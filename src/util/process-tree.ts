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
