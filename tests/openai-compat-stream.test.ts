import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import type { ChatRequest } from "../src/providers/types.js";

function makeReq(): ChatRequest {
  return {
    model: "proxy-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "read a file",
          parameters: { type: "object" },
        },
      },
    ],
  };
}

function sseResponse(chunks: unknown[]): Response {
  const body =
    chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n") +
    "\ndata: [DONE]\n";
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("openai-compat streamed tool_call index handling", () => {
  let prevFetch: typeof globalThis.fetch;

  beforeEach(() => {
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
  });

  function mockStream(chunks: unknown[]) {
    globalThis.fetch = (async () => sseResponse(chunks)) as typeof fetch;
  }

  it("sends tool_choice=required when the request asks for it", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return sseResponse([
        {
          id: "chatcmpl_tc",
          model: "grok-4.6",
          choices: [{ delta: { content: "x" }, finish_reason: "stop" }],
        },
      ]);
    }) as typeof fetch;
    const p = new OpenAICompatProvider({
      id: "xai",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "sk-test",
    });
    await p.chatStream({ ...makeReq(), tool_choice: "required" }, () => {});
    assert.equal(body?.tool_choice, "required");
  });

  it("does not emit lone UTF-16 surrogate hex escapes (xAI serde_json 400)", async () => {
    let raw = "";
    globalThis.fetch = (async (_url, init) => {
      raw = String(init?.body ?? "");
      return sseResponse([
        {
          id: "chatcmpl_surr",
          model: "grok-4.6",
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        },
      ]);
    }) as typeof fetch;
    const p = new OpenAICompatProvider({
      id: "xai",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "sk-test",
    });
    // Dogfood: DuckDuckGo snippet ended mid-emoji → messages[n].content \ud83d
    const split = "🔥".slice(0, 1);
    await p.chatStream(
      {
        ...makeReq(),
        messages: [
          {
            role: "tool",
            content: `unique features: ${split}\n\n_Source: DuckDuckGo HTML`,
          },
        ],
      },
      () => {},
    );
    assert.doesNotMatch(raw, /\\ud[89ab][0-9a-f]{2}/i);
    JSON.parse(raw);
    const parsed = JSON.parse(raw) as {
      messages: Array<{ content: string }>;
    };
    assert.match(parsed.messages[0]!.content, /\uFFFD/);
  });

  it("accumulates tool_call chunks that omit `index` (single-call proxy)", async () => {
    mockStream([
      {
        id: "chatcmpl_1",
        model: "proxy-model",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"pa' },
                },
              ],
            },
          },
        ],
      },
      {
        id: "chatcmpl_1",
        model: "proxy-model",
        choices: [
          {
            delta: {
              tool_calls: [{ function: { arguments: 'th":"x"}' } }],
            },
          },
        ],
      },
      {
        id: "chatcmpl_1",
        model: "proxy-model",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ]);
    const p = new OpenAICompatProvider({
      id: "custom",
      baseUrl: "https://proxy.test/v1",
      apiKey: "sk-test",
    });
    const res = await p.chatStream(makeReq(), () => {});

    assert.equal(res.finish_reason, "tool_calls");
    assert.equal(res.message.tool_calls?.length, 1);
    assert.equal(res.message.tool_calls?.[0].id, "call_1");
    assert.equal(res.message.tool_calls?.[0].function.name, "read_file");
    assert.equal(
      res.message.tool_calls?.[0].function.arguments,
      '{"path":"x"}',
    );
  });

  it("indexed chunks still accumulate into separate calls", async () => {
    mockStream([
      {
        id: "chatcmpl_2",
        model: "proxy-model",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
                  function: { name: "read_file", arguments: "{}" },
                },
                {
                  index: 1,
                  id: "call_b",
                  function: { name: "write_file", arguments: '{"path":"y"}' },
                },
              ],
            },
          },
        ],
      },
      {
        id: "chatcmpl_2",
        model: "proxy-model",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ]);
    const p = new OpenAICompatProvider({
      id: "custom",
      baseUrl: "https://proxy.test/v1",
      apiKey: "sk-test",
    });
    const res = await p.chatStream(makeReq(), () => {});

    assert.equal(res.message.tool_calls?.length, 2);
    assert.equal(res.message.tool_calls?.[0].function.name, "read_file");
    assert.equal(res.message.tool_calls?.[1].function.name, "write_file");
  });

  it("maps DeepSeek native cache counters onto cache_read_input_tokens", async () => {
    mockStream([
      {
        id: "chatcmpl_ds",
        model: "deepseek-v4-flash",
        choices: [
          { delta: { content: "ok" }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 10,
          total_tokens: 1010,
          prompt_cache_hit_tokens: 900,
          prompt_cache_miss_tokens: 100,
        },
      },
    ]);
    const p = new OpenAICompatProvider({
      id: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
    });
    const res = await p.chatStream(makeReq(), () => {});
    assert.equal(res.usage?.cache_read_input_tokens, 900);
    assert.equal(res.usage?.prompt_tokens, 1000);
  });

  it("xAI/OpenAI prompt_tokens_details.cached_tokens still maps (regression)", async () => {
    mockStream([
      {
        id: "chatcmpl_xai",
        model: "grok-4.5",
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 5,
          total_tokens: 505,
          prompt_tokens_details: { cached_tokens: 400 },
        },
      },
    ]);
    const p = new OpenAICompatProvider({
      id: "xai",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "sk-test",
    });
    const res = await p.chatStream(makeReq(), () => {});
    assert.equal(res.usage?.cache_read_input_tokens, 400);
  });

  it("accumulates reasoning_content for prefix-cache replay (not painted)", async () => {
    mockStream([
      {
        id: "chatcmpl_r",
        model: "grok-4.6",
        choices: [{ delta: { reasoning_content: "step " } }],
      },
      {
        id: "chatcmpl_r",
        model: "grok-4.6",
        choices: [
          { delta: { reasoning_content: "two", content: "hi" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      },
    ]);
    const painted: string[] = [];
    const p = new OpenAICompatProvider({
      id: "xai",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "sk-test",
    });
    const res = await p.chatStream(makeReq(), (d) => {
      if (d.content) painted.push(d.content);
    });
    assert.equal(res.message.content, "hi");
    assert.equal(res.message.reasoning_content, "step two");
    assert.deepEqual(painted, ["hi"]);
  });

  it("reasoning-only wall returns Stop, not a dropped-connection throw", async () => {
    const prev = process.env.FORGE_PROVIDER_REASONING_WALL_MS;
    process.env.FORGE_PROVIDER_REASONING_WALL_MS = "40ms";
    const enc = new TextEncoder();
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  id: "chatcmpl_w",
                  model: "grok-4.6",
                  choices: [{ delta: { reasoning_content: "I MUST pick a DIFFERENT surface" } }],
                })}\n`,
              ),
            );
            await new Promise((r) => setTimeout(r, 80));
            try {
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({
                    choices: [{ delta: { content: "too late" }, finish_reason: "stop" }],
                  })}\n`,
                ),
              );
              controller.enqueue(enc.encode("data: [DONE]\n"));
              controller.close();
            } catch {
              /* reader cancelled by the wall */
            }
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      )) as typeof fetch;
    try {
      const p = new OpenAICompatProvider({
        id: "xai",
        baseUrl: "https://api.x.ai/v1",
        apiKey: "sk-test",
      });
      const res = await p.chatStream(makeReq(), () => {});
      assert.equal(res.finish_reason, "reasoning_wall");
      assert.match(res.message.reasoning_content || "", /DIFFERENT surface/);
      assert.equal(res.message.content, null);
      assert.equal(res.message.tool_calls, undefined);
    } finally {
      if (prev === undefined) delete process.env.FORGE_PROVIDER_REASONING_WALL_MS;
      else process.env.FORGE_PROVIDER_REASONING_WALL_MS = prev;
    }
  });

  it("reasoning mantra loop returns Stop without waiting for the wall", async () => {
    const prev = process.env.FORGE_PROVIDER_REASONING_WALL_MS;
    process.env.FORGE_PROVIDER_REASONING_WALL_MS = "off";
    const closer =
      "The fix is in place and verified.\n\n**Proof:** test passed.\n\nReady for the next different surface. ";
    const thought = "Need a different surface from leftover lectures. " + closer.repeat(40);
    mockStream([
      {
        id: "chatcmpl_loop",
        model: "grok-4.6",
        choices: [{ delta: { reasoning_content: thought } }],
      },
      {
        choices: [{ delta: { content: "too late" }, finish_reason: "stop" }],
      },
    ]);
    try {
      const p = new OpenAICompatProvider({
        id: "xai",
        baseUrl: "https://api.x.ai/v1",
        apiKey: "sk-test",
      });
      const res = await p.chatStream(makeReq(), () => {});
      assert.equal(res.finish_reason, "reasoning_loop");
      assert.match(res.message.reasoning_content || "", /fix is in place/);
      assert.equal(res.message.content, null);
      assert.equal(res.message.tool_calls, undefined);
    } finally {
      if (prev === undefined) delete process.env.FORGE_PROVIDER_REASONING_WALL_MS;
      else process.env.FORGE_PROVIDER_REASONING_WALL_MS = prev;
    }
  });
});
