/**
 * Consecutive tool-error circuit breaker (Grok Build–inspired).
 *
 * Doom-loop catches identical tool+args. This catches a different failure mode:
 * the model keeps thrashing with *different* tools/args that all error
 * (wrong paths, bad edits, failing shell) and burns the turn budget.
 *
 * When the streak trips we inject a hard strategy-change nudge. Permission
 * denies / hard safety denies do not count — those are intentional gates.
 */

export interface ErrorStreakConfig {
  /** Consecutive errored tool results required to trip (default 5) */
  threshold?: number;
  /**
   * After a trip, require this many successful tools before another trip
   * can fire on a fresh streak (default = threshold).
   */
  coolSuccesses?: number;
}

export interface ErrorStreakHit {
  count: number;
  recent: string[];
  message: string;
}

export class ErrorStreakTracker {
  private readonly threshold: number;
  private readonly coolSuccesses: number;
  private streak = 0;
  private successesSinceTrip = Number.POSITIVE_INFINITY;
  private recent: string[] = [];
  private tripped = false;

  constructor(cfg: ErrorStreakConfig = {}) {
    this.threshold = Math.max(2, cfg.threshold ?? 5);
    this.coolSuccesses = Math.max(1, cfg.coolSuccesses ?? this.threshold);
  }

  reset(): void {
    this.streak = 0;
    this.recent = [];
    this.tripped = false;
    this.successesSinceTrip = Number.POSITIVE_INFINITY;
  }

  /** Record a successful tool result — breaks the error streak. */
  observeSuccess(): void {
    this.streak = 0;
    this.recent = [];
    if (this.tripped) {
      this.successesSinceTrip += 1;
      if (this.successesSinceTrip >= this.coolSuccesses) {
        this.tripped = false;
        this.successesSinceTrip = Number.POSITIVE_INFINITY;
      }
    }
  }

  /**
   * Record a tool error. Returns a hit when the consecutive error streak
   * reaches threshold (once per streak; cools after enough successes).
   */
  observeError(tool: string, summary?: string): ErrorStreakHit | null {
    const label = summary
      ? `${tool}: ${summary.replace(/\s+/g, " ").trim().slice(0, 80)}`
      : tool;
    this.streak += 1;
    this.recent.push(label);
    if (this.recent.length > this.threshold + 2) {
      this.recent = this.recent.slice(-(this.threshold + 2));
    }

    if (this.streak < this.threshold) return null;
    if (this.tripped) return null;

    this.tripped = true;
    this.successesSinceTrip = 0;
    const recent = this.recent.slice(-this.threshold);
    return {
      count: this.streak,
      recent,
      message: buildErrorStreakMessage(this.streak, recent),
    };
  }

  get currentStreak(): number {
    return this.streak;
  }
}

function buildErrorStreakMessage(count: number, recent: string[]): string {
  const list = recent.map((r, i) => `  ${i + 1}. ${r}`).join("\n");
  return (
    `[Forge error-streak] ${count} consecutive tool errors without a success.\n` +
    `Recent failures:\n${list}\n` +
    `STOP thrashing. Change strategy now:\n` +
    `1. Re-read the actual file/error output (do not guess paths).\n` +
    `2. Run the cheapest verification (typecheck/test) to learn the real failure.\n` +
    `3. Try a different tool or narrower scope — identical retries will keep failing.\n` +
    `4. If blocked on missing credentials/external state, say so clearly instead of looping.`
  );
}

/**
 * Classify whether a tool result content should count toward the error streak.
 * Permission/hard denies are intentional gates, not model thrash.
 */
export function isCountableToolError(content: string, isError?: boolean): boolean {
  if (!isError) return false;
  const s = (content || "").trim();
  if (!s) return true;
  if (/^HARD DENY\b/i.test(s)) return false;
  if (/^Tool denied by (hook|permission gate)\b/i.test(s)) return false;
  if (/^\[Forge doom-loop\]/i.test(s) && s.length < 40) return false;
  // User/turn cancel is not model thrash — don't fire the circuit breaker.
  if (/^Aborted\b/i.test(s) || /^Aborted$/i.test(s)) return false;
  if (/\b(aborted by user|turn aborted|request aborted)\b/i.test(s)) return false;
  return true;
}

/** Short one-line summary of a tool error for the streak log. */
export function summarizeToolError(content: string): string {
  const line = (content || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("[note:"));
  return (line || "error").slice(0, 100);
}
