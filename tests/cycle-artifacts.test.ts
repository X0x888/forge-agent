import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  architectureClassTokens,
  explainPlanParseFailure,
  explainReviewParseFailure,
  extractDisputeLines,
  extractLabelledLines,
  extractSerendipityLines,
  isSurfaceSit,
  lookCouldNotLook,
  lookHasKernelEvidence,
  lookInfraFailed,
  classifyLookKind,
  lookKindAllowsSurfaceCommit,
  architectureClassMustCollapse,
  continueWorthHold,
  worthIsNo,
  parseLookArtifact,
  parsePlanArtifact,
  parsePlanItemLine,
  parseReviewArtifact,
  parseScoutArtifact,
  salvageIncompleteReview,
  formatBlockedReview,
  readPlanRecordLabels,
  readReviewRecordLabels,
  planAddressesArchitectureClass,
  planCollapsesArchitectureClass,
  planArtifactContract,
  recurringArchitectureClass,
  reviewArtifactContract,
  scoutArtifactContract,
  PLAN_COMPLETE_RE,
  MAX_CYCLE_PLAN_ITEMS,
  planIsClassSlice,
  consideredSiblingItems,
  consideredCandidates,
} from "../src/harness/cycle/artifacts.js";

/** The alternatives block every `continue` plan has to carry. */
const CONSIDERED = [
  "Considered:",
  "- missing capability: a --json flag — cheap, but no user asked for machine output yet",
  "- broken promise: the README's first-run card is missing — the first thing a new user meets",
  "- leave it — the CLI runs; without the card a new user still has to read the docs",
].join("\n");

/** An item line in the full shape: files, serves, red now, proof. */
const ITEM = (title: string, files: string, proof: string) =>
  `${title} — files: ${files} — serves: a new user orienting without docs — red now: ran node dist/cli.js with no config, no card — proof: ${proof}`;

const PLAN = `
### Subagent result: cycle 1 planner
- status: completed

# Cycle 1 plan — Make the CLI usable on first run
Verdict: continue
Identity: Forge is a terminal coding agent for developers who want an autonomous loop with a real harness.
Looked: built dist, ran node dist/cli.js in an empty dir — got a bare prompt, no orientation.
${CONSIDERED}
Direction: first-run polish — the CLI should orient a new user without docs.
Worth the cycle: a new user's first minute is the product's whole first impression; nothing generic about it — this CLI's --help is the only door.
Verify: \`npm test\`
Items:
1. ${ITEM("Print a first-run card when no config exists", "src/cli.ts, src/tui/banner.ts", "node dist/cli.js --help shows the card")}
2. ${ITEM("Add --version", "src/cli.ts", "npm test")}
- ${ITEM("Fix the stale path in AGENTS.md", "AGENTS.md", "npm run typecheck").replace(/ — /g, " | ")}
Out of scope:
- Rewriting the provider layer (a different cycle)
Guidelines: fix: AGENTS.md names npm run lint which does not exist
Operator: none
`;

/** Presence-only sit every `continue` plan owes. A failed sit still counts. */
const LOOK_DIR_WORTH = [
  "Looked: ran the binary — bare prompt",
  "Direction: first-run card",
  "Worth the cycle: a new user should see a card without the docs",
].join("\n");

/** Required when Items has one entry. */
const ONE_ITEM =
  "One item: isolated kernel — other Considered entries are a different job or leave-it, not the next cycle";

/** The smallest continue plan the parser accepts. */
const MINIMAL = (extra = "") =>
  `# Cycle 2 plan — x\nVerdict: continue\n${LOOK_DIR_WORTH}\n${CONSIDERED}\nVerify: npm test\nItems:\n1. ${ITEM("a thing", "a.ts", "npm test")}\n${ONE_ITEM}\n${extra}`;

