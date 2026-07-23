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
});
