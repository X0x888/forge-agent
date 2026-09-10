import { describe, it, beforeEach, afterEach } from "node:test";
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
  armCycle,
  disarmCycle,
  setHumanPlan,
  type CycleRuntime,
  type CycleRole,
  type CyclePlanItem,
} from "../src/harness/cycle/index.js";
import type { StopFacts } from "../src/harness/cycle/machine.js";
import { armWithPlan, mkGitRepo } from "./helpers/cycle-arm.js";

/** The alternatives block and the item shape every `continue` plan owes the parser. */
const CONSIDERED = `Considered:\n- rough edge: theme — cheap and visible\n- leave it — the tree runs; the theme is what a user meets first`;
const ITEM = (title: string, file: string) =>
  `${title} — files: ${file} — serves: the user's first minute — red now: ran it, not there yet — proof: npm test`;

const PLAN_OK = (n: number, items = 2) =>
  `# Cycle ${n} plan — theme ${n}\nVerdict: continue\nIdentity: a CLI for tests\nLooked: ran the binary\n${CONSIDERED}\nDirection: theme ${n}\nWorth the cycle: theme ${n} beats leaving it because a user meets it first\nVerify: \`npm test\`\nItems:\n${Array.from(
    { length: items },
    (_, i) => `${i + 1}. ${ITEM(`item ${n}.${i + 1}`, `src/f${i}.ts`)}`,
  ).join("\n")}\nOut of scope:\n- nothing`;
const PLAN_FULFILLED = `# Cycle 2 plan\nVerdict: fulfilled — the widget exists and is tested`;
const REVIEW_OK = `# Cycle 1 review\nVerdict: ship\nFulfillment:\n- item — done\nRevisions:\n- none\nMust-fix:\n- none`;
const REVIEW_MUSTFIX = `# Cycle 1 review\nVerdict: ship-with-revisions\nMust-fix:\n- the flag prints nothing`;
const REVIEW_REVISED = `# Cycle 1 review\nVerdict: ship-with-revisions\nRevisions:\n- restored the flag output\nMust-fix:\n- none`;
const SCOUT = (n: number) =>
  `# Cycle ${n} scout\nIdentity: a CLI for tests, scouted\nLooked: built dist and ran --help; no first-run card\nPromises:\n- README: a first-run card — broken — bare prompt\n- --help lists every command — kept — matches\nConsidered:\n- broken promise: the first-run card — the first thing a new user meets\n- leave it — the CLI works without it`;
const LOOK = (n: number) => `# Cycle ${n} look\nLooked: ran node dist/cli.js in an empty dir — the card shows`;

interface FakeOpts {
  planner?: string[];
  reviewer?: string[];
  checkPasses?: boolean[];
  /** Failing test names per red run (consumed in order). */
  checkFailures?: string[][];
  commitOk?: boolean;
  /** Keep role sessions so the orchestrator runs each role in two turns. */
  twoTurn?: boolean;
}

