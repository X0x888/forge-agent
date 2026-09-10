import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executeTool } from "../src/agent/tools/index.js";
import { toolRead } from "../src/agent/tools/read.js";
import { expandMessagesForVision, runAgentLoop } from "../src/agent/loop.js";
import { parseImageHits } from "../src/util/imagine-client.js";
import {
  imageReadReceipt,
  loadImageDataUrl,
} from "../src/util/user-images.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  ChatResponse,
} from "../src/providers/types.js";
import { ProviderApiError } from "../src/providers/errors.js";
import { createSession } from "../src/session/session.js";
import { HookRunner } from "../src/harness/hooks.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { McpManager } from "../src/mcp/manager.js";
import { LspManager } from "../src/lsp/manager.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function pngWithEdge(n: number): Buffer {
  const b = Buffer.from(PNG_1X1);
  b.writeUInt32BE(n, 16);
  b.writeUInt32BE(n, 20);
  return b;
}

const PNG_8X8 = pngWithEdge(8);
const PNG_32X32 = pngWithEdge(32);

const MAZE_DIMENSION_BODY =
  "Image dimensions 1x1 are too small. Both width and height must be at least 8 pixels.";

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
  it("does not attach a 1×1 PNG (leftover-door class)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-img-read-"));
    const png = path.join(dir, "shot.png");
    fs.writeFileSync(png, PNG_1X1);
    const r = await toolRead({ path: png }, { workspace: dir });
    assert.notEqual(r.isError, true);
    assert.doesNotMatch(r.output, /\[\[image:/);
    assert.match(r.output, /Image:/);
    assert.match(r.output, /1x1/);
    assert.match(r.output, /Not attached/);
    assert.equal(loadImageDataUrl(png, dir), null);
  });

  it("returns [[image:]] receipt for an 8×8 PNG instead of binary refuse", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-img-read-"));
    const png = path.join(dir, "shot.png");
    fs.writeFileSync(png, PNG_8X8);
    const r = await toolRead({ path: png }, { workspace: dir });
    assert.notEqual(r.isError, true);
    assert.match(r.output, /\[\[image:shot\.png\]\]/);
    assert.match(r.output, /Image:/);
    assert.match(r.output, /8x8/);
    assert.ok(loadImageDataUrl(png, dir));
  });
});

function visionMsgs(
  dir: string,
  receipt: string,
): ChatMessage[] {
  return [
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
      content: receipt,
    },
  ];
}

describe("expandMessagesForVision tool results", () => {
  it("does not emit image_url for a 1×1 PNG even when [[image:]] is in the tool result", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vis-"));
    const png = path.join(dir, "shot.png");
    fs.writeFileSync(png, PNG_1X1);
    const out = expandMessagesForVision(
      visionMsgs(dir, `see [[image:shot.png]]`),
      dir,
    );
    const dumped = JSON.stringify(out);
    assert.doesNotMatch(dumped, /"image_url"/);
    assert.equal(
      out.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === "image_url"),
      ),
      false,
    );
  });

  it("appends a user vision turn after tool [[image:]] for an 8×8 PNG", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vis-"));
    const png = path.join(dir, "shot.png");
    fs.writeFileSync(png, PNG_8X8);
    const out = expandMessagesForVision(
      visionMsgs(
        dir,
        imageReadReceipt("shot.png", PNG_8X8.length, { width: 8, height: 8 }),
      ),
      dir,
    );
    const last = out[out.length - 1]!;
    assert.equal(last.role, "user");
    assert.ok(Array.isArray(last.content));
    const parts = last.content as Array<{ type: string }>;
    assert.ok(parts.some((p) => p.type === "image_url"));
  });

  it("appends image_url for a 32×32 PNG", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vis-"));
    const png = path.join(dir, "shot.png");
    fs.writeFileSync(png, PNG_32X32);
    const out = expandMessagesForVision(
      visionMsgs(
        dir,
        imageReadReceipt("shot.png", PNG_32X32.length, {
          width: 32,
          height: 32,
        }),
      ),
      dir,
    );
    const last = out[out.length - 1]!;
    assert.ok(Array.isArray(last.content));
    assert.ok(
      (last.content as Array<{ type: string }>).some((p) => p.type === "image_url"),
    );
  });

  it("keeps only the last N vision images when maxImages is set", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vis-cap-"));
    const msgs: ChatMessage[] = [{ role: "user", content: "look" }];
    for (let i = 1; i <= 3; i++) {
      const png = path.join(dir, `shot${i}.png`);
      fs.writeFileSync(png, PNG_8X8);
      msgs.push(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `c${i}`,
              type: "function",
              function: { name: "read_file", arguments: `{"path":"shot${i}.png"}` },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: `c${i}`,
          content: imageReadReceipt(`shot${i}.png`, PNG_8X8.length, {
            width: 8,
            height: 8,
          }),
        },
      );
    }
    const out = expandMessagesForVision(msgs, dir, { maxImages: 2 });
    const images = out.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((p) => p.type === "image_url")
        : [],
    );
    assert.equal(images.length, 2);
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

