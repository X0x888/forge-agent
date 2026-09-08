import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  explainPlanParseFailure,
  extractDisputeLines,
  extractLabelledLines,
  extractSerendipityLines,
  parsePlanArtifact,
  parsePlanItemLine,
  parseReviewArtifact,
  parseScoutArtifact,
  planArtifactContract,
  reviewArtifactContract,
  scoutArtifactContract,
  PLAN_COMPLETE_RE,
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

/** The smallest continue plan the parser accepts. */
const MINIMAL = (extra = "") =>
  `# Cycle 2 plan — x\nVerdict: continue\n${CONSIDERED}\nVerify: npm test\nItems:\n1. ${ITEM("a thing", "a.ts", "npm test")}\n${extra}`;

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
      `# Cycle 2 plan — x\nVerdict: continue\n${CONSIDERED}\nVerify: the login flow works end to end\nItems:\n1. ${ITEM("a thing", "a.ts", "npm test")}`,
    );
    assert.ok(p);
    assert.equal(p.verifyCommand, undefined);
    assert.match(p.verifyRefused ?? "", /login flow/);
  });

  it("accepts Verify: none — why", () => {
    const p = parsePlanArtifact(
      `# Cycle 2 plan — x\nVerdict: continue\n${CONSIDERED}\nVerify: none — this repo has no test runner yet\nItems:\n1. ${ITEM("add one", "a.ts", "npm test")}`,
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
    const bold = `# Cycle 1 plan\nVerdict: continue\nConsidered:\n- rough edge: x — y\n- **leave it** — fine as is\nVerify: npm test\nItems:\n1. ${ITEM("a", "a.ts", "npm test")}`;
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
    const unchecked = `# Cycle 1 plan\nVerdict: continue\n${CONSIDERED}\nVerify: npm test\nItems:\n1. a thing — files: a.ts — serves: the job — red now: unchecked, needs a browser — proof: npm test`;
    assert.ok(parsePlanArtifact(unchecked));
  });

  it("explainPlanParseFailure lists every defect and says so when the plan is fine", () => {
    assert.match(explainPlanParseFailure("no labelled lines at all"), /Verdict:/);
    assert.match(explainPlanParseFailure(`Verdict: continue\nItems:\n`), /empty Items:/);
    assert.equal(explainPlanParseFailure(MINIMAL()), "");
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
    assert.deepEqual(parseScoutArtifact(promises)?.promises, expected);
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
    for (const label of ["# Cycle 3 scout", "Identity:", "Looked:", "Promises:", "kept | broken | absent", "Considered:", "leave it"]) {
      assert.ok(c.includes(label), label);
    }
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

  it("a review without a verdict does not parse; Looked: is optional", () => {
    assert.equal(parseReviewArtifact("looks fine to me"), null);
    const r = parseReviewArtifact("Verdict: ship");
    assert.equal(r?.verdict, "ship");
    assert.equal(r?.looked, undefined);
  });

  it("ship and blocked verdicts parse; the contract names the sections", () => {
    assert.equal(parseReviewArtifact("Verdict: ship")?.verdict, "ship");
    assert.equal(parseReviewArtifact("Verdict: blocked — secret missing")?.verdict, "blocked");
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
