/**
 * Resolve a headless prompt that may be a slash command.
 * Used by `forge run "/plan"` and custom `.forge/commands` templates.
 */
import type { ForgeConfig } from "../config/types.js";
import type { SessionData } from "../session/session.js";
import type { HookRunner } from "../harness/hooks.js";
import { handleSlash } from "./slash.js";
import { saveSession } from "../session/session.js";

export type HeadlessSlashResolution =
  | { kind: "prompt"; prompt: string; notice?: string; session: SessionData }
  | { kind: "done"; output: string; command: string; session: SessionData }
  | { kind: "passthrough"; prompt: string; session: SessionData };

/**
 * If `prompt` starts with `/`, run handleSlash.
 * - forwardPrompt → continue agent loop with expanded text
 * - handled without forward → finish headless without a model call
 * - not a slash / error → passthrough original prompt
 */
export async function resolveHeadlessSlashPrompt(opts: {
  prompt: string;
  session: SessionData;
  config: ForgeConfig;
  hooks: HookRunner;
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
    try {
      saveSession(session);
    } catch {
      /* never block headless on save */
    }
    if (slash.forwardPrompt) {
      return {
        kind: "prompt",
        prompt: slash.forwardPrompt,
        notice: slash.output ? String(slash.output) : undefined,
        session,
      };
    }
    if (slash.handled) {
      return {
        kind: "done",
        output: String(slash.output || ""),
        command: raw.trim().split(/\s+/)[0] || "/",
        session,
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
