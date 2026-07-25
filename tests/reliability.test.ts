import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseToolArguments,
  closeIncompleteJson,
} from "../src/util/json-repair.js";
import {
  repairToolCallPairing,
  alignKeepBoundary,
} from "../src/session/message-repair.js";
import { compactMessagesStructured } from "../src/session/compaction.js";
import {
  ProviderApiError,
  parseRetryAfterMs,
  isProviderApiError,
} from "../src/providers/errors.js";
import {
  isRetryableError,
  computeRetryDelayMs,
  withRetry,
} from "../src/util/retry.js";
import { mergeStreamedToolName } from "../src/providers/openai-compat.js";
import { executeTool, normalizeToolName } from "../src/agent/tools/index.js";
import type { ChatMessage } from "../src/providers/types.js";

describe("json-repair", () => {
  it("parses valid object args", () => {
    const r = parseToolArguments('{"path":"a.ts","offset":1}');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.repaired, false);
      assert.equal(r.value.path, "a.ts");
    }
  });

  it("repairs truncated object with unclosed string", () => {
    const r = parseToolArguments('{"command":"npm test --grep foo');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.repaired, true);
      assert.equal(r.value.command, "npm test --grep foo");
    }
  });

  it("repairs unescaped quote inside a value (model glitch)", () => {
    const r = parseToolArguments('{"command":"grep "foo" bar');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.repaired, true);
      assert.match(String(r.value.command), /grep/);
    }
  });

  it("repairs missing closing braces", () => {
    const r = parseToolArguments('{"path":"src/a.ts","limit":20');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.repaired, true);
      assert.equal(r.value.path, "src/a.ts");
      assert.equal(r.value.limit, 20);
    }
  });

  it("repairs trailing commas", () => {
    const r = parseToolArguments('{"a":1,"b":2,}');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.a, 1);
      assert.equal(r.value.b, 2);
    }
  });

  it("strips markdown fences", () => {
    const r = parseToolArguments('```json\n{"x":1}\n```');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.x, 1);
  });

  it("closeIncompleteJson terminates open structures", () => {
    assert.equal(closeIncompleteJson('{"a":'), '{"a":null}');
    assert.equal(closeIncompleteJson('{"a":[1,2'), '{"a":[1,2]}');
  });

  it("empty args → empty object", () => {
    const r = parseToolArguments("");
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, {});
  });
});

describe("message-repair", () => {
  it("fills orphaned tool_calls after abort", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "do stuff" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a"}' },
          },
        ],
      },
      // only first tool result present — second orphaned
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ];
    const r = repairToolCallPairing(messages);
    assert.equal(r.changed, true);
    assert.equal(r.filledOrphanToolCalls, 1);
    const tools = r.messages.filter((m) => m.role === "tool");
    assert.equal(tools.length, 2);
    assert.ok(tools.some((t) => t.tool_call_id === "call_2"));
    assert.match(String(tools.find((t) => t.tool_call_id === "call_2")?.content), /interrupted/i);
  });

  it("drops orphan tool results with no parent call", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "ghost", content: "nope" },
      { role: "assistant", content: "ok" },
    ];
    const r = repairToolCallPairing(messages);
    assert.equal(r.droppedOrphanToolResults, 1);
    assert.equal(r.messages.filter((m) => m.role === "tool").length, 0);
  });

  it("alignKeepBoundary does not start kept on tool result", () => {
    const rest: ChatMessage[] = [
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "bash", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "out" },
      { role: "assistant", content: "done" },
      { role: "user", content: "u2" },
    ];
    // keepLast=2 would naively start on tool if cut poorly — ensure assistant included
    const { kept } = alignKeepBoundary(rest, 2);
    assert.notEqual(kept[0]?.role, "tool");
    // kept should include enough to be valid
    const repaired = repairToolCallPairing(kept);
    assert.equal(repaired.filledOrphanToolCalls, 0);
  });

  it("compaction repairs tool pairing at boundary", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
    ];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: `u${i}` });
      messages.push({ role: "assistant", content: `a${i}` });
    }
    // append a partial tool turn at the end of "old" history
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "late",
          type: "function",
          function: { name: "bash", arguments: '{"command":"x"}' },
        },
      ],
    });
    // no tool result — then more recent turns
    messages.push({ role: "user", content: "continue" });
    messages.push({ role: "assistant", content: "working" });

    const result = compactMessagesStructured(messages, { keepLast: 6 });
    const healed = repairToolCallPairing(result.messages);
    // compact itself should already heal
    assert.equal(healed.filledOrphanToolCalls, 0);
    // no bare tool without assistant
    for (let i = 0; i < result.messages.length; i++) {
      if (result.messages[i].role === "tool") {
        const prev = result.messages[i - 1];
        assert.ok(
          prev &&
            (prev.role === "tool" ||
              (prev.role === "assistant" && prev.tool_calls?.length)),
        );
      }
    }
  });
});

