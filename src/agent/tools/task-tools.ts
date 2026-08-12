import type { ToolResult } from "./types.js";
import {
  getTask,
  killTask,
  listTasks,
  readTaskOutput,
  waitForTask,
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

  // Optional wait-until-done (or timeout) before reading output — kills
  // poll-loop thrash that serious users hit on long bg test/build jobs.
  const waitRaw = args.wait ?? args.timeout_ms ?? args.timeoutMs;
  let waitNote = "";
  if (waitRaw != null && String(waitRaw).trim() !== "") {
    const waitMs = parseWaitMs(waitRaw);
    if (waitMs == null) {
      return {
        output:
          `get_task_output error: invalid wait/timeout_ms "${waitRaw}". ` +
          `Use a number of ms, or duration suffixes like 30s / 2m / 1h (max 30m).`,
        isError: true,
      };
    }
    if (waitMs > 0) {
      const w = await waitForTask(id, { timeoutMs: waitMs });
      if (!w.ok) {
        return { output: w.error, isError: true };
      }
      waitNote = w.timedOut
        ? `wait: timed out after ${w.waitedMs}ms (still ${w.task.status})\n`
        : `wait: reached ${w.task.status} in ${w.waitedMs}ms\n`;
    }
  }

  const text = await readTaskOutput(id, {
    tail,
    stream,
  });
  const managed = await boundToolOutput(text, { maxChars: 80_000 });
  return { output: waitNote + managed.text };
}

/** Parse wait/timeout_ms: number, numeric string, or 30s/2m/1h suffixes. */
export function parseWaitMs(raw: unknown): number | null {
  if (typeof raw === "boolean") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.min(30 * 60_000, Math.floor(raw)));
  }
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  // bare true-ish → default 2m
  if (s === "true" || s === "yes" || s === "on" || s === "wait") {
    return 120_000;
  }
  if (s === "false" || s === "no" || s === "off") return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2] || "ms";
  let ms = n;
  if (unit === "s") ms = n * 1000;
  else if (unit === "m") ms = n * 60_000;
  else if (unit === "h") ms = n * 3_600_000;
  return Math.max(0, Math.min(30 * 60_000, Math.floor(ms)));
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
