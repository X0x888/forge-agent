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

/**
 * Expert-facing multi-line error with recovery tips (OpenCode-style).
 * Safe for REPL stderr and headless JSON `error` / `recovery` fields.
 */
export function formatProviderError(
  err: unknown,
  opts?: { provider?: string; model?: string },
): { message: string; tips: string[]; code: string } {
  const providerLabel =
    (isProviderApiError(err) ? err.provider : opts?.provider) || "provider";
  const model = opts?.model ? ` · model ${opts.model}` : "";
  const tips: string[] = [];
  let code = "provider_error";
  let headline = err instanceof Error ? err.message : String(err);

  if (isProviderApiError(err)) {
    code = `http_${err.status}`;
    const bodyHint = summarizeProviderBody(err.body);
    headline = `${providerLabel} HTTP ${err.status}${model}${
      bodyHint ? `: ${bodyHint}` : ""
    }`;
    if (err.retryAfterMs != null) {
      headline += ` (Retry-After ${Math.ceil(err.retryAfterMs / 1000)}s)`;
    }

    if (err.status === 401 || err.status === 403) {
      code = err.status === 401 ? "auth_expired" : "auth_forbidden";
      tips.push("forge login  (or forge login --add for another account)");
      tips.push("forge accounts status  ·  /accounts switch");
      tips.push("Check sticky provider: forge auth  ·  preferences.json");
    } else if (err.status === 429) {
      code = "rate_limited";
      tips.push("Wait for Retry-After, or forge accounts switch");
      tips.push("Auto-switch: forge accounts auto-switch on");
      tips.push("Lower concurrency / narrow the task");
    } else if (err.status === 402 || /quota|billing|payment|insufficient/i.test(err.body)) {
      code = "quota_exhausted";
      tips.push("forge accounts switch  ·  forge login --add");
      tips.push("Check plan usage: forge status  ·  /status");
    } else if (err.status === 404) {
      code = "not_found";
      tips.push("forge models -p " + err.provider + "  ·  /model <name>");
      tips.push("Verify base URL / model id spelling");
    } else if (err.status === 408 || err.status === 504) {
      code = "timeout";
      tips.push("Raise FORGE_PROVIDER_TIMEOUT_MS or narrow context (/compact)");
      tips.push("Retry: /retry  ·  forge run --continue");
    } else if (err.status === 413 || isContextOverflowish(err.body)) {
      code = "context_overflow";
      tips.push("/compact  ·  /compact-and <next>  ·  raise context_window");
      tips.push("Drop stale tool results (auto microcompaction) or start /new");
    } else if (err.status >= 500) {
      code = "provider_5xx";
      tips.push("Transient — Forge retries automatically; wait or /retry");
      tips.push("If persistent: switch model/provider or check status page");
    } else if (err.status === 400 || err.status === 422) {
      code = "bad_request";
      if (isContextOverflowish(err.body)) {
        code = "context_overflow";
        tips.push("/compact  ·  /new  ·  reduce max_tokens");
      } else {
        tips.push("Check model supports tools/vision for this request");
        tips.push("/model <other>  ·  forge doctor");
      }
    }
  } else {
    const msg = headline;
    if (/^Aborted$/i.test(msg.trim()) || /aborted by user/i.test(msg)) {
      code = "aborted";
      tips.push("Turn cancelled — type a new prompt or /retry");
    } else if (/timed out after \d+ms/i.test(msg) || /timeout/i.test(msg)) {
      code = "timeout";
      tips.push("FORGE_PROVIDER_TIMEOUT_MS  ·  /compact  ·  /retry");
    } else if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network/i.test(msg)) {
      code = "network";
      tips.push("Check network / VPN / proxy; retry shortly");
      tips.push("/retry  ·  forge run --continue");
    } else if (isContextOverflowish(msg)) {
      code = "context_overflow";
      tips.push("/compact  ·  /new  ·  raise context_window");
    } else if (/rate.?limit|429/i.test(msg)) {
      code = "rate_limited";
      tips.push("forge accounts switch  ·  wait and /retry");
    } else if (/401|unauthorized|invalid.?api.?key|auth/i.test(msg)) {
      code = "auth_expired";
      tips.push("forge login  ·  /accounts status");
    } else {
      tips.push("forge doctor  ·  /retry  ·  forge logs");
    }
  }

  if (!tips.length) {
    tips.push("forge doctor  ·  /retry  ·  forge logs");
  }

  return { message: headline, tips, code };
}

function isContextOverflowish(text: string): boolean {
  return /context.?length|context.?window|maximum.?prompt|prompt.?too.?long|too.?many.?tokens|token.?limit|request.?too.?large|context_length_exceeded/i.test(
    text || "",
  );
}

/** Pull a short human snippet from JSON or plain error bodies. */
function summarizeProviderBody(body: string): string {
  const raw = (body || "").trim();
  if (!raw) return "";
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const err = j.error as Record<string, unknown> | string | undefined;
    if (typeof err === "string") return err.slice(0, 200);
    if (err && typeof err === "object") {
      const msg = err.message || err.code || err.type;
      if (typeof msg === "string") return msg.slice(0, 200);
    }
    if (typeof j.message === "string") return j.message.slice(0, 200);
  } catch {
    /* plain text */
  }
  return raw.replace(/\s+/g, " ").slice(0, 200);
}

/** Single string for log.error / console — message + indented tips. */
export function formatProviderErrorText(
  err: unknown,
  opts?: { provider?: string; model?: string },
): string {
  const { message, tips, code } = formatProviderError(err, opts);
  const tipLines = tips.map((t) => `  → ${t}`).join("\n");
  return `${message}\n  [${code}]\n${tipLines}`;
}
