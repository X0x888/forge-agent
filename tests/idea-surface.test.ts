/**
 * Idea-surface hold: one sentence painted onto every chrome.
 * HashPet (791 waves): "names the found chew" shipped on 29 files, ten in
 * a row, and the per-file same-surface streak never passed 1.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  IDEA_FILE_HOLD,
  IDEA_LOOKBACK,
  formatIdeaHoldAdmit,
  ideaHoldReleases,
  ideaMantras,
  ideaNoteFor,
  ideaSignature,
  sameIdea,
  treeKeyFiles,
} from "../src/harness/idea-surface.js";
import {
  armUlwCycle,
  evaluateUlwAtStop,
  formatUlwStatus,
  ideaHolding,
  loadUlwCycle,
  markUlwPlanDone,
  maybeStampUlwWave,
  notePlayLoopRan,
  sameSurfaceHolding,
  scheduleCycleZeroStop,
} from "../src/harness/ulw-cycle.js";
import { ledgerMustFixItems } from "../src/harness/last-reflect.js";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-idea-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mkSession(sid: string): void {
  fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
}

type Counter = { edits: number };

function stamper(sid: string, c: Counter) {
  return (msg: string, paths: string[]) => {
    c.edits += 6;
    return maybeStampUlwWave({
      sessionId: sid,
      editCount: c.edits,
      openTodoCount: 0,
      stepsSinceStamp: 1,
      lastAssistantMessage: msg,
      verificationPassed: true,
      changedPaths: paths,
    });
  };
}

function stopper(sid: string, c: Counter) {
  return (msg: string, paths: string[]) => {
    c.edits += 6;
    return evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: msg,
      editCount: c.edits,
      openTodoCount: 0,
      stuckThreshold: 5,
      verificationPassed: true,
      changedPaths: paths,
    });
  };
}

/** The HashPet paint: one sentence, a different file each wave. */
const PAINT: Array<{ msg: string; paths: string[] }> = [
  {
    msg: "**Wave shipped.** **Ship landed:** Toolbar names the found chew — `badge.ts` `careBadgeTitle`. After a found chew the toolbar says **Nexus ate Philosophy.** Never a hostname. Verify: `cd extension && npm test` — exit 0.",
    paths: ["extension/src/lib/badge.ts"],
  },
  {
    msg: "**Wave shipped.** **Ship landed:** Miner card names the found chew — `DigitalLifeform.tsx` `minerCardLine`. The miner card says **ate Philosophy** after a found chew. Never a hostname. Verify: `cd extension && npm test` — exit 0.",
    paths: ["extension/src/components/DigitalLifeform.tsx"],
  },
  {
    msg: "**Wave shipped.** **Ship landed:** Ticker names the found chew — `home-ticker.ts` `tickerBeat`. The 12s beat says **Nexus ate Philosophy.** after a found chew. Never a hostname. Verify: `cd extension && npm test` — exit 0.",
    paths: ["extension/src/lib/home-ticker.ts"],
  },
  {
    msg: "**Wave shipped.** **Ship landed:** Flask names the found chew — `StomachView.tsx` `flaskCaption`. The flask reads **ate Philosophy** after a found chew. Never a hostname. Verify: `cd extension && npm test` — exit 0.",
    paths: ["extension/src/components/StomachView.tsx"],
  },
  {
    msg: "**Wave shipped.** **Ship landed:** Insight bubble names the found chew — `insight-generator.ts` `huntAteInsight`. The bubble says **ate Philosophy** after a found chew. Never a hostname. Verify: `cd extension && npm test` — exit 0.",
    paths: ["extension/src/lib/insight-generator.ts"],
  },
];

