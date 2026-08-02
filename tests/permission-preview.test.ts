import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editToolDiffPreview } from "../src/agent/permission-preview.js";

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
