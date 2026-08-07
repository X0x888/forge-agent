/**
 * memory_write — append durable decision/constraint records (session decisions.json).
 */
import type { ToolContext, ToolResult } from "./types.js";
import {
  appendMemoryRecord,
  formatMemoryStatus,
  type MemoryKind,
} from "../../harness/decision-memory.js";

const KINDS = new Set<MemoryKind>([
  "constraint",
  "decision",
  "fact",
  "out_of_scope",
  "priority",
  "blocker",
  "observation",
]);

export async function toolMemoryWrite(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const sessionId = ctx.sessionId;
  if (!sessionId) {
    return {
      output:
        "memory_write error: no session id (cannot persist decisions). Use interactive forge or forge run --session.",
      isError: true,
    };
  }
  const text = String(args.text ?? args.content ?? "").trim();
  if (!text) {
    return {
      output:
        'memory_write error: text is required.\nExample: { "kind": "constraint", "text": "Do not weaken auth tests" }',
      isError: true,
    };
  }
  let kind = String(args.kind ?? "decision").trim().toLowerCase() as MemoryKind;
  if (!KINDS.has(kind)) {
    kind = "decision";
  }
  const rec = appendMemoryRecord(sessionId, {
    kind,
    text,
    source: "agent",
  });
  if (!rec) {
    return {
      output: `No-op: identical active ${kind} already recorded.\n${formatMemoryStatus(sessionId)}`,
    };
  }
  return {
    output: `Recorded ${rec.kind} [${rec.id}]: ${rec.text}\n${formatMemoryStatus(sessionId)}`,
  };
}