function fakeRuntime(cwd: string, o: FakeOpts = {}) {
  const calls: string[] = [];
  const todos: Array<{ id: string; status: string }> = [];
  const admitted: string[] = [];
  const briefs: Array<{ role: CycleRole; turn: number; brief: string }> = [];
  const remembered: { promises: unknown[] } = { promises: [] };
  const planner = [...(o.planner ?? [])];
  const reviewer = [...(o.reviewer ?? [])];
  const checks = [...(o.checkPasses ?? [])];
  let commits = 0;
  let sessions = 0;
  const rt: CycleRuntime = {
    workspace: cwd,
    async runRole(role: CycleRole, brief, opts) {
      const turn = opts.resumeSessionId ? 2 : opts.keepSession ? 1 : 0;
      calls.push(turn ? `role:${role}#${turn}` : `role:${role}`);
      briefs.push({ role, turn, brief });
      const text = role === "planner" ? planner.shift() : reviewer.shift();
      return {
        ok: Boolean(text),
        text: text ?? "",
        status: text ? "completed" : "error",
        promptTokens: 10,
        completionTokens: 5,
        editCount: role === "reviewer" ? 1 : 0,
        error: text ? undefined : `no ${role} script`,
        ...(o.twoTurn && opts.keepSession ? { sessionId: opts.resumeSessionId ?? `${role}-sess-${++sessions}` } : {}),
      };
    },
    async cleanupRoleSession(id) {
      calls.push(`cleanup:${id}`);
    },
    rememberPromises(p) {
      remembered.promises.push(...p);
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
    gitIsClean: () => true,
    userMessagesSince: () => [],
    guidelineSurvey: () => "AGENTS.md fresh",
    projectChecks: () => ["npm test"],
  };
  return { rt, calls, todos, admitted, briefs, remembered };
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
    // These tests script one document per role run: the single-brief mode.
    // The two-turn mode has its own describe below.
    process.env.FORGE_ULW_TWO_TURN = "0";
    cwd = mkGitRepo();
  });
  afterEach(() => {
    delete process.env.FORGE_ULW_TWO_TURN;
    delete process.env.FORGE_ULW_LOOK_GATE;
  });

  it("turn start: the Planner writes cycle 1, items seed the board, the plan is admitted", async () => {
    const sid = "orch-plan";
    const { rt, calls, todos } = fakeRuntime(cwd, { planner: [PLAN_OK(1, 3)] });
    rt.gitIsClean = () => false; // Cycle 1 deliberately baselines the user's existing work.
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

  it("a mandate fulfilled without Looked: becomes go-deeper, not a release", async () => {
    const sid = "orch-fulfilled-no-look";
    const { rt } = fakeRuntime(cwd, {
      planner: [`# Cycle 1 plan\nVerdict: fulfilled — hello world is enough`],
    });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: "build a chrome extension", cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.equal(out?.released, false, "Looked: is required before a mandate can end the run");
    assert.equal(out?.planAdmitted, true);
    const s = loadCycleState(sid)!;
    assert.match(s.planTitle ?? "", /Go deeper/);
    assert.equal(s.directExecuteStreak, 1);
  });

  it("a fulfilled first plan releases the run (case a already met)", async () => {
    const sid = "orch-fulfilled";
    const { rt } = fakeRuntime(cwd, {
      planner: [`${PLAN_FULFILLED}\nLooked: ran the binary and npm test`],
    });
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

  it("/cycle 0 during the next Planner (after a commit) releases without admitting another cycle", async () => {
    const sid = "orch-cycle0-during-plan";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_OK(2)] });
    const orig = rt.runRole.bind(rt);
    rt.runRole = async (role, brief, opts) => {
      if (role === "planner") setCycleFlag(sid, 0);
      return orig(role, brief, opts);
    };
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.ok(r?.released);
    assert.equal(r.endReason, "cycle-zero");
    assert.equal(r.committed?.sha, "abc1");
    const s = loadCycleState(sid)!;
    assert.equal(s.cycle, 1, "did not admit cycle 2");
    assert.equal(s.phase, "released");
    assert.equal(s.cycles.length, 1);
    assert.ok(calls.includes("role:planner"));
    assert.ok(!calls.some((c) => c.startsWith("todos:")), "no next board");
  });

  it("/cycle 0 during the first Planner still admits cycle 1 as the last cycle", async () => {
    const sid = "orch-cycle0-first-plan";
    armCycle({ sessionId: sid, mandate: "add a widget", cwd });
    const { rt } = fakeRuntime(cwd, { planner: [PLAN_OK(1, 2)] });
    rt.gitIsClean = () => false;
    const orig = rt.runRole.bind(rt);
    rt.runRole = async (role, brief, opts) => {
      if (role === "planner") setCycleFlag(sid, 0);
      return orig(role, brief, opts);
    };
    const out = await ensureCyclePlanned(sid, rt);
    assert.equal(out?.released, false);
    assert.equal(out?.planAdmitted, true);
    const s = loadCycleState(sid)!;
    assert.equal(s.cycle, 1);
    assert.equal(s.phase, "execute");
    assert.equal(s.cycleZeroRequested, true);
  });

  it("/cycle 0 during the Reviewer still commits the open cycle, then releases", async () => {
    const sid = "orch-cycle0-during-review";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_OK(2)] });
    const orig = rt.runRole.bind(rt);
    rt.runRole = async (role, brief, opts) => {
      if (role === "reviewer") setCycleFlag(sid, 0);
      return orig(role, brief, opts);
    };
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.ok(r?.released);
    assert.equal(r.endReason, "cycle-zero");
    assert.equal(r.committed?.sha, "abc1");
    assert.ok(!calls.includes("role:planner"), "no re-plan after /cycle 0 mid-review");
  });

  it("/ulw-off during the next Planner aborts without admitting another cycle", async () => {
    const sid = "orch-ulwoff-during-plan";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_OK(2)] });
    const orig = rt.runRole.bind(rt);
    rt.runRole = async (role, brief, opts) => {
      if (role === "planner") disarmCycle(sid);
      return orig(role, brief, opts);
    };
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.ok(r?.released);
    assert.equal(r.endReason, "disarmed");
    assert.equal(r.committed?.sha, "abc1");
    const s = loadCycleState(sid)!;
    assert.equal(s.cycle, 1);
    assert.equal(s.phase, "released");
    assert.ok(!calls.some((c) => c.startsWith("todos:")));
  });

  it("/plan during the next Planner stands down without admitting another cycle", async () => {
    const sid = "orch-humanplan-during-plan";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_OK(2)] });
    const orig = rt.runRole.bind(rt);
    rt.runRole = async (role, brief, opts) => {
      if (role === "planner") setHumanPlan(sid, true);
      return orig(role, brief, opts);
    };
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(r?.released, false);
    assert.equal(r?.allowStop, true);
    const s = loadCycleState(sid)!;
    assert.equal(s.cycle, 1);
    assert.equal(s.humanPlan, true);
    assert.equal(s.enabled, true);
    assert.ok(!calls.some((c) => c.startsWith("todos:")));
  });

  it("/ulw-off during the Reviewer aborts without committing", async () => {
    const sid = "orch-ulwoff-during-review";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_OK(2)] });
    const orig = rt.runRole.bind(rt);
    rt.runRole = async (role, brief, opts) => {
      if (role === "reviewer") disarmCycle(sid);
      return orig(role, brief, opts);
    };
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.ok(r?.released);
    assert.equal(r.endReason, "disarmed");
    assert.ok(!calls.some((c) => c.startsWith("commit:")), "/ulw-off is immediate; no cycle commit");
    assert.ok(!calls.includes("role:planner"));
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
      reviewer: [REVIEW_REVISED],
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

  it("a red run after the Reviewer's revisions requires a fresh review of executor fixes before commit", async () => {
    const sid = "orch-red-post";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt, calls } = fakeRuntime(cwd, {
      reviewer: [REVIEW_REVISED, REVIEW_OK],
      checkPasses: [true, false, true, true],
      planner: [PLAN_FULFILLED],
    });
    const r1 = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(r1?.phase, "fix");
    assert.match(r1?.reanchor ?? "", /after review: `npm test` is RED/);
    assert.equal(loadCycleState(sid)!.cycles[0].reviewPath, undefined, "stale approval is invalidated on disk before executor fixes");
    assert.equal(loadCycleState(sid)!.cycles[0].reviewVerdict, undefined);
    assert.equal(fs.readFileSync(path.join(cycleArtifactsDir(sid, 1), "review.before-fix.1.md"), "utf8").trim(), REVIEW_REVISED);
    const r2 = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts({ lastAssistantMessage: "fixed" }) });
    assert.equal(r2?.committed?.sha, "abc1");
    assert.equal(calls.filter((c) => c === "role:reviewer").length, 2);
    assert.deepEqual(calls.filter((c) => c.startsWith("check:") || c.startsWith("role:reviewer") || c.startsWith("commit:")), [
      "check:npm test", "role:reviewer", "check:npm test",
      "check:npm test", "role:reviewer", "check:npm test", "commit:ulw cycle 1: test plan",
    ]);
  });

  it("nominal ship with a must-fix stays in the current cycle until a fresh review clears it", async () => {
    const sid = "orch-review-mustfix";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", maxCycles: 1 });
    const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_MUSTFIX, REVIEW_OK] });
    const first = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(first?.phase, "fix");
    assert.equal(first?.released, false, "max_cycles waits for the current cycle's fixes");
    assert.match(first?.reanchor ?? "", /the flag prints nothing/);
    assert.equal(loadCycleState(sid)!.cycle, 1);
    assert.ok(!calls.some((c) => c.startsWith("commit:") || c.startsWith("role:planner")));
    const second = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts({ lastAssistantMessage: "fixed" }) });
    assert.equal(second?.committed?.sha, "abc1");
    assert.equal(second?.endReason, "max-cycles");
    assert.equal(calls.filter((c) => c === "role:reviewer").length, 2);
  });

  for (const state of ["partial", "missing"] as const) {
    it(`a nominal ship whose current item is ${state} cannot commit a green tree`, async () => {
      const sid = `orch-review-${state}`;
      armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "the flag" }] });
      setCycleFlag(sid, 0);
      const { rt, calls, todos } = fakeRuntime(cwd, {
        reviewer: [`# Cycle 1 review\nVerdict: ship\nFulfillment:\n- the flag - ${state} - no output\nMust-fix:\n- none`, REVIEW_OK],
      });
      todos.push({ id: "i1", status: "completed" });
      const first = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
      assert.equal(first?.phase, "fix");
      assert.equal(first?.released, false, "/cycle 0 waits for review findings to be resolved");
      assert.match(first?.reanchor ?? "", /the flag.*no output/);
      assert.equal(loadCycleState(sid)!.items[0].status, "open", "the reviewer supersedes the completed board item");
      assert.ok(!calls.some((c) => c.startsWith("commit:")));
      const second = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
      assert.equal(second?.committed?.sha, "abc1");
      assert.equal(second?.endReason, "cycle-zero");
    });
  }

  it("review findings and failing checks share the same bounded fix budget", async () => {
    const sid = "orch-review-fixcap";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
    const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_MUSTFIX, REVIEW_MUSTFIX], checkPasses: [false, true, true] });
    const first = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts(), fixRoundsCap: 2 });
    assert.equal(first?.phase, "fix");
    const second = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts(), fixRoundsCap: 2 });
    assert.equal(second?.phase, "fix");
    assert.match(second?.reason ?? "", /fix round 2\/2/);
    const third = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts(), fixRoundsCap: 2 });
    assert.equal(third?.endReason, "fix-cap");
    assert.match(third?.reason ?? "", /Reviewer findings remain.*the flag prints nothing/);
    assert.ok(!calls.some((c) => c.startsWith("commit:") || c.startsWith("role:planner")));
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
    // review.md is the structured verdict the run used; the prose is kept beside it.
    const dir = cycleArtifactsDir(sid, 1);
    assert.match(fs.readFileSync(path.join(dir, "review.md"), "utf8"), /^# Cycle 1 review\nVerdict: blocked\nMust-fix:\n- Reviewer returned no parseable review/);
    assert.equal(fs.readFileSync(path.join(dir, "review.failed.md"), "utf8").trim(), "looks fine to me");
  });

  for (const result of [{ ok: false, status: "error" }, { ok: true, status: "incomplete_cost_cap" }]) {
    it(`a parseable ship from a ${result.status} Reviewer cannot approve a commit`, async () => {
      const sid = `orch-review-${result.status}`;
      armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", maxCycles: 1 });
      const base = fakeRuntime(cwd, { reviewer: [REVIEW_OK] });
      const rt: CycleRuntime = {
        ...base.rt,
        async runRole(role, brief, opts) {
          return { ...await base.rt.runRole(role, brief, opts), ...result };
        },
      };
      const out = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
      assert.equal(out?.committed?.skipped, "review blocked");
      assert.ok(!base.calls.some((c) => c.startsWith("commit:")));
      const record = loadCycleState(sid)!.cycles[0];
      assert.equal(record.reviewVerdict, "blocked");
      assert.match(record.mustFix[0], /Reviewer did not complete/);
      assert.equal(fs.readFileSync(path.join(cycleArtifactsDir(sid, 1), "review.failed.md"), "utf8").trim(), REVIEW_OK);
    });
  }

  it("resuming after a blocked review was persisted never treats its artifact as approval", async () => {
    const sid = "orch-resume-blocked-review";
    const state = armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", maxCycles: 1 });
    state.phase = "review";
    state.cycles[0].reviewPath = path.join(cycleArtifactsDir(sid, 1), "review.md");
    state.cycles[0].reviewVerdict = "blocked";
    state.cycles[0].mustFix = ["the flag deletes user data"];
    const { saveCycleState } = await import("../src/harness/cycle/state.js");
    saveCycleState(state);
    const { rt, calls } = fakeRuntime(cwd);
    const out = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(out?.committed?.skipped, "review blocked");
    assert.equal(out?.endReason, "max-cycles");
    assert.deepEqual(calls, [], "no check or commit can turn the blocked artifact into acceptance");
  });

  for (const phase of ["fix", "verify"] as const) {
    it(`a legacy ${phase} sidecar cannot reuse approval from before a failed post-review check`, async () => {
      const sid = `orch-resume-legacy-${phase}`;
      const state = armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", maxCycles: 1 });
      state.phase = phase;
      state.fixRounds = 1;
      const record = state.cycles[0];
      record.reviewPath = path.join(cycleArtifactsDir(sid, 1), "review.md");
      record.reviewVerdict = "ship";
      record.verifyPassed = false;
      fs.mkdirSync(path.dirname(record.reviewPath), { recursive: true });
      fs.writeFileSync(record.reviewPath, REVIEW_OK);
      const { saveCycleState } = await import("../src/harness/cycle/state.js");
      saveCycleState(state);
      const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_OK] });
      const out = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts({ lastAssistantMessage: "fixed" }) });
      assert.equal(out?.committed?.sha, "abc1");
      assert.deepEqual(calls.filter((c) => c.startsWith("check:") || c.startsWith("role:") || c.startsWith("commit:")), [
        "check:npm test", "role:reviewer", "check:npm test", "commit:ulw cycle 1: test plan",
      ], "executor repairs require a fresh review before the accepted tree can commit");
      assert.equal(loadCycleState(sid)!.fixRounds, 1, "resuming does not spend another fix round");
    });
  }

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
    const base = fakeRuntime(cwd, { reviewer: [REVIEW_MUSTFIX.replace("Verdict: ship-with-revisions", "Verdict: blocked")], planner: [PLAN_OK(2)] });
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
      `# Cycle 1 plan — x\nVerdict: continue\n${CONSIDERED}\nDirection: Sit leftover sits with Murmur\nVerify: npm test\nItems:\n1. ${ITEM("the flag", "a.ts")}\nOut of scope:\n- Day-0 hunt \`Nexus ate Philosophy.\` — the next rename\n`,
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
    assert.match(brief, /cycle 1 — test plan · Sit leftover sits with Murmur · review: ship · worth found: no — a one-word rename/);
    assert.match(brief, /## The last Reviewer's shape notes\n- two formatters, one sentence/);
    assert.match(brief, /## The last Reviewer judged the last cycle not worth a cycle/);
    assert.match(brief, /Plan a concrete benefit or resolve a consequential unknown/);
    assert.doesNotMatch(brief, /Prior plan/);
    assert.doesNotMatch(brief, /Nexus ate Philosophy/, "the previous author's Out-of-scope backlog is not handed on");
    assert.doesNotMatch(brief, /### Cycle 1 plan/);
    assert.match(brief, /2\. Use it\. Exercise a representative job end to end/);
    assert.match(brief, /11\. Verdict: fulfilled releases a run only when its explicit mandate is met/);
    const s = loadCycleState(sid)!;
    assert.equal(s.cycles[0].worth, "no — a one-word rename no user would notice");
    assert.deepEqual(s.cycles[0].architecture, ["two formatters, one sentence"]);
  });

  it("the Reviewer brief carries recent cycles' Worth: to judge whether the work justified its cost", async () => {
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
    assert.match(brief, /## Recent cycles — did each justify its cost\?/);
    assert.match(brief, /- cycle 1 — Flask sit digested, not ate: no — a rename/);
    assert.match(brief, /- cycle 2 — Hunt sit digested, not ate: no — another rename/);
    assert.match(brief, /Worth: judge the benefit to this product's user, operator or maintainer from evidence/);
    assert.match(brief, /Persisted data and public surface/);
  });

  it("the executor hears a blocked review: the next plan admission carries what the Reviewer changed, disputed and noted", async () => {
    const sid = "orch-executor-hears";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "the flag" }, { title: "the csv export" }] });
    const { rt, admitted } = fakeRuntime(cwd, {
      reviewer: [
        [
          "# Cycle 1 review",
          "Verdict: blocked",
          "Fulfillment:",
          "- the flag — done",
          "- the csv export — partial — no header row",
          "Revisions:",
          "- removed the three `// used to` comments in src/f0.ts; comments describe the code as it is",
          "- folded formatRow / formatLine into one formatter",
          "Must-fix:",
          "- none",
          "Architecture:",
          "- two formatters, one sentence",
          "Worth: yes — the export opens in a spreadsheet",
        ].join("\n"),
      ],
      planner: [PLAN_OK(2)],
    });
    const out = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(out?.planAdmitted, true);
    const admission = out!.reanchor!;
    assert.match(admission, /## The Reviewer's notes on cycle 1 — standing for this run/);
    assert.match(admission, /Verdict: blocked · Worth: yes — the export opens in a spreadsheet/);
    assert.match(admission, /Changed in your work, and why:\n- removed the three `\/\/ used to` comments/);
    assert.match(admission, /- folded formatRow \/ formatLine into one formatter/);
    assert.match(admission, /Judged against your board:\n- the csv export — partial — no header row/);
    assert.match(admission, /Shape notes:\n- two formatters, one sentence/);
    assert.match(admission, /Carry applicable corrections forward\. A recurring acceptance defect is a Must-fix; nonblocking shape observations are future work/);
    // The block sits between the plan and the executor's orders, before the todo board.
    assert.ok(admission.indexOf("The Reviewer's notes") < admission.indexOf("You are the executor."));
    // The record keeps what the executor was told, for /cycle status and the report.
    const st = loadCycleState(sid)!;
    assert.deepEqual(st.cycles[0].revisions, [
      "removed the three `// used to` comments in src/f0.ts; comments describe the code as it is",
      "folded formatRow / formatLine into one formatter",
    ]);
    assert.deepEqual(st.cycles[0].disputed, ["the csv export — partial — no header row"]);
    assert.ok(admitted.length === 0, "the admission is the Stop's reanchor, not a second admit");
  });

  it("a review that changed nothing tells the executor so, and cycle 1's admission carries no review", async () => {
    const sid = "orch-executor-clean-review";
    const { rt } = fakeRuntime(cwd, { planner: [PLAN_OK(1), PLAN_OK(2)], reviewer: [REVIEW_OK] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: "add a widget", cwd });
    const first = await ensureCyclePlanned(sid, rt);
    assert.doesNotMatch(first!.reanchor!, /The Reviewer's notes/, "no review has happened yet");
    const second = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.match(second!.reanchor!, /## The Reviewer's notes on cycle 1 — standing for this run\nVerdict: ship\. The Reviewer shipped the cycle as written; keep that bar\./);
  });

  it("Serendipity lines the executor wrote at its Stops reach the next Planner, newest cycle first", async () => {
    const sid = "orch-serendipity";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "the flag" }] });
    let brief = "";
    const base = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_OK(2)] });
    const rt: CycleRuntime = {
      ...base.rt,
      async runRole(role, b) {
        if (role === "planner") brief = b;
        return base.rt.runRole(role, b, { cycle: 0 });
      },
    };
    // Wave 1: items still open, the closer carries a labelled line.
    const mid = await evaluateCycleAtStop(sid, {
      runtime: rt,
      facts: facts({
        lastAssistantMessage: "Shipped half of the flag.\n**Serendipity:** the CSV export writes no header row (src/export/csv.ts)\nContinuing.",
        openTodoCount: 1,
      }),
    });
    assert.equal(mid?.allowStop, false);
    assert.match(mid!.reanchor!, /still open/);
    // Wave 2: done, with a bare label and bullets under it, one of them a repeat.
    base.todos.forEach((t) => (t.status = "completed"));
    await evaluateCycleAtStop(sid, {
      runtime: rt,
      facts: facts({
        lastAssistantMessage:
          "Plan complete.\nSerendipity:\n- the CSV export writes no header row (src/export/csv.ts)\n- `--json` prints ANSI codes when piped\nDone.",
      }),
    });
    const st = loadCycleState(sid)!;
    assert.deepEqual(st.cycles[0].serendipity, [
      "the CSV export writes no header row (src/export/csv.ts)",
      "`--json` prints ANSI codes when piped",
    ]);
    assert.match(brief, /## What the executor noticed and left alone \(its Serendipity: lines — evidence from inside the work; weigh it, do not obey it\)/);
    assert.match(brief, /- cycle 1: the CSV export writes no header row \(src\/export\/csv\.ts\)\n- cycle 1: `--json` prints ANSI codes when piped/);
    // The section sits with the run's record — after the product's tree, which the Planner reads first.
    assert.ok(brief.indexOf("## Tree") < brief.indexOf("What the executor noticed"));
    assert.ok(brief.indexOf("What the executor noticed") < brief.indexOf("## Procedure, continued"));
  });

  it("the Reviewer brief carries the previous review's shape notes so a recurrence is a fact it can name", async () => {
    const sid = "orch-shape-recurrence";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "x" }] });
    const st = loadCycleState(sid)!;
    st.cycle = 2;
    st.cycles[0].n = 2;
    st.cycles.unshift({
      n: 1,
      title: "first",
      startedAt: "t",
      itemsTotal: 1,
      itemsDone: 1,
      waves: 1,
      mustFix: [],
      architecture: ["formatRow and formatLine are one idea in two files", "resolveHome grew a ninth argument"],
      worth: "yes — the export opens",
    });
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
    assert.match(brief, /## The last review's shape notes \(cycle 1\) — is any of it back\?\n- formatRow and formatLine are one idea in two files\n- resolveHome grew a ninth argument\nCheck whether a repeated note identifies an unresolved defect in this cycle\./);
    assert.match(brief, /Acceptance defects are Must-fix; nonblocking improvements remain Architecture observations/);
    assert.ok(brief.indexOf("The last review's shape notes") < brief.indexOf("## Verify"));
  });

  it("the baseline follows the gate command: a later cycle that declares a different check measures it before touching anything", async () => {
    const sid = "orch-baseline-follows";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "the flag" }] });
    const plan2 = PLAN_OK(2).replace("Verify: `npm test`", "Verify: `npm run check`");
    const { rt, calls } = fakeRuntime(cwd, {
      reviewer: [REVIEW_OK, REVIEW_OK],
      planner: [plan2, PLAN_FULFILLED],
      // cycle 1: pre-review green, post-review green; cycle 2 admission: the new
      // command's baseline is red with one old failure; cycle 2 close: pre-review
      // and post-review red with that same old failure — green vs baseline.
      checkPasses: [true, true, false, false, false],
      checkFailures: [["old flake"], ["old flake"], ["old flake"]],
    });
    const first = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(first?.planAdmitted, true);
    assert.equal(first?.phase, "execute");
    let st = loadCycleState(sid)!;
    assert.equal(st.verifyCommand, "npm run check");
    assert.equal(st.verifyBaseline?.command, "npm run check", "the baseline was re-captured for the new gate");
    assert.deepEqual(st.verifyBaseline?.failures, ["old flake"]);
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 2), "verify.baseline.log")));
    assert.equal(calls.filter((c) => c === "check:npm run check").length, 1);
    // The executor finishes cycle 2; the old failure does not count against it.
    (rt.todos() as Array<{ status: string }>).forEach((t) => (t.status = "completed"));
    const second = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(second?.released, true);
    assert.equal(second?.endReason, "fulfilled");
    st = loadCycleState(sid)!;
    assert.equal(st.cycles[1].verifyPassed, true);
    assert.equal(st.cycles[1].verifyInherited, 1);
    assert.ok(st.cycles[1].commitSha, "cycle 2 committed on a green-vs-baseline gate");
    assert.equal(st.fixRounds, 0, "no fix round was spent on the inherited failure");
    assert.deepEqual(st.verifyBaseline?.failures, ["old flake"], "the accepted run is the next baseline");
    assert.equal(calls.filter((c) => c === "check:npm run check").length, 3);
  });

  it("the baseline is not re-run when the gate command is unchanged", async () => {
    const sid = "orch-baseline-stable";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "the flag" }] });
    const { rt, calls } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_OK(2)] });
    await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    // pre-review + post-review only: the accepted post-review run became the baseline.
    assert.equal(calls.filter((c) => c === "check:npm test").length, 2);
    assert.equal(loadCycleState(sid)!.verifyBaseline?.command, "npm test");
  });

  for (const scenario of [
    { name: "blocked-review", reviewer: "# Cycle 1 review\nVerdict: blocked\nMust-fix:\n- the changed export is unsafe", clean: true },
    { name: "dirty-tree", reviewer: REVIEW_OK, clean: false },
    { name: "unknown-tree", reviewer: REVIEW_OK, clean: null },
    { name: "unavailable-clean-query", reviewer: REVIEW_OK, clean: undefined },
  ]) {
    it(`a new gate cannot baseline rejected or unverified work after ${scenario.name}`, async () => {
      const sid = `orch-baseline-${scenario.name}`;
      const state = armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test" });
      state.verifyBaseline = { command: "npm test", exitCode: 0, failures: [], at: "before" };
      const { saveCycleState } = await import("../src/harness/cycle/state.js");
      saveCycleState(state);
      const blocked = scenario.name === "blocked-review";
      const { rt, calls } = fakeRuntime(cwd, {
        reviewer: [scenario.reviewer],
        planner: [PLAN_OK(2).replace("Verify: `npm test`", "Verify: `npm run check`")],
        checkPasses: blocked ? [true, false] : [true, true, false],
        checkFailures: [["export now drops records"]],
      });
      rt.gitIsClean = scenario.clean === undefined ? undefined : () => scenario.clean!;
      const first = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
      assert.equal(first?.planAdmitted, true);
      assert.equal(loadCycleState(sid)!.verifyBaseline?.command, "npm test", "unaccepted work cannot redefine inherited failures");
      assert.ok(!calls.includes("check:npm run check"), "the new baseline is not run on that tree");
      assert.ok(!fs.existsSync(path.join(cycleArtifactsDir(sid, 2), "verify.baseline.log")));
      const commitsBefore = calls.filter((c) => c.startsWith("commit:")).length;
      const second = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
      assert.equal(second?.phase, "fix");
      assert.match(second?.reanchor ?? "", /export now drops records/);
      assert.equal(calls.filter((c) => c.startsWith("commit:")).length, commitsBefore, "the introduced failure blocks cycle 2");
    });
  }

  it("a Planner that cannot produce a plan does not end the run — it becomes a direct-execute cycle", async () => {
    const sid = "orch-noparse";
    const { rt, calls } = fakeRuntime(cwd, { planner: ["I think we should do things", "still prose"] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: null, cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.equal(out?.released, false, "an unlimited run does not stop because the Planner stumbled");
    assert.equal(out?.planAdmitted, true);
    const s = loadCycleState(sid)!;
    assert.equal(s.phase, "execute");
    assert.equal(s.cycle, 1);
    assert.ok(s.items.length >= 1, "the executor is handed work");
    assert.match(s.planTitle ?? "", /Direct execute/);
    assert.equal(s.directExecuteStreak, 1, "the synthesized cycle counts toward the no-progress wall");
    assert.equal(calls.filter((c) => c === "role:planner").length, 2, "one retry before synthesizing");
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 1), "plan.failed.md")), "the failed plan is kept");
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 1), "plan.md")), "the synthesized work plan is on disk");
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
        `# Cycle 1 plan — x\nVerdict: continue\n${CONSIDERED}\nVerify: \`npx tsx --test tests/one.test.ts\`\nItems:\n1. ${ITEM("thing", "a.ts")}`,
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
    const { rt } = fakeRuntime(cwd, { planner: [`# Cycle 1 plan\nVerdict: fulfilled — the flag already exists.\nLooked: ran --help and the test`] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: "x", cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.match(out!.reason, /already exists\. ULW released/);
    assert.doesNotMatch(out!.reason, /\.\./);
  });

  it("Dispute: lines the executor wrote reach the record and the next Planner", async () => {
    const sid = "orch-dispute";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "the flag" }] });
    const { rt, briefs } = fakeRuntime(cwd, { reviewer: [REVIEW_OK], planner: [PLAN_OK(2)] });
    await evaluateCycleAtStop(sid, {
      runtime: rt,
      facts: facts({
        lastAssistantMessage:
          "Plan complete.\nDispute: the last Reviewer called `catchAt` dead — scripts/seed.mjs reads it (run log in cycles/1)\nSerendipity: the README example is stale",
      }),
    });
    const st = loadCycleState(sid)!;
    assert.deepEqual(st.cycles[0].disputes, ["the last Reviewer called `catchAt` dead — scripts/seed.mjs reads it (run log in cycles/1)"]);
    assert.deepEqual(st.cycles[0].serendipity, ["the README example is stale"]);
    const plannerBrief = briefs.find((b) => b.role === "planner")!.brief;
    assert.match(plannerBrief, /## What the executor disputed in the last review/);
    assert.match(plannerBrief, /scripts\/seed\.mjs reads it/);
  });

  it("single-brief: a surface ship with a real Looked: still commits (no look.md)", async () => {
    const sid = "orch-look-gate-single-real";
    armWithPlan({
      sessionId: sid,
      cwd,
      verifyCommand: "npm test",
      maxCycles: 1,
      items: [{ title: "Stay dock leftover", proof: "open leftover door" }],
    });
    const { rt } = fakeRuntime(cwd, {
      reviewer: [
        `# Cycle 1 review\nLooked: opened leftover\nVerdict: ship\nFulfillment:\n- item — done\nMust-fix:\n- none`,
      ],
    });
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.ok(r?.committed?.sha, "the review's Looked: stands in when two-turn is off");
    assert.equal(loadCycleState(sid)!.cycles[0].reviewVerdict, "ship");
  });

  it("single-brief: a surface ship whose Looked: never opened still blocks", async () => {
    const sid = "orch-look-gate-single-never";
    armWithPlan({
      sessionId: sid,
      cwd,
      verifyCommand: "npm test",
      maxCycles: 1,
      items: [{ title: "Stay dock leftover", proof: "open leftover door" }],
    });
    const { rt, calls } = fakeRuntime(cwd, {
      reviewer: [
        `# Cycle 1 review\nLooked: Playwright MCP never initialized\nVerdict: ship\nFulfillment:\n- item — done\nMust-fix:\n- none`,
      ],
    });
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(r?.committed?.skipped, "review blocked");
    assert.ok(!calls.some((c) => c.startsWith("commit:")));
    assert.equal(loadCycleState(sid)!.lastReview?.mustFix[0], "look the surface");
  });

  it("a tab visit is not a surface sit and may ship without a look", async () => {
    const sid = "orch-look-gate-visit";
    armWithPlan({
      sessionId: sid,
      cwd,
      verifyCommand: "npm test",
      maxCycles: 1,
      items: [{ title: "a tab visit raised hunger", proof: "visit the API docs" }],
    });
    const { rt } = fakeRuntime(cwd, {
      reviewer: [
        `# Cycle 1 review\nLooked: Playwright MCP never initialized\nVerdict: ship\nFulfillment:\n- item — done\nMust-fix:\n- none`,
      ],
    });
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.ok(r?.committed?.sha, "visit is not sit — the look gate does not fire");
    assert.equal(loadCycleState(sid)!.cycles[0].reviewVerdict, "ship");
  });

  it("a single-brief plan that carries Promises: persists them as the run's checklist", async () => {
    const sid = "orch-promises-single";
    const plan = PLAN_OK(1).replace(
      "Direction:",
      "Promises:\n- README: a first-run card — broken — bare prompt\n- --help lists every command — kept\nDirection:",
    );
    const { rt, remembered } = fakeRuntime(cwd, { planner: [plan] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: null, cwd });
    await ensureCyclePlanned(sid, rt);
    const st = loadCycleState(sid)!;
    assert.deepEqual(st.promises, [
      { text: "README: a first-run card", state: "broken", seen: "bare prompt" },
      { text: "--help lists every command", state: "kept" },
    ]);
    assert.equal(remembered.promises.length, 2, "the promises reach project memory beside the identity");
    assert.deepEqual(st.cycles[0].considered, ["rough edge: theme — cheap and visible", "leave it — the tree runs; the theme is what a user meets first"]);
    assert.match(st.cycles[0].worthClaim ?? "", /beats leaving it/);
  });
});

