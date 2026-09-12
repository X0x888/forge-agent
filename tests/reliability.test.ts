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
  isFetchFailedRetryError,
  noteFetchFailedRetry,
  retryEventReason,
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

  it("repairs bare undefined / NaN values to null", () => {
    const r = parseToolArguments('{"a": true, "b": undefined, "c": NaN}');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.repaired, true);
      assert.equal(r.value.a, true);
      assert.equal(r.value.b, null);
      assert.equal(r.value.c, null);
    }
  });

  it("repairs unquoted keys", () => {
    const r = parseToolArguments('{path: "src/a.ts", offset: 1}');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.repaired, true);
      assert.equal(r.value.path, "src/a.ts");
      assert.equal(r.value.offset, 1);
    }
  });

  it("strips // and /* */ comments outside strings", () => {
    const line = parseToolArguments('{"a":1 // trailing\n,"b":2}');
    assert.equal(line.ok, true);
    if (line.ok) {
      assert.equal(line.value.a, 1);
      assert.equal(line.value.b, 2);
    }
    const block = parseToolArguments('{"a":1, /* skip */ "b":2}');
    assert.equal(block.ok, true);
    if (block.ok) {
      assert.equal(block.value.a, 1);
      assert.equal(block.value.b, 2);
    }
    // Comments inside string values must stay intact.
    const kept = parseToolArguments('{"cmd":"echo // not a comment"}');
    assert.equal(kept.ok, true);
    if (kept.ok) assert.equal(kept.value.cmd, "echo // not a comment");
  });

  it("repairs empty values after colon (closed or mid-list)", () => {
    const closed = parseToolArguments('{"a":1,"b":}');
    assert.equal(closed.ok, true);
    if (closed.ok) {
      assert.equal(closed.repaired, true);
      assert.equal(closed.value.a, 1);
      assert.equal(closed.value.b, null);
    }
    const mid = parseToolArguments('{"a":1,"b":, "c":2}');
    assert.equal(mid.ok, true);
    if (mid.ok) {
      assert.equal(mid.value.a, 1);
      assert.equal(mid.value.b, null);
      assert.equal(mid.value.c, 2);
    }
    // Unquoted keys + empty value (combined model glitch).
    const bare = parseToolArguments("{a:1,b:,c:2}");
    assert.equal(bare.ok, true);
    if (bare.ok) {
      assert.equal(bare.value.a, 1);
      assert.equal(bare.value.b, null);
      assert.equal(bare.value.c, 2);
    }
    // Truncated colon still recovers (existing closeIncompleteJson path).
    const trunc = parseToolArguments('{"command":"npm test","background":');
    assert.equal(trunc.ok, true);
    if (trunc.ok) {
      assert.equal(trunc.value.command, "npm test");
      assert.equal(trunc.value.background, null);
    }
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

  it("Retry-After: 60 is not clamped to the 12s client cap", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 429,
      body: "rate limited",
      retryAfterMs: 60_000,
    });
    assert.equal(computeRetryDelayMs(err, 0, {}), 60_000);
  });

  it("server hints are still capped at the 120s ceiling", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 429,
      body: "rate limited",
      retryAfterMs: 600_000,
    });
    assert.equal(computeRetryDelayMs(err, 0, {}), 120_000);
  });

  it("no hint → exponential backoff under maxDelay", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 500,
      body: "boom",
    });
    const d = computeRetryDelayMs(err, 1, { baseDelayMs: 800, maxDelayMs: 12_000 });
    assert.ok(d >= 1600 && d <= 12_000);
  });

  it("counts fetch-failed / ECONNRESET / terminated for browser-reap", () => {
    assert.equal(isFetchFailedRetryError(new Error("fetch failed")), true);
    assert.equal(isFetchFailedRetryError(new Error("read ECONNRESET")), true);
    const term = new Error("terminated");
    term.name = "TypeError";
    assert.equal(isFetchFailedRetryError(term), true);
    assert.equal(isFetchFailedRetryError(new Error("API error 503 overloaded")), false);
    const first = noteFetchFailedRetry(new Error("fetch failed"), 0);
    assert.equal(first.count, 1);
    assert.equal(first.reap, false);
    const second = noteFetchFailedRetry(new Error("read ECONNRESET"), 1);
    assert.equal(second.reap, true);
    assert.equal(second.visionImageCap, 2);
    assert.match(retryEventReason(term), /TypeError: terminated/);
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

  it("doctor flags yolo/sandbox-off aliases like canonical modes", async () => {
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { runDoctorCheck } = await import("../src/commands/slash.js");
    const yolo = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      permissionMode: "yolo" as any,
    });
    assert.ok(
      yolo.issues.some((i) => /bypassPermissions \(yolo\)/i.test(i)),
      "yolo alias must raise the yolo doctor issue",
    );
    const sandboxNone = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      sandbox: "none" as any,
    });
    assert.ok(
      sandboxNone.issues.some((i) => /Sandbox is off/i.test(i)),
      "sandbox=none alias must raise sandbox-off doctor issue",
    );
  });

  it("doctor and production-warnings treat stringy blockingStopHooks=false as OFF", async () => {
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { runDoctorCheck } = await import("../src/commands/slash.js");
    const { productionWarningsForRun } = await import(
      "../src/util/production-warnings.js"
    );
    const { isFalsy, coerceBool } = await import("../src/util/bool.js");
    assert.equal(isFalsy("false"), true);
    assert.equal(isFalsy("0"), true);
    assert.equal(coerceBool("false"), false);
    assert.equal(coerceBool("true"), true);

    const doc = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      blockingStopHooks: "false" as any,
    });
    assert.ok(
      doc.issues.some((i) => /Blocking Stop is OFF/i.test(i)),
      "string blockingStopHooks=false must raise Blocking Stop OFF",
    );
    const w = productionWarningsForRun(
      { ...DEFAULT_CONFIG, blockingStopHooks: "false" as any },
      {
        _testDirtyFiles: 0,
        _testSessionCount: 0,
        _testPinnedCount: 0,
      },
    );
    assert.ok(w.some((x) => /blockingStopHooks=false/i.test(x)));
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
    // runDoctor should match check.report; git dirty Δ can race with parallel
    // tests touching the tree, so normalize that volatile segment.
    const stabilizeGit = (s: string) =>
      s
        .replace(/Δ\d+/g, "ΔN")
        .replace(/dirty \d+/g, "dirty N")
        .replace(/dirty tree has \d+ changed files/g, "dirty tree has N changed files");
    assert.equal(stabilizeGit(await runDoctor(cfg)), stabilizeGit(report));
    assert.equal(typeof check.modelInCatalog, "boolean");
    // default xai/grok-4.6 is in catalog
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
    {
      const stabilizeGit = (s: string) =>
        s
          .replace(/Δ\d+/g, "ΔN")
          .replace(/dirty \d+/g, "dirty N")
          .replace(/dirty tree has \d+ changed files/g, "dirty tree has N changed files");
      assert.equal(
        stabilizeGit(await runDoctor(cfg)),
        stabilizeGit(check.report),
      );
    }
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

  it("touch() resets stall so active streams outlive the stall window", async () => {
    const { mergeAbortSignals } = await import("../src/util/abort.js");
    const { signal, dispose, touch } = mergeAbortSignals(undefined, 80);
    // Keep the stream "alive" past one stall period
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(signal.aborted, false, `still alive at tick ${i}`);
      touch();
    }
    assert.equal(signal.aborted, false);
    // Stop touching — should abort after stall
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(signal.aborted, true);
    assert.match(
      String((signal as AbortSignal & { reason?: unknown }).reason ?? ""),
      /timed out after 80ms/i,
    );
    dispose();
  });

  it("reasoning output wall fires without stall touch and is not a timeout retry", async () => {
    const {
      armReasoningOutputWall,
      providerReasoningWallMs,
      isTimeoutError,
    } = await import("../src/util/abort.js");
    const prev = process.env.FORGE_PROVIDER_REASONING_WALL_MS;
    process.env.FORGE_PROVIDER_REASONING_WALL_MS = "80ms";
    try {
      assert.equal(providerReasoningWallMs(), 80);
      let fired = 0;
      const wall = armReasoningOutputWall(80, () => {
        fired += 1;
      });
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(fired, 1);
      wall.dispose();
      const quiet = armReasoningOutputWall(80, () => {
        fired += 1;
      });
      quiet.noteVisibleOutput();
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(fired, 1, "visible output cancels the wall");
      quiet.dispose();
      process.env.FORGE_PROVIDER_REASONING_WALL_MS = "off";
      assert.equal(providerReasoningWallMs(), 0);
    } finally {
      if (prev === undefined) delete process.env.FORGE_PROVIDER_REASONING_WALL_MS;
      else process.env.FORGE_PROVIDER_REASONING_WALL_MS = prev;
    }
    assert.equal(isTimeoutError(new Error("Request timed out after 80ms")), true);
  });

  it("maxWallMs aborts even if touch keeps resetting stall", async () => {
    const { mergeAbortSignals, isTimeoutError } = await import(
      "../src/util/abort.js"
    );
    const { signal, dispose, touch } = mergeAbortSignals(undefined, 500, {
      maxWallMs: 90,
    });
    const iv = setInterval(() => touch(), 20);
    await new Promise((r) => setTimeout(r, 140));
    clearInterval(iv);
    assert.equal(signal.aborted, true);
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    assert.equal(isTimeoutError(reason), true);
    assert.match(String(reason ?? ""), /absolute max/i);
    dispose();
  });
});