describe("provider errors + retry", () => {
  it("parses Retry-After seconds and HTTP-date", () => {
    assert.equal(parseRetryAfterMs({ "retry-after": "2.5" }), 2500);
    assert.equal(parseRetryAfterMs({ "retry-after-ms": "1500" }), 1500);
    const future = new Date(Date.now() + 3000).toUTCString();
    const ms = parseRetryAfterMs({ "retry-after": future });
    assert.ok(ms != null && ms > 1000 && ms <= 5000);
  });

  it("ProviderApiError is retryable for 429/5xx", () => {
    const e429 = new ProviderApiError({
      provider: "xai",
      status: 429,
      body: "rate",
      retryAfterMs: 1000,
    });
    assert.equal(e429.isRetryable, true);
    assert.equal(isRetryableError(e429), true);
    assert.equal(isProviderApiError(e429), true);
    assert.equal(
      new ProviderApiError({ provider: "xai", status: 400, body: "bad" })
        .isRetryable,
      false,
    );
    assert.equal(
      isRetryableError(
        new ProviderApiError({ provider: "xai", status: 503, body: "down" }),
      ),
      true,
    );
  });

  it("computeRetryDelayMs honors retry-after", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 429,
      body: "slow down",
      retryAfterMs: 2500,
    });
    const d = computeRetryDelayMs(err, 0, { maxDelayMs: 12_000 });
    assert.equal(d, 2500);
  });

  it("withRetry respects abort and retries retryable errors", async () => {
    let n = 0;
    const v = await withRetry(
      async () => {
        n += 1;
        if (n < 3) throw new Error("API error 503 overloaded");
        return "ok";
      },
      { retries: 4, baseDelayMs: 1, maxDelayMs: 5 },
    );
    assert.equal(v, "ok");
    assert.ok(n >= 3);

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => withRetry(async () => "x", { signal: ac.signal, retries: 2 }),
      /Aborted/,
    );
  });
});

describe("version", () => {
  it("reads package.json version", async () => {
    const { getForgeVersion } = await import("../src/util/version.js");
    const v = getForgeVersion();
    assert.match(v, /^\d+\.\d+\.\d+/);
  });
});

describe("ddg html parse", () => {
  it("extracts result anchors", async () => {
    const { parseDdgHtml } = await import("../src/agent/tools/web-search.js");
    const html = `
      <a rel="nofollow" class="result__a" href="https://example.com/a">Alpha Docs</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb">Beta</a>
      <a class="result__a" href="/relative">Skip me</a>
    `;
    const hits = parseDdgHtml(html, 5);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].url, "https://example.com/a");
    assert.equal(hits[0].title, "Alpha Docs");
    assert.equal(hits[1].url, "https://example.com/b");
  });
});

describe("doctor surfaces reliability", () => {
  it("mentions reliability features and node", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doc-"));
    process.env.FORGE_HOME = tmp;
    const { loadConfig } = await import("../src/config/load.js");
    const { runDoctor } = await import("../src/commands/slash.js");
    const out = runDoctor(loadConfig({}, tmp));
    assert.match(out, /Forge doctor/);
    assert.match(out, /Version:/);
    assert.match(out, /Reliability:/);
    assert.match(out, /overflow→compact|overflow/);
    assert.match(out, /error-streak|doom-loop/);
    assert.match(out, /empty-SSE|abortable streams/);
    assert.match(out, /metrics\.jsonl|metrics:/);
    assert.match(out, /Node:/);
    assert.match(out, /Blocking Stop/);
    assert.match(out, /sessions:/);
  });

  it("doctor report + hygiene helpers expose CI contract fields", async () => {
    // Unit-level contract (no dist/ dependency — npm test must work pre-build)
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doc-json-"));
    process.env.FORGE_HOME = tmp;
    const { loadConfig } = await import("../src/config/load.js");
    const { runDoctor } = await import("../src/commands/slash.js");
    const { getForgeVersion } = await import("../src/util/version.js");
    const { toolOutputStats } = await import("../src/agent/tools/truncate.js");
    const { sandboxLogStats } = await import("../src/agent/sandbox-log.js");
    const { metricsStats } = await import("../src/session/metrics.js");
    const { listSessions } = await import("../src/session/session.js");
    const cfg = loadConfig({}, tmp);
    const report = runDoctor(cfg);
    const payload = {
      ok: /No blocking issues detected/.test(report),
      version: getForgeVersion(),
      sessionCount: listSessions(10_000).length,
      toolOutput: (() => {
        const st = toolOutputStats();
        return { files: st.files, bytes: st.bytes };
      })(),
      sandboxLog: (() => {
        const sl = sandboxLogStats();
        return { bytes: sl.bytes, backupBytes: sl.backupBytes };
      })(),
      metrics: (() => {
        const m = metricsStats();
        return { events: m.events, bytes: m.bytes };
      })(),
      blockingStop: cfg.blockingStopHooks,
      report,
    };
    assert.equal(typeof payload.ok, "boolean");
    assert.match(payload.version, /^\d+\.\d+\.\d+/);
    assert.equal(typeof payload.sessionCount, "number");
    assert.equal(typeof payload.toolOutput.files, "number");
    assert.equal(typeof payload.toolOutput.bytes, "number");
    assert.equal(typeof payload.sandboxLog.bytes, "number");
    assert.equal(typeof payload.metrics.events, "number");
    assert.equal(typeof payload.metrics.bytes, "number");
    assert.equal(typeof payload.blockingStop, "boolean");
    assert.match(payload.report, /Forge doctor/);
    assert.match(payload.report, /metrics:/);
  });

  it("flags missing auth as an issue", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doc2-"));
    // Isolate HOME so ~/.grok/auth.json is not reused
    process.env.FORGE_HOME = tmp;
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    for (const k of [
      "XAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "GROK_API_KEY",
      "FORGE_API_KEY",
    ]) {
      delete process.env[k];
    }
    const { loadConfig } = await import("../src/config/load.js");
    const { runDoctor } = await import("../src/commands/slash.js");
    const out = runDoctor(loadConfig({ provider: "xai" }, tmp));
    assert.match(out, /Not authenticated|not authenticated/i);
    assert.match(out, /issue/i);
  });
});

