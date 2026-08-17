import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isExplorePickDone,
  isSamePickTopic,
} from "../src/harness/explore-contract.js";
import {
  armUlwCycle,
  citesIsolateOnlyPass,
  detectWaveProof,
  disarmUlwCycle,
  evaluateUlwAtStop,
  loadUlwCycle,
  maybeAdoptNamedShips,
  maybeStampUlwWave,
  namedShipsExhausted,
  parseCitedSuiteFailCount,
  saveUlwCycle,
  seedNamedShipsFromExploreMaps,
} from "../src/harness/ulw-cycle.js";
import { buildStructuredSummary } from "../src/session/compaction.js";

const PICK_A =
  "Wave 1 should give floors 6–13 their own fights and journal, not more combat juice or Hearth chrome.";
const PICK_B =
  "After ~190 ULW couple-fairness ships, the play-hurting leftover is online is maze-only — joiner cannot follow into the Hearth and several host overlays never exist on their laptop.";
const CLAIMS_A = [
  "only floor 5 forces an Archivist; 10/13 do not",
  "lantern halls (6–10) reuse the Vault/Stacks roster",
  "journal chapters cover 1–5 then jump to 11–13",
];
const CLAIMS_B = [
  "MSG.OVER: joiner cannot enter Hearth — Reload-to-title only",
];
const WAVE1 =
  "Wave shipped: Long Walk/Memory Walk encounter staging — unique lantern-halls + remembering monsters, climactic spawn at floors 5/10/13, Long Walk journal beats.";
const WAVE62 =
  "Wave shipped: OVER → joiner's own Hearth. takeJoinerOverHome. No reload. Reload-to-title is gone.";
const WAVE74 =
  "Wave shipped: the joiner hears the well. Host heard the sip. Toast-on-the-wire.";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pick-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeMaps(sid: string): void {
  const dir = path.join(process.env.FORGE_HOME!, "sessions", sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      exploreMaps: [
        {
          pick: PICK_A,
          files: CLAIMS_A.map((claim) => ({
            path: "src/scenes/maze.js",
            line: 1,
            claim,
          })),
          at: new Date().toISOString(),
        },
        {
          pick: PICK_B,
          files: CLAIMS_B.map((claim) => ({
            path: "src/scenes/online_client.js",
            line: 353,
            claim,
          })),
          at: new Date().toISOString(),
        },
      ],
    }),
  );
}

describe("explore pick done vs topic", () => {
  it("marks the climb and joiner Home, not toast-on-the-wire", () => {
    assert.equal(isExplorePickDone(WAVE1, PICK_A, CLAIMS_A), true);
    assert.equal(isExplorePickDone(WAVE74, PICK_A, CLAIMS_A), false);
    assert.equal(isExplorePickDone(WAVE62, PICK_B, CLAIMS_B), true);
    assert.equal(isExplorePickDone(WAVE74, PICK_B, CLAIMS_B), false);
    assert.equal(isSamePickTopic(WAVE74, [PICK_B]), true);
    assert.equal(
      isSamePickTopic(
        "Reading: Memory Walk as a 13-floor reskin, not couple copy.",
        [PICK_B],
      ),
      false,
    );
  });
});

