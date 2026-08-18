import { parseDurationMs } from "./duration-ms.js";

/**
 * AbortSignal helpers for production timeouts + cooperative cancel.
 */

/**
 * Default **stall** budget for a single provider chat/stream call.
 *
 * This is not a total wall-clock cap on healthy streams. It is how long we
 * tolerate *silence* (no bytes / no activity) before aborting:
 * - pre-first-token: high-effort reasoning can think for minutes
 * - mid-stream: dead connection / hung proxy
 *
 * Stream readers call `touch()` on each chunk so active long generations
 * (ULW, max effort, large outputs) are not killed at a fixed 10-minute wall.
 * Tune with FORGE_PROVIDER_TIMEOUT_MS (5s–60min accepted).
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 600_000; // 10 minutes stall

/**
 * Optional absolute wall-clock ceiling for one provider call (stall resets
 * do not extend this). 0 / unset = no absolute cap (stall-only). Cap range
 * 1m–6h when set. Env: FORGE_PROVIDER_MAX_MS.
 */
export const DEFAULT_PROVIDER_MAX_MS = 0;

export function providerTimeoutMs(): number {
  const raw = process.env.FORGE_PROVIDER_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = parseDurationMs(raw);
    if (parsed.ok && parsed.ms >= 5_000 && parsed.ms <= 3_600_000) {
      return parsed.ms;
    }
  }
  return DEFAULT_PROVIDER_TIMEOUT_MS;
}

/**
 * Absolute wall-clock cap for one provider request. Independent of stall
 * resets. 0 means disabled (rely on stall + user abort only).
 */
export function providerMaxWallMs(): number {
  const raw = process.env.FORGE_PROVIDER_MAX_MS?.trim();
  if (!raw || raw === "0" || /^off$/i.test(raw)) return 0;
  const parsed = parseDurationMs(raw);
  if (parsed.ok && parsed.ms >= 60_000 && parsed.ms <= 21_600_000) {
    return parsed.ms;
  }
  return DEFAULT_PROVIDER_MAX_MS;
}

/**
 * Wall for a stream that has produced **no visible output** (no content,
 * no tool_call). Reasoning SSE / keepalives reset the stall timer but must
 * not extend this — maze dogfood sat 59 minutes thinking then stopped empty.
 *
 * Default 12 minutes. `0` / `off` disables. Env: FORGE_PROVIDER_REASONING_WALL_MS.
 */
export const DEFAULT_PROVIDER_REASONING_WALL_MS = 720_000;

export function providerReasoningWallMs(): number {
  const raw = process.env.FORGE_PROVIDER_REASONING_WALL_MS?.trim();
  if (raw === "0" || (raw && /^off$/i.test(raw))) return 0;
  if (raw) {
    const parsed = parseDurationMs(raw);
    // 20ms floor so tests can use short walls; production default is 12m.
    if (parsed.ok && parsed.ms >= 20 && parsed.ms <= 3_600_000) {
      return parsed.ms;
    }
  }
  return DEFAULT_PROVIDER_REASONING_WALL_MS;
}

export interface ReasoningOutputWall {
  /** Call when a content or tool_call delta arrives. */
  noteVisibleOutput: () => void;
  dispose: () => void;
}

/**
 * Fire `onFire` once if no visible output arrives within `wallMs`.
 * Keepalives / reasoning tokens must not reset this.
 */
export function armReasoningOutputWall(
  wallMs: number,
  onFire: () => void,
): ReasoningOutputWall {
  if (wallMs <= 0) {
    return { noteVisibleOutput() {}, dispose() {} };
  }
  let saw = false;
  let fired = false;
  const timer = setTimeout(() => {
    if (saw || fired) return;
    fired = true;
    onFire();
  }, wallMs);
  timer.unref?.();
  return {
    noteVisibleOutput() {
      if (saw) return;
      saw = true;
      clearTimeout(timer);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

export interface MergeAbortHandle {
  signal: AbortSignal;
  dispose: () => void;
  /**
   * Reset the stall timer (call on stream activity). No-op after dispose or
   * when stallMs is 0. Does not reset the absolute wall-clock max.
   */
  touch: () => void;
}

/**
 * Combine an optional external signal with a **stall** timeout (and optional
 * absolute wall-clock max).
 *
 * - Without `touch()`: behaves like a classic wall-clock timeout (tools,
 *   non-stream chat).
 * - With `touch()` on each stream chunk: only silent periods abort — long
 *   healthy streams survive past the stall window.
 */
export function mergeAbortSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
  opts?: { maxWallMs?: number },
): MergeAbortHandle {
  const ctrl = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const stallMs = timeoutMs > 0 ? timeoutMs : 0;
  // Absolute cap only when callers opt in (providers pass providerMaxWallMs()).
  // Tools (web_fetch/web_search) must not inherit FORGE_PROVIDER_MAX_MS.
  const maxWallMs =
    opts?.maxWallMs !== undefined && opts.maxWallMs > 0 ? opts.maxWallMs : 0;

  const abortFromExternal = () => {
    if (!ctrl.signal.aborted) {
      ctrl.abort(external?.reason ?? new Error("Aborted"));
    }
  };

  if (external) {
    if (external.aborted) {
      abortFromExternal();
    } else {
      external.addEventListener("abort", abortFromExternal, { once: true });
    }
  }

  const armStall = () => {
    if (disposed || stallMs <= 0 || ctrl.signal.aborted) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (!ctrl.signal.aborted) {
        // Generic wording — used by providers and tools (web_fetch/web_search).
        ctrl.abort(new Error(`Request timed out after ${stallMs}ms`));
      }
    }, stallMs);
    // Don't keep the process alive solely for the provider timer
    stallTimer.unref?.();
  };

  if (!ctrl.signal.aborted) {
    armStall();
    if (maxWallMs > 0) {
      maxTimer = setTimeout(() => {
        if (!ctrl.signal.aborted) {
          ctrl.abort(
            new Error(`Request timed out after ${maxWallMs}ms (absolute max)`),
          );
        }
      }, maxWallMs);
      maxTimer.unref?.();
    }
  }

  const touch = () => {
    if (disposed || ctrl.signal.aborted) return;
    armStall();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (stallTimer) clearTimeout(stallTimer);
    if (maxTimer) clearTimeout(maxTimer);
    external?.removeEventListener("abort", abortFromExternal);
  };

  return { signal: ctrl.signal, dispose, touch };
}

/** True when an error is a timeout (retryable) vs user abort (not). */
export function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed out after \d+ms/i.test(msg)) return true;
  if (/timeout/i.test(msg) && !/aborted/i.test(msg)) return true;
  // DOMException AbortError from AbortSignal.timeout
  if (err && typeof err === "object" && "name" in err) {
    const name = String((err as { name?: string }).name);
    if (name === "TimeoutError") return true;
  }
  return false;
}