describe("provider abort helpers", () => {
  it("merges timeout and external abort", async () => {
    const { mergeAbortSignals, isTimeoutError, providerTimeoutMs } =
      await import("../src/util/abort.js");
    assert.ok(providerTimeoutMs() >= 5_000);
    const ac = new AbortController();
    const { signal, dispose } = mergeAbortSignals(ac.signal, 60_000);
    assert.equal(signal.aborted, false);
    ac.abort();
    assert.equal(signal.aborted, true);
    dispose();

    const { signal: s2, dispose: d2 } = mergeAbortSignals(undefined, 30);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s2.aborted, true);
    assert.equal(
      isTimeoutError(new Error("Provider request timed out after 300000ms")),
      true,
    );
    assert.equal(isTimeoutError(new Error("Aborted")), false);
    d2();
  });
});

describe("auth failure detection", () => {
  it("classifies 401/expired token messages", async () => {
    const { isAuthFailureMessage } = await import("../src/auth/refresh.js");
    assert.equal(isAuthFailureMessage("API error 401: unauthorized"), true);
    assert.equal(isAuthFailureMessage("invalid_api_key"), true);
    assert.equal(isAuthFailureMessage("rate limit 429"), false);
  });

  it("providers hot-swap credentials", async () => {
    const { OpenAICompatProvider } = await import(
      "../src/providers/openai-compat.js"
    );
    const { AnthropicProvider } = await import("../src/providers/anthropic.js");
    const oai = new OpenAICompatProvider({
      id: "xai",
      baseUrl: "http://127.0.0.1:9",
      apiKey: "old",
    });
    oai.updateCredentials("new-token");
    assert.equal(
      (oai as unknown as { apiKey: string }).apiKey,
      "new-token",
    );
    const ant = new AnthropicProvider({ apiKey: "old" });
    ant.updateCredentials("new-ant");
    assert.equal(
      (ant as unknown as { apiKey: string }).apiKey,
      "new-ant",
    );
  });
});

describe("env parsers", () => {
  it("envPositiveInt falls back on missing/invalid", async () => {
    const { envPositiveInt, envNonNegInt } = await import("../src/util/env.js");
    const key = "FORGE_TEST_ENV_POS_" + process.pid;
    delete process.env[key];
    assert.equal(envPositiveInt(key, 7), 7);
    process.env[key] = "0";
    assert.equal(envPositiveInt(key, 7), 7);
    process.env[key] = "-3";
    assert.equal(envPositiveInt(key, 7), 7);
    process.env[key] = "nope";
    assert.equal(envPositiveInt(key, 7), 7);
    process.env[key] = "4.9";
    assert.equal(envPositiveInt(key, 7), 4);
    process.env[key] = " 12 ";
    assert.equal(envPositiveInt(key, 7), 12);
    delete process.env[key];
    assert.equal(envNonNegInt(key, 3), 3);
    process.env[key] = "0";
    assert.equal(envNonNegInt(key, 3), 0);
    delete process.env[key];
  });
});

