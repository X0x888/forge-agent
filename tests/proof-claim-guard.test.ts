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

  it("names preferred project checks in reanchor", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "All tests pass.",
      verificationRan: false,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 2,
      preferredCheckCommands: ["npm run typecheck", "npm test"],
    });
    assert.equal(r.block, true);
    assert.match(r.reanchor || "", /preferred for this workspace/i);
    assert.match(r.reanchor || "", /npm run typecheck/);
    assert.match(r.reanchor || "", /npm test/);
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

  it("blocks done/fixed closers after edits without verification", () => {
    for (const msg of ["Done.", "Fixed!", "✅ complete", "Ready to merge."]) {
      const r = evaluateProofClaimAtStop({
        lastAssistantMessage: msg,
        verificationRan: false,
        ultrawork: false,
        goalActive: false,
        openTodoCount: 0,
        editCount: 2,
      });
      assert.equal(r.block, true, msg);
    }
  });

  it("allows done closers without edits (pure Q&A)", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "Done.",
      verificationRan: false,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 0,
    });
    assert.equal(r.block, false);
  });

  it("allows done closers when verificationRan", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "Done.",
      verificationRan: true,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 3,
    });
    assert.equal(r.block, false);
  });

  it("reanchor mentions stale last-verify trail", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "All tests pass.",
      verificationRan: false,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 2,
      preferredCheckCommands: ["npm test"],
      lastVerificationCommand: "npm test",
      lastVerificationStale: true,
    });
    assert.equal(r.block, true);
    assert.match(String(r.reanchor || ""), /STALE/i);
    assert.match(String(r.reanchor || ""), /npm test/);
  });

  it("allows bare Done. after advisory Q&A even with prior edits", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "Done.",
      verificationRan: false,
      ultrawork: true,
      goalActive: false,
      openTodoCount: 0,
      editCount: 3,
      lastUserMessage: "what do you think about the landing page?",
    });
    assert.equal(r.block, false);
  });

  it("still blocks Done. after work-order user turn with edits", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "Done.",
      verificationRan: false,
      ultrawork: true,
      goalActive: false,
      openTodoCount: 0,
      editCount: 3,
      lastUserMessage: "please implement the remaining fixes",
    });
    assert.equal(r.block, true);
  });

  it("still blocks tests-pass claims after advisory user turn", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "All tests pass.",
      verificationRan: false,
      ultrawork: true,
      goalActive: false,
      openTodoCount: 0,
      editCount: 3,
      lastUserMessage: "what do you think about the landing page?",
    });
    assert.equal(r.block, true);
  });

  it("reanchor includes free self-audit checklist", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "All tests pass.",
      verificationRan: false,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 2,
      preferredCheckCommands: ["npm test"],
    });
    assert.equal(r.block, true);
    assert.match(String(r.reanchor || ""), /Self-audit/i);
    assert.match(String(r.reanchor || ""), /Completeness/i);
    assert.match(String(r.reanchor || ""), /Evidence/i);
    assert.match(String(r.reanchor || ""), /Consequence/i);
  });

  it("blocks silent stop after edits without verification (free triage)", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "Updated the parser and cleaned up imports.",
      verificationRan: false,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 3,
      preferredCheckCommands: ["npm test", "npm run typecheck"],
    });
    assert.equal(r.block, true);
    assert.match(String(r.reanchor || ""), /edits without verification|free triage/i);
    assert.match(String(r.reanchor || ""), /Silent stop after 3/i);
    assert.match(String(r.reanchor || ""), /npm test/);
    assert.match(String(r.reanchor || ""), /Self-audit/i);
  });

  it("does not silent-block under ULW (ULW owns proof-demand)", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "Updated the parser.",
      verificationRan: false,
      ultrawork: true,
      goalActive: false,
      openTodoCount: 0,
      editCount: 2,
    });
    assert.equal(r.block, false);
  });

  it("does not silent-block under active goal (goal owns attestation)", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "Updated the parser.",
      verificationRan: false,
      ultrawork: false,
      goalActive: true,
      openTodoCount: 0,
      editCount: 2,
    });
    assert.equal(r.block, false);
  });

  it("does not silent-block after advisory Q&A with prior edits", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "The landing page uses a hero + three feature cards.",
      verificationRan: false,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 4,
      lastUserMessage: "what does the landing page look like?",
    });
    assert.equal(r.block, false);
  });

  it("does not silent-block when no edits", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "Here is how the parser works.",
      verificationRan: false,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 0,
    });
    assert.equal(r.block, false);
  });

  it("releases silent-unverified after cap", () => {
    const r = evaluateProofClaimAtStop({
      lastAssistantMessage: "Updated the parser.",
      verificationRan: false,
      ultrawork: false,
      goalActive: false,
      openTodoCount: 0,
      editCount: 2,
      proofClaimBlocks: 1,
      proofClaimBlockCap: 1,
    });
    assert.equal(r.block, false);
    assert.equal(r.released, true);
  });
});
