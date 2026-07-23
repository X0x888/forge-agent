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

  it("completes slash commands", () => {
    const hits = completeSlash("/go");
    assert.ok(hits.includes("/goal"));
    assert.deepEqual(completeSlash("hello"), []);
  });
});
