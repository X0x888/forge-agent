import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editToolDiffPreview } from "../src/agent/permission-preview.js";
import {
  formatPermissionAskHeader,
  formatPermissionAskPrompt,
  formatPermissionTimeoutLine,
  parsePermissionAskAnswer,
} from "../src/agent/permissions.js";
import { visibleWidth } from "../src/util/format.js";

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-perm-preview-"));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("editToolDiffPreview", () => {
  test("search_replace shows colored +/- diff lines", () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "const x = 1;\nconst y = 2;\n");
    const out = editToolDiffPreview(
      "search_replace",
      { path: "a.ts", old_string: "const x = 1;", new_string: "const x = 42;" },
      ws,
    );
    assert.ok(out);
    assert.match(out, /--- a\/a\.ts/);
    assert.match(out, /\+\+\+ b\/a\.ts/);
    assert.ok(out.includes("-const x = 1;"));
    assert.ok(out.includes("+const x = 42;"));
  });

  test("search_replace returns undefined when old_string misses (fallback to text)", () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "const x = 1;\n");
    const out = editToolDiffPreview(
      "search_replace",
      { path: "a.ts", old_string: "nope", new_string: "yep" },
      ws,
    );
    assert.equal(out, undefined);
  });

  test("search_replace returns undefined for a missing file", () => {
    const out = editToolDiffPreview(
      "search_replace",
      { path: "ghost.ts", old_string: "a", new_string: "b" },
      ws,
    );
    assert.equal(out, undefined);
  });

  test("write_file on a new file previews all-added lines", () => {
    const out = editToolDiffPreview(
      "write_file",
      { path: "fresh.ts", content: "one\ntwo\n" },
      ws,
    );
    assert.ok(out);
    assert.ok(out.includes("+one"));
    assert.ok(out.includes("+two"));
  });

  test("write_file on an existing file previews removed + added lines", () => {
    fs.writeFileSync(path.join(ws, "b.ts", ), "old\nkeep\n");
    const out = editToolDiffPreview(
      "write_file",
      { path: "b.ts", content: "new\nkeep\n" },
      ws,
    );
    assert.ok(out);
    assert.ok(out.includes("-old"));
    assert.ok(out.includes("+new"));
  });

  test("apply_patch previews update hunks in memory", () => {
    fs.writeFileSync(path.join(ws, "c.ts"), "alpha\nbeta\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: c.ts",
      "@@",
      " alpha",
      "-beta",
      "+gamma",
      "*** End Patch",
    ].join("\n");
    const out = editToolDiffPreview("apply_patch", { patchText: patch }, ws);
    assert.ok(out);
    assert.ok(out.includes("-beta"));
    assert.ok(out.includes("+gamma"));
  });

  test("apply_patch returns undefined for an unparseable patch", () => {
    const out = editToolDiffPreview(
      "apply_patch",
      { patchText: "not a patch" },
      ws,
    );
    assert.equal(out, undefined);
  });

  test("non-edit tools return undefined", () => {
    assert.equal(editToolDiffPreview("bash", { command: "ls" }, ws), undefined);
    assert.equal(editToolDiffPreview("read_file", { path: "a.ts" }, ws), undefined);
  });

  test("caps a large write preview so Allow? stays on screen", () => {
    const content = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const out = editToolDiffPreview("write_file", { path: "big.ts", content }, ws);
    assert.ok(out);
    const lines = out.split("\n");
    assert.ok(lines.length <= 14, `preview too tall: ${lines.length} lines`);
    assert.match(out, /more diff lines/);
  });

  test("previews never write to disk", () => {
    const target = path.join(ws, "guard.ts");
    fs.writeFileSync(target, "untouched\n");
    editToolDiffPreview(
      "search_replace",
      { path: "guard.ts", old_string: "untouched", new_string: "changed" },
      ws,
    );
    editToolDiffPreview("write_file", { path: "guard.ts", content: "changed\n" }, ws);
    assert.equal(fs.readFileSync(target, "utf8"), "untouched\n");
  });
});

describe("permission ask UX", () => {
  test("empty Enter / y / yes / unknown = allow once; n/s/a stay explicit", () => {
    assert.equal(parsePermissionAskAnswer(""), "allow_once");
    assert.equal(parsePermissionAskAnswer("   "), "allow_once");
    assert.equal(parsePermissionAskAnswer("y"), "allow_once");
    assert.equal(parsePermissionAskAnswer("YES"), "allow_once");
    assert.equal(parsePermissionAskAnswer("sure"), "allow_once");
    assert.equal(parsePermissionAskAnswer("n"), "deny");
    assert.equal(parsePermissionAskAnswer("no"), "deny");
    assert.equal(parsePermissionAskAnswer("s"), "session");
    assert.equal(parsePermissionAskAnswer("session"), "session");
    assert.equal(parsePermissionAskAnswer("a"), "always");
    assert.equal(parsePermissionAskAnswer("always"), "always");
    assert.equal(parsePermissionAskAnswer("__timeout__"), "timeout");
  });

  test("⚠ header is one line (hint stays on the next)", () => {
    const plain = formatPermissionAskHeader("write_file", false);
    assert.equal(plain, "⚠ write_file\n");
    assert.doesNotMatch(plain, /Permission:/);
    const danger = formatPermissionAskHeader("bash", true, " rm -rf /tmp/x ");
    assert.match(danger, /^⚠ bash \[DANGEROUS\]\n/);
    assert.match(danger, /\n  rm -rf \/tmp\/x\n$/);
    assert.doesNotMatch(danger, /^\n/);
  });

  test("prompt is one scannable line: once / always / session / no", () => {
    const ready = formatPermissionAskPrompt({
      mcpAlwaysReady: true,
      alwaysTool: "write_file",
      alwaysPattern: "src/**",
      timeoutNote: "",
    });
    assert.match(ready, /↵\/y once/);
    assert.match(ready, /a always Write\(src\/\*\*\)/);
    assert.match(ready, /s session/);
    assert.match(ready, /n no/);
    assert.equal(ready.includes("\n"), false);
    const mcp = formatPermissionAskPrompt({
      mcpAlwaysReady: false,
      alwaysTool: "call_mcp",
      alwaysPattern: "*",
      timeoutNote: " (30s)",
    });
    assert.match(mcp, /↵\/y once/);
    assert.match(mcp, /n no/);
    assert.match(mcp, /server__tool/);
    assert.match(mcp, /\(30s\)/);
    assert.equal(mcp.includes("\n"), false);
  });

  test("timeout deny is one line, not a box + tip lecture", () => {
    const line = formatPermissionTimeoutLine(30, "write_file");
    assert.equal(line, "✖ timed out 30s — denied write_file");
    assert.equal(line.includes("\n"), false);
    assert.doesNotMatch(line, /Tip:|FORGE_PERMISSION_TIMEOUT_MS|dontAsk/);
  });

  test("clips Allow? to one TTY row and keeps the caret", () => {
    const orig = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 28,
    });
    try {
      const ready = formatPermissionAskPrompt({
        mcpAlwaysReady: true,
        alwaysTool: "write_file",
        alwaysPattern: "src/very/long/nested/path/**",
        timeoutNote: " (30s)",
      });
      assert.match(ready, /^Allow\?/);
      assert.ok(visibleWidth(ready) <= 28);
    } finally {
      if (orig) Object.defineProperty(process.stdout, "columns", orig);
      else delete (process.stdout as { columns?: number }).columns;
    }
  });
});
