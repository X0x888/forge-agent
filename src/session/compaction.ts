/**
 * Store checkpoint compact — resume file for long unattended runs.
 *
 * Wire prune (request-prune.ts) slims the API request. This module rewrites
 * session.json only when the *store* is huge: system + verbatim job card +
 * in-flight assistant steps. Sidecars (ulw/decisions/mutations/spools) are
 * the source of truth; the card is extractive, not an LLM summary.
 */

import type { ChatMessage } from "../providers/types.js";
import type { GoalState } from "../harness/goal.js";
import type { UlwCycleState } from "../harness/ulw-cycle.js";
import type { TodoItem } from "./session.js";
import {
  displayUlwMandate,
  formatUlwCounts,
  formatWaveLedger,
} from "../harness/ulw-cycle.js";
import { repairToolCallPairing } from "./message-repair.js";
import {
  DEFAULT_CHECKPOINT_KEEP_STEPS,
  nextCheckpointEpoch,
  splitInFlightTail,
  lastRealUserText,
  mutationPathsNewestFirst,
  collectSpoolPaths,
  collectToolSketch,
  persistCheckpointRecord,
} from "./checkpoint.js";
import { detectProjectIntel } from "../util/project-intel.js";
import { looksLikeAdvisoryUserMessage } from "../util/advisory-intent.js";
import { formatMemoryForPrompt } from "../harness/decision-memory.js";
import { formatProjectMemoryForPrompt } from "../harness/project-memory.js";
import {
  extractSavedOutputPath,
  ensureToolOutputSpool,
} from "./tool-clearing.js";
export { looksLikeAdvisoryUserMessage } from "../util/advisory-intent.js";

export interface CompactContext {
  ulw?: UlwCycleState | null;
  goal?: GoalState | null;
  todos?: TodoItem[];
  sessionId?: string;
  /** Workspace cwd for project-intel preferred checks. */
  cwd?: string;
  /** Last structural verification command from session meta. */
  lastVerificationCommand?: string;
  lastVerificationAt?: string;
  lastEditAt?: string;
}

export interface CompactResult {
  messages: ChatMessage[];
  droppedCount: number;
  summary: string;
}

const DEFAULT_KEEP_LAST = DEFAULT_CHECKPOINT_KEEP_STEPS;

/** Do not re-inject the 5k god-mode dump as "last user request" after compact. */
export function clipUserMandate(raw: string): string {
  const t = raw.trim();
  // Slim kickoff (protocol lives in the system prompt).
  if (/^## ULW armed\b/m.test(t)) {
    const m = t.match(/^Mandate:\s*(.+)$/m);
    const mandate = (m?.[1] || "").trim();
    if (mandate) {
      return `${mandate}  [ulw kickoff clipped — protocol is in the system prompt]`;
    }
  }
  const signal = t.match(/User signal[^:]*:\s*"([^"]+)"/i);
  if (signal && /ULW GOD MODE|god-mode|full operational ownership/i.test(t)) {
    return `"${signal[1]}"  [expanded mandate in ulw.json — do not re-derive or restart leftover-chrome hunting]`;
  }
  if (t.length > 400 && /ULW GOD MODE/i.test(t)) {
    return `${t.slice(0, 240)}… [ulw.expandedMandate]`;
  }
  return t.length > 1200 ? `${t.slice(0, 400)}… [full in last real user / ulw.json]` : t;
}

/**
 * Checkpoint the store: system + verbatim job card + last N assistant steps.
 * `keepLast` is in-flight assistant steps (default 3), not raw messages.
 */
export function compactMessagesStructured(
  messages: ChatMessage[],
  opts?: {
    keepLast?: number;
    context?: CompactContext;
  },
): CompactResult {
  const keepSteps = opts?.keepLast ?? DEFAULT_KEEP_LAST;
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const { dropped, kept: keptRaw } = splitInFlightTail(rest, keepSteps);
  if (dropped.length === 0) {
    return { messages, droppedCount: 0, summary: "" };
  }

  const epoch = nextCheckpointEpoch(messages);
  const ctx = opts?.context;
  const summary = buildStructuredSummary(dropped, ctx, {
    epoch,
    allMessages: messages,
  });
  const sketch = collectToolSketch(dropped);
  persistCheckpointRecord(ctx?.sessionId, {
    epoch,
    droppedCount: dropped.length,
    mandate: ctx?.ulw?.mandate,
    paths: [
      ...mutationPathsNewestFirst(ctx?.sessionId || "", 40),
      ...sketch.paths,
    ].filter((p, i, a) => a.indexOf(p) === i).slice(0, 40),
    spoolPaths: collectSpoolPaths(dropped),
    lastVerificationCommand: ctx?.lastVerificationCommand,
    lastVerificationAt: ctx?.lastVerificationAt,
  });

  const repaired = repairToolCallPairing([
    ...system,
    { role: "user", content: summary },
    ...keptRaw,
  ]);

  return {
    messages: repaired.messages,
    droppedCount: dropped.length,
    summary,
  };
}


