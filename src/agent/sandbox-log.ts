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

/**
 * Tail recent sandbox/safety events (newest last).
 * Best-effort JSONL parse; corrupt lines skipped.
 */
export function readSandboxLogTail(limit = 30): SandboxLogEvent[] {
  // limit 0 = all events in the read window (not coerced to 1/30).
  // Negative / NaN → default 30. Positive capped at 200.
  let n = 30;
  if (typeof limit === "number" && Number.isFinite(limit)) {
    const f = Math.floor(limit);
    if (f === 0) n = 0;
    else if (f > 0) n = Math.min(200, f);
  }
  const file = sandboxLogPath();
  let raw = "";
  try {
    // Read up to last ~512 KiB so huge logs don't blow memory
    const st = fs.statSync(file);
    const max = 512 * 1024;
    if (st.size <= max) {
      raw = fs.readFileSync(file, "utf8");
    } else {
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(max);
        fs.readSync(fd, buf, 0, max, st.size - max);
        raw = buf.toString("utf8");
        // Drop partial first line
        const nl = raw.indexOf("\n");
        if (nl >= 0) raw = raw.slice(nl + 1);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return [];
  }
  const out: SandboxLogEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as SandboxLogEvent;
      if (ev && typeof ev === "object" && typeof ev.type === "string") {
        out.push(ev);
      }
    } catch {
      /* skip */
    }
  }
  if (n === 0) return out;
  return out.slice(-n);
}

/** Human-readable tail for `/logs` and incident triage. */
export function formatSandboxLogTail(limit = 30): string {
  const p = sandboxLogPath();
  const events = readSandboxLogTail(limit);
  if (!events.length) {
    return (
      `No sandbox/safety events yet.\n` +
      `Log path: ${p}\n` +
      `Events appear when bash is sandboxed, denied, or falls back.`
    );
  }
  const lines = events.map((e) => {
    const ts = (e.ts || "").replace("T", " ").replace(/\.\d+Z$/, "Z");
    const bits = [
      ts || "?",
      e.type,
      e.profile ? `profile=${e.profile}` : "",
      e.backend ? `backend=${e.backend}` : "",
      e.reason || "",
      e.rule ? `rule=${e.rule}` : "",
      e.command ? `cmd=${e.command}` : "",
      e.path ? `path=${e.path}` : "",
    ].filter(Boolean);
    return bits.join("  ");
  });
  return (
    `Sandbox/safety log (last ${events.length}) · ${p}\n` + lines.join("\n")
  );
}
