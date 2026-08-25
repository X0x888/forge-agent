import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyRawPinSideEffects,
  introducesRawReadFileSync,
  isTopLevelTestFile,
  pinBudgetLawPresent,
  RAW_PIN_WARNING,
} from "../src/util/pin-budget.js";
import { armUlwReady as armUlwCycle } from "./helpers/ulw-arm.js";
import {
  loadUlwCycle,
  maybeStampUlwWave,
} from "../src/harness/ulw-cycle.js";

describe("pin-budget law", () => {
  it("detects top-level tests and raw readFileSync introductions", () => {
    const cwd = "/repo";
    assert.equal(
      isTopLevelTestFile("/repo/tests/w161-overflow.test.mjs", cwd),
      true,
    );
    assert.equal(
      isTopLevelTestFile("/repo/tests/_meta/pin-budget.test.mjs", cwd),
      false,
    );
    assert.equal(
      isTopLevelTestFile("/repo/src/foo.js", cwd),
      false,
    );
    assert.equal(introducesRawReadFileSync("", "import { readFileSync } from 'fs'"), true);
    assert.equal(
      introducesRawReadFileSync(
        "import { readFileSync } from 'fs'",
        "import { readFileSync } from 'fs'\n// still",
      ),
      false,
    );
  });

  it("taints ULW proof when a new raw pin lands in a law repo", () => {
    const prev = process.env.FORGE_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pin-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pin-ws-"));
    process.env.FORGE_HOME = home;
    try {
      fs.mkdirSync(path.join(cwd, "tests/_meta"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "tests/_meta/pin-budget.test.mjs"), "export {}\n");
      assert.equal(pinBudgetLawPresent(cwd), true);
      const sid = "pin-1";
      fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
      });
      const warn = applyRawPinSideEffects({
        cwd,
        absPath: path.join(cwd, "tests/w161-overflow.test.mjs"),
        before: "",
        after: "import { readFileSync } from 'node:fs';\n",
        sessionId: sid,
      });
      assert.equal(warn, RAW_PIN_WARNING);
      assert.equal(loadUlwCycle(sid)!.rawPinProofTaint, true);
      const hit = maybeStampUlwWave({
        sessionId: sid,
        editCount: 4,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: "Wave shipped: ACT no longer swings at a downed partner.",
        verificationPassed: true,
      });
      assert.equal(hit.stamped, false);
      assert.match(hit.admit || "", /pin-only|Pin-budget|cannot stamp/i);
      assert.equal(loadUlwCycle(sid)!.wave, 0);
      assert.equal(loadUlwCycle(sid)!.rawPinProofTaint, true);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
