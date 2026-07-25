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
    assert.match(out, /file-aware undo|apply_patch/);
    assert.match(out, /bash timeout=/);
    assert.match(out, /metrics\.jsonl|metrics:/);
    assert.match(out, /Node:/);
    assert.match(out, /Blocking Stop/);
    assert.match(out, /sessions:/);
    // foreign-locked count is optional (0 locks → no suffix)
    assert.match(out, /sessions: \d+/);
  });

  it("doctor report + hygiene helpers expose CI contract fields", async () => {
    // Unit-level contract (no dist/ dependency — npm test must work pre-build)
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doc-json-"));
    process.env.FORGE_HOME = tmp;
    const { loadConfig } = await import("../src/config/load.js");
    const { runDoctor, runDoctorCheck } = await import(
      "../src/commands/slash.js"
    );
    const { getForgeVersion } = await import("../src/util/version.js");
    const { toolOutputStats } = await import("../src/agent/tools/truncate.js");
    const { sandboxLogStats } = await import("../src/agent/sandbox-log.js");
    const { metricsStats } = await import("../src/session/metrics.js");
    const { listSessions } = await import("../src/session/session.js");
    const { inspectSecureFile, writeJsonFile, forgeHome } = await import(
      "../src/util/fs.js"
    );
    const cfg = loadConfig({}, tmp);
    const check = runDoctorCheck(cfg);
    const report = check.report;
    assert.equal(runDoctor(cfg), report);
    const home = forgeHome();
    const secureFiles = {
      auth: inspectSecureFile(path.join(home, "auth.json")),
      permissions: inspectSecureFile(path.join(home, "permissions.json")),
      preferences: inspectSecureFile(path.join(home, "preferences.json")),
    };
    const secureFilesOk = Object.values(secureFiles).every(
      (f) => f.modeOk !== false,
    );
    // CI ok is structured — never chalk/report regex
    const { sessionHasForeignLiveLock } = await import(
      "../src/session/session.js"
    );
    const sessions = listSessions(10_000);
    let sessionsLocked = 0;
    let sessionsPinned = 0;
    for (const s of sessions) {
      if (sessionHasForeignLiveLock(s.id)) sessionsLocked += 1;
      if (s.pinned) sessionsPinned += 1;
    }
    const payload = {
      ok: check.ok && secureFilesOk && check.blockingStop,
      version: getForgeVersion(),
      sessionCount: sessions.length,
      sessionsLocked,
      sessionsPinned,
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
      secureFiles,
      blockingStop: check.blockingStop,
      issues: check.issues,
      report,
    };
    assert.equal(typeof payload.ok, "boolean");
    assert.equal(typeof check.ok, "boolean");
    assert.ok(Array.isArray(check.issues));
    assert.match(payload.version, /^\d+\.\d+\.\d+/);
    assert.equal(typeof payload.sessionCount, "number");
    assert.equal(typeof payload.sessionsLocked, "number");
    assert.ok(payload.sessionsLocked >= 0);
    assert.ok(payload.sessionsLocked <= payload.sessionCount);
    assert.equal(typeof payload.sessionsPinned, "number");
    assert.ok(payload.sessionsPinned >= 0);
    assert.ok(payload.sessionsPinned <= payload.sessionCount);
    assert.equal(typeof payload.toolOutput.files, "number");
    assert.equal(typeof payload.toolOutput.bytes, "number");
    assert.equal(typeof payload.sandboxLog.bytes, "number");
    assert.equal(typeof payload.metrics.events, "number");
    assert.equal(typeof payload.metrics.bytes, "number");
    assert.equal(typeof payload.blockingStop, "boolean");
    assert.equal(payload.blockingStop, true);
    // Operator knobs (bash timeouts) — defaults when env unset; mirror doctor --json fields
    {
      const { defaultBashTimeoutMs, defaultBashBackgroundTimeoutMs } =
        await import("../src/util/env.js");
      const { mutationsJournalStats } = await import(
        "../src/session/mutations.js"
      );
      const bashTimeoutMs = defaultBashTimeoutMs();
      const bashBackgroundTimeoutMs = defaultBashBackgroundTimeoutMs();
      const undoJournal = mutationsJournalStats();
      assert.equal(bashTimeoutMs, 120_000);
      assert.equal(bashBackgroundTimeoutMs, 30 * 60_000);
      // Shape experts/CI should read from forge doctor --json
      const doctorJsonShape = {
        ...payload,
        bashTimeoutMs,
        bashBackgroundTimeoutMs,
        undoJournal,
      };
      assert.equal(typeof doctorJsonShape.bashTimeoutMs, "number");
      assert.equal(typeof doctorJsonShape.bashBackgroundTimeoutMs, "number");
      assert.ok(doctorJsonShape.bashTimeoutMs >= 5_000);
      assert.equal(typeof doctorJsonShape.undoJournal.sessions, "number");
      assert.equal(typeof doctorJsonShape.undoJournal.bytes, "number");
      assert.equal(typeof doctorJsonShape.undoJournal.entries, "number");
    }
    assert.equal(payload.secureFiles.auth.exists, false);
    assert.equal(payload.secureFiles.auth.modeOk, null);
    assert.match(payload.report, /Forge doctor/);
    assert.match(payload.report, /metrics:/);

    // World-readable auth must fail modeOk (and doctor report).
    // Write with 0644 directly (sandbox may block chmodSync).
    const authPath = path.join(home, "auth.json");
    fs.writeFileSync(
      authPath,
      JSON.stringify({ version: 1, credentials: {} }, null, 2) + "\n",
      { mode: 0o644 },
    );
    // Some FS ignore mode on write — only assert when mode stuck as world-readable
    const st = fs.statSync(authPath);
    if ((st.mode & 0o077) !== 0) {
      const bad = inspectSecureFile(authPath);
      assert.equal(bad.exists, true);
      assert.equal(bad.modeOk, false);
      const checkBad = runDoctorCheck(cfg);
      assert.equal(checkBad.ok, false);
      assert.ok(
        checkBad.issues.some((i) => /auth|0600|world-readable/i.test(i)),
      );
      assert.match(checkBad.report, /auth.*should be 600|group\/world-readable/i);
    } else {
      // Still verify inspectSecureFile shape on a secure file
      writeJsonFile(authPath, { version: 1, credentials: {} }, 0o600);
      const good = inspectSecureFile(authPath);
      assert.equal(good.exists, true);
      assert.equal(good.modeOk, true);
    }
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

  it("flags Blocking Stop OFF as a doctor issue (non-negotiable)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doc-bstop-"));
    process.env.FORGE_HOME = tmp;
    const { loadConfig } = await import("../src/config/load.js");
    const { runDoctor, runDoctorCheck } = await import(
      "../src/commands/slash.js"
    );
    const cfg = loadConfig({}, tmp);
    cfg.blockingStopHooks = false;
    const check = runDoctorCheck(cfg);
    assert.equal(check.ok, false);
    assert.equal(check.blockingStop, false);
    assert.ok(check.issues.some((i) => /Blocking Stop is OFF/i.test(i)));
    assert.match(check.report, /Blocking Stop: off/i);
    assert.doesNotMatch(check.report, /No blocking issues detected/);
    // Default remains on
    const on = runDoctorCheck(loadConfig({}, tmp));
    assert.equal(on.blockingStop, true);
    assert.match(on.report, /Blocking Stop: on/i);
    assert.equal(runDoctor(cfg), check.report);
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
      isTimeoutError(new Error("Request timed out after 300000ms")),
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

describe("readJsonFile fallback isolation", () => {
  it("does not return a shared mutable object fallback", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { readJsonFile } = await import("../src/util/fs.js");
    const missing = path.join(
      os.tmpdir(),
      `forge-missing-json-${process.pid}-${Date.now()}.json`,
    );
    const EMPTY = { version: 1 as const, items: [] as string[] };
    const a = readJsonFile<typeof EMPTY>(missing, EMPTY);
    a.items.push("mutated");
    const b = readJsonFile<typeof EMPTY>(missing, EMPTY);
    assert.deepEqual(b.items, []);
    assert.deepEqual(EMPTY.items, []);
    // corrupt file also clones fallback
    const bad = path.join(
      os.tmpdir(),
      `forge-bad-json-${process.pid}-${Date.now()}.json`,
    );
    fs.writeFileSync(bad, "{not json", "utf8");
    const c = readJsonFile<typeof EMPTY>(bad, EMPTY);
    c.items.push("x");
    assert.deepEqual(readJsonFile<typeof EMPTY>(bad, EMPTY).items, []);
    try {
      fs.unlinkSync(bad);
    } catch {
      /* */
    }
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
    savePreferences({ seenWelcomeTip: true });
    assert.equal(loadPreferences().seenWelcomeTip, true);
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
    assert.equal(isCountableToolError("Aborted", true), false);
    assert.equal(isCountableToolError("Aborted by user", true), false);
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

    // Corrupt roles / todos must not poison the agent loop
    assert.throws(
      () =>
        importSessionJson(
          JSON.stringify({
            format: "forge-session-v1",
            messages: [{ role: "hacker", content: "x" }],
          }),
        ),
      /role must be system\|user\|assistant\|tool/i,
    );
    assert.throws(
      () =>
        importSessionJson(
          JSON.stringify({
            format: "forge-session-v1",
            messages: ["not-an-object"],
          }),
        ),
      /must be an object/i,
    );
    const withBadTodos = importSessionJson(
      JSON.stringify({
        format: "forge-session-v1",
        messages: [{ role: "user", content: "hi" }],
        todos: [
          { id: "ok", content: "work", status: "pending" },
          { id: "bad", content: "x", status: "nope" },
          { content: "missing-id", status: "pending" },
        ],
      }),
    );
    assert.equal(withBadTodos.todos.length, 1);
    assert.equal(withBadTodos.todos[0]?.id, "ok");

    // loadSession soft-drops invalid roles from on-disk corruption
    {
      const dirty = createSession({
        cwd: tmp,
        provider: "xai",
        model: "m",
      });
      dirty.messages = [
        { role: "user", content: "keep" },
        { role: "hacker" as "user", content: "drop" },
        { role: "assistant", content: "ok" },
      ];
      dirty.todos = [
        { id: "t", content: "x", status: "pending" },
        { id: "bad", content: "y", status: "nope" as "pending" },
      ];
      saveSession(dirty);
      // Bypass saveSession normalize by writing raw JSON
      const dir = sessionDir(dirty.meta.id);
      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, "session.json"), "utf8"),
      );
      raw.messages.push({ role: "evil", content: "nope" });
      raw.todos.push({ id: "z", content: "z", status: "bogus" });
      fs.writeFileSync(
        path.join(dir, "session.json"),
        JSON.stringify(raw, null, 2),
      );
      const loaded = loadSession(dirty.meta.id);
      assert.ok(loaded);
      assert.ok(loaded!.messages.every((m) =>
        ["system", "user", "assistant", "tool"].includes(m.role),
      ));
      assert.ok(!loaded!.messages.some((m) => m.content === "nope"));
      assert.ok(loaded!.todos.every((t) =>
        ["pending", "in_progress", "completed", "cancelled"].includes(t.status),
      ));
    }

    // loadSession heals orphan tool_calls left by a crash mid-batch and re-saves
    {
      const mid = createSession({ cwd: tmp, provider: "xai", model: "m" });
      mid.messages = [
        { role: "user", content: "run" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_a",
              type: "function",
              function: { name: "bash", arguments: '{"command":"ls"}' },
            },
            {
              id: "call_b",
              type: "function",
              function: { name: "bash", arguments: '{"command":"pwd"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: "ok" },
        // call_b result missing — would 400 the next provider request
      ];
      saveSession(mid);
      // Write raw incomplete transcript (bypass any save-time heal)
      const midPath = path.join(sessionDir(mid.meta.id), "session.json");
      const rawMid = JSON.parse(fs.readFileSync(midPath, "utf8"));
      rawMid.messages = mid.messages;
      fs.writeFileSync(midPath, JSON.stringify(rawMid, null, 2));
      const healed = loadSession(mid.meta.id);
      assert.ok(healed);
      const tools = healed!.messages.filter((m) => m.role === "tool");
      assert.equal(tools.length, 2);
      assert.ok(tools.some((t) => t.tool_call_id === "call_b"));
      assert.ok(
        tools.some(
          (t) =>
            t.tool_call_id === "call_b" &&
            /interrupted|no result/i.test(String(t.content || "")),
        ),
      );
      // Disk should now contain the synthetic tool result (dirty re-save)
      const onDisk = JSON.parse(fs.readFileSync(midPath, "utf8"));
      const diskTools = (onDisk.messages || []).filter(
        (m: { role?: string }) => m.role === "tool",
      );
      assert.equal(diskTools.length, 2);
    }

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
    // forge run --continue uses the same finder (newest unlocked same-cwd)
    assert.ok(hit);
    assert.ok(hit!.meta);
    assert.equal(hit!.meta!.id, a.meta.id);
    assert.equal(hit!.skippedLocked, 0);
    assert.equal(findRecentSessionForCwd(path.join(tmp, "nope")), null);
    // Age filter: maxAgeDays=0 disables age cut
    assert.ok(findRecentSessionForCwd(tmp, { maxAgeDays: 0 })?.meta);
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
    assert.equal(findRecentSessionForCwd(tmp)!.meta!.id, locked.meta.id);
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
      assert.ok(afterSkip!.meta);
      assert.equal(afterSkip!.meta!.id, unlocked.meta.id);
      assert.equal(afterSkip!.skippedLocked, 1);
    } catch {
      assert.ok(afterSkip!.meta);
      assert.equal(afterSkip!.meta!.id, locked.meta.id);
      assert.equal(afterSkip!.skippedLocked, 0);
    }
    // skipLocked:false always returns newest regardless
    assert.equal(
      findRecentSessionForCwd(tmp, { skipLocked: false })!.meta!.id,
      locked.meta.id,
    );

    // When every same-cwd candidate is locked → meta null + skipped count
    const lockPath2 = path.join(
      tmp,
      "sessions",
      unlocked.meta.id,
      "session.lock",
    );
    fs.writeFileSync(
      lockPath2,
      JSON.stringify({
        pid: 1,
        hostname: "other-host",
        acquiredAt: new Date().toISOString(),
        sessionId: unlocked.meta.id,
      }),
    );
    try {
      process.kill(1, 0);
      const allLocked = findRecentSessionForCwd(tmp);
      assert.ok(allLocked);
      assert.equal(allLocked!.meta, null);
      assert.ok(allLocked!.skippedLocked >= 1);
      assert.ok(allLocked!.candidates >= 1);
    } catch {
      /* pid 1 not alive on this host — skip all-locked assertion */
    }
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

describe("formatRelativeTime", () => {
  it("formats compact ages for session pickers", async () => {
    const { formatRelativeTime } = await import("../src/util/format.js");
    const now = Date.parse("2026-04-01T12:00:00.000Z");
    assert.equal(formatRelativeTime(new Date(now - 10_000).toISOString(), now), "just now");
    assert.equal(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now), "5m");
    assert.equal(formatRelativeTime(new Date(now - 3 * 3600_000).toISOString(), now), "3h");
    assert.equal(formatRelativeTime(new Date(now - 4 * 86400_000).toISOString(), now), "4d");
    assert.equal(formatRelativeTime(null, now), "—");
    assert.equal(formatRelativeTime("not-a-date", now), "not-a-date".slice(0, 10));
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

  it("formatSessionShareCard is pasteable without secrets", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-share-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession,
      formatSessionShareCard,
      saveSession,
      setSessionPinned,
    } = await import("../src/session/session.js");
    const s = createSession({
      cwd: path.join(tmp, "ws"),
      provider: "xai",
      model: "m",
      title: "handoff-42",
    });
    s.messages.push({ role: "user", content: "hi" });
    s.messages.push({
      role: "assistant",
      content: "done with the fix — secret=should-not-matter",
    });
    s.meta.turnCount = 2;
    s.meta.editCount = 1;
    setSessionPinned(s, true);
    saveSession(s);
    const card = formatSessionShareCard(s);
    assert.match(card, /Forge session/);
    assert.match(card, /handoff-42/);
    assert.match(card, /forge --session/);
    assert.match(card, /handoff-42/); // title resume line
    assert.match(card, /PIN/);
    assert.match(card, /\/pin/);
    assert.match(card, /--continue/);
    assert.match(card, /sessions export/);
    assert.match(card, /\/last 3/);
    assert.match(card, /\/files/);
    assert.match(card, /path:/i);
    assert.match(card, /\/path/);
    assert.match(card, /Last assistant:/);
    assert.doesNotMatch(card, /api[_-]?key|sk-|password/i);
  });

  it("collectUsageStats aggregates runs and session inventory", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-usage-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const {
      appendSessionMetrics,
      collectUsageStats,
      formatUsageStats,
    } = await import("../src/session/metrics.js");
    const a = path.join(tmp, "proj-a");
    fs.mkdirSync(a);
    createSession({
      cwd: a,
      provider: "xai",
      model: "grok-test",
      title: "t1",
    });
    appendSessionMetrics({
      ts: new Date().toISOString(),
      type: "run_end",
      sessionId: "abc",
      provider: "xai",
      model: "grok-test",
      cwd: a,
      turns: 3,
      stopContinues: 0,
      editCount: 2,
      promptTokens: 1000,
      completionTokens: 200,
      estCostUsd: 0.01,
      durationMs: 5000,
      ok: true,
      headless: true,
      ultrawork: true,
    });
    appendSessionMetrics({
      ts: new Date().toISOString(),
      type: "run_end",
      sessionId: "def",
      provider: "anthropic",
      model: "claude-test",
      cwd: a,
      turns: 1,
      stopContinues: 0,
      editCount: 0,
      promptTokens: 100,
      completionTokens: 50,
      estCostUsd: 0.002,
      durationMs: 1000,
      ok: false,
      aborted: true,
      headless: false,
    });
    const stats = collectUsageStats();
    assert.equal(stats.runs, 2);
    assert.equal(stats.okRuns, 1);
    assert.equal(stats.abortedRuns, 1);
    assert.equal(stats.headlessRuns, 1);
    assert.equal(stats.ulwRuns, 1);
    assert.equal(stats.promptTokens, 1100);
    assert.equal(stats.completionTokens, 250);
    assert.ok(stats.byProvider.xai >= 1);
    assert.ok(stats.byProvider.anthropic >= 1);
    assert.ok(stats.sessions.total >= 1);
    assert.ok(stats.sessions.titled >= 1);
    assert.equal(typeof stats.sessions.pinned, "number");
    assert.ok(stats.sessions.pinned >= 0);
    const textOut = formatUsageStats(stats);
    assert.match(textOut, /Forge usage/);
    assert.match(textOut, /runs:/);
    assert.match(textOut, /By provider/);
    assert.match(textOut, /pinned=/);
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

  it("treats corrupt lock JSON and invalid acquiredAt as recoverable", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lock-bad-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, sessionDir } = await import(
      "../src/session/session.js"
    );
    const {
      acquireSessionLock,
      readSessionLock,
      releaseSessionLock,
    } = await import("../src/session/lock.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const lockFile = path.join(sessionDir(s.meta.id), "session.lock");

    // Garbage JSON → treated as absent
    fs.writeFileSync(lockFile, "{not-json", "utf8");
    assert.equal(readSessionLock(s.meta.id), null);
    const a1 = acquireSessionLock(s.meta.id);
    assert.equal(a1.ok, true);
    assert.equal(a1.owned, true);
    releaseSessionLock(s.meta.id);

    // Missing/invalid pid → absent
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ hostname: "x", acquiredAt: new Date().toISOString() }),
      "utf8",
    );
    assert.equal(readSessionLock(s.meta.id), null);

    // Dead foreign pid with invalid acquiredAt → still steal (dead = stale)
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid + 99999,
        hostname: "other",
        acquiredAt: "not-a-date",
        sessionId: s.meta.id,
      }),
      "utf8",
    );
    const a2 = acquireSessionLock(s.meta.id, { ttlMs: 60_000 });
    assert.equal(a2.ok, true);
    assert.equal(a2.owned, true);
    assert.equal(a2.stolen, true);
    releaseSessionLock(s.meta.id);

    // Live foreign pid (pid 1 when alive) with invalid acquiredAt must NOT be
    // treated as stale — only force steals live holders with bad timestamps.
    try {
      process.kill(1, 0);
      fs.writeFileSync(
        lockFile,
        JSON.stringify({
          pid: 1,
          hostname: "other-host",
          acquiredAt: "not-a-date",
          sessionId: s.meta.id,
        }),
        "utf8",
      );
      const blocked = acquireSessionLock(s.meta.id, { ttlMs: 60_000 });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.owned, false);
      assert.ok(blocked.holder);
      const forced = acquireSessionLock(s.meta.id, {
        ttlMs: 60_000,
        force: true,
      });
      assert.equal(forced.ok, true);
      assert.equal(forced.stolen, true);
      releaseSessionLock(s.meta.id);
    } catch {
      /* pid 1 not alive on this host — skip live-invalid-acquiredAt assertion */
    }
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
  it("emits bash/zsh/fish completions with run sandbox + sessions export flags", async () => {
    const { shellCompletionScript } = await import(
      "../src/util/completion-script.js"
    );
    const out = shellCompletionScript("bash");
    assert.match(out, /_forge_completions/);
    assert.match(out, /complete -F/);
    assert.match(out, /sessions/);
    assert.match(out, /show path export import fork pin unpin delete prune/);
    assert.match(out, /prune-metrics/);
    assert.match(out, /--session/);
    assert.match(out, /top_flags/);
    assert.match(out, /--new/);
    assert.match(out, /--sandbox/);
    assert.match(out, /--sandbox-network/);
    assert.match(out, /--deny/);
    assert.match(out, /--format/);
    assert.match(out, /md json markdown/);
    assert.match(out, /--max-age-days/);
    assert.match(out, /delete\) COMPREPLY=.*--force/);
    assert.match(out, /list\) COMPREPLY=.*--cwd/);
    assert.match(out, /list\) COMPREPLY=.*--query/);
    assert.match(out, /list\) COMPREPLY=.*--pinned/);
    assert.match(out, /--title/);
    assert.match(out, /\bstats\b/);
    assert.match(out, /stats\) COMPREPLY=.*--days/);
    const zsh = shellCompletionScript("zsh");
    assert.match(zsh, /compdef/);
    assert.match(zsh, /--sandbox/);
    assert.match(zsh, /--format/);
    assert.match(zsh, /--title/);
    assert.match(zsh, /\bstats\b/);
    assert.match(zsh, /delete\).*--force|values 'delete' --json --force/);
    assert.match(zsh, /values 'list' --json --limit -n --cwd --query -q --pinned/);
    const fish = shellCompletionScript("fish");
    assert.match(fish, /complete -c forge/);
    assert.match(fish, /l new/);
    assert.match(fish, /sandbox/);
    assert.match(fish, /__fish_seen_subcommand_from run/);
    assert.match(fish, /l format/);
    assert.match(fish, /md json markdown/);
    assert.match(fish, /l force/);
    assert.match(fish, /l query/);
    assert.match(fish, /l title/);
    assert.match(fish, /stats/);
  });
});

