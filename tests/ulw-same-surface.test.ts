import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { armUlwReady as armUlwCycle } from "./helpers/ulw-arm.js";
import {
  disarmUlwCycle,
  evaluateUlwAtStop,
  formatUlwStatus,
  loadUlwCycle,
  maybeAdoptNamedShips,
  maybeStampUlwWave,
  resolveUlwPhase,
  sameSurfaceHolding,
  saveUlwCycle,
  scheduleCycleZeroStop,
} from "../src/harness/ulw-cycle.js";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ss-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const REST_1 =
  "Wave shipped: rest only names what you have actually lived.";
const REST_2 =
  "Wave shipped: rest now only names what you have actually lived on dry stone.";
const REST_3 =
  "Wave shipped: the leftover rest card no longer names water, weight, or the hidden hour.";
const REST_LEFTOVER =
  "Wave shipped: leftover rest card still names water. Fix that only.";
const LIFETIME =
  "Wave shipped: hidden lifetime now ticks from the start of a life.";

describe("ULW same-surface hold", () => {
  it("holds unlimited ULW after 3 rest-card siblings", () => {
    withHome(() => {
      const sid = "ss-hold";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      let edits = 0;
      for (const msg of [REST_1, REST_2, REST_3]) {
        edits += 8;
        const r = maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: msg,
          verificationPassed: true,
        });
        assert.equal(r.stamped, true, msg);
      }
      const s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 3);
      assert.ok((s.sameSurfaceStreak ?? 0) >= 3);
      assert.equal(sameSurfaceHolding(s), true);
      assert.equal(s.reorientRequested, true);
      assert.equal(resolveUlwPhase(s), "orient");
      assert.match(formatUlwStatus(s), /Same surface: hold/i);

      const blocked = maybeStampUlwWave({
        sessionId: sid,
        editCount: edits + 8,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: REST_3,
        verificationPassed: true,
      });
      assert.equal(blocked.stamped, false);
      assert.match(blocked.admit || "", /same surface/i);
      assert.equal(loadUlwCycle(sid)!.wave, 3);
    });
  });

  it("a different-surface ship releases the hold and increments w", () => {
    withHome(() => {
      const sid = "ss-release";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
      });
      let edits = 0;
      for (const msg of [REST_1, REST_2, REST_3]) {
        edits += 8;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: msg,
          verificationPassed: true,
        });
      }
      const released = maybeStampUlwWave({
        sessionId: sid,
        editCount: edits + 10,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: LIFETIME,
        verificationPassed: true,
      });
      assert.equal(released.stamped, true);
      const s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 4);
      assert.equal(sameSurfaceHolding(s), false);
      assert.equal(s.sameSurfaceStreak, 1);
    });
  });

  it("capped runs do not hold", () => {
    withHome(() => {
      const sid = "ss-cap";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        maxWaves: 10,
        skipCheckpoint: true,
      });
      let edits = 0;
      for (const msg of [REST_1, REST_2, REST_3]) {
        edits += 8;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: msg,
          verificationPassed: true,
        });
      }
      const s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 3);
      assert.equal(sameSurfaceHolding(s), false);
      const fourth = maybeStampUlwWave({
        sessionId: sid,
        editCount: edits + 8,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: REST_3,
        verificationPassed: true,
      });
      assert.equal(fourth.stamped, true);
      assert.equal(loadUlwCycle(sid)!.wave, 4);
      assert.equal(sameSurfaceHolding(loadUlwCycle(sid)!), false);
      assert.match(
        fourth.admit || "",
        /budget, not a hold|different class|LAST consolidation/i,
      );
      assert.match(formatUlwStatus(loadUlwCycle(sid)!), /budget — not a hold/i);
    });
  });

  it("/cycle 0 N+1 budget clears the hold so those waves can finish", () => {
    withHome(() => {
      const sid = "ss-c0";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 24,
      });
      let edits = 24;
      for (const msg of [REST_1, REST_2, REST_3]) {
        edits += 8;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: msg,
          verificationPassed: true,
        });
      }
      assert.equal(sameSurfaceHolding(loadUlwCycle(sid)!), true);
      const scheduled = scheduleCycleZeroStop(sid, { editCount: edits })!;
      assert.equal(scheduled.sameSurfaceHold, false);
      assert.equal(sameSurfaceHolding(scheduled), false);
      const extra = maybeStampUlwWave({
        sessionId: sid,
        editCount: edits + 8,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: REST_3,
        verificationPassed: true,
      });
      assert.equal(extra.stamped, true);
      assert.ok((loadUlwCycle(sid)!.wave ?? 0) >= 4);
    });
  });

  it("stuck-wall does not release during the hold", () => {
    withHome(() => {
      const sid = "ss-stuck";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
      });
      let edits = 0;
      for (const msg of [REST_1, REST_2, REST_3]) {
        edits += 8;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: msg,
          verificationPassed: true,
        });
      }
      let last = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "named list is done",
        editCount: edits,
        openTodoCount: 0,
        stuckThreshold: 3,
      });
      assert.equal(last.block, true);
      assert.equal(last.stuckReleased, undefined);
      last = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "still waiting",
        editCount: edits,
        openTodoCount: 0,
        stuckThreshold: 3,
      });
      last = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "still waiting",
        editCount: edits,
        openTodoCount: 0,
        stuckThreshold: 3,
      });
      assert.equal(last.stuckReleased, undefined);
      assert.equal(loadUlwCycle(sid)!.enabled, true);
      assert.equal(last.sameSurfaceDemanded, true);
    });
  });

  it("refuses a same-surface reading and adopts a different-surface one", () => {
    withHome(() => {
      const sid = "ss-read";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
      });
      let edits = 0;
      for (const msg of [REST_1, REST_2, REST_3]) {
        edits += 8;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: msg,
          verificationPassed: true,
        });
      }
      const held = loadUlwCycle(sid)!;
      assert.equal(sameSurfaceHolding(held), true);
      const refused = maybeAdoptNamedShips(
        held,
        "Reading: rest copy is still the hard work. ONE ship: leftover rest card still names water. Passed on: chrome catalogs.",
      );
      assert.equal(refused, false);
      assert.equal(sameSurfaceHolding(loadUlwCycle(sid)!), true);
      const after = loadUlwCycle(sid)!;
      const adopted = maybeAdoptNamedShips(
        after,
        "Reading: the clock is the hard work. The ONE ship is hidden lifetime ticks from the start. Passed on: rest card copy.",
      );
      assert.equal(adopted, true);
      assert.equal(after.sameSurfaceHold, false);
      disarmUlwCycle(sid);
    });
  });

  it("Stop hold does not increment w on a leftover listen sibling", () => {
    withHome(() => {
      const sid = "ss-stop";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
      });
      let edits = 0;
      for (const msg of [REST_1, REST_2, REST_3]) {
        edits += 8;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: msg,
          verificationPassed: true,
        });
      }
      const beforeState = loadUlwCycle(sid)!;
      beforeState.soulNudgeDone = true;
      saveUlwCycle(beforeState);
      const before = beforeState.wave;
      const d = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: REST_LEFTOVER,
        editCount: edits + 5,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(d.block, true);
      assert.equal(d.sameSurfaceDemanded, true);
      assert.equal(loadUlwCycle(sid)!.wave, before);
    });
  });
});
