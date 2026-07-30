import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession, saveSession } from "../src/session/session.js";
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
  formatBackgroundTasksList,
  createWorkingIndicator,
  clipAnsi,
  visibleWidth,
} from "../src/tui/status-bar.js";
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

    const flags = buildPromptFlags({ config, session: s, auth });
    assert.match(flags, /ULW/);
    assert.match(flags, /c=1/);
    assert.match(flags, /w=0/);

    const footer = renderTurnFooter(
      { config, session: s, auth },
      { promptTokens: 100, completionTokens: 50, stopContinues: 1 },
    );
    assert.match(footer, /ctx/);
    assert.match(footer, /todos:1/);
    assert.match(footer, /harness/);
    assert.match(footer, /ULW c=1 w=0/);
    assert.match(footer, /\/cycle 0/);
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
});
