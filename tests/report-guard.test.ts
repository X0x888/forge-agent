import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  countReportLabels,
  detectHomework,
  evaluateAttestationHomeworkAtStop,
  evaluateReportAtStop,
  isTerminalAttestation,
  looksLikeRunReport,
} from "../src/harness/report-guard.js";
import { HookRunner } from "../src/harness/hooks.js";
import { runStopGuard } from "../src/harness/stop-guard.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { clearGuidelineAuditState } from "../src/harness/guideline-audit.js";
import { loadUlwCycle, setCycleFlag } from "../src/harness/ulw-cycle.js";
import { armUlwReady } from "./helpers/ulw-arm.js";

const GOOD_REPORT = `Done — the login flow now rejects expired tokens and 3 files changed.

**What shipped**
- Token expiry check in the session middleware.
- A regression test that calls it with an expired token.

**Verified**
- \`npm test\` passed (212 tests).

**Not done**
- Nothing left open.

**Needs you**
- Nothing.`;

describe("detectHomework", () => {
  it("flags work handed back to the user", () => {
    const cases = [
      "You should now run `npm run build` before you deploy.",
      "Next steps for you: add the env var and re-run the migration.",
      "You'll need to configure the webhook URL in the dashboard.",
      "Please run the test suite to confirm.",
      "I'm leaving the integration test to you.",
      "I didn't run the full suite; you could run it before merging.",
    ];
    for (const c of cases) {
      assert.equal(detectHomework(c).homework, true, c);
    }
  });

  it("lets the four allowed reasons and Operator: lines through", () => {
    const cases = [
      "Operator: you need to add the STRIPE_SECRET_KEY to .env — I cannot read it.",
      "You will need to log in to the vendor portal; the API key is not in the repo.",
      "You should force-push only if you accept losing the remote history (irreversible).",
      "The external service is down; you can re-run once the network is back.",
      "Run `npm test` yourself if you like — I ran it and it passed.",
      // An affordance is not a directive: this tells the user what they have.
      "You can now run `npm run build` to see the change.",
    ];
    for (const c of cases) {
      assert.equal(detectHomework(c).homework, false, c);
    }
    // Code fences are not instructions to the user.
    assert.equal(
      detectHomework("```\n# you can now run npm test\n```\nDone.").homework,
      false,
    );
  });
});

describe("looksLikeRunReport", () => {
  it("accepts outcome-first labelled reports and rejects last-round nits", () => {
    assert.equal(looksLikeRunReport(GOOD_REPORT), true);
    assert.ok(countReportLabels(GOOD_REPORT) >= 4);
    assert.equal(looksLikeRunReport("Fixed the reviewer's nit."), false);
    assert.equal(
      looksLikeRunReport("**What shipped**\n- x\n**Verified**\n- y"),
      false,
      "a bare label first line is not an outcome sentence",
    );
    assert.equal(
      looksLikeRunReport("## Summary\nThe run finished and everything is green.\n## Verified\n- npm test"),
      true,
    );
  });
});

