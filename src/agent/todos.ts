/**
 * Session todo board updates (todo_write tool).
 */
import chalk from "chalk";
import type { SessionData, TodoItem } from "../session/session.js";
import { saveSession } from "../session/session.js";
import { clipAnsi, visibleWidth } from "../util/format.js";
import { editDistance } from "../util/string-distance.js";

export function openTodos(todos: readonly TodoItem[]): number {
  return todos.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  ).length;
}

/** First in-progress title, else first pending — HUD should not say `todos:N` with no name. */
export function activeTodoTitle(todos: readonly TodoItem[]): string | null {
  const hit =
    todos.find((t) => t.status === "in_progress") ??
    todos.find((t) => t.status === "pending");
  const text = hit?.content?.replace(/\s+/g, " ").trim();
  return text || null;
}

/**
 * Compact HUD chip: `▶ ship` / `▶ ship +1` / `todos:2`.
 * Null when nothing is open.
 */
export function formatHudTodos(
  openCount: number,
  activeTitle?: string | null,
  maxTitle = 18,
): string | null {
  if (openCount <= 0) return null;
  const title = activeTitle?.replace(/\s+/g, " ").trim();
  if (!title) return `todos:${openCount}`;
  const clipped =
    title.length > maxTitle ? `${title.slice(0, Math.max(1, maxTitle - 1))}…` : title;
  return openCount > 1 ? `▶ ${clipped} +${openCount - 1}` : `▶ ${clipped}`;
}

const TODO_GLYPH: Record<TodoItem["status"], string> = {
  in_progress: "▶",
  pending: "○",
  completed: "✓",
  cancelled: "×",
};

/** One scannable line per item (`▶ ship it  · w3`). */
export function formatTodoLines(todos: readonly TodoItem[]): string {
  return todos
    .map((t) => {
      const g = TODO_GLYPH[t.status] ?? "○";
      const id = t.id?.trim();
      return id ? `${g} ${t.content}  · ${id}` : `${g} ${t.content}`;
    })
    .join("\n");
}

const STATUS_ORDER: Record<TodoItem["status"], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
};

/** `/todos` work board: next-up header, grouped glyphs, designed empty/done. */
export function formatTodoBoard(
  todos: readonly TodoItem[],
  opts?: { checkCommand?: string; columns?: number },
): string {
  const cols = Math.max(
    24,
    opts?.columns ??
      (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  const clip = (s: string) =>
    visibleWidth(s) > cols ? clipAnsi(s, cols) : s;

  if (todos.length === 0) {
    const lines = [chalk.dim("Nothing on the board")];
    lines.push(clip(chalk.dim("  ↳ todo_write for multi-step work")));
    if (opts?.checkCommand?.trim()) {
      lines.push(clip(chalk.dim(`  ↳ verify: ${opts.checkCommand.trim()}`)));
    }
    return lines.join("\n");
  }

  const open = openTodos(todos);
  const active = activeTodoTitle(todos);
  const done = todos.filter((t) => t.status === "completed").length;
  const cancelled = todos.filter((t) => t.status === "cancelled").length;
  let header: string;
  if (open === 0) {
    header =
      cancelled === todos.length
        ? `Todos  all cancelled  ·  ${todos.length}`
        : `Todos  all done  ·  ${done}/${todos.length}`;
  } else if (active) {
    header = `Todos  ${open}/${todos.length} open  ·  ▶ ${active}`;
  } else {
    header = `Todos  ${open}/${todos.length} open`;
  }

  const ordered = [...todos].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9),
  );
  const rows = ordered.map((t) => {
    const g = TODO_GLYPH[t.status] ?? "○";
    const line = `${g} ${t.content.replace(/\s+/g, " ").trim()}`;
    if (t.status === "in_progress") return clip(chalk.cyan(line));
    if (t.status === "pending") return clip(line);
    return clip(chalk.dim(line));
  });
  return [clip(header), ...rows].join("\n");
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
  return `Todos updated (${session.todos.length} items, ${openTodos(session.todos)} open):\n${formatTodoLines(session.todos)}`;
}
