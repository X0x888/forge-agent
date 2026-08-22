/**
 * Per-model context window lookup.
 *
 * `context_window` config stays the explicit override; when the user has NOT
 * set it, the window is re-derived from the active *route* (provider + model)
 * so /model grok-3 (131k) does not keep grok-4.5's 500k — and so Cursor-hosted
 * Grok 4.5+ (256k) does not keep xAI's 500k and die of host overflow at 0.92
 * hard-headroom while auto-compact still thinks there is room.
 *
 * Lookup order:
 *  1. Native model max (Grok generation heuristic, exact id, family prefix,
 *     OpenRouter `context_length` cache)
 *  2. Host overlay (Cursor-hosted Grok 4.5+ is 256k; native stays on `native`)
 */
import path from "node:path";
import { grokAtLeast, grokContextWindow } from "./grok-model.js";
import { forgeHome, readJsonFile } from "../util/fs.js";
import { formatTokens } from "../util/format.js";

/** Strip provider prefix and xAI alias suffixes: x-ai/grok-4.5-latest → grok-4.5 */
export function normalizeModelKey(model: string): string {
  const base = model.includes("/") ? model.split("/").pop()! : model;
  return base
    .trim()
    .toLowerCase()
    .replace(/^cursor-/, "")
    // drop openrouter free/variant suffixes after colon
    .replace(/:.*$/, "")
    .replace(/-latest$/, "")
    .replace(/-\d{8}$/, "") // dated snapshots: claude-sonnet-4-20250514
    .replace(/-\d{4}$/, ""); // short dated: grok-2-1212
}

/** Exact windows first, then family prefixes (tokens). */
const MODEL_WINDOWS: Record<string, number> = {
  // Grok windows: see grok-model.ts (keeps grok-4.6+ from matching grok-4 → 256k).
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
  "claude-fable-5": 1_000_000,
  "claude-fable": 1_000_000,
  "llama-4-maverick": 1_048_576,
  "mistral-large": 128_000,
  "qwen3-coder": 262_144,
  "composer-2.5": 200_000,
  "composer-2": 200_000,
  composer: 200_000,
  auto: 200_000,
  "auto-smart": 200_000,
};

