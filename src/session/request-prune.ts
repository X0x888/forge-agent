/**
 * Request-time working-set prune (Grok PruningConfig analogue).
 *
 * Stored session.json is never rewritten — undo, /last, and the xAI prefix
 * cache stay intact. Only the outbound ChatRequest is slimmed.
 *
 * Forge ULW is one user message and hundreds of assistant+tool steps, so
 * age is counted in **assistant tool-rounds**, not user turns. A user-turn
 * clock would leave an 800-round wave unpruned.
 *
 *   age 0 .. keepTurns-1  → untouched (hot tail)
 *   age >= keepTurns      → collapse tool_call args; soft-trim fat results
 *   age >= hardAgeTurns   → omit tool results (spool pointer when we can)
 */
import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, ToolCall } from "../providers/types.js";
import { ensureDir } from "../util/fs.js";
import { envPositiveInt } from "../util/env.js";
import { isFalsy } from "../util/bool.js";
import { toolOutputDir } from "../agent/tools/truncate.js";
import {
  extractSavedOutputPath,
  isIdempotentRestoreTool,
} from "./tool-clearing.js";

export const REQUEST_PRUNE_DEFAULT_KEEP_TURNS = 3;
export const REQUEST_PRUNE_DEFAULT_HARD_AGE = 10;
export const REQUEST_PRUNE_DEFAULT_SOFT_CHARS = 4_000;
export const REQUEST_PRUNE_DEFAULT_SOFT_HEAD = 1_500;
export const REQUEST_PRUNE_DEFAULT_SOFT_TAIL = 1_500;

export const REQUEST_PRUNE_OMITTED = "[Tool result omitted — too old]";
const SOFT_TRIM_SEP = "\n\n…\n\n";

export interface RequestPruneConfig {
  enabled: boolean;
  /** Assistant steps kept verbatim (newest first). */
  keepTurns: number;
  /** Age at which tool bodies become the omit placeholder. */
  hardAgeTurns: number;
  softTrimChars: number;
  softTrimHead: number;
  softTrimTail: number;
}

export function requestPruneEnvConfig(): RequestPruneConfig {
  const raw = process.env.FORGE_REQUEST_PRUNE;
  return {
    enabled: raw === undefined || raw === "" ? true : !isFalsy(raw),
    keepTurns: envPositiveInt(
      "FORGE_REQUEST_PRUNE_KEEP_TURNS",
      REQUEST_PRUNE_DEFAULT_KEEP_TURNS,
    ),
    hardAgeTurns: envPositiveInt(
      "FORGE_REQUEST_PRUNE_HARD_AGE",
      REQUEST_PRUNE_DEFAULT_HARD_AGE,
    ),
    softTrimChars: envPositiveInt(
      "FORGE_REQUEST_PRUNE_SOFT_CHARS",
      REQUEST_PRUNE_DEFAULT_SOFT_CHARS,
    ),
    softTrimHead: envPositiveInt(
      "FORGE_REQUEST_PRUNE_SOFT_HEAD",
      REQUEST_PRUNE_DEFAULT_SOFT_HEAD,
    ),
    softTrimTail: envPositiveInt(
      "FORGE_REQUEST_PRUNE_SOFT_TAIL",
      REQUEST_PRUNE_DEFAULT_SOFT_TAIL,
    ),
  };
}

export interface RequestPruneOptions extends Partial<RequestPruneConfig> {
  /**
   * When true (send path), hard-omit may write a stable spool keyed by
   * tool_call_id. Estimate path should leave this false — no disk I/O.
   */
  spool?: boolean;
}

export interface RequestPruneResult {
  messages: ChatMessage[];
  /** Tool-result bodies soft-trimmed or omitted. */
  prunedResults: number;
  /** Assistant tool_call argument blobs collapsed. */
  collapsedCalls: number;
  /** Older harness user pokes stubbed to a one-liner. */
  stubbedHarness?: number;
  /** True when `messages` is a new array (input was not mutated). */
  changed: boolean;
}

export const HARNESS_USER_STUB = "[Forge harness — superseded]";

const HARNESS_USER_CLASSES: { id: string; prefix: string }[] = [
  { id: "admit", prefix: "[Forge harness — mid-conversation update]" },
  { id: "ulw_stop", prefix: "[Forge ULW cycle driver]" },
  { id: "verify", prefix: "[Forge harness — verify nudge]" },
  { id: "fix", prefix: "[Forge harness — fix until green]" },
  { id: "todo", prefix: "[Forge system-reminder — TodoNudge]" },
  { id: "bg", prefix: "[Forge harness — background task " },
];

