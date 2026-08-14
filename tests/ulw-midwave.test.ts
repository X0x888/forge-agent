import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  armUlwCycle,
  disarmUlwCycle,
  loadUlwCycle,
  saveUlwCycle,
  maybeStampUlwWave,
  evaluateUlwAtStop,
  setMaxWaves,
  MID_WAVE_STAMP_STEPS,
} from "../src/harness/ulw-cycle.js";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-midwave-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("ULW mid-loop wave stamp", () => {
  it("stamps waves on idle step count without Stop", () => {
    withHome(() => {
      const sid = "sess-mid-1";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Ship the feature.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      const none = maybeStampUlwWave({
        sessionId: sid,
        editCount: 0,
        openTodoCount: 0,
        stepsSinceStamp: 3,
      });
      assert.equal(none.stamped, false);
      const hit = maybeStampUlwWave({
        sessionId: sid,
        editCount: 0,
        openTodoCount: 0,
        stepsSinceStamp: MID_WAVE_STAMP_STEPS,
      });
      assert.equal(hit.stamped, true);
      assert.ok((hit.wave ?? 0) >= 1);
      const s = loadUlwCycle(sid);
      assert.ok((s?.waves?.length ?? 0) >= 1);
      disarmUlwCycle(sid);
    });
  });

  it("edit progress updates tracking without incrementing the wave counter", () => {
    withHome(() => {
      const sid = "sess-mid-2";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Ship the feature.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 2,
      });
      const hit = maybeStampUlwWave({
        sessionId: sid,
        editCount: 5,
        openTodoCount: 0,
        stepsSinceStamp: 1,
      });
      assert.equal(hit.stamped, false);
      assert.equal(hit.updated, true);
      const s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 0, "a burst of edits is not a new wave");
      assert.equal(s.cycle, 1);
      assert.equal(s.lastProgressEditCount, 5);
      disarmUlwCycle(sid);
    });
  });

  it("five edit bursts with max_waves=2 stay on wave 0 CONTINUE", () => {
    withHome(() => {
      const sid = "sess-mid-cap-edits";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Ship the feature.", {
        cycle: 1,
        maxWaves: 2,
        skipCheckpoint: true,
        editCount: 0,
      });
      for (let i = 1; i <= 5; i++) {
        maybeStampUlwWave({
          sessionId: sid,
          editCount: i * 2,
          openTodoCount: 0,
          stepsSinceStamp: 1,
        });
      }
      const s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 0);
      assert.equal(s.cycle, 1);
      assert.equal(s.maxWaves, 2);
      disarmUlwCycle(sid);
    });
  });

  it("idle epochs honor max_waves and flip LAST", () => {
    withHome(() => {
      const sid = "sess-mid-cap-idle";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Ship the feature.", {
        cycle: 1,
        maxWaves: 2,
        skipCheckpoint: true,
        editCount: 0,
      });
      const w1 = maybeStampUlwWave({
        sessionId: sid,
        editCount: 0,
        openTodoCount: 0,
        stepsSinceStamp: MID_WAVE_STAMP_STEPS,
      });
      assert.equal(w1.stamped, true);
      assert.equal(w1.wave, 1);
      assert.equal(loadUlwCycle(sid)!.cycle, 1);

      const w2 = maybeStampUlwWave({
        sessionId: sid,
        editCount: 0,
        openTodoCount: 0,
        stepsSinceStamp: MID_WAVE_STAMP_STEPS,
      });
      assert.equal(w2.stamped, true);
      assert.equal(w2.wave, 2);
      assert.equal(w2.flippedToLast, true);
      const s = loadUlwCycle(sid)!;
      assert.equal(s.cycle, 0);
      assert.equal(s.wave, 2);
      assert.match(w2.admit || "", /max_waves=2/);

      const extra = maybeStampUlwWave({
        sessionId: sid,
        editCount: 0,
        openTodoCount: 0,
        stepsSinceStamp: MID_WAVE_STAMP_STEPS,
      });
      assert.equal(extra.stamped, false);
      assert.equal(loadUlwCycle(sid)!.wave, 2);
      disarmUlwCycle(sid);
    });
  });

  it("already-over-cap mid-loop flips LAST without incrementing", () => {
    withHome(() => {
      const sid = "sess-mid-over";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Ship the feature.", {
        cycle: 1,
        maxWaves: 10,
        skipCheckpoint: true,
        editCount: 0,
      });
      for (let i = 0; i < 3; i++) {
        maybeStampUlwWave({
          sessionId: sid,
          editCount: 0,
          openTodoCount: 0,
          stepsSinceStamp: MID_WAVE_STAMP_STEPS,
        });
      }
      assert.equal(loadUlwCycle(sid)!.wave, 3);
      setMaxWaves(sid, 2);
      const s = loadUlwCycle(sid)!;
      assert.equal(s.cycle, 0);
      assert.equal(s.wave, 3);
      const stamp = maybeStampUlwWave({
        sessionId: sid,
        editCount: 4,
        openTodoCount: 0,
        stepsSinceStamp: MID_WAVE_STAMP_STEPS,
      });
      assert.equal(stamp.stamped, false);
      assert.equal(loadUlwCycle(sid)!.wave, 3);
      disarmUlwCycle(sid);
    });
  });

  it("mid-loop edits do not poison Stop netDiff to none", () => {
    withHome(() => {
      const sid = "sess-mid-net";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "Ship the feature.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      s0.lastDiffFp = "fp-clean";
      saveUlwCycle(s0);
      maybeStampUlwWave({
        sessionId: sid,
        editCount: 10,
        openTodoCount: 0,
        stepsSinceStamp: 1,
      });
      assert.equal(loadUlwCycle(sid)!.lastDiffFp, "fp-clean");
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "shipped",
        editCount: 10,
        openTodoCount: 0,
        stuckThreshold: 5,
        diffFingerprint: "fp-dirty",
      });
      const w1 = loadUlwCycle(sid)!.waves![0]!;
      assert.equal(w1.netDiff, "new");
      disarmUlwCycle(sid);
    });
  });

  it("Stop increments once after mid-loop edit tracking of the same progress", () => {
    withHome(() => {
      const sid = "sess-mid-3";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Ship the feature.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      maybeStampUlwWave({
        sessionId: sid,
        editCount: 4,
        openTodoCount: 0,
        stepsSinceStamp: 1,
      });
      assert.equal(loadUlwCycle(sid)!.wave, 0);
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "still going",
        editCount: 4,
        openTodoCount: 0,
        stuckThreshold: 5,
      });
      const afterStop = loadUlwCycle(sid)!;
      assert.equal(afterStop.wave, 1);
      assert.equal(afterStop.waves?.length, 1);
      disarmUlwCycle(sid);
    });
  });
});
