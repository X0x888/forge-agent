/**
 * Regression tests for the 2026-07 comprehensive audit round
 * (grok-4.5 production-readiness: latency, token efficiency, reliability).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeRetryDelayMs } from "../src/util/retry.js";
import { ProviderApiError } from "../src/providers/errors.js";
import { boundToolOutput } from "../src/agent/tools/truncate.js";
import { streamLines, toolRead } from "../src/agent/tools/read.js";
import {
  formatGitStableForPrompt,
  formatGitBranchLine,
  formatGitTreeLine,
  formatGitForPrompt,
} from "../src/util/git-context.js";
import {
  snapshotHarness,
  admitHarnessIfChanged,
  fingerprintSnapshot,
  clearAdmittedFingerprints,
} from "../src/harness/context-admit.js";
import {
  modelContextWindow,
  normalizeModelKey,
} from "../src/config/model-info.js";
import {
  modelSupportsReasoningEffort,
  resolveReasoningEffort,
} from "../src/config/reasoning.js";
import { estimateCostUsd } from "../src/util/format.js";
import { HookRunner } from "../src/harness/hooks.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { loadConfig } from "../src/config/load.js";
import { acquireSessionLock, releaseSessionLock } from "../src/session/lock.js";
import { execCommandSandboxed } from "../src/agent/sandbox.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import type { ChatRequest } from "../src/providers/types.js";
import { handleSlash } from "../src/commands/slash.js";
import { createSession, sessionDir } from "../src/session/session.js";
import type { ToolContext } from "../src/agent/tools/types.js";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "forge-audit-"));

describe("retry: server Retry-After is honored above client maxDelay", () => {
  it("Retry-After: 60 is not clamped to the 12s client cap", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 429,
      body: "rate limited",
      retryAfterMs: 60_000,
    });
    const d = computeRetryDelayMs(err, 0, {});
    assert.equal(d, 60_000);
  });

  it("server hints are still capped at the 120s ceiling", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 429,
      body: "rate limited",
      retryAfterMs: 600_000, // parseRetryAfterMs caps at 120s, but be safe
    });
    assert.equal(computeRetryDelayMs(err, 0, {}), 120_000);
  });

  it("no hint → exponential backoff under maxDelay", () => {
    const err = new ProviderApiError({
      provider: "xai",
      status: 500,
      body: "boom",
    });
    const d = computeRetryDelayMs(err, 1, {});
    assert.ok(d >= 1600 && d <= 12_000);
  });
});

describe("truncate: maxChars branch respects maxBytes (multibyte)", () => {
  it("100k CJK chars is capped to ~50KB, not 240KB", async () => {
    const big = "界".repeat(100_000); // 3 bytes per char in UTF-8
    const out = await boundToolOutput(big, { maxChars: 80_000 });
    assert.equal(out.truncated, true);
    const bytes = Buffer.byteLength(out.text, "utf8");
    // 50KB cap + footer pointer
    assert.ok(
      bytes < 60 * 1024,
      `expected < 60KB with footer, got ${bytes} bytes`,
    );
    assert.match(out.text, /full \d+ bytes/);
  });
});

describe("read_file: streaming path for huge files", () => {
  it("streamLines reads a window without the whole file", async () => {
    const dir = tmpdir();
    const file = path.join(dir, "big.log");
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");

    const r = await streamLines(file, 100, 5);
    assert.deepEqual(r.slice, [
      "line 100",
      "line 101",
      "line 102",
      "line 103",
      "line 104",
    ]);
    assert.equal(r.complete, false); // stopped early, exact total unknown

    const tail = await streamLines(file, 4998, 0);
    assert.deepEqual(tail.slice, ["line 4998", "line 4999", "line 5000"]);
    assert.equal(tail.complete, true);
    assert.equal(tail.seen, 5000);
  });

  it("streamLines survives a single absurdly long line", async () => {
    const dir = tmpdir();
    const file = path.join(dir, "oneline.json");
    const hugeLine = "x".repeat(500_000);
    fs.writeFileSync(file, `head\n${hugeLine}\ntail\n`, "utf8");

    const r = await streamLines(file, 1, 0);
    assert.equal(r.complete, true);
    assert.equal(r.seen, 3);
    assert.equal(r.slice[0], "head");
    assert.ok(r.slice[1]!.length < 3000);
    assert.match(r.slice[1]!, /truncated/);
    assert.equal(r.slice[2], "tail");
  });

  it("toolRead streams a >2MB file instead of loading it whole", async () => {
    const dir = tmpdir();
    const file = path.join(dir, "huge.txt");
    const chunk = "0123456789abcdef\n".repeat(200_000); // ~3.4MB
    fs.writeFileSync(file, chunk, "utf8");
    const ctx = { workspace: dir } as ToolContext;
    const r = await toolRead({ path: "huge.txt", offset: 1, limit: 3 }, ctx);
    assert.equal(r.isError ?? false, false);
    assert.match(r.output, /showing 1-3/);
    assert.match(r.output, /prefer smaller limit\/offset or grep/);
    const past = await toolRead(
      { path: "huge.txt", offset: 999_999_999, limit: 5 },
      ctx,
    );
    assert.match(past.output, /past end of file/);
  });
});

describe("git context: stable system prefix + volatile branch admission", () => {
  const snap = {
    root: "/repo",
    branch: "main",
    dirty: true,
    changedFiles: 7,
    remote: "git@github.com:x/y.git",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
  };

  it("stable formatter excludes branch/dirty/ahead (cache-safe message[0])", () => {
    const s = formatGitStableForPrompt(snap);
    assert.match(s, /Git root: \/repo/);
    assert.match(s, /Remote:/);
    assert.ok(!s.includes("main"));
    assert.ok(!/dirty|ahead|behind/.test(s));
  });

  it("branch line excludes dirty counts (no per-edit churn)", () => {
    const s = formatGitBranchLine(snap);
    assert.match(s, /^Branch: main/);
    assert.match(s, /ahead 2/);
    assert.match(s, /behind 1/);
    assert.match(s, /→ origin\/main/);
    assert.ok(!/dirty|7 files/.test(s));
  });

  it("tree line reports coarse dirty/clean (count is display-only)", () => {
    assert.equal(
      formatGitTreeLine(snap),
      "Working tree: dirty (7 files)",
    );
    assert.equal(
      formatGitTreeLine({ ...snap, dirty: false, changedFiles: 0 }),
      "Working tree: clean",
    );
    assert.equal(formatGitTreeLine({ dirty: true, changedFiles: 3 }), "");
  });

  it("legacy full formatter unchanged for banners", () => {
    const s = formatGitForPrompt(snap);
    assert.match(s, /dirty, 7 files/);
    assert.match(s, /Branch: main/);
  });
});

describe("context-admit: git branch travels with harness admissions", () => {
  beforeEach(() => clearAdmittedFingerprints());
  afterEach(() => clearAdmittedFingerprints());

  const baseSnap = {
    ulw: null,
    goal: null,
    todos: [],
    permissionMode: "default",
  };

  it("first idle admit surfaces the branch line once, then stays silent", () => {
    const snap = snapshotHarness({
      ...baseSnap,
      git: { root: "/r", branch: "main" },
    });
    const msg = admitHarnessIfChanged("s-git", snap);
    assert.ok(msg);
    assert.match(msg!, /Branch: main/);
    assert.match(msg!, /Working tree: clean/);
    // Unchanged → no second message
    assert.equal(admitHarnessIfChanged("s-git", snap), null);
  });

  it("dirty flip re-admits; file-count churn does not", () => {
    const clean = snapshotHarness({
      ...baseSnap,
      git: { root: "/r", branch: "main", dirty: false },
    });
    admitHarnessIfChanged("s-tree", clean);
    const dirty1 = snapshotHarness({
      ...baseSnap,
      git: { root: "/r", branch: "main", dirty: true, changedFiles: 1 },
    });
    const flip = admitHarnessIfChanged("s-tree", dirty1);
    assert.ok(flip);
    assert.match(flip!, /Working tree: dirty \(1 file\)/);
    const dirty7 = snapshotHarness({
      ...baseSnap,
      git: { root: "/r", branch: "main", dirty: true, changedFiles: 7 },
    });
    assert.equal(admitHarnessIfChanged("s-tree", dirty7), null);
    assert.equal(fingerprintSnapshot(dirty1), fingerprintSnapshot(dirty7));
  });

  it("branch switch earns a fresh admission even with counters suppressed", () => {
    const s1 = snapshotHarness({ ...baseSnap, git: { root: "/r", branch: "main" } });
    admitHarnessIfChanged("s-sw", s1);
    const s2 = snapshotHarness({
      ...baseSnap,
      git: { root: "/r", branch: "feature/x" },
    });
    const msg = admitHarnessIfChanged("s-sw", s2, {
      suppressCounterOnlyChanges: true,
    });
    assert.ok(msg);
    assert.match(msg!, /feature\/x/);
  });

  it("fingerprint includes gitBranch", () => {
    const a = snapshotHarness({ ...baseSnap, git: { root: "/r", branch: "a" } });
    const b = snapshotHarness({ ...baseSnap, git: { root: "/r", branch: "b" } });
    assert.notEqual(fingerprintSnapshot(a), fingerprintSnapshot(b));
  });

  it("non-git workspace stays silent on idle first admit", () => {
    const snap = snapshotHarness({ ...baseSnap, git: {} });
    assert.equal(admitHarnessIfChanged("s-nogit", snap), null);
  });
});

describe("model-info + reasoning: windows and effort aliases", () => {
  it("context windows match the real models", () => {
    assert.equal(modelContextWindow("grok-4.5"), 500_000);
    assert.equal(modelContextWindow("grok-4.6"), 500_000);
    assert.equal(modelContextWindow("grok-4.7"), 500_000);
    assert.equal(modelContextWindow("grok-4"), 256_000);
    assert.equal(modelContextWindow("grok-3"), 131_072);
    assert.equal(modelContextWindow("claude-sonnet-4-20250514"), 200_000);
    assert.equal(modelContextWindow("claude-fable-5"), 1_000_000);
    assert.equal(modelContextWindow("claude-fable-5-thinking-high"), 1_000_000);
    assert.equal(modelContextWindow("gpt-4.1"), 1_000_000);
    assert.equal(modelContextWindow("gpt-4o"), 128_000);
    assert.equal(modelContextWindow("x-ai/grok-4.5"), 500_000);
    assert.equal(modelContextWindow("x-ai/grok-4.6"), 500_000);
    assert.equal(modelContextWindow("totally-unknown-9"), undefined);
  });

  it("normalizeModelKey strips prefixes and alias suffixes", () => {
    assert.equal(normalizeModelKey("x-ai/grok-4.5-latest"), "grok-4.5");
    assert.equal(normalizeModelKey("GROK-4.5"), "grok-4.5");
  });

  it("grok-4.5-latest keeps reasoning effort support", () => {
    assert.equal(modelSupportsReasoningEffort("grok-4.5-latest"), true);
    assert.equal(resolveReasoningEffort("grok-4.5-latest", undefined), "high");
    assert.equal(resolveReasoningEffort("grok-4.5-latest", "low"), "low");
  });

  it("grok-4.6-latest defaults to xhigh", () => {
    assert.equal(modelSupportsReasoningEffort("grok-4.6-latest"), true);
    assert.equal(resolveReasoningEffort("grok-4.6-latest", undefined), "xhigh");
  });
});

describe("cost estimates: grok-4.6 rates, not grok-4 rates", () => {
  it("xai default prices grok-4.6 ($2/$6)", () => {
    assert.equal(estimateCostUsd("xai", 1_000_000, 100_000), 2 + 0.6);
  });
  it("cursor native quota is $0", () => {
    assert.equal(estimateCostUsd("cursor", 1_000_000, 100_000, "composer-2.5"), 0);
  });
  it("grok-4 override keeps $3/$15", () => {
    assert.equal(
      estimateCostUsd("xai", 1_000_000, 1_000_000, "grok-4"),
      3 + 15,
    );
  });
  it("grok-3-mini prices cheap", () => {
    const c = estimateCostUsd("xai", 1_000_000, 1_000_000, "grok-3-mini");
    assert.ok(Math.abs(c - 0.8) < 1e-9);
  });
});

describe("cost estimates: cache-aware pricing", () => {
  it("deepseek flash: 90% cache-hit input is dramatically cheaper", () => {
    // 1M prompt with 900k cache hits: 100k×0.14 + 900k×0.0028 (+0.28 out)
    const c = estimateCostUsd(
      "deepseek",
      1_000_000,
      1_000_000,
      "deepseek-v4-flash",
      900_000,
    );
    assert.ok(Math.abs(c - (0.1 * 0.14 + 0.9 * 0.0028 + 0.28)) < 1e-9);
  });
  it("no cache tokens → identical to legacy full-rate estimate", () => {
    assert.equal(
      estimateCostUsd("deepseek", 1_000_000, 1_000_000, "deepseek-v4-flash"),
      estimateCostUsd("deepseek", 1_000_000, 1_000_000, "deepseek-v4-flash", 0),
    );
  });
  it("models without a cache rate price cached input at full rate (safe)", () => {
    // grok-3 has no cacheIn — cacheReadTokens must not lower the estimate.
    assert.equal(
      estimateCostUsd("xai", 1_000_000, 0, "grok-3", 500_000),
      estimateCostUsd("xai", 1_000_000, 0, "grok-3"),
    );
  });
  it("deepseek-v4-pro uses current official rates ($0.435/$0.87)", () => {
    const c = estimateCostUsd("deepseek", 1_000_000, 1_000_000, "deepseek-v4-pro");
    assert.ok(Math.abs(c - (0.435 + 0.87)) < 1e-9);
  });
  it("cacheReadTokens is clamped to promptTokens", () => {
    const c = estimateCostUsd("xai", 100, 0, "grok-4.5", 999_999);
    assert.ok(Math.abs(c - (100 * 0.5) / 1_000_000) < 1e-12);
  });
});

describe("hooks: crashed Stop hooks fail closed", () => {
  function writeStopHook(dir: string, command: string) {
    fs.mkdirSync(path.join(dir, ".forge", "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".forge", "hooks", "stop.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 5 }] }] },
      }),
      "utf8",
    );
  }

  it("non-zero exit blocks (was silent allow)", async () => {
    const tmp = tmpdir();
    process.env.FORGE_HOME = path.join(tmp, "home");
    writeStopHook(tmp, "exit 1");
    const runner = new HookRunner(
      { ...DEFAULT_CONFIG, blockingStopHooks: true, compatClaudeHooks: false, compatCursorHooks: false },
      tmp,
    );
    const r = await runner.run("Stop", {
      sessionId: "s",
      cwd: tmp,
      workspaceRoot: tmp,
    });
    assert.equal(r.blocked, true);
    assert.equal(r.decision, "block");
    assert.match(String(r.reason), /exit code 1|fail-closed/i);
  });

  it("clean exit 0 still allows", async () => {
    const tmp = tmpdir();
    process.env.FORGE_HOME = path.join(tmp, "home");
    writeStopHook(tmp, "exit 0");
    const runner = new HookRunner(
      { ...DEFAULT_CONFIG, blockingStopHooks: true, compatClaudeHooks: false, compatCursorHooks: false },
      tmp,
    );
    const r = await runner.run("Stop", {
      sessionId: "s",
      cwd: tmp,
      workspaceRoot: tmp,
    });
    assert.equal(r.blocked, false);
  });

  it("non-Stop events stay fail-open on non-zero exit", async () => {
    const tmp = tmpdir();
    process.env.FORGE_HOME = path.join(tmp, "home");
    fs.mkdirSync(path.join(tmp, ".forge", "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".forge", "hooks", "pre.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "exit 1", timeout: 5 }] }],
        },
      }),
      "utf8",
    );
    const runner = new HookRunner(
      { ...DEFAULT_CONFIG, blockingStopHooks: true, compatClaudeHooks: false, compatCursorHooks: false },
      tmp,
    );
    const r = await runner.run("PreToolUse", {
      sessionId: "s",
      cwd: tmp,
      workspaceRoot: tmp,
      toolName: "bash",
      toolInput: { command: "echo hi" },
    });
    assert.equal(r.blocked, false);
    assert.equal(r.decision, "allow");
  });

  it("blockingStopHooks=false keeps fail-open on crash", async () => {
    const tmp = tmpdir();
    process.env.FORGE_HOME = path.join(tmp, "home");
    writeStopHook(tmp, "exit 1");
    const runner = new HookRunner(
      { ...DEFAULT_CONFIG, blockingStopHooks: false, compatClaudeHooks: false, compatCursorHooks: false },
      tmp,
    );
    const r = await runner.run("Stop", {
      sessionId: "s",
      cwd: tmp,
      workspaceRoot: tmp,
    });
    assert.equal(r.blocked, false);
  });

  it("hook that closes stdin early does not crash the process (EPIPE)", async () => {
    const tmp = tmpdir();
    process.env.FORGE_HOME = path.join(tmp, "home");
    writeStopHook(tmp, "exit 0"); // exits immediately without reading stdin
    const runner = new HookRunner(
      { ...DEFAULT_CONFIG, blockingStopHooks: true, compatClaudeHooks: false, compatCursorHooks: false },
      tmp,
    );
    const r = await runner.run("Stop", {
      sessionId: "s",
      cwd: tmp,
      workspaceRoot: tmp,
      // Large payload — used to EPIPE-crash the CLI on macOS (16KB pipe).
      lastAssistantMessage: "y".repeat(200_000),
    });
    assert.equal(r.blocked, false);
  });

  it("HTTP Stop hook failure fails closed", async () => {
    const tmp = tmpdir();
    process.env.FORGE_HOME = path.join(tmp, "home");
    fs.mkdirSync(path.join(tmp, ".forge", "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".forge", "hooks", "stop.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                // Port 1 is reliably closed — connection refused
                { type: "http", url: "http://127.0.0.1:1/hook", timeout: 2 },
              ],
            },
          ],
        },
      }),
      "utf8",
    );
    const runner = new HookRunner(
      { ...DEFAULT_CONFIG, blockingStopHooks: true, compatClaudeHooks: false, compatCursorHooks: false },
      tmp,
    );
    const r = await runner.run("Stop", {
      sessionId: "s",
      cwd: tmp,
      workspaceRoot: tmp,
    });
    assert.equal(r.blocked, true);
    assert.equal(r.decision, "block");
  });
});

describe("session lock: atomic create + steal semantics", () => {
  it("acquire → foreign live holder blocked, dead holder stolen", () => {
    const home = tmpdir();
    process.env.FORGE_HOME = home;
    const sid = `lock-${Date.now()}`;
    const first = acquireSessionLock(sid);
    assert.equal(first.ok, true);
    assert.equal(first.owned, true);

    // Same process re-acquire = refresh, still owned
    const again = acquireSessionLock(sid);
    assert.equal(again.ok, true);

    // Simulate a foreign live holder (pid 1 is always alive)
    const dir = sessionDir(sid);
    fs.writeFileSync(
      path.join(dir, "session.lock"),
      JSON.stringify({
        pid: 1,
        hostname: "other",
        acquiredAt: new Date().toISOString(),
        sessionId: sid,
      }),
      { mode: 0o600 },
    );
    const blocked = acquireSessionLock(sid);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.holder?.pid, 1);

    // Dead foreign pid → stolen
    fs.writeFileSync(
      path.join(dir, "session.lock"),
      JSON.stringify({
        pid: 999_999_999,
        hostname: "other",
        acquiredAt: new Date().toISOString(),
        sessionId: sid,
      }),
      { mode: 0o600 },
    );
    const stolen = acquireSessionLock(sid);
    assert.equal(stolen.ok, true);
    assert.equal(stolen.stolen, true);

    releaseSessionLock(sid);
  });

  it("corrupt lock file recovers instead of looping", () => {
    const home = tmpdir();
    process.env.FORGE_HOME = home;
    const sid = `lock-corrupt-${Date.now()}`;
    const dir = sessionDir(sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "session.lock"), "{{{not json", {
      mode: 0o600,
    });
    const r = acquireSessionLock(sid);
    assert.equal(r.ok, true);
    assert.equal(r.owned, true);
    releaseSessionLock(sid);
  });
});

// sessionDir is exported from session.js; imported at top.

describe("sandbox: runaway output is capped, not OOM", () => {
  it("profile=off caps stdout at 4MB and kills the child", async () => {
    const r = await execCommandSandboxed({
      command: `node -e "process.stdout.write('x'.repeat(6_000_000))"`,
      cwd: os.tmpdir(),
      timeoutMs: 30_000,
      profile: "off",
    });
    assert.ok(r.stdout.length <= 4 * 1024 * 1024 + 16);
    assert.match(r.stderr, /Output exceeded/);
  });
});

describe("anthropic: rolling history cache breakpoint", () => {
  let prevFetch: typeof globalThis.fetch;
  let prevEnv: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastBody: any;

  beforeEach(() => {
    prevFetch = globalThis.fetch;
    prevEnv = process.env.FORGE_ANTHROPIC_CACHE;
    delete process.env.FORGE_ANTHROPIC_CACHE;
    lastBody = undefined;
  });
  afterEach(() => {
    globalThis.fetch = prevFetch;
    if (prevEnv === undefined) delete process.env.FORGE_ANTHROPIC_CACHE;
    else process.env.FORGE_ANTHROPIC_CACHE = prevEnv;
  });

  const req: ChatRequest = {
    model: "claude-sonnet-4-5",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ],
    tools: [
      {
        type: "function",
        function: { name: "t", description: "d", parameters: { type: "object" } },
      },
    ],
  };

  it("last message carries cache_control; earlier messages do not", async () => {
    globalThis.fetch = (async (_url, init) => {
      lastBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "m",
          model: "c",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const p = new AnthropicProvider({ apiKey: "k" });
    await p.chat(req);

    const msgs = lastBody.messages as Array<{
      role: string;
      content: unknown;
    }>;
    assert.equal(msgs.length, 3);
    // earlier messages untouched (block form, no cache_control)
    assert.deepEqual(msgs[0]!.content, [{ type: "text", text: "one" }]);
    assert.equal(
      JSON.stringify(msgs[1]).includes("cache_control"),
      false,
    );
    // last message wrapped into a cached text block
    const last = msgs[2]!.content as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(last));
    assert.deepEqual(last[last.length - 1]!.cache_control, {
      type: "ephemeral",
    });
  });

  it("FORGE_ANTHROPIC_CACHE=0 leaves messages untouched", async () => {
    process.env.FORGE_ANTHROPIC_CACHE = "0";
    globalThis.fetch = (async (_url, init) => {
      lastBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "m",
          model: "c",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const p = new AnthropicProvider({ apiKey: "k" });
    await p.chat(req);
    assert.ok(!JSON.stringify(lastBody).includes("cache_control"));
  });
});

describe("config: per-model context window derivation", () => {
  it("FORGE_MODEL=grok-3 derives a 131k window when not explicit", () => {
    const home = tmpdir();
    process.env.FORGE_HOME = home;
    const prev = process.env.FORGE_MODEL;
    process.env.FORGE_MODEL = "grok-3";
    try {
      const cfg = loadConfig({}, tmpdir());
      assert.equal(cfg.model, "grok-3");
      assert.equal(cfg.contextWindow, 131_072);
      assert.equal(cfg.contextWindowExplicit, false);
    } finally {
      if (prev === undefined) delete process.env.FORGE_MODEL;
      else process.env.FORGE_MODEL = prev;
    }
  });

  it("explicit context_window in config.toml wins over the model default", () => {
    const home = tmpdir();
    process.env.FORGE_HOME = home;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "config.toml"),
      'model = "grok-3"\ncontext_window = 64000\n',
      "utf8",
    );
    const cfg = loadConfig({}, tmpdir());
    assert.equal(cfg.contextWindow, 64_000);
    assert.equal(cfg.contextWindowExplicit, true);
  });

  it("default model keeps the 500k default", () => {
    const home = tmpdir();
    process.env.FORGE_HOME = home;
    const prev = process.env.FORGE_MODEL;
    delete process.env.FORGE_MODEL;
    try {
      const cfg = loadConfig({}, tmpdir());
      assert.equal(cfg.model, "grok-4.6");
      assert.equal(cfg.contextWindow, 500_000);
    } finally {
      if (prev !== undefined) process.env.FORGE_MODEL = prev;
    }
  });

  it("/model grok-3 re-derives the window; /model grok-4.5 keeps 500k", async () => {
    const home = tmpdir();
    process.env.FORGE_HOME = home;
    const ws = tmpdir();
    const config = { ...DEFAULT_CONFIG, workspace: ws };
    const session = createSession({ cwd: ws, provider: "xai", model: "grok-4.5" });
    const hooks = new HookRunner(config, ws);
    const r = await handleSlash("/model grok-3", { session, config, hooks });
    assert.equal(config.model, "grok-3");
    assert.equal(config.contextWindow, 131_072);
    assert.match(r.output || "", /ctx 131\.1k/);
  });
});

describe("servedModelDiverged: provider tier routing made visible", () => {
  it("same model and alias/snapshot forms never diverge", async () => {
    const { servedModelDiverged } = await import(
      "../src/config/model-info.js"
    );
    assert.equal(servedModelDiverged("deepseek-v4-flash", "deepseek-v4-flash"), false);
    assert.equal(
      servedModelDiverged("deepseek-v4-flash", "deepseek/deepseek-v4-flash"),
      false,
    );
    assert.equal(
      servedModelDiverged("deepseek-v4-flash", "deepseek-v4-flash-0731"),
      false,
    );
    assert.equal(servedModelDiverged("grok-4.5", "grok-4.5-latest"), false);
  });
  it("a different served tier diverges (the flash→pro billing case)", async () => {
    const { servedModelDiverged } = await import(
      "../src/config/model-info.js"
    );
    assert.equal(
      servedModelDiverged("deepseek-v4-flash", "deepseek-v4-pro"),
      true,
    );
    assert.equal(servedModelDiverged("grok-4.5", "grok-4"), true);
  });
  it("empty/unknown served ids never diverge", async () => {
    const { servedModelDiverged } = await import(
      "../src/config/model-info.js"
    );
    assert.equal(servedModelDiverged("deepseek-v4-flash", undefined), false);
    assert.equal(servedModelDiverged("deepseek-v4-flash", ""), false);
  });
});
