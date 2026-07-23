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
import { getCredential } from "../auth/store.js";
import { nowEpoch } from "../util/fs.js";

const CACHE_DIR = () => path.join(os.homedir(), ".forge", "statusline");
const CACHE_FILE = () => path.join(CACHE_DIR(), "plan-cache.json");

interface CacheFile {
  entries: Record<
    string,
    { fetchedAt: number; plan: PlanUsageInfo }
  >;
}

function readCache(key: string, ttlSec: number): PlanUsageInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE(), "utf8")) as CacheFile;
    const e = raw.entries?.[key];
    if (!e) return null;
    if (nowEpoch() - e.fetchedAt > ttlSec) return null;
    return e.plan;
  } catch {
    return null;
  }
}

function writeCache(key: string, plan: PlanUsageInfo): void {
  try {
    fs.mkdirSync(CACHE_DIR(), { recursive: true });
    let raw: CacheFile = { entries: {} };
    try {
      raw = JSON.parse(fs.readFileSync(CACHE_FILE(), "utf8")) as CacheFile;
    } catch {
      /* */
    }
    raw.entries[key] = { fetchedAt: nowEpoch(), plan };
    fs.writeFileSync(CACHE_FILE(), JSON.stringify(raw, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

async function fetchXaiCredits(token: string): Promise<PlanUsageInfo | null> {
  const cacheKey = "xai:credits";
  const cached = readCache(cacheKey, 60);
  if (cached) return cached;

  try {
    const resp = await fetch(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "forge-statusline/0.3",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!resp.ok) {
      return {
        source: "xai:billing",
        note: `billing HTTP ${resp.status}`,
        product: "SuperGrok",
      };
    }
    const data = (await resp.json()) as Record<string, unknown>;
    // Flexible parsing — Grok billing shapes evolve
    const used = num(data.used ?? data.credits_used ?? data.usage);
    const limit = num(data.limit ?? data.credits_limit ?? data.quota);
    const remaining =
      num(data.remaining ?? data.credits_remaining) ??
      (used != null && limit != null ? Math.max(0, limit - used) : undefined);
    let percent: number | undefined;
    if (used != null && limit != null && limit > 0) {
      percent = Math.min(100, Math.round((used / limit) * 100));
    } else if (typeof data.percent === "number") {
      percent = Math.min(100, Math.round(data.percent as number));
    } else if (typeof data.usage_percent === "number") {
      percent = Math.min(100, Math.round(data.usage_percent as number));
    }

    const plan: PlanUsageInfo = {
      percent,
      used: used ?? undefined,
      limit: limit ?? undefined,
      remaining: remaining ?? undefined,
      unit: "credits",
      periodLabel: str(data.period) || "week",
      resetsAt: str(data.period_end || data.reset_at || data.week_end),
      product: str(data.product) || "SuperGrok",
      source: "xai:cli-chat-proxy/billing",
    };
    writeCache(cacheKey, plan);
    return plan;
  } catch (err) {
    return {
      source: "xai:billing",
      note: `billing unavailable (${(err as Error).message?.slice(0, 60) || "error"})`,
      product: "SuperGrok",
    };
  }
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
 */
export async function collectPlanUsage(opts: {
  provider: string;
  authMethod: AuthMethod;
}): Promise<PlanUsageInfo | undefined> {
  const p = opts.provider.toLowerCase();

  // xAI / Grok subscription path
  if (p === "xai" || p === "grok") {
    if (opts.authMethod === "subscription" || opts.authMethod === "oauth") {
      const grok = readGrokXaiSession();
      const stored = getCredential("xai");
      const token = grok?.accessToken || stored?.accessToken;
      if (token) {
        const plan = await fetchXaiCredits(token);
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
