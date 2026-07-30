import { log } from "./log.js";
import { isProviderApiError } from "../providers/errors.js";

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
  signal?: AbortSignal;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Optional hook so UIs can show "retrying in Ns…" */
  onRetry?: (info: {
    attempt: number;
    retries: number;
    delayMs: number;
    error: unknown;
  }) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Aborted"));
    };
    const t = setTimeout(() => {
      // Detach on the happy path — the run-long signal would otherwise
      // accumulate one listener per retry (MaxListenersExceededWarning).
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Context / prompt-too-long errors must not be retried with the same payload
 * (OpenCode-style). Callers should compact then re-issue once.
 */
export function isContextOverflowError(err: unknown): boolean {
  if (isProviderApiError(err)) {
    // Some gateways return 400/413 with overflow body
    if (err.status === 413) return true;
    if (
      (err.status === 400 || err.status === 422) &&
      isContextOverflowMessage(err.body || err.message)
    ) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return isContextOverflowMessage(msg);
}

/**
 * Detect provider "prompt too large" phrasing across vendors.
 *
 * xAI (observed): `This model's maximum prompt length is 500000 but the
 * request contains 500644 tokens.` — older patterns only matched
 * "context length", so overflow recovery never fired and ULW died mid-cycle.
 */
function isContextOverflowMessage(msg: string): boolean {
  if (/rate.?limit/i.test(msg)) return false;
  return (
    /context.?length|context.?window|maximum.?context|max.?context|prompt.?too.?long|too.?many.?tokens|token.?limit|request.?too.?large|exceeds?.?(the )?(maximum|model)|input.?too.?long|context_length_exceeded|string.?too.?long|reduce.?the.?length|maximum.?prompt.?length|prompt.?length|max(?:imum)?.?prompt|request contains \d[\d,]* tokens|prompt is too long|tokens? (?:exceed|over|above)|over the (?:maximum|limit)|invalid-argument[\s\S]{0,120}token/i.test(
      msg,
    )
  );
}

export function isRetryableError(err: unknown): boolean {
  // Never retry overflow — same payload will fail again
  if (isContextOverflowError(err)) return false;
  if (isProviderApiError(err)) return err.isRetryable;
  const msg = err instanceof Error ? err.message : String(err);
  // User abort is not retryable; provider wall-clock timeout is.
  if (/^Aborted$/i.test(msg.trim())) return false;
  if (/aborted|abort/i.test(msg) && !/timeout/i.test(msg)) return false;
  if (/timed out after \d+ms/i.test(msg)) return true;
  if (/\b(408|429|500|502|503|504)\b/.test(msg)) return true;
  // Dropped SSE / empty stream — retry with same payload is usually fine
  if (
    /stream ended with empty response|stream error:|dropped connection/i.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /rate.?limit|overloaded|temporar|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network/i.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Compute backoff delay. Honors ProviderApiError.retryAfterMs when present
 * (OpenCode-style Retry-After support).
 */
export function computeRetryDelayMs(
  err: unknown,
  attempt: number,
  opts: { baseDelayMs?: number; maxDelayMs?: number } = {},
): number {
  const base = opts.baseDelayMs ?? 800;
  const maxDelay = opts.maxDelayMs ?? 12_000;

  if (isProviderApiError(err) && err.retryAfterMs != null && err.retryAfterMs > 0) {
    // The server hint wins over the client maxDelay (already capped at 120s
    // by parseRetryAfterMs) — clamping a `Retry-After: 60` to 12s just eats
    // another 429 and burns the retry budget during sustained limiting.
    return Math.min(MAX_SERVER_RETRY_DELAY_MS, Math.max(200, err.retryAfterMs));
  }

  return Math.min(maxDelay, base * 2 ** attempt + Math.random() * 200);
}

/** Ceiling for server-supplied Retry-After hints (matches errors.ts cap). */
const MAX_SERVER_RETRY_DELAY_MS = 120_000;

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 800;
  const maxDelay = opts.maxDelayMs ?? 12_000;
  const shouldRetry = opts.shouldRetry ?? ((e) => isRetryableError(e));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new Error("Aborted");
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !shouldRetry(err, attempt)) throw err;
      const delay = computeRetryDelayMs(err, attempt, {
        baseDelayMs: base,
        maxDelayMs: maxDelay,
      });
      opts.onRetry?.({
        attempt: attempt + 1,
        retries: retries + 1,
        delayMs: delay,
        error: err,
      });
      const reason = isProviderApiError(err)
        ? `${err.status}${err.retryAfterMs != null ? ` retry-after=${Math.round(err.retryAfterMs)}ms` : ""}`
        : (err as Error).message?.slice(0, 120) || String(err);
      log.warn(
        `${opts.label || "request"} failed (attempt ${attempt + 1}/${retries + 1}): ${reason}. Retrying in ${Math.round(delay)}ms…`,
      );
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}
