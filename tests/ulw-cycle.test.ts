import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  armUlwCycle,
  setCycleFlag,
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

  it("max_waves forces LAST when wave hits cap", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-cap-"));
    process.env.FORGE_HOME = tmp;
    const sid = "ulw-cap";
    armUlwCycle(sid, "ship three waves", { cycle: 1, maxWaves: 2 });

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

    const done = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "**Cycle complete.**\nShipped two waves.",
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

  it("lowering max_waves below current wave forces LAST on next Stop", () => {
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
    setMaxWaves(sid, 1);
    const d = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "try continue",
      editCount: 3,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    assert.equal(d.maxWavesHit, true);
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
