import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parsePeerScoutArtifact,
  peerScoutArtifactContract,
} from "../src/harness/cycle/artifacts.js";
import {
  buildPlannerScoutBrief,
  buildPlannerPlanBrief,
  buildReviewerLookBrief,
  formatPlanAdmission,
  runSpend,
} from "../src/harness/cycle/briefs.js";
import {
  ensurePeerScout,
  peerScoutEnabled,
  peerScoutFlush,
  resetPeerScoutJobsForTest,
  formatPeerScoutStatus,
  formatPeerScoutDock,
  formatPeerScoutCard,
  buildPeerScoutBrief,
  jobHypothesis,
  readPeerScoutArtifact,
  stopPeerScout,
} from "../src/harness/cycle/peer-scout.js";
import {
  newCycleState,
  loadCycleState,
  peerScoutArtifactPath,
  identitiesMatch,
  writeCycleState,
} from "../src/harness/cycle/state.js";
import { formatUlwStatus } from "../src/harness/cycle/status.js";
import type { CycleRuntime, CycleRole, RoleRunOptions, RoleRunResult } from "../src/harness/cycle/orchestrator.js";
import { githubSearchRequestPath } from "../src/agent/tools/github.js";
import { resolveRoleShape, filterToolsForSubagent, toolSetCanEdit } from "../src/agent/subagent.js";
import { ulwRoleInlineSkills } from "../src/util/product-kind.js";
import { mkGitRepo } from "./helpers/cycle-arm.js";

const STAGE1 = `# Peer scout — a CLI for tests
Stage: 1
Identity used: a CLI for tests
Peers:
- stingray-cli/stingray ★12000 · pushed 2026-08-01 — same job, sit-down keys
- shark/help ★4000 · pushed 2026-07-01 — --help matches behaviour
Not for us:
- plugin marketplace — different job
`;

const STAGE2 = `# Peer scout — a CLI for tests
Stage: 2
Identity used: a CLI for tests
Peers:
- stingray-cli/stingray ★12000 · pushed 2026-08-01 — same job
Sat:
- stingray --help: verbs first, errors keep data
- this tree --help: bare prompt, no recovery
Noticed:
- a demanding CLI user notices --help that matches behaviour
Not for us:
- plugin marketplace — different job
`;

const STAGE3 = `# Peer scout — a CLI for tests
Stage: 3
Identity used: a CLI for tests
Peers:
- stingray-cli/stingray ★12000 · pushed 2026-08-01 — same job
Sat:
- stingray --help: verbs first
Noticed:
- --help that matches behaviour
Not for us:
- plugin marketplace — different job
Candidates:
- --help does not match the verbs — serves: first-minute user — red now: unchecked — scout has not sat this binary — leave it if --help already lists them
`;

function fakeRt(cwd: string, scripts: string[]) {
  const calls: Array<{ role: CycleRole; opts: RoleRunOptions; brief: string }> = [];
  const cleaned: string[] = [];
  const queue = [...scripts];
  let n = 0;
  const rt: CycleRuntime = {
    workspace: cwd,
    async runRole(role, brief, opts) {
      calls.push({ role, opts, brief });
      n += 1;
      const text = queue.shift() ?? "";
      return {
        ok: Boolean(text),
        text,
        status: text ? "completed" : "error",
        promptTokens: 3,
        completionTokens: 2,
        editCount: 0,
        ...(opts.keepSession ? { sessionId: opts.resumeSessionId ?? `peer-sess-${n}` } : {}),
      } satisfies RoleRunResult;
    },
    async cleanupRoleSession(id) {
      cleaned.push(id);
    },
    async runCheck() {
      throw new Error("peer scout must not verify");
    },
    commit() {
      throw new Error("peer scout must not commit");
    },
    seedTodos() {},
    todos: () => [],
    admit() {
      throw new Error("peer scout must not admit to the executor");
    },
    gitHead: () => null,
    gitDiffSince: () => ({ diff: "", files: [], truncated: false }),
    gitLogSince: () => "",
    gitStatus: () => "",
    userMessagesSince: () => [],
    guidelineSurvey: () => "",
    projectChecks: () => [],
  };
  return { rt, calls, cleaned };
}

