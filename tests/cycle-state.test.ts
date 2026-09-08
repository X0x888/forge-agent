import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adoptLiveControls,
  armCycle,
  currentCycleAlreadyClosed,
  disarmCycle,
  loadCycleState,
  saveCycleState,
  setCycleFlag,
  setMaxCycles,
  writeCycleState,
} from "../src/harness/cycle/index.js";
import { armWithPlan, mkGitRepo } from "./helpers/cycle-arm.js";

describe("cycle live-control overlay", () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-overlay-"));
    process.env.FORGE_HOME = home;
    cwd = mkGitRepo();
  });

  it("saveCycleState does not clobber a live /cycle 0 written while memory was stale", () => {
    const sid = "overlay-cycle0";
    armCycle({ sessionId: sid, mandate: "ship it", cwd });
    const stale = loadCycleState(sid)!;
    assert.equal(stale.cycleZeroRequested, false);
    assert.equal(setCycleFlag(sid, 0).ok, true);
    assert.equal(loadCycleState(sid)!.cycleZeroRequested, true);
    stale.phase = "plan";
    saveCycleState(stale);
    const disk = loadCycleState(sid)!;
    assert.equal(disk.cycleZeroRequested, true, "orchestrator persist must keep the keystroke");
    assert.equal(stale.cycleZeroRequested, true, "in-memory copy is overlaid too");
  });

  it("saveCycleState does not clobber /ulw-off written while memory was stale", () => {
    const sid = "overlay-disarm";
    armCycle({ sessionId: sid, mandate: "ship it", cwd });
    const stale = loadCycleState(sid)!;
    assert.equal(disarmCycle(sid)?.endReason, "disarmed");
    saveCycleState(stale);
    const disk = loadCycleState(sid)!;
    assert.equal(disk.enabled, false);
    assert.equal(disk.phase, "released");
    assert.equal(disk.endReason, "disarmed");
  });

  it("saveCycleState does not clobber /max-cycles written while memory was stale", () => {
    const sid = "overlay-max";
    armCycle({ sessionId: sid, mandate: "ship it", cwd });
    const stale = loadCycleState(sid)!;
    assert.equal(stale.maxCycles, null);
    assert.equal(setMaxCycles(sid, 3).ok, true);
    saveCycleState(stale);
    assert.equal(loadCycleState(sid)!.maxCycles, 3);
  });

  it("a harness release is not revived by an armed disk", () => {
    const sid = "overlay-release";
    armCycle({ sessionId: sid, mandate: "ship it", cwd });
    const s = loadCycleState(sid)!;
    s.enabled = false;
    s.phase = "released";
    s.endReason = "cycle-zero";
    saveCycleState(s);
    const disk = loadCycleState(sid)!;
    assert.equal(disk.enabled, false);
    assert.equal(disk.phase, "released");
    assert.equal(disk.endReason, "cycle-zero");
  });

  it("adoptLiveControls copies disk controls onto a stale object without writing", () => {
    const sid = "overlay-adopt";
    armCycle({ sessionId: sid, mandate: "ship it", cwd });
    const stale = loadCycleState(sid)!;
    setCycleFlag(sid, 0);
    assert.equal(stale.cycleZeroRequested, false);
    adoptLiveControls(stale);
    assert.equal(stale.cycleZeroRequested, true);
  });

  it("re-arming does not inherit a previous /cycle 0", () => {
    const sid = "overlay-rearm";
    armCycle({ sessionId: sid, mandate: "ship it", cwd });
    setCycleFlag(sid, 0);
    const next = armCycle({ sessionId: sid, mandate: "ship it again", cwd });
    assert.equal(next.cycleZeroRequested, false);
    assert.equal(next.enabled, true);
    assert.equal(next.phase, "plan");
  });

  it("/cycle 0 after a closed cycle says the run stops without starting the next plan", () => {
    const sid = "overlay-closed-msg";
    const s = armWithPlan({ sessionId: sid, cwd, mandate: "ship it" });
    s.phase = "plan";
    s.cycles[0].endedAt = new Date().toISOString();
    writeCycleState(s);
    assert.equal(currentCycleAlreadyClosed(loadCycleState(sid)!), true);
    const r = setCycleFlag(sid, 0);
    assert.equal(r.ok, true);
    assert.match(r.line, /already closed/);
    assert.match(r.line, /without starting the next plan/);
  });
});
