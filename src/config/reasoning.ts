/**
 * Reasoning effort for models that support it (e.g. grok-4.5).
 * Values match xAI chat API `reasoning_effort`.
 */
export type ReasoningEffort = "low" | "medium" | "high";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
] as const;

export const REASONING_EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  low: "Quick / latency-sensitive agent work",
  medium: "Balanced reasoning depth",
  high: "Deepest reasoning (default for grok-4.5)",
};

interface ModelEffortSpec {
  levels: readonly ReasoningEffort[];
  default: ReasoningEffort;
}

/** Models that accept `reasoning_effort` on chat completions. */
const MODEL_EFFORT_SPECS: Record<string, ModelEffortSpec> = {
  "grok-4.5": {
    levels: ["low", "medium", "high"],
    default: "high",
  },
};

function normalizeModelId(model: string): string {
  const base = model.includes("/") ? model.split("/").pop()! : model;
  return base.trim().toLowerCase();
}

export function modelSupportsReasoningEffort(model: string): boolean {
  return normalizeModelId(model) in MODEL_EFFORT_SPECS;
}

export function effortLevelsForModel(model: string): readonly ReasoningEffort[] {
  return MODEL_EFFORT_SPECS[normalizeModelId(model)]?.levels ?? [];
}

export function defaultEffortForModel(model: string): ReasoningEffort | undefined {
  return MODEL_EFFORT_SPECS[normalizeModelId(model)]?.default;
}

/** Parse user input (name, alias, or menu number) into a level. */
export function parseReasoningEffort(raw: string): ReasoningEffort | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (t === "low" || t === "l" || t === "lo" || t === "min" || t === "minimal") return "low";
  if (t === "medium" || t === "med" || t === "m" || t === "mid") return "medium";
  if (t === "high" || t === "h" || t === "hi" || t === "max" || t === "deep") return "high";
  return null;
}

/**
 * Effort to send on the API request.
 * - Unsupported models → undefined (omit field)
 * - Supported + configured valid level → configured
 * - Supported + invalid/missing config → model default
 */
export function resolveReasoningEffort(
  model: string,
  configured?: ReasoningEffort | null,
): ReasoningEffort | undefined {
  const spec = MODEL_EFFORT_SPECS[normalizeModelId(model)];
  if (!spec) return undefined;
  if (configured && (spec.levels as readonly string[]).includes(configured)) {
    return configured;
  }
  return spec.default;
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
 * One notch up within the model's allowed levels (low→medium→high).
 * Used by adaptive effort escalation: hard rounds (doom-loop / error-streak /
 * missing wave proof) get a temporary boost instead of paying high effort on
 * every turn. Returns undefined for models without effort support, and the
 * same level back when already at the top (callers compare to skip no-ops).
 */
export function bumpReasoningEffort(
  model: string,
  current?: ReasoningEffort,
): ReasoningEffort | undefined {
  const levels = effortLevelsForModel(model);
  if (!levels.length) return undefined;
  const cur = current ?? defaultEffortForModel(model);
  const idx = cur ? levels.indexOf(cur) : -1;
  if (idx < 0) return levels[levels.length - 1];
  return levels[Math.min(idx + 1, levels.length - 1)];
}
