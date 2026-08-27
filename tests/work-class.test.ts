import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  factoryClassHolding,
  isAdjacentShareSchema,
  isChangelogOnlySummary,
  isFactoryFingerprint,
  isMillClassShip,
  isSameClassReading,
  isSpeakOnceSchema,
  matchesRecentSchema,
  shipSchema,
} from "../src/harness/work-class.js";
import {
  matchesRecentSurface,
  nextSameSurfaceStreak,
  SAME_SURFACE_HOLD,
} from "../src/harness/same-surface.js";
import { extractShipSummary, isShipCloseText } from "../src/harness/ship-close.js";
import { buildAutoCommitSubject } from "../src/util/git-auto-commit.js";
import { armUlwReady as armUlwCycle } from "./helpers/ulw-arm.js";
import {
  bestWave,
  disarmUlwCycle,
  evaluateUlwAtStop,
  isVerificationOutputPipe,
  loadUlwCycle,
  maybeAdoptNamedShips,
  maybeStampUlwWave,
  noteExploreChildCompleted,
  parseTestFailCount,
  saveUlwCycle,
  verificationPassedFromResult,
} from "../src/harness/ulw-cycle.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BRAZIER = `Reading: Last ship was the moss. What's still hard is the brazier — they stand beside you in the dark.

Shipped: The brazier lights you both. Far stays the walker's.

Wave shipped.`;

const MOSS = `Reading: Last ship was the pot. What's still hard is the moss — they stood beside you hurt.

Shipped: The moss now sips them too. Far stays the wearer's.

Wave shipped.`;

const POT = `Reading: Last ship was the brazier. What's still hard is the pot — they cooked together.

Shipped: A real maze dish now lets both taste the steam. Far stays the bag's.

Wave shipped.`;

const OVERFLOW = `Reading: Last ship was the brazier. What's still hard is the loot — they stand beside you with room.

Shipped: What you can't carry goes to them. Far stays under your feet.

Wave shipped.`;

const HUSH = `Reading: Last ship was the loaf. What's still hard is the hush — they wore the amulet beside you.

Shipped: Their quiet now covers you. Far still walks loud.

