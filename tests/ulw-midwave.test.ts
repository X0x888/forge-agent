import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  armUlwCycle,
  disarmUlwCycle,
  loadUlwCycle,
  maybeStampUlwWave,
  evaluateUlwAtStop,
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

  it("stamps on edit progress without Stop", () => {
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
      assert.equal(hit.stamped, true);
      const s = loadUlwCycle(sid)!;
      assert.equal(s.waves![0]!.editDelta, 3);
      disarmUlwCycle(sid);
    });
  });

  it("Stop does not double-increment after a mid-loop stamp of the same sig", () => {
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
      const afterMid = loadUlwCycle(sid)!;
      const wave = afterMid.wave;
      const n = afterMid.waves?.length ?? 0;
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "still going",
        editCount: 4,
        openTodoCount: 0,
        stuckThreshold: 5,
      });
      const afterStop = loadUlwCycle(sid)!;
      assert.equal(afterStop.wave, wave);
      assert.equal(afterStop.waves?.length, n);
      disarmUlwCycle(sid);
    });
  });
});
