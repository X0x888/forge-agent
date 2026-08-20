import { isCursorProvider } from "../auth/cursor.js";
import {
  cursorVariantId,
  parseCursorModelId,
  reconcileCursorModelEffort,
  resolveCursorModelAlias,
} from "./cursor-model.js";
import {
  GROK_FLAGSHIP_MILESTONES,
  grokAtLeast,
  parseGrokGeneration,
} from "./grok-model.js";
import { applyModelContextWindow, normalizeModelKey } from "./model-info.js";
import {
  clampEffortForModel,
  EFFORT_RANK,
  type ReasoningEffort,
} from "./reasoning.js";
import type { ForgeConfig } from "./types.js";

/** Intelligence floor for any automatic model hop. Below this is not accepted. */
export const FALLBACK_FLOOR_GROK_MAJOR = 4;
export const FALLBACK_FLOOR_GROK_MINOR = 5;
export const FALLBACK_FLOOR_EFFORT: ReasoningEffort = "high";
export const FALLBACK_FLOOR_LABEL = "grok-4.5 high";

/**
 * Internal opt-in token for `fallback_models = "on"` / `/fallback default`.
 * Expanded to a floor-filtered catalog chain at load / slash time.
 */
export const FALLBACK_DEFAULT_MARKER = "__default__";

function grokFlagshipIds(): string[] {
  return [...GROK_FLAGSHIP_MILESTONES]
    .slice()
    .reverse()
    .map((m) => `grok-${m.major}.${m.minor}`);
}

/** Cursor wire ids — never bare `grok-4.6` (AgentService `not_found`). */
function cursorGrokDefaultChain(): string[] {
  const out: string[] = [];
  for (const row of [...GROK_FLAGSHIP_MILESTONES].slice().reverse()) {
    const base = `cursor-grok-${row.major}.${row.minor}`;
    if ((row.efforts as readonly string[]).includes("xhigh")) {
      out.push(`${base}-xhigh-fast`, `${base}-high-fast`, `${base}-high`);
    } else {
      out.push(`${base}-high`);
    }
  }
  return out;
}

/**
 * Opt-in same-provider chains. Only models that meet {@link FALLBACK_FLOOR_LABEL}.
 * Cursor stays on Grok lineage (no auto / composer).
 */
function catalogDefaults(provider: string): readonly string[] {
  if (isCursorProvider(provider)) return cursorGrokDefaultChain();
  switch (String(provider)) {
    case "xai":
      return grokFlagshipIds();
    case "anthropic":
      return ["claude-opus-4-20250514"];
    case "openai":
      return ["o3"];
    case "openrouter":
      return [
        ...grokFlagshipIds().map((id) => `x-ai/${id}`),
        "anthropic/claude-opus-4",
        "openai/o3",
        "google/gemini-2.5-pro",
      ];
    case "google":
      return ["gemini-2.5-pro"];
    case "copilot":
      return ["gemini-2.5-pro"];
    default:
      return [];
  }
}

function isDefaultMarker(id: string): boolean {
  return id === FALLBACK_DEFAULT_MARKER;
}

function grokBareFlagshipId(model: string): string | undefined {
  const g = parseGrokGeneration(model);
  if (!g) return undefined;
  return g.minor > 0 ? `grok-${g.major}.${g.minor}` : `grok-${g.major}`;
}

