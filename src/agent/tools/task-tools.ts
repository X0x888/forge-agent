import type { ToolResult } from "./types.js";
import {
  getTask,
  killTask,
  listTasks,
  readTaskOutput,
} from "./background-tasks.js";
import { boundToolOutput } from "./truncate.js";
import { editDistance } from "../../util/string-distance.js";

function formatTaskListLine(t: {
  id: string;
  status: string;
  command: string;
}): string {
  return `- ${t.id} [${t.status}] ${t.command.slice(0, 80)}${t.command.length > 80 ? "…" : ""}`;
}

/** Unknown task_id guidance: list actives + prefix/typo suggestions. */
export function unknownTaskMessage(id: string): string {
  const all = listTasks();
  const parts = [`Unknown task_id: ${id}`];
  if (!all.length) {
    parts.push(
      "No background tasks in this process. Start one with bash { background: true }.",
    );
    return parts.join("\n");
  }
  const q = id.toLowerCase();
  const suggested = all
    .map((t) => {
      const tid = t.id.toLowerCase();
      let score = 0;
      if (tid === q) score = 100;
      else if (tid.startsWith(q) || q.startsWith(tid)) score = 80;
      else if (tid.includes(q) || q.includes(tid)) score = 60;
      else {
        const d = editDistance(q, tid);
        if (d <= 3) score = 40 - d;
      }
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.t);
  if (suggested.length) {
    parts.push("Did you mean one of these?");
    for (const t of suggested) parts.push(formatTaskListLine(t));
  }
  parts.push("Active tasks:");
  for (const t of all.slice(0, 12)) parts.push(formatTaskListLine(t));
  if (all.length > 12) parts.push(`… +${all.length - 12} more`);
  return parts.join("\n");
}

export async function toolGetTaskOutput(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  {
    const rawId = args.task_id ?? args.id;
    if (rawId != null && typeof rawId !== "string") {
      const kind =
        rawId === null
          ? "null"
          : Array.isArray(rawId)
            ? "array"
            : typeof rawId;
      return {
        output: `get_task_output error: task_id must be a string (got ${kind}).`,
        isError: true,
      };
    }
  }
  // Validate tail/stream before task_id so bad args are not masked by "task_id is required".
  // tail: 0 = full output (not coerced to 200 via Number(x)||default)
  let tail = 200;
  if (args.tail != null && String(args.tail).trim() !== "") {
    const key = String(args.tail).trim().toLowerCase();
    // Parity with logs -n / grep head_limit: all|max|full → full output (0).
    if (key === "all" || key === "max" || key === "full" || key === "unlimited") {
      tail = 0;
    } else if (!/^\d+$/.test(key)) {
      let tip: string | null = null;
      let best = Infinity;
      for (const c of ["0", "all", "max", "full", "200", "50", "100"]) {
        const d = editDistance(key, c);
        if (d < best && d <= Math.max(2, Math.floor(c.length / 2))) {
          best = d;
          tip = c;
        }
      }
      return {
        output:
          `get_task_output error: invalid tail "${args.tail}". ` +
          (tip ? `Did you mean: ${tip}? ` : "") +
          `Pass a non-negative integer or all|max|full (0/all = full output, default 200).`,
        isError: true,
      };
    } else {
      const n = Number(key);
      if (!Number.isFinite(n) || n < 0) {
        return {
          output:
            `get_task_output error: invalid tail "${args.tail}". ` +
            `Pass a non-negative integer or all|max|full (0/all = full output, default 200).`,
          isError: true,
        };
      }
      tail = Math.floor(n);
    }
  }
  let stream: "stdout" | "stderr" | "both" = "both";
  if (args.stream != null && String(args.stream).trim() !== "") {
    if (typeof args.stream !== "string") {
      const kind =
        args.stream === null
          ? "null"
          : Array.isArray(args.stream)
            ? "array"
            : typeof args.stream;
      return {
        output:
          `get_task_output error: stream must be a string (got ${kind}). ` +
          `Use stdout | stderr | both.`,
        isError: true,
      };
    }
    const s = args.stream.trim().toLowerCase();
    if (s !== "stdout" && s !== "stderr" && s !== "both") {
      const candidates = ["stdout", "stderr", "both"] as const;
      let tip: string | null = null;
      let best = Infinity;
      for (const c of candidates) {
        const d = editDistance(s, c);
        if (d < best && d <= Math.max(2, Math.floor(c.length / 2))) {
          best = d;
          tip = c;
        }
      }
      // common aliases
      if (!tip) {
        if (s === "out" || s === "std" || s === "standard") tip = "stdout";
        else if (s === "err" || s === "error") tip = "stderr";
        else if (s === "all" || s === "full" || s === "*") tip = "both";
      }
      return {
        output:
          `get_task_output error: invalid stream "${args.stream}". ` +
          (tip ? `Did you mean: ${tip}? ` : "") +
          `Use stdout | stderr | both.`,
        isError: true,
      };
    }
    stream = s;
  }

  const id = String(args.task_id || args.id || "").trim();
  if (!id) {
    const all = listTasks();
    if (!all.length) {
      return {
        output:
          "task_id is required. No background tasks in this process yet.\n" +
          'Start one with bash { "command": "npm test", "background": true } then get_task_output({ "task_id": "…" }).\n' +
          "Omit task_id to list actives when any exist.",
        isError: true,
      };
    }
    return {
      output:
        "task_id is required. Active tasks:\n" +
        all.map(formatTaskListLine).join("\n"),
      isError: true,
    };
  }
  if (!getTask(id)) {
    return { output: unknownTaskMessage(id), isError: true };
  }
  const text = await readTaskOutput(id, {
    tail,
    stream,
  });
  const managed = await boundToolOutput(text, { maxChars: 80_000 });
  return { output: managed.text };
}

export async function toolKillTask(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  {
    const rawId = args.task_id ?? args.id;
    if (rawId != null && typeof rawId !== "string") {
      const kind =
        rawId === null
          ? "null"
          : Array.isArray(rawId)
            ? "array"
            : typeof rawId;
      return {
        output: `kill_task error: task_id must be a string (got ${kind}).`,
        isError: true,
      };
    }
  }
  const id = String(args.task_id || args.id || "").trim();
  if (!id) {
    // Parity with get_task_output: list active tasks so the agent can pick an id.
    const all = listTasks();
    if (!all.length) {
      return {
        output:
          "task_id is required. No background tasks in this process yet.\n" +
          'Start one with bash { "command": "npm test", "background": true } then get_task_output({ "task_id": "…" }).\n' +
          "Omit task_id to list actives when any exist.",
        isError: true,
      };
    }
    return {
      output:
        "task_id is required. Active tasks:\n" +
        all.map(formatTaskListLine).join("\n"),
      isError: true,
    };
  }
  if (!getTask(id)) {
    return { output: unknownTaskMessage(id), isError: true };
  }
  const msg = killTask(id);
  if (
    msg.startsWith("Unknown") ||
    msg.startsWith("Failed") ||
    msg.includes(" is already ")
  ) {
    return { output: msg, isError: true };
  }
  return { output: msg };
}