describe("plan artifact parser", () => {
  it("parses verdict, identity, looked, considered, direction, worth claim, verify, items, out-of-scope, guidelines", () => {
    const p = parsePlanArtifact(PLAN);
    assert.ok(p);
    assert.equal(p.verdict, "continue");
    assert.equal(p.title, "Make the CLI usable on first run");
    assert.match(p.identity ?? "", /terminal coding agent/);
    assert.match(p.looked ?? "", /bare prompt/);
    assert.equal(p.considered.length, 3);
    assert.match(p.considered[2], /^leave it/);
    assert.match(p.direction ?? "", /first-run polish/);
    assert.match(p.worthClaim ?? "", /first impression/);
    assert.equal(p.verifyCommand, "npm test");
    assert.equal(p.items.length, 3);
    assert.equal(p.items[0].id, "i1");
    assert.equal(p.items[0].title, "Print a first-run card when no config exists");
    assert.deepEqual(p.items[0].files, ["src/cli.ts", "src/tui/banner.ts"]);
    assert.equal(p.items[0].serves, "a new user orienting without docs");
    assert.match(p.items[0].redNow ?? "", /no card/);
    assert.match(p.items[0].proof ?? "", /--help/);
    assert.deepEqual(p.items[2].files, ["AGENTS.md"]);
    assert.equal(p.items[2].proof, "npm run typecheck");
    assert.equal(p.outOfScope.length, 1);
    assert.match(p.guidelines ?? "", /^fix:/);
    assert.deepEqual(p.operator, []);
  });

  it("refuses prose under Verify: and reports it", () => {
    const p = parsePlanArtifact(
      `# Cycle 2 plan — x\nVerdict: continue\n${LOOK_DIR_WORTH}\n${CONSIDERED}\nVerify: the login flow works end to end\nItems:\n1. ${ITEM("a thing", "a.ts", "npm test")}\n${ONE_ITEM}`,
    );
    assert.ok(p);
    assert.equal(p.verifyCommand, undefined);
    assert.match(p.verifyRefused ?? "", /login flow/);
  });

  it("accepts Verify: none — why", () => {
    const p = parsePlanArtifact(
      `# Cycle 2 plan — x\nVerdict: continue\n${LOOK_DIR_WORTH}\n${CONSIDERED}\nVerify: none — this repo has no test runner yet\nItems:\n1. ${ITEM("add one", "a.ts", "npm test")}\n${ONE_ITEM}`,
    );
    assert.ok(p);
    assert.equal(p.verifyCommand, undefined);
    assert.match(p.verifyNone ?? "", /no test runner/);
  });

  it("fulfilled and blocked verdicts carry their note and need no items, no Considered", () => {
    const f = parsePlanArtifact(`# Cycle 3 plan\nVerdict: fulfilled — the --version flag already exists and is tested`);
    assert.ok(f);
    assert.equal(f.verdict, "fulfilled");
    assert.match(f.verdictNote ?? "", /already exists/);
    assert.deepEqual(f.considered, []);
    const b = parsePlanArtifact(`# Cycle 3 plan\nVerdict: blocked — needs the STRIPE_KEY secret\nOperator: provide STRIPE_KEY`);
    assert.ok(b);
    assert.equal(b.verdict, "blocked");
    assert.deepEqual(b.operator, ["provide STRIPE_KEY"]);
  });

  it("a continue plan with no items does not parse", () => {
    assert.equal(parsePlanArtifact(`# Cycle 1 plan\nVerdict: continue\n${CONSIDERED}\nItems:\n`), null);
    assert.equal(parsePlanArtifact(`just some prose with no labelled lines`), null);
  });

  it("a continue plan without Considered:, or without a leave-it entry, does not parse", () => {
    const noConsidered = `# Cycle 1 plan\nVerdict: continue\nVerify: npm test\nItems:\n1. ${ITEM("a", "a.ts", "npm test")}`;
    assert.equal(parsePlanArtifact(noConsidered), null);
    assert.match(explainPlanParseFailure(noConsidered), /Considered:/);
    const noLeaveIt = `# Cycle 1 plan\nVerdict: continue\nConsidered:\n- rough edge: x — y\n- debt: z — w\nVerify: npm test\nItems:\n1. ${ITEM("a", "a.ts", "npm test")}`;
    assert.equal(parsePlanArtifact(noLeaveIt), null);
    assert.match(explainPlanParseFailure(noLeaveIt), /leave it/);
    // A bold leave-it entry counts.
    const bold = `# Cycle 1 plan\nVerdict: continue\n${LOOK_DIR_WORTH}\nConsidered:\n- rough edge: x — y\n- **leave it** — fine as is\nVerify: npm test\nItems:\n1. ${ITEM("a", "a.ts", "npm test")}\n${ONE_ITEM}`;
    assert.ok(parsePlanArtifact(bold));
  });

  it("a continue plan whose item lacks serves: or red now: does not parse, and the explanation names the item", () => {
    const noServes = `# Cycle 1 plan\nVerdict: continue\n${CONSIDERED}\nVerify: npm test\nItems:\n1. a thing — files: a.ts — red now: checked, absent — proof: npm test`;
    assert.equal(parsePlanArtifact(noServes), null);
    assert.match(explainPlanParseFailure(noServes), /item 1 .*serves:/);
    const noRed = `# Cycle 1 plan\nVerdict: continue\n${CONSIDERED}\nVerify: npm test\nItems:\n1. a thing — files: a.ts — serves: the job — proof: npm test`;
    assert.equal(parsePlanArtifact(noRed), null);
    assert.match(explainPlanParseFailure(noRed), /item 1 .*red now:/);
    // `red now: unchecked — why` is a valid labelled line.
    const unchecked = `# Cycle 1 plan\nVerdict: continue\n${LOOK_DIR_WORTH}\n${CONSIDERED}\nVerify: npm test\nItems:\n1. a thing — files: a.ts — serves: the job — red now: unchecked, needs a browser — proof: npm test\n${ONE_ITEM}`;
    assert.ok(parsePlanArtifact(unchecked));
  });

  it("a continue plan without Looked, Direction, or Worth the cycle does not parse; a failed sit is a look", () => {
    const onlyShape = `# Cycle 1 plan\nVerdict: continue\n${CONSIDERED}\nVerify: npm test\nItems:\n1. ${ITEM("a", "a.ts", "npm test")}`;
    assert.equal(parsePlanArtifact(onlyShape), null);
    assert.match(explainPlanParseFailure(onlyShape), /Looked:/);
    assert.match(explainPlanParseFailure(onlyShape), /Direction:/);
    assert.match(explainPlanParseFailure(onlyShape), /Worth the cycle:/);
    const noLooked = `# Cycle 1 plan\nVerdict: continue\nLooked:\n${CONSIDERED}\nDirection: first-run card\nWorth the cycle: x\nVerify: npm test\nItems:\n1. ${ITEM("a", "a.ts", "npm test")}`;
    assert.equal(parsePlanArtifact(noLooked), null);
    assert.match(explainPlanParseFailure(noLooked), /Looked:/);
    const noDirection = `# Cycle 1 plan\nVerdict: continue\nLooked: ran it\n${CONSIDERED}\nWorth the cycle: x\nVerify: npm test\nItems:\n1. ${ITEM("a", "a.ts", "npm test")}`;
    assert.equal(parsePlanArtifact(noDirection), null);
    assert.match(explainPlanParseFailure(noDirection), /Direction:/);
    const noWorth = `# Cycle 1 plan\nVerdict: continue\nLooked: ran it\n${CONSIDERED}\nDirection: first-run card\nVerify: npm test\nItems:\n1. ${ITEM("a", "a.ts", "npm test")}`;
    assert.equal(parsePlanArtifact(noWorth), null);
    assert.match(explainPlanParseFailure(noWorth), /Worth the cycle:/);
    const failedSit = `# Cycle 1 plan\nVerdict: continue\nLooked: could not run — Playwright MCP never initialized; Godot grey\n${CONSIDERED}\nDirection: first-run card\nWorth the cycle: x\nVerify: npm test\nItems:\n1. ${ITEM("a", "a.ts", "npm test")}\n${ONE_ITEM}`;
    const p = parsePlanArtifact(failedSit);
    assert.ok(p);
    assert.match(p.looked ?? "", /could not run/);
  });

  it("resume backfill reads Direction/Looked from a continue plan the admit parser refuses", () => {
    const plan = `# Cycle 1 plan — x\nVerdict: continue\nLooked: ran the popup\n${CONSIDERED}\nDirection: leftover sits with Murmur\nVerify: npm test\nItems:\n1. ${ITEM("a", "a.ts", "npm test")}`;
    assert.equal(parsePlanArtifact(plan), null, "no Worth the cycle: — does not admit");
    assert.deepEqual(readPlanRecordLabels(plan), {
      direction: "leftover sits with Murmur",
      looked: "ran the popup",
    });
  });

  it("explainPlanParseFailure lists every defect and says so when the plan is fine", () => {
    assert.match(explainPlanParseFailure("no labelled lines at all"), /Verdict:/);
    assert.match(explainPlanParseFailure(`Verdict: continue\nItems:\n`), /empty Items:/);
    assert.equal(explainPlanParseFailure(MINIMAL()), "");
  });

  it("accepts **Verdict.** (period after the label) the way models often bold the contract", () => {
    const p = parsePlanArtifact(
      [
        `# Cycle 15 scout`,
        `**Verdict.** continue — restow the title door`,
        `**Identity.** a player of the extract-port`,
        `**Looked.** smoke EXIT:0 SMOKE_FUSE_OK`,
        `**Considered.**`,
        `- leave it tick_bombs — already bound`,
        `- restow stock Start — first session`,
        `**Direction.** restow Start from a scripted handler`,
        `**Worth the cycle.** the first session is the title`,
        `**Verify.** \`cargo test -p game_core --offline && godot --path godot --headless --script res://scripts/smoke.gd\``,
        `**Items.**`,
        `1. Restow the title door — files: godot/scripts/main.gd — serves: sit down without a toolbar — red now: stock StartButton — proof: smoke calls _on_start`,
        `One item: isolated kernel — leave it is the other Considered entry`,
      ].join("\n"),
    );
    assert.ok(p);
    assert.equal(p.verdict, "continue");
    assert.match(p.title, /restow the title door/i);
    assert.equal(p.items.length, 1);
    assert.match(p.verifyCommand ?? "", /godot/);
  });

  it("item lines keep unlabelled trailing segments in the title, and prose after a prose label stays with that label", () => {
    const it1 = parsePlanItemLine("Wire the settle listener — so background checks count — files: src/agent/loop.ts", 0);
    assert.equal(it1.title, "Wire the settle listener — so background checks count");
    assert.deepEqual(it1.files, ["src/agent/loop.ts"]);
    const it2 = parsePlanItemLine(
      "Show the card — files: src/cli.ts — red now: ran the binary — no card, bare prompt — serves: first minute — proof: npm test",
      1,
    );
    assert.equal(it2.title, "Show the card");
    assert.deepEqual(it2.files, ["src/cli.ts"]);
    assert.equal(it2.redNow, "ran the binary — no card, bare prompt");
    assert.equal(it2.serves, "first minute");
    assert.equal(it2.proof, "npm test");
    // `red:` is accepted as the short form.
    assert.equal(parsePlanItemLine("a — red: not yet", 2).redNow, "not yet");
  });

  it("the contract text names every section the parser reads, and the item shape", () => {
    const c = planArtifactContract(4);
    for (const label of [
      "Verdict:",
      "Identity:",
      "Looked:",
      "Considered:",
      "leave it",
      "Direction:",
      "Worth the cycle:",
      "Verify:",
      "Items:",
      "One item:",
      "serves:",
      "red now:",
      "proof:",
      "Out of scope:",
      "Guidelines:",
      "Operator:",
    ]) {
      assert.ok(c.includes(label), label);
    }
    assert.ok(c.includes("# Cycle 4 plan"));
    assert.match(c, /never a paraphrase of the mandate's adjectives/);
    assert.match(c, /more than 12 is a backlog/);
  });

  it("a continue plan with one item and no One item: does not parse", () => {
    const no = `# Cycle 2 plan — x\nVerdict: continue\n${LOOK_DIR_WORTH}\n${CONSIDERED}\nVerify: npm test\nItems:\n1. ${ITEM("a thing", "a.ts", "npm test")}\n`;
    assert.equal(parsePlanArtifact(no), null);
    assert.match(explainPlanParseFailure(no), /One item:/);
  });

  it("a continue plan with one item and One item: parses", () => {
    const p = parsePlanArtifact(MINIMAL());
    assert.ok(p);
    assert.equal(p.items.length, 1);
    assert.match(p.oneItem ?? "", /isolated kernel/);
  });

  it("a continue plan with two items does not need One item:", () => {
    const two = `# Cycle 2 plan — x\nVerdict: continue\n${LOOK_DIR_WORTH}\n${CONSIDERED}\nVerify: npm test\nItems:\n1. ${ITEM("a thing", "a.ts", "npm test")}\n2. ${ITEM("another", "b.ts", "npm test")}\n`;
    const p = parsePlanArtifact(two);
    assert.ok(p);
    assert.equal(p.items.length, 2);
    assert.equal(p.oneItem, undefined);
  });

  it("a continue plan at the session cap parses; one more does not (no silent slice)", () => {
    const mk = (n: number) => {
      const items = Array.from(
        { length: n },
        (_, i) => `${i + 1}. ${ITEM(`thing ${i + 1}`, `a${i}.ts`, "npm test")}`,
      ).join("\n");
      return `# Cycle 2 plan — x\nVerdict: continue\n${LOOK_DIR_WORTH}\n${CONSIDERED}\nVerify: npm test\nItems:\n${items}\n`;
    };
    const atCap = parsePlanArtifact(mk(MAX_CYCLE_PLAN_ITEMS));
    assert.ok(atCap);
    assert.equal(atCap.items.length, MAX_CYCLE_PLAN_ITEMS);
    const over = mk(MAX_CYCLE_PLAN_ITEMS + 1);
    assert.equal(parsePlanArtifact(over), null);
    assert.match(explainPlanParseFailure(over), new RegExp(`session \\(${MAX_CYCLE_PLAN_ITEMS}\\)`));
  });

  it("a one-item plan with two Considered candidates besides leave it is a class slice", () => {
    assert.equal(
      planIsClassSlice([{ title: "the card" }], [
        "broken promise: first-run card",
        "rough edge: --dry deletes",
        "leave it — it runs",
      ]),
      true,
    );
    assert.equal(planIsClassSlice([{ title: "a" }, { title: "b" }], ["x", "y", "leave it"]), false);
    assert.equal(planIsClassSlice([{ title: "the card" }], ["x", "leave it"]), false);
    const sibs = consideredSiblingItems(
      ["broken promise: first-run card — first thing", "rough edge: --dry deletes — same class", "leave it — runs"],
      [{ id: "i1", title: "first-run card" }],
      12,
    );
    assert.equal(consideredCandidates(["a", "leave it — x", "b"]).length, 2);
    assert.ok(sibs.some((i) => /--dry/.test(i.title)));
    assert.ok(!sibs.some((i) => /leave it/i.test(i.title)));
  });

  it("a one-item plan may keep one Out of scope entry; two is a parking lot", () => {
    const one = `# Cycle 2 plan — x\nVerdict: continue\n${LOOK_DIR_WORTH}\n${CONSIDERED}\nVerify: npm test\nItems:\n1. ${ITEM("a thing", "a.ts", "npm test")}\n${ONE_ITEM}\nOut of scope:\n- Steamworks — a different job\n`;
    const p = parsePlanArtifact(one);
    assert.ok(p);
    assert.equal(p.outOfScope.length, 1);
    const lot = `# Cycle 2 plan — x\nVerdict: continue\n${LOOK_DIR_WORTH}\n${CONSIDERED}\nVerify: npm test\nItems:\n1. ${ITEM("a thing", "a.ts", "npm test")}\n${ONE_ITEM}\nOut of scope:\n- keep-50 cull\n- --dry preview\n`;
    assert.equal(parsePlanArtifact(lot), null);
    assert.match(explainPlanParseFailure(lot), /parking lot/);
  });

  it("numbered item lines under One item: do not parse (they would be dropped)", () => {
    const stolen = `# Cycle 2 plan — x\nVerdict: continue\n${LOOK_DIR_WORTH}\n${CONSIDERED}\nVerify: npm test\nItems:\n1. ${ITEM("a thing", "a.ts", "npm test")}\nOne item: isolated kernel\n2. ${ITEM("another", "b.ts", "npm test")}\n`;
    assert.equal(parsePlanArtifact(stolen), null);
    assert.match(explainPlanParseFailure(stolen), /numbered item lines/);
  });
});

const SCOUT = `
### Subagent result: cycle 2 planner
- status: completed

# Cycle 2 scout
Identity: A toolbar pet for people who want a Tamagotchi in the browser.
Looked: loaded the unpacked extension, clicked the icon — the popup opens on a legal screen, no pet for 40 seconds.
Promises:
- README: "your browsing feeds the pet" — kept — a tab visit raised hunger in the popup
- --help / store copy: "breeding" — absent — no code path, no screen
- First-hour guide: "tap a star to hunt" — broken — the star is under the lesson overlay (z-40)
- No account, no server (kept)
- a line with no state at all
Considered:
- missing capability: sound on feed — small, nobody asked
- broken promise: stars are not tappable under the overlay — the hour-one verb
- leave it — the pet lives; only the hunt is blocked
`;

describe("scout artifact parser", () => {
  it("preserves unknown promises and their evidence limits in scouts and single-turn plans", () => {
    const promises = `Promises:\n- Recovery after restart — UNKNOWN — cannot restart the service here\n- Offline delivery (unknown)\n`;
    const expected = [
      { text: "Recovery after restart", state: "unknown", seen: "cannot restart the service here" },
      { text: "Offline delivery", state: "unknown" },
    ];
    assert.deepEqual(
      parseScoutArtifact(`Looked: could not run — recovery fixture unavailable\n${promises}`)?.promises,
      expected,
    );
    assert.deepEqual(parsePlanArtifact(`Verdict: fulfilled\n${promises}`)?.promises, expected);
  });

  it("parses identity, looked, promises with states and where seen, considered", () => {
    const s = parseScoutArtifact(SCOUT);
    assert.ok(s);
    assert.match(s.identity ?? "", /toolbar pet/);
    assert.match(s.looked ?? "", /legal screen/);
    assert.equal(s.promises.length, 4, "a line without a state is not a promise row");
    assert.deepEqual(s.promises[0], {
      text: `README: "your browsing feeds the pet"`,
      state: "kept",
      seen: "a tab visit raised hunger in the popup",
    });
    assert.equal(s.promises[1].state, "absent");
    assert.equal(s.promises[2].state, "broken");
    assert.deepEqual(s.promises[3], { text: "No account, no server", state: "kept" });
    assert.equal(s.considered.length, 3);
  });

  it("a document with none of the scout sections does not parse; the contract names them", () => {
    assert.equal(parseScoutArtifact("I looked around and it seems fine."), null);
    const c = scoutArtifactContract(3);
    for (const label of ["# Cycle 3 scout", "Identity:", "Looked:", "Promises:", "kept | broken | absent | unknown | limited", "Considered:", "leave it"]) {
      assert.ok(c.includes(label), label);
    }
  });

  it("a scout without Looked: is incomplete; an empty Looked is not a look", () => {
    const noLook = `# Cycle 1 scout\nIdentity: a\nPromises:\n- x — kept\nConsidered:\n- leave it — fine`;
    assert.equal(parseScoutArtifact(noLook), null);
    const emptyLook = `# Cycle 1 scout\nIdentity: a\nLooked:\nPromises:\n- x — kept\nConsidered:\n- leave it — fine`;
    assert.equal(parseScoutArtifact(emptyLook), null);
    const failedLook = `# Cycle 1 scout\nIdentity: a\nLooked: could not run — Playwright MCP never initialized\nPromises:\n- x — unknown — MCP down\nConsidered:\n- leave it — fine`;
    const s = parseScoutArtifact(failedLook);
    assert.ok(s);
    assert.match(s.looked ?? "", /could not run/);
  });
});

const REVIEW = `
# Cycle 1 review
Verdict: ship-with-revisions — two items landed, one partial
Looked: ran node dist/cli.js in an empty dir — the card shows; --version prints an empty line.
Fulfillment:
- Print a first-run card — done
- Add --version — partial — flag parses but prints nothing
- Fix the stale path in AGENTS.md — missing
Revisions:
- Deleted tests/version.test.ts: it asserted on the source text, could not fail
- Extracted printVersion() so --version and the banner share it
Must-fix:
- --version prints an empty line
Architecture:
- cli.ts grew a fourth boolean flag; a first-run context object is due
Worth: yes — a new user sees the card in their first minute
Operator: none
`;

describe("look artifact parser", () => {
  it("pins couldNotLook on Looked: lines that never opened the product", () => {
    const pin = (text: string, could: boolean) => {
      const p = parseLookArtifact(`# Cycle 1 look\nLooked: ${text}`);
      assert.ok(p, text);
      assert.equal(p.couldNotLook, could, text);
    };
    pin("Playwright MCP never initialized", true);
    pin("could not run — no display", true);
    pin("never opened the popup", true);
    pin("did not open popup; MCP timed out", true);
    pin("loaded the unpacked extension and clicked the icon", false);
    pin("headless smoke EXIT:0 SMOKE_FUSE_OK", false);
    pin(
      "Playwright MCP never initialized; opened leftover via bash Chrome — dock is empty",
      false,
    );
    pin("Playwright MCP never initialized; use bash/browser lease", true);
    pin("Playwright MCP never initialized — use bash/browser lease", true);
    pin("Playwright MCP never initialized. I never actually opened anything", true);
    assert.equal(parseLookArtifact("# Cycle 1 look\nIdentity: a pet"), null);
  });
});

describe("surface sit classifier", () => {
  const item = (
    o: { title: string; proof?: string; redNow?: string },
  ): Parameters<typeof isSurfaceSit>[0][number] => ({
    id: "i1",
    files: [],
    status: "open",
    ...o,
  });

  it("does not treat visit as a sit, or go-deeper walk/screen prose as a surface", () => {
    assert.equal(isSurfaceSit([item({ title: "visit the API docs", proof: "curl /v1" })]), false);
    assert.equal(
      isSurfaceSit([item({ title: "a tab visit raised hunger", proof: "visit the API docs" })]),
      false,
    );
    assert.equal(
      isSurfaceSit([
        item({
          title:
            "Go deeper — a flow the run has not walked. Exercise an untested core workflow: screens and return paths for an app, public calls for a library.",
          redNow: "unwalked — exercise it now",
          proof: "a reproducible observation or measurement of the workflow or risk, plus the project gate",
        }),
      ]),
      false,
    );
  });

  it("a leftover door / popup / first-hour claim is a surface sit; npm test is not", () => {
    assert.equal(isSurfaceSit([item({ title: "Stay dock leftover", proof: "open leftover door" })]), true);
    assert.equal(isSurfaceSit([item({ title: "the first-hour popup", proof: "click the icon" })]), true);
    assert.equal(
      isSurfaceSit([item({ title: "Re-look glance tap so the well opens the garden", proof: "simctl launch" })]),
      true,
      "watch glance is a surface sit",
    );
    assert.equal(isSurfaceSit([item({ title: "ship the widget", proof: "npm test" })]), false);
    assert.equal(
      isSurfaceSit([
        item({
          title: "sit down at the title door",
          proof: "godot --path godot --headless --script res://scripts/smoke.gd",
        }),
      ]),
      false,
      "headless product smoke is a CLI proof, not a browser sit",
    );
  });
});

describe("architecture class tokens", () => {
  const continuePlan = (opts: { title?: string; item?: string; serves?: string; leave?: string }) =>
    parsePlanArtifact(
      `# Cycle 3 plan — ${opts.title ?? "theme"}\nVerdict: continue\nLooked: ran it\nConsidered:\n- rough edge: theme\n- leave it — ${opts.leave ?? "the tree runs; the theme is what a user meets first"}\nDirection: theme\nWorth the cycle: x\nItems:\n1. ${opts.item ?? "item"} — files: a.ts — serves: ${opts.serves ?? "first minute"} — red now: not there — proof: npm test\n${ONE_ITEM}\n`,
    );

  it("two shipped reviews sharing chew/Stay pile yield that class; a leave-it or item addresses it", () => {
    const a = ["`chew` and Stay still pile in one module"];
    const b = ["the chew/Stay pile grew another helper"];
    assert.ok(architectureClassTokens(a).includes("chew stay pile"));
    const cls = recurringArchitectureClass([
      { commitSha: "aaa", architecture: a },
      { commitSha: "bbb", architecture: b },
    ]);
    assert.equal(cls, "chew stay pile");
    const left = continuePlan({ leave: "the chew/Stay pile is next year's work" });
    assert.ok(left);
    assert.equal(planAddressesArchitectureClass(left, cls!), true);
    const item = continuePlan({ item: "collapse the chew/Stay pile" });
    assert.ok(item);
    assert.equal(planAddressesArchitectureClass(item, cls!), true);
    const serves = continuePlan({ serves: "the chew stay pile as one module" });
    assert.ok(serves);
    assert.equal(planAddressesArchitectureClass(serves, cls!), true);
    const titled = continuePlan({ title: "collapse the chew/Stay pile" });
    assert.ok(titled);
    assert.equal(planAddressesArchitectureClass(titled, cls!), false, "plan title is not addressing");
    const slice = continuePlan({});
    assert.ok(slice);
    assert.equal(planAddressesArchitectureClass(slice, cls!), false);
    const split = parsePlanArtifact(
      `# Cycle 3 plan — pause verbs\nVerdict: continue\nLooked: ran it\nConsidered:\n- leave it — keeps MEMORY's Steam promise broken\n- Extract the copied walk() in \`routing.test.ts\` / save.test.ts — leave that class\nDirection: pause\nWorth the cycle: x\nItems:\n1. keyboard pause — files: a.ts — serves: first minute — red now: click-only — proof: npm test\n${ONE_ITEM}\nOut of scope:\n- Copied walk() in \`routing.test.ts\` — named class, left\n`,
    );
    assert.ok(split);
    assert.equal(
      planAddressesArchitectureClass(split, "routing.test.ts"),
      true,
      "Out of scope that names the class addresses it",
    );
    const loose = parsePlanArtifact(
      `# Cycle 3 plan — pause verbs\nVerdict: continue\nLooked: ran it\nConsidered:\n- leave it — pin is Operator\n- Extract the copied walk() in \`routing.test.ts\` — messy, maybe later\nDirection: pause\nWorth the cycle: x\nItems:\n1. keyboard pause — files: a.ts — serves: first minute — red now: click-only — proof: npm test\n${ONE_ITEM}\nOut of scope:\n- Steamworks\n`,
    );
    assert.ok(loose);
    assert.equal(
      planAddressesArchitectureClass(loose, "routing.test.ts"),
      false,
      "leave-it on another bullet plus the class in a later Considered is not leaving that class",
    );
  });

  it("three shipped reviews naming the same class must collapse, not leave-it", () => {
    const note = ["HUD clip ate a required word"];
    const cycles = [
      { commitSha: "a", architecture: note, commitFiles: ["hud.ts"] },
      { commitSha: "b", architecture: ["other"] },
      { commitSha: "c", architecture: note, commitFiles: ["hud.ts"] },
      { commitSha: "d", architecture: note, commitFiles: ["hud.ts"] },
    ];
    const cls = recurringArchitectureClass(cycles);
    assert.ok(cls);
    assert.equal(architectureClassMustCollapse(cycles, cls!), true);
    const left = continuePlan({ leave: `${cls} is next year's work` });
    assert.ok(left);
    assert.equal(planAddressesArchitectureClass(left, cls!), true);
    assert.equal(planCollapsesArchitectureClass(left, cls!), false);
  });
});

describe("continueWorthHold", () => {
  const last = { worth: "no — a user would not notice", direction: "leftover sits with Murmur" };
  const planAt = (direction: string) =>
    parsePlanArtifact(MINIMAL().replace("Direction: first-run card", `Direction: ${direction}`));

  it("same Direction after Worth: no does not admit; different Direction does", () => {
    const same = planAt("leftover sits with Murmur");
    assert.ok(same);
    assert.match(continueWorthHold(last, same), /Direction matched the last Worth: no cycle/);
    const spaced = planAt("  Leftover   sits with MURMUR ");
    assert.ok(spaced);
    assert.match(continueWorthHold(last, spaced), /Worth:\s*no/);
    const other = planAt("a different door");
    assert.ok(other);
    assert.equal(continueWorthHold(last, other), "");
  });

  it("Worth: yes, missing Direction, or a non-continue plan do not hold", () => {
    const same = planAt("leftover sits with Murmur");
    assert.ok(same);
    assert.equal(continueWorthHold({ worth: "yes — the card shows", direction: last.direction }, same), "");
    assert.equal(continueWorthHold({ worth: "nope — not a no", direction: last.direction }, same), "");
    assert.equal(continueWorthHold({ worth: "no — invisible", direction: "" }, same), "");
    assert.equal(continueWorthHold(undefined, same), "");
    const fulfilled = parsePlanArtifact(`# Cycle 3 plan\nVerdict: fulfilled — the flag exists`);
    assert.ok(fulfilled);
    assert.equal(continueWorthHold(last, fulfilled), "");
  });

  it("Worth: **no** and a bolded Direction still hold", () => {
    assert.equal(worthIsNo("**no** — invisible"), true);
    assert.equal(worthIsNo("**yes** — the card shows"), false);
    const last = { worth: "**no** — invisible", direction: "**leftover sits with Murmur**" };
    const same = planAt("leftover sits with Murmur");
    assert.ok(same);
    assert.match(continueWorthHold(last, same), /Direction matched the last Worth: no cycle/);
    const boldPlan = planAt("**leftover sits with Murmur**");
    assert.ok(boldPlan);
    assert.match(continueWorthHold({ worth: "no — invisible", direction: "leftover sits with Murmur" }, boldPlan), /Direction matched/);
  });
});

describe("look infra vs could-not-look", () => {
  it("maxTurns and Godot crash are infra; a failed sitting is could-not-look", () => {
    assert.equal(lookInfraFailed("[Forge] maxTurns (15) reached — releasing."), true);
    assert.equal(lookInfraFailed("Godot quit unexpectedly after Vulkan init"), true);
    assert.equal(lookCouldNotLook("could not run — Playwright MCP never initialized"), true);
    assert.equal(lookCouldNotLook("opened popup.html and tapped Stay"), false);
    assert.equal(lookHasKernelEvidence("walk() tape + npm test 62/62"), true);
    assert.equal(lookHasKernelEvidence("npm test 62/62"), false, "the project gate is not a look");
    assert.equal(lookHasKernelEvidence("cargo test --offline"), false);
    assert.equal(lookHasKernelEvidence("opened leftover door"), false);
    assert.equal(
      lookHasKernelEvidence("Drove SE via simctl launch; screenshot Vision dropped"),
      false,
      "simctl without seen pixels is not kernel evidence",
    );
    assert.equal(lookInfraFailed("Playwright is down. Drove HID."), true);
    assert.equal(lookInfraFailed("screenshot Vision dropped — well/garden unread"), true);
    assert.equal(
      lookInfraFailed("[Forge: this provider dropped 2 image attachment(s) — Cursor has no multimodal parts.]"),
      true,
    );
  });

  it("look kind: AUTO/help are not a surface sit; leased Chrome is", () => {
    assert.equal(classifyLookKind("LOAD A CRATE. WATCH THE CHIPS."), "unknown");
    assert.equal(lookKindAllowsSurfaceCommit(classifyLookKind("LOAD A CRATE. WATCH THE CHIPS.")), false);
    assert.equal(classifyLookKind("cargo run -- --help (exit 0, no window)"), "cli-help");
    assert.equal(classifyLookKind("CHAIN_BENCH_AUTO=1 wrote chain-bench-idle.png"), "auto-still");
    assert.equal(
      classifyLookKind("Playwright MCP was down. Drove leased Chrome against http://127.0.0.1:5176"),
      "cdp-live",
    );
    assert.equal(
      lookKindAllowsSurfaceCommit(
        classifyLookKind("Playwright MCP was down. Drove leased Chrome against http://127.0.0.1:5176"),
      ),
      true,
    );
    assert.equal(classifyLookKind("look_native: wrote /tmp/x.png. Read that PNG"), "hid-window");
    assert.equal(
      classifyLookKind("look_native sim: wrote /tmp/x.png (simctl io booted screenshot)"),
      "sim-hid",
    );
    assert.equal(
      classifyLookKind("look_native movie: Godot --write-movie /tmp/look --quit-after 4"),
      "headless-smoke",
    );
    assert.equal(
      classifyLookKind("tried look_native; TCC -10004 privilege violation"),
      "failed",
      "naming the tool after a TCC deny is not a HID sit",
    );
    assert.equal(lookCouldNotLook("could not run; call_mcp failed"), true);
    assert.equal(classifyLookKind("could not run; call_mcp failed"), "failed");
  });

  it("MEMORY.md is not a must-collapse architecture class; a prior Collapse title retires the class", () => {
    const mem = recurringArchitectureClass([
      { commitSha: "a", architecture: ["`.forge/MEMORY.md` restamp"] },
      { commitSha: "b", architecture: ["`.forge/MEMORY.md` restamp"] },
      { commitSha: "c", architecture: ["`.forge/MEMORY.md` restamp"] },
    ]);
    assert.ok(mem);
    assert.equal(architectureClassMustCollapse([
      { commitSha: "a", architecture: ["`.forge/MEMORY.md` restamp"], title: "t" },
      { commitSha: "b", architecture: ["`.forge/MEMORY.md` restamp"], title: "t" },
      { commitSha: "c", architecture: ["`.forge/MEMORY.md` restamp"], title: "t" },
    ], mem!), false);
    const cls = "debug_drop_collect";
    assert.equal(
      architectureClassMustCollapse(
        [
          { commitSha: "a", architecture: ["`debug_drop_collect` leftover"], title: "loot" },
          { commitSha: "b", architecture: ["`debug_drop_collect` leftover"], title: "loot" },
          { commitSha: "c", architecture: ["`debug_drop_collect` leftover"], title: "Collapse `debug_drop_collect`" },
        ],
        cls,
      ),
      false,
    );
  });

  it("salvages a look without Worth: as blocked, not a blank stub", () => {
    const raw = `# Cycle 2 review
Verdict: ship — Task / Friend / Role toggle dump chrome
Looked: could not run — this pass did not host QQ华夏.app
Fulfillment:
- 任务 Main bar opens dump panel — done — WorldView loads WindowTable
Must-fix:
`;
    assert.equal(parseReviewArtifact(raw), null);
    const s = salvageIncompleteReview(raw);
    assert.ok(s);
    assert.equal(s.verdict, "blocked");
    assert.match(s.looked ?? "", /did not host/);
    assert.equal(s.fulfillment.length, 1);
    assert.match(s.mustFix.join(" "), /look preserved|Worth/);
    const blocked = formatBlockedReview(2, s);
    assert.match(blocked, /Verdict: blocked/);
    assert.match(blocked, /did not host/);
    assert.match(blocked, /WorldView loads WindowTable/);
  });

  it("an unknown promise whose evidence is a lease limit is stored as limited", () => {
    const s = parseScoutArtifact(
      `# Cycle 1 scout\nIdentity: a\nLooked: could not click\nPromises:\n- Wear the moth on the face — unknown — System Events -10004; CLKActive []\n- First climb — kept — walked it\n- Lantern tap — unknown — could not click the glass\nConsidered:\n- leave it — pin is Operator\n`,
    );
    assert.equal(s?.promises[0]?.state, "limited");
    assert.equal(s?.promises[1]?.state, "kept");
    assert.equal(s?.promises[2]?.state, "unknown", "could not click is not itself a lease limit");
  });
});

describe("review artifact parser", () => {
  it("parses verdict, looked, fulfillment states, revisions, must-fix, architecture, worth", () => {
    const r = parseReviewArtifact(REVIEW);
    assert.ok(r);
    assert.equal(r.verdict, "ship-with-revisions");
    assert.match(r.looked ?? "", /empty dir/);
    assert.equal(r.fulfillment.length, 3);
    assert.equal(r.fulfillment[0].state, "done");
    assert.equal(r.fulfillment[1].state, "partial");
    assert.match(r.fulfillment[1].note ?? "", /prints nothing/);
    assert.equal(r.fulfillment[2].state, "missing");
    assert.equal(r.revisions.length, 2);
    assert.deepEqual(r.mustFix, ["--version prints an empty line"]);
    assert.equal(r.architecture.length, 1);
    assert.match(r.worth ?? "", /^yes/);
    assert.deepEqual(r.operator, []);
  });

  it("a review without a verdict does not parse; Looked: is optional; Worth: yes|no is required", () => {
    assert.equal(parseReviewArtifact("looks fine to me"), null);
    assert.equal(parseReviewArtifact("looks fine to me\n**Goal achieved.**"), null);
    const r = parseReviewArtifact("Verdict: ship\nWorth: yes — the card shows");
    assert.equal(r?.verdict, "ship");
    assert.equal(r?.looked, undefined);
    assert.match(r?.worth ?? "", /^yes/);
    assert.match(explainReviewParseFailure("looks fine to me"), /no Verdict:/);
    assert.match(explainReviewParseFailure("Verdict: maybe"), /not ship/);
    assert.equal(parseReviewArtifact("Verdict: ship"), null);
    assert.match(explainReviewParseFailure("Verdict: ship"), /Worth:/);
    assert.equal(parseReviewArtifact("Verdict: ship\nWorth: maybe"), null);
    assert.match(explainReviewParseFailure("Verdict: ship\nWorth: maybe"), /Worth:/);
    assert.equal(explainReviewParseFailure("Verdict: ship\nWorth: yes"), "");
    const boldNo = parseReviewArtifact("Verdict: ship\nWorth: **no** — a one-word rename");
    assert.ok(boldNo);
    assert.match(boldNo.worth ?? "", /^no\b/i);
  });

  it("ship and blocked verdicts parse; the contract names the sections", () => {
    assert.equal(parseReviewArtifact("Verdict: ship\nWorth: yes")?.verdict, "ship");
    assert.equal(parseReviewArtifact("Verdict: **ship.**\nWorth: **yes.**")?.verdict, "ship");
    assert.equal(
      parseReviewArtifact("[Forge] maxTurns (80) reached — releasing.\n\n# Cycle 11 review\nVerdict: ship — both items landed\nWorth: yes — both items landed")?.verdict,
      "ship",
    );
    assert.equal(parseReviewArtifact("Verdict: blocked — secret missing\nWorth: no — cannot review")?.verdict, "blocked");
    const unapproved = `# Cycle 1 review\nVerdict: ship\nArchitecture:\n- two formatters, one sentence\nWorth: a user would notice the card`;
    assert.equal(parseReviewArtifact(unapproved), null, "Worth: is not yes|no — does not approve");
    const labels = readReviewRecordLabels(unapproved);
    assert.deepEqual(labels.architecture, ["two formatters, one sentence"]);
    assert.match(labels.worth ?? "", /user would notice/);
    const c = reviewArtifactContract(2);
    for (const label of ["Verdict:", "Looked:", "Fulfillment:", "Revisions:", "Must-fix:", "Architecture:", "Worth:"]) {
      assert.ok(c.includes(label), label);
    }
  });
});

describe("Plan complete token", () => {
  it("matches the declared closer in bold or plain, not prose about plans", () => {
    assert.ok(PLAN_COMPLETE_RE.test("**Plan complete.**"));
    assert.ok(PLAN_COMPLETE_RE.test("All three items shipped. Plan complete"));
    assert.equal(PLAN_COMPLETE_RE.test("the plan is complete in spirit"), false);
  });

  it("Operator: omit / none / n/a parse as no operator lines", () => {
    for (const word of ["omit", "none", "n/a", "omitted."]) {
      const plan = parsePlanArtifact(MINIMAL(`Operator: ${word}\n`));
      assert.deepEqual(plan?.operator, [], word);
    }
    const real = parsePlanArtifact(MINIMAL(`Operator: needs the STRIPE_KEY secret\n`));
    assert.deepEqual(real?.operator, ["needs the STRIPE_KEY secret"]);
  });
});

describe("extractSerendipityLines", () => {
  it("reads the same-line remainder, a bare label's bullets, bold labels and bulleted labels", () => {
    const text = [
      "Shipped the flag.",
      "**Serendipity:** the CSV export writes no header row",
      "Serendipity:",
      "- `--json` prints ANSI codes when piped",
      "* the README example is stale",
      "not a bullet — stops the block",
      "- Serendipity: config.toml is read twice",
      "Plan complete.",
    ].join("\n");
    assert.deepEqual(extractSerendipityLines(text), [
      "the CSV export writes no header row",
      "`--json` prints ANSI codes when piped",
      "the README example is stale",
      "config.toml is read twice",
    ]);
  });

  it("drops none / n-a, dedupes case-insensitively, clips and caps", () => {
    assert.deepEqual(extractSerendipityLines("Serendipity: none\nSerendipity: n/a\nSerendipity:\n- nothing"), []);
    assert.deepEqual(extractSerendipityLines("Serendipity: Same thing\nSerendipity: same thing"), ["Same thing"]);
    const long = `Serendipity: ${"x".repeat(400)}`;
    assert.equal(extractSerendipityLines(long)[0].length, 300);
    const many = Array.from({ length: 20 }, (_, i) => `Serendipity: item ${i}`).join("\n");
    assert.equal(extractSerendipityLines(many).length, 12);
    assert.deepEqual(extractSerendipityLines("no label here\nSerendipitous: not the token"), []);
  });
});

describe("extractDisputeLines", () => {
  it("is the same labelled-line reader on the Dispute: token, and the tokens do not bleed into each other", () => {
    const text = [
      "Dispute: the Reviewer deleted tests/x.test.ts as unable to fail — it fails on `git stash`; restored nothing, evidence: run log",
      "Serendipity: the README example is stale",
      "Dispute:",
      "- the 'dead flag' is read by the installer script",
    ].join("\n");
    assert.deepEqual(extractDisputeLines(text), [
      "the Reviewer deleted tests/x.test.ts as unable to fail — it fails on `git stash`; restored nothing, evidence: run log",
      "the 'dead flag' is read by the installer script",
    ]);
    assert.deepEqual(extractSerendipityLines(text), ["the README example is stale"]);
    assert.deepEqual(extractLabelledLines("Dispute: none", "Dispute"), []);
  });
});
