import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideAtStop, syncItemsFromTodos, type StopFacts } from "../src/harness/cycle/machine.js";
import { newCycleState, type CycleState } from "../src/harness/cycle/state.js";

function executing(overrides: Partial<CycleState> = {}): CycleState {
  const s = newCycleState({ sessionId: "m", mandate: "add x" });
  s.cycle = 1;
  s.phase = "execute";
  s.items = [
    { id: "i1", title: "a", files: [], status: "open" },
    { id: "i2", title: "b", files: [], status: "open" },
  ];
  return { ...s, ...overrides };
}

const facts = (o: Partial<StopFacts> = {}): StopFacts => ({
  editCount: 3,
  openTodoCount: 2,
  lastAssistantMessage: "shipped a",
  diffFingerprint: "fp1",
  verificationRan: true,
  verificationPassed: true,
  verificationFullSuite: false,
  stuckThreshold: 3,
  ...o,
});

describe("cycle machine — decideAtStop", () => {
  it("phase plan runs the Planner; a human /plan yields instead", () => {
    const s = newCycleState({ sessionId: "m", mandate: null });
    assert.deepEqual(decideAtStop(s, facts()), { kind: "plan" });
    s.humanPlan = true;
    assert.deepEqual(decideAtStop(s, facts()), { kind: "yield", why: "human-plan" });
  });

  it("EXECUTE with open items re-anchors and stamps a wave with facts", () => {
    const s = executing();
    const a = decideAtStop(s, facts());
    assert.deepEqual(a, { kind: "reanchor", why: "items-open" });
    assert.equal(s.wave, 1);
    assert.equal(s.totalWaves, 1);
    assert.equal(s.ledger.length, 1);
    assert.equal(s.ledger[0].editDelta, 3);
    assert.equal(s.ledger[0].netDiff, "new");
    assert.equal(s.ledger[0].proofRan, true);
    assert.equal(s.stuckBlocks, 0);
  });

  it("'Plan complete.' closes the cycle even with todos still open", () => {
    const s = executing();
    const a = decideAtStop(s, facts({ lastAssistantMessage: "**Plan complete.** all done" }));
    assert.deepEqual(a, { kind: "close-cycle", why: "plan-complete" });
  });

  it("an empty board closes the cycle (items-done)", () => {
    const s = executing();
    s.items.forEach((i) => (i.status = "done"));
    const a = decideAtStop(s, facts({ openTodoCount: 0 }));
    assert.deepEqual(a, { kind: "close-cycle", why: "items-done" });
  });

  it("/replan closes the cycle at the next Stop", () => {
    const s = executing({ replanRequested: true });
    assert.deepEqual(decideAtStop(s, facts()), { kind: "close-cycle", why: "replan" });
  });

  it("no edits and no tree movement for N Stops routes to REVIEW, not release", () => {
    const s = executing();
    const still = facts({ editCount: 0, diffFingerprint: "same" });
    decideAtStop(s, still); // fp new → progressed once
    assert.equal(s.stuckBlocks, 0);
    assert.deepEqual(decideAtStop(s, still), { kind: "reanchor", why: "items-open" });
    assert.deepEqual(decideAtStop(s, still), { kind: "reanchor", why: "items-open" });
    const a = decideAtStop(s, still);
    assert.deepEqual(a, { kind: "close-cycle", why: "stuck" });
    assert.equal(s.stuckBlocks, 3);
  });

  it("edit→revert is a revisit, not progress", () => {
    const s = executing();
    decideAtStop(s, facts({ editCount: 1, diffFingerprint: "a" }));
    decideAtStop(s, facts({ editCount: 2, diffFingerprint: "b" }));
    decideAtStop(s, facts({ editCount: 2, diffFingerprint: "a" }));
    assert.equal(s.ledger[2].netDiff, "revisit");
    assert.equal(s.stuckBlocks, 1);
  });

  it("FIX phase re-runs verify; interrupted review/verify/commit resume the close", () => {
    assert.deepEqual(decideAtStop(executing({ phase: "fix" }), facts()), { kind: "verify" });
    for (const phase of ["review", "verify", "commit"] as const) {
      assert.equal(decideAtStop(executing({ phase }), facts()).kind, "close-cycle");
    }
  });

  it("disabled / released / legacy states release", () => {
    const s = executing({ enabled: false, endReason: "disarmed" });
    assert.deepEqual(decideAtStop(s, facts()), { kind: "release", reason: "disarmed" });
    const l = executing({ legacy: true });
    assert.equal(decideAtStop(l, facts()).kind, "release");
  });
});

describe("syncItemsFromTodos", () => {
  it("mirrors the executor's board onto the plan items by id", () => {
    const s = executing();
    syncItemsFromTodos(s, [
      { id: "i1", status: "completed" },
      { id: "i2", status: "cancelled" },
      { id: "zz", status: "pending" },
    ]);
    assert.equal(s.items[0].status, "done");
    assert.equal(s.items[1].status, "cancelled");
  });
});
