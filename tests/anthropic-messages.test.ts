import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import type { ChatRequest } from "../src/providers/types.js";

const OK_PAYLOAD = {
  id: "msg_1",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
};

function makeReq(messages: ChatRequest["messages"]): ChatRequest {
  return { model: "claude-sonnet-4-5", messages };
}

/** Every text block on the wire must be non-empty (Anthropic 400s otherwise). */
function allTextBlocks(body: { messages: Array<{ content: unknown }> }): string[] {
  const texts: string[] = [];
  for (const m of body.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; text?: string }>) {
      if (b?.type === "text") texts.push(b.text ?? "");
    }
  }
  return texts;
}

function roles(body: { messages: Array<{ role: string }> }): string[] {
  return body.messages.map((m) => m.role);
}

describe("anthropic convertMessages empty-content handling", () => {
  let prevFetch: typeof globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastBody: any;

  beforeEach(() => {
    prevFetch = globalThis.fetch;
    lastBody = undefined;
    globalThis.fetch = (async (_url, init) => {
      lastBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(OK_PAYLOAD), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
  });

  it("assistant content:null (empty-response leftover) emits no empty text block", async () => {
    const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
    await p.chat(
      makeReq([
        { role: "user", content: "hi" },
        { role: "assistant", content: null },
        { role: "user", content: "are you there?" },
      ]),
    );

    for (const t of allTextBlocks(lastBody)) assert.ok(t.length > 0);
    // Dropped empty assistant must not leave consecutive user messages —
    // Anthropic also 400s on non-alternating roles.
    assert.deepEqual(roles(lastBody), ["user"]);
    const blocks = lastBody.messages[0].content as Array<{ text?: string }>;
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, "hi");
    assert.equal(blocks[1].text, "are you there?");
  });

  it("assistant with tool_calls and content:null emits only tool_use blocks", async () => {
    const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
    await p.chat(
      makeReq([
        { role: "user", content: "read x" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "file body" },
      ]),
    );

    assert.deepEqual(roles(lastBody), ["user", "assistant", "user"]);
    const asst = lastBody.messages[1].content as Array<{ type: string }>;
    assert.equal(asst.length, 1);
    assert.equal(asst[0].type, "tool_use");
    const toolResult = lastBody.messages[2].content as Array<{
      type: string;
      content: string;
    }>;
    assert.equal(toolResult[0].type, "tool_result");
    assert.equal(toolResult[0].content, "file body");
  });

  it("empty user content is skipped without breaking alternation", async () => {
    const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
    await p.chat(
      makeReq([
        { role: "user", content: "hi" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "bye" },
      ]),
    );

    for (const t of allTextBlocks(lastBody)) assert.ok(t.length > 0);
    assert.deepEqual(roles(lastBody), ["user", "assistant", "user"]);
    const merged = lastBody.messages[1].content as Array<{ text?: string }>;
    assert.deepEqual(
      merged.map((b) => b.text),
      ["a1", "a2"],
    );
  });

  it("empty-string assistant content is also dropped", async () => {
    const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
    await p.chat(
      makeReq([
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
        { role: "user", content: "next" },
      ]),
    );

    for (const t of allTextBlocks(lastBody)) assert.ok(t.length > 0);
    assert.deepEqual(roles(lastBody), ["user"]);
  });
});

describe("anthropic stream trailing-buffer flush", () => {
  let prevFetch: typeof globalThis.fetch;

  beforeEach(() => {
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
  });

  it("parses a final SSE event not terminated by newline", async () => {
    const messageStart = JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-5",
        usage: { input_tokens: 100, output_tokens: 1 },
      },
    });
    const textDelta = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hi" },
    });
    const messageDelta = JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 5 },
    });
    // No trailing newline on the final event.
    const body = `data: ${messageStart}\n\ndata: ${textDelta}\n\ndata: ${messageDelta}`;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      )) as typeof fetch;

    const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
    const res = await p.chatStream(makeReq([{ role: "user", content: "hi" }]), () => {});

    assert.equal(res.finish_reason, "stop");
    assert.equal(res.message.content, "hi");
    assert.equal(res.usage?.prompt_tokens, 100);
    assert.equal(res.usage?.completion_tokens, 5);
  });
});
