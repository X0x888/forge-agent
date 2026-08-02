import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  armGoal,
  evaluateGoalAtStop,
  loadGoal,
  pauseGoal,
  resumeGoal,
  detectAutoGoal,
  deriveCriteria,
  markGoalDone,
} from "../src/harness/goal.js";

describe("goal harness", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-goal-"));
  process.env.FORGE_HOME = tmp;
  const sid = "test-session-1";

  it("derives criteria from objective", () => {
    const c = deriveCriteria("migrate to v2 and make tests pass");
    assert.ok(c.length >= 2);
  });

  it("detects auto-goal markers", () => {
    assert.equal(
      detectAutoGoal("please don't stop until all tests pass"),
      "all tests pass",
    );
    assert.ok(detectAutoGoal("goal: ship the auth feature end to end"));
    assert.equal(detectAutoGoal("hello world"), null);
  });

  it("arms and evaluates stop blocking", async () => {
    const g = armGoal(sid, "implement foo and verify with tests", "manual");
    assert.equal(g.status, "active");
    assert.ok(loadGoal(sid)?.objective.includes("implement foo"));

    const blocked = evaluateGoalAtStop({
      sessionId: sid,
      lastAssistantMessage: "I think we're done for now.",
      editCount: 0,
      stuckThreshold: 3,
      enabled: true,
    });
    assert.equal(blocked.block, true);
    assert.ok(blocked.reanchor?.includes("implement foo"));

    // Progress resets stuck streak
    const blocked2 = evaluateGoalAtStop({
      sessionId: sid,
      lastAssistantMessage: "made progress",
      editCount: 2,
      stuckThreshold: 3,
      enabled: true,
    });
    assert.equal(blocked2.block, true);

    // Soft TodoGate fire before attestation
    const {
      evaluateTodoGateAtStop,
      clearTodoGateState,
      getTodoGateFires,
    } = await import("../src/harness/todo-gate.js");
    clearTodoGateState(sid);
    evaluateTodoGateAtStop({
      sessionId: sid,
      ulwEnabled: false,
      ultraworkFlag: false,
      openTodoCount: 1,
      lastAssistantMessage: "stop",
    });
    assert.ok(getTodoGateFires(sid) >= 1);

    // Attestation releases + clears soft TodoGate
    const done = evaluateGoalAtStop({
      sessionId: sid,
      lastAssistantMessage: "**Goal achieved.**\n✅ all good",
      editCount: 2,
      stuckThreshold: 3,
      enabled: true,
    });
    assert.equal(done.block, false);
    assert.equal(loadGoal(sid)?.status, "achieved");
    assert.equal(getTodoGateFires(sid), 0);
  });

  it("stuck-wall releases after threshold with no edits", async () => {
    const sid2 = "test-session-stuck";
    armGoal(sid2, "impossible forever task", "manual");
    const {
      evaluateTodoGateAtStop,
      clearTodoGateState,
      getTodoGateFires,
    } = await import("../src/harness/todo-gate.js");
    clearTodoGateState(sid2);
    evaluateTodoGateAtStop({
      sessionId: sid2,
      ulwEnabled: false,
      ultraworkFlag: false,
      openTodoCount: 1,
      lastAssistantMessage: "stop",
    });
    assert.ok(getTodoGateFires(sid2) >= 1);
    let last;
    for (let i = 0; i < 3; i++) {
      last = evaluateGoalAtStop({
        sessionId: sid2,
        lastAssistantMessage: "still going",
        editCount: 0,
        stuckThreshold: 3,
        enabled: true,
      });
    }
    assert.equal(last!.stuckReleased, true);
    assert.equal(loadGoal(sid2)?.status, "stuck");
    // Soft TodoGate cleared on stuck-wall release
    assert.equal(getTodoGateFires(sid2), 0);
  });

  it("pause and resume", async () => {
    const sid3 = "test-session-pause";
    armGoal(sid3, "paused objective", "manual");
    pauseGoal(sid3);
    const whilePaused = evaluateGoalAtStop({
      sessionId: sid3,
      lastAssistantMessage: "x",
      editCount: 0,
      stuckThreshold: 3,
      enabled: true,
    });
    assert.equal(whilePaused.block, false);
    resumeGoal(sid3);
    const after = evaluateGoalAtStop({
      sessionId: sid3,
      lastAssistantMessage: "x",
      editCount: 0,
      stuckThreshold: 3,
      enabled: true,
    });
    assert.equal(after.block, true);

    // Soft TodoGate fire before markGoalDone
    const {
      evaluateTodoGateAtStop,
      clearTodoGateState,
      getTodoGateFires,
    } = await import("../src/harness/todo-gate.js");
    clearTodoGateState(sid3);
    evaluateTodoGateAtStop({
      sessionId: sid3,
      ulwEnabled: false,
      ultraworkFlag: false,
      openTodoCount: 1,
      lastAssistantMessage: "stop",
    });
    assert.ok(getTodoGateFires(sid3) >= 1);

    markGoalDone(sid3);
    assert.equal(loadGoal(sid3)?.status, "achieved");
    assert.equal(getTodoGateFires(sid3), 0);
  });
});

