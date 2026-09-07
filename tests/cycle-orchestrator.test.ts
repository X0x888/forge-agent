import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateCycleAtStop,
  ensureCyclePlanned,
  resolveVerifyCommand,
  loadCycleState,
  requestReplan,
  setCycleFlag,
  setMaxCycles,
  cycleArtifactsDir,
  type CycleRuntime,
  type CycleRole,
  type CyclePlanItem,
} from "../src/harness/cycle/index.js";
import type { StopFacts } from "../src/harness/cycle/machine.js";
import { armWithPlan, mkGitRepo } from "./helpers/cycle-arm.js";

const PLAN_OK = (n: number, items = 2) =>
  `# Cycle ${n} plan — theme ${n}\nVerdict: continue\nIdentity: a CLI for tests\nDirection: theme ${n}\nVerify: \`npm test\`\nItems:\n${Array.from(
    { length: items },
    (_, i) => `${i + 1}. item ${n}.${i + 1} — files: src/f${i}.ts — proof: npm test`,
  ).join("\n")}\nOut of scope:\n- nothing`;
const PLAN_FULFILLED = `# Cycle 2 plan\nVerdict: fulfilled — the widget exists and is tested`;
const REVIEW_OK = `# Cycle 1 review\nVerdict: ship\nFulfillment:\n- item — done\nRevisions:\n- none\nMust-fix:\n- none`;
const REVIEW_MUSTFIX = `# Cycle 1 review\nVerdict: ship-with-revisions\nMust-fix:\n- the flag prints nothing`;

interface FakeOpts {
  planner?: string[];
  reviewer?: string[];
  checkPasses?: boolean[];
  /** Failing test names per red run (consumed in order). */
  checkFailures?: string[][];
  commitOk?: boolean;
}

function fakeRuntime(cwd: string, o: FakeOpts = {}) {
  const calls: string[] = [];
  const todos: Array<{ id: string; status: string }> = [];
  const admitted: string[] = [];
  const planner = [...(o.planner ?? [])];
  const reviewer = [...(o.reviewer ?? [])];
  const checks = [...(o.checkPasses ?? [])];
  let commits = 0;
  const rt: CycleRuntime = {
    workspace: cwd,
    async runRole(role: CycleRole) {
      calls.push(`role:${role}`);
      const text = role === "planner" ? planner.shift() : reviewer.shift();
      return {
        ok: Boolean(text),
        text: text ?? "",
        status: text ? "completed" : "error",
        promptTokens: 10,
        completionTokens: 5,
        editCount: role === "reviewer" ? 1 : 0,
        error: text ? undefined : `no ${role} script`,
      };
    },
    async runCheck(command) {
      calls.push(`check:${command}`);
      const passed = checks.length ? Boolean(checks.shift()) : true;
      const failures = passed ? [] : o.checkFailures?.shift() ?? ["✖ the flag"];
      const output = passed ? "ok" : `${failures.join("\n")}\nℹ fail ${failures.length}`;
      return {
        command,
        exitCode: passed ? 0 : 1,
        output,
        tail: output,
        timedOut: false,
        ms: 5,
        cls: { ran: true, passed, isolate: false, fullSuite: passed },
        failures: failures.map((f) => f.replace(/^✖ /, "")),
      };
    },
    creditCheck(_run, passed) {
      calls.push(`credit:${passed ? "pass" : "fail"}`);
    },
    commit({ subject }) {
      calls.push(`commit:${subject}`);
      if (o.commitOk === false) return { committed: false, skipped: "working tree clean" };
      commits += 1;
      return { committed: true, sha: `abc${commits}`, subject, files: 1 };
    },
    seedTodos(items: CyclePlanItem[]) {
      calls.push(`todos:${items.length}`);
      todos.splice(0, todos.length, ...items.map((i) => ({ id: i.id, status: "pending" })));
    },
    todos: () => todos,
    admit: (t) => {
      admitted.push(t);
    },
    gitHead: () => "0".repeat(40),
    gitDiffSince: () => ({ diff: "+x", files: ["src/f0.ts"], truncated: false }),
    gitLogSince: () => "",
    gitStatus: () => "clean",
    userMessagesSince: () => [],
    guidelineSurvey: () => "AGENTS.md fresh",
    projectChecks: () => ["npm test"],
  };
  return { rt, calls, todos, admitted };
}

