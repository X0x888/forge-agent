/**
 * Expert-facing provider error recovery tips.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderApiError,
  formatProviderError,
  formatProviderErrorText,
} from "../src/providers/errors.js";

describe("formatProviderError", () => {
  it("formats 401 with login tips", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 401,
      body: JSON.stringify({ error: { message: "Invalid API key" } }),
    });
    const f = formatProviderError(err, { model: "grok-4.5" });
    assert.equal(f.code, "auth_expired");
    assert.match(f.message, /HTTP 401/);
    assert.match(f.message, /Invalid API key/);
    assert.match(f.message, /grok-4\.5/);
    assert.ok(f.tips.some((t) => /forge login/i.test(t)));
    const text = formatProviderErrorText(err, { model: "grok-4.5" });
    assert.match(text, /✖ /);
    assert.match(text, /\[auth_expired\]/);
    assert.match(text, /→/);
    assert.match(text, /Next  forge login/);
    assert.doesNotMatch(text, /Error\?/);
    const repl = formatProviderErrorText(err, { model: "grok-4.5", repl: true });
    assert.match(repl, /^✖ /);
    assert.match(repl, /Next  \/auth/);
    assert.match(repl, /\/retry/);
    assert.doesNotMatch(repl, /Next  forge login/);
    assert.doesNotMatch(repl, /forge login/);
    assert.ok(
      [...repl.matchAll(/→/g)].length <= 1,
      "REPL card is at most one tip, not a lecture",
    );
  });

  it("Next keys wrap at · on a narrow TTY", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 429,
      body: "rate limit exceeded",
      retryAfterMs: 15_000,
    });
    const repl = formatProviderErrorText(err, { repl: true, columns: 18 });
    assert.match(repl, /Next  /);
    assert.match(repl, /\n  ·  /);
    assert.doesNotMatch(repl, /bck-i-search/);
    assert.doesNotMatch(repl, /Error\?/);
  });

  it("formats 429 with Retry-After and account switch tips", () => {
    const err = new ProviderApiError({
      provider: "anthropic",
      status: 429,
      body: "rate limit exceeded",
      retryAfterMs: 15_000,
    });
    const f = formatProviderError(err);
    assert.equal(f.code, "rate_limited");
    assert.match(f.message, /Retry-After 15s/);
    assert.ok(f.tips.some((t) => /accounts switch/i.test(t)));
  });

  it("formats context overflow 400", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 400,
      body: "This model's maximum prompt length is 500000 but the request contains 500644 tokens.",
    });
    const f = formatProviderError(err);
    assert.equal(f.code, "context_overflow");
    assert.ok(f.tips.some((t) => /compact/i.test(t)));
  });

  it("formats 5xx as retryable provider error", () => {
    const err = new ProviderApiError({
      provider: "openai",
      status: 503,
      body: "internal server error",
    });
    const f = formatProviderError(err);
    assert.equal(f.code, "provider_5xx");
    assert.ok(f.tips.some((t) => /retry/i.test(t)));
  });

  it("formats overloaded 503 body as provider_overloaded", () => {
    const err = new ProviderApiError({
      provider: "openai",
      status: 503,
      body: "overloaded",
    });
    const f = formatProviderError(err);
    assert.equal(f.code, "provider_overloaded");
    assert.ok(f.tips.some((t) => /retry/i.test(t)));
  });

  it("formats network / timeout plain errors", () => {
    const net = formatProviderError(new Error("fetch failed"));
    assert.equal(net.code, "network");
    const term = formatProviderError(new Error("terminated"));
    assert.equal(term.code, "network");
    assert.ok(term.tips.some((t) => /retries|OAuth|continue/i.test(t)));
    const http2 = formatProviderError(
      Object.assign(
        new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR"),
        { code: "ERR_HTTP2_STREAM_ERROR" },
      ),
      { provider: "cursor" },
    );
    assert.equal(http2.code, "network");
    assert.ok(http2.tips.some((t) => /HTTP\/2|reconnect/i.test(t)));
    assert.ok(http2.tips.some((t) => /compact/i.test(t)));
    assert.equal(
      http2.tips.some((t) => /refresh(?:es)? OAuth/i.test(t)),
      false,
      "HTTP/2 RST is not an OAuth refresh",
    );
    const card = formatProviderErrorText(
      Object.assign(
        new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR"),
        { code: "ERR_HTTP2_STREAM_ERROR" },
      ),
      { provider: "cursor", repl: true, columns: 80 },
    );
    assert.match(card, /^✖ Stream closed/);
    assert.doesNotMatch(card, /✖ ✖/);
    assert.match(card, /\[network\]/);
    const to = formatProviderError(new Error("Provider timed out after 600000ms"));
    assert.equal(to.code, "timeout");
    assert.ok(
      to.tips.some((t) => /FORGE_PROVIDER_REASONING_WALL_MS/.test(t)),
      "timeout card names the no-output reasoning wall",
    );
    const ab = formatProviderError(new Error("Aborted"));
    assert.equal(ab.code, "aborted");
  });

  it("formats 404 with models tip", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 404,
      body: "model not found",
    });
    const f = formatProviderError(err);
    assert.equal(f.code, "not_found");
    assert.ok(f.tips.some((t) => /forge models/i.test(t)));
  });

  it("formats content_filter plain errors", () => {
    const f = formatProviderError(new Error("Response blocked by content filter"));
    assert.equal(f.code, "content_filter");
    assert.ok(f.tips.some((t) => /rephrase|model/i.test(t)));
  });

  it("classifies 403 quota/billing as quota_exhausted (not auth_forbidden)", () => {
    const err = new ProviderApiError({
      provider: "openai",
      status: 403,
      body: JSON.stringify({
        error: { message: "You exceeded your current quota", type: "insufficient_quota" },
      }),
    });
    const f = formatProviderError(err);
    assert.equal(f.code, "quota_exhausted");
    assert.ok(f.tips.some((t) => /accounts switch|status/i.test(t)));
  });

  it("classifies 402 Payment Required as quota_exhausted", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 402,
      body: "Payment Required",
    });
    const f = formatProviderError(err);
    assert.equal(f.code, "quota_exhausted");
  });

  it("classifies Anthropic 529 / overloaded bodies as provider_overloaded", () => {
    const overloaded529 = formatProviderError(
      new ProviderApiError({
        provider: "anthropic",
        status: 529,
        body: JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }),
      }),
    );
    assert.equal(overloaded529.code, "provider_overloaded");
    assert.ok(overloaded529.tips.some((t) => /retry|switch|model/i.test(t)));

    const plain = formatProviderError(new Error("overloaded_error: capacity"));
    assert.equal(plain.code, "provider_overloaded");

    const e529 = new ProviderApiError({
      provider: "anthropic",
      status: 529,
      body: "Overloaded",
    });
    assert.equal(e529.isRetryable, true);
  });

  it("classifies model-not-found plain errors and 404 bodies", () => {
    const plain = formatProviderError(new Error("model_not_found: grok-9"), {
      provider: "xai",
    });
    assert.equal(plain.code, "not_found");
    assert.ok(plain.tips.some((t) => /forge models/i.test(t)));

    const http = formatProviderError(
      new ProviderApiError({
        provider: "openai",
        status: 400,
        body: JSON.stringify({ error: { message: "The model `gpt-9` does not exist" } }),
      }),
    );
    assert.equal(http.code, "not_found");
  });

  it("classifies DNS / ENOTFOUND as network", () => {
    const dns = formatProviderError(new Error("getaddrinfo ENOTFOUND api.x.ai"));
    assert.equal(dns.code, "network");
    assert.ok(dns.tips.some((t) => /DNS|network|VPN/i.test(t)));
  });

  it("classifies plain insufficient_quota text as quota_exhausted", () => {
    const f = formatProviderError(new Error("Error: insufficient_quota"));
    assert.equal(f.code, "quota_exhausted");
  });

  it("classifies Anthropic 'prompt is too long' as context_overflow", () => {
    const err = new ProviderApiError({
      provider: "anthropic",
      status: 400,
      body: JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "prompt is too long: 200000 tokens > 100000 maximum",
        },
      }),
    });
    const f = formatProviderError(err);
    assert.equal(f.code, "context_overflow");
    assert.ok(f.tips.some((t) => /compact/i.test(t)));
  });

  it("classifies xAI serde hex-escape 400 as retryable JSON unicode", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 400,
      body: JSON.stringify({
        error: {
          message:
            "Failed to parse the request body as JSON: messages[20].content: unexpected end of hex escape at line 1 column 117666",
        },
      }),
    });
    const f = formatProviderError(err, { provider: "xai", model: "grok-4.6" });
    assert.equal(f.code, "bad_request");
    assert.ok(f.tips.some((t) => /retry/i.test(t)));
    assert.ok(f.tips.some((t) => /surrogate|emoji/i.test(t)));
  });

  it("does not over-classify generic 'does not exist' / bare billing as model/quota", () => {
    const fileMissing = formatProviderError(
      new ProviderApiError({
        provider: "openai",
        status: 400,
        body: "file does not exist",
      }),
    );
    assert.equal(fileMissing.code, "bad_request");

    const billingAddr = formatProviderError(
      new ProviderApiError({
        provider: "openai",
        status: 400,
        body: "invalid billing address",
      }),
    );
    assert.equal(billingAddr.code, "bad_request");
  });

  it("classifies Azure content-management policy + HTTP content_filter as content_filter", () => {
    const azure = formatProviderError(
      new Error(
        "The response was filtered due to the prompt triggering Azure OpenAI's content management policy",
      ),
    );
    assert.equal(azure.code, "content_filter");
    assert.ok(azure.tips.some((t) => /rephrase|model/i.test(t)));

    const http = formatProviderError(
      new ProviderApiError({
        provider: "openai",
        status: 400,
        body: JSON.stringify({
          error: { code: "content_filter", message: "content filter" },
        }),
      }),
    );
    assert.equal(http.code, "content_filter");
  });

  it("classifies empty/no-choice model responses", () => {
    for (const msg of [
      "empty response from model",
      "No completion choices returned",
      "stream ended without choices",
      "Received empty completion from provider",
      "choices array is empty",
    ]) {
      const f = formatProviderError(new Error(msg));
      assert.equal(f.code, "empty_response", msg);
      assert.ok(f.tips.some((t) => /retry/i.test(t)), msg);
    }
  });

  it("classifies policy-violation phrasing as content_filter", () => {
    const f = formatProviderError(new Error("policy violation detected by safety system"));
    assert.equal(f.code, "content_filter");
  });

  it("classifies unsupported model features / org verification / deprecated model", () => {
    const tools = formatProviderError(
      new Error("tools is not supported with this model"),
      { provider: "openai" },
    );
    assert.equal(tools.code, "unsupported_feature");
    assert.ok(tools.tips.some((t) => /model/i.test(t)));

    const http = formatProviderError(
      new ProviderApiError({
        provider: "openai",
        status: 400,
        body: JSON.stringify({
          error: {
            message: "tools is not supported with this model",
            code: "unsupported_value",
          },
        }),
      }),
    );
    assert.equal(http.code, "unsupported_feature");

    const org = formatProviderError(
      new Error("Your organization must be verified to use this model"),
    );
    assert.equal(org.code, "org_verification");

    const dep = formatProviderError(new Error("model is deprecated"), {
      provider: "xai",
    });
    assert.equal(dep.code, "model_deprecated");
    assert.ok(dep.tips.some((t) => /forge models/i.test(t)));
  });

  it("classifies Cursor Connect internal as protocol, not tools/vision", () => {
    const f = formatProviderError(
      new ProviderApiError({
        provider: "cursor",
        status: 400,
        body: "internal: Error",
      }),
      { model: "cursor-grok-4.6-xhigh-fast" },
    );
    assert.equal(f.code, "protocol_error");
    assert.ok(f.tips.some((t) => /fresh conversation|protocol/i.test(t)));
    assert.ok(f.tips.some((t) => /compact/i.test(t)));
    assert.equal(f.tips.some((t) => /tools\/vision/i.test(t)), false);
  });
});

describe("log.error does not double-prefix formatted cards", () => {
  it("leaves an existing ✖ headline alone", async () => {
    const { log } = await import("../src/util/log.js");
    const { formatProviderErrorText } = await import(
      "../src/providers/errors.js"
    );
    const err = Object.assign(
      new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR"),
      { code: "ERR_HTTP2_STREAM_ERROR" },
    );
    const card = formatProviderErrorText(err, {
      provider: "cursor",
      repl: true,
      columns: 80,
    });
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(String(args[0] ?? ""));
    };
    try {
      log.error(card);
    } finally {
      console.error = orig;
    }
    assert.equal(lines.length, 1);
    const plain = lines[0]!.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain, /^✖ Stream closed/);
    assert.doesNotMatch(plain, /✖ ✖/);
  });
});
