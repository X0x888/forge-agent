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
  betHolding,
  betPathHit,
  betShipHit,
  extractBetPaths,
  formatBetReanchorLine,
  isOpenMandate,
  parseBetLine,
  sameBetText,
} from "../src/harness/bet-contract.js";
import {
  armUlwCycle,
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
