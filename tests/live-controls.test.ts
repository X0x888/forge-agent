import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyLiveSlash,
  isLiveSafeSlash,
  isSafeDiffFilterArg,
  handleSlash,
  LIVE_CONTROLS_HINT,
} from "../src/commands/slash.js";
import {
  pushLiveNotice,
  drainLiveNotices,
  peekLiveNotices,
  clearLiveNotices,
  formatLiveNoticesMessage,
} from "../src/harness/live-notices.js";
import {
  armUlwCycle,
  setCycleFlag,
  loadUlwCycle,
  evaluateUlwAtStop,
} from "../src/harness/ulw-cycle.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";

describe("live mid-run slash policy", () => {
  it("allows harness controls mid-run", () => {
    assert.equal(classifyLiveSlash("/cycle 0"), "control");
    assert.equal(classifyLiveSlash("/cycle 1"), "control");
    assert.equal(classifyLiveSlash("/cycle status"), "readonly");
    assert.equal(classifyLiveSlash("/cycle"), "readonly");
    assert.equal(classifyLiveSlash("/ulw-off"), "control");
    assert.equal(classifyLiveSlash("/goal pause"), "control");
    assert.equal(classifyLiveSlash("/goal resume"), "control");
    assert.equal(classifyLiveSlash("/goal clear"), "control");
    assert.equal(classifyLiveSlash("/goal done"), "control");
    assert.equal(classifyLiveSlash("/done"), "control");
    assert.equal(classifyLiveSlash("/done shipped"), "control");
    assert.equal(classifyLiveSlash("/pause"), "control");
    assert.equal(classifyLiveSlash("/unpause"), "control");
    assert.ok(isLiveSafeSlash("/cycle 0"));
    assert.ok(isLiveSafeSlash("/done"));
    assert.ok(isLiveSafeSlash("/pause"));
    assert.ok(isLiveSafeSlash("/unpause"));
  });

  it("allows read-only status mid-run", () => {
    assert.equal(classifyLiveSlash("/status"), "readonly");
    assert.equal(classifyLiveSlash("/help"), "readonly");
    assert.equal(classifyLiveSlash("/todos"), "readonly");
    assert.equal(classifyLiveSlash("/goal"), "readonly");
    assert.equal(classifyLiveSlash("/goal status"), "readonly");
    assert.equal(classifyLiveSlash("/sessions"), "readonly");
    assert.equal(classifyLiveSlash("/sessions list"), "readonly");
    assert.equal(classifyLiveSlash("/sessions all"), "readonly");
    assert.equal(classifyLiveSlash("/sessions pinned"), "readonly");
    assert.equal(classifyLiveSlash("/sessions search incident"), "readonly");
    assert.equal(classifyLiveSlash("/sessions incident-42"), "readonly");
    assert.equal(classifyLiveSlash("/stats"), "readonly");
    assert.equal(classifyLiveSlash("/stats 7"), "readonly");
    assert.equal(classifyLiveSlash("/share"), "readonly");
    assert.equal(classifyLiveSlash("/tips"), "readonly");
    assert.equal(classifyLiveSlash("/news"), "readonly");
    assert.equal(classifyLiveSlash("/news 2"), "readonly");
    assert.equal(classifyLiveSlash("/changelog"), "readonly");
    assert.equal(classifyLiveSlash("/diff"), "readonly");
    assert.equal(classifyLiveSlash("/metrics"), "readonly");
    assert.equal(classifyLiveSlash("/cost"), "readonly");
    assert.equal(classifyLiveSlash("/title"), "readonly");
    assert.equal(classifyLiveSlash("/rename"), "readonly");
    assert.equal(classifyLiveSlash("/permissions"), "readonly");
    assert.equal(classifyLiveSlash("/permissions list"), "readonly");
    assert.equal(classifyLiveSlash("/copy"), "readonly");
    assert.equal(classifyLiveSlash("/last"), "readonly");
    assert.equal(classifyLiveSlash("/last 3"), "readonly");
    assert.equal(classifyLiveSlash("/files"), "readonly");
    assert.equal(classifyLiveSlash("/files writes"), "readonly");
    assert.equal(classifyLiveSlash("/files 20"), "readonly");
    assert.equal(classifyLiveSlash("/path"), "readonly");
    assert.equal(classifyLiveSlash("/path json"), "readonly");
    assert.equal(classifyLiveSlash("/logs"), "readonly");
    assert.equal(classifyLiveSlash("/logs 20"), "readonly");
    assert.equal(classifyLiveSlash("/logs path"), "readonly");
    assert.equal(classifyLiveSlash("/config"), "readonly");
    assert.equal(classifyLiveSlash("/config json"), "readonly");
    assert.equal(classifyLiveSlash("/pin status"), "readonly");
    assert.ok(isLiveSafeSlash("/status"));
    assert.ok(isLiveSafeSlash("/sessions"));
    assert.ok(isLiveSafeSlash("/files"));
    assert.ok(isLiveSafeSlash("/logs"));
    assert.ok(isLiveSafeSlash("/config"));
    assert.ok(isLiveSafeSlash("/pin status"));
    assert.ok(isLiveSafeSlash("/diff"));
    assert.ok(isLiveSafeSlash("/metrics"));
    assert.ok(isLiveSafeSlash("/title"));
    assert.ok(isLiveSafeSlash("/permissions list"));
    assert.ok(isLiveSafeSlash("/copy"));
    assert.ok(isLiveSafeSlash("/last 3"));
  });

  it("allows title rename mid-run as control", () => {
    assert.equal(classifyLiveSlash("/title incident-42"), "control");
    assert.equal(classifyLiveSlash("/rename clear"), "control");
    assert.ok(isLiveSafeSlash("/title incident-42"));
  });

  it("allows /pin toggle mid-run as control", () => {
    assert.equal(classifyLiveSlash("/pin"), "control");
    assert.equal(classifyLiveSlash("/pin on"), "control");
    assert.equal(classifyLiveSlash("/unpin"), "control");
    assert.equal(classifyLiveSlash("/pin toggle"), "control");
    assert.ok(isLiveSafeSlash("/pin"));
    assert.ok(isLiveSafeSlash("/pin on"));
    assert.ok(isLiveSafeSlash("/unpin"));
  });

  it("allows /bell status and toggle mid-run", () => {
    assert.equal(classifyLiveSlash("/bell"), "readonly");
    assert.equal(classifyLiveSlash("/bell on"), "control");
    assert.equal(classifyLiveSlash("/bell off"), "control");
    assert.ok(isLiveSafeSlash("/bell test"));
  });

  it("allows quit mid-run (abort then exit)", () => {
    assert.equal(classifyLiveSlash("/quit"), "quit");
    assert.equal(classifyLiveSlash("/exit"), "quit");
    assert.ok(isLiveSafeSlash("/quit"));
  });

  it("rejects turn-starting and conversation-mutating commands", () => {
    assert.equal(classifyLiveSlash("/ulw improve the code"), "idle-only");
    assert.equal(classifyLiveSlash("/goal set ship the feature"), "idle-only");
    assert.equal(classifyLiveSlash("/goal ship the feature"), "idle-only");
    assert.equal(classifyLiveSlash("/compact"), "idle-only");
    assert.equal(classifyLiveSlash("/compact-and next"), "idle-only");
    assert.equal(classifyLiveSlash("/fork-and-compact next"), "idle-only");
    assert.equal(classifyLiveSlash("/init"), "idle-only");
    assert.equal(classifyLiveSlash("/review"), "idle-only");
    assert.equal(classifyLiveSlash("/new"), "idle-only");
    assert.equal(classifyLiveSlash("/clear"), "idle-only");
    assert.equal(classifyLiveSlash("/rewind"), "idle-only");
    assert.equal(classifyLiveSlash("/undo"), "idle-only");
    assert.equal(classifyLiveSlash("/retry"), "idle-only");
    assert.equal(classifyLiveSlash("/again try harder"), "idle-only");
    assert.equal(classifyLiveSlash("/model grok-4"), "idle-only");
    assert.equal(isLiveSafeSlash("/retry"), false);
    assert.equal(isLiveSafeSlash("/fork-and-compact x"), false);
    assert.equal(classifyLiveSlash("/sessions delete abc"), "idle-only");
    assert.equal(classifyLiveSlash("/sessions prune"), "idle-only");
    assert.equal(classifyLiveSlash("/permissions clear"), "idle-only");
    assert.equal(classifyLiveSlash("/permissions bypassPermissions"), "idle-only");
    assert.equal(classifyLiveSlash("not a slash"), "idle-only");
    assert.equal(isLiveSafeSlash("/ulw fix it"), false);
    assert.equal(isLiveSafeSlash("/sessions delete x"), false);
    assert.equal(isLiveSafeSlash("/permissions clear"), false);
  });

  it("exposes a usable hint string", () => {
    assert.match(LIVE_CONTROLS_HINT, /cycle 0/);
    assert.match(LIVE_CONTROLS_HINT, /ulw-off/);
    assert.match(LIVE_CONTROLS_HINT, /\/done/);
    assert.match(LIVE_CONTROLS_HINT, /\/pause/);
    assert.match(LIVE_CONTROLS_HINT, /\/unpause/);
  });
});

