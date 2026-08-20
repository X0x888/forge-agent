/**
 * Reasoning / thinking effort for models that support it.
 *
 * - xAI Grok flagship: generation-aware (`src/config/grok-model.ts`).
 *   grok-4.5 = low|medium|high; grok-4.6+ = …|xhigh. Newer flagship ids inherit
 *   the latest known max so a bump like grok-4.7 does not need a Forge release.
 * - DeepSeek V4: low | high | max (OpenRouter + native)
 * - Others: family heuristics + OpenRouter catalog cache when present
 *
 * Default is always the **maximum** level allowed for that model.
 * Unsupported models omit the field entirely (no inventing params).
 */
import path from "node:path";
import { grokEffortLevels } from "./grok-model.js";
import { normalizeModelKey } from "./model-info.js";
import { parseCursorModelId } from "./cursor-model.js";
import { forgeHome, readJsonFile } from "../util/fs.js";

export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Rank for clamp / max selection (higher = deeper thinking). */
export const EFFORT_RANK: Record<ReasoningEffort, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const REASONING_EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  minimal: "Minimal thinking (fastest)",
  low: "Light reasoning / latency-sensitive",
  medium: "Balanced reasoning depth",
  high: "Deep reasoning",
  xhigh: "Extra-high reasoning (maps to max on some models)",
  max: "Maximum thinking depth allowed",
};

interface ModelEffortSpec {
  levels: readonly ReasoningEffort[];
  /** Always the max of levels unless overridden */
  default: ReasoningEffort;
}

function specWithMaxDefault(
  levels: readonly ReasoningEffort[],
): ModelEffortSpec {
  return { levels, default: maxEffortOf(levels) };
}

export function maxEffortOf(
  levels: readonly ReasoningEffort[],
): ReasoningEffort {
  if (!levels.length) return "high";
  let best: ReasoningEffort = levels[0]!;
  for (const e of levels) {
    if (EFFORT_RANK[e] > EFFORT_RANK[best]) best = e;
  }
  return best;
}

/** Exact bare keys (after normalizeModelKey). */
const MODEL_EFFORT_SPECS: Record<string, ModelEffortSpec> = {
  // Grok flagship effort lives in grok-model.ts (version-aware + inherit).
  // DeepSeek V4 — vendor + OpenRouter
  "deepseek-v4-flash": specWithMaxDefault(["low", "high", "max"]),
  "deepseek-v4-pro": specWithMaxDefault(["low", "high", "max"]),
  "deepseek-chat": specWithMaxDefault(["low", "high", "max"]),
  "deepseek-reasoner": specWithMaxDefault(["low", "high", "max"]),
  "deepseek-r1": specWithMaxDefault(["low", "high", "max"]),
  // Moonshot / Kimi (OpenRouter often exposes high/max style)
  "kimi-k2": specWithMaxDefault(["low", "high", "max"]),
  "kimi-k2.5": specWithMaxDefault(["low", "high", "max"]),
  "kimi-k3": specWithMaxDefault(["low", "high", "max"]),
};

/**
 * Family prefixes (checked in order; first match wins).
 * Keep more-specific prefixes before broader ones.
 */
