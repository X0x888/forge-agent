import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession, saveSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import {
  sessionToSnapshot,
  collectSnapshots,
} from "../src/statusline/snapshot.js";
import {
  renderHud,
  renderTmux,
  renderCompactStrip,
  snapshotsToJson,
} from "../src/statusline/render.js";
import {
  heartbeatSession,
  computeLiveness,
  releaseSession,
} from "../src/statusline/active.js";
import {
  beginTurn,
  endTurn,
  setPhase,
  _resetActivityForTests,
} from "../src/statusline/activity.js";
import { collectPlanUsage } from "../src/statusline/plan.js";
import {
  startBackgroundTask,
  _resetTasksForTests,
  listTasks,
} from "../src/agent/tools/background-tasks.js";
import {
  buildPromptFlags,
  renderTurnFooter,
  formatSessionDetails,
  renderLiveRunHeader,
  formatBackgroundTasksList,
  createWorkingIndicator,
} from "../src/tui/status-bar.js";
import { clipAnsi, visibleWidth } from "../src/util/format.js";
import type { ForgeConfig } from "../src/config/types.js";
import type { ResolvedAuth } from "../src/auth/types.js";
import { armUlwCycle } from "../src/harness/ulw-cycle.js";

describe("statusline", () => {
  beforeEach(() => {
    _resetActivityForTests();
    _resetTasksForTests();
  });

  it("builds snapshot and renders without plan inventing numbers", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "anthropic", model: "claude-sonnet-4" });
    s.messages.push({ role: "user", content: "hello world ".repeat(50) });
    s.meta.totalPromptTokens = 1200;
    s.meta.totalCompletionTokens = 400;
    s.meta.ultrawork = true;
    saveSession(s);

    const snap = sessionToSnapshot(s, {
      windowTokens: 100_000,
      authMethod: "api_key",
      authLabel: "env:ANTHROPIC_API_KEY",
    });
    assert.equal(snap.provider, "anthropic");
    assert.ok(snap.context.percent >= 0);
    assert.equal(snap.tokens.totalTokens, 1600);
    assert.ok(snap.tags.includes("ULW"));

    const hud = renderHud([snap], { plain: true, width: 120 });
    assert.match(hud, /anthropic/);
    assert.match(hud, /ctx:|█|░|%/i);
    assert.match(hud, /tok:/);

    const tmux = renderTmux(snap);
    assert.match(tmux, /forge/);
    assert.match(tmux, /ctx:/);

    const strip = renderCompactStrip(snap, { plain: true, width: 100 });
    assert.match(strip, /%/);

    const j = JSON.parse(snapshotsToJson([snap]));
    assert.equal(j.ok, true);
    assert.ok(typeof j.version === "string" && j.version.length > 0);
    assert.equal(j.count, 1);
    assert.equal(j.sessions.length, 1);
  });

  it("surfaces foreign live session locks in snapshot + HUD", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-lock-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    saveSession(s);
    const { acquireSessionLock, releaseSessionLock } = await import(
      "../src/session/lock.js"
    );
    // Simulate another process holding the lock
    const lockPath = path.join(tmp, "sessions", s.meta.id, "session.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid + 99999,
        hostname: "other-host",
        acquiredAt: new Date().toISOString(),
        sessionId: s.meta.id,
      }) + "\n",
    );
    // pidAlive will be false for fake pid — force alive by using our pid but
    // mark as foreign via hostname only works if pid differs; use dead pid → no LOCK tag.
    // Instead acquire for real then rewrite pid field to a live foreign pid is hard.
    // Use acquire (mine) then assert lock.mine; then write foreign dead lock for tag absence.
    releaseSessionLock(s.meta.id);
    const mine = acquireSessionLock(s.meta.id);
    assert.equal(mine.ok, true);
    let snap = sessionToSnapshot(s, { authMethod: "api_key" });
    assert.ok(snap.lock);
    assert.equal(snap.lock!.mine, true);
    assert.equal(snap.lock!.pid, process.pid);
    releaseSessionLock(s.meta.id);

    // Foreign lock with current pid on different "logical" holder: use pid 1 if alive
    const foreignPid = 1;
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: foreignPid,
        hostname: "ci-runner",
        acquiredAt: new Date().toISOString(),
        sessionId: s.meta.id,
      }) + "\n",
    );
    snap = sessionToSnapshot(s, { authMethod: "api_key" });
    assert.ok(snap.lock);
    assert.equal(snap.lock!.mine, false);
    if (snap.lock!.alive) {
      assert.ok(snap.tags.some((t) => t.startsWith("LOCK:")));
      const hud = renderHud([snap], { plain: true, width: 140 });
      assert.match(hud, /LOCK:|lock:pid/i);
      const strip = renderCompactStrip(snap, { plain: true, width: 120 });
      assert.match(strip, /LOCK:/);
    }
  });

  it("tracks live heartbeat", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl2-"));
    process.env.FORGE_HOME = tmp;
    heartbeatSession({
      sessionId: "abc-123",
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
    });
    const { liveness } = computeLiveness("abc-123", new Date().toISOString());
    assert.equal(liveness, "live");
    releaseSession("abc-123");
  });

  it("reports working when busy heartbeat is set", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-work-"));
    process.env.FORGE_HOME = tmp;
    heartbeatSession({
      sessionId: "work-1",
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
      busy: true,
      phase: "thinking",
    });
    const { liveness } = computeLiveness("work-1", new Date().toISOString());
    assert.equal(liveness, "working");
    releaseSession("work-1");
  });

  it("snapshot includes activity when mid-turn in this process", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-act-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    saveSession(s);
    heartbeatSession({
      sessionId: s.meta.id,
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
    });
    beginTurn();
    setPhase("tool", "bash npm test");
    const snap = sessionToSnapshot(s, { authMethod: "api_key" });
    assert.ok(snap.activity?.busy);
    assert.equal(snap.activity?.phase, "tool");
    assert.match(snap.activity?.detail || "", /bash/);
    assert.equal(snap.liveness, "working");

    const hud = renderHud([snap], { plain: true, width: 120 });
    assert.match(hud, /tool:|thinking|working/i);

    endTurn();
    releaseSession(s.meta.id);
  });

  it("renders background tasks in HUD", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-bg-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    saveSession(s);
    heartbeatSession({
      sessionId: s.meta.id,
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
    });

    const started = await startBackgroundTask({
      command: "sleep 30",
      cwd: tmp,
      profile: "off",
      missingBackend: "fallback",
    });
    assert.equal(started.ok, true);
    assert.ok(listTasks().some((t) => t.status === "running"));

    const snap = sessionToSnapshot(s, { authMethod: "api_key" });
    assert.ok((snap.activity?.bgRunning ?? 0) >= 1);
    assert.ok(snap.backgroundTasks?.some((t) => t.status === "running"));

    const hud = renderHud([snap], { plain: true, width: 120 });
    assert.match(hud, /bg:|sleep/);

    const list = formatBackgroundTasksList();
    assert.match(list, /sleep|running/i);

    _resetTasksForTests();
    endTurn();
    releaseSession(s.meta.id);
  });

  it("prompt flags and turn footer surface session health", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-prompt-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    s.meta.ultrawork = true;
    s.meta.totalPromptTokens = 500;
    s.meta.totalCompletionTokens = 100;
    s.todos = [
      { id: "1", content: "ship", status: "in_progress" },
    ];
    saveSession(s);

    armUlwCycle(s.meta.id, "improve", { cycle: 1 });

    const config = {
      provider: "xai",
      model: "grok-4",
      contextWindow: 128_000,
      permissionMode: "default",
      blockingStopHooks: true,
    } as ForgeConfig;
    const auth = {
      provider: "xai",
      method: "api_key",
      token: "test",
    } as ResolvedAuth;

    const prevCols = process.stdout.columns;
    // Wide enough that footer clipping does not drop ULW controls / verify tips.
    Object.defineProperty(process.stdout, "columns", {
      value: 200,
      configurable: true,
    });
    try {
      const flags = buildPromptFlags({ config, session: s, auth });
      assert.match(flags, /ULW/);
      assert.match(flags, /c=1/);
      assert.match(flags, /w=0/);
      // No last-verify yet → no bare ✓ flag
      assert.doesNotMatch(flags.replace(/\x1b\[[0-9;]*m/g, ""), /✓/);

      const footer = renderTurnFooter(
        { config, session: s, auth },
        { promptTokens: 100, completionTokens: 50, stopContinues: 1 },
      );
      assert.match(footer, /ctx/);
      assert.match(footer, /todos:1/);
      assert.match(footer, /harness/);
      assert.match(footer, /ULW c=1 w=0/);
      assert.match(footer, /\/cycle 0/);

      // After edits, footer surfaces cheapest project check (when package.json exists).
      fs.writeFileSync(
        path.join(tmp, "package.json"),
        JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
      );
      fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}");
      s.meta.editCount = 2;
      s.meta.cwd = tmp;
      const footer2 = renderTurnFooter(
        {
          config: { ...config, workspace: tmp },
          session: s,
          auth,
        },
        { promptTokens: 100, completionTokens: 50 },
      );
      // Strip ANSI for assertion (chalk may wrap the check tip).
      const plain = footer2.replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(plain, /✓ npm run typecheck|✓ npm test/);

      // When a structural check was recorded, prefer last✓ over preferred tip.
      s.meta.lastVerificationCommand = "npm test";
      s.meta.lastVerificationAt = "2026-04-10T12:34:56.000Z";
      const flags2 = buildPromptFlags({ config, session: s, auth });
      assert.match(flags2.replace(/\x1b\[[0-9;]*m/g, ""), /✓/);
      const footer3 = renderTurnFooter(
        {
          config: { ...config, workspace: tmp },
          session: s,
          auth,
        },
        { promptTokens: 100, completionTokens: 50 },
      );
      const plain3 = footer3.replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(plain3, /last✓ npm test/);
    } finally {
      Object.defineProperty(process.stdout, "columns", {
        value: prevCols,
        configurable: true,
      });
    }
  });

  it("plan adapter is honest for api_key and copilot", async () => {
    const api = await collectPlanUsage({ provider: "anthropic", authMethod: "api_key" });
    assert.ok(api?.note);
    assert.equal(api?.percent, undefined);

    const copilot = await collectPlanUsage({
      provider: "copilot",
      authMethod: "subscription",
    });
    assert.ok(copilot?.note?.toLowerCase().includes("quota") || copilot?.product);
    assert.equal(copilot?.percent, undefined);
  });

  it("hides N/A plan noise in render", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl3-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "openai", model: "gpt-4.1" });
    const snap = sessionToSnapshot(s, { authMethod: "api_key" });
    snap.plan = {
      source: "openai:api_key",
      note: "API key — billed per token; see session cost estimate",
      product: "OpenAI API",
    };
    const hud = renderHud([snap], { plain: true, width: 100 });
    assert.doesNotMatch(hud, /billed per token/);
  });

  it("working indicator pause is refcounted", () => {
    const w = createWorkingIndicator();
    w.start();
    assert.equal(w.pauseDepth(), 0);
    w.pause();
    w.pause();
    assert.equal(w.pauseDepth(), 2);
    w.resume();
    assert.equal(w.pauseDepth(), 1);
    w.resume();
    assert.equal(w.pauseDepth(), 0);
    w.stop();

    const colored = "\x1b[32mhello\x1b[0m world";
    assert.equal(visibleWidth(colored), "hello world".length);
    const clipped = clipAnsi(colored, 5);
    assert.ok(visibleWidth(clipped) <= 5);
  });

  it("parallel tool hold stays until all pending settle", () => {
    // Mirrors REPL contract: pendingTools++ on phase tool, -- on settled
    const w = createWorkingIndicator();
    w.start();
    let pending = 0;
    let toolHold = false;
    const setToolHold = (on: boolean) => {
      if (on && !toolHold) {
        w.pause();
        toolHold = true;
      } else if (!on && toolHold) {
        w.resume();
        toolHold = false;
      }
    };
    const onPhaseTool = () => {
      pending += 1;
      setToolHold(true);
    };
    const onSettled = () => {
      pending = Math.max(0, pending - 1);
      if (pending === 0) setToolHold(false);
    };

    // A and B enter tool phase (A still in permission)
    onPhaseTool();
    onPhaseTool();
    assert.equal(pending, 2);
    assert.equal(w.pauseDepth(), 1);
    // B finishes while A still waiting
    onSettled();
    assert.equal(pending, 1);
    assert.equal(w.pauseDepth(), 1); // still held for A
    // A finishes
    onSettled();
    assert.equal(pending, 0);
    assert.equal(w.pauseDepth(), 0);
    w.stop();
  });

  it("collectSnapshots --cwd uses native listSessions filter before limit", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-cwd-"));
    process.env.FORGE_HOME = tmp;
    const a = path.join(tmp, "proj-a");
    const b = path.join(tmp, "proj-b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    // Flood other workspace so a post-limit filter would miss proj-a
    for (let i = 0; i < 25; i++) {
      createSession({ cwd: b, provider: "xai", model: "m" });
    }
    const target = createSession({ cwd: a, provider: "xai", model: "m" });
    target.meta.title = "status-cwd-hit";
    saveSession(target);

    const snaps = await collectSnapshots({
      cwd: a,
      all: true,
      fetchPlan: false,
    });
    assert.ok(snaps.length >= 1);
    assert.ok(
      snaps.every((s) => path.resolve(s.cwd) === path.resolve(a)),
      "all snapshots should be for cwd filter",
    );
    assert.ok(
      snaps.some((s) => s.sessionId === target.meta.id),
      "same-cwd session must not be starved by other workspaces",
    );
  });
});

