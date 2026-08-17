import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isTestOrHarnessPath,
  isTestsWithoutBodyCloser,
  isTestsWithoutBodyShip,
} from "../src/harness/tests-without-body.js";
import {
  armUlwCycle,
  disarmUlwCycle,
  evaluateUlwAtStop,
  loadUlwCycle,
  maybeStampUlwWave,
} from "../src/harness/ulw-cycle.js";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-twb-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const REDGREEN =
  "Using `forge-redgreen`. Writing tests for carried gifts first, then wiring the body. Wave shipped.";
const BODY =
  "Wave shipped: carried functional tools must change the body (vision, felt weight, flood pace).";

describe("tests-without-body classifier", () => {
  it("treats test files and lockfiles as harness, not the body", () => {
    assert.equal(isTestOrHarnessPath("client/src/lib/game/carriedGifts.test.ts"), true);
    assert.equal(isTestOrHarnessPath("package.json"), true);
    assert.equal(isTestOrHarnessPath("client/src/lib/game/carriedGifts.ts"), false);
    assert.equal(isTestsWithoutBodyCloser(REDGREEN), true);
    assert.equal(isTestsWithoutBodyCloser(BODY), false);
  });

  it("refuses an unproven test-only ship and allows a proven one", () => {
    assert.equal(
      isTestsWithoutBodyShip({
        proof: false,
        paths: ["client/src/lib/game/carriedGifts.test.ts"],
        closer: BODY,
      }),
      true,
    );
    assert.equal(
      isTestsWithoutBodyShip({
        proof: true,
        paths: ["client/src/lib/game/carriedGifts.test.ts"],
        closer: BODY,
      }),
      false,
    );
    assert.equal(
      isTestsWithoutBodyShip({
        proof: false,
        paths: [
          "client/src/lib/game/carriedGifts.test.ts",
          "client/src/lib/game/carriedGifts.ts",
        ],
        closer: BODY,
      }),
      false,
    );
    assert.equal(
      isTestsWithoutBodyShip({ proof: false, closer: REDGREEN }),
      true,
    );
  });
});

describe("ULW refuses a red-only test stamp", () => {
  it("maybeStamp does not increment w on forge-redgreen Wave shipped", () => {
    withHome(() => {
      const sid = "twb-stamp";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve this game based on comprehensive evaluation and understanding.", {
        cycle: 1,
        maxWaves: 20,
        skipCheckpoint: true,
        editCount: 0,
      });
      const refused = maybeStampUlwWave({
        sessionId: sid,
        editCount: 1,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: REDGREEN,
        verificationPassed: false,
        changedPaths: ["client/src/lib/game/carriedGifts.test.ts"],
      });
      assert.equal(refused.stamped, false);
      assert.equal(loadUlwCycle(sid)!.wave, 0);
      assert.match(refused.admit || "", /tests-without-body/i);

      const body = maybeStampUlwWave({
        sessionId: sid,
        editCount: 20,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: BODY,
        verificationPassed: true,
        changedPaths: [
          "client/src/lib/game/carriedGifts.test.ts",
          "client/src/lib/game/carriedGifts.ts",
          "client/src/lib/game/GameEngine.ts",
        ],
      });
      assert.equal(body.stamped, true);
      assert.equal(loadUlwCycle(sid)!.wave, 1);
      disarmUlwCycle(sid);
    });
  });

  it("Stop does not increment w on a red-only test Wave shipped", () => {
    withHome(() => {
      const sid = "twb-stop";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        maxWaves: 20,
        skipCheckpoint: true,
        editCount: 0,
      });
      const d = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: REDGREEN,
        editCount: 1,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: false,
        changedPaths: ["client/src/lib/game/carriedGifts.test.ts"],
      });
      assert.equal(d.block, true);
      assert.equal(d.waveClosed, false);
      assert.equal(loadUlwCycle(sid)!.wave, 0);
      assert.match(d.reanchor || "", /tests-without-body/i);
      disarmUlwCycle(sid);
    });
  });
});
