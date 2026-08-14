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

const board: TodoItem[] = [
  { id: "w3", content: "ship it", status: "in_progress" },
  { id: "w4", content: "review", status: "pending" },
  { id: "w1", content: "read the surface", status: "completed" },
  { id: "old", content: "catalog chrome", status: "cancelled" },
];

describe("formatTodoBoard", () => {
  it("empty board is No todos.", () => {
    assert.equal(formatTodoBoard([]), "No todos.");
  });

  it("prints counts + glyphs, not [in_progress] id:", () => {
    const text = formatTodoBoard(board);
    assert.match(text, /^Todos 2\/4 open\n/);
    assert.match(text, /▶ ship it {2}· w3/);
    assert.match(text, /○ review {2}· w4/);
    assert.match(text, /✓ read the surface {2}· w1/);
    assert.match(text, /× catalog chrome {2}· old/);
    assert.doesNotMatch(text, /\[in_progress\]/);
    assert.doesNotMatch(text, /^- \[/m);
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