function sameChain(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

/**
 * Native providers only serve their own families. Cursor / OpenRouter / Copilot
 * / custom host many — the intelligence floor is the gate there.
 */
export function providerAcceptsFallbackId(
  provider: string,
  model: string,
): boolean {
  const p = String(provider || "").toLowerCase();
  if (isCursorProvider(p) || p === "openrouter" || p === "custom" || p === "copilot") {
    return true;
  }
  const grok = grokAtLeast(
    model,
    FALLBACK_FLOOR_GROK_MAJOR,
    FALLBACK_FLOOR_GROK_MINOR,
  );
  const key = fallbackKey(model);
  switch (p) {
    case "xai":
      return grok === true;
    case "anthropic":
      return key.startsWith("claude-");
    case "openai":
      return /^(gpt-|o[1-9])/.test(key);
    case "google":
      return key.startsWith("gemini-");
    case "deepseek":
      return key.startsWith("deepseek");
    default:
      return true;
  }
}

function encodedEffort(model: string): ReasoningEffort | undefined {
  return parseCursorModelId(model).effort;
}

function effortMeetsFloor(model: string): boolean {
  const eff = encodedEffort(model);
  if (!eff) return true;
  return EFFORT_RANK[eff] >= EFFORT_RANK[FALLBACK_FLOOR_EFFORT];
}

function fallbackKey(model: string): string {
  return normalizeModelKey(parseCursorModelId(model).baseId);
}

/**
 * Non-Grok families known to sit at/above grok-4.5 high.
 * Unknown families fail closed — unattended hops must not guess.
 */
function nonGrokFamilyMeetsFloor(key: string): boolean {
  if (!key) return false;
  if (/^(auto|auto-smart|composer)(-|$)/.test(key)) return false;
  if (/(?:^|-)(mini|nano|lite|haiku|flash|composer)(?:-|$)/.test(key)) {
    return false;
  }
  if (/^gpt-4([.-]|$)/.test(key)) return false;
  if (/^claude-sonnet-4([.-]|$)/.test(key)) return false;
  if (/^claude-haiku/.test(key)) return false;
  if (/^claude-3([.-]|$)/.test(key)) return false;
  if (/^deepseek/.test(key)) return false;
  if (/^(kimi|llama|mistral|qwen)/.test(key)) return false;

  if (/^claude-opus-([4-9]|[1-9]\d)/.test(key)) return true;
  if (/^claude-fable/.test(key)) return true;
  if (/^claude-sonnet-([5-9]|[1-9]\d)/.test(key)) return true;
  if (/^gpt-([5-9]|[1-9]\d)/.test(key)) return true;
  if (/^o3($|-)/.test(key)) return true;
  if (/^o4($|-)/.test(key)) return true;
  if (/^gemini-/.test(key) && /pro/.test(key) && !/flash/.test(key)) {
    return true;
  }
  return false;
}

export function meetsFallbackFloor(model: string): boolean {
  const id = String(model ?? "").trim();
  if (!id || isDefaultMarker(id)) return false;
  const grok = grokAtLeast(
    id,
    FALLBACK_FLOOR_GROK_MAJOR,
    FALLBACK_FLOOR_GROK_MINOR,
  );
  if (grok === false) return false;
  if (grok === true) return effortMeetsFloor(id);
  return nonGrokFamilyMeetsFloor(fallbackKey(id)) && effortMeetsFloor(id);
}

function cursorFillsHigh(baseId: string): boolean {
  const key = normalizeModelKey(baseId);
  return /^grok-/.test(key) || /^claude-/.test(key);
}

/**
 * Provider-aware id for a hop. Cursor catalog ids are variant strings;
 * sending a bare `grok-4.5` is `not_found`. Missing Grok/Claude effort
 * suffixes are filled to `high` (the floor) — never left to Auto.
 */
export function normalizeFallbackModelId(
  provider: string,
  model: string,
): string {
  const raw = String(model ?? "").trim();
  if (!raw || isDefaultMarker(raw)) return raw;
  const p = String(provider);

  if (isCursorProvider(p)) {
    const aliased = resolveCursorModelAlias(raw) || raw;
    const parsed = parseCursorModelId(aliased);
    const g = parseGrokGeneration(aliased);
    if (g) {
      const base = parsed.baseId.replace(/^cursor-/, "");
      const prefixed = /^grok-/.test(base) ? `cursor-${base}` : parsed.baseId;
      const effort = parsed.effort ?? FALLBACK_FLOOR_EFFORT;
      return cursorVariantId({ ...parsed, baseId: prefixed }, effort);
    }
    if (cursorFillsHigh(parsed.baseId) && !parsed.effort) {
      return `${parsed.baseId}-high`;
    }
    return aliased;
  }

  // A Cursor-saved chain must not be sent to xAI as `cursor-grok-4.6-xhigh-fast`.
  const bare = grokBareFlagshipId(raw);
  if (bare) {
    if (p === "openrouter") {
      const slash = raw.indexOf("/");
      const prefix = slash > 0 ? raw.slice(0, slash) : "";
      if (prefix && prefix !== "cursor") return `${prefix}/${bare}`;
      return `x-ai/${bare}`;
    }
    return bare;
  }
  return raw;
}

export function filterFallbackChain(
  models: readonly string[],
  provider: string,
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const seen = new Set<string>();
  const dropped: string[] = [];
  for (const raw of models) {
    const id = String(raw ?? "").trim();
    if (!id || isDefaultMarker(id)) continue;
    // Floor-check the raw id first so `cursor-grok-4.6-low-fast` cannot be
    // unwrapped to bare grok-4.6 and sneak past the effort floor.
    if (!meetsFallbackFloor(id)) {
      dropped.push(id);
      continue;
    }
    const norm = normalizeFallbackModelId(provider, id);
    if (!meetsFallbackFloor(norm) || !providerAcceptsFallbackId(provider, norm)) {
      dropped.push(id);
      continue;
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    kept.push(norm);
  }
  return { kept, dropped };
}

export function parseFallbackModels(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (raw === true) return [FALLBACK_DEFAULT_MARKER];
  if (raw === false) return [];
  if (Array.isArray(raw)) {
    if (raw.length === 1) {
      const one = String(raw[0] ?? "").trim();
      if (!one) return undefined;
      if (/^(off|none|false|no|0|disable)$/i.test(one)) return [];
      if (/^(on|true|default|defaults)$/i.test(one)) {
        return [FALLBACK_DEFAULT_MARKER];
      }
    }
    const out = raw
      .map((x) => String(x ?? "").trim())
      .filter((x) => x && !isDefaultMarker(x));
    return out.length ? [...new Set(out)] : [];
  }
  const s = String(raw).trim();
  if (!s) return undefined;
  if (s === "0" || /^(off|none|false|no|disable)$/i.test(s)) return [];
  if (/^(on|true|default|defaults)$/i.test(s)) return [FALLBACK_DEFAULT_MARKER];
  const parts = [
    ...new Set(s.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean)),
  ];
  return parts.length ? parts : undefined;
}

/** Expand `on` / floor-filter a stored list. `undefined` stays off. */
export function materializeFallbackModels(
  raw: string[] | undefined,
  provider: string,
  model: string,
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw.length === 0) return [];
  const onlyDefault =
    raw.some(isDefaultMarker) &&
    raw.every((m) => isDefaultMarker(String(m ?? "").trim()) || !String(m ?? "").trim());
  if (onlyDefault) return defaultFallbackModels(provider, model);
  const { kept } = filterFallbackChain(
    raw.filter((m) => !isDefaultMarker(String(m ?? "").trim())),
    provider,
  );
  return kept;
}

