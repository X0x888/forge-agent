/**
 * Structured provider API errors — carry HTTP status + Retry-After so the
 * retry layer can honor server backoff (OpenCode-style production reliability).
 */

export class ProviderApiError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs?: number;
  readonly headers: Record<string, string>;

  constructor(opts: {
    provider: string;
    status: number;
    body: string;
    retryAfterMs?: number;
    headers?: Record<string, string>;
  }) {
    super(`${opts.provider} API error ${opts.status}: ${opts.body.slice(0, 800)}`);
    this.name = "ProviderApiError";
    this.provider = opts.provider;
    this.status = opts.status;
    this.body = opts.body;
    this.retryAfterMs = opts.retryAfterMs;
    this.headers = opts.headers ?? {};
  }

  get isRetryable(): boolean {
    if (this.status === 429) return true;
    if (this.status === 408) return true;
    if (this.status >= 500 && this.status <= 599) return true;
    return false;
  }
}

export function isProviderApiError(err: unknown): err is ProviderApiError {
  return err instanceof ProviderApiError;
}

/**
 * Parse Retry-After / retry-after-ms response headers into a delay in ms.
 * Supports delta-seconds and HTTP-date forms (RFC 7231).
 */
export function parseRetryAfterMs(
  headers: Headers | Record<string, string | null | undefined>,
): number | undefined {
  const get = (name: string): string | undefined => {
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(name) ?? undefined;
    }
    const rec = headers as Record<string, string | null | undefined>;
    const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? (rec[key] ?? undefined) ?? undefined : undefined;
  };

  const msHeader = get("retry-after-ms");
  if (msHeader) {
    const n = Number.parseFloat(msHeader);
    if (!Number.isNaN(n) && n >= 0) return capRetryDelay(n);
  }

  const ra = get("retry-after");
  if (!ra) return undefined;

  const seconds = Number.parseFloat(ra);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return capRetryDelay(Math.ceil(seconds * 1000));
  }

  const when = Date.parse(ra);
  if (!Number.isNaN(when)) {
    const delta = when - Date.now();
    if (delta > 0) return capRetryDelay(delta);
  }
  return undefined;
}

const MAX_RETRY_AFTER_MS = 120_000; // 2 min cap — don't freeze the agent forever

function capRetryDelay(ms: number): number {
  return Math.min(Math.max(0, Math.ceil(ms)), MAX_RETRY_AFTER_MS);
}

/** Lowercase header map for logging / structured errors. */
export function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export async function throwIfNotOk(
  provider: string,
  resp: Response,
): Promise<void> {
  if (resp.ok) return;
  const body = await resp.text().catch(() => "");
  const headers = headerMap(resp.headers);
  const retryAfterMs = parseRetryAfterMs(resp.headers);
  throw new ProviderApiError({
    provider,
    status: resp.status,
    body,
    retryAfterMs,
    headers,
  });
}
