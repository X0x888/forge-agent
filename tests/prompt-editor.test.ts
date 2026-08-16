import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeHistoryEntry,
  decodeHistoryEntry,
  insertText,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  moveWord,
  csiIsWordMotion,
  findHistoryMatch,
  startHistorySearch,
  stepHistorySearch,
  formatHistorySearchPrompt,
  historySearchCursor,
  normalizePaste,
  countLines,
  cursorRowCol,
  stripAnsi,
  layoutEditor,
  softWrapRows,
  displayWidth,
  resolveCtrlC,
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

describe("prompt-editor layout (cursor math)", () => {
  it("softWrapRows divides by terminal width", () => {
    assert.equal(softWrapRows(0, 80), 1);
    assert.equal(softWrapRows(80, 80), 1);
    assert.equal(softWrapRows(81, 80), 2);
    assert.equal(softWrapRows(160, 80), 2);
    assert.equal(softWrapRows(161, 80), 3);
  });

  it("single-line cursor stays on view row 0 when short", () => {
    const prompt = "forge › ";
    const buf = "hello";
    // cursor at end
    const end = layoutEditor({
      buffer: buf,
      cursor: buf.length,
      promptPlain: prompt,
      cols: 80,
      showFooter: false,
    });
    assert.equal(end.cursorViewRow, 0);
    assert.equal(end.cursorViewCol, displayWidth(prompt) + buf.length);
    assert.equal(end.totalViewRows, 1);

    // cursor moved left
    const mid = layoutEditor({
      buffer: buf,
      cursor: 2,
      promptPlain: prompt,
      cols: 80,
      showFooter: false,
    });
    assert.equal(mid.cursorViewRow, 0);
    assert.equal(mid.cursorViewCol, displayWidth(prompt) + 2);
  });

  it("multi-line cursor row tracks logical lines", () => {
    const prompt = "forge › ";
    const buf = "one\ntwo\nthree";
    // cursor on 'w' of two (index: one\n = 4, +1 = 5 for 'w'? "one\ntwo" cursor at 5 is 'w')
    // o n e \n t w o  → indices 0 1 2 3 4 5 6
    const lay = layoutEditor({
      buffer: buf,
      cursor: 5,
      promptPlain: prompt,
      cols: 80,
      showFooter: true,
    });
    assert.equal(lay.cursorViewRow, 1);
    assert.equal(lay.totalViewRows, 4); // 3 content + footer
  });

  it("long single line soft-wraps cursor view row", () => {
    const prompt = ">>"; // width 2
    const buf = "x".repeat(20);
    const lay = layoutEditor({
      buffer: buf,
      cursor: 15, // abs col = 2+15 = 17
      promptPlain: prompt,
      cols: 10,
      showFooter: false,
    });
    // abs 17 → wrap row floor(17/10)=1, col 7
    assert.equal(lay.cursorViewRow, 1);
    assert.equal(lay.cursorViewCol, 7);
    assert.equal(lay.totalViewRows, 3); // 22 width / 10 = 3 rows
  });
});

describe("resolveCtrlC", () => {
  it("idle: draft clears, empty line interrupts", () => {
    assert.equal(resolveCtrlC("half typed", false), "clear");
    assert.equal(resolveCtrlC("", false), "sigint");
  });

  it("mid-run: always interrupts, even with a draft", () => {
    assert.equal(resolveCtrlC("/cyc", true), "sigint");
    assert.equal(resolveCtrlC("queue this", true), "sigint");
    assert.equal(resolveCtrlC("", true), "sigint");
  });
});

describe("history incremental search", () => {
  const hist = [
    "/status",
    "fix the permission prompt",
    "/retry",
    "fix the dock hop",
    "ship Ctrl+R search",
  ];

  it("findHistoryMatch is newest-first and case-insensitive", () => {
    assert.equal(findHistoryMatch(hist, "FIX"), 3);
    assert.equal(findHistoryMatch(hist, "fix", { fromIndex: 3, exclusive: true }), 1);
    assert.equal(findHistoryMatch(hist, "nope"), -1);
    assert.equal(findHistoryMatch([], "x"), -1);
    assert.equal(findHistoryMatch(hist, "", { dir: 1 }), 0);
  });

  it("start + type keeps a still-matching hit, then steps older", () => {
    let s = startHistorySearch(hist, -1);
    assert.equal(s.matchIndex, hist.length - 1);
    assert.equal(s.failed, false);
    s = stepHistorySearch(hist, s, { type: "type", text: "s" });
    assert.equal(hist[s.matchIndex], "ship Ctrl+R search");
    s = stepHistorySearch(hist, s, { type: "type", text: "ea" });
    assert.equal(hist[s.matchIndex], "ship Ctrl+R search");
    s = stepHistorySearch(hist, startHistorySearch(hist, -1), {
      type: "type",
      text: "fix",
    });
    assert.equal(hist[s.matchIndex], "fix the dock hop");
    assert.equal(s.failed, false);
    const older = stepHistorySearch(hist, s, { type: "again" });
    assert.equal(hist[older.matchIndex], "fix the permission prompt");
    const fail = stepHistorySearch(hist, older, { type: "again" });
    assert.equal(fail.failed, true);
    assert.equal(fail.matchIndex, older.matchIndex);
  });

  it("backspace restores a broader match; flip walks forward", () => {
    let s = startHistorySearch(hist, -1);
    s = stepHistorySearch(hist, s, { type: "type", text: "retry" });
    assert.equal(hist[s.matchIndex], "/retry");
    s = stepHistorySearch(hist, s, { type: "backspace" });
    assert.equal(s.query, "retr");
    assert.equal(hist[s.matchIndex], "/retry");
    s = stepHistorySearch(hist, s, { type: "flip", dir: 1 });
    assert.equal(s.dir, 1);
    // no newer /retry — stay failed on the same hit
    assert.equal(s.failed, true);
    assert.equal(hist[s.matchIndex], "/retry");
  });

  it("formatHistorySearchPrompt + cursor mark the query", () => {
    const s = stepHistorySearch(
      hist,
      startHistorySearch(hist),
      { type: "type", text: "dock" },
    );
    assert.equal(
      formatHistorySearchPrompt(s),
      "(bck-i-search)`dock': ",
    );
    assert.equal(
      formatHistorySearchPrompt({ ...s, failed: true }),
      "(failed bck-i-search)`dock': ",
    );
    assert.equal(
      historySearchCursor("fix the dock hop", "dock"),
      "fix the ".length + "dock".length,
    );
    assert.equal(historySearchCursor("abc", ""), 3);
  });
});

describe("word motion", () => {
  it("moveWord skips whitespace both ways", () => {
    assert.equal(moveWord("foo  bar baz", 12, -1), 9);
    assert.equal(moveWord("foo  bar baz", 8, -1), 5);
    assert.equal(moveWord("foo  bar baz", 0, 1), 5);
    assert.equal(moveWord("foo  bar baz", 5, 1), 9);
    assert.equal(moveWord("", 0, -1), 0);
  });

  it("csiIsWordMotion reads ctrl/alt modifiers", () => {
    assert.equal(csiIsWordMotion("1;5", "C"), 1);
    assert.equal(csiIsWordMotion("1;3", "D"), -1);
    assert.equal(csiIsWordMotion("5", "C"), 1);
    assert.equal(csiIsWordMotion("", "C"), 0);
    assert.equal(csiIsWordMotion("1;5", "A"), 0);
  });
});
