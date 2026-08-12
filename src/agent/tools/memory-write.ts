/**
 * memory_write — append durable decision/constraint records.
 *
 * scope=session (default): session decisions.json (survives compact, dies with session)
 * scope=project: cross-session project memory (~/.forge/project-memory + .forge/MEMORY.md)
 */
import type { ToolContext, ToolResult } from "./types.js";
import {
  appendMemoryRecord,
  formatMemoryStatus,
  type MemoryKind,
} from "../../harness/decision-memory.js";
import {
  appendProjectMemory,
  formatProjectMemoryStatus,
  normalizeProjectMemoryKind,
} from "../../harness/project-memory.js";

const SESSION_KINDS = new Set<MemoryKind>([
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
  const text = String(args.text ?? args.content ?? "").trim();
  if (!text) {
    return {
      output:
        "memory_write error: text is required.\n" +
        'Example: { "kind": "constraint", "text": "Do not weaken auth tests" }\n' +
        'Project-durable: { "scope": "project", "kind": "gotcha", "text": "tests need TMPDIR=$PWD/.tmp" }',
      isError: true,
    };
  }

  const scopeRaw = String(args.scope ?? args.target ?? "session")
    .trim()
    .toLowerCase();
  const scope =
    scopeRaw === "project" ||
    scopeRaw === "repo" ||
    scopeRaw === "workspace" ||
    scopeRaw === "global-project"
      ? "project"
      : "session";

  if (scope === "project") {
    const kind = normalizeProjectMemoryKind(args.kind ?? "fact");
    const rec = appendProjectMemory(ctx.workspace || process.cwd(), {
      text,
      kind,
      source: "agent",
    });
    const status = formatProjectMemoryStatus(ctx.workspace || process.cwd());
    if (!rec) {
      return {
        output: `No-op: identical active project ${kind} already recorded.\n${status}`,
      };
    }
    return {
      output: `Recorded project ${rec.kind} [${rec.id}]: ${rec.text}\n${status}`,
    };
  }

  const sessionId = ctx.sessionId;
  if (!sessionId) {
    return {
      output:
        "memory_write error: no session id for scope=session. " +
        "Use scope=project for cross-session memory, or run with a session id.",
      isError: true,
    };
  }
  let kind = String(args.kind ?? "decision").trim().toLowerCase() as MemoryKind;
  if (!SESSION_KINDS.has(kind)) {
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
