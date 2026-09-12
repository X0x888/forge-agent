import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cycleReportFacts, formatUlwStatus } from "../src/harness/cycle/status.js";
import { newCycleState, type CycleState } from "../src/harness/cycle/state.js";

function state(): CycleState {
  const s = newCycleState({ sessionId: "status-test", mandate: null });
  s.cycle = 2;
  s.phase = "execute";
  s.planTitle = "Stars stay tappable";
  s.identity = "A toolbar pet.";
  s.items = [{ id: "i1", title: "stars tappable under the lesson", files: [], status: "open" }];
  s.promises = [
    { text: "browsing feeds the pet", state: "kept", seen: "hunger rose" },
    { text: "tap a star to hunt", state: "broken", seen: "star under the overlay" },
    { text: "breeding", state: "absent" },
    { text: "no account, no server", state: "kept" },
  ];
  s.cycles = [
    {
      n: 1,
      title: "Toolbar face",
      startedAt: "t",
      endedAt: "t",
      itemsTotal: 2,
      itemsDone: 2,
      waves: 1,
      reviewVerdict: "ship",
      verifyCommand: "npm test",
      verifyPassed: true,
      commitSha: "abc1234",
      mustFix: [],
      worthClaim: "the icon is what a toolbar-pet user watches all day",
      worth: "yes — the badge moves when the pet eats",
    },
    { n: 2, title: "Stars stay tappable", startedAt: "t", itemsTotal: 1, itemsDone: 0, waves: 0, mustFix: [] },
  ];
  return s;
}

describe("/cycle status", () => {
  it("keeps untested promises visible as unknown, not broken or kept", () => {
    const s = state();
    s.promises!.push({ text: "Recovery after restart", state: "unknown", seen: "service unavailable" });
    assert.match(formatUlwStatus(s), /Promises: 2 kept · 1 broken · 1 absent · 1 unknown/);
    assert.ok(cycleReportFacts(s).notDone.includes("Promise unknown: Recovery after restart — service unavailable"));
  });

  it("tallies the promises and shows the Reviewer's worth beside the Planner's claim", () => {
    const text = formatUlwStatus(state());
    assert.match(text, /Promises: 2 kept · 1 broken · 1 absent/);
    assert.match(text, /c1 · Toolbar face · 2\/2 · 1w · ship · verify ✓ · abc1234 · worth yes \(claimed\)/);
    assert.match(text, /c2 · Stars stay tappable · 0\/1 · 0w · open/);
  });

  it("green vs baseline names the inherited reds instead of a bare tick", () => {
    const s = state();
    s.cycles[0].verifyInherited = 12;
    const text = formatUlwStatus(s);
    assert.match(text, /verify ✓ vs baseline \(12 pre-existing still red\)/);
    assert.doesNotMatch(text, /verify ✓ · abc1234/);
    const facts = cycleReportFacts(s);
    assert.match(facts.verified[0] ?? "", /green vs baseline \(12 pre-existing still red\)/);
  });

  it("omits the promises line when none were recorded", () => {
    const s = state();
    delete s.promises;
    assert.doesNotMatch(formatUlwStatus(s), /Promises:/);
  });
});

describe("cycleReportFacts", () => {
  it("What shipped carries claimed vs found; Not done carries the broken and absent promises", () => {
    const f = cycleReportFacts(state());
    assert.match(f.shipped[0], /^Cycle 1 — Toolbar face: 2\/2 items, commit abc1234 · claimed: the icon is what a toolbar-pet user watches all day · found: yes — the badge moves when the pet eats$/);
    assert.ok(f.notDone.includes("Promise broken: tap a star to hunt — star under the overlay"));
    assert.ok(f.notDone.includes("Promise absent: breeding"));
    assert.ok(!f.notDone.some((l) => /browsing feeds the pet/.test(l)), "kept promises are not open work");
  });

  it("a cycle with only a finding, or only a claim, shows what it has", () => {
    const s = state();
    delete s.cycles[0].worthClaim;
    assert.match(cycleReportFacts(s).shipped[0], / · found: yes — the badge moves when the pet eats$/);
    assert.doesNotMatch(cycleReportFacts(s).shipped[0], /claimed:/);
    delete s.cycles[0].worth;
    s.cycles[0].worthClaim = "x";
    assert.match(cycleReportFacts(s).shipped[0], / · claimed: x$/);
  });
});
