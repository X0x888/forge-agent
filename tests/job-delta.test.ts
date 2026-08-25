import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHROME_PATH_HOLD,
  decideWaveJobCredit,
  isBehavioralTestSource,
  isChromeOnlyPaths,
  isPinOnlyTestSource,
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
    assert.deepEqual(d, { ok: true, chrome: false });
  });

  it("empty paths do not refuse (unknown is not chrome)", () => {
    assert.deepEqual(decideWaveJobCredit({ paths: [] }), {
      ok: true,
      chrome: false,
    });
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
