/**
 * Unattended store checkpoint — resume file for the night shift.
 *
 * Not Grok FullReplace. Wire prune already slims the API request.
 * This module shrinks session.json when the *store* is dangerous and
 * writes a verbatim job card from sidecars (mandate, decisions, artifacts).
 */
import path from "node:path";
import { forgeHome, readJsonFile, writeJsonFile, nowIso } from "../util/fs.js";
import { envPositiveInt } from "../util/env.js";
import type { ChatMessage } from "../providers/types.js";
import { readFileMutations } from "./mutations.js";
import { extractSavedOutputPath } from "./tool-clearing.js";

/** Same prefixes as session.isSyntheticUserMessage — do not import session.ts (cycle). */
function isSyntheticUser(msg: ChatMessage): boolean {
  if (msg.role !== "user" || typeof msg.content !== "string") return false;
  const text = msg.content.trimStart();
  return (
    text.startsWith("[Forge") ||
    text.startsWith("[User control — mid-run]") ||
    text.startsWith("[Conversation compacted — ") ||
    text.startsWith("The user sent a message while you were working:")
  );
}

export const DEFAULT_CHECKPOINT_KEEP_STEPS = 3;
export const DEFAULT_CHECKPOINT_STORE_TOKENS = 1_500_000;
export const DEFAULT_CHECKPOINT_STORE_MESSAGES = 2_500;

export const CHECKPOINT_PREFIX = "[Forge checkpoint ";

export interface CheckpointRecord {
  epoch: number;
  at: string;
  droppedCount: number;
  mandate?: string;
  paths: string[];
  spoolPaths: string[];
  lastVerificationCommand?: string;
  lastVerificationAt?: string;
}

export function checkpointPath(sessionId: string): string {
  return path.join(forgeHome(), "sessions", sessionId, "checkpoint.json");
}

export function loadCheckpointSidecar(
  sessionId: string,
): CheckpointRecord | null {
  if (!sessionId) return null;
  return readJsonFile<CheckpointRecord | null>(checkpointPath(sessionId), null);
}

export function saveCheckpointSidecar(
  sessionId: string,
  rec: CheckpointRecord,
): void {
  if (!sessionId) return;
  writeJsonFile(checkpointPath(sessionId), rec);
}

export function checkpointStoreLimits(): {
  maxTokens: number;
  maxMessages: number;
} {
  return {
    maxTokens: envPositiveInt(
      "FORGE_CHECKPOINT_STORE_TOKENS",
      DEFAULT_CHECKPOINT_STORE_TOKENS,
    ),
    maxMessages: envPositiveInt(
      "FORGE_CHECKPOINT_STORE_MESSAGES",
      DEFAULT_CHECKPOINT_STORE_MESSAGES,
    ),
  };
}

/** True when the *stored* transcript is large enough to justify a checkpoint. */
export function storeNeedsCheckpoint(
  messageCount: number,
  storeTokens: number,
): boolean {
  const { maxTokens, maxMessages } = checkpointStoreLimits();
  return messageCount >= maxMessages || storeTokens >= maxTokens;
}

export function nextCheckpointEpoch(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content !== "string") continue;
    const g = /Forge checkpoint (\d+)/.exec(m.content);
    if (g) n = Math.max(n, Number(g[1]) || 0);
  }
  return n + 1;
}

export function lastRealUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user" || typeof m.content !== "string") continue;
    if (isSyntheticUser(m)) continue;
    const t = m.content.trim();
    if (t) return t;
  }
  return "";
}

/**
 * Keep the last `keepSteps` assistant tool-rounds (assistant + its tools).
 * If there are no assistant messages, fall back to last `keepSteps` rows.
 */
export function splitInFlightTail(
  rest: ChatMessage[],
  keepSteps: number,
): { dropped: ChatMessage[]; kept: ChatMessage[] } {
  const steps = Math.max(1, keepSteps);
  const assistantAt: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i]?.role === "assistant") assistantAt.push(i);
  }
  if (assistantAt.length === 0) {
    if (rest.length <= steps) return { dropped: [], kept: rest };
    return {
      dropped: rest.slice(0, rest.length - steps),
      kept: rest.slice(rest.length - steps),
    };
  }
  const from =
    assistantAt.length <= steps
      ? assistantAt[0]!
      : assistantAt[assistantAt.length - steps]!;
  if (from <= 0) return { dropped: [], kept: rest };
  return { dropped: rest.slice(0, from), kept: rest.slice(from) };
}

export function mutationPathsNewestFirst(
  sessionId: string,
  limit = 40,
): string[] {
  if (!sessionId) return [];
  try {
    const all = readFileMutations(sessionId);
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const p = all[i]?.path;
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function collectSpoolPaths(messages: ChatMessage[], limit = 16): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "tool" || !m.content) continue;
    const p = extractSavedOutputPath(m.content);
    if (p && !out.includes(p)) {
      out.push(p);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function collectToolSketch(dropped: ChatMessage[]): {
  calls: string;
  paths: string[];
} {
  const toolNames = new Map<string, number>();
  const paths = new Set<string>();
  for (const m of dropped) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      toolNames.set(
        tc.function.name,
        (toolNames.get(tc.function.name) || 0) + 1,
      );
      const args = tc.function.arguments || "";
      for (const match of args.matchAll(
        /"(?:path|file|target_file|command)"\s*:\s*"([^"]{1,200})"/g,
      )) {
        paths.add(match[1]!);
      }
    }
  }
  const calls = [...toolNames.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([n, c]) => `${n}×${c}`)
    .join(", ");
  return { calls, paths: [...paths].slice(0, 20) };
}

export function persistCheckpointRecord(
  sessionId: string | undefined,
  rec: Omit<CheckpointRecord, "at">,
): CheckpointRecord {
  const full: CheckpointRecord = { ...rec, at: nowIso() };
  if (sessionId) {
    try {
      saveCheckpointSidecar(sessionId, full);
    } catch {
      /* sidecar is best-effort */
    }
  }
  return full;
}