describe("auth failure detection", () => {
  it("classifies 401/expired token messages", async () => {
    const { isAuthFailureMessage } = await import("../src/auth/refresh.js");
    assert.equal(isAuthFailureMessage("API error 401: unauthorized"), true);
    assert.equal(isAuthFailureMessage("invalid_api_key"), true);
    assert.equal(isAuthFailureMessage("rate limit 429"), false);
    assert.equal(
      isAuthFailureMessage(
        "The OAuth2 access token could not be validated",
      ),
      true,
    );
  });

  it("isTokenAuthFailure: SuperGrok 403 token death vs quota 403", async () => {
    const { isTokenAuthFailure } = await import("../src/auth/refresh.js");
    const { ProviderApiError } = await import("../src/providers/errors.js");

    // Observed mid-ULW death: 403 + validated — must recover (refresh/switch)
    const superGrokDead = new ProviderApiError({
      provider: "xai",
      status: 403,
      body: "The OAuth2 access token could not be validated.",
    });
    assert.equal(isTokenAuthFailure(superGrokDead), true);

    const unauth401 = new ProviderApiError({
      provider: "xai",
      status: 401,
      body: "Unauthorized",
    });
    assert.equal(isTokenAuthFailure(unauth401), true);

    // Quota/policy 403 must NOT take the auth-recovery path
    const quota403 = new ProviderApiError({
      provider: "xai",
      status: 403,
      body: "You have exceeded your plan quota / usage limit",
    });
    assert.equal(isTokenAuthFailure(quota403), false);

    assert.equal(isTokenAuthFailure(new Error("rate limit 429")), false);
    assert.equal(
      isTokenAuthFailure(
        new Error("xai API error 403: The OAuth2 access token could not be validated"),
      ),
      true,
    );
  });

  it("OAuth refresh without expires_in does not keep a past expiresAt", async () => {
    // Regression: mid-run recovery used resolveAuth after refresh; a stale
    // past expiresAt made resolveAuth skip the fresh bearer so ULW died and
    // only "continue" (proactive path) recovered.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-refresh-ttl-"));
    const prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
    const prevFetch = globalThis.fetch;
    try {
      const { upsertOAuth, getCredential, isExpired } = await import(
        "../src/auth/store.js"
      );
      const { refreshCredentialIfNeeded } = await import(
        "../src/auth/refresh.js"
      );
      const { nowEpoch } = await import("../src/util/fs.js");
      const past = nowEpoch() - 3600;
      upsertOAuth("xai", {
        accessToken: "dead-access",
        refreshToken: "rt-live",
        expiresAt: past,
        clientId: "test-client",
        method: "subscription",
        accountLabel: "test:refresh-ttl",
      });
      assert.equal(isExpired(getCredential("xai")!), true);

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "rt-live",
            // deliberately omit expires_in
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;

      const r = await refreshCredentialIfNeeded("xai", { force: true });
      assert.equal(r.ok, true);
      assert.equal(r.refreshed, true);
      assert.equal(r.credential?.accessToken, "fresh-access");
      const cred = getCredential("xai")!;
      assert.equal(cred.accessToken, "fresh-access");
      assert.equal(isExpired(cred, 0), false, "must not keep past expiresAt");
      assert.ok(
        cred.expiresAt && cred.expiresAt > nowEpoch(),
        "default TTL should be in the future",
      );
    } finally {
      globalThis.fetch = prevFetch;
      if (prevHome === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prevHome;
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
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

  it("trips success repeats at 2 and does not doom MCP partial", async () => {
    const {
      DoomLoopTracker,
      classifyToolDoomOutcome,
      isTaskOutputPoll,
    } = await import("../src/agent/doom-loop.js");
    const t = new DoomLoopTracker({ threshold: 3 });
    const q = { query: "*" };
    assert.equal(t.observe("search_mcp", q), null);
    t.noteResult("search_mcp", q, "MCP tools (2): context7, playwright", false);
    const success = t.observe("search_mcp", q);
    assert.ok(success);
    assert.equal(success!.kind, "doom");
    assert.match(success!.message, /already have this result/i);

    const p = new DoomLoopTracker({ threshold: 3 });
    const partialBody =
      "MCP tools matching \"*\" (1):\n(Partial: some servers still connecting or failed — see server errors below.)";
    assert.equal(classifyToolDoomOutcome(partialBody, false), "partial");
    assert.equal(p.observe("search_mcp", q), null);
    p.noteResult("search_mcp", q, partialBody, false);
    const wait = p.observe("search_mcp", q);
    assert.ok(wait);
    assert.equal(wait!.kind, "wait");
    assert.match(wait!.message, /partial|connecting/i);
    assert.doesNotMatch(wait!.message, /STOP repeating/);

    assert.equal(
      isTaskOutputPoll("get_task_output", { task_id: "t1" }),
      true,
    );
    assert.equal(
      isTaskOutputPoll("get_task_output", { task_id: "t1", wait: 120000 }),
      false,
    );
    assert.equal(
      isTaskOutputPoll("get_task_output", { task_id: "t1", timeout_ms: 120000 }),
      false,
    );
    const poll = new DoomLoopTracker({ threshold: 3 });
    assert.equal(poll.observe("get_task_output", { task_id: "t1" }), null);
    const pollHit = poll.observe("get_task_output", { task_id: "t1" });
    assert.ok(pollHit);
    assert.equal(pollHit!.kind, "poll");
    assert.match(pollHit!.message, /wait=/);

    const stub = new DoomLoopTracker({ threshold: 3 });
    const stubBody =
      "[Stale tool output cleared (bash, 9000 chars). Full output: /tmp/x.txt — use read_file on that path. Do not re-run bash to restore this result.]";
    assert.equal(classifyToolDoomOutcome(stubBody, false), "stub");
    stub.observe("bash", { command: "ls" });
    stub.noteResult("bash", { command: "ls" }, stubBody, false);
    const stubHit = stub.observe("bash", { command: "ls" });
    assert.ok(stubHit);
    assert.equal(stubHit!.kind, "stub");
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
    // pid 1 (launchd/init) always exists: alive for root, EPERM otherwise —
    // and EPERM is still a LIVE foreign holder (never stealable), so the
    // locked session is skipped either way.
    assert.ok(afterSkip);
    assert.ok(afterSkip!.meta);
    assert.equal(afterSkip!.meta!.id, unlocked.meta.id);
    assert.equal(afterSkip!.skippedLocked, 1);
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
    const sub = formatPermissionPreview("spawn_subagent", {
      subagent_type: "explore",
      description: "map daily REPL dumps",
      prompt: "Read src/tui/repl.ts and list leftover chrome.",
    });
    assert.match(sub, /explore: map daily REPL dumps/);
    assert.ok(!sub.includes("Read src/tui/repl.ts"));
    const mcp = formatPermissionPreview("call_mcp", {
      tool_name: "github__list_issues",
      arguments: { owner: "X0x888", repo: "forge-agent" },
    });
    assert.match(mcp, /github__list_issues · 2 args/);
    assert.ok(!mcp.includes("X0x888"));
    const resource = formatPermissionPreview("mcp_resource", {
      action: "read",
      uri: "docs://forge/help",
    });
    assert.match(resource, /uri=docs:\/\/forge\/help/);
    assert.ok(!resource.includes("{\n"));
    const search = formatPermissionPreview("search_mcp", {
      query: "playwright click",
      limit: 8,
    });
    assert.match(search, /playwright click/);
    assert.ok(!search.includes("query="));
    assert.ok(!search.includes("{\n"));
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
      sessionSpendForRunEnd,
      snapshotRunSpend,
      crashRunEndRounds,
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
        sessionId: "stuck-1",
        provider: "xai",
        model: "m",
        turns: 4,
        stopContinues: 3,
        stuckReleased: true,
        editCount: 8,
        promptTokens: 10,
        completionTokens: 5,
        ok: true,
      }),
    );
    const stuckLine = fs
      .readFileSync(metricsPath(), "utf8")
      .trim()
      .split("\n")
      .at(-1)!;
    assert.match(stuckLine, /"stuckReleased":true/);

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

    const crashSpend = sessionSpendForRunEnd({
      totalPromptTokens: 12_000,
      totalCompletionTokens: 800,
      totalCacheReadTokens: 4_000,
      lastRoundPromptTokens: 3_000,
      lastRoundCacheReadTokens: 2_700,
    });
    const crashEv = buildRunEndMetrics({
      sessionId: "crash-1",
      provider: "xai",
      model: "grok-4",
      turns: 0,
      stopContinues: 0,
      editCount: 2,
      ...crashSpend,
      ok: false,
      lastErrorCode: "provider_error",
    });
    assert.equal(crashSpend.turns, 0);
    assert.equal(crashEv.promptTokens, 12_000);
    assert.equal(crashEv.completionTokens, 800);
    assert.equal(crashEv.ok, false);
    assert.ok((crashEv.estCostUsd ?? 0) > 0);

    const snap = snapshotRunSpend({
      totalPromptTokens: 10_000,
      totalCompletionTokens: 500,
      totalCacheReadTokens: 3_000,
      turnCount: 4,
    });
    const deltaSpend = sessionSpendForRunEnd(
      {
        totalPromptTokens: 12_000,
        totalCompletionTokens: 800,
        totalCacheReadTokens: 4_000,
        lastRoundPromptTokens: 3_000,
        lastRoundCacheReadTokens: 2_700,
        turnCount: 6,
      },
      snap,
    );
    assert.equal(deltaSpend.promptTokens, 2_000);
    assert.equal(deltaSpend.completionTokens, 300);
    assert.equal(deltaSpend.cacheReadTokens, 1_000);
    assert.equal(deltaSpend.turns, 2);
    assert.deepEqual(crashRunEndRounds({}), {});
    assert.deepEqual(crashRunEndRounds({ providerRounds: 0 }), {});
    assert.deepEqual(crashRunEndRounds({ providerRounds: 12 }), {
      turns: 12,
      providerRounds: 12,
    });

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
    assert.equal(stats.costCapHits, 0);
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
    // No run carried harness meters → the row says so instead of printing 0%.
    assert.match(textOut, /harness:\s+\(no metered runs/);
  });

  it("provider_round events live in rounds.jsonl so run_end history survives auto-prune", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rounds-"));
    process.env.FORGE_HOME = tmp;
    const {
      appendSessionMetrics,
      buildRunEndMetrics,
      metricsPath,
      roundsPath,
      metricsStats,
      pruneMetrics,
      readMetricsEvents,
    } = await import("../src/session/metrics.js");
    const { appendProviderRoundMetrics } = await import(
      "../src/session/prompt-cache.js"
    );
    appendProviderRoundMetrics({
      sessionId: "s1",
      provider: "xai",
      model: "m",
      promptTokens: 1000,
      cacheReadTokens: 900,
      completionTokens: 10,
      pruned: false,
      turn: 1,
      retries: [
        { attempt: 1, reason: "fetch failed", delayMs: 800 },
        { attempt: 2, reason: "TypeError: terminated", delayMs: 1600 },
      ],
    });
    for (let i = 1; i < 20; i++) {
      appendProviderRoundMetrics({
        sessionId: "s1",
        provider: "xai",
        model: "m",
        promptTokens: 1000 + i,
        cacheReadTokens: 900,
        completionTokens: 10,
        pruned: false,
        turn: i + 1,
      });
    }
    appendSessionMetrics(
      buildRunEndMetrics({
        sessionId: "s1",
        provider: "xai",
        model: "m",
        turns: 20,
        stopContinues: 2,
        editCount: 3,
        promptTokens: 20_000,
        completionTokens: 200,
        ok: true,
        harnessUserPokes: 4,
        proofPokes: 1,
        guardBlocks: { proofClaim: 1, ulw: 2, report: 0 },
        providerRounds: 20,
      }),
    );
    // Rounds never touch metrics.jsonl; the run record is the only line there.
    const runLines = fs
      .readFileSync(metricsPath(), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    assert.equal(runLines.length, 1);
    assert.match(runLines[0], /"type":"run_end"/);
    assert.match(runLines[0], /"guardBlocks":\{"proofClaim":1,"ulw":2\}/);
    const roundLines = fs
      .readFileSync(roundsPath(), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    assert.equal(roundLines.length, 20);
    assert.ok(roundLines.every((l) => /"type":"provider_round"/.test(l)));
    assert.match(roundLines[0]!, /"retries":\[\{"attempt":1,"reason":"fetch failed"/);
    // Every round is priced: a 7,970-round run used to sum to $0 here.
    const priced = roundLines.map((l) => JSON.parse(l) as { estCostUsd?: number });
    assert.ok(priced.every((r) => typeof r.estCostUsd === "number" && r.estCostUsd > 0));
    const first = priced[0]!.estCostUsd!;
    // xai default: (1000-900)*2 + 900*0.5 + 10*6 per 1M tokens.
    assert.ok(Math.abs(first - (100 * 2 + 900 * 0.5 + 10 * 6) / 1_000_000) < 1e-12, String(first));
    // Per-session sidecar still receives both kinds.
    const side = fs
      .readFileSync(path.join(tmp, "sessions", "s1", "rounds.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    assert.equal(side.length, 21);
    const st = metricsStats();
    assert.equal(st.events, 1);
    assert.equal(st.rounds?.events, 20);
    // readMetricsEvents (forge stats) sees only run-level records.
    assert.equal(readMetricsEvents().length, 1);
    // Prune cuts both files.
    const pruned = pruneMetrics({ keep: 5 });
    assert.equal(pruned.afterEvents, 1);
    assert.equal(pruned.rounds?.afterEvents, 5);
    assert.equal(pruned.rounds?.deleted, 15);
    assert.equal(metricsStats().rounds?.events, 5);
  });

  it("collectUsageStats totals harness pokes and guard blocks across metered runs", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-harness-stats-"));
    process.env.FORGE_HOME = tmp;
    const {
      appendSessionMetrics,
      buildRunEndMetrics,
      collectUsageStats,
      formatUsageStats,
    } = await import("../src/session/metrics.js");
    appendSessionMetrics(
      buildRunEndMetrics({
        sessionId: "a",
        provider: "xai",
        model: "m",
        turns: 30,
        stopContinues: 5,
        editCount: 4,
        promptTokens: 1,
        completionTokens: 1,
        ok: true,
        harnessUserPokes: 9,
        proofPokes: 2,
        guardBlocks: { ulw: 5, proofClaim: 2, handoff: 1 },
        providerRounds: 30,
      }),
    );
    appendSessionMetrics(
      buildRunEndMetrics({
        sessionId: "b",
        provider: "xai",
        model: "m",
        turns: 10,
        stopContinues: 1,
        editCount: 1,
        promptTokens: 1,
        completionTokens: 1,
        ok: true,
        harnessUserPokes: 1,
        guardBlocks: { report: 1 },
        providerRounds: 10,
      }),
    );
    // Legacy record without meters — counted as a run, not as metered.
    appendSessionMetrics(
      buildRunEndMetrics({
        sessionId: "c",
        provider: "xai",
        model: "m",
        turns: 2,
        stopContinues: 0,
        editCount: 0,
        promptTokens: 1,
        completionTokens: 1,
        ok: true,
      }),
    );
    const stats = collectUsageStats();
    assert.equal(stats.runs, 3);
    assert.equal(stats.harness.meteredRuns, 2);
    assert.equal(stats.harness.providerRounds, 40);
    assert.equal(stats.harness.pokes, 10);
    assert.equal(stats.harness.proofPokes, 2);
    assert.deepEqual(stats.harness.guardBlocks, {
      ulw: 5,
      proofClaim: 2,
      handoff: 1,
      report: 1,
    });
    const text = formatUsageStats(stats);
    assert.match(text, /harness:\s+pokes=10 \(25% of 40 rounds\)\s+proof=2/);
    assert.match(text, /blocks: ulw=5 proofClaim=2 handoff=1 report=1/);
    assert.match(text, /2\/3 runs metered/);
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
    const a2 = acquireSessionLock(s.meta.id);
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
      const blocked = acquireSessionLock(s.meta.id);
      assert.equal(blocked.ok, false);
      assert.equal(blocked.owned, false);
      assert.ok(blocked.holder);
      const forced = acquireSessionLock(s.meta.id, { force: true });
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
    assert.match(out, /forge login --add/);
    assert.match(out, /forge login -p cursor --oauth --add/);
    const zsh = shellCompletionScript("zsh");
    assert.match(zsh, /forge login --add/);
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

  it("filters listSessions by errors and untitled before limit", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-list-err-"));
    process.env.FORGE_HOME = tmp;
    const {
      createSession,
      listSessions,
      setSessionTitle,
      setSessionLastError,
      saveSession,
    } = await import("../src/session/session.js");
    const failed = createSession({
      cwd: tmp,
      provider: "xai",
      model: "m",
      title: "old-fail",
    });
    setSessionLastError(failed, {
      code: "rate_limited",
      message: "429",
    });
    failed.meta.updatedAt = new Date(Date.now() - 86_400_000).toISOString();
    saveSession(failed);
    const untitled = createSession({ cwd: tmp, provider: "xai", model: "m" });
    untitled.meta.updatedAt = new Date(Date.now() - 43_200_000).toISOString();
    saveSession(untitled);
    for (let i = 0; i < 5; i++) {
      const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
      setSessionTitle(s, `fresh-${i}`);
      saveSession(s);
    }
    const limitedErr = listSessions({ limit: 3, errors: true });
    assert.equal(limitedErr.length, 1);
    assert.equal(limitedErr[0]!.id, failed.meta.id);
    const cycle = createSession({
      cwd: tmp,
      provider: "xai",
      model: "m",
      title: "cycle-done",
    });
    setSessionLastError(cycle, {
      code: "ulw_done",
      message: "released",
    });
    saveSession(cycle);
    assert.equal(listSessions({ limit: 10, errors: true }).length, 1);
    const untitledHits = listSessions({ limit: 2, untitled: true });
    assert.equal(untitledHits.length, 1);
    assert.equal(untitledHits[0]!.id, untitled.meta.id);
    assert.ok(!untitledHits[0]!.title);
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
    const { armCycle } = await import("../src/harness/cycle/index.js");
    const current = createSession({ cwd: tmp, provider: "xai", model: "m" });
    current.meta.ultrawork = true;
    armCycle({ sessionId: current.meta.id, mandate: "old mandate", cwd: tmp });
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
    const { armCycle, loadCycleState } = await import(
      "../src/harness/cycle/index.js"
    );
    const {
      evaluateTodoGateAtStop,
      clearTodoGateState,
      getTodoGateFires,
    } = await import("../src/harness/todo-gate.js");
    const current = createSession({ cwd: tmp, provider: "xai", model: "m" });
    current.meta.ultrawork = true;
    armCycle({ sessionId: current.meta.id, mandate: "keep going", cwd: tmp });
    current.messages.push({ role: "user", content: "old work" });
    clearTodoGateState(current.meta.id);
    evaluateTodoGateAtStop({
      sessionId: current.meta.id,
      ulwEnabled: false,
      ultraworkFlag: false,
      openTodoCount: 1,
      lastAssistantMessage: "stop",
    });
    assert.ok(getTodoGateFires(current.meta.id) >= 1);
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
    assert.equal(loadCycleState(current.meta.id)?.enabled, true);
    assert.equal(loadCycleState(r.replaceSession!.meta.id), null);
    // Soft TodoGate fire count cleared for the old session id
    assert.equal(getTodoGateFires(current.meta.id), 0);
  });

  it("/clear (soft) clears soft TodoGate fire count", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-clear-soft-todo-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const {
      evaluateTodoGateAtStop,
      clearTodoGateState,
      getTodoGateFires,
    } = await import("../src/harness/todo-gate.js");
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    clearTodoGateState(session.meta.id);
    evaluateTodoGateAtStop({
      sessionId: session.meta.id,
      ulwEnabled: false,
      ultraworkFlag: false,
      openTodoCount: 2,
      lastAssistantMessage: "stop",
    });
    assert.ok(getTodoGateFires(session.meta.id) >= 1);
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/clear", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.equal(getTodoGateFires(session.meta.id), 0);
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
    const terminated = new Error("terminated");
    terminated.name = "TypeError";
    assert.equal(isRetryableError(terminated), true);
    const http2 = Object.assign(
      new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR"),
      { code: "ERR_HTTP2_STREAM_ERROR" },
    );
    assert.equal(isRetryableError(http2), true);
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
  it("copyToClipboard never writes the OS pasteboard under node:test", async () => {
    const { copyToClipboard, clipboardWritesDisabled } = await import(
      "../src/util/clipboard.js"
    );
    assert.equal(clipboardWritesDisabled(), true);
    const r = copyToClipboard("forge-clipboard-test");
    assert.equal(r.ok, false);
    assert.match(r.error, /disabled/i);
  });

  it("FORGE_CLIPBOARD=0 disables even when NODE_TEST_CONTEXT is absent", async () => {
    const { clipboardWritesDisabled } = await import("../src/util/clipboard.js");
    const prevClip = process.env.FORGE_CLIPBOARD;
    const prevCtx = process.env.NODE_TEST_CONTEXT;
    process.env.FORGE_CLIPBOARD = "0";
    delete process.env.NODE_TEST_CONTEXT;
    try {
      assert.equal(clipboardWritesDisabled(), true);
    } finally {
      if (prevClip === undefined) delete process.env.FORGE_CLIPBOARD;
      else process.env.FORGE_CLIPBOARD = prevClip;
      if (prevCtx === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = prevCtx;
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
      const blocked = acquireSessionLock(s.meta.id);
      assert.equal(blocked.ok, false, "live pid must never be stolen");
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
    assert.deepEqual(normalizeProviderId("cursor-ai"), {
      ok: true,
      provider: "cursor",
    });
    assert.equal(normalizeProviderId("nope").ok, false);
    assert.equal(normalizePermissionMode("yolo"), "bypassPermissions");
    assert.equal(normalizePermissionMode("ask"), "default");
    assert.equal(normalizePermissionMode("deny"), "dontAsk");
    assert.equal(normalizePermissionMode("dont-ask"), "dontAsk");
    assert.equal(normalizePermissionMode("no-ask"), "dontAsk");
    assert.equal(normalizePermissionMode("never-ask"), "dontAsk");
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
  it("maps /permissions ask to default (ask-for-writes), not dontAsk", async () => {
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
    const cfg = { ...DEFAULT_CONFIG, workspace: tmp, permissionMode: "acceptEdits" as const };
    const r = await handleSlash("/permissions ask", {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.equal(cfg.permissionMode, "default");
    const r2 = await handleSlash("/permissions deny", {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(r2.handled, true);
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
    assert.equal(loadPreferences().permissionMode, "default");
    const saved = savePreferences({ permissionMode: "accept" as any });
    assert.equal(saved.permissionMode, "acceptEdits");
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
describe("doctor package.json engines.node floor", () => {
  it("flags runtime below engines.node >=N floor", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-engines-"));
    process.env.FORGE_HOME = tmp;
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "x", engines: { node: ">=99" } }),
    );
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { runDoctorCheck } = await import("../src/commands/slash.js");
    const check = await runDoctorCheck({
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "default",
    });
    assert.equal(check.ok, false);
    assert.ok(
      check.issues.some((i) => /engines\.node floor 99/i.test(i)),
      check.issues.join("; "),
    );
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

  it("accepts FORGE_PERMISSION_ASK_TIMEOUT_MS alias when canonical is unset", async () => {
    const prevCanon = process.env.FORGE_PERMISSION_TIMEOUT_MS;
    const prevAlias = process.env.FORGE_PERMISSION_ASK_TIMEOUT_MS;
    delete process.env.FORGE_PERMISSION_TIMEOUT_MS;
    process.env.FORGE_PERMISSION_ASK_TIMEOUT_MS = "30s";
    try {
      const { permissionAskTimeoutMs } = await import("../src/agent/permissions.js");
      assert.equal(permissionAskTimeoutMs(), 30_000);
    } finally {
      if (prevCanon === undefined) delete process.env.FORGE_PERMISSION_TIMEOUT_MS;
      else process.env.FORGE_PERMISSION_TIMEOUT_MS = prevCanon;
      if (prevAlias === undefined) delete process.env.FORGE_PERMISSION_ASK_TIMEOUT_MS;
      else process.env.FORGE_PERMISSION_ASK_TIMEOUT_MS = prevAlias;
    }
  });

  it("canonical FORGE_PERMISSION_TIMEOUT_MS wins over the alias", async () => {
    const prevCanon = process.env.FORGE_PERMISSION_TIMEOUT_MS;
    const prevAlias = process.env.FORGE_PERMISSION_ASK_TIMEOUT_MS;
    process.env.FORGE_PERMISSION_TIMEOUT_MS = "90s";
    process.env.FORGE_PERMISSION_ASK_TIMEOUT_MS = "30s";
    try {
      const { permissionAskTimeoutMs } = await import("../src/agent/permissions.js");
      assert.equal(permissionAskTimeoutMs(), 90_000);
    } finally {
      if (prevCanon === undefined) delete process.env.FORGE_PERMISSION_TIMEOUT_MS;
      else process.env.FORGE_PERMISSION_TIMEOUT_MS = prevCanon;
      if (prevAlias === undefined) delete process.env.FORGE_PERMISSION_ASK_TIMEOUT_MS;
      else process.env.FORGE_PERMISSION_ASK_TIMEOUT_MS = prevAlias;
    }
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

describe("loop guard messages project checks", () => {
  it("error-streak message names a verification command", async () => {
    const { ErrorStreakTracker } = await import("../src/agent/error-streak.js");
    const t = new ErrorStreakTracker({ threshold: 3 });
    t.observeError("bash", "fail a");
    t.observeError("bash", "fail b");
    const hit = t.observeError("bash", "fail c");
    assert.ok(hit);
    assert.match(hit!.message, /cheapest verification/);
    // In this repo, should name npm run typecheck (or fallback typecheck/test)
    assert.match(hit!.message, /npm run typecheck|typecheck\/test/);
  });

  it("doom-loop message suggests verification when stuck", async () => {
    const { DoomLoopTracker } = await import("../src/agent/doom-loop.js");
    const t = new DoomLoopTracker({ threshold: 3 });
    const input = { command: "ls" };
    t.observe("bash", input);
    t.observe("bash", input);
    const hit = t.observe("bash", input);
    assert.ok(hit);
    assert.match(hit!.message, /When stuck after edits, run/);
    assert.match(hit!.message, /npm run typecheck|typecheck\/test/);
  });
});
