import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isUserFacingProductWork,
  extractJobInsight,
  extractSerendipities,
  hasProductEdge,
  harvestProductQualityNotes,
  evaluateProductQuality,
  hasStoredJobInsight,
} from "../src/harness/product-quality.js";
import {
  armUlwCycle,
  disarmUlwCycle,
  evaluateUlwAtStop,
  maybeAdoptNamedShips,
  loadUlwCycle,
  isLeftoverChromeShip,
} from "../src/harness/ulw-cycle.js";
import { appendMemoryRecord } from "../src/harness/decision-memory.js";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pq-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("isUserFacingProductWork", () => {
  it("arms on evaluate-then-ui and build-an-app", () => {
    assert.equal(
      isUserFacingProductWork(
        "comprehensively evaluate this tool and then improve the ui",
      ),
      true,
    );
    assert.equal(isUserFacingProductWork("build a small notes app"), true);
    assert.equal(isUserFacingProductWork("redesign the onboarding"), true);
    assert.equal(isUserFacingProductWork("improve the empty state"), true);
    assert.equal(isUserFacingProductWork("improve the onboarding ux"), true);
  });

  it("skips infra, flags, bugfix, and generic UI chrome", () => {
    assert.equal(isUserFacingProductWork("improve the code"), false);
    assert.equal(isUserFacingProductWork("improve the ui"), false);
    assert.equal(isUserFacingProductWork("improve the ui chrome"), false);
    assert.equal(isUserFacingProductWork("polish the tui"), false);
    assert.equal(isUserFacingProductWork("fix the type error in loop.ts"), false);
    assert.equal(isUserFacingProductWork("add a flag for prune"), false);
    assert.equal(isUserFacingProductWork("fix the login bug"), false);
    assert.equal(isUserFacingProductWork("harden ci yaml"), false);
  });
});

describe("product-quality detectors", () => {
  it("reads Job / Reading / edges / Serendipity", () => {
    assert.match(
      extractJobInsight("The hard work is trusting the daily loop.") || "",
      /trusting the daily loop/,
    );
    assert.match(
      extractJobInsight(
        "Reading: Forge's product is the interactive REPL. The ONE ship is the dock.",
      ) || "",
      /interactive REPL/,
    );
    assert.equal(hasProductEdge("Empty state: tap to capture a thought."), true);
    assert.equal(hasProductEdge("Wave shipped: dock tool name"), false);
    assert.deepEqual(extractSerendipities("Serendipity: pin the last thought."), [
      "pin the last thought.",
    ]);
    assert.equal(
      extractSerendipities(
        "Serendipity: one.\nSerendipity: two more garnish.",
      ).length,
      2,
    );
  });

  it("treats a stored Reading as the job and first-run as an edge", () => {
    withHome(() => {
      const sid = "pq-stored-read";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      appendMemoryRecord(sid, {
        kind: "observation",
        source: "agent",
        text: "Reading: first-run numbers — ship typeable 1–6.",
      });
      assert.equal(hasStoredJobInsight(sid), true);
      const q = evaluateProductQuality({
        closer: "Ship landed: wave 2 item.\n✅ npm test — 12 passed",
        sessionId: sid,
        wave: 1,
      });
      assert.equal(q.ok, true);
    });
  });

  it("does not require an edge on the first product ship", () => {
    const q = evaluateProductQuality({
      closer: "Job: capture a thought before it vanishes.\nWave shipped: the composer.",
      sessionId: "",
      wave: 0,
    });
    assert.equal(q.ok, true);
    const later = evaluateProductQuality({
      closer: "Job: capture a thought before it vanishes.\nWave shipped: the composer.",
      sessionId: "",
      wave: 1,
    });
    assert.equal(later.ok, false);
    assert.ok(later.missing.includes("edge"));
  });

  it("does not treat a chrome catalog Reading as the job", () => {
    const q = evaluateProductQuality({
      closer:
        "Reading: leftovers. The ONE ship is first 5 names under the ✓ row.\nWave shipped: preview list.",
      sessionId: "",
      wave: 0,
      isLeftoverChrome: isLeftoverChromeShip,
    });
    assert.equal(q.ok, false);
    assert.ok(q.missing.includes("job"));
  });

  it("rejects leftover-chrome labeled as Serendipity", () => {
    const q = evaluateProductQuality({
      closer:
        "Reading: the job is capture. Empty state: blank card.\nSerendipity: first 5 names under the ✓ row.",
      sessionId: "",
      wave: 1,
      isLeftoverChrome: isLeftoverChromeShip,
    });
    assert.equal(q.ok, false);
    assert.ok(q.missing.includes("serendipity_chrome"));
  });

  it("rejects a second Serendipity in one unit", () => {
    const q = evaluateProductQuality({
      closer:
        "Job: capture a thought. Empty state: tap.\nSerendipity: pin last.\nSerendipity: also a badge.",
      sessionId: "",
      wave: 1,
    });
    assert.equal(q.ok, false);
    assert.ok(q.missing.includes("serendipity_budget"));
  });
});