const FAMILY_WINDOWS: Array<[prefix: string, window: number]> = [
  ["claude-fable", 1_000_000],
  ["claude-opus-5", 1_000_000],
  ["claude-sonnet-5", 1_000_000],
  ["claude-", 200_000],
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
  ["composer", 200_000],
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

/** Cursor-hosted Grok 4.5+ default (docs: 256k; Max context = provider native). */
export const CURSOR_GROK_CONTEXT_WINDOW = 256_000;

export type ContextWindowSource = "model" | "cursor" | "openrouter";

export interface ContextWindowCaps {
  /** Auto window for this provider+model (compact, HUD, `/context-window auto`). */
  window: number;
  source: ContextWindowSource;
  /** Native model max when the host serves a smaller default. */
  native?: number;
  /**
   * Larger window a provider knob can request. Cursor Max Mode maps onto this
   * when the session window is above the hosted default.
   */
  extended?: number;
}

export interface ContextWindowConfig {
  model: string;
  provider?: string;
  contextWindow: number;
  contextWindowExplicit?: boolean;
}

function isCursorRoute(model: string, provider?: string): boolean {
  const p = (provider ?? "").trim().toLowerCase();
  if (
    p === "cursor" ||
    p === "cursor-ai" ||
    p === "cursorai" ||
    p === "cursor-cli" ||
    p === "anysphere"
  ) {
    return true;
  }
  const raw = (model.includes("/") ? model.split("/").pop()! : model)
    .trim()
    .toLowerCase();
  return raw.startsWith("cursor-");
}

/**
 * Native (weights / vendor card) window — ignores host overlays.
 * Cursor Grok 4.5+ is 500k here and 256k after {@link contextWindowCaps}.
 */
export function nativeContextWindow(model: string): number | undefined {
  if (!model?.trim()) return undefined;
  const key = normalizeModelKey(model);
  if (!key) return undefined;

  const grok = grokContextWindow(model);
  if (grok) return grok;

  const exact = MODEL_WINDOWS[key];
  if (exact) return exact;

  const fullLower = String(model).trim().toLowerCase();
  if (MODEL_WINDOWS[fullLower]) return MODEL_WINDOWS[fullLower];

  for (const [prefix, win] of FAMILY_WINDOWS) {
    if (key.startsWith(prefix)) return win;
  }

  const cached = openRouterCachedContextWindow(model);
  if (cached && cached > 0) return cached;

  return undefined;
}

function nativeWindowSource(model: string): ContextWindowSource {
  const key = normalizeModelKey(model);
  if (grokContextWindow(model)) return "model";
  if (key && MODEL_WINDOWS[key]) return "model";
  const fullLower = String(model).trim().toLowerCase();
  if (MODEL_WINDOWS[fullLower]) return "model";
  if (key) {
    for (const [prefix] of FAMILY_WINDOWS) {
      if (key.startsWith(prefix)) return "model";
    }
  }
  return "openrouter";
}

/**
 * Cursor jointly-hosts Grok 4.5+ at 256k (not a trimmed xAI 500k SKU).
 * Newer Cursor Grok flagships inherit 256k until Cursor publishes otherwise.
 */
function cursorHostedWindow(model: string, provider?: string): number | undefined {
  if (!isCursorRoute(model, provider)) return undefined;
  if (grokAtLeast(model, 4, 5) === true) return CURSOR_GROK_CONTEXT_WINDOW;
  return undefined;
}

/**
 * Route-aware caps: auto `window` is what Forge should use; `native` is the
 * vendor card when the host is smaller.
 */
export function contextWindowCaps(
  model: string,
  provider?: string,
): ContextWindowCaps | undefined {
  const native = nativeContextWindow(model);
  const hosted = cursorHostedWindow(model, provider);
  if (hosted && hosted > 0) {
    if (native && hosted < native) {
      return {
        window: hosted,
        source: "cursor",
        native,
        extended: native,
      };
    }
    return {
      window: hosted,
      source: "cursor",
      native: native && native > hosted ? native : undefined,
      extended: native && native > hosted ? native : undefined,
    };
  }
  if (native && native > 0) {
    return { window: native, source: nativeWindowSource(model), native };
  }
  return undefined;
}

/**
 * Auto context window for a model id (and optional provider).
 * `cursor-grok-4.6-*` / provider=cursor → 256k; xAI `grok-4.6` → 500k.
 */
export function modelContextWindow(
  model: string,
  provider?: string,
): number | undefined {
  return contextWindowCaps(model, provider)?.window;
}

/**
 * Apply the route's known max context when the user has not pinned
 * `context_window`. Returns the window applied (or current) and whether it changed.
 */
export function applyModelContextWindow(
  config: ContextWindowConfig,
  model = config.model,
): { window: number; changed: boolean; known: boolean; source?: string } {
  const caps = contextWindowCaps(model, config.provider);
  if (config.contextWindowExplicit) {
    return {
      window: config.contextWindow,
      changed: false,
      known: caps != null,
      source: "explicit",
    };
  }
  const known = caps?.window;
  if (known && known !== config.contextWindow) {
    config.contextWindow = known;
    return {
      window: known,
      changed: true,
      known: true,
      source: caps?.source ?? "model",
    };
  }
  if (known) {
    return {
      window: known,
      changed: false,
      known: true,
      source: caps?.source ?? "model",
    };
  }
  return {
    window: config.contextWindow,
    changed: false,
    known: false,
    source: "default",
  };
}

/** Informational hosted-vs-native line (not a degradation warning). */
export function contextWindowRouteNote(
  model: string,
  provider?: string,
): string | undefined {
  const caps = contextWindowCaps(model, provider);
  if (!caps?.native || caps.native === caps.window) return undefined;
  if (caps.source === "cursor") {
    return `Cursor Grok hosted default ${formatTokens(caps.window)} (xAI grok native ${formatTokens(caps.native)})`;
  }
  return `${caps.source} ${formatTokens(caps.window)} · native ${formatTokens(caps.native)}`;
}

/**
 * Degraded-settings warnings: pin above the host (overflow before compact) or
 * below the route default (unused capacity). Auto hosted-below-native is quiet.
 */
export function contextWindowWarnings(config: ContextWindowConfig): string[] {
  const caps = contextWindowCaps(config.model, config.provider);
  if (!caps) return [];
  const win = config.contextWindow;
  if (!(win > 0)) return [];
  const host = caps.window;
  const native = caps.native ?? host;
  const warns: string[] = [];

  if (win > host) {
    if (win > native && native !== host) {
      warns.push(
        `context_window ${win} exceeds ${caps.source === "cursor" ? "Cursor Grok" : config.model}'s ${host} default and grok native ${native} — provider may reject long prompts (/context-window auto)`,
      );
    } else if (caps.source === "cursor" && native > host) {
      warns.push(
        `context_window ${win} exceeds Cursor Grok's ${host} default — compact will not fire before the host rejects; Max Mode will be requested (xAI native ${native}). /context-window auto`,
      );
    } else if (win > native) {
      warns.push(
        `context_window ${win} exceeds known model max ${native} — provider may reject long prompts (/context-window auto)`,
      );
    }
  } else if (config.contextWindowExplicit && win < host) {
    warns.push(
      `context_window ${win} is below ${config.model}'s ${host} — paid capacity unused (/context-window auto)`,
    );
  }
  return warns;
}

/**
 * Posture / `/model` ctx fragment. When the host is below native, say so
 * even on the auto default (`256k (cursor · native 500k)`).
 */
export function formatContextWindowPosture(config: ContextWindowConfig): string {
  const caps = contextWindowCaps(config.model, config.provider);
  const tok = formatTokens(config.contextWindow);
  const pin = config.contextWindowExplicit ? " (pinned)" : "";
  if (!caps?.native || caps.native === caps.window) {
    return `${tok}${pin}`;
  }
  const host = `${caps.source} ${formatTokens(caps.window)}`;
  const native = `native ${formatTokens(caps.native)}`;
  if (!config.contextWindowExplicit && config.contextWindow === caps.window) {
    return `${tok} (${caps.source} · ${native})`;
  }
  return `${tok}${pin} (${host} · ${native})`;
}

/**
 * Cursor AgentService Max Mode: 1M models, or a window above this route's
 * hosted default (Cursor Grok 256k → pin 500k requests provider max).
 */
export function cursorRequestsMaxMode(
  model: string,
  contextWindow?: number,
): boolean {
  const win = contextWindow ?? 0;
  if (win >= 1_000_000) return true;
  const caps = contextWindowCaps(model, "cursor");
  return Boolean(
    caps?.extended && caps.extended > caps.window && win > caps.window,
  );
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
