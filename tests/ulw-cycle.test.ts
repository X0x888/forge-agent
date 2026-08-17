import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  armUlwCycle,
  setCycleFlag,
  scheduleCycleZeroStop,
  cycleZeroTargetWave,
  cycleZeroCurrentWave,
  maybeStampUlwWave,
  maybeFlipUlwToLastOnSafetyValve,
  stopBlockTripsContinueCap,
  maybeFlipUlwToLastOnCostCap,
  setMaxWaves,
  evaluateUlwAtStop,
  isSoftPrompt,
  isResumeFollowUp,
  isPlaceholderMandate,
  isArmableMandate,
  mandateFromUserText,
  PLACEHOLDER_MANDATE,
  adoptUlwMandate,
  maybeAdoptMandateFromUserTexts,
  reenableUlwCycle,
  expandUlwMandate,
  loadUlwCycle,
  saveUlwCycle,
  copyUlwCycle,
  parseCycleArg,
  parseMaxWavesArg,
  normalizeMaxWaves,
  disarmUlwCycle,
  formatUlwCounts,
  formatUlwBadge,
  formatUlwStatus,
  formatCappedWaveDoctrine,
  ulwKickoffMessage,
  detectWaveProof,
  hasAttestationEvidence,
  bestWave,
  formatWaveLedger,
  VERIFICATION_CMD_RE,
  ULW_LIVE_CONTROLS_HINT,
  summarizeWave,
  isPolishClassShip,
  isGlanceableClassShip,
  resolveUlwPhase,
  advanceUlwPhaseOnReading,
  shouldSkipOrient,
} from "../src/harness/ulw-cycle.js";
import { filterToolsForUlwPhase, citedPathsFromToolCalls } from "../src/agent/loop.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { TOOL_DEFINITIONS } from "../src/agent/tools/definitions.js";
import {
  appendMemoryRecord,
  loadDecisionMemory,
} from "../src/harness/decision-memory.js";
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
    assert.equal(isSoftPrompt("continue"), false);
    assert.equal(isSoftPrompt("keep going"), false);
  });

  it("evaluate-class general prompts get a written-reading doctrine, not tools-not-advice", () => {
    const mandate =
      "comprehensively evaluate this tool and then improve the ui and ux of it.";
    const { expanded } = expandUlwMandate(mandate);
    assert.match(expanded, /Evaluate-class|written reading|first verb/i);
    assert.match(expanded, /not.*advice/i);
    assert.doesNotMatch(
      expanded,
      /Execute Wave 1 in this turn — tools, not advice/,
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-eval-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-eval-cap";
    const s = armUlwCycle(sid, mandate, { cycle: 1, maxWaves: 2 });
    assert.equal(s.backlogRequired, false);
    assert.equal(s.judgmentRequired, true);
    const kick = ulwKickoffMessage(s);
    assert.match(kick, /max_waves=2/);
    assert.match(kick, /spend both|Wave 1: written|budget/i);
    assert.match(
      formatCappedWaveDoctrine(2, mandate),
      /evaluation|first verb/i,
    );
    assert.match(kick, /Mandate: comprehensively evaluate/);
    assert.doesNotMatch(kick, /ULW GOD MODE \(soft user signal/);
  });

  it("adopts a real mandate after /cycle placeholder arm", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-adopt-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-adopt";
    armUlwCycle(sid, PLACEHOLDER_MANDATE, {
      cycle: 1,
      skipCheckpoint: true,
    });
    {
      const mem = loadDecisionMemory(sid);
      assert.equal(
        mem.records.some((r) => /continue prior mandate/i.test(r.text)),
        false,
      );
    }
    assert.equal(isPlaceholderMandate(PLACEHOLDER_MANDATE), true);
    assert.equal(isPlaceholderMandate("improve the codebase"), false);
    assert.equal(isPlaceholderMandate(""), true);
    assert.equal(
      isPlaceholderMandate(
        "comprehensively evaluate this tool and then improve the ui and ux of it.",
      ),
      false,
    );
    assert.equal(isArmableMandate("improve the codebase"), true);
    assert.equal(isArmableMandate("thanks"), false);
    assert.equal(isArmableMandate("sounds good!"), false);
    assert.equal(
      isArmableMandate("what do you think about the landing page?"),
      false,
    );
    const kick = [
      "## ULW armed",
      "Mandate: comprehensively evaluate this tool and then improve the ui.",
      "God-mode protocol is in the system prompt — do not re-derive it.",
    ].join("\n");
    assert.equal(isArmableMandate(kick), false);
    assert.match(
      mandateFromUserText(kick) || "",
      /comprehensively evaluate this tool/,
    );
    assert.equal(mandateFromUserText("ok thanks"), null);
    const next = adoptUlwMandate(
      sid,
      "comprehensively evaluate this tool and then improve the ui and ux of it.",
    );
    assert.ok(next);
    assert.match(next!.mandate, /evaluate this tool/);
    assert.equal(next!.judgmentRequired, true);
    assert.equal(next!.backlogRequired, false);
    assert.equal(next!.wave, 0);
    const ignore = adoptUlwMandate(sid, "now polish the footer");
    assert.equal(ignore!.mandate, next!.mandate);
    const ack = adoptUlwMandate(sid, "sounds good!");
    assert.equal(ack!.mandate, next!.mandate);
  });

  it("does not let steering overwrite a real /ulw default mandate", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-nosteal-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-nosteal";
    armUlwCycle(sid, "improve the codebase", {
      cycle: 1,
      skipCheckpoint: true,
    });
    const stay = adoptUlwMandate(
      sid,
      "comprehensively evaluate this tool and then improve the ui.",
    );
    assert.equal(stay!.mandate, "improve the codebase");
  });

  it("adopts a placeholder mandate from a mid-run interjection", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-ij-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-ij-adopt";
    armUlwCycle(sid, PLACEHOLDER_MANDATE, {
      cycle: 1,
      skipCheckpoint: true,
    });
    const skip = maybeAdoptMandateFromUserTexts(sid, [
      "thanks",
      "what do you think about the footer?",
    ]);
    assert.equal(skip!.mandate, PLACEHOLDER_MANDATE);
    const next = maybeAdoptMandateFromUserTexts(sid, [
      "ok",
      "comprehensively evaluate this tool and then improve the ui.",
    ]);
    assert.match(next!.mandate, /evaluate this tool/);
    assert.equal(next!.judgmentRequired, true);
  });

  it("re-enables a stuck-wall sidecar instead of naming the mandate continue", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-revive-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-revive";
    armUlwCycle(
      sid,
      "comprehensively evaluate this tool and then improve the ui.",
      { cycle: 1, skipCheckpoint: true },
    );
    disarmUlwCycle(sid);
    assert.equal(loadUlwCycle(sid)?.enabled, false);
    assert.equal(reenableUlwCycle(sid)?.enabled, true);
    assert.match(loadUlwCycle(sid)!.mandate, /evaluate this tool/);
    armUlwCycle(sid + "-ph", PLACEHOLDER_MANDATE, {
      cycle: 1,
      skipCheckpoint: true,
    });
    disarmUlwCycle(sid + "-ph");
    assert.equal(reenableUlwCycle(sid + "-ph"), null);
  });

  it("/cycle 1 after stuck-wall resumes the sidecar instead of re-arming", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-cycle-resume-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-cycle-resume";
    armUlwCycle(sid, "comprehensively evaluate this tool and then improve the ui.", {
      cycle: 1,
      maxWaves: 4,
      skipCheckpoint: true,
    });
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "Reading: ship the dock. Wave shipped.",
      editCount: 3,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationRan: true,
      verificationPassed: true,
    });
    assert.equal(loadUlwCycle(sid)?.wave, 1);
    disarmUlwCycle(sid);
    const next = setCycleFlag(sid, 1);
    assert.ok(next);
    assert.equal(next!.enabled, true);
    assert.equal(next!.cycle, 1);
    assert.equal(next!.wave, 1);
    assert.equal(next!.maxWaves, 4);
    assert.match(next!.mandate, /evaluate this tool/);
    assert.equal(setCycleFlag(sid, 0)?.enabled, true);
    armUlwCycle(sid + "-ph", PLACEHOLDER_MANDATE, {
      cycle: 1,
      skipCheckpoint: true,
    });
    const pending = formatUlwStatus(loadUlwCycle(sid + "-ph"));
    assert.match(pending, /pending work-order/);
    assert.doesNotMatch(pending, /continue prior mandate/);
  });

  it("judgment gate blocks wave-0 Stop until a Reading exists, then releases", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-judge-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-judge";
    armUlwCycle(
      sid,
      "comprehensively evaluate this tool and then improve the ui.",
      { cycle: 1, maxWaves: 2 },
    );
    const blocked = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "shipping chrome now",
      editCount: 1,
      openTodoCount: 2,
      stuckThreshold: 20,
    });
    assert.equal(blocked.block, true);
    assert.equal(blocked.waveClosed, undefined);
    assert.match(blocked.reanchor || "", /written reading|Reading:/i);
    assert.equal(loadUlwCycle(sid)?.wave, 0);

    const after = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage:
        "Reading: highest-leverage work is the missing /verbose catalog plus dock-is-HUD chrome.",
      editCount: 1,
      openTodoCount: 2,
      stuckThreshold: 20,
    });
    assert.equal(after.block, true);
    assert.equal(after.waveClosed, true);
    assert.equal(loadUlwCycle(sid)?.wave, 1);
    assert.equal(loadUlwCycle(sid)?.judgmentRequired, false);
  });

  it("detects resume follow-ups that must not replace the mandate", () => {
    assert.equal(isResumeFollowUp("continue"), true);
    assert.equal(isResumeFollowUp("Continue."), true);
    assert.equal(isResumeFollowUp("keep going"), true);
    assert.equal(isResumeFollowUp("resume"), true);
    assert.equal(isResumeFollowUp("ok"), true);
    assert.equal(isResumeFollowUp("improve the code"), false);
    assert.equal(isResumeFollowUp("continue the auth refactor"), false);
  });

  it("expands soft mandates to smart god-mode (subagents + anti-thrash)", () => {
    const { soft, expanded } = expandUlwMandate("improve the code");
    assert.equal(soft, true);
    assert.match(expanded, /GOD MODE|god-mode/i);
    assert.match(expanded, /Smart \+ hard|IQ-class|leverage/i);
    assert.match(expanded, /Subagents|spawn_subagent/i);
    assert.match(expanded, /proactive|whenever/i);
    assert.match(expanded, /Skip when|overhead/i);
    assert.match(expanded, /Doctrine, not a cage|philosophy/i);
    assert.match(expanded, /do \*\*not\*\* ask|do not ask/i);
    assert.match(expanded, /token|waste|thrash/i);
  });

  it("hard mandates still get smart god-mode rails", () => {
    const { soft, expanded } = expandUlwMandate(
      "add a /health endpoint and make npm test pass",
    );
    assert.equal(soft, false);
    assert.match(expanded, /User mandate:/);
    assert.match(expanded, /god-mode/i);
    assert.match(expanded, /Subagents|spawn_subagent|proactive/i);
    assert.match(expanded, /Smart \+ hard|leverage/i);
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

  it("unlimited CONTINUE Stop-blocks do not trip the continue cap (log10)", () => {
    assert.equal(
      stopBlockTripsContinueCap({
        enabled: true,
        cycle: 1,
        maxWaves: null,
      }),
      false,
    );
    assert.equal(
      stopBlockTripsContinueCap({
        enabled: true,
        cycle: 1,
        maxWaves: 12,
      }),
      true,
    );
    assert.equal(
      stopBlockTripsContinueCap({
        enabled: true,
        cycle: 0,
        maxWaves: null,
      }),
      true,
    );
    assert.equal(stopBlockTripsContinueCap(null), true);
    assert.equal(
      stopBlockTripsContinueCap({ enabled: false, cycle: 1, maxWaves: null }),
      true,
    );
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
    assert.equal(d1.waveClosed, true);
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

  it("cycle=1 evaluate-class without a reading still blocks Cycle complete", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-ceil-noread-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-ceil-noread";
    armUlwCycle(
      sid,
      "comprehensively evaluate this tool and then improve the ui",
      { cycle: 1, maxWaves: 4, skipCheckpoint: true },
    );
    const d = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "**Cycle complete.**\n✅ npm test — 12 passed",
      editCount: 4,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationPassed: true,
    });
    assert.equal(d.block, true);
    assert.notEqual(d.lastCycleReleased, true);
    assert.equal(loadUlwCycle(sid)?.enabled, true);
    assert.equal(loadUlwCycle(sid)?.cycle, 1);
  });

  it("cycle=1 reading + proven work + Cycle complete does not release before the cap", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-budget-hold-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-budget-hold";
    armUlwCycle(
      sid,
      "comprehensively evaluate this tool and then improve the ui",
      { cycle: 1, maxWaves: 4, skipCheckpoint: true },
    );
    appendMemoryRecord(sid, {
      kind: "observation",
      text: "Reading: daily REPL trust beats leftover chrome — ship the dock.",
      source: "agent",
    });
    const d = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage:
        "Reading: daily REPL trust beats leftover chrome.\n**Cycle complete.**\n✅ npm test — 12 passed",
      editCount: 6,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationPassed: true,
    });
    assert.equal(d.block, true);
    assert.notEqual(d.lastCycleReleased, true);
    assert.equal(loadUlwCycle(sid)?.enabled, true);
    assert.equal(loadUlwCycle(sid)?.cycle, 1);
    const held = loadUlwCycle(sid);
    assert.ok((held?.waves ?? []).length >= 1, "declared ship must stamp the wave");
    assert.ok((held?.wave ?? 0) >= 1);
    assert.ok((held?.wave ?? 0) < 4);
    assert.match(d.reanchor || "", /refused|remain/i);
    assert.match(d.reanchor || "", /max_waves=4/);
  });

  it("cycle=1 unlimited Cycle complete does not release", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-uncapped-cc-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-uncapped-cc";
    armUlwCycle(sid, "improve the daily REPL", {
      cycle: 1,
      skipCheckpoint: true,
    });
    const d = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage:
        "**Cycle complete.**\n✅ npm test — 12 passed\nShip landed: dock.",
      editCount: 4,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationPassed: true,
    });
    assert.equal(d.block, true);
    assert.notEqual(d.lastCycleReleased, true);
    assert.equal(loadUlwCycle(sid)?.enabled, true);
    assert.equal(loadUlwCycle(sid)?.cycle, 1);
    assert.match(d.reanchor || "", /refused|CONTINUE/i);
  });

  it("max_waves=4 Cycle complete releases only after the cap auto-LAST", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-budget-spend-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-budget-spend";
    armUlwCycle(
      sid,
      "comprehensively evaluate this tool and then improve the ui",
      { cycle: 1, maxWaves: 4, skipCheckpoint: true },
    );
    appendMemoryRecord(sid, {
      kind: "observation",
      text: "Reading: first-run numbers — ship typeable 1–6.",
      source: "agent",
    });
    for (let i = 1; i <= 4; i++) {
      const d = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: `Ship landed: wave ${i} item.\n✅ npm test — 12 passed`,
        editCount: i * 3,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(d.block, true);
      assert.notEqual(d.lastCycleReleased, true);
      if (i < 4) {
        assert.equal(loadUlwCycle(sid)?.cycle, 1);
        assert.equal(d.maxWavesHit, undefined);
      } else {
        assert.equal(d.maxWavesHit, true);
        assert.equal(loadUlwCycle(sid)?.cycle, 0);
        assert.equal(loadUlwCycle(sid)?.wave, 4);
      }
    }
    const done = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage:
        "**Cycle complete.**\n✅ four ships — npm test: 12 passed",
      editCount: 13,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationPassed: true,
    });
    assert.equal(done.block, false);
    assert.equal(done.lastCycleReleased, true);
    assert.equal(loadUlwCycle(sid)?.enabled, false);
  });

  it("capped-wave doctrine spends the budget instead of inviting early Cycle complete", () => {
    const mandate =
      "comprehensively evaluate this tool and then improve the ui";
    const four = formatCappedWaveDoctrine(4, mandate);
    assert.match(four, /spend all 4/);
    assert.match(four, /refused/);
    assert.doesNotMatch(four, /ceiling/);
    assert.doesNotMatch(four, /verbs are done/);
    const two = formatCappedWaveDoctrine(2, mandate);
    assert.match(two, /spend both/);
    assert.match(two, /first verb/i);
    assert.doesNotMatch(two, /ceiling/);
  });

  it("cycle=1 does not treat a red check as Cycle complete evidence", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-ceil-red-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-ceil-red";
    armUlwCycle(
      sid,
      "comprehensively evaluate this tool and then improve the ui",
      { cycle: 1, maxWaves: 4, skipCheckpoint: true },
    );
    appendMemoryRecord(sid, {
      kind: "observation",
      text: "Reading: daily REPL trust beats leftover chrome — ship the dock.",
      source: "agent",
    });
    // First stop: proven wave lands in the ledger.
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage:
        "Reading: daily REPL trust.\nShip landed: dock.\nnpm test: 12 passed",
      editCount: 4,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationPassed: true,
    });
    assert.equal(loadUlwCycle(sid)?.enabled, true);
    assert.ok((loadUlwCycle(sid)?.waves ?? []).some((w) => w.proof));
    const d = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "**Cycle complete.** all wrapped up",
      editCount: 6,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationRan: true,
      verificationPassed: false,
    });
    assert.equal(d.block, true);
    assert.notEqual(d.lastCycleReleased, true);
    assert.equal(loadUlwCycle(sid)?.enabled, true);
    assert.equal(loadUlwCycle(sid)?.cycle, 1);
  });

  it("cycle=1 still blocks a yield ask; handoff-guard owns shall-I-continue", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-ceil-yield-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-ceil-yield";
    armUlwCycle(sid, "improve the daily REPL", {
      cycle: 1,
      skipCheckpoint: true,
    });
    const d = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "Want me to keep going?",
      editCount: 2,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationPassed: true,
    });
    assert.equal(d.block, true);
    assert.notEqual(d.lastCycleReleased, true);
    const { detectPrematureHandoff } = await import(
      "../src/harness/handoff-guard.js"
    );
    assert.equal(detectPrematureHandoff("Want me to keep going?").handoff, true);
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
    assert.equal(loadUlwCycle(s.meta.id)?.wave, 0);
    assert.equal(isPlaceholderMandate(loadUlwCycle(s.meta.id)!.mandate), true);
    assert.equal(loadDecisionMemory(s.meta.id).records.length, 0);
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

