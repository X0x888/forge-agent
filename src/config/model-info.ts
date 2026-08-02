/**
 * Per-model context window lookup.
 *
 * `context_window` config stays the explicit override; when the user has NOT
 * set it, the window is re-derived from the active model so /model grok-3
 * (131k) does not keep grok-4.5's 500k and die of provider overflow at 0.92
 * hard-headroom while auto-compact still thinks there is room.
 *
 * Lookup order:
 *  1. Exact id (normalized bare key)
 *  2. Family prefix heuristics
 *  3. OpenRouter remote/cache catalog (`context_length` from /api/v1/models)
 */
import path from "node:path";
import { forgeHome, readJsonFile } from "../util/fs.js";

/** Strip provider prefix and xAI alias suffixes: x-ai/grok-4.5-latest → grok-4.5 */
export function normalizeModelKey(model: string): string {
  const base = model.includes("/") ? model.split("/").pop()! : model;
  return base
    .trim()
    .toLowerCase()
    // drop openrouter free/variant suffixes after colon
    .replace(/:.*$/, "")
    .replace(/-latest$/, "")
    .replace(/-\d{8}$/, "") // dated snapshots: claude-sonnet-4-20250514
    .replace(/-\d{4}$/, ""); // short dated: grok-2-1212
}

/** Exact windows first, then family prefixes (tokens). */
const MODEL_WINDOWS: Record<string, number> = {
  "grok-4.5": 500_000,
  "grok-4": 256_000,
  "grok-3": 131_072,
  "grok-3-mini": 131_072,
  "grok-2": 131_072,
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1-nano": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  o3: 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.5-flash-lite": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  // DeepSeek V4 (OpenRouter / native)
  "deepseek-v4-flash": 1_048_576,
  "deepseek-v4-flash-0731": 1_048_576,
  "deepseek-v4-pro": 1_048_576,
  "deepseek-chat": 128_000,
  "deepseek-r1": 164_000,
  "deepseek-reasoner": 128_000,
  // Moonshot / Kimi
  "kimi-k2": 131_072,
  "kimi-k2.5": 262_144,
  "kimi-k3": 1_048_576,
  // Common OpenRouter-facing aliases (bare)
  "claude-sonnet-4": 200_000,
  "claude-opus-4": 200_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "llama-4-maverick": 1_048_576,
  "mistral-large": 128_000,
  "qwen3-coder": 262_144,
};

const FAMILY_WINDOWS: Array<[prefix: string, window: number]> = [
  ["claude-opus-5", 1_000_000],
  ["claude-sonnet-5", 1_000_000],
  ["claude-", 200_000],
  ["grok-4.5", 500_000],
  ["grok-4", 256_000], // grok-4.x variants other than 4.5 (exact hit above)
  ["grok-3", 131_072],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
  ["gpt-5", 1_050_000],
  ["o3", 200_000],
  ["o4", 200_000],
  ["gemini-2.5", 1_000_000],
  ["gemini-2.0", 1_000_000],
  ["gemini-3", 1_048_576],
  ["deepseek-v4", 1_048_576],
  ["deepseek-r1", 164_000],
  ["deepseek", 128_000],
  ["kimi-k3", 1_048_576],
  ["kimi-k2", 131_072],
  ["kimi", 131_072],
  ["llama-4", 1_048_576],
  ["llama-3", 128_000],
  ["qwen3", 262_144],
  ["qwen", 131_072],
  ["mistral", 128_000],
];

/** Shape written by model-catalog OpenRouter cache (v2). */
interface OpenRouterContextCache {
  fetchedAt: number;
  /** id → context_length */
  contextById?: Record<string, number>;
  /** legacy id list */
  models?: string[];
}

function openRouterCachePath(): string {
  return path.join(forgeHome(), "cache", "openrouter-models.json");
}

/**
 * Look up context_length from the OpenRouter models cache (sync, no network).
 * Matches full id (`deepseek/deepseek-v4-flash`) or bare key.
 */
export function openRouterCachedContextWindow(model: string): number | undefined {
  try {
    const raw = readJsonFile<OpenRouterContextCache | null>(
      openRouterCachePath(),
      null,
    );
    if (!raw?.contextById || typeof raw.contextById !== "object") {
      return undefined;
    }
    const full = String(model || "").trim().toLowerCase();
    if (full && typeof raw.contextById[full] === "number") {
      return raw.contextById[full];
    }
    // try without :variant
    const noTag = full.replace(/:.*$/, "");
    if (noTag && typeof raw.contextById[noTag] === "number") {
      return raw.contextById[noTag];
    }
    // bare key scan
    const key = normalizeModelKey(model);
    if (!key) return undefined;
    for (const [id, win] of Object.entries(raw.contextById)) {
      if (typeof win !== "number" || win <= 0) continue;
      if (normalizeModelKey(id) === key) return win;
    }
  } catch {
    /* cache optional */
  }
  return undefined;
}