describe("attention bell", () => {
  it("respects FORGE_BELL env over preference", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bell-"));
    process.env.FORGE_HOME = tmp;
    const prev = process.env.FORGE_BELL;
    delete process.env.FORGE_BELL;
    const { isBellEnabled, maybeRingBell } = await import(
      "../src/util/attention.js"
    );
    const { savePreferences, loadPreferences } = await import(
      "../src/config/preferences.js"
    );
    assert.equal(isBellEnabled({}), false);
    assert.equal(isBellEnabled({ bellOnTurnEnd: true }), true);
    process.env.FORGE_BELL = "0";
    assert.equal(isBellEnabled({ bellOnTurnEnd: true }), false);
    process.env.FORGE_BELL = "1";
    assert.equal(isBellEnabled({ bellOnTurnEnd: false }), true);
    savePreferences({ bellOnTurnEnd: true });
    assert.equal(loadPreferences().bellOnTurnEnd, true);
    // force ring path is safe even when not a TTY (returns false)
    const rang = maybeRingBell({ force: true });
    assert.equal(typeof rang, "boolean");
    if (prev === undefined) delete process.env.FORGE_BELL;
    else process.env.FORGE_BELL = prev;
  });
});

describe("doom-loop", () => {
  it("trips on 3 identical tool fingerprints", async () => {
    const { DoomLoopTracker, toolFingerprint } = await import(
      "../src/agent/doom-loop.js"
    );
    const t = new DoomLoopTracker({ threshold: 3 });
    const input = { path: "a.ts" };
    assert.equal(t.observe("read_file", input), null);
    assert.equal(t.observe("read_file", input), null);
    const hit = t.observe("read_file", input);
    assert.ok(hit);
    assert.equal(hit!.tool, "read_file");
    assert.equal(hit!.count, 3);
    assert.match(hit!.message, /doom-loop/i);
    // Same streak does not re-fire
    assert.equal(t.observe("read_file", input), null);
    // Different args resets
    assert.equal(t.observe("read_file", { path: "b.ts" }), null);
    assert.equal(
      toolFingerprint("bash", { command: "ls", timeout_ms: 1 }),
      toolFingerprint("bash", { command: "ls", timeout_ms: 99 }),
    );
  });
});

describe("error-streak", () => {
  it("trips after N consecutive countable errors", async () => {
    const {
      ErrorStreakTracker,
      isCountableToolError,
      summarizeToolError,
    } = await import("../src/agent/error-streak.js");
    const t = new ErrorStreakTracker({ threshold: 3 });
    assert.equal(isCountableToolError("HARD DENY [x]: no", true), false);
    assert.equal(
      isCountableToolError("Tool denied by permission gate: nope", true),
      false,
    );
    assert.equal(isCountableToolError("File not found: a.ts", true), true);
    assert.equal(t.observeError("read_file", "missing a"), null);
    assert.equal(t.observeError("edit", "no match"), null);
    const hit = t.observeError("bash", "exit 1");
    assert.ok(hit);
    assert.equal(hit!.count, 3);
    assert.match(hit!.message, /error-streak/i);
    // Same streak does not re-fire until cool successes
    assert.equal(t.observeError("grep", "no hits"), null);
    t.observeSuccess();
    t.observeSuccess();
    t.observeSuccess();
    // Fresh streak can trip again
    assert.equal(t.observeError("read_file", "x"), null);
    assert.equal(t.observeError("read_file", "y"), null);
    assert.ok(t.observeError("read_file", "z"));
    assert.match(summarizeToolError("line1\nline2"), /line1/);
  });

  it("success breaks streak before threshold", async () => {
    const { ErrorStreakTracker } = await import("../src/agent/error-streak.js");
    const t = new ErrorStreakTracker({ threshold: 4 });
    assert.equal(t.observeError("a", "1"), null);
    assert.equal(t.observeError("b", "2"), null);
    t.observeSuccess();
    assert.equal(t.currentStreak, 0);
    assert.equal(t.observeError("c", "3"), null);
  });
});