describe("product-quality Stop bar", () => {
  it("does not fire on infra mandates", () => {
    withHome(() => {
      const sid = "pq-infra";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "fix the type error in loop.ts", {
        cycle: 1,
        skipCheckpoint: true,
      });
      const d = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "Wave 1 shipped: clamp the window past EOF.",
        editCount: 4,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(d.soulDemanded, undefined);
      assert.equal(loadUlwCycle(sid)!.wave, 1);
      disarmUlwCycle(sid);
    });
  });

  it("bounces a user-facing ship that never names the job", () => {
    withHome(() => {
      const sid = "pq-nojob";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "build a small notes app", {
        cycle: 1,
        skipCheckpoint: true,
      });
      const d = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "Wave 1 shipped: a feature grid of six cards.",
        editCount: 5,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(d.block, true);
      assert.equal(d.soulDemanded, true);
      assert.match(d.reanchor || "", /product quality/);
      assert.equal(loadUlwCycle(sid)!.wave, 0);
      assert.equal(loadUlwCycle(sid)!.soulNudgeDone, true);
      const again = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "Wave 1 shipped: a feature grid of six cards.",
        editCount: 5,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(again.soulDemanded, undefined);
      assert.equal(loadUlwCycle(sid)!.wave, 1);
      disarmUlwCycle(sid);
    });
  });

  it("passes a ship with job, edge, and one adjacent Serendipity", () => {
    withHome(() => {
      const sid = "pq-ok";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "build a small notes app", {
        cycle: 1,
        skipCheckpoint: true,
      });
      const d = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: [
          "Reading: The hard work is capturing a thought before it vanishes.",
          "Wave shipped: the composer.",
          "Empty state: tap to capture.",
          "Serendipity: pin the last thought.",
        ].join("\n"),
        editCount: 6,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(d.soulDemanded, undefined);
      assert.equal(d.block, true);
      assert.equal(loadUlwCycle(sid)!.wave, 1);
      assert.equal(hasStoredJobInsight(sid), true);
      disarmUlwCycle(sid);
    });
  });

  it("refuses a chrome-only reading as the product plan", () => {
    withHome(() => {
      const sid = "pq-chrome-read";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s = armUlwCycle(sid, "improve the onboarding ux", {
        cycle: 1,
        skipCheckpoint: true,
      });
      const adopted = maybeAdoptNamedShips(
        s,
        "Reading: leftovers. The ONE ship is first 5 names under the ✓ row. Passed on: last 8 log lines under the ✓ row.",
      );
      assert.equal(adopted, false);
      disarmUlwCycle(sid);
    });
  });

  it("harvests Job from a reading onto the decision ledger", () => {
    withHome(() => {
      const sid = "pq-harvest";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      harvestProductQualityNotes(
        sid,
        "Reading: The hard work is trusting the daily REPL. Empty state: unread transcript.",
      );
      assert.equal(hasStoredJobInsight(sid), true);
    });
  });
});
