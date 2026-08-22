import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { armUlwReady as armUlwCycle } from "./helpers/ulw-arm.js";
import {
  disarmUlwCycle,
  loadUlwCycle,
  saveUlwCycle,
  evaluateUlwAtStop,
  markNamedShipDone,
  maybeStampUlwWave,
  parseNamedShipsFromReading,
  maybeAdoptNamedShips,
  applyCleanBaselineAfterCommit,
  formatUlwStatus,
} from "../src/harness/ulw-cycle.js";
import { appendMemoryRecord } from "../src/harness/decision-memory.js";
import { CLEAN_TREE_DIFF_FP } from "../src/util/git-context.js";
import { buildStructuredSummary } from "../src/session/compaction.js";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-named-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const READING =
  "Reading: Forge's product is the interactive REPL. The ONE ship is the tool-status line. Passed on: markdown wrap, help groups, session picker.";

describe("named-ship backlog", () => {
  it("parses the ONE ship plus passed-on list", () => {
    const ships = parseNamedShipsFromReading(READING);
    assert.ok(ships.length >= 3, String(ships));
    assert.match(ships[0]!, /tool-status/i);
    assert.ok(ships.some((s) => /markdown/i.test(s)));
    assert.ok(ships.some((s) => /session picker/i.test(s)));
  });

  it("does not treat a so-clause or next-need as a named ship", () => {
    const ships = parseNamedShipsFromReading(
      "Reading: tea is done. Passed on: Hearth enter still full-heals, so the 4 HP is usually 0 in play — do not grind more cups. Next: a real play bug.",
    );
    assert.ok(
      !ships.some((s) => /^so the 4 HP/i.test(s)),
      String(ships),
    );
    assert.ok(
      !ships.some((s) => /real play bug/i.test(s)),
      String(ships),
    );
    assert.ok(
      ships.some((s) => /Hearth enter still full-heals/i.test(s)),
      String(ships),
    );
  });

  it("drops mid-word truncated ships", () => {
    const ships = parseNamedShipsFromReading(
      "Reading: sit-down. The ONE ship is /commit is ve. Passed on: leftover chrome.",
    );
    assert.ok(
      !ships.some((s) => /\/commit is ve$/i.test(s)),
      String(ships),
    );
  });

  it("does not treat (later waves…) as a named ship", () => {
    const ships = parseNamedShipsFromReading(
      "Reading: daily UX is the transcript. Passed on (later waves, other surfaces): delayed start parity; user-turn landmarks; setup-card checkmarks. ONE ship: dock shows running tool name and elapsed.",
    );
    assert.ok(!ships.some((s) => /\(later waves/i.test(s)), String(ships));
    assert.match(ships[0]!, /dock shows running tool/i);
    assert.ok(ships.some((s) => /delayed start/i.test(s)));
    assert.ok(ships.some((s) => /user-turn landmarks/i.test(s)));
    assert.ok(ships.some((s) => /setup-card/i.test(s)));
  });

  it("adopts the reading on a declared ship after memory_write", () => {
    withHome(() => {
      const sid = "sess-named-adopt";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "comprehensively evaluate then improve ux", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: READING,
      });
      const hit = maybeStampUlwWave({
        sessionId: sid,
        editCount: 5,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: "Wave 1 shipped: the tool-status line",
      });
      assert.equal(hit.stamped, true);
      const s = loadUlwCycle(sid)!;
      assert.ok((s.namedShips?.length ?? 0) >= 3, String(s.namedShips));
      const done = s.namedShips!.filter((x) => x.status === "done");
      assert.equal(done.length, 1);
      assert.match(done[0]!.text, /tool-status/i);
      disarmUlwCycle(sid);
    });
  });

  it("blocks the next unlimited Stop once after named ships are done", () => {
    withHome(() => {
      const sid = "sess-named-1";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "comprehensively evaluate then improve ux", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: READING,
      });
      maybeAdoptNamedShips(s0, READING);
      saveUlwCycle(s0);
      const named = loadUlwCycle(sid)!.namedShips ?? [];
      assert.ok(named.length >= 3, String(named.map((n) => n.text)));

      let edits = 0;
      for (let i = 0; i < named.length; i++) {
        edits += 4;
        const hit = maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: `Wave ${i + 1} shipped: ${named[i]!.text}`,
        });
        assert.equal(hit.stamped, true, `ship ${i + 1} should stamp`);
      }
      const after = loadUlwCycle(sid)!;
      assert.ok(after.namedShips?.every((x) => x.status === "done"));
      assert.equal(after.wave, named.length);

      const blocked = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: `${READING}\n\nshall I keep polishing leftovers`,
        editCount: edits + 1,
        openTodoCount: 0,
        stuckThreshold: 20,
      });
      assert.equal(blocked.block, true);
      assert.match(blocked.reanchor || "", /named ships from the reading are done/i);
      assert.equal(loadUlwCycle(sid)!.wave, named.length, "gate must not increment w");
      assert.equal(loadUlwCycle(sid)!.namedShipAdmitDone, true);

      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: "Reading: stdin lease is still the hard work. The ONE ship is the permission-ask lease. Passed on: picker hierarchy, leftover chrome.",
      });
      const next = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "Reading: stdin lease is still the hard work. The ONE ship is the permission-ask lease. Passed on: picker hierarchy, leftover chrome.",
        editCount: edits + 2,
        openTodoCount: 0,
        stuckThreshold: 20,
      });
      assert.equal(next.block, true);
      assert.doesNotMatch(next.reanchor || "", /named ships from the reading are done/i);
      const adopted = loadUlwCycle(sid)!;
      assert.ok((adopted.namedShips ?? []).some((x) => x.status === "open"));
      disarmUlwCycle(sid);
    });
  });

  it("capped run with empty backlog still spends remaining waves", () => {
    withHome(() => {
      const sid = "sess-named-cap";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "comprehensively evaluate then improve ux", {
        cycle: 1,
        maxWaves: 8,
        skipCheckpoint: true,
        editCount: 0,
      });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: READING,
      });
      maybeAdoptNamedShips(s0, READING);
      saveUlwCycle(s0);
      const named = loadUlwCycle(sid)!.namedShips ?? [];
      let edits = 0;
      for (let i = 0; i < named.length; i++) {
        edits += 4;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: `Wave ${i + 1} shipped: ${named[i]!.text}`,
        });
      }
      const d = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "next surface: permission-ask lease",
        editCount: edits + 2,
        openTodoCount: 0,
        stuckThreshold: 20,
      });
      assert.equal(d.block, true);
      assert.doesNotMatch(d.reanchor || "", /named ships from the reading are done/i);
      assert.ok((loadUlwCycle(sid)!.wave ?? 0) > named.length);
      disarmUlwCycle(sid);
    });
  });

  it("cycle status lists named ships", () => {
    withHome(() => {
      const sid = "sess-named-status";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "comprehensively evaluate then improve ux", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      maybeAdoptNamedShips(s0, READING);
      saveUlwCycle(s0);
      const status = formatUlwStatus(loadUlwCycle(sid));
      assert.match(status, /Named ships: 0\/\d+ done/);
      assert.match(status, /tool-status/i);
      assert.doesNotMatch(status, /stuck-wall will not release/);
      disarmUlwCycle(sid);
    });
  });

  it("second Stop after an exhausted list does not open a free-invent wave", () => {
    withHome(() => {
      const sid = "sess-named-reblock";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "comprehensively evaluate then improve ux", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: READING,
      });
      maybeAdoptNamedShips(s0, READING);
      saveUlwCycle(s0);
      const named = loadUlwCycle(sid)!.namedShips ?? [];
      let edits = 0;
      for (let i = 0; i < named.length; i++) {
        edits += 4;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: `Wave ${i + 1} shipped: ${named[i]!.text}`,
        });
      }
      const first = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "named list is done",
        editCount: edits + 1,
        openTodoCount: 0,
        stuckThreshold: 20,
      });
      assert.match(first.reanchor || "", /named ships from the reading are done/i);
      const wave = loadUlwCycle(sid)!.wave;
      const second = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "still done, no new reading",
        editCount: edits + 2,
        openTodoCount: 0,
        stuckThreshold: 20,
      });
      assert.equal(second.block, true);
      assert.match(second.reanchor || "", /named ships from the reading are done|new Reading|different surface/i);
      assert.equal(loadUlwCycle(sid)!.wave, wave);
      disarmUlwCycle(sid);
    });
  });

  it("refuses a glanceable sibling reading after the exhausted admit", () => {
    withHome(() => {
      const sid = "sess-named-chrome";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "comprehensively evaluate then improve ux", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: READING,
      });
      maybeAdoptNamedShips(s0, READING);
      saveUlwCycle(s0);
      const named = loadUlwCycle(sid)!.namedShips ?? [];
      let edits = 0;
      for (let i = 0; i < named.length; i++) {
        edits += 4;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: `Wave ${i + 1} shipped: ${named[i]!.text}`,
        });
      }
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "named list is done",
        editCount: edits + 1,
        openTodoCount: 0,
        stuckThreshold: 20,
      });
      const before = (loadUlwCycle(sid)!.namedShips ?? []).map((x) => x.text);
      const chrome =
        "Reading: glanceable ✓ class continues. The ONE ship is search_mcp lists first 5 matched tool names under the ✓ row. Passed on: leftover chrome.";
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: chrome,
      });
      const adopted = maybeAdoptNamedShips(loadUlwCycle(sid)!, chrome);
      assert.equal(adopted, false);
      assert.deepEqual(
        (loadUlwCycle(sid)!.namedShips ?? []).map((x) => x.text),
        before,
      );
      const blocked = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: chrome,
        editCount: edits + 2,
        openTodoCount: 0,
        stuckThreshold: 20,
      });
      assert.equal(blocked.block, true);
      assert.match(blocked.reanchor || "", /named ships from the reading are done|new Reading|different surface/i);
      disarmUlwCycle(sid);
    });
  });

  it("stuck-wall does not release unlimited ULW while named ships are exhausted", () => {
    withHome(() => {
      const sid = "sess-named-stuck";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "improve the codebase", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      maybeAdoptNamedShips(s0, READING);
      saveUlwCycle(s0);
      const named = loadUlwCycle(sid)!.namedShips ?? [];
      let edits = 0;
      for (let i = 0; i < named.length; i++) {
        edits += 4;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: `Wave ${i + 1} shipped: ${named[i]!.text}`,
        });
      }
      let last;
      for (let i = 0; i < 5; i++) {
        last = evaluateUlwAtStop({
          sessionId: sid,
          lastAssistantMessage: "**Cycle complete.** All named surfaces shipped.",
          editCount: edits,
          openTodoCount: 0,
          stuckThreshold: 3,
          verificationPassed: true,
        });
      }
      assert.equal(last!.stuckReleased, undefined);
      assert.equal(last!.block, true);
      assert.equal(loadUlwCycle(sid)!.enabled, true);
      assert.equal(loadUlwCycle(sid)!.cycle, 1);
      assert.match(last!.reanchor || "", /new Reading|named ships from the reading are done/i);
      assert.doesNotMatch(last!.reanchor || "", /Hard work looks exhausted/);
      assert.match(last!.reanchor || "", /red test suite|open defect/i);
      assert.match(
        formatUlwStatus(loadUlwCycle(sid)),
        /stuck-wall will not release/,
      );
      disarmUlwCycle(sid);
    });
  });

  it("declared ship with edits after exhaust stamps w and still asks for a reading", () => {
    withHome(() => {
      const sid = "sess-named-stamp";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "improve the codebase", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      maybeAdoptNamedShips(s0, READING);
      saveUlwCycle(s0);
      const named = loadUlwCycle(sid)!.namedShips ?? [];
      let edits = 0;
      for (let i = 0; i < named.length; i++) {
        edits += 4;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: `Wave ${i + 1} shipped: ${named[i]!.text}`,
        });
      }
      const before = loadUlwCycle(sid)!.wave;
      const d = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "Wave shipped: toaster no longer throws when style is missing.",
        editCount: edits + 6,
        openTodoCount: 0,
        stuckThreshold: 3,
        verificationPassed: true,
      });
      assert.equal(d.block, true);
      assert.equal(d.waveClosed, true);
      assert.equal(loadUlwCycle(sid)!.wave, before + 1);
      assert.match(d.reanchor || "", /named ships from the reading are done|new Reading/i);
      disarmUlwCycle(sid);
    });
  });

  it("compact job card names the unlimited named-ship hold", () => {
    withHome(() => {
      const sid = "sess-named-compact";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      maybeAdoptNamedShips(s0, READING);
      saveUlwCycle(s0);
      const named = loadUlwCycle(sid)!.namedShips ?? [];
      let edits = 0;
      for (let i = 0; i < named.length; i++) {
        edits += 4;
        maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: `Wave ${i + 1} shipped: ${named[i]!.text}`,
        });
      }
      const card = buildStructuredSummary(
        [{ role: "user", content: "Improve this game." }],
        { ulw: loadUlwCycle(sid), sessionId: sid },
      );
      assert.match(card, /Named ships from the reading are done/i);
      assert.match(card, /red test suite/i);
      disarmUlwCycle(sid);
    });
  });
});