function hasImageUrl(req: ChatRequest): boolean {
  return req.messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => p && p.type === "image_url"),
  );
}

function textReply(text: string): ChatResponse {
  return {
    id: "chatcmpl_vis",
    model: "grok-4.6",
    message: { role: "assistant", content: text },
    finish_reason: "stop",
    usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
  };
}

describe("dimension 400 retry", () => {
  let tmp: string;
  const prevHome = process.env.FORGE_HOME;
  const prevMcp = process.env.FORGE_MCP;
  const prevLsp = process.env.FORGE_LSP;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vis-retry-"));
    process.env.FORGE_HOME = path.join(tmp, "home");
    process.env.FORGE_MCP = "0";
    process.env.FORGE_LSP = "0";
    fs.writeFileSync(path.join(tmp, "shot.png"), PNG_8X8);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevMcp === undefined) delete process.env.FORGE_MCP;
    else process.env.FORGE_MCP = prevMcp;
    if (prevLsp === undefined) delete process.env.FORGE_LSP;
    else process.env.FORGE_LSP = prevLsp;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  function harness() {
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.6",
    });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      maxTurns: 2,
      goal: { ...DEFAULT_CONFIG.goal, autoArm: false, stuckThreshold: 20 },
    };
    return {
      session,
      config,
      hooks: new HookRunner(config, tmp),
      permissions: new PermissionGate({ interactive: false }),
      mcp: new McpManager({
        workspace: tmp,
        config: { enabled: false, servers: {}, sources: [] },
      }),
      lsp: new LspManager({
        workspace: tmp,
        config: { enabled: false, servers: [], sources: [] },
      }),
    };
  }

  function dimension400(): ProviderApiError {
    return new ProviderApiError({
      provider: "xai",
      status: 400,
      body: MAZE_DIMENSION_BODY,
    });
  }

  it("strips image_url and retries once after a dimension 400", async () => {
    const h = harness();
    const reqs: ChatRequest[] = [];
    const provider: LLMProvider = {
      id: "xai",
      async chat(req) {
        reqs.push(req);
        if (hasImageUrl(req)) throw dimension400();
        return textReply("ok without images");
      },
      async chatStream(req) {
        return this.chat(req);
      },
    };
    const result = await runAgentLoop({
      ...h,
      provider,
      userMessage: "look at [[image:shot.png]]",
      stream: false,
      disableHarnessAutoArm: true,
    });
    assert.equal(result.aborted, false);
    assert.match(result.finalText, /ok without images/);
    assert.equal(reqs.length, 2);
    assert.equal(hasImageUrl(reqs[0]!), true);
    assert.equal(hasImageUrl(reqs[1]!), false);
  });

  it("throws on the second dimension 400", async () => {
    const h = harness();
    let calls = 0;
    const provider: LLMProvider = {
      id: "xai",
      async chat() {
        calls += 1;
        throw dimension400();
      },
      async chatStream() {
        calls += 1;
        throw dimension400();
      },
    };
    await assert.rejects(
      () =>
        runAgentLoop({
          ...h,
          provider,
          userMessage: "look at [[image:shot.png]]",
          stream: false,
          disableHarnessAutoArm: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderApiError);
        assert.equal(err.status, 400);
        return true;
      },
    );
    assert.equal(calls, 2);
  });

  it("a generic 400 is fatal immediately and does not strip vision", async () => {
    const h = harness();
    let calls = 0;
    const reqs: ChatRequest[] = [];
    const provider: LLMProvider = {
      id: "xai",
      async chat(req) {
        calls += 1;
        reqs.push(req);
        throw new ProviderApiError({
          provider: "xai",
          status: 400,
          body: "invalid schema for function",
        });
      },
      async chatStream(req) {
        return this.chat(req);
      },
    };
    await assert.rejects(
      () =>
        runAgentLoop({
          ...h,
          provider,
          userMessage: "look at [[image:shot.png]]",
          stream: false,
          disableHarnessAutoArm: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderApiError);
        assert.equal(err.status, 400);
        assert.match(err.body, /invalid schema for function/);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(hasImageUrl(reqs[0]!), true);
  });
});
