/**
 * Session-scoped stale/unread edit protection (OpenCode-inspired).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileReadState,
  fileReadsForSession,
  clearFileReadsForSession,
  forgetFileReadsSession,
} from "../src/agent/tools/file-read-state.js";
import { compactMessages } from "../src/session/session.js";
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

  it("refreshNotedFromDisk restamps without inventing a read", async () => {
    const d = tmpWorkspace();
    const f = path.join(d, "c.ts");
    fs.writeFileSync(f, "const x = 1;\n");
    const state = new FileReadState();
    await state.refreshNotedFromDisk(f);
    assert.equal(state.get(f), undefined, "must not invent a stamp");
    assert.equal(await state.noteFromDisk(f), true);
    const first = state.get(f)!;
    await new Promise((r) => setTimeout(r, 15));
    fs.writeFileSync(f, "const x = 1;\n");
    await state.refreshNotedFromDisk(f);
    const second = state.get(f)!;
    assert.notEqual(second.mtimeMs, first.mtimeMs);
    const ok = await state.checkBeforeMutate(f, {
      tool: "search_replace",
      rel: "c.ts",
    });
    assert.equal(ok, null);
    fs.unlinkSync(f);
    await state.refreshNotedFromDisk(f);
    assert.equal(state.get(f), undefined, "gone file clears the note");
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* */
    }
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
    assert.match(ok.output, /\(\d+ lines?\)/);
    assert.equal(fs.readFileSync(path.join(dir, "x.ts"), "utf8"), "export const a = 2;\n");
    const stamp = fileReads.get(path.join(dir, "x.ts"));
    assert.ok(stamp);
    assert.equal(
      stamp!.fullReadLines,
      undefined,
      "receipt is not a read — noteFromDisk must not set fullReadLines",
    );
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

  it("apply_patch rollback restamps so a retry is not blocked as changed on disk", async () => {
    fs.writeFileSync(path.join(dir, "keep.txt"), "original\n");
    fs.writeFileSync(path.join(dir, "blocked"), "not-a-dir\n");
    await toolRead({ path: "keep.txt" }, ctx);
    await new Promise((r) => setTimeout(r, 15));
    const failed = await toolApplyPatch(
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
      ctx,
    );
    assert.equal(failed.isError, true);
    assert.match(failed.output, /Rolled back — workspace is unchanged/i);
    assert.equal(
      fs.readFileSync(path.join(dir, "keep.txt"), "utf8"),
      "original\n",
    );
    assert.equal(
      await fileReads.checkBeforeMutate(path.join(dir, "keep.txt"), {
        tool: "apply_patch",
        rel: "keep.txt",
      }),
      null,
    );
    const retry = await toolApplyPatch(
      {
        patchText: `*** Begin Patch
*** Update File: keep.txt
@@
-original
+changed
*** End Patch`,
      },
      ctx,
    );
    assert.equal(retry.isError, undefined, retry.output);
    assert.doesNotMatch(retry.output, /changed on disk/);
    assert.equal(
      fs.readFileSync(path.join(dir, "keep.txt"), "utf8"),
      "changed\n",
    );
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

describe("compact and FileReadState", () => {
  it("no-op compact (nothing dropped) leaves FileReadState intact", async () => {
    const id = "sess-compact-fileread-noop";
    forgetFileReadsSession(id);
    const d = tmpWorkspace();
    const f = path.join(d, "a.ts");
    fs.writeFileSync(f, "const x = 1;\n");
    const state = fileReadsForSession(id);
    assert.equal(await state.noteFromDisk(f), true);
    compactMessages(
      [
        { role: "user", content: "read a.ts" },
        { role: "assistant", content: "ok" },
      ],
      12,
      { sessionId: id },
    );
    assert.equal(state.size(), 1);
    assert.equal(
      await state.checkBeforeMutate(f, { tool: "search_replace", rel: "a.ts" }),
      null,
    );
    forgetFileReadsSession(id);
  });

  it("checkpoint compact keeps FileReadState when the file is unchanged", async () => {
    const id = "sess-compact-fileread";
    forgetFileReadsSession(id);
    const d = tmpWorkspace();
    const f = path.join(d, "a.ts");
    fs.writeFileSync(f, "const x = 1;\n");
    const state = fileReadsForSession(id);
    assert.equal(await state.noteFromDisk(f), true);
    assert.equal(
      await state.checkBeforeMutate(f, { tool: "search_replace", rel: "a.ts" }),
      null,
    );
    const long: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 0; i < 40; i++) {
      long.push({ role: "user", content: `turn ${i}` });
      long.push({ role: "assistant", content: `ok ${i}` });
    }
    compactMessages(long, 8, { sessionId: id });
    assert.ok(state.size() >= 1);
    assert.equal(
      await state.checkBeforeMutate(f, { tool: "search_replace", rel: "a.ts" }),
      null,
    );
    forgetFileReadsSession(id);
  });

  it("checkpoint compact drops FileReadState when the file changed on disk", async () => {
    const id = "sess-compact-fileread-stale";
    forgetFileReadsSession(id);
    const d = tmpWorkspace();
    const f = path.join(d, "a.ts");
    fs.writeFileSync(f, "const x = 1;\n");
    const state = fileReadsForSession(id);
    assert.equal(await state.noteFromDisk(f), true);
    fs.writeFileSync(f, "const x = 2;\nconst y = 3;\n");
    const long: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 0; i < 40; i++) {
      long.push({ role: "user", content: `turn ${i}` });
      long.push({ role: "assistant", content: `ok ${i}` });
    }
    compactMessages(long, 8, { sessionId: id });
    const msg = await state.checkBeforeMutate(f, {
      tool: "search_replace",
      rel: "a.ts",
    });
    assert.ok(msg);
    assert.match(msg!, /has not been read|changed on disk/);
    forgetFileReadsSession(id);
  });

  it("clearFileReadsForSession is a no-op for unknown ids", () => {
    clearFileReadsForSession("no-such-session");
    clearFileReadsForSession("");
  });
});

