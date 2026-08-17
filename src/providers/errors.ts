/**
 * Structured provider API errors — carry HTTP status + Retry-After so the
 * retry layer can honor server backoff (OpenCode-style production reliability).
 */
import { clipAnsi, visibleWidth } from "../util/format.js";

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
    // Anthropic overloaded (and some gateways) use 529.
    if (this.status === 529) return true;
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
    const bodyBlob = `${err.body || ""}\n${bodyHint}`;
    headline = `${providerLabel} HTTP ${err.status}${model}${
      bodyHint ? `: ${bodyHint}` : ""
    }`;
    if (err.retryAfterMs != null) {
      headline += ` (Retry-After ${Math.ceil(err.retryAfterMs / 1000)}s)`;
    }

    // Body-first classification for ambiguous statuses (403 quota, 400 model, 529 overload).
    if (isQuotaExhaustedish(bodyBlob) || err.status === 402) {
      code = "quota_exhausted";
      tips.push("forge accounts switch  ·  forge login --add");
      tips.push("Check plan usage: forge status  ·  /status");
    } else if (isContentFilterish(bodyBlob)) {
      code = "content_filter";
      tips.push("Rephrase · drop secrets/PII · /model <other> · narrower scope");
      tips.push("/compact  ·  /retry");
    } else if (isOverloadedish(bodyBlob) || err.status === 529) {
      code = "provider_overloaded";
      tips.push("Transient overload — wait briefly, then /retry");
      tips.push("forge accounts switch  ·  /model <other>  ·  narrower task");
    } else if (isModelNotFoundish(bodyBlob) || err.status === 404) {
      code = "not_found";
      tips.push("forge models -p " + err.provider + "  ·  /model <name>");
      tips.push("Verify base URL / model id spelling");
    } else if (err.status === 401 || err.status === 403) {
      code = err.status === 401 ? "auth_expired" : "auth_forbidden";
      const body = err.body || headline;
      const isOpenRouter =
        /openrouter/i.test(providerLabel) || /openrouter/i.test(body);
      const missingAuthHdr = /missing authentication header/i.test(body);
      if (isOpenRouter || missingAuthHdr) {
        tips.push(
          "OpenRouter needs sk-or-v1-… from https://openrouter.ai/keys",
        );
        tips.push(
          "DeepSeek platform sk-… keys → forge login -p deepseek --api-key …  ·  forge -p deepseek -m deepseek-v4-flash",
        );
        tips.push(
          "forge login -p openrouter --api-key 'sk-or-v1-…'  ·  or OPENROUTER_API_KEY / DEEPSEEK_API_KEY",
        );
        tips.push("forge auth  ·  forge accounts status");
      } else if (/deepseek/i.test(providerLabel)) {
        tips.push(
          "forge login -p deepseek --api-key $DEEPSEEK_API_KEY  (platform.deepseek.com)",
        );
        tips.push("export DEEPSEEK_API_KEY=sk-…  ·  forge accounts status");
      } else {
        tips.push(
          "Forge auto-refreshes OAuth mid-run; if this persists: forge login",
        );
        tips.push("forge login --add  ·  forge accounts status  ·  /accounts switch");
        tips.push("Multi-day unattended: forge login --api-key (no refresh_token needed)");
      }
    } else if (err.status === 429) {
      code = "rate_limited";
      tips.push("Wait for Retry-After, or forge accounts switch");
      tips.push("Auto-switch: forge accounts auto-switch on");
      tips.push("Lower concurrency / narrow the task");
    } else if (err.status === 408 || err.status === 504) {
      code = "timeout";
      tips.push(
        "Raise FORGE_PROVIDER_TIMEOUT_MS (stall silence budget) or /compact; active streams no longer die at a fixed wall clock",
      );
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
      } else if (isUnsupportedFeatureish(err.body)) {
        code = "unsupported_feature";
        tips.push("/model <other> that supports tools/vision/params");
        tips.push("forge models -p " + err.provider + "  ·  drop unsupported params");
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
      tips.push(
        "FORGE_PROVIDER_TIMEOUT_MS (stall)  ·  FORGE_PROVIDER_MAX_MS (optional absolute)  ·  /compact  ·  /retry",
      );
    } else if (
      /^terminated$/i.test(msg.trim()) ||
      /other side closed|UND_ERR_|ERR_STREAM_PREMATURE_CLOSE|\bEPIPE\b|premature (?:close|end)/i.test(
        msg,
      )
    ) {
      code = "network";
      tips.push("Dropped connection — Forge retries and refreshes OAuth automatically");
      tips.push("If it persists: /retry  ·  forge run --continue");
    } else if (
      /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|getaddrinfo|fetch failed|socket hang up|network/i.test(
        msg,
      )
    ) {
      code = "network";
      tips.push("Check network / VPN / proxy / DNS; retry shortly");
      tips.push("/retry  ·  forge run --continue");
    } else if (isContextOverflowish(msg)) {
      code = "context_overflow";
      tips.push("/compact  ·  /new  ·  raise context_window");
    } else if (isQuotaExhaustedish(msg) || /402|payment.?required/i.test(msg)) {
      code = "quota_exhausted";
      tips.push("forge accounts switch  ·  forge login --add");
      tips.push("Check plan usage: forge status  ·  /status");
    } else if (isOverloadedish(msg)) {
      code = "provider_overloaded";
      tips.push("Transient overload — wait briefly, then /retry");
      tips.push("forge accounts switch  ·  /model <other>");
    } else if (isModelNotFoundish(msg)) {
      code = "not_found";
      tips.push(
        opts?.provider
          ? `forge models -p ${opts.provider}  ·  /model <name>`
          : "forge models  ·  /model <name>",
      );
      tips.push("Verify model id spelling / provider pin");
    } else if (/rate.?limit|429/i.test(msg)) {
      code = "rate_limited";
      tips.push("forge accounts switch  ·  wait and /retry");
    } else if (isContentFilterish(msg)) {
      code = "content_filter";
      tips.push("Rephrase · drop secrets/PII · /model <other> · narrower scope");
      tips.push("/compact  ·  /retry");
    } else if (isEmptyResponseish(msg)) {
      code = "empty_response";
      tips.push("/retry  ·  forge run --continue");
      tips.push("If repeated: /compact  ·  /model <other>  ·  narrower task");
    } else if (isUnsupportedFeatureish(msg)) {
      code = "unsupported_feature";
      tips.push("/model <other> that supports tools/vision/params");
      tips.push(
        opts?.provider
          ? `forge models -p ${opts.provider}  ·  drop unsupported params`
          : "forge models  ·  drop unsupported params",
      );
    } else if (/organiz(?:ation|ation).{0,40}verif|must be verified/i.test(msg)) {
      code = "org_verification";
      tips.push("Complete provider org verification in the vendor console");
      tips.push("forge accounts switch  ·  /model <other>  ·  forge login --add");
    } else if (/model is deprecated|deprecated model/i.test(msg)) {
      code = "model_deprecated";
      tips.push(
        opts?.provider
          ? `forge models -p ${opts.provider}  ·  /model <current>`
          : "forge models  ·  /model <current>",
      );
      tips.push("Update pinned model in preferences / CLI flags");
    } else if (/401|unauthorized|invalid.?api.?key|auth/i.test(msg)) {
      code = "auth_expired";
      tips.push(
        "Forge auto-refreshes OAuth mid-run; if this persists: forge login  ·  /accounts status",
      );
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
  // Anthropic: "prompt is too long: 200000 tokens > 100000 maximum"
  // OpenAI: "maximum context length is …" / context_length_exceeded
  // xAI/gateways: "request too large"
  return /context.?length|context.?window|maximum.?prompt|prompt.?is.?too.?long|prompt.?too.?long|too.?long(?:\s*:)?\s*\d+\s*tokens|tokens?\s*>\s*\d+|too.?many.?tokens|token.?limit|request.?too.?large|context_length_exceeded|max(?:imum)?\s+(?:context|prompt|input)/i.test(
    text || "",
  );
}

