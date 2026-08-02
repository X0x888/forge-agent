import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractDiffFromToolOutput,
  formatDiffBlock,
  formatToolOutputHead,
  visibleWidth,
} from "../src/util/format.js";

describe("extractDiffFromToolOutput", () => {
  test("extracts the diff after the Edited header and strips the verify tip", () => {
    const out =
      "Edited src/a.ts\n\n--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\nTip: verify with `npm test`";
    assert.equal(
      extractDiffFromToolOutput("search_replace", out),
      "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new",
    );
  });

  test("works for write_file and apply_patch (and aliases)", () => {
    const diff = "--- a/x\n+++ b/x\n+line";
    assert.equal(
      extractDiffFromToolOutput("write_file", `Wrote x\n\n${diff}`),
      diff,
    );
    assert.equal(
      extractDiffFromToolOutput("apply_patch", `Applied patch (1 op(s)):\nA x\n\n${diff}`),
      diff,
    );
    assert.equal(extractDiffFromToolOutput("Edit", `Edited x\n\n${diff}`), diff);
  });

  test("ignores non-edit tools even when output looks like a diff", () => {
    const out = "git output\n\n--- a/x\n+++ b/x\n-old\n+new";
    assert.equal(extractDiffFromToolOutput("bash", out), undefined);
    assert.equal(extractDiffFromToolOutput("read_file", out), undefined);
  });

  test("undefined when the output carries no diff block", () => {
    assert.equal(extractDiffFromToolOutput("search_replace", "Edited x"), undefined);
    assert.equal(
      extractDiffFromToolOutput("search_replace", "old_string not found\nFile: x"),
      undefined,
    );
  });
});

describe("formatDiffBlock", () => {
  test("indents every line and keeps +/- content", () => {
    const block = formatDiffBlock("--- a/x\n+++ b/x\n-old\n+new\n ctx");
    const lines = block.split("\n");
    assert.equal(lines.length, 5);
    for (const l of lines) assert.ok(l.startsWith("    "), `no indent: ${l}`);
    assert.ok(block.includes("-old"));
    assert.ok(block.includes("+new"));
  });

  test("caps at maxLines with a truncation note", () => {
    const diff = Array.from({ length: 80 }, (_, i) => `+line${i}`).join("\n");
    const block = formatDiffBlock(diff, { maxLines: 10 });
    assert.ok(block.includes("… (70 more diff lines)"));
  });
});

describe("formatToolOutputHead", () => {
  test("head mode shows first 5 lines and counts the rest", () => {
    const out = Array.from({ length: 9 }, (_, i) => `line${i}`).join("\n");
    const head = formatToolOutputHead(out);
    const lines = head.split("\n");
    assert.equal(lines.length, 6);
    assert.ok(lines[0]!.includes("line0"));
    assert.ok(lines[4]!.includes("line4"));
    assert.ok(!lines.some((l) => l.includes("line5")));
    assert.ok(head.includes("… (4 more lines · /verbose to show all)"));
  });

  test("verbose mode shows every line", () => {
    const out = Array.from({ length: 9 }, (_, i) => `line${i}`).join("\n");
    const head = formatToolOutputHead(out, { verbose: true });
    assert.equal(head.split("\n").length, 9);
    assert.ok(head.includes("line8"));
  });

  test("clips overlong lines in head mode", () => {
    const head = formatToolOutputHead("x".repeat(500));
    assert.ok(visibleWidth(head) <= 4 + 160 + 1);
  });

  test("empty / whitespace-only output renders nothing", () => {
    assert.equal(formatToolOutputHead(""), "");
    assert.equal(formatToolOutputHead("   \n  "), "");
  });
});
