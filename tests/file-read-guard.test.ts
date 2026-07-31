/**
 * Session-scoped stale/unread edit protection (OpenCode-inspired).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileReadState } from "../src/agent/tools/file-read-state.js";
import { toolRead } from "../src/agent/tools/read.js";
import { toolEdit } from "../src/agent/tools/edit.js";
import { toolWrite } from "../src/agent/tools/write.js";
import { toolApplyPatch } from "../src/agent/tools/apply-patch.js";
import type { ToolContext } from "../src/agent/tools/types.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forge-frg-"));
}

describe("FileReadState", () => {
  it("blocks mutate when never read", async () => {
    const d = tmpWorkspace();
    const f = path.join(d, "a.ts");
    fs.writeFileSync(f, "const x = 1;\n");
    const state = new FileReadState();
    const msg = await state.checkBeforeMutate(f, { tool: "search_replace", rel: "a.ts" });
    assert.ok(msg);
    assert.match(msg!, /has not been read/);
  });

  it("allows mutate after noteFromDisk and blocks after external change", async () => {
    const d = tmpWorkspace();
    const f = path.join(d, "b.ts");
    fs.writeFileSync(f, "const x = 1;\n");
    const state = new FileReadState();
    assert.equal(await state.noteFromDisk(f), true);
    assert.equal(await state.checkBeforeMutate(f, { tool: "search_replace" }), null);

    // External change (size + mtime).
    await new Promise((r) => setTimeout(r, 15));
    fs.writeFileSync(f, "const x = 2;\n// changed\n");
    const stale = await state.checkBeforeMutate(f, { tool: "search_replace", rel: "b.ts" });
    assert.ok(stale);
    assert.match(stale!, /changed on disk/);
    // Stamp cleared — still blocked until re-read.
    const again = await state.checkBeforeMutate(f, { tool: "search_replace", rel: "b.ts" });
    assert.ok(again);
    assert.match(again!, /has not been read/);
  });
});

describe("tool integration with fileReads", () => {
  let dir: string;
  let fileReads: FileReadState;
  let ctx: ToolContext;
  const prev = process.env.FORGE_FILE_READ_GUARD;

  beforeEach(() => {
    dir = tmpWorkspace();
    fileReads = new FileReadState();
    ctx = { workspace: dir, fileReads };
    process.env.FORGE_FILE_READ_GUARD = "1";
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.FORGE_FILE_READ_GUARD;
    else process.env.FORGE_FILE_READ_GUARD = prev;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("search_replace refuses unread file, succeeds after read_file", async () => {
    fs.writeFileSync(path.join(dir, "x.ts"), "export const a = 1;\n");
    const blocked = await toolEdit(
      { path: "x.ts", old_string: "a = 1", new_string: "a = 2" },
      ctx,
    );
    assert.equal(blocked.isError, true);
    assert.match(blocked.output, /has not been read/);
    assert.match(blocked.output, /Recovery: read_file\(\{ path: "x\.ts" \}\)/);

    const read = await toolRead({ path: "x.ts" }, ctx);
    assert.equal(read.isError, undefined);
    assert.match(read.output, /export const a = 1/);

    const ok = await toolEdit(
      { path: "x.ts", old_string: "a = 1", new_string: "a = 2" },
      ctx,
    );
    assert.equal(ok.isError, undefined);
    assert.match(ok.output, /Edited/);
    assert.equal(fs.readFileSync(path.join(dir, "x.ts"), "utf8"), "export const a = 2;\n");
  });

  it("search_replace refuses stale mtime after external edit", async () => {
    fs.writeFileSync(path.join(dir, "y.ts"), "hello\n");
    await toolRead({ path: "y.ts" }, ctx);
    await new Promise((r) => setTimeout(r, 15));
    fs.writeFileSync(path.join(dir, "y.ts"), "hello\nworld\n");
    const blocked = await toolEdit(
      { path: "y.ts", old_string: "hello", new_string: "hi" },
      ctx,
    );
    assert.equal(blocked.isError, true);
    assert.match(blocked.output, /changed on disk/);
  });

  it("write_file allows create without read; overwrite needs read", async () => {
    const create = await toolWrite(
      { path: "new.md", content: "# hi\n" },
      ctx,
    );
    assert.equal(create.isError, undefined);
    assert.match(create.output, /Wrote/);

    // Overwrite without re-read — blocked (create noted the stamp; clear it).
    fileReads.clear(path.join(dir, "new.md"));
    const blocked = await toolWrite(
      { path: "new.md", content: "# bye\n" },
      ctx,
    );
    assert.equal(blocked.isError, true);
    assert.match(blocked.output, /has not been read/);

    await toolRead({ path: "new.md" }, ctx);
    const ok = await toolWrite(
      { path: "new.md", content: "# bye\n" },
      ctx,
    );
    assert.equal(ok.isError, undefined);
  });

  it("apply_patch update requires prior read", async () => {
    fs.writeFileSync(path.join(dir, "z.ts"), "const n = 1;\n");
    const patch =
      "*** Begin Patch\n*** Update File: z.ts\n@@\n-const n = 1;\n+const n = 2;\n*** End Patch";
    const blocked = await toolApplyPatch({ patchText: patch }, ctx);
    assert.equal(blocked.isError, true);
    assert.match(blocked.output, /has not been read/);

    await toolRead({ path: "z.ts" }, ctx);
    const ok = await toolApplyPatch({ patchText: patch }, ctx);
    assert.equal(ok.isError, undefined);
    assert.match(ok.output, /M z\.ts|Success/);
    assert.equal(fs.readFileSync(path.join(dir, "z.ts"), "utf8"), "const n = 2;\n");
  });

  it("without fileReads on ctx, edits work (unit-test path)", async () => {
    fs.writeFileSync(path.join(dir, "free.ts"), "a\n");
    const bare: ToolContext = { workspace: dir };
    const ok = await toolEdit(
      { path: "free.ts", old_string: "a", new_string: "b" },
      bare,
    );
    assert.equal(ok.isError, undefined);
  });

  it("FORGE_FILE_READ_GUARD=0 disables enforcement", async () => {
    process.env.FORGE_FILE_READ_GUARD = "0";
    fs.writeFileSync(path.join(dir, "off.ts"), "a\n");
    const ok = await toolEdit(
      { path: "off.ts", old_string: "a", new_string: "b" },
      ctx,
    );
    assert.equal(ok.isError, undefined);
  });

  it("chained edits after a successful write do not require re-read", async () => {
    fs.writeFileSync(path.join(dir, "chain.ts"), "one\n");
    await toolRead({ path: "chain.ts" }, ctx);
    const e1 = await toolEdit(
      { path: "chain.ts", old_string: "one", new_string: "two" },
      ctx,
    );
    assert.equal(e1.isError, undefined);
    const e2 = await toolEdit(
      { path: "chain.ts", old_string: "two", new_string: "three" },
      ctx,
    );
    assert.equal(e2.isError, undefined);
    assert.equal(fs.readFileSync(path.join(dir, "chain.ts"), "utf8"), "three\n");
  });
});
