import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executeTool } from "../src/agent/tools/index.js";
import { toolRead } from "../src/agent/tools/read.js";
import { expandMessagesForVision } from "../src/agent/loop.js";
import { parseImageHits } from "../src/util/imagine-client.js";
import { imageReadReceipt } from "../src/util/user-images.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import type { ChatMessage } from "../src/providers/types.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("Imagine client parse", () => {
  it("reads url and b64 hits", () => {
    const hits = parseImageHits({
      data: [
        { url: "https://cdn.example/a.png" },
        { b64_json: PNG_1X1.toString("base64"), mime_type: "image/png" },
      ],
    });
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.url, "https://cdn.example/a.png");
    assert.ok(hits[1]!.b64_json);
  });
});

describe("read_file vision", () => {
  it("returns [[image:]] receipt instead of binary refuse", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-img-read-"));
    const png = path.join(dir, "shot.png");
    fs.writeFileSync(png, PNG_1X1);
    const r = await toolRead({ path: png }, { workspace: dir });
    assert.notEqual(r.isError, true);
    assert.match(r.output, /\[\[image:shot\.png\]\]/);
    assert.match(r.output, /Image:/);
  });
});

describe("expandMessagesForVision tool results", () => {
  it("appends a user vision turn after tool [[image:]]", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vis-"));
    const png = path.join(dir, "shot.png");
    fs.writeFileSync(png, PNG_1X1);
    const msgs: ChatMessage[] = [
      { role: "user", content: "look" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"shot.png"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: imageReadReceipt("shot.png", PNG_1X1.length),
      },
    ];
    const out = expandMessagesForVision(msgs, dir);
    const last = out[out.length - 1]!;
    assert.equal(last.role, "user");
    assert.ok(Array.isArray(last.content));
    const parts = last.content as Array<{ type: string }>;
    assert.ok(parts.some((p) => p.type === "image_url"));
  });
});

describe("image_gen tool", () => {
  let prevKey = "";
  let prevFetch: typeof fetch;

  before(() => {
    prevKey = process.env.XAI_API_KEY || "";
    process.env.XAI_API_KEY = "test-key";
    prevFetch = globalThis.fetch;
  });

  after(() => {
    if (prevKey) process.env.XAI_API_KEY = prevKey;
    else delete process.env.XAI_API_KEY;
    globalThis.fetch = prevFetch;
  });

  it("writes images/ from b64_json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-igen-"));
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          data: [{ b64_json: PNG_1X1.toString("base64"), mime_type: "image/png" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const r = await executeTool(
      "image_gen",
      JSON.stringify({ prompt: "a red torch, pixel art, flat green background" }),
      { workspace: dir, config: { ...DEFAULT_CONFIG, workspace: dir } },
    );
    assert.notEqual(r.isError, true, r.output);
    assert.match(r.output, /\[\[image:/);
    const files = fs.readdirSync(path.join(dir, "images"));
    assert.ok(files.some((f) => f.endsWith(".png")));
  });

  it("fails closed without a prompt", async () => {
    const r = await executeTool("image_gen", "{}", {
      workspace: os.tmpdir(),
    });
    assert.equal(r.isError, true);
    assert.match(r.output, /prompt is required/);
  });
});