const FAMILY_EFFORT_SPECS: Array<[prefix: string, levels: readonly ReasoningEffort[]]> =
  [
    ["deepseek-v4", ["low", "high", "max"]],
    ["deepseek-r1", ["low", "high", "max"]],
    ["deepseek", ["low", "high", "max"]],
    ["kimi-k3", ["low", "high", "max"]],
    ["kimi-k2", ["low", "high", "max"]],
    ["kimi", ["low", "high", "max"]],
    // OpenRouter / Cursor Claude reasoning efforts
    ["claude-fable", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-opus-5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-sonnet-5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-opus-4", ["low", "medium", "high", "max"]],
    ["claude-sonnet-4", ["low", "medium", "high", "max"]],
    // OpenAI o-series / gpt-5 reasoning (when exposed via OpenRouter)
    ["o3", ["low", "medium", "high"]],
    ["o4", ["low", "medium", "high"]],
    ["gpt-5", ["minimal", "low", "medium", "high", "xhigh", "max"]],
    ["gemini-3", ["minimal", "low", "medium", "high"]],
    ["gemini-2.5", ["minimal", "low", "medium", "high"]],
  ];

interface OpenRouterEffortCache {
  fetchedAt?: number;
  /** model id (lower) → supported effort strings from OpenRouter */
  effortsById?: Record<string, string[]>;
}

function openRouterCachePath(): string {
  return path.join(forgeHome(), "cache", "openrouter-models.json");
}

function normalizeEffortToken(raw: string): ReasoningEffort | null {
  const t = raw.trim().toLowerCase();
  if (
    t === "minimal" ||
    t === "min" ||
    t === "none" ||
    t === "off"
  ) {
    // "none/off" only accepted as minimal when model lists it; else parse still returns minimal
    return t === "none" || t === "off" ? "minimal" : "minimal";
  }
  if (t === "low" || t === "l" || t === "lo") return "low";
  if (t === "medium" || t === "med" || t === "m" || t === "mid") return "medium";
  if (t === "high" || t === "h" || t === "hi" || t === "deep") return "high";
  if (t === "xhigh" || t === "x-high" || t === "extra" || t === "ultra") {
    return "xhigh";
  }
  if (t === "max" || t === "maximum" || t === "full") return "max";
  return null;
}

/** Parse user input (name, alias, or menu number) into a level. */
export function parseReasoningEffort(raw: string): ReasoningEffort | null {
  if (!raw?.trim()) return null;
  return normalizeEffortToken(raw);
}

function openRouterCachedEfforts(model: string): ReasoningEffort[] | undefined {
  try {
    const raw = readJsonFile<OpenRouterEffortCache | null>(
      openRouterCachePath(),
      null,
    );
    if (!raw?.effortsById) return undefined;
    const full = String(model || "").trim().toLowerCase();
    const noTag = full.replace(/:.*$/, "");
    const list =
      raw.effortsById[full] ||
      raw.effortsById[noTag] ||
      (() => {
        const key = normalizeModelKey(model);
        for (const [id, efforts] of Object.entries(raw.effortsById!)) {
          if (normalizeModelKey(id) === key) return efforts;
        }
        return undefined;
      })();
    if (!list?.length) return undefined;
    const out: ReasoningEffort[] = [];
    for (const e of list) {
      const p = normalizeEffortToken(String(e));
      if (p && !out.includes(p)) out.push(p);
    }
    // Sort by rank for stable menus
    out.sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

function lookupEffortSpec(model: string): ModelEffortSpec | undefined {
  const key = normalizeModelKey(model);
  if (!key) return undefined;

  // 1. Exact static
  if (MODEL_EFFORT_SPECS[key]) return MODEL_EFFORT_SPECS[key];

  // 1b. Grok generation (4.5 high · 4.6+ xhigh · newer flagships inherit)
  const grokLevels = grokEffortLevels(model);
  if (grokLevels?.length) return specWithMaxDefault(grokLevels);

  // 2. OpenRouter catalog supported_efforts (when cached)
  const cached = openRouterCachedEfforts(model);
  if (cached?.length) return specWithMaxDefault(cached);

  // 3. Family heuristics
  for (const [prefix, levels] of FAMILY_EFFORT_SPECS) {
    if (key.startsWith(prefix)) return specWithMaxDefault(levels);
  }

  return undefined;
}

export function modelSupportsReasoningEffort(model: string): boolean {
  return lookupEffortSpec(model) != null;
}

export function effortLevelsForModel(model: string): readonly ReasoningEffort[] {
  return lookupEffortSpec(model)?.levels ?? [];
}

/**
 * Default effort for a model = **maximum** allowed level, unless the id
 * already encodes a Cursor variant (`grok-4.6-high-fast` → high).
 * Undefined when the model does not support effort.
 */
export function defaultEffortForModel(model: string): ReasoningEffort | undefined {
  const spec = lookupEffortSpec(model);
  if (!spec) return undefined;
  const tagged = parseCursorModelId(model).effort;
  if (tagged) {
    const clamped = clampEffortForModel(model, tagged);
    if (clamped) return clamped;
  }
  return spec.default;
}

/**
 * Map a requested effort onto a model's allowed levels.
 * Prefer exact match; otherwise clamp to nearest allowed rank;
 * never return a level the model rejects.
 */
export function clampEffortForModel(
  model: string,
  requested: ReasoningEffort,
): ReasoningEffort | undefined {
  const levels = effortLevelsForModel(model);
  if (!levels.length) return undefined;
  if ((levels as readonly string[]).includes(requested)) return requested;

  // xhigh → max or high when missing
  if (requested === "xhigh") {
    if ((levels as readonly string[]).includes("max")) return "max";
    if ((levels as readonly string[]).includes("high")) return "high";
  }
  if (requested === "max") {
    if ((levels as readonly string[]).includes("xhigh")) return "xhigh";
    if ((levels as readonly string[]).includes("high")) return "high";
  }
  if (requested === "minimal") {
    if ((levels as readonly string[]).includes("low")) return "low";
  }
  if (requested === "medium") {
    if ((levels as readonly string[]).includes("high")) return "high";
    if ((levels as readonly string[]).includes("low")) return "low";
  }

  // Nearest by rank
  const want = EFFORT_RANK[requested];
  let best = levels[0]!;
  let bestDist = Math.abs(EFFORT_RANK[best] - want);
  for (const e of levels) {
    const d = Math.abs(EFFORT_RANK[e] - want);
    if (d < bestDist || (d === bestDist && EFFORT_RANK[e] > EFFORT_RANK[best])) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Effort to send on the API request.
 * - Unsupported models → undefined (omit field)
 * - Supported + configured valid (or clampable) → that level
 * - Supported + missing config → model default (Cursor variant suffix if
 *   the id already encodes one, otherwise the family's maximum)
 */
export function resolveReasoningEffort(
  model: string,
  configured?: ReasoningEffort | null,
): ReasoningEffort | undefined {
  const spec = lookupEffortSpec(model);
  if (!spec) return undefined;
  if (configured) {
    const clamped = clampEffortForModel(model, configured);
    if (clamped) return clamped;
  }
  return defaultEffortForModel(model);
}

/** True when the level is valid for this model (or model has no effort). */
export function isEffortAllowedForModel(
  model: string,
  effort: ReasoningEffort,
): boolean {
  const levels = effortLevelsForModel(model);
  if (!levels.length) return false;
  return (levels as readonly string[]).includes(effort);
}

/**
 * One notch up within the model's allowed levels (adaptive escalation).
 * Returns undefined for models without effort support.
 */
export function bumpReasoningEffort(
  model: string,
  current?: ReasoningEffort,
): ReasoningEffort | undefined {
  const levels = [...effortLevelsForModel(model)].sort(
    (a, b) => EFFORT_RANK[a] - EFFORT_RANK[b],
  );
  if (!levels.length) return undefined;
  const cur = current ?? defaultEffortForModel(model);
  const idx = cur ? levels.indexOf(cur) : -1;
  if (idx < 0) return levels[levels.length - 1];
  return levels[Math.min(idx + 1, levels.length - 1)];
}