describe("statusline PIN badge", () => {
  it("tags pinned sessions with PIN", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-pin-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, saveSession, setSessionPinned } = await import(
      "../src/session/session.js"
    );
    const { collectSnapshots } = await import("../src/statusline/snapshot.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    setSessionPinned(s, true);
    saveSession(s);
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const snaps = await collectSnapshots({
      sessionId: s.meta.id,
      fetchPlan: false,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
    });
    assert.equal(snaps.length, 1);
    assert.ok(snaps[0]!.tags.includes("PIN"), String(snaps[0]!.tags));
    assert.equal(snaps[0]!.pinned, true);
  });
});

describe("statusline lastError snapshot", () => {
  it("sessionToSnapshot includes lastError and ERR tag", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-lasterr-"));
    process.env.FORGE_HOME = tmp;
    const { sessionToSnapshot } = await import("../src/statusline/snapshot.js");
    const { setSessionLastError, saveSession } = await import(
      "../src/session/session.js"
    );
    const { renderTmux, renderCompactStrip, renderHud } = await import(
      "../src/statusline/render.js"
    );
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    setSessionLastError(s, {
      code: "rate_limited",
      message: "xai HTTP 429",
      tips: ["forge accounts switch"],
    });
    saveSession(s);
    const snap = sessionToSnapshot(s, { authMethod: "api_key" });
    assert.ok(snap.lastError);
    assert.equal(snap.lastError!.code, "rate_limited");
    assert.match(snap.lastError!.message, /429/);
    assert.ok(snap.tags.some((t) => t.startsWith("ERR:")));
    assert.match(renderTmux(snap), /ERR:rate_limited/);
    assert.match(renderCompactStrip(snap, { plain: true }), /ERR:rate_limited/);
    assert.match(renderHud([snap], { plain: true, width: 120 }), /ERR:rate_limited/);
  });
});