describe("summarizeWave", () => {
  it("prefers Reading over a mid-thought last sentence", () => {
    const s = summarizeWave(
      "LSP still reports the unused import — verifying.\n\n**Reading:** Forge's product is the interactive REPL. Daily-loop trust beats chrome.",
    );
    assert.match(s, /interactive REPL/);
    assert.doesNotMatch(s, /verifying/);
  });

  it("prefers Ship landed over Reading when both are present", () => {
    const s = summarizeWave(
      "**Reading:** Forge's product is the interactive REPL. Daily-loop trust beats chrome.\n\nShip landed: tables on the session picker",
    );
    assert.match(s, /tables on the session picker/);
    assert.doesNotMatch(s, /interactive REPL/);
  });

  it("falls back to decision-memory Reading when the closer is mid-thought", () => {
    const prev = process.env.FORGE_HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-sum-"));
    process.env.FORGE_HOME = tmp;
    try {
      const sid = "ulw-sum-mem";
      fs.mkdirSync(path.join(tmp, "sessions", sid), { recursive: true });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: "Reading: Forge's product is the interactive REPL + blocking harness. Daily-loop trust beats chrome.",
      });
      const s = summarizeWave(
        "LSP still reports the unused import — verifying the file actually dropped it.",
        sid,
      );
      assert.match(s, /interactive REPL/);
      assert.doesNotMatch(s, /verifying/);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps a short factual closer when there is no Reading", () => {
    assert.match(summarizeWave("shipped input validation"), /input validation/);
  });

  it("treats close-Wave mid-thought as a reading fallback", () => {
    const prev = process.env.FORGE_HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-sum2-"));
    process.env.FORGE_HOME = tmp;
    try {
      const sid = "ulw-sum-close";
      fs.mkdirSync(path.join(tmp, "sessions", sid), { recursive: true });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: "Reading: headless forge run hides failed-tool tails. Ship transcript parity.",
      });
      const s = summarizeWave(
        "The resume change is tiny; I'll re-run the dock test and close Wave 2.",
        sid,
      );
      assert.match(s, /headless forge run|transcript parity/);
      assert.doesNotMatch(s, /I'll re-run/);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("polish-class Stop", () => {
  it("matches last-verify / quieter / one-TTY-row leftovers", () => {
    assert.equal(isPolishClassShip("keep one TTY row"), true);
    assert.equal(isPolishClassShip("strip the last-verify dump from /model"), true);
    assert.equal(isPolishClassShip("quieter chip copy on the HUD"), true);
    assert.equal(
      isPolishClassShip("headless forge run failed-tool tails"),
      false,
    );
    assert.equal(isPolishClassShip("dock owns identity — slim the banner"), true);
    assert.equal(isPolishClassShip("dock overflow drops brand"), true);
    assert.equal(
      isGlanceableClassShip(
        "Wave 3 shipped: successful bash prints last 5 lines under the ✓ row",
      ),
      true,
    );
    assert.equal(
      isGlanceableClassShip("Wave 1 shipped: Ctrl+R incremental history search"),
      false,
    );
  });

  it("evaluate-class arms in orient and flips to ship on a reading", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-orient-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-orient";
    const s = armUlwCycle(
      sid,
      "comprehensively evaluate this tool and then improve the ui",
      { cycle: 1, skipCheckpoint: true },
    );
    assert.equal(resolveUlwPhase(s), "orient");
    assert.equal(
      filterToolsForUlwPhase(TOOL_DEFINITIONS, "orient").some(
        (t) => t.function.name === "spawn_subagent",
      ),
      false,
    );
    assert.equal(
      filterToolsForUlwPhase(TOOL_DEFINITIONS, "orient").some(
        (t) => t.function.name === "search_replace",
      ),
      false,
    );
    appendMemoryRecord(sid, {
      kind: "decision",
      text: "Reading: first-run numbers lie — ship typeable 1–6 on the setup card.",
      source: "agent",
    });
    assert.equal(advanceUlwPhaseOnReading(sid), true);
    assert.equal(resolveUlwPhase(loadUlwCycle(sid)), "ship");
    assert.ok(
      filterToolsForUlwPhase(TOOL_DEFINITIONS, "ship").some(
        (t) => t.function.name === "search_replace",
      ),
    );
    const again = armUlwCycle(
      sid,
      "comprehensively evaluate this tool and then improve the ui",
      { cycle: 1, skipCheckpoint: true },
    );
    assert.equal(resolveUlwPhase(again), "ship");
    assert.equal(shouldSkipOrient(again, sid), true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("orient hard-denies writes/spawn/mutating bash even under yolo", async () => {
    const gate = new PermissionGate({ interactive: false });
    const write = await gate.request({
      toolName: "search_replace",
      input: { path: "a.ts", old_string: "a", new_string: "b" },
      mode: "bypassPermissions",
      workspace: process.cwd(),
      ulwPhase: "orient",
    });
    assert.equal(write.decision, "deny");
    assert.match(write.reason || "", /ulw_orient/);

    const spawn = await gate.request({
      toolName: "spawn_subagent",
      input: { prompt: "map the tui", subagent_type: "explore" },
      mode: "bypassPermissions",
      workspace: process.cwd(),
      ulwPhase: "orient",
    });
    assert.equal(spawn.decision, "deny");

    const mut = await gate.request({
      toolName: "bash",
      input: { command: "sed -i '' 's/a/b/' a.ts" },
      mode: "bypassPermissions",
      workspace: process.cwd(),
      ulwPhase: "orient",
    });
    assert.equal(mut.decision, "deny");

    const ro = await gate.request({
      toolName: "bash",
      input: { command: "git status" },
      mode: "bypassPermissions",
      workspace: process.cwd(),
      ulwPhase: "orient",
    });
    assert.equal(ro.decision, "allow");

    const ship = await gate.request({
      toolName: "search_replace",
      input: { path: "a.ts", old_string: "a", new_string: "b" },
      mode: "bypassPermissions",
      workspace: process.cwd(),
      ulwPhase: "ship",
    });
    assert.equal(ship.decision, "allow");
  });

  it("later waves skip orient even if the sidecar still says orient", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-later-"));
    const prev = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
    try {
      const sid = "ulw-later-wave";
      armUlwCycle(
        sid,
        "comprehensively evaluate this tool and then improve the ui",
        { cycle: 1, skipCheckpoint: true },
      );
      appendMemoryRecord(sid, {
        kind: "decision",
        text: "Reading: first-run numbers lie — next ship typeable 1–6 on the setup card.",
        source: "agent",
      });
      assert.equal(advanceUlwPhaseOnReading(sid), true);
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "Wave 1 shipped. Reading: first-run numbers lie — ship typeable 1–6.",
        editCount: 2,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationRan: true,
        verificationPassed: true,
      });
      const s = loadUlwCycle(sid)!;
      assert.ok((s.wave ?? 0) >= 1);
      s.phase = "orient";
      s.judgmentRequired = true;
      assert.equal(resolveUlwPhase(s), "ship");
      assert.equal(shouldSkipOrient(s, sid), true);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("citedPathsFromToolCalls extracts path-like args", () => {
    assert.deepEqual(
      citedPathsFromToolCalls({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "1",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"src/tui/repl.ts"}',
            },
          },
        ],
      }),
      ["src/tui/repl.ts"],
    );
    assert.deepEqual(
      citedPathsFromToolCalls({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "2",
            type: "function",
            function: {
              name: "glob",
              arguments: '{"glob":"src/tui/*.ts"}',
            },
          },
        ],
      }),
      ["src/tui/*.ts"],
    );
  });

  it("Stop-boundary polish ships increment the streak and LAST at 4", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-polish-stop-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-polish-stop";
    armUlwCycle(sid, "improve the daily REPL", {
      cycle: 1,
      maxWaves: 10,
      skipCheckpoint: true,
    });
    for (let i = 1; i <= 4; i++) {
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: `Wave shipped. keep one TTY row on picker ${i}`,
        editCount: i,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationRan: true,
        verificationPassed: true,
      });
    }
    const s = loadUlwCycle(sid)!;
    assert.equal(s.polishStreak, 4);
    assert.equal(s.cycle, 0);
    assert.ok(s.wave >= 4);
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
    assert.match(d2.reanchor || "", /no successful verification|ran no verification/);
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
    assert.ok(VERIFICATION_CMD_RE.test("npm run smoke"));
    assert.ok(VERIFICATION_CMD_RE.test("cargo test"));
    assert.ok(VERIFICATION_CMD_RE.test("pytest -q"));
    assert.ok(VERIFICATION_CMD_RE.test("npx tsc --noEmit"));
    assert.ok(VERIFICATION_CMD_RE.test("mix test"));
    assert.ok(VERIFICATION_CMD_RE.test("turbo run test"));
    assert.ok(VERIFICATION_CMD_RE.test("turbo run typecheck"));
    assert.ok(VERIFICATION_CMD_RE.test("nx run-many -t test"));
    assert.ok(!VERIFICATION_CMD_RE.test("ls -la"));
    assert.ok(!VERIFICATION_CMD_RE.test("git status"));
    assert.ok(!VERIFICATION_CMD_RE.test("npm install"));
  });

  it("isVerificationCommand honors preferred project checks", async () => {
    const { isVerificationCommand } = await import(
      "../src/harness/ulw-cycle.js"
    );
    assert.ok(isVerificationCommand("npm test"));
    assert.ok(
      isVerificationCommand("npm run unit", ["npm run unit", "npm test"]),
    );
    assert.ok(
      isVerificationCommand("cd packages/core && npm run unit", [
        "npm run unit",
      ]),
    );
    assert.ok(!isVerificationCommand("npm run unit"));
    assert.ok(!isVerificationCommand("ls -la", ["npm test"]));
  });

  it("recognizes npx/bunx/forge and bare preferred scripts", async () => {
    const { isVerificationCommand } = await import(
      "../src/harness/ulw-cycle.js"
    );
    assert.ok(isVerificationCommand("npx tsc --noEmit"));
    assert.ok(isVerificationCommand("npx eslint ."));
    assert.ok(isVerificationCommand("bunx vitest run"));
    assert.ok(isVerificationCommand("forge check"));
    assert.ok(isVerificationCommand("npm run format-check"));
    assert.ok(isVerificationCommand("npm run unit", ["unit"]));
    assert.ok(isVerificationCommand("pnpm run typecheck", ["typecheck"]));
    assert.ok(!isVerificationCommand("git commit -m fix test"));
  });


  it("shouldStampLastVerification is success-only", async () => {
    const {
      shouldStampLastVerification,
      shouldClearLastVerification,
    } = await import("../src/harness/ulw-cycle.js");
    assert.equal(
      shouldStampLastVerification({ command: "npm test", isError: false }),
      true,
    );
    assert.equal(
      shouldStampLastVerification({ command: "npm test", isError: true }),
      false,
    );
    assert.equal(
      shouldStampLastVerification({ command: "ls -la", isError: false }),
      false,
    );
    assert.equal(
      shouldStampLastVerification({
        command: "npm run unit",
        isError: false,
        preferredCheckCommands: ["npm run unit"],
      }),
      true,
    );
    assert.equal(
      shouldStampLastVerification({
        command: "npm run unit",
        isError: true,
        preferredCheckCommands: ["npm run unit"],
      }),
      false,
    );
  });

  it("shouldClearLastVerification wipes trail on failed checks only", async () => {
    const { shouldClearLastVerification } = await import(
      "../src/harness/ulw-cycle.js"
    );
    assert.equal(
      shouldClearLastVerification({ command: "npm test", isError: true }),
      true,
    );
    assert.equal(
      shouldClearLastVerification({ command: "npm test", isError: false }),
      false,
    );
    assert.equal(
      shouldClearLastVerification({ command: "ls", isError: true }),
      false,
    );
  });

  it("applyVerificationTrail keeps a red npm test on the trail", async () => {
    const { applyVerificationTrail } = await import(
      "../src/harness/ulw-cycle.js"
    );
    const meta: {
      lastVerificationCommand?: string;
      lastVerificationOk?: boolean;
      lastVerificationExitCode?: number;
    } = { lastVerificationCommand: "npm test", lastVerificationOk: true };
    applyVerificationTrail(meta, { command: "npm test", isError: true });
    assert.equal(meta.lastVerificationCommand, "npm test");
    assert.equal(meta.lastVerificationOk, false);
    assert.equal(meta.lastVerificationExitCode, 1);
    applyVerificationTrail(meta, { command: "npm test", isError: false });
    assert.equal(meta.lastVerificationOk, true);
    assert.equal(meta.lastVerificationExitCode, 0);
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
    assert.match(d1.reanchor || "", /no successful verification|ran no verification/);
    const d2 = stop(4);
    assert.equal(d2.proofDemanded, true);
    // Cap reached (MAX_PROOF_DEMANDS = 2): a stated rationale is accepted
    const d3 = stop(6);
    assert.equal(d3.proofDemanded, false);
    assert.doesNotMatch(d3.reanchor || "", /no successful verification|ran no verification/);
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

  it("attestation evidence prefers verificationPassed over failed runs", async () => {
    const { hasAttestationEvidence } = await import("../src/harness/ulw-cycle.js");
    // hasAttestationEvidence itself still takes a boolean — callers pass passed.
    assert.equal(
      hasAttestationEvidence("**Cycle complete.**", false),
      false,
    );
    assert.equal(
      hasAttestationEvidence("**Cycle complete.**\n✅ tests 10 pass", false),
      true,
    );
    assert.equal(
      hasAttestationEvidence("**Cycle complete.**", true),
      true,
    );
  });

  it("proof-demand reanchor names preferred project checks", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-proof-pref-"));
    process.env.FORGE_HOME = tmp;
    const {
      armUlwCycle,
      evaluateUlwAtStop,
      saveUlwCycle,
      loadUlwCycle,
    } = await import("../src/harness/ulw-cycle.js");
    const sid = "ulw-proof-pref";
    armUlwCycle(sid, "ship it");
    // Force a continue wave with edits but no verification
    const s = loadUlwCycle(sid)!;
    s.cycle = 1;
    s.wave = 1;
    s.editCountAtArm = 0;
    saveUlwCycle(s);
    const r = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "I made some changes.",
      editCount: 3,
      openTodoCount: 0,
      stuckThreshold: 5,
      verificationRan: false,
      verificationPassed: false,
      preferredCheckCommands: ["npm test", "npm run typecheck"],
    });
    assert.equal(r.block, true);
    assert.match(String(r.reanchor || r.reason || ""), /npm test/);
    assert.match(String(r.reanchor || r.reason || ""), /no successful verification|proof NOW/i);
  });

  it("proof-demand distinguishes failed check vs never ran", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-proof-fail-"));
    process.env.FORGE_HOME = tmp;
    const {
      armUlwCycle,
      evaluateUlwAtStop,
      saveUlwCycle,
      loadUlwCycle,
    } = await import("../src/harness/ulw-cycle.js");
    const sid = "ulw-proof-fail";
    armUlwCycle(sid, "ship it");
    const s = loadUlwCycle(sid)!;
    s.cycle = 1;
    s.wave = 1;
    s.editCountAtArm = 0;
    saveUlwCycle(s);
    const failed = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "I made some changes.",
      editCount: 3,
      openTodoCount: 0,
      stuckThreshold: 5,
      verificationRan: true,
      verificationPassed: false,
      preferredCheckCommands: ["npm test"],
    });
    assert.equal(failed.block, true);
    assert.match(String(failed.reanchor || failed.reason || ""), /failed \(red\)|check failed/i);
    assert.match(String(failed.reanchor || failed.reason || ""), /npm test/);

    const never = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "Still working.",
      editCount: 4,
      openTodoCount: 0,
      stuckThreshold: 5,
      verificationRan: false,
      verificationPassed: false,
      preferredCheckCommands: ["npm test"],
    });
    assert.equal(never.block, true);
    assert.match(
      String(never.reanchor || never.reason || ""),
      /no successful verification|ran no/i,
    );
  });

  it("arming mid-session baselines the wave ledger at the current editCount", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-base-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-arm-baseline";
    // 40 edits happened before /ulw was armed — wave 1 must measure from here.
    const armed = armUlwCycle(sid, "improve the codebase", {
      cycle: 1,
      editCount: 40,
    });
    assert.equal(armed.lastBlockEditCount, 40);

    const d = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "Shipped wave 1; npm test passed.",
      editCount: 43,
      openTodoCount: 0,
      stuckThreshold: 5,
      verificationRan: true,
      verificationPassed: true,
    });
    assert.equal(d.block, true);
    const s = loadUlwCycle(sid)!;
    const w1 = s.waves![s.waves!.length - 1];
    assert.equal(w1.wave, 1);
    // Not 43 — pre-arm edits are not part of wave 1, so bestWave() anchors
    // the quality bar to work the cycle actually drove.
    assert.equal(w1.editDelta, 3);
    assert.equal(bestWave(s.waves)!.editDelta, 3);
  });

  it("arm without editCount keeps the legacy zero baseline", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-base0-"));
    process.env.FORGE_HOME = tmp;
    const s = armUlwCycle("ulw-arm-zero", "improve the codebase", { cycle: 1 });
    assert.equal(s.lastBlockEditCount, 0);
  });
});

