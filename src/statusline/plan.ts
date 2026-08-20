/**
 * Optional plan / quota adapters.
 *
 * Philosophy: never invent usage. Each provider contributes what it can:
 * - xAI SuperGrok (via Grok auth): weekly credits from cli-chat-proxy
 * - OpenAI / Codex: local rate-limit hints if present; else nothing
 * - GitHub Copilot: no public quota API → note only
 * - API keys: no plan segment (token estimates live under tokens.*)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlanUsageInfo, AuthMethod } from "./types.js";
import { readGrokXaiSession } from "../auth/import-grok.js";
import { getActiveAccount, getCredential } from "../auth/store.js";
import { recordAccountPlan } from "../auth/accounts.js";
import { nowEpoch, forgeHome, readJsonFile, writeJsonFile } from "../util/fs.js";

const CACHE_DIR = () => path.join(forgeHome(), "statusline");
const CACHE_FILE = () => path.join(CACHE_DIR(), "plan-cache.json");

interface CacheFile {
  entries: Record<
    string,
    { fetchedAt: number; plan: PlanUsageInfo }
  >;
}

function readCache(key: string, ttlSec: number): PlanUsageInfo | null {
  const raw = readJsonFile<CacheFile>(CACHE_FILE(), { entries: {} });
  const e = raw.entries?.[key];
  if (!e) return null;
  if (nowEpoch() - e.fetchedAt > ttlSec) return null;
  return e.plan;
}

function writeCache(key: string, plan: PlanUsageInfo): void {
  try {
    const raw = readJsonFile<CacheFile>(CACHE_FILE(), { entries: {} });
    raw.entries[key] = { fetchedAt: nowEpoch(), plan };
    // Atomic tmp+rename (0600) — a torn cache must never crash a probe.
    writeJsonFile(CACHE_FILE(), raw, 0o600);
  } catch {
    /* best-effort */
  }
}

/**
 * xAI SuperGrok billing body shapes (cli-chat-proxy) evolve; parse both:
 *
 *   GET /v1/billing?format=credits  → weekly usage % + period window
 *   {
 *     config: {
 *       currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end },
 *       creditUsagePercent: 22.0,
 *       productUsage: [{ product: "GrokBuild", usagePercent: 22.0 }, …],
 *       billingPeriodStart, billingPeriodEnd,
 *       …
 *     }
 *   }
 *
 *   GET /v1/billing  → absolute used/limit (often {val:N} wrappers)
 *   {
 *     config: {
 *       used: { val: 27795 }, monthlyLimit: { val: 150000 },
 *       billingPeriodStart, billingPeriodEnd, …
 *     }
 *   }
 *
 * Never invent numbers — only surface fields we can parse.
 */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Unwrap `{ val: N }` wrappers and plain numbers/strings. */
function numVal(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "object" && !Array.isArray(v) && "val" in (v as object)) {
    return num((v as { val: unknown }).val);
  }
  return num(v);
}

function periodLabelFromType(type: string | undefined): string | undefined {
  if (!type) return undefined;
  const t = type.toUpperCase();
  if (t.includes("WEEK")) return "week";
  if (t.includes("MONTH")) return "month";
  if (t.includes("DAY") || t.includes("DAILY")) return "day";
  if (t.includes("HOUR")) return "hour";
  return undefined;
}

/**
 * Parse a single billing JSON body into PlanUsageInfo fields.
 * Accepts both nested `config` and flat historical shapes.
 */
