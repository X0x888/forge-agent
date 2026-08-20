import { log } from "./log.js";
import { isHttp2ProtocolError } from "./http2-error.js";
import {
  isCursorAgentInternalBody,
  isProviderApiError,
} from "../providers/errors.js";

export { isHttp2ProtocolError } from "./http2-error.js";

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

/**
 * Undici/Node fetch + proxy drops that are *not* HTTP status errors.
 *
 * SuperGrok / xAI often RST the socket when an access token dies mid-stream
 * instead of returning HTTP 401/403. Node then throws `TypeError: terminated`
 * (message is exactly "terminated"). The previous auth-recovery path never
 * saw a 401, so unattended ULW died at the prompt — and typing "continue"
 * worked because the next loop proactively refreshed OAuth.
 */
export function isDroppedConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const name = err instanceof Error ? err.name : "";
  const t = msg.trim();
  if (/^terminated$/i.test(t)) return true;
  if (name === "TypeError" && /terminated/i.test(t)) return true;
  if (isHttp2ProtocolError(err)) return true;
  if (
    /other side closed|UND_ERR_|ERR_STREAM_PREMATURE_CLOSE|\bEPIPE\b|socket hang up|ECONNRESET|UND_ERR_SOCKET|connection (?:reset|closed|aborted)|premature (?:close|end)|network connection (?:lost|closed)/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/** Cursor AgentService Connect-RPC `internal` (HTTP 400) — protocol, not a 400 capability miss. */
export function isCursorProtocolInternalError(err: unknown): boolean {
  if (!isProviderApiError(err)) return false;
  if (!/^(cursor|cursor-ai|cursorai)$/i.test(err.provider)) return false;
  if (err.status !== 400) return false;
  return isCursorAgentInternalBody(err.body || err.message);
}

/**
 * Drops that recover by opening a fresh stream — not by rotating OAuth.
 * HTTP/2 RST and Cursor Connect `internal` are protocol/transport, not dead tokens.
 */
export function isReconnectWithoutAuthDrop(err: unknown): boolean {
  return isHttp2ProtocolError(err) || isCursorProtocolInternalError(err);
}

/**
 * Errors that must not be papered over by "just continue":
 * user abort, context overflow, hard 400/404 capability misses.
 */
export function isPermanentProviderHalt(err: unknown): boolean {
  if (isContextOverflowError(err)) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/^Aborted$/i.test(msg.trim()) || /aborted by user/i.test(msg)) {
    return true;
  }
  if (isProviderApiError(err)) {
    if (err.status === 400 || err.status === 404 || err.status === 422) {
      // Cursor Connect `internal` is a dead Run, not an unsupported-tools 400.
      if (isCursorProtocolInternalError(err)) return false;
      return true;
    }
  }
  if (
    /unsupported_feature|is not supported|does not support|org(?:anization)?.{0,40}verif|model is deprecated|model_not_found|unknown.?model/i.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * True when a fresh provider call (after optional OAuth refresh) is what a
 * human "continue" would do — so unattended ULW must not yield to the prompt.
 *
 * Includes the screenshot case: generic `terminated` / `provider_error`
 * with valid auth still on disk.
 */
export function isContinueRecoverableProviderError(err: unknown): boolean {
  if (isPermanentProviderHalt(err)) return false;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  // Quota / 429 have their own account-switch path. Do not infinite-continue
  // into a spend or rate wall. "terminated" is not quota.
  if (
    /rate.?limit|too many requests|insufficient[_\s-]?quota|quota.?exceeded|quota.?exhausted|payment.?required|credits?.?(exhausted|exceeded|depleted)|usage.?limit|plan.?limit|over.?limit/i.test(
      msg,
    ) &&
    !isDroppedConnectionError(err)
  ) {
    return false;
  }
  if (isProviderApiError(err) && (err.status === 402 || err.status === 429)) {
    return false;
  }
  if (/content.?filter|policy violation|safety system/i.test(msg)) {
    return false;
  }
  if (isDroppedConnectionError(err)) return true;
  if (isRetryableError(err)) return true;
  // Unclassified non-HTTP errors (TypeError: terminated, empty throws, …)
  // are exactly what "type continue" recovers — do not halt ULW.
  if (!isProviderApiError(err)) return true;
  if (err.status >= 500 || err.status === 408 || err.status === 529) {
    return true;
  }
  return false;
}

export function isRetryableError(err: unknown): boolean {
  // Never retry overflow — same payload will fail again
  if (isContextOverflowError(err)) return false;
  if (isDroppedConnectionError(err)) return true;
  if (isCursorProtocolInternalError(err)) return true;
  if (isProviderApiError(err)) return err.isRetryable;
  const msg = err instanceof Error ? err.message : String(err);
  // User abort is not retryable; provider wall-clock timeout is.
  if (/^Aborted$/i.test(msg.trim())) return false;
  if (/aborted|abort/i.test(msg) && !/timeout/i.test(msg)) return false;
  if (/timed out after \d+ms/i.test(msg)) return true;
  if (/\b(408|429|500|502|503|504)\b/.test(msg)) return true;
  // Dropped SSE / empty stream — retry with same payload is usually fine
  if (
    /stream ended with empty response|stream error:|dropped connection|empty choices array|empty response \(no content/i.test(
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
