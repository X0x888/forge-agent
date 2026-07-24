/**
 * Repair conversation message lists so providers never see illegal sequences.
 *
 * Common failure modes (learned from OpenCode / production agent loops):
 * 1. Assistant tool_calls without matching tool results (abort mid-batch,
 *    crash, compact cut mid-turn) → API 400 on next request.
 * 2. Orphan tool results with no preceding assistant tool_call.
 * 3. Compaction keeping a partial tool turn at the keep boundary.
 */

import type { ChatMessage, ToolCall } from "../providers/types.js";

export interface MessageRepairResult {
  messages: ChatMessage[];
  /** Number of synthetic tool results injected for orphaned tool_calls */
  filledOrphanToolCalls: number;
  /** Number of orphan tool messages dropped */
  droppedOrphanToolResults: number;
  /** Whether any mutation occurred */
  changed: boolean;
}

const ORPHAN_TOOL_RESULT =
  "[tool interrupted — no result was recorded. Re-run the tool if still needed.]";

/**
 * Ensure every assistant tool_call has a following tool result message, and
 * drop tool results that do not correspond to an open tool_call id.
 * Preserves relative order of valid messages.
 */
export function repairToolCallPairing(messages: ChatMessage[]): MessageRepairResult {
  const out: ChatMessage[] = [];
  let filledOrphanToolCalls = 0;
  let droppedOrphanToolResults = 0;

  /** tool_call_id → still awaiting a tool result */
  let pending = new Map<string, ToolCall>();

  const flushPending = () => {
    if (pending.size === 0) return;
    for (const [id, tc] of pending) {
      out.push({
        role: "tool",
        tool_call_id: id,
        content: `${ORPHAN_TOOL_RESULT} (tool=${tc.function.name || "unknown"})`,
      });
      filledOrphanToolCalls += 1;
    }
    pending = new Map();
  };

  for (const m of messages) {
    if (m.role === "assistant") {
      // New assistant turn closes any previous unfinished tool batch
      flushPending();
      out.push(m);
      if (m.tool_calls?.length) {
        pending = new Map(m.tool_calls.map((tc) => [tc.id, tc]));
      }
      continue;
    }

    if (m.role === "tool") {
      const id = m.tool_call_id || "";
      if (id && pending.has(id)) {
        out.push(m);
        pending.delete(id);
      } else {
        // Orphan tool result — drop (would 400 on Anthropic/OpenAI)
        droppedOrphanToolResults += 1;
      }
      continue;
    }

    // user / system — must not appear between tool_calls and their results
    flushPending();
    out.push(m);
  }

  flushPending();

  const changed =
    filledOrphanToolCalls > 0 ||
    droppedOrphanToolResults > 0 ||
    out.length !== messages.length;

  return {
    messages: changed ? out : messages,
    filledOrphanToolCalls,
    droppedOrphanToolResults,
    changed,
  };
}

/**
 * When compacting, never cut inside a tool-call batch.
 * Expand `kept` backward so the first kept message is not a bare tool result,
 * and if the first kept is mid-batch, include the parent assistant tool_calls.
 */
export function alignKeepBoundary(
  rest: ChatMessage[],
  keepLast: number,
): { dropped: ChatMessage[]; kept: ChatMessage[] } {
  if (rest.length <= keepLast) {
    return { dropped: [], kept: rest };
  }
  let cut = rest.length - keepLast;
  // Walk back so we never start `kept` on a tool result, and always include
  // the parent assistant tool_calls message for any kept tool results.
  while (cut > 0) {
    const at = rest[cut];
    if (at?.role === "tool") {
      cut -= 1;
      continue;
    }
    // If previous message is assistant-with-tools and current is its first tool,
    // the while above already moved onto the assistant when cut landed on tool.
    break;
  }
  // If cut is still on a tool (all prefix was tools — pathological), start at 0
  while (cut < rest.length && rest[cut]?.role === "tool" && cut > 0) {
    cut -= 1;
  }
  return {
    dropped: rest.slice(0, cut),
    kept: rest.slice(cut),
  };
}
