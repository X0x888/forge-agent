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
  clearConversation,
} from "../src/session/session.js";
import { truncateMiddle, estimateCostUsd, formatTokens } from "../src/util/format.js";
import { isRetryableError } from "../src/util/retry.js";
import { completeSlash, handleSlash } from "../src/commands/slash.js";
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

  it("/fork includes last-turn peek", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fork-peek-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    s.messages.push({ role: "user", content: "branch this work" });
    s.messages.push({ role: "assistant", content: "ready to fork" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/fork experiment", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.ok(r.replaceSession);
    assert.match(String(r.output || ""), /Forked session/i);
    assert.match(String(r.output || ""), /branch this work/);
    assert.match(String(r.output || ""), /\/last 3/);
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
});
