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
});