describe("session fork / export / tmp recover", () => {
  it("forks, exports JSON, and recovers from atomic tmp", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sess-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession,
      saveSession,
      loadSession,
      forkSession,
      exportSessionJson,
      formatSessionSummary,
      sessionDir,
    } = await import("../src/session/session.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    s.messages.push({ role: "user", content: "hello" });
    s.messages.push({ role: "assistant", content: "hi" });
    s.todos = [{ id: "t1", content: "work", status: "pending" }];
    s.meta.title = "demo";
    saveSession(s);

    const forked = forkSession(s, { title: "experiment" });
    assert.notEqual(forked.meta.id, s.meta.id);
    assert.equal(forked.messages.length, s.messages.length);
    assert.equal(forked.meta.title, "experiment");
    assert.equal(forked.todos[0]?.id, "t1");

    const json = exportSessionJson(s);
    const parsed = JSON.parse(json);
    assert.equal(parsed.format, "forge-session-v1");
    assert.equal(parsed.messageCount, 2);
    assert.match(formatSessionSummary(s), /demo/);

    const { importSessionJson } = await import("../src/session/session.js");
    const imported = importSessionJson(json, { title: "restored" });
    assert.notEqual(imported.meta.id, s.meta.id);
    assert.equal(imported.messages.length, 2);
    assert.equal(imported.meta.title, "restored");

    // Simulate crash: only atomic tmp remains
    const dir = sessionDir(s.meta.id);
    const primary = path.join(dir, "session.json");
    const payload = fs.readFileSync(primary, "utf8");
    fs.unlinkSync(primary);
    fs.writeFileSync(path.join(dir, `session.json.${process.pid}.tmp`), payload);
    const recovered = loadSession(s.meta.id);
    assert.ok(recovered);
    assert.equal(recovered!.messages.length, 2);
    assert.equal(recovered!.meta.title, "demo");
    // Promoted back to primary
    assert.ok(fs.existsSync(primary));

    const { setSessionTitle, maybeSetTitle } = await import(
      "../src/session/session.js"
    );
    assert.equal(setSessionTitle(s, "  renamed session  "), "renamed session");
    assert.equal(loadSession(s.meta.id)!.meta.title, "renamed session");
    assert.equal(setSessionTitle(s, ""), undefined);
    assert.equal(loadSession(s.meta.id)!.meta.title, undefined);
    maybeSetTitle(s, "auto from first message that is quite long ".repeat(5));
    assert.ok((s.meta.title || "").length <= 72);
    // maybeSetTitle does not overwrite explicit titles
    setSessionTitle(s, "keep-me");
    maybeSetTitle(s, "should-not-apply");
    assert.equal(s.meta.title, "keep-me");

    const { findRecentSessionForCwd, createSession: mk } = await import(
      "../src/session/session.js"
    );
    const a = mk({ cwd: tmp, provider: "xai", model: "m" });
    a.meta.title = "workspace-a";
    saveSession(a); // newest same-cwd after prior saves of s
    // Different cwd should not match
    const other = mk({
      cwd: path.join(tmp, "other-proj"),
      provider: "xai",
      model: "m",
    });
    fs.mkdirSync(other.meta.cwd, { recursive: true });
    other.meta.title = "other";
    saveSession(other);
    const hit = findRecentSessionForCwd(tmp);
    assert.ok(hit);
    assert.equal(hit!.id, a.meta.id);
    assert.equal(findRecentSessionForCwd(path.join(tmp, "nope")), null);
    // Age filter: maxAgeDays=0 disables age cut
    assert.ok(findRecentSessionForCwd(tmp, { maxAgeDays: 0 }));
    // Stale sessions beyond maxAgeDays are ignored (patch meta sidecars;
    // saveSession would refresh updatedAt to now). Age *all* same-cwd metas
    // including forks/imports created earlier in this test.
    const stale = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const sessRoot = path.join(tmp, "sessions");
    for (const id of fs.readdirSync(sessRoot)) {
      const metaPath = path.join(sessRoot, id, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      const raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (path.resolve(raw.cwd || "") !== path.resolve(tmp)) continue;
      raw.updatedAt = stale;
      fs.writeFileSync(metaPath, JSON.stringify(raw));
    }
    assert.equal(findRecentSessionForCwd(tmp, { maxAgeDays: 14 }), null);

    // Foreign live lock is skipped (falls through to older unlocked same-cwd)
    const unlocked = mk({ cwd: tmp, provider: "xai", model: "m" });
    unlocked.meta.title = "unlocked-older";
    saveSession(unlocked);
    const locked = mk({ cwd: tmp, provider: "xai", model: "m" });
    locked.meta.title = "locked-newer";
    saveSession(locked);
    // Make locked newest via meta sidecar timestamps
    const now = Date.now();
    const patchMeta = (id: string, ts: number) => {
      const p = path.join(tmp, "sessions", id, "meta.json");
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      raw.updatedAt = new Date(ts).toISOString();
      fs.writeFileSync(p, JSON.stringify(raw));
    };
    patchMeta(unlocked.meta.id, now - 5_000);
    patchMeta(locked.meta.id, now);
    const lockPath = path.join(tmp, "sessions", locked.meta.id, "session.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid + 999_999, // almost certainly dead → not foreign-live
        hostname: "other",
        acquiredAt: new Date().toISOString(),
        sessionId: locked.meta.id,
      }),
    );
    // Dead foreign pid should NOT skip
    assert.equal(findRecentSessionForCwd(tmp)!.id, locked.meta.id);
    // Live foreign pid (use our own pid but claim foreign — pid===self is not foreign)
    // Simulate live foreign by writing pid 1 if alive on this host
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 1,
        hostname: "other-host",
        acquiredAt: new Date().toISOString(),
        sessionId: locked.meta.id,
      }),
    );
    const afterSkip = findRecentSessionForCwd(tmp);
    // If pid 1 is alive, locked is skipped → unlocked; if not, locked still wins
    try {
      process.kill(1, 0);
      assert.ok(afterSkip);
      assert.equal(afterSkip!.id, unlocked.meta.id);
    } catch {
      assert.equal(afterSkip!.id, locked.meta.id);
    }
    // skipLocked:false always returns newest regardless
    assert.equal(
      findRecentSessionForCwd(tmp, { skipLocked: false })!.id,
      locked.meta.id,
    );
  });
});

