import { parseDurationMs } from "./duration-ms.js";

/**
 * AbortSignal helpers for production timeouts + cooperative cancel.
 */

/** Default wall-clock budget for a single provider chat/stream call. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000; // 5 minutes

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
 * Combine an optional external signal with a timeout.
 * Aborting either aborts the returned signal. Caller should dispose when done.
 */
export function mergeAbortSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

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

  if (timeoutMs > 0 && !ctrl.signal.aborted) {
    timer = setTimeout(() => {
      if (!ctrl.signal.aborted) {
        // Generic wording — used by providers and tools (web_fetch/web_search).
        ctrl.abort(new Error(`Request timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    // Don't keep the process alive solely for the provider timer
    timer.unref?.();
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer) clearTimeout(timer);
    external?.removeEventListener("abort", abortFromExternal);
  };

  return { signal: ctrl.signal, dispose };
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
