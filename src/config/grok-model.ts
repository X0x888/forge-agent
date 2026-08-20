/**
 * Grok (xAI) generation heuristics.
 *
 * Flagship point-releases keep expanding: grok-4.5 max effort is `high`,
 * grok-4.6 adds `xhigh`. Unknown *newer* flagship ids (grok-4.7, grok-5, …)
 * inherit the latest known milestone so a Forge release is not required for
 * each xAI bump. Older product lines (grok-4, grok-4.20, grok-3) stay pinned.
 */
import type { ReasoningEffort } from "./reasoning.js";

export interface ParsedGrok {
  major: number;
  /** 0 for `grok-4` (no minor). */
  minor: number;
  /** Remainder after `grok-X.Y-` (`mini`, `0309-reasoning`, …). */
  variant: string;
  /** Normalized bare id (`grok-4.6`). */
  key: string;
}

export interface GrokRates {
  in: number;
  out: number;
  cacheIn?: number;
}

export interface GrokFlagshipMilestone {
  major: number;
  minor: number;
  efforts: readonly ReasoningEffort[];
  context: number;
  rates: GrokRates;
}

const HIGH_EFFORTS = ["low", "medium", "high"] as const satisfies readonly ReasoningEffort[];
const XHIGH_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ReasoningEffort[];

/** Newest last. Future flagships inherit the last row until a new row is added. */
export const GROK_FLAGSHIP_MILESTONES: readonly GrokFlagshipMilestone[] = [
  {
    major: 4,
    minor: 5,
    efforts: HIGH_EFFORTS,
    context: 500_000,
    rates: { in: 2, out: 6, cacheIn: 0.5 },
  },
  {
    major: 4,
    minor: 6,
    efforts: XHIGH_EFFORTS,
    context: 500_000,
    rates: { in: 2, out: 6, cacheIn: 0.5 },
  },
];

/** Strip provider prefix + alias suffixes without pulling model-info (cycle-safe). */
function grokKey(model: string): string {
  const base = model.includes("/") ? model.split("/").pop()! : model;
  return base
    .trim()
    .toLowerCase()
    .replace(/^cursor-/, "")
    .replace(/:.*$/, "")
    .replace(/-latest$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}$/, "");
}

export function parseGrokGeneration(model: string): ParsedGrok | null {
  const key = grokKey(model);
  const m = key.match(/^grok-(\d+)(?:\.(\d+))?(?:-(.+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] != null ? Number(m[2]) : 0,
    variant: m[3] || "",
    key,
  };
}

export function isGrokLineageModel(model: string): boolean {
  const g = parseGrokGeneration(model);
  return g != null && !isNonTextGrok(g);
}

/**
 * Whether this id is a Grok text model at/above a generation.
 * `null` = not Grok. Mini/nano/lite/non-text are `false` even when the
 * numeric generation would pass.
 */
export function grokAtLeast(
  model: string,
  major: number,
  minor: number,
): boolean | null {
  const g = parseGrokGeneration(model);
  if (!g) return null;
  if (isNonTextGrok(g)) return false;
  const flavor = `${g.key} ${g.variant}`;
  if (/(?:^|[\s-])(mini|nano|lite)(?:[\s-]|$)/.test(flavor)) return false;
  return cmp(g, major, minor) >= 0;
}

function isNonTextGrok(g: ParsedGrok): boolean {
  const s = `${g.key} ${g.variant}`;
  return /imagine|voice|tts|\bimage\b|\bvideo\b|grok-build/.test(s);
}

function cmp(g: ParsedGrok, major: number, minor: number): number {
  return g.major - major || g.minor - minor;
}

interface GrokCaps {
  efforts?: readonly ReasoningEffort[];
  context?: number;
  rates?: GrokRates;
}

function capsFor(model: string): GrokCaps | undefined {
  const g = parseGrokGeneration(model);
  if (!g || isNonTextGrok(g)) return undefined;

  // Distinct product lines that are *not* the sequential flagship.
  if (g.major === 4 && g.minor === 20) {
    if (/multi-agent/.test(g.variant)) {
      return { efforts: XHIGH_EFFORTS, context: 1_000_000 };
    }
    return { context: 1_000_000 };
  }
  if (g.major === 4 && g.minor === 3) {
    return { efforts: HIGH_EFFORTS, context: 1_000_000 };
  }

  if (cmp(g, 4, 5) < 0) {
    if (g.major >= 4) return { context: 256_000, rates: { in: 3, out: 15 } };
    if (g.variant.includes("mini") || g.key.includes("mini")) {
      return { context: 131_072, rates: { in: 0.3, out: 0.5 } };
    }
    return { context: 131_072, rates: { in: 3, out: 15 } };
  }

  const milestone = milestoneFor(g);
  if (!milestone) return { context: 500_000 };
  return {
    efforts: milestone.efforts,
    context: milestone.context,
    rates: milestone.rates,
  };
}

function milestoneFor(g: ParsedGrok): GrokFlagshipMilestone | undefined {
  if (!GROK_FLAGSHIP_MILESTONES.length) return undefined;
  const latest = GROK_FLAGSHIP_MILESTONES[GROK_FLAGSHIP_MILESTONES.length - 1]!;
  if (cmp(g, latest.major, latest.minor) >= 0) return latest;
  for (let i = GROK_FLAGSHIP_MILESTONES.length - 1; i >= 0; i--) {
    const row = GROK_FLAGSHIP_MILESTONES[i]!;
    if (cmp(g, row.major, row.minor) >= 0) return row;
  }
  return undefined;
}

export function grokEffortLevels(
  model: string,
): readonly ReasoningEffort[] | undefined {
  return capsFor(model)?.efforts;
}

export function grokContextWindow(model: string): number | undefined {
  return capsFor(model)?.context;
}

export function grokCostRates(model: string): GrokRates | undefined {
  return capsFor(model)?.rates;
}

export function latestGrokFlagshipId(): string {
  const latest = GROK_FLAGSHIP_MILESTONES[GROK_FLAGSHIP_MILESTONES.length - 1];
  if (!latest) return "grok-4.6";
  return `grok-${latest.major}.${latest.minor}`;
}