describe("formatRetryWait", () => {
  it("formats ms and seconds", async () => {
    const { formatRetryWait } = await import("../src/util/format.js");
    assert.equal(formatRetryWait(450), "450ms");
    assert.equal(formatRetryWait(1200), "1.2s");
    assert.equal(formatRetryWait(15_000), "15s");
  });
});

describe("permission / tool arg previews", () => {
  it("summarizes apply_patch instead of dumping full text", async () => {
    const { summarizeToolArgs, formatPermissionPreview } = await import(
      "../src/util/format.js"
    );
    const patch = `*** Begin Patch
*** Add File: a.ts
+hi
*** Update File: b.ts
@@
-old
+new
*** Delete File: c.ts
*** End Patch`;
    const sum = summarizeToolArgs({ patchText: patch });
    assert.match(sum, /patch\(3\)/);
    assert.match(sum, /A a\.ts/);
    assert.ok(!sum.includes("+hi\n"));
    const prev = formatPermissionPreview("apply_patch", { patchText: patch });
    assert.match(prev, /ops \(3\)/);
    assert.match(prev, /^A a\.ts/m);
    assert.match(prev, /^M b\.ts/m);
    assert.match(prev, /^D c\.ts/m);
    const bash = formatPermissionPreview("bash", { command: "npm test" });
    assert.match(bash, /npm test/);
  });
});

describe("session metrics + permission timeout", () => {
  it("appends metrics without secrets and parses timeout env", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-metrics-"));
    process.env.FORGE_HOME = tmp;
    const {
      appendSessionMetrics,
      buildRunEndMetrics,
      metricsStats,
      metricsPath,
    } = await import("../src/session/metrics.js");
    const { permissionAskTimeoutMs } = await import(
      "../src/agent/permissions.js"
    );

    const prev = process.env.FORGE_PERMISSION_TIMEOUT_MS;
    delete process.env.FORGE_PERMISSION_TIMEOUT_MS;
    assert.equal(permissionAskTimeoutMs(), 0);
    process.env.FORGE_PERMISSION_TIMEOUT_MS = "1000"; // below min → 5000
    assert.equal(permissionAskTimeoutMs(), 5_000);
    process.env.FORGE_PERMISSION_TIMEOUT_MS = "60000";
    assert.equal(permissionAskTimeoutMs(), 60_000);
    if (prev === undefined) delete process.env.FORGE_PERMISSION_TIMEOUT_MS;
    else process.env.FORGE_PERMISSION_TIMEOUT_MS = prev;

    appendSessionMetrics(
      buildRunEndMetrics({
        sessionId: "abc",
        provider: "xai",
        model: "m",
        turns: 2,
        stopContinues: 1,
        editCount: 3,
        promptTokens: 100,
        completionTokens: 50,
        durationMs: 1234,
        ok: true,
        headless: true,
      }),
    );
    const st = metricsStats();
    assert.equal(st.events, 1);
    assert.ok(st.bytes > 0);
    const line = fs.readFileSync(metricsPath(), "utf8").trim();
    assert.match(line, /"type":"run_end"/);
    assert.doesNotMatch(line, /api[_-]?key|sk-|password|secret/i);
    assert.match(line, /"estCostUsd":/);

    const { pruneMetrics } = await import("../src/session/metrics.js");
    for (let i = 0; i < 5; i++) {
      appendSessionMetrics(
        buildRunEndMetrics({
          sessionId: `s${i}`,
          provider: "xai",
          model: "m",
          turns: 1,
          stopContinues: 0,
          editCount: 0,
          promptTokens: 1,
          completionTokens: 1,
          ok: true,
        }),
      );
    }
    const pruned = pruneMetrics({ keep: 3 });
    assert.equal(pruned.afterEvents, 3);
    assert.ok(pruned.deleted >= 3);
    assert.equal(metricsStats().events, 3);
  });
});

