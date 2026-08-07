import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  seedMemoryFromMandate,
  formatMemoryForPrompt,
  appendMemoryRecord,
  extractMandateBullets,
  isBroadMandate,
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
    const bullets = extractMandateBullets(m);
    assert.ok(bullets.length >= 4);
    const todos = todosFromMandate(m);
    assert.ok(todos.length >= 4);
    assert.equal(todos[0]!.status, "pending");
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