describe("net-diff progress tracking (ULW)", () => {
  const base = (sid: string, over: Record<string, unknown> = {}) => ({
    sessionId: sid,
    lastAssistantMessage: "wave summary, no evidence cited",
    editCount: 0,
    openTodoCount: 0,
    stuckThreshold: 3,
    ...over,
  });

  it("bash-channel work (new diff, no edit-tool calls) counts as progress and is not thin", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-nd1-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-nd-progress";
    armUlwCycle(sid, "improve", { cycle: 1 });
    // wave 1: sets the fingerprint baseline (no edit calls, tree at fp-a)
    let d = evaluateUlwAtStop(base(sid, { diffFingerprint: "fp-a" }));
    assert.equal(d.block, true);
    // waves 2..4: editCount stays flat (bash heredocs/sed), but the working
    // tree keeps moving to NEW states — the stuck-wall must never engage.
    for (const fp of ["fp-b", "fp-c", "fp-d"]) {
      d = evaluateUlwAtStop(base(sid, { diffFingerprint: fp }));
      assert.equal(d.block, true);
      assert.equal(d.stuckReleased ?? false, false);
    }
    const s = loadUlwCycle(sid)!;
    assert.equal(s.stuckBlocks, 0);
    const last = s.waves![s.waves!.length - 1];
    assert.equal(last.editDelta, 0);
    assert.equal(last.netDiff, "new");
    // Real tree movement with no proof is not "thin" — only churn is.
    assert.equal(s.thinStreak ?? 0, 0);
  });

  it("edit→revert churn is a revisit: thin, excluded from bestWave", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-nd2-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-nd-churn";
    armUlwCycle(sid, "improve", { cycle: 1 });
    // w1: real work, baseline fp-1
    evaluateUlwAtStop(base(sid, { editCount: 5, diffFingerprint: "fp-1" }));
    // w2: more real work, new state fp-2
    evaluateUlwAtStop(base(sid, { editCount: 10, diffFingerprint: "fp-2" }));
    // w3: 5 edit CALLS but the tree is back at fp-1 (revert) — churn, not progress
    evaluateUlwAtStop(base(sid, { editCount: 15, diffFingerprint: "fp-1" }));
    const s = loadUlwCycle(sid)!;
    const w3 = s.waves![s.waves!.length - 1];
    assert.equal(w3.editDelta, 5);
    assert.equal(w3.netDiff, "revisit");
    assert.ok((s.thinStreak ?? 0) >= 1, "churn wave counts toward thinStreak");
    const best = bestWave(s.waves)!;
    assert.notEqual(best.wave, w3.wave, "churn wave must not anchor the bar");
    // Ledger marks the revisit for /cycle status transparency
    assert.match(formatWaveLedger(s.waves), /w3 \+5e↺/);
  });

  it("without fingerprints (non-git), flat editCount still hits the stuck-wall", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-nd3-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-nd-nogit";
    armUlwCycle(sid, "improve", { cycle: 1 });
    let released: boolean | undefined = false;
    for (let i = 0; i < 3; i++) {
      const d = evaluateUlwAtStop(base(sid, { diffFingerprint: null }));
      released = d.stuckReleased ?? false;
    }
    assert.equal(released, true, "editCount-only fallback preserves stuck-wall");
    assert.equal(loadUlwCycle(sid)!.enabled, false);
  });

  it("background bash never counts as verification (fire-and-forget observes no exit code)", async () => {
    const { countsTowardVerification } = await import(
      "../src/harness/ulw-cycle.js"
    );
    // The B2b hole: this exact call used to satisfy wave proof/attestations.
    assert.equal(
      countsTowardVerification({ command: "npm test", background: true }),
      false,
    );
    assert.equal(
      countsTowardVerification({ command: "npm test", background: "true" }),
      false,
    );
    // The alias + truthy-variant bypass (bash tool honors both keys via
    // isTruthy): every one of these spawns the same unobserved process.
    assert.equal(
      countsTowardVerification({ command: "npm test", run_in_background: true }),
      false,
    );
    assert.equal(
      countsTowardVerification({ command: "npm test", run_in_background: 1 }),
      false,
    );
    assert.equal(
      countsTowardVerification({ command: "npm test", background: "yes" }),
      false,
    );
    assert.equal(
      countsTowardVerification({ command: "npm test", background: 1 }),
      false,
    );
    // Foreground still counts (regex + preferred-command paths).
    assert.equal(
      countsTowardVerification({ command: "npm test", background: false }),
      true,
    );
    assert.equal(
      countsTowardVerification({ command: "npm test", background: "false" }),
      true,
    );
    assert.equal(countsTowardVerification({ command: "npm test" }), true);
    assert.equal(
      countsTowardVerification({ command: "npm run unit" }, ["npm run unit"]),
      true,
    );
    // Non-check commands and junk stay excluded.
    assert.equal(countsTowardVerification({ command: "ls -la" }), false);
    assert.equal(countsTowardVerification({ background: true }), false);
    assert.equal(countsTowardVerification({}), false);
  });
});

