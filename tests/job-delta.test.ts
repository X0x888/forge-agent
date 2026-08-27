import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHROME_PATH_HOLD,
  classifyProdEditKindFromDiff,
  decideWaveJobCredit,
  isBehavioralTestSource,
  isChromeOnlyPaths,
  isPinOnlyTestSource,
  sameTreeSurface,
  treeSurfaceKey,
  PIN_ONLY_ADMIT,
  JOB_FLAT_ADMIT,
  waveTestProofKind,
} from "../src/harness/job-delta.js";

const PIN_ONLY = `
import { test } from 'node:test';
import { pinPresent, readSrc } from './_helpers/pins.mjs';
test('settings is a ledger', () => {
  pinPresent(readSrc('style.css'), 'cream leaf', /settings-ledger/);
});
`;

const BEHAVIORAL = `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hopGoldFromBody, goldHopCount } from '../src/systems/gold-hop.js';
import { pinPresent, readSrc } from './_helpers/pins.mjs';
test('coins hop', () => {
  const spawned = [];
  assert.equal(hopGoldFromBody({ spawn: (o) => spawned.push(o) }, { fromX: 1, fromY: 1, toX: 2, toY: 1, gold: 4 }), goldHopCount(4));
});
test('wired', () => {
  pinPresent(readSrc('src/scenes/maze.js'), 'hop on kill', /hopKillGold/);
});
`;

