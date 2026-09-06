import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  seedMemoryFromMandate,
  formatMemoryForPrompt,
  selectMemoryForPrompt,
  appendMemoryRecord,
  extractMandateBullets,
  loadDecisionMemory,
  copyDecisionMemory,
  decisionMemoryPath,
} from "../src/harness/decision-memory.js";
import { compactMessagesStructured } from "../src/session/compaction.js";
import { armWithPlan } from "./helpers/cycle-arm.js";
import { expandMessagesForVision } from "../src/agent/loop.js";
import type { ChatMessage } from "../src/providers/types.js";

describe("decision memory (Phase 1–5)", () => {
  let home: string;
  let prevHome: string | undefined;

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mem-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = home;
  });

  after(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("extracts bullets from a multi-section mandate and leaves a verb-order sentence whole", () => {
    const m = `
Please comprehensively audit and improve this app:
- Reliability: no false signed out
- Accuracy: numbers match
- First-run under 2 minutes
- macOS polish
- Privacy & security
`;
    const bullets = extractMandateBullets(m);
    assert.ok(bullets.length >= 4);
    const short =
      "comprehensively evaluate this tool and then improve the ui and ux of it.";
    const clauses = extractMandateBullets(short);
    assert.equal(clauses.length, 2, "an explicit 'then' checklist splits in two");
  });

  it("seeds MANDATE: plus bullets as priorities/constraints", () => {
    const sid = "sess-seed";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    seedMemoryFromMandate(
      sid,
      "Improve reliability:\n- no false signed out\n- multi-account works\n- tray sync\n- privacy",
      { force: true },
    );
    const store = loadDecisionMemory(sid);
    assert.ok(store.records.some((r) => /^MANDATE:/i.test(r.text)));
    const prios = store.records.filter((r) => r.status === "active" && r.kind === "priority");
    assert.equal(prios.length, 3, "first three bullets are priorities");
    assert.equal(
      store.records.some((r) => /Soft mandate|Broad mandate|Mandate verbs/i.test(r.text)),
      false,
      "no classifier-seeded doctrine rows",
    );
  });

  it("keeps durable rows, the last two plans and the newest notes", () => {
    const recs = [
      {
        id: "1",
        at: "1",
        kind: "constraint" as const,
        text: "MANDATE: evaluate then improve",
        source: "ulw" as const,
        status: "active" as const,
      },
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `p${i}`,
        at: String(2 + i),
        kind: "decision" as const,
        text: `Plan ${i + 1}: theme ${i + 1}`,
        source: "harness" as const,
        status: "active" as const,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `s${i}`,
        at: String(10 + i),
        kind: "decision" as const,
        text: `note ${i}`,
        source: "agent" as const,
        status: "active" as const,
      })),
    ];
    const kept = selectMemoryForPrompt(recs);
    assert.ok(kept.some((r) => /MANDATE/.test(r.text)));
    assert.deepEqual(
      kept.filter((r) => /^Plan/.test(r.text)).map((r) => r.text),
      ["Plan 3: theme 3", "Plan 4: theme 4"],
    );
    assert.equal(kept.filter((r) => /^note/.test(r.text)).length, 8);
    assert.ok(kept.some((r) => r.text === "note 19"));
    assert.equal(kept.some((r) => r.text === "note 0"), false);
  });

  it("seeds and formats durable constraints", () => {
    const sid = "sess-mem-1";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    const r = seedMemoryFromMandate(sid, "P0 fix auth. P1 polish UI.");
    assert.ok(r.seeded >= 1);
    const fmt = formatMemoryForPrompt(sid);
    assert.ok(fmt.activeCount >= 1);
    assert.match(fmt.text, /MANDATE|auth|P0/i);
    assert.ok(fs.existsSync(decisionMemoryPath(sid)));
  });

  it("compact preserves decision section", () => {
    const sid = "sess-mem-compact";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    seedMemoryFromMandate(sid, "Never weaken tests. Fix the race in auth.", {
      force: true,
    });
    appendMemoryRecord(sid, {
      kind: "out_of_scope",
      text: "Do not redesign marketing site",
      source: "user",
    });
    const msgs: ChatMessage[] = [
      { role: "system", content: "You are Forge" },
      ...Array.from({ length: 30 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `turn ${i} lorem ipsum filler content for compact window`,
      })),
    ];
    const ulw = armWithPlan({
      sessionId: sid,
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "forge-arm-")),
      mandate: "Never weaken tests. Fix the race in auth.",
    });
    const result = compactMessagesStructured(msgs, {
      keepLast: 4,
      context: { sessionId: sid, ulw, todos: [] },
    });
    assert.ok(result.droppedCount > 0);
    assert.match(result.summary, /Decisions|constraints|Never weaken|auth/i);
  });

  it("context-admit surfaces new decisions without a Stop", async () => {
    const { snapshotHarness, admitHarnessIfChanged, clearAdmittedFingerprints } =
      await import("../src/harness/context-admit.js");
    const sid = "sess-admit-mem";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    clearAdmittedFingerprints(sid);
    const base = {
      ulw: null,
      goal: null,
      todos: [] as { id: string; content: string; status: "pending" }[],
      permissionMode: "default",
      sessionId: sid,
    };
    const empty = snapshotHarness(base);
    admitHarnessIfChanged(sid, empty);
    appendMemoryRecord(sid, {
      kind: "constraint",
      text: "Do not weaken Stop fail-closed",
      source: "agent",
    });
    const next = snapshotHarness(base);
    const msg = admitHarnessIfChanged(sid, next);
    assert.ok(msg);
    assert.match(msg!, /Active decisions/);
    assert.match(msg!, /Do not weaken Stop fail-closed/);
    clearAdmittedFingerprints(sid);
  });

  it("ship-log memory_write does not re-admit; a new constraint does", async () => {
    const { snapshotHarness, admitHarnessIfChanged, clearAdmittedFingerprints } =
      await import("../src/harness/context-admit.js");
    const {
      durableMemoryFingerprint,
    } = await import("../src/harness/decision-memory.js");
    const sid = "sess-admit-shiplog";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    clearAdmittedFingerprints(sid);
    appendMemoryRecord(sid, {
      kind: "constraint",
      text: "MANDATE: evaluate then improve the daily REPL",
      source: "ulw",
    });
    const base = {
      ulw: null,
      goal: null,
      todos: [] as { id: string; content: string; status: "pending" }[],
      permissionMode: "default",
      sessionId: sid,
    };
    const first = snapshotHarness(base);
    // Idle first admit (no ULW/goal) is silent unless git is present —
    // still records the fingerprint so later deltas can be judged.
    admitHarnessIfChanged(sid, first);
    const fp0 = durableMemoryFingerprint(sid);
    appendMemoryRecord(sid, {
      kind: "decision",
      text: "Wave 3 shipped: strip last-verify dump from /model",
      source: "agent",
    });
    appendMemoryRecord(sid, {
      kind: "decision",
      text: "Reading: daily REPL trust beats chrome.",
      source: "agent",
    });
    assert.equal(durableMemoryFingerprint(sid), fp0);
    const afterShip = snapshotHarness(base);
    assert.equal(
      admitHarnessIfChanged(sid, afterShip, {
        suppressCounterOnlyChanges: true,
      }),
      null,
    );
    appendMemoryRecord(sid, {
      kind: "constraint",
      text: "Never weaken blocking Stop",
      source: "agent",
    });
    const afterConstraint = snapshotHarness(base);
    const msg = admitHarnessIfChanged(sid, afterConstraint, {
      suppressCounterOnlyChanges: true,
    });
    assert.ok(msg);
    assert.match(msg!, /Never weaken blocking Stop/);
    clearAdmittedFingerprints(sid);
  });

  it("markHarnessAdmitted suppresses the next admit for the same snap", async () => {
    const {
      snapshotHarness,
      admitHarnessIfChanged,
      markHarnessAdmitted,
      clearAdmittedFingerprints,
    } = await import("../src/harness/context-admit.js");
    const sid = "sess-mark-admitted";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    clearAdmittedFingerprints(sid);
    appendMemoryRecord(sid, {
      kind: "constraint",
      text: "MANDATE: evaluate then improve",
      source: "ulw",
    });
    const ulw = armWithPlan({
      sessionId: sid,
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "forge-arm-")),
      mandate: "evaluate then improve",
      maxCycles: 4,
    });
    const snap = snapshotHarness({
      ulw,
      goal: null,
      todos: [],
      permissionMode: "default",
      sessionId: sid,
    });
    markHarnessAdmitted(sid, snap);
    assert.equal(
      admitHarnessIfChanged(sid, snap, { suppressCounterOnlyChanges: true }),
      null,
    );
    const afterShip = snapshotHarness({
      ulw: { ...ulw, wave: 2, blocks: 2 },
      goal: null,
      todos: [],
      permissionMode: "default",
      sessionId: sid,
    });
    assert.equal(
      admitHarnessIfChanged(sid, afterShip, {
        suppressCounterOnlyChanges: true,
      }),
      null,
    );
    clearAdmittedFingerprints(sid);
  });

  it("emit:false updates the fingerprint without a user-channel dump", async () => {
    const { snapshotHarness, admitHarnessIfChanged, clearAdmittedFingerprints } =
      await import("../src/harness/context-admit.js");
    const sid = "sess-admit-silent";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    clearAdmittedFingerprints(sid);
    const ulw = armWithPlan({
      sessionId: sid,
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "forge-arm-")),
      mandate: "evaluate then improve",
      maxCycles: 4,
    });
    const snap = snapshotHarness({
      ulw,
      goal: null,
      todos: [],
      permissionMode: "default",
      sessionId: sid,
    });
    assert.equal(admitHarnessIfChanged(sid, snap, { emit: false }), null);
    assert.equal(admitHarnessIfChanged(sid, snap), null);
    clearAdmittedFingerprints(sid);
  });

  it("copyDecisionMemory clones to fork id", () => {
    const a = "sess-a";
    const b = "sess-b";
    fs.mkdirSync(path.join(home, "sessions", a), { recursive: true });
    seedMemoryFromMandate(a, "Keep multi-account failover working", {
      force: true,
    });
    copyDecisionMemory(a, b);
    const store = loadDecisionMemory(b);
    assert.ok(store.records.length >= 1);
    assert.equal(store.sessionId, b);
  });

});

describe("vision expand (Phase 6)", () => {
  it("leaves plain text alone", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hello without images" },
    ];
    const out = expandMessagesForVision(msgs, process.cwd());
    assert.equal(out.length, 1);
    assert.equal(out[0]!.content, "hello without images");
  });
});
