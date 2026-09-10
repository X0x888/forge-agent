import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
  runSpend,
} from "../src/harness/cycle/briefs.js";
import { newCycleState, type CycleState } from "../src/harness/cycle/state.js";
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
    assert.match(b, /matching shipped forge-\* skill/);
    assert.match(b, /user's adjectives are not the bar/);
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
      assert.match(b, /fulfilled releases a run only when its explicit mandate is met/);
      assert.match(b, /An investigation may conclude no change is justified/);
      assert.match(b, /Never invent defects or edits to keep running/);
      assert.doesNotMatch(b, /say so and the run stops|the behaviour exists and the item is not an item/);
    }
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
        /Look path: playwright connecting — use bash\/browser lease; do not spend the scout waiting on MCP\./,
      );
    } finally {
      setActiveMcpManager(null);
    }
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
      assert.doesNotMatch(b, /test-only change with no production body|stop planning invisible cycles|first minute, first day/);
    }
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