describe("session lock", () => {
  it("acquires and releases lock for current pid", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lock-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const {
      acquireSessionLock,
      releaseSessionLock,
      readSessionLock,
    } = await import("../src/session/lock.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const a = acquireSessionLock(s.meta.id);
    assert.equal(a.ok, true);
    assert.equal(a.owned, true);
    const info = readSessionLock(s.meta.id);
    assert.equal(info?.pid, process.pid);
    assert.equal(releaseSessionLock(s.meta.id), true);
    assert.equal(readSessionLock(s.meta.id), null);
  });
});

describe("sandbox log rotation", () => {
  it("rotates when over max bytes", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-slog-"));
    process.env.FORGE_HOME = tmp;
    const {
      logSandboxEvent,
      sandboxLogPath,
      sandboxLogStats,
      SANDBOX_LOG_MAX_BYTES,
    } = await import("../src/agent/sandbox-log.js");
    const file = sandboxLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write a large file just under then force over via direct write + event
    const big = Buffer.alloc(SANDBOX_LOG_MAX_BYTES + 100, 0x61);
    fs.writeFileSync(file, big);
    logSandboxEvent({ type: "deny", reason: "test-rotate", command: "echo hi" });
    assert.ok(fs.existsSync(`${file}.1`), "backup should exist after rotate");
    const st = sandboxLogStats();
    assert.ok(st.exists);
    assert.ok(st.backupBytes > 0);
    // Active file should be small (just the new line)
    assert.ok(st.bytes < 10_000);
  });
});

describe("tool-output prune", () => {
  it("prunes old dumps keeping newest", async () => {
    const fs = await import("node:fs");
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tout-"));
    process.env.FORGE_HOME = tmp;
    const {
      toolOutputDir,
      pruneToolOutputsSync,
      toolOutputStats,
      saveFullOutput,
    } = await import("../src/agent/tools/truncate.js");
    const dir = toolOutputDir();
    await fsp.mkdir(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      await saveFullOutput(`dump ${i}\n` + "x".repeat(100));
    }
    // Age the oldest two
    const files = fs.readdirSync(dir).map((n) => path.join(dir, n));
    files.sort();
    const old = Date.now() - 30 * 86_400_000;
    for (const f of files.slice(0, 2)) {
      fs.utimesSync(f, new Date(old / 1000), new Date(old / 1000));
    }
    const before = toolOutputStats();
    assert.ok(before.files >= 5);
    const r = pruneToolOutputsSync({ keep: 3, maxAgeDays: 7 });
    assert.ok(r.deleted >= 2);
    const after = toolOutputStats();
    assert.ok(after.files <= 3);
  });
});

describe("shell completion", () => {
  it("emits bash completion function", async () => {
    const { shellCompletionScript } = await import(
      "../src/util/completion-script.js"
    );
    const out = shellCompletionScript("bash");
    assert.match(out, /_forge_completions/);
    assert.match(out, /complete -F/);
    assert.match(out, /sessions/);
    assert.match(out, /show export import fork delete prune/);
    assert.match(out, /prune-metrics/);
    assert.match(out, /--session/);
    assert.match(out, /top_flags/);
    assert.match(out, /--new/);
    assert.match(shellCompletionScript("zsh"), /compdef/);
    const fish = shellCompletionScript("fish");
    assert.match(fish, /complete -c forge/);
    assert.match(fish, /l new/);
  });
});

describe("headless session resume helpers", () => {
  it("loadSession restores messages for forge run --session", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-run-sess-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession,
      saveSession,
      loadSession,
    } = await import("../src/session/session.js");
    const s = createSession({
      cwd: path.join(tmp, "proj"),
      provider: "xai",
      model: "m",
    });
    s.messages.push({ role: "user", content: "step 1" });
    s.messages.push({ role: "assistant", content: "done step 1" });
    s.meta.title = "ci-pipeline";
    saveSession(s);
    const loaded = loadSession(s.meta.id.slice(0, 8));
    assert.ok(loaded);
    assert.equal(loaded!.messages.length, 2);
    assert.equal(loaded!.meta.cwd, path.join(tmp, "proj"));
    assert.equal(loaded!.meta.title, "ci-pipeline");
    // Prefix resolve must not require full uuid
    assert.equal(loadSession(s.meta.id.slice(0, 6))?.meta.id, s.meta.id);
  });
});