/** A build-out with a home: every slice touches the module the idea lives in. */
const BUILD_OUT: Array<{ msg: string; paths: string[] }> = [
  {
    msg: "Ship landed: voice table owns the meal caption — `voice.ts` `mealCaption(field)`. Verify: npm test — exit 0.",
    paths: ["extension/src/lib/voice.ts"],
  },
  {
    msg: "Ship landed: toolbar reads the meal caption from the voice table — `voice.ts` `mealCaption`, `badge.ts` imports it. Verify: npm test — exit 0.",
    paths: ["extension/src/lib/voice.ts", "extension/src/lib/badge.ts"],
  },
  {
    msg: "Ship landed: ticker reads the meal caption from the voice table — `voice.ts` `mealCaption`, `home-ticker.ts` imports it. Verify: npm test — exit 0.",
    paths: ["extension/src/lib/voice.ts", "extension/src/lib/home-ticker.ts"],
  },
  {
    msg: "Ship landed: flask reads the meal caption from the voice table — `voice.ts` `mealCaption`, `StomachView.tsx` imports it. Verify: npm test — exit 0.",
    paths: ["extension/src/lib/voice.ts", "extension/src/components/StomachView.tsx"],
  },
  {
    msg: "Ship landed: bubble reads the meal caption from the voice table — `voice.ts` `mealCaption`, `insight-generator.ts` imports it. Verify: npm test — exit 0.",
    paths: ["extension/src/lib/voice.ts", "extension/src/lib/insight-generator.ts"],
  },
];

/**
 * Arm an open mandate with a Bet whose path covers the ships — the HashPet
 * shape. On-bet ships are exempt from the per-file same-surface hold, which
 * is exactly why the paint was never held there; the idea hold must see
 * through that exemption.
 */
function armOpen(sid: string, betPath = "extension/src/") {
  mkSession(sid);
  const s = armUlwCycle(sid, "improve this game", {
    cycle: 1,
    skipCheckpoint: true,
    editCount: 0,
  });
  markUlwPlanDone(
    sid,
    `Reading: the companion voice. Ship: badge.ts careBadgeTitle. Verify: cd extension && npm test.\nBet: the companion speaks the found meal in one voice — ${betPath} — first slice: badge.ts careBadgeTitle says the field; verify: cd extension && npm test`,
  );
  return s;
}

describe("idea-surface — signatures", () => {
  it("keeps backticked identifiers whole, drops ritual words, adds bigrams", () => {
    const sig = ideaSignature(PAINT[0]!.msg);
    assert.ok(sig.includes("carebadgetitle"), sig.join(","));
    assert.ok(sig.includes("found chew"), sig.join(","));
    assert.ok(sig.includes("philosophy"));
    assert.ok(!sig.includes("shipped"));
    assert.ok(!sig.includes("verify"));
    assert.ok(!sig.includes("never"));
  });

  it("two paint closers are one idea; a paint and a build-out slice are not", () => {
    const a = ideaSignature(PAINT[0]!.msg);
    const b = ideaSignature(PAINT[1]!.msg);
    const shared = sameIdea(a, b);
    assert.ok(shared && shared.includes("found chew"), String(shared));
    const c = ideaSignature(
      "Ship landed: recovery worker resumes the digest after a restart — `recovery.ts` `resumeDigest`. Verify: npm test — exit 0.",
    );
    assert.equal(sameIdea(a, c), null);
  });

  it("a term that rides most of the window is a mantra and is dropped", () => {
    const sigs = PAINT.map((p) => ideaSignature(p.msg));
    const mantras = ideaMantras(sigs);
    // "hostname" rode every closer; "found chew" too — mantras are what the
    // window shares, so what is left must be the file-specific part.
    assert.ok(mantras.has("hostname"));
    const a = sigs[0]!;
    const b = sigs[1]!;
    const shared = sameIdea(a, b, mantras);
    // With the whole paint as the window, even "found chew" is a mantra:
    // the comparison then falls to distinct terms, and two closers about
    // different chrome share none — the note below handles this by
    // measuring mantras over a wider, mixed window.
    assert.ok(shared === null || !shared.includes("hostname"));
  });

  it("treeKeyFiles parses kind:file|file", () => {
    assert.deepEqual(treeKeyFiles("control-flow:a/b.ts|c/d.tsx"), ["a/b.ts", "c/d.tsx"]);
    assert.deepEqual(treeKeyFiles("chrome:"), []);
    assert.deepEqual(treeKeyFiles(undefined), []);
  });
});

