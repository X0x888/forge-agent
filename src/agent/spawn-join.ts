/**
 * Join helpers for overlapping spawn_subagent calls.
 *
 * OrderGate serializes worktree land into the parent in original tool-call
 * order. enqueueGitWorktreeMeta serializes git worktree add|remove|prune
 * on one repo (a different lock domain than parent `git apply`).
 */
import path from "node:path";

export interface OrderGate {
  /**
   * Wait until `current === ticket`, **always** run `fn`, then finish.
   * Abort unblocks waiters only — never skip `fn` when the slot is granted.
   */
  run<T>(ticket: number, fn: () => Promise<T>): Promise<T>;
  /**
   * Wait until this ticket is current (or already finished), then advance
   * if we still hold the slot. Idempotent with `run`.
   */
  finish(ticket: number): Promise<void>;
}

/**
 * Dense tickets `0..n-1` per batch, never reused.
 * Waiters are a list per ticket (run + outer finish may both wait).
 */
export function createOrderGate(signal?: AbortSignal): OrderGate {
  let current = 0;
  const finished = new Set<number>();
  const held = new Set<number>();
  const waiters = new Map<number, Array<() => void>>();

  const wake = (ticket: number): void => {
    const list = waiters.get(ticket);
    if (!list?.length) return;
    waiters.delete(ticket);
    for (const w of list) w();
  };

  const wakeAll = (): void => {
    const all = [...waiters.values()].flat();
    waiters.clear();
    for (const w of all) w();
  };

  if (signal) {
    const onAbort = (): void => wakeAll();
    if (!signal.aborted) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const ready = (ticket: number): boolean =>
    finished.has(ticket) || current === ticket;

  const waitUntil = (pred: () => boolean, ticket: number): Promise<void> => {
    if (pred()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      if (pred()) {
        resolve();
        return;
      }
      const list = waiters.get(ticket) ?? [];
      list.push(resolve);
      waiters.set(ticket, list);
    }).then(() => {
      if (pred()) return;
      return waitUntil(pred, ticket);
    });
  };

  const advance = (ticket: number): void => {
    if (finished.has(ticket)) return;
    finished.add(ticket);
    held.delete(ticket);
    current = ticket + 1;
    wake(ticket);
    wake(current);
  };

  const finish = async (ticket: number): Promise<void> => {
    await waitUntil(() => ready(ticket), ticket);
    if (finished.has(ticket)) return;
    if (held.has(ticket)) {
      await waitUntil(() => finished.has(ticket), ticket);
      return;
    }
    advance(ticket);
  };

  const run = async <T>(ticket: number, fn: () => Promise<T>): Promise<T> => {
    await waitUntil(() => ready(ticket), ticket);
    held.add(ticket);
    try {
      return await fn();
    } finally {
      if (!finished.has(ticket)) advance(ticket);
      else held.delete(ticket);
    }
  };

  return { run, finish };
}

const worktreeMetaChains = new Map<string, Promise<unknown>>();

/**
 * Fail-open chain (same shape as `enqueuePrompt`): a rejected job still
 * lets the next add/remove/prune run.
 */
export function enqueueGitWorktreeMeta<T>(
  gitRoot: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const key = path.resolve(gitRoot);
  const run = (worktreeMetaChains.get(key) ?? Promise.resolve()).then(fn, fn);
  worktreeMetaChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