describe("live notices queue", () => {
  beforeEach(() => clearLiveNotices());

  it("pushes and drains FIFO per session", () => {
    pushLiveNotice("s1", "first");
    pushLiveNotice("s1", "second");
    pushLiveNotice("s2", "other");
    assert.deepEqual([...peekLiveNotices("s1")], ["first", "second"]);
    assert.deepEqual(drainLiveNotices("s1"), ["first", "second"]);
    assert.deepEqual(drainLiveNotices("s1"), []);
    assert.deepEqual(drainLiveNotices("s2"), ["other"]);
  });

  it("formats single and multi notices", () => {
    assert.match(formatLiveNoticesMessage(["only"]), /User control — mid-run/);
    assert.match(formatLiveNoticesMessage(["only"]), /only/);
    const multi = formatLiveNoticesMessage(["a", "b"]);
    assert.match(multi, /1\. a/);
    assert.match(multi, /2\. b/);
  });

  it("ignores empty messages", () => {
    pushLiveNotice("s1", "   ");
    assert.deepEqual(drainLiveNotices("s1"), []);
  });
});

describe("/done and /pause goal shortcuts", () => {
  it("marks goal achieved like /goal done", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-done-"));
    process.env.FORGE_HOME = tmp;
    clearLiveNotices();
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "test",
    });
    const { armGoal, loadGoal } = await import("../src/harness/goal.js");
    armGoal(session.meta.id, "ship the feature", "manual");
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/done verified in CI", {
      session,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /Goal marked achieved/i);
    const g = loadGoal(session.meta.id);
    assert.ok(g);
    assert.equal(g!.status, "achieved");
    const notices = drainLiveNotices(session.meta.id);
    assert.ok(notices.some((n) => /goal done|released/i.test(n)));
  });

  it("pauses goal like /goal pause", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pause-"));
    process.env.FORGE_HOME = tmp;
    clearLiveNotices();
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "test",
    });
    const { armGoal, loadGoal } = await import("../src/harness/goal.js");
    armGoal(session.meta.id, "keep going", "manual");
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/pause", {
      session,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /paused|Goal/i);
    const g = loadGoal(session.meta.id);
    assert.ok(g);
    assert.equal(g!.paused, true);
  });

  it("unpauses goal like /goal resume", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-unpause-"));
    process.env.FORGE_HOME = tmp;
    clearLiveNotices();
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "test",
    });
    const { armGoal, pauseGoal, loadGoal } = await import(
      "../src/harness/goal.js"
    );
    armGoal(session.meta.id, "keep going", "manual");
    pauseGoal(session.meta.id);
    assert.equal(loadGoal(session.meta.id)?.paused, true);
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/unpause", {
      session,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /resumed|Goal/i);
    const g = loadGoal(session.meta.id);
    assert.ok(g);
    assert.equal(g!.paused, false);
  });
});

