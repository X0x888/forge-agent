import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { armUlwReady } from "./helpers/ulw-arm.js";
import {
  canLeaveUlwPlan,
  completeUlwPlan,
  exploreSpawnSkipReason,
  loadUlwCycle,
  maybeStampUlwWave,
  noteExploreChildCompleted,
  requestUlwReorient,
  saveUlwCycle,
} from "../src/harness/ulw-cycle.js";
import { PIN_ONLY_ADMIT, JOB_FLAT_ADMIT, REORIENT_EVIDENCE_ADMIT } from "../src/harness/job-delta.js";
import { noteRawPinProofTaint } from "../src/util/pin-budget.js";

describe("ULW job-delta credit", () => {
  let prevHome = "";
  let home = "";

  before(() => {
    prevHome = process.env.FORGE_HOME || "";
    home = fs.mkdtempSync(path.join(os.tmpdir() || "/tmp", "forge-job-"));
    process.env.FORGE_HOME = home;
  });

  after(() => {
    if (prevHome) process.env.FORGE_HOME = prevHome;
    else delete process.env.FORGE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("does not stamp w on pin-tainted Wave shipped", () => {
    const sid = "job-pin";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    armUlwReady(sid, "Improve this game.");
    noteRawPinProofTaint({ sessionId: sid });
    const hit = maybeStampUlwWave({
      sessionId: sid,
      editCount: 6,
      openTodoCount: 0,
      stepsSinceStamp: 1,
      lastAssistantMessage: "Wave shipped: settings is a cream ledger.",
      verificationPassed: true,
      changedPaths: ["src/ui/overlay/settings.js", "tests/w-settings-ledger.test.mjs"],
    });
    assert.equal(hit.stamped, false);
    assert.match(hit.admit || "", /pin-only/);
    assert.equal(loadUlwCycle(sid)!.wave, 0);
    assert.equal(loadUlwCycle(sid)!.rawPinProofTaint, true);
    assert.equal(PIN_ONLY_ADMIT.includes("pin-only"), true);
  });

  it("stamps a production ship with no pin taint", () => {
    const sid = "job-ok";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    armUlwReady(sid, "Improve this game.");
    const hit = maybeStampUlwWave({
      sessionId: sid,
      editCount: 8,
      openTodoCount: 0,
      stepsSinceStamp: 1,
      lastAssistantMessage: "Wave shipped: coins hop from the body into the hand.",
      verificationPassed: true,
      changedPaths: ["src/systems/gold-hop.js", "tests/w-gold-hop.test.mjs"],
    });
    assert.equal(hit.stamped, true);
    assert.equal(loadUlwCycle(sid)!.wave, 1);
  });

  it("stamps the first chrome-only ship, refuses the second", () => {
    const sid = "job-chrome";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    armUlwReady(sid, "Improve this game.");
    const first = maybeStampUlwWave({
      sessionId: sid,
      editCount: 3,
      openTodoCount: 0,
      stepsSinceStamp: 1,
      lastAssistantMessage: "Wave shipped: empty cook is a basin.",
      verificationPassed: true,
      changedPaths: ["style.css", "tests/w-cook-empty.test.mjs"],
    });
    assert.equal(first.stamped, true, first.admit);
    const second = maybeStampUlwWave({
      sessionId: sid,
      editCount: 6,
      openTodoCount: 0,
      stepsSinceStamp: 1,
      lastAssistantMessage: "Wave shipped: pause is a key-card.",
      verificationPassed: true,
      changedPaths: ["style.css", "CHANGELOG.md"],
    });
    assert.equal(second.stamped, false);
    assert.equal(second.admit, JOB_FLAT_ADMIT);
    assert.equal(loadUlwCycle(sid)!.wave, 1);
  });

  it("blocks completeUlwPlan after reorient until explore evidence", () => {
    const sid = "job-reorient";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    armUlwReady(sid, "Improve this game.");
    requestUlwReorient(sid);
    const s = loadUlwCycle(sid)!;
    assert.equal(s.reorientNeedsEvidence, true);
    assert.equal(canLeaveUlwPlan(s), false);
    assert.equal(
      completeUlwPlan(sid, {
        closer: "Reading: the ping is a cream wick. Verify: npm test.",
      }),
      false,
    );
    noteExploreChildCompleted(sid);
    assert.equal(canLeaveUlwPlan(loadUlwCycle(sid)!), true);
    assert.equal(
      completeUlwPlan(sid, {
        closer: "Reading: the ping is a cream wick. Verify: npm test.",
      }),
      true,
    );
    assert.equal(loadUlwCycle(sid)!.reorientNeedsEvidence, false);
    assert.match(REORIENT_EVIDENCE_ADMIT, /new Reading is not a ticket/);
  });

  it("skips explore spawn while explore-map ships are open", () => {
    const sid = "job-explore";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    armUlwReady(sid, "Improve this game.");
    const s = loadUlwCycle(sid)!;
    s.wave = 4;
    s.namedShips = [
      { text: "the shrine is still a glowing triangle", status: "open", source: "explore-map" },
    ];
    saveUlwCycle(s);
    const skip = exploreSpawnSkipReason(sid);
    assert.match(skip || "", /Open explore-map ships remain/);
    s.namedShips[0]!.status = "done";
    s.lastExploreWave = 4;
    saveUlwCycle(s);
    assert.match(exploreSpawnSkipReason(sid) || "", /Explore already ran at wave 4/);
    s.exploreRequired = true;
    saveUlwCycle(s);
    assert.equal(exploreSpawnSkipReason(sid), undefined);
  });
});
