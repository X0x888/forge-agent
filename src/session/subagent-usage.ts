/**
 * Family spend ledger: parent session totals plus a per-child breakdown.
 *
 * Child tokens fold into parent totals (one family number). `/budget`
 * uses that family number — live-fold during a child run so parallel
 * siblings share remaining, and the parent HIT valve cannot be bypassed
 * by a fresh child session.
 */
import type { ForgeConfig } from "../config/types.js";
import {
  costCapStatus,
  type CostCapStatus,
} from "../util/cost-budget.js";
import { estimateCostUsd, formatCost, formatTokens } from "../util/format.js";
import type { SessionMeta } from "./session.js";

export interface SubagentUsageRecord {
  sessionId: string;
  description: string;
  subagentType: string;
  status: string;
  turns: number;
  maxTurns: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  estCostUsd: number;
  at: string;
}

export interface UsageTriple {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
}

const MAX_LEDGER = 32;

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/** Child.meta is the bill. Loop deltas are a fallback when meta was not incremented. */
export function resolveChildUsage(
  child: Pick<
    SessionMeta,
    "totalPromptTokens" | "totalCompletionTokens" | "totalCacheReadTokens"
  >,
  result?: Partial<UsageTriple> | null,
): UsageTriple {
  return {
    promptTokens: Math.max(n(child.totalPromptTokens), n(result?.promptTokens)),
    completionTokens: Math.max(
      n(child.totalCompletionTokens),
      n(result?.completionTokens),
    ),
    cacheReadTokens: Math.max(
      n(child.totalCacheReadTokens),
      n(result?.cacheReadTokens),
    ),
  };
}

/**
 * Cursor (and similar) can run 25 turns with 0 billed tokens on the child
 * session. Approximate from the transcript so the parent family ledger
 * does not show `sub 1 $0.0000`.
 */
export function fallbackUsageFromTranscript(
  usage: UsageTriple,
  messages: Array<{ content?: string | null }>,
  turns: number,
): UsageTriple {
  if (usage.promptTokens > 0 || usage.completionTokens > 0) return usage;
  if (turns <= 0 || !messages.length) return usage;
  let chars = 0;
  for (const m of messages) chars += String(m.content || "").length;
  const est = Math.max(1, Math.ceil(chars / 3.2));
  const completion = Math.max(0, Math.floor(est * 0.1));
  return {
    promptTokens: est - completion,
    completionTokens: completion,
    cacheReadTokens: 0,
  };
}

export function normalizeSubagentUsage(
  raw: unknown,
): SubagentUsageRecord[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: SubagentUsageRecord[] = [];
  for (const item of raw.slice(-MAX_LEDGER)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const sessionId = String(rec.sessionId || "").trim();
    if (!sessionId) continue;
    out.push({
      sessionId: sessionId.slice(0, 80),
      description: String(rec.description || "").trim().slice(0, 120),
      subagentType: String(rec.subagentType || "general-purpose").slice(0, 40),
      status: String(rec.status || "completed").slice(0, 40),
      turns: Math.max(0, Math.floor(n(rec.turns))),
      maxTurns: Math.max(0, Math.floor(n(rec.maxTurns))),
      promptTokens: Math.max(0, Math.floor(n(rec.promptTokens))),
      completionTokens: Math.max(0, Math.floor(n(rec.completionTokens))),
      cacheReadTokens: Math.max(0, Math.floor(n(rec.cacheReadTokens))),
      estCostUsd: n(rec.estCostUsd),
      at: String(rec.at || "").slice(0, 40),
    });
  }
  return out.length ? out : undefined;
}

export function buildSubagentUsageRecord(opts: {
  sessionId: string;
  description: string;
  subagentType: string;
  status: string;
  turns: number;
  maxTurns: number;
  usage: UsageTriple;
  provider: string;
  model?: string;
  at?: string;
}): SubagentUsageRecord {
  return {
    sessionId: opts.sessionId,
    description: (opts.description || "").trim().slice(0, 120),
    subagentType: opts.subagentType,
    status: opts.status,
    turns: Math.max(0, Math.floor(opts.turns || 0)),
    maxTurns: Math.max(0, Math.floor(opts.maxTurns || 0)),
    promptTokens: opts.usage.promptTokens,
    completionTokens: opts.usage.completionTokens,
    cacheReadTokens: opts.usage.cacheReadTokens,
    estCostUsd: estimateCostUsd(
      opts.provider,
      opts.usage.promptTokens,
      opts.usage.completionTokens,
      opts.model,
      opts.usage.cacheReadTokens,
    ),
    at: opts.at || new Date().toISOString(),
  };
}

