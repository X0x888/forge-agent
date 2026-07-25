import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePatch, applyUpdateChunks } from "../src/agent/tools/patch.js";
import { toolApplyPatch } from "../src/agent/tools/apply-patch.js";
import { executeTool } from "../src/agent/tools/index.js";
import { hardSafetyCheck } from "../src/agent/safety.js";
import { atomicWriteFile } from "../src/agent/tools/atomic-write.js";

describe("parsePatch", () => {
  it("parses add/update/delete", () => {
    const text = `*** Begin Patch
*** Add File: nested/new.txt
+created
*** Delete File: delete.txt
*** Update File: modify.txt
@@
-line2
+changed
*** End Patch`;
    const r = parsePatch(text);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hunks.length, 3);
    assert.equal(r.hunks[0].type, "add");
    assert.equal(r.hunks[1].type, "delete");
    assert.equal(r.hunks[2].type, "update");
  });

  it("rejects empty and missing markers", () => {
    assert.equal(parsePatch("*** Begin Patch\n*** End Patch").ok, false);
    assert.equal(parsePatch("not a patch").ok, false);
  });

  it("applies update chunks with fuzzy match", () => {
    const original = "a\nline2\nb\n";
    const chunks = [
      {
        oldLines: ["line2"],
        newLines: ["changed"],
      },
    ];
    const next = applyUpdateChunks(original, "f.txt", chunks);
    assert.equal(next, "a\nchanged\nb\n");
  });
});

describe("toolApplyPatch", () => {
  it("adds updates deletes and moves", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-patch-"));
    fs.writeFileSync(path.join(tmp, "modify.txt"), "line1\nline2\nline3\n");
    fs.writeFileSync(path.join(tmp, "delete.txt"), "bye\n");
    fs.mkdirSync(path.join(tmp, "old"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "old/name.txt"), "old content\n");

    let edits = 0;
    const patch = `*** Begin Patch
*** Add File: nested/new.txt
+created
*** Delete File: delete.txt
*** Update File: modify.txt
@@
-line2
+changed
*** Update File: old/name.txt
*** Move to: renamed/dir/name.txt
@@
-old content
+new content
*** End Patch`;

    const result = await toolApplyPatch(
      { patchText: patch },
      { workspace: tmp, onEdit: () => {
        edits += 1;
      } },
    );
    assert.equal(result.isError, undefined);
    assert.match(result.output, /Applied patch/);
    assert.equal(
      fs.readFileSync(path.join(tmp, "nested/new.txt"), "utf8"),
      "created\n",
    );
    assert.equal(fs.existsSync(path.join(tmp, "delete.txt")), false);
    assert.equal(
      fs.readFileSync(path.join(tmp, "modify.txt"), "utf8"),
      "line1\nchanged\nline3\n",
    );
    assert.equal(fs.existsSync(path.join(tmp, "old/name.txt")), false);
    assert.equal(
      fs.readFileSync(path.join(tmp, "renamed/dir/name.txt"), "utf8"),
      "new content\n",
    );
    assert.ok(edits >= 3);
  });

  it("fails closed when update target missing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-patch-"));
    const result = await toolApplyPatch(
      {
        patchText: `*** Begin Patch
*** Update File: missing.txt
@@
-nope
+better
*** End Patch`,
      },
      { workspace: tmp },
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /missing/i);
  });

  it("executeTool routes apply_patch", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-patch-"));
    const r = await executeTool(
      "apply_patch",
      JSON.stringify({
        patchText: `*** Begin Patch
*** Add File: a.txt
+hi
*** End Patch`,
      }),
      { workspace: tmp },
    );
    assert.equal(r.isError, undefined);
    assert.equal(fs.readFileSync(path.join(tmp, "a.txt"), "utf8"), "hi\n");
  });
});

describe("hardSafetyCheck apply_patch", () => {
  it("denies patch paths outside workspace / protected", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-patch-safe-"));
    const v = hardSafetyCheck(
      "apply_patch",
      {
        patchText: `*** Begin Patch
*** Add File: /etc/passwd
+x
*** End Patch`,
      },
      tmp,
    );
    assert.equal(v.ok, false);
  });
});

describe("atomicWriteFile", () => {
  it("writes via rename", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-atomic-"));
    const file = path.join(tmp, "out.txt");
    await atomicWriteFile(file, "hello\n");
    assert.equal(fs.readFileSync(file, "utf8"), "hello\n");
    // no leftover tmp
    const leftovers = fs.readdirSync(tmp).filter((n) => n.endsWith(".tmp"));
    assert.equal(leftovers.length, 0);
  });
});
