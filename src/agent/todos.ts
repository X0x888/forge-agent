/**
 * Session todo board updates (todo_write tool).
 */
import type { SessionData, TodoItem } from "../session/session.js";
import { saveSession } from "../session/session.js";
import { editDistance } from "../util/string-distance.js";

export function openTodos(todos: TodoItem[]): number {
  return todos.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  ).length;
}

/**
 * Apply todo_write payload. Returns a human/model-facing summary.
 * Prefix `todo_write error:` marks validation failures (executeTool → isError).
 */
export function applyTodos(
  session: SessionData,
  todos: unknown,
  merge: boolean,
): string {
  if (todos == null) {
    return (
      "todo_write error: todos array is required.\n" +
      'Example: { "todos": [{ "id": "1", "content": "run typecheck", "status": "in_progress" }], "merge": true }\n' +
      "merge:true with [] is a no-op. Empty id/content fail closed. Status: pending|in_progress|completed|cancelled."
    );
  }
  if (!Array.isArray(todos)) {
    return (
      "todo_write error: todos must be an array of { id, content, status } objects.\n" +
      'Example: { "todos": [{ "id": "w1", "content": "…", "status": "pending" }], "merge": true }'
    );
  }
  const allowed = new Set([
    "pending",
    "in_progress",
    "completed",
    "cancelled",
  ]);
  const incoming: TodoItem[] = [];
  for (let i = 0; i < todos.length; i++) {
    const raw = todos[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return `todo_write error: todos[${i}] must be an object with id, content, status.`;
    }
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "string" && o.id != null) {
      const kind = Array.isArray(o.id) ? "array" : typeof o.id;
      return `todo_write error: todos[${i}].id must be a string (got ${kind}).`;
    }
    if (typeof o.content !== "string" && o.content != null) {
      const kind =
        o.content === null
          ? "null"
          : Array.isArray(o.content)
            ? "array"
            : typeof o.content;
      return `todo_write error: todos[${i}].content must be a string (got ${kind}).`;
    }
    if (typeof o.status !== "string" && o.status != null) {
      const kind = Array.isArray(o.status) ? "array" : typeof o.status;
      return `todo_write error: todos[${i}].status must be a string (got ${kind}).`;
    }
    const id = String(o.id ?? "").trim();
    const content = String(o.content ?? "").trim();
    const status = String(o.status ?? "pending").trim() || "pending";
    if (!id) {
      return (
        `todo_write error: todos[${i}].id is required (non-empty string).\n` +
        'Example item: { "id": "w1-research", "content": "inventory gaps", "status": "in_progress" }'
      );
    }
    if (!content) {
      return (
        `todo_write error: todos[${i}].content is required (non-empty string).\n` +
        'Example item: { "id": "w1-research", "content": "inventory gaps", "status": "in_progress" }'
      );
    }
    if (!allowed.has(status)) {
      const candidates = ["pending", "in_progress", "completed", "cancelled"] as const;
      const aliases: Record<string, string> = {
        todo: "pending",
        open: "pending",
        doing: "in_progress",
        progress: "in_progress",
        wip: "in_progress",
        active: "in_progress",
        done: "completed",
        complete: "completed",
        finished: "completed",
        cancel: "cancelled",
        canceled: "cancelled",
        skipped: "cancelled",
      };
      let tip = aliases[status.toLowerCase()] || null;
      if (!tip) {
        let best = Infinity;
        for (const c of candidates) {
          const d = editDistance(status.toLowerCase(), c);
          if (d < best && d <= Math.max(2, Math.floor(c.length / 3))) {
            best = d;
            tip = c;
          }
        }
      }
      return (
        `todo_write error: todos[${i}].status "${status}" is invalid. ` +
        (tip ? `Did you mean: ${tip}? ` : "") +
        `Use pending|in_progress|completed|cancelled.`
      );
    }
    incoming.push({
      id,
      content,
      status: status as TodoItem["status"],
    });
  }
  // merge:false with [] clears the board (explicit). merge:true with [] is a no-op warn.
  if (merge && incoming.length === 0) {
    return (
      `Todos unchanged (${session.todos.length} items, ${openTodos(session.todos)} open) — ` +
      `merge:true with an empty todos array does nothing. Pass items to upsert, or merge:false to replace/clear.`
    );
  }
  if (!merge) {
    session.todos = incoming;
  } else {
    const map = new Map(session.todos.map((t) => [t.id, t]));
    for (const item of incoming) {
      const prev = map.get(item.id);
      map.set(item.id, { ...prev, ...item });
    }
    session.todos = [...map.values()];
  }
  saveSession(session);
  return `Todos updated (${session.todos.length} items, ${openTodos(session.todos)} open):\n${session.todos
    .map((item) => `- [${item.status}] ${item.id}: ${item.content}`)
    .join("\n")}`;
}
