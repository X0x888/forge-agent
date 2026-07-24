import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatInterjection,
  formatUserQuery,
  formatInterjectionsMessage,
  pushInterjection,
  drainInterjections,
  clearInterjections,
  truncateUtf8,
  LARGE_INTERJECTION_THRESHOLD,
} from "../src/harness/interjection.js";
import {
  snapshotHarness,
  fingerprintSnapshot,
  admitHarnessIfChanged,
  renderHarnessAdmission,
  clearAdmittedFingerprints,
} from "../src/harness/context-admit.js";
import {
  evaluateTodoGateAtStop,
  maybeTodoNudge,
  noteTodoWrite,
  noteAssistantTurn,
  resetTodoNudgeForPrompt,
  clearTodoGateState,
} from "../src/harness/todo-gate.js";
import {
  buildStructuredSummary,
  compactMessagesStructured,
} from "../src/session/compaction.js";
import {
  buildBaselineSystemPrompt,
  resolvePromptProfile,
} from "../src/agent/system-prompt.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { armUlwCycle } from "../src/harness/ulw-cycle.js";
import { PermissionGate } from "../src/agent/permissions.js";
import type { ChatMessage } from "../src/providers/types.js";

describe("interjection (Grok-style)", () => {
  beforeEach(() => clearInterjections());

  it("wraps free-text with mid-turn note and user_query", () => {
    const out = formatInterjection("stop and fix the test first");
    assert.match(out, /The user sent a message while you were working/);
    assert.match(out, /<user_query>/);
    assert.match(out, /stop and fix the test first/);
    assert.match(formatUserQuery("hi"), /<user_query>\nhi\n<\/user_query>/);
  });

  it("queues and drains FIFO", () => {
    pushInterjection("s1", "one");
    pushInterjection("s1", "two");
    assert.deepEqual(drainInterjections("s1"), ["one", "two"]);
    assert.deepEqual(drainInterjections("s1"), []);
  });

  it("formats multi interjections under one envelope", () => {
    const msg = formatInterjectionsMessage(["a", "b"]);
    assert.match(msg, /while you were working/);
    assert.match(msg, /\(1\) a/);
    assert.match(msg, /\(2\) b/);
  });

  it("truncates large text at utf8 boundary", () => {
    // Content is capped at maxBytes; the "... [truncated]" suffix is appended after
    // (same as Grok interjection-core — total may slightly exceed the content cap).
    const s = "é".repeat(LARGE_INTERJECTION_THRESHOLD); // 2 bytes each → over cap
    const t = truncateUtf8(s, LARGE_INTERJECTION_THRESHOLD);
    assert.match(t, /\[truncated\]/);
    const body = t.replace(/\.\.\. \[truncated\]$/, "");
    assert.ok(Buffer.byteLength(body, "utf8") <= LARGE_INTERJECTION_THRESHOLD);
    assert.ok(Buffer.byteLength(body, "utf8") > 0);
    const framed = formatInterjection("x".repeat(30_000));
    assert.match(framed, /\[truncated\]/);
  });
});

describe("context admit (OpenCode-inspired)", () => {
  beforeEach(() => clearAdmittedFingerprints());

  it("skips empty first admit when harness idle", () => {
    const snap = snapshotHarness({
      ulw: null,
      goal: null,
      todos: [],
      permissionMode: "default",
    });
    assert.equal(admitHarnessIfChanged("sess-idle", snap), null);
  });

  it("admits when ULW state present and re-admits on change only", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-admit-"));
    process.env.FORGE_HOME = tmp;
    const sid = "admit-1";
    const ulw = armUlwCycle(sid, "improve the code", { cycle: 1 });
    const snap1 = snapshotHarness({
      ulw,
      goal: null,
      todos: [],
      permissionMode: "default",
    });
    const msg1 = admitHarnessIfChanged(sid, snap1);
    assert.ok(msg1);
    assert.match(msg1!, /Forge harness — mid-conversation/);
    assert.match(msg1!, /cycle=1/);
    assert.match(msg1!, /improve the code/);

    // Unchanged → null
    assert.equal(admitHarnessIfChanged(sid, snap1), null);

    // Wave change → new admission
    const snap2 = { ...snap1, wave: 3, blocks: 2 };
    const msg2 = admitHarnessIfChanged(sid, snap2);
    assert.ok(msg2);
    assert.match(msg2!, /wave=3/);
  });

  it("fingerprints distinguish open todos", () => {
    const a = snapshotHarness({
      ulw: null,
      goal: null,
      todos: [{ id: "1", content: "x", status: "pending" }],
      permissionMode: "default",
    });
    const b = snapshotHarness({
      ulw: null,
      goal: null,
      todos: [],
      permissionMode: "default",
    });
    assert.notEqual(fingerprintSnapshot(a), fingerprintSnapshot(b));
    assert.match(renderHarnessAdmission(a), /1 open/);
  });
});

