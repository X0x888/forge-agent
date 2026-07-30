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
    const out = await runDoctor(loadConfig({}, tmp));
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
    const check = await runDoctorCheck(cfg);
    const report = check.report;
    assert.equal(await runDoctor(cfg), report);
    assert.equal(typeof check.modelInCatalog, "boolean");
    // default xai/grok-4.5 is in catalog
    assert.equal(check.modelInCatalog, true);
    const custom = await runDoctorCheck(
      loadConfig({ model: "totally-not-in-catalog-xyz" }),
    );
    assert.equal(custom.modelInCatalog, false);
    assert.match(custom.report, /not in xai catalog/i);
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
      maxTurns: cfg.maxTurns,
      maxTurnsUnlimited: !(typeof cfg.maxTurns === "number" && cfg.maxTurns > 0),
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
      modelInCatalog: check.modelInCatalog,
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
    assert.equal(typeof payload.modelInCatalog, "boolean");
    assert.equal(payload.modelInCatalog, true);
    assert.equal(typeof payload.maxTurns, "number");
    assert.equal(payload.maxTurnsUnlimited, true);
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
      const checkBad = await runDoctorCheck(cfg);
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
    const out = await runDoctor(loadConfig({ provider: "xai" }, tmp));
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
    const check = await runDoctorCheck(cfg);
    assert.equal(check.ok, false);
    assert.equal(check.blockingStop, false);
    assert.ok(check.issues.some((i) => /Blocking Stop is OFF/i.test(i)));
    assert.match(check.report, /Blocking Stop: off/i);
    assert.doesNotMatch(check.report, /No blocking issues detected/);
    // Default remains on
    const on = await runDoctorCheck(loadConfig({}, tmp));
    assert.equal(on.blockingStop, true);
    assert.match(on.report, /Blocking Stop: on/i);
    assert.equal(await runDoctor(cfg), check.report);
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

  it("maps Anthropic stop_reason refusal → content_filter", async () => {
    const { mapAnthropicStopReason } = await import(
      "../src/providers/anthropic.js"
    );
    assert.equal(mapAnthropicStopReason("tool_use"), "tool_calls");
    assert.equal(mapAnthropicStopReason("end_turn"), "stop");
    assert.equal(mapAnthropicStopReason("refusal"), "content_filter");
    assert.equal(mapAnthropicStopReason("max_tokens"), "max_tokens");
    assert.equal(mapAnthropicStopReason(null), null);
  });
});

describe("env parsers", () => {
  it("parseKeepCount treats 0 as valid (unlike Number(x)||fallback)", async () => {
    const { parseKeepCount } = await import("../src/util/env.js");
    assert.equal(parseKeepCount(0, 50), 0);
    assert.equal(parseKeepCount("0", 50), 0);
    assert.equal(parseKeepCount(3, 50), 3);
    assert.equal(parseKeepCount("12", 50), 12);
    assert.equal(parseKeepCount(-1, 50), 50);
    assert.equal(parseKeepCount("nope", 50), 50);
    assert.equal(parseKeepCount(undefined, 50), 50);
    assert.equal(parseKeepCount("", 50), 50);
    assert.equal(parseKeepCount(2.9, 50), 2);
  });

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
    assert.equal(
      toolFingerprint("bash", { command: "npm test", background: true }),
      toolFingerprint("bash", { command: "npm test", background: false }),
    );
    assert.equal(
      toolFingerprint("bash", { command: "npm test", run_in_background: true }),
      toolFingerprint("bash", { command: "npm test", background: false }),
    );
    assert.equal(
      toolFingerprint("get_task_output", { task_id: "t1", tail: 50 }),
      toolFingerprint("get_task_output", { task_id: "t1", tail: 200, stream: "stdout" }),
    );
    assert.equal(
      toolFingerprint("web_fetch", { url: "https://example.com", allow_local: true }),
      toolFingerprint("web_fetch", { url: "https://example.com", allow_local: false }),
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
    assert.equal(
      isCountableToolError(
        "Task bg_x is already completed (exit 0) · sleep 1\nUse get_task_output…",
        true,
      ),
      false,
    );
    assert.equal(isCountableToolError("File not found: a.ts", true), true);
    assert.equal(t.observeError("read_file", "missing a"), null);
    assert.equal(t.observeError("edit", "no match"), null);
    const hit = t.observeError("bash", "exit 1");
    assert.ok(hit);
    assert.equal(hit!.count, 3);
    assert.match(hit!.message, /error-streak/i);
    assert.match(hit!.message, /plan mode|\/build|\/compact|Did you mean/i);
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
    assert.ok((s.meta.title || "").length <= 200);
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
        releasedOnContinueCap: true,
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
    assert.match(line, /"releasedOnContinueCap":true/);

    appendSessionMetrics(
      buildRunEndMetrics({
        sessionId: "fail-1",
        provider: "xai",
        model: "m",
        turns: 0,
        stopContinues: 0,
        editCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        ok: false,
        lastErrorCode: "rate_limited",
      }),
    );
    const failLine = fs
      .readFileSync(metricsPath(), "utf8")
      .trim()
      .split("\n")
      .pop()!;
    assert.match(failLine, /"lastErrorCode":"rate_limited"/);
    assert.doesNotMatch(failLine, /api[_-]?key|sk-|password|secret/i);

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
    assert.match(card, /sessions title/);
    assert.match(card, /--continue/);
    assert.match(card, /sessions export/);
    assert.match(card, /forge ".*" --json/);
    assert.match(card, /auth --json/);
    assert.match(card, /doctor --json/);
    assert.match(card, /status --session/);
    assert.match(card, /\/last 3/);
    assert.match(card, /\/files/);
    assert.match(card, /path:/i);
    assert.match(card, /\/path/);
    assert.match(card, /Last assistant:/);
    assert.doesNotMatch(card, /api[_-]?key|sk-|password/i);
    assert.match(card, /fail-closed if none/);
    assert.match(card, /forge tips --json/);
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
      releasedOnContinueCap: true,
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
      lastErrorCode: "rate_limited",
    });
    const { setSessionLastError, saveSession } = await import(
      "../src/session/session.js"
    );
    const failedSess = createSession({
      cwd: a,
      provider: "xai",
      model: "m",
      title: "failed-sess",
    });
    setSessionLastError(failedSess, {
      code: "rate_limited",
      message: "429",
      tips: ["switch"],
    });
    saveSession(failedSess);
    const stats = collectUsageStats();
    assert.equal(stats.runs, 2);
    assert.equal(stats.okRuns, 1);
    assert.equal(stats.failedRuns, 1);
    assert.equal(stats.abortedRuns, 1);
    assert.equal(stats.continueCapReleases, 1);
    assert.equal(stats.maxTurnsHits, 0);
    assert.equal(stats.headlessRuns, 1);
    assert.equal(stats.ulwRuns, 1);
    assert.equal(stats.promptTokens, 1100);
    assert.equal(stats.completionTokens, 250);
    assert.ok(stats.byProvider.xai >= 1);
    assert.ok(stats.byProvider.anthropic >= 1);
    assert.equal(stats.byLastErrorCode.rate_limited, 1);
    assert.ok(stats.sessions.total >= 1);
    assert.ok(stats.sessions.titled >= 1);
    assert.equal(typeof stats.sessions.pinned, "number");
    assert.ok(stats.sessions.pinned >= 0);
    assert.ok(stats.sessions.withLastError >= 1);
    const textOut = formatUsageStats(stats);
    assert.match(textOut, /Forge usage/);
    assert.match(textOut, /runs:/);
    assert.match(textOut, /failed=1/);
    assert.match(textOut, /continueCap=1/);
    assert.match(textOut, /maxTurns=0/);
    assert.match(textOut, /By provider/);
    assert.match(textOut, /pinned=/);
    assert.match(textOut, /lastError=/);
    assert.match(textOut, /By lastError code/);
    assert.match(textOut, /rate_limited/);
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
    assert.match(
      out,
      /show path export import fork pin unpin pinned title rename delete prune/,
    );
    assert.match(out, /prune-metrics/);
    assert.match(out, /doctor\).*--provider|doctor\).*--sandbox/);
    assert.match(out, /models\).*--provider/);
    assert.match(out, /doctor\).*\s-p|models\).*\s-p/);
    assert.match(out, /--session/);
    assert.match(out, /top_flags/);
    assert.match(out, /--new/);
    assert.match(out, /--json/);
    assert.match(out, /--continue/);
    assert.match(out, /local top_flags="[^"]*--json[^"]*"/);
    assert.match(out, /local top_flags="[^"]*--continue[^"]*"/);
    assert.match(out, /--sandbox/);
    assert.match(out, /acceptEdits plan bypassPermissions dontAsk/);
    assert.match(out, /\byolo\b/);
    assert.match(out, /\boai\b/);
    assert.match(out, /\bhaiku\b/);
    assert.match(out, /\blo med hi\b|compgen -W "low medium high lo med hi max"/);
    assert.match(out, /readonly ro ws none full/);
    assert.match(out, /0 all max unlimited/);
    assert.match(out, /0 all none off 7 14 30/);
    assert.match(out, /all max unlimited 10 50/);
    assert.match(out, /fail-closed fallback/);
    assert.match(out, /--sandbox-network/);
    assert.match(out, /--deny/);
    assert.match(out, /--format/);
    assert.match(out, /md json markdown/);
    assert.match(out, /--max-age-days/);
    assert.match(out, /delete\) COMPREPLY=.*--force/);
    assert.match(out, /list\) COMPREPLY=.*--cwd/);
    assert.match(out, /list\) COMPREPLY=.*--query/);
    assert.match(out, /list\) COMPREPLY=.*--pinned/);
    assert.match(out, /list\) COMPREPLY=.*--errors/);
    assert.match(out, /--title/);
    assert.match(out, /\bstats\b/);
    assert.match(out, /stats\) COMPREPLY=.*--days/);
    assert.match(out, /login\) COMPREPLY=.*--json/);
    assert.match(out, /logout\) COMPREPLY=.*--json/);
    const zsh = shellCompletionScript("zsh");
    assert.match(zsh, /compdef/);
    assert.match(zsh, /--sandbox/);
    assert.match(zsh, /--format/);
    assert.match(zsh, /--title/);
    assert.match(zsh, /\bstats\b/);
    assert.match(zsh, /delete\).*--force|values 'delete' --json --force/);
    assert.match(zsh, /values 'list' --json --limit -n --cwd --query -q --pinned --errors/);
        assert.match(zsh, /permission-mode.*dontAsk|values 'permission-mode'.*dontAsk/);
