import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  armUlwCycle,
  setCycleFlag,
  maybeFlipUlwToLastOnSafetyValve,
  maybeFlipUlwToLastOnCostCap,
  setMaxWaves,
  evaluateUlwAtStop,
  isSoftPrompt,
  expandUlwMandate,
  loadUlwCycle,
  copyUlwCycle,
  parseCycleArg,
  parseMaxWavesArg,
  normalizeMaxWaves,
  disarmUlwCycle,
  formatUlwCounts,
  formatUlwBadge,
  formatUlwStatus,
  detectWaveProof,
  hasAttestationEvidence,
  bestWave,
  formatWaveLedger,
  VERIFICATION_CMD_RE,
  ULW_LIVE_CONTROLS_HINT,
} from "../src/harness/ulw-cycle.js";
import { armGoal, copyGoal, loadGoal } from "../src/harness/goal.js";
import { createSession, forkSession } from "../src/session/session.js";
import { runStopGuard } from "../src/harness/stop-guard.js";
import { HookRunner } from "../src/harness/hooks.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

describe("ulw cycle", () => {
  it("detects soft prompts", () => {
    assert.equal(isSoftPrompt("improve the code"), true);
    assert.equal(isSoftPrompt("fix"), true);
    assert.equal(isSoftPrompt("polish"), true);
    assert.equal(
      isSoftPrompt("add a /health endpoint and make npm test pass"),
      false,
    );
  });

  it("expands soft mandates to god-scope", () => {
    const { soft, expanded } = expandUlwMandate("improve the code");
    assert.equal(soft, true);
    assert.match(expanded, /God-scope|gap list|Serendipity/i);
  });

  it("parseCycleArg accepts 0/1 aliases", () => {
    assert.equal(parseCycleArg("1"), 1);
    assert.equal(parseCycleArg("continue"), 1);
    assert.equal(parseCycleArg("0"), 0);
    assert.equal(parseCycleArg("last"), 0);
    assert.equal(parseCycleArg("nope"), null);
  });

  it("parseMaxWavesArg / normalizeMaxWaves", () => {
    assert.equal(parseMaxWavesArg("3"), 3);
    assert.equal(parseMaxWavesArg("off"), null);
    assert.equal(parseMaxWavesArg("unlimited"), null);
    assert.equal(parseMaxWavesArg("0"), null);
    assert.equal(parseMaxWavesArg("nope"), undefined);
    assert.equal(parseMaxWavesArg("1.5"), undefined);
    assert.equal(normalizeMaxWaves(5), 5);
    assert.equal(normalizeMaxWaves(0), null);
    assert.equal(normalizeMaxWaves(null), null);
  });

  it("default maxWaves is unlimited; arm can set cap", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-mw-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-mw-default";
    const s = armUlwCycle(sid, "improve", { cycle: 1 });
    assert.equal(s.maxWaves, null);
    assert.equal(formatUlwCounts(s), "cycle=1 wave=0 blocks=0");

    const capped = armUlwCycle(sid, "improve more", { cycle: 1, maxWaves: 3 });
    assert.equal(capped.maxWaves, 3);
    assert.equal(formatUlwCounts(capped), "cycle=1 wave=0/3 blocks=0");
    assert.equal(formatUlwBadge(capped), "c=1 w=0/3");
    assert.match(formatUlwStatus(capped), /max_waves: 3/);
  });

  it("max_waves forces LAST when wave hits cap", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-cap-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-cap";
    armUlwCycle(sid, "ship three waves", { cycle: 1, maxWaves: 2 });
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

    const d1 = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "wave done",
      editCount: 1,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    // wave becomes 1 < 2 → CONTINUE
    assert.equal(d1.block, true);
    assert.equal(d1.maxWavesHit, undefined);
    assert.match(d1.reanchor || "", /CONTINUE/i);
    assert.equal(loadUlwCycle(sid)?.wave, 1);
    assert.equal(loadUlwCycle(sid)?.cycle, 1);
    // Soft TodoGate not cleared on CONTINUE
    assert.ok(getTodoGateFires(sid) >= 1);

    const d2 = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "wave two",
      editCount: 2,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    // wave becomes 2 >= 2 → auto LAST
    assert.equal(d2.block, true);
    assert.equal(d2.maxWavesHit, true);
    assert.match(d2.reanchor || "", /LAST|max_waves/i);
    assert.equal(loadUlwCycle(sid)?.wave, 2);
    assert.equal(loadUlwCycle(sid)?.cycle, 0);
    // Soft TodoGate cleared on auto LAST
    assert.equal(getTodoGateFires(sid), 0);

    const done = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage:
        "**Cycle complete.**\n✅ wave one shipped — npm test: 42 passed\n✅ wave two shipped — typecheck clean",
      editCount: 3,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    assert.equal(done.block, false);
    assert.equal(done.lastCycleReleased, true);
  });

  it("setMaxWaves live + clear; re-arm preserves cap unless overridden", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-setmw-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-setmw";
    armUlwCycle(sid, "task", { cycle: 1 });
    assert.equal(setMaxWaves(sid, 4)?.maxWaves, 4);
    // Re-arm without maxWaves opts keeps prior cap
    const again = armUlwCycle(sid, "task continued", { cycle: 1 });
    assert.equal(again.maxWaves, 4);
    assert.equal(setMaxWaves(sid, null)?.maxWaves, null);
    // Explicit override
    const forced = armUlwCycle(sid, "task", { cycle: 1, maxWaves: 2 });
    assert.equal(forced.maxWaves, 2);
  });

  it("setMaxWaves immediately flips to LAST when wave already at/over cap", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-setmw-now-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-setmw-now";
    armUlwCycle(sid, "task", { cycle: 1, maxWaves: 10 });
    // Advance wave to 3
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "w1",
      editCount: 1,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "w2",
      editCount: 2,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "w3",
      editCount: 3,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    assert.equal(loadUlwCycle(sid)?.wave, 3);
    assert.equal(loadUlwCycle(sid)?.cycle, 1);
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
    // Cap at 2 while wave is 3 → immediate LAST
    const next = setMaxWaves(sid, 2);
    assert.ok(next);
    assert.equal(next!.maxWaves, 2);
    assert.equal(next!.cycle, 0);
    assert.equal(loadUlwCycle(sid)?.cycle, 0);
    assert.equal(getTodoGateFires(sid), 0);
  });

  it("lowering max_waves below current wave forces LAST immediately", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-lower-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-lower";
    armUlwCycle(sid, "task", { cycle: 1, maxWaves: 10 });
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "w1",
      editCount: 1,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "w2",
      editCount: 2,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    assert.equal(loadUlwCycle(sid)?.wave, 2);
    // Immediate LAST when cap is under current wave (no wait for next Stop)
    setMaxWaves(sid, 1);
    assert.equal(loadUlwCycle(sid)?.cycle, 0);
    assert.equal(loadUlwCycle(sid)?.wave, 2); // no overshoot
    const d = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "try continue",
      editCount: 3,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    // Already LAST — stop-guard still re-anchors until attestation
    assert.equal(d.block, true);
    assert.equal(loadUlwCycle(sid)?.cycle, 0);
    assert.equal(loadUlwCycle(sid)?.wave, 2); // no overshoot
  });

  it("cycle=1 blocks Stop and increments wave", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-sess-1";
    armUlwCycle(sid, "improve the code", { cycle: 1 });

    const d1 = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "I improved a few things. Done for now.",
      editCount: 1,
      openTodoCount: 0,
      stuckThreshold: 10,
    });
    assert.equal(d1.block, true);
    assert.match(d1.reanchor || "", /cycle=1|CONTINUE/i);
    assert.match(d1.reanchor || "", /wave=1/);
    assert.match(d1.reanchor || "", /Live mid-run|\/cycle 0/);

    const st = loadUlwCycle(sid)!;
    assert.equal(st.wave, 1);
    assert.equal(st.cycle, 1);
    assert.equal(formatUlwCounts(st), "cycle=1 wave=1 blocks=1");
    assert.equal(formatUlwBadge(st), "c=1 w=1 b=1");
  });

  it("status and live hint surface counts for users", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-hint-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-hint";
    const s = armUlwCycle(sid, "improve", { cycle: 1 });
    const status = formatUlwStatus(s);
    assert.match(status, /cycle=1 wave=0 blocks=0/);
    assert.match(status, /Live mid-run/);
    assert.match(ULW_LIVE_CONTROLS_HINT, /\/cycle 0/);
    assert.match(ULW_LIVE_CONTROLS_HINT, /\/ulw-off/);
    assert.match(ULW_LIVE_CONTROLS_HINT, /\/budget/);
    assert.match(ULW_LIVE_CONTROLS_HINT, /\/notify/);
    assert.match(ULW_LIVE_CONTROLS_HINT, /\/done/);
  });

  it("cycle=0 releases only on Cycle complete attestation", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw2-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-sess-2";
    armUlwCycle(sid, "improve the code", { cycle: 1 });
    setCycleFlag(sid, 0);

    const blocked = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "I think we're good.",
      editCount: 2,
      openTodoCount: 0,
      stuckThreshold: 10,
    });
    assert.equal(blocked.block, true);
    assert.match(blocked.reanchor || "", /LAST|Cycle complete/i);

    const done = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "**Cycle complete.**\nShipped X, tests pass.",
      editCount: 3,
      openTodoCount: 0,
      stuckThreshold: 10,
    });
    assert.equal(done.block, false);
    assert.equal(done.lastCycleReleased, true);
    assert.equal(loadUlwCycle(sid)?.enabled, false);
  });

  it("stuck-wall releases without progress", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw3-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-stuck";
    armUlwCycle(sid, "fix forever", { cycle: 1 });
    let last;
    for (let i = 0; i < 3; i++) {
      last = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "still thinking",
        editCount: 0,
        openTodoCount: 0,
        stuckThreshold: 3,
      });
    }
    assert.equal(last!.block, false);
    assert.equal(last!.stuckReleased, true);
  });

  it("stop-guard integrates ULW cycle", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw4-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-sg";
    armUlwCycle(sid, "improve the code", { cycle: 1 });
    const config = {
      ...DEFAULT_CONFIG,
      blockingStopHooks: true,
      compatClaudeHooks: false,
      compatCursorHooks: false,
      goal: { ...DEFAULT_CONFIG.goal, enabled: false },
    };
    const hooks = new HookRunner(config, tmp);
    const r = await runStopGuard({
      config,
      hooks,
      ctx: { sessionId: sid, cwd: tmp, workspaceRoot: tmp },
      ultrawork: true,
      openTodoCount: 0,
      editCount: 1,
      lastAssistantMessage: "Stopping early.",
    });
    assert.equal(r.allowStop, false);
    assert.ok(r.ulw?.block);
    disarmUlwCycle(sid);
  });

  it("forkSession copies ULW + goal harness sidecars", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fork-harness-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    s.meta.ultrawork = true;
    armUlwCycle(s.meta.id, "ship the feature", { cycle: 1 });
    setCycleFlag(s.meta.id, 1);
    armGoal(s.meta.id, "all tests green");
    const forked = forkSession(s, { title: "branch" });
    const ulw = loadUlwCycle(forked.meta.id);
    assert.ok(ulw);
    assert.equal(ulw!.enabled, true);
    assert.equal(ulw!.cycle, 1);
    assert.equal(ulw!.sessionId, forked.meta.id);
    assert.match(ulw!.mandate, /ship the feature/);
    // Source still has its own state
    assert.equal(loadUlwCycle(s.meta.id)?.sessionId, s.meta.id);

    const g = loadGoal(forked.meta.id);
    assert.ok(g);
    assert.equal(g!.status, "active");
    assert.match(g!.objective, /tests green/);
    assert.equal(g!.sessionId, forked.meta.id);

    // Direct copy helpers are idempotent for missing source
    assert.equal(copyUlwCycle("missing", forked.meta.id), null);
    assert.equal(copyGoal("missing", forked.meta.id), null);
  });

  it("clearConversation resets ULW/goal stuck-wall baselines", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-clear-stuck-"));
    process.env.FORGE_HOME = tmp;
    const { clearConversation } = await import("../src/session/session.js");
    const s = createSession({ cwd: tmp, provider: "xai", model: "m" });
    armUlwCycle(s.meta.id, "keep going", { cycle: 1 });
    armGoal(s.meta.id, "ship it");
    // Simulate prior Stop blocks that advanced lastBlockEditCount
    evaluateUlwAtStop({
      sessionId: s.meta.id,
      lastAssistantMessage: "still working",
      editCount: 9,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    assert.equal(loadUlwCycle(s.meta.id)?.lastBlockEditCount, 9);
    // Goal path
    const { evaluateGoalAtStop } = await import("../src/harness/goal.js");
    evaluateGoalAtStop({
      sessionId: s.meta.id,
      lastAssistantMessage: "still working",
      editCount: 9,
      stuckThreshold: 20,
      enabled: true,
    });
    assert.equal(loadGoal(s.meta.id)?.lastBlockEditCount, 9);

    s.meta.editCount = 9;
    clearConversation(s);
    assert.equal(s.meta.editCount, 0);
    assert.equal(loadUlwCycle(s.meta.id)?.lastBlockEditCount, 0);
    assert.equal(loadUlwCycle(s.meta.id)?.stuckBlocks, 0);
    assert.equal(loadGoal(s.meta.id)?.lastBlockEditCount, 0);
    assert.equal(loadGoal(s.meta.id)?.stuckBlocks, 0);
    // Fresh edits should count as progress again (stuckBlocks stays 0)
    const d = evaluateUlwAtStop({
      sessionId: s.meta.id,
      lastAssistantMessage: "did one edit",
      editCount: 1,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    assert.equal(d.block, true);
    assert.equal(loadUlwCycle(s.meta.id)?.stuckBlocks, 0); // progressed
  });
});

describe("ulw wave ledger + quality bar", () => {
  it("records factual wave entries at each boundary", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-ledger-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-ledger";
    armUlwCycle(sid, "harden the cli", { cycle: 1 });

    const d1 = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "shipped input validation",
      editCount: 5,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationRan: true,
    });
    assert.equal(d1.block, true);
    let st = loadUlwCycle(sid)!;
    assert.equal(st.waves!.length, 1);
    assert.equal(st.waves![0].wave, 1);
    assert.equal(st.waves![0].editDelta, 5);
    assert.equal(st.waves![0].proof, true);
    assert.match(st.waves![0].summary, /input validation/);

    const d2 = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "tweaked a comment",
      editCount: 6,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    st = loadUlwCycle(sid)!;
    assert.equal(st.waves!.length, 2);
    assert.equal(st.waves![1].editDelta, 1);
    assert.equal(st.waves![1].proof, false);
    assert.equal(st.thinStreak, 1);
    // Re-anchor anchors the bar to the best proven wave and demands proof
    assert.match(d2.reanchor || "", /best wave so far w1/);
    assert.match(d2.reanchor || "", /ran no verification/);
  });

  it("detectWaveProof trusts execution over prose", () => {
    assert.equal(detectWaveProof("all good", true), true);
    assert.equal(detectWaveProof("ran npm test — 42 passed", false), true);
    assert.equal(detectWaveProof("tsc clean", false), true);
    assert.equal(detectWaveProof("improved naming", false), false);
    assert.equal(hasAttestationEvidence("**Cycle complete.** done", false), false);
    assert.equal(
      hasAttestationEvidence("**Cycle complete.**\n✅ npm test — 42 passed", false),
      true,
    );
    assert.equal(
      hasAttestationEvidence("**Cycle complete.**\nShipped X, tests pass.", false),
      true,
    );
    assert.equal(hasAttestationEvidence("weak claim", true), true);
  });

  it("VERIFICATION_CMD_RE matches check commands, not prose commands", () => {
    assert.ok(VERIFICATION_CMD_RE.test("npm test"));
    assert.ok(VERIFICATION_CMD_RE.test("npm run typecheck"));
    assert.ok(VERIFICATION_CMD_RE.test("cargo test"));
    assert.ok(VERIFICATION_CMD_RE.test("pytest -q"));
    assert.ok(VERIFICATION_CMD_RE.test("npx tsc --noEmit"));
    assert.ok(!VERIFICATION_CMD_RE.test("ls -la"));
    assert.ok(!VERIFICATION_CMD_RE.test("git status"));
    assert.ok(!VERIFICATION_CMD_RE.test("npm install"));
  });

  it("demands proof after proof-less waves, then caps the demands", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-proof-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-proof-cap";
    armUlwCycle(sid, "improve", { cycle: 1 });

    const stop = (editCount: number) =>
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "did some edits",
        editCount,
        openTodoCount: 0,
        stuckThreshold: 50,
      });

    const d1 = stop(2);
    assert.equal(d1.proofDemanded, true);
    assert.match(d1.reanchor || "", /ran no verification/);
    const d2 = stop(4);
    assert.equal(d2.proofDemanded, true);
    // Cap reached (MAX_PROOF_DEMANDS = 2): a stated rationale is accepted
    const d3 = stop(6);
    assert.equal(d3.proofDemanded, false);
    assert.doesNotMatch(d3.reanchor || "", /ran no verification/);
    assert.equal(loadUlwCycle(sid)!.proofDemands, 2);

    // A wave with real proof resets the demand counter
    const d4 = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "added tests",
      editCount: 9,
      openTodoCount: 0,
      stuckThreshold: 50,
      verificationRan: true,
    });
    assert.equal(d4.proofDemanded, false);
    assert.equal(loadUlwCycle(sid)!.proofDemands, 0);
    assert.equal(loadUlwCycle(sid)!.thinStreak, 0); // proven wave is never thin
  });

  it("thin waves escalate wording, then surface a diminishing-returns advisory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-thin-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-thin";
    armUlwCycle(sid, "improve", { cycle: 1 });

    const stop = (editCount: number) =>
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "minor tweak",
        editCount,
        openTodoCount: 0,
        stuckThreshold: 50,
      });

    const d1 = stop(1); // streak 1
    assert.equal(d1.thinStreakAdvisory, false);
    assert.doesNotMatch(d1.reanchor || "", /thinning/);
    const d2 = stop(2); // streak 2 → escalation wording
    assert.equal(d2.thinStreakAdvisory, false);
    assert.match(d2.reanchor || "", /thinning/);
    const d3 = stop(3); // streak 3 → user-visible advisory
    assert.equal(d3.thinStreakAdvisory, true);
    assert.match(formatUlwStatus(loadUlwCycle(sid)), /Diminishing returns/);
  });

  it("every 4th wave is a consolidation wave", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-consol-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-consol";
    armUlwCycle(sid, "improve", { cycle: 1 });

    const decisions = [10, 12, 14, 16].map((editCount) =>
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "shipped a bounded fix",
        editCount,
        openTodoCount: 0,
        stuckThreshold: 50,
        verificationRan: true,
      }),
    );
    assert.doesNotMatch(decisions[0].reanchor || "", /CONSOLIDATION WAVE/);
    assert.doesNotMatch(decisions[1].reanchor || "", /CONSOLIDATION WAVE/);
    assert.doesNotMatch(decisions[2].reanchor || "", /CONSOLIDATION WAVE/);
    assert.match(decisions[3].reanchor || "", /CONSOLIDATION WAVE/);
    // Consolidation waves forbid new scope
    assert.match(decisions[3].reanchor || "", /no new scope/i);
  });

  it("bounces a weak cycle=0 attestation once, then releases (never a trap)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-evid-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-evidence";
    armUlwCycle(sid, "improve the code", { cycle: 1 });
    setCycleFlag(sid, 0);

    const weak = "**Cycle complete.** all wrapped up";
    const d1 = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: weak,
      editCount: 1,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    assert.equal(d1.block, true);
    assert.equal(d1.evidenceDemanded, true);
    assert.match(d1.reanchor || "", /attestation needs evidence/);

    // Second weak attestation still releases — evidence demands are capped,
    // never an infinite trap.
    const d2 = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: weak,
      editCount: 1,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    assert.equal(d2.block, false);
    assert.equal(d2.lastCycleReleased, true);
  });

  it("attestation with machine-checkable evidence releases immediately", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-evok-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-evidence-ok";
    armUlwCycle(sid, "improve the code", { cycle: 1 });
    setCycleFlag(sid, 0);

    const done = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "**Cycle complete.**\n✅ npm test — 12 passed",
      editCount: 2,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    assert.equal(done.block, false);
    assert.equal(done.lastCycleReleased, true);
    assert.equal(done.evidenceDemanded, undefined);
  });

  it("status renders the ledger, the bar, and counters", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-stat-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-status-ledger";
    armUlwCycle(sid, "improve", { cycle: 1 });
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "big wave",
      editCount: 5,
      openTodoCount: 0,
      stuckThreshold: 50,
      verificationRan: true,
    });
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "tiny wave",
      editCount: 6,
      openTodoCount: 0,
      stuckThreshold: 50,
    });

    const st = loadUlwCycle(sid)!;
    assert.equal(formatWaveLedger(st.waves), "w1 +5e ✓ · w2 +1e ✗");
    const status = formatUlwStatus(st);
    assert.match(status, /Recent waves: w1 \+5e ✓ · w2 \+1e ✗/);
    assert.match(status, /Best wave \(the bar to match\/beat\): w1/);
  });

  it("bestWave prefers proven waves, then largest edit delta", () => {
    assert.equal(bestWave(undefined), null);
    assert.equal(bestWave([]), null);
    const best = bestWave([
      { wave: 1, editDelta: 2, proof: true, summary: "", ts: "" },
      { wave: 2, editDelta: 9, proof: false, summary: "", ts: "" },
      { wave: 3, editDelta: 4, proof: true, summary: "", ts: "" },
    ]);
    assert.equal(best!.wave, 3); // proven pool beats bigger unproven wave
    const unproven = bestWave([
      { wave: 1, editDelta: 2, proof: false, summary: "", ts: "" },
      { wave: 2, editDelta: 9, proof: false, summary: "", ts: "" },
    ]);
    assert.equal(unproven!.wave, 2);
  });

  it("fork clones the wave ledger without sharing the array", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-forkled-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-fork-ledger";
    armUlwCycle(sid, "improve", { cycle: 1 });
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "wave one",
      editCount: 3,
      openTodoCount: 0,
      stuckThreshold: 50,
      verificationRan: true,
    });

    copyUlwCycle(sid, "ulw-fork-ledger-2")!;
    assert.equal(loadUlwCycle("ulw-fork-ledger-2")!.waves!.length, 1);
    assert.equal(loadUlwCycle("ulw-fork-ledger-2")!.thinStreak, 0);

    // Source advances — fork ledger must not change (no shared reference)
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "wave two",
      editCount: 6,
      openTodoCount: 0,
      stuckThreshold: 50,
      verificationRan: true,
    });
    assert.equal(loadUlwCycle(sid)!.waves!.length, 2);
    assert.equal(loadUlwCycle("ulw-fork-ledger-2")!.waves!.length, 1);
  });

  it("stop-guard passes verificationRan into the wave ledger", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-sgp-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-sg-proof";
    armUlwCycle(sid, "improve the code", { cycle: 1 });
    const config = {
      ...DEFAULT_CONFIG,
      blockingStopHooks: true,
      compatClaudeHooks: false,
      compatCursorHooks: false,
      goal: { ...DEFAULT_CONFIG.goal, enabled: false },
    };
    const hooks = new HookRunner(config, tmp);
    const r = await runStopGuard({
      config,
      hooks,
      ctx: { sessionId: sid, cwd: tmp, workspaceRoot: tmp },
      ultrawork: true,
      openTodoCount: 0,
      editCount: 4,
      lastAssistantMessage: "added tests",
      verificationRan: true,
    });
    assert.equal(r.allowStop, false);
    assert.equal(loadUlwCycle(sid)!.waves![0].proof, true);
    disarmUlwCycle(sid);
  });

  it("maybeFlipUlwToLastOnSafetyValve flips CONTINUE → LAST", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-cost-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-cost-cap";
    armUlwCycle(sid, "improve the code", { cycle: 1 });
    assert.equal(loadUlwCycle(sid)!.cycle, 1);
    const flipped = maybeFlipUlwToLastOnSafetyValve(sid);
    assert.ok(flipped);
    assert.equal(flipped!.cycle, 0);
    assert.equal(loadUlwCycle(sid)!.cycle, 0);
    // Already LAST — no-op
    assert.equal(maybeFlipUlwToLastOnSafetyValve(sid), null);
    // Alias still works
    armUlwCycle(sid, "again", { cycle: 1 });
    assert.ok(maybeFlipUlwToLastOnCostCap(sid));
    assert.equal(loadUlwCycle(sid)!.cycle, 0);
    disarmUlwCycle(sid);
    // Disarmed — no-op
    assert.equal(maybeFlipUlwToLastOnSafetyValve(sid), null);
  });

  it("maybeFlipUlwToLastOnSafetyValve clears soft TodoGate fires", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-todo-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-todo-clear";
    const {
      evaluateTodoGateAtStop,
      clearTodoGateState,
      getTodoGateFires,
    } = await import("../src/harness/todo-gate.js");
    armUlwCycle(sid, "improve", { cycle: 1 });
    clearTodoGateState(sid);
    evaluateTodoGateAtStop({
      sessionId: sid,
      ulwEnabled: false,
      ultraworkFlag: false,
      openTodoCount: 1,
      lastAssistantMessage: "stop",
    });
    assert.ok(getTodoGateFires(sid) >= 1);
    assert.ok(maybeFlipUlwToLastOnSafetyValve(sid));
    assert.equal(getTodoGateFires(sid), 0);
    disarmUlwCycle(sid);
  });
});
