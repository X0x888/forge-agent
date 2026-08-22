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

  it("miss tips show numbered nearby lines, not re-read", () => {
    assert.throws(
      () =>
        applyUpdateChunks("a\nline2\nb\n", "f.txt", [
          { oldLines: ["nope"], newLines: ["x"] },
        ]),
      (err: Error) => {
        assert.match(err.message, /Current nearby lines/);
        assert.doesNotMatch(err.message, /Tip: re-read/);
        return true;
      },
    );
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
    assert.doesNotMatch(result.output, /--- a\//);
    assert.doesNotMatch(result.output, /Tip: re-read/);
    assert.match(result.output, /A nested\/new\.txt \(2 lines\)/);
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

  it("fails closed when move destination already exists", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-patch-"));
    fs.writeFileSync(path.join(tmp, "src.txt"), "from\n");
    fs.writeFileSync(path.join(tmp, "dst.txt"), "keep-me\n");
    const patch = `*** Begin Patch
*** Update File: src.txt
*** Move to: dst.txt
@@
-from
+from
*** End Patch`;
    const result = await toolApplyPatch({ patchText: patch }, { workspace: tmp });
    assert.equal(result.isError, true);
    assert.match(result.output, /move destination already exists/i);
    // Neither file clobbered
    assert.equal(fs.readFileSync(path.join(tmp, "src.txt"), "utf8"), "from\n");
    assert.equal(fs.readFileSync(path.join(tmp, "dst.txt"), "utf8"), "keep-me\n");
  });

  it("fails closed when move destination is created earlier in the same patch", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-patch-batch-"));
    fs.writeFileSync(path.join(tmp, "a.ts"), "export const a = 1;\n");
    const patch = `*** Begin Patch
*** Add File: b.ts
+export const b = 2;
*** Update File: a.ts
*** Move to: b.ts
@@
-export const a = 1;
+export const a = 1;
*** End Patch`;
    const result = await toolApplyPatch({ patchText: patch }, { workspace: tmp });
    assert.equal(result.isError, true);
    assert.match(result.output, /earlier in this patch|already exists/i);
    // Source untouched; dest not half-written from move
    assert.equal(
      fs.readFileSync(path.join(tmp, "a.ts"), "utf8"),
      "export const a = 1;\n",
    );
    assert.equal(fs.existsSync(path.join(tmp, "b.ts")), false);
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

  it("suggests nearby path when update target is a typo", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-patch-hint-"));
    fs.writeFileSync(path.join(tmp, "readme.md"), "hello\n");
    const result = await toolApplyPatch(
      {
        patchText: `*** Begin Patch
*** Update File: readme.mdd
@@
-hello
+hi
*** End Patch`,
      },
      { workspace: tmp },
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /missing/i);
    assert.match(result.output, /readme\.md/i);
  });

  it("refuses add when path is an existing directory", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-patch-addir-"));
    fs.mkdirSync(path.join(tmp, "src"));
    const result = await toolApplyPatch(
      {
        patchText: `*** Begin Patch
*** Add File: src
+nope
*** End Patch`,
      },
      { workspace: tmp },
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /directory/i);
  });

  it("refuses update when path is a directory (no EISDIR)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-patch-updir-"));
    fs.mkdirSync(path.join(tmp, "src"));
    const result = await toolApplyPatch(
      {
        patchText: `*** Begin Patch
*** Update File: src
@@
-a
+b
*** End Patch`,
      },
      { workspace: tmp },
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /directory/i);
    assert.doesNotMatch(result.output, /EISDIR/i);
  });

  it("rolls back earlier ops when a later write fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-patch-rb-"));
    fs.writeFileSync(path.join(tmp, "keep.txt"), "original\n");
    fs.writeFileSync(path.join(tmp, "blocked"), "not-a-dir\n");
    const journals: Array<{ path: string; kind: string }> = [];
    let edits = 0;
    const result = await toolApplyPatch(
      {
        patchText: `*** Begin Patch
*** Update File: keep.txt
@@
-original
+changed
*** Add File: blocked/child.txt
+should-not-land
*** End Patch`,
      },
      {
        workspace: tmp,
        onEdit: () => {
          edits += 1;
        },
        recordMutation: (input) => {
          journals.push({ path: input.path, kind: input.kind });
        },
      },
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /Rolled back — workspace is unchanged/i);
    assert.doesNotMatch(result.output, /NOT rolled back/i);
    assert.equal(fs.readFileSync(path.join(tmp, "keep.txt"), "utf8"), "original\n");
    assert.equal(fs.existsSync(path.join(tmp, "blocked/child.txt")), false);
    assert.equal(fs.readFileSync(path.join(tmp, "blocked"), "utf8"), "not-a-dir\n");
    assert.equal(edits, 0);
    assert.equal(journals.length, 0);
  });

  it("rolls back a delete when a later add cannot write", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-patch-rbdel-"));
    const gone = path.join(tmp, "gone.txt");
    fs.writeFileSync(gone, "restore-me\n");
    let expectMode: number | undefined;
    try {
      fs.chmodSync(gone, 0o640);
      expectMode = 0o640;
    } catch {
      /* sandbox / windows — content restore is the load-bearing check */
    }
    fs.writeFileSync(path.join(tmp, "blocked"), "not-a-dir\n");
    const result = await toolApplyPatch(
      {
        patchText: `*** Begin Patch
*** Delete File: gone.txt
*** Add File: blocked/child.txt
+nope
*** End Patch`,
      },
      { workspace: tmp },
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /Rolled back/i);
    assert.equal(fs.readFileSync(gone, "utf8"), "restore-me\n");
    if (expectMode !== undefined) {
      assert.equal(fs.statSync(gone).mode & 0o777, expectMode);
    }
    assert.equal(fs.existsSync(path.join(tmp, "blocked/child.txt")), false);
  });

  it("rolls back a move when a later add cannot write", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-patch-rbmv-"));
    fs.writeFileSync(path.join(tmp, "src.txt"), "from\n");
    fs.writeFileSync(path.join(tmp, "blocked"), "not-a-dir\n");
    const result = await toolApplyPatch(
      {
        patchText: `*** Begin Patch
*** Update File: src.txt
*** Move to: dest.txt
@@
-from
+moved
*** Add File: blocked/child.txt
+nope
*** End Patch`,
      },
      { workspace: tmp },
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /Rolled back/i);
    assert.equal(fs.readFileSync(path.join(tmp, "src.txt"), "utf8"), "from\n");
    assert.equal(fs.existsSync(path.join(tmp, "dest.txt")), false);
    assert.equal(fs.existsSync(path.join(tmp, "blocked/child.txt")), false);
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
