import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractSerendipityLines,
  parsePlanArtifact,
  parsePlanItemLine,
  parseReviewArtifact,
  planArtifactContract,
  reviewArtifactContract,
  PLAN_COMPLETE_RE,
} from "../src/harness/cycle/artifacts.js";

const PLAN = `
### Subagent result: cycle 1 planner
- status: completed

# Cycle 1 plan — Make the CLI usable on first run
Verdict: continue
Identity: Forge is a terminal coding agent for developers who want an autonomous loop with a real harness.
Direction: first-run polish — the CLI should orient a new user without docs.
Verify: \`npm test\`
Items:
1. Print a first-run card when no config exists — files: src/cli.ts, src/tui/banner.ts — proof: node dist/cli.js --help shows the card
2. Add --version — files: src/cli.ts — proof: npm test
- Fix the stale path in AGENTS.md | files: AGENTS.md | proof: npm run typecheck
Out of scope:
- Rewriting the provider layer (a different cycle)
Guidelines: fix: AGENTS.md names npm run lint which does not exist
Operator: none
`;

describe("plan artifact parser", () => {
  it("parses verdict, identity, direction, verify, items, out-of-scope, guidelines", () => {
    const p = parsePlanArtifact(PLAN);
    assert.ok(p);
    assert.equal(p.verdict, "continue");
    assert.equal(p.title, "Make the CLI usable on first run");
    assert.match(p.identity ?? "", /terminal coding agent/);
    assert.match(p.direction ?? "", /first-run polish/);
    assert.equal(p.verifyCommand, "npm test");
    assert.equal(p.items.length, 3);
    assert.equal(p.items[0].id, "i1");
    assert.deepEqual(p.items[0].files, ["src/cli.ts", "src/tui/banner.ts"]);
    assert.match(p.items[0].proof ?? "", /--help/);
    assert.deepEqual(p.items[2].files, ["AGENTS.md"]);
    assert.equal(p.items[2].proof, "npm run typecheck");
    assert.equal(p.outOfScope.length, 1);
    assert.match(p.guidelines ?? "", /^fix:/);
    assert.deepEqual(p.operator, []);
  });

  it("refuses prose under Verify: and reports it", () => {
    const p = parsePlanArtifact(
      `# Cycle 2 plan — x\nVerdict: continue\nVerify: the login flow works end to end\nItems:\n1. a thing`,
    );
    assert.ok(p);
    assert.equal(p.verifyCommand, undefined);
    assert.match(p.verifyRefused ?? "", /login flow/);
  });

  it("accepts Verify: none — why", () => {
    const p = parsePlanArtifact(
      `# Cycle 2 plan — x\nVerdict: continue\nVerify: none — this repo has no test runner yet\nItems:\n1. add one`,
    );
    assert.ok(p);
    assert.equal(p.verifyCommand, undefined);
    assert.match(p.verifyNone ?? "", /no test runner/);
  });

  it("fulfilled and blocked verdicts carry their note and need no items", () => {
    const f = parsePlanArtifact(`# Cycle 3 plan\nVerdict: fulfilled — the --version flag already exists and is tested`);
    assert.ok(f);
    assert.equal(f.verdict, "fulfilled");
    assert.match(f.verdictNote ?? "", /already exists/);
    const b = parsePlanArtifact(`# Cycle 3 plan\nVerdict: blocked — needs the STRIPE_KEY secret\nOperator: provide STRIPE_KEY`);
    assert.ok(b);
    assert.equal(b.verdict, "blocked");
    assert.deepEqual(b.operator, ["provide STRIPE_KEY"]);
  });

  it("a continue plan with no items does not parse", () => {
    assert.equal(parsePlanArtifact(`# Cycle 1 plan\nVerdict: continue\nItems:\n`), null);
    assert.equal(parsePlanArtifact(`just some prose with no labelled lines`), null);
  });

  it("item lines keep unlabelled trailing segments in the title", () => {
    const it1 = parsePlanItemLine("Wire the settle listener — so background checks count — files: src/agent/loop.ts", 0);
    assert.equal(it1.title, "Wire the settle listener — so background checks count");
    assert.deepEqual(it1.files, ["src/agent/loop.ts"]);
  });

  it("the contract text names every section the parser reads", () => {
    const c = planArtifactContract(4);
    for (const label of ["Verdict:", "Identity:", "Direction:", "Verify:", "Items:", "Out of scope:", "Guidelines:", "Operator:"]) {
      assert.ok(c.includes(label), label);
    }
    assert.ok(c.includes("# Cycle 4 plan"));
  });
});

const REVIEW = `
# Cycle 1 review
Verdict: ship-with-revisions — two items landed, one partial
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
Operator: none
`;

describe("review artifact parser", () => {
  it("parses verdict, fulfillment states, revisions, must-fix, architecture", () => {
    const r = parseReviewArtifact(REVIEW);
    assert.ok(r);
    assert.equal(r.verdict, "ship-with-revisions");
    assert.equal(r.fulfillment.length, 3);
    assert.equal(r.fulfillment[0].state, "done");
    assert.equal(r.fulfillment[1].state, "partial");
    assert.match(r.fulfillment[1].note ?? "", /prints nothing/);
    assert.equal(r.fulfillment[2].state, "missing");
    assert.equal(r.revisions.length, 2);
    assert.deepEqual(r.mustFix, ["--version prints an empty line"]);
    assert.equal(r.architecture.length, 1);
    assert.deepEqual(r.operator, []);
  });

  it("a review without a verdict does not parse", () => {
    assert.equal(parseReviewArtifact("looks fine to me"), null);
  });

  it("ship and blocked verdicts parse; the contract names the sections", () => {
    assert.equal(parseReviewArtifact("Verdict: ship")?.verdict, "ship");
    assert.equal(parseReviewArtifact("Verdict: blocked — secret missing")?.verdict, "blocked");
    const c = reviewArtifactContract(2);
    for (const label of ["Verdict:", "Fulfillment:", "Revisions:", "Must-fix:", "Architecture:"]) {
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
      const plan = parsePlanArtifact(
        `# Cycle 1 plan — x\nVerdict: continue\nVerify: npm test\nItems:\n1. a — files: a.ts — proof: npm test\nOperator: ${word}\n`,
      );
      assert.deepEqual(plan?.operator, [], word);
    }
    const real = parsePlanArtifact(
      `# Cycle 1 plan — x\nVerdict: continue\nVerify: npm test\nItems:\n1. a — files: a.ts — proof: npm test\nOperator: needs the STRIPE_KEY secret\n`,
    );
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
