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
  isBroadMandate,
  isEvaluateClassMandate,
  hasMandateJudgment,
  hasUlwPlan,
  todosFromMandate,
  loadDecisionMemory,
  copyDecisionMemory,
  decisionMemoryPath,
} from "../src/harness/decision-memory.js";
import { compactMessagesStructured } from "../src/session/compaction.js";
import { armUlwCycle, evaluateUlwAtStop } from "../src/harness/ulw-cycle.js";
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

  it("extracts bullets and detects broad mandates", () => {
    const m = `
Please comprehensively audit and improve this app:
- Reliability: no false signed out
- Accuracy: numbers match
- First-run under 2 minutes
- macOS polish
- Privacy & security
`;
    assert.equal(isBroadMandate(m), true);
    const short =
      "comprehensively evaluate this tool and then improve the ui and ux of it.";
    assert.equal(
      isBroadMandate(short),
      false,
      "evaluate-then-improve is a verb order, not a ≥2-item backlog",
    );
    assert.equal(isEvaluateClassMandate(short), true);
    const clauses = extractMandateBullets(short);
    assert.equal(
      clauses.length,
      0,
      "verb-order sentence must not become evaluate+improve bullets",
    );
    const shortTodos = todosFromMandate(short);
    assert.equal(shortTodos.length, 1);
    assert.match(shortTodos[0]!.content, /evaluate/i);
    const bullets = extractMandateBullets(m);
    assert.ok(bullets.length >= 4);
    const todos = todosFromMandate(m);
    assert.ok(todos.length >= 4);
    assert.equal(todos[0]!.status, "pending");
  });

  it("does not seed evaluate+improve as two priorities", () => {
    const sid = "sess-no-split";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    seedMemoryFromMandate(
      sid,
      "comprehensively evaluate this tool and then improve the ui and ux of it.",
      { softPrompt: true, force: true },
    );
    const store = loadDecisionMemory(sid);
    const prios = store.records.filter(
      (r) => r.status === "active" && r.kind === "priority",
    );
    assert.equal(prios.length, 0, JSON.stringify(prios.map((r) => r.text)));
    assert.ok(
      store.records.some((r) => /Mandate verbs in order/i.test(r.text)),
    );
    assert.ok(store.records.some((r) => /^MANDATE:/i.test(r.text)));
    assert.equal(
      store.records.some((r) => /invents high-leverage/i.test(r.text)),
      false,
    );
  });

  it("treats a Reading: reply as mandate judgment", () => {
    const sid = "sess-judgment";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    assert.equal(hasMandateJudgment(sid, ""), false);
    assert.equal(
      hasMandateJudgment(
        sid,
        "Reading: highest-leverage work is a real TUI/REPL UX evaluation.",
      ),
      true,
    );
  });

  it("hasUlwPlan requires a Reading:, not a 40-char agent note", () => {
    const sid = "sess-ulw-plan";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    appendMemoryRecord(sid, {
      kind: "decision",
      text: "I will look around and maybe polish the HUD chrome today.",
      source: "agent",
    });
    assert.equal(hasMandateJudgment(sid, ""), true);
    assert.equal(hasUlwPlan(sid, ""), false);
    appendMemoryRecord(sid, {
      kind: "decision",
      text: "Reading: ship the setup card 1–6. Verify: npm test.",
      source: "agent",
    });
    assert.equal(hasUlwPlan(sid, ""), true);
    assert.equal(
      hasUlwPlan("", "Reading: fix foo.ts and run npm test after."),
      true,
    );
    assert.equal(
      hasUlwPlan("", "Reading: leftover chrome catalog of first 5 names."),
      false,
    );
  });

  it("keeps the reading and last ship logs, not 80 Wave siblings", () => {
    const recs = [
      {
        id: "1",
        at: "1",
        kind: "constraint" as const,
        text: "MANDATE: evaluate then improve",
        source: "ulw" as const,
        status: "active" as const,
      },
      {
        id: "2",
        at: "2",
        kind: "decision" as const,
        text: "Reading: daily REPL trust beats chrome.",
        source: "agent" as const,
        status: "active" as const,
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `s${i}`,
        at: String(10 + i),
        kind: "decision" as const,
        text: `Wave 2 sibling: clip widget ${i} to one TTY row`,
        source: "agent" as const,
        status: "active" as const,
      })),
      {
        id: "real",
        at: "99",
        kind: "decision" as const,
        text: "Wave 3 shipped the Memory Walk reskin with play-loop proof",
        source: "agent" as const,
        status: "active" as const,
      },
    ];
    const kept = selectMemoryForPrompt(recs);
    assert.ok(kept.some((r) => /MANDATE/.test(r.text)));
    assert.ok(kept.some((r) => /Reading:/.test(r.text)));
    assert.equal(
      kept.filter((r) => /Wave 2 sibling/.test(r.text)).length,
      0,
      "mill sibling ship logs must not crowd out Wave 1",
    );
    assert.ok(kept.some((r) => /Memory Walk reskin/.test(r.text)));
  });

  it("seeds and formats durable constraints", () => {
    const sid = "sess-mem-1";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    const r = seedMemoryFromMandate(sid, "P0 fix auth. P1 polish UI.", {
      softPrompt: false,
    });
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
    const ulw = armUlwCycle(sid, "Never weaken tests. Fix the race in auth.", {
      cycle: 1,
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
    const ulw = {
      enabled: true,
      cycle: 1 as const,
      wave: 1,
      maxWaves: 4,
      blocks: 1,
      mandate: "evaluate then improve",
      softPrompt: true,
    };
    const snap = snapshotHarness({
      ulw: ulw as never,
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
      ulw: { ...ulw, wave: 2, blocks: 2 } as never,
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
    const ulw = {
      enabled: true,
      cycle: 1 as const,
      wave: 0,
      maxWaves: 4,
      blocks: 0,
      mandate: "evaluate then improve",
      softPrompt: true,
    };
    const snap = snapshotHarness({
      ulw: ulw as never,
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

  it("broad ULW blocks invent until backlog (wave 0)", () => {
    const sid = "sess-backlog";
    fs.mkdirSync(path.join(home, "sessions", sid), { recursive: true });
    const mandate = `
Comprehensively improve reliability:
- No false signed out
- Multi-account works
- Tray sync
- Privacy
- Performance
`;
    armUlwCycle(sid, mandate, { cycle: 1, editCount: 0 });
    const d = evaluateUlwAtStop({
      sessionId: sid,
      lastAssistantMessage: "I will improve things now.",
      editCount: 0,
      openTodoCount: 0,
      stuckThreshold: 5,
    });
    assert.equal(d.block, true);
    assert.match(String(d.reanchor || d.reason), /backlog required/i);
    assert.match(String(d.reanchor || d.reason), /decisions\.json/);
    assert.doesNotMatch(String(d.reanchor || d.reason), /## Active decisions/);
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
