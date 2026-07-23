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

  it("arms and evaluates stop blocking", () => {
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

    // Attestation releases
    const done = evaluateGoalAtStop({
      sessionId: sid,
      lastAssistantMessage: "**Goal achieved.**\n✅ all good",
      editCount: 2,
      stuckThreshold: 3,
      enabled: true,
    });
    assert.equal(done.block, false);
    assert.equal(loadGoal(sid)?.status, "achieved");
  });

  it("stuck-wall releases after threshold with no edits", () => {
    const sid2 = "test-session-stuck";
    armGoal(sid2, "impossible forever task", "manual");
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
    assert.equal(last!.block, false);
    assert.equal(last!.stuckReleased, true);
    assert.equal(loadGoal(sid2)?.status, "stuck");
  });

  it("pause and resume", () => {
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
    markGoalDone(sid3);
    assert.equal(loadGoal(sid3)?.status, "achieved");
  });
});
