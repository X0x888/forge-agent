/**
 * Bet contract: open mandates owe a capability, not only hole-closes.
 * 2,407 dogfood waves stamped zero new-module ships — this is the fix.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BET_DECLINE_WINDOW,
  BET_MAX_SWAPS,
  BET_OFF_HOLD,
  BET_RUN_ADOPT_SOFT,
  BET_STUB_SLICES,
  betCapabilityClause,
  betHoleShapeReason,
  betHolding,
  betNewPathReason,
  betPathHit,
  betShipHit,
  extractBetPaths,
  formatBetReanchorLine,
  isOpenMandate,
  parseBetLine,
  resolveBetNewPaths,
  sameBetText,
} from "../src/harness/bet-contract.js";
import {
  CAPABILITY_DROUGHT_ADVISORY,
  CAPABILITY_DROUGHT_HOLD,
  armUlwCycle,
  capabilityHolding,
  evaluateUlwAtStop,
  formatUlwStatus,
  isSoftPrompt,
  loadUlwCycle,
  markUlwPlanDone,
  maybeStampUlwWave,
  sameSurfaceHolding,
  scheduleCycleZeroStop,
  setCycleFlag,
  ulwKickoffMessage,
  expandUlwMandate,
} from "../src/harness/ulw-cycle.js";
import { lastAttest } from "./helpers/ulw-arm.js";
import {
  SAME_SURFACE_HOLD,
  matchesRecentSurface,
  nextSameSurfaceStreak,
} from "../src/harness/same-surface.js";
import { isMillClassShip } from "../src/harness/work-class.js";
import {
  buildUlwJobCard,
  formatUlwJobCard,
  waveMovedJob,
} from "../src/harness/ulw-job-card.js";
import { activeMemoryRecords } from "../src/harness/decision-memory.js";
import { parseExploreMap, formatExploreMap } from "../src/session/explore-map.js";

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bet-"));
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
  fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
    recursive: true,
  });
}

const BET_TEXT =
  "one-command CSV/JSON export of the session ledger — src/export/csv.ts — first slice: `forge export --csv` writes rows; proof: node --test tests/export.test.ts";

const PLUGIN_BET =
  "a plugin runtime under src/plugins/ so a user can add a slash command without a fork — first slice: src/plugins/host.ts loads one manifest; proof: node --test tests/plugins.test.ts";

/** Reading that names the holes it will close (job moves) — no bet. */
const READING_NO_BET =
  "Reading: holes — src/auth/refresh.ts src/mcp/catalog.ts src/lsp/ensure.ts src/util/retry.ts src/tui/dock.ts src/config/model-info.ts. Verify: npm test.";

/** Same holes AND the bet the mandate owes. */
const READING_WITH_BET = `${READING_NO_BET}\nBet: ${BET_TEXT}`;

const HOLE_SHIPS: Array<{ msg: string; paths: string[] }> = [
  {
    msg: "Wave shipped: auth refresh no longer drops the token on 401. Proof: npm test.",
    paths: ["src/auth/refresh.ts"],
  },
  {
    msg: "Wave shipped: mcp catalog waits for connecting servers instead of a half list. Proof: npm test.",
    paths: ["src/mcp/catalog.ts"],
  },
  {
    msg: "Wave shipped: lsp ensure stops retrying after the third install failure. Proof: npm test.",
    paths: ["src/lsp/ensure.ts"],
  },
  {
    msg: "Wave shipped: retry honors Retry-After above the client backoff. Proof: npm test.",
    paths: ["src/util/retry.ts"],
  },
  {
    msg: "Wave shipped: bottom dock labels hosted Grok as 256k. Proof: npm test.",
    paths: ["src/tui/dock.ts"],
  },
  {
    msg: "Wave shipped: model-info inherits the last milestone window for newer ids. Proof: npm test.",
    paths: ["src/config/model-info.ts"],
  },
  {
    msg: "Wave shipped: auth refresh also rotates the OIDC nonce on 403. Proof: npm test.",
    paths: ["src/auth/refresh.ts"],
  },
  {
    msg: "Wave shipped: mcp catalog dedupes servers that answer twice. Proof: npm test.",
    paths: ["src/mcp/catalog.ts"],
  },
];

/** Shares the bet's vocabulary ("session ledger") but none of its files. */
const LEDGER_HOLE =
  "Wave shipped: session ledger no longer drops the last row on compaction. Proof: npm test.";

/** Consecutive slices on the bet's own file — same-surface flavoured on purpose. */
const CSV_SLICES = [
  "Ship landed: csv export writes the session ledger as rows. Proof: node --test tests/export.test.ts",
  "Ship landed: csv export quotes commas inside session ledger rows. Proof: node --test tests/export.test.ts",
  "Ship landed: csv export emits a header row above the session ledger rows. Proof: node --test tests/export.test.ts",
  "Ship landed: csv export streams large session ledgers row by row. Proof: node --test tests/export.test.ts",
  "Ship landed: csv export escapes embedded newlines in session ledger rows. Proof: node --test tests/export.test.ts",
];

/** One monotonic edit counter per session — the harness baselines on it. */
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

function armOpen(sid: string, reading: string, opts?: { maxWaves?: number }) {
  mkSession(sid);
  const s = armUlwCycle(sid, "improve this tool", {
    cycle: 1,
    skipCheckpoint: true,
    editCount: 0,
    ...(opts?.maxWaves != null ? { maxWaves: opts.maxWaves } : {}),
  });
  markUlwPlanDone(sid, reading);
  return s;
}

