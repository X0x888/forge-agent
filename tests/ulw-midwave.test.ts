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
  isDeclaredWaveClose,
  isPolishClassShip,
} from "../src/harness/ulw-cycle.js";
import { appendMemoryRecord } from "../src/harness/decision-memory.js";

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
  it("unlimited idle epochs do not increment the wave counter", () => {
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
      for (let i = 0; i < 4; i++) {
        const hit = maybeStampUlwWave({
          sessionId: sid,
          editCount: i === 0 ? 0 : 3,
          openTodoCount: 0,
          stepsSinceStamp: MID_WAVE_STAMP_STEPS,
        });
        assert.equal(hit.stamped, false, "idle must not stamp when uncapped");
      }
      const s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 0);
      assert.equal(s.cycle, 1);
      assert.equal(s.maxWaves, null);
      assert.equal((s.waves?.length ?? 0), 0);
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

  it("capped ULW idle epochs do not increment the wave counter", () => {
    withHome(() => {
      const sid = "sess-mid-cap-noinc";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Ship the feature.", {
        cycle: 1,
        maxWaves: 4,
        skipCheckpoint: true,
        editCount: 0,
      });
      for (let i = 0; i < 3; i++) {
        const r = maybeStampUlwWave({
          sessionId: sid,
          editCount: 0,
          openTodoCount: 0,
          stepsSinceStamp: MID_WAVE_STAMP_STEPS,
        });
        assert.equal(r.stamped, false, "idle must not stamp a new wave when capped");
      }
      const s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 0);
      assert.equal(s.cycle, 1);
      disarmUlwCycle(sid);
    });
  });

  it("idle at/over a lowered cap flips LAST without incrementing", () => {
    withHome(() => {
      const sid = "sess-mid-cap-idle";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const armed = armUlwCycle(sid, "Ship the feature.", {
        cycle: 1,
        maxWaves: 10,
        skipCheckpoint: true,
        editCount: 0,
      });
      armed.wave = 2;
      saveUlwCycle(armed);
      setMaxWaves(sid, 2);
      assert.equal(loadUlwCycle(sid)!.cycle, 0);
      const idle = maybeStampUlwWave({
        sessionId: sid,
        editCount: 0,
        openTodoCount: 0,
        stepsSinceStamp: MID_WAVE_STAMP_STEPS,
      });
      assert.equal(idle.stamped, false);
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
      for (let i = 1; i <= 3; i++) {
        evaluateUlwAtStop({
          sessionId: sid,
          lastAssistantMessage: `w${i}`,
          editCount: i,
          openTodoCount: 0,
          stuckThreshold: 20,
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

  it("declared Wave shipped increments even when max_waves is set", () => {
    withHome(() => {
      const sid = "sess-declared";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "improve the ui", {
        cycle: 1,
        maxWaves: 4,
        skipCheckpoint: true,
        editCount: 0,
      });
      assert.equal(isDeclaredWaveClose("Wave 2 shipped: todo board"), true);
      assert.equal(isDeclaredWaveClose("still verifying the unused import"), false);
      const idle = maybeStampUlwWave({
        sessionId: sid,
        editCount: 12,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: "still wiring",
      });
      assert.equal(idle.stamped, false);
      assert.equal(loadUlwCycle(sid)!.wave, 0);
      const hit = maybeStampUlwWave({
        sessionId: sid,
        editCount: 18,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: "Wave 1 shipped: scannable todo board",
      });
      assert.equal(hit.stamped, true);
      assert.equal(loadUlwCycle(sid)!.wave, 1);
      assert.match(hit.admit || "", /harness counter/i);
      disarmUlwCycle(sid);
    });
  });

  it("stamps a declared close from memory_write when assistant prose is empty", () => {
    withHome(() => {
      const sid = "sess-mem-close";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "improve the ui", {
        cycle: 1,
        maxWaves: 4,
        skipCheckpoint: true,
        editCount: 0,
      });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: "Wave 1 shipped: stdin lease so permission asks do not fight the editor.",
      });
      const hit = maybeStampUlwWave({
        sessionId: sid,
        editCount: 8,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: "",
      });
      assert.equal(hit.stamped, true, "memory_write closer must count");
      assert.equal(loadUlwCycle(sid)!.wave, 1);
      disarmUlwCycle(sid);
    });
  });

  it("does not overwrite a ship ledger row with a Reading reprint", () => {
    withHome(() => {
      const sid = "sess-ledger-ship";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "improve the ui", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: "Reading: Forge's product is the interactive REPL plus blocking harness. Daily-loop trust beats chrome leftovers.",
      });
      maybeStampUlwWave({
        sessionId: sid,
        editCount: 8,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: "Wave 1 shipped: stdin lease for permission asks",
      });
      assert.match(loadUlwCycle(sid)!.waves![0]!.summary, /stdin lease/i);
      maybeStampUlwWave({
        sessionId: sid,
        editCount: 10,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage:
          "Reading: Forge's product is the interactive REPL plus blocking harness. Daily-loop trust beats chrome leftovers.\n\nstill verifying",
      });
      assert.match(loadUlwCycle(sid)!.waves![0]!.summary, /stdin lease/i);
      disarmUlwCycle(sid);
    });
  });

  it("declared ship still increments after unlimited idle epochs", () => {
    withHome(() => {
      const sid = "sess-mid-idle-then-ship";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "improve the ui", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      maybeStampUlwWave({
        sessionId: sid,
        editCount: 6,
        openTodoCount: 0,
        stepsSinceStamp: MID_WAVE_STAMP_STEPS,
        lastAssistantMessage: "still wiring",
      });
      assert.equal(loadUlwCycle(sid)!.wave, 0);
      const hit = maybeStampUlwWave({
        sessionId: sid,
        editCount: 12,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: "Wave 1 shipped: stdin lease",
      });
      assert.equal(hit.stamped, true);
      assert.equal(loadUlwCycle(sid)!.wave, 1);
      disarmUlwCycle(sid);
    });
  });

  it("four polish-class ships flip LAST even under the cap", () => {
    withHome(() => {
      const sid = "sess-polish";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "improve the ui", {
        cycle: 1,
        maxWaves: 8,
        skipCheckpoint: true,
        editCount: 0,
      });
      assert.equal(isPolishClassShip("Wave 2 shipped: clip banner to one TTY row"), true);
      assert.equal(isPolishClassShip("Wave 2 shipped: stdin lease for permission asks"), false);
      let edits = 0;
      let last;
      for (let i = 1; i <= 4; i++) {
        edits += 6;
        last = maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: `Wave ${i} shipped: clip widget ${i} to one TTY row`,
        });
      }
      assert.equal(last?.stamped, true);
      assert.equal(last?.flippedToLast, true);
      assert.equal(loadUlwCycle(sid)!.cycle, 0);
      assert.match(last?.admit || "", /polish-class auto LAST|polish class/i);
      disarmUlwCycle(sid);
    });
  });
});