describe("clearConversation drops FileReadState", () => {
  it("same session id cannot edit after /clear without re-read", async () => {
    const { createSession, clearConversation } = await import(
      "../src/session/session.js"
    );
    const d = tmpWorkspace();
    const s = createSession({
      cwd: d,
      provider: "xai",
      model: "grok-4",
    });
    const f = path.join(d, "a.ts");
    fs.writeFileSync(f, "const x = 1;\n");
    const state = fileReadsForSession(s.meta.id);
    assert.equal(await state.noteFromDisk(f), true);
    assert.equal(
      await state.checkBeforeMutate(f, { tool: "search_replace", rel: "a.ts" }),
      null,
    );
    clearConversation(s);
    assert.equal(state.size(), 0);
    const msg = await state.checkBeforeMutate(f, {
      tool: "search_replace",
      rel: "a.ts",
    });
    assert.ok(msg);
    assert.match(msg!, /has not been read/);
    forgetFileReadsSession(s.meta.id);
  });

  it("deleteSession drops the FileReadState registry entry", async () => {
    const { createSession, deleteSession } = await import(
      "../src/session/session.js"
    );
    const d = tmpWorkspace();
    const s = createSession({
      cwd: d,
      provider: "xai",
      model: "grok-4",
    });
    const f = path.join(d, "a.ts");
    fs.writeFileSync(f, "const x = 1;\n");
    const first = fileReadsForSession(s.meta.id);
    assert.equal(await first.noteFromDisk(f), true);
    assert.equal(deleteSession(s.meta.id, { force: true }), true);
    const again = fileReadsForSession(s.meta.id);
    assert.notEqual(again, first);
    assert.equal(again.size(), 0);
    forgetFileReadsSession(s.meta.id);
  });
});
