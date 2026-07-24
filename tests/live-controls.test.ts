import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyLiveSlash,
  isLiveSafeSlash,
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
    assert.ok(isLiveSafeSlash("/cycle 0"));
  });

  it("allows read-only status mid-run", () => {
    assert.equal(classifyLiveSlash("/status"), "readonly");
    assert.equal(classifyLiveSlash("/help"), "readonly");
    assert.equal(classifyLiveSlash("/todos"), "readonly");
    assert.equal(classifyLiveSlash("/goal"), "readonly");
    assert.equal(classifyLiveSlash("/goal status"), "readonly");
    assert.ok(isLiveSafeSlash("/status"));
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
    assert.equal(classifyLiveSlash("/new"), "idle-only");
    assert.equal(classifyLiveSlash("/clear"), "idle-only");
    assert.equal(classifyLiveSlash("/rewind"), "idle-only");
    assert.equal(classifyLiveSlash("/model grok-4"), "idle-only");
    assert.equal(classifyLiveSlash("not a slash"), "idle-only");
    assert.equal(isLiveSafeSlash("/ulw fix it"), false);
  });

  it("exposes a usable hint string", () => {
    assert.match(LIVE_CONTROLS_HINT, /cycle 0/);
    assert.match(LIVE_CONTROLS_HINT, /ulw-off/);
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
});