export function parseXaiBillingBody(
  data: Record<string, unknown>,
  source: string,
): PlanUsageInfo {
  const cfg = asRecord(data.config) ?? data;
  const period = asRecord(cfg.currentPeriod);

  // Absolute used / limit — top-level OR nested config, with {val} wrappers
  let used = numVal(
    cfg.used ??
      cfg.credits_used ??
      cfg.usage ??
      data.used ??
      data.credits_used ??
      data.usage,
  );
  let limit = numVal(
    cfg.monthlyLimit ??
      cfg.limit ??
      cfg.credits_limit ??
      cfg.quota ??
      data.limit ??
      data.credits_limit ??
      data.quota,
  );
  // Some responses store dollar-cents (val/100 → dollars of credit budget).
  // Only rescale when both look like cent-scale integers and limit is large.
  if (
    used != null &&
    limit != null &&
    limit >= 10_000 &&
    Number.isInteger(used) &&
    Number.isInteger(limit) &&
    used % 1 === 0
  ) {
    // Prefer leaving raw units and reporting percent; keep unit "credits".
    // (Display layer formats compactly.)
  }

  let remaining = numVal(
    cfg.remaining ??
      cfg.credits_remaining ??
      data.remaining ??
      data.credits_remaining,
  );
  if (remaining == null && used != null && limit != null) {
    remaining = Math.max(0, limit - used);
  }

  // Percent: prefer explicit weekly creditUsagePercent (format=credits)
  let percent: number | undefined;
  const creditPct = numVal(
    cfg.creditUsagePercent ??
      cfg.usage_percent ??
      cfg.percent ??
      data.creditUsagePercent ??
      data.usage_percent ??
      data.percent,
  );
  if (creditPct != null) {
    percent = Math.min(100, Math.round(creditPct));
  }

  // productUsage[] — prefer GrokBuild (Forge/CLI path), else first with %
  if (percent == null) {
    const products = Array.isArray(cfg.productUsage)
      ? cfg.productUsage
      : Array.isArray(data.productUsage)
        ? data.productUsage
        : [];
    let buildPct: number | null = null;
    let anyPct: number | null = null;
    for (const p of products) {
      const rec = asRecord(p);
      if (!rec) continue;
      const up = numVal(rec.usagePercent ?? rec.percent ?? rec.usage_percent);
      if (up == null) continue;
      const name = str(rec.product) || "";
      if (/grokbuild|build|cli/i.test(name)) buildPct = up;
      else if (anyPct == null) anyPct = up;
    }
    const pick = buildPct ?? anyPct;
    if (pick != null) percent = Math.min(100, Math.round(pick));
  }

  if (percent == null && used != null && limit != null && limit > 0) {
    percent = Math.min(100, Math.round((used / limit) * 100));
  }

  const periodType = str(period?.type) || str(cfg.periodType) || str(data.period);
  const periodLabel =
    periodLabelFromType(periodType) ||
    str(cfg.period) ||
    str(data.period) ||
    (period || cfg.billingPeriodEnd || data.period_end ? "week" : undefined);

  const resetsAt =
    str(period?.end) ||
    str(cfg.billingPeriodEnd) ||
    str(cfg.period_end) ||
    str(cfg.reset_at) ||
    str(cfg.week_end) ||
    str(data.period_end) ||
    str(data.reset_at) ||
    str(data.week_end) ||
    str(data.billingPeriodEnd);

  // Product label — prefer named productUsage entry, else SuperGrok
  let product = str(cfg.product) || str(data.product);
  if (!product && Array.isArray(cfg.productUsage)) {
    for (const p of cfg.productUsage) {
      const rec = asRecord(p);
      const name = rec ? str(rec.product) : undefined;
      if (name && /grokbuild|build/i.test(name)) {
        product = "SuperGrok Build";
        break;
      }
    }
  }
  product = product || "SuperGrok";

  return {
    percent,
    used: used ?? undefined,
    limit: limit ?? undefined,
    remaining: remaining ?? undefined,
    unit: "credits",
    periodLabel,
    resetsAt,
    product,
    source,
  };
}

function planHasSignal(plan: PlanUsageInfo): boolean {
  return (
    plan.percent != null ||
    plan.remaining != null ||
    (plan.used != null && plan.limit != null) ||
    Boolean(plan.resetsAt)
  );
}

async function fetchXaiBillingJson(
  token: string,
  url: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status?: number; err?: string }> {
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "forge-statusline/0.4",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(4_000),
    });
    if (!resp.ok) return { ok: false, status: resp.status };
    const data = (await resp.json()) as Record<string, unknown>;
    if (!data || typeof data !== "object") {
      return { ok: false, err: "non-object body" };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, err: (err as Error).message?.slice(0, 60) || "error" };
  }
}

