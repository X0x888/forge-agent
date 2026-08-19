/**
 * Cursor-hosted model knobs (AgentService ModelDetails + RequestedModel).
 *
 * Root cause: Cursor does not take OpenAI `reasoning_effort` / a 1M flag as
 * chat-completions fields. The CLI encodes them as:
 *   - ModelDetails.thinking_details (empty message present = thinking on)
 *   - ModelDetails.max_mode (bool; IDE 1M / Max Mode)
 *   - RequestedModel.parameters id=thinking|reasoning|effort|fast
 *   - optional id suffixes: -thinking -fast -low|-medium|-high|-xhigh|-max
 *
 * Forge `/effort` and `/context-window` are the source of truth. Suffixes on
 * the model id are a convenience overlay (thinking/fast always; effort only
 * when `/effort` is unset).
 */
import type { ReasoningEffort } from "./reasoning.js";

export type CursorReasoning = "low" | "medium" | "high" | "extra-high";

export interface CursorModelId {
  /** Server model id with variant suffixes stripped. */
  baseId: string;
  thinking: boolean;
  fast: boolean;
  /** Forge effort implied by a `-low`/`-max`/… suffix, if any. */
  effort?: ReasoningEffort;
}

export interface CursorRunModel {
  baseId: string;
  thinking: boolean;
  fast: boolean;
  maxMode: boolean;
  parameters: Array<{ id: string; value: string }>;
}

/** Display / typo aliases → canonical Cursor model id. */
const ALIASES: Record<string, string> = {
  fable: "claude-fable-5",
  fabel: "claude-fable-5",
  "claude-fable": "claude-fable-5",
  composer: "composer-2.5",
  "composer-2": "composer-2.5",
  "cursor-grok-4.6": "grok-4.6",
  "cursor-grok-4.5": "grok-4.5",
};

const SUFFIXES: Array<{ token: string; apply: (out: CursorModelId) => void }> = [
  { token: "-thinking", apply: (o) => { o.thinking = true; } },
  { token: "-fast", apply: (o) => { o.fast = true; } },
  { token: "-extra-high", apply: (o) => { o.effort = "xhigh"; } },
  { token: "-extrahigh", apply: (o) => { o.effort = "xhigh"; } },
  { token: "-xhigh", apply: (o) => { o.effort = "xhigh"; } },
  { token: "-medium", apply: (o) => { o.effort = "medium"; } },
  { token: "-high", apply: (o) => { o.effort = "high"; } },
  { token: "-max", apply: (o) => { o.effort = "max"; } },
  { token: "-low", apply: (o) => { o.effort = "low"; } },
  { token: "-minimal", apply: (o) => { o.effort = "minimal"; } },
];

function bareModelId(raw: string): string {
  const base = raw.includes("/") ? raw.split("/").pop()! : raw;
  return base.trim().toLowerCase();
}

export function resolveCursorModelAlias(raw: string): string | undefined {
  const key = bareModelId(raw).replace(/\s+/g, "-");
  return ALIASES[key];
}

/**
 * Strip Cursor variant suffixes from a model id (thinking / fast / effort).
 * Longest tokens first so `-xhigh` is not eaten as `-high`.
 */
export function parseCursorModelId(raw: string): CursorModelId {
  let rest = bareModelId(raw);
  const out: CursorModelId = {
    baseId: rest,
    thinking: false,
    fast: false,
  };
  let changed = true;
  while (changed && rest.length) {
    changed = false;
    for (const s of SUFFIXES) {
      if (rest.endsWith(s.token) && rest.length > s.token.length) {
        rest = rest.slice(0, -s.token.length);
        s.apply(out);
        changed = true;
        break;
      }
    }
  }
  out.baseId = rest;
  return out;
}

function forgeEffortToCursorParams(
  effort: ReasoningEffort,
): Array<{ id: string; value: string }> {
  if (effort === "max") return [{ id: "effort", value: "max" }];
  if (effort === "xhigh") return [{ id: "reasoning", value: "extra-high" }];
  if (effort === "high" || effort === "medium" || effort === "low") {
    return [{ id: "reasoning", value: effort }];
  }
  if (effort === "minimal") return [{ id: "reasoning", value: "low" }];
  return [];
}

/**
 * Map a Forge ChatRequest onto Cursor AgentService model fields.
 *
 * - thinking: off unless the id contains `-thinking`
 * - max_mode: on when Forge context window is ≥ 1M (Cursor Max Mode)
 * - effort: ChatRequest.reasoning_effort, else an effort suffix on the id
 */
export function resolveCursorRunModel(opts: {
  model: string;
  reasoningEffort?: ReasoningEffort;
  contextWindow?: number;
}): CursorRunModel {
  const parsed = parseCursorModelId(opts.model);
  const thinking = parsed.thinking;
  const maxMode = (opts.contextWindow ?? 0) >= 1_000_000;
  const effort = opts.reasoningEffort ?? parsed.effort;
  const parameters: Array<{ id: string; value: string }> = [
    { id: "thinking", value: thinking ? "true" : "false" },
  ];
  if (parsed.fast) parameters.push({ id: "fast", value: "true" });
  if (effort) parameters.push(...forgeEffortToCursorParams(effort));
  return {
    baseId: parsed.baseId,
    thinking,
    fast: parsed.fast,
    maxMode,
    parameters,
  };
}
