import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSession,
  markUserTurn,
  rewindSession,
  exportSessionMarkdown,
  maybeSetTitle,
  clearConversation,
} from "../src/session/session.js";
import { truncateMiddle, estimateCostUsd, formatTokens } from "../src/util/format.js";
import { isRetryableError } from "../src/util/retry.js";
import { completeSlash } from "../src/commands/slash.js";

describe("session helpers", () => {
  it("rewinds user turns", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sess-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    s.messages.push({ role: "system", content: "sys" });
    markUserTurn(s);
    s.messages.push({ role: "user", content: "one" });
    s.messages.push({ role: "assistant", content: "a1" });
    markUserTurn(s);
    s.messages.push({ role: "user", content: "two" });
    s.messages.push({ role: "assistant", content: "a2" });
    s.meta.turnCount = 2;
    const removed = rewindSession(s, 1);
    assert.ok(removed >= 2);
    assert.equal(s.messages.filter((m) => m.role === "user").length, 1);
    assert.equal(s.messages.at(-1)?.content, "a1");
  });

  it("sets title and exports markdown", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sess2-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    maybeSetTitle(s, "implement the auth flow please");
    assert.ok(s.meta.title?.includes("auth"));
    s.messages.push({ role: "user", content: "hi" });
    s.messages.push({ role: "assistant", content: "hello" });
    const md = exportSessionMarkdown(s);
    assert.match(md, /### user/);
    assert.match(md, /hello/);
    clearConversation(s);
    assert.equal(s.messages.filter((m) => m.role !== "system").length, 0);
  });
});

describe("git context formatting", () => {
  it("formats dirty ahead/behind details", async () => {
    const { formatGitForPrompt } = await import("../src/util/git-context.js");
    const s = formatGitForPrompt({
      root: "/repo",
      branch: "main",
      dirty: true,
      changedFiles: 3,
      ahead: 2,
      behind: 1,
      upstream: "origin/main",
      remote: "git@x:y.git",
    });
    assert.match(s, /main/);
    assert.match(s, /dirty, 3 files/);
    assert.match(s, /ahead 2/);
    assert.match(s, /behind 1/);
    assert.match(s, /origin\/main/);
  });
});

describe("format + slash complete", () => {
  it("truncates middle preserving head and tail", () => {
    const s = "A".repeat(100) + "MID" + "B".repeat(100);
    const t = truncateMiddle(s, 80);
    assert.ok(t.startsWith("A"));
    assert.ok(t.endsWith("B"));
    assert.match(t, /omitted/);
  });

  it("estimates cost and formats tokens", () => {
    assert.equal(formatTokens(500), "500");
    assert.ok(formatTokens(12_000).includes("k"));
    assert.ok(estimateCostUsd("xai", 1_000_000, 0) > 0);
  });

  it("classifies retryable errors", () => {
    assert.equal(isRetryableError(new Error("API error 429 rate limit")), true);
    assert.equal(isRetryableError(new Error("Aborted")), false);
    assert.equal(isRetryableError(new Error("invalid api key")), false);
  });

  it("does not retry context overflow", async () => {
    const {
      isContextOverflowError,
      isRetryableError: retryable,
      withRetry,
    } = await import("../src/util/retry.js");
    const { ProviderApiError } = await import("../src/providers/errors.js");
    const overflow = new Error(
      "API error 400: This model's maximum context length is 128000 tokens",
    );
    assert.equal(isContextOverflowError(overflow), true);
    assert.equal(retryable(overflow), false);
    assert.equal(
      isContextOverflowError(
        new ProviderApiError({
          provider: "xai",
          status: 400,
          body: "context_length_exceeded: reduce the length of the messages",
        }),
      ),
      true,
    );
    // Real xAI grok-4.5 wording (was missed by older regex → ULW died at ~85%)
    assert.equal(
      isContextOverflowError(
        new Error(
          '✖ xai API error 400: {"code":"invalid-argument","error":"This model\'s maximum prompt length is 500000 but the request contains 500644 tokens."}',
        ),
      ),
      true,
    );
    assert.equal(
      isContextOverflowError(
        new ProviderApiError({
          provider: "xai",
          status: 400,
          body: JSON.stringify({
            code: "invalid-argument",
            error:
              "This model's maximum prompt length is 500000 but the request contains 500644 tokens.",
          }),
        }),
      ),
      true,
    );
    assert.equal(
      isContextOverflowError(
        new ProviderApiError({
          provider: "openai",
          status: 413,
          body: "payload too large",
        }),
      ),
      true,
    );
    assert.equal(retryable(new Error("API error 503 overloaded")), true);
    assert.equal(
      isContextOverflowError(new Error("invalid api key")),
      false,
    );

    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw overflow;
          },
          { retries: 3, baseDelayMs: 1, maxDelayMs: 5 },
        ),
      /maximum context length/i,
    );
    assert.equal(calls, 1, "overflow must not be retried with same payload");
  });

  it("estimates tokens conservatively and prunes oversized bodies", async () => {
    const {
      estimateTokens,
      estimateRequestTokens,
      pruneOversizedMessageBodies,
    } = await import("../src/session/session.js");
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "hello world" },
      {
        role: "tool" as const,
        tool_call_id: "t1",
        content: "X".repeat(20_000),
      },
    ];
    const est = estimateTokens(messages);
    // chars/3.2 + framing must exceed naive chars/4
    const naive = Math.ceil(
      ("sys".length + "hello world".length + 20_000 + "t1".length + 12) / 4,
    );
    assert.ok(est > naive, `expected conservative est ${est} > naive ${naive}`);
    const withTools = estimateRequestTokens(messages, { toolsJsonChars: 5_000 });
    assert.ok(withTools > est);

    const pruned = pruneOversizedMessageBodies(messages, {
      maxToolChars: 1_000,
      maxAssistantChars: 2_000,
      maxToolArgChars: 500,
    });
    assert.ok(pruned.pruned >= 1);
    assert.ok((pruned.messages[2].content || "").length < 20_000);
    assert.match(pruned.messages[2].content || "", /pruned/i);
  });

  it("completes slash commands", () => {
    const hits = completeSlash("/go");
    assert.ok(hits.includes("/goal"));
    assert.deepEqual(completeSlash("hello"), []);
  });
});