Wave shipped.`;

const REVIVE =
  "ACT-vs-revive collision: first tap no longer swings at a downed partner.";
const MEMORY =
  "Memory Walk must find the kept letter before the portal opens.";

describe("factory fingerprint + adjacent-share schema", () => {
  it("flags log10 mill closers and not Wave-1 bugs", () => {
    assert.equal(isFactoryFingerprint(BRAZIER), true);
    assert.equal(isFactoryFingerprint(MOSS), true);
    assert.equal(isAdjacentShareSchema(BRAZIER), true);
    assert.equal(isMillClassShip(OVERFLOW), true);
    assert.equal(isFactoryFingerprint(REVIVE), false);
    assert.equal(isAdjacentShareSchema(REVIVE), false);
    assert.equal(isMillClassShip(MEMORY), false);
    assert.equal(shipSchema(BRAZIER), "factory");
    assert.equal(shipSchema(REVIVE), undefined);
  });

  it("Far stays alone is game voice, not a schema", () => {
    assert.equal(isAdjacentShareSchema("Far stays the walker's."), false);
    assert.equal(
      isMillClassShip(
        "Shipped: Memory Walk finds the letter. Far stays the walker's.",
      ),
      false,
    );
    assert.equal(
      isMillClassShip(
        "Shipped: Far still waits at the stargazer until they stand up.",
      ),
      false,
    );
    assert.equal(
      isMillClassShip(
        "Shipped: Memory Walk finds the letter. Far stays the walker's.",
        { onContract: true },
      ),
      false,
    );
    assert.equal(
      isSameClassReading(
        [BRAZIER, MOSS],
        ["Memory Walk as a 13-floor reskin, not couple copy"],
        { onContract: true },
      ),
      false,
    );
  });

  it("rotating nouns are the same schema", () => {
    assert.equal(matchesRecentSchema([BRAZIER, MOSS], POT), true);
    assert.equal(matchesRecentSurface([BRAZIER, MOSS], POT), true);
    assert.equal(matchesRecentSchema([REVIVE], MEMORY), false);
  });

  it("factory class holds at 5 of 8", () => {
    const prev = [BRAZIER, MOSS, POT, OVERFLOW];
    assert.equal(factoryClassHolding(prev, HUSH), true);
    assert.equal(factoryClassHolding([BRAZIER, MOSS], POT), false);
  });

  it("refuses a one-ship mill reading after mill waves", () => {
    assert.equal(
      isSameClassReading(
        [BRAZIER, MOSS, POT],
        ["What's still hard is the hush — they stand beside you. Far stays."],
      ),
      true,
    );
    assert.equal(
      isSameClassReading([BRAZIER, MOSS], ["stdin lease is still the hard work"]),
      false,
    );
  });

  it("schema streak reaches hold on three mill ships", () => {
    const a = nextSameSurfaceStreak([], BRAZIER, 0);
    const b = nextSameSurfaceStreak([BRAZIER], MOSS, a.streak);
    assert.equal(b.same, true);
    const c = nextSameSurfaceStreak([BRAZIER, MOSS], POT, b.streak);
    assert.equal(c.same, true);
    assert.ok(c.streak >= SAME_SURFACE_HOLD, `streak=${c.streak}`);
  });
});

describe("Shipped: grammar + subjects", () => {
  it("extracts Shipped: before empty Wave shipped", () => {
    assert.equal(isShipCloseText(BRAZIER), true);
    const body = extractShipSummary(BRAZIER) || "";
    assert.match(body, /brazier lights you both/i);
    assert.doesNotMatch(body, /^Proof:/);
  });

  it("does not treat 'shipped input validation' as a close", () => {
    assert.equal(isShipCloseText("shipped input validation"), false);
  });

  it("auto-commit subject prefers Shipped: over the mandate", () => {
    const s = buildAutoCommitSubject(
      "Improve this game based on comprehensive evaluation and understanding.",
      BRAZIER,
    );
    assert.match(s, /brazier/i);
    assert.doesNotMatch(s, /comprehensive evaluation/i);
  });
});

describe("honest verification", () => {
  it("parses node:test fail counts from a grepped tail", () => {
    const out = "ℹ tests 4931\nℹ pass 4867\nℹ fail 64\nℹ cancelled 0\n";
    assert.equal(parseTestFailCount(out), 64);
    assert.equal(parseTestFailCount("ℹ fail 0\n"), 0);
    assert.equal(parseTestFailCount("FAILED (failures=2, errors=1)\n"), 3);
    assert.equal(parseTestFailCount("===== 4 failed, 10 passed in 0.2s =====\n"), 4);
    assert.equal(parseTestFailCount("command hung waiting for result\n"), 1);
    assert.equal(
      parseTestFailCount("1 passed in 0.20s — retry on timeout\n"),
      undefined,
    );
  });

  it("treats npm test | grep as a pipe, and fail 64 as not passed", () => {
    const cmd = 'npm test 2>&1 | grep -E "ℹ (tests|pass|fail) "';
    assert.equal(isVerificationOutputPipe(cmd), true);
    assert.equal(
      verificationPassedFromResult({
        command: cmd,
        isError: false,
        output: "ℹ tests 4931\nℹ pass 4867\nℹ fail 64\n",
      }),
      false,
    );
    assert.equal(
      verificationPassedFromResult({
        command: "npm test",
        isError: false,
        output: "ℹ fail 0\n",
      }),
      true,
    );
  });
});

describe("unlimited adopt + stamp refuse the mill", () => {
  function withHome(fn: () => void): void {
    const prev = process.env.FORGE_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-wc-"));
    process.env.FORGE_HOME = dir;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("holds after three mill ships and refuses the next mill reading", () => {
    withHome(() => {
      const sid = "wc-mill";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      let edits = 0;
      for (const msg of [BRAZIER, MOSS, POT]) {
        edits += 8;
        const r = maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: msg,
          verificationPassed: true,
        });
        assert.equal(r.stamped, true, msg.slice(0, 40));
      }
      const s = loadUlwCycle(sid)!;
      assert.ok((s.sameSurfaceStreak ?? 0) >= 3);
      assert.equal(s.sameSurfaceHold, true);
      s.soulNudgeDone = true;
      saveUlwCycle(s);

      const blocked = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: HUSH,
        editCount: edits + 8,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(blocked.block, true);
      assert.match(
        blocked.reanchor || "",
        /same surface|factory class|different class|explore/i,
      );
      assert.equal(loadUlwCycle(sid)!.wave, 3, "mill sibling must not increment w");

      const after = loadUlwCycle(sid)!;
      after.namedShipAdmitCount = 1;
      after.namedShips = [{ text: "the brazier lights you both", status: "done" }];
      saveUlwCycle(after);
      const adopted = maybeAdoptNamedShips(
        loadUlwCycle(sid)!,
        "Reading: Last ship was the pot. What's still hard is the hush — they stand beside you. Far stays.",
      );
      assert.equal(adopted, false);
      disarmUlwCycle(sid);
    });
  });

  it("bounces once with Wave 1 picks when mill continues", () => {
    withHome(() => {
      const sid = "wc-reprint";
      const dir = path.join(process.env.FORGE_HOME!, "sessions", sid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({
          exploreMaps: [
            {
              pick: "Memory Walk is CoupleMaze + copy, not find past memories",
              files: [],
              at: new Date().toISOString(),
            },
          ],
        }),
      );
      armUlwCycle(sid, "Evaluate this game and then improve it.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      let edits = 0;
      for (const msg of [BRAZIER, MOSS, POT]) {
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
      const blocked = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: HUSH,
        editCount: edits + 8,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(blocked.block, true);
      assert.match(blocked.reanchor || "", /Wave 1|Explore-map picks|garnish/i);
      assert.equal(loadUlwCycle(sid)!.soulNudgeDone, true);
      disarmUlwCycle(sid);
    });
  });

  it("Memory Walk + Far stays is a pick, not a mill sibling", () => {
    withHome(() => {
      const sid = "wc-mw";
      const dir = path.join(process.env.FORGE_HOME!, "sessions", sid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({
          exploreMaps: [
            {
              pick:
                "Memory Walk is CoupleMaze + copy, not find past memories; next: online-Hearth, same-BSP topology",
              files: [],
              at: new Date().toISOString(),
            },
          ],
        }),
      );
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      let edits = 0;
      for (const msg of [BRAZIER, MOSS, POT]) {
        edits += 8;
        const r = maybeStampUlwWave({
          sessionId: sid,
          editCount: edits,
          openTodoCount: 0,
          stepsSinceStamp: 1,
          lastAssistantMessage: msg,
          verificationPassed: true,
        });
        assert.equal(r.stamped, true, msg.slice(0, 40));
      }
      const held = loadUlwCycle(sid)!;
      assert.equal(held.sameSurfaceHold, true);
      assert.equal(held.exploreRequired, true);
      held.soulNudgeDone = true;
      held.namedShipAdmitCount = 1;
      held.namedShips = [{ text: "the brazier lights you both", status: "done" }];
      saveUlwCycle(held);

      const blockedAdopt = maybeAdoptNamedShips(
        loadUlwCycle(sid)!,
        "Reading: The one ship is Memory Walk as a 13-floor reskin, not couple copy.",
      );
      assert.equal(blockedAdopt, false, "pick reading waits for mid-run explore");
      assert.equal(noteExploreChildCompleted(sid), true);

      const adopted = maybeAdoptNamedShips(
        loadUlwCycle(sid)!,
        "Reading: The one ship is Memory Walk as a 13-floor reskin, not couple copy.",
      );
      assert.equal(adopted, true, "pick reading must adopt after mill hold");

      const mw =
        "Shipped: Memory Walk now finds the kept letter before the portal opens. Far stays the walker's.\n\nWave shipped.";
      const r = maybeStampUlwWave({
        sessionId: sid,
        editCount: edits + 10,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: mw,
        verificationPassed: true,
      });
      assert.equal(r.stamped, true, "on-contract Memory Walk must stamp");
      const after = loadUlwCycle(sid)!;
      assert.equal(after.wave, 4);
      assert.equal(after.sameSurfaceHold, false);
      const last = after.waves?.[after.waves.length - 1];
      assert.equal(last?.millClass, undefined);
      assert.match(after.waves?.[0]?.classText || "", /Last ship was/i);
      disarmUlwCycle(sid);
    });
  });
});

const WATER_ONCE =
  "**Job:** the first water used to talk every frame. Standing in it filled the head with the same line until you left. Now the feet speak once when they get wet.";
const WANDERER_ONCE =
  "**Job:** the first other person used to stay silent until you stood on their tile long enough. Now, when you first share an opening with them, a thought comes once: Someone is here.";
const GLOW_ONCE =
  "**Job:** the first way onward used to glow in silence. Now the first time that glow is along the corridor, a thought comes once: A light that is not the torch.";
const BURDEN_ONCE =
  "**Job:** a heavy load used to talk every frame. Now the body speaks once when the load first becomes too much.";
const ENDING =
  "**Job:** the first ending used to count. Now the ending names the life. Empty hands. One thing.";
const PLACEMENT =
  "**Job:** a first life could wake and walk a hollow maze. Now one thing always waits a few steps from waking.";
const DROWN =
  "Wave shipped: drowning now claims a burdened body after a felt wait.";

describe("speak-once schema (maze max20 mill)", () => {
  it("flags rotating first-X speaks-once jobs", () => {
    assert.equal(isSpeakOnceSchema(WATER_ONCE), true);
    assert.equal(isSpeakOnceSchema(WANDERER_ONCE), true);
    assert.equal(isSpeakOnceSchema(GLOW_ONCE), true);
    assert.equal(isSpeakOnceSchema(BURDEN_ONCE), true);
    assert.equal(shipSchema(WATER_ONCE), "speak-once");
    assert.equal(isMillClassShip(WATER_ONCE), true);
  });

  it("does not treat placement, drowning, or ending copy as speak-once", () => {
    assert.equal(isSpeakOnceSchema(PLACEMENT), false);
    assert.equal(isSpeakOnceSchema(DROWN), false);
    assert.equal(isSpeakOnceSchema(ENDING), false);
    assert.equal(isMillClassShip(PLACEMENT), false);
  });

  it("three speak-once siblings are the same surface", () => {
    assert.equal(matchesRecentSchema([WATER_ONCE], WANDERER_ONCE), true);
    assert.equal(matchesRecentSurface([WATER_ONCE], WANDERER_ONCE), true);
    const a = nextSameSurfaceStreak([], WATER_ONCE, 0);
    const b = nextSameSurfaceStreak([WATER_ONCE], WANDERER_ONCE, a.streak);
    const c = nextSameSurfaceStreak(
      [WATER_ONCE, WANDERER_ONCE],
      GLOW_ONCE,
      b.streak,
    );
    assert.equal(b.same, true);
    assert.equal(c.same, true);
    assert.ok(c.streak >= SAME_SURFACE_HOLD, `streak=${c.streak}`);
  });
});

describe("bestWave excludes factory + changelog-only", () => {
  it("keeps the revive wave as the bar over later mill ships", () => {
    const best = bestWave([
      {
        wave: 1,
        editDelta: 7,
        proof: true,
        summary: REVIVE,
        ts: "",
      },
      {
        wave: 80,
        editDelta: 16,
        proof: true,
        summary: BRAZIER,
        ts: "",
      },
      {
        wave: 81,
        editDelta: 0,
        proof: true,
        summary: "Wave 81 consolidation. No new scope.",
        ts: "",
      },
    ]);
    assert.equal(best!.wave, 1);
    assert.equal(isChangelogOnlySummary("Wave 81 consolidation. No new scope.", 0), true);
  });
});