/** Human-readable chain for /status, /share, doctor, run JSON. */
export function formatFallbackChain(
  config: Pick<ForgeConfig, "provider" | "model" | "fallbackModels">,
): string {
  if (!config.fallbackModels || config.fallbackModels.length === 0) return "off";
  const { kept } = filterFallbackChain(
    config.fallbackModels,
    String(config.provider),
  );
  return kept.length ? kept.join(" → ") : "off";
}

export function defaultFallbackModels(
  provider: string,
  _currentModel?: string,
): string[] {
  return filterFallbackChain(catalogDefaults(provider), provider).kept;
}

/**
 * Rebuild a stored chain for a new provider. Catalog-default chains swap to
 * the new provider's floor-qualified defaults; custom lists are re-normalized
 * and dropped if nothing on the destination meets the floor.
 */
export function rebindFallbackModels(
  chain: string[] | undefined,
  fromProvider: string,
  toProvider: string,
  currentModel?: string,
): string[] | undefined {
  if (chain === undefined) return undefined;
  if (chain.length === 0) return [];
  const fromDef = defaultFallbackModels(fromProvider);
  const asFrom = filterFallbackChain(chain, fromProvider).kept;
  if (sameChain(chain, fromDef) || sameChain(asFrom, fromDef)) {
    return defaultFallbackModels(toProvider, currentModel);
  }
  return filterFallbackChain(chain, toProvider).kept;
}

/**
 * Next same-provider model after the current one has exhausted retries.
 * `undefined` / `[]` = disabled (the default). Non-empty lists are
 * floor-filtered — nothing below {@link FALLBACK_FLOOR_LABEL} is returned.
 */
export function nextFallbackModel(
  config: Pick<ForgeConfig, "provider" | "model" | "fallbackModels">,
  opts?: { tried?: Iterable<string> },
): string | undefined {
  const provider = String(config.provider);
  const explicit = config.fallbackModels;
  if (explicit === undefined || explicit.length === 0) return undefined;
  const chain = filterFallbackChain(explicit, provider).kept;
  const tried = new Set(
    [...(opts?.tried ?? []), config.model]
      .map((m) => normalizeFallbackModelId(provider, String(m ?? "").trim()))
      .filter(Boolean),
  );
  for (const id of chain) {
    if (!id || tried.has(id)) continue;
    return id;
  }
  return undefined;
}

/**
 * Apply a hop: wire-id normalize (Cursor), context window, never drop
 * effort below {@link FALLBACK_FLOOR_EFFORT}.
 */
export function applyFallbackHop(config: ForgeConfig, next: string): string {
  const provider = String(config.provider);
  const id = normalizeFallbackModelId(provider, next);
  if (!meetsFallbackFloor(id) || !providerAcceptsFallbackId(provider, id)) {
    return config.model;
  }
  config.model = id;
  applyModelContextWindow(config, id);

  const current = config.reasoningEffort;
  if (current && EFFORT_RANK[current] < EFFORT_RANK[FALLBACK_FLOOR_EFFORT]) {
    const raised = clampEffortForModel(id, FALLBACK_FLOOR_EFFORT);
    if (raised) config.reasoningEffort = raised;
  } else if (current) {
    const clamped = clampEffortForModel(id, current);
    if (clamped) config.reasoningEffort = clamped;
  }

  if (isCursorProvider(provider)) {
    const aligned = reconcileCursorModelEffort({
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      effortExplicit: Boolean(config.reasoningEffort),
    });
    config.model = aligned.model;
    config.reasoningEffort = aligned.reasoningEffort;
  }
  return config.model;
}

export function isModelFallbackWorthy(err: unknown): boolean {
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  if (status === 401 || status === 403) return false;
  if (status === 429 || status === 408 || status === 529) return true;
  if (status >= 500 && status < 600) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/oauth2 access token|invalid.?api.?key|unauthorized|insufficient.?quota|billing|credit/i.test(msg)) {
    return false;
  }
  return /overloaded|unavailable|capacity|high demand|try again later|temporarily|service.?unavailable|too many requests|rate.?limit/i.test(
    msg,
  );
}