describe("bet contract — classification", () => {
  it("open mandates: soft, improve-class without a deliverable, creative asks", () => {
    assert.equal(isOpenMandate("improve the code", true), true);
    assert.equal(
      isOpenMandate(
        "Improve the UI, UX, performance, reliability of this tool comprehensively.",
        false,
      ),
      true,
    );
    assert.equal(
      isOpenMandate(
        "Improve this virtual pet app. Ensure it is interesting, attractive and addictive. Be creative.",
        false,
      ),
      true,
    );
    assert.equal(isOpenMandate("make this tool more useful", false), true);
    assert.equal(
      isOpenMandate("add a /health endpoint and make npm test pass", false),
      false,
    );
    assert.equal(isOpenMandate("", false), false);
  });

  it("open wishes are soft prompts; build orders with an object stay hard", () => {
    assert.equal(isSoftPrompt("invent something valuable here"), true);
    assert.equal(isSoftPrompt("build what's missing"), true);
    assert.equal(isSoftPrompt("create anything a power user would pay for"), true);
    assert.equal(isSoftPrompt("build a /health endpoint"), false);
    assert.equal(
      isSoftPrompt("add a /health endpoint and make npm test pass"),
      false,
    );
    // A terse build order with no path token is the user's own work order.
    const orders = [
      "build a login page with email and password",
      "make the advanced settings panel keyboard navigable",
      "build a CSV exporter for the session ledger",
      "create a dark mode toggle for the settings page",
      "create a migration for the users table",
      "design the onboarding flow",
      "handle missing config",
      "rebuild the index",
      "evolve the schema for v2",
      "extend the export to JSON",
    ];
    for (const o of orders) {
      assert.equal(isSoftPrompt(o), false, `soft: ${o}`);
      assert.equal(isOpenMandate(o, false), false, `open: ${o}`);
      const { soft, expanded } = expandUlwMandate(o);
      assert.equal(soft, false, o);
      assert.match(expanded, /^User mandate: /, o);
      assert.doesNotMatch(expanded, /### Bet \(open mandate/, o);
    }
    // Aimed at the product itself, grow/evolve are open.
    assert.equal(isOpenMandate("grow this product", false), true);
    assert.equal(isOpenMandate("reimagine the app", false), true);
  });

  it("parses Bet: lines, declines, and rejects tiny or catalog bets", () => {
    const bet = parseBetLine(READING_WITH_BET);
    assert.ok(bet && bet.kind === "bet");
    assert.match(bet.text, /CSV\/JSON export/);
    assert.ok(bet.paths.includes("src/export/csv.ts"));
    assert.ok(bet.paths.includes("tests/export.test.ts"));

    const none = parseBetLine(
      "Reading: …\nBet: none — every open hole is a first-run crash; no capability beats that today.",
    );
    assert.ok(none && none.kind === "none");
    assert.match(none.reason, /first-run crash/);

    assert.equal(parseBetLine("Bet: tiny"), null);
    assert.equal(parseBetLine("Bet: none"), null);
    assert.equal(parseBetLine("alphabet: soup for the reading"), null);
    assert.equal(
      parseBetLine("Bet: clip the remainder catalog dump lecture under /help"),
      null,
    );
  });

  it("extracts file and directory tokens", () => {
    const paths = extractBetPaths(
      "a plugin runtime under src/plugins/ with src/plugins/host.ts, proof tests/plugins.test.ts (not src/)",
    );
    assert.deepEqual(paths, [
      "src/plugins",
      "src/plugins/host.ts",
      "tests/plugins.test.ts",
    ]);
  });

  it("path hit: bet file, bet directory, sibling in the bet dir — not src/ alone", () => {
    assert.equal(betPathHit(["src/export/csv.ts"], ["src/export/csv.ts"]), true);
    assert.equal(betPathHit(["src/export/csv.ts"], ["src/export/json.ts"]), true);
    assert.equal(betPathHit(["src/export"], ["src/export/json.ts"]), true);
    assert.equal(betPathHit(["src/export/csv.ts"], ["src/tui/repl.ts"]), false);
    assert.equal(betPathHit(["src/"], ["src/anything.ts"]), false);
    assert.equal(betPathHit(["server.py"], ["server.py"]), true);
    assert.equal(betPathHit(["server.py"], ["other.py"]), false);
    // tests are not production paths — a test-only diff is not a slice.
    assert.equal(betPathHit(["src/export/csv.ts"], ["tests/export.test.ts"]), false);
  });

  it("slice test is the tree: a ship that names the bet's job on another file is not a slice", () => {
    const bet = { text: BET_TEXT, paths: ["src/export/csv.ts"] };
    // LEDGER_HOLE's closer is the bet's vocabulary; its path is src/session,
    // not the bet's src/export — the closer is not consulted at all.
    assert.equal(betShipHit(bet, ["src/session/ledger.ts"], "control-flow"), false);
    assert.equal(betShipHit(bet, ["src/export/csv.ts"], "control-flow"), true);
    assert.equal(betShipHit(bet, ["src/export/json.ts"], "new-module"), true);
    assert.equal(betShipHit(bet, ["src/export/csv.ts"], "tty"), false);
    assert.equal(betShipHit(bet, ["src/export/csv.ts"], "string-literal"), false);
    assert.equal(betShipHit(bet, [], "control-flow"), false);
    assert.equal(betShipHit(undefined, ["src/export/csv.ts"], "control-flow"), false);
  });

  it("on-bet ships are their own class: no same-surface streak, no mill schema", () => {
    const key = "control-flow:src/export/csv.ts";
    const prev = CSV_SLICES.slice(0, 2);
    const slice = nextSameSurfaceStreak(prev, CSV_SLICES[2]!, 2, {
      onBet: true,
      treeKey: key,
      prevTreeKeys: [key, key],
    });
    assert.equal(slice.same, false);
    assert.equal(slice.streak, 1);
    // Control: the same tree key off the bet is the third same-surface ship.
    const held = nextSameSurfaceStreak(prev, CSV_SLICES[2]!, 2, {
      treeKey: key,
      prevTreeKeys: [key, key],
    });
    assert.equal(held.same, true);
    assert.ok(held.streak >= SAME_SURFACE_HOLD, `streak=${held.streak}`);
    assert.equal(
      matchesRecentSurface(prev, CSV_SLICES[2]!, {
        onBet: true,
        treeKey: key,
        prevTreeKeys: [key],
      }),
      false,
    );
    assert.equal(matchesRecentSurface(prev, CSV_SLICES[2]!), true);
    const factory =
      "Last ship was the brazier. What's still hard is the hush. Far stays.";
    assert.equal(isMillClassShip(factory), true);
    assert.equal(isMillClassShip(factory, { onBet: true }), false);
  });

  it("a restated bet is the same bet", () => {
    assert.equal(sameBetText(BET_TEXT, `Bet: ${BET_TEXT}`), true);
    assert.equal(sameBetText(BET_TEXT, PLUGIN_BET), false);
  });

  it("job card prints the open bet and counts an on-bet wave as a job move", () => {
    assert.equal(
      waveMovedJob({ wave: 3, editDelta: 4, proof: true, summary: "x", onBet: true }),
      true,
    );
    const bet = {
      text: BET_TEXT,
      paths: ["src/export/csv.ts"],
      setAt: "",
      setWave: 1,
      slices: 1,
    };
    const card = buildUlwJobCard({ openMandate: true, bet, betOffStreak: 2 });
    assert.match(card.betLine || "", /Open bet:/);
    assert.match(formatUlwJobCard(card), /Open bet: .*slices 1 · 2 ship/);
    const owed = buildUlwJobCard({ openMandate: true, betRequired: true });
    assert.match(owed.betLine || "", /none on file/);
    const hard = buildUlwJobCard({ openMandate: false });
    assert.equal(hard.betLine, undefined);
    assert.match(
      formatBetReanchorLine({ openMandate: true, bet, betOffStreak: 3 }) || "",
      /3 job-moving ships since the Bet moved/,
    );
    assert.match(
      formatBetReanchorLine({ openMandate: true, betRequired: true, betOffStreak: 0 }) || "",
      /no Bet on file/,
    );
    assert.equal(
      formatBetReanchorLine({ openMandate: true, betRequired: true, betDeclined: "why" }),
      undefined,
    );
  });

  it("explore maps carry an optional bet: line", () => {
    const map = parseExploreMap(
      "pick: first-run 1–6 are not typeable\npassed_on: README\nbet: a saved-view gallery under src/views/ so a user can return to a reading\nfiles:\n  src/tui/repl.ts:345  idle digits go to the model\n",
    );
    assert.ok(map);
    assert.match(map!.bet || "", /saved-view gallery/);
    assert.match(formatExploreMap(map!), /^bet: a saved-view/m);
    const noBet = parseExploreMap("pick: a hole\nbet: none\nfiles:\n  src/a.ts:1  x\n");
    assert.equal(noBet!.bet, undefined);
  });

  it("soft expansion carries the Bet doctrine; hard mandates do not", () => {
    const soft = expandUlwMandate("improve the code");
    assert.match(soft.expanded, /### Bet \(open mandate/);
    assert.match(soft.expanded, /and one Bet:/);
    const open = expandUlwMandate("make this tool more useful");
    assert.equal(open.soft, false);
    assert.match(open.expanded, /### Bet \(open mandate/);
    const hard = expandUlwMandate("add a /health endpoint and make npm test pass");
    assert.doesNotMatch(hard.expanded, /### Bet \(open mandate/);
  });
});

describe("bet contract — harness", () => {
  it("arm: open mandate owes a bet; the kickoff and re-anchor say so; a closer Bet: is adopted and remembered", () => {
    withHome(() => {
      const sid = "bet-adopt";
      const s0 = armOpen(sid, READING_NO_BET);
      assert.equal(s0.openMandate, true);
      assert.equal(s0.betRequired, true);
      assert.match(ulwKickoffMessage(s0), /Bet gate \(open mandate\)/);
      const stop = stopper(sid, { edits: 0 });

      const r1 = stop(HOLE_SHIPS[0]!.msg, HOLE_SHIPS[0]!.paths);
      assert.equal(r1.block, true);
      assert.equal(r1.betDemanded, undefined);
      assert.equal(loadUlwCycle(sid)!.wave, 1);
      assert.match(r1.reanchor || "", /no Bet on file/);
      assert.match(formatUlwStatus(loadUlwCycle(sid)!), /Bet: none yet/);

      const r2 = stop(`${HOLE_SHIPS[1]!.msg}\nBet: ${BET_TEXT}`, HOLE_SHIPS[1]!.paths);
      assert.equal(r2.block, true);
      assert.equal(r2.betDemanded, undefined);
      const s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 2);
      assert.ok(s.bet);
      assert.match(s.bet!.text, /CSV\/JSON export/);
      assert.equal(s.betRequired, false);
      assert.match(formatUlwStatus(s), /Bet: one-command CSV\/JSON export/);
      assert.ok(
        activeMemoryRecords(sid).some((r) => /^Bet: one-command/.test(r.text)),
        "bet is remembered in decision memory",
      );
      assert.doesNotMatch(r2.reanchor || "", /no Bet on file/);
    });
  });

  it("no bet on file: six job-moving hole-closes hold unlimited ULW; writing a Bet: releases", () => {
    withHome(() => {
      const sid = "bet-owed";
      armOpen(sid, READING_NO_BET);
      const c = { edits: 0 };
      const stamp = stamper(sid, c);
      for (let i = 0; i < BET_OFF_HOLD; i++) {
        const r = stamp(HOLE_SHIPS[i]!.msg, HOLE_SHIPS[i]!.paths);
        assert.equal(r.stamped, true, HOLE_SHIPS[i]!.msg);
      }
      let s = loadUlwCycle(sid)!;
      assert.equal(s.wave, BET_OFF_HOLD);
      assert.ok(s.waves!.every((w) => w.jobMoved === true), "hole-closes on the reading's files are job moves");
      assert.equal(s.betOffStreak, BET_OFF_HOLD);
      assert.equal(s.betHold, true);
      assert.equal(betHolding(s), true);
      assert.match(formatUlwStatus(s), /Bet: none yet .*HOLD/);

      const held = stamp(HOLE_SHIPS[6]!.msg, HOLE_SHIPS[6]!.paths);
      assert.equal(held.stamped, false);
      assert.match(held.admit || "", /no Bet on file/);
      assert.equal(loadUlwCycle(sid)!.wave, BET_OFF_HOLD);

      const stop = stopper(sid, c);
      const stopHeld = stop(HOLE_SHIPS[6]!.msg, HOLE_SHIPS[6]!.paths);
      assert.equal(stopHeld.block, true);
      assert.equal(stopHeld.betDemanded, true);
      assert.match(stopHeld.reanchor || "", /no Bet on file/);

      const released = stop(`${HOLE_SHIPS[7]!.msg}\nBet: ${BET_TEXT}`, HOLE_SHIPS[7]!.paths);
      assert.equal(released.betDemanded, undefined);
      s = loadUlwCycle(sid)!;
      assert.ok(s.bet);
      assert.equal(s.betHold, false);
      assert.equal(s.betOffStreak, 1, "the hole-close that carried the bet still counts as off-bet");
      assert.equal(s.wave, BET_OFF_HOLD + 1);
    });
  });

  it("bet slices are job moves and never sibling mill; six hole-closes off the bet hold until a slice lands", () => {
    withHome(() => {
      const sid = "bet-hold";
      armOpen(sid, READING_WITH_BET);
      const stamp = stamper(sid, { edits: 0 });

      const slice = stamp(
        "Ship landed: `forge export --csv` writes the session ledger as CSV rows. Proof: node --test tests/export.test.ts",
        ["src/export/csv.ts", "tests/export.test.ts"],
      );
      assert.equal(slice.stamped, true);
      let s = loadUlwCycle(sid)!;
      assert.ok(s.bet, "bet adopted from the reading in memory");
      assert.equal(s.bet!.slices, 1);
      assert.equal(s.waves![0]!.onBet, true);
      assert.equal(s.waves![0]!.jobMoved, true);

      for (let i = 0; i < BET_OFF_HOLD; i++) {
        const r = stamp(HOLE_SHIPS[i]!.msg, HOLE_SHIPS[i]!.paths);
        assert.equal(r.stamped, true, HOLE_SHIPS[i]!.msg);
      }
      s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 1 + BET_OFF_HOLD);
      assert.equal(s.betOffStreak, BET_OFF_HOLD);
      assert.equal(s.betHold, true);
      assert.equal(betHolding(s), true);
      assert.match(formatUlwStatus(s), /Bet: .*HOLD/);

      const held = stamp(HOLE_SHIPS[6]!.msg, HOLE_SHIPS[6]!.paths);
      assert.equal(held.stamped, false);
      assert.match(held.admit || "", /job-moving ships since the open Bet/);
      assert.equal(loadUlwCycle(sid)!.wave, 1 + BET_OFF_HOLD);

      const release = stamp(
        "Ship landed: JSON export slice — `forge export --json` mirrors the CSV rows. Proof: node --test tests/export.test.ts",
        ["src/export/json.ts"],
      );
      assert.equal(release.stamped, true);
      s = loadUlwCycle(sid)!;
      assert.equal(s.betHold, false);
      assert.equal(s.betOffStreak, 0);
      assert.equal(s.bet!.slices, 2);
      assert.equal(betHolding(s), false);
    });
  });

  it("a new Bet: releases the hold at Stop; a restated one does not; after two unshipped swaps only a slice does", () => {
    withHome(() => {
      const sid = "bet-new";
      armOpen(sid, READING_WITH_BET);
      const c = { edits: 0 };
      const stamp = stamper(sid, c);
      for (let i = 0; i < BET_OFF_HOLD; i++) {
        assert.equal(stamp(HOLE_SHIPS[i]!.msg, HOLE_SHIPS[i]!.paths).stamped, true);
      }
      assert.equal(betHolding(loadUlwCycle(sid)!), true);
      const stop = stopper(sid, c);

      const restated = stop(`${HOLE_SHIPS[6]!.msg}\nBet: ${BET_TEXT}`, HOLE_SHIPS[6]!.paths);
      assert.equal(restated.betDemanded, true);

      const fresh = stop(`${HOLE_SHIPS[6]!.msg}\nBet: ${PLUGIN_BET}`, HOLE_SHIPS[6]!.paths);
      assert.equal(fresh.betDemanded, undefined);
      let s = loadUlwCycle(sid)!;
      assert.match(s.bet!.text, /plugin runtime/);
      assert.equal(s.betSwaps, 1);
      assert.equal(s.betHold, false);

      // Keep closing holes: second swap still releases, the third does not.
      // The Stop that carried the new Bet: also stamped a hole-close, so the
      // streak restarts at 1 — BET_OFF_HOLD - 1 more ships arm the hold.
      for (let k = 0; k < 2; k++) {
        assert.equal(loadUlwCycle(sid)!.betOffStreak, 1, `streak after swap ${k + 1}`);
        for (let i = 0; i < BET_OFF_HOLD - 1; i++) {
          const r = stamp(HOLE_SHIPS[i]!.msg, HOLE_SHIPS[i]!.paths);
          assert.equal(r.stamped, true, `round ${k} ship ${i}`);
        }
        s = loadUlwCycle(sid)!;
        assert.equal(betHolding(s), true, `hold after round ${k}`);
        const stop2 = stop;
        const swapText =
          k === 0
            ? "Bet: a session timeline view under src/timeline/ so a user can scrub a run — first slice: src/timeline/view.ts renders one wave; proof: node --test tests/timeline.test.ts"
            : "Bet: a shareable run report under src/report/ so a user can hand a run to a teammate — first slice: src/report/html.ts writes one page; proof: node --test tests/report.test.ts";
        const r = stop2(`${HOLE_SHIPS[7]!.msg}\n${swapText}`, HOLE_SHIPS[7]!.paths);
        s = loadUlwCycle(sid)!;
        if (k === 0) {
          assert.equal(s.betSwaps, BET_MAX_SWAPS);
          assert.equal(r.betDemanded, undefined, "second swap still releases");
          assert.equal(s.betHold, false);
        } else {
          assert.equal(s.betSwaps, BET_MAX_SWAPS + 1);
          assert.equal(r.betDemanded, true, "third swap does not release");
          assert.match(r.reanchor || "", /replaced unshipped/);
          assert.equal(betHolding(s), true);
        }
      }

      // A slice of the current bet releases.
      const r = stop(
        "Ship landed: report html writes one page for a run. Proof: node --test tests/report.test.ts",
        ["src/report/html.ts"],
      );
      assert.equal(r.betDemanded, undefined);
      s = loadUlwCycle(sid)!;
      assert.equal(s.bet!.slices, 1);
      assert.equal(s.betHold, false);
      assert.equal(s.betOffStreak, 0);
    });
  });

  it("Bet: none — <why> declines for a window of ships, then the question returns", () => {
    withHome(() => {
      const sid = "bet-none";
      armOpen(
        sid,
        `${READING_NO_BET}\nBet: none — every open hole is a first-run crash; no capability beats that today.`,
      );
      const stamp = stamper(sid, { edits: 0 });
      // Inside the window: declined, quiet, no hold.
      for (let i = 0; i < BET_DECLINE_WINDOW - 1; i++) {
        const r = stamp(HOLE_SHIPS[i]!.msg, HOLE_SHIPS[i]!.paths);
        assert.equal(r.stamped, true, HOLE_SHIPS[i]!.msg);
      }
      let s = loadUlwCycle(sid)!;
      assert.equal(s.bet, undefined);
      assert.equal(s.betRequired, false);
      assert.match(s.betDeclined || "", /first-run crash/);
      assert.equal(s.betDeclineShips, BET_DECLINE_WINDOW - 1);
      assert.equal(betHolding(s), false);
      assert.match(formatUlwStatus(s), /Bet: declined \(\d+\/\d+ ships, then asked again\)/);
      assert.ok(activeMemoryRecords(sid).some((r) => /^Bet: none — every open hole/.test(r.text)));

      // Window closes: the open mandate owes a Bet again; the spent why is kept.
      const r6 = stamp(HOLE_SHIPS[BET_DECLINE_WINDOW - 1]!.msg, HOLE_SHIPS[BET_DECLINE_WINDOW - 1]!.paths);
      assert.equal(r6.stamped, true);
      s = loadUlwCycle(sid)!;
      assert.equal(s.betDeclined, undefined);
      assert.equal(s.betRequired, true);
      assert.deepEqual(
        (s.betDeclineHistory ?? []).map((h) => /first-run crash/.test(h)),
        [true],
      );
      assert.equal(s.betOffStreak, 0);
      assert.match(formatUlwStatus(s), /Bet: none yet/);

      // The same why does not decline twice — the streak keeps counting.
      const again = stamp(
        `${HOLE_SHIPS[BET_DECLINE_WINDOW]!.msg}\nBet: none — every open hole is a first-run crash; no capability beats that today.`,
        HOLE_SHIPS[BET_DECLINE_WINDOW]!.paths,
      );
      assert.equal(again.stamped, true);
      s = loadUlwCycle(sid)!;
      assert.equal(s.betDeclined, undefined);
      assert.equal(s.betOffStreak, 1);

      // A new why declines again (a fresh window).
      const fresh = stamp(
        `${HOLE_SHIPS[BET_DECLINE_WINDOW + 1]!.msg}\nBet: none — the export surface is blocked on the auth rewrite landing first.`,
        HOLE_SHIPS[BET_DECLINE_WINDOW + 1]!.paths,
      );
      assert.equal(fresh.stamped, true);
      s = loadUlwCycle(sid)!;
      assert.match(s.betDeclined || "", /auth rewrite/);
      assert.equal(s.betRequired, false);
    });
  });

  it("every credited ship off the bet counts toward the hold, not only job-moving ones", () => {
    withHome(() => {
      const sid = "bet-any-ship";
      armOpen(sid, READING_NO_BET);
      const stamp = stamper(sid, { edits: 0 });
      // Distinct surfaces (no sibling stems, no shared tokens) that touch
      // none of the reading's files and no pick: previously jobMoved=false
      // meant they never counted; the run could grind holes forever.
      const OFF_JOB: Array<{ msg: string; paths: string[] }> = [
        { msg: "Ship landed: backoff honors Retry-After above the client curve. Proof: npm test.", paths: ["src/net/backoff.ts"] },
        { msg: "Ship landed: store index rebuilds after a torn write. Proof: npm test.", paths: ["src/store/index.ts"] },
        { msg: "Ship landed: help epilog names the sit-down keys. Proof: npm test.", paths: ["src/cli/help.ts"] },
        { msg: "Ship landed: mcp health probe times out per server. Proof: npm test.", paths: ["src/mcp/health.ts"] },
        { msg: "Ship landed: lsp pool recycles crashed servers. Proof: npm test.", paths: ["src/lsp/pool.ts"] },
        { msg: "Ship landed: oidc nonce rotates on every 403. Proof: npm test.", paths: ["src/auth/oidc.ts"] },
        { msg: "Ship landed: clock skew tolerance widened to 90s. Proof: npm test.", paths: ["src/util/clock.ts"] },
      ];
      for (let i = 0; i < BET_OFF_HOLD; i++) {
        const r = stamp(OFF_JOB[i]!.msg, OFF_JOB[i]!.paths);
        assert.equal(r.stamped, true, `${i}: ${r.admit || ""}`);
        assert.equal(loadUlwCycle(sid)!.waves!.at(-1)!.jobMoved, false, "not a job move");
      }
      const s = loadUlwCycle(sid)!;
      assert.equal(s.betOffStreak, BET_OFF_HOLD);
      assert.equal(betHolding(s), true);
      const held = stamp(OFF_JOB[BET_OFF_HOLD]!.msg, OFF_JOB[BET_OFF_HOLD]!.paths);
      assert.equal(held.stamped, false);
      assert.match(held.admit || "", /no Bet on file/);
    });
  });

  it("capped runs and hard mandates never bet-hold", () => {
    withHome(() => {
      const capped = "bet-cap";
      armOpen(capped, READING_NO_BET, { maxWaves: 20 });
      const stamp = stamper(capped, { edits: 0 });
      for (let i = 0; i <= BET_OFF_HOLD; i++) {
        const r = stamp(HOLE_SHIPS[i]!.msg, HOLE_SHIPS[i]!.paths);
        assert.equal(r.stamped, true, HOLE_SHIPS[i]!.msg);
      }
      const s = loadUlwCycle(capped)!;
      assert.equal(s.wave, BET_OFF_HOLD + 1);
      assert.ok((s.betOffStreak ?? 0) >= BET_OFF_HOLD);
      assert.equal(betHolding(s), false);
      assert.equal(s.betHold, false);

      const hard = "bet-hard";
      mkSession(hard);
      const h = armUlwCycle(hard, "add a /health endpoint and make npm test pass", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      assert.equal(h.openMandate, false);
      assert.equal(h.betRequired, false);
      assert.doesNotMatch(ulwKickoffMessage(h), /Bet gate/);
      markUlwPlanDone(hard, READING_NO_BET);
      const stampHard = stamper(hard, { edits: 0 });
      for (let i = 0; i <= BET_OFF_HOLD; i++) {
        const r = stampHard(HOLE_SHIPS[i]!.msg, HOLE_SHIPS[i]!.paths);
        assert.equal(r.stamped, true, HOLE_SHIPS[i]!.msg);
      }
      const hs = loadUlwCycle(hard)!;
      assert.equal(hs.wave, BET_OFF_HOLD + 1);
      assert.equal(hs.betOffStreak, 0);
      assert.equal(formatUlwStatus(hs).includes("Bet:"), false);
    });
  });

  it("/cycle 0 sit-down then continue clears the bet hold; the first Stop after is not re-blocked", () => {
    withHome(() => {
      const prevReflect = process.env.FORGE_ULW_LAST_REFLECT;
      process.env.FORGE_ULW_LAST_REFLECT = "0";
      try {
        const sid = "bet-sitdown";
        armOpen(sid, READING_WITH_BET);
        const c = { edits: 0 };
        const stamp = stamper(sid, c);
        for (let i = 0; i < BET_OFF_HOLD; i++) {
          assert.equal(stamp(HOLE_SHIPS[i]!.msg, HOLE_SHIPS[i]!.paths).stamped, true);
        }
        let s = loadUlwCycle(sid)!;
        assert.equal(betHolding(s), true);
        assert.equal(s.betHold, true);

        const scheduled = scheduleCycleZeroStop(sid, { editCount: c.edits })!;
        assert.equal(scheduled.betHold, false);
        assert.equal(scheduled.betOffStreak, 0);
        assert.equal(betHolding(scheduled), false);
        assert.ok(scheduled.bet, "the bet itself stays");

        const stop = stopper(sid, c);
        const wrap = stop(HOLE_SHIPS[6]!.msg, HOLE_SHIPS[6]!.paths);
        assert.equal(wrap.betDemanded, undefined, "wrap wave is not bet-blocked");
        assert.equal(loadUlwCycle(sid)!.cycle, 0);
        const done = evaluateUlwAtStop({
          sessionId: sid,
          lastAssistantMessage: lastAttest("**Cycle complete.**\n✅ npm test — 1 passed"),
          editCount: c.edits,
          openTodoCount: 0,
          stuckThreshold: 20,
          verificationPassed: true,
        });
        assert.equal(done.block, false);
        assert.equal(done.lastCycleSatDown, true);
        s = loadUlwCycle(sid)!;
        assert.equal(s.enabled, true);
        assert.equal(s.cycle, 1);
        assert.equal(s.betHold, false);
        assert.equal(s.betOffStreak, 0);
        assert.ok(s.bet);

        // The user types to continue; the first hole-close Stop must not re-block.
        const next = stop(HOLE_SHIPS[7]!.msg, HOLE_SHIPS[7]!.paths);
        assert.equal(next.block, true, "CONTINUE re-anchor");
        assert.equal(next.betDemanded, undefined);
        assert.equal(loadUlwCycle(sid)!.betOffStreak, 1);

        // Explicit /cycle 1 after a fresh hold clears it the same way.
        for (let i = 0; i < BET_OFF_HOLD; i++) {
          stamp(HOLE_SHIPS[i]!.msg, HOLE_SHIPS[i]!.paths);
        }
        assert.equal(betHolding(loadUlwCycle(sid)!), true);
        const resumed = setCycleFlag(sid, 1)!;
        assert.equal(resumed.betHold, false);
        assert.equal(betHolding(resumed), false);
        assert.ok(resumed.bet);
      } finally {
        if (prevReflect === undefined) delete process.env.FORGE_ULW_LAST_REFLECT;
        else process.env.FORGE_ULW_LAST_REFLECT = prevReflect;
      }
    });
  });

  it("numbered siblings inside the bet's directory are slices, not sibling mill", () => {
    withHome(() => {
      const sid = "bet-siblings";
      armOpen(sid, `Reading: src/auth/refresh.ts drops tokens. Verify: npm test.\nBet: ${PLUGIN_BET}`);
      const ships = [
        ["Ship landed: plugin host loads one manifest (src/plugins/host-1.ts). Proof: node --test tests/plugins.test.ts", "src/plugins/host-1.ts"],
        ["Ship landed: plugin host resolves a second manifest layer (src/plugins/host-2.ts). Proof: node --test tests/plugins.test.ts", "src/plugins/host-2.ts"],
        ["Ship landed: plugin host isolates a third loader (src/plugins/host-3.ts). Proof: node --test tests/plugins.test.ts", "src/plugins/host-3.ts"],
      ] as const;
      const stamp = stamper(sid, { edits: 0 });
      for (const [msg, p] of ships) {
        const r = stamp(msg, [p]);
        assert.equal(r.stamped, true, msg);
        assert.doesNotMatch(r.admit || "", /sibling new-modules/);
      }
      const s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 3);
      assert.equal(s.siblingMillHold, false);
      assert.equal(s.bet!.slices, 3);
      assert.ok(s.waves!.every((w) => w.onBet === true && !w.siblingMill));

      // Control: the same numbered siblings on a hard mandate still hold.
      const ctl = "bet-siblings-control";
      mkSession(ctl);
      armUlwCycle(ctl, "add a /health endpoint and make npm test pass", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      markUlwPlanDone(ctl);
      const stampCtl = stamper(ctl, { edits: 0 });
      let heldAdmit = "";
      for (const [msg, p] of ships) {
        const r = stampCtl(msg, [p]);
        if (!r.stamped) heldAdmit = r.admit || "";
      }
      assert.match(heldAdmit, /sibling new-modules/);
    });
  });

  it("a hole-close that names the bet's job on another file is not a slice: the hold stays", () => {
    withHome(() => {
      const sid = "bet-terms";
      armOpen(sid, READING_WITH_BET);
      const stamp = stamper(sid, { edits: 0 });
      for (let i = 0; i < BET_OFF_HOLD; i++) {
        assert.equal(stamp(HOLE_SHIPS[i]!.msg, HOLE_SHIPS[i]!.paths).stamped, true);
      }
      let s = loadUlwCycle(sid)!;
      assert.ok(s.bet, "bet adopted from the reading in memory");
      assert.equal(s.betHold, true);
      assert.equal(betHolding(s), true);

      // "session ledger" is the bet's own wording — the tree says src/session.
      const held = stamp(LEDGER_HOLE, ["src/session/ledger.ts"]);
      assert.equal(held.stamped, false);
      assert.match(held.admit || "", /job-moving ships since the open Bet/);
      s = loadUlwCycle(sid)!;
      assert.equal(s.betHold, true);
      assert.equal(betHolding(s), true);
      assert.equal(s.bet!.slices, 0);
      assert.equal(s.wave, BET_OFF_HOLD);
      assert.ok(
        s.waves!.every((w) => !w.onBet),
        "no wave record was credited to the bet",
      );

      // The same words on the bet's file are the slice.
      const slice = stamp(
        "Ship landed: session ledger rows now reach `forge export --csv`. Proof: node --test tests/export.test.ts",
        ["src/export/csv.ts"],
      );
      assert.equal(slice.stamped, true);
      s = loadUlwCycle(sid)!;
      assert.equal(s.betHold, false);
      assert.equal(s.bet!.slices, 1);
      assert.equal(s.waves![s.waves!.length - 1]!.onBet, true);
    });
  });

  it("four consecutive slices on the bet's file never arm the same-surface hold", () => {
    withHome(() => {
      const sid = "bet-slices";
      armOpen(sid, READING_WITH_BET);
      const c = { edits: 0 };
      const stamp = stamper(sid, c);
      for (const msg of CSV_SLICES.slice(0, 4)) {
        const r = stamp(msg, ["src/export/csv.ts"]);
        assert.equal(r.stamped, true, msg);
        assert.doesNotMatch(r.admit || "", /same surface/i, msg);
        assert.equal(sameSurfaceHolding(loadUlwCycle(sid)!), false, msg);
      }
      let s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 4);
      assert.equal(s.bet!.slices, 4);
      assert.equal(s.sameSurfaceHold, false);
      assert.ok((s.sameSurfaceStreak ?? 0) < SAME_SURFACE_HOLD, `streak=${s.sameSurfaceStreak}`);
      assert.ok(s.waves!.every((w) => w.onBet === true && !w.millClass && !w.siblingMill));
      assert.equal(s.exploreRequired ?? false, false);

      // A fifth slice at Stop is not held for a different surface either.
      const stop = stopper(sid, c);
      const r = stop(CSV_SLICES[4]!, ["src/export/csv.ts"]);
      assert.equal(r.sameSurfaceDemanded, undefined);
      assert.equal(r.betDemanded, undefined);
      s = loadUlwCycle(sid)!;
      assert.equal(s.wave, 5);
      assert.equal(s.bet!.slices, 5);
      assert.equal(sameSurfaceHolding(s), false);
    });
  });
});

/**
 * HashPet dogfood (session 23b2c2a5, 791 waves): 234 `Bet:` lines were
 * adopted, 96 shaped like holes, none naming a file that did not exist.
 * Every one was a slice, a job move, and an exemption from the same-surface
 * hold. These are the lines that got through.
 */
const HASHPET_HOLE_BETS = [
  "Bet: MOOD still hunts while STATUS says ATE — `extension/src/lib/pet-face.ts` `digitalMoodLine` — first slice: `ATE` on chew.",
  "Bet: Empty fridge after bless still Tap a star instead of planting tomorrow. — `extension/src/lib/first-hour.ts` — first slice: `Tomorrow wants Arts.` Verify: `cd extension && npm test -- src/__tests__/first-hour.test.ts`.",
  "Bet: The ate-Philosophy line never preempts hour-hold — `extension/src/lib/insight-generator.ts` — first slice: `huntAteInsightDue` after a found chew.",
  "Bet: Last digest never stamps the found field — `extension/src/lib/digest-loot.ts` — first slice: loot.knowledge is the meal's field, never a hostname.",
  "Bet: PoW wait copy still says Nexus is chewing. while the kicker is Chewing Philosophy. — `extension/src/lib/home-intent.ts` `pokeHashingLine` — first slice: `Nexus is chewing Philosophy.`",
  "Bet: sit-days badge ignores the leftover meal — `extension/src/lib/badge.ts` — first slice: leftover wins the title.",
  "Bet: the toolbar title is wrong after a recast — `extension/src/lib/badge.ts` — first slice: recast title.",
];

/** Capability clauses from the same run — early bets, when the product score was climbing. */
const HASHPET_CAPABILITY_BETS = [
  "Bet: A blessed meal is felt — `extension/src/lib/daily-appetite.ts` — first slice: `applyBlessedMeal` on `maybeCompleteAppetite` before the digest commit.",
  "Bet: Answer an insight by tapping the body — `extension/src/popup/PopupApp.tsx` — first slice: live `currentInsight` + poke calls `replyInsight('heard')`.",
  "Bet: The companion body cannot gaze or speak today's field as a Digest/Clean tap verb — `extension/src/lib/pet-face.ts` — first slice: crave look when `appetiteMatch`. Never a hostname.",
  "Bet: one voice table for every meal caption — `extension/src/lib/voice.ts` — first slice: `mealCaption(field)` used by toolbar and ticker; verify: `cd extension && npm test`.",
];

describe("bet contract — a bet is a capability with a new path", () => {
  it("hole-shaped capability clauses are refused as bets (HashPet lines)", () => {
    for (const line of HASHPET_HOLE_BETS) {
      const p = parseBetLine(line);
      assert.ok(p && p.kind === "hole", `should be a hole: ${line}`);
      assert.match(p.why, /pick \(a hole\)/);
    }
    for (const line of HASHPET_CAPABILITY_BETS) {
      const p = parseBetLine(line);
      assert.ok(p && p.kind === "bet", `should be a bet: ${line}`);
    }
    // Only the capability clause is judged — a slice or verify that says
    // "never a hostname" is a constraint, not a hole.
    assert.equal(
      betHoleShapeReason(
        "a privacy ledger of hashed visits — src/privacy/ledger.ts — first slice: rows never carry a hostname",
      ),
      undefined,
    );
    assert.equal(betCapabilityClause("x still y — src/a.ts — first slice: z"), "x still y");
    // "cannot" is the grammar of a capability gap.
    assert.equal(
      betHoleShapeReason("this tool cannot export a run today — src/export/csv.ts"),
      undefined,
    );
    // The existing corpus bets still parse.
    assert.ok(parseBetLine(`Bet: ${BET_TEXT}`)?.kind === "bet");
    assert.ok(parseBetLine(`Bet: ${PLUGIN_BET}`)?.kind === "bet");
  });

  it("new paths are the ones absent from the tree; no cwd skips the test", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bet-tree-"));
    try {
      fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "lib", "badge.ts"), "export const a = 1;\n");
      assert.deepEqual(
        resolveBetNewPaths(["src/lib/badge.ts", "src/lib/voice.ts", "src/voice/"], dir),
        ["src/lib/voice.ts", "src/voice"],
      );
      assert.deepEqual(resolveBetNewPaths(["src/lib/badge.ts"], dir), []);
      assert.equal(resolveBetNewPaths(["src/lib/badge.ts"], undefined), undefined);
      // Resolved from a nested cwd up to the git root too.
      fs.mkdirSync(path.join(dir, ".git"));
      fs.mkdirSync(path.join(dir, "extension"));
      assert.deepEqual(
        resolveBetNewPaths(["src/lib/badge.ts", "src/lib/voice.ts"], path.join(dir, "extension")),
        ["src/lib/voice.ts"],
      );
      assert.match(
        betNewPathReason(["src/lib/badge.ts"], []) || "",
        /already exists .*src\/lib\/badge\.ts.*names the file the capability creates/,
      );
      assert.equal(betNewPathReason(["src/lib/badge.ts"], undefined), undefined);
      assert.equal(betNewPathReason(["src/lib/voice.ts"], ["src/lib/voice.ts"]), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with newPaths the slice test is the created path, not the whole directory", () => {
    const bet = {
      text: "voice table",
      paths: ["extension/src/lib/voice.ts"],
      newPaths: ["extension/src/lib/voice.ts"],
    };
    // Editing a sibling in extension/src/lib/ is a hole-close, not a slice.
    assert.equal(betShipHit(bet, ["extension/src/lib/badge.ts"], "control-flow"), false);
    assert.equal(betShipHit(bet, ["extension/src/lib/voice.ts"], "control-flow"), true);
    assert.equal(betShipHit(bet, ["extension/src/lib/voice.ts"], "tty"), false);
    // A new directory credits everything inside it.
    const dirBet = { text: "plugins", paths: ["src/plugins"], newPaths: ["src/plugins"] };
    assert.equal(betShipHit(dirBet, ["src/plugins/host.ts"], "new-module"), true);
    assert.equal(betShipHit(dirBet, ["src/tui/repl.ts"], "control-flow"), false);
    // Legacy sidecar (no newPaths): the old file-or-directory rule.
    const legacy = { text: "csv", paths: ["src/export/csv.ts"] };
    assert.equal(betShipHit(legacy, ["src/export/json.ts"], "control-flow"), true);
  });

  it("a hole-shaped Bet: is refused at adoption and the re-anchor says why; a real one clears it", () => {
    withHome(() => {
      const sid = "bet-refuse";
      armOpen(sid, READING_NO_BET);
      const c = { edits: 0 };
      const stamp = stamper(sid, c);
      const r = stamp(`${HOLE_SHIPS[0]!.msg}\n${HASHPET_HOLE_BETS[0]}`, HOLE_SHIPS[0]!.paths);
      assert.equal(r.stamped, true);
      let s = loadUlwCycle(sid)!;
      assert.equal(s.bet, undefined, "hole was not adopted as a bet");
      assert.match(s.betRefused || "", /"still".*pick \(a hole\)/);
      assert.equal(s.betRequired, true, "the mandate still owes a bet");
      assert.match(formatBetReanchorLine(s) || "", /Bet refused — "still"/);
      assert.match(formatBetReanchorLine(s) || "", /new file it creates/);
      // The wave itself was a hole-close, not a slice.
      assert.equal(s.waves![s.waves!.length - 1]!.onBet, undefined);

      const ok = stamp(`${HOLE_SHIPS[1]!.msg}\nBet: ${PLUGIN_BET}`, HOLE_SHIPS[1]!.paths);
      assert.equal(ok.stamped, true);
      s = loadUlwCycle(sid)!;
      assert.match(s.bet!.text, /plugin runtime/);
      assert.equal(s.betRefused, undefined);
      assert.equal(s.betsAdopted, 1);
      assert.doesNotMatch(formatBetReanchorLine(s) || "", /refused/);
    });
  });

  it("with a cwd, a Bet: whose every path exists is refused; one that creates a file is adopted with newPaths", () => {
    withHome(() => {
      const sid = "bet-tree";
      const tree = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bet-cwd-"));
      try {
        fs.mkdirSync(path.join(tree, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(tree, "src", "auth", "refresh.ts"), "export const x = 1;\n");
        armOpen(sid, READING_NO_BET);
        const c = { edits: 0 };
        const stampAt = (msg: string, paths: string[]) => {
          c.edits += 6;
          return maybeStampUlwWave({
            sessionId: sid,
            editCount: c.edits,
            openTodoCount: 0,
            stepsSinceStamp: 1,
            lastAssistantMessage: msg,
            verificationPassed: true,
            changedPaths: paths,
            cwd: tree,
          });
        };
        // Capability grammar, but the only path is a file that already exists.
        stampAt(
          `${HOLE_SHIPS[0]!.msg}\nBet: a refresh that survives a rotated OIDC key — src/auth/refresh.ts — first slice: rotate on 403`,
          HOLE_SHIPS[0]!.paths,
        );
        let s = loadUlwCycle(sid)!;
        assert.equal(s.bet, undefined);
        assert.match(s.betRefused || "", /already exists \(src\/auth\/refresh\.ts\)/);

        stampAt(
          `${HOLE_SHIPS[1]!.msg}\nBet: a session timeline a user can scrub — src/timeline/view.ts — first slice: render one wave; verify: npm test`,
          HOLE_SHIPS[1]!.paths,
        );
        s = loadUlwCycle(sid)!;
        assert.match(s.bet!.text, /timeline/);
        assert.deepEqual(s.bet!.newPaths, ["src/timeline/view.ts"]);
        assert.equal(s.betRefused, undefined);

        // A ship on the existing sibling is not a slice; the new file is.
        stampAt("Wave shipped: refresh also handles 403. Proof: npm test.", ["src/auth/refresh.ts"]);
        s = loadUlwCycle(sid)!;
        assert.equal(s.bet!.slices, 0);
        assert.equal(s.betOffStreak, 2);
        stampAt("Ship landed: timeline view renders one wave. Proof: npm test.", ["src/timeline/view.ts"]);
        s = loadUlwCycle(sid)!;
        assert.equal(s.bet!.slices, 1);
        assert.equal(s.betOffStreak, 0);
        assert.match(formatUlwStatus(s), /creates src\/timeline\/view\.ts/);
      } finally {
        fs.rmSync(tree, { recursive: true, force: true });
      }
    });
  });

  it("past BET_RUN_ADOPT_SOFT bets, replacing a one-slice bet is a swap and the re-anchor says so", () => {
    withHome(() => {
      const sid = "bet-adopt-soft";
      armOpen(sid, READING_NO_BET);
      const c = { edits: 0 };
      const stamp = stamper(sid, c);
      const CAPS = [
        "a session timeline a user can scrub",
        "one-command CSV export of the ledger",
        "a plugin runtime loading slash manifests",
        "shareable HTML run reports for teammates",
        "keyboard-navigable settings panel",
        "offline replay of a recorded conversation",
        "voice table for every meal caption",
        "spend forecast before a wave starts",
      ];
      const betAt = (i: number) =>
        `Bet: ${CAPS[i - 1]} — src/cap${i}/index.ts — first slice: src/cap${i}/index.ts does one thing; proof: node --test tests/cap${i}.test.ts`;
      // Six bets, each shipped one slice, then replaced — free so far.
      for (let i = 1; i <= BET_RUN_ADOPT_SOFT; i++) {
        stamp(`Ship landed: cap ${i} does one thing. Proof: npm test.\n${betAt(i)}`, [
          `src/cap${i}/index.ts`,
        ]);
      }
      let s = loadUlwCycle(sid)!;
      assert.equal(s.betsAdopted, BET_RUN_ADOPT_SOFT);
      assert.equal(s.betSwaps, 0, "one-slice replacements were free below the soft cap");
      assert.equal(s.bet!.slices, 1);
      assert.match(formatBetReanchorLine(s) || "", /bets adopted this run/);
      assert.match(formatBetReanchorLine(s) || "", new RegExp(`${BET_STUB_SLICES}\\+ slices`));
      // The seventh replaces a one-slice bet: now a swap.
      stamp(`Ship landed: cap 7 does one thing. Proof: npm test.\n${betAt(7)}`, ["src/cap7/index.ts"]);
      s = loadUlwCycle(sid)!;
      assert.equal(s.betsAdopted, BET_RUN_ADOPT_SOFT + 1);
      assert.equal(s.betSwaps, 1);
      assert.match(formatUlwStatus(s), /7 bets this run \(1 swapped unshipped\)/);
      // Shipping it to two slices makes the next replacement honest again.
      stamp("Ship landed: cap 7 does a second thing. Proof: npm test.", ["src/cap7/index.ts"]);
      s = loadUlwCycle(sid)!;
      assert.equal(s.bet!.slices, 2);
      assert.equal(formatBetReanchorLine(s), undefined);
      stamp(`Ship landed: cap 8 does one thing. Proof: npm test.\n${betAt(8)}`, ["src/cap8/index.ts"]);
      s = loadUlwCycle(sid)!;
      assert.equal(s.betSwaps, 1, "a two-slice bet is shipped, not swapped");
    });
  });
});

describe("capability drought — a run that only repairs", () => {
  /**
   * Repairs on files the ledger already knows: rotate through six existing
   * files with a distinct sentence each time (a shared suffix would be one
   * idea painted onto six files — the idea hold would rightly fire).
   */
  const REPAIR_VERBS = [
    "tolerates a slow DNS answer",
    "survives a half-written cache file",
    "recovers from an interrupted download",
    "rejects a malformed manifest early",
    "keeps its width under a narrow terminal",
    "prefers the newest milestone window",
    "honours the retry budget under load",
    "logs the failing host once",
    "closes the socket on abort",
    "drops the stale lock on restart",
    "warms the index before the first query",
    "caps the backoff at a minute",
    "reads the proxy from the environment",
    "ignores a trailing slash in the base",
    "escapes the shell path on Windows",
    "reuses one keep-alive agent",
    "trims the banner to the row",
    "sorts the milestones numerically",
  ];
  /** Distinct decline reasons — the same why never declines twice. */
  const DECLINES = [
    "every open hole is a first-run crash and no capability beats that today",
    "the retry path still loses data under load and that outranks any new surface",
    "the catalog race corrupts sessions and must close before anything is invented",
    "the dock misreports context and a wrong number is worse than a missing feature",
    "the milestone table drifts and every user hits it before any new command would",
  ];
  const repairs = (n: number, from = 0) =>
    Array.from({ length: n }, (_, k) => {
      const i = from + k;
      const h = HOLE_SHIPS[i % 6]!;
      const noun = h.paths[0]!.split("/").pop()!.replace(/\.ts$/, "");
      // Re-decline the bet question as each 6-ship window lapses, so the
      // bet-owed hold stays out of a test about the drought counter.
      const decline =
        i > 0 && i % BET_DECLINE_WINDOW === 0
          ? `\nBet: none — ${DECLINES[(i / BET_DECLINE_WINDOW) % DECLINES.length]}`
          : "";
      return {
        msg: `Wave shipped: ${noun} ${REPAIR_VERBS[i % REPAIR_VERBS.length]}. Proof: npm test.${decline}`,
        paths: h.paths,
      };
    });

  it("counts credited ships since the last new module; a new path resets it", () => {
    withHome(() => {
      const sid = "drought-count";
      // Decline the bet question so only the drought is under test.
      armOpen(sid, `${READING_NO_BET}\nBet: none — every hole here is a first-run crash and no capability beats that today.`);
      const c = { edits: 0 };
      const stamp = stamper(sid, c);
      // First ship on an unknown file is a capability ship (no diff → ledger-new path).
      const first = stamp("Ship landed: auth refresh rotates the token. Proof: npm test.", ["src/auth/refresh.ts"]);
      let s = loadUlwCycle(sid)!;
      assert.equal(first.stamped, true);
      assert.equal(s.capabilityShips, 1);
      assert.equal(s.capabilityDrought, 0);
      // First touches of the other five files are capability ships too
      // (ledger-new paths); the drought resets on each, so it ends at 0.
      for (const r of repairs(6)) stamp(r.msg, r.paths);
      s = loadUlwCycle(sid)!;
      assert.equal(s.capabilityShips, 6);
      assert.equal(s.capabilityDrought, 0);
      // From here every path is known: repairs only (indices continue so the
      // re-decline cadence lines up with the bet window).
      const notStamped: string[] = [];
      for (const r of repairs(12, 6)) {
        const res = stamp(r.msg, r.paths);
        if (!res.stamped) notStamped.push(res.admit || "(no admit)");
      }
      s = loadUlwCycle(sid)!;
      assert.deepEqual(notStamped, [], notStamped.join("\n---\n"));
      assert.equal(s.capabilityDrought, 12);
      assert.equal(s.creditedShips, 19);
      assert.match(formatUlwStatus(s), /Capability: 12 ship\(s\) since the last new module \(6 this run\)/);
      // A new module resets.
      stamp("Ship landed: a CSV exporter for the ledger. Proof: npm test.", ["src/export/csv.ts"]);
      s = loadUlwCycle(sid)!;
      assert.equal(s.capabilityDrought, 0);
      assert.equal(s.capabilityShips, 7);
    });
  });

  it("an open unlimited mandate holds at CAPABILITY_DROUGHT_HOLD; a new module releases; /cycle 0 clears", () => {
    withHome(() => {
      const sid = "drought-hold";
      // Decline the bet question so the bet-owed hold does not fire first;
      // the drought hold is armable once the decline window lapses.
      armOpen(sid, `${READING_NO_BET}\nBet: none — every hole here is a first-run crash and no capability beats that today.`);
      const c = { edits: 0 };
      const stamp = stamper(sid, c);
      const stop = stopper(sid, c);
      // Six first touches (ledger-new paths = capability ships), then repairs.
      for (const r of repairs(6)) stamp(r.msg, r.paths);
      for (const r of repairs(6 + CAPABILITY_DROUGHT_ADVISORY).slice(6)) stamp(r.msg, r.paths);
      let s = loadUlwCycle(sid)!;
      assert.equal(s.capabilityDrought, CAPABILITY_DROUGHT_ADVISORY);
      assert.equal(capabilityHolding(s), false);
      assert.match(formatUlwStatus(s), /Capability: 12 ship\(s\) since the last new module/);
      // Take the sidecar to one below the bar with a real bet on file (an
      // empty bet slot would re-seed the last decline from memory) and the
      // bet question quiet.
      s.capabilityDrought = CAPABILITY_DROUGHT_HOLD - 1;
      s.bet = {
        text: "a session timeline a user can scrub — src/timeline/view.ts — first slice: render one wave",
        paths: ["src/timeline/view.ts"],
        newPaths: ["src/timeline/view.ts"],
        setAt: new Date().toISOString(),
        setWave: s.wave,
        slices: 0,
      };
      s.betDeclined = undefined;
      s.betRequired = false;
      s.betOffStreak = 0;
      fs.writeFileSync(
        path.join(process.env.FORGE_HOME!, "sessions", sid, "ulw.json"),
        JSON.stringify(s),
      );
      const r = repairs(1)[0]!;
      const tick = stamp(`${r.msg} #bar`, r.paths);
      assert.equal(tick.stamped, true, "the ship that reaches the bar still stamps");
      s = loadUlwCycle(sid)!;
      assert.equal(s.capabilityDrought, CAPABILITY_DROUGHT_HOLD);
      assert.equal(capabilityHolding(s), true);
      assert.match(formatUlwStatus(s), /Capability: HOLD/);
      // The next repair is blocked at Stop with the drought admit.
      const blocked = stop(`${HOLE_SHIPS[1]!.msg} #after-bar`, HOLE_SHIPS[1]!.paths);
      assert.equal(blocked.block, true);
      assert.equal(blocked.capabilityDemanded, true, blocked.reanchor);
      assert.match(blocked.reanchor || "", /credited ships since the last new module/);
      assert.match(blocked.reanchor || "", /bug tracker, not a product/);
      s = loadUlwCycle(sid)!;
      assert.equal(s.capabilityDrought, CAPABILITY_DROUGHT_HOLD, "the blocked repair did not stamp");
      // A new module releases and resets.
      const released = stop(
        "Ship landed: a session timeline view renders one wave — src/timeline/view.ts. Proof: node --test tests/timeline.test.ts",
        ["src/timeline/view.ts"],
      );
      assert.equal(released.capabilityDemanded, undefined, released.reanchor);
      s = loadUlwCycle(sid)!;
      assert.equal(capabilityHolding(s), false);
      assert.equal(s.capabilityDrought, 0);
      assert.equal(s.capabilityShips, 7);
    });
    withHome(() => {
      const sid = "drought-cycle0";
      armOpen(sid, READING_NO_BET);
      const s = loadUlwCycle(sid)!;
      s.capabilityDrought = CAPABILITY_DROUGHT_HOLD;
      s.capabilityHold = true;
      fs.writeFileSync(
        path.join(process.env.FORGE_HOME!, "sessions", sid, "ulw.json"),
        JSON.stringify(s),
      );
      assert.equal(capabilityHolding(loadUlwCycle(sid)!), true);
      scheduleCycleZeroStop(sid);
      const after = loadUlwCycle(sid)!;
      assert.equal(capabilityHolding(after), false);
      assert.equal(after.capabilityDrought, CAPABILITY_DROUGHT_HOLD, "the count is a run fact and stays");
    });
  });

  it("hard mandates and capped runs never hold, only advise; the kill-switch disables the hold", () => {
    withHome(() => {
      const sid = "drought-hard";
      mkSession(sid);
      armUlwCycle(sid, "add a /health endpoint and make npm test pass", {
        cycle: 1,
        skipCheckpoint: true,
        editCount: 0,
      });
      markUlwPlanDone(sid, READING_NO_BET);
      const s = loadUlwCycle(sid)!;
      assert.equal(s.openMandate, false);
      s.capabilityDrought = CAPABILITY_DROUGHT_HOLD + 5;
      s.capabilityHold = true;
      fs.writeFileSync(
        path.join(process.env.FORGE_HOME!, "sessions", sid, "ulw.json"),
        JSON.stringify(s),
      );
      const loaded = loadUlwCycle(sid)!;
      assert.equal(capabilityHolding(loaded), false, "hard mandate: no hold");
      assert.match(formatUlwStatus(loaded), /Capability: \d+ ship\(s\) since the last new module/);
      assert.doesNotMatch(formatUlwStatus(loaded), /Capability: HOLD/);
    });
    withHome(() => {
      const sid = "drought-capped";
      armOpen(sid, READING_NO_BET, { maxWaves: 40 });
      const s = loadUlwCycle(sid)!;
      s.capabilityDrought = CAPABILITY_DROUGHT_HOLD;
      s.capabilityHold = true;
      fs.writeFileSync(
        path.join(process.env.FORGE_HOME!, "sessions", sid, "ulw.json"),
        JSON.stringify(s),
      );
      assert.equal(capabilityHolding(loadUlwCycle(sid)!), false, "a cap is a budget");
    });
    withHome(() => {
      const prev = process.env.FORGE_ULW_CAPABILITY_HOLD;
      process.env.FORGE_ULW_CAPABILITY_HOLD = "0";
      try {
        const sid = "drought-off";
        armOpen(sid, READING_NO_BET);
        const s = loadUlwCycle(sid)!;
        s.capabilityDrought = CAPABILITY_DROUGHT_HOLD;
        s.capabilityHold = true;
        fs.writeFileSync(
          path.join(process.env.FORGE_HOME!, "sessions", sid, "ulw.json"),
          JSON.stringify(s),
        );
        assert.equal(capabilityHolding(loadUlwCycle(sid)!), false);
      } finally {
        if (prev === undefined) delete process.env.FORGE_ULW_CAPABILITY_HOLD;
        else process.env.FORGE_ULW_CAPABILITY_HOLD = prev;
      }
    });
  });
});