const PROOF_POKE_CLASSES = new Set(["verify", "fix"]);

/** Classify a user-channel harness poke, or null for real user / kickoff text. */
export function classifyHarnessUserMessage(content: string): string | null {
  return harnessUserClass(content);
}

/** Count Forge-injected user-channel pokes (for run JSON / metrics). */
export function countHarnessUserPokes(messages: ChatMessage[]): {
  harnessUserPokes: number;
  admitCount: number;
  proofPokes: number;
} {
  let harnessUserPokes = 0;
  let admitCount = 0;
  let proofPokes = 0;
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content !== "string") continue;
    const cls = harnessUserClass(m.content);
    if (!cls) continue;
    harnessUserPokes += 1;
    if (cls === "admit") admitCount += 1;
    if (PROOF_POKE_CLASSES.has(cls)) proofPokes += 1;
  }
  return { harnessUserPokes, admitCount, proofPokes };
}

function harnessUserClass(content: string): string | null {
  const t = content.trimStart();
  for (const c of HARNESS_USER_CLASSES) {
    if (t.startsWith(c.prefix)) return c.id;
  }
  return null;
}

/**
 * Keep the newest message of each harness-user class; stub older ones.
 * Real user text and kickoff (`## ULW armed`) are never stubbed.
 */
export function collapseStaleHarnessUserMessages(
  messages: ChatMessage[],
): { messages: ChatMessage[]; stubbed: number; changed: boolean } {
  const lastKept = new Set<string>();
  let stubbed = 0;
  let out: ChatMessage[] | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user" || typeof m.content !== "string") continue;
    const cls = harnessUserClass(m.content);
    if (!cls) continue;
    if (!lastKept.has(cls)) {
      lastKept.add(cls);
      continue;
    }
    if (m.content === HARNESS_USER_STUB || m.content.startsWith(HARNESS_USER_STUB)) {
      continue;
    }
    if (!out) out = messages.slice();
    out[i] = { ...m, content: HARNESS_USER_STUB };
    stubbed += 1;
  }
  return {
    messages: out ?? messages,
    stubbed,
    changed: Boolean(out),
  };
}

/**
 * Age of each message in assistant steps from the end.
 * Assistant messages increment the step. Following tool rows share that step.
 * System/user = -1 (never pruned).
 */
export function assistantStepAges(messages: ChatMessage[]): number[] {
  const n = messages.length;
  const stepOf = new Array<number>(n).fill(-1);
  let step = -1;
  for (let i = 0; i < n; i++) {
    const role = messages[i]?.role;
    if (role === "assistant") {
      step += 1;
      stepOf[i] = step;
    } else if (role === "tool") {
      stepOf[i] = step;
    }
  }
  if (step < 0) return stepOf;
  return stepOf.map((s) => (s < 0 ? -1 : step - s));
}

function alreadyOmitted(body: string): boolean {
  return body.startsWith(REQUEST_PRUNE_OMITTED) || body.includes(REQUEST_PRUNE_OMITTED);
}

function alreadyClearedArgs(args: string): boolean {
  return args.includes('"_cleared"');
}

function peekArgMeta(args: string): { path?: string; command?: string } {
  const raw = (args || "").trim();
  if (!raw || raw[0] !== "{") return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== "object") return {};
    const pick = (k: string): string | undefined => {
      const v = o[k];
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    const p = pick("path") || pick("target_file") || pick("file");
    const cmd = pick("command");
    return {
      path: p && p.length > 48 ? `${p.slice(0, 45)}…` : p,
      command: cmd && cmd.length > 48 ? `${cmd.slice(0, 45)}…` : cmd,
    };
  } catch {
    return {};
  }
}

export function collapseToolCallArgs(tc: ToolCall): ToolCall {
  const args = tc.function.arguments || "";
  if (!args || alreadyClearedArgs(args)) return tc;
  const name = tc.function.name || "tool";
  // Keep the JSON tiny — name already lives on function.name. A short
  // command/path hint is optional and capped so 800-step histories stay lean.
  const meta = peekArgMeta(args);
  const stub: Record<string, unknown> = { _cleared: true };
  // Commands are otherwise lost (name is just "bash"). Paths stay off the
  // wire — function.name + the omitted result are enough for reads.
  if (meta.command) stub.command = meta.command;
  return {
    ...tc,
    function: {
      ...tc.function,
      name,
      arguments: JSON.stringify(stub),
    },
  };
}

