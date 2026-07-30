import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import type { ChatRequest } from "../src/providers/types.js";

function makeReq(): ChatRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [
      { role: "system", content: "You are Forge." },
      { role: "user", content: "hi" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "read a file",
          parameters: { type: "object" },
        },
      },
      {
        type: "function",
        function: {
          name: "write",
          description: "write a file",
          parameters: { type: "object" },
        },
      },
    ],
  };
}

const OK_PAYLOAD = {
  id: "msg_1",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 5 },
};

function sseResponse(events: string[]): Response {
  const body = events.map((e) => `data: ${e}`).join("\n\n") + "\n\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("anthropic prompt caching", () => {
  let prevFetch: typeof globalThis.fetch;
  let prevCacheEnv: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastBody: any;

  beforeEach(() => {
    prevFetch = globalThis.fetch;
    prevCacheEnv = process.env.FORGE_ANTHROPIC_CACHE;
    delete process.env.FORGE_ANTHROPIC_CACHE; // default = on
    lastBody = undefined;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    if (prevCacheEnv === undefined) delete process.env.FORGE_ANTHROPIC_CACHE;
    else process.env.FORGE_ANTHROPIC_CACHE = prevCacheEnv;
  });

  function mockJsonResponse(payload: unknown) {
    globalThis.fetch = (async (_url, init) => {
      lastBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  function mockStreamResponse(events: string[]) {
    globalThis.fetch = (async (_url, init) => {
      lastBody = JSON.parse(String(init?.body));
      return sseResponse(events);
    }) as typeof fetch;
  }

  it("default on: system sent as blocks with cache breakpoint, last tool cached (chat)", async () => {
    mockJsonResponse(OK_PAYLOAD);
    const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
    await p.chat(makeReq());

    assert.ok(Array.isArray(lastBody.system));
    assert.equal(lastBody.system.length, 1);
    assert.equal(lastBody.system[0].type, "text");
    assert.equal(lastBody.system[0].text, "You are Forge.");
    assert.deepEqual(lastBody.system[0].cache_control, { type: "ephemeral" });

    assert.equal(lastBody.tools.length, 2);
    assert.ok(!("cache_control" in lastBody.tools[0]));
    assert.deepEqual(lastBody.tools[1].cache_control, { type: "ephemeral" });
    // cached tool otherwise unchanged
    assert.equal(lastBody.tools[1].name, "write");
    assert.deepEqual(lastBody.tools[1].input_schema, { type: "object" });
  });

  it("default on: same breakpoints on chatStream", async () => {
    mockStreamResponse([
      JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      }),
      JSON.stringify({
        type: "content_block_start",
        content_block: { type: "text", text: "" },
      }),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hi" },
      }),
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      }),
    ]);
    const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
    const res = await p.chatStream(makeReq(), () => {});

    assert.ok(Array.isArray(lastBody.system));
    assert.deepEqual(lastBody.system[0].cache_control, { type: "ephemeral" });
    assert.ok(!("cache_control" in lastBody.tools[0]));
    assert.deepEqual(lastBody.tools[1].cache_control, { type: "ephemeral" });
    assert.equal(res.finish_reason, "stop");
  });

  it("FORGE_ANTHROPIC_CACHE=0: legacy string system, no cache_control anywhere", async () => {
    process.env.FORGE_ANTHROPIC_CACHE = "0";
    mockJsonResponse(OK_PAYLOAD);
    const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
    await p.chat(makeReq());

    assert.equal(lastBody.system, "You are Forge.");
    assert.equal(lastBody.tools.length, 2);
    assert.ok(!JSON.stringify(lastBody).includes("cache_control"));
  });

  it("FORGE_ANTHROPIC_CACHE=false: also disables", async () => {
    process.env.FORGE_ANTHROPIC_CACHE = "false";
    mockJsonResponse(OK_PAYLOAD);
    const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
    await p.chat(makeReq());

    assert.equal(lastBody.system, "You are Forge.");
    assert.ok(!JSON.stringify(lastBody).includes("cache_control"));
  });

  it("empty system stays omitted even with caching on", async () => {
    mockJsonResponse(OK_PAYLOAD);
    const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
    const req = makeReq();
    req.messages = req.messages.filter((m) => m.role !== "system");
    await p.chat(req);

    assert.ok(!("system" in lastBody));
    // tools still cached
    assert.deepEqual(lastBody.tools[1].cache_control, { type: "ephemeral" });
  });

  it("surfaces cache usage counters from non-stream response", async () => {
    mockJsonResponse({
      ...OK_PAYLOAD,
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    });
    const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
    const res = await p.chat(makeReq());

    assert.equal(res.usage?.prompt_tokens, 100);
    assert.equal(res.usage?.completion_tokens, 5);
    assert.equal(res.usage?.cache_read_input_tokens, 80);
    assert.equal(res.usage?.cache_creation_input_tokens, 20);
  });

  it("stream usage keeps message_start cache counters through message_delta", async () => {
    mockStreamResponse([
      JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 20,
          },
        },
      }),
      JSON.stringify({
        type: "content_block_start",
        content_block: { type: "text", text: "" },
      }),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hi" },
      }),
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      }),
    ]);
    const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
    const res = await p.chatStream(makeReq(), () => {});

    assert.equal(res.usage?.prompt_tokens, 100);
    assert.equal(res.usage?.completion_tokens, 5);
    assert.equal(res.usage?.cache_read_input_tokens, 80);
    assert.equal(res.usage?.cache_creation_input_tokens, 20);
  });
});
