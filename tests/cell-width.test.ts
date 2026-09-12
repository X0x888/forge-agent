import "./helpers/pin-color.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stringWidth,
  clusterWidth,
  codePointWidth,
  indexFromColumns,
  columnsBefore,
  sliceByColumns,
  graphemes,
} from "../src/util/cell-width.js";
import { visibleWidth, clipAnsi, wrapAnsiLine } from "../src/util/format.js";

describe("cell-width", () => {
  it("ASCII is one column per character", () => {
    assert.equal(stringWidth("hello"), 5);
    assert.equal(stringWidth(""), 0);
    assert.equal(codePointWidth(0x41), 1);
  });

  it("Chinese is two columns per Han", () => {
    assert.equal(stringWidth("你好"), 4);
    assert.equal(stringWidth("hi你好"), 6);
    assert.equal(stringWidth("hello 世界"), 10);
    assert.equal(clusterWidth("你"), 2);
  });

  it("fullwidth forms are width 2", () => {
    assert.equal(stringWidth("全角Ａ"), 6);
  });

  it("SGR does not count", () => {
    assert.equal(visibleWidth("\x1b[31m你好\x1b[0m"), 4);
    assert.equal(visibleWidth("hello world"), 11);
  });

  it("emoji / flags are one cluster of width 2", () => {
    assert.equal(graphemes("👍").length, 1);
    assert.equal(stringWidth("👍"), 2);
    const flag = "🇹🇼";
    assert.equal(stringWidth(flag), 2);
  });

  it("combining mark does not add a column", () => {
    const eAcute = "e\u0301";
    assert.equal(graphemes(eAcute).length, 1);
    assert.equal(stringWidth(eAcute), 1);
  });

  it("indexFromColumns lands on the cluster, including the right half of 你", () => {
    const s = "hi你好";
    assert.equal(indexFromColumns(s, 0), 0);
    assert.equal(indexFromColumns(s, 2), 2); // first 你
    assert.equal(indexFromColumns(s, 3), 2); // right half of 你
    assert.equal(indexFromColumns(s, 4), 3); // 好
    assert.equal(indexFromColumns(s, 99), s.length);
  });

  it("columnsBefore matches stringWidth of the prefix", () => {
    const s = "hi你好";
    assert.equal(columnsBefore(s, 0), 0);
    assert.equal(columnsBefore(s, 2), 2);
    assert.equal(columnsBefore(s, s.length), 6);
  });

  it("sliceByColumns never splits 你", () => {
    assert.equal(sliceByColumns("你".repeat(40), 20), "你".repeat(10));
    assert.equal(stringWidth(sliceByColumns("你".repeat(40), 20)), 20);
    assert.equal(sliceByColumns("你", 1), "");
    assert.equal(sliceByColumns("a你", 2), "a");
    assert.equal(sliceByColumns("a你", 3), "a你");
  });

  it("clipAnsi is column-accurate for CJK and still closes SGR", () => {
    assert.equal(clipAnsi("hello world", 5), "hello");
    const colored = "\x1b[32m" + "你".repeat(20) + "\x1b[0m";
    const clipped = clipAnsi(colored, 10);
    assert.ok(visibleWidth(clipped) <= 10);
    assert.ok(clipped.endsWith("\x1b[0m"));
    assert.equal(clipAnsi("你".repeat(40), 20), "你".repeat(10));
  });

  it("wrapAnsiLine hard-breaks Chinese (no spaces) on columns", () => {
    const lines = wrapAnsiLine("你".repeat(30), 20);
    assert.ok(lines.length >= 3);
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= 20,
        `${visibleWidth(line)} > 20: ${line}`,
      );
    }
    assert.equal(lines.join(""), "你".repeat(30));
  });

  it("wrapAnsiLine still breaks ASCII on words", () => {
    const words = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" ");
    const lines = wrapAnsiLine(words, 24);
    assert.ok(lines.length > 1);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 24);
    }
  });
});