describe("idea-surface — note and release", () => {
  const waves = (items: Array<{ msg: string; paths: string[] }>, kind = "control-flow") =>
    items.map((p) => ({
      classText: p.msg,
      summary: p.msg.slice(0, 80),
      treeSurfaceKey: `${kind}:${p.paths.join("|")}`,
    }));

  it("a 4th disjoint file for one idea holds; the same idea with a home does not", () => {
    // Mixed window so "found chew" is an idea, not a mantra: three paints
    // among unrelated ships.
    const noise = [
      { msg: "Ship landed: recovery worker resumes digest after restart — `recovery.ts`. Verify: npm test — exit 0.", paths: ["extension/src/background/recovery.ts"] },
      { msg: "Ship landed: genes sculpt the body silhouette — `visual-personality.ts` `bodyFromGenes`. Verify: npm test — exit 0.", paths: ["extension/src/lib/visual-personality.ts"] },
      { msg: "Ship landed: overnight decay sets the catch-up title — `hunger-tick.ts` `catchUpTitle`. Verify: npm test — exit 0.", paths: ["extension/src/lib/hunger-tick.ts"] },
    ];
    const prev = waves([noise[0]!, PAINT[0]!, noise[1]!, PAINT[1]!, noise[2]!, PAINT[2]!]);
    const note = ideaNoteFor(prev, PAINT[3]!.msg, PAINT[3]!.paths);
    assert.ok(note.terms.includes("found chew"), note.terms.join(","));
    assert.equal(note.files.length, IDEA_FILE_HOLD);
    assert.equal(note.home, undefined);
    assert.equal(note.hold, true);

    // Same sentence count, but every slice touches voice.ts: a home.
    const prevBuild = waves([noise[0]!, BUILD_OUT[0]!, noise[1]!, BUILD_OUT[1]!, noise[2]!, BUILD_OUT[2]!]);
    const build = ideaNoteFor(prevBuild, BUILD_OUT[3]!.msg, BUILD_OUT[3]!.paths);
    assert.ok(build.terms.length >= 2, build.terms.join(","));
    assert.equal(build.home, "extension/src/lib/voice.ts");
    assert.equal(build.hold, false);

    // Three files is the advisory, not the hold.
    const three = ideaNoteFor(waves([noise[0]!, PAINT[0]!, noise[1]!, PAINT[1]!]), PAINT[2]!.msg, PAINT[2]!.paths);
    assert.equal(three.files.length, 3);
    assert.equal(three.hold, false);
  });

  it("only the last IDEA_LOOKBACK ships are compared", () => {
    const old = waves([PAINT[0]!, PAINT[1]!, PAINT[2]!]);
    const filler = waves(
      Array.from({ length: IDEA_LOOKBACK }, (_, i) => ({
        msg: `Ship landed: unrelated ship number ${i} on module${i} — \`m${i}.ts\` \`fn${i}\`. Verify: npm test — exit 0.`,
        paths: [`src/m${i}.ts`],
      })),
    );
    const note = ideaNoteFor([...old, ...filler], PAINT[3]!.msg, PAINT[3]!.paths);
    assert.equal(note.hold, false);
  });

  it("release: a different idea, a new module touched with a carrier, or a sweep across carriers", () => {
    const hold = {
      terms: ["found chew", "philosophy", "chew"],
      files: PAINT.slice(0, 4).flatMap((p) => p.paths),
      wave: 10,
      admits: 0,
    };
    assert.equal(ideaHoldReleases(hold, PAINT[4]!.msg, PAINT[4]!.paths, "control-flow"), null);
    assert.equal(
      ideaHoldReleases(
        hold,
        "Ship landed: recovery worker resumes digest after restart — `recovery.ts`. Verify: npm test.",
        ["extension/src/background/recovery.ts"],
        "control-flow",
      ),
      "different",
    );
    assert.equal(
      ideaHoldReleases(
        hold,
        "Ship landed: voice table owns the found chew caption — `voice.ts` `mealCaption`; badge imports it. Verify: npm test.",
        ["extension/src/lib/voice.ts", "extension/src/lib/badge.ts"],
        "new-module",
      ),
      "collapse",
    );
    assert.equal(
      ideaHoldReleases(
        hold,
        "Ship landed: toolbar, ticker and flask read the found chew from one caption — Verify: npm test.",
        PAINT.slice(0, 3).flatMap((p) => p.paths),
        "control-flow",
      ),
      "collapse",
    );
    assert.match(formatIdeaHoldAdmit(hold), /painted onto 4 surfaces/);
    assert.match(formatIdeaHoldAdmit(hold), /Collapse it/);
  });
});

