import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import type { ChatRequest } from "../src/providers/types.js";
import {
  X_GROK_CONV_ID,
  REQUEST_PRUNE_AT_DEFAULT,
  cacheHitRatio,
  extractReasoningContent,
  formatCacheRatio,
  grokConvIdHeaders,
  sessionCacheRatio,
  shouldPruneOutbound,
  requestPruneAtTokens,
} from "../src/session/prompt-cache.js";

describe("prompt-cache helpers", () => {
  it("ratio is cache/prompt, clamped", () => {
    assert.equal(cacheHitRatio(0, 0), 0);
    assert.equal(cacheHitRatio(100, 99), 0.99);
    assert.equal(cacheHitRatio(100, 200), 1);
    assert.equal(formatCacheRatio(0.992), "99.2%");
  });

  it("prefers last-round ratio over the session smear", () => {
    const live = sessionCacheRatio({
      totalPromptTokens: 1_000_000,
      totalCacheReadTokens: 400_000,
      lastRoundPromptTokens: 80_000,
      lastRoundCacheReadTokens: 79_200,
    });
    assert.ok(live);
    assert.equal(live!.live, true);
    assert.ok(Math.abs(live!.ratio - 0.99) < 0.001);
    const smear = sessionCacheRatio({
      totalPromptTokens: 1_000_000,
      totalCacheReadTokens: 400_000,
    });
    assert.ok(smear);
    assert.equal(smear!.live, false);
    assert.ok(Math.abs(smear!.ratio - 0.4) < 0.001);
  });

  it("conv-id header is clipped and omitted when empty", () => {
    assert.deepEqual(grokConvIdHeaders(""), {});
    assert.deepEqual(grokConvIdHeaders("  "), {});
    assert.equal(grokConvIdHeaders("sess-1")[X_GROK_CONV_ID], "sess-1");
  });

  it("extracts reasoning_content from message and delta shapes", () => {
    assert.equal(extractReasoningContent({ reasoning_content: "think" }), "think");
    assert.equal(extractReasoningContent({ reasoning: "r" }), "r");
    assert.equal(extractReasoningContent({ reasoning: { content: "c" } }), "c");
    assert.equal(extractReasoningContent({ content: "nope" }), "");
  });
});

describe("shouldPruneOutbound", () => {
  const prev = process.env.FORGE_REQUEST_PRUNE;
  const prevAt = process.env.FORGE_REQUEST_PRUNE_AT;

  afterEach(() => {
    if (prev === undefined) delete process.env.FORGE_REQUEST_PRUNE;
    else process.env.FORGE_REQUEST_PRUNE = prev;
    if (prevAt === undefined) delete process.env.FORGE_REQUEST_PRUNE_AT;
    else process.env.FORGE_REQUEST_PRUNE_AT = prevAt;
  });

  it("default is append-only under the 180k cliff", () => {
    delete process.env.FORGE_REQUEST_PRUNE;
    delete process.env.FORGE_REQUEST_PRUNE_AT;
    assert.deepEqual(shouldPruneOutbound(20_000), {
      prune: false,
      reason: "under_threshold",
    });
    assert.deepEqual(shouldPruneOutbound(REQUEST_PRUNE_AT_DEFAULT), {
      prune: true,
      reason: "threshold",
    });
  });

  it("FORGE_REQUEST_PRUNE=1 always prunes (legacy)", () => {
    process.env.FORGE_REQUEST_PRUNE = "1";
    assert.equal(shouldPruneOutbound(100).prune, true);
  });

  it("FORGE_REQUEST_PRUNE=0 never prunes", () => {
    process.env.FORGE_REQUEST_PRUNE = "0";
    assert.equal(shouldPruneOutbound(500_000).prune, false);
  });

  it("route window pulls the cliff forward on 256k, not on 500k", () => {
    delete process.env.FORGE_REQUEST_PRUNE;
    delete process.env.FORGE_REQUEST_PRUNE_AT;
    assert.equal(requestPruneAtTokens(), REQUEST_PRUNE_AT_DEFAULT);
    assert.equal(requestPruneAtTokens(500_000), REQUEST_PRUNE_AT_DEFAULT);
    assert.equal(requestPruneAtTokens(256_000), 140_800);
    assert.equal(shouldPruneOutbound(140_800, 256_000).prune, true);
    assert.equal(shouldPruneOutbound(140_800).prune, false);
    assert.equal(shouldPruneOutbound(140_800, 500_000).prune, false);
  });
});

describe("xAI chat sends x-grok-conv-id and keeps reasoning_content", () => {
  let prevFetch: typeof globalThis.fetch;
  let lastHeaders: Headers | undefined;
  let lastBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    prevFetch = globalThis.fetch;
    lastHeaders = undefined;
    lastBody = undefined;
  });
  afterEach(() => {
    globalThis.fetch = prevFetch;
  });

  function mockJson(payload: unknown) {
    globalThis.fetch = (async (_url, init) => {
      lastHeaders = new Headers(init?.headers);
      lastBody = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  const req: ChatRequest = {
    model: "grok-4.6",
    conversationId: "sess-abc",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "ok",
        reasoning_content: "prior thought",
      },
    ],
  };

  it("sets x-grok-conv-id on xAI requests and replays reasoning_content", async () => {
    mockJson({
      id: "c1",
      model: "grok-4.6",
      choices: [
        {
          message: {
            role: "assistant",
            content: "done",
            reasoning_content: "new thought",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
    const p = new OpenAICompatProvider({
      id: "xai",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "k",
    });
    const out = await p.chat(req);
    assert.equal(lastHeaders?.get(X_GROK_CONV_ID), "sess-abc");
    const msgs = lastBody?.messages as Array<{ reasoning_content?: string }>;
    assert.equal(msgs[1]?.reasoning_content, "prior thought");
    assert.equal(out.message.reasoning_content, "new thought");
  });

  it("empty-choices retry still sends x-grok-conv-id and reasoning_content", async () => {
    const { withRetry } = await import("../src/util/retry.js");
    const { isRetryableError } = await import("../src/util/retry.js");
    assert.equal(
      isRetryableError(new Error("xai API error: empty choices array (provider returned no completion — retry or switch model)")),
      true,
    );
    let calls = 0;
    const headers: Array<string | null> = [];
    const bodies: Array<string | undefined> = [];
    globalThis.fetch = (async (_url, init) => {
      calls += 1;
      headers.push(new Headers(init?.headers).get(X_GROK_CONV_ID));
      const parsed = JSON.parse(String(init?.body || "{}")) as {
        messages?: Array<{ reasoning_content?: string }>;
      };
      bodies.push(parsed.messages?.[1]?.reasoning_content);
      if (calls === 1) {
        return new Response(JSON.stringify({ id: "c0", model: "grok-4.6", choices: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "c1",
          model: "grok-4.6",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const p = new OpenAICompatProvider({
      id: "xai",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "k",
    });
    const out = await withRetry(() => p.chat(req), { retries: 2, baseDelayMs: 1 });
    assert.equal(calls, 2);
    assert.deepEqual(headers, ["sess-abc", "sess-abc"]);
    assert.deepEqual(bodies, ["prior thought", "prior thought"]);
    assert.equal(out.message.content, "ok");
  });

  it("does not send x-grok-conv-id for non-xAI providers", async () => {
    mockJson({
      id: "c1",
      model: "gpt",
      choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
    });
    const p = new OpenAICompatProvider({
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "k",
    });
    await p.chat({ ...req, conversationId: "sess-abc" });
    assert.equal(lastHeaders?.get(X_GROK_CONV_ID), null);
  });
});