describe("seeded picks exhaust after the jobs, not the mill", () => {
  it("seeds maps, completes A then B, holds on joiner-hears-well", () => {
    withHome(() => {
      const sid = "pick-8e68638e";
      writeMaps(sid);
      armUlwCycle(sid, "Improve this game based on comprehensive evaluation and understanding.", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      assert.equal(seedNamedShipsFromExploreMaps(sid), true);
      const seeded = loadUlwCycle(sid)!;
      assert.equal(seeded.namedShips?.length, 2);
      assert.ok(seeded.namedShips?.every((x) => x.source === "explore-map"));
      assert.equal(namedShipsExhausted(seeded), false);

      const w1 = maybeStampUlwWave({
        sessionId: sid,
        editCount: 20,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: WAVE1,
        verificationPassed: true,
      });
      assert.equal(w1.stamped, true);
      const afterA = loadUlwCycle(sid)!;
      const aDone = afterA.namedShips?.filter((x) => x.status === "done") ?? [];
      const aOpen = afterA.namedShips?.filter((x) => x.status === "open") ?? [];
      assert.equal(aDone.length, 1, "pick A done");
      assert.equal(aOpen.length, 1, "pick B still open — no FIFO");

      const toast = maybeStampUlwWave({
        sessionId: sid,
        editCount: 30,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: WAVE74,
        verificationPassed: true,
      });
      assert.equal(toast.stamped, true);
      assert.equal(
        loadUlwCycle(sid)!.namedShips?.filter((x) => x.status === "open").length,
        1,
        "toast-wire must not complete pick B",
      );

      const w62 = maybeStampUlwWave({
        sessionId: sid,
        editCount: 50,
        openTodoCount: 0,
        stepsSinceStamp: 1,
        lastAssistantMessage: WAVE62,
        verificationPassed: true,
      });
      assert.equal(w62.stamped, true);
      const exhausted = loadUlwCycle(sid)!;
      assert.equal(namedShipsExhausted(exhausted), true);

      exhausted.soulNudgeDone = true;
      saveUlwCycle(exhausted);

      const blocked = evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: WAVE74,
        editCount: 60,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(blocked.block, true);
      assert.match(blocked.reanchor || "", /named ships|new Reading|cycle 0/i);
      assert.equal(
        maybeAdoptNamedShips(
          loadUlwCycle(sid)!,
          "Reading: The ONE ship is the joiner hears the well. Toast-on-the-wire.",
        ),
        false,
        "topic recap must not adopt after exhaust",
      );
      disarmUlwCycle(sid);
    });
  });

  it("capped runs do not seed a hold list", () => {
    withHome(() => {
      const sid = "pick-cap";
      writeMaps(sid);
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        maxWaves: 20,
        skipCheckpoint: true,
      });
      assert.equal(seedNamedShipsFromExploreMaps(sid), false);
      assert.equal(loadUlwCycle(sid)!.namedShips?.length ?? 0, 0);
      disarmUlwCycle(sid);
    });
  });

  it("compact job card reprints open seeded picks", () => {
    withHome(() => {
      const sid = "pick-compact";
      writeMaps(sid);
      armUlwCycle(sid, "Improve this game.", {
        cycle: 1,
        skipCheckpoint: true,
      });
      seedNamedShipsFromExploreMaps(sid);
      const card = buildStructuredSummary(
        [{ role: "user", content: "Improve this game." }],
        { ulw: loadUlwCycle(sid), sessionId: sid },
      );
      assert.match(card, /Open named ships/i);
      assert.match(card, /floors 6/i);
      disarmUlwCycle(sid);
    });
  });
});

describe("isolate cite is not wave proof", () => {
  it("parses cited full-suite fails and isolate-only passes", () => {
    assert.equal(parseCitedSuiteFailCount("5008 / 65 fail — same pin-rot"), 65);
    assert.equal(parseCitedSuiteFailCount("4978 pass / 131 fail"), 131);
    assert.equal(parseCitedSuiteFailCount("22/22 pass"), undefined);
    assert.equal(citesIsolateOnlyPass("W77–79 stay green (43/43)."), true);
    assert.equal(citesIsolateOnlyPass("npm test → 187 pass, 0 fail"), false);
  });

  it("helper-only + 22/22 is not proof; cited 67 fail is not proof", () => {
    assert.equal(
      detectWaveProof("22/22 pass. Wave shipped.", false, { helperOnly: true }),
      false,
    );
    assert.equal(
      detectWaveProof("Full suite: 5300 pass / 67 fail. Wave shipped.", true),
      false,
    );
    assert.equal(
      detectWaveProof("npm test → 187 tests pass.", true),
      true,
    );
  });
});