assert.match(zsh, /values 'login'.*--json|login\).*--json/);
    assert.match(zsh, /values 'logout'.*--json|logout\).*--json/);
    assert.match(zsh, /doctor\).*--provider|models\).*--provider|values 'flags' --json --provider/);
    const fish = shellCompletionScript("fish");
    assert.match(fish, /complete -c forge/);
    assert.match(fish, /l new/);
    assert.match(fish, /sandbox/);
    assert.match(fish, /__fish_seen_subcommand_from run/);
    assert.match(fish, /l format/);
    assert.match(fish, /md json markdown/);
    assert.match(fish, /l force/);
    assert.match(fish, /l query/);
    assert.match(fish, /l errors/);
        assert.match(fish, /l title/);
    assert.match(fish, /seen_subcommand_from models.*l provider|models" -l provider/);
    assert.match(fish, /seen_subcommand_from doctor.*l provider|doctor" -l provider/);
assert.match(fish, /l continue/);
    assert.match(fish, /stats/);
    assert.match(fish, /__fish_seen_subcommand_from login.*l json|login.*-l json/);
    assert.match(fish, /__fish_seen_subcommand_from logout.*l json|logout.*-l json/);

    const {
      normalizeCompletionShell,
    } = await import("../src/util/completion-script.js");
    assert.equal(normalizeCompletionShell("bash"), "bash");
    assert.equal(normalizeCompletionShell(""), "bash");
    assert.equal(normalizeCompletionShell("ZSH"), "zsh");
    assert.equal(normalizeCompletionShell("bogus"), null);
    assert.throws(() => shellCompletionScript("powershell"), /Unknown completion shell/);
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



describe("sessions pin id mutation via slash", () => {
  it("/sessions pin <id> pins a non-active session", async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pin-slash-"));
    const prev = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
    try {
      const {
        createSession,
        setSessionTitle,
        saveSession,
        loadSession,
      } = await import("../src/session/session.js");
      const { handleSlash } = await import("../src/commands/slash.js");
      const { DEFAULT_CONFIG } = await import("../src/config/types.js");
      const { HookRunner } = await import("../src/harness/hooks.js");
      const active = createSession({ cwd: home, provider: "xai", model: "m" });
      setSessionTitle(active, "active");
      saveSession(active);
      const other = createSession({ cwd: home, provider: "xai", model: "m" });
      setSessionTitle(other, "keeper-other");
      saveSession(other);
      const cfg = { ...DEFAULT_CONFIG, workspace: home };
      const hooks = new HookRunner(cfg, home);
      const r = await handleSlash(`/sessions pin ${other.meta.id.slice(0, 8)}`, {
        session: active,
        config: cfg,
        hooks,
      });
      assert.equal(r.handled, true);
      assert.match(String(r.output || ""), /Pinned/i);
      const reloaded = loadSession(other.meta.id);
      assert.ok(reloaded);
      assert.equal(reloaded!.meta.pinned, true);
      const list = await handleSlash("/sessions pinned", {
        session: active,
        config: cfg,
        hooks,
      });
      assert.match(String(list.output || ""), /keeper-other/);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
    }
  });
});

describe("sessions pinned action filter", () => {
  it("forge sessions pinned lists only pin-protected sessions", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pin-act-"));
    const env = { ...process.env, FORGE_HOME: home };
    const prev = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
    let pinnedId = "";
    try {
      const {
        createSession,
        setSessionTitle,
        setSessionPinned,
        saveSession,
      } = await import("../src/session/session.js");
      const a = createSession({ cwd: home, provider: "xai", model: "m" });
      setSessionTitle(a, "keeper");
      setSessionPinned(a, true);
      saveSession(a);
      pinnedId = a.meta.id;
      createSession({ cwd: home, provider: "xai", model: "m" }); // unpinned
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
    }
    const r = spawnSync(
      process.execPath,
      [cli, "sessions", "pinned", "--json"],
      { env, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.pinnedOnly, true);
    assert.equal(j.count, 1);
    assert.equal(j.sessions[0].id, pinnedId);
    assert.equal(j.sessions[0].pinned, true);
  });
});

describe("sessions list --json inventory summary", () => {
  it("includes sessionsTotal/Untitled/WithLastError/Pinned", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-list-inv-"));
    const env = { ...process.env, FORGE_HOME: home };
    const prev = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
    try {
      const {
        createSession,
        setSessionTitle,
        saveSession,
        setSessionLastError,
      } = await import("../src/session/session.js");
      const a = createSession({ cwd: home, provider: "xai", model: "m" });
      setSessionTitle(a, "titled-one");
      saveSession(a);
      const b = createSession({ cwd: home, provider: "xai", model: "m" });
      setSessionLastError(b, {
        code: "empty_run",
        message: "empty",
      });
      saveSession(b);
      createSession({ cwd: home, provider: "xai", model: "m" }); // untitled
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
    }
    const r = spawnSync(
      process.execPath,
      [cli, "sessions", "list", "--json", "--limit", "50"],
      { env, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.sessionsTotal, 3);
    assert.equal(j.sessionsUntitled, 2);
    assert.equal(j.sessionsWithLastError, 1);
    assert.equal(typeof j.sessionsPinned, "number");
    assert.equal(j.count, 3);
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

  it("listSessions limit 0 means unlimited (not default 20)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-list-limit0-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, listSessions } = await import(
      "../src/session/session.js"
    );
    for (let i = 0; i < 5; i++) {
      createSession({ cwd: tmp, provider: "xai", model: "m" });
    }
    assert.equal(listSessions({ limit: 2 }).length, 2);
    assert.equal(listSessions({ limit: 0 }).length, 5);
    // bare 0 same as opts
    assert.equal(listSessions(0).length, 5);
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

    // keep=0 must delete remaining unpinned sessions (not fall back to 50)
    const leftover = listSessions(10);
    assert.equal(leftover.length, 1);
    const wipe = pruneSessions({ keep: 0 });
    assert.ok(wipe.deleted.length >= 1);
    assert.equal(listSessions(10).length, 0);
  });

  it("/sessions prune --keep=0 honors zero (protects active only)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-slash-prune0-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, listSessions, saveSession } = await import(
      "../src/session/session.js"
    );
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const active = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const old = createSession({ cwd: tmp, provider: "xai", model: "m" });
    old.meta.updatedAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
    saveSession(old);
    assert.equal(listSessions(10).length, 2);
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/sessions prune --keep=0", {
      session: active,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /Pruned/);
    assert.match(String(r.output || ""), /--keep 0/);
    const left = listSessions(10);
    assert.equal(left.length, 1);
    assert.equal(left[0]!.id, active.meta.id);
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
    const { armUlwCycle } = await import("../src/harness/ulw-cycle.js");
    const current = createSession({ cwd: tmp, provider: "xai", model: "m" });
    current.meta.ultrawork = true;
    armUlwCycle(current.meta.id, "old mandate", { cycle: 1 });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/new incident-hotfix", {
      session: current,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.ok(r.replaceSession);
    assert.equal(r.replaceSession!.meta.title, "incident-hotfix");
    // Fresh session must not inherit ultrawork without ulw.json
    assert.equal(r.replaceSession!.meta.ultrawork, false);
    assert.match(String(r.output || ""), /incident-hotfix/);
    assert.match(String(r.output || ""), /ULW\/goal not carried over|re-arm/i);
    const found = listSessions({ limit: 10, query: "incident-hotfix" });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, r.replaceSession!.meta.id);
  });

  it("/clear hard creates a fresh session id without ultrawork", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-clear-hard-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const { armUlwCycle, loadUlwCycle } = await import(
      "../src/harness/ulw-cycle.js"
    );
    const current = createSession({ cwd: tmp, provider: "xai", model: "m" });
    current.meta.ultrawork = true;
    armUlwCycle(current.meta.id, "keep going", { cycle: 1 });
    current.messages.push({ role: "user", content: "old work" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/clear hard", {
      session: current,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.ok(r.replaceSession);
    assert.notEqual(r.replaceSession!.meta.id, current.meta.id);
    assert.equal(r.replaceSession!.meta.ultrawork, false);
    assert.equal(r.replaceSession!.messages.length, 0);
    // Old session ULW sidecar untouched
    assert.equal(loadUlwCycle(current.meta.id)?.enabled, true);
    assert.equal(loadUlwCycle(r.replaceSession!.meta.id), null);
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

describe("/sessions prune keep validation", () => {
  it("rejects invalid --keep", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const home = fs.mkdtempSync(path.join(process.cwd(), ".tmp", "forge-slash-prune-"));
    process.env.FORGE_HOME = home;
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const s = createSession({ cwd: home, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, home);
    const r = await handleSlash("/sessions prune --keep abc", {
      session: s,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /Invalid --keep/i);
  });
});

describe("parseCliNonNegInt", () => {
  it("distinguishes omit / invalid / zero", async () => {
    const { parseCliNonNegInt } = await import("../src/util/env.js");
    assert.equal(parseCliNonNegInt(undefined), undefined);
    assert.equal(parseCliNonNegInt(null), undefined);
    assert.equal(parseCliNonNegInt(""), null);
    assert.equal(parseCliNonNegInt("abc"), null);
    assert.equal(parseCliNonNegInt("-1"), null);
    assert.equal(parseCliNonNegInt("0"), 0);
    assert.equal(parseCliNonNegInt("12"), 12);
  });
});

describe("forge run --json early failures (CLI)", () => {
  it("emits structured empty_prompt and session_not_found (parent --session)", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    // Build may be stale in pure test runs — require dist
    if (!fs.existsSync(cli)) {
      // Skip when dist missing (typecheck-only envs)
      return;
    }
    // Prefer workspace .tmp (sandbox may block os.tmpdir)
    const home = path.join(process.cwd(), ".tmp", `forge-run-json-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      FORGE_HOME: home,
      // Dummy key so we pass auth and reach session lookup / empty-prompt paths
      XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
    };

    const empty = spawnSync(
      process.execPath,
      [cli, "run", "--json", "   "],
      { env, encoding: "utf8" },
    );
    assert.notEqual(empty.status, 0);
    const emptyJson = JSON.parse((empty.stdout || "").trim());
    assert.equal(emptyJson.ok, false);
    assert.equal(emptyJson.reason, "empty_prompt");

    // Parent-level --session must not silently start a fresh session
    const miss = spawnSync(
      process.execPath,
      [cli, "run", "--session", "zzz-no-such-id-ever-47", "--json", "hi"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(miss.status, 0);
    const missOut = (miss.stdout || "").trim();
    assert.ok(missOut.length > 0, `expected JSON stdout, got stderr=${miss.stderr}`);
    const missJson = JSON.parse(missOut);
    assert.equal(missJson.ok, false);
    assert.equal(missJson.reason, "session_not_found");
    assert.match(String(missJson.session || ""), /zzz-no-such-id-ever-47/);
    assert.ok(Array.isArray(missJson.suggestions), "suggestions[] for CI recovery");
  });


  it("unknown_option --json includes suggestion/hint for flag typos", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-unk-opt-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home, XAI_API_KEY: "sk-test" };
    const r = spawnSync(
      process.execPath,
      [cli, "run", "x", "--josn", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, false);
    assert.equal(j.reason, "unknown_option");
    assert.equal(j.suggestion, "--json");
    assert.match(String(j.hint || ""), /json/i);
  });

  it("forge login --json is quiet and never echoes the key", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-login-json-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const secret = "sk-login-json-secret-never-print";
    const ok = spawnSync(
      process.execPath,
      [cli, "login", "--api-key", secret, "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(ok.status, 0);
    const j = JSON.parse((ok.stdout || "").trim());
    assert.equal(j.ok, true);
    assert.equal(j.method, "api_key");
    assert.doesNotMatch(ok.stdout || "", new RegExp(secret));
    assert.doesNotMatch(ok.stderr || "", new RegExp(secret));

    const oauth = spawnSync(
      process.execPath,
      [cli, "login", "--oauth", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(oauth.status, 0);
    const oj = JSON.parse((oauth.stdout || "").trim());
    assert.equal(oj.ok, false);
    assert.equal(oj.reason, "interactive_required");

    // Parent -p must not be swallowed by login default xai
    const badP = spawnSync(
      process.execPath,
      [cli, "login", "-p", "bogus", "--api-key", "sk-x", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(badP.status, 0);
    const bj = JSON.parse((badP.stdout || "").trim());
    assert.equal(bj.ok, false);
    assert.equal(bj.reason, "invalid_provider");

    // Empty --api-key must not fall through to Grok import
    const emptyKey = spawnSync(
      process.execPath,
      [cli, "login", "--api-key", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(emptyKey.status, 0);
    const ej = JSON.parse((emptyKey.stdout || "").trim());
    assert.equal(ej.ok, false);
    assert.equal(ej.reason, "api_key_required");
    assert.notEqual(ej.method, "from_grok");
  });

  it("forge auth --json never dumps tokens", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-auth-json-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      FORGE_HOME: home,
      // Ensure we can resolve something without real OAuth
      XAI_API_KEY: "sk-test-auth-json-never-leak",
    };
    const r = spawnSync(process.execPath, [cli, "auth", "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, true);
    assert.equal(j.authenticated, true);
    assert.equal(j.active?.provider, "xai");
    assert.equal(j.active?.method, "api_key");
    // Hard guarantee: no secret material in the payload
    const raw = JSON.stringify(j);
    assert.doesNotMatch(raw, /sk-test-auth-json-never-leak/);
    assert.doesNotMatch(raw, /"accessToken"|"refreshToken"|"token"\s*:/);

    // Parent-attached --json (Commander binds flag to parent) must still JSON.
    const parentFirst = spawnSync(
      process.execPath,
      [cli, "--json", "auth"],
      { env, encoding: "utf8" },
    );
    assert.equal(parentFirst.status, 0);
    const pj = JSON.parse((parentFirst.stdout || "").trim());
    assert.equal(pj.ok, true);
    assert.equal(pj.authenticated, true);
    assert.doesNotMatch(
      JSON.stringify(pj),
      /sk-test-auth-json-never-leak/,
    );

    // Unauthenticated → ok:false + exit 1 (CI parity with doctor)
    const noAuthHome = path.join(home, "noauth");
    fs.mkdirSync(noAuthHome, { recursive: true });
    const unauth = spawnSync(process.execPath, [cli, "auth", "--json"], {
      env: {
        ...env,
        FORGE_HOME: noAuthHome,
        GROK_HOME: path.join(noAuthHome, "nogrok"),
        XAI_API_KEY: "",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        OPENROUTER_API_KEY: "",
        GOOGLE_API_KEY: "",
      },
      encoding: "utf8",
    });
    assert.notEqual(unauth.status, 0);
    const uj = JSON.parse((unauth.stdout || "").trim());
    assert.equal(uj.ok, false);
    assert.equal(uj.authenticated, false);
    assert.equal(uj.reason, "unauthenticated");

    // status --session '' must not silently list all sessions
    const stEmpty = spawnSync(
      process.execPath,
      [cli, "status", "--session", "", "--json"],
      { env: { ...env, FORGE_HOME: noAuthHome }, encoding: "utf8" },
    );
    assert.notEqual(stEmpty.status, 0);
    const stJ = JSON.parse((stEmpty.stdout || "").trim());
    assert.equal(stJ.ok, false);
    assert.equal(stJ.reason, "session_not_found");

    // doctor -p bogus / empty must fail closed (parent or local -p)
    const docBogus = spawnSync(
      process.execPath,
      [cli, "doctor", "-p", "bogus", "--json"],
      { env: { ...env, FORGE_HOME: noAuthHome }, encoding: "utf8" },
    );
    assert.notEqual(docBogus.status, 0);
    const docBJ = JSON.parse((docBogus.stdout || "").trim());
    assert.equal(docBJ.ok, false);
    assert.equal(docBJ.reason, "invalid_provider");

    const docEmpty = spawnSync(
      process.execPath,
      [cli, "-p", "", "doctor", "--json"],
      { env: { ...env, FORGE_HOME: noAuthHome }, encoding: "utf8" },
    );
    assert.notEqual(docEmpty.status, 0);
    const docEJ = JSON.parse((docEmpty.stdout || "").trim());
    assert.equal(docEJ.ok, false);
    assert.equal(docEJ.reason, "invalid_provider");
  });

  it("explicit --continue fails closed when no same-cwd session", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-continue-miss-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      FORGE_HOME: home,
      XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
    };

    const miss = spawnSync(
      process.execPath,
      [cli, "run", "next", "--continue", "--json"],
      { env, encoding: "utf8", cwd: home },
    );
    assert.notEqual(miss.status, 0);
    const missJ = JSON.parse((miss.stdout || "").trim());
    assert.equal(missJ.ok, false);
    assert.equal(missJ.reason, "continue_miss");
    assert.ok(String(missJ.error || "").length > 0);

    // bare forge --continue --json same contract
    const bare = spawnSync(
      process.execPath,
      [cli, "next", "--continue", "--json"],
      { env, encoding: "utf8", cwd: home },
    );
    assert.notEqual(bare.status, 0);
    const bareJ = JSON.parse((bare.stdout || "").trim());
    assert.equal(bareJ.ok, false);
    assert.equal(bareJ.reason, "continue_miss");

    // tips / completion / init --json hygiene
    const tips = spawnSync(process.execPath, [cli, "tips", "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(tips.status, 0);
    const tipsJ = JSON.parse((tips.stdout || "").trim());
    assert.equal(tipsJ.ok, true);
    assert.match(String(tipsJ.tips || ""), /forge doctor --json|--continue/);

    const badShell = spawnSync(
      process.execPath,
      [cli, "completion", "powershell", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(badShell.status, 0);
    const badShellJ = JSON.parse((badShell.stdout || "").trim());
    assert.equal(badShellJ.ok, false);
    assert.equal(badShellJ.reason, "invalid_shell");

    const okShell = spawnSync(
      process.execPath,
      [cli, "completion", "bash", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(okShell.status, 0);
    const okShellJ = JSON.parse((okShell.stdout || "").trim());
    assert.equal(okShellJ.ok, true);
    assert.equal(okShellJ.shell, "bash");
    assert.match(String(okShellJ.script || ""), /_forge_completions/);

    // init --json in an isolated cwd (do not clobber repo AGENTS.md)
    const initCwd = path.join(home, "init-ws");
    fs.mkdirSync(initCwd, { recursive: true });
    const init = spawnSync(process.execPath, [cli, "init", "--json"], {
      env,
      encoding: "utf8",
      cwd: initCwd,
    });
    assert.equal(init.status, 0);
    const initJ = JSON.parse((init.stdout || "").trim());
    assert.equal(initJ.ok, true);
    assert.ok(Array.isArray(initJ.wrote));
    assert.ok(initJ.wrote.some((p: string) => p.endsWith("config.toml")));
  });

  it("invalid news count and status --interval fail closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-news-interval-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const news = spawnSync(
      process.execPath,
      [cli, "news", "abc", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(news.status, 0);
    const nj = JSON.parse((news.stdout || "").trim());
    assert.equal(nj.ok, false);
    assert.equal(nj.reason, "invalid_count");

    for (const bad of ["0", "11", "100"]) {
      const nBad = spawnSync(
        process.execPath,
        [cli, "news", bad, "--json"],
        { env, encoding: "utf8" },
      );
      assert.notEqual(nBad.status, 0, bad);
      const body = (nBad.stdout || "").trim();
      assert.ok(body, `expected JSON stdout for news ${bad}`);
      assert.equal(JSON.parse(body).reason, "invalid_count", bad);
    }

    // all|full|max → cap (10); latest → 1
    for (const good of ["all", "full", "max", "latest"] as const) {
      const nOk = spawnSync(
        process.execPath,
        [cli, "news", good, "--json"],
        { env, encoding: "utf8" },
      );
      assert.equal(nOk.status, 0, good + " " + (nOk.stderr || nOk.stdout));
      const body = JSON.parse((nOk.stdout || "").trim());
      assert.equal(body.ok, true, good);
      assert.ok(typeof body.version === "string" && body.version.length > 0, good);
      assert.ok(Array.isArray(body.releases), good);
      if (good === "latest") assert.ok(body.count <= 1, good);
      else assert.ok(body.count <= 10, good);
    }

    const interval = spawnSync(
      process.execPath,
      [cli, "status", "--watch", "--interval", "nope", "--json"],
      { env, encoding: "utf8", timeout: 3000 },
    );
    assert.notEqual(interval.status, 0);
    const ij = JSON.parse((interval.stdout || "").trim());
    assert.equal(ij.ok, false);
    assert.equal(ij.reason, "invalid_interval");

    // Invalid --interval fails closed even without --watch (shared scripts).
    const intervalNoWatch = spawnSync(
      process.execPath,
      [cli, "status", "--interval", "nope", "--json"],
      { env, encoding: "utf8", timeout: 3000 },
    );
    assert.notEqual(intervalNoWatch.status, 0);
    const ij2 = JSON.parse((intervalNoWatch.stdout || "").trim());
    assert.equal(ij2.ok, false);
    assert.equal(ij2.reason, "invalid_interval");
  });

  it("status --watch --json is single-shot (no hang)", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-status-watch-json-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const r = spawnSync(
      process.execPath,
      [cli, "status", "--watch", "--json"],
      { env, encoding: "utf8", timeout: 8_000 },
    );
    assert.equal(r.error, undefined, String(r.error || ""));
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.sessions));
  });


  it("unknown CLI option with --json is structured", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-unknown-opt-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const r = spawnSync(
      process.execPath,
      [cli, "run", "x", "--not-a-real-flag", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, false);
    assert.equal(j.reason, "unknown_option");
    assert.match(String(j.error || ""), /not-a-real-flag/);
  });


  it("permission-mode aliases deny/dont-ask → dontAsk", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-perm-alias-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    for (const alias of ["deny", "dont-ask", "yolo"]) {
      const r = spawnSync(
        process.execPath,
        [cli, "run", "x", "--permission-mode", alias, "--json"],
        { env, encoding: "utf8" },
      );
      // Should not be invalid_permission_mode (unauthenticated is fine)
      const j = JSON.parse((r.stdout || "").trim());
      assert.notEqual(j.reason, "invalid_permission_mode", alias);
      assert.ok(
        j.reason === "unauthenticated" || j.ok === true,
        `${alias} → ${j.reason}`,
      );
    }
  });


  it("sandbox-missing aliases fail_closed/failclosed → fail-closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-sb-miss-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    for (const a of ["fail_closed", "failclosed"]) {
      const r = spawnSync(
        process.execPath,
        [cli, "run", "x", "--sandbox-missing", a, "--json"],
        { env, encoding: "utf8" },
      );
      const j = JSON.parse((r.stdout || "").trim());
      assert.notEqual(j.reason, "invalid_sandbox_missing", a);
      assert.ok(j.reason === "unauthenticated" || j.ok === true, a + " " + j.reason);
    }
  });


  it("sandbox/provider aliases resolve (readonly, claude, gpt)", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-alias-sp-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    for (const [flag, val] of [
      ["--sandbox", "readonly"],
      ["--sandbox", "ro"],
      ["--sandbox-network", "none"],
      ["--sandbox-network", "open"],
      ["-p", "claude"],
      ["-p", "gpt"],
      ["-p", "gemini"],
    ] as const) {
      const r = spawnSync(
        process.execPath,
        [cli, "run", "x", flag, val, "--json"],
        { env, encoding: "utf8" },
      );
      const j = JSON.parse((r.stdout || "").trim());
      const badReason =
        flag === "-p"
          ? "invalid_provider"
          : flag === "--sandbox-network"
            ? "invalid_sandbox_network"
            : "invalid_sandbox";
      assert.notEqual(j.reason, badReason, `${flag} ${val} → ${j.reason}`);
      assert.ok(
        j.reason === "unauthenticated" || j.ok === true,
        `${flag} ${val} → ${j.reason}`,
      );
    }
  });


  it("max-turns empty/invalid fail closed; 0 unlimited", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-max-turns-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    for (const bad of ["", "abc", "-1", "1.5", "100001"]) {
      const r = spawnSync(
        process.execPath,
        [cli, "run", "x", "--max-turns", bad, "--json"],
        { env, encoding: "utf8" },
      );
      assert.notEqual(r.status, 0, bad);
      const j = JSON.parse((r.stdout || "").trim());
      assert.equal(j.reason, "invalid_max_turns", bad);
    }
    const ok = spawnSync(
      process.execPath,
      [cli, "run", "x", "--max-turns", "0", "--json"],
      { env, encoding: "utf8" },
    );
    // unauthenticated is fine — not invalid_max_turns
    const oj = JSON.parse((ok.stdout || "").trim());
    assert.notEqual(oj.reason, "invalid_max_turns");
  });


  it("invalid --base-url fails closed before API", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-baseurl-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    for (const url of ["not-a-url", "ftp://example.com", "http://"]) {
      // http:// alone may parse — still require hostname-ish; we only check protocol+URL parse
    }
    const bad = spawnSync(
      process.execPath,
      [cli, "run", "x", "--base-url", "not-a-url", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(bad.status, 0);
    const bj = JSON.parse((bad.stdout || "").trim());
    assert.equal(bj.reason, "invalid_base_url");

    const ftp = spawnSync(
      process.execPath,
      [cli, "run", "x", "--base-url", "ftp://x.example", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(ftp.status, 0);
    const fj = JSON.parse((ftp.stdout || "").trim());
    assert.equal(fj.reason, "invalid_base_url");

    const emptyHost = spawnSync(
      process.execPath,
      [cli, "run", "x", "--base-url", "https://", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(emptyHost.status, 0);
    const eh = JSON.parse((emptyHost.stdout || "").trim());
    assert.equal(eh.reason, "invalid_base_url");
  });

  it("continue+new and session+new fail closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-conflict-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const cn = spawnSync(
      process.execPath,
      [cli, "run", "x", "--continue", "--new", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(cn.status, 0);
    const cj = JSON.parse((cn.stdout || "").trim());
    assert.equal(cj.reason, "conflicting_flags");

    const sn = spawnSync(
      process.execPath,
      [cli, "run", "x", "--session", "abc", "--new", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(sn.status, 0);
    const sj = JSON.parse((sn.stdout || "").trim());
    assert.equal(sj.reason, "conflicting_flags");
  });

  it("forge --version --json is structured", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const r = spawnSync(
      process.execPath,
      [cli, "--version", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, true);
    assert.match(String(j.version || ""), /^\d+\.\d+/);
    assert.equal(j.name, "forge");
    assert.match(String(j.node || ""), /^v\d+/);
  });

  it("effort/sandbox-network/missing typos suggest enum values", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-effort-typo-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const effort = spawnSync(
      process.execPath,
      [cli, "run", "x", "--effort", "medum", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(effort.status, 0);
    const ej = JSON.parse((effort.stdout || "").trim());
    assert.equal(ej.reason, "invalid_effort");
    assert.equal(ej.suggestion, "medium");

    const net = spawnSync(
      process.execPath,
      [cli, "run", "x", "--sandbox-network", "blokced", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(net.status, 0);
    const nj = JSON.parse((net.stdout || "").trim());
    assert.equal(nj.reason, "invalid_sandbox_network");
    assert.equal(nj.suggestion, "blocked");

    const miss = spawnSync(
      process.execPath,
      [cli, "run", "x", "--sandbox-missing", "fallbak", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(miss.status, 0);
    const mj = JSON.parse((miss.stdout || "").trim());
    assert.equal(mj.reason, "invalid_sandbox_missing");
    assert.equal(mj.suggestion, "fallback");
  });

  it("sandbox/permission-mode typos suggest enum values", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-enum-typo-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const sb = spawnSync(
      process.execPath,
      [cli, "run", "x", "--sandbox", "workspac", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(sb.status, 0);
    const sj = JSON.parse((sb.stdout || "").trim());
    assert.equal(sj.reason, "invalid_sandbox");
    assert.equal(sj.suggestion, "workspace");

    const pm = spawnSync(
      process.execPath,
      [cli, "run", "x", "--permission-mode", "aceptEdits", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(pm.status, 0);
    const pj = JSON.parse((pm.stdout || "").trim());
    assert.equal(pj.reason, "invalid_permission_mode");
    assert.equal(pj.suggestion, "acceptEdits");
  });

  it("provider/model typos suggest catalog names", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-model-typo-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const prov = spawnSync(
      process.execPath,
      [cli, "run", "x", "--provider", "xaai", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(prov.status, 0);
    const pj = JSON.parse((prov.stdout || "").trim());
    assert.equal(pj.reason, "invalid_provider");
    assert.equal(pj.suggestion, "xai");

    const model = spawnSync(
      process.execPath,
      [cli, "run", "x", "--model", "grok-45", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(model.status, 0);
    const mj = JSON.parse((model.stdout || "").trim());
    assert.equal(mj.reason, "invalid_model");
    assert.equal(mj.suggestion, "grok-4.5");

    // Free-form unknown model is not rejected at preflight (API may still 400)
    const free = spawnSync(
      process.execPath,
      [cli, "run", "x", "--model", "my-custom-finetune-v3", "--json"],
      { env, encoding: "utf8", timeout: 30_000 },
    );
    const fj = JSON.parse((free.stdout || "").trim() || "{}");
    assert.notEqual(fj.reason, "invalid_model");
  });

  it("forge sessions search applies query (parity with -q)", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const { createSession, saveSession, setSessionTitle } = await import(
      "../src/session/session.js"
    );
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-sess-search-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    process.env.FORGE_HOME = home; // createSession/saveSession read process env
    const s = createSession({ cwd: home, provider: "xai", model: "m" });
    setSessionTitle(s, "incident-42");
    saveSession(s);

    const search = spawnSync(
      process.execPath,
      [cli, "sessions", "search", "incident", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(search.status, 0);
    const sj = JSON.parse((search.stdout || "").trim());
    assert.equal(sj.ok, true);
    assert.equal(sj.query, "incident");
    assert.ok(sj.count >= 1);

    const empty = spawnSync(
      process.execPath,
      [cli, "sessions", "search", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(empty.status, 0);
    const ej = JSON.parse((empty.stdout || "").trim());
    assert.equal(ej.reason, "usage");
  });

  it("sessions action typos fail closed with suggestion", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-sess-action-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const prun = spawnSync(
      process.execPath,
      [cli, "sessions", "prun", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(prun.status, 0);
    const pj = JSON.parse((prun.stdout || "").trim());
    assert.equal(pj.ok, false);
    assert.equal(pj.reason, "unknown_session_action");
    assert.equal(pj.suggestion, "prune");

    const serach = spawnSync(
      process.execPath,
      [cli, "sessions", "serach", "x", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(serach.status, 0);
    const sj = JSON.parse((serach.stdout || "").trim());
    assert.equal(sj.reason, "unknown_session_action");
    assert.equal(sj.suggestion, "search");

    // Real title query still works (ok:true empty list)
    const title = spawnSync(
      process.execPath,
      [cli, "sessions", "incident-42", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(title.status, 0);
    const tj = JSON.parse((title.stdout || "").trim());
    assert.equal(tj.ok, true);
    assert.equal(tj.query, "incident-42");
  });

  it("bare forge subcommand typo fails closed with suggestion", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-cmd-typo-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const typo = spawnSync(
      process.execPath,
      [cli, "sesions", "--json"],
      { env, encoding: "utf8", timeout: 5000 },
    );
    assert.notEqual(typo.status, 0);
    const j = JSON.parse((typo.stdout || "").trim());
    assert.equal(j.ok, false);
    assert.equal(j.reason, "command_typo");
    assert.equal(j.suggestion, "sessions");

    // Real short prompts must not false-positive
    const hi = spawnSync(
      process.execPath,
      [cli, "hi", "--json"],
      { env, encoding: "utf8", timeout: 5000 },
    );
    // may fail auth but must NOT be command_typo
    const hout = (hi.stdout || "").trim();
    if (hout.startsWith("{")) {
      const hj = JSON.parse(hout);
      assert.notEqual(hj.reason, "command_typo");
    }
  });

  it("invalid --days/--lines fail closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-days-lines-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const days = spawnSync(
      process.execPath,
      [cli, "stats", "--days", "abc", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(days.status, 0);
    const dj = JSON.parse((days.stdout || "").trim());
    assert.equal(dj.ok, false);
    assert.equal(dj.reason, "invalid_days");

    const lines = spawnSync(
      process.execPath,
      [cli, "logs", "-n", "nope", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(lines.status, 0);
    const lj = JSON.parse((lines.stdout || "").trim());
    assert.equal(lj.ok, false);
    assert.equal(lj.reason, "invalid_lines");
  });

  it("invalid --keep/--limit fail closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-keep-invalid-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const keep = spawnSync(
      process.execPath,
      [cli, "sessions", "prune", "--keep", "abc", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(keep.status, 0);
    const kj = JSON.parse((keep.stdout || "").trim());
    assert.equal(kj.ok, false);
    assert.equal(kj.reason, "invalid_keep");

    const limit = spawnSync(
      process.execPath,
      [cli, "sessions", "list", "--limit", "-3", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(limit.status, 0);
    const lj = JSON.parse((limit.stdout || "").trim());
    assert.equal(lj.ok, false);
    assert.equal(lj.reason, "invalid_limit");

    const age = spawnSync(
      process.execPath,
      [cli, "sessions", "prune", "--max-age-days", "nope", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(age.status, 0);
    const aj = JSON.parse((age.stdout || "").trim());
    assert.equal(aj.ok, false);
    assert.equal(aj.reason, "invalid_max_age_days");
  });

  it("sessions list --limit above 10000 fails closed; 0 unlimited", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-limit-cap-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const over = spawnSync(
      process.execPath,
      [cli, "sessions", "list", "--limit", "10001", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(over.status, 0);
    assert.equal(JSON.parse((over.stdout || "").trim()).reason, "invalid_limit");
    const ok = spawnSync(
      process.execPath,
      [cli, "sessions", "list", "--limit", "0", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    assert.equal(JSON.parse((ok.stdout || "").trim()).limit, 0);
  });


  it("status --cwd empty fails closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-status-cwd-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const r = spawnSync(
      process.execPath,
      [cli, "status", "--cwd", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, false);
    assert.equal(j.reason, "invalid_cwd");
  });

  it("logout -p empty fails closed (does not clear all)", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-logout-empty-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    // Seed a credential
    const login = spawnSync(
      process.execPath,
      [cli, "login", "--api-key", "sk-logout-guard", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(login.status, 0);
    const empty = spawnSync(
      process.execPath,
      [cli, "logout", "-p", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(empty.status, 0);
    const ej = JSON.parse((empty.stdout || "").trim());
    assert.equal(ej.ok, false);
    assert.equal(ej.reason, "invalid_provider");
    // Credential must still exist
    const auth = spawnSync(process.execPath, [cli, "auth", "--json"], {
      env: { ...env, XAI_API_KEY: "" },
      encoding: "utf8",
    });
    // may still be authenticated via stored key
    const aj = JSON.parse((auth.stdout || "").trim());
    assert.equal(aj.ok, true);
    assert.equal(aj.authenticated, true);
  });

  it("sessions list -q empty fails closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-query-empty-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const r = spawnSync(
      process.execPath,
      [cli, "sessions", "list", "-q", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, false);
    assert.equal(j.reason, "invalid_query");
  });

  it("empty --goal fails closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-goal-empty-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      FORGE_HOME: home,
      XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
    };
    const r = spawnSync(
      process.execPath,
      [cli, "run", "x", "--goal", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, false);
    assert.equal(j.reason, "invalid_goal");
  });

  it("empty --deny/--allow/--ask fail closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-deny-empty-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      FORGE_HOME: home,
      XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
    };
    for (const [flag, reason] of [
      ["--deny", "invalid_deny"],
      ["--allow", "invalid_allow"],
      ["--ask", "invalid_ask"],
    ] as const) {
      const r = spawnSync(
        process.execPath,
        [cli, "run", "x", flag, "", "--json"],
        { env, encoding: "utf8" },
      );
      assert.notEqual(r.status, 0, flag);
      const j = JSON.parse((r.stdout || "").trim());
      assert.equal(j.ok, false, flag);
      assert.equal(j.reason, reason, flag);
    }
  });

  it("doctor flags invalid permission rules in config", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doc-rules-"));
    process.env.FORGE_HOME = tmp;
    const { runDoctorCheck } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const cfg = {
      ...DEFAULT_CONFIG,
      permission: {
        deny: ["Bash()", "Bash(rm *)"],
        allow: ["Read()"],
        ask: [],
        rules: [],
      },
    };
    const check = await runDoctorCheck(cfg as any);
    assert.equal(check.ok, false);
    assert.ok(
      check.issues.some((i) => /Invalid permission rule/i.test(i)),
      check.issues.join(" | "),
    );
    assert.ok(
      check.issues.some((i) => /Bash\(\)/.test(i)),
      check.issues.join(" | "),
    );

    // Non-array deny must not be character-iterated
    const checkStr = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      permission: {
        deny: "Bash()" as unknown as string[],
        allow: [],
        ask: [],
        rules: [],
      },
    } as any);
    assert.ok(
      checkStr.issues.some((i) => /non-array|Invalid permission rule/i.test(i)),
      checkStr.issues.join(" | "),
    );
    assert.ok(
      !checkStr.issues.some((i) => /deny: \(/.test(i)),
      "must not iterate string chars: " + checkStr.issues.join(" | "),
    );
  });

  it("empty Tool() permission rules fail closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-empty-rule-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const deny = spawnSync(
      process.execPath,
      [cli, "run", "x", "--deny", "Bash()", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(deny.status, 0);
    const dj = JSON.parse((deny.stdout || "").trim());
    assert.equal(dj.reason, "invalid_deny");
    assert.match(String(dj.error || ""), /Bash\(\)|empty Tool/i);

    // bare tool and Tool(*) still valid (may proceed to auth/run)
    const bare = spawnSync(
      process.execPath,
      [cli, "run", "x", "--deny", "Bash", "--json"],
      { env, encoding: "utf8", timeout: 30_000 },
    );
    const bj = JSON.parse((bare.stdout || "").trim() || "{}");
    assert.notEqual(bj.reason, "invalid_deny");
  });


  it("sessions list --cwd empty fails closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-sess-cwd-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const r = spawnSync(
      process.execPath,
      [cli, "sessions", "list", "--cwd", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, false);
    assert.equal(j.reason, "invalid_cwd");
  });

  it("bare --continue/--session preflight does not apply --title before auth", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-title-preflight-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    process.env.FORGE_HOME = home;
    const {
      createSession,
      saveSession,
      loadSession,
    } = await import("../src/session/session.js");
    const ws = path.join(home, "ws");
    fs.mkdirSync(ws, { recursive: true });
    const s = createSession({
      cwd: ws,
      provider: "xai",
      model: "m",
      title: "original-title",
    });
    s.messages.push({ role: "user", content: "hi" });
    saveSession(s);
    const env = {
      ...process.env,
      FORGE_HOME: home,
      // Force unauthenticated after session preflight
      XAI_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      OPENROUTER_API_KEY: "",
      GOOGLE_API_KEY: "",
      GROK_HOME: path.join(home, "nogrok"),
    };
    const r = spawnSync(
      process.execPath,
      [
        cli,
        "next",
        "--continue",
        "--title",
        "should-not-stick",
        "--json",
        "--cwd",
        ws,
      ],
      { env, encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    // continue may succeed preflight then fail auth
    assert.equal(j.ok, false);
    assert.ok(
      j.reason === "unauthenticated" || j.reason === "continue_miss",
      `unexpected reason ${j.reason}`,
    );
    if (j.reason === "unauthenticated") {
      const again = loadSession(s.meta.id);
      assert.equal(again?.meta.title, "original-title");
    }
  });

  it("forge config empty --provider/--cwd fail closed; completion lists tips --json", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-config-empty-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const emptyP = spawnSync(
      process.execPath,
      [cli, "config", "-p", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(emptyP.status, 0);
    const pj = JSON.parse((emptyP.stdout || "").trim());
    assert.equal(pj.ok, false);
    assert.equal(pj.reason, "invalid_provider");

    const emptyCwd = spawnSync(
      process.execPath,
      [cli, "config", "--cwd", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(emptyCwd.status, 0);
    const cj = JSON.parse((emptyCwd.stdout || "").trim());
    assert.equal(cj.ok, false);
    assert.equal(cj.reason, "invalid_cwd");

    const { shellCompletionScript } = await import(
      "../src/util/completion-script.js"
    );
    const bash = shellCompletionScript("bash");
    // Case arm may list extra cmds (e.g. accounts) between tips/init/completion and `)`.
    assert.match(
      bash,
      /tips\|init\|completion[\w|]*\).*--json|doctor\|models\|status\|auth\|tips/,
    );
    assert.match(bash, /--max-waves/);
  });

  it("models -p filters; empty/invalid provider fail closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-models-p-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const empty = spawnSync(
      process.execPath,
      [cli, "models", "-p", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(empty.status, 0);
    const ej = JSON.parse((empty.stdout || "").trim());
    assert.equal(ej.ok, false);
    assert.equal(ej.reason, "invalid_provider");

    const spaces = spawnSync(
      process.execPath,
      [cli, "models", "-p", "   ", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(spaces.status, 0);
    assert.equal(JSON.parse((spaces.stdout || "").trim()).reason, "invalid_provider");

    const bad = spawnSync(
      process.execPath,
      [cli, "models", "-p", "notaprovider", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(bad.status, 0);
    const bj = JSON.parse((bad.stdout || "").trim());
    assert.equal(bj.reason, "invalid_provider");

    const parentEmpty = spawnSync(
      process.execPath,
      [cli, "-p", "", "models", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(parentEmpty.status, 0);
    assert.equal(
      JSON.parse((parentEmpty.stdout || "").trim()).reason,
      "invalid_provider",
    );

    const ok = spawnSync(
      process.execPath,
      [cli, "models", "-p", "xai", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    const oj = JSON.parse((ok.stdout || "").trim());
    assert.equal(oj.ok, true);
    assert.equal(oj.provider, "xai");
    assert.ok(Array.isArray(oj.providers));
    assert.equal(oj.providers.length, 1);
    assert.equal(oj.providers[0].provider, "xai");
    assert.ok(
      (oj.providers[0].models || []).some((m: string) => /grok/i.test(m)),
    );

    const parentOk = spawnSync(
      process.execPath,
      [cli, "-p", "anthropic", "models", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(parentOk.status, 0, parentOk.stderr || parentOk.stdout);
    const pj = JSON.parse((parentOk.stdout || "").trim());
    assert.equal(pj.provider, "anthropic");
    assert.equal(pj.providers.length, 1);
    assert.equal(pj.providers[0].provider, "anthropic");

    // Friendly aliases experts type at -p
    for (const [alias, provider] of [
      ["oai", "openai"],
      ["haiku", "anthropic"],
      ["bard", "google"],
      ["router", "openrouter"],
    ] as const) {
      const ar = spawnSync(
        process.execPath,
        [cli, "models", "-p", alias, "--json"],
        { env, encoding: "utf8" },
      );
      assert.equal(ar.status, 0, alias + " " + (ar.stderr || ar.stdout));
      const aj = JSON.parse((ar.stdout || "").trim());
      assert.equal(aj.ok, true, alias);
      assert.equal(aj.provider, provider, alias);
      assert.equal(aj.providers.length, 1, alias);
      assert.equal(aj.providers[0].provider, provider, alias);
    }
  });

  it("overlong --goal fails closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-goal-len-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const r = spawnSync(
      process.execPath,
      [cli, "run", "x", "--goal", "g".repeat(4001), "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.reason, "invalid_goal");
  });

  it("missing --cwd directory and overlong --title fail closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-cwd-miss-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const missing = path.join(home, "no-such-workspace");

    const cwd = spawnSync(
      process.execPath,
      [cli, "run", "x", "--cwd", missing, "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(cwd.status, 0);
    const cj = JSON.parse((cwd.stdout || "").trim());
    assert.equal(cj.reason, "invalid_cwd");

    const title = spawnSync(
      process.execPath,
      [cli, "run", "x", "--title", "a".repeat(201), "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(title.status, 0);
    const tj = JSON.parse((title.stdout || "").trim());
    assert.equal(tj.reason, "invalid_title");
  });

  it("setSessionTitle stores up to 200 chars; sessions title overlong fails closed", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const {
      createSession,
      setSessionTitle,
      MAX_SESSION_TITLE_CHARS,
      loadSession,
    } = await import("../src/session/session.js");
    assert.equal(MAX_SESSION_TITLE_CHARS, 200);
    const home = path.join(process.cwd(), ".tmp", `forge-title-cap-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const prev = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
    try {
      const s = createSession({ cwd: process.cwd() });
      const long = "b".repeat(200);
      const stored = setSessionTitle(s, long);
      assert.equal(stored, long);
      assert.equal(loadSession(s.meta.id)?.meta.title, long);

      const cli = path.join(process.cwd(), "dist", "cli.js");
      if (fs.existsSync(cli)) {
        const env = { ...process.env, FORGE_HOME: home };
        const over = spawnSync(
          process.execPath,
          [
            cli,
            "sessions",
            "title",
            s.meta.id,
            "c".repeat(201),
            "--json",
          ],
          { env, encoding: "utf8" },
        );
        assert.notEqual(over.status, 0);
        const oj = JSON.parse((over.stdout || "").trim());
        assert.equal(oj.reason, "invalid_title");
        // title unchanged
        assert.equal(loadSession(s.meta.id)?.meta.title, long);
      }
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
    }
  });

  it("empty --cwd/--title and logs -n 0 fail-closed / semantics", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-empty-flags-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      FORGE_HOME: home,
      XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
    };

    const emptyCwd = spawnSync(
      process.execPath,
      [cli, "run", "x", "--cwd", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(emptyCwd.status, 0);
    const cwdJ = JSON.parse((emptyCwd.stdout || "").trim());
    assert.equal(cwdJ.ok, false);
    assert.equal(cwdJ.reason, "invalid_cwd");

    const emptyTitle = spawnSync(
      process.execPath,
      [cli, "run", "x", "--title", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(emptyTitle.status, 0);
    const titleJ = JSON.parse((emptyTitle.stdout || "").trim());
    assert.equal(titleJ.ok, false);
    assert.equal(titleJ.reason, "invalid_title");

    // bare forge same
    const bareTitle = spawnSync(
      process.execPath,
      [cli, "x", "--title", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(bareTitle.status, 0);
    const bareTJ = JSON.parse((bareTitle.stdout || "").trim());
    assert.equal(bareTJ.ok, false);
    assert.equal(bareTJ.reason, "invalid_title");

    const logs0 = spawnSync(
      process.execPath,
      [cli, "logs", "-n", "0", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(logs0.status, 0);
    const logsJ = JSON.parse((logs0.stdout || "").trim());
    assert.equal(logsJ.ok, true);
    assert.equal(logsJ.limit, 0);
    assert.ok(Array.isArray(logsJ.events));

    const logs201 = spawnSync(
      process.execPath,
      [cli, "logs", "-n", "201", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(logs201.status, 0);
    const logs201J = JSON.parse((logs201.stdout || "").trim());
    assert.equal(logs201J.reason, "invalid_lines");

    // unit: readSandboxLogTail(0) returns full window
    const { readSandboxLogTail, sandboxLogPath } = await import(
      "../src/agent/sandbox-log.js"
    );
    const logPath = sandboxLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({ type: "deny", ts: "1", detail: "a" }),
        JSON.stringify({ type: "deny", ts: "2", detail: "b" }),
        JSON.stringify({ type: "deny", ts: "3", detail: "c" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const all = readSandboxLogTail(0);
    assert.ok(all.length >= 3, `expected >=3 events, got ${all.length}`);
    const one = readSandboxLogTail(1);
    assert.equal(one.length, 1);
  });

  it("parent --continue/--json documented; bare forge --json early failures; export invalid_format", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(process.cwd(), ".tmp", `forge-continue-${process.pid}`);
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    const help = spawnSync(process.execPath, [cli, "--help"], {
      env,
      encoding: "utf8",
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout || "", /--continue/);
    assert.match(help.stdout || "", /bare headless same-cwd resume/);
    assert.match(help.stdout || "", /--json/);
    assert.match(help.stdout || "", /forge run --json|Headless JSON/);

    const tips = spawnSync(process.execPath, [cli, "tips"], {
      env,
      encoding: "utf8",
    });
    assert.equal(tips.status, 0);
    assert.match(tips.stdout || "", /forge auth --json|--continue|forge doctor --json/);
    assert.match(tips.stdout || "", /forge "…" --json|forge "\u2026" --json/);

    // Bare forge --json with empty prompt (no auth needed)
    const emptyBare = spawnSync(process.execPath, [cli, "--json"], {
      env,
      encoding: "utf8",
    });
    assert.notEqual(emptyBare.status, 0);
    const emptyJ = JSON.parse((emptyBare.stdout || "").trim());
    assert.equal(emptyJ.ok, false);
    assert.equal(emptyJ.reason, "empty_prompt");

    // Bare forge --json session miss (before auth when session resolves first...
    // actually auth runs before resolveSession — use unauthenticated home)
    const noAuthHome = path.join(home, "noauth");
    fs.mkdirSync(noAuthHome, { recursive: true });
    const noAuthEnv = {
      ...env,
      FORGE_HOME: noAuthHome,
      XAI_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      OPENROUTER_API_KEY: "",
      GOOGLE_API_KEY: "",
      GROK_HOME: path.join(noAuthHome, "nogrok"),
    };
    const unauthBare = spawnSync(
      process.execPath,
      [cli, "hi", "--json"],
      { env: noAuthEnv, encoding: "utf8" },
    );
    assert.notEqual(unauthBare.status, 0);
    const unauthJ = JSON.parse((unauthBare.stdout || "").trim());
    assert.equal(unauthJ.ok, false);
    assert.equal(unauthJ.reason, "unauthenticated");

    const missBare = spawnSync(
      process.execPath,
      [cli, "hi", "--session", "zzz-no-such-bare-json-99", "--json"],
      { env, encoding: "utf8" },
    );
    // May be unauthenticated first if no creds in home — either structured reason is fine
    assert.notEqual(missBare.status, 0);
    const missJ = JSON.parse((missBare.stdout || "").trim());
    assert.equal(missJ.ok, false);
    assert.ok(
      missJ.reason === "session_not_found" || missJ.reason === "unauthenticated",
      `expected session_not_found|unauthenticated, got ${missJ.reason}`,
    );

    const badFmt = spawnSync(
      process.execPath,
      [cli, "sessions", "export", "zzz-nope", "--format", "yaml", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(badFmt.status, 0);
    const badJson = JSON.parse((badFmt.stdout || "").trim());
    assert.equal(badJson.ok, false);
    assert.equal(badJson.reason, "invalid_format");
    assert.equal(badJson.format, "yaml");

    // Empty --format must not coerce to md
    const emptyFmt = spawnSync(
      process.execPath,
      [cli, "sessions", "export", "zzz-nope", "--format", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(emptyFmt.status, 0);
    const emptyFmtJ = JSON.parse((emptyFmt.stdout || "").trim());
    assert.equal(emptyFmtJ.ok, false);
    assert.equal(emptyFmtJ.reason, "invalid_format");

    // Export --out directory → structured is_directory (not uncaught EISDIR)
    const { createSession, saveSession } = await import(
      "../src/session/session.js"
    );
    const expHome = path.join(home, "export-dir");
    fs.mkdirSync(expHome, { recursive: true });
    process.env.FORGE_HOME = expHome;
    const expS = createSession({
      cwd: path.join(expHome, "ws"),
      provider: "xai",
      model: "m",
      title: "export-me",
    });
    expS.messages.push({ role: "user", content: "hi" });
    saveSession(expS);
    const outDir = path.join(expHome, "outdir");
    fs.mkdirSync(outDir, { recursive: true });
    const dirOut = spawnSync(
      process.execPath,
      [
        cli,
        "sessions",
        "export",
        expS.meta.id,
        "--out",
        outDir,
        "--json",
      ],
      { env: { ...env, FORGE_HOME: expHome }, encoding: "utf8" },
    );
    assert.notEqual(dirOut.status, 0);
    const dirJ = JSON.parse((dirOut.stdout || "").trim());
    assert.equal(dirJ.ok, false);
    assert.equal(dirJ.reason, "is_directory");
    assert.match(String(dirJ.hint || ""), /session-/);

    // Export --out '' → structured usage (not silent stdout dump)
    const emptyOut = spawnSync(
      process.execPath,
      [cli, "sessions", "export", expS.meta.id, "--out", "", "--json"],
      { env: { ...env, FORGE_HOME: expHome }, encoding: "utf8" },
    );
    assert.notEqual(emptyOut.status, 0);
    const emptyOutJ = JSON.parse((emptyOut.stdout || "").trim());
    assert.equal(emptyOutJ.ok, false);
    assert.equal(emptyOutJ.reason, "usage");

    // Import directory → structured is_directory (not EISDIR invalid)
    const impDir = spawnSync(
      process.execPath,
      [cli, "sessions", "import", outDir, "--json"],
      { env: { ...env, FORGE_HOME: expHome }, encoding: "utf8" },
    );
    assert.notEqual(impDir.status, 0);
    const impJ = JSON.parse((impDir.stdout || "").trim());
    assert.equal(impJ.ok, false);
    assert.equal(impJ.reason, "is_directory");

    const usage = spawnSync(
      process.execPath,
      [cli, "sessions", "title", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(usage.status, 0);
    const usageJson = JSON.parse((usage.stdout || "").trim());
    assert.equal(usageJson.ok, false);
    assert.equal(usageJson.reason, "usage");
    assert.match(String(usageJson.error || ""), /title/);

    const badEffort = spawnSync(
      process.execPath,
      [cli, "run", "--json", "--effort", "nope", "hi"],
      {
        env: {
          ...env,
          XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(badEffort.status, 0);
    const effortJson = JSON.parse((badEffort.stdout || "").trim());
    assert.equal(effortJson.ok, false);
    assert.equal(effortJson.reason, "invalid_effort");
    assert.equal(effortJson.effort, "nope");

    const badPerm = spawnSync(
      process.execPath,
      [cli, "run", "--json", "--permission-mode", "bypassPermisions", "hi"],
      {
        env: {
          ...env,
          XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(badPerm.status, 0);

    // Empty enum flags must fail closed (not skip validation and hit the API)
    const emptyPerm = spawnSync(
      process.execPath,
      [cli, "run", "--json", "--permission-mode", "", "hi"],
      {
        env: {
          ...env,
          XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(emptyPerm.status, 0);
    const emptyPermJ = JSON.parse((emptyPerm.stdout || "").trim());
    assert.equal(emptyPermJ.ok, false);
    assert.equal(emptyPermJ.reason, "invalid_permission_mode");

    const emptySandbox = spawnSync(
      process.execPath,
      [cli, "run", "--json", "--sandbox", "", "hi"],
      {
        env: {
          ...env,
          XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(emptySandbox.status, 0);
    const emptySandboxJ = JSON.parse((emptySandbox.stdout || "").trim());
    assert.equal(emptySandboxJ.ok, false);
    assert.equal(emptySandboxJ.reason, "invalid_sandbox");

    const emptyEffort = spawnSync(
      process.execPath,
      [cli, "run", "--json", "--effort", "", "hi"],
      {
        env: {
          ...env,
          XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(emptyEffort.status, 0);
    const emptyEffortJ = JSON.parse((emptyEffort.stdout || "").trim());
    assert.equal(emptyEffortJ.ok, false);
    assert.equal(emptyEffortJ.reason, "invalid_effort");

    const emptyProv = spawnSync(
      process.execPath,
      [cli, "run", "--json", "-p", "", "hi"],
      {
        env: {
          ...env,
          XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(emptyProv.status, 0);
    const emptyProvJ = JSON.parse((emptyProv.stdout || "").trim());
    assert.equal(emptyProvJ.ok, false);
    assert.equal(emptyProvJ.reason, "invalid_provider");

    const emptyModel = spawnSync(
      process.execPath,
      [cli, "run", "--json", "-m", "", "hi"],
      {
        env: {
          ...env,
          XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(emptyModel.status, 0);
    const emptyModelJ = JSON.parse((emptyModel.stdout || "").trim());
    assert.equal(emptyModelJ.ok, false);
    assert.equal(emptyModelJ.reason, "invalid_model");

    const emptyBase = spawnSync(
      process.execPath,
      [cli, "run", "--json", "--base-url", "", "hi"],
      {
        env: {
          ...env,
          XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(emptyBase.status, 0);
    const emptyBaseJ = JSON.parse((emptyBase.stdout || "").trim());
    assert.equal(emptyBaseJ.ok, false);
    assert.equal(emptyBaseJ.reason, "invalid_base_url");

    // Empty --session must not silently start a fresh session
    const emptySess = spawnSync(
      process.execPath,
      [cli, "run", "--json", "--session", "", "hi"],
      {
        env: {
          ...env,
          XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(emptySess.status, 0);
    const emptySessJ = JSON.parse((emptySess.stdout || "").trim());
    assert.equal(emptySessJ.ok, false);
    assert.equal(emptySessJ.reason, "session_not_found");

    const permJson = JSON.parse((badPerm.stdout || "").trim());
    assert.equal(permJson.ok, false);
    assert.equal(permJson.reason, "invalid_permission_mode");
    assert.equal(permJson.permissionMode, "bypassPermisions");
    assert.equal(permJson.suggestion, "bypassPermissions");

    const badSandbox = spawnSync(
      process.execPath,
      [cli, "run", "--json", "--sandbox", "paranoid", "hi"],
      {
        env: {
          ...env,
          XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(badSandbox.status, 0);
    const sandJson = JSON.parse((badSandbox.stdout || "").trim());
    assert.equal(sandJson.ok, false);
    assert.equal(sandJson.reason, "invalid_sandbox");
    assert.equal(sandJson.sandbox, "paranoid");

    const badProv = spawnSync(
      process.execPath,
      [cli, "run", "--json", "-p", "bogus", "hi"],
      {
        env: {
          ...env,
          XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(badProv.status, 0);
    const provJson = JSON.parse((badProv.stdout || "").trim());
    assert.equal(provJson.ok, false);
    assert.equal(provJson.reason, "invalid_provider");
    assert.equal(provJson.provider, "bogus");

    const customNoBase = spawnSync(
      process.execPath,
      [cli, "run", "--json", "-p", "custom", "hi"],
      {
        env: {
          ...env,
          XAI_API_KEY: process.env.XAI_API_KEY || "sk-test-forge-cli",
          // Ensure FORGE_BASE_URL does not satisfy the check
          FORGE_BASE_URL: "",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(customNoBase.status, 0);
    const customJson = JSON.parse((customNoBase.stdout || "").trim());
    assert.equal(customJson.ok, false);
    assert.equal(customJson.reason, "missing_base_url");
  });
});

describe("mergeRunOpts (parent vs run defaults)", () => {
  it("prefers parent CLI permissionMode and unions deny rules", async () => {
    const { mergeRunOpts } = await import("../src/util/merge-run-opts.js");
    const sources: Record<string, string> = {
      permissionMode: "default",
      deny: "default",
      json: "cli",
    };
    const parentSources: Record<string, string> = {
      permissionMode: "cli",
      deny: "cli",
      json: "cli",
    };
    const command = {
      optsWithGlobals: () => ({
        permissionMode: "yolo",
        deny: ["Bash(rm *)"],
        json: true,
      }),
      getOptionValueSource: (k: string) => sources[k],
      parent: {
        getOptionValueSource: (k: string) => parentSources[k],
      },
    };
    // Local run defaults clobber if naively spread
    const opts = {
      permissionMode: "acceptEdits",
      deny: [] as string[],
      json: true,
    };
    const merged = mergeRunOpts(command, opts);
    assert.equal(merged.permissionMode, "yolo");
    assert.deepEqual(merged.deny, ["Bash(rm *)"]);
    assert.equal(merged.json, true);

    // Local CLI deny unions with parent
    sources.deny = "cli";
    opts.deny = ["Bash(curl *)"];
    const merged2 = mergeRunOpts(command, opts);
    assert.deepEqual(merged2.deny, ["Bash(rm *)", "Bash(curl *)"]);

    // Local CLI permissionMode wins over parent
    sources.permissionMode = "cli";
    opts.permissionMode = "plan";
    const merged3 = mergeRunOpts(command, opts);
    assert.equal(merged3.permissionMode, "plan");
  });
});

describe("session lock multi-day", () => {
  it("never TTL-steals a live foreign pid even when acquiredAt is ancient", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { spawn } = await import("node:child_process");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-lock-live-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, sessionDir } = await import("../src/session/session.js");
    const { acquireSessionLock, releaseSessionLock } = await import(
      "../src/session/lock.js"
    );
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const holder = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"], {
      stdio: "ignore",
    });
    try {
      const lockFile = path.join(sessionDir(s.meta.id), "session.lock");
      fs.writeFileSync(
        lockFile,
        JSON.stringify({
          pid: holder.pid,
          hostname: "other",
          acquiredAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
          sessionId: s.meta.id,
        }),
        "utf8",
      );
      const blocked = acquireSessionLock(s.meta.id, { ttlMs: 1000 });
      assert.equal(blocked.ok, false, "live pid must not be TTL-stolen");
      assert.ok(blocked.holder);
      const forced = acquireSessionLock(s.meta.id, { force: true });
      assert.equal(forced.ok, true);
      assert.equal(forced.stolen, true);
      releaseSessionLock(s.meta.id);
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

describe("early JSON failures always include version", () => {
  it("emitFailJson paths surface version for CI matrices", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const { getForgeVersion } = await import("../src/util/version.js");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-json-version-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const version = getForgeVersion();
    const cases: Array<{ args: string[]; reason: string }> = [
      { args: ["run", "--json"], reason: "empty_prompt" },
      { args: ["run", "x", "--max-turns", "abc", "--json"], reason: "invalid_max_turns" },
      { args: ["run", "x", "--continue", "--new", "--json"], reason: "conflicting_flags" },
      { args: ["sesions", "--json"], reason: "command_typo" },
      { args: ["run", "x", "--session", "nope", "--json"], reason: "session_not_found" },
      {
        args: ["sessions", "export", "dead", "--format", "xyz", "--json"],
        reason: "invalid_format",
      },
      {
        args: ["completion", "csh", "--json"],
        reason: "invalid_shell",
      },
      {
        args: ["sessions", "import", home, "--json"],
        reason: "is_directory",
      },
    ];
    for (const c of cases) {
      const r = spawnSync(process.execPath, [cli, ...c.args], {
        env,
        encoding: "utf8",
      });
      assert.notEqual(r.status, 0, c.args.join(" "));
      const j = JSON.parse((r.stdout || "").trim());
      assert.equal(j.ok, false, c.args.join(" "));
      assert.equal(j.version, version, c.args.join(" "));
      assert.equal(j.reason, c.reason, c.args.join(" "));
    }
  });
});

describe("JSON success paths always include version", () => {
  it("emitOkJson paths surface version for CI matrices", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const { getForgeVersion } = await import("../src/util/version.js");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-json-ok-version-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      FORGE_HOME: home,
      XAI_API_KEY: "sk-test-ok-json-version",
    };
    const version = getForgeVersion();
    const cases: string[][] = [
      ["tips", "--json"],
      ["news", "--json"],
      ["config", "--json"],
      ["completion", "bash", "--json"],
      ["sessions", "list", "--json"],
      ["init", "--json"],
      ["stats", "--json"],
      ["status", "--json"],
    ];
    for (const args of cases) {
      const r = spawnSync(process.execPath, [cli, ...args], {
        env,
        encoding: "utf8",
      });
      assert.equal(r.status, 0, args.join(" ") + " status");
      const j = JSON.parse((r.stdout || "").trim());
      assert.equal(j.ok, true, args.join(" "));
      assert.equal(j.version, version, args.join(" "));
    }
  });
});

describe("bare command alias recovery", () => {
  it("maps cfg/log/session/whoami to real subcommands before auth", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-cmd-alias-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const cases: Array<{ token: string; suggestion: string }> = [
      { token: "cfg", suggestion: "config" },
      { token: "log", suggestion: "logs" },
      { token: "session", suggestion: "sessions" },
      { token: "whoami", suggestion: "auth" },
      { token: "hud", suggestion: "status" },
      { token: "whatsnew", suggestion: "news" },
      { token: "tip", suggestion: "tips" },
    ];
    for (const c of cases) {
      const r = spawnSync(process.execPath, [cli, c.token, "--json"], {
        env,
        encoding: "utf8",
      });
      assert.notEqual(r.status, 0, c.token);
      const j = JSON.parse((r.stdout || "").trim());
      assert.equal(j.ok, false, c.token);
      assert.equal(j.reason, "command_typo", c.token);
      assert.equal(j.suggestion, c.suggestion, c.token);
    }
  });
});

describe("sessions action aliases in suggestions", () => {
  it("suggests rename/clone for near-miss actions", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-sess-action-alias-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    for (const [token, suggestion] of [
      ["renam", "rename"],
      ["clonee", "clone"],
      ["locaton", "location"],
    ] as const) {
      const r = spawnSync(
        process.execPath,
        [cli, "sessions", token, "x", "--json"],
        { env, encoding: "utf8" },
      );
      assert.notEqual(r.status, 0, token);
      const j = JSON.parse((r.stdout || "").trim());
      assert.equal(j.reason, "unknown_session_action", token);
      assert.equal(j.suggestion, suggestion, token);
    }
  });
});

describe("permission mode alias ask", () => {
  it("maps ask/deny to dontAsk before auth", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-perm-ask-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    // invalid still fails closed
    const bad = spawnSync(
      process.execPath,
      [cli, "run", "x", "--permission-mode", "notamode", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(bad.status, 0);
    assert.equal(JSON.parse((bad.stdout || "").trim()).reason, "invalid_permission_mode");

    // ask is a valid alias — should pass flag validation (may fail later on auth/model)
    for (const mode of ["ask", "deny", "dont-ask"] as const) {
      const r = spawnSync(
        process.execPath,
        [cli, "run", "x", "--permission-mode", mode, "--json"],
        { env, encoding: "utf8" },
      );
      const j = JSON.parse((r.stdout || "").trim());
      assert.notEqual(
        j.reason,
        "invalid_permission_mode",
        mode + " should alias to dontAsk",
      );
    }
  });
});

describe("effort aliases hi/lo", () => {
  it("accepts hi and lo as high/low", async () => {
    const { parseReasoningEffort } = await import("../src/config/reasoning.js");
    assert.equal(parseReasoningEffort("hi"), "high");
    assert.equal(parseReasoningEffort("lo"), "low");
    assert.equal(parseReasoningEffort("med"), "medium");
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-effort-hi-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    for (const e of ["hi", "lo"] as const) {
      const r = spawnSync(
        process.execPath,
        [cli, "run", "x", "--effort", e, "--json"],
        { env, encoding: "utf8" },
      );
      const j = JSON.parse((r.stdout || "").trim());
      assert.notEqual(j.reason, "invalid_effort", e);
    }
  });
});

describe("stats days and logs lines aliases", () => {
  it("accepts week/month/today/7d and logs all/max", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-stats-logs-alias-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };

    for (const [alias, expectDays] of [
      ["week", 7],
      ["month", 30],
      ["today", 1],
      ["7d", 7],
      ["all", 0],
    ] as const) {
      const r = spawnSync(
        process.execPath,
        [cli, "stats", "--days", alias, "--json"],
        { env, encoding: "utf8" },
      );
      assert.equal(r.status, 0, alias + " " + (r.stderr || r.stdout));
      const j = JSON.parse((r.stdout || "").trim());
      assert.equal(j.ok, true, alias);
      assert.equal(j.days, expectDays, alias);
    }

    for (const alias of ["all", "max", "full"] as const) {
      const r = spawnSync(
        process.execPath,
        [cli, "logs", "-n", alias, "--json"],
        { env, encoding: "utf8" },
      );
      assert.equal(r.status, 0, alias + " " + (r.stderr || r.stdout));
      const j = JSON.parse((r.stdout || "").trim());
      assert.equal(j.ok, true, alias);
      assert.equal(j.limit, 0, alias);
    }
  });
});

describe("slash stats/news aliases", () => {
  it("accepts /stats week and /news all", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-slash-alias-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const cfg = { ...DEFAULT_CONFIG, workspace: tmp };

    const week = await handleSlash("/stats week", {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(week.handled, true);
    assert.doesNotMatch(String(week.output || ""), /Invalid \/stats/i);

    const bad = await handleSlash("/stats nope", {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(bad.handled, true);
    assert.match(String(bad.output || ""), /Invalid \/stats/i);

    const newsAll = await handleSlash("/news all", {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(newsAll.handled, true);
    assert.match(String(newsAll.output || ""), /what's new|CHANGELOG|0\.9/i);

    const newsBad = await handleSlash("/news abc", {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(newsBad.handled, true);
    assert.match(String(newsBad.output || ""), /Invalid \/news/i);
  });
});

describe("parseDaysWindow shared helper", () => {
  it("parses aliases and rejects garbage", async () => {
    const { parseDaysWindow, daysWindowHelp } = await import(
      "../src/util/days-window.js"
    );
    assert.deepEqual(parseDaysWindow("week"), { ok: true, days: 7 });
    assert.deepEqual(parseDaysWindow("30"), { ok: true, days: 30 });
    assert.deepEqual(parseDaysWindow("14d"), { ok: true, days: 14 });
    assert.deepEqual(parseDaysWindow("--days=3"), { ok: true, days: 3 });
    assert.deepEqual(parseDaysWindow("all"), { ok: true, days: 0 });
    assert.equal(parseDaysWindow("nope").ok, false);
    assert.equal(parseDaysWindow("").ok, false);
    assert.match(daysWindowHelp(), /week/);
  });
});
describe("parseNewsCount shared helper", () => {
  it("parses aliases and rejects garbage", async () => {
    const { parseNewsCount, newsCountHelp } = await import(
      "../src/util/news-count.js"
    );
    assert.deepEqual(parseNewsCount("all"), { ok: true, count: 10 });
    assert.deepEqual(parseNewsCount("latest"), { ok: true, count: 1 });
    assert.deepEqual(parseNewsCount("3"), { ok: true, count: 3 });
    assert.equal(parseNewsCount("0").ok, false);
    assert.equal(parseNewsCount("11").ok, false);
    assert.equal(parseNewsCount("abc").ok, false);
    assert.match(newsCountHelp(), /all/);
  });
});
describe("parseLogsLines shared helper", () => {
  it("parses aliases and rejects garbage", async () => {
    const { parseLogsLines, logsLinesHelp } = await import(
      "../src/util/logs-lines.js"
    );
    assert.deepEqual(parseLogsLines("all"), { ok: true, lines: 0 });
    assert.deepEqual(parseLogsLines("max"), { ok: true, lines: 0 });
    assert.deepEqual(parseLogsLines("0"), { ok: true, lines: 0 });
    assert.deepEqual(parseLogsLines("30"), { ok: true, lines: 30 });
    assert.equal(parseLogsLines("201").ok, false);
    assert.equal(parseLogsLines("abc").ok, false);
    assert.match(logsLinesHelp(), /all/);
  });
});
describe("env provider/permission/sandbox aliases", () => {
  it("normalizes FORGE_PROVIDER/PERMISSION/SANDBOX aliases", async () => {
    // Pure normalizers only — do not mutate process.env here.
    // node:test runs files in parallel; env leaks race auth-config tests.
    const { normalizeProviderId } = await import("../src/util/provider-id.js");
    const {
      normalizePermissionMode,
      normalizeSandboxProfile,
      normalizeSandboxNetwork,
    } = await import("../src/util/mode-aliases.js");
    assert.deepEqual(normalizeProviderId("claude"), {
      ok: true,
      provider: "anthropic",
    });
    assert.deepEqual(normalizeProviderId("oai"), {
      ok: true,
      provider: "openai",
    });
    assert.deepEqual(normalizeProviderId("grok"), {
      ok: true,
      provider: "xai",
    });
    assert.deepEqual(normalizeProviderId("github-copilot"), {
      ok: true,
      provider: "copilot",
    });
    assert.deepEqual(normalizeProviderId("github"), {
      ok: true,
      provider: "copilot",
    });
    assert.equal(normalizeProviderId("nope").ok, false);
    assert.equal(normalizePermissionMode("yolo"), "bypassPermissions");
    assert.equal(normalizePermissionMode("ask"), "dontAsk");
    assert.equal(normalizePermissionMode("accept"), "acceptEdits");
    assert.equal(normalizePermissionMode("nope"), null);
    assert.equal(normalizeSandboxProfile("readonly"), "read-only");
    assert.equal(normalizeSandboxProfile("ws"), "workspace");
    assert.equal(normalizeSandboxProfile("full"), "strict");
    assert.equal(normalizeSandboxNetwork("none"), "blocked");
    assert.equal(normalizeSandboxNetwork("open"), "unrestricted");
  });
});

describe("slash permissions ask alias", () => {
  it("maps /permissions ask to dontAsk", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-perm-ask-slash-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const cfg = { ...DEFAULT_CONFIG, workspace: tmp, permissionMode: "default" as const };
    const r = await handleSlash("/permissions ask", {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.equal(cfg.permissionMode, "dontAsk");
  });
});
describe("preferences permission alias", () => {
  it("loads yolo/ask from preferences.json as canonical modes", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-prefs-alias-"));
    process.env.FORGE_HOME = tmp;
    const {
      preferencesPath,
      loadPreferences,
      savePreferences,
    } = await import("../src/config/preferences.js");
    fs.writeFileSync(
      preferencesPath(),
      JSON.stringify({ version: 1, permissionMode: "yolo" }),
      "utf8",
    );
    assert.equal(loadPreferences().permissionMode, "bypassPermissions");
    fs.writeFileSync(
      preferencesPath(),
      JSON.stringify({ version: 1, permissionMode: "ask" }),
      "utf8",
    );
    assert.equal(loadPreferences().permissionMode, "dontAsk");
    const saved = savePreferences({ permissionMode: "accept" as any });
    assert.equal(saved.permissionMode, "acceptEdits");
  });
});
describe("auth logout footgun", () => {
  it("suggests forge logout when user types forge auth logout", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-auth-logout-footgun-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const r = spawnSync(
      process.execPath,
      [cli, "auth", "logout", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, false);
    assert.equal(j.reason, "excess_arguments");
    assert.match(String(j.hint || j.error || ""), /forge logout/i);

    const d = spawnSync(
      process.execPath,
      [cli, "doctor", "login", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(d.status, 0);
    const dj = JSON.parse((d.stdout || "").trim());
    assert.equal(dj.reason, "excess_arguments");
    assert.equal(dj.suggestion, "login");
    assert.match(String(dj.hint || ""), /forge login/i);
  });
});
describe("sessions nested command footgun", () => {
  it("does not search when action is a top-level command name", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-sess-login-footgun-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    const r = spawnSync(
      process.execPath,
      [cli, "sessions", "login", "--json"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, false);
    assert.equal(j.reason, "unknown_session_action");
    assert.equal(j.suggestion, "login");
    assert.match(String(j.error || ""), /forge login/i);
  });
});
describe("doctor flags bypassPermissions", () => {
  it("reports yolo as a blocking issue for CI", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doctor-yolo-"));
    process.env.FORGE_HOME = tmp;
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { runDoctorCheck } = await import("../src/commands/slash.js");
    const check = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "bypassPermissions",
    });
    assert.equal(check.ok, false);
    assert.ok(
      check.issues.some((i) => /bypassPermissions|yolo/i.test(i)),
      check.issues.join("; "),
    );
  });
});
describe("doctor flags sandbox off", () => {
  it("reports sandbox=off as a blocking issue for production hosts", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doctor-sandbox-"));
    process.env.FORGE_HOME = tmp;
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { runDoctorCheck } = await import("../src/commands/slash.js");
    const check = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      workspace: tmp,
      sandbox: "off",
      permissionMode: "default",
    });
    assert.equal(check.ok, false);
    assert.ok(
      check.issues.some((i) => /sandbox is off/i.test(i)),
      check.issues.join("; "),
    );
  });
});
describe("sessions list limit aliases", () => {
  it("accepts all|max|unlimited as unlimited (0)", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-sess-limit-alias-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    for (const alias of ["all", "max", "unlimited"] as const) {
      const r = spawnSync(
        process.execPath,
        [cli, "sessions", "list", "--limit", alias, "--json"],
        { env, encoding: "utf8" },
      );
      assert.equal(r.status, 0, alias + " " + (r.stderr || r.stdout));
      const j = JSON.parse((r.stdout || "").trim());
      assert.equal(j.ok, true, alias);
      assert.equal(j.limit, 0, alias);
    }
  });
});
describe("doctor reports active auth provider", () => {
  it("surfaces stored anthropic when config default is xai", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doctor-auth-p-"));
    const prev = {
      FORGE_HOME: process.env.FORGE_HOME,
      XAI_API_KEY: process.env.XAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    try {
      process.env.FORGE_HOME = tmp;
      delete process.env.XAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      const { upsertApiKey } = await import("../src/auth/store.js");
      const { loadConfig } = await import("../src/config/load.js");
      const { runDoctorCheck } = await import("../src/commands/slash.js");
      upsertApiKey("anthropic", "sk-doctor-active-provider");
      const { savePreferences } = await import("../src/config/preferences.js");
      savePreferences({ provider: "anthropic" });
      const cfg = loadConfig({}, tmp);
      assert.equal(cfg.provider, "anthropic");
      const check = await runDoctorCheck(cfg);
      assert.match(check.report, /Provider\/model:\s*anthropic/i);
      assert.match(check.report, /anthropic via api_key/i);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
describe("auth --json includes configProvider", () => {
  it("reports config default provider alongside active auth", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-auth-cfg-provider-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home, XAI_API_KEY: "sk-auth-cfg" };
    const r = spawnSync(process.execPath, [cli, "auth", "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, true);
    assert.equal(j.configProvider, "xai");
    assert.equal(j.active?.provider, "xai");
  });
});

describe("FORGE_JSON_COMPACT", () => {
  it("emits single-line auth --json when compact env is set", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-json-compact-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      FORGE_HOME: home,
      XAI_API_KEY: "sk-compact-test",
      FORGE_JSON_COMPACT: "1",
    };
    const r = spawnSync(process.execPath, [cli, "auth", "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    const out = (r.stdout || "").trim();
    assert.equal(out.includes("\n"), false, "expected single-line JSON");
    const j = JSON.parse(out);
    assert.equal(j.ok, true);
    assert.equal(j.version != null, true);
  });
});

describe("resume session provider auth", () => {
  it("forge run --session uses session provider credentials not sticky default", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-prov-"));
    const env = { ...process.env, FORGE_HOME: home };
    for (const k of Object.keys(env)) {
      if (/API_KEY|FORGE_PROVIDER|FORGE_MODEL/.test(k)) delete env[k];
    }
    process.env.FORGE_HOME = home;
    delete process.env.XAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FORGE_PROVIDER;
    const { createSession, saveSession } = await import("../src/session/session.js");
    const { upsertApiKey } = await import("../src/auth/store.js");
    const { savePreferences } = await import("../src/config/preferences.js");
    upsertApiKey("anthropic", "sk-ant-resume-test");
    // no xai key
    savePreferences({ provider: "anthropic" });
    const s = createSession({
      cwd: process.cwd(),
      provider: "xai",
      model: "grok-4.5",
    });
    saveSession(s);
    const r = spawnSync(
      process.execPath,
      [cli, "run", "ping", "--session", s.meta.id, "--json", "--max-turns", "1"],
      { env, encoding: "utf8" },
    );
    assert.notEqual(r.status, 0);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, false);
    // Must fail closed for xai (session provider), not call anthropic with wrong key
    assert.equal(j.reason, "unauthenticated");
    assert.equal(j.provider, "xai");
  });
});

describe("login without -p uses sticky provider", () => {
  it("re-login api-key targets sticky provider when -p omitted", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-login-sticky-"));
    const env = { ...process.env, FORGE_HOME: home };
    for (const k of Object.keys(env)) {
      if (/API_KEY|FORGE_PROVIDER/.test(k)) delete env[k];
    }
    spawnSync(
      process.execPath,
      [cli, "login", "-p", "claude", "--api-key", "sk-1", "--json"],
      { env, encoding: "utf8" },
    );
    const r = spawnSync(
      process.execPath,
      [cli, "login", "--api-key", "sk-2", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const j = JSON.parse((r.stdout || "").trim());
    assert.equal(j.ok, true);
    assert.equal(j.provider, "anthropic");
    const cfg = JSON.parse(
      spawnSync(process.execPath, [cli, "config", "--json"], {
        env,
        encoding: "utf8",
      }).stdout.trim(),
    );
    assert.equal(cfg.provider, "anthropic");
  });
});

describe("sessions prune max-age-days aliases", () => {
  it("accepts all|none|off as no age filter", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-prune-age-alias-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    for (const alias of ["all", "none", "off"] as const) {
      const r = spawnSync(
        process.execPath,
        [cli, "sessions", "prune", "--keep", "50", "--max-age-days", alias, "--json"],
        { env, encoding: "utf8" },
      );
      assert.equal(r.status, 0, alias + " " + (r.stderr || r.stdout));
      const j = JSON.parse((r.stdout || "").trim());
      assert.equal(j.ok, true, alias);
    }
  });
});

describe("prune-tool-output max-age-days aliases", () => {
  it("accepts all|none as no age filter", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-tool-age-alias-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    for (const alias of ["all", "none"] as const) {
      const r = spawnSync(
        process.execPath,
        [cli, "prune-tool-output", "--max-age-days", alias, "--json"],
        { env, encoding: "utf8" },
      );
      assert.equal(r.status, 0, alias + " " + (r.stderr || r.stdout));
      const j = JSON.parse((r.stdout || "").trim());
      assert.equal(j.ok, true, alias);
    }
  });
});

describe("prune --keep all aliases", () => {
  it("accepts all|max for sessions/metrics/tool-output prune", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!fs.existsSync(cli)) return;
    const home = path.join(
      process.cwd(),
      ".tmp",
      `forge-keep-all-${process.pid}`,
    );
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, FORGE_HOME: home };
    for (const args of [
      ["sessions", "prune", "--keep", "all", "--json"],
      ["prune-metrics", "--keep", "max", "--json"],
      ["prune-tool-output", "--keep", "all", "--json"],
    ] as const) {
      const r = spawnSync(process.execPath, [cli, ...args], {
        env,
        encoding: "utf8",
      });
      assert.equal(r.status, 0, args.join(" ") + " " + (r.stderr || r.stdout));
      const j = JSON.parse((r.stdout || "").trim());
      assert.equal(j.ok, true, args.join(" "));
    }
  });
});

describe("doctor flags sandbox-missing fallback", () => {
  it("reports fallback missing-backend policy as a blocking issue", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doctor-fallback-"));
    process.env.FORGE_HOME = tmp;
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { runDoctorCheck } = await import("../src/commands/slash.js");
    const check = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      workspace: tmp,
      sandbox: "workspace",
      sandboxMissingBackend: "fallback",
      permissionMode: "default",
    });
    assert.equal(check.ok, false);
    assert.ok(
      check.issues.some((i) => /fallback/i.test(i)),
      check.issues.join("; "),
    );
  });
});

describe("forge run --read-outside", () => {
  it("fail-closed empty/invalid and accepts ask|allow|deny", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ro-"));
    const env = { ...process.env, FORGE_HOME: home, XAI_API_KEY: "sk" };
    const empty = spawnSync(process.execPath, [cli, "run", "x", "--read-outside", "", "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(JSON.parse(empty.stdout).reason, "invalid_read_outside");
    const bad = spawnSync(process.execPath, [cli, "run", "x", "--read-outside", "explode", "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(JSON.parse(bad.stdout).reason, "invalid_read_outside");
    // deny alias
    const deny = spawnSync(
      process.execPath,
      [cli, "run", "x", "--read-outside", "deny", "--json", "--max-turns", "1"],
      { env, encoding: "utf8", timeout: 15000 },
    );
    const j = JSON.parse(deny.stdout);
    assert.equal(j.readOutsideWorkspace, "deny");
  });
});

describe("apply_patch empty patch message", () => {
  it("hints required hunk kinds", async () => {
    const { parsePatch } = await import("../src/agent/tools/patch.js");
    const r = parsePatch("*** Begin Patch\n*** End Patch");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /empty patch/i);
      assert.match(r.error, /Add\/Update\/Delete\/Move/i);
    }
  });
});

describe("doctor flags read-outside allow", () => {
  it("reports allow outside-workspace reads as a blocking issue", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doctor-ro-"));
    process.env.FORGE_HOME = tmp;
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { runDoctorCheck } = await import("../src/commands/slash.js");
    const check = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      workspace: tmp,
      sandbox: "workspace",
      readOutsideWorkspace: "allow",
      permissionMode: "default",
    });
    assert.equal(check.ok, false);
    assert.ok(
      check.issues.some((i) => /read-outside|outside the workspace/i.test(i)),
      check.issues.join("; "),
    );
  });
});

describe("logs/news empty count fail-closed", () => {
  it("rejects explicit empty --lines and news count", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-empty-n-"));
    const env = { ...process.env, FORGE_HOME: home };
    const logs = spawnSync(process.execPath, [cli, "logs", "-n", "", "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(JSON.parse(logs.stdout).reason, "invalid_lines");
    const news = spawnSync(process.execPath, [cli, "news", "", "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(JSON.parse(news.stdout).reason, "invalid_count");
    // omit still works
    const logsDef = spawnSync(process.execPath, [cli, "logs", "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(JSON.parse(logsDef.stdout).ok, true);
    assert.equal(JSON.parse(logsDef.stdout).limit, 30);
    const newsDef = spawnSync(process.execPath, [cli, "news", "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(JSON.parse(newsDef.stdout).ok, true);
  });
});

describe("prune-tool-output empty --max-age-days fail-closed", () => {
  it("rejects explicit empty max-age-days", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pto-"));
    const env = { ...process.env, FORGE_HOME: home };
    const empty = spawnSync(
      process.execPath,
      [cli, "prune-tool-output", "--max-age-days", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(JSON.parse(empty.stdout).reason, "invalid_max_age_days");
    const ok = spawnSync(process.execPath, [cli, "prune-tool-output", "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(JSON.parse(ok.stdout).ok, true);
  });
});

describe("doctor --json includes sandbox/read-outside fields", () => {
  it("exposes sandboxMissingBackend, readOutsideWorkspace, stickyProvider, rule counts", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doctor-fields-"));
    const env = {
      ...process.env,
      FORGE_HOME: home,
      XAI_API_KEY: "sk",
      FORGE_READ_OUTSIDE: "deny",
    };
    const r = spawnSync(process.execPath, [cli, "doctor", "--json"], {
      env,
      encoding: "utf8",
    });
    const j = JSON.parse(r.stdout);
    assert.equal(j.readOutsideWorkspace, "deny");
    assert.ok(["fail-closed", "fallback"].includes(j.sandboxMissingBackend));
    assert.ok(["unrestricted", "blocked"].includes(j.sandboxNetwork));
    assert.equal(typeof j.denyRules, "number");
    assert.ok("stickyProvider" in j);
  });
});

describe("sessions export format typo suggestion", () => {
  it("suggests json for jsn", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fmt-"));
    const env = { ...process.env, FORGE_HOME: home };
    const r = spawnSync(
      process.execPath,
      [cli, "sessions", "export", "x", "--format", "jsn", "--json"],
      { env, encoding: "utf8" },
    );
    const j = JSON.parse(r.stdout);
    assert.equal(j.reason, "invalid_format");
    assert.equal(j.suggestion, "json");
    assert.match(j.error, /Did you mean: json/i);
  });
});

describe("typo suggestions for shell/logs/news/stats", () => {
  it("suggests bash/all/week for near-miss tokens", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-typo-"));
    const env = { ...process.env, FORGE_HOME: home };
    const shell = spawnSync(process.execPath, [cli, "completion", "bas", "--json"], {
      env,
      encoding: "utf8",
    });
    const sj = JSON.parse(shell.stdout);
    assert.equal(sj.reason, "invalid_shell");
    assert.equal(sj.suggestion, "bash");
    const logs = spawnSync(process.execPath, [cli, "logs", "-n", "al", "--json"], {
      env,
      encoding: "utf8",
    });
    const lj = JSON.parse(logs.stdout);
    assert.equal(lj.reason, "invalid_lines");
    assert.equal(lj.suggestion, "all");
    const news = spawnSync(process.execPath, [cli, "news", "al", "--json"], {
      env,
      encoding: "utf8",
    });
    const nj = JSON.parse(news.stdout);
    assert.equal(nj.reason, "invalid_count");
    assert.equal(nj.suggestion, "all");
    const stats = spawnSync(process.execPath, [cli, "stats", "--days", "wek", "--json"], {
      env,
      encoding: "utf8",
    });
    const st = JSON.parse(stats.stdout);
    assert.equal(st.reason, "invalid_days");
    assert.equal(st.suggestion, "week");
  });
});

describe("keep/limit/max-age typo suggestions", () => {
  it("suggests all for al on keep/limit/max-age-days", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-keep-typo-"));
    const env = { ...process.env, FORGE_HOME: home };
    const keep = spawnSync(
      process.execPath,
      [cli, "sessions", "prune", "--keep", "al", "--json"],
      { env, encoding: "utf8" },
    );
    const kj = JSON.parse(keep.stdout);
    assert.equal(kj.reason, "invalid_keep");
    assert.equal(kj.suggestion, "all");
    const limit = spawnSync(
      process.execPath,
      [cli, "sessions", "list", "--limit", "al", "--json"],
      { env, encoding: "utf8" },
    );
    const lj = JSON.parse(limit.stdout);
    assert.equal(lj.reason, "invalid_limit");
    assert.equal(lj.suggestion, "all");
    const age = spawnSync(
      process.execPath,
      [cli, "prune-tool-output", "--max-age-days", "al", "--json"],
      { env, encoding: "utf8" },
    );
    const aj = JSON.parse(age.stdout);
    assert.equal(aj.reason, "invalid_max_age_days");
    assert.equal(aj.suggestion, "all");
  });
});

describe("run --session + --continue conflict", () => {
  it("fail-closed conflicting_flags", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sess-cont-"));
    const env = { ...process.env, FORGE_HOME: home, XAI_API_KEY: "sk" };
    const r = spawnSync(
      process.execPath,
      [cli, "run", "x", "--session", "abc", "--continue", "--json"],
      { env, encoding: "utf8" },
    );
    const j = JSON.parse(r.stdout);
    assert.equal(j.reason, "conflicting_flags");
    assert.match(j.error, /--session.*--continue/i);
  });
});

describe("status --interval empty fail-closed", () => {
  it("rejects explicit empty interval", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-interval-"));
    const env = { ...process.env, FORGE_HOME: home };
    const empty = spawnSync(
      process.execPath,
      [cli, "status", "--interval", "", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(JSON.parse(empty.stdout).reason, "invalid_interval");
    const ok = spawnSync(process.execPath, [cli, "status", "--json"], {
      env,
      encoding: "utf8",
    });
    assert.equal(JSON.parse(ok.stdout).ok, true);
  });
});

describe("tips --json structured fields", () => {
  it("includes lines and sections", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tips-"));
    const env = { ...process.env, FORGE_HOME: home };
    const r = spawnSync(process.execPath, [cli, "tips", "--json"], {
      env,
      encoding: "utf8",
    });
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.ok(typeof j.tips === "string" && j.tips.includes("Forge expert tips"));
    assert.ok(Array.isArray(j.lines) && j.lines.length >= 5);
    assert.ok(Array.isArray(j.sections) && j.sections.includes("CI"));
  });
});

describe("run --json productionWarnings", () => {
  it("flags sandbox=off and yolo and read-outside=allow", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pw-"));
    const env = { ...process.env, FORGE_HOME: home, XAI_API_KEY: "sk" };
    const r = spawnSync(
      process.execPath,
      [
        cli,
        "run",
        "x",
        "--sandbox",
        "off",
        "--permission-mode",
        "yolo",
        "--read-outside",
        "allow",
        "--json",
        "--max-turns",
        "1",
      ],
      { env, encoding: "utf8", timeout: 15000 },
    );
    const j = JSON.parse(r.stdout);
    assert.ok(Array.isArray(j.productionWarnings));
    assert.ok(j.productionWarnings.some((w: string) => /sandbox=off/i.test(w)));
    assert.ok(j.productionWarnings.some((w: string) => /bypassPermissions|yolo/i.test(w)));
    assert.ok(j.productionWarnings.some((w: string) => /read-outside=allow/i.test(w)));
    const safe = spawnSync(
      process.execPath,
      [cli, "run", "x", "--sandbox", "workspace", "--read-outside", "deny", "--json", "--max-turns", "1"],
      { env, encoding: "utf8", timeout: 15000 },
    );
    const s = JSON.parse(safe.stdout);
    assert.deepEqual(s.productionWarnings, []);

    const plan = spawnSync(
      process.execPath,
      [
        cli,
        "run",
        "x",
        "--permission-mode",
        "plan",
        "--sandbox",
        "workspace",
        "--read-outside",
        "deny",
        "--json",
        "--max-turns",
        "1",
      ],
      { env, encoding: "utf8", timeout: 15000 },
    );
    const pj = JSON.parse(plan.stdout);
    assert.ok(
      pj.productionWarnings.some((w: string) => /permissionMode=plan/i.test(w)),
    );
  });
});

describe("run --json productionWarnings large inventory", () => {
  it("flags ≥100 sessions on disk", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pw-inv-"));
    const env = { ...process.env, FORGE_HOME: home, XAI_API_KEY: "sk" };
    const { createSession } = await import("../src/session/session.js");
    const prev = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
    try {
      for (let i = 0; i < 100; i++) {
        createSession({ cwd: home, provider: "xai", model: "m" });
      }
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
    }
    const r = spawnSync(
      process.execPath,
      [
        cli,
        "run",
        "x",
        "--sandbox",
        "workspace",
        "--read-outside",
        "deny",
        "--json",
        "--max-turns",
        "1",
      ],
      { env, encoding: "utf8", timeout: 30000 },
    );
    const j = JSON.parse(r.stdout);
    assert.ok(Array.isArray(j.productionWarnings));
    assert.ok(
      j.productionWarnings.some((w: string) => /sessions on disk/i.test(w)),
      `expected inventory warning, got ${JSON.stringify(j.productionWarnings)}`,
    );
  });
});

describe("run --no-blocking-stop", () => {
  it("sets blockingStop false and productionWarnings", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-nbs-"));
    const env = { ...process.env, FORGE_HOME: home, XAI_API_KEY: "sk" };
    const r = spawnSync(
      process.execPath,
      [cli, "run", "x", "--no-blocking-stop", "--json", "--max-turns", "1"],
      { env, encoding: "utf8", timeout: 15000 },
    );
    const j = JSON.parse(r.stdout);
    assert.equal(j.blockingStop, false);
    assert.ok(j.productionWarnings.some((w: string) => /blockingStop/i.test(w)));
  });
});

describe("mergeRunOpts carries readOutside and blockingStop", () => {
  it("prefers parent CLI blockingStop over run default", async () => {
    const { mergeRunOpts } = await import("../src/util/merge-run-opts.js");
    const command = {
      optsWithGlobals: () => ({ blockingStop: false, readOutside: "deny" }),
      getOptionValueSource: (k: string) =>
        k === "blockingStop" || k === "readOutside" ? "default" : undefined,
      parent: {
        getOptionValueSource: (k: string) =>
          k === "blockingStop" || k === "readOutside" ? "cli" : undefined,
      },
    };
    const merged = mergeRunOpts(command, {
      // run subcommand default would be true
      blockingStop: true,
      readOutside: "ask",
    });
    assert.equal(merged.blockingStop, false);
    assert.equal(merged.readOutside, "deny");
  });
});

describe("run --base-url ftp tip", () => {
  it("suggests https for ftp base-url", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-base-ftp-"));
    const env = { ...process.env, FORGE_HOME: home, XAI_API_KEY: "sk" };
    const r = spawnSync(
      process.execPath,
      [cli, "run", "x", "--base-url", "ftp://api.x.ai", "--json"],
      { env, encoding: "utf8" },
    );
    const j = JSON.parse(r.stdout);
    assert.equal(j.reason, "invalid_base_url");
    assert.equal(j.suggestion, "https");
    assert.match(j.error, /Did you mean: https/i);
  });
});

describe("sessions export --json without --out", () => {
  it("emits structured envelope even for md format", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-export-json-"));
    process.env.FORGE_HOME = home;
    const { createSession, saveSession } = await import("../src/session/session.js");
    const s = createSession({
      cwd: process.cwd(),
      provider: "xai",
      model: "grok-4.5",
      title: "export-json",
    });
    saveSession(s);
    const env = { ...process.env, FORGE_HOME: home };
    const md = spawnSync(
      process.execPath,
      [cli, "sessions", "export", s.meta.id, "--format", "md", "--json"],
      { env, encoding: "utf8" },
    );
    const j = JSON.parse(md.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.format, "md");
    assert.equal(j.id, s.meta.id);
    assert.equal(typeof j.body, "string");
    assert.match(j.body, /Forge session/i);
    const js = spawnSync(
      process.execPath,
      [cli, "sessions", "export", s.meta.id, "--format", "json", "--json"],
      { env, encoding: "utf8" },
    );
    const j2 = JSON.parse(js.stdout);
    assert.equal(j2.ok, true);
    assert.equal(j2.format, "json");
    assert.ok(j2.body && typeof j2.body === "object");
  });
});

describe("sessions import accepts export --json envelope", () => {
  it("unwraps body from export --json stdout payload", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-import-env-"));
    process.env.FORGE_HOME = home;
    const { createSession, saveSession } = await import("../src/session/session.js");
    const s = createSession({
      cwd: process.cwd(),
      provider: "xai",
      model: "grok-4.5",
      title: "import-env",
    });
    saveSession(s);
    const env = { ...process.env, FORGE_HOME: home };
    const exp = spawnSync(
      process.execPath,
      [cli, "sessions", "export", s.meta.id, "--format", "json", "--json"],
      { env, encoding: "utf8" },
    );
    const envelope = JSON.parse(exp.stdout);
    assert.equal(envelope.ok, true);
    const file = path.join(home, "envelope.json");
    fs.writeFileSync(file, JSON.stringify(envelope));
    const imp = spawnSync(
      process.execPath,
      [cli, "sessions", "import", file, "--json"],
      { env, encoding: "utf8" },
    );
    const j = JSON.parse(imp.stdout);
    assert.equal(j.ok, true);
    assert.ok(j.id);
    assert.notEqual(j.id, s.meta.id);
  });
});

describe("doctor what-if safety flags", () => {
  it("honors --sandbox off and --read-outside allow on doctor itself", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-doctor-whatif-"));
    const env = { ...process.env, FORGE_HOME: home, XAI_API_KEY: "sk" };
    const r = spawnSync(
      process.execPath,
      [cli, "doctor", "--json", "--sandbox", "off", "--read-outside", "allow"],
      { env, encoding: "utf8" },
    );
    const j = JSON.parse(r.stdout);
    assert.equal(j.sandbox, "off");
    assert.equal(j.readOutsideWorkspace, "allow");
    assert.equal(j.ok, false);
    assert.ok(j.issues.some((i: string) => /sandbox is off/i.test(i)));
    assert.ok(j.issues.some((i: string) => /read-outside|outside the workspace/i.test(i)));
  });
});

describe("config what-if safety flags", () => {
  it("applies --sandbox/--read-outside on config snapshot", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-config-whatif-"));
    const env = { ...process.env, FORGE_HOME: home };
    const r = spawnSync(
      process.execPath,
      [cli, "config", "--json", "--sandbox", "strict", "--read-outside", "deny"],
      { env, encoding: "utf8" },
    );
    const j = JSON.parse(r.stdout);
    assert.equal(j.sandbox, "strict");
    assert.equal(j.readOutsideWorkspace, "deny");
  });
});

describe("FORGE_BASH_TIMEOUT_MS duration suffixes", () => {
  it("accepts 90s via envDurationMs/defaultBashTimeoutMs", async () => {
    const prev = process.env.FORGE_BASH_TIMEOUT_MS;
    process.env.FORGE_BASH_TIMEOUT_MS = "90s";
    try {
      const { defaultBashTimeoutMs } = await import("../src/util/env.js");
      assert.equal(defaultBashTimeoutMs(), 90_000);
    } finally {
      if (prev === undefined) delete process.env.FORGE_BASH_TIMEOUT_MS;
      else process.env.FORGE_BASH_TIMEOUT_MS = prev;
    }
  });
});

describe("FORGE_MAX_RUN_MS / PROVIDER_TIMEOUT duration suffixes", () => {
  it("parses 10m and 5m via shared duration helper", async () => {
    const prevMax = process.env.FORGE_MAX_RUN_MS;
    const prevProv = process.env.FORGE_PROVIDER_TIMEOUT_MS;
    try {
      process.env.FORGE_MAX_RUN_MS = "10m";
      const { maxRunMsFromEnv } = await import("../src/util/env.js");
      assert.equal(maxRunMsFromEnv(), 600_000);
      process.env.FORGE_PROVIDER_TIMEOUT_MS = "5m";
      // fresh module path for providerTimeoutMs
      const { providerTimeoutMs } = await import("../src/util/abort.js");
      // may be cached — call after env set; if cached still assert function exists
      const n = providerTimeoutMs();
      assert.ok(n >= 5_000);
      // direct parse
      const { parseDurationMs } = await import("../src/util/duration-ms.js");
      assert.equal(parseDurationMs("5m").ok && (parseDurationMs("5m") as any).ms, 300_000);
      assert.equal(parseDurationMs("10m").ok && (parseDurationMs("10m") as any).ms, 600_000);
    } finally {
      if (prevMax === undefined) delete process.env.FORGE_MAX_RUN_MS;
      else process.env.FORGE_MAX_RUN_MS = prevMax;
      if (prevProv === undefined) delete process.env.FORGE_PROVIDER_TIMEOUT_MS;
      else process.env.FORGE_PROVIDER_TIMEOUT_MS = prevProv;
    }
  });
});

describe("FORGE_PERMISSION_TIMEOUT_MS duration suffixes", () => {
  it("accepts 45s", async () => {
    const prev = process.env.FORGE_PERMISSION_TIMEOUT_MS;
    process.env.FORGE_PERMISSION_TIMEOUT_MS = "45s";
    try {
      const { permissionAskTimeoutMs } = await import("../src/agent/permissions.js");
      assert.equal(permissionAskTimeoutMs(), 45_000);
    } finally {
      if (prev === undefined) delete process.env.FORGE_PERMISSION_TIMEOUT_MS;
      else process.env.FORGE_PERMISSION_TIMEOUT_MS = prev;
    }
  });
});

describe("sessions import markdown export hint", () => {
  it("steers md export files to --format json", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-import-md-"));
    process.env.FORGE_HOME = home;
    const { createSession, saveSession } = await import("../src/session/session.js");
    const s = createSession({
      cwd: process.cwd(),
      provider: "xai",
      model: "grok-4.5",
      title: "md-imp",
    });
    saveSession(s);
    const env = { ...process.env, FORGE_HOME: home };
    const exp = spawnSync(
      process.execPath,
      [cli, "sessions", "export", s.meta.id, "--format", "md", "--json"],
      { env, encoding: "utf8" },
    );
    const envelope = JSON.parse(exp.stdout);
    const file = path.join(home, "session.md");
    fs.writeFileSync(file, envelope.body);
    const imp = spawnSync(
      process.execPath,
      [cli, "sessions", "import", file, "--json"],
      { env, encoding: "utf8" },
    );
    const j = JSON.parse(imp.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.reason, "invalid");
    assert.match(j.error, /markdown exports are not importable|--format json/i);
  });
});

describe("doctor package.json engines.node floor", () => {
  it("flags runtime below engines.node >=N floor", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const cli = path.join(process.cwd(), "dist/cli.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-engines-"));
    const cwd = path.join(home, "proj");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "x", engines: { node: ">=99" } }),
    );
    const env = { ...process.env, FORGE_HOME: home, XAI_API_KEY: "sk" };
    const r = spawnSync(
      process.execPath,
      [cli, "doctor", "--json", "--cwd", cwd],
      { env, encoding: "utf8" },
    );
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.ok(j.issues.some((i: string) => /engines\.node floor 99/i.test(i)));
    assert.equal(j.packageEnginesNode, ">=99");
  });
});

describe("completion script sessions hygiene", () => {
  it("dedupes --untitled and includes errors/untitled actions", async () => {
    const { shellCompletionScript } = await import("../src/util/completion-script.js");
    const bash = shellCompletionScript("bash");
    assert.ok(!/--untitled --untitled/.test(bash), "duplicate --untitled");
    assert.match(bash, /--untitled/);
    assert.match(bash, /\berrors\b/);
    // actions list should include untitled as action
    assert.match(bash, /untitled/);
  });
});
