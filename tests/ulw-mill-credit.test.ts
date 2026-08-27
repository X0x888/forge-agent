/**
 * Acceptance: capped TTY mill must not spend max_waves as mill units.
 * Fixture is generic (no product-specific closer strings).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { armUlwReady } from "./helpers/ulw-arm.js";
import {
  applyLastReflectGate,
  ledgerMustFixItems,
} from "../src/harness/last-reflect.js";
import {
  evaluateUlwAtStop,
  loadUlwCycle,
  maybeStampUlwWave,
  sameSurfaceHolding,
  saveUlwCycle,
} from "../src/harness/ulw-cycle.js";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mill-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PY_PIN = `
import io
import unittest
from tool import format_line

class TestLine(unittest.TestCase):
    def test_line(self):
        buf = io.StringIO()
        format_line(buf)
        self.assertIn("READY", buf.getvalue())
`;

const PY_BEH = `
import unittest
from tool import idle_before_require_backend_cli

class TestIdle(unittest.TestCase):
    def test_idle(self):
        self.assertTrue(idle_before_require_backend_cli({"ready": True}))
`;

describe("ULW mill credit (capped TTY)", () => {
  it("8 TTY-pin waves on the same 2 files with max_waves=20 stick w and LAST", () => {
    withHome(() => {
      const sid = "mill-tty";
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mill-cwd-"));
      try {
        fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
          recursive: true,
        });
        fs.mkdirSync(path.join(cwd, "tests"));
        fs.writeFileSync(path.join(cwd, "tool.py"), 'print("READY")\n');
        fs.writeFileSync(path.join(cwd, "tests/test_tool.py"), PY_PIN);
        armUlwReady(
          sid,
          "Comprehensively evaluate this tool and then improve the ui and ux of it.",
          { cycle: 1, maxWaves: 20, skipCheckpoint: true },
        );
        let edits = 0;
        let lastFlipped = false;
        for (let i = 0; i < 8; i++) {
          edits += 12;
          const r = maybeStampUlwWave({
            sessionId: sid,
            editCount: edits,
            openTodoCount: 0,
            stepsSinceStamp: 1,
            lastAssistantMessage: `Wave shipped: operator glance ${i + 1} (argv / first line).`,
            verificationPassed: true,
            verificationHelperOnly: true,
            cwd,
            changedPaths: ["tool.py", "tests/test_tool.py"],
          });
          if (r.flippedToLast) lastFlipped = true;
        }
        const s = loadUlwCycle(sid)!;
        assert.ok(s.wave <= 2, `w stuck, got ${s.wave}`);
        assert.ok(
          (s.pinCreditRefused ?? 0) >= 1 || (s.jobThinStreak ?? 0) >= 1,
          "pin/chrome mill must refuse credit",
        );
        assert.ok(
          lastFlipped || s.cycle === 0 || (s.jobThinStreak ?? 0) >= 3,
          "PLAN/LAST on a thick mill",
        );
        const holes = ledgerMustFixItems(s);
        assert.ok(holes.length > 0, "Must-fix non-empty if suite never ran");
        const card = applyLastReflectGate(
          { lastReflect: "score" },
          "Must-fix: none\nLive-with: chrome",
          { ledgerMustFix: holes },
        );
        assert.equal(card.block, true);
        assert.ok((card.reanchor || "").length > 0);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  it("capped run of 5 same-surface closers stamps w<=3 not w=5", () => {
    withHome(() => {
      const sid = "mill-cap5";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwReady(sid, "Improve this game.", {
        cycle: 1,
        maxWaves: 20,
        skipCheckpoint: true,
      });
      const closers = [
        "Wave shipped: rest only names what you have actually lived.",
        "Wave shipped: rest now only names what you have actually lived on dry stone.",
        "Wave shipped: the leftover rest card no longer names water, weight, or the hidden hour.",
        "Wave shipped: leftover rest card still names water. Fix that only.",
        "Wave shipped: leftover rest copy is the last sibling. Fix that only.",
      ];
      let edits = 0;
      for (const msg of closers) {
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
      assert.ok(s.wave <= 3, `expected mill hold, w=${s.wave}`);
      assert.notEqual(s.wave, 5);
      assert.equal(sameSurfaceHolding(s), true);
    });
  });

  it("a control-flow ship still increments w", () => {
    withHome(() => {
      const sid = "mill-cf";
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mill-cf-"));
      try {
        fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
          recursive: true,
        });
        fs.mkdirSync(path.join(cwd, "tests"));
        fs.writeFileSync(
          path.join(cwd, "tool.py"),
          "def idle_before_require_backend_cli(s):\n    if not s.get('ready'):\n        return False\n    return True\n",
        );
        fs.writeFileSync(path.join(cwd, "tests/test_tool.py"), PY_BEH);
        armUlwReady(sid, "Improve this tool.", {
          cycle: 1,
          maxWaves: 20,
          skipCheckpoint: true,
        });
        const r = maybeStampUlwWave({
          sessionId: sid,
          editCount: 10,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage:
            "Wave shipped: idle gate runs before the backend CLI is required.",
          verificationPassed: true,
          cwd,
          changedPaths: ["tool.py", "tests/test_tool.py"],
          // Unified diff so production classifies as control-flow/new-module.
        });
        // Without git, behavioral tests still credit.
        assert.equal(r.stamped, true, r.admit);
        assert.equal(loadUlwCycle(sid)!.wave, 1);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  it("evaluate garnish repeats after wave 3 (soulNudgeDone does not waive)", () => {
    withHome(() => {
      const sid = "mill-garnish";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwReady(
        sid,
        "Evaluate this game and then improve it.",
        { cycle: 1, skipCheckpoint: true },
      );
      let edits = 0;
      for (const msg of [
        "Wave shipped: rest only names what you have actually lived.",
        "Wave shipped: rest now only names what you have actually lived on dry stone.",
        "Wave shipped: the leftover rest card no longer names water.",
      ]) {
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
      held.soulNudgeDone = true;
      saveUlwCycle(held);
      const d = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "Wave shipped: leftover rest card still names water. Fix that only.",
        editCount: edits + 8,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(d.block, true);
      assert.match(d.reanchor || "", /garnish|same surface|different class/i);
      assert.equal(loadUlwCycle(sid)!.wave, held.wave);
    });
  });
});
