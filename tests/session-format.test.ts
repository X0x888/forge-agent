import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSession,
  markUserTurn,
  rewindSession,
  lastUserText,
  formatRecentTurns,
  formatResumePeek,
  exportSessionMarkdown,
  maybeSetTitle,
  deriveSessionTitle,
  clearConversation,
  setSessionTitle,
  saveSession,
  setSessionLastError,
  formatSessionLookupMiss,
  listSessionLookupSuggestions,
  formatSessionShareCard,
  formatResumeOrientation,
  formatSessionPickerRow,
  exportSessionJson,
  importSessionJson,
  isLastVerificationStale,
} from "../src/session/session.js";
import { truncateMiddle, estimateCostUsd, formatTokens, visibleWidth } from "../src/util/format.js";
import { isRetryableError } from "../src/util/retry.js";
import {
  completeSlash,
  formatUnknownSlash,
  handleSlash,
  suggestSlashCommands,
} from "../src/commands/slash.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";

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
    assert.equal(lastUserText(s), "two");
    const removed = rewindSession(s, 1);
    assert.ok(removed >= 2);
    assert.equal(s.messages.filter((m) => m.role === "user").length, 1);
    assert.equal(s.messages.at(-1)?.content, "a1");
    assert.equal(lastUserText(s), "one");
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

  it("/retry rewinds and forwards the last prompt", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-retry-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    markUserTurn(s);
    s.messages.push({ role: "user", content: "fix the flaky test" });
    s.messages.push({ role: "assistant", content: "I tried X" });
    s.meta.turnCount = 1;
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/retry", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.equal(r.forwardPrompt, "fix the flaky test");
    assert.match(r.output || "", /Retrying last turn/);
    assert.equal(s.messages.filter((m) => m.role === "user").length, 0);
    assert.equal(lastUserText(s), "");
  });

  it("/retry with rewrite uses the new prompt", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-retry2-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    markUserTurn(s);
    s.messages.push({ role: "user", content: "old approach" });
    s.messages.push({ role: "assistant", content: "done poorly" });
    s.meta.turnCount = 1;
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/again try a different approach", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.forwardPrompt, "try a different approach");
    assert.match(r.output || "", /rewritten prompt/);
  });

  it("/retry with empty session is a no-op", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-retry3-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/retry", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.equal(r.forwardPrompt, undefined);
    assert.match(r.output || "", /Nothing to retry/);
  });

  it("formatRecentTurns peeks last N user/assistant turns", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-last-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
      title: "peek-demo",
    });
    s.messages.push({ role: "system", content: "sys" });
    s.messages.push({ role: "user", content: "first task" });
    s.messages.push({
      role: "assistant",
      content: "did first",
      tool_calls: [
        {
          id: "1",
          type: "function",
          function: { name: "bash", arguments: "{}" },
        },
      ],
    });
    s.messages.push({ role: "tool", tool_call_id: "1", content: "ok" });
    s.messages.push({ role: "user", content: "second task please" });
    s.messages.push({ role: "assistant", content: "did second thoroughly" });
    const one = formatRecentTurns(s, { turns: 1 });
    assert.match(one, /Last 1 turn/);
    assert.match(one, /second task/);
    assert.doesNotMatch(one, /first task/);
    const two = formatRecentTurns(s, { turns: 2 });
    assert.match(two, /first task/);
    assert.match(two, /second task/);
    assert.match(two, /tools: bash/);
    assert.match(two, /peek-demo/);
  });

  it("formatRecentTurns and lastUserText skip harness injections", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-last-synth-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
      title: "synth-skip",
    });
    s.messages.push({ role: "user", content: "ship the dock clip" });
    s.messages.push({ role: "assistant", content: "clipped live ›" });
    s.messages.push({
      role: "user",
      content:
        "[Forge harness — mid-conversation update]\nObey this state over earlier harness messages.",
    });
    s.messages.push({ role: "assistant", content: "still working on clip" });
    assert.equal(lastUserText(s), "ship the dock clip");
    const peek = formatRecentTurns(s, { turns: 1 });
    assert.match(peek, /ship the dock clip/);
    assert.doesNotMatch(peek, /Forge harness/);
    assert.match(peek, /still working on clip/);
  });

  it("formatRecentTurns clips each row to one TTY line", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-last-clip-"));
    process.env.FORGE_HOME = tmp;
    const { createSession: mk, formatRecentTurns } = await import(
      "../src/session/session.js"
    );
    const { visibleWidth } = await import("../src/util/format.js");
    const s = mk({
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
      title: "very-long-session-title-that-would-wrap",
    });
    s.messages.push({
      role: "user",
      content: `please ${"do this and that ".repeat(20)}`,
    });
    s.messages.push({
      role: "assistant",
      content: `ok ${"working through the request ".repeat(12)}`,
    });
    const stdout = process.stdout as NodeJS.WriteStream & { columns?: number };
    const prevCols = stdout.columns;
    const prevTty = stdout.isTTY;
    stdout.isTTY = true;
    stdout.columns = 40;
    try {
      const text = formatRecentTurns(s, { turns: 1, maxChars: 400 });
      assert.doesNotMatch(text, /Tip:/);
      for (const row of text.split("\n").filter(Boolean)) {
        assert.ok(visibleWidth(row) <= 40, JSON.stringify(row));
      }
    } finally {
      stdout.columns = prevCols;
      stdout.isTTY = prevTty;
    }
  });

  it("/last is handled and live-safe", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-last-slash-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    s.messages.push({ role: "user", content: "hello world" });
    s.messages.push({ role: "assistant", content: "hi there" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/last 1", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(r.output || "", /hello world/);
    assert.match(r.output || "", /hi there/);
  });

  it("formatResumePeek is compact and empty for fresh sessions", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-peek-"));
    process.env.FORGE_HOME = tmp;
    const empty = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    assert.equal(formatResumePeek(empty), "");
    empty.messages.push({ role: "user", content: "ship the feature" });
    empty.messages.push({ role: "assistant", content: "shipped it" });
    const peek = formatResumePeek(empty);
    assert.match(peek, /ship the feature/);
    assert.match(peek, /shipped it/);
    assert.doesNotMatch(peek, /^Tip:/m);
  });

  it("formatResumePeek is empty when only harness injections exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-synth-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    s.messages.push({
      role: "user",
      content: "[Forge harness — mid-conversation update]\nULW ON",
    });
    assert.equal(formatResumePeek(s), "");
    s.messages.push({ role: "user", content: "ship the dock clip" });
    s.messages.push({ role: "assistant", content: "clipped" });
    s.messages.push({
      role: "user",
      content: "[Forge harness — mid-conversation update]\nwave 2",
    });
    const peek = formatResumePeek(s);
    assert.match(peek, /ship the dock clip/);
    assert.doesNotMatch(peek, /Forge harness/);
  });

  it("saveSession stores lastUserPreview for list pickers", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lup-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession: mk,
      saveSession,
      listSessions,
      loadSessionMeta,
    } = await import("../src/session/session.js");
    const s = mk({ cwd: tmp, provider: "xai", model: "m", title: "t" });
    s.messages.push({
      role: "user",
      content: "fix the flaky auth test please",
    });
    s.messages.push({ role: "assistant", content: "ok" });
    saveSession(s);
    assert.equal(s.meta.lastUserPreview, "fix the flaky auth test please");
    const meta = loadSessionMeta(s.meta.id);
    assert.equal(meta?.lastUserPreview, "fix the flaky auth test please");
    const hit = listSessions({ cwd: tmp, query: "flaky auth", limit: 10 });
    assert.ok(hit.some((m) => m.id === s.meta.id));
  });

  it("formatSessionSummary includes last-turn peek", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-summary-peek-"));
    process.env.FORGE_HOME = tmp;
    const { formatSessionSummary } = await import("../src/session/session.js");
    const s = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
      title: "demo",
    });
    s.messages.push({ role: "user", content: "inspect me later" });
    s.messages.push({
      role: "assistant",
      content: "ready for show",
      tool_calls: [
        {
          id: "1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "src/shown.ts", content: "x" }),
          },
        },
      ],
    });
    const summary = formatSessionSummary(s);
    assert.match(summary, /demo/);
    assert.match(summary, /inspect me later/);
    assert.match(summary, /ready for show/);
    assert.match(summary, /src\/shown\.ts/);
    assert.match(summary, /\(/); // relative age on updated line
  });

  it("formatSessionSummary includes last-verify", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-summary-verify-"));
    process.env.FORGE_HOME = tmp;
    const { formatSessionSummary } = await import("../src/session/session.js");
    const s = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
      title: "verify-show",
    });
    s.meta.lastVerificationCommand = "npm test";
    s.meta.lastVerificationAt = "2026-04-10T12:34:56.000Z";
    const summary = formatSessionSummary(s);
    assert.match(summary, /last-verify:\s+npm test/);
    assert.match(summary, /2026-04-10 12:34:56/);
  });

  it("/resume includes last-turn peek", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-out-"));
    process.env.FORGE_HOME = tmp;
    const target = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    target.messages.push({ role: "user", content: "continue the migration" });
    target.messages.push({ role: "assistant", content: "migration half done" });
    const { saveSession } = await import("../src/session/session.js");
    saveSession(target);
    const current = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash(`/resume ${target.meta.id.slice(0, 8)}`, {
      session: current,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /Resumed/i);
    assert.match(String(r.output || ""), /continue the migration/);
    assert.match(String(r.output || ""), /\/last 3/);
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
    assert.equal(isRetryableError(new Error("terminated")), true);
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

it("unknown slash suggests close command names", async () => {
    // transposition / single-letter typos common at the REPL
    const exportHits = suggestSlashCommands("/exprot");
    assert.ok(exportHits.includes("/export"), String(exportHits));
    const helpHits = suggestSlashCommands("/hepl");
    assert.ok(helpHits.includes("/help"), String(helpHits));
    assert.equal(helpHits[0], "/help", String(helpHits));
    const msg = formatUnknownSlash("/exprot");
    assert.match(msg, /Did you mean/);
    assert.match(msg, /\/export/);
    assert.match(msg, /Type \/help/);

    const s = createSession({
      cwd: process.cwd(),
      provider: "xai",
      model: "m",
    });
    const r = await handleSlash("/exprot", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks: new HookRunner(DEFAULT_CONFIG, process.cwd()),
    });
    assert.equal(r.handled, true);
    assert.match(r.output || "", /Did you mean/);
    assert.match(r.output || "", /\/export/);

    // gibberish: no false-positive suggestions
    const none = suggestSlashCommands("/zzzznotacommand");
    assert.deepEqual(none, []);
    assert.match(formatUnknownSlash("/zzzznotacommand"), /Type \/help for commands/);
  });

it("/permissions mode typos suggest canonical names", async () => {
    const s = createSession({
      cwd: process.cwd(),
      provider: "xai",
      model: "m",
    });
    const hooks = new HookRunner(DEFAULT_CONFIG, process.cwd());
    const r = await handleSlash("/permissions aceptEdits", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.match(r.output || "", /Did you mean: acceptEdits/);
  });

it("/model catalog typos suggest instead of saving broken id", async () => {
    const s = createSession({
      cwd: process.cwd(),
      provider: "xai",
      model: "grok-4.5",
    });
    const hooks = new HookRunner(DEFAULT_CONFIG, process.cwd());
    const r = await handleSlash("/model grok-45", {
      session: s,
      config: { ...DEFAULT_CONFIG, provider: "xai", model: "grok-4.5" },
      hooks,
    });
    assert.match(r.output || "", /Did you mean: grok-4\.5/);
    // free-form non-typo still accepted
    const r2 = await handleSlash("/model my-custom-finetune-v3", {
      session: s,
      config: { ...DEFAULT_CONFIG, provider: "xai", model: "grok-4.5" },
      hooks,
    });
    assert.match(r2.output || "", /Model set to (xai\/)?my-custom-finetune-v3/);
  });

it("session lookup miss suggests title typos", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-title-typo-"));
    process.env.FORGE_HOME = tmp;
    const a = createSession({ cwd: tmp, provider: "xai", model: "m" });
    setSessionTitle(a, "alpha-project");
    saveSession(a);
    const msg = formatSessionLookupMiss("alpa-project", { cwd: tmp });
    assert.match(msg, /Did you mean/);
    assert.match(msg, /alpha-project/);
    const none = formatSessionLookupMiss("zzzznope-unique", { cwd: tmp });
    assert.doesNotMatch(none, /Did you mean/);
  });

it("/sessions action typos suggest canonical names", async () => {
    const s = createSession({
      cwd: process.cwd(),
      provider: "xai",
      model: "m",
    });
    const hooks = new HookRunner(DEFAULT_CONFIG, process.cwd());
    const r = await handleSlash("/sessions prun", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.match(r.output || "", /Did you mean: prune/);
    const r2 = await handleSlash("/sessions serach x", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.match(r2.output || "", /Did you mean: search/);
    // real title query still searches
    const r3 = await handleSlash("/sessions incident-42", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.match(r3.output || "", /No sessions matching|incident-42/i);
  });

it("slash count args fail closed on garbage", async () => {
    const s = createSession({
      cwd: process.cwd(),
      provider: "xai",
      model: "m",
    });
    s.messages.push({ role: "user", content: "hi" });
    s.messages.push({ role: "assistant", content: "hello" });
    const hooks = new HookRunner(DEFAULT_CONFIG, process.cwd());
    const ctx = { session: s, config: DEFAULT_CONFIG, hooks };

    const last = await handleSlash("/last abc", ctx);
    assert.match(last.output || "", /Invalid \/last count/);

    const news = await handleSlash("/news abc", ctx);
    assert.match(news.output || "", /Invalid \/news count/);
    const news0 = await handleSlash("/news 0", ctx);
    assert.match(news0.output || "", /Invalid \/news count/);
    const news11 = await handleSlash("/news 11", ctx);
    assert.match(news11.output || "", /Invalid \/news count|1–10/);

    const stats = await handleSlash("/stats abc", ctx);
    assert.match(stats.output || "", /Invalid \/stats window/);

    const logs = await handleSlash("/logs abc", ctx);
    assert.match(logs.output || "", /Invalid \/logs arg/);

    const files = await handleSlash("/files abc", ctx);
    assert.match(files.output || "", /Invalid \/files arg/);
    const files0 = await handleSlash("/files 0", ctx);
    assert.match(files0.output || "", /Invalid \/files limit/);
    const files201 = await handleSlash("/files 201", ctx);
    assert.match(files201.output || "", /Invalid \/files limit/);

    const rewind = await handleSlash("/rewind abc", ctx);
    assert.match(rewind.output || "", /Invalid \/rewind count/);
    const undo0 = await handleSlash("/undo 0", ctx);
    assert.match(undo0.output || "", /Invalid \/undo count/);
    const undo101 = await handleSlash("/undo 101", ctx);
    assert.match(undo101.output || "", /Invalid \/undo count|1–100/);

    const last21 = await handleSlash("/last 21", ctx);
    assert.match(last21.output || "", /Invalid \/last count|1–20/);
    const lastMc = await handleSlash("/last 1 10", ctx);
    assert.match(lastMc.output || "", /Invalid \/last max-chars|40–2000/);

    // valid paths still work
    const lastOk = await handleSlash("/last 1", ctx);
    assert.match(lastOk.output || "", /turn/i);
    const newsOk = await handleSlash("/news", ctx);
    assert.match(newsOk.output || "", /Forge|what's new|0\.9/i);
  });

it("/fork includes last-turn peek", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fork-peek-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    s.messages.push({ role: "user", content: "before fork" });
    s.messages.push({ role: "assistant", content: "ready to fork" });
    // Optional ULW so harness-copy line is exercised when present
    try {
      const { armUlwCycle } = await import("../src/harness/ulw-cycle.js");
      armUlwCycle(s.meta.id, "keep going", { cycle: 1 });
      s.meta.ultrawork = true;
    } catch {
      /* optional */
    }
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/fork experiment", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.ok(r.replaceSession);
    assert.match(String(r.output || ""), /Forked session/i);
    assert.match(String(r.output || ""), /before fork|ready to fork/);
    assert.match(String(r.output || ""), /\/last 3/);
    assert.match(String(r.output || ""), /Harness copied:.*ULW/i);
  });

  it("resolveSessionId matches unique title and lastUserPreview", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resolve-title-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession: mk,
      saveSession,
      setSessionTitle,
      resolveSessionId,
      formatSessionLookupMiss,
      loadSession,
    } = await import("../src/session/session.js");
    const a = mk({ cwd: tmp, provider: "xai", model: "m" });
    setSessionTitle(a, "auth-migration");
    a.messages.push({ role: "user", content: "port the oauth flow" });
    saveSession(a);
    const b = mk({ cwd: tmp, provider: "xai", model: "m" });
    setSessionTitle(b, "docs-pass");
    b.messages.push({ role: "user", content: "rewrite the README" });
    saveSession(b);

    assert.equal(resolveSessionId("auth-migration"), a.meta.id);
    assert.equal(resolveSessionId("AUTH-MIGRATION"), a.meta.id);
    assert.equal(resolveSessionId("oauth flow"), a.meta.id);
    assert.equal(resolveSessionId(a.meta.id.slice(0, 8)), a.meta.id);
    const loaded = loadSession("docs-pass");
    assert.equal(loaded?.meta.id, b.meta.id);

    // Ambiguous substring → null + helpful miss text
    const c = mk({ cwd: tmp, provider: "xai", model: "m" });
    setSessionTitle(c, "auth-cleanup");
    saveSession(c);
    assert.equal(resolveSessionId("auth"), null);
    const miss = formatSessionLookupMiss("auth");
    assert.match(miss, /Ambiguous|matches/i);
    assert.match(miss, /auth-migration|auth-cleanup/);
  });

  it("resolveSessionDir and show path line", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-path-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession: mk,
      saveSession,
      resolveSessionDir,
      resolveSessionJsonPath,
      formatSessionSummary,
    } = await import("../src/session/session.js");
    const s = mk({ cwd: tmp, provider: "xai", model: "m", title: "path-demo" });
    saveSession(s);
    const dir = resolveSessionDir("path-demo");
    assert.ok(dir && dir.includes(s.meta.id));
    const jp = resolveSessionJsonPath(s.meta.id.slice(0, 8));
    assert.ok(jp && jp.endsWith("session.json"));
    assert.match(formatSessionSummary(s), /path:\s+/);
    assert.match(formatSessionSummary(s), /path-demo|pinned/);
  });

  it("/path prints session directory", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-path-slash-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/path", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /Session dir:/);
    assert.match(String(r.output || ""), /session\.json/);
    const j = await handleSlash("/path json", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.match(String(j.output || ""), /session\.json$/);
  });

  it("formatResumeOrientation includes mutated files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-orient-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession: mk,
      formatResumeOrientation,
    } = await import("../src/session/session.js");
    const s = mk({ cwd: tmp, provider: "xai", model: "m" });
    s.messages.push({ role: "user", content: "ship the patch" });
    s.messages.push({
      role: "assistant",
      content: "patched",
      tool_calls: [
        {
          id: "1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "src/orient.ts", content: "x" }),
          },
        },
      ],
    });
    const o = formatResumeOrientation(s);
    assert.match(o, /ship the patch|patched/);
    assert.match(o, /src\/orient\.ts/);
    assert.match(o, /\/files/);
  });

  it("formatResumeOrientation compact skips Checks/memory/checkpoint", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-orient-c-"));
    process.env.FORGE_HOME = tmp;
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "orient-c", scripts: { test: "node --test" } }),
    );
    const {
      createSession: mk,
      formatResumeOrientation,
    } = await import("../src/session/session.js");
    const s = mk({ cwd: tmp, provider: "xai", model: "m" });
    s.messages.push({ role: "user", content: "ship the patch" });
    s.messages.push({
      role: "assistant",
      content: "patched",
      tool_calls: [
        {
          id: "1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "src/orient.ts", content: "x" }),
          },
        },
      ],
    });
    s.meta.editCount = 2;
    s.meta.maxCostUsd = 5;
    const full = formatResumeOrientation(s);
    const compact = formatResumeOrientation(s, { compact: true });
    assert.match(full, /Checks:/);
    assert.doesNotMatch(compact, /Checks:/);
    assert.doesNotMatch(compact, /Project memory:/);
    assert.doesNotMatch(compact, /Checkpoint:/);
    assert.match(compact, /src\/orient\.ts/);
    assert.match(compact, /Last verify:/);
  });

  it("listSessions filters pinned", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-list-pin-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession: mk,
      setSessionPinned,
      saveSession,
      listSessions,
    } = await import("../src/session/session.js");
    const a = mk({ cwd: tmp, provider: "xai", model: "m", title: "a" });
    setSessionPinned(a, true);
    saveSession(a);
    const b = mk({ cwd: tmp, provider: "xai", model: "m", title: "b" });
    saveSession(b);
    const pins = listSessions({ pinned: true, limit: 50 });
    assert.ok(pins.every((m) => m.pinned));
    assert.ok(pins.some((m) => m.id === a.meta.id));
    assert.ok(!pins.some((m) => m.id === b.meta.id));
  });

  it("fork does not inherit pin", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fork-pin-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession: mk,
      setSessionPinned,
      forkSession,
      saveSession,
    } = await import("../src/session/session.js");
    const src = mk({ cwd: tmp, provider: "xai", model: "m", title: "pinned-src" });
    setSessionPinned(src, true);
    saveSession(src);
    const forked = forkSession(src, { title: "experiment" });
    assert.equal(src.meta.pinned, true);
    assert.equal(forked.meta.pinned, undefined);
    assert.match(forked.meta.title || "", /experiment/);
  });

  it("lastError sessions survive prune unless forceLastError", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prune-err-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession: mk,
      saveSession,
      setSessionLastError,
      pruneSessions,
      listSessions,
    } = await import("../src/session/session.js");
    const failed = mk({ cwd: tmp, provider: "xai", model: "m", title: "failed-run" });
    setSessionLastError(failed, {
      code: "rate_limited",
      message: "429",
      tips: ["switch"],
    });
    failed.meta.updatedAt = new Date(Date.now() - 90 * 86400_000).toISOString();
    saveSession(failed);
    const drop = mk({ cwd: tmp, provider: "xai", model: "m", title: "old-ok" });
    drop.meta.updatedAt = new Date(Date.now() - 80 * 86400_000).toISOString();
    saveSession(drop);
    const r = pruneSessions({ keep: 0, maxAgeDays: 1 });
    assert.ok(r.skippedLastError >= 1);
    assert.ok(listSessions(100).some((m) => m.id === failed.meta.id));
    assert.ok(!listSessions(100).some((m) => m.id === drop.meta.id));
    const forced = pruneSessions({ keep: 0, maxAgeDays: 1, forceLastError: true });
    assert.ok(forced.deletedWithLastError >= 1);
    assert.ok(!listSessions(100).some((m) => m.id === failed.meta.id));
  });

  it("pinned sessions survive prune", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pin-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession: mk,
      saveSession,
      setSessionPinned,
      pruneSessions,
      listSessions,
      loadSessionMeta,
    } = await import("../src/session/session.js");
    const keep = mk({ cwd: tmp, provider: "xai", model: "m", title: "keep-me" });
    setSessionPinned(keep, true);
    saveSession(keep);
    const drop = mk({ cwd: tmp, provider: "xai", model: "m", title: "drop-me" });
    // Make drop older so keep-newest prefers the pinned one anyway — force keep=0 age path
    drop.meta.updatedAt = new Date(Date.now() - 90 * 86400_000).toISOString();
    saveSession(drop);
    const r = pruneSessions({ keep: 0, maxAgeDays: 1 });
    assert.ok(r.skippedPinned >= 1);
    assert.ok(listSessions(100).some((m) => m.id === keep.meta.id));
    assert.equal(loadSessionMeta(keep.meta.id)?.pinned, true);
    assert.ok(!listSessions(100).some((m) => m.id === drop.meta.id));
  });

  it("/pin protects the active session", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pin-slash-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/pin", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.equal(s.meta.pinned, true);
    assert.match(String(r.output || ""), /Pinned/i);
    const u = await handleSlash("/unpin", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(s.meta.pinned, undefined);
    assert.match(String(u.output || ""), /Unpinned/i);
  });

  it("listSessionTouchedFiles extracts paths from tool calls", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-files-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession: mk,
      listSessionTouchedFiles,
      formatSessionTouchedFiles,
    } = await import("../src/session/session.js");
    const s = mk({ cwd: tmp, provider: "xai", model: "m" });
    s.messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "src/a.ts" }),
          },
        },
        {
          id: "2",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "src/b.ts", content: "hi" }),
          },
        },
        {
          id: "3",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({
              patchText:
                "*** Begin Patch\n*** Update File: src/c.ts\n@@\n-old\n+new\n*** End Patch",
            }),
          },
        },
      ],
    });
    const all = listSessionTouchedFiles(s);
    assert.ok(all.some((t) => t.path === "src/a.ts" && !t.mutated));
    assert.ok(all.some((t) => t.path === "src/b.ts" && t.mutated));
    assert.ok(all.some((t) => t.path === "src/c.ts" && t.mutated));
    const writes = listSessionTouchedFiles(s, { mutatedOnly: true });
    assert.ok(writes.every((t) => t.mutated));
    assert.ok(!writes.some((t) => t.path === "src/a.ts"));
    const text = formatSessionTouchedFiles(s, { mutatedOnly: true });
    assert.match(text, /src\/b\.ts/);
    assert.match(text, /src\/c\.ts/);
    assert.doesNotMatch(text, /src\/a\.ts/);
    assert.match(text, /\/diff --full/);
  });

  it("formatSessionTouchedFiles clips each row to one TTY line", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-files-clip-"));
    process.env.FORGE_HOME = tmp;
    const { createSession: mk, formatSessionTouchedFiles } = await import(
      "../src/session/session.js"
    );
    const { visibleWidth } = await import("../src/util/format.js");
    const s = mk({ cwd: tmp, provider: "xai", model: "m" });
    const long = `src/${"very-long-directory-name/".repeat(8)}file.ts`;
    s.messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: long, content: "x" }),
          },
        },
      ],
    });
    const stdout = process.stdout as NodeJS.WriteStream & { columns?: number };
    const prevCols = stdout.columns;
    const prevTty = stdout.isTTY;
    stdout.isTTY = true;
    stdout.columns = 36;
    try {
      const text = formatSessionTouchedFiles(s, { mutatedOnly: true });
      const rows = text.split("\n").filter((l) => /^\s+[A-Z]\s+/.test(l));
      assert.ok(rows.length >= 1);
      for (const row of rows) {
        assert.ok(visibleWidth(row) <= 36, JSON.stringify(row));
        assert.match(row, /^\s+A\s+/);
      }
    } finally {
      stdout.columns = prevCols;
      stdout.isTTY = prevTty;
    }
  });

  it("/files lists touched paths", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-files-slash-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    s.messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "1",
          type: "function",
          function: {
            name: "search_replace",
            arguments: JSON.stringify({
              path: "README.md",
              old_string: "a",
              new_string: "b",
            }),
          },
        },
      ],
    });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/files writes", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /README\.md/);
    assert.match(String(r.output || ""), /M|mutations/i);
  });

  it("/resume by title switches session", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-title-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession: mk,
      saveSession,
      setSessionTitle,
    } = await import("../src/session/session.js");
    const target = mk({ cwd: tmp, provider: "xai", model: "grok-4" });
    setSessionTitle(target, "incident-42");
    target.messages.push({ role: "user", content: "triage the outage" });
    target.messages.push({ role: "assistant", content: "root cause found" });
    saveSession(target);
    const current = mk({ cwd: tmp, provider: "xai", model: "grok-4" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/resume incident-42", {
      session: current,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.equal(r.replaceSession?.meta.id, target.meta.id);
    assert.match(String(r.output || ""), /Resumed/i);
    assert.match(String(r.output || ""), /incident-42|triage the outage/);

    const miss = await handleSlash("/resume no-such-label-zzz", {
      session: current,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.match(String(miss.output || ""), /not found|Try:/i);
  });

  it("listSessionLookupSuggestions returns structured id/title/path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sug-"));
    process.env.FORGE_HOME = tmp;
    const a = createSession({
      cwd: tmp,
      provider: "xai",
      model: "m",
      title: "alpha-project",
    });
    const b = createSession({
      cwd: tmp,
      provider: "xai",
      model: "m",
      title: "beta-work",
    });
    saveSession(a);
    saveSession(b);
    const hits = listSessionLookupSuggestions("alpa-project", { cwd: tmp });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].title, "alpha-project");
    assert.equal(hits[0].id, a.meta.id);
    assert.ok(hits[0].path.includes(a.meta.id));
    assert.ok(hits[0].relativeAge);
    const none = listSessionLookupSuggestions("zzzznope-unique", { cwd: tmp });
    assert.deepEqual(none, []);
  });

  it("deriveSessionTitle prefers mandate and strips harness noise", () => {
    const t = deriveSessionTitle(
      [
        "User mandate: harden the auth refresh path",
        "Execute relentlessly under the ULW cycle protocol until cycle flag is 0.",
        "",
        "## ULW",
        "cycle=1 wave=0",
      ].join("\n"),
    );
    assert.equal(t, "Harden the auth refresh path");

    const polite = deriveSessionTitle("please fix the flaky CI job on main");
    assert.equal(polite, "Fix the flaky CI job on main");

    assert.equal(deriveSessionTitle("/status"), undefined);
    assert.equal(deriveSessionTitle("  "), undefined);

    const long = "word ".repeat(80).trim();
    const cut = deriveSessionTitle(long, 40)!;
    assert.ok(cut.endsWith("…"));
    assert.ok(cut.length <= 41);
    assert.ok(!cut.includes("  "));
  });

  it("maybeSetTitle uses smart derive and never overwrites", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-title-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    maybeSetTitle(
      s,
      "User mandate: ship production-ready undo journal\nExecute relentlessly under the ULW cycle protocol",
    );
    assert.equal(s.meta.title, "Ship production-ready undo journal");
    maybeSetTitle(s, "should not replace");
    assert.equal(s.meta.title, "Ship production-ready undo journal");
  });

  it("exportSessionMarkdown includes lastError", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-md-err-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    setSessionLastError(s, {
      code: "auth_expired",
      message: "xai HTTP 401",
      tips: ["forge login"],
    });
    const md = exportSessionMarkdown(s);
    assert.match(md, /Last error/);
    assert.match(md, /auth_expired/);
    assert.match(md, /forge login/);
  });

  it("exportSessionMarkdown includes project stack + last verify", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-md-stack-"));
    process.env.FORGE_HOME = tmp;
    // Minimal package so project-intel has something to report.
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "export-stack-demo",
        version: "1.2.3",
        scripts: { test: "node --test", typecheck: "tsc -p ." },
      }),
    );
    fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}\n");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    s.meta.editCount = 4;
    s.meta.turnCount = 2;
    s.meta.lastVerificationCommand = "npm test";
    s.meta.lastVerificationAt = "2026-04-10T12:34:56.000Z";
    const md = exportSessionMarkdown(s);
    assert.match(md, /Cwd:/);
    assert.match(md, /Turns: 2\s+edits=4/);
    assert.match(md, /Project:.*export-stack-demo@1\.2\.3/);
    assert.match(md, /checks=/);
    assert.match(md, /Last verify: `npm test`/);
    assert.match(md, /2026-04-10 12:34:56/);
  });

  it("/sessions list shows ✓ when lastVerificationCommand is set", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sess-verify-badge-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, saveSession } = await import(
      "../src/session/session.js"
    );
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const active = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
      title: "active-no-verify",
    });
    const other = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
      title: "verified-session",
    });
    other.meta.lastVerificationCommand = "npm test";
    other.meta.lastVerificationAt = "2026-04-10T12:34:56.000Z";
    saveSession(other);
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/sessions", {
      session: active,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "");
    // Verified session row carries the badge; active without verify does not force it.
    assert.match(out, /verified-session/);
    assert.match(out, /✓/);
  });

  it("resume orientation + share card surface session budget", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-budget-orient-"));
    process.env.FORGE_HOME = tmp;
    const {
      formatResumeOrientation,
      formatSessionShareCard,
    } = await import("../src/session/session.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    s.meta.maxCostUsd = 5;
    s.meta.totalPromptTokens = 10_000;
    s.meta.totalCompletionTokens = 2_000;
    const orient = formatResumeOrientation(s);
    assert.match(orient, /budget:/i);
    const card = formatSessionShareCard(s);
    assert.match(card, /budget:/i);
    assert.match(card, /tokens:/i);
    const md = exportSessionMarkdown(s);
    assert.match(md, /Est\. cost/i);
    assert.match(md, /budget:/i);
  });


  it("formatSessionShareCard warns when edits lack last-verify", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-share-noverify-"));
    process.env.FORGE_HOME = tmp;
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "share-noverify",
        scripts: { test: "node --test", typecheck: "tsc -p ." },
      }),
    );
    fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}\n");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    s.meta.editCount = 5;
    delete s.meta.lastVerificationCommand;
    const card = formatSessionShareCard(s);
    assert.match(card, /last-verify: \(none after 5 edit/);
    assert.match(card, /npm run typecheck|npm test/);
  });

  it("formatResumeOrientation warns when edits lack last-verify", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-noverify-"));
    process.env.FORGE_HOME = tmp;
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        scripts: { typecheck: "tsc -b", test: "node --test" },
      }),
    );
    fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    s.meta.editCount = 3;
    delete s.meta.lastVerificationCommand;
    const orient = formatResumeOrientation(s);
    assert.match(orient, /Last verify: \(none after 3 edit/);
    assert.match(orient, /npm run typecheck|npm test/);
  });

  it("isLastVerificationStale detects edits after verify", () => {
    assert.equal(
      isLastVerificationStale({
        lastVerificationAt: "2026-04-10T12:00:00.000Z",
        lastEditAt: "2026-04-10T12:05:00.000Z",
      }),
      true,
    );
    assert.equal(
      isLastVerificationStale({
        lastVerificationAt: "2026-04-10T12:05:00.000Z",
        lastEditAt: "2026-04-10T12:00:00.000Z",
      }),
      false,
    );
    assert.equal(
      isLastVerificationStale({
        lastVerificationAt: "2026-04-10T12:00:00.000Z",
      }),
      false,
    );
  });

  it("formatResumeOrientation marks stale last-verify", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-stale-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    s.meta.lastVerificationCommand = "npm test";
    s.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    s.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    s.meta.editCount = 2;
    const orient = formatResumeOrientation(s);
    assert.match(orient, /Last verify: npm test/);
    assert.match(orient, /stale \(edits after verify\)/);
  });

  it("/sessions list shows ✓~ when last-verify is stale", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sess-stale-badge-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, saveSession } = await import(
      "../src/session/session.js"
    );
    const { handleSlash } = await import("../src/commands/slash.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const active = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
      title: "active-row",
    });
    const other = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
      title: "stale-verified",
    });
    other.meta.lastVerificationCommand = "npm test";
    other.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    other.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    other.meta.editCount = 2;
    saveSession(other);
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/sessions", {
      session: active,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /stale-verified/);
    assert.match(out, /✓~/);
  });

  it("importSessionJson preserves lastEditAt + last-verify trail", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-import-trail-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    s.meta.editCount = 3;
    s.meta.lastVerificationCommand = "npm test";
    s.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    s.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    s.messages.push({ role: "user", content: "hi" });
    const json = exportSessionJson(s);
    const imported = importSessionJson(json, { cwd: tmp });
    assert.equal(imported.meta.lastVerificationCommand, "npm test");
    assert.equal(imported.meta.lastVerificationAt, "2026-04-10T12:00:00.000Z");
    assert.equal(imported.meta.lastEditAt, "2026-04-10T12:10:00.000Z");
    assert.equal(isLastVerificationStale(imported.meta), true);
  });

  it("formatSessionPickerRow stays one TTY row", () => {
    const s = createSession({ cwd: "/tmp", provider: "xai", model: "grok-4.6" });
    s.meta.title = "very long title that would wrap a picker";
    s.meta.lastUserPreview = "please comprehensively evaluate then improve the ui";
    s.meta.ultrawork = true;
    s.meta.pinned = true;
    s.meta.lastError = { at: "t", code: "x", message: "fail" };
    const row = formatSessionPickerRow(s.meta, ["*"], 36);
    assert.ok(visibleWidth(row) <= 36, row);
    assert.match(row.replace(/\x1b\[[0-9;]*m/g, ""), /ULW|PIN|ERR|\*/);
  });
});
