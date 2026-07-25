/**
 * Best-effort session lock so two Forge processes don't thrash the same
 * session.json (experts often open a second terminal by accident).
 *
 * Stale locks (dead pid or age > TTL) are stolen automatically.
 */

import fs from "node:fs";
import path from "node:path";
import { sessionDir } from "./session.js";
import { ensureDir, nowIso } from "../util/fs.js";
import os from "node:os";

export interface SessionLockInfo {
  pid: number;
  hostname: string;
  acquiredAt: string;
  sessionId: string;
}

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2h

function lockPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "session.lock");
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readSessionLock(sessionId: string): SessionLockInfo | null {
  try {
    const raw = fs.readFileSync(lockPath(sessionId), "utf8");
    const data = JSON.parse(raw) as Partial<SessionLockInfo> | null;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const pid = Number(data.pid);
    // Corrupt / incomplete lock files are treated as absent so acquire can
    // recover instead of blocking forever on garbage JSON.
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return {
      pid: Math.trunc(pid),
      hostname: typeof data.hostname === "string" ? data.hostname : "unknown",
      acquiredAt:
        typeof data.acquiredAt === "string" ? data.acquiredAt : "",
      sessionId:
        typeof data.sessionId === "string" ? data.sessionId : sessionId,
    };
  } catch {
    return null;
  }
}

export interface AcquireLockResult {
  ok: boolean;
  /** True when we own the lock after this call */
  owned: boolean;
  /** Existing foreign lock if blocked */
  holder?: SessionLockInfo;
  /** Stolen a stale lock */
  stolen?: boolean;
  reason?: string;
}

/**
 * Try to acquire an exclusive session lock.
 * @param force steal even if holder looks alive (user override)
 */
export function acquireSessionLock(
  sessionId: string,
  opts?: { force?: boolean; ttlMs?: number },
): AcquireLockResult {
  ensureDir(sessionDir(sessionId));
  const file = lockPath(sessionId);
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const existing = readSessionLock(sessionId);

  if (existing) {
    const acquiredMs = Date.parse(existing.acquiredAt || "");
    const age = Number.isFinite(acquiredMs)
      ? Date.now() - acquiredMs
      : Infinity;
    const alive = pidAlive(existing.pid);
    const mine = existing.pid === process.pid;
    if (mine) {
      // Refresh timestamp
      writeLock(sessionId);
      return { ok: true, owned: true };
    }
    const stale = !alive || age > ttl;
    if (!stale && !opts?.force) {
      return {
        ok: false,
        owned: false,
        holder: existing,
        reason: `session locked by pid ${existing.pid} on ${existing.hostname} since ${existing.acquiredAt}`,
      };
    }
    // steal
    writeLock(sessionId);
    return {
      ok: true,
      owned: true,
      stolen: true,
      holder: existing,
      reason: stale
        ? `stole stale lock from pid ${existing.pid}`
        : `force-stole lock from pid ${existing.pid}`,
    };
  }

  writeLock(sessionId);
  return { ok: true, owned: true };
}

function writeLock(sessionId: string): void {
  const info: SessionLockInfo = {
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: nowIso(),
    sessionId,
  };
  const file = lockPath(sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows / some FS ignore mode */
  }
}

/** Release only if we own the lock. */
export function releaseSessionLock(sessionId: string): boolean {
  const existing = readSessionLock(sessionId);
  if (!existing) return true;
  if (existing.pid !== process.pid) return false;
  try {
    fs.unlinkSync(lockPath(sessionId));
    return true;
  } catch {
    return false;
  }
}

export function formatLockHolder(info: SessionLockInfo): string {
  const alive = pidAlive(info.pid) ? "alive" : "dead";
  return `pid ${info.pid} @ ${info.hostname} (${alive}, since ${info.acquiredAt})`;
}