describe("peer scout", () => {
  let home: string;
  let cwd: string;
  let prevPeers: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-peers-"));
    prevHome = process.env.FORGE_HOME;
    prevPeers = process.env.FORGE_ULW_PEERS;
    process.env.FORGE_HOME = home;
    process.env.FORGE_ULW_PEERS = "1";
    cwd = mkGitRepo("forge-peers-ws-");
    fs.writeFileSync(path.join(cwd, "README.md"), "# Tool\nA CLI for tests.\n");
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "tool", bin: { tool: "./cli.js" } }));
    resetPeerScoutJobsForTest();
  });

  afterEach(async () => {
    resetPeerScoutJobsForTest();
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevPeers === undefined) delete process.env.FORGE_ULW_PEERS;
    else process.env.FORGE_ULW_PEERS = prevPeers;
  });

  it("is off under node:test unless FORGE_ULW_PEERS=1, and FORGE_ULW_PEERS=0 always wins", () => {
    delete process.env.FORGE_ULW_PEERS;
    assert.equal(peerScoutEnabled(), false, "node:test default is off so orchestrator tests do not race");
    process.env.FORGE_ULW_PEERS = "0";
    assert.equal(peerScoutEnabled(), false);
    process.env.FORGE_ULW_PEERS = "1";
    assert.equal(peerScoutEnabled(), true);
  });

  it("parses staged peers.md and rejects a missing Stage:", () => {
    const p = parsePeerScoutArtifact(STAGE3);
    assert.ok(p);
    assert.equal(p.stage, 3);
    assert.deepEqual(p.peers, ["stingray-cli/stingray"]);
    assert.ok(p.candidates.length);
    assert.ok(p.notForUs.length);
    assert.equal(parsePeerScoutArtifact("Peers:\n- x/y"), null);
    assert.ok(peerScoutArtifactContract().includes("Stage:"));
  });

  it("caps peers at three and skips junk without owner/repo", () => {
    const p = parsePeerScoutArtifact(`Stage: 1
Peers:
- alpha/one
- beta/two
- gamma/three
- delta/four
- just a sentence
`);
    assert.ok(p);
    assert.deepEqual(p.peers, ["alpha/one", "beta/two", "gamma/three"]);
  });

  it("runs three stages in the background, writes peers.md, then sleeps", async () => {
    const sid = "peer-run";
    const s = newCycleState({ sessionId: sid, mandate: null });
    s.enabled = true;
    s.phase = "execute";
    s.identity = "a CLI for tests";
    writeCycleState(s);
    const { rt, calls, cleaned } = fakeRt(cwd, [STAGE1, STAGE2, STAGE3]);
    ensurePeerScout(s, rt);
    await peerScoutFlush(sid);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.role === "peer-scout"));
    assert.equal(calls[0].opts.quiet, true);
    assert.ok(calls[0].opts.abort);
    assert.equal(calls[1].opts.resumeSessionId, "peer-sess-1");
    const disk = loadCycleState(sid)!;
    assert.equal(disk.peerScout?.status, "sleeping");
    assert.equal(disk.peerScout?.stage, 3);
    assert.deepEqual(disk.peerScout?.peers, ["stingray-cli/stingray"]);
    assert.match(readPeerScoutArtifact(sid), /Stage: 3/);
    assert.ok(fs.existsSync(path.join(home, "sessions", sid, "cycles", "1", "peers.md")));
    assert.ok(cleaned.includes("peer-sess-3") || cleaned.includes("peer-sess-1"));
    assert.match(formatPeerScoutStatus(disk), /sleeping/);
    assert.deepEqual(formatPeerScoutDock(disk), { text: "peers", style: "magenta" });
    assert.match(formatPeerScoutCard(disk), /stingray-cli\/stingray/);
    assert.match(formatUlwStatus(disk), /Peer scout: stage 3/);
  });

  it("does not admit into the executor transcript or call commit", async () => {
    const sid = "peer-no-admit";
    const s = newCycleState({ sessionId: sid, mandate: "add --version" });
    s.phase = "execute";
    s.identity = "a CLI for tests";
    writeCycleState(s);
    const { rt, calls } = fakeRt(cwd, [STAGE3]);
    ensurePeerScout(s, rt);
    await peerScoutFlush(sid);
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((c) => c.role === "peer-scout"));
  });

  it("re-aims when Identity: changes and does not restart a sleeping same-Identity scout", async () => {
    const sid = "peer-reaim";
    const s = newCycleState({ sessionId: sid, mandate: null });
    s.phase = "execute";
    s.identity = "a CLI for tests";
    writeCycleState(s);
    const first = fakeRt(cwd, [STAGE3]);
    ensurePeerScout(s, first.rt);
    await peerScoutFlush(sid);
    assert.equal(loadCycleState(sid)!.peerScout?.status, "sleeping");
    const n1 = first.calls.length;
    ensurePeerScout(loadCycleState(sid)!, first.rt);
    await peerScoutFlush(sid);
    assert.equal(first.calls.length, n1, "same Identity does not restart a sleeper");

    const live = loadCycleState(sid)!;
    live.identity = "a Godot action RPG, not a CLI";
    writeCycleState(live);
    const second = fakeRt(cwd, [
      STAGE1.replace("a CLI for tests", "a Godot action RPG"),
      STAGE2,
      STAGE3,
    ]);
    ensurePeerScout(live, second.rt);
    await peerScoutFlush(sid);
    assert.ok(second.calls.length >= 1, "Identity change re-aims");
    assert.match(second.calls[0].brief, /Identity has locked|re-name/i);
  });

  it("FORGE_ULW_PEERS=0 does not start a loop", async () => {
    process.env.FORGE_ULW_PEERS = "0";
    const sid = "peer-off";
    const s = newCycleState({ sessionId: sid, mandate: null });
    s.phase = "execute";
    s.identity = "a CLI";
    writeCycleState(s);
    const { rt, calls } = fakeRt(cwd, [STAGE3]);
    ensurePeerScout(s, rt);
    await peerScoutFlush(sid);
    assert.equal(calls.length, 0);
  });

  it("aborts an in-flight scout on stopPeerScout", async () => {
    const sid = "peer-stop";
    const s = newCycleState({ sessionId: sid, mandate: null });
    s.phase = "execute";
    s.identity = "a CLI for tests";
    writeCycleState(s);
    const { rt, calls } = fakeRt(cwd, [STAGE1, STAGE2, STAGE3]);
    rt.runRole = async (_role, _brief, opts) => {
      calls.push({ role: "peer-scout", opts, brief: _brief });
      await new Promise<void>((resolve) => {
        if (opts.abort?.aborted) {
          resolve();
          return;
        }
        opts.abort?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        ok: false,
        text: "",
        status: "error",
        promptTokens: 0,
        completionTokens: 0,
        editCount: 0,
        error: "aborted",
      };
    };
    ensurePeerScout(s, rt);
    await stopPeerScout(sid, rt);
    await peerScoutFlush(sid);
    assert.equal(calls.length, 1, "abort stops before later stages");
  });

  it("the Planner scout carries the note after Looked:; Reviewer and executor admission do not", () => {
    const s = newCycleState({ sessionId: "brief-peers", mandate: null });
    s.identity = "A CLI for tests.";
    s.peerScout = {
      status: "sleeping",
      stage: 3,
      peers: ["stingray-cli/stingray"],
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(peerScoutArtifactPath(s.sessionId)), { recursive: true });
    fs.writeFileSync(peerScoutArtifactPath(s.sessionId), STAGE3, "utf8");
    const scout = buildPlannerScoutBrief({
      state: s,
      workspace: cwd,
      gitStatus: "",
      projectChecks: [],
    });
    const proc = scout.split("## Procedure")[1] ?? "";
    const evidenceAt = proc.indexOf("## Category evidence");
    const lookedAt = proc.indexOf("Looked:");
    assert.ok(evidenceAt > 0, "category evidence is on the scout");
    assert.ok(lookedAt >= 0);
    assert.ok(evidenceAt > lookedAt, "procedure names Looked: before the peer note is offered");
    assert.match(scout, /read AFTER Looked:/);
    assert.match(scout, /stingray-cli\/stingray/);
    assert.match(scout, /Do not github-search the category/);

    const review = buildReviewerLookBrief({ state: s, workspace: cwd, direction: "help" });
    assert.doesNotMatch(review, /Category evidence/);
    assert.doesNotMatch(review, /stingray-cli/);

    const admit = formatPlanAdmission({
      cycle: 1,
      title: "help",
      planText: "# Cycle 1 plan\nDirection: help",
      items: [{ id: "i1", title: "help" }],
      verifyCommand: "npm test",
      maxCycles: null,
      cycleZeroRequested: false,
    });
    assert.doesNotMatch(admit, /peer scout/i);
    assert.doesNotMatch(admit, /stingray/);

    const plan = buildPlannerPlanBrief({
      state: s,
      workspace: cwd,
      gitLog: "",
      gitStatus: "",
      guidelineSurvey: "",
      projectChecks: [],
      userMessages: [],
      spend: runSpend(s),
      scoutText: "Looked: ran it",
    });
    assert.doesNotMatch(plan, /Category evidence \(peer scout/);
  });

  it("jobHypothesis reads README and kind from the tree", () => {
    const h = jobHypothesis(cwd);
    assert.match(h, /cli/i);
    assert.match(h, /CLI for tests/);
  });

  it("buildPeerScoutBrief asks for sort=stars and forbids scraping github.com", () => {
    const s = newCycleState({ sessionId: "b", mandate: null });
    s.identity = "a CLI";
    const b = buildPeerScoutBrief({
      state: s,
      workspace: cwd,
      target: 1,
      previous: "",
      job: "a CLI",
    });
    assert.match(b, /sort=stars/);
    assert.match(b, /not a scrape of github.com/);
    assert.match(b, /1–3/);
    assert.match(b, /executor never sees you/i);
  });

  it("identitiesMatch ignores whitespace and case", () => {
    assert.equal(identitiesMatch("A CLI for tests.", "a cli for   tests."), true);
    assert.equal(identitiesMatch("CLI", "Godot game"), false);
    assert.equal(identitiesMatch("", "x"), false);
  });
});