describe("auto-commit clean-tree baseline", () => {
  it("second wave after a clean baseline is not revisit", () => {
    withHome(() => {
      const sid = "sess-clean-fp";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "improve the ui", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      s0.lastDiffFp = CLEAN_TREE_DIFF_FP;
      s0.seenDiffFps = [CLEAN_TREE_DIFF_FP];
      saveUlwCycle(s0);
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "Wave 1 shipped: tool-status line",
        editCount: 6,
        openTodoCount: 0,
        stuckThreshold: 20,
        diffFingerprint: "fp-dirty-a",
      });
      const w1 = loadUlwCycle(sid)!;
      assert.equal(w1.waves![0]!.netDiff, "new");
      applyCleanBaselineAfterCommit(w1, CLEAN_TREE_DIFF_FP);
      saveUlwCycle(w1);
      assert.equal(loadUlwCycle(sid)!.lastDiffFp, CLEAN_TREE_DIFF_FP);
      assert.ok(!(loadUlwCycle(sid)!.seenDiffFps ?? []).includes(CLEAN_TREE_DIFF_FP));

      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "Wave 2 shipped: markdown wrap",
        editCount: 12,
        openTodoCount: 0,
        stuckThreshold: 20,
        diffFingerprint: "fp-dirty-b",
      });
      const w2 = loadUlwCycle(sid)!.waves!.at(-1)!;
      assert.notEqual(w2.netDiff, "revisit");
      assert.equal(w2.netDiff, "new");
      disarmUlwCycle(sid);
    });
  });

  it("thought-only Stop does not spend a wave or FIFO a named ship", () => {
    withHome(() => {
      const sid = "sess-empty-idle-stop";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const s0 = armUlwCycle(sid, "Ship the feature.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      s0.namedShips = [
        { text: "the tool-status line", status: "open", source: "reading" },
        { text: "markdown wrap", status: "open", source: "reading" },
      ];
      saveUlwCycle(s0);
      markNamedShipDone(s0, "");
      assert.ok(
        s0.namedShips.every((x) => x.status === "open"),
        "empty closer must not FIFO",
      );
      saveUlwCycle(s0);

      const blocked = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "",
        editCount: 0,
        openTodoCount: 0,
        stuckThreshold: 20,
      });
      assert.equal(blocked.block, true);
      assert.equal(blocked.waveClosed, false);
      assert.equal(loadUlwCycle(sid)!.wave, 0, "idle thought-stop is not a work unit");
      assert.ok(
        loadUlwCycle(sid)!.namedShips?.every((x) => x.status === "open"),
      );
      disarmUlwCycle(sid);
    });
  });

  it("empty closer after real edits still stamps the wave", () => {
    withHome(() => {
      const sid = "sess-empty-after-edits";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Ship the feature.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      const stamped = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "",
        editCount: 6,
        openTodoCount: 0,
        stuckThreshold: 20,
      });
      assert.equal(stamped.block, true);
      assert.equal(stamped.waveClosed, true);
      assert.equal(loadUlwCycle(sid)!.wave, 1);
      disarmUlwCycle(sid);
    });
  });
});