describe("job-delta", () => {
  it("detects pin-only vs mixed behavioral tests", () => {
    assert.equal(isPinOnlyTestSource(PIN_ONLY), true);
    assert.equal(isBehavioralTestSource(PIN_ONLY), false);
    assert.equal(isPinOnlyTestSource(BEHAVIORAL), false);
    assert.equal(isBehavioralTestSource(BEHAVIORAL), true);
  });

  it("treats css/md/test paths as chrome-only", () => {
    assert.equal(
      isChromeOnlyPaths(["style.css", "tests/w-settings-ledger.test.mjs"]),
      true,
    );
    assert.equal(
      isChromeOnlyPaths(["src/systems/gold-hop.js", "tests/w-gold-hop.test.mjs"]),
      false,
    );
    assert.equal(isChromeOnlyPaths([]), false);
  });

  it("refuses pin-taint and pin-only tests", () => {
    const pin = decideWaveJobCredit({
      paths: ["src/ui/overlay/settings.js", "tests/w-settings.test.mjs"],
      pinTaint: true,
    });
    assert.equal(pin.ok, false);
    if (!pin.ok) {
      assert.equal(pin.reason, "pin");
      assert.equal(pin.admit, PIN_ONLY_ADMIT);
    }
  });

  it("refuses a second consecutive chrome-only ship", () => {
    const first = decideWaveJobCredit({
      paths: ["style.css", "tests/w-cook-empty.test.mjs"],
      chromeStreak: 0,
    });
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.chrome, true);
    const second = decideWaveJobCredit({
      paths: ["style.css", "CHANGELOG.md"],
      chromeStreak: CHROME_PATH_HOLD,
    });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.reason, "chrome");
      assert.equal(second.admit, JOB_FLAT_ADMIT);
    }
  });

  it("play-loop always credits", () => {
    const d = decideWaveJobCredit({
      paths: ["style.css"],
      pinTaint: true,
      playLoop: true,
      chromeStreak: 4,
    });
    assert.deepEqual(d, { ok: true, chrome: false, kind: "control-flow" });
  });

  it("empty paths without cwd do not refuse (closer-only tests)", () => {
    assert.deepEqual(decideWaveJobCredit({ paths: [] }), {
      ok: true,
      chrome: false,
      kind: "unknown",
    });
  });

  it("declared empty paths with cwd are chrome, not unknown-ok", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-jd-empty-"));
    try {
      const first = decideWaveJobCredit({
        paths: [],
        cwd,
        declared: true,
      });
      assert.equal(first.ok, true);
      if (first.ok) assert.equal(first.chrome, true);
      const second = decideWaveJobCredit({
        paths: [],
        cwd,
        declared: true,
        chromeStreak: CHROME_PATH_HOLD,
      });
      assert.equal(second.ok, false);
      if (!second.ok) assert.equal(second.reason, "chrome");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("classifies tests on disk", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-jd-"));
    try {
      fs.mkdirSync(path.join(cwd, "tests"));
      fs.writeFileSync(path.join(cwd, "tests/w-pin.test.mjs"), PIN_ONLY);
      fs.writeFileSync(path.join(cwd, "tests/w-hop.test.mjs"), BEHAVIORAL);
      assert.equal(
        waveTestProofKind({ cwd, paths: ["tests/w-pin.test.mjs"] }),
        "pin-only",
      );
      assert.equal(
        waveTestProofKind({
          cwd,
          paths: ["tests/w-pin.test.mjs", "tests/w-hop.test.mjs"],
        }),
        "behavioral",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

const PY_TTY_PIN = `
import io
import unittest
from cli import format_status

class TestStatus(unittest.TestCase):
    def test_status_line(self):
        buf = io.StringIO()
        format_status(buf)
        self.assertIn("READY", buf.getvalue())
        self.assertNotIn("abs path", buf.getvalue())
`;

const PY_BEHAVIORAL = `
import unittest
from cli import idle_before_require_backend_cli

class TestIdle(unittest.TestCase):
    def test_idle_gate(self):
        self.assertTrue(idle_before_require_backend_cli({"ready": True}))
`;

describe("job-delta language-agnostic pins", () => {
  it("treats Python assertIn on captured TTY as pin-only", () => {
    assert.equal(isPinOnlyTestSource(PY_TTY_PIN), true);
    assert.equal(isBehavioralTestSource(PY_TTY_PIN), false);
    assert.equal(
      isPinOnlyTestSource(`
import unittest
from tool import items
class T(unittest.TestCase):
    def test_has(self):
        self.assertIn("idle", items())
`),
      false,
    );
  });

  it("treats Python assertTrue on a production function as behavioral", () => {
    assert.equal(isBehavioralTestSource(PY_BEHAVIORAL), true);
    assert.equal(isPinOnlyTestSource(PY_BEHAVIORAL), false);
  });

  it("refuses Python TTY pin tests even with a production .py path", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-jd-py-"));
    try {
      fs.mkdirSync(path.join(cwd, "tests"));
      fs.writeFileSync(path.join(cwd, "cli.py"), 'print("READY")\n');
      fs.writeFileSync(path.join(cwd, "tests/test_cli.py"), PY_TTY_PIN);
      const d = decideWaveJobCredit({
        cwd,
        paths: ["cli.py", "tests/test_cli.py"],
        declared: true,
      });
      assert.equal(d.ok, false);
      if (!d.ok) assert.equal(d.reason, "pin");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("credits a control-flow production ship with behavioral tests", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-jd-cf-"));
    try {
      fs.mkdirSync(path.join(cwd, "tests"));
      fs.writeFileSync(
        path.join(cwd, "cli.py"),
        "def idle_before_require_backend_cli(s):\n    if not s.get('ready'):\n        return False\n    return True\n",
      );
      fs.writeFileSync(path.join(cwd, "tests/test_cli.py"), PY_BEHAVIORAL);
      const d = decideWaveJobCredit({
        cwd,
        paths: ["cli.py", "tests/test_cli.py"],
        declared: true,
        diffs: {
          "cli.py": `diff --git a/cli.py b/cli.py
new file mode 100644
--- /dev/null
+++ b/cli.py
@@ -0,0 +1,4 @@
+def idle_before_require_backend_cli(s):
+    if not s.get('ready'):
+        return False
+    return True
`,
        },
      });
      assert.equal(d.ok, true, JSON.stringify(d));
      if (d.ok) {
        assert.equal(d.chrome, false);
        assert.equal(d.kind, "new-module");
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("classifies string-literal / TTY diffs vs control-flow", () => {
    assert.equal(
      classifyProdEditKindFromDiff(`
--- a/cli.py
+++ b/cli.py
@@ -1,2 +1,2 @@
-print("READY")
+print("BUSY")
`),
      "tty",
    );
    assert.equal(
      classifyProdEditKindFromDiff(`
--- a/cli.py
+++ b/cli.py
@@ -1,1 +1,4 @@
 def run():
+    if idle:
+        return False
     return True
`),
      "control-flow",
    );
  });

  it("clusters the same 1–3 production files as one tree surface", () => {
    const a = treeSurfaceKey(["cli.py", "tests/test_cli.py"], "tty");
    const b = treeSurfaceKey(["cli.py", "tests/test_cli.py"], "string-literal");
    const c = treeSurfaceKey(["cli.py"], "control-flow");
    assert.equal(sameTreeSurface(a, b), true);
    assert.equal(sameTreeSurface(a, c), false);
  });
});