/**
 * Fold one child's usage into the parent once. Re-folding the same
 * sessionId updates the ledger and only adds a positive delta.
 */
export function foldChildUsage(
  parent: SessionMeta,
  record: SubagentUsageRecord,
): { added: boolean; delta: UsageTriple } {
  const ledger = [...(parent.subagentUsage ?? [])];
  const idx = ledger.findIndex((r) => r.sessionId === record.sessionId);
  const prev = idx >= 0 ? ledger[idx] : undefined;
  const delta: UsageTriple = {
    promptTokens: Math.max(0, record.promptTokens - (prev?.promptTokens ?? 0)),
    completionTokens: Math.max(
      0,
      record.completionTokens - (prev?.completionTokens ?? 0),
    ),
    cacheReadTokens: Math.max(
      0,
      record.cacheReadTokens - (prev?.cacheReadTokens ?? 0),
    ),
  };
  parent.totalPromptTokens = (parent.totalPromptTokens || 0) + delta.promptTokens;
  parent.totalCompletionTokens =
    (parent.totalCompletionTokens || 0) + delta.completionTokens;
  parent.totalCacheReadTokens =
    (parent.totalCacheReadTokens || 0) + delta.cacheReadTokens;
  if (idx >= 0) ledger[idx] = record;
  else ledger.push(record);
  parent.subagentUsage = ledger.slice(-MAX_LEDGER);
  return { added: !prev, delta };
}

export function sumSubagentUsage(records: SubagentUsageRecord[] | undefined): UsageTriple & {
  estCostUsd: number;
  count: number;
} {
  const list = records ?? [];
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let estCostUsd = 0;
  for (const r of list) {
    promptTokens += r.promptTokens;
    completionTokens += r.completionTokens;
    cacheReadTokens += r.cacheReadTokens;
    estCostUsd += r.estCostUsd;
  }
  return {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    estCostUsd,
    count: list.length,
  };
}

export interface FamilyCostBreakdown {
  family: UsageTriple & { estCostUsd: number };
  parent: UsageTriple & { estCostUsd: number };
  children: SubagentUsageRecord[];
  childSum: UsageTriple & { estCostUsd: number; count: number };
}

export function familyCostBreakdown(
  meta: Pick<
    SessionMeta,
    | "totalPromptTokens"
    | "totalCompletionTokens"
    | "totalCacheReadTokens"
    | "subagentUsage"
    | "provider"
    | "model"
  >,
  provider?: string,
  model?: string,
): FamilyCostBreakdown {
  const p = provider || meta.provider || "xai";
  const m = model || meta.model;
  const children = meta.subagentUsage ?? [];
  const childSum = sumSubagentUsage(children);
  const familyUsage: UsageTriple = {
    promptTokens: meta.totalPromptTokens || 0,
    completionTokens: meta.totalCompletionTokens || 0,
    cacheReadTokens: meta.totalCacheReadTokens || 0,
  };
  const parentUsage: UsageTriple = {
    promptTokens: Math.max(0, familyUsage.promptTokens - childSum.promptTokens),
    completionTokens: Math.max(
      0,
      familyUsage.completionTokens - childSum.completionTokens,
    ),
    cacheReadTokens: Math.max(
      0,
      familyUsage.cacheReadTokens - childSum.cacheReadTokens,
    ),
  };
  return {
    family: {
      ...familyUsage,
      estCostUsd: estimateCostUsd(
        p,
        familyUsage.promptTokens,
        familyUsage.completionTokens,
        m,
        familyUsage.cacheReadTokens,
      ),
    },
    parent: {
      ...parentUsage,
      estCostUsd: estimateCostUsd(
        p,
        parentUsage.promptTokens,
        parentUsage.completionTokens,
        m,
        parentUsage.cacheReadTokens,
      ),
    },
    children,
    childSum,
  };
}

