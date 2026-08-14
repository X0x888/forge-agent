/**
 * Exclusive stdin lease for nested TTY prompts.
 *
 * The REPL PromptEditor owns raw-mode stdin for the whole session so users
 * can type mid-run. Permission asks and ask_user open a second readline on
 * the same streams — without this lease, `y`/`n` land in the live buffer
 * (or both) and the first-write-of-the-day prompt feels broken.
 *
 * Callers wrap their readline in `withStdinLease`. The REPL registers the
 * editor once; other sites (login offer, tests) are no-ops when nothing is
 * registered.
 */

export interface StdinLeaseHolder {
  suspend(): void;
  resume(): void;
}

let holder: StdinLeaseHolder | null = null;
let depth = 0;

/** Register the REPL editor (or a test double). Replaces any previous holder. */
export function setStdinLeaseHolder(next: StdinLeaseHolder | null): void {
  holder = next;
}

export function getStdinLeaseHolder(): StdinLeaseHolder | null {
  return holder;
}

/** True while a nested prompt currently owns stdin. */
export function stdinLeaseHeld(): boolean {
  return depth > 0;
}

/**
 * Run `fn` with exclusive stdin. Nested leases increment a depth counter
 * so the editor stays paused until the outermost release.
 */
export async function withStdinLease<T>(fn: () => Promise<T>): Promise<T> {
  const first = depth === 0;
  depth += 1;
  if (first) {
    try {
      holder?.suspend();
    } catch {
      /* never brick a permission ask because the editor failed to pause */
    }
  }
  try {
    return await fn();
  } finally {
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      try {
        holder?.resume();
      } catch {
        /* ignore — REPL will redraw on next prompt() */
      }
    }
  }
}

/** Test / shutdown helper — drop holder and reset depth. */
export function resetStdinLeaseForTests(): void {
  holder = null;
  depth = 0;
}
