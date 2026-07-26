import type { ToolResult } from "./types.js";
import {
  getTask,
  killTask,
  listTasks,
  readTaskOutput,
} from "./background-tasks.js";
import { boundToolOutput } from "./truncate.js";

export async function toolGetTaskOutput(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = String(args.task_id || args.id || "").trim();
  if (!id) {
    const all = listTasks();
    if (!all.length) {
      return {
        output:
          "task_id is required. No background tasks in this process yet. Start one with bash { background: true }.",
        isError: true,
      };
    }
    return {
      output:
        "task_id is required. Active tasks:\n" +
        all
          .map(
            (t) =>
              `- ${t.id} [${t.status}] ${t.command.slice(0, 80)}${t.command.length > 80 ? "…" : ""}`,
          )
          .join("\n"),
      isError: true,
    };
  }
  if (!getTask(id)) {
    return { output: `Unknown task_id: ${id}`, isError: true };
  }
  // tail: 0 = full output (not coerced to 200 via Number(x)||default)
  let tail = 200;
  if (args.tail != null && String(args.tail).trim() !== "") {
    const n = Number(args.tail);
    if (Number.isFinite(n) && n >= 0) tail = Math.floor(n);
  }
  const text = await readTaskOutput(id, {
    tail,
    stream: (args.stream as "stdout" | "stderr" | "both") || "both",
  });
  const managed = await boundToolOutput(text, { maxChars: 80_000 });
  return { output: managed.text };
}

export async function toolKillTask(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = String(args.task_id || args.id || "").trim();
  if (!id) {
    // Parity with get_task_output: list active tasks so the agent can pick an id.
    const all = listTasks();
    if (!all.length) {
      return {
        output:
          "task_id is required. No background tasks in this process yet. Start one with bash { background: true }.",
        isError: true,
      };
    }
    return {
      output:
        "task_id is required. Active tasks:\n" +
        all
          .map(
            (t) =>
              `- ${t.id} [${t.status}] ${t.command.slice(0, 80)}${t.command.length > 80 ? "…" : ""}`,
          )
          .join("\n"),
      isError: true,
    };
  }
  const msg = killTask(id);
  if (msg.startsWith("Unknown") || msg.startsWith("Failed")) {
    return { output: msg, isError: true };
  }
  return { output: msg };
}
