/**
 * Best-effort cross-process mutex for small JSON state files
 * (auth.json, preferences.json).
 *
 * Every store mutator is load → mutate → save. Two forge processes doing
 * that concurrently clobber each other (e.g. process A persists a rotated
 * OAuth refresh_token while process B, which loaded before A's write,
 * persists a cooldown → rotated token lost → invalid_grant → re-login).
 * This serializes the read-modify-write via a `<file>.lock` sidecar:
 * atomic wx-create, bounded wait, stale-steal (dead pid or age cap).
 *
 * FAIL-OPEN by design: if the lock cannot be acquired within waitMs, the
 * callback still runs (unlocked). A wedged lockfile must never brick login —
 * a rare lost update is acceptable next to a dead CLI. Same trade-off class
 * as the session lock (src/session/lock.ts), generalized to any file.
 */
import fs from "node:fs";

const DEFAULT_WAIT_MS = 2_000;
const POLL_MS = 25;
/**
 * Critical sections are ms-scale synchronous I/O, so a lock older than this
 * is always abandoned (holder crashed or was SIGKILLed mid-write) and may be
 * stolen even when its pid looks alive (pid reuse).
 */
const STALE_MS = 10_000;

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists, owned by another user — alive for stealing purposes.
    return (
      typeof err === "object" &&
      err !== null &&
      (err as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

/** Synchronous sleep (all store mutators are sync, so the wait must be too). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** null = lock vanished between our create attempt and the stat (retry). */
function readLockInfo(lockPath: string): { mtimeMs: number; pid?: number } | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(lockPath);
  } catch {
    return null;
  }
  let pid: number | undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: unknown;
    };
    const n = Number(raw?.pid);
    if (Number.isFinite(n) && n > 0) pid = Math.trunc(n);
  } catch {
    /* empty/corrupt — holder may simply be mid-create; age still governs */
  }
  return { mtimeMs: st.mtimeMs, pid };
}

/**
 * Run `fn` holding the lock for `targetPath` (sidecar `<targetPath>.lock`).
 * Returns fn's result; fn's exceptions propagate after releasing the lock.
 */
export function withFileLock<T>(
  targetPath: string,
  fn: () => T,
  opts?: { waitMs?: number; staleMs?: number },
): T {
  const lockPath = `${targetPath}.lock`;
  const waitMs = Math.max(0, opts?.waitMs ?? DEFAULT_WAIT_MS);
  const staleMs = Math.max(1, opts?.staleMs ?? STALE_MS);
  const deadline = Date.now() + waitMs;
  let owned = false;

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, at: Date.now() }),
        );
      } finally {
        fs.closeSync(fd);
      }
      owned = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") break; // fs trouble → fail-open
      const info = readLockInfo(lockPath);
      if (info === null) {
        if (Date.now() >= deadline) break; // churning contenders — fail-open
        continue; // vanished between open and stat — retry the create
      }
      const young = Date.now() - info.mtimeMs < staleMs;
      // A young lock belongs to a live holder mid-section: wait, never steal.
      // Only a dead holder pid justifies an early steal; old locks always do.
      const holderDead = info.pid !== undefined && !pidAlive(info.pid);
      if (young && !holderDead) {
        if (Date.now() >= deadline) break; // fail-open
        sleepSync(POLL_MS);
        continue;
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* lost the steal race — loop re-reads */
      }
    }
  }

  try {
    return fn();
  } finally {
    if (owned) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* best-effort; age cap recovers a missed release */
      }
    }
  }
}
