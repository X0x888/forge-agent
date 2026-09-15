import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPlannerBrief,
  buildPlannerPlanBrief,
  buildPlannerScoutBrief,
  buildReviewerBrief,
  buildReviewerLookBrief,
  buildReviewerReviewBrief,
  formatPlanAdmission,
  LOOK_PATH_DOWN_LINE,
  MANDATE_QUALITY_BAR,
  RECORD_CYCLE_LINES_FULL,
  runSpend,
} from "../src/harness/cycle/briefs.js";
import { newCycleState, type CycleRecord, type CycleState } from "../src/harness/cycle/state.js";
import { ulwKickoffMessage } from "../src/harness/cycle/index.js";
import { renderHarnessAdmission } from "../src/harness/context-admit.js";
import { McpManager, setActiveMcpManager } from "../src/mcp/manager.js";

/** A run two cycles in: one committed, one blocked, with everything the briefs can carry. */
function runState(): CycleState {
  const s = newCycleState({ sessionId: "brief-test", mandate: null });
  s.cycle = 2;
  s.identity = "A toolbar pet for people who want a Tamagotchi in the browser.";
  s.direction = "the hour-one verb";
  s.promises = [
    { text: "browsing feeds the pet", state: "kept", seen: "hunger rose on a tab visit" },
    { text: "tap a star to hunt", state: "broken", seen: "star under the overlay" },
  ];
  s.items = [{ id: "i1", title: "stars tappable under the lesson", files: ["a.ts"], status: "open" }];
  s.cycles = [
    {
      n: 1,
      title: "Toolbar face",
      direction: "a living face on chrome.action",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T01:00:00Z",
      itemsTotal: 2,
      itemsDone: 2,
      waves: 1,
      reviewVerdict: "ship-with-revisions",
      worthClaim: "the icon is what a toolbar-pet user watches all day",
      worth: "yes — the badge moves when the pet eats",
      mustFix: ["resolveBadge takes ten positional args"],
      architecture: ["badge and icon duplicate one priority tree"],
      serendipity: ["the popup CSS loads twice"],
      disputes: ["the Reviewer called `catchAt` dead; scripts/seed.mjs reads it (run log attached)"],
      commitSha: "abc1234",
      commitFiles: ["extension/src/face.ts", "extension/src/badge.ts"],
      plannerTokens: 12_000,
      reviewerTokens: 30_000,
    },
    {
      n: 2,
      title: "Stars stay tappable",
      startedAt: "2026-01-01T02:00:00Z",
      itemsTotal: 1,
      itemsDone: 0,
      waves: 0,
      mustFix: [],
      plannerTokens: 8_000,
    },
  ];
  return s;
}

