import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  roleBody,
  roleTokens,
  runRoleTwoTurn,
  runRoleTurnAgain,
  twoTurnEnabled,
  plannerPlanTurns,
  reviewerLookTurns,
} from "../src/harness/cycle/roles.js";
import type { CycleRole, CycleRuntime, RoleRunOptions, RoleRunResult } from "../src/harness/cycle/orchestrator.js";

interface Call {
  role: CycleRole;
  brief: string;
  opts: RoleRunOptions;
}

/** A runtime that records every role call and answers from a script. */
function fakeRt(script: Array<Partial<RoleRunResult> | Error>, o: { keepsSessions?: boolean } = {}) {
  const calls: Call[] = [];
  const cleaned: string[] = [];
  let n = 0;
  const rt = {
    workspace: "/w",
    async runRole(role: CycleRole, brief: string, opts: RoleRunOptions): Promise<RoleRunResult> {
      calls.push({ role, brief, opts });
      const next = script.shift();
      if (next instanceof Error) throw next;
      n += 1;
      const base: RoleRunResult = {
        ok: true,
        text: `doc ${n}`,
        status: "completed",
        promptTokens: 10,
        completionTokens: 5,
        editCount: 0,
        ...(o.keepsSessions !== false && opts.keepSession ? { sessionId: opts.resumeSessionId ?? `sess-${n}` } : {}),
      };
      return { ...base, ...(next ?? {}) };
    },
    async cleanupRoleSession(id: string) {
      cleaned.push(id);
    },
  } as unknown as CycleRuntime;
  return { rt, calls, cleaned };
}

const opts = {
  cycle: 3,
  firstBrief: "SCOUT BRIEF",
  secondBrief: (first: string) => `PLAN BRIEF <<${first}>>`,
  singleBrief: (first: string) => `SINGLE BRIEF <<${first}>>`,
  firstMaxTurns: 40,
  secondMaxTurns: 12,
};