describe("statusline plan mode details", () => {
  it("formatSessionDetails tips /build under plan", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-plan-"));
    process.env.FORGE_HOME = tmp;
    const { formatSessionDetails } = await import("../src/tui/status-bar.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const auth = {
      provider: "xai",
      method: "api_key",
      token: "t",
    } as ResolvedAuth;
    const text = formatSessionDetails({
      config: { ...DEFAULT_CONFIG, permissionMode: "plan", workspace: tmp },
      session: s,
      auth,
    });
    assert.match(text, /plan/i);
    assert.match(text, /\/build/);
    assert.match(text, /ctx\s+|autoCompact@/);
    // git line when in a repo (this workspace is)
    assert.match(text, /git\s+/);
  });

  it("formatSessionDetails surfaces lastError recovery tip", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-err-"));
    process.env.FORGE_HOME = tmp;
    const { formatSessionDetails } = await import("../src/tui/status-bar.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { setSessionLastError } = await import("../src/session/session.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    setSessionLastError(s, {
      code: "rate_limited",
      message: "xai HTTP 429: rate limit",
      tips: ["forge accounts switch"],
    });
    const auth = {
      provider: "xai",
      method: "api_key",
      token: "t",
    } as ResolvedAuth;
    const text = formatSessionDetails({
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      session: s,
      auth,
    });
    assert.match(text, /lastErr/);
    assert.match(text, /rate_limited/);
    assert.match(text, /accounts switch/);
  });
});

