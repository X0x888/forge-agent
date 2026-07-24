/**
 * Append-only sandbox / safety event log (Grok SandboxEvent-inspired).
 * Never writes secrets — only profiles, reasons, truncated command previews.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir, forgeHome, nowIso } from "../util/fs.js";

export type SandboxLogEventType =
  | "profile"
  | "deny"
  | "fallback"
  | "fail_closed"
  | "network_block"
  | "hard_deny"
  | "rule_deny"
  | "external_dir"
  | "redirection";

export interface SandboxLogEvent {
  ts: string;
  type: SandboxLogEventType;
  profile?: string;
  reason?: string;
  rule?: string;
  command?: string;
  path?: string;
  backend?: string;
  network?: string;
}

function logPath(): string {
  return path.join(forgeHome(), "logs", "sandbox.jsonl");
}

export function logSandboxEvent(event: Omit<SandboxLogEvent, "ts"> & { ts?: string }): void {
  try {
    const full: SandboxLogEvent = {
      ...event,
      ts: event.ts || nowIso(),
      command: event.command ? event.command.slice(0, 200) : undefined,
      path: event.path ? event.path.slice(0, 300) : undefined,
      reason: event.reason ? event.reason.slice(0, 400) : undefined,
    };
    const file = logPath();
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(full) + "\n", { mode: 0o600 });
  } catch {
    /* never break agent on log failure */
  }
}