describe("idea-surface — ledger integration", () => {
  it("the HashPet paint holds at the 4th file while the per-file streak stays at 1; a collapse releases", () => {
    withHome(() => {
      const sid = "idea-paint";
      armOpen(sid);
      const c = { edits: 0 };
      const stamp = stamper(sid, c);
      // Interleave unrelated ships so the paint is an idea, not the mantra.
      const noise = [
        "Ship landed: recovery worker resumes digest after restart — `recovery.ts` `resumeDigest`. Verify: npm test — exit 0.",
        "Ship landed: genes sculpt the body silhouette — `visual-personality.ts` `bodyFromGenes`. Verify: npm test — exit 0.",
        "Ship landed: overnight decay sets the catch-up title — `hunger-tick.ts` `catchUpTitle`. Verify: npm test — exit 0.",
      ];
      const noisePaths = [
        ["extension/src/background/recovery.ts"],
        ["extension/src/lib/visual-personality.ts"],
        ["extension/src/lib/hunger-tick.ts"],
      ];
      for (let i = 0; i < 3; i++) {
        assert.equal(stamp(noise[i]!, noisePaths[i]!).stamped, true);
        assert.equal(stamp(PAINT[i]!.msg, PAINT[i]!.paths).stamped, true, `paint ${i}`);
      }
      let s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 6);
      assert.equal(sameSurfaceHolding(s), false);
      assert.ok((s.sameSurfaceStreak ?? 0) <= 1, `per-file streak ${s.sameSurfaceStreak}`);
      assert.ok(s.waves!.slice(-1)[0]!.onBet, "the paint rides the bet exemption, as in HashPet");
      assert.equal(ideaHolding(s), false);
      assert.ok(s.ideaNote?.files.length === 3, JSON.stringify(s.ideaNote));
      assert.match(formatUlwStatus(s), /Idea surface: ".*" on 3 files — the next surface holds/);

      // 4th disjoint file: stamps (the ship happened) but arms the hold.
      const r4 = stamp(PAINT[3]!.msg, PAINT[3]!.paths);
      assert.equal(r4.stamped, true);
      s = loadUlwCycle(sid)!;
      assert.equal(ideaHolding(s), true);
      assert.equal(s.ideaHolds, 1);
      assert.ok(s.ideaHold!.files.length >= IDEA_FILE_HOLD);
      assert.match(formatUlwStatus(s), /Idea surface: hold/);
      assert.equal(s.sameSurfaceHold, false, "the per-file hold never saw it");

      // 5th surface at Stop: the once-per-run product-quality bounce goes
      // first on a game mandate; the Stop after it meets the idea hold.
      const stop = stopper(sid, c);
      const soul = stop(PAINT[4]!.msg, PAINT[4]!.paths);
      assert.equal(soul.soulDemanded, true);
      const r5 = stop(PAINT[4]!.msg, PAINT[4]!.paths);
      assert.equal(r5.block, true);
      assert.equal(r5.ideaDemanded, true, r5.reanchor);
      assert.match(r5.reanchor || "", /one idea painted onto \d+ surfaces/);
      assert.match(r5.reanchor || "", /Collapse it: one formatter/);
      s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 7, "the 5th surface did not stamp");
      assert.equal(s.ideaHold!.admits, 1);

      // LAST reflect would carry the hole.
      const holes = ledgerMustFixItems({
        waves: s.waves,
        ideaHold: s.ideaHold,
        ideaHolds: s.ideaHolds,
      });
      assert.ok(holes.some((h) => /still painted onto \d+ files/.test(h)), holes.join("\n"));

      // The collapse ship releases: a new module touched with a carrier.
      // (A game ship after wave 1 also owes a structural look at Stop.)
      notePlayLoopRan(sid);
      const r6 = stop(
        "**Wave shipped.** **Ship landed:** one voice table owns the found chew caption — `voice.ts` `mealCaption(field)`; `badge.ts` imports it. Verify: `cd extension && npm test` — exit 0.",
        ["extension/src/lib/voice.ts", "extension/src/lib/badge.ts"],
      );
      assert.equal(r6.ideaDemanded, undefined, r6.reanchor);
      s = loadUlwCycle(sid)!;
      assert.equal(ideaHolding(s), false);
      assert.equal(s.wave, 8);
      assert.equal(s.ideaWindowFrom, 7, "comparison window restarts at the collapse");
    });
  });

  it("a build-out with a home never holds, even on-bet across five files", () => {
    withHome(() => {
      const sid = "idea-home";
      armOpen(sid, "extension/src/lib/voice.ts");
      const c = { edits: 0 };
      const stamp = stamper(sid, c);
      for (const b of BUILD_OUT) {
        const r = stamp(b.msg, b.paths);
        assert.equal(r.stamped, true, b.msg);
        assert.doesNotMatch(r.admit || "", /painted onto/);
      }
      const s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 5);
      assert.equal(s.bet!.slices, 5);
      assert.equal(ideaHolding(s), false);
      assert.equal(s.ideaHolds ?? 0, 0);
    });
  });

  it("/cycle 0 clears the hold; FORGE_ULW_IDEA_HOLD=0 never arms it", () => {
    withHome(() => {
      const sid = "idea-release";
      armOpen(sid);
      const c = { edits: 0 };
      const stamp = stamper(sid, c);
      const noise = [
        ["Ship landed: recovery worker resumes digest after restart — `recovery.ts`. Verify: npm test — exit 0.", ["extension/src/background/recovery.ts"]],
        ["Ship landed: genes sculpt the body silhouette — `visual-personality.ts`. Verify: npm test — exit 0.", ["extension/src/lib/visual-personality.ts"]],
        ["Ship landed: overnight decay sets the catch-up title — `hunger-tick.ts`. Verify: npm test — exit 0.", ["extension/src/lib/hunger-tick.ts"]],
      ] as const;
      for (let i = 0; i < 3; i++) {
        stamp(noise[i]![0], [...noise[i]![1]]);
        stamp(PAINT[i]!.msg, PAINT[i]!.paths);
      }
      stamp(PAINT[3]!.msg, PAINT[3]!.paths);
      assert.equal(ideaHolding(loadUlwCycle(sid)!), true);
      scheduleCycleZeroStop(sid);
      assert.equal(ideaHolding(loadUlwCycle(sid)!), false);
    });
    withHome(() => {
      const prev = process.env.FORGE_ULW_IDEA_HOLD;
      process.env.FORGE_ULW_IDEA_HOLD = "0";
      try {
        const sid = "idea-off";
        armOpen(sid);
        const c = { edits: 0 };
        const stamp = stamper(sid, c);
        for (const p of PAINT) stamp(p.msg, p.paths);
        const s = loadUlwCycle(sid)!;
        assert.equal(s.wave, 5);
        assert.equal(ideaHolding(s), false);
        assert.equal(s.ideaHold, undefined);
      } finally {
        if (prev === undefined) delete process.env.FORGE_ULW_IDEA_HOLD;
        else process.env.FORGE_ULW_IDEA_HOLD = prev;
      }
    });
  });
});