describe("session meta sidecar", () => {
  it("listSessions uses meta without requiring full reload path", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-meta-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession,
      saveSession,
      listSessions,
      loadSessionMeta,
      sessionDir,
    } = await import("../src/session/session.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    s.meta.title = "sidecar-test";
    s.messages.push({ role: "user", content: "x".repeat(5000) });
    saveSession(s);
    assert.ok(fs.existsSync(path.join(sessionDir(s.meta.id), "meta.json")));
    const meta = loadSessionMeta(s.meta.id);
    assert.equal(meta?.title, "sidecar-test");
    const list = listSessions(5);
    assert.ok(list.some((m) => m.id === s.meta.id && m.title === "sidecar-test"));
  });

  it("backfills meta.json for legacy sessions", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-legacy-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession,
      saveSession,
      loadSessionMeta,
      sessionDir,
    } = await import("../src/session/session.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    s.meta.title = "legacy";
    saveSession(s);
    const metaPath = path.join(sessionDir(s.meta.id), "meta.json");
    fs.unlinkSync(metaPath);
    assert.equal(fs.existsSync(metaPath), false);
    const meta = loadSessionMeta(s.meta.id);
    assert.equal(meta?.title, "legacy");
    assert.ok(fs.existsSync(metaPath), "should backfill meta.json");
  });
});

describe("session prune", () => {
  it("deletes and prunes old sessions", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prune-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession,
      listSessions,
      deleteSession,
      pruneSessions,
      saveSession,
    } = await import("../src/session/session.js");
    const a = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const b = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const c = createSession({ cwd: tmp, provider: "xai", model: "m" });
    // Make a look older
    a.meta.updatedAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
    saveSession(a);
    b.meta.updatedAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    saveSession(b);
    assert.equal(listSessions(10).length, 3);
    assert.equal(deleteSession(c.meta.id.slice(0, 8)), true);
    assert.equal(listSessions(10).length, 2);
    const pruned = pruneSessions({ keep: 1 });
    assert.ok(pruned.deleted.length >= 1);
    assert.equal(listSessions(10).length, 1);
  });
});

describe("stream empty / error recovery", () => {
  it("classifies empty stream and stream error as retryable", async () => {
    const { isRetryableError } = await import("../src/util/retry.js");
    assert.equal(
      isRetryableError(
        new Error(
          "xai stream ended with empty response (no content, tools, or finish_reason) — likely a dropped connection",
        ),
      ),
      true,
    );
    assert.equal(
      isRetryableError(new Error("xai stream error: rate_limit_exceeded")),
      true,
    );
  });

  it("flags git commit --no-verify as soft-dangerous", async () => {
    const { isSoftDangerousBash } = await import("../src/agent/safety.js");
    assert.equal(isSoftDangerousBash("git commit -m 'x'"), false);
    assert.equal(isSoftDangerousBash("git commit --no-verify -m 'x'"), true);
    assert.equal(isSoftDangerousBash("git commit -n -m 'x'"), true);
    assert.equal(isSoftDangerousBash("git push --no-verify origin HEAD"), true);
    // dry-run flags on other git verbs must not trip
    assert.equal(isSoftDangerousBash("git add -n ."), false);
    assert.equal(isSoftDangerousBash("git status -n"), false);
  });
});

describe("stream tool name merge + executeTool repair", () => {
  it("openai-compat stream body requests usage", async () => {
    // Ensure the production body builder still asks for stream usage.
    // We inspect the class method via a tiny subclass hook.
    const { OpenAICompatProvider } = await import(
      "../src/providers/openai-compat.js"
    );
    const p = new OpenAICompatProvider({
      id: "test",
      baseUrl: "http://127.0.0.1:9",
      apiKey: "k",
    });
    const body = (
      p as unknown as {
        buildBody: (
          req: { model: string; messages: [] },
          stream: boolean,
        ) => Record<string, unknown>;
      }
    ).buildBody({ model: "m", messages: [] }, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    const bodyNo = (
      p as unknown as {
        buildBody: (
          req: { model: string; messages: [] },
          stream: boolean,
        ) => Record<string, unknown>;
      }
    ).buildBody({ model: "m", messages: [] }, false);
    assert.equal(bodyNo.stream_options, undefined);
  });

  it("mergeStreamedToolName avoids bashbash", () => {
    assert.equal(mergeStreamedToolName("", "bash"), "bash");
    assert.equal(mergeStreamedToolName("bash", "bash"), "bash");
    assert.equal(mergeStreamedToolName("ba", "bash"), "bash");
    assert.equal(mergeStreamedToolName("bash", "ba"), "bash");
  });

  it("normalizeToolName recovers doubled names", () => {
    assert.equal(normalizeToolName("bashbash"), "bash");
    assert.equal(normalizeToolName("todo_writetodo_write"), "todo_write");
  });

  it("executeTool accepts repaired truncated JSON", async () => {
    const r = await executeTool(
      "todo_write",
      '{"todos":[{"id":"1","content":"x","status":"pending"}]', // missing }}
      { workspace: process.cwd() },
      (todos) => `got ${Array.isArray(todos) ? todos.length : 0}`,
    );
    assert.equal(r.isError, undefined);
    assert.match(r.output, /got 1/);
  });
});