describe("two-turn role runner", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.FORGE_ULW_TWO_TURN;
    delete process.env.FORGE_ULW_TWO_TURN;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.FORGE_ULW_TWO_TURN;
    else process.env.FORGE_ULW_TWO_TURN = prev;
  });

  it("turn 1 keeps the session, turn 2 resumes it with turn 1's document in its brief", async () => {
    const { rt, calls, cleaned } = fakeRt([{ text: "### Subagent result\n- status: completed\n\n# Cycle 3 scout\nLooked: ran it" }, { text: "# Cycle 3 plan\nVerdict: fulfilled" }]);
    const r = await runRoleTwoTurn(rt, "planner", opts);
    assert.equal(r.mode, "two-turn");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].brief, "SCOUT BRIEF");
    assert.deepEqual(calls[0].opts, { cycle: 3, keepSession: true, maxTurns: 40 });
    assert.equal(calls[1].opts.resumeSessionId, "sess-1", "turn 2 resumes turn 1's session");
    assert.equal(calls[1].opts.keepSession, true, "kept for a possible retry; the caller cleans up");
    assert.equal(calls[1].opts.maxTurns, 12);
    assert.equal(calls[1].brief, "PLAN BRIEF <<# Cycle 3 scout\nLooked: ran it>>", "the header is stripped, the document is handed back");
    assert.equal(r.sessionId, "sess-1");
    assert.equal(r.second.text, "# Cycle 3 plan\nVerdict: fulfilled");
    assert.deepEqual(cleaned, [], "the runner never cleans up — the caller may still retry");
  });

  it("secondDocumentOnly makes turn 2 report-only so the writing turn cannot re-enter exploration", async () => {
    const { rt, calls } = fakeRt([{ text: "# Cycle 3 scout\nLooked: x" }, { text: "# Cycle 3 plan\nVerdict: fulfilled" }]);
    await runRoleTwoTurn(rt, "planner", { ...opts, secondDocumentOnly: true });
    assert.equal(calls[1].opts.documentOnly, true, "the plan turn is document-only");
    assert.notEqual(calls[0].opts.documentOnly, true, "the scout turn still explores");
  });

  it("skipSecondIf admits a scout that is already the plan", async () => {
    const scout = "# Cycle 3 scout\nVerdict: continue\nLooked: x";
    const { rt, calls } = fakeRt([{ text: scout }]);
    const r = await runRoleTwoTurn(rt, "planner", {
      ...opts,
      skipSecondIf: (t) => /Verdict:\s*continue/.test(t),
    });
    assert.equal(calls.length, 1);
    assert.equal(r.second.text, scout);
    assert.equal(r.mode, "two-turn");
  });

  it("a runtime that does not keep sessions gets one more call with the single brief and turn 1's text", async () => {
    const { rt, calls } = fakeRt([{ text: "# Cycle 3 scout\nLooked: x" }, {}], { keepsSessions: false });
    const r = await runRoleTwoTurn(rt, "planner", opts);
    assert.equal(r.mode, "single");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].brief, "SINGLE BRIEF <<# Cycle 3 scout\nLooked: x>>");
    assert.deepEqual(calls[1].opts, { cycle: 3 });
    assert.equal(r.sessionId, undefined);
  });

  it("FORGE_ULW_TWO_TURN=0 makes exactly one call with the single brief", async () => {
    process.env.FORGE_ULW_TWO_TURN = "0";
    assert.equal(twoTurnEnabled(), false);
    const { rt, calls } = fakeRt([{}]);
    const r = await runRoleTwoTurn(rt, "reviewer", opts);
    assert.equal(r.mode, "single");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].brief, "SINGLE BRIEF <<>>");
    assert.deepEqual(calls[0].opts, { cycle: 3 });
    assert.equal(r.first, undefined);
  });

  it("a resume that fails before a word falls back to a fresh single run and never throws", async () => {
    const { rt, calls, cleaned } = fakeRt([
      { text: "# Cycle 3 scout\nLooked: y" },
      { ok: false, text: "", status: "error", error: "spawn_subagent error: resume_session_id not found" },
      { text: "# Cycle 3 plan\nVerdict: fulfilled" },
    ]);
    const r = await runRoleTwoTurn(rt, "planner", opts);
    assert.equal(r.mode, "single");
    assert.equal(calls.length, 3);
    assert.equal(calls[2].brief, "SINGLE BRIEF <<# Cycle 3 scout\nLooked: y>>");
    assert.equal(r.sessionId, "sess-1", "caller persists roles.jsonl then wipes");
    assert.deepEqual(cleaned, [], "the runner never cleans up — the caller persists then wipes");
    assert.equal(r.second.text, "# Cycle 3 plan\nVerdict: fulfilled");
  });

  it("a runtime that throws on turn 1 is a failed first turn, and the single brief still runs", async () => {
    const { rt, calls } = fakeRt([new Error("provider down"), { text: "# Cycle 3 plan\nVerdict: fulfilled" }]);
    const r = await runRoleTwoTurn(rt, "planner", opts);
    assert.equal(r.mode, "single");
    assert.equal(calls.length, 2);
    assert.equal(r.first?.ok, false);
    assert.match(r.first?.error ?? "", /provider down/);
    assert.equal(calls[1].brief, "SINGLE BRIEF <<>>");
  });

  it("runRoleTurnAgain re-enters the kept session for one more document turn", async () => {
    const { rt, calls } = fakeRt([{}]);
    await runRoleTurnAgain(rt, "planner", "sess-9", "[Forge] again", { cycle: 3, maxTurns: 12 });
    assert.deepEqual(calls[0].opts, { cycle: 3, resumeSessionId: "sess-9", keepSession: true, maxTurns: 12 });
    assert.equal(calls[0].brief, "[Forge] again");
  });

  it("roleBody strips the subagent header ahead of any of the four documents", () => {
    assert.equal(roleBody("### Subagent result: x\n- status: completed\n\n# Cycle 2 scout\nIdentity: a"), "# Cycle 2 scout\nIdentity: a");
    assert.equal(roleBody("header\n# Cycle 2 look\nLooked: b"), "# Cycle 2 look\nLooked: b");
    assert.equal(roleBody("header\nLooked: bare"), "Looked: bare");
    assert.equal(roleBody("# Cycle 1 plan\nVerdict: continue"), "# Cycle 1 plan\nVerdict: continue");
    assert.equal(roleBody("no document here"), "no document here");
  });

  it("roleTokens: a resumed turn reports the session's cumulative usage, so two turns are the max, a fallback the sum", () => {
    const run = (p: number, c: number): RoleRunResult => ({ ok: true, text: "", status: "completed", promptTokens: p, completionTokens: c, editCount: 0 });
    // turn 1 spent 1,000; turn 2's figure already includes it.
    assert.equal(roleTokens({ mode: "two-turn", first: run(800, 200), second: run(1_500, 300), sessionId: "s" }), 1_800);
    // a retry on the same session: still cumulative.
    assert.equal(roleTokens({ mode: "two-turn", first: run(800, 200), second: run(1_500, 300), sessionId: "s" }, run(2_000, 400)), 2_400);
    // single mode after a kept-less turn 1: two sessions, two bills.
    assert.equal(roleTokens({ mode: "single", first: run(800, 200), second: run(500, 100) }), 1_600);
    assert.equal(roleTokens({ mode: "single", first: run(800, 200), second: run(500, 100) }, run(50, 10)), 1_660);
    // FORGE_ULW_TWO_TURN=0: one run.
    assert.equal(roleTokens({ mode: "single", second: run(500, 100) }), 600);
  });

  it("turn budgets default and read their env", () => {
    delete process.env.FORGE_ULW_PLANNER_PLAN_TURNS;
    delete process.env.FORGE_ULW_REVIEWER_LOOK_TURNS;
    assert.equal(plannerPlanTurns(), 12);
    assert.equal(reviewerLookTurns(), 25);
    process.env.FORGE_ULW_PLANNER_PLAN_TURNS = "20";
    process.env.FORGE_ULW_REVIEWER_LOOK_TURNS = "7";
    try {
      assert.equal(plannerPlanTurns(), 20);
      assert.equal(reviewerLookTurns(), 7);
    } finally {
      delete process.env.FORGE_ULW_PLANNER_PLAN_TURNS;
      delete process.env.FORGE_ULW_REVIEWER_LOOK_TURNS;
    }
  });
});
