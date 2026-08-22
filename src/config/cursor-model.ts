/**
 * Cursor-hosted model knobs (AgentService ModelDetails + RequestedModel).
 *
 * Root cause: Cursor does not take OpenAI `reasoning_effort` / a 1M flag as
 * chat-completions fields. The CLI encodes them as:
 *   - ModelDetails.thinking_details (empty message present = thinking on)
 *   - ModelDetails.max_mode (bool; IDE Max Mode — 1M models, or a window
 *     above the hosted default so Cursor Grok 500k pin requests provider max)
 *   - RequestedModel.parameters id=thinking|reasoning|effort|fast
 *   - optional id suffixes: -thinking -fast -low|-medium|-high|-xhigh|-max
 *
 * Forge `/effort` and `/context-window` are the source of truth. Suffixes on
 * the model id are a convenience overlay (thinking/fast always; effort only
 * when `/effort` is unset).
 */
import type { ReasoningEffort } from "./reasoning.js";
import { cursorRequestsMaxMode } from "./model-info.js";

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
  /** Id to send on the wire (full variant string). */
  serverId: string;
  baseId: string;
  thinking: boolean;
  fast: boolean;
  maxMode: boolean;
  isVariantString: boolean;
  parameters: Array<{ id: string; value: string }>;
}

/** Display / typo aliases → canonical Cursor **server** model id. */
const ALIASES: Record<string, string> = {
  fable: "claude-fable-5-max",
  fabel: "claude-fable-5-max",
  "claude-fable": "claude-fable-5-max",
  "claude-fable-5": "claude-fable-5-max",
  composer: "composer-2.5",
  "composer-2": "composer-2.5",
  "grok-4.6": "cursor-grok-4.6-xhigh-fast",
  "grok-4.6-xhigh-fast": "cursor-grok-4.6-xhigh-fast",
  "grok-4.6-high-fast": "cursor-grok-4.6-high-fast",
  "cursor-grok-4.6": "cursor-grok-4.6-xhigh-fast",
  "cursor-grok-4.5": "cursor-grok-4.5-high",
  "grok-4.5": "cursor-grok-4.5-high",
};

function withCursorGrokPrefix(base: string): string {
  if (/^grok-4\.[56]$/.test(base)) return `cursor-${base}`;
  return base;
}

function effortSuffix(effort?: ReasoningEffort): string {
  if (!effort) return "";
  if (effort === "xhigh") return "-xhigh";
  if (effort === "max") return "-max";
  if (effort === "minimal") return "-low";
  if (effort === "high" || effort === "medium" || effort === "low") {
    return `-${effort}`;
  }
  return "";
}

/** Rebuild a Cursor catalog variant id from knobs. */
export function cursorVariantId(
  parsed: CursorModelId,
  effort?: ReasoningEffort,
): string {
  const use = effort ?? parsed.effort;
  let id = withCursorGrokPrefix(parsed.baseId);
  if (parsed.thinking) id += "-thinking";
  id += effortSuffix(use);
  if (parsed.fast) id += "-fast";
  return id;
}

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

/**
 * Cursor catalog ids encode effort (`-xhigh-fast`). A leftover global
 * `/effort` pin must not sit on a different variant — the HUD would show
 * `cursor-grok-4.6-xhigh-fast ·high` while the wire overlays to high-fast.
 *
 * Explicit overlay (CLI `--effort` / config file) rewrites the id to match.
 * Otherwise the suffix wins and the pin is dropped.
 */
export function reconcileCursorModelEffort(opts: {
  model: string;
  reasoningEffort?: ReasoningEffort;
  effortExplicit: boolean;
}): { model: string; reasoningEffort?: ReasoningEffort } {
  const aliased = resolveCursorModelAlias(opts.model) || opts.model;
  const parsed = parseCursorModelId(aliased);
  const tagged = parsed.effort;
  if (!tagged) {
    return { model: aliased, reasoningEffort: opts.reasoningEffort };
  }
  if (
    opts.effortExplicit &&
    opts.reasoningEffort &&
    opts.reasoningEffort !== tagged
  ) {
    return {
      model: cursorVariantId(parsed, opts.reasoningEffort),
      reasoningEffort: opts.reasoningEffort,
    };
  }
  if (
    !opts.effortExplicit &&
    opts.reasoningEffort &&
    opts.reasoningEffort !== tagged
  ) {
    return { model: aliased, reasoningEffort: undefined };
  }
  return { model: aliased, reasoningEffort: opts.reasoningEffort };
}

/**
 * Map a Forge ChatRequest onto Cursor AgentService.
 *
 * Live GetUsableModels ids **are** variant strings
 * (`cursor-grok-4.6-xhigh-fast`). Sending a bare `grok-4.6` is `not_found`.
 * Forge knobs rewrite that string; we do not also send param key/values that
 * make the server look up a different base id.
 */
export function resolveCursorRunModel(opts: {
  model: string;
  reasoningEffort?: ReasoningEffort;
  contextWindow?: number;
}): CursorRunModel {
  const aliased = resolveCursorModelAlias(opts.model) || opts.model;
  const parsed = parseCursorModelId(aliased);
  const thinking = parsed.thinking;
  const maxMode = cursorRequestsMaxMode(aliased, opts.contextWindow);
  // Suffix on the catalog id is the encoded default. Overlay only when
  // ChatRequest carries a *different* level (explicit /effort).
  const effort =
    opts.reasoningEffort && opts.reasoningEffort !== parsed.effort
      ? opts.reasoningEffort
      : (parsed.effort ?? opts.reasoningEffort);
  const serverId = cursorVariantId(parsed, effort);
  return {
    serverId,
    baseId: withCursorGrokPrefix(parsed.baseId),
    thinking,
    fast: parsed.fast,
    maxMode,
    isVariantString: true,
    parameters: [],
  };
}