describe("evaluateReportAtStop", () => {
  beforeEach(() => {
    delete process.env.FORGE_REPORT_GUARD;
    delete process.env.FORGE_REPORT_BLOCK_CAP;
  });

  const base = {
    stopContinues: 0,
    editCount: 3,
    ultrawork: false,
    goalActive: false,
    openTodoCount: 0,
  };

  it("blocks homework once with the harness facts, then releases at the cap", () => {
    const d = evaluateReportAtStop({
      ...base,
      lastAssistantMessage: "Done. You can now run `npm run lint` and fix anything it reports.",
      factsProvider: () => ["Shipped: 3 files changed: a.ts, b.ts", "Verified: none"],
    });
    assert.equal(d.block, true);
    assert.equal(d.kind, "homework");
    assert.match(d.reanchor || "", /hands work back to the user/);
    assert.match(d.reanchor || "", /Operator:/);
    assert.match(d.reanchor || "", /Shipped: 3 files changed/);

    const released = evaluateReportAtStop({
      ...base,
      lastAssistantMessage: "Done. You should now run `npm run lint`.",
      reportBlocks: 2,
    });
    assert.equal(released.block, false);
    assert.equal(released.released, true);
  });

  it("after multiple harness rounds a last-round-only closer is bounced for the run-wide shape", () => {
    const d = evaluateReportAtStop({
      ...base,
      stopContinues: 3,
      lastAssistantMessage: "Addressed the nit: renamed the helper.",
    });
    assert.equal(d.block, true);
    assert.equal(d.kind, "shape");
    assert.match(d.reanchor || "", /after 3 harness rounds/);
    assert.match(d.reanchor || "", /What shipped/);

    const ok = evaluateReportAtStop({
      ...base,
      stopContinues: 3,
      lastAssistantMessage: GOOD_REPORT,
    });
    assert.equal(ok.block, false);
  });

  it("leaves the shape of a driver attestation alone — the attestation pass owns it", () => {
    const bare = "**Cycle complete.**\n✅ npm test — green\nMust-fix: none";
    assert.equal(
      evaluateReportAtStop({
        ...base,
        stopContinues: 5,
        ultrawork: true,
        lastAssistantMessage: bare,
      }).block,
      false,
    );
    // …but homework inside one is still homework at this step.
    const d = evaluateReportAtStop({
      ...base,
      stopContinues: 5,
      ultrawork: true,
      lastAssistantMessage: `${bare}\nYou'll need to run the migration against staging yourself.`,
    });
    assert.equal(d.block, true);
    assert.equal(d.kind, "homework");
  });

  it("does not bounce single-round closers, advisory Q&A, attestations, or when disabled", () => {
    assert.equal(
      evaluateReportAtStop({
        ...base,
        stopContinues: 0,
        lastAssistantMessage: "Renamed the helper and ran npm test — green.",
      }).block,
      false,
    );
    assert.equal(
      evaluateReportAtStop({
        ...base,
        editCount: 0,
        lastUserMessage: "What does this function do?",
        lastAssistantMessage: "It parses dates. You could add a test if you want coverage.",
      }).block,
      false,
    );
    assert.equal(
      evaluateReportAtStop({
        ...base,
        stopContinues: 5,
        ultrawork: true,
        lastAssistantMessage: "**Cycle complete.**\n✅ npm test — green\nMust-fix: none",
      }).block,
      false,
    );
    process.env.FORGE_REPORT_GUARD = "0";
    assert.equal(
      evaluateReportAtStop({
        ...base,
        stopContinues: 4,
        lastAssistantMessage: "You can now run the build.",
      }).block,
      false,
    );
  });

  it("terminal attestation: cycle=1 declares a wave, cycle=0 and Goal achieved close the run", () => {
    const cc = "**Cycle complete.** wave 12 shipped.";
    assert.equal(isTerminalAttestation(cc, { ulwEnabled: true, ulwCycle: 1 }), false);
    assert.equal(isTerminalAttestation(cc, { ulwEnabled: true, ulwCycle: 0 }), true);
    assert.equal(isTerminalAttestation(cc, {}), true);
    assert.equal(
      isTerminalAttestation("**Goal achieved.** every criterion met.", {
        ulwEnabled: true,
        ulwCycle: 1,
      }),
      true,
    );
    assert.equal(isTerminalAttestation("Done, all green.", {}), false);
  });

  it("attestation pass: homework in the closer blocks, a wave-level ship does not, cap releases", () => {
    const withHomework = `**Cycle complete.**\n12 waves shipped, suite green.\nYou can now run \`npm run deploy\` when you are ready.`;
    const d = evaluateAttestationHomeworkAtStop({
      lastAssistantMessage: withHomework,
      ulwEnabled: true,
      ulwCycle: 0,
      stopContinues: 40,
      editCount: 60,
      factsProvider: () => ["Shipped: 12 waves", "Verified: npm test passed"],
    });
    assert.equal(d.block, true);
    assert.equal(d.kind, "homework");
    assert.match(d.reanchor || "", /hands work back to the user/);
    assert.match(d.reanchor || "", /re-attest with the same marker/i);
    assert.match(d.reanchor || "", /Shipped: 12 waves/);

    // The same text mid-run under cycle=1 is a wave ship — the driver owns it.
    assert.equal(
      evaluateAttestationHomeworkAtStop({
        lastAssistantMessage: withHomework,
        ulwEnabled: true,
        ulwCycle: 1,
        stopContinues: 40,
        editCount: 60,
      }).block,
      false,
    );

    const released = evaluateAttestationHomeworkAtStop({
      lastAssistantMessage: withHomework,
      ulwEnabled: true,
      ulwCycle: 0,
      stopContinues: 40,
      editCount: 60,
      reportBlocks: 2,
    });
    assert.equal(released.block, false);
    assert.equal(released.released, true);
  });

  it("attestation pass: after many rounds a bare attestation is bounced for the run-wide report", () => {
    const bare = "**Cycle complete.**\n✅ npm test — green\nMust-fix: none";
    const d = evaluateAttestationHomeworkAtStop({
      lastAssistantMessage: bare,
      ulwEnabled: true,
      ulwCycle: 0,
      stopContinues: 40,
      editCount: 60,
    });
    assert.equal(d.block, true);
    assert.equal(d.kind, "shape");
    assert.match(d.reanchor || "", /covers only the close-out/);

    // A full report that opens with the marker is accepted.
    const full = `**Cycle complete.**\n\nDone — the importer now streams and 12 waves shipped since the mandate.\n\n**What shipped**\n- Streaming importer.\n\n**Verified**\n- \`npm test\` passed (212 tests).\n\n**Needs you**\n- Nothing.`;
    assert.equal(looksLikeRunReport(full), true);
    assert.equal(
      evaluateAttestationHomeworkAtStop({
        lastAssistantMessage: full,
        ulwEnabled: true,
        ulwCycle: 0,
        stopContinues: 40,
        editCount: 60,
      }).block,
      false,
    );

    // One round in, there is no whole run to summarise yet.
    assert.equal(
      evaluateAttestationHomeworkAtStop({
        lastAssistantMessage: bare,
        ulwEnabled: false,
        stopContinues: 1,
        editCount: 2,
      }).block,
      false,
    );
  });

  it("runStopGuard checks the ULW closer before the driver, and spends no wave doing it", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rg-ulw-"));
    process.env.FORGE_HOME = tmp;
    clearGuidelineAuditState();
    const sid = "rg-ulw-1";
    armUlwReady(sid, "improve this tool");
    setCycleFlag(sid, 0);
    const before = loadUlwCycle(sid)!;
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
      editCount: 9,
      verificationRan: true,
      verificationPassed: true,
      stopContinues: 12,
      reportBlocks: 0,
      lastAssistantMessage:
        "**Cycle complete.**\n9 waves shipped, suite green.\nYou'll need to add the CHANGELOG entry yourself.",
      runFactsProvider: () => ["Shipped: 9 waves"],
    });
    assert.equal(r.allowStop, false);
    assert.equal(r.report?.kind, "homework");
    assert.match(r.additionalContext || "", /Shipped: 9 waves/);
    // The driver never evaluated this Stop: no wave, no evidence nudge spent.
    const after = loadUlwCycle(sid)!;
    assert.equal(after.enabled, true);
    assert.equal(after.wave, before.wave);
    assert.equal(after.waves?.length ?? 0, before.waves?.length ?? 0);
    assert.equal(after.evidenceNudges ?? 0, before.evidenceNudges ?? 0);
  });

  it("composes through runStopGuard after the proof-claim guard", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rg-"));
    process.env.FORGE_HOME = tmp;
    clearGuidelineAuditState();
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
      ctx: { sessionId: "rg-1", cwd: tmp, workspaceRoot: tmp },
      ultrawork: false,
      openTodoCount: 0,
      editCount: 2,
      verificationRan: true,
      verificationPassed: true,
      stopContinues: 2,
      reportBlocks: 0,
      lastAssistantMessage: "Fixed the last nit. You should now update the README for the new flag.",
      runFactsProvider: () => ["Shipped: 2 files changed: x.ts, y.ts"],
    });
    assert.equal(r.allowStop, false);
    assert.equal(r.report?.kind, "homework");
    assert.match(r.additionalContext || "", /Shipped: 2 files changed/);

    const r2 = await runStopGuard({
      config,
      hooks,
      ctx: { sessionId: "rg-1", cwd: tmp, workspaceRoot: tmp },
      ultrawork: false,
      openTodoCount: 0,
      editCount: 2,
      verificationRan: true,
      verificationPassed: true,
      stopContinues: 3,
      reportBlocks: 1,
      lastAssistantMessage: GOOD_REPORT,
    });
    assert.equal(r2.allowStop, true);
  });
});
