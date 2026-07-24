/**
 * Append-only sandbox / safety event log (Grok SandboxEvent-inspired).
 * Never writes secrets — only profiles, reasons, truncated command previews.
 * Rotates when the active file exceeds MAX_BYTES (keeps one .1 backup).
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

/** Rotate when active log exceeds this size (default 2 MiB). */
export const SANDBOX_LOG_MAX_BYTES = 2 * 1024 * 1024;

export function sandboxLogPath(): string {
  return path.join(forgeHome(), "logs", "sandbox.jsonl");
}

function rotateIfNeeded(file: string): void {
  try {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    if (st.size < SANDBOX_LOG_MAX_BYTES) return;
    const bak = `${file}.1`;
    try {
      fs.unlinkSync(bak);
    } catch {
      /* */
    }
    fs.renameSync(file, bak);
  } catch {
    /* never break agent on rotate failure */
  }
}

export function logSandboxEvent(
  event: Omit<SandboxLogEvent, "ts"> & { ts?: string },
): void {
  try {
    const full: SandboxLogEvent = {
      ...event,
      ts: event.ts || nowIso(),
      command: event.command ? event.command.slice(0, 200) : undefined,
      path: event.path ? event.path.slice(0, 300) : undefined,
      reason: event.reason ? event.reason.slice(0, 400) : undefined,
    };
    const file = sandboxLogPath();
    ensureDir(path.dirname(file));
    rotateIfNeeded(file);
    fs.appendFileSync(file, JSON.stringify(full) + "\n", { mode: 0o600 });
  } catch {
    /* never break agent on log failure */
  }
}

export interface SandboxLogStats {
  path: string;
  bytes: number;
  backupBytes: number;
  exists: boolean;
}

/** Best-effort stats for doctor. */
export function sandboxLogStats(): SandboxLogStats {
  const p = sandboxLogPath();
  const bak = `${p}.1`;
  let bytes = 0;
  let backupBytes = 0;
  let exists = false;
  try {
    if (fs.existsSync(p)) {
      exists = true;
      bytes = fs.statSync(p).size;
    }
    if (fs.existsSync(bak)) {
      backupBytes = fs.statSync(bak).size;
    }
  } catch {
    /* */
  }
  return { path: p, bytes, backupBytes, exists };
}
