import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeHistoryEntry,
  decodeHistoryEntry,
  insertText,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  normalizePaste,
  countLines,
  cursorRowCol,
  stripAnsi,
} from "../src/tui/prompt-editor.js";

describe("prompt-editor pure ops", () => {
  it("insertText at cursor", () => {
    assert.deepEqual(insertText("ab", 1, "X"), { buffer: "aXb", cursor: 2 });
    assert.deepEqual(insertText("", 0, "hi\nthere"), {
      buffer: "hi\nthere",
      cursor: 8,
    });
  });

  it("deleteBackward / deleteForward", () => {
    assert.deepEqual(deleteBackward("abc", 2), { buffer: "ac", cursor: 1 });
    assert.deepEqual(deleteBackward("abc", 0), { buffer: "abc", cursor: 0 });
    assert.deepEqual(deleteForward("abc", 1), { buffer: "ac", cursor: 1 });
    assert.deepEqual(deleteForward("abc", 3), { buffer: "abc", cursor: 3 });
  });

  it("deleteWordBackward", () => {
    assert.deepEqual(deleteWordBackward("foo bar", 7), {
      buffer: "foo ",
      cursor: 4,
    });
    // cursor on 'b' of bar → skip spaces left of cursor, delete "foo"
    assert.deepEqual(deleteWordBackward("foo  bar", 5), {
      buffer: "bar",
      cursor: 0,
    });
  });

  it("normalizePaste strips single trailing newline only", () => {
    assert.equal(normalizePaste("a\nb\n"), "a\nb");
    assert.equal(normalizePaste("a\nb\n\n"), "a\nb\n\n");
    assert.equal(normalizePaste("a\r\nb\r\n"), "a\nb");
    assert.equal(normalizePaste("single"), "single");
  });

  it("countLines / cursorRowCol", () => {
    assert.equal(countLines(""), 1);
    assert.equal(countLines("a\nb\nc"), 3);
    assert.deepEqual(cursorRowCol("a\nbc", 0), { row: 0, col: 0 });
    assert.deepEqual(cursorRowCol("a\nbc", 2), { row: 1, col: 0 });
    assert.deepEqual(cursorRowCol("a\nbc", 4), { row: 1, col: 2 });
  });

  it("history encode/decode round-trips multi-line", () => {
    const raw = "line1\nline2\npath\\to";
    const enc = encodeHistoryEntry(raw);
    assert.equal(enc.includes("\n"), false);
    assert.equal(decodeHistoryEntry(enc), raw);
    // plain historic entries unchanged
    assert.equal(decodeHistoryEntry("just a line"), "just a line");
  });

  it("stripAnsi removes color codes", () => {
    assert.equal(stripAnsi("\x1b[32mforge\x1b[0m › "), "forge › ");
  });
});

describe("prompt-editor paste contract", () => {
  it("normalizePaste never invents submit — multi-line stays multi-line", () => {
    const body = "Implement StatusHub\n\n1. Write tests\n2. Ship it";
    const n = normalizePaste(body + "\n");
    assert.equal(n, body);
    assert.ok(n.includes("\n"));
    assert.equal(countLines(n), 4);
    assert.ok(n.includes("Ship it"));
  });
});