const facts = (o: Partial<StopFacts> = {}): StopFacts => ({
  editCount: 5,
  openTodoCount: 0,
  lastAssistantMessage: "Plan complete.",
  diffFingerprint: "fp",
  verificationRan: true,
  verificationPassed: true,
  verificationFullSuite: true,
  stuckThreshold: 3,
  ...o,
});

describe("cycle orchestrator", () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-orch-home-"));
    process.env.FORGE_HOME = home;
    process.env.FORGE_ULW_AUTO_COMMIT = "1";
    cwd = mkGitRepo();
  });

  it("turn start: the Planner writes cycle 1, items seed the board, the plan is admitted", async () => {
    const sid = "orch-plan";
    const { rt, calls, todos } = fakeRuntime(cwd, { planner: [PLAN_OK(1, 3)] });
    // arm without a plan
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: "add a widget", cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.ok(out);
    assert.equal(out.released, false);
    assert.equal(out.planAdmitted, true);
    assert.match(out.reanchor ?? "", /Cycle 1 plan — theme 1/);
    assert.match(out.reanchor ?? "", /Plan complete/);
    const s = loadCycleState(sid)!;
    assert.equal(s.phase, "execute");
    assert.equal(s.cycle, 1);
    assert.equal(s.items.length, 3);
    assert.equal(s.verifyCommand, "npm test");
    assert.equal(s.identity, "a CLI for tests");
    assert.equal(todos.length, 3);
    assert.deepEqual(calls, ["role:planner", "todos:3", "check:npm test", "credit:pass"], "the baseline runs once at cycle 1");
    assert.deepEqual(s.verifyBaseline?.failures, []);
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 1), "plan.md")));
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 1), "verify.baseline.log")));
    // second call is a no-op: the plan is on disk
    assert.equal(await ensureCyclePlanned(sid, rt), null);
  });

  it("a fulfilled first plan releases the run (case a already met)", async () => {
    const sid = "orch-fulfilled";
    const { rt } = fakeRuntime(cwd, { planner: [PLAN_FULFILLED] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: "add --version", cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.ok(out?.released);
    assert.equal(out.endReason, "fulfilled");
    assert.equal(loadCycleState(sid)!.enabled, false);
  });

  it("EXECUTE Stop with open items re-anchors; 'Plan complete.' runs verify → review → verify → commit → next plan", async () => {
    const sid = "orch-full";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "ship" }] });
    const { rt, calls } = fakeRuntime(cwd, { planner: [PLAN_OK(2)], reviewer: [REVIEW_OK] });
    const r1 = await evaluateCycleAtStop(sid, {
      runtime: rt,
      facts: facts({ openTodoCount: 1, lastAssistantMessage: "working on it" }),
    });
    assert.ok(r1);
    assert.equal(r1.allowStop, false);
    assert.equal(r1.waveStamped, true);
    assert.match(r1.reanchor ?? "", /1 plan item\(s\) still open/);
    const r2 = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.ok(r2);
    assert.equal(r2.allowStop, false);
    assert.equal(r2.cycleClosed, true);
    assert.equal(r2.committed?.sha, "abc1");
    assert.equal(r2.planAdmitted, true);
    assert.match(r2.reanchor ?? "", /Cycle 2 plan — theme 2/);
    assert.deepEqual(calls, [
      "check:npm test",
      "credit:pass",
      "role:reviewer",
      "check:npm test",
      "credit:pass",
      "commit:ulw cycle 1: test plan",
      "role:planner",
      "todos:2",
    ]);
    const s = loadCycleState(sid)!;
    assert.equal(s.cycle, 2);
    assert.equal(s.phase, "execute");
    assert.equal(s.cycles[0].commitSha, "abc1");
    assert.equal(s.cycles[0].reviewVerdict, "ship");
    assert.equal(s.cycles[0].verifyPassed, true);
    assert.equal(s.verifyBaseline?.command, "npm test", "the accepted run is the next baseline");
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 1), "review.md")));
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 1), "verify.pre-review.log")));
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 1), "verify.post-review.log")));
  });

  it("/cycle 0 finishes the open cycle (verify, review, verify, commit) and then releases", async () => {
    const sid = "orch-cycle0";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    assert.equal(setCycleFlag(sid, 0).ok, true);
    const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_OK(2)] });
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.ok(r?.released);
    assert.equal(r.endReason, "cycle-zero");
    assert.equal(r.committed?.sha, "abc1");
    assert.ok(!calls.includes("role:planner"), "no re-plan after /cycle 0");
  });

  it("max_cycles releases after the capped cycle commits", async () => {
    const sid = "orch-cap";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", maxCycles: 1 });
    assert.equal(setMaxCycles(sid, 1).ok, true);
    const { rt } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_OK(2)] });
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.ok(r?.released);
    assert.equal(r.endReason, "max-cycles");
  });

  it("red verify before review → FIX re-anchor names the new failure; green on the next Stop reviews, verifies, commits", async () => {
    const sid = "orch-red";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt, calls } = fakeRuntime(cwd, {
      reviewer: [REVIEW_MUSTFIX],
      checkPasses: [false, true, true],
      planner: [PLAN_FULFILLED],
    });
    const r1 = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.ok(r1);
    assert.equal(r1.allowStop, false);
    assert.equal(r1.phase, "fix");
    assert.match(r1.reanchor ?? "", /before review: `npm test` is RED \(fix round 1\/3\)/);
    assert.match(r1.reanchor ?? "", /New failures \(yours to fix\): `the flag`/);
    assert.match(r1.reanchor ?? "", /fail 1/);
    assert.ok(!calls.includes("role:reviewer"), "the reviewer waits for a tree that passes the gate");
    assert.ok(!calls.some((c) => c.startsWith("commit:")), "no commit on red");
    const r2 = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts({ lastAssistantMessage: "fixed" }) });
    assert.ok(r2);
    assert.equal(r2.committed?.sha, "abc1");
    assert.equal(r2.released, true, "planner said fulfilled after the commit");
    assert.equal(calls.filter((c) => c === "role:reviewer").length, 1, "reviewer runs once per cycle");
    assert.equal(calls.filter((c) => c.startsWith("check:")).length, 3, "pre-review red, pre-review green, post-review green");
  });

  it("a red run after the Reviewer's revisions goes back to the executor once, then commits without a second review", async () => {
    const sid = "orch-red-post";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt, calls } = fakeRuntime(cwd, {
      reviewer: [REVIEW_MUSTFIX],
      checkPasses: [true, false, true],
      planner: [PLAN_FULFILLED],
    });
    const r1 = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(r1?.phase, "fix");
    assert.match(r1?.reanchor ?? "", /after review: `npm test` is RED/);
    assert.match(r1?.reanchor ?? "", /Reviewer must-fix: the flag prints nothing/);
    const r2 = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts({ lastAssistantMessage: "fixed" }) });
    assert.equal(r2?.committed?.sha, "abc1");
    assert.equal(calls.filter((c) => c === "role:reviewer").length, 1);
  });

  it("pre-existing failures do not count: a red run whose failures are all in the baseline is green", async () => {
    const sid = "orch-baseline";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "ship" }] });
    const { rt, calls } = fakeRuntime(cwd, {
      reviewer: [REVIEW_OK],
      planner: [PLAN_FULFILLED],
      // pre-review: the two old failures plus a new one → red; the fix leaves the two old ones → green vs baseline
      checkPasses: [false, false, false],
      checkFailures: [["✖ renders colour", "✖ hud width", "✖ my new test"], ["✖ renders colour", "✖ hud width"], ["✖ hud width"]],
    });
    const st = loadCycleState(sid)!;
    st.verifyBaseline = { command: "npm test", exitCode: 1, failures: ["renders colour", "hud width"], at: "t" };
    const { saveCycleState } = await import("../src/harness/cycle/state.js");
    saveCycleState(st);
    const r1 = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(r1?.phase, "fix");
    assert.match(r1?.reanchor ?? "", /New failures \(yours to fix\): `my new test`/);
    assert.match(r1?.reanchor ?? "", /2 failure\(s\) were already failing before this cycle and do not count/);
    assert.doesNotMatch(r1?.reanchor ?? "", /yours to fix\).*renders colour/);
    const r2 = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts({ lastAssistantMessage: "fixed" }) });
    assert.equal(r2?.committed?.sha, "abc1", "green vs baseline commits");
    const s = loadCycleState(sid)!;
    assert.equal(s.cycles[0].verifyPassed, true);
    assert.equal(s.cycles[0].verifyInherited, 1, "the post-review run had one inherited failure left");
    assert.deepEqual(s.verifyBaseline?.failures, ["hud width"], "the accepted set shrinks to what is still failing");
    assert.equal(calls.filter((c) => c === "role:reviewer").length, 1);
    assert.deepEqual(
      calls.filter((c) => c.startsWith("credit:")),
      ["credit:fail", "credit:pass", "credit:pass"],
      "run-level verification counts the gate's verdict, not the exit code",
    );
  });

  it("a red run that names no failing test is red whatever the baseline says", async () => {
    const sid = "orch-opaque";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], checkPasses: [false], checkFailures: [[]] });
    const st = loadCycleState(sid)!;
    st.verifyBaseline = { command: "npm test", exitCode: 1, failures: ["renders colour"], at: "t" };
    const { saveCycleState } = await import("../src/harness/cycle/state.js");
    saveCycleState(st);
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(r?.phase, "fix");
    assert.match(r?.reason ?? "", /no failing tests named/);
  });

  it("a Reviewer `blocked` verdict closes the cycle without a commit and the next plan starts from it", async () => {
    const sid = "orch-blocked";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "the flag" }] });
    let brief = "";
    const base = fakeRuntime(cwd, {
      reviewer: [`# Cycle 1 review\nVerdict: blocked — the flag deletes user data\nMust-fix:\n- do not delete\n`],
      planner: [PLAN_OK(2)],
    });
    const rt: CycleRuntime = {
      ...base.rt,
      async runRole(role, b) {
        if (role === "planner") brief = b;
        return base.rt.runRole(role, b, { cycle: 0 });
      },
    };
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(r?.cycleClosed, true);
    assert.equal(r?.committed?.sha, undefined);
    assert.equal(r?.committed?.skipped, "review blocked");
    assert.equal(r?.planAdmitted, true);
    assert.ok(!base.calls.some((c) => c.startsWith("commit:")), "blocked never commits");
    assert.deepEqual(base.calls.slice(0, 3), ["check:npm test", "credit:pass", "role:reviewer"]);
    assert.equal(loadCycleState(sid)!.cycles[0].reviewVerdict, "blocked");
    assert.match(brief, /do not delete/);
  });

  it("an unparseable review fails closed: blocked, no commit", async () => {
    const sid = "orch-review-noparse";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt, calls } = fakeRuntime(cwd, { reviewer: ["looks fine to me"], planner: [PLAN_FULFILLED] });
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(r?.committed?.skipped, "review blocked");
    assert.ok(!calls.some((c) => c.startsWith("commit:")));
    assert.equal(loadCycleState(sid)!.cycles[0].reviewVerdict, "blocked");
  });

  it("fix rounds past the cap release with fix-cap and nothing committed", async () => {
    const sid = "orch-fixcap";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], checkPasses: [false, false, false] });
    let r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts(), fixRoundsCap: 2 });
    assert.equal(r?.phase, "fix");
    r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts(), fixRoundsCap: 2 });
    assert.equal(r?.phase, "fix");
    r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts(), fixRoundsCap: 2 });
    assert.ok(r?.released);
    assert.equal(r.endReason, "fix-cap");
    assert.match(r.reason, /Operator:/);
    assert.ok(!calls.some((c) => c.startsWith("commit:")));
  });

  it("stuck in EXECUTE routes to the Reviewer instead of releasing", async () => {
    const sid = "orch-stuck";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_FULFILLED] });
    const still = facts({ editCount: 0, openTodoCount: 1, lastAssistantMessage: "hmm", diffFingerprint: "same" });
    for (let i = 0; i < 3; i++) {
      const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: still });
      assert.equal(r?.allowStop, false);
    }
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: still });
    assert.ok(r);
    assert.ok(calls.includes("role:reviewer"));
    assert.equal(r.released, true);
    assert.equal(r.endReason, "fulfilled");
  });

  it("/replan closes the cycle at the next Stop and re-plans", async () => {
    const sid = "orch-replan";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    assert.equal(requestReplan(sid).ok, true);
    const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_OK(2)] });
    const r = await evaluateCycleAtStop(sid, {
      runtime: rt,
      facts: facts({ openTodoCount: 1, lastAssistantMessage: "half way" }),
    });
    assert.equal(r?.planAdmitted, true);
    assert.deepEqual(calls.slice(0, 4), ["check:npm test", "credit:pass", "role:reviewer", "check:npm test"]);
  });

  it("the Reviewer's must-fix and unfulfilled items reach the next Planner brief", async () => {
    const sid = "orch-brief";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "the flag" }] });
    let brief = "";
    const base = fakeRuntime(cwd, { reviewer: [REVIEW_MUSTFIX], planner: [PLAN_OK(2)] });
    const rt: CycleRuntime = {
      ...base.rt,
      async runRole(role, b) {
        if (role === "planner") brief = b;
        return base.rt.runRole(role, b, { cycle: 0 });
      },
    };
    await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.match(brief, /Must-fix left by the last review/);
    assert.match(brief, /the flag prints nothing/);
    assert.match(brief, /## Mandate\nadd a widget/);
  });

  it("the Planner brief is a ledger of what shipped, not the last plan's body: direction, verdict, worth — never Out of scope", async () => {
    const sid = "orch-ledger";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "the flag" }] });
    // Give the armed plan a direction + out-of-scope list as a real plan.md would carry.
    const st = loadCycleState(sid)!;
    const rec = st.cycles[st.cycles.length - 1];
    rec.direction = "Sit leftover sits with Murmur";
    rec.looked = "ran the popup";
    rec.planPath = path.join(cycleArtifactsDir(sid, 1), "plan.md");
    fs.mkdirSync(path.dirname(rec.planPath), { recursive: true });
    const { saveCycleState } = await import("../src/harness/cycle/state.js");
    saveCycleState(st);
    fs.writeFileSync(
      rec.planPath,
      "# Cycle 1 plan — x\nVerdict: continue\nDirection: Sit leftover sits with Murmur\nVerify: npm test\nItems:\n1. the flag — files: a.ts — proof: npm test\nOut of scope:\n- Day-0 hunt `Nexus ate Philosophy.` — the next rename\n",
    );
    let brief = "";
    const base = fakeRuntime(cwd, {
      reviewer: [
        `# Cycle 1 review\nVerdict: ship\nFulfillment:\n- the flag — done\nMust-fix:\n- none\nArchitecture:\n- two formatters, one sentence\nWorth: no — a one-word rename no user would notice\n`,
      ],
      planner: [PLAN_FULFILLED],
    });
    const rt: CycleRuntime = {
      ...base.rt,
      async runRole(role, b) {
        if (role === "planner") brief = b;
        return base.rt.runRole(role, b, { cycle: 0 });
      },
    };
    await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.match(brief, /## What this run has shipped \(a record, not a thread/);
    assert.match(brief, /cycle 1 — test plan · Sit leftover sits with Murmur · review: ship · worth: no — a one-word rename/);
    assert.match(brief, /## The last Reviewer's shape notes\n- two formatters, one sentence/);
    assert.match(brief, /## The last Reviewer judged the last cycle not worth a cycle/);
    assert.match(brief, /Plan work a user will notice, or write Verdict: fulfilled/);
    assert.doesNotMatch(brief, /Prior plan/);
    assert.doesNotMatch(brief, /Nexus ate Philosophy/, "the previous author's Out-of-scope backlog is not handed on");
    assert.doesNotMatch(brief, /### Cycle 1 plan/);
    assert.match(brief, /2\. Use it\. Before you read a line of source/);
    assert.match(brief, /8\. Leave it\./);
    const s = loadCycleState(sid)!;
    assert.equal(s.cycles[0].worth, "no — a one-word rename no user would notice");
    assert.deepEqual(s.cycles[0].architecture, ["two formatters, one sentence"]);
  });

  it("the Reviewer brief carries the recent cycles' Worth: so 'third invisible cycle' is a fact it can see", async () => {
    const sid = "orch-worth-ledger";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "x" }] });
    const st = loadCycleState(sid)!;
    // Two earlier cycles judged not worth it; the armed cycle is n=3.
    st.cycle = 3;
    st.cycles[0].n = 3;
    st.cycles.unshift(
      { n: 1, title: "Flask sit digested, not ate", startedAt: "t", itemsTotal: 1, itemsDone: 1, waves: 1, mustFix: [], worth: "no — a rename" },
      { n: 2, title: "Hunt sit digested, not ate", startedAt: "t", itemsTotal: 1, itemsDone: 1, waves: 1, mustFix: [], worth: "no — another rename" },
    );
    const { saveCycleState } = await import("../src/harness/cycle/state.js");
    saveCycleState(st);
    let brief = "";
    const base = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_FULFILLED] });
    const rt: CycleRuntime = {
      ...base.rt,
      async runRole(role, b) {
        if (role === "reviewer") brief = b;
        return base.rt.runRole(role, b, { cycle: 0 });
      },
    };
    await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.match(brief, /## Recent cycles — was each worth a user's notice\?/);
    assert.match(brief, /- cycle 1 — Flask sit digested, not ate: no — a rename/);
    assert.match(brief, /- cycle 2 — Hunt sit digested, not ate: no — another rename/);
    assert.match(brief, /Worth: you judge the cycle, not only the diff/);
    assert.match(brief, /Persisted data and public surface/);
  });

  it("a Planner that never parses releases as blocked with the failed artifact on disk", async () => {
    const sid = "orch-noparse";
    const { rt, calls } = fakeRuntime(cwd, { planner: ["I think we should do things", "still prose"] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: null, cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.ok(out?.released);
    assert.equal(out.endReason, "blocked");
    assert.equal(calls.filter((c) => c === "role:planner").length, 2, "one retry");
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 1), "plan.failed.md")));
  });

  it("no runtime: an armed run that needs a role releases with runtime-unavailable", async () => {
    const sid = "orch-nort";
    armWithPlan({ sessionId: sid, cwd });
    const r = await evaluateCycleAtStop(sid, { facts: facts() });
    assert.ok(r?.released);
    assert.equal(r.endReason, "runtime-unavailable");
  });

  it("not armed → null so the Stop guard falls through", async () => {
    assert.equal(await evaluateCycleAtStop("never-armed", { facts: facts() }), null);
  });

  it("an isolate Verify: is proof=ran — the stack table's suite gates and the isolate stays declared", () => {
    const checks = ["npm run typecheck", "npm test"];
    const iso = resolveVerifyCommand({ verifyCommand: "npx tsx --test tests/cycle-status.test.ts" }, checks);
    assert.equal(iso.command, "npm test");
    assert.equal(iso.declared, "npx tsx --test tests/cycle-status.test.ts");
    assert.match(iso.note ?? "", /is an isolate/);
    const tsc = resolveVerifyCommand({ verifyCommand: "npm run typecheck" }, checks);
    assert.equal(tsc.command, "npm test");
    const suite = resolveVerifyCommand({ verifyCommand: "cargo test" }, ["cargo test"]);
    assert.equal(suite.command, "cargo test");
    assert.equal(suite.note, undefined);
    // A stray pyproject at a JS monorepo root: the fuller check must share the isolate's ecosystem.
    const mono = ["npm run check", "npm run build", "pytest"];
    const js = resolveVerifyCommand({ verifyCommand: "cd extension && npx vitest run src/x.test.ts" }, mono);
    assert.equal(js.command, "npm run check", "never pytest for an npm isolate");
    assert.equal(resolveVerifyCommand({ verifyNone: "none" }, mono).command, "npm run check");
    assert.equal(resolveVerifyCommand({}, mono).command, "npm run check");
    assert.equal(resolveVerifyCommand({ verifyCommand: "pytest tests/test_a.py" }, mono).command, "pytest");
    // Nothing fuller in the stack table: the isolate is all there is, and says so.
    const only = resolveVerifyCommand({ verifyCommand: "node --test tests/a.test.js" }, []);
    assert.equal(only.command, "node --test tests/a.test.js");
    assert.match(only.note ?? "", /no fuller check/);
    // `none — why` falls back to the suite; no stack table → no gate.
    assert.equal(resolveVerifyCommand({ verifyNone: "no runner" }, checks).command, "npm test");
    assert.equal(resolveVerifyCommand({ verifyNone: "no runner" }, []).command, undefined);
    assert.equal(resolveVerifyCommand({}, checks).command, "npm test");
  });

  it("a plan that declares an isolate is gated by the suite when the cycle closes", async () => {
    const sid = "orch-isolate-gate";
    const { rt, calls } = fakeRuntime(cwd, {
      planner: [
        `# Cycle 1 plan — x\nVerdict: continue\nVerify: \`npx tsx --test tests/one.test.ts\`\nItems:\n1. thing — files: a.ts — proof: npm test`,
      ],
      reviewer: [REVIEW_OK],
    });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: "x", cwd });
    await ensureCyclePlanned(sid, rt);
    const s = loadCycleState(sid)!;
    assert.equal(s.verifyCommand, "npm test");
    assert.deepEqual(s.declaredChecks, ["npx tsx --test tests/one.test.ts"]);
    await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.ok(calls.includes("check:npm test"), calls.join(","));
    assert.ok(!calls.some((c) => c.includes("one.test.ts")), "the isolate never gates");
  });

  it("a fulfilled verdict note does not double its period in the release line", async () => {
    const sid = "orch-period";
    const { rt } = fakeRuntime(cwd, { planner: [`# Cycle 1 plan\nVerdict: fulfilled — the flag already exists.`] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: "x", cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.match(out!.reason, /already exists\. ULW released/);
    assert.doesNotMatch(out!.reason, /\.\./);
  });
});