async function fetchXaiCredits(
  token: string,
  cacheKeySuffix?: string,
): Promise<PlanUsageInfo | null> {
  // v2: nested config + creditUsagePercent parse (older keys cached empty "week")
  const cacheKey = cacheKeySuffix
    ? `xai:credits:v2:${cacheKeySuffix}`
    : "xai:credits:v2";
  const cached = readCache(cacheKey, 60);
  if (cached) return cached;

  const creditsUrl =
    "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
  const plainUrl = "https://cli-chat-proxy.grok.com/v1/billing";

  const primary = await fetchXaiBillingJson(token, creditsUrl);
  if (!primary.ok) {
    // Negative-cache: a down/blocked billing endpoint must not cost the
    // full timeout on every probe (forge status with N sessions).
    const note: PlanUsageInfo = {
      source: "xai:billing",
      note: primary.status
        ? `billing HTTP ${primary.status}`
        : `billing unavailable (${primary.err || "error"})`,
      product: "SuperGrok",
    };
    writeCache(cacheKey, note);
    return note;
  }

  let plan = parseXaiBillingBody(
    primary.data,
    "xai:cli-chat-proxy/billing?format=credits",
  );

  // If weekly % arrived but absolute used/limit did not, merge plain /billing.
  if (
    (plan.used == null || plan.limit == null) &&
    (plan.percent != null || plan.resetsAt)
  ) {
    const secondary = await fetchXaiBillingJson(token, plainUrl);
    if (secondary.ok) {
      const extra = parseXaiBillingBody(
        secondary.data,
        "xai:cli-chat-proxy/billing",
      );
      plan = {
        ...plan,
        used: plan.used ?? extra.used,
        limit: plan.limit ?? extra.limit,
        remaining: plan.remaining ?? extra.remaining,
        // Prefer weekly reset from credits format; fall back to monthly window
        resetsAt: plan.resetsAt ?? extra.resetsAt,
        periodLabel: plan.periodLabel ?? extra.periodLabel,
        // Keep weekly percent; only fill if still missing
        percent: plan.percent ?? extra.percent,
        source: planHasSignal(plan)
          ? plan.source
          : extra.source,
      };
      if (plan.used != null && plan.limit != null && plan.remaining == null) {
        plan.remaining = Math.max(0, plan.limit - plan.used);
      }
    }
  } else if (!planHasSignal(plan)) {
    // Credits body empty — try plain billing as sole source
    const secondary = await fetchXaiBillingJson(token, plainUrl);
    if (secondary.ok) {
      plan = parseXaiBillingBody(
        secondary.data,
        "xai:cli-chat-proxy/billing",
      );
    }
  }

  // Only default periodLabel when we have real usage signal
  if (!plan.periodLabel && planHasSignal(plan)) {
    plan.periodLabel = "week";
  }

  writeCache(cacheKey, plan);
  return plan;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Best-effort Codex / ChatGPT local usage hints (no network). */
function readCodexLocalHints(): PlanUsageInfo | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".codex", "rate_limits.json"),
    path.join(home, ".codex", "cache", "rate_limits.json"),
    path.join(home, ".codex", "session_usage.json"),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
      const used = num(data.used ?? data.primary_used ?? data.tokens_used);
      const limit = num(data.limit ?? data.primary_limit ?? data.tokens_limit);
      const remaining =
        num(data.remaining) ??
        (used != null && limit != null ? Math.max(0, limit - used) : undefined);
      let percent: number | undefined;
      if (used != null && limit != null && limit > 0) {
        percent = Math.min(100, Math.round((used / limit) * 100));
      }
      return {
        percent,
        used: used ?? undefined,
        limit: limit ?? undefined,
        remaining: remaining ?? undefined,
        unit: str(data.unit) || "tokens",
        periodLabel: str(data.period) || "window",
        product: "Codex / ChatGPT",
        source: `codex:local:${path.basename(f)}`,
        note: percent == null ? "local file present but incomplete" : undefined,
      };
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Collect plan usage for the active provider/auth combination.
 * Safe to call often (cached + short timeouts).
 * When multi-account is active, also records lastPlan on the account for
 * proactive auto-switch ranking.
 */
export async function collectPlanUsage(opts: {
  provider: string;
  authMethod: AuthMethod;
  /** Optional active account id for per-account cache + plan recording */
  accountId?: string;
}): Promise<PlanUsageInfo | undefined> {
  const p = opts.provider.toLowerCase();

  // xAI / Grok subscription path
  if (p === "xai" || p === "grok") {
    if (opts.authMethod === "subscription" || opts.authMethod === "oauth") {
      const active = getActiveAccount("xai");
      const grok = readGrokXaiSession();
      const stored = getCredential("xai");
      const token = active?.accessToken || grok?.accessToken || stored?.accessToken;
      const accountId = opts.accountId || active?.id;
      if (token) {
        const plan = await fetchXaiCredits(token, accountId);
        if (plan && accountId && (plan.percent != null || plan.remaining != null)) {
          try {
            recordAccountPlan(accountId, {
              percent: plan.percent,
              used: plan.used,
              remaining: plan.remaining,
              limit: plan.limit,
              unit: plan.unit,
              source: plan.source,
            });
          } catch {
            /* best-effort */
          }
        }
        return plan || undefined;
      }
      return {
        source: "xai",
        product: "SuperGrok",
        note: "subscription auth but no token for billing probe",
      };
    }
    // API key: no credits bar — token usage is session-level
    return {
      source: "xai:api_key",
      note: "API key path — plan credits not applicable; see session tokens",
      product: "xAI API",
    };
  }

  // OpenAI / Codex-style
  if (p === "openai" || p === "codex") {
    if (opts.authMethod === "subscription" || opts.authMethod === "oauth") {
      const local = readCodexLocalHints();
      if (local) return local;
      return {
        source: "openai:subscription",
        product: "ChatGPT / Codex",
        note: "no local rate-limit file; session tokens only",
      };
    }
    return {
      source: "openai:api_key",
      note: "API key — billed per token; see session cost estimate",
      product: "OpenAI API",
    };
  }

  // GitHub Copilot
  if (p === "copilot" || p === "github" || p === "github-copilot") {
    return {
      source: "copilot",
      product: "GitHub Copilot",
      note: "quota not exposed to third-party CLIs; session tokens only",
    };
  }

  // Cursor subscription
  if (p === "cursor" || p === "cursor-ai" || p === "cursorai") {
    return {
      source: "cursor",
      product: "Cursor",
      note:
        "native Cursor quota (no third-party % API) · session tokens + cache on the dock · cursor.com/dashboard/spending",
    };
  }

  // Anthropic / OpenRouter / Google / custom API keys
  if (opts.authMethod === "api_key") {
    return {
      source: `${p}:api_key`,
      product: p,
      note: "API key — plan bar N/A; session tokens + est. cost",
    };
  }

  return {
    source: p,
    note: "no plan adapter for this provider",
  };
}
