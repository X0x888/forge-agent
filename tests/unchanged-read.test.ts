import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileReadState,
} from "../src/agent/tools/file-read-state.js";
import {
  toolRead,
  UNCHANGED_READ_STUB,
  isFullFileReadArgs,
} from "../src/agent/tools/read.js";
import { toolWrite } from "../src/agent/tools/write.js";
import { REQUEST_PRUNE_OMITTED } from "../src/session/request-prune.js";
import type { ToolContext } from "../src/agent/tools/types.js";
import type { SessionData } from "../src/session/session.js";
import type { ChatMessage } from "../src/providers/types.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forge-unchanged-read-"));
}

function sessionWithRead(file: string, body: string, args?: Record<string, unknown>): SessionData {
  const callArgs = { path: file, ...args };
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "r1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify(callArgs),
          },
        },
      ],
    },
    { role: "tool", tool_call_id: "r1", content: body },
  ];
  return { messages } as SessionData;
}

describe("isFullFileReadArgs", () => {
  it("treats omitted offset/limit as a full-file read", () => {
    assert.equal(isFullFileReadArgs({ path: "a.ts" }), true);
    assert.equal(isFullFileReadArgs({ path: "a.ts", offset: 1, limit: 0 }), true);
    assert.equal(isFullFileReadArgs({ path: "a.ts", offset: 10 }), false);
    assert.equal(isFullFileReadArgs({ path: "a.ts", limit: 40 }), false);
  });
});

describe("unchanged full-file read stub", () => {
  let dir: string;
  let fileReads: FileReadState;
  let ctx: ToolContext;
  const prevGuard = process.env.FORGE_FILE_READ_GUARD;
  const prevStub = process.env.FORGE_UNCHANGED_READ_STUB;

  beforeEach(() => {
    dir = tmpWorkspace();
    fileReads = new FileReadState();
    ctx = { workspace: dir, fileReads };
    process.env.FORGE_FILE_READ_GUARD = "1";
    delete process.env.FORGE_UNCHANGED_READ_STUB;
  });

  afterEach(() => {
    if (prevGuard === undefined) delete process.env.FORGE_FILE_READ_GUARD;
    else process.env.FORGE_FILE_READ_GUARD = prevGuard;
    if (prevStub === undefined) delete process.env.FORGE_UNCHANGED_READ_STUB;
    else process.env.FORGE_UNCHANGED_READ_STUB = prevStub;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("second full read with live tail returns the unchanged stub", async () => {
    const rel = "a.ts";
    fs.writeFileSync(path.join(dir, rel), "export const x = 1;\n");
    const first = await toolRead({ path: rel }, ctx);
    assert.match(first.output, /File: /);
    assert.doesNotMatch(first.output, new RegExp(UNCHANGED_READ_STUB));
    ctx.session = sessionWithRead(rel, first.output);
    const second = await toolRead({ path: rel }, ctx);
    assert.match(second.output, new RegExp(UNCHANGED_READ_STUB));
    assert.match(second.output, /same mtime/);
    assert.ok(!second.isError);
  });

  it("offset/limit windows are never stubbed", async () => {
    const rel = "win.ts";
    fs.writeFileSync(path.join(dir, rel), "one\ntwo\nthree\nfour\n");
    const first = await toolRead({ path: rel, offset: 2, limit: 2 }, ctx);
    ctx.session = sessionWithRead(rel, first.output, { offset: 2, limit: 2 });
    const second = await toolRead({ path: rel, offset: 2, limit: 2 }, ctx);
    assert.match(second.output, /File: /);
    assert.doesNotMatch(second.output, new RegExp(UNCHANGED_READ_STUB));
  });

  it("write then read returns the full body", async () => {
    const rel = "w.ts";
    fs.writeFileSync(path.join(dir, rel), "v1\n");
    const first = await toolRead({ path: rel }, ctx);
    ctx.session = sessionWithRead(rel, first.output);
    const wrote = await toolWrite({ path: rel, content: "v2\n" }, ctx);
    assert.equal(wrote.isError, undefined);
    const after = await toolRead({ path: rel }, ctx);
    assert.match(after.output, /File: /);
    assert.match(after.output, /v2/);
    assert.doesNotMatch(after.output, new RegExp(UNCHANGED_READ_STUB));
  });

  it("does not stub when the last live read was omitted", async () => {
    const rel = "omit.ts";
    fs.writeFileSync(path.join(dir, rel), "keep me\n");
    const first = await toolRead({ path: rel }, ctx);
    assert.match(first.output, /File: /);
    ctx.session = sessionWithRead(rel, `${REQUEST_PRUNE_OMITTED} (read_file, 12 chars).`);
    const second = await toolRead({ path: rel }, ctx);
    assert.match(second.output, /File: /);
    assert.match(second.output, /keep me/);
  });

  it("FORGE_UNCHANGED_READ_STUB=0 keeps the full body", async () => {
    process.env.FORGE_UNCHANGED_READ_STUB = "0";
    const rel = "off.ts";
    fs.writeFileSync(path.join(dir, rel), "body\n");
    const first = await toolRead({ path: rel }, ctx);
    ctx.session = sessionWithRead(rel, first.output);
    const second = await toolRead({ path: rel }, ctx);
    assert.match(second.output, /File: /);
    assert.doesNotMatch(second.output, new RegExp(UNCHANGED_READ_STUB));
  });
});
