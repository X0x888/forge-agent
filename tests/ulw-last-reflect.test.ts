/**
 * LAST reflect: score this run after wrap, at most one must-fix close-out.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseLastScorecard,
  applyLastReflectGate,
  lastReflectEnabled,
} from "../src/harness/last-reflect.js";
import {
  armUlwCycle,
  evaluateUlwAtStop,
  loadUlwCycle,
  setCycleFlag,
  setMaxWaves,
  disarmUlwCycle,
} from "../src/harness/ulw-cycle.js";
import { armUlwReady, lastAttest } from "./helpers/ulw-arm.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

describe("parseLastScorecard", () => {
  it("is absent without Must-fix", () => {
    const c = parseLastScorecard("**Cycle complete.**\n✅ tests green");
    assert.equal(c.present, false);
    assert.deepEqual(c.mustFix, []);
  });

  it("parses Must-fix: none", () => {
    const c = parseLastScorecard(
      "**Cycle complete.**\nMust-fix: none\nLive-with: python -c when sandbox=off",
    );
    assert.equal(c.present, true);
    assert.deepEqual(c.mustFix, []);
  });

  it("parses Must-fix bullets", () => {
    const c = parseLastScorecard(`## LAST scorecard
Must-fix:
- src/foo.ts:12 — land=discard deletes the worktree
- src/bar.ts:3 — journal stamps live turnCount
Live-with:
- python -c when sandbox=off
`);
    assert.equal(c.present, true);
    assert.equal(c.mustFix.length, 2);
    assert.match(c.mustFix[0]!, /land=discard/);
    assert.match(c.mustFix[1]!, /turnCount/);
  });
});

describe("applyLastReflectGate", () => {
  it("does not steal wrap when pending and no scorecard", () => {
    const s: { lastReflect?: "pending" | "score" } = { lastReflect: "pending" };
    const r = applyLastReflectGate(s, "still wrapping", { attested: false });
    assert.equal(r.block, false);
    assert.equal(s.lastReflect, "pending");
  });

  it("enters score on Cycle complete without a card", () => {
    const s = { lastReflect: "pending" as const, lastReflectScoreDemands: 0 };
    const r = applyLastReflectGate(s, "**Cycle complete.** ✅ tests", {
      attested: true,
    });
    assert.equal(r.block, true);
    assert.equal(r.lastReflectDemanded, true);
    assert.equal(s.lastReflect, "score");
    assert.match(r.reanchor || "", /LAST reflect \(score this run\)/i);
  });

  it("skips close-out when Must-fix: none", () => {
    const s = { lastReflect: "score" as const };
    const r = applyLastReflectGate(s, "Must-fix: none\nLive-with: chrome");
    assert.equal(r.block, false);
    assert.equal(s.lastReflect, "done");
  });

  it("enters one close-out when Must-fix has holes", () => {
    const s = { lastReflect: "score" as const };
    const r = applyLastReflectGate(
      s,
      "Must-fix:\n- src/a.ts:1 — hole\nLive-with:\n- leftover chrome",
    );
    assert.equal(r.block, true);
    assert.equal(r.lastReflectCloseout, true);
    assert.equal(s.lastReflect, "closeout");
    assert.equal(s.lastReflectMustFix, 1);
    assert.match(r.reanchor || "", /src\/a\.ts:1/);
  });

  it("close-out Stop without edits stays blocked", () => {
    const s = {
      lastReflect: "closeout" as const,
      lastReflectMustFix: 1,
      lastReflectHoles: ["src/a.ts:1 — hole"],
    };
    const r = applyLastReflectGate(s, "**Cycle complete.** ✅ tests", {
      attested: true,
      editDelta: 0,
    });
    assert.equal(r.block, true);
    assert.equal(s.lastReflect, "closeout");
  });

  it("close-out Stop with edits finishes reflect", () => {
    const s = { lastReflect: "closeout" as const, lastReflectMustFix: 1 };
    const r = applyLastReflectGate(s, "**Cycle complete.** Must-fix closed.", {
      editDelta: 2,
    });
    assert.equal(r.block, false);
    assert.equal(s.lastReflect, "done");
  });

  it("fail-open after two missing scorecards", () => {
    const s = { lastReflect: "score" as const, lastReflectScoreDemands: 0 };
    applyLastReflectGate(s, "no card", { attested: true });
    applyLastReflectGate(s, "still no card", { attested: true });
    const r = applyLastReflectGate(s, "third", { attested: true });
    assert.equal(r.block, false);
    assert.equal(s.lastReflect, "done");
  });
});

describe("evaluateUlwAtStop LAST reflect", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) {
      try {
        fs.rmSync(h, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
    delete process.env.FORGE_ULW_LAST_REFLECT;
  });

  function home(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ulw-lr-"));
    homes.push(d);
    process.env.FORGE_HOME = d;
    return d;
  }

  it("bounces Cycle complete without a scorecard, then releases on Must-fix: none", () => {
    home();
    const sid = "lr-none";
    armUlwReady(sid, "ship it", { cycle: 1, maxWaves: 1, skipCheckpoint: true });
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "Wave shipped: the one ship",
      editCount: 2,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    assert.equal(loadUlwCycle(sid)?.cycle, 0);
    assert.equal(loadUlwCycle(sid)?.lastReflect, "pending");

    const bounce = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "**Cycle complete.**\n✅ npm test — 3 passed",
      editCount: 2,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationPassed: true,
    });
    assert.equal(bounce.block, true);
    assert.equal(bounce.lastReflectDemanded, true);
    assert.equal(loadUlwCycle(sid)?.lastReflect, "score");

    const done = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: lastAttest(
        "**Cycle complete.**\n✅ npm test — 3 passed",
      ),
      editCount: 2,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationPassed: true,
    });
    assert.equal(done.block, false);
    assert.equal(done.lastCycleReleased, true);
    disarmUlwCycle(sid);
  });

  it("one must-fix close-out then Cycle complete", () => {
    home();
    const sid = "lr-close";
    armUlwReady(sid, "ship it", { cycle: 1, skipCheckpoint: true });
    setCycleFlag(sid, 0);
    const score = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: `**Cycle complete.**
✅ typecheck green
Must-fix:
- src/foo.ts:9 — land=discard deletes the only copy
Live-with:
- python -c when sandbox=off`,
      editCount: 4,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationPassed: true,
    });
    assert.equal(score.block, true);
    assert.equal(score.lastReflectCloseout, true);
    assert.equal(loadUlwCycle(sid)?.lastReflect, "closeout");

    const done = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: lastAttest(
        "**Cycle complete.**\n✅ land=discard keeps incomplete worktrees\n✅ typecheck green",
      ),
      editCount: 6,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationPassed: true,
    });
    assert.equal(done.block, false);
    assert.equal(done.lastCycleReleased, true);
    assert.equal(loadUlwCycle(sid)?.lastReflect, "done");
    disarmUlwCycle(sid);
  });

  it("FORGE_ULW_LAST_REFLECT=0 skips to Cycle complete", () => {
    home();
    process.env.FORGE_ULW_LAST_REFLECT = "0";
    assert.equal(lastReflectEnabled(), false);
    const sid = "lr-off";
    armUlwReady(sid, "ship it", { cycle: 1, skipCheckpoint: true });
    setMaxWaves(sid, 1);
    evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "Wave shipped",
      editCount: 1,
      openTodoCount: 0,
      stuckThreshold: 20,
    });
    const done = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "**Cycle complete.**\n✅ npm test — 1 passed",
      editCount: 1,
      openTodoCount: 0,
      stuckThreshold: 20,
      verificationPassed: true,
    });
    assert.equal(done.block, false);
    assert.equal(done.lastCycleReleased, true);
    disarmUlwCycle(sid);
  });

  it("score phase denies writes even under yolo", async () => {
    home();
    const g = new PermissionGate({ interactive: false });
    const r = await g.request({
      toolName: "write_file",
      input: { path: "src/a.ts", content: "x" },
      mode: "bypassPermissions",
      workspace: "/tmp/proj",
      config: DEFAULT_CONFIG,
      ulwLastReflectScore: true,
    });
    assert.equal(r.decision, "deny");
    assert.equal(r.rule, "ulw_last_score");
    const git = await g.request({
      toolName: "bash",
      input: { command: "git log --oneline" },
      mode: "bypassPermissions",
      workspace: "/tmp/proj",
      config: DEFAULT_CONFIG,
      ulwLastReflectScore: true,
    });
    assert.equal(git.decision, "allow");
  });
});
