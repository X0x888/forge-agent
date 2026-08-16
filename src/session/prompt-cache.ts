/**
 * Prompt-cache helpers for xAI prefix cache.
 *
 * Cache hits require a byte-identical prefix, sticky routing
 * (`x-grok-conv-id`), and (on reasoning models) replayed
 * `reasoning_content`. See docs.x.ai prompt-caching.
 */
import { envPositiveInt } from "../util/env.js";
import { isFalsy, isTruthy } from "../util/bool.js";
import { appendSessionMetrics } from "./metrics.js";

/** xAI Chat Completions header — pins the conversation to one cache shard. */
export const X_GROK_CONV_ID = "x-grok-conv-id";

/** Compact / prune before the 200k long-context 2× price cliff. */
export const REQUEST_PRUNE_AT_DEFAULT = 180_000;

export function grokConvIdHeaders(
  conversationId: string | undefined,
): Record<string, string> {
  const id = (conversationId || "").trim();
  if (!id) return {};
  return { [X_GROK_CONV_ID]: id.slice(0, 128) };
}

export function cacheHitRatio(promptTokens: number, cacheReadTokens: number): number {
  if (!(promptTokens > 0)) return 0;
  const cached = Math.min(Math.max(0, cacheReadTokens), promptTokens);
  return cached / promptTokens;
}

export function formatCacheRatio(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "0%";
  if (ratio >= 0.999) return "99.9%";
  return `${Math.round(ratio * 1000) / 10}%`;
}

/**
 * Live last-round ratio when the session recorded one; otherwise the
 * lifetime smear (early uncached rounds drag that number down).
 */
export function sessionCacheRatio(meta: {
  totalPromptTokens?: number;
  totalCacheReadTokens?: number;
  lastRoundPromptTokens?: number;
  lastRoundCacheReadTokens?: number;
}): { ratio: number; promptTokens: number; live: boolean } | undefined {
  const lastP = meta.lastRoundPromptTokens ?? 0;
  const lastC = meta.lastRoundCacheReadTokens ?? 0;
  if (lastP > 0) {
    return { ratio: cacheHitRatio(lastP, lastC), promptTokens: lastP, live: true };
  }
  const prompt = meta.totalPromptTokens ?? 0;
  const cached = meta.totalCacheReadTokens ?? 0;
  if (prompt > 0) {
    return { ratio: cacheHitRatio(prompt, cached), promptTokens: prompt, live: false };
  }
  return undefined;
}

export type PruneOutboundDecision =
  | { prune: false; reason: "off" | "under_threshold" }
  | { prune: true; reason: "always" | "threshold" };

/**
 * When to slim the outbound transcript.
 *
 * Default: append-only until the estimate hits REQUEST_PRUNE_AT (180k),
 * so xAI can cache the prefix. `FORGE_REQUEST_PRUNE=1` restores every-round
 * prune (legacy; kills prefix cache). `=0` never prunes.
 */
export function requestPruneAtTokens(): number {
  return envPositiveInt("FORGE_REQUEST_PRUNE_AT", REQUEST_PRUNE_AT_DEFAULT);
}

export function shouldPruneOutbound(estimatedTokens: number): PruneOutboundDecision {
  const raw = process.env.FORGE_REQUEST_PRUNE;
  if (raw !== undefined && raw !== "" && isFalsy(raw)) {
    return { prune: false, reason: "off" };
  }
  if (raw !== undefined && raw !== "" && isTruthy(raw)) {
    return { prune: true, reason: "always" };
  }
  const at = requestPruneAtTokens();
  if (Number.isFinite(estimatedTokens) && estimatedTokens >= at) {
    return { prune: true, reason: "threshold" };
  }
  return { prune: false, reason: "under_threshold" };
}

/** Pull reasoning text off a Chat Completions message or SSE delta. */
export function extractReasoningContent(source: unknown): string {
  if (!source || typeof source !== "object") return "";
  const o = source as Record<string, unknown>;
  if (typeof o.reasoning_content === "string" && o.reasoning_content) {
    return o.reasoning_content;
  }
  if (typeof o.reasoning === "string" && o.reasoning) return o.reasoning;
  if (o.reasoning && typeof o.reasoning === "object") {
    const inner = o.reasoning as Record<string, unknown>;
    if (typeof inner.content === "string" && inner.content) return inner.content;
    if (typeof inner.text === "string" && inner.text) return inner.text;
  }
  return "";
}

export function appendProviderRoundMetrics(opts: {
  sessionId: string;
  provider: string;
  model?: string;
  promptTokens: number;
  cacheReadTokens: number;
  completionTokens: number;
  pruned: boolean;
  pruneKind?: string;
  cacheDrop?: boolean;
  turn: number;
}): void {
  const ratio = cacheHitRatio(opts.promptTokens, opts.cacheReadTokens);
  appendSessionMetrics({
    ts: new Date().toISOString(),
    type: "provider_round",
    sessionId: opts.sessionId,
    provider: opts.provider,
    model: opts.model,
    promptTokens: opts.promptTokens,
    cacheReadTokens: opts.cacheReadTokens,
    completionTokens: opts.completionTokens,
    cacheRatio: Math.round(ratio * 10000) / 10000,
    pruned: opts.pruned || undefined,
    pruneKind: opts.pruneKind && opts.pruneKind !== "off" ? opts.pruneKind : undefined,
    cacheDrop: opts.cacheDrop || undefined,
    providerRounds: opts.turn,
  });
}