export function buildStructuredSummary(
  dropped: ChatMessage[],
  ctx?: CompactContext,
  extra?: { epoch?: number; allMessages?: ChatMessage[] },
): string {
  const epoch = extra?.epoch ?? 1;
  const sections: string[] = [
    `[Conversation compacted — Forge checkpoint ${epoch} — ${dropped.length} earlier messages]`,
    `Continue from this job card + the in-flight tail. Do not rescan the repo from zero. Sidecars (ulw.json, decisions.json, mutations.jsonl, tool-output) win if this card and the transcript disagree.`,
  ];

  const realUser = lastRealUserText(extra?.allMessages || dropped);
  if (realUser) {
    sections.push(``, `## 0. Last real user request`, clipUserMandate(realUser));
  }

  // 1. Harness / mandate (load-bearing for ULW)
  sections.push(``, `## 1. Harness & mandate`);
  // Compact-boundary intent: ULW momentum must not override pure Q&A.
  // (oh-my-claude compact-intent-preservation lesson — advisory survives compact.)
  const lastUser = [...dropped]
    .reverse()
    .find((m) => m.role === "user" && (m.content || "").trim());
  const advisory = lastUser
    ? looksLikeAdvisoryUserMessage(String(lastUser.content || ""))
    : false;
  if (advisory) {
    const raw = String(lastUser?.content || "").replace(/\s+/g, " ").trim();
    const snippet =
      raw.length > 240 ? `${raw.slice(0, 237).trimEnd()}…` : raw;
    sections.push(
      `- Intent: ADVISORY/Q&A (last user message looks like a question/opinion request) — answer first; do **not** implement, edit, commit, or push unless the user explicitly asks. ULW momentum does not override this.`,
    );
    if (snippet) {
      sections.push(`- Last meta-request: ${snippet}`);
    }
  } else {
    sections.push(
      `- Intent: pure questions are not work orders — answer first; do not build/refactor unasked. Explicit implement/fix/ship language overrides. Soft prompts under ULW still expand to god-scope.`,
    );
  }

  const ulw = ctx?.ulw?.enabled ? ctx.ulw : null;
  if (ulw) {
    const softLine = ulw.softPrompt
      ? advisory
        ? `- Soft prompt expanded to god-scope (suspended while Intent is ADVISORY/Q&A — answer first)`
        : `- Soft prompt expanded to god-scope`
      : "";
    // Prefer full mandate when it fits; otherwise keep head + sidecar pointer
    // (decision memory holds structured constraints — do not lobotomize).
    const mandateFull = displayUlwMandate(ulw.mandate || "");
    const mandateLine =
      mandateFull.length <= 1200
        ? `- Mandate: ${mandateFull || "(none)"}`
        : `- Mandate (head): ${mandateFull.slice(0, 400)}… [full in ulw.json + decisions.json]`;
    // Never re-inject expandedMandate (the 5k god-mode dump). Protocol is
    // already in the cache-stable system prompt.
    const ledger = formatWaveLedger(ulw.waves, 8);
    sections.push(
      `- ULW ON | ${formatUlwCounts(ulw)} ${ulw.cycle === 1 ? "(CONTINUE)" : "(LAST)"}`,
      `- Harness w=N/M is the only wave counter. Do not invent Wave K. Close a unit with \`Wave shipped.\` / \`Ship landed:\` / \`Cycle complete.\` so the counter can move (ulw.json wins if this card is stale).`,
      `- max_waves: ${ulw.maxWaves != null ? ulw.maxWaves : "off (unlimited)"}`,
      ledger ? `- Ledger: ${ledger}` : "",
      mandateLine,
      softLine,
    );
  } else {
    sections.push(`- ULW: off`);
  }

  // 1b. Durable decisions (Mastra-critical — never drop active constraints)
  sections.push(``, `## 1b. Decisions / constraints (durable)`);
  if (ctx?.sessionId) {
    const mem = formatMemoryForPrompt(ctx.sessionId, {
      budget: 6000,
      includeWave: false,
    });
    if (mem.corrupt) {
      sections.push(
        `- ⚠ Decision memory corrupt — re-arm /ulw or inspect decisions.json; do not invent constraints`,
      );
    }
    sections.push(mem.text);
  } else {
    sections.push(`- (no sessionId — decision sidecar unavailable)`);
  }
  // 1c. Cross-session project memory (survives /new — not decisions.json)
  try {
    const cwd = ctx?.cwd || process.cwd();
    const pm = formatProjectMemoryForPrompt(cwd, 2_500);
    if (pm.trim()) {
      sections.push(``, pm);
    }
  } catch {
    /* */
  }
  const goal = ctx?.goal;
  if (goal?.objective && goal.status === "active" && !goal.paused) {
    sections.push(
      advisory
        ? `- Goal ACTIVE (paused for ADVISORY/Q&A — answer first; do not treat this as a work order): ${goal.objective}`
        : `- Goal ACTIVE: ${goal.objective}`,
      goal.criteria.length
        ? `- Criteria: ${goal.criteria.map((c, i) => `${i + 1}. ${c}`).join("; ")}`
        : "",
    );
  } else if (goal?.paused) {
    sections.push(`- Goal: paused (${goal.objective || ""})`);
  } else {
    sections.push(`- Goal: none`);
  }

  // Project verification (less steering after compact)
  try {
    const cwd = ctx?.cwd || process.cwd();
    const intel = detectProjectIntel(cwd);
    if (intel.checkCommands[0] || intel.packageManager) {
      sections.push(
        `- Project checks: ${intel.checkCommands.slice(0, 4).join(" · ")}` +
          (intel.packageManager ? ` (pm=${intel.packageManager})` : ""),
      );
    }
    if (ctx?.lastVerificationCommand?.trim()) {
      const last = ctx.lastVerificationCommand.trim().slice(0, 120);
      let stale = "";
      try {
        const vt = ctx.lastVerificationAt
          ? Date.parse(ctx.lastVerificationAt)
          : NaN;
        const et = ctx.lastEditAt ? Date.parse(ctx.lastEditAt) : NaN;
        if (Number.isFinite(vt) && Number.isFinite(et) && et > vt) {
          stale = "  ⚠ stale (edits after verify)";
        }
      } catch {
        /* */
      }
      sections.push(`- Last verify: ${last}${stale}`);
    }
  } catch {
    /* */
  }

  // 2. Todos
  sections.push(``, `## 2. Todos`);
  const todos = ctx?.todos ?? [];
  if (todos.length === 0) {
    sections.push(`- (none recorded)`);
  } else {
    if (advisory) {
      sections.push(
        `- (ADVISORY/Q&A: list is context only — do not execute open todos unless the user explicitly asks)`,
      );
    }
    for (const t of todos.slice(0, 40)) {
      sections.push(`- [${t.status}] ${t.id}: ${t.content}`);
    }
    if (todos.length > 40) sections.push(`- … +${todos.length - 40} more`);
  }

  // 3. User messages (verbatim high-fidelity, capped)
  sections.push(``, `## 3. User messages (dropped span)`);
  const userMsgs = dropped
    .filter((m) => m.role === "user" && (m.content || "").trim())
    .map((m) => (m.content || "").trim());
  if (userMsgs.length === 0) {
    sections.push(`- (none)`);
  } else {
    const pick = userMsgs.length <= 12 ? userMsgs : [
      ...userMsgs.slice(0, 6),
      `… (${userMsgs.length - 10} omitted) …`,
      ...userMsgs.slice(-4),
    ];
    for (const u of pick) {
      sections.push(`- ${clip(u, 400)}`);
    }
  }

  // 4. Tool activity sketch
  sections.push(``, `## 4. Tool activity (sketch)`);
  const toolNames = new Map<string, number>();
  const paths = new Set<string>();
  for (const m of dropped) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        toolNames.set(
          tc.function.name,
          (toolNames.get(tc.function.name) || 0) + 1,
        );
        const args = tc.function.arguments || "";
        for (const match of args.matchAll(
          /"(?:path|file|target_file|command)"\s*:\s*"([^"]{1,200})"/g,
        )) {
          paths.add(match[1]);
        }
      }
    }
  }
  if (toolNames.size === 0) {
    sections.push(`- (no tool calls in dropped span)`);
  } else {
    const ranked = [...toolNames.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([n, c]) => `${n}×${c}`);
    sections.push(`- Calls: ${ranked.join(", ")}`);
    if (paths.size) {
      sections.push(
        `- Paths/commands (sample): ${[...paths].slice(0, 20).join("; ")}`,
      );
    }
    const artifacts: string[] = [];
    for (const m of dropped) {
      if (m.role !== "tool" || !m.content) continue;
      const p = extractSavedOutputPath(m.content);
      if (p && !artifacts.includes(p)) artifacts.push(p);
    }
    if (artifacts.length) {
      sections.push(
        `- Saved tool output (read_file to restore): ${artifacts.slice(0, 8).join("; ")}`,
      );
    }
  }

  // 5. Assistant conclusions / errors (heuristic)
  sections.push(``, `## 5. Notes from assistant turns`);
  const assistantSnips = dropped
    .filter((m) => m.role === "assistant" && (m.content || "").trim())
    .map((m) => (m.content || "").trim());
  const interesting = assistantSnips.filter((t) =>
    /error|fail|fix|shipped|serendipity|wave|done|blocked|cannot|❌|✅/i.test(t),
  );
  const snips =
    interesting.length > 0
      ? interesting.slice(-6)
      : assistantSnips.slice(-3);
  if (snips.length === 0) {
    sections.push(`- (none)`);
  } else {
    for (const s of snips) {
      sections.push(`- ${clip(s, 280)}`);
    }
  }

  const mutPaths = mutationPathsNewestFirst(ctx?.sessionId || "", 24);
  const spools = collectSpoolPaths(dropped);
  if (mutPaths.length || spools.length) {
    sections.push(``, `## 4b. Artifact index (sidecars)`);
    if (mutPaths.length) {
      sections.push(`- Edited: ${mutPaths.slice(0, 20).join("; ")}`);
    }
    if (spools.length) {
      sections.push(
        `- Spools (read_file to restore; do not re-run bash/spawn): ${spools.slice(0, 8).join("; ")}`,
      );
    }
  }

  sections.push(
    ``,
    `## 6. Resume`,
    `- Epoch ${epoch}: continue the mandate/goal from the job card + in-flight tail.`,
    `- Do not rescan the workspace from zero. Verify only what may be stale.`,
    `- Restore omitted tool bodies with read_file on a Full output / spool path — do not re-run spawn_subagent or bash.`,
    `- File-read stamps survive this checkpoint if the file mtime still matches; re-read only when the guard says the file changed.`,
  );

  return sections.filter((l) => l !== undefined && l !== "").join("\n");
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