describe("cycle orchestrator — two turns per role", () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-orch2-home-"));
    process.env.FORGE_HOME = home;
    process.env.FORGE_ULW_AUTO_COMMIT = "1";
    delete process.env.FORGE_ULW_TWO_TURN;
    cwd = mkGitRepo();
  });
  afterEach(() => {
    delete process.env.FORGE_ULW_LOOK_GATE;
  });

  it("the Reviewer looks then reviews, the Planner scouts then plans; the scout never sees the record, the plan does", async () => {
    const sid = "orch2-full";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "ship" }] });
    const { rt, calls, briefs, remembered } = fakeRuntime(cwd, {
      twoTurn: true,
      reviewer: [LOOK(1), `${REVIEW_OK}\nWorth: yes — the card shows`],
      planner: [SCOUT(2), PLAN_OK(2)],
    });
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(r?.planAdmitted, true);
    assert.equal(r?.committed?.sha, "abc1");
    assert.deepEqual(calls, [
      "check:npm test",
      "credit:pass",
      "role:reviewer#1",
      "role:reviewer#2",
      "cleanup:reviewer-sess-1",
      "check:npm test",
      "credit:pass",
      "commit:ulw cycle 1: test plan",
      "role:planner#1",
      "role:planner#2",
      "cleanup:planner-sess-2",
      "todos:2",
    ]);
    // Sequence is the enforcement: turn 1 has the product, turn 2 the record.
    const scoutBrief = briefs.find((b) => b.role === "planner" && b.turn === 1)!.brief;
    const planBrief = briefs.find((b) => b.role === "planner" && b.turn === 2)!.brief;
    assert.match(scoutBrief, /turn 1 of 2: the scout/);
    assert.doesNotMatch(scoutBrief, /## What this run has shipped/);
    assert.doesNotMatch(scoutBrief, /test plan/, "no cycle title from the record reaches the scout");
    assert.match(scoutBrief, /# Cycle 2 scout/);
    assert.match(planBrief, /turn 2 of 2: the plan/);
    assert.match(planBrief, /## Your scout \(turn 1\)\n# Cycle 2 scout\nIdentity: a CLI for tests, scouted/);
    assert.match(planBrief, /## What this run has shipped/);
    assert.match(planBrief, /cycle 1 — test plan/);
    assert.match(planBrief, /worth found: yes — the card shows/);
    assert.match(planBrief, /## Spend so far/);
    const lookBrief = briefs.find((b) => b.role === "reviewer" && b.turn === 1)!.brief;
    const reviewBrief = briefs.find((b) => b.role === "reviewer" && b.turn === 2)!.brief;
    assert.match(lookBrief, /turn 1 of 2: the look/);
    assert.doesNotMatch(lookBrief, /```diff/);
    assert.match(reviewBrief, /## Your look \(turn 1\)\n# Cycle 1 look\nLooked: ran node dist\/cli\.js/);
    assert.match(reviewBrief, /```diff/);
    // Artifacts and record.
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 1), "look.md")));
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 2), "scout.md")));
    const st = loadCycleState(sid)!;
    assert.match(st.cycles[0].reviewerLooked ?? "", /the card shows/);
    assert.ok(st.cycles[0].lookPath?.endsWith("look.md"));
    assert.ok(st.cycles[1].scoutPath?.endsWith("scout.md"));
    assert.equal(st.cycles[1].looked, "ran the binary", "the plan's own Looked: wins; the scout's stands in when it is absent");
    assert.match(st.cycles[1].worthClaim ?? "", /beats leaving it/);
    assert.equal(st.cycles[1].considered?.length, 2);
    assert.equal(st.identity, "a CLI for tests", "the plan reaffirms the identity");
    assert.deepEqual(st.promises, [
      { text: "README: a first-run card", state: "broken", seen: "bare prompt" },
      { text: "--help lists every command", state: "kept", seen: "matches" },
    ]);
    assert.equal(remembered.promises.length, 2);
    // The next scout is handed the promises to re-inspect — and nothing else from the record.
    const { rt: rt2, briefs: briefs2 } = fakeRuntime(cwd, { twoTurn: true, reviewer: [LOOK(2), REVIEW_OK], planner: [SCOUT(3), PLAN_FULFILLED] });
    await evaluateCycleAtStop(sid, { runtime: rt2, facts: facts() });
    const scout3 = briefs2.find((b) => b.role === "planner" && b.turn === 1)!.brief;
    assert.match(scout3, /## Promises as you last recorded them/);
    assert.match(scout3, /README: a first-run card — broken — bare prompt/);
    assert.doesNotMatch(scout3, /## What this run has shipped/);
  });

  it("a plan turn that does not parse is retried on the kept session — the scout is not redone — with what was missing named", async () => {
    const sid = "orch2-retry";
    const { rt, calls, briefs } = fakeRuntime(cwd, {
      twoTurn: true,
      planner: [SCOUT(1), "# Cycle 1 plan — x\nVerdict: continue\nVerify: npm test\nItems:\n1. thing — files: a.ts — proof: npm test", PLAN_OK(1)],
    });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: null, cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.equal(out?.planAdmitted, true);
    assert.equal(calls.filter((c) => c === "role:planner#1").length, 1, "one scout");
    assert.equal(calls.filter((c) => c === "role:planner#2").length, 2, "the plan turn ran twice");
    const retry = briefs[2].brief;
    assert.match(retry, /did not parse: Considered: missing/);
    assert.match(retry, /item 1 \(thing\) has no serves: \/ red now:/);
    assert.doesNotMatch(retry, /## What this run has shipped/, "the retry is a short resumed turn, not the brief again");
    assert.match(retry, /# Cycle 1 plan — <short title>/, "the contract is reprinted");
    assert.equal(calls.filter((c) => c.startsWith("cleanup:")).length, 1, "the kept session is released once, after the retry");
    assert.equal(loadCycleState(sid)!.phase, "execute");
  });

  it("a Planner whose plan turn never parses becomes a direct-execute cycle; the scout it wrote survives", async () => {
    const sid = "orch2-noparse";
    const { rt, calls } = fakeRuntime(cwd, { twoTurn: true, planner: [SCOUT(1), "prose", "still prose"] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: null, cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.equal(out?.released, false);
    assert.equal(out?.planAdmitted, true);
    const s = loadCycleState(sid)!;
    assert.equal(s.phase, "execute");
    assert.match(s.planTitle ?? "", /Direct execute/);
    assert.equal(s.directExecuteStreak, 1);
    // the scout's identity/promises inform the synthesized cycle
    assert.equal(s.identity, "a CLI for tests, scouted");
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 1), "scout.md")));
    assert.ok(fs.existsSync(path.join(cycleArtifactsDir(sid, 1), "plan.failed.md")));
    assert.equal(calls.filter((c) => c.startsWith("cleanup:")).length, 1);
  });

  it("a review turn without its own Looked: takes the look's; a mandate `fulfilled` still releases", async () => {
    const sid = "orch2-look-standin";
    // A real mandate is present (armWithPlan defaults it), so fulfilled is terminal.
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "ship" }] });
    const { rt } = fakeRuntime(cwd, { twoTurn: true, reviewer: [LOOK(1), REVIEW_OK], planner: [SCOUT(2), PLAN_FULFILLED] });
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(r?.released, true);
    const st = loadCycleState(sid)!;
    assert.match(st.lastReview?.looked ?? "", /the card shows/);
    assert.match(st.cycles[0].reviewerLooked ?? "", /the card shows/);
    assert.ok(st.cycles[1].scoutPath?.endsWith("scout.md"));
    assert.equal(st.cycles[1].planVerdict, "fulfilled");
    assert.match(st.cycles[1].looked ?? "", /no first-run card/, "the fulfilled record carries the scout's Looked:");
  });
});