export function formatSubagentCostLine(record: Pick<
  SubagentUsageRecord,
  | "subagentType"
  | "turns"
  | "maxTurns"
  | "status"
  | "promptTokens"
  | "estCostUsd"
  | "description"
>): string {
  const turns =
    record.maxTurns > 0
      ? `${record.turns}/${record.maxTurns}`
      : String(record.turns);
  const desc = record.description ? `  ${record.description}` : "";
  return `${record.subagentType} ${turns} ${record.status}  in=${formatTokens(record.promptTokens)} · ${formatCost(record.estCostUsd)}${desc}`;
}

/** Header line for the parent-facing spawn_subagent result. */
export function formatSubagentTokensHeader(usage: UsageTriple, estCostUsd: number): string {
  if (
    usage.promptTokens <= 0 &&
    usage.completionTokens <= 0 &&
    usage.cacheReadTokens <= 0
  ) {
    return "";
  }
  const cache =
    usage.cacheReadTokens > 0
      ? ` cache=${formatTokens(usage.cacheReadTokens)}`
      : "";
  return `- tokens: in=${formatTokens(usage.promptTokens)}${cache} out=${formatTokens(usage.completionTokens)} · est ${formatCost(estCostUsd)}`;
}

/** Extra /cost /status lines. Empty when no children were recorded. */
export function formatFamilyCostLines(breakdown: FamilyCostBreakdown): string[] {
  if (breakdown.childSum.count === 0) return [];
  const lines = [
    `  family:      ${formatCost(breakdown.family.estCostUsd)}  (parent + ${breakdown.childSum.count} subagent${breakdown.childSum.count === 1 ? "" : "s"})`,
    `  parent:      in=${formatTokens(breakdown.parent.promptTokens)} · ${formatCost(breakdown.parent.estCostUsd)}`,
    `  subagents:   in=${formatTokens(breakdown.childSum.promptTokens)} · ${formatCost(breakdown.childSum.estCostUsd)}`,
  ];
  for (const rec of breakdown.children) {
    lines.push(`    ${formatSubagentCostLine(rec)}`);
  }
  return lines;
}

export function familyCostJson(
  meta: SessionMeta,
  provider?: string,
  model?: string,
): {
  sessionCostUsd: number;
  parentCostUsd: number;
  subagentCostUsd: number;
  subagentUsage: SubagentUsageRecord[];
} {
  const b = familyCostBreakdown(meta, provider, model);
  return {
    sessionCostUsd: b.family.estCostUsd,
    parentCostUsd: b.parent.estCostUsd,
    subagentCostUsd: b.childSum.estCostUsd,
    subagentUsage: b.children,
  };
}

export function formatLiveChildSpend(
  child: Pick<
    SessionMeta,
    | "provider"
    | "model"
    | "totalPromptTokens"
    | "totalCompletionTokens"
    | "totalCacheReadTokens"
  >,
): string {
  const u = resolveChildUsage(child);
  if (u.promptTokens <= 0 && u.completionTokens <= 0) return "";
  const cost = estimateCostUsd(
    child.provider || "xai",
    u.promptTokens,
    u.completionTokens,
    child.model,
    u.cacheReadTokens,
  );
  return ` · ${formatTokens(u.promptTokens)} · ${formatCost(cost)}`;
}

/**
 * Live family spend check for a child loop. Folds this child's current
 * tokens into the parent (delta-safe) and returns the parent's
 * `costCapStatus` so siblings share remaining.
 */
export function createFamilyCostCapResolver(opts: {
  parentConfig: Pick<ForgeConfig, "maxCostUsd" | "provider" | "model">;
  parentMeta: SessionMeta;
  childMeta: SessionMeta;
  description: string;
  subagentType: string;
  maxTurns: number;
}): () => CostCapStatus {
  return () => {
    const usage = resolveChildUsage(opts.childMeta);
    const rec = buildSubagentUsageRecord({
      sessionId: opts.childMeta.id,
      description: opts.description,
      subagentType: opts.subagentType,
      status: "running",
      turns: Math.max(
        0,
        opts.childMeta.providerRounds ?? opts.childMeta.turnCount ?? 0,
      ),
      maxTurns: opts.maxTurns,
      usage,
      provider: String(opts.parentConfig.provider || opts.childMeta.provider),
      model: opts.parentConfig.model || opts.childMeta.model,
    });
    foldChildUsage(opts.parentMeta, rec);
    return costCapStatus(opts.parentConfig, opts.parentMeta);
  };
}
