/**
 * Resolve a headless prompt that may be a slash command.
 * Used by `forge run "/plan"` and custom `.forge/commands` templates.
 */
import type { ForgeConfig } from "../config/types.js";
import type { SessionData } from "../session/session.js";
import type { HookRunner } from "../harness/hooks.js";
import { handleSlash, classifyLiveSlash } from "./slash.js";
import {
  saveSession,
  deleteSessionDetailed,
} from "../session/session.js";

export type HeadlessSlashResolution =
  | { kind: "prompt"; prompt: string; notice?: string; session: SessionData }
  | {
      kind: "done";
      output: string;
      command: string;
      session: SessionData;
      /** True when the session was discarded (ephemeral pure-control). */
      ephemeral?: boolean;
    }
  | { kind: "passthrough"; prompt: string; session: SessionData };

/**
 * If `prompt` starts with `/`, run handleSlash.
 * - forwardPrompt → continue agent loop with expanded text
 * - handled without forward → finish headless without a model call
 * - not a slash / error → passthrough original prompt
 *
 * When `ephemeral` is true (default for pure-control without `--session`),
 * the temporary session is deleted after a pure-control slash so CI probes
 * do not pollute `forge sessions list` / break `--continue` fail-closed.
 */
export async function resolveHeadlessSlashPrompt(opts: {
  prompt: string;
  session: SessionData;
  config: ForgeConfig;
  hooks: HookRunner;
  /** Discard session after pure-control slash (default false). */
  ephemeral?: boolean;
}): Promise<HeadlessSlashResolution> {
  const raw = String(opts.prompt ?? "");
  if (!/^\s*\//.test(raw)) {
    return { kind: "passthrough", prompt: raw, session: opts.session };
  }
  try {
    const slash = await handleSlash(raw.trim(), {
      session: opts.session,
      config: opts.config,
      hooks: opts.hooks,
    });
    const session = slash.session || opts.session;
    if (slash.forwardPrompt) {
      // Forwarded templates need a real session for the agent turn.
      try {
        saveSession(session);
      } catch {
        /* never block headless on save */
      }
      return {
        kind: "prompt",
        prompt: slash.forwardPrompt,
        notice: slash.output ? String(slash.output) : undefined,
        session,
      };
    }
    if (slash.handled) {
      // Only discard for true read-only probes (/help, /commands, /doctor…).
      // Mutating controls (/plan, /build, /model, /cycle…) must persist session.
      const cmd = raw.trim().split(/\s+/)[0] || "/";
      const readonlyProbe =
        classifyLiveSlash(raw.trim()) === "readonly" ||
        classifyLiveSlash(cmd) === "readonly";
      const ephemeral = Boolean(opts.ephemeral) && readonlyProbe;
      if (ephemeral) {
        try {
          deleteSessionDetailed(session.meta.id, { force: true });
        } catch {
          /* best-effort cleanup */
        }
      } else {
        try {
          saveSession(session);
        } catch {
          /* */
        }
      }
      return {
        kind: "done",
        output: String(slash.output || ""),
        command: cmd,
        session,
        ephemeral,
      };
    }
  } catch {
    /* fall through */
  }
  return { kind: "passthrough", prompt: raw, session: opts.session };
}

/** Strip ANSI for headless JSON / plain stdout. */
export function stripAnsi(s: string): string {
  return String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
}
