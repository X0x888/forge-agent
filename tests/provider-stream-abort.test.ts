import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import type { ChatRequest } from "../src/providers/types.js";

/**
 * Regression: mid-stream abort/timeout must reject, never resolve as a
 * partial "successful" completion. reader.cancel() resolves a pending read()
 * with { done: true } — the stream loop must re-check the abort flag after
 * every read(), or a user Esc / provider timeout returns partial content
 * with finish_reason null.
 */

function makeReq(): ChatRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
  };
}

/** 200 SSE response that emits `firstChunk` then stays open forever. */
function hangingSseResponse(firstChunk: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(firstChunk));
      // Never close/enqueue again — the next read() stays pending until
      // the abort listener cancels the reader.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("provider mid-stream abort", () => {
  let prevFetch: typeof globalThis.fetch;

  beforeEach(() => {
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
  });

  it("openai-compat: cancel-during-read rejects with Aborted, not partial success", async () => {
    const chunk =
      'data: {"id":"c1","model":"m","choices":[{"delta":{"content":"Hello"}}]}\n\n';
    globalThis.fetch = (async () =>
      hangingSseResponse(chunk)) as typeof fetch;
    const p = new OpenAICompatProvider({
      id: "xai",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test",
    });
    const ac = new AbortController();
    const promise = p.chatStream(
      makeReq(),
      (delta) => {
        // Abort once the first token lands — the next read() is pending and
        // cancel() will resolve it with { done: true }.
        if (delta.content && !ac.signal.aborted) {
          setTimeout(() => ac.abort(), 0);
        }
      },
      ac.signal,
    );
    await assert.rejects(promise, /^Error: Aborted$/);
  });

  it("anthropic: cancel-during-read rejects with Aborted, not partial success", async () => {
    const events = [
      JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      }),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      }),
    ];
    const chunk = events.map((e) => `data: ${e}`).join("\n\n") + "\n\n";
    globalThis.fetch = (async () =>
      hangingSseResponse(chunk)) as typeof fetch;
    const p = new AnthropicProvider({
      baseUrl: "http://127.0.0.1:1",
      apiKey: "sk-ant-test",
    });
    const ac = new AbortController();
    const promise = p.chatStream(
      makeReq(),
      (delta) => {
        if (delta.content && !ac.signal.aborted) {
          setTimeout(() => ac.abort(), 0);
        }
      },
      ac.signal,
    );
    await assert.rejects(promise, /^Error: Aborted$/);
  });
});
