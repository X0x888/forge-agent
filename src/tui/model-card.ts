/**
 * `/model` — the sit-down key for the session model.
 *
 * `/status` served-drift Next is `/model`. Typing it used to dump
 * `Provider: …` + a numbered catalog (`formatParamMenu`). Trust is the
 * key you type: see `model  ·  grok-4.6` (or `drift`), then `/model <id>`.
 * Tab still completes catalog names. CLI `forge models` stays off ›.
 */
import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import { formatContextWindowPosture } from "../config/model-info.js";
import {
  modelSupportsReasoningEffort,
  resolveReasoningEffort,
} from "../config/reasoning.js";
import { recentModelsForProvider } from "../config/model-catalog.js";
import { formatVerifyCloser } from "./verify-card.js";

export type ModelKind = "ok" | "drift" | "unknown";

export function modelKindFromServed(
  requested: string,
  served?: readonly string[] | null,
): ModelKind {
  const asked = String(requested || "").trim();
  const list = (served ?? [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  if (!list.length) return "ok";
  return list.some((s) => s !== asked) ? "drift" : "ok";
}

export function formatModelVerdict(
  kind: ModelKind,
  model?: string,
  opts?: { color?: boolean },
): string {
  const color = opts?.color !== false;
  const title = color ? chalk.bold("model") : "model";
  const bit = (text: string, paint: (s: string) => string) =>
    color ? paint(text) : text;
  if (kind === "unknown") return `${title}  ·  ${bit("unknown", chalk.yellow)}`;
  if (kind === "drift") return `${title}  ·  ${bit("drift", chalk.yellow)}`;
  const id = String(model || "").trim() || "—";
  return `${title}  ·  ${bit(id, chalk.green)}`;
}

export function formatModelPostureLine(input: {
  provider?: string;
  effort?: string | null;
  ctx?: string | null;
}): string {
  const parts: string[] = [];
  const p = String(input.provider || "").trim();
  if (p) parts.push(p);
  const e = String(input.effort || "").trim();
  if (e) parts.push(`effort ${e}`);
  const c = String(input.ctx || "").trim();
  if (c) parts.push(`ctx ${c}`);
  return parts.length ? `  ${parts.join("  ·  ")}` : "";
}

/** Next after you type `/model`. Drift → insist requested + accept served. */
export function modelNextKeys(input: {
  kind: ModelKind;
  model?: string;
  served?: readonly string[] | null;
  recentOther?: string | null;
  effortWired?: boolean;
  unknownTip?: string | null;
}): string[] {
  if (input.kind === "unknown") {
    const tip = String(input.unknownTip || "").trim();
    return tip ? [`/model ${tip}`] : [];
  }
  const keys: string[] = [];
  const asked = String(input.model || "").trim();
  if (input.kind === "drift") {
    if (asked) keys.push(`/model ${asked}`);
    const served = (input.served ?? [])
      .map((s) => String(s || "").trim())
      .find((s) => s && s !== asked);
    if (served) keys.push(`/model ${served}`);
    return keys.slice(0, 3);
  }
  const other = String(input.recentOther || "").trim();
  if (other && other !== asked) keys.push(`/model ${other}`);
  if (input.effortWired) keys.push("/effort");
  return keys.slice(0, 3);
}

export function formatModelCard(input: {
  kind: ModelKind;
  model?: string;
  provider?: string;
  effort?: string | null;
  ctx?: string | null;
  served?: readonly string[] | null;
  note?: string;
  next?: string[];
  color?: boolean;
  columns?: number;
}): string {
  const color = input.color !== false;
  const lines = [formatModelVerdict(input.kind, input.model, { color })];
  if (input.kind === "drift") {
    const asked = String(input.model || "").trim() || "—";
    const served =
      (input.served ?? [])
        .map((s) => String(s || "").trim())
        .filter(Boolean)
        .join(", ") || "—";
    const row = `  asked ${asked}  ·  served ${served}`;
    lines.push(color ? chalk.yellow(row) : row);
  }
  if (input.kind !== "unknown") {
    const body = formatModelPostureLine({
      provider: input.provider,
      effort: input.effort,
      ctx: input.ctx,
    });
    if (body) lines.push(color ? chalk.dim(body) : body);
  }
  const note = input.note?.trim();
  if (note) {
    lines.push(color ? chalk.yellow(`  ${note}`) : `  ${note}`);
  }
  const closer = formatVerifyCloser(input.next ?? [], {
    columns: input.columns,
  });
  if (closer) lines.push(closer);
  return lines.filter((l) => l.length > 0).join("\n");
}

export function assembleModelCard(input: {
  kind: ModelKind;
  model: string;
  provider: string;
  effort?: string | null;
  ctx?: string | null;
  served?: readonly string[] | null;
  recentOther?: string | null;
  effortWired?: boolean;
  unknownTip?: string | null;
  note?: string;
  color?: boolean;
  columns?: number;
}): string {
  return formatModelCard({
    kind: input.kind,
    model: input.model,
    provider: input.provider,
    effort: input.effort,
    ctx: input.ctx,
    served: input.served,
    note: input.note,
    next: modelNextKeys({
      kind: input.kind,
      model: input.model,
      served: input.served,
      recentOther: input.recentOther,
      effortWired: input.effortWired,
      unknownTip: input.unknownTip,
    }),
    color: input.color,
    columns: input.columns,
  });
}

/** Peek card from live config + session (no catalog dump). */
export function peekModelCard(input: {
  config: Pick<
    ForgeConfig,
    | "model"
    | "provider"
    | "reasoningEffort"
    | "contextWindow"
    | "contextWindowExplicit"
  >;
  served?: readonly string[] | null;
  color?: boolean;
  columns?: number;
}): string {
  const model = String(input.config.model || "");
  const provider = String(input.config.provider || "");
  const kind = modelKindFromServed(model, input.served);
  const effort = resolveReasoningEffort(model, input.config.reasoningEffort);
  const recent =
    recentModelsForProvider(provider).find((m) => m !== model) ?? null;
  return assembleModelCard({
    kind,
    model,
    provider,
    effort,
    ctx: formatContextWindowPosture(input.config),
    served: input.served,
    recentOther: recent,
    effortWired: modelSupportsReasoningEffort(model),
    color: input.color,
    columns: input.columns,
  });
}
