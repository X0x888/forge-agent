import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  armUlwCycle,
  completeUlwPlan,
  loadUlwCycle,
  requestUlwReorient,
  resolveUlwPhase,
  closerRequestsReorient,
  markUlwPlanDone,
} from "../src/harness/ulw-cycle.js";
import { executeTool } from "../src/agent/tools/index.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

describe("ULW reorient after wave 1", () => {
  let prevHome = "";
  let home = "";

  before(() => {
    prevHome = process.env.FORGE_HOME || "";
    home = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "forge-reorient-"));
    process.env.FORGE_HOME = home;
  });

  after(() => {
    if (prevHome) process.env.FORGE_HOME = prevHome;
    else delete process.env.FORGE_HOME;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("wave >= 1 stays ship until requestUlwReorient", () => {
    const sid = "reorient-1";
    armUlwCycle(sid, "improve this game", { cycle: 1, skipCheckpoint: true });
    assert.equal(resolveUlwPhase(loadUlwCycle(sid)), "orient");
    markUlwPlanDone(sid, "Reading: plant the cry on floor 1. Verify: npm test.");
    assert.equal(resolveUlwPhase(loadUlwCycle(sid)), "ship");
    const s = loadUlwCycle(sid)!;
    s.wave = 2;
    // persist via complete? wave is on disk after mark; set via re-load
    requestUlwReorient(sid);
    assert.equal(resolveUlwPhase(loadUlwCycle(sid)), "orient");
    assert.equal(loadUlwCycle(sid)?.reorientRequested, true);
    completeUlwPlan(sid, { force: true });
    assert.equal(resolveUlwPhase(loadUlwCycle(sid)), "ship");
    assert.equal(loadUlwCycle(sid)?.reorientRequested, false);
  });

  it("closerRequestsReorient matches plan-stale language", () => {
    assert.equal(closerRequestsReorient("Plan stale — back to research."), true);
    assert.equal(closerRequestsReorient("Wave shipped: the cry plants."), false);
  });

  it("enter_plan_mode during ULW ship re-arms PLAN", async () => {
    const session = createSession({ cwd: process.cwd(), provider: "xai", model: "m" });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: process.cwd(),
      permissionMode: "default" as const,
    };
    armUlwCycle(session.meta.id, "improve this game", {
      cycle: 1,
      skipCheckpoint: true,
    });
    completeUlwPlan(session.meta.id, { force: true });
    assert.equal(resolveUlwPhase(loadUlwCycle(session.meta.id)), "ship");
    const r = await executeTool(
      "enter_plan_mode",
      JSON.stringify({ reason: "reading is a gold wash" }),
      { workspace: process.cwd(), session, config },
    );
    assert.notEqual(r.isError, true, r.output);
    assert.equal(resolveUlwPhase(loadUlwCycle(session.meta.id)), "orient");
    assert.equal(config.permissionMode, "plan");
  });
});
