import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "../src/providers/factory.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import type { ForgeConfig } from "../src/config/types.js";
import type { ChatRequest } from "../src/providers/types.js";

const OK_CHAT = {
  id: "chatcmpl_1",
  model: "gpt-test",
  choices: [
    {
      message: { role: "assistant", content: "hi" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const OK_MESSAGES = {
  id: "msg_1",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

function makeReq(): ChatRequest {
  return { model: "test-model", messages: [{ role: "user", content: "hi" }] };
}

/** Config with no provider entries and no global baseUrl. */
function bareConfig(): ForgeConfig {
  return { ...DEFAULT_CONFIG, providers: {}, baseUrl: undefined };
}

describe("provider factory base URL fallback", () => {
  let prevFetch: typeof globalThis.fetch;
  let lastUrl: string | undefined;

  beforeEach(() => {
    prevFetch = globalThis.fetch;
    lastUrl = undefined;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
  });

  function mockFetch(payload: unknown) {
    globalThis.fetch = (async (url) => {
      lastUrl = String(url);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  it("anthropic without configured baseUrl hits api.anthropic.com, not api.openai.com", async () => {
    mockFetch(OK_MESSAGES);
    const p = createProvider(bareConfig(), {
      provider: "anthropic",
      method: "api_key",
      token: "sk-ant-test",
    });
    await p.chat(makeReq());
    assert.ok(lastUrl);
    assert.ok(lastUrl!.startsWith("https://api.anthropic.com/v1/"));
  });

  it("openai-compatible providers keep the api.openai.com fallback", async () => {
    mockFetch(OK_CHAT);
    const p = createProvider(bareConfig(), {
      provider: "openai",
      method: "api_key",
      token: "sk-test",
    });
    await p.chat(makeReq());
    assert.ok(lastUrl);
    assert.ok(lastUrl!.startsWith("https://api.openai.com/v1/"));
  });

  it("configured anthropic baseUrl still wins", async () => {
    mockFetch(OK_MESSAGES);
    const cfg: ForgeConfig = {
      ...bareConfig(),
      providers: { anthropic: { baseUrl: "https://anthropic.proxy.test/v1" } },
    };
    const p = createProvider(cfg, {
      provider: "anthropic",
      method: "api_key",
      token: "sk-ant-test",
    });
    await p.chat(makeReq());
    assert.ok(lastUrl);
    assert.ok(lastUrl!.startsWith("https://anthropic.proxy.test/v1/"));
  });
});
