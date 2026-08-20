/**
 * Idle/live bang-shell: `!git status` runs immediately (Claude / OpenCode).
 * Same PermissionGate + bash tool as the agent — no backdoor around plan/deny.
 * Output is printed and appended so the next model turn sees it.
 */
import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import type { SessionData } from "../session/session.js";
import { markUserTurn, saveSession } from "../session/session.js";
import { appendFileMutation } from "../session/mutations.js";
import type { PermissionGate } from "../agent/permissions.js";
import { executeTool } from "../agent/tools/index.js";
import {
  applyVerificationTrail,
  verificationPassedFromResult,
} from "../harness/ulw-cycle.js";
import { detectProjectIntel } from "../util/project-intel.js";

const MAX_SESSION_CHARS = 8_000;

export function parseBangCommand(line: string): string | null {
  if (!line.startsWith("!")) return null;
  return line.slice(1).trim();
}

export async function runBangShell(opts: {
  line: string;
  config: ForgeConfig;
  session: SessionData;
  permissions: PermissionGate;
  /** When false, print-only — caller queues the result (mid-run, avoid racing the loop). */
  persist?: boolean;
  /**
   * Journal workspace writes (and increment turn on persist) so /undo
   * restores disk. Default true for user `!cmd`. `/verify` sets false —
   * a project check must not become an undo turn or journal test fixtures.
   */
  journal?: boolean;
  /** Live last-line of the bang command (throttled) for live ›. */
  onProgress?: (detail: string) => void;
}): Promise<{ handled: boolean; output: string; isError?: boolean }> {
  const command = parseBangCommand(opts.line);
  if (command === null) return { handled: false, output: "" };
  if (!command) {
    return {
      handled: true,
      output: "Usage: !<command>   e.g. !git status   !npm test",
      isError: true,
    };
  }

  const { config, session, permissions } = opts;
  const perm = await permissions.request({
    toolName: "bash",
    input: { command },
    mode: config.permissionMode,
    workspace: config.workspace || session.meta.cwd,
    config,
    userInitiated: true,
  });
  if (perm.decision === "deny") {
    const msg = `! denied: ${perm.reason || "permission denied"}`;
    return { handled: true, output: msg, isError: true };
  }

  const persist = opts.persist !== false;
  const journal = opts.journal !== false;
  // Idle bang is a real user turn so /undo 1 restores only this write,
  // not the previous agent turn. Mid-run (persist:false) stays on the
  // in-flight turn — those writes rewind with that ship.
  if (persist && journal) {
    session.meta.turnCount = (session.meta.turnCount || 0) + 1;
    markUserTurn(session);
  }

  const result = await executeTool(
    "bash",
    JSON.stringify({ command }),
    {
      workspace: config.workspace || session.meta.cwd,
      sessionId: session.meta.id,
      // User typed the command — run unsandboxed (Claude/OpenCode bang-shell).
      // PermissionGate still applies (plan mode / deny rules).
      sandbox: "off",
      sandboxNetwork: config.sandboxNetwork,
      sandboxMissingBackend: config.sandboxMissingBackend,
      session,
      config,
      onProgress: opts.onProgress,
      ...(journal
        ? {
            onEdit: () => {
              session.meta.editCount += 1;
              session.meta.lastEditAt = new Date().toISOString();
            },
            recordMutation: (input: {
              path: string;
              kind: "create" | "update" | "delete";
              before?: string;
              mode?: number;
              skipped?: boolean;
              reason?: string;
            }) => {
              appendFileMutation(session.meta.id, {
                ...input,
                turn: Math.max(1, session.meta.turnCount || 0),
              });
            },
          }
        : {}),
    },
  );
  const body = String(result.output || "").trimEnd();
  const header = `! ${command}`;
  const printed = body ? `${header}\n${body}` : header;
  const passed = verificationPassedFromResult({
    command,
    isError: result.isError,
    output: result.output,
  });

  try {
    const preferred = detectProjectIntel(
      config.workspace || session.meta.cwd,
    ).checkCommands;
    applyVerificationTrail(session.meta, {
      command,
      isError: !passed,
      preferredCheckCommands: preferred,
    });
    // Persist the verify stamp even when persist:false (mid-run) so proof-claim
    // sees the successful check without racing the in-flight message list.
    if (opts.persist === false) {
      try {
        saveSession(session);
      } catch {
        /* */
      }
    }
  } catch {
    /* */
  }

  if (opts.persist !== false) {
    try {
      const clipped =
        printed.length > MAX_SESSION_CHARS
          ? `${printed.slice(0, MAX_SESSION_CHARS)}\n…(truncated)`
          : printed;
      session.messages.push({
        role: "user",
        content: `[User ran bang-shell]\n${clipped}`,
      });
      saveSession(session);
    } catch {
      /* */
    }
  }

  return { handled: true, output: printed, isError: !passed };
}

export function formatBangOutput(output: string, isError = false): string {
  const paint = isError ? chalk.red : chalk.dim;
  const head = isError ? chalk.red : chalk.cyan;
  return output
    .split("\n")
    .map((line, i) => (i === 0 ? head(line) : paint(line)))
    .join("\n");
}