describe("cycle orchestrator — an unlimited run does not stop on the model's judgement", () => {
  let home: string;
  let cwd: string;
  const SCOUT_ALL_KEPT = `# Cycle 2 scout\nIdentity: a CLI for tests\nLooked: ran every screen and navigated back out of each\nPromises:\n- README loads — kept — it loads\n- you can navigate back from every screen — kept — Esc works everywhere\nConsidered:\n- leave it — it genuinely looks fine`;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-orch3-home-"));
    process.env.FORGE_HOME = home;
    process.env.FORGE_ULW_AUTO_COMMIT = "1";
    delete process.env.FORGE_ULW_TWO_TURN;
    cwd = mkGitRepo();
  });
  afterEach(() => {
    delete process.env.FORGE_ULW_TWO_TURN;
    delete process.env.FORGE_ULW_LOOK_GATE;
  });

  it("a mandate `fulfilled` releases — a real ask that is met is a real answer", async () => {
    const sid = "orch3-mandate-done";
    const { rt } = fakeRuntime(cwd, { twoTurn: true, planner: [SCOUT(1), PLAN_FULFILLED] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: "add a --version flag", cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.ok(out?.released);
    assert.equal(out.endReason, "fulfilled");
  });

  it("a no-mandate `fulfilled` with a broken promise becomes a keep-promise cycle, not a release", async () => {
    const sid = "orch3-fulfilled-broken";
    const { rt } = fakeRuntime(cwd, { twoTurn: true, planner: [SCOUT(2), PLAN_FULFILLED] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: null, cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.equal(out?.released, false, "the model does not get to call a product with a broken promise done");
    assert.equal(out?.planAdmitted, true);
    const s = loadCycleState(sid)!;
    assert.equal(s.phase, "execute");
    assert.match(s.planTitle ?? "", /Keep the promise/);
    assert.ok(s.items.some((i) => /README: a first-run card/.test(i.title)), "the broken promise is the work");
    assert.equal(s.directExecuteStreak, 1);
  });

  it("a no-mandate `fulfilled` with every promise kept becomes a go-deeper cycle, not a release", async () => {
    const sid = "orch3-fulfilled-kept";
    const { rt } = fakeRuntime(cwd, { twoTurn: true, planner: [SCOUT_ALL_KEPT, PLAN_FULFILLED] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: null, cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.equal(out?.released, false, "'nothing worth a cycle' is a reason to look harder, not to stop");
    const s = loadCycleState(sid)!;
    assert.match(s.planTitle ?? "", /Go deeper/);
    assert.match(s.items[0]?.title ?? "", /screens and return paths for an app, public calls for a library, commands for a CLI/);
    assert.match(s.items[0]?.title ?? "", /without inventing an edit/);
    assert.equal(s.directExecuteStreak, 1);
  });

  it("an unknown promise survives scouting and becomes investigation rather than a claimed defect", async () => {
    const sid = "orch3-fulfilled-unknown";
    const scout = `# Cycle 1 scout\nIdentity: a storage library\nLooked: read the consumer example; recovery requires an unavailable fixture\nPromises:\n- Recovery preserves records - UNKNOWN - could not exercise recovery\nConsidered:\n- leave it - recovery remains unverified`;
    const { rt } = fakeRuntime(cwd, { twoTurn: true, planner: [scout, PLAN_FULFILLED] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: null, cwd });
    const out = await ensureCyclePlanned(sid, rt);
    assert.equal(out?.phase, "execute");
    assert.equal(out?.released, false);
    const state = loadCycleState(sid)!;
    assert.deepEqual(state.promises, [{ text: "Recovery preserves records", state: "unknown", seen: "could not exercise recovery" }]);
    assert.match(state.items[0]?.title ?? "", /^Investigate the promise: Recovery preserves records/);
    assert.match(state.items[0]?.title ?? "", /Establish whether it holds before editing/);
    assert.equal(state.items[0]?.redNow, "could not exercise recovery");
    assert.doesNotMatch(state.items[0]?.title ?? "", /does not keep|is broken/);
    assert.match(state.items[0]?.proof ?? "", /public interface; report the observation and any limits/);
  });

  it("the no-progress wall stops the run only after N synthesized cycles land nothing", async () => {
    const sid = "orch3-wall";
    const { rt } = fakeRuntime(cwd, { twoTurn: true, planner: [SCOUT(1), "prose", "still prose"] });
    const { armCycle } = await import("../src/harness/cycle/index.js");
    armCycle({ sessionId: sid, mandate: null, cwd });
    const st = loadCycleState(sid)!;
    st.directExecuteStreak = 3; // at the default cap
    const { saveCycleState } = await import("../src/harness/cycle/state.js");
    saveCycleState(st);
    const out = await ensureCyclePlanned(sid, rt);
    assert.ok(out?.released);
    assert.equal(out.endReason, "no-progress");
    assert.match(out.reason, /not making progress|shipped nothing/);
  });

  it("a committed cycle resets the no-progress streak", async () => {
    const sid = "orch3-wall-reset";
    armWithPlan({ sessionId: sid, cwd, verifyCommand: "npm test", items: [{ title: "ship" }] });
    const st = loadCycleState(sid)!;
    st.directExecuteStreak = 2;
    const { saveCycleState } = await import("../src/harness/cycle/state.js");
    saveCycleState(st);
    const { rt } = fakeRuntime(cwd, { twoTurn: true, reviewer: [LOOK(1), REVIEW_OK], planner: [SCOUT(2), PLAN_FULFILLED] });
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(r?.committed?.sha, "abc1");
    assert.equal(loadCycleState(sid)!.directExecuteStreak, 0, "landing work clears the wall");
  });

  it("a surface-claim ship whose look never opened the product does not commit", async () => {
    const sid = "orch2-look-gate-surface";
    armWithPlan({
      sessionId: sid,
      cwd,
      verifyCommand: "npm test",
      maxCycles: 1,
      items: [{ title: "Stay dock leftover", proof: "open leftover door" }],
    });
    const { rt, calls } = fakeRuntime(cwd, {
      twoTurn: true,
      reviewer: [
        `# Cycle 1 look\nLooked: Playwright MCP never initialized`,
        REVIEW_OK,
      ],
    });
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.equal(r?.committed?.sha, undefined);
    assert.equal(r?.committed?.skipped, "review blocked");
    assert.ok(!calls.some((c) => c.startsWith("commit:")));
    const st = loadCycleState(sid)!;
    assert.equal(st.cycles[0].reviewVerdict, "blocked");
    assert.equal(st.cycles[0].commitSha, undefined);
    assert.equal(st.lastReview?.mustFix[0], "look the surface");
    assert.match(
      fs.readFileSync(path.join(cycleArtifactsDir(sid, 1), "review.md"), "utf8"),
      /Verdict: blocked\nMust-fix:\n- look the surface/,
    );
  });

  it("a CLI cycle whose proof is npm test may still ship when the look could not run", async () => {
    const sid = "orch2-look-gate-cli";
    armWithPlan({
      sessionId: sid,
      cwd,
      verifyCommand: "npm test",
      maxCycles: 1,
      items: [{ title: "ship the widget", proof: "npm test" }],
    });
    const { rt } = fakeRuntime(cwd, {
      twoTurn: true,
      reviewer: [
        `# Cycle 1 look\nLooked: could not run — Playwright MCP never initialized`,
        REVIEW_OK,
      ],
    });
    const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
    assert.ok(r?.committed?.sha, "not a surface sit — CLI/JSON-RPC proofs still ship");
    assert.equal(loadCycleState(sid)!.cycles[0].reviewVerdict, "ship");
  });

  it("FORGE_ULW_LOOK_GATE=0 lets a surface ship commit without a look", async () => {
    const prev = process.env.FORGE_ULW_LOOK_GATE;
    process.env.FORGE_ULW_LOOK_GATE = "0";
    try {
      const sid = "orch2-look-gate-off";
      armWithPlan({
        sessionId: sid,
        cwd,
        verifyCommand: "npm test",
        maxCycles: 1,
        items: [{ title: "Stay dock leftover", proof: "open leftover door" }],
      });
      const { rt } = fakeRuntime(cwd, {
        twoTurn: true,
        reviewer: [
          `# Cycle 1 look\nLooked: Playwright MCP never initialized`,
          REVIEW_OK,
        ],
      });
      const r = await evaluateCycleAtStop(sid, { runtime: rt, facts: facts() });
      assert.ok(r?.committed?.sha);
      assert.equal(loadCycleState(sid)!.cycles[0].reviewVerdict, "ship");
    } finally {
      if (prev === undefined) delete process.env.FORGE_ULW_LOOK_GATE;
      else process.env.FORGE_ULW_LOOK_GATE = prev;
    }
  });
});