function isQuotaExhaustedish(text: string): boolean {
  // Prefer explicit quota/credit/spend phrasing over bare "billing"
  // (avoids misclassifying billing-address validation errors).
  return /insufficient.?quota|quota.?exceeded|quota.?exhausted|payment.?required|exceeded.+credit|out of credits|credit balance|spend.?limit|usage.?limit.?reached|billing.?hard.?limit|billing.?quota/i.test(
    text || "",
  );
}

function isOverloadedish(text: string): boolean {
  return /overloaded(?:_error)?|server.?busy|high.?demand|too many requests.*try again later|(?:at|no) capacity/i.test(
    text || "",
  );
}

function isModelNotFoundish(text: string): boolean {
  // Keep "does not exist" gated on "model" nearby so generic 404/400 bodies
  // (resource missing, file missing) do not become not_found tips.
  return /model.?not.?found|unknown.?model|invalid.?model|no such model|model_not_found|model[^.\n]{0,40}does not exist|does not exist[^.\n]{0,40}model|not_found_error[^.\n]{0,40}model/i.test(
    text || "",
  );
}

function isContentFilterish(text: string): boolean {
  // OpenAI/Azure: content_filter / content management policy
  // Anthropic-ish: safety refusals / blocked by …
  return /content.?filter|content.?filtered|content.?management.?policy|prompt.?triggering|safety.?refus|blocked by|responsible.?ai|jailbreak.?detected|policy violation|safety system/i.test(
    text || "",
  );
}

