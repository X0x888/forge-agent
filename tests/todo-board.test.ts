import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeTodoTitle,
  formatHudTodos,
  formatTodoBoard,
  formatTodoLines,
  openTodos,
} from "../src/agent/todos.js";
import type { TodoItem } from "../src/session/session.js";
import { visibleWidth } from "../src/util/format.js";

const board: TodoItem[] = [
  { id: "w3", content: "ship it", status: "in_progress" },
  { id: "w4", content: "review", status: "pending" },
  { id: "w1", content: "read the surface", status: "completed" },
  { id: "old", content: "catalog chrome", status: "cancelled" },
];

describe("formatTodoBoard", () => {
  it("empty board is a designed empty state", () => {
    const text = formatTodoBoard([]);
    assert.match(text, /Nothing on the board/);
    assert.match(text, /todo_write/);
    assert.doesNotMatch(text, /verify:/);
    const withCheck = formatTodoBoard([], { checkCommand: "npm test" });
    assert.match(withCheck, /verify: npm test/);
  });

  it("prints next-up header + glyphs, not [in_progress] ids", () => {
    const text = formatTodoBoard(board);
    assert.match(text, /Todos {2}2\/4 open {2}· {2}▶ ship it/);
    const lines = text.split("\n");
    assert.match(lines[1] ?? "", /▶ ship it/);
    assert.match(lines[2] ?? "", /○ review/);
    assert.match(text, /✓ read the surface/);
    assert.match(text, /× catalog chrome/);
    assert.doesNotMatch(text, /\[in_progress\]/);
    assert.doesNotMatch(text, /· w3/);
    assert.doesNotMatch(text, /^- \[/m);
  });

  it("all-done board is a designed complete state", () => {
    const text = formatTodoBoard([
      { id: "a", content: "shipped", status: "completed" },
      { id: "b", content: "also", status: "completed" },
    ]);
    assert.match(text, /Todos {2}all done {2}· {2}2\/2/);
    assert.match(text, /✓ shipped/);
  });

  it("clips each row to the TTY width", () => {
    const text = formatTodoBoard(
      [{ id: "long", content: "x".repeat(80), status: "pending" }],
      { columns: 40 },
    );
    for (const row of text.split("\n")) {
      assert.ok(visibleWidth(row) <= 40, row);
    }
  });
});

describe("formatTodoLines", () => {
  it("omits empty id", () => {
    assert.equal(
      formatTodoLines([{ id: "  ", content: "lone", status: "pending" }]),
      "○ lone",
    );
  });
});

describe("openTodos", () => {
  it("counts pending + in_progress", () => {
    assert.equal(openTodos(board), 2);
  });
});

describe("formatHudTodos", () => {
  it("is null when nothing is open", () => {
    assert.equal(formatHudTodos(0), null);
  });

  it("shows todos:N only when no title is supplied", () => {
    assert.equal(formatHudTodos(2), "todos:2");
  });

  it("shows ▶ title and remaining count", () => {
    assert.equal(formatHudTodos(2, "ship it"), "▶ ship it +1");
    assert.equal(formatHudTodos(1, "ship it"), "▶ ship it");
  });

  it("clips long titles", () => {
    assert.equal(formatHudTodos(1, "abcdefghijklmnopqrstuvwxyz", 8), "▶ abcdefg…");
  });
});

describe("activeTodoTitle", () => {
  it("returns in-progress, else first pending", () => {
    assert.equal(activeTodoTitle(board), "ship it");
    assert.equal(
      activeTodoTitle(board.filter((t) => t.status !== "in_progress")),
      "review",
    );
    assert.equal(
      activeTodoTitle(board.filter((t) => t.status === "completed")),
      null,
    );
  });
});