function twelveCycleState(): CycleState {
  const s = runState();
  s.cycle = 12;
  s.cycles = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return {
      n,
      title: `title-${n}`,
      direction: `DIR-ESSAY-${String(n).padStart(2, "0")} unique direction for cycle ${n}`,
      startedAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`,
      endedAt: `2026-01-${String(n).padStart(2, "0")}T01:00:00Z`,
      itemsTotal: 1,
      itemsDone: 1,
      waves: 1,
      reviewVerdict: "ship" as const,
      worthClaim: `worth-claim-${String(n).padStart(2, "0")}`,
      worth: n === 12 ? "no — last cycle was not worth it" : `yes — cycle ${n} landed`,
      mustFix: n === 1 ? ["must-fix-from-collapsed-cycle"] : n === 12 ? ["must-fix-from-last-review"] : [],
      architecture: n === 12 ? ["shape-note-from-last"] : [],
      commitSha: n % 2 === 0 ? `sha${n}` : undefined,
      plannerTokens: 1_000,
      reviewerTokens: 1_000,
    } satisfies CycleRecord;
  });
  return s;
}

function assertShippedCollapse(shipped: string, total: number) {
  assert.ok(total > RECORD_CYCLE_LINES_FULL, "fixture must exceed the keep-count");
  const collapsed = total - RECORD_CYCLE_LINES_FULL;
  for (let n = 1; n <= collapsed; n++) {
    const pad = String(n).padStart(2, "0");
    assert.equal(shipped.includes(`DIR-ESSAY-${pad}`), false, `cycle ${n} direction collapsed`);
    assert.equal(shipped.includes(`worth-claim-${pad}`), false, `cycle ${n} worth claim collapsed`);
    assert.match(
      shipped,
      new RegExp(`cycle ${n} — title-${n} · ship · ${n % 2 === 0 ? "commit" : "no-commit"}`),
    );
  }
  for (let n = collapsed + 1; n <= total; n++) {
    const pad = String(n).padStart(2, "0");
    assert.ok(shipped.includes(`DIR-ESSAY-${pad}`), `cycle ${n} keeps direction`);
    assert.ok(shipped.includes(`worth-claim-${pad}`), `cycle ${n} keeps worth claim`);
  }
}

const HISTORY_TITLES = [
  "## What this run has shipped",
  "## Must-fix left by the last review",
  "## The last Reviewer's shape notes",
  "## What the executor noticed and left alone",
  "## What the executor disputed in the last review",
  "## What the user said since the last plan",
  "## Commits this run",
  "## Spend so far",
];

describe("Planner scout brief (turn 1)", () => {
  it("carries the product and the procedure, and none of the record", () => {
    const b = buildPlannerScoutBrief({
      state: runState(),
      workspace: "/w",
      gitStatus: "M a.ts",
      projectChecks: ["npm test"],
    });
    assert.match(b, /^\[Forge cycle planner — cycle 3, turn 1 of 2/);
    assert.ok(b.includes("## Mandate"));
    assert.ok(b.includes("## Identity (persisted"));
    assert.ok(b.includes("## Promises as you last recorded them"), "the last promise list is there to be re-inspected");
    assert.ok(b.includes("browsing feeds the pet — kept"));
    assert.ok(b.includes("## Tree"));
    assert.ok(b.includes("## Project checks"));
    assert.ok(b.includes("## Procedure"));
    assert.ok(b.includes("# Cycle 3 scout"), "ends with the scout contract");
    assert.ok(b.includes("Considered:"));
    for (const t of HISTORY_TITLES) assert.equal(b.includes(t), false, `${t} must not reach the scout`);
    assert.equal(b.includes("Toolbar face"), false, "no cycle title from the record");
    assert.equal(b.includes("resolveBadge"), false, "no must-fix from the record");
    assert.equal(b.includes("popup CSS"), false, "no serendipity from the record");
  });

  it("grounds discovery in project consequences and preserves unverified promises", () => {
    const b = buildPlannerScoutBrief({
      state: runState(), workspace: "/w", gitStatus: "", projectChecks: ["npm test"],
    });
    assert.match(b, /library's consumer example/);
    assert.match(b, /security and privacy/);
    assert.match(b, /discovery lenses, not quotas or scores/);
    assert.match(b, /not required bins/);
    assert.match(b, /kept \| broken \| absent \| unknown/);
    assert.match(b, /Unknown means unverified: investigate before proposing repair/);
    assert.match(b, /An investigation that resolves a consequential unknown is legitimate work/);
  });

  it("passes the user's mandate through verbatim and frames it as attention, not a spec", () => {
    const laundry =
      "Improve this game, make it more interesting, attractive, and addictive. Make the game finished with rich contents.";
    const s = newCycleState({ sessionId: "mandate-bar", mandate: laundry });
    const b = buildPlannerScoutBrief({
      state: s, workspace: "/w", gitStatus: "", projectChecks: [],
    });
    const mandateBlock = b.split("## Mandate")[1]?.split("##")[0] ?? "";
    assert.ok(mandateBlock.includes(laundry), "harness does not rewrite the user's words");
    for (const line of MANDATE_QUALITY_BAR) {
      assert.ok(b.includes(line), "quality bar is in the scout brief");
    }
    assert.match(b, /not a quality ceiling/);
    assert.match(b, /Do not copy their adjectives/);
    assert.match(b, /web_search/);
    assert.match(b, /do not glob or grep \$HOME/);
    assert.doesNotMatch(b, /read the matching shipped forge-\* skill from the catalog/);
    assert.match(b, /user's adjectives are not the bar/);
  });

  it("names the inlined category skill for a CLI tree and omits it when unknown", () => {
    const unknown = buildPlannerScoutBrief({
      state: runState(),
      workspace: "/w",
      gitStatus: "",
      projectChecks: [],
    });
    assert.equal(unknown.includes("Category skill inlined:"), false);
    const unknownSingle = buildPlannerBrief({
      state: runState(),
      workspace: "/w",
      gitLog: "",
      gitStatus: "",
      guidelineSurvey: "",
      projectChecks: [],
      userMessages: [],
      spend: runSpend(runState()),
    });
    assert.equal(unknownSingle.includes("Category skill inlined:"), false);

    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-brief-cli-"));
    execFileSync("git", ["init", "-q"], { cwd: ws });
    fs.writeFileSync(
      path.join(ws, "package.json"),
      JSON.stringify({ name: "tool", bin: { tool: "./cli.js" } }),
    );
    try {
      const b = buildPlannerScoutBrief({
        state: runState(),
        workspace: ws,
        gitStatus: "",
        projectChecks: ["npm test"],
      });
      assert.match(b, /Category skill inlined: forge-shape/);
      const single = buildPlannerBrief({
        state: runState(),
        workspace: ws,
        gitLog: "",
        gitStatus: "",
        guidelineSurvey: "",
        projectChecks: ["npm test"],
        userMessages: [],
        spend: runSpend(runState()),
      });
      assert.match(single, /Category skill inlined: forge-shape/);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("Planner plan brief (turn 2)", () => {
  const input = () => ({
    state: runState(),
    workspace: "/w",
    gitLog: "abc1234 ulw cycle 1: Toolbar face",
    gitStatus: "M a.ts",
    guidelineSurvey: "AGENTS.md: ok",
    projectChecks: ["npm test"],
    userMessages: ["please keep the legal screen"],
    scoutText: "# Cycle 3 scout\nIdentity: a pet\nLooked: opened the popup\nPromises:\n- x — kept\nConsidered:\n- leave it — fine",
    spend: runSpend(runState()),
  });

  it("carries the scout back, then every part of the record, the spend and the plan contract", () => {
    const b = buildPlannerPlanBrief(input());
    assert.match(b, /^\[Forge cycle planner — cycle 3, turn 2 of 2/);
    assert.ok(b.includes("## Your scout (turn 1)"));
    assert.ok(b.includes("opened the popup"));
    for (const t of HISTORY_TITLES) assert.ok(b.includes(t), t);
    assert.ok(b.includes("cycle 1 — Toolbar face"));
    assert.match(b, /files: extension\/src\/face\.ts, extension\/src\/badge\.ts/);
    assert.match(b, /never the easiest remaining string/);
    assert.ok(b.includes("claimed: the icon is what a toolbar-pet user watches all day"), "the Planner's claim before the spend");
    assert.ok(b.includes("found: yes — the badge moves"), "the Reviewer's finding after");
    assert.ok(b.includes("resolveBadge takes ten positional args"));
    assert.ok(b.includes("scripts/seed.mjs reads it"), "the executor's dispute reaches the Planner");
    assert.ok(b.includes("please keep the legal screen"));
    assert.ok(b.includes("1 committed cycle"), "spend names the cycles");
    assert.ok(b.includes("Planner 20,000 tokens"), "spend sums planner tokens across cycles");
    assert.ok(b.includes("Reviewer 30,000 tokens"));
    assert.ok(b.includes("## Agent guidelines survey"));
    assert.ok(b.includes("# Cycle 3 plan"), "ends with the plan contract");
    assert.ok(b.includes("Worth the cycle:"));
    assert.ok(b.includes("same kind of change twice"), "the class rule is stated");
    assert.match(b, /session-sized plan/);
    assert.match(b, /One item:/);
    assert.match(b, /Pack every evidenced candidate of this class/);
    assert.match(b, /not sequels/);
    assert.match(b, / · 2 items/, "the ledger shows how big the last session was");
    assert.match(b, /ledger row that shows `1 item` is the exception/);
  });

  it("prices the spend only when a dollar figure is given", () => {
    const without = buildPlannerPlanBrief(input());
    assert.equal(/\$\d/.test(without.split("## Spend so far")[1].split("##")[0]), false);
    const with$ = buildPlannerPlanBrief({ ...input(), spend: { ...runSpend(runState()), usd: 12.5 } });
    assert.ok(with$.includes("$12.50"));
  });

  it("the single-brief fallback is scout and plan in one message and asks for Promises: in the plan", () => {
    const b = buildPlannerBrief({ ...input(), scoutText: undefined });
    assert.ok(b.includes("## Procedure"));
    assert.ok(b.includes("## What this run has shipped"));
    assert.ok(b.includes("one turn"), "says it is a single turn");
    assert.ok(b.includes("Promises:"), "the plan carries the promises when there is no scout");
    assert.equal(b.includes("## Your scout (turn 1)"), false);
    assert.ok(b.includes("# Cycle 3 plan"));
  });

  it("both planning paths permit evidence work and distinguish continued inquiry from forced edits", () => {
    for (const b of [buildPlannerPlanBrief(input()), buildPlannerBrief(input())]) {
      assert.match(b, /Existing behavior may already pass while its regression protection is missing/);
      assert.match(b, /a test-only item must identify the plausible fault its new check catches/);
      assert.match(b, /Prevented data loss/);
      assert.match(b, /the scout already spent/);
      assert.match(b, /Out of scope is a different job or a lease limit/);
      assert.match(b, /A one-item plan may keep at most one Out of scope entry/);
      assert.match(b, /fulfilled releases a run only when its explicit mandate is met/);
      assert.match(b, /An investigation may conclude no change is justified/);
      assert.match(b, /Never invent defects or edits to keep running/);
      assert.doesNotMatch(b, /say so and the run stops|the behaviour exists and the item is not an item/);
    }
  });

  it("a 12-cycle record keeps eight full cycle lines; older rows collapse", () => {
    const s = twelveCycleState();
    const b = buildPlannerPlanBrief({
      state: s,
      workspace: "/w",
      gitLog: "log",
      gitStatus: "M a.ts",
      guidelineSurvey: "ok",
      projectChecks: ["npm test"],
      userMessages: [],
      scoutText: "scout",
      spend: runSpend(s),
    });
    assertShippedCollapse(b.split("## What this run has shipped")[1]?.split("##")[0] ?? "", 12);
    assert.ok(b.includes("must-fix-from-last-review"), "last review Must-fix is not only in a dropped line");
    assert.equal(b.includes("must-fix-from-collapsed-cycle"), false, "collapsed-cycle Must-fix is not a durable row");
    assert.ok(b.includes("shape-note-from-last"), "last architecture notes stay");
    assert.ok(b.includes("The last Reviewer judged the last cycle not worth a cycle"));
    assert.ok(b.includes("A toolbar pet"), "identity stays");
    assert.ok(b.includes("tap a star to hunt"), "unkept promise stays");
    assert.ok(b.includes("## Spend so far"));

    const review = buildReviewerReviewBrief({
      state: s,
      workspace: "/w",
      planText: "# Cycle 12 plan — title-12\nConsidered:\n- leave it — already shipped",
      diff: "+x",
      diffTruncated: false,
      changedFiles: ["a.ts"],
      verifyCommand: "npm test",
      executorCloser: "Plan complete.",
    });
    // prior is n < 12 → 11 rows; a revert of reviewerRecordLines to map(cycleLine) pastes DIR-ESSAY-01.
    assertShippedCollapse(
      review.split("## What this run has shipped before this cycle")[1]?.split("##")[0] ?? "",
      11,
    );
  });

  it("both planning paths keep the quality bar and tell Direction: to be the Planner's sentence", () => {
    for (const b of [buildPlannerPlanBrief(input()), buildPlannerBrief(input())]) {
      for (const line of MANDATE_QUALITY_BAR) {
        assert.ok(b.includes(line));
      }
      assert.match(b, /never a restatement of the mandate/);
      assert.match(b, /job they pointed at is met at veteran quality/);
      assert.match(b, /not when every adjective is ticked/);
    }
  });
});

describe("Reviewer look brief (turn 1)", () => {
  it("carries identity, direction, the Planner's Looked and no diff", () => {
    const s = runState();
    const b = buildReviewerLookBrief({
      state: s,
      workspace: "/w",
      direction: "stars stay tappable under the lesson",
      plannerLooked: "loaded the extension; the star sat under the overlay",
      verifyCommand: "cd extension && npm test",
    });
    assert.match(b, /^\[Forge cycle reviewer — cycle 2, turn 1 of 2/);
    assert.ok(b.includes("stars stay tappable under the lesson"));
    assert.ok(b.includes("sat under the overlay"));
    assert.ok(b.includes("# Cycle 2 look"));
    assert.equal(b.includes("```diff"), false);
    assert.equal(b.includes("## Duty"), false);
    assert.ok(/do not edit/i.test(b));
  });

  it("names a down playwright so the scout does not wait on MCP", () => {
    const mgr = new McpManager({
      workspace: "/w",
      config: {
        enabled: true,
        sources: [],
        servers: { playwright: { name: "playwright", command: "true", disabled: true } },
      },
    });
    setActiveMcpManager(mgr);
    try {
      const scout = buildPlannerScoutBrief({
        state: runState(),
        workspace: "/w",
        gitStatus: "M a.ts",
        projectChecks: ["npm test"],
      });
      const look = buildReviewerLookBrief({
        state: runState(),
        workspace: "/w",
        direction: "stars",
      });
      assert.ok(scout.includes(LOOK_PATH_DOWN_LINE));
      assert.ok(look.includes(LOOK_PATH_DOWN_LINE));
    } finally {
      setActiveMcpManager(null);
    }
  });

  it("the lease hint also fires while playwright is still connecting", () => {
    const mgr = new McpManager({
      workspace: "/w",
      config: {
        enabled: true,
        sources: [],
        servers: { playwright: { name: "playwright", command: "true" } },
      },
    });
    mgr.start();
    setActiveMcpManager(mgr);
    try {
      const scout = buildPlannerScoutBrief({
        state: runState(),
        workspace: "/w",
        gitStatus: "M a.ts",
        projectChecks: ["npm test"],
      });
      assert.match(
        scout,
        /Look path: playwright connecting — if call_mcp is not yet listed, use the leased profile below once; do not mkdir a new \/tmp UDD/,
      );
    } finally {
      setActiveMcpManager(null);
    }
  });

  it("names the leased look profile and a Godot recipe when project.godot is present", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-godot-brief-"));
    fs.writeFileSync(path.join(ws, "project.godot"), "; godot\n");
    try {
      const scout = buildPlannerScoutBrief({
        state: runState(),
        workspace: ws,
        gitStatus: "",
        projectChecks: ["make test"],
        lookProfileUdd: "/tmp/look-udd",
      });
      assert.match(scout, /Leased browser profile.*\/tmp\/look-udd/);
      assert.match(scout, /Godot look:.*gl_compatibility.*--write-movie/);
      assert.match(scout, /do not `open -a Godot`/);
      assert.match(scout, /Category skill inlined: forge-game-assets/);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

const LIFECYCLE_LINE =
  "until a mandate fulfilled, Planner blocked, /cycle 0, max_cycles, or the no-progress wall. Fulfilled releases only an explicit mandate.";

describe("unlimited ULW lifecycle copy", () => {
  function assertMatchesDriver(text: string, label: string) {
    assert.doesNotMatch(text, /in good shape/, `${label} must not end a no-mandate run on "in good shape"`);
    assert.match(text, /no-progress/, `${label} must name the no-progress wall`);
    assert.match(text, /blocked/, `${label} must name Planner blocked`);
    assert.match(text, /explicit mandate/, `${label} must say fulfilled releases only an explicit mandate`);
    assert.ok(text.includes(LIFECYCLE_LINE), `${label} must match planNextCycle's release conditions`);
  }

  it("kickoff unlimited budget matches planNextCycle", () => {
    const kick = ulwKickoffMessage(newCycleState({ sessionId: "life-kick", mandate: null }));
    assert.match(kick, /^\[Forge ULW cycle driver\] armed/);
    assert.ok(kick.includes(`Budget: unlimited cycles ${LIFECYCLE_LINE}`));
    assertMatchesDriver(kick, "kickoff");
    const capped = ulwKickoffMessage(newCycleState({ sessionId: "life-cap", mandate: null, maxCycles: 3 }));
    assert.match(capped, /Budget: 3 cycle\(s\)\./);
    assert.doesNotMatch(capped, /in good shape/);
  });

  it("admit unlimited line matches planNextCycle (a revert of the admit string is red)", () => {
    const admit = renderHarnessAdmission({
      ulwEnabled: true,
      cycle: 1,
      phase: "execute",
      wave: 0,
      maxCycles: null,
      itemsOpen: 0,
      itemsTotal: 0,
      planTitle: "",
      cycleZeroRequested: false,
      mandate: "",
      goalActive: false,
      goalObjective: "",
      goalPaused: false,
      openTodos: 0,
      permissionMode: "default",
    });
    assert.match(admit, /^\[Forge harness — mid-conversation update\]/);
    assert.ok(
      admit.includes(`Unlimited cycles ${LIFECYCLE_LINE}`),
      "admit unlimited line must be the planNextCycle lifecycle, not 'in good shape'",
    );
    assertMatchesDriver(admit, "admit");
  });
});

describe("Reviewer review brief (turn 2)", () => {
  const input = () => ({
    state: runState(),
    workspace: "/w",
    planText: "# Cycle 2 plan — Stars stay tappable\nConsidered:\n- rough edge: overlay z-index — one line\n- leave it — the hunt is blocked\nDirection: stars",
    diff: "--- a.ts\n+++ a.ts\n+z-index: 41",
    diffTruncated: false,
    changedFiles: ["a.ts"],
    verifyCommand: "npm test",
    executorCloser: "Plan complete.",
  });

  it("carries the look back, the record for the class check, the Considered pointer and the root-cause duty", () => {
    const b = buildReviewerReviewBrief({ ...input(), lookText: "# Cycle 2 look\nLooked: tapped a star — it hunts" });
    assert.match(b, /^\[Forge cycle reviewer — cycle 2, turn 2 of 2/);
    assert.ok(b.includes("## Your look (turn 1)"));
    assert.ok(b.includes("it hunts"));
    assert.ok(b.includes("```diff"));
    assert.ok(b.includes("## What this run has shipped"), "the record is what makes a class visible");
    assert.ok(b.includes("cycle 1 — Toolbar face"));
    assert.ok(b.includes("same class"), "the symptom duty is stated");
    assert.ok(b.includes("Considered:"), "the Reviewer is pointed at the alternatives");
    assert.ok(b.includes("# Cycle 2 review"));
    assert.ok(b.includes("Looked:"));
  });

  it("the single-brief fallback asks for the look first, in the same message", () => {
    const b = buildReviewerBrief(input());
    assert.equal(b.includes("## Your look (turn 1)"), false);
    assert.ok(/before you read the diff/i.test(b));
    assert.ok(b.includes("```diff"));
    assert.ok(b.includes("# Cycle 2 review"));
  });

  it("both review paths accept invisible benefits and separate acceptance defects from future work", () => {
    for (const b of [buildReviewerReviewBrief(input()), buildReviewerBrief(input())]) {
      assert.match(b, /Reliability, security, accessibility, performance, recovery, compatibility, maintainability and regression protection can justify a cycle/);
      assert.match(b, /Test-only changes are valid/);
      assert.match(b, /Do not require a production edit for behavior that is already correct/);
      assert.match(b, /A useful investigation may produce no code change/);
      assert.match(b, /Partial or missing items cannot ship/);
      assert.match(b, /Verdict: ship-with-revisions: the harness withholds commit/);
      assert.match(b, /Reserve blocked for an unavailable review/);
      assert.match(b, /Nonblocking observations and future improvements belong under Architecture/);
      assert.match(b, /not against whether the diff matches the mandate's adjectives/);
      assert.match(b, /one slice while Considered already listed other evidenced candidates/);
      assert.match(b, /Class is this cycle's scope/);
      assert.match(b, /Must-fix names what a user of this product would hit/);
      assert.doesNotMatch(b, /test-only change with no production body|stop planning invisible cycles|first minute, first day/);
    }
  });

  it("a parseable one-item plan is counted against Considered so Worth: no is a fact, not a reread", () => {
    const planText = [
      "# Cycle 2 plan — Stars stay tappable",
      "Verdict: continue",
      "Looked: tapped a star — overlay ate the click",
      "Considered:",
      "- rough edge: overlay z-index — one line",
      "- missing: hunt cooldown — same first-hour job",
      "- leave it — the hunt is blocked",
      "Direction: stars",
      "Worth the cycle: the hunt is the product's verb",
      "Verify: npm test",
      "Items:",
      "1. overlay z-index — files: a.ts — serves: hunt — red now: overlay ate the click — proof: npm test",
      "One item: isolated kernel — cooldown is a different job",
      "Out of scope:",
      "- Steamworks — a different job",
    ].join("\n");
    const b = buildReviewerReviewBrief({ ...input(), planText, lookText: "# Cycle 2 look\nLooked: tapped a star" });
    assert.match(b, /This plan has 1 item and 2 Considered candidates besides leave it/);
    assert.match(b, /A one-item plan of a class already in Considered is Worth: no unless One item: names a real isolation/);
    assert.match(b, /Out of scope on a one-item plan is one different job or a lease limit/);
  });

  it("turn 2 is the document: Must-fix revises the tree, not write access", () => {
    for (const b of [buildReviewerReviewBrief(input()), buildReviewerBrief(input())]) {
      assert.doesNotMatch(b, /write access/i);
      assert.doesNotMatch(b, /revise in place/i);
      assert.doesNotMatch(b, /Revise what you can now/);
      assert.match(b, /You do not edit this turn; Must-fix is how the tree changes/);
    }
    const look = buildReviewerLookBrief({
      state: runState(),
      workspace: "/w",
      direction: "stars",
    });
    assert.ok(/do not edit/i.test(look));
  });
});

describe("plan admission", () => {
  it("tells the executor the plan is the contract and the mandate does not license a sloppy ship", () => {
    const text = formatPlanAdmission({
      cycle: 1,
      title: "First-hour verb",
      planText: "# Cycle 1 plan — First-hour verb\nDirection: the jump feels like this game",
      items: [{ id: "i1", title: "tighten jump" }],
      verifyCommand: "npm test",
      maxCycles: null,
      cycleZeroRequested: false,
    });
    assert.match(text, /mandate's wording does not license a sloppy ship/);
    assert.match(text, /extra unplanned scope/);
    assert.match(text, /one session of a theme, not one tiny task/);
    assert.doesNotMatch(text, /reads the cycle diff and revises/);
    assert.match(text, /writes the review \(Must-fix is how the tree changes\)/);
  });
});

describe("runSpend", () => {
  it("sums role tokens over every cycle and counts committed cycles", () => {
    assert.deepEqual(runSpend(runState()), { cycles: 2, committed: 1, plannerTokens: 20_000, reviewerTokens: 30_000 });
    assert.deepEqual(runSpend(newCycleState({ sessionId: "x", mandate: null })), {
      cycles: 0,
      committed: 0,
      plannerTokens: 0,
      reviewerTokens: 0,
    });
  });
});
