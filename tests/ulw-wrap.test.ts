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
  setCycleFlag,
  evaluateUlwAtStop,
  maybeStampUlwWave,
  maybeAdoptNamedShips,
  openNamedWrapItems,
  setMaxWaves,
  reenableUlwCycle,
} from "../src/harness/ulw-cycle.js";
import { appendMemoryRecord } from "../src/harness/decision-memory.js";
import { CLEAN_TREE_DIFF_FP } from "../src/util/git-context.js";

const READING =
  "Reading: Forge's product is the interactive REPL. The ONE ship is the tool-status line. Passed on: markdown wrap, help groups, session picker.";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-wrap-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function armNamed(sid: string, maxWaves?: number) {
  fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
    recursive: true,
  });
  const s = armUlwCycle(sid, "comprehensively evaluate then improve ux", {
    cycle: 1,
    maxWaves,
    skipCheckpoint: true,
    editCount: 0,
  });
  appendMemoryRecord(sid, {
    kind: "decision",
    source: "agent",
    text: READING,
  });
  maybeAdoptNamedShips(s, READING);
  saveUlwCycle(s);
  return loadUlwCycle(sid)!;
}

describe("ULW LAST wrap", () => {
  it("user /cycle 0 with open named ships bounces Cycle complete once", () => {
    withHome(() => {
      const sid = "wrap-user";
      armNamed(sid);
      const flagged = setCycleFlag(sid, 0, { lastReason: "user" })!;
      assert.equal(flagged.wrapKind, "user");
      assert.ok(openNamedWrapItems(flagged).length >= 2);

      const bounce = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "**Cycle complete.**\n✅ npm run typecheck — green\nMust-fix: none",
        editCount: 4,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(bounce.block, true);
      assert.equal(bounce.wrapDemanded, true);
      assert.match(bounce.reanchor || "", /wrap the named plan/i);
      assert.equal(loadUlwCycle(sid)!.enabled, true);

      const named = loadUlwCycle(sid)!.namedShips ?? [];
      let edits = 4;
      for (const item of named.filter((x) => x.status === "open")) {
        edits += 3;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: `Wave shipped: ${item.text}`,
        });
      }
      const done = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "**Cycle complete.**\n✅ npm run typecheck — green\nMust-fix: none",
        editCount: edits,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(done.block, false);
      assert.equal(done.lastCycleReleased, true);
      disarmUlwCycle(sid);
    });
  });

  it("budget LAST at the cap does not require leftover named ships", () => {
    withHome(() => {
      const sid = "wrap-budget";
      const s0 = armNamed(sid, 4);
      s0.wave = 4;
      saveUlwCycle(s0);
      setMaxWaves(sid, 4);
      const s = loadUlwCycle(sid)!;
      assert.equal(s.cycle, 0);
      assert.equal(s.wrapKind, "budget");
      assert.equal(openNamedWrapItems(s).length, 0);

      const done = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "**Cycle complete.**\n✅ npm run typecheck — green\nMust-fix: none",
        editCount: 8,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(done.block, false);
      assert.equal(done.lastCycleReleased, true);
      disarmUlwCycle(sid);
    });
  });

  it("early /cycle 0 on a capped run wraps remaining named ships", () => {
    withHome(() => {
      const sid = "wrap-early-cap";
      armNamed(sid, 4);
      maybeStampUlwWave({
        sessionId: sid,
        editCount: 5,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: "Wave 1 shipped: the tool-status line",
      });
      const flagged = setCycleFlag(sid, 0, { lastReason: "user" })!;
      assert.equal(flagged.wrapKind, "user");
      assert.ok(openNamedWrapItems(flagged).length >= 2);
      disarmUlwCycle(sid);
    });
  });

  it("does not adopt a new reading during LAST", () => {
    withHome(() => {
      const sid = "wrap-frozen";
      armNamed(sid);
      setCycleFlag(sid, 0, { lastReason: "user" });
      const s = loadUlwCycle(sid)!;
      const before = (s.namedShips ?? []).map((x) => x.text).join("|");
      const adopted = maybeAdoptNamedShips(
        s,
        "Reading: new work. The ONE ship is permission-ask lease. Passed on: leftover chrome.",
      );
      assert.equal(adopted, false);
      assert.equal(
        (loadUlwCycle(sid)!.namedShips ?? []).map((x) => x.text).join("|"),
        before,
      );
      disarmUlwCycle(sid);
    });
  });

  it("cancelling leftover named ships with reason releases on first Cycle complete", () => {
    withHome(() => {
      const sid = "wrap-cancel";
      armNamed(sid);
      setCycleFlag(sid, 0, { lastReason: "user" });
      const open = openNamedWrapItems(loadUlwCycle(sid)!);
      assert.ok(open.length >= 2);
      const cancelled = open
        .map((x) => `Cancelled: ${x.text} — leftover, not this wrap`)
        .join("\n");
      const done = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          `**Cycle complete.**\n${cancelled}\n✅ npm run typecheck — green\nMust-fix: none`,
        editCount: 4,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(done.block, false);
      assert.equal(done.lastCycleReleased, true);
      assert.equal(done.wrapDemanded, undefined);
      disarmUlwCycle(sid);
    });
  });

  it("/cycle 1 after LAST clears the frozen wrap so CONTINUE can adopt again", () => {
    withHome(() => {
      const sid = "wrap-resume";
      armNamed(sid);
      setCycleFlag(sid, 0, { lastReason: "user" });
      assert.equal(loadUlwCycle(sid)!.wrapKind, "user");
      const resumed = setCycleFlag(sid, 1)!;
      assert.equal(resumed.cycle, 1);
      assert.equal(resumed.wrapKind, undefined);
      assert.equal((resumed.wrapItems ?? []).length, 0);
      const s = loadUlwCycle(sid)!;
      s.namedShips = (s.namedShips ?? []).map((x) => ({
        ...x,
        status: "done" as const,
      }));
      saveUlwCycle(s);
      const adopted = maybeAdoptNamedShips(
        loadUlwCycle(sid)!,
        "Reading: new surface. The ONE ship is the permission-ask stdin lease for the REPL. Passed on: leftover chrome.",
      );
      assert.equal(adopted, true);
      disarmUlwCycle(sid);
    });
  });

  it("legacy LAST sidecar without wrapKind snapshots on evaluate", () => {
    withHome(() => {
      const sid = "wrap-legacy";
      armNamed(sid);
      const s = loadUlwCycle(sid)!;
      s.cycle = 0;
      s.wrapKind = undefined;
      s.wrapItems = undefined;
      saveUlwCycle(s);
      const bounce = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "**Cycle complete.**\n✅ npm run typecheck — green\nMust-fix: none",
        editCount: 4,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(bounce.block, true);
      assert.equal(bounce.wrapDemanded, true);
      assert.equal(loadUlwCycle(sid)!.wrapKind, "user");
      disarmUlwCycle(sid);
    });
  });

  it("legacy LAST at the cap infers budget wrap and does not require named leftovers", () => {
    withHome(() => {
      const sid = "wrap-legacy-cap";
      const s0 = armNamed(sid, 4);
      s0.wave = 4;
      s0.cycle = 0;
      s0.wrapKind = undefined;
      s0.wrapItems = undefined;
      saveUlwCycle(s0);
      const done = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "**Cycle complete.**\n✅ npm run typecheck — green\nMust-fix: none",
        editCount: 8,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(done.block, false);
      assert.equal(done.lastCycleReleased, true);
      assert.equal(loadUlwCycle(sid)!.wrapKind, "budget");
      disarmUlwCycle(sid);
    });
  });

  it("user LAST bounces once when the tree is still dirty", () => {
    withHome(() => {
      const sid = "wrap-dirty";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "improve the ui", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      setCycleFlag(sid, 0, { lastReason: "user" });
      assert.equal(openNamedWrapItems(loadUlwCycle(sid)!).length, 0);
      const bounce = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "**Cycle complete.**\n✅ npm run typecheck — green\nMust-fix: none",
        editCount: 6,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
        diffFingerprint: "fp-dirty-wrap",
      });
      assert.equal(bounce.block, true);
      assert.equal(bounce.wrapDemanded, true);
      assert.match(bounce.reanchor || "", /wrap the open wave/i);

      const done = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "**Cycle complete.** Working tree clean.\n✅ npm run typecheck — green\nMust-fix: none",
        editCount: 6,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
        diffFingerprint: CLEAN_TREE_DIFF_FP,
      });
      assert.equal(done.block, false);
      assert.equal(done.lastCycleReleased, true);
      disarmUlwCycle(sid);
    });
  });

  it("budget LAST does not bounce for a dirty tree", () => {
    withHome(() => {
      const sid = "wrap-budget-dirty";
      const s0 = armNamed(sid, 4);
      s0.wave = 4;
      saveUlwCycle(s0);
      setMaxWaves(sid, 4);
      assert.equal(loadUlwCycle(sid)!.wrapKind, "budget");
      const done = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "**Cycle complete.**\n✅ npm run typecheck — green\nMust-fix: none",
        editCount: 8,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
        diffFingerprint: "fp-dirty-budget",
      });
      assert.equal(done.block, false);
      assert.equal(done.lastCycleReleased, true);
      disarmUlwCycle(sid);
    });
  });

  it("reenable after abort clears leftover wrap", () => {
    withHome(() => {
      const sid = "wrap-reenable";
      armNamed(sid);
      setCycleFlag(sid, 0, { lastReason: "user" });
      disarmUlwCycle(sid);
      const next = reenableUlwCycle(sid)!;
      assert.equal(next.enabled, true);
      assert.equal(next.cycle, 1);
      assert.equal(next.wrapKind, undefined);
      disarmUlwCycle(sid);
    });
  });
});