describe("todo nudge + gate", () => {
  beforeEach(() => clearTodoGateState());

  it("nudges after several turns without todo_write under harness", () => {
    const sid = "nudge-1";
    resetTodoNudgeForPrompt(sid);
    assert.equal(
      maybeTodoNudge({ sessionId: sid, harnessActive: true, openTodoCount: 0 }),
      null,
    );
    noteAssistantTurn(sid);
    noteAssistantTurn(sid);
    noteAssistantTurn(sid);
    const msg = maybeTodoNudge({
      sessionId: sid,
      harnessActive: true,
      openTodoCount: 0,
    });
    assert.ok(msg);
    assert.match(msg!, /TodoNudge/);
  });

  it("resets nudge streak after todo_write", () => {
    const sid = "nudge-2";
    resetTodoNudgeForPrompt(sid);
    noteAssistantTurn(sid);
    noteAssistantTurn(sid);
    noteAssistantTurn(sid);
    noteTodoWrite(sid, 3);
    assert.equal(
      maybeTodoNudge({ sessionId: sid, harnessActive: true, openTodoCount: 1 }),
      null,
    );
  });

  it("TodoGate blocks Stop when open todos under ULW", () => {
    const r = evaluateTodoGateAtStop({
      sessionId: "tg-1",
      ulwEnabled: true,
      ultraworkFlag: false,
      openTodoCount: 2,
      lastAssistantMessage: "I think we're done.",
    });
    assert.equal(r.block, true);
    assert.match(r.reanchor || "", /TodoGate/);
  });

  it("TodoGate allows after Cycle complete attestation", () => {
    const r = evaluateTodoGateAtStop({
      sessionId: "tg-2",
      ulwEnabled: true,
      ultraworkFlag: true,
      openTodoCount: 1,
      lastAssistantMessage: "**Cycle complete.** Shipped X.",
    });
    assert.equal(r.block, false);
  });
});

describe("structured compaction", () => {
  it("preserves ULW mandate and todos in summary", () => {
    const dropped: ChatMessage[] = [
      { role: "user", content: "improve the code" },
      {
        role: "assistant",
        content: "Working on wave 1",
        tool_calls: [
          {
            id: "1",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"src/cli.ts"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "1", content: "…" },
      { role: "user", content: "also fix auth" },
    ];
    const summary = buildStructuredSummary(dropped, {
      ulw: {
        enabled: true,
        cycle: 1,
        wave: 2,
        blocks: 1,
        stuckBlocks: 0,
        lastBlockEditCount: 0,
        mandate: "improve the code",
        expandedMandate: "god-scope…",
        softPrompt: true,
        startedAt: "",
        updatedAt: "",
        sessionId: "x",
      },
      todos: [{ id: "t1", content: "fix auth", status: "pending" }],
    });
    assert.match(summary, /improve the code/);
    assert.match(summary, /cycle=1 wave=2/);
    assert.match(summary, /fix auth/);
    assert.match(summary, /also fix auth/);
    assert.match(summary, /read_file/);
  });

  it("compactMessagesStructured keeps system + summary + tail", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: "user" as const,
        content: `msg ${i}`,
      })),
    ];
    const { messages, droppedCount } = compactMessagesStructured(msgs, {
      keepLast: 4,
      context: { todos: [] },
    });
    assert.ok(droppedCount > 0);
    assert.equal(messages[0].role, "system");
    assert.match(messages[1].content || "", /compacted/i);
    assert.ok(messages.length < msgs.length);
  });
});

describe("prompt profile + baseline system", () => {
  it("resolves autonomous under ULW", () => {
    assert.equal(
      resolvePromptProfile({
        config: DEFAULT_CONFIG,
        ultrawork: true,
      }),
      "autonomous",
    );
    assert.equal(
      resolvePromptProfile({
        config: { ...DEFAULT_CONFIG, promptProfile: "concise" },
        ultrawork: true,
      }),
      "concise",
    );
  });

  it("baseline mentions mid-conversation harness, not live counters only", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sp-"));
    const text = buildBaselineSystemPrompt({
      config: DEFAULT_CONFIG,
      workspace: tmp,
      ultrawork: true,
      ulwCycle: {
        enabled: true,
        cycle: 1,
        wave: 9,
        blocks: 4,
        stuckBlocks: 0,
        lastBlockEditCount: 0,
        mandate: "x",
        expandedMandate: "y",
        softPrompt: true,
        startedAt: "",
        updatedAt: "",
        sessionId: "s",
      },
    });
    assert.match(text, /mid-conversation update/);
    assert.match(text, /autonomous|Keep working/i);
    assert.match(text, /SERENDIPITY/i);
    // Live counters should NOT be baked as the only source — protocol is static
    assert.match(text, /Live counters\/mandate are injected mid-conversation/i);
    assert.match(text, /Reliability \(runtime self-heal\)/);
    assert.match(text, /doom-loop/i);
    assert.match(text, /Context overflow|overflow/i);
  });
});

describe("plan mode permission enforcement", () => {
  it("denies writes and bash in plan mode", async () => {
    const gate = new PermissionGate({ interactive: false });
    const write = await gate.request({
      toolName: "write_file",
      input: { path: "a.ts", content: "x" },
      mode: "plan",
      workspace: process.cwd(),
    });
    assert.equal(write.decision, "deny");
    assert.match(write.reason, /plan_mode/);

    const bash = await gate.request({
      toolName: "bash",
      input: { command: "echo hi" },
      mode: "plan",
      workspace: process.cwd(),
    });
    assert.equal(bash.decision, "deny");

    const read = await gate.request({
      toolName: "read_file",
      input: { path: "package.json" },
      mode: "plan",
      workspace: process.cwd(),
    });
    assert.equal(read.decision, "allow");
  });
});
