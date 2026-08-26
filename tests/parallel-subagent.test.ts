import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolCall } from "../src/providers/types.js";
import {
  isReadOnlyToolName,
  isSpawnToolName,
  isParallelSafeToolCall,
  partitionParallelBatches,
  subagentParallelEnabled,
  type ParallelSafeOpts,
} from "../src/agent/loop.js";
import {
  childManagerAutostart,
  isSpawnParallelSafe,
  resolveSpawnSubagentType,
  wrapChildLoopEvents,
} from "../src/agent/subagent.js";
import { findGitRoot } from "../src/agent/worktree.js";
import { loadSessionMeta, sessionDir } from "../src/session/session.js";
import { forgeHome } from "../src/util/fs.js";

function tc(name: string, args: Record<string, unknown>, id = "c"): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function explore(id = "e"): ToolCall {
  return tc("spawn_subagent", { prompt: "map", description: "map", subagent_type: "explore" }, id);
}

function gpNone(id = "g"): ToolCall {
  return tc(
    "spawn_subagent",
    {
      prompt: "impl",
      description: "impl",
      subagent_type: "general-purpose",
      isolation: "none",
    },
    id,
  );
}

function web(q: string): ToolCall {
  return tc("web_search", { query: q }, `w-${q.slice(0, 8)}`);
}

describe("isReadOnlyToolName spawn pin", () => {
  it("spawn_subagent stays not read-only (parallel-safe is a different predicate)", () => {
    assert.equal(isReadOnlyToolName("spawn_subagent"), false);
    assert.equal(isSpawnToolName("spawn_subagent"), true);
    assert.equal(isSpawnToolName("Task"), true);
  });
});

describe("resolveSpawnSubagentType", () => {
  it("omitted is explore only when plan or orient", () => {
    assert.equal(resolveSpawnSubagentType(undefined, { ulwOrient: true }), "explore");
    assert.equal(resolveSpawnSubagentType("", { planMode: true }), "explore");
    assert.equal(resolveSpawnSubagentType(undefined, {}), "general-purpose");
    assert.equal(
      resolveSpawnSubagentType(undefined, {
        planMode: true,
        ulwLastReflectScore: true,
      }),
      "general-purpose",
    );
    assert.equal(
      resolveSpawnSubagentType("general-purpose", { ulwOrient: true }),
      "general-purpose",
    );
  });
});