describe("github search sort", () => {
  it("omits sort by default and appends stars&order=desc when asked", () => {
    const bare = githubSearchRequestPath("cli rust", 5, { code: false });
    assert.ok("path" in bare);
    assert.equal(bare.path.includes("sort="), false);
    const stars = githubSearchRequestPath("cli rust", 5, { code: false, sort: "stars" });
    assert.ok("path" in stars);
    assert.match(stars.path, /sort=stars/);
    assert.match(stars.path, /order=desc/);
  });

  it("fails closed on invalid sort and on sort+code", () => {
    const bad = githubSearchRequestPath("x", 5, { code: false, sort: "best" });
    assert.ok("error" in bad);
    assert.match(bad.error, /stars \| forks \| updated/);
    const code = githubSearchRequestPath("x", 5, { code: true, sort: "stars" });
    assert.ok("error" in code);
    assert.match(code.error, /not code/);
  });
});

describe("peer-scout role shape", () => {
  it("is read-only, denyEdits, no spawn, github present, cannot edit", () => {
    const shape = resolveRoleShape("peer-scout");
    assert.equal(shape.capabilityMode, "read-only");
    assert.equal(shape.denyEdits, true);
    assert.equal(shape.allowSpawn, false);
    assert.equal(shape.subagentType, "explore");
    const names = filterToolsForSubagent(shape.capabilityMode, {
      allowSpawn: false,
      denyEdits: true,
    }).map((t) => t.function.name);
    assert.ok(names.includes("github"));
    assert.ok(names.includes("web_search"));
    assert.ok(!names.includes("write_file"));
    assert.ok(!names.includes("spawn_subagent"));
    assert.equal(toolSetCanEdit(filterToolsForSubagent(shape.capabilityMode, { denyEdits: true })), false);
  });

  it("inlines forge-peer-scout + veteran + the category skill", () => {
    const skills = ulwRoleInlineSkills("peer-scout", cwdForKind());
    assert.ok(skills.includes("forge-peer-scout"));
    assert.ok(skills.includes("forge-veteran"));
    assert.ok(skills.includes("forge-shape"));
    assert.ok(!skills.includes("forge-planner"));
  });
});

function cwdForKind(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "forge-peer-kind-"));
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ bin: { t: "./t.js" } }));
  return d;
}
