/**
 * Process-group kill for spawned shells.
 *
 * Signalling only the wrapper (`sh -c npm test`, sandbox-exec) orphans
 * grandchildren. Those keep stdout/stderr pipe FDs open, so Node's
 * `child.on("close")` never fires — Ctrl+C prints Aborting… and hangs.
 * Hooks already documented this; bash/background must do the same:
 * spawn detached (own PGID) and kill the negative pid.
 */
import type { ChildProcess } from "node:child_process";

const inflight = new Set<ChildProcess>();

export function registerInflightChild(child: ChildProcess): void {
  inflight.add(child);
  const gone = () => inflight.delete(child);
  child.once("exit", gone);
  child.once("error", gone);
}

export function unregisterInflightChild(child: ChildProcess): void {
  inflight.delete(child);
}

export function inflightChildCount(): number {
  return inflight.size;
}

/** POSIX: own process group so timeout/abort can reap grandchildren. */
export function spawnOwnGroupOpts(): { detached: boolean } {
  return { detached: process.platform !== "win32" };
}

/** True when `kill(pid, 0)` succeeds. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signal a pid, or its process group when it is a group leader (the bash
 * spawn-own-group shape). Falls back to the pid when `-pid` fails.
 */
export function signalPidTree(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      /* not a leader — direct kill below */
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM a pid/group, then SIGKILL after waitMs without blocking the event
 * loop (Atomics.wait would freeze the TUI and parallel tests).
 */
export function escalateKillPid(pid: number, waitMs = 800): number {
  if (!pidAlive(pid)) return 0;
  let n = 0;
  if (signalPidTree(pid, "SIGTERM")) n += 1;
  const t = setTimeout(() => {
    if (pidAlive(pid)) signalPidTree(pid, "SIGKILL");
  }, Math.max(0, waitMs));
  t.unref?.();
  return n;
}

/**
 * Kill the child's process group (POSIX) or the child (win32 / ESRCH).
 * Returns true if a signal was sent.
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): boolean {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      /* group gone or not a leader — direct kill below */
    }
  }
  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

/** Second Ctrl+C / REPL teardown: SIGKILL every in-flight bash/grep child. */
export function killAllInflightTrees(signal: NodeJS.Signals): number {
  let n = 0;
  for (const c of [...inflight]) {
    if (killProcessTree(c, signal)) n += 1;
  }
  return n;
}

/** Test helper */
export function _resetInflightChildrenForTests(): void {
  for (const c of [...inflight]) {
    try {
      killProcessTree(c, "SIGKILL");
    } catch {
      /* */
    }
  }
  inflight.clear();
}