function isEmptyResponseish(text: string): boolean {
  return /empty response|empty completion|no completion choices|stream ended without choices|no choices returned|choices array is empty|missing completion|blank completion|zero choices|received empty/i.test(
    text || "",
  );
}

function isUnsupportedFeatureish(text: string): boolean {
  // Model/param capability mismatches — not generic 400s.
  return /unsupported_value|does not support|is not supported|not supported with this model|tools?.{0,20}not support|vision.{0,20}not support|image_url is not|temperature does not|max_tokens is too large|invalid schema for function|tool_use_id not found/i.test(
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

/** REPL closer after a failed turn — Allow?-style keys, not a tip lecture. */
export const PROVIDER_ERROR_RECOVERY =
  "Error? /retry same prompt · /model to switch · type to continue";

/** Pack Error? keys onto as few rows as fit; last row keeps a trailing space. */
export function wrapErrorAskLine(line: string, cols: number): string {
  const caret = "Error? ";
  const body = line.startsWith(caret) ? line.slice(caret.length) : line;
  const tokens = body
    .split(" · ")
    .map((t) => t.trim())
    .filter(Boolean);
  const rows: string[] = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current
      ? `${current} · ${token}`
      : rows.length === 0
        ? `${caret}${token}`
        : `  · ${token}`;
    if (visibleWidth(candidate) <= cols) {
      current = candidate;
      continue;
    }
    if (current) {
      rows.push(current);
      current = "";
    }
    const alone = rows.length === 0 ? `${caret}${token}` : `  · ${token}`;
    current = visibleWidth(alone) <= cols ? alone : clipAnsi(alone, cols);
  }
  if (current) rows.push(current);
  if (!rows.length) return `${caret} `;
  rows[rows.length - 1] = `${rows[rows.length - 1]!.replace(/\s+$/, "")} `;
  return rows.join("\n");
}

/** Designed failure card for log.error / REPL — not a tip dump. */
export function formatProviderErrorText(
  err: unknown,
  opts?: { provider?: string; model?: string; repl?: boolean; columns?: number },
): string {
  const { message, tips, code } = formatProviderError(err, opts);
  const cols = Math.max(
    8,
    opts?.columns ?? (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  const headline = clipAnsi(`✖ ${message}`, cols);
  const meta = clipAnsi(`  [${code}]`, cols);
  const shown = opts?.repl ? tips.slice(0, 1) : tips.slice(0, 2);
  const tipLines = shown.map((t) => clipAnsi(`  → ${t}`, cols));
  const keys = opts?.repl
    ? wrapErrorAskLine(`${PROVIDER_ERROR_RECOVERY} `, cols)
    : "";
  return [headline, meta, ...tipLines, keys].filter(Boolean).join("\n");
}
