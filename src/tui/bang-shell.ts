/**
 * Idle/live bang-shell: `!git status` runs immediately (Claude / OpenCode).
 * Same PermissionGate + bash tool as the agent — no backdoor around plan/deny.
 * Output is printed and appended so the next model turn sees it.
 */
import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import type { SessionData } from "../session/session.js";
import { saveSession } from "../session/session.js";
import type { PermissionGate } from "../agent/permissions.js";
import { executeTool } from "../agent/tools/index.js";
import {
  shouldClearLastVerification,
  shouldStampLastVerification,
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
    },
  );
  const body = String(result.output || "").trimEnd();
  const header = `! ${command}`;
  const printed = body ? `${header}\n${body}` : header;

  try {
    const preferred = detectProjectIntel(
      config.workspace || session.meta.cwd,
    ).checkCommands;
    if (
      shouldStampLastVerification({
        command,
        isError: result.isError,
        preferredCheckCommands: preferred,
      })
    ) {
      session.meta.lastVerificationCommand = command.trim().slice(0, 240);
      session.meta.lastVerificationAt = new Date().toISOString();
    } else if (
      shouldClearLastVerification({
        command,
        isError: result.isError,
        preferredCheckCommands: preferred,
      })
    ) {
      delete session.meta.lastVerificationCommand;
      delete session.meta.lastVerificationAt;
    }
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

  return { handled: true, output: printed, isError: Boolean(result.isError) };
}

export function formatBangOutput(output: string, isError = false): string {
  const paint = isError ? chalk.red : chalk.dim;
  return output
    .split("\n")
    .map((line, i) => (i === 0 ? chalk.cyan(line) : paint(line)))
    .join("\n");
}
