/**
 * Decision memory keeps what the run stands on.
 *
 * Both 400-record dogfood runs had lost their `MANDATE:` constraint: the
 * oldest-first slice evicted it under 200 wave observations and 107
 * duplicate `Job:` rows. Trim order is superseded → excess waves → oldest
 * non-durable; durable kinds, MANDATE, Bet and the first Reading survive.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendMemoryRecord,
  loadDecisionMemory,
  recordWaveObservation,
  seedMemoryFromMandate,
  supersedeMemoryRecords,
  trimDecisionRecords,
  WAVE_RECORDS_KEEP,
  activeMemoryRecords,
  type MemoryRecord,
} from "../src/harness/decision-memory.js";
import { harvestProductQualityNotes } from "../src/harness/product-quality.js";

function withHome(fn: (home: string) => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-memtrim-"));
  process.env.FORGE_HOME = dir;
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let seq = 0;
function rec(
  kind: MemoryRecord["kind"],
  text: string,
  extra?: Partial<MemoryRecord>,
): MemoryRecord {
  seq += 1;
  return {
    id: `r${seq}`,
    at: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    kind,
    text,
    source: "harness",
    status: "active",
    ...extra,
  };
}

describe("trimDecisionRecords", () => {
  it("evicts wave observations before the mandate and the first Reading", () => {
    const records: MemoryRecord[] = [
      rec("constraint", "MANDATE: Improve the UI, UX, performance, reliability of this tool comprehensively.", { source: "ulw" }),
      rec("decision", "Reading: Product is a menu-bar isolator. ONE ship: hotkey pause. Verify: ./build.sh --self-test", { source: "agent" }),
      rec("priority", "Bet: one-command CSV export — src/export/csv.ts — first slice: rows", { source: "harness" }),
    ];
    for (let i = 0; i < 300; i++) records.push(rec("wave", `w${i + 1}: +6e proof=✗`));
    for (let i = 0; i < 120; i++) records.push(rec("decision", `Job: reading ${i}`, { source: "agent" }));
    assert.equal(records.length, 423);
    const out = trimDecisionRecords(records, 400);
    assert.equal(out.length, 400);
    assert.ok(out.some((r) => /^MANDATE:/.test(r.text)), "mandate survives");
    assert.ok(out.some((r) => /^Reading: Product is a menu-bar isolator/.test(r.text)), "first Reading survives");
    assert.ok(out.some((r) => /^Bet:/.test(r.text)), "bet survives");
    // Only waves were dropped — the newest waves are kept.
    const waves = out.filter((r) => r.kind === "wave");
    assert.equal(waves.length, 300 - 23);
    assert.equal(waves[0]!.text, "w24: +6e proof=✗");
    assert.equal(out.filter((r) => /^Job:/.test(r.text)).length, 120);
  });

  it("never drops below WAVE_RECORDS_KEEP waves while non-durable decisions can go first", () => {
    const records: MemoryRecord[] = [
      rec("constraint", "MANDATE: improve the code", { source: "ulw" }),
      rec("decision", "Reading: first plan. Verify: npm test", { source: "agent" }),
    ];
    for (let i = 0; i < 60; i++) records.push(rec("wave", `w${i + 1}: +3e proof=✓`));
    for (let i = 0; i < 400; i++) records.push(rec("decision", `Job: churn ${i}`, { source: "agent" }));
    const out = trimDecisionRecords(records, 400);
    assert.equal(out.length, 400);
    assert.equal(out.filter((r) => r.kind === "wave").length, WAVE_RECORDS_KEEP);
    assert.ok(out.some((r) => /^MANDATE:/.test(r.text)));
    assert.equal(out.find((r) => /^Reading:/.test(r.text))?.text, "Reading: first plan. Verify: npm test");
    // Oldest Job: rows went first.
    assert.equal(out.some((r) => r.text === "Job: churn 0"), false);
    assert.equal(out.some((r) => r.text === "Job: churn 399"), true);
  });

  it("drops superseded history before anything active", () => {
    const records: MemoryRecord[] = [rec("constraint", "MANDATE: x", { source: "ulw" })];
    for (let i = 0; i < 30; i++) records.push(rec("decision", `Job: old ${i}`, { source: "agent", status: "superseded" }));
    for (let i = 0; i < 380; i++) records.push(rec("decision", `fact ${i}`, { source: "agent" }));
    const out = trimDecisionRecords(records, 400);
    assert.equal(out.length, 400);
    assert.equal(out.filter((r) => r.status === "superseded").length, 19);
    assert.equal(out.filter((r) => /^fact /.test(r.text)).length, 380);
  });

  it("is a no-op under the cap", () => {
    const records = [rec("constraint", "MANDATE: x"), rec("wave", "w1: +1e")];
    assert.deepEqual(trimDecisionRecords(records, 400), records);
  });
});

describe("decision memory store hygiene", () => {
  it("a 450-wave run still has its MANDATE constraint and Wave-1 Reading on disk", () => {
    withHome(() => {
      const sid = "mem-long-run";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
      seedMemoryFromMandate(sid, "Improve the UI, UX, performance, reliability of this tool comprehensively.", {
        softPrompt: true,
      });
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: "Reading: Product is a folder messenger. ONE ship: DaemonRecovery on first launch. Verify: npm test",
      });
      for (let w = 1; w <= 450; w++) {
        recordWaveObservation(sid, w, `+6e proof=✗ — w${w} ship`);
      }
      const store = loadDecisionMemory(sid);
      assert.ok(store.records.length <= 400);
      assert.ok(store.records.some((r) => /^MANDATE: Improve the UI/.test(r.text)), "mandate kept");
      assert.ok(store.records.some((r) => /^Reading: Product is a folder messenger/.test(r.text)), "reading kept");
      const waves = store.records.filter((r) => r.kind === "wave");
      // Waves fill the slack under the cap (they are facts) but are the
      // first to go when something else needs the room; the oldest went.
      assert.ok(waves.length >= WAVE_RECORDS_KEEP);
      assert.equal(waves.some((r) => /^w1:/.test(r.text)), false, "oldest wave evicted");
      assert.match(waves.at(-1)!.text, /w450/);
      // A new Reading after the cap evicts a wave, never the mandate.
      appendMemoryRecord(sid, {
        kind: "decision",
        source: "agent",
        text: "Reading: re-PLAN — first launch when the daemon never comes up. Verify: npm test",
      });
      const after = loadDecisionMemory(sid);
      assert.ok(after.records.length <= 400);
      assert.ok(after.records.some((r) => /^MANDATE: Improve the UI/.test(r.text)));
      assert.ok(after.records.some((r) => /^Reading: re-PLAN/.test(r.text)));
      assert.equal(after.records.filter((r) => r.kind === "wave").length, waves.length - 1);
    });
  });

  it("Job: and Next need: are one-slot notes — a new Reading supersedes the previous", () => {
    withHome(() => {
      const sid = "mem-job-slot";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
      harvestProductQualityNotes(sid, "Reading: Product is a menu-bar isolator. Job: hotkey pause during login. Next need: wake-safe rebuild.");
      harvestProductQualityNotes(sid, "Reading: Product is a menu-bar isolator. Job: allowed-apps icon for running Dock apps. Next need: icon cache.");
      harvestProductQualityNotes(sid, "Reading: Product is a menu-bar isolator. Job: quit-and-restore menu title. Next need: quit safety.");
      const active = activeMemoryRecords(sid);
      const jobs = active.filter((r) => /^Job:/.test(r.text));
      const needs = active.filter((r) => /^Next need:/.test(r.text));
      assert.equal(jobs.length, 1);
      assert.match(jobs[0]!.text, /quit-and-restore/);
      assert.equal(needs.length, 1);
      assert.match(needs[0]!.text, /quit safety/);
      const all = loadDecisionMemory(sid).records;
      assert.equal(all.filter((r) => /^Job:/.test(r.text) && r.status === "superseded").length, 2);
      // Same Reading again does not churn the slot.
      harvestProductQualityNotes(sid, "Reading: Product is a menu-bar isolator. Job: quit-and-restore menu title. Next need: quit safety.");
      assert.equal(loadDecisionMemory(sid).records.filter((r) => /^Job:/.test(r.text)).length, 3);
    });
  });

  it("supersedeMemoryRecords marks only matching active rows", () => {
    withHome(() => {
      const sid = "mem-supersede";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
      appendMemoryRecord(sid, { kind: "decision", source: "agent", text: "Job: a" });
      appendMemoryRecord(sid, { kind: "decision", source: "agent", text: "Reading: keep me. Verify: npm test" });
      const n = supersedeMemoryRecords(sid, (r) => r.text.startsWith("Job:"));
      assert.equal(n, 1);
      const active = activeMemoryRecords(sid).map((r) => r.text);
      assert.deepEqual(active, ["Reading: keep me. Verify: npm test"]);
      assert.equal(supersedeMemoryRecords(sid, (r) => r.text.startsWith("Job:")), 0);
    });
  });
});
