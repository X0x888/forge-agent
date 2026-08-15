import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EDIT_RECEIPT_CLIP_SUFFIX,
  afterWriteText,
  budgetPatchWindows,
  buildSuccessReceipt,
  collapsePatchOps,
  editReceiptEnabled,
  editReceiptMode,
  emittedLineCount,
  formatNumberedLines,
  formatReceiptHeader,
  lineCount,
  lineHunks,
  lineStats,
  numberedWindowBytes,
  selectAfterWindows,
  splitFileLines,
} from "../src/agent/tools/edit-receipt.js";

const MINUS = "\u2212";
const ENDASH = "\u2013";
const ELLIPSIS = "\u2026";

function chromeOf(header: string, body: string, tip = ""): string {
  return `${header}\n${body.includes(ELLIPSIS) ? `${ELLIPSIS} N lines not shown ${ELLIPSIS}\n` : ""}${EDIT_RECEIPT_CLIP_SUFFIX}${tip}`;
}

describe("edit-receipt", () => {
  describe("kill switch", () => {
    const prev = process.env.FORGE_EDIT_RECEIPT;
    after(() => {
      if (prev === undefined) delete process.env.FORGE_EDIT_RECEIPT;
      else process.env.FORGE_EDIT_RECEIPT = prev;
    });
    it("defaults to new", () => {
      delete process.env.FORGE_EDIT_RECEIPT;
      assert.equal(editReceiptMode(), "new");
      assert.equal(editReceiptEnabled(), true);
    });
    it("legacy aliases", () => {
      for (const v of ["legacy", "0", "false", "off", "no", "old"]) {
        process.env.FORGE_EDIT_RECEIPT = v;
        assert.equal(editReceiptMode(), "legacy", v);
      }
    });
  });

  describe("splitFileLines / lineCount", () => {
    it("matches read_file", () => {
      assert.equal(lineCount(""), 0);
      assert.deepEqual(splitFileLines("\n"), ["", ""]);
      assert.equal(lineCount("created\n"), 2);
      assert.equal(lineCount("a\r\nb\r\n"), 3);
    });
  });

  describe("G1 small exact replace", () => {
    const before = "export function f() {\n  const x = 1;\n  return x;\n}\n";
    const after = "export function f() {\n  const x = 2;\n  return x;\n}\n";
    it("hunk + window + header", () => {
      assert.equal(lineCount(after), 5);
      const hunks = lineHunks(before, after);
      const st = lineStats(hunks);
      assert.equal(st.removed, 1);
      assert.equal(st.added, 1);
      const windows = selectAfterWindows(hunks, lineCount(after), {
        afterLines: splitFileLines(after),
      });
      assert.deepEqual(windows, [{ start: 1, end: 5 }]);
      const header = formatReceiptHeader({
        kind: "edit",
        rel: "src/a.ts",
        lines: 5,
        added: 1,
        removed: 1,
        windows,
      });
      assert.equal(
        header,
        `Edited src/a.ts (5 lines) · ${MINUS}1 +1 · lines 1${ENDASH}5 of 5`,
      );
      assert.doesNotMatch(header, /truncated|omitted|saved to/i);
    });
  });

  describe("G2 identical", () => {
    const text = "a\nb\nc\n";
    it("empty hunks and windows", () => {
      const hunks = lineHunks(text, text);
      assert.deepEqual(hunks, []);
      const windows = selectAfterWindows(hunks, lineCount(text), {
        afterLines: splitFileLines(text),
      });
      assert.deepEqual(windows, []);
      const header = formatReceiptHeader({
        kind: "edit",
        rel: "a.ts",
        lines: lineCount(text),
        added: 0,
        removed: 0,
        windows,
      });
      assert.match(header, /\(4 lines\)/);
      assert.doesNotMatch(header, /lines \d/);
    });
  });

  describe("G3 200-line delete", () => {
    const afterArr = Array.from({ length: 880 }, (_, i) => `L${i + 1}`);
    const after = afterArr.join("\n");
    const before = [
      ...afterArr.slice(0, 48),
      ...Array.from({ length: 200 }, (_, i) => `DEL${i}`),
      ...afterArr.slice(48),
    ].join("\n");
    it("hole window is lines 41–56", () => {
      assert.equal(lineCount(after), 880);
      const hunks = lineHunks(before, after);
      const st = lineStats(hunks);
      assert.equal(st.removed, 200);
      assert.equal(st.added, 0);
      const windows = selectAfterWindows(hunks, 880, {
        afterLines: splitFileLines(after),
      });
      assert.deepEqual(windows, [{ start: 41, end: 56 }]);
      assert.equal(windows[0]!.end - windows[0]!.start + 1, 16);
      const header = formatReceiptHeader({
        kind: "edit",
        rel: "src/big.ts",
        lines: 880,
        added: 0,
        removed: 200,
        windows,
      });
      assert.match(header, new RegExp(`lines 41${ENDASH}56 of 880`));
      assert.doesNotMatch(header, /truncated/i);
    });
  });

  describe("G4 200-line insert", () => {
    const afterArr = Array.from({ length: 880 }, (_, i) => `L${i + 1}`);
    const afterBase = afterArr.join("\n");
    const before = afterBase;
    const after = [
      ...afterArr.slice(0, 48),
      ...Array.from({ length: 200 }, (_, i) => `INS${i}`),
      ...afterArr.slice(48),
    ].join("\n");
    it("head+tail around the insert", () => {
      assert.equal(lineCount(after), 1080);
      const hunks = lineHunks(before, after);
      const st = lineStats(hunks);
      assert.equal(st.added, 200);
      assert.equal(st.removed, 0);
      const windows = selectAfterWindows(hunks, 1080, {
        afterLines: splitFileLines(after),
      });
      assert.deepEqual(windows, [
        { start: 41, end: 80 },
        { start: 217, end: 256 },
      ]);
      const body = formatNumberedLines(splitFileLines(after), windows);
      assert.match(body, new RegExp(`${ELLIPSIS} 136 lines not shown ${ELLIPSIS}`));
      const header = formatReceiptHeader({
        kind: "edit",
        rel: "src/big.ts",
        lines: 1080,
        added: 200,
        removed: 0,
        windows,
      });
      assert.match(
        header,
        new RegExp(`lines 41${ENDASH}80, 217${ENDASH}256 of 1080`),
      );
    });
  });

  describe("G5 500-line create", () => {
    const after = Array.from({ length: 500 }, (_, i) => `C${i + 1}`).join("\n");
    it("head+tail of the new file", () => {
      const hunks = lineHunks("", after);
      const st = lineStats(hunks);
      assert.equal(st.added, 500);
      assert.equal(st.removed, 0);
      const windows = selectAfterWindows(hunks, 500, {
        afterLines: splitFileLines(after),
      });
      assert.deepEqual(windows, [
        { start: 1, end: 40 },
        { start: 461, end: 500 },
      ]);
      const body = formatNumberedLines(splitFileLines(after), windows);
      assert.match(body, new RegExp(`${ELLIPSIS} 420 lines not shown ${ELLIPSIS}`));
    });
  });

  describe("G6 50-site replace_all", () => {
    it("keeps first and last sites", () => {
      const afterLines = Array.from({ length: 2000 }, (_, i) => `L${i + 1}`);
      const beforeLines = afterLines.slice();
      const sites: number[] = [];
      for (let n = 21; n <= 2000; n += 40) {
        sites.push(n);
        beforeLines[n - 1] = `OLD${n}`;
      }
      assert.equal(sites.length, 50);
      const before = beforeLines.join("\n");
      const after = afterLines.join("\n");
      const hunks = lineHunks(before, after);
      const st = lineStats(hunks);
      assert.equal(st.added, 50);
      assert.equal(st.removed, 50);
      const windows = selectAfterWindows(hunks, 2000, {
        afterLines: afterLines,
      });
      assert.deepEqual(windows[0], { start: 13, end: 29 });
      assert.equal(windows.length, 2);
      const last = sites[sites.length - 1]!;
      assert.deepEqual(windows[1], { start: last - 8, end: last + 8 });
      const header = formatReceiptHeader({
        kind: "edit",
        rel: "a.ts",
        lines: 2000,
        added: 50,
        removed: 50,
        windows,
        replaceAllCount: 50,
      });
      assert.match(header, /\(50 occurrences\)/);
    });
  });

  describe("G7 byte cap", () => {
    it("shrinks under 4000 bytes", () => {
      const long = "x".repeat(1200);
      const before = [long, long, "old", long].join("\n") + "\n";
      const after = [long, long, "new", long].join("\n") + "\n";
      assert.equal(lineCount(after), 5);
      const hunks = lineHunks(before, after);
      const windows = selectAfterWindows(hunks, 5, {
        afterLines: splitFileLines(after),
      });
      assert.ok(windows.length >= 1);
      assert.ok(numberedWindowBytes(splitFileLines(after), windows) <= 4000);
      const header = formatReceiptHeader({
        kind: "edit",
        rel: "a.ts",
        lines: 5,
        added: 1,
        removed: 1,
        windows,
      });
      const tip = "\nTip: verify with `npm test`";
      const chrome = chromeOf(header, formatNumberedLines(splitFileLines(after), windows), tip);
      assert.doesNotMatch(chrome, /truncated|omitted|saved to/i);
    });
  });

  describe("G8 empty after", () => {
    it("no window", () => {
      const before = "a\nb\nc\n";
      const hunks = lineHunks(before, "");
      const st = lineStats(hunks);
      assert.equal(st.removed, 4);
      const windows = selectAfterWindows(hunks, 0);
      assert.deepEqual(windows, []);
      const header = formatReceiptHeader({
        kind: "write",
        rel: "empty.txt",
        lines: 0,
        added: 0,
        removed: 4,
        windows,
      });
      assert.match(header, /\(0 lines\)/);
      assert.doesNotMatch(header, /lines \d/);
    });
  });

  describe("G9 CRLF", () => {
    it("counts like read_file", () => {
      const after = "a\r\nb\r\n";
      assert.equal(lineCount(after), 3);
      const lines = splitFileLines(after);
      assert.equal(lines[0], "a\r");
      assert.equal(lines[1], "b\r");
      assert.equal(lines[2], "");
    });
  });

  describe("G10 Myers abort", () => {
    it("one hunk from first mismatch", () => {
      const before = Array.from({ length: 12_000 }, (_, i) => `A${i}`).join("\n");
      const after = Array.from({ length: 12_000 }, (_, i) => `B${i}`).join("\n");
      const hunks = lineHunks(before, after);
      assert.equal(hunks.length, 1);
      assert.deepEqual(hunks[0], {
        aStart: 0,
        aEnd: 12_000,
        bStart: 0,
        bEnd: 12_000,
      });
    });
  });

  describe("G11 insert at SOF", () => {
    it("core-vs-expand not window-as-core", () => {
      const tail = Array.from({ length: 8 }, (_, i) => `T${i + 1}`);
      const inserted = Array.from({ length: 200 }, (_, i) => `I${i + 1}`);
      const before = tail.join("\n");
      const after = [...inserted, ...tail].join("\n");
      const hunks = lineHunks(before, after);
      const st = lineStats(hunks);
      assert.equal(st.added, 200);
      assert.equal(st.removed, 0);
      const windows = selectAfterWindows(hunks, lineCount(after), {
        afterLines: splitFileLines(after),
      });
      assert.deepEqual(windows, [
        { start: 1, end: 36 },
        { start: 165, end: 208 },
      ]);
    });
  });

  describe("G12 maxLines=10 on mid insert", () => {
    it("R<0 keeps 10 lines from core start", () => {
      const afterArr = Array.from({ length: 880 }, (_, i) => `L${i + 1}`);
      const before = afterArr.join("\n");
      const after = [
        ...afterArr.slice(0, 48),
        ...Array.from({ length: 200 }, (_, i) => `INS${i}`),
        ...afterArr.slice(48),
      ].join("\n");
      const hunks = lineHunks(before, after);
      const windows = selectAfterWindows(hunks, 1080, {
        maxLines: 10,
        afterLines: splitFileLines(after),
      });
      assert.deepEqual(windows, [{ start: 49, end: 58 }]);
    });
  });

  describe("window clamp", () => {
    it("never emits line numbers past the AFTER file", () => {
      const after = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n");
      const before = after.replace("L10", "OLD");
      const hunks = lineHunks(before, after);
      const windows = selectAfterWindows(hunks, 20, {
        maxLines: 80,
        afterLines: splitFileLines(after),
      });
      for (const w of windows) {
        assert.ok(w.start >= 1);
        assert.ok(w.end <= 20);
      }
      const body = formatNumberedLines(splitFileLines(after), [
        { start: 18, end: 40 },
      ]);
      assert.match(body, /20\|L20/);
      assert.doesNotMatch(body, /21\|/);
    });
  });

  describe("buildSuccessReceipt", () => {
    it("does not embed --- a/", () => {
      const before = "a\n";
      const after = "b\n";
      const r = buildSuccessReceipt({
        header: {
          kind: "edit",
          rel: "a.ts",
          lines: 2,
          added: 1,
          removed: 1,
          windows: [],
        },
        before,
        after,
        relForDiff: "a.ts",
        verifyTip: "\nTip: verify with `npm test`",
      });
      assert.doesNotMatch(r.output, /--- a\//);
      assert.doesNotMatch(r.output, /diff truncated/);
      assert.match(r.output, /Edited a\.ts \(2 lines\)/);
      assert.match(r.diff, /--- a\//);
    });
  });

  describe("patch budget", () => {
    it("starves later updates", () => {
      const big = Array.from({ length: 200 }, (_, i) => `X${i}`).join("\n");
      const ops = [1, 2, 3].map((n) => ({
        kind: "update" as const,
        rel: `f${n}.ts`,
        before: "",
        after: big,
      }));
      const w = budgetPatchWindows(ops);
      assert.ok(emittedLineCount(w[0]!) > 0);
      assert.equal(emittedLineCount(w[1]!), 0);
      assert.equal(emittedLineCount(w[2]!), 0);
    });
    it("collapses add-then-update", () => {
      const collapsed = collapsePatchOps([
        { kind: "add", rel: "a.ts", before: "", after: "one\n" },
        { kind: "update", rel: "a.ts", before: "one\n", after: "two\n" },
      ]);
      assert.equal(collapsed.length, 1);
      assert.equal(collapsed[0]!.kind, "add");
      assert.equal(collapsed[0]!.after, "two\n");
    });
  });

  describe("afterWriteText", () => {
    it("re-reads post-format disk and names the formatter", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-receipt-fmt-"));
      const f = path.join(dir, "a.ts");
      fs.writeFileSync(f, "const x = 2;\n");
      const r = afterWriteText(f, "const x = 1;\n", {
        formatter: "prettier",
        ok: true,
      });
      assert.equal(r.after, "const x = 2;\n");
      assert.equal(r.formatted, "prettier");
      assert.equal(r.formatSkipped, undefined);
    });
    it("does not claim formatted when re-read fails", () => {
      const r = afterWriteText("/no/such/forge-receipt-file.ts", "fallback\n", {
        formatter: "prettier",
        ok: true,
      });
      assert.equal(r.after, "fallback\n");
      assert.equal(r.formatted, undefined);
      assert.match(r.formatSkipped ?? "", /prettier skipped: re-read failed/);
    });
  });

  describe("preimage skipped header", () => {
    it("uses −?", () => {
      const header = formatReceiptHeader({
        kind: "write",
        rel: "huge.log",
        lines: 12,
        added: 12,
        removed: null,
        windows: [{ start: 1, end: 12 }],
        preimageSkipped: true,
      });
      assert.match(header, /\(pre-image skipped\)/);
      assert.match(header, new RegExp(`${MINUS}\\? \\+12`));
    });
  });
});