describe("isSpawnParallelSafe + partitionParallelBatches", () => {
  const prevParallel = process.env.FORGE_SUBAGENT_PARALLEL;
  const prevIso = process.env.FORGE_SUBAGENT_ISOLATION;
  const prevHome = process.env.FORGE_HOME;
  let tmpHome = "";
  let nonGit = "";
  const gitRoot = findGitRoot(process.cwd()) || process.cwd();

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "forge-par-home-"));
    process.env.FORGE_HOME = tmpHome;
    nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "forge-par-nongit-"));
  });

  after(() => {
    if (prevParallel === undefined) delete process.env.FORGE_SUBAGENT_PARALLEL;
    else process.env.FORGE_SUBAGENT_PARALLEL = prevParallel;
    if (prevIso === undefined) delete process.env.FORGE_SUBAGENT_ISOLATION;
    else process.env.FORGE_SUBAGENT_ISOLATION = prevIso;
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* */
    }
    try {
      fs.rmSync(nonGit, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  const opts = (over: Partial<ParallelSafeOpts> = {}): ParallelSafeOpts => ({
    workspace: gitRoot,
    planOrOrient: false,
    ...over,
  });

  it("explore and plan are parallel-safe", () => {
    assert.equal(isSpawnParallelSafe(explore(), opts()), true);
    assert.equal(
      isSpawnParallelSafe(
        tc("spawn_subagent", { prompt: "p", subagent_type: "plan" }),
        opts(),
      ),
      true,
    );
  });

  it("GP + isolation=worktree is parallel-safe in a git repo", () => {
    assert.equal(
      isSpawnParallelSafe(
        tc("spawn_subagent", {
          prompt: "p",
          subagent_type: "general-purpose",
          isolation: "worktree",
        }),
        opts(),
      ),
      true,
    );
  });

  it("explicit isolation=none GP is a barrier even in PLAN", () => {
    assert.equal(isSpawnParallelSafe(gpNone(), opts({ planOrOrient: true })), false);
    assert.equal(
      isParallelSafeToolCall(gpNone(), opts({ planOrOrient: true })),
      false,
    );
  });

  it("omitted GP in a non-git workspace is not parallel-safe", () => {
    assert.equal(
      isSpawnParallelSafe(
        tc("spawn_subagent", { prompt: "p", description: "d" }),
        opts({ workspace: nonGit, planOrOrient: false }),
      ),
      false,
    );
  });

  it("unparseable arguments fail closed", () => {
    const bad: ToolCall = {
      id: "b",
      type: "function",
      function: { name: "spawn_subagent", arguments: "{not json" },
    };
    assert.equal(isSpawnParallelSafe(bad, opts()), false);
  });

  it("FORGE_SUBAGENT_PARALLEL=0 / disabled turns explore sequential", () => {
    process.env.FORGE_SUBAGENT_PARALLEL = "0";
    assert.equal(subagentParallelEnabled(), false);
    assert.equal(isParallelSafeToolCall(explore(), opts()), false);
    process.env.FORGE_SUBAGENT_PARALLEL = "disabled";
    assert.equal(subagentParallelEnabled(), false);
    delete process.env.FORGE_SUBAGENT_PARALLEL;
    assert.equal(subagentParallelEnabled(), true);
    assert.equal(isParallelSafeToolCall(explore(), opts()), true);
  });

  it("omitted type + planOrOrient is explore (even FORGE_SUBAGENT_ISOLATION=none)", () => {
    process.env.FORGE_SUBAGENT_ISOLATION = "none";
    assert.equal(
      isSpawnParallelSafe(
        tc("spawn_subagent", { prompt: "p", description: "d" }),
        opts({ planOrOrient: true }),
      ),
      true,
    );
    delete process.env.FORGE_SUBAGENT_ISOLATION;
  });

  it("resume uses loadSessionMeta only; missing stamp fails closed", () => {
    const id = "resumeWt1";
    const dir = sessionDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        id,
        cwd: gitRoot,
        provider: "xai",
        model: "grok-4.6",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        subagent: {
          parentId: "parent1",
          type: "general-purpose",
          isolation: "worktree",
          worktreePath: "/tmp/wt",
        },
      }),
      "utf8",
    );
    assert.ok(loadSessionMeta(id)?.subagent);
    assert.equal(
      isSpawnParallelSafe(
        tc("spawn_subagent", { resume_session_id: id }),
        opts(),
      ),
      true,
    );
    assert.equal(
      isSpawnParallelSafe(
        tc("spawn_subagent", { resume_session_id: "noSuchChild" }),
        opts(),
      ),
      false,
    );
    assert.equal(forgeHome(), tmpHome);
  });

  it("groups [explore, explore, web_search, GP-none, explore] as [3,1,1]", () => {
    const groups = partitionParallelBatches(
      [explore("a"), explore("b"), web("q"), gpNone("g"), explore("c")],
      opts({ planOrOrient: true }),
    );
    assert.deepEqual(
      groups.map((g) => g.length),
      [3, 1, 1],
    );
  });

  it("enter_plan_mode is a barrier, not a spawn batch mate", () => {
    const groups = partitionParallelBatches(
      [
        tc("enter_plan_mode", { reason: "stale reading" }, "enter"),
        explore("a"),
      ],
      opts({ planOrOrient: false }),
    );
    assert.deepEqual(
      groups.map((g) => g.length),
      [1, 1],
    );
  });

  it("omitted type after PLAN (planOrOrient false) + isolation=none is serial", () => {
    process.env.FORGE_SUBAGENT_ISOLATION = "none";
    const omitted = tc("spawn_subagent", {
      prompt: "p",
      description: "d",
    });
    assert.equal(
      isParallelSafeToolCall(omitted, opts({ planOrOrient: false })),
      false,
    );
    const groups = partitionParallelBatches(
      [omitted, omitted],
      opts({ planOrOrient: false }),
    );
    assert.deepEqual(
      groups.map((g) => g.length),
      [1, 1],
    );
    delete process.env.FORGE_SUBAGENT_ISOLATION;
  });
});

describe("wrapChildLoopEvents", () => {
  it("never forwards child onPhase(tool)", () => {
    const phases: string[] = [];
    const wrapped = wrapChildLoopEvents({
      onPhase: (p) => {
        phases.push(p);
      },
    });
    wrapped.onPhase?.("tool", "grep foo");
    wrapped.onPhase?.("thinking");
    assert.deepEqual(phases, ["thinking"]);
  });

  it("does not forward child onToolStart to the parent", () => {
    let starts = 0;
    const wrapped = wrapChildLoopEvents({
      onToolStart: () => {
        starts += 1;
      },
    });
    wrapped.onToolStart?.("grep", {});
    assert.equal(starts, 0);
    assert.equal(typeof wrapped.onToolStart, "function");
  });
});

describe("childManagerAutostart", () => {
  it("worktree + FORGE_SUBAGENT_CHILD_MCP=0 is false; in-place ignores the flag", () => {
    const prev = process.env.FORGE_SUBAGENT_CHILD_MCP;
    try {
      process.env.FORGE_SUBAGENT_CHILD_MCP = "0";
      assert.equal(childManagerAutostart("worktree"), false);
      assert.equal(childManagerAutostart("none"), true);
      delete process.env.FORGE_SUBAGENT_CHILD_MCP;
      assert.equal(childManagerAutostart("worktree"), true);
    } finally {
      if (prev === undefined) delete process.env.FORGE_SUBAGENT_CHILD_MCP;
      else process.env.FORGE_SUBAGENT_CHILD_MCP = prev;
    }
  });
});