describe("mid-run /cycle affects stop-guard without abort", () => {
  it("cycle flag written while 'busy' is honored on next Stop", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-live-"));
    process.env.FORGE_HOME = tmp;
    clearLiveNotices();

    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "test",
    });
    armUlwCycle(session.meta.id, "improve the code", { cycle: 1 });

    // Simulate mid-run user typing /cycle 0
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const result = await handleSlash("/cycle 0", {
      session,
      config: DEFAULT_CONFIG,
      hooks,
    });
    assert.equal(result.handled, true);
    assert.match(result.output || "", /cycle=0|LAST/i);
    assert.equal(loadUlwCycle(session.meta.id)?.cycle, 0);

    // Notice queued for next LLM call
    const notices = drainLiveNotices(session.meta.id);
    assert.ok(notices.some((n) => /cycle=0|LAST/i.test(n)));

    // Stop without attestation still blocks (finish wave)
    const blocked = evaluateUlwAtStop({
      sessionId: session.meta.id,
      lastAssistantMessage: "I think we're done.",
      editCount: 2,
      openTodoCount: 0,
      stuckThreshold: 10,
    });
    assert.equal(blocked.block, true);
    assert.match(blocked.reanchor || "", /LAST|Cycle complete/i);

    // Attestation releases
    setCycleFlag(session.meta.id, 0);
    const released = evaluateUlwAtStop({
      sessionId: session.meta.id,
      lastAssistantMessage: "**Cycle complete.** Shipped X with tests.",
      editCount: 3,
      openTodoCount: 0,
      stuckThreshold: 10,
    });
    assert.equal(released.block, false);
    assert.equal(released.lastCycleReleased, true);
  });

  it("/ulw-off mid-run disables cycle driver", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-live2-"));
    process.env.FORGE_HOME = tmp;
    clearLiveNotices();

    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "test",
    });
    armUlwCycle(session.meta.id, "improve", { cycle: 1 });
    session.meta.ultrawork = true;

    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    await handleSlash("/ulw-off", {
      session,
      config: DEFAULT_CONFIG,
      hooks,
    });

    assert.equal(session.meta.ultrawork, false);
    assert.equal(loadUlwCycle(session.meta.id)?.enabled, false);

    const d = evaluateUlwAtStop({
      sessionId: session.meta.id,
      lastAssistantMessage: "stopping",
      editCount: 1,
      openTodoCount: 0,
      stuckThreshold: 10,
    });
    assert.equal(d.block, false);

    const notices = drainLiveNotices(session.meta.id);
    assert.ok(notices.some((n) => /disarm|ulw-off/i.test(n)));
  });

  it("/diff does not shell-interpolate filter args", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-diff-safe-"));
    process.env.FORGE_HOME = tmp;
    // Marker must NOT be created if injection were possible via shell
    const marker = path.join(tmp, "pwned-diff-marker");
    const session = createSession({
      cwd: process.cwd(), // real git repo
      provider: "xai",
      model: "test",
    });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const evil = `/diff ; touch ${marker}`;
    const r = await handleSlash(evil, {
      session,
      config: { ...DEFAULT_CONFIG, workspace: process.cwd() },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.equal(fs.existsSync(marker), false, "shell injection must not run");
    // Either a normal git error/output or unavailable — never side-effect
    assert.ok(typeof r.output === "string" && r.output.length > 0);
  });

  it("isSafeDiffFilterArg allowlists pathspecs and denies write sinks", () => {
    assert.equal(isSafeDiffFilterArg("src/cli.ts"), true);
    assert.equal(isSafeDiffFilterArg("HEAD"), true);
    assert.equal(isSafeDiffFilterArg("main...HEAD"), true);
    assert.equal(isSafeDiffFilterArg("--cached"), true);
    assert.equal(isSafeDiffFilterArg("--name-only"), true);
    assert.equal(isSafeDiffFilterArg("-U5"), true);
    assert.equal(isSafeDiffFilterArg("--"), true);
    assert.equal(isSafeDiffFilterArg("--output=/tmp/x"), false);
    assert.equal(isSafeDiffFilterArg("--output"), false);
    assert.equal(isSafeDiffFilterArg("--ext-diff"), false);
    assert.equal(isSafeDiffFilterArg("--git-dir=/tmp"), false);
    assert.equal(isSafeDiffFilterArg("-c"), false);
  });

  it("/diff rejects --output write sink before invoking git", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-diff-out-"));
    process.env.FORGE_HOME = tmp;
    const sink = path.join(tmp, "evil-diff-out");
    const session = createSession({
      cwd: process.cwd(),
      provider: "xai",
      model: "test",
    });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash(`/diff --output=${sink}`, {
      session,
      config: { ...DEFAULT_CONFIG, workspace: process.cwd() },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(String(r.output || ""), /Rejected \/diff filter/i);
    assert.equal(fs.existsSync(sink), false);
  });
});
