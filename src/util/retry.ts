import { log } from "./log.js";

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
  signal?: AbortSignal;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/aborted|abort/i.test(msg) && !/timeout/i.test(msg)) return false;
  if (/\b(429|502|503|504)\b/.test(msg)) return true;
  if (/rate.?limit|overloaded|temporar|timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg)) {
    return true;
  }
  return false;
}

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
      const delay = Math.min(maxDelay, base * 2 ** attempt + Math.random() * 200);
      log.warn(
        `${opts.label || "request"} failed (attempt ${attempt + 1}/${retries + 1}): ${(err as Error).message?.slice(0, 120) || err}. Retrying in ${Math.round(delay)}ms…`,
      );
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}
