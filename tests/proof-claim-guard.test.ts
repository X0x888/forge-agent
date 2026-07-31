import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectProofClaim,
  evaluateProofClaimAtStop,
} from "../src/harness/proof-claim-guard.js";
import { runStopGuard } from "../src/harness/stop-guard.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";

describe("detectProofClaim", () => {
  it("flags success claims", () => {
    const cases = [
      "All tests pass.",
      "npm test is green.",
      "typecheck clean",
      "typechecks cleanly",
      "814 tests passed",
      "all green",
      "All checks are green.",
      "build succeeded",
      "Verified with npm test.",
      "Verified via the test suite.",
    ];
    for (const msg of cases) {
      const d = detectProofClaim(msg);
      assert.equal(d.claim, true, `expected claim: ${msg}`);
    }
  });

  it("does not flag non-claims", () => {
    const cases = [
      "I should run the tests next.",
      "Shipped the retry path.",
      "The bug is fixed.",
      "I verified the fix works.", // no command named
      "Let me know if you have questions.",
      "**Goal achieved.**\n✅ done",
      "",
    ];
    for (const msg of cases) {
      const d = detectProofClaim(msg);
      assert.equal(d.claim, false, `expected no claim: ${msg}`);
    }
  });
});

describe("evaluateProofClaimAtStop", () => {
  it("blocks claim without verification when edits exist", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "All tests pass. Ready to merge.",
      verificationRan: false,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 3,
    });
    assert.equal(r.block, true);
    assert.match(r.reanchor || "", /proof-claim/i);
  });

  it("allows when verificationRan", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "All tests pass.",
      verificationRan: true,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 3,
    });
    assert.equal(r.block, false);
  });

  it("allows claim with no work in flight", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "In general tests pass when the suite is green.",
      verificationRan: false,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 0,
    });
    assert.equal(r.block, false);
  });

  it("releases after cap", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "all green",
      verificationRan: false,
      ultrawork: true,
      goalActive: false,
      openTodoCount: 0,
      editCount: 1,
      proofClaimBlocks: 1,
      proofClaimBlockCap: 1,
    });
    assert.equal(r.block, false);
    assert.equal(r.released, true);
  });
});

describe("stop-guard proof-claim composition", () => {
  it("blocks unverified success claim after edits", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pc-"));
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
      ctx: { sessionId: "pc1", cwd: tmp, workspaceRoot: tmp },
      ultrawork: false,
      openTodoCount: 0,
      editCount: 2,
      lastAssistantMessage: "Shipped. All tests pass.",
      verificationRan: false,
    });
    assert.equal(r.allowStop, false);
    assert.ok(r.proofClaim?.block);
  });

  it("allows verified success claim", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pc2-"));
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
      ctx: { sessionId: "pc2", cwd: tmp, workspaceRoot: tmp },
      ultrawork: false,
      openTodoCount: 0,
      editCount: 2,
      lastAssistantMessage: "Shipped. All tests pass.",
      verificationRan: true,
    });
    assert.equal(r.allowStop, true);
  });
});
