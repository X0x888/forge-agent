/**
 * Doom-loop detection (OpenCode-inspired).
 *
 * Models sometimes call the same tool with identical args 3+ times in a row
 * (failed edit retry, stuck grep, etc.). Detect and inject a hard nudge so the
 * agent changes strategy instead of burning tokens.
 */

export interface DoomLoopConfig {
  /** Consecutive identical tool fingerprints required to trip (default 3) */
  threshold?: number;
  /** Max fingerprints retained (default 12) */
  window?: number;
}

export interface DoomLoopHit {
  tool: string;
  fingerprint: string;
  count: number;
  message: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Fingerprint a tool invocation for equality checks. */
export function toolFingerprint(
  name: string,
  input: Record<string, unknown>,
): string {
  // Drop noisy / non-semantic fields so retries that only flip transport knobs
  // (timeout, background, stream tail) still trip the doom-loop detector.
  const slim: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (
      k === "timeout_ms" ||
      k === "timeout" ||
      k === "raw" ||
      k === "background" ||
      k === "run_in_background" ||
      k === "stream" ||
      k === "tail" ||
      k === "allow_local"
    ) {
      continue;
    }
    slim[k] = v;
  }
  return `${name}::${stableStringify(slim)}`;
}

export class DoomLoopTracker {
  private readonly threshold: number;
  private readonly window: number;
  private recent: string[] = [];
  private lastHit: string | null = null;

  constructor(cfg: DoomLoopConfig = {}) {
    this.threshold = cfg.threshold ?? 3;
    this.window = cfg.window ?? 12;
  }

  reset(): void {
    this.recent = [];
    this.lastHit = null;
  }

  /**
   * Record a tool call. Returns a hit when the last `threshold` fingerprints
   * are identical (and we have not already reported this streak).
   */
  observe(name: string, input: Record<string, unknown>): DoomLoopHit | null {
    const fp = toolFingerprint(name, input);
    this.recent.push(fp);
    if (this.recent.length > this.window) {
      this.recent = this.recent.slice(-this.window);
    }

    if (this.recent.length < this.threshold) return null;
    const tail = this.recent.slice(-this.threshold);
    if (!tail.every((x) => x === fp)) {
      // Streak broken — allow future hits on a new streak
      if (this.lastHit && this.lastHit !== fp) this.lastHit = null;
      return null;
    }

    // Already warned for this continuous streak
    if (this.lastHit === fp) return null;
    this.lastHit = fp;

    return {
      tool: name,
      fingerprint: fp,
      count: this.threshold,
      message: buildDoomMessage(name, input, this.threshold),
    };
  }
}

function buildDoomMessage(
  name: string,
  input: Record<string, unknown>,
  count: number,
): string {
  const preview = summarizeInput(input);
  return (
    `[Forge doom-loop] You called \`${name}\` with the same arguments ${count} times in a row` +
    (preview ? ` (${preview})` : "") +
    `. STOP repeating. Change approach: re-read the file, try a different tool, ` +
    `narrow/broaden the query, fix the underlying error, or ask a clarifying question. ` +
    `Identical retries waste turns and will keep failing.`
  );
}

function summarizeInput(input: Record<string, unknown>): string {
  if (typeof input.command === "string") {
    return `command=${JSON.stringify(String(input.command).slice(0, 80))}`;
  }
  if (typeof input.path === "string") {
    return `path=${JSON.stringify(String(input.path).slice(0, 80))}`;
  }
  if (typeof input.pattern === "string") {
    return `pattern=${JSON.stringify(String(input.pattern).slice(0, 60))}`;
  }
  try {
    return JSON.stringify(input).slice(0, 100);
  } catch {
    return "";
  }
}
