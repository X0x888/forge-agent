import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HookRunner } from "../src/harness/hooks.js";
import { runStopGuard } from "../src/harness/stop-guard.js";
import { armGoal } from "../src/harness/goal.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

describe("stop-guard composition", () => {
  it("blocks on active goal without attestation", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sg-"));
    process.env.FORGE_HOME = tmp;
    const sid = "sg-session";
    armGoal(sid, "finish the feature completely", "manual");

    const config = {
      ...DEFAULT_CONFIG,
      blockingStopHooks: true,
      compatClaudeHooks: false,
      compatCursorHooks: false,
      goal: { ...DEFAULT_CONFIG.goal, enabled: true, stuckThreshold: 5 },
    };
    const hooks = new HookRunner(config, tmp);

    const r = await runStopGuard({
      config,
      hooks,
      ctx: {
        sessionId: sid,
        cwd: tmp,
        workspaceRoot: tmp,
      },
      ultrawork: true,
      openTodoCount: 0,
      editCount: 1,
      lastAssistantMessage: "I made some progress and will stop here.",
    });
    assert.equal(r.allowStop, false);
    assert.ok(r.additionalContext?.includes("finish the feature"));
  });

  it("blocks ultrawork when todos remain", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sg2-"));
    process.env.FORGE_HOME = tmp;
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
      ctx: { sessionId: "x", cwd: tmp, workspaceRoot: tmp },
      ultrawork: true,
      openTodoCount: 2,
      editCount: 0,
      lastAssistantMessage: "Stopping for now.",
    });
    assert.equal(r.allowStop, false);
    assert.match(r.reason || "", /open todo/i);
  });

  it("allows stop when goal attested", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sg3-"));
    process.env.FORGE_HOME = tmp;
    const sid = "sg-done";
    armGoal(sid, "done task", "manual");
    const config = {
      ...DEFAULT_CONFIG,
      blockingStopHooks: true,
      compatClaudeHooks: false,
      compatCursorHooks: false,
    };
    const hooks = new HookRunner(config, tmp);
    const r = await runStopGuard({
      config,
      hooks,
      ctx: { sessionId: sid, cwd: tmp, workspaceRoot: tmp },
      ultrawork: false,
      openTodoCount: 0,
      editCount: 3,
      lastAssistantMessage: "**Goal achieved.**\n✅ done task — verified",
    });
    assert.equal(r.allowStop, true);
  });

  it("blocks premature handoff under ultrawork", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sg-ho-"));
    process.env.FORGE_HOME = tmp;
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
      ctx: { sessionId: "ho1", cwd: tmp, workspaceRoot: tmp },
      ultrawork: true,
      openTodoCount: 0,
      editCount: 2,
      lastAssistantMessage:
        "I made progress on the parser. Let me know if you want me to continue with the tests.",
    });
    assert.equal(r.allowStop, false);
    assert.ok(r.handoff?.block);
    assert.match(r.reason || "", /handoff-guard/i);
    assert.match(r.additionalContext || "", /Finish, don't hand off/i);
  });

  it("allows pure Q&A closer without driver", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sg-qa-"));
    process.env.FORGE_HOME = tmp;
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
      ctx: { sessionId: "qa1", cwd: tmp, workspaceRoot: tmp },
      ultrawork: false,
      openTodoCount: 0,
      editCount: 0,
      lastAssistantMessage:
        "The flag is in config.toml under [agent]. Let me know if you have any questions.",
    });
    assert.equal(r.allowStop, true);
    assert.notEqual(r.handoff?.block, true);
  });

  it("blocks hard continue-ask even without driver", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sg-hc-"));
    process.env.FORGE_HOME = tmp;
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
      ctx: { sessionId: "hc1", cwd: tmp, workspaceRoot: tmp },
      ultrawork: false,
      openTodoCount: 0,
      editCount: 0,
      lastAssistantMessage:
        "I can wire up the retry path next. Shall I continue with the implementation?",
    });
    assert.equal(r.allowStop, false);
    assert.ok(r.handoff?.block);
  });

  it("releases handoff after block cap", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sg-cap-"));
    process.env.FORGE_HOME = tmp;
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
      ctx: { sessionId: "cap1", cwd: tmp, workspaceRoot: tmp },
      ultrawork: true,
      openTodoCount: 0,
      editCount: 1,
      lastAssistantMessage: "Stopping here for now — want me to keep going?",
      handoffBlocks: 3,
    });
    assert.equal(r.allowStop, true);
    assert.equal(r.handoff?.released, true);
  });

  it("soft TodoGate outside ULW sets todoGate and blocks once", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sg-soft-todo-"));
    process.env.FORGE_HOME = tmp;
    const { clearTodoGateState } = await import("../src/harness/todo-gate.js");
    clearTodoGateState("soft-todo-1");
    const config = {
      ...DEFAULT_CONFIG,
      blockingStopHooks: true,
      compatClaudeHooks: false,
      compatCursorHooks: false,
      goal: { ...DEFAULT_CONFIG.goal, enabled: false },
    };
    const hooks = new HookRunner(config, tmp);
    const r1 = await runStopGuard({
      config,
      hooks,
      ctx: { sessionId: "soft-todo-1", cwd: tmp, workspaceRoot: tmp },
      ultrawork: false,
      openTodoCount: 2,
      editCount: 0,
      lastAssistantMessage: "Done for now.",
    });
    assert.equal(r1.allowStop, false);
    assert.equal(r1.todoGate, true);
    assert.match(r1.reason || "", /once/i);
    // Second stop same session releases soft gate
    const r2 = await runStopGuard({
      config,
      hooks,
      ctx: { sessionId: "soft-todo-1", cwd: tmp, workspaceRoot: tmp },
      ultrawork: false,
      openTodoCount: 2,
      editCount: 0,
      lastAssistantMessage: "Still open but releasing.",
    });
    assert.equal(r2.allowStop, true);
  });

  it("proof-claim ignores failed verification runs (verificationPassed)", async () => {
    const { evaluateStopGuards } = await import("../src/harness/stop-guard.js");
    // Use evaluateProofClaimAtStop path via stop-guard if exported; else unit the mapping
    const { evaluateProofClaimAtStop } = await import(
      "../src/harness/proof-claim-guard.js"
    );
    // Failed run must not satisfy Done. after edits
    const failed = evaluateProofClaimAtStop({
      lastAssistantMessage: "Done.",
      verificationRan: false,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 2,
    });
    assert.equal(failed.block, true);
    // Successful run satisfies
    const ok = evaluateProofClaimAtStop({
      lastAssistantMessage: "Done.",
      verificationRan: true,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 2,
    });
    assert.equal(ok.block, false);
  });
});