export interface PruneBodiesResult {
  messages: ChatMessage[];
  pruned: number;
}

/**
 * In-place shrink of huge tool/assistant bodies while keeping message shape.
 * Used when keep-window compaction alone cannot free enough tokens (common
 * when a few tool results are tens of KB each).
 */
export function pruneOversizedMessageBodies(
  messages: ChatMessage[],
  opts?: {
    maxToolChars?: number;
    maxAssistantChars?: number;
    maxToolArgChars?: number;
  },
): PruneBodiesResult {
  const maxTool = opts?.maxToolChars ?? 6_000;
  const maxAsst = opts?.maxAssistantChars ?? 12_000;
  const maxArg = opts?.maxToolArgChars ?? 4_000;
  let pruned = 0;

  const out = messages.map((m) => {
    if (m.role === "tool") {
      const c = m.content || "";
      if (c.length > maxTool) {
        pruned += 1;
        let pointer = extractSavedOutputPath(c);
        if (!pointer) {
          try {
            pointer = ensureToolOutputSpool(c);
          } catch {
            pointer = undefined;
          }
        }
        const restore = pointer
          ? `full output: ${pointer} — use read_file on that path`
          : "read_file the saved output path if one was recorded";
        return {
          ...m,
          content:
            c.slice(0, Math.floor(maxTool * 0.7)) +
            `\n\n… [pruned ${c.length - maxTool} chars for context recovery — ${restore}] …\n\n` +
            c.slice(-(Math.floor(maxTool * 0.2))),
        };
      }
      return m;
    }

    if (m.role === "assistant") {
      let next: ChatMessage = m;
      const c = m.content || "";
      if (c.length > maxAsst) {
        pruned += 1;
        next = {
          ...next,
          content:
            c.slice(0, Math.floor(maxAsst * 0.75)) +
            `\n… [pruned assistant text for context recovery]`,
        };
      }
      if (m.tool_calls?.length) {
        let argsPruned = false;
        const tool_calls = m.tool_calls.map((tc) => {
          const args = tc.function.arguments || "";
          if (args.length <= maxArg) return tc;
          argsPruned = true;
          const preview = args.slice(0, Math.max(80, maxArg - 80));
          return {
            ...tc,
            function: {
              ...tc.function,
              // Valid JSON stub — raw truncation often breaks the next API call
              arguments: JSON.stringify({
                _pruned: true,
                _originalChars: args.length,
                _preview: preview,
              }),
            },
          };
        });
        if (argsPruned) {
          pruned += 1;
          next = { ...next, tool_calls };
        }
      }
      return next;
    }

    if (m.role === "user") {
      const c = m.content || "";
      // Leave short harness admits alone; cap only pathological dumps
      if (c.length > maxAsst * 2) {
        pruned += 1;
        return {
          ...m,
          content:
            c.slice(0, maxAsst) +
            `\n… [pruned user message for context recovery]`,
        };
      }
    }

    return m;
  });

  return { messages: pruned > 0 ? out : messages, pruned };
}
