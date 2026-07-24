/**
 * Structured conversation compaction (Grok Build–inspired sections).
 *
 * Preserves load-bearing harness state (ULW mandate/wave, goal, todos) and
 * extracts key user messages / tool activity from dropped turns so long ULW
 * sessions survive auto-compact without losing the mandate.
 */

import type { ChatMessage } from "../providers/types.js";
import type { GoalState } from "../harness/goal.js";
import type { UlwCycleState } from "../harness/ulw-cycle.js";
import type { TodoItem } from "./session.js";
import { formatUlwCounts } from "../harness/ulw-cycle.js";
import {
  alignKeepBoundary,
  repairToolCallPairing,
} from "./message-repair.js";

export interface CompactContext {
  ulw?: UlwCycleState | null;
  goal?: GoalState | null;
  todos?: TodoItem[];
  sessionId?: string;
}

export interface CompactResult {
  messages: ChatMessage[];
  droppedCount: number;
  summary: string;
}

const DEFAULT_KEEP_LAST = 12;

/**
 * Compact history: keep system messages + structured summary + last N non-system.
 */
export function compactMessagesStructured(
  messages: ChatMessage[],
  opts?: {
    keepLast?: number;
    context?: CompactContext;
  },
): CompactResult {
  const keepLast = opts?.keepLast ?? DEFAULT_KEEP_LAST;
  if (messages.length <= keepLast + 2) {
    return { messages, droppedCount: 0, summary: "" };
  }

  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  if (rest.length <= keepLast) {
    return { messages, droppedCount: 0, summary: "" };
  }

  // Never cut inside a tool_call batch — providers reject unpaired tool results
  const { dropped, kept: keptRaw } = alignKeepBoundary(rest, keepLast);
  const summary = buildStructuredSummary(dropped, opts?.context);
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
): string {
  const sections: string[] = [
    `[Conversation compacted — ${dropped.length} earlier messages summarized]`,
    `Continue from the structured summary + recent context below. Do not re-ask for information captured here.`,
  ];

  // 1. Harness / mandate (load-bearing for ULW)
  sections.push(``, `## 1. Harness & mandate`);
  const ulw = ctx?.ulw?.enabled ? ctx.ulw : null;
  if (ulw) {
    sections.push(
      `- ULW ON | ${formatUlwCounts(ulw)} ${ulw.cycle === 1 ? "(CONTINUE)" : "(LAST)"}`,
      `- Mandate: ${ulw.mandate || "(none)"}`,
      ulw.softPrompt ? `- Soft prompt expanded to god-scope` : "",
      `- Expanded mandate (abbrev): ${(ulw.expandedMandate || "").slice(0, 600)}`,
    );
  } else {
    sections.push(`- ULW: off`);
  }

  const goal = ctx?.goal;
  if (goal?.objective && goal.status === "active" && !goal.paused) {
    sections.push(
      `- Goal ACTIVE: ${goal.objective}`,
      goal.criteria.length
        ? `- Criteria: ${goal.criteria.map((c, i) => `${i + 1}. ${c}`).join("; ")}`
        : "",
    );
  } else if (goal?.paused) {
    sections.push(`- Goal: paused (${goal.objective || ""})`);
  } else {
    sections.push(`- Goal: none`);
  }

  // 2. Todos
  sections.push(``, `## 2. Todos`);
  const todos = ctx?.todos ?? [];
  if (todos.length === 0) {
    sections.push(`- (none recorded)`);
  } else {
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

  sections.push(
    ``,
    `## 6. Resume`,
    `- Continue the active mandate/goal without re-scanning from zero unless evidence is stale.`,
    `- Prefer verifying current workspace state over trusting this summary alone.`,
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
        return {
          ...m,
          content:
            c.slice(0, Math.floor(maxTool * 0.7)) +
            `\n\n… [pruned ${c.length - maxTool} chars for context recovery — re-run tool or read full output path if still needed] …\n\n` +
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