describe("live run header controls", () => {
  it("lists budget/done/notify alongside cycle controls", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-live-hdr-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    const text = renderLiveRunHeader({
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      session: s,
      auth: {
        provider: "xai",
        method: "api_key",
        token: "t",
      } as ResolvedAuth,
    });
    assert.match(text, /live run/);
    assert.match(text, /\/cycle 0/);
    assert.match(text, /\/budget/);
    assert.match(text, /\/done/);
    assert.match(text, /\/notify/);
    assert.match(text, /\/status/);
  });
});

describe("statusline tmux badges", () => {
  it("includes PIN for pinned sessions", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-tmux-pin-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, saveSession, setSessionPinned } = await import(
      "../src/session/session.js"
    );
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { collectSnapshots } = await import("../src/statusline/snapshot.js");
    const { renderTmux } = await import("../src/statusline/render.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    setSessionPinned(s, true);
    saveSession(s);
    const snaps = await collectSnapshots({
      sessionId: s.meta.id,
      fetchPlan: false,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
    });
    const line = renderTmux(snaps[0]);
    assert.match(line, /PIN/);
  });

  it("formatSessionDetails shows verify line / no-verify tip", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-details-verify-"));
    process.env.FORGE_HOME = tmp;
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc -b", test: "node --test" } }),
    );
    fs.writeFileSync(path.join(tmp, "package-lock.json"), "{}");
    const s = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
    });
    s.meta.editCount = 2;
    delete s.meta.lastVerificationCommand;
    const auth = { provider: "xai", method: "api_key", apiKey: "t" } as any;
    const config = { ...DEFAULT_CONFIG, workspace: tmp };
    const details = formatSessionDetails({ config, session: s, auth });
    const plain = details.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain, /verify\s+\(none after 2 edit/);
    s.meta.lastVerificationCommand = "npm test";
    const details2 = formatSessionDetails({ config, session: s, auth });
    const plain2 = details2.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain2, /verify\s+npm test/);
  });

  it("status snapshot includes lastEditAt + lastVerificationStale", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-snap-stale-"));
    process.env.FORGE_HOME = tmp;
    const { createSession, saveSession } = await import("../src/session/session.js");
    const { collectSnapshots } = await import("../src/statusline/snapshot.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4" });
    s.meta.lastVerificationCommand = "npm test";
    s.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    s.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    s.meta.editCount = 1;
    saveSession(s);
    const snaps = await collectSnapshots({ forgeHome: tmp, cwd: tmp });
    const mine = snaps.find((x: any) => x.sessionId === s.meta.id) || snaps[0];
    assert.ok(mine);
    assert.equal(mine!.lastEditAt, "2026-04-10T12:10:00.000Z");
    assert.equal(mine!.lastVerificationStale, true);
  });

  it("prompt flags surface WT for linked worktrees", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-wt-flag-"));
    process.env.FORGE_HOME = tmp;
    // Mock getGitSnapshot via real git worktree is heavy; unit-test the flag
    // path by stubbing module is awkward — instead call buildPromptFlags after
    // monkey-patching getGitSnapshot on the imported module is not available.
    // Use a real nested worktree when git allows; otherwise skip.
    const { createSession } = await import("../src/session/session.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    let wtDir = "";
    try {
      const { execFileSync } = await import("node:child_process");
      const main = fs.mkdtempSync(path.join(os.tmpdir(), "forge-wt-main-"));
      execFileSync("git", ["init"], { cwd: main, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: main, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "t"], { cwd: main, stdio: "ignore" });
      fs.writeFileSync(path.join(main, "a.txt"), "x\n");
      execFileSync("git", ["add", "a.txt"], { cwd: main, stdio: "ignore" });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "i"], {
        cwd: main,
        stdio: "ignore",
      });
      wtDir = path.join(os.tmpdir(), `forge-wt-link-${Date.now()}`);
      execFileSync(
        "git",
        ["worktree", "add", "--detach", wtDir, "HEAD"],
        { cwd: main, stdio: "ignore" },
      );
    } catch {
      return; // sandbox cannot create worktrees
    }
    const s = createSession({ cwd: wtDir, provider: "xai", model: "grok-4" });
    const auth = { provider: "xai", method: "api_key", apiKey: "t" } as any;
    const flags = buildPromptFlags({
      config: { ...DEFAULT_CONFIG, workspace: wtDir },
      session: s,
      auth,
    });
    const plain = flags.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain, /\bWT\b/);
  });
});
