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
    assert.match(text, /\[auth_expired\]/);
    assert.match(text, /→/);
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
      body: "overloaded",
    });
    const f = formatProviderError(err);
    assert.equal(f.code, "provider_5xx");
    assert.ok(f.tips.some((t) => /retry/i.test(t)));
  });

  it("formats network / timeout plain errors", () => {
    const net = formatProviderError(new Error("fetch failed"));
    assert.equal(net.code, "network");
    const to = formatProviderError(new Error("Provider timed out after 600000ms"));
    assert.equal(to.code, "timeout");
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
});