describe("/cycle 0 stop at N+1", () => {
  function withHome(fn: () => void): void {
    const prev = process.env.FORGE_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-c0-"));
    process.env.FORGE_HOME = dir;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("mid-wave at stamped w=42 stops at 44", () => {
    assert.equal(
      cycleZeroTargetWave(
        {
          wave: 42,
          lastProgressEditCount: 300,
          lastBlockEditCount: 300,
          maxWaves: null,
        },
        { editCount: 310 },
      ),
      44,
    );
    assert.equal(
      cycleZeroCurrentWave(
        { wave: 42, lastProgressEditCount: 300, lastBlockEditCount: 300 },
        { editCount: 310 },
      ),
      43,
    );
  });

  it("at a wave boundary stops at last-stamped + 1", () => {
    assert.equal(
      cycleZeroTargetWave(
        {
          wave: 43,
          lastProgressEditCount: 394,
          lastBlockEditCount: 394,
          maxWaves: null,
        },
        { editCount: 394 },
      ),
      44,
    );
  });

  it("wave 0 with no edits stops at 1", () => {
    assert.equal(
      cycleZeroTargetWave(
        { wave: 0, lastBlockEditCount: 0, maxWaves: null },
        { editCount: 0 },
      ),
      1,
    );
  });

  it("does not raise an existing tighter cap", () => {
    assert.equal(
      cycleZeroTargetWave(
        {
          wave: 3,
          lastProgressEditCount: 10,
          lastBlockEditCount: 10,
          maxWaves: 4,
        },
        { editCount: 12 },
      ),
      4,
    );
  });

  it("schedules CONTINUE with maxWaves=N+1 (maze: /cycle 0 mid-wave)", () => {
    withHome(() => {
      const sid = "c0-maze";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 300,
      });
      s0.wave = 42;
      s0.lastProgressEditCount = 300;
      s0.lastBlockEditCount = 300;
      saveUlwCycle(s0);
      const next = scheduleCycleZeroStop(sid, { editCount: 310 })!;
      assert.equal(next.cycle, 1);
      assert.equal(next.maxWaves, 44);
      assert.equal(next.cycleZeroStopAt, 44);
      assert.equal(next.wrapKind, undefined);
      assert.equal(next.enabled, true);

      maybeStampUlwWave({
        sessionId: sid,
        editCount: 320,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: "Wave shipped: finish the open wave.",
      });
      assert.equal(loadUlwCycle(sid)!.wave, 43);
      assert.equal(loadUlwCycle(sid)!.cycle, 1);

      maybeStampUlwWave({
        sessionId: sid,
        editCount: 330,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: "Wave shipped: the extra wave.",
      });
      const last = loadUlwCycle(sid)!;
      assert.equal(last.wave, 44);
      assert.equal(last.cycle, 0);
      assert.equal(last.wrapKind, "budget");
    });
  });

  it("/cycle 1 after a scheduled /cycle 0 clears the N+1 cap", () => {
    withHome(() => {
      const sid = "c0-resume";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
      });
      scheduleCycleZeroStop(sid, { editCount: 0 });
      assert.equal(loadUlwCycle(sid)!.maxWaves, 1);
      const resumed = setCycleFlag(sid, 1)!;
      assert.equal(resumed.cycle, 1);
      assert.equal(resumed.maxWaves, null);
      assert.equal(resumed.cycleZeroStopAt, undefined);
    });
  });
});