describe("sessions list cwd filter", () => {
  it("filters listSessions by cwd and query before limit", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-list-cwd-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, listSessions, setSessionTitle, saveSession } =
      await import("../src/session/session.js");
    const a = path.join(tmp, "proj-a");
    const b = path.join(tmp, "proj-b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    createSession({ cwd: a, provider: "xai", model: "m" });
    const s2 = createSession({ cwd: a, provider: "xai", model: "m" });
    setSessionTitle(s2, "incident-42-hotfix");
    saveSession(s2);
    createSession({ cwd: b, provider: "xai", model: "m" });
    const all = listSessions(50);
    assert.equal(all.length, 3);
    const byCwd = listSessions({ limit: 50, cwd: a });
    assert.equal(byCwd.length, 2);
    assert.ok(byCwd.every((s) => path.resolve(s.cwd!) === path.resolve(a)));
    // limit applies after filter (would miss if filter ran post-slice)
    const limited = listSessions({ limit: 1, cwd: a });
    assert.equal(limited.length, 1);
    const byQuery = listSessions({ limit: 50, query: "incident-42" });
    assert.equal(byQuery.length, 1);
    assert.match(byQuery[0]!.title || "", /incident-42/);
    const bareLimit = listSessions(2);
    assert.equal(bareLimit.length, 2);
    const titled = createSession({
      cwd: a,
      provider: "xai",
      model: "m",
      title: "ci-pipeline-99",
    });
    assert.equal(titled.meta.title, "ci-pipeline-99");
    const byCreateTitle = listSessions({ limit: 50, query: "ci-pipeline-99" });
    assert.equal(byCreateTitle.length, 1);
    assert.equal(byCreateTitle[0]!.id, titled.meta.id);
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

  it("listSessions skips corrupt session dirs without throwing", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-corrupt-list-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession,
      saveSession,
      listSessions,
      sessionDir,
    } = await import("../src/session/session.js");
    const good = createSession({ cwd: tmp, provider: "xai", model: "m" });
    good.meta.title = "good";
    saveSession(good);

    // Garbage session directory (invalid JSON + no valid meta)
    const badId = "00000000-0000-4000-8000-000000000099";
    const badDir = path.join(tmp, "sessions", badId);
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "session.json"), "{not-json");
    fs.writeFileSync(path.join(badDir, "meta.json"), "null");

    // Truncated / wrong-shape meta
    const bad2 = "00000000-0000-4000-8000-000000000098";
    const bad2Dir = path.join(tmp, "sessions", bad2);
    fs.mkdirSync(bad2Dir, { recursive: true });
    fs.writeFileSync(
      path.join(bad2Dir, "meta.json"),
      JSON.stringify({ notAnId: true }),
    );

    assert.doesNotThrow(() => listSessions(50));
    const list = listSessions(50);
    assert.ok(list.some((m) => m.id === good.meta.id));
    assert.ok(!list.some((m) => m.id === badId || m.id === bad2));
    // loadSessionMeta must also be null-safe
    const { loadSessionMeta } = await import("../src/session/session.js");
    assert.equal(loadSessionMeta(badId), null);
    void sessionDir;
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
    assert.equal(typeof pruned.skippedLocked, "number");
  });

  it("/new [title] labels the fresh session", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-new-title-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, listSessions } = await import(
      "../src/session/session.js"
    );
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const current = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/new incident-hotfix", {
      session: current,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.ok(r.replaceSession);
    assert.equal(r.replaceSession!.meta.title, "incident-hotfix");
    assert.match(String(r.output || ""), /incident-hotfix/);
    const found = listSessions({ limit: 10, query: "incident-hotfix" });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, r.replaceSession!.meta.id);
  });

  it("/resume warns on foreign live lock", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { spawn } = await import("node:child_process");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-lock-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession,
      sessionDir,
    } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const holder = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      stdio: "ignore",
    });
    try {
      const target = createSession({ cwd: tmp, provider: "xai", model: "m" });
      const current = createSession({ cwd: tmp, provider: "xai", model: "m" });
      fs.writeFileSync(
        path.join(sessionDir(target.meta.id), "session.lock"),
        JSON.stringify({
          pid: holder.pid,
          hostname: "other",
          acquiredAt: new Date().toISOString(),
          sessionId: target.meta.id,
        }),
        "utf8",
      );
      const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
      const r = await handleSlash(`/resume ${target.meta.id.slice(0, 8)}`, {
        session: current,
        config: { ...DEFAULT_CONFIG, workspace: tmp },
        hooks,
      });
      assert.equal(r.handled, true);
      assert.match(String(r.output || ""), /Resumed/i);
      assert.match(String(r.output || ""), /locked by another live process/i);
      assert.ok(r.replaceSession);
      assert.equal(r.replaceSession!.meta.id, target.meta.id);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("deleteSession refuses foreign live locks unless force", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { spawn } = await import("node:child_process");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-del-lock-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession,
      deleteSession,
      deleteSessionDetailed,
      sessionDir,
      listSessions,
    } = await import("../src/session/session.js");
    const holder = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      stdio: "ignore",
    });
    try {
      const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
      fs.writeFileSync(
        path.join(sessionDir(s.meta.id), "session.lock"),
        JSON.stringify({
          pid: holder.pid,
          hostname: "other",
          acquiredAt: new Date().toISOString(),
          sessionId: s.meta.id,
        }),
        "utf8",
      );
      assert.equal(deleteSession(s.meta.id), false);
      const detailed = deleteSessionDetailed(s.meta.id);
      assert.equal(detailed.ok, false);
      if (!detailed.ok) assert.equal(detailed.reason, "locked");
      assert.ok(listSessions(5).some((m) => m.id === s.meta.id));
      assert.equal(deleteSession(s.meta.id, { force: true }), true);
      assert.equal(listSessions(5).some((m) => m.id === s.meta.id), false);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("pruneSessions skips foreign live locks", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { spawn } = await import("node:child_process");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prune-lock-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession,
      listSessions,
      pruneSessions,
      sessionDir,
    } = await import("../src/session/session.js");
    // Hold a real live foreign pid (sandbox may block kill(1,0))
    const holder = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      stdio: "ignore",
    });
    try {
      const keep = createSession({ cwd: tmp, provider: "xai", model: "m" });
      const locked = createSession({ cwd: tmp, provider: "xai", model: "m" });
      const old = createSession({ cwd: tmp, provider: "xai", model: "m" });
      // Patch meta.json directly — saveSession() always rewrites updatedAt=now.
      const patchAge = (id: string, daysAgo: number) => {
        const p = path.join(sessionDir(id), "meta.json");
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        raw.updatedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
        fs.writeFileSync(p, JSON.stringify(raw));
      };
      patchAge(locked.meta.id, 20);
      patchAge(old.meta.id, 30);
      patchAge(keep.meta.id, 0);
      const lockFile = path.join(sessionDir(locked.meta.id), "session.lock");
      fs.writeFileSync(
        lockFile,
        JSON.stringify({
          pid: holder.pid,
          hostname: "other-host",
          acquiredAt: new Date().toISOString(),
          sessionId: locked.meta.id,
        }),
        "utf8",
      );
      const pruned = pruneSessions({ keep: 1 });
      assert.ok(pruned.skippedLocked >= 1);
      assert.ok(
        listSessions(10).some((s) => s.id === locked.meta.id),
        "foreign-locked session must survive prune",
      );
      assert.ok(
        pruned.deleted.includes(old.meta.id),
        "unlocked old session must be pruned when over keep",
      );
      assert.ok(
        listSessions(10).some((s) => s.id === keep.meta.id),
        "newest session must remain under keep=1",
      );
    } finally {
      holder.kill("SIGKILL");
    }
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

describe("clipboard helper", () => {
  it("copyToClipboard returns structured result", async () => {
    const { copyToClipboard } = await import("../src/util/clipboard.js");
    // Empty string is still valid clipboard content
    const r = copyToClipboard("forge-clipboard-test");
    assert.equal(typeof r.ok, "boolean");
    if (r.ok) {
      assert.ok(r.backend.length > 0);
    } else {
      assert.match(r.error, /clipboard|pbcopy|clip|wl-copy|xclip|xsel/i);
    }
  });
});