function softTrim(body: string, head: number, tail: number): string {
  if (body.length <= head + tail + SOFT_TRIM_SEP.length) return body;
  return body.slice(0, head) + SOFT_TRIM_SEP + body.slice(-tail);
}

/** Stable spool so a second request does not write a new file. */
export function ensureRequestPruneSpool(
  toolCallId: string,
  body: string,
): string | undefined {
  const existing = extractSavedOutputPath(body);
  if (existing) return existing;
  const id = (toolCallId || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  if (!id) return undefined;
  try {
    const dir = toolOutputDir();
    ensureDir(dir);
    const file = path.join(dir, `req_${id}.txt`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
    }
    return file;
  } catch {
    return undefined;
  }
}

function formatOmitted(opts: {
  name: string;
  chars: number;
  outputPath?: string;
  idempotent: boolean;
}): string {
  const who = `${opts.name}, ${opts.chars} chars`;
  const pointer = opts.outputPath ? ` Full output: ${opts.outputPath}` : "";
  const hint = opts.idempotent ? "" : ` Do not re-run ${opts.name}.`;
  return `${REQUEST_PRUNE_OMITTED} (${who}).${pointer}${hint}`;
}

function nameByToolCallId(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      if (tc.id) map.set(tc.id, tc.function.name || "tool");
    }
  }
  return map;
}

/**
 * Return a pruned copy for the provider. Input is never mutated.
 * When nothing qualifies, returns the same array reference.
 */
export function pruneMessagesForRequest(
  messages: ChatMessage[],
  opts: RequestPruneOptions = {},
): RequestPruneResult {
  const env = requestPruneEnvConfig();
  const enabled = opts.enabled ?? env.enabled;
  if (!enabled || messages.length === 0) {
    return {
      messages,
      prunedResults: 0,
      collapsedCalls: 0,
      stubbedHarness: 0,
      changed: false,
    };
  }

  const keepTurns = opts.keepTurns ?? env.keepTurns;
  const hardAge = opts.hardAgeTurns ?? env.hardAgeTurns;
  const softChars = opts.softTrimChars ?? env.softTrimChars;
  const softHead = opts.softTrimHead ?? env.softTrimHead;
  const softTail = opts.softTrimTail ?? env.softTrimTail;
  const spool = Boolean(opts.spool);

  const ages = assistantStepAges(messages);
  const names = nameByToolCallId(messages);

  let out: ChatMessage[] | null = null;
  let prunedResults = 0;
  let collapsedCalls = 0;

  const take = (i: number): ChatMessage => {
    if (!out) out = messages.slice();
    return out[i]!;
  };

  for (let i = 0; i < messages.length; i++) {
    const age = ages[i] ?? -1;
    if (age < keepTurns) continue;

    const m = messages[i]!;

    if (m.role === "assistant" && m.tool_calls?.length) {
      let any = false;
      const nextCalls = m.tool_calls.map((tc) => {
        const args = tc.function.arguments || "";
        if (!args || alreadyClearedArgs(args)) return tc;
        any = true;
        collapsedCalls += 1;
        return collapseToolCallArgs(tc);
      });
      if (any) {
        const cur = take(i);
        out![i] = { ...cur, tool_calls: nextCalls };
      }
      continue;
    }

    if (m.role !== "tool") continue;
    const body = m.content ?? "";
    if (!body || alreadyOmitted(body)) continue;

    const name = (m.tool_call_id && names.get(m.tool_call_id)) || "tool";

    if (age >= hardAge) {
      const outputPath = spool
        ? ensureRequestPruneSpool(m.tool_call_id || "", body)
        : extractSavedOutputPath(body);
      const stub = formatOmitted({
        name,
        chars: body.length,
        outputPath,
        idempotent: isIdempotentRestoreTool(name),
      });
      if (stub !== body) {
        take(i);
        out![i] = { ...m, content: stub };
        prunedResults += 1;
      }
      continue;
    }

    if (body.length > softChars) {
      const trimmed = softTrim(body, softHead, softTail);
      if (trimmed !== body) {
        take(i);
        out![i] = { ...m, content: trimmed };
        prunedResults += 1;
      }
    }
  }

  const toolChanged = Boolean(out);
  const afterTools = out ?? messages;
  const harness = collapseStaleHarnessUserMessages(afterTools);
  if (!toolChanged && !harness.changed) {
    return {
      messages,
      prunedResults: 0,
      collapsedCalls: 0,
      stubbedHarness: 0,
      changed: false,
    };
  }
  return {
    messages: harness.messages,
    prunedResults,
    collapsedCalls,
    stubbedHarness: harness.stubbed,
    changed: true,
  };
}
