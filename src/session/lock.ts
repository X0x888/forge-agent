/**
 * Best-effort session lock so two Forge processes don't thrash the same
 * session.json (experts often open a second terminal by accident).
 *
 * A lock held by a live pid is never stolen (multi-day ULW holds it for the
 * whole process lifetime and refreshes acquiredAt via touchSessionLock);
 * only a dead-pid lock is stolen immediately, or any lock with force.
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

function lockPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "session.lock");
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but owned by another user — still ALIVE for
    // lock-stealing purposes (treating it as dead made foreign-user locks
    // stealable).
    return (
      typeof err === "object" &&
      err !== null &&
      (err as NodeJS.ErrnoException).code === "EPERM"
    );
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
  opts?: { force?: boolean },
): AcquireLockResult {
  ensureDir(sessionDir(sessionId));
  const file = lockPath(sessionId);

  // Bounded: normally one pass; a lost create-race re-reads once. A corrupt
  // file reads as "no lock" yet still exists (EEXIST), so never loop on it.
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = readSessionLock(sessionId);

    if (existing) {
      const alive = pidAlive(existing.pid);
      const mine = existing.pid === process.pid;
      if (mine) {
        // Refresh timestamp (multi-day runs must keep acquiredAt fresh)
        writeLock(sessionId);
        return { ok: true, owned: true };
      }
      // Live foreign pid: never steal (multi-day ULW would lose exclusivity
      // mid-run and race session.json). Only dead pid (or force) is stealable.
      if (alive && !opts?.force) {
        return {
          ok: false,
          owned: false,
          holder: existing,
          reason: `session locked by live pid ${existing.pid} on ${existing.hostname} since ${existing.acquiredAt || "unknown"}`,
        };
      }
      // Dead pid (or force): steal.
      writeLock(sessionId);
      return {
        ok: true,
        owned: true,
        stolen: true,
        holder: existing,
        reason: alive
          ? `force-stole lock from live pid ${existing.pid}`
          : `stole stale lock from dead pid ${existing.pid}`,
      };
    }

    // No lock on disk: create ATOMICALLY (wx). The previous read→write
    // sequence was TOCTOU — two Forge processes started together both read
    // "no lock" and both acquired, thrashing the same session.json.
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(lockInfo(sessionId), null, 2) + "\n");
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, owned: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lost the create race (or a corrupt file blocks creation) — loop once
      // to re-read; fall through to corrupt-steal if it still fails.
    }
  }

  // Corrupt / unreadable lock that reads as absent but blocks creation:
  // recover by overwriting (same as the pre-atomic behavior).
  writeLock(sessionId);
  return {
    ok: true,
    owned: true,
    stolen: true,
    reason: "stole corrupt/unreadable lock file",
  };
}

function lockInfo(sessionId: string): SessionLockInfo {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: nowIso(),
    sessionId,
  };
}

function writeLock(sessionId: string): void {
  const info = lockInfo(sessionId);
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
    // Re-verify ownership immediately before unlink to shrink the read→unlink
    // TOCTOU — a force-steal landing in that gap installs a fresh lock we must
    // not delete. (A residual race remains: Node has no atomic
    // compare-and-delete; the window is now microseconds, not a full read.)
    const still = readSessionLock(sessionId);
    if (
      !still ||
      still.pid !== process.pid ||
      still.acquiredAt !== existing.acquiredAt
    ) {
      return false;
    }
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

/**
 * Refresh acquiredAt when this process already owns the lock.
 * Call from saveSession during multi-day runs (statusline + ops visibility).
 * Does not steal; no-op if we do not own the lock.
 */
export function touchSessionLock(sessionId: string): boolean {
  const existing = readSessionLock(sessionId);
  if (!existing || existing.pid !== process.pid) return false;
  try {
    writeLock(sessionId);
    return true;
  } catch {
    return false;
  }
}