describe("goal arms session title when untitled", () => {
  it("/goal set titles an untitled session", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-goal-title-"));
    process.env.FORGE_HOME = tmp;
    const { createSession } = await import("../src/session/session.js");
    const { handleSlash } = await import("../src/commands/slash.js");
    const { DEFAULT_CONFIG } = await import("../src/config/types.js");
    const { HookRunner } = await import("../src/harness/hooks.js");
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    assert.equal(session.meta.title, undefined);
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const r = await handleSlash("/goal set harden the auth refresh path", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(r.handled, true);
    assert.ok(session.meta.title);
    assert.match(session.meta.title!, /auth refresh|Harden/i);
    // Does not overwrite existing title
    session.meta.title = "keep-me";
    await handleSlash("/goal set something else entirely", {
      session,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(session.meta.title, "keep-me");
  });

  it("blocks Goal achieved without evidence after edits", () => {
    const sid = "test-session-attest-evidence";
    armGoal(sid, "ship the feature");
    const blocked = evaluateGoalAtStop({
      sessionId: sid,
      lastAssistantMessage: "**Goal achieved.**",
      editCount: 3,
      stuckThreshold: 5,
      enabled: true,
      verificationPassed: false,
      preferredCheckCommands: ["npm test", "npm run typecheck"],
    });
    assert.equal(blocked.block, true);
    assert.match(String(blocked.reason || ""), /evidence/i);
    assert.match(String(blocked.reanchor || ""), /npm test/);
    assert.match(String(blocked.reanchor || ""), /Goal attestation needs evidence/);
    const ok = evaluateGoalAtStop({
      sessionId: sid,
      lastAssistantMessage: "**Goal achieved.**\n✅ all criteria met",
      editCount: 3,
      stuckThreshold: 5,
      enabled: true,
      verificationPassed: false,
    });
    assert.equal(ok.block, false);
    assert.equal(loadGoal(sid)?.status, "achieved");
  });

  it("caps the evidence bounce — repeated weak attestation hits the stuck-wall (never a trap)", () => {
    const sid = "test-session-attest-trap";
    armGoal(sid, "ship the feature");
    const weak = {
      sessionId: sid,
      lastAssistantMessage: "**Goal achieved.**",
      editCount: 3,
      stuckThreshold: 3,
      enabled: true,
      verificationPassed: false,
    };

    // First weak attestation: evidence bounce — and stuck tracking persisted.
    const d1 = evaluateGoalAtStop(weak);
    assert.equal(d1.block, true);
    assert.match(String(d1.reason || ""), /evidence/i);
    assert.equal(loadGoal(sid)?.blocks, 1);
    assert.equal(loadGoal(sid)?.evidenceNudges, 1);

    // Second weak attestation: bounce is capped → normal goal block, no new nudge.
    const d2 = evaluateGoalAtStop(weak);
    assert.equal(d2.block, true);
    assert.match(String(d2.reason || ""), /goal not yet achieved/i);
    assert.equal(loadGoal(sid)?.evidenceNudges, 1);

    // Repeated weak attestations feed the stuck-wall — it must always release.
    let last;
    for (let i = 0; i < 5; i++) {
      last = evaluateGoalAtStop(weak);
      if (!last.block) break;
    }
    assert.equal(last!.block, false);
    assert.equal(last!.stuckReleased, true);
    assert.equal(loadGoal(sid)?.status, "stuck");
  });

  it("working-tree diff movement prevents a false stuck-wall (bash-channel work)", () => {
    const sidFp = "test-goal-fp-progress";
    armGoal(sidFp, "keep making tree changes", "manual");
    const call = (fp: string) =>
      evaluateGoalAtStop({
        sessionId: sidFp,
        lastAssistantMessage: "working via bash heredocs",
        editCount: 0, // no edit-tool calls — work lands via bash
        stuckThreshold: 3,
        enabled: true,
        diffFingerprint: fp,
      });
    // First call sets the baseline; the next three all move the tree to new
    // states. Without fingerprinting this would release at threshold 3.
    call("fp-0");
    let last;
    for (const fp of ["fp-1", "fp-2", "fp-3"]) last = call(fp);
    assert.equal(last!.block, true);
    assert.equal(last!.stuckReleased ?? false, false);
    assert.equal(loadGoal(sidFp)?.stuckBlocks, 0);
    assert.equal(loadGoal(sidFp)?.status, "active");

    // Stop moving the tree → the stuck-wall engages on schedule.
    let released;
    for (let i = 0; i < 3; i++) released = call("fp-3");
    assert.equal(released!.stuckReleased, true);
    assert.equal(loadGoal(sidFp)?.status, "stuck");
  });
});