/**
 * Context window for a model id, or undefined when unknown (caller keeps the
 * configured/default window rather than guessing).
 */
export function modelContextWindow(model: string): number | undefined {
  if (!model?.trim()) return undefined;
  const key = normalizeModelKey(model);
  if (!key) return undefined;

  // Exact bare key
  const exact = MODEL_WINDOWS[key];
  if (exact) return exact;

  // Full OpenRouter-style id in static table (rare)
  const fullLower = String(model).trim().toLowerCase();
  if (MODEL_WINDOWS[fullLower]) return MODEL_WINDOWS[fullLower];

  // Family prefixes (longest-first order in table)
  for (const [prefix, win] of FAMILY_WINDOWS) {
    if (key.startsWith(prefix)) return win;
  }

  // OpenRouter remote catalog cache
  const cached = openRouterCachedContextWindow(model);
  if (cached && cached > 0) return cached;

  return undefined;
}

/**
 * Apply the model's known max context to config when the user has not pinned
 * `context_window`. Returns the window applied (or current) and whether it changed.
 */
export function applyModelContextWindow(
  config: {
    model: string;
    contextWindow: number;
    contextWindowExplicit?: boolean;
  },
  model = config.model,
): { window: number; changed: boolean; known: boolean; source?: string } {
  if (config.contextWindowExplicit) {
    return {
      window: config.contextWindow,
      changed: false,
      known: modelContextWindow(model) != null,
      source: "explicit",
    };
  }
  const known = modelContextWindow(model);
  if (known && known !== config.contextWindow) {
    config.contextWindow = known;
    return { window: known, changed: true, known: true, source: "model" };
  }
  if (known) {
    return { window: known, changed: false, known: true, source: "model" };
  }
  return {
    window: config.contextWindow,
    changed: false,
    known: false,
    source: "default",
  };
}

/**
 * Default max output tokens when the user has not pinned `max_tokens`.
 * Reasoning models think inside the output budget on xAI/DeepSeek — the old
 * flat 16k cap truncated high-effort reasoning mid-thought and the loop then
 * paid full-prompt length-continuations to finish the thought. Non-reasoning
 * models keep the lean 16k base.
 */
export function defaultMaxOutputTokens(
  model: string,
  reasoningActive: boolean,
): number {
  if (!reasoningActive) return 16_384;
  const key = normalizeModelKey(model);
  // DeepSeek endpoints cap output lower than xAI; 32k stays safely accepted.
  if (key.startsWith("deepseek")) return 32_768;
  return 65_536;
}

/**
 * Effective max_tokens for a request: user pin wins; otherwise the auto
 * per-model cap above. `reasoningActive` = an effort field will be sent.
 */
export function resolveEffectiveMaxTokens(
  config: { model: string; maxTokens: number; maxTokensExplicit?: boolean },
  reasoningActive: boolean,
): number {
  if (config.maxTokensExplicit) return config.maxTokens;
  return defaultMaxOutputTokens(config.model, reasoningActive);
}

/**
 * True when the model a provider says it SERVED diverges from what was
 * requested (aliases/snapshot suffixes normalized away). Providers may route
 * to a different tier under load or effort — e.g. DeepSeek flash requests
 * billed as pro (2026-08 incident); make the divergence observable instead of
 * silent. Empty/unknown served ids never diverge.
 */
export function servedModelDiverged(
  requested: string,
  served: string | undefined | null,
): boolean {
  const s = String(served || "").trim();
  if (!s) return false;
  const reqKey = normalizeModelKey(requested);
  const srvKey = normalizeModelKey(s);
  if (!reqKey || !srvKey) return false;
  return reqKey !== srvKey;
}

/** Parse user context size: 200000, 200k, 1m, 1.5m, auto. */
export function parseContextWindowArg(raw: string): number | "auto" | null {
  const t = raw.trim().toLowerCase().replace(/[_,]/g, "");
  if (!t) return null;
  if (t === "auto" || t === "default" || t === "model" || t === "reset") {
    return "auto";
  }
  const m = t.match(/^(\d+(?:\.\d+)?)(k|m|mb|kb)?$/i);
  if (!m) {
    const n = Number(t);
    if (Number.isFinite(n) && n >= 1_000 && n <= 10_000_000) return Math.floor(n);
    return null;
  }
  let n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || "").toLowerCase();
  if (unit === "k" || unit === "kb") n *= 1_000;
  else if (unit === "m" || unit === "mb") n *= 1_000_000;
  if (n < 1_000 || n > 10_000_000) return null;
  return Math.floor(n);
}
