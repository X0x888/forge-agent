import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatInterjection,
  formatUserQuery,
  formatInterjectionsMessage,
  formatInterjectionContext,
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

  it("attaches harness context so free-text does not drop the mandate", () => {
    const ctxLine = formatInterjectionContext({
      ulwLine: "ULW cycle=1 wave=2 (CONTINUE)",
      goalLine: "ship reliability",
      openTodos: 3,
    });
    assert.match(ctxLine, /Forge harness still active/);
    assert.match(ctxLine, /ULW cycle=1/);
    assert.match(ctxLine, /goal: ship reliability/);
    assert.match(ctxLine, /todos:3/);
    const framed = formatInterjection("focus on the tests first", {
      ulwLine: "ULW cycle=1 wave=2 (CONTINUE)",
      openTodos: 2,
    });
    assert.match(framed, /focus on the tests first/);
    assert.match(framed, /harness still active/i);
    assert.match(framed, /do not abandon/i);
    // No context → no harness line
    const plain = formatInterjection("hi");
    assert.ok(!/harness still active/i.test(plain));
  });
});

  it("frames advisory mid-run interjections under ULW", () => {
    const framed = formatInterjection("what do you think about the approach?", {
      ulwLine: "ULW cycle=1 wave=2 (CONTINUE)",
    });
    assert.match(framed, /ADVISORY\/Q&A/);
    assert.match(framed, /Answer the question first/i);
    const work = formatInterjection("please implement the fix now", {
      ulwLine: "ULW cycle=1 wave=2 (CONTINUE)",
    });
    assert.doesNotMatch(work, /ADVISORY\/Q&A/);
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

  it("suppresses counter-only changes when requested, admits real changes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-admit-sup-"));
    process.env.FORGE_HOME = tmp;
    const sid = "admit-suppress";
    const ulw = armUlwCycle(sid, "improve the code", { cycle: 1 });
    const snap1 = snapshotHarness({
      ulw,
      goal: null,
      todos: [],
      permissionMode: "default",
    });
    // Baseline admit goes through
    assert.ok(admitHarnessIfChanged(sid, snap1));

    // Counter-only churn (wave/blocks/todos) → suppressed with the flag…
    const snap2 = { ...snap1, wave: 2, blocks: 3, openTodos: 4 };
    assert.equal(
      admitHarnessIfChanged(sid, snap2, { suppressCounterOnlyChanges: true }),
      null,
    );
    // …but admitted without it (legacy behavior preserved)
    const snap2b = { ...snap1, wave: 7, blocks: 8 };
    assert.ok(admitHarnessIfChanged(sid, snap2b));

    // Real change (cycle flip) always admits, even with the flag
    const snap3 = { ...snap2b, cycle: 0 as const };
    const msg3 = admitHarnessIfChanged(sid, snap3, {
      suppressCounterOnlyChanges: true,
    });
    assert.ok(msg3);
    assert.match(msg3!, /LAST/);

    // Suppression updates the stored fingerprint: re-sending snap3 is a no-op
    assert.equal(
      admitHarnessIfChanged(sid, snap3, { suppressCounterOnlyChanges: true }),
      null,
    );
  });
});

describe("todo nudge + gate", () => {
  beforeEach(() => clearTodoGateState());

  it("does not nag an empty board into ceremony", () => {
    const sid = "nudge-1";
    resetTodoNudgeForPrompt(sid);
    for (let i = 0; i < 12; i++) noteAssistantTurn(sid);
    assert.equal(
      maybeTodoNudge({ sessionId: sid, harnessActive: true, openTodoCount: 0 }),
      null,
    );
  });

  it("nudges a stale open board after many turns", () => {
    const sid = "nudge-1b";
    resetTodoNudgeForPrompt(sid);
    for (let i = 0; i < 16; i++) noteAssistantTurn(sid);
    const msg = maybeTodoNudge({
      sessionId: sid,
      harnessActive: true,
      openTodoCount: 2,
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

  it("TodoGate soft-blocks once outside ULW with open todos", () => {
    clearTodoGateState("tg-soft");
    const r1 = evaluateTodoGateAtStop({
      sessionId: "tg-soft",
      ulwEnabled: false,
      ultraworkFlag: false,
      openTodoCount: 2,
      lastAssistantMessage: "Done for now.",
    });
    assert.equal(r1.block, true);
    assert.equal(r1.soft, true);
    assert.match(r1.reanchor || "", /once/i);
    // Second stop same prompt releases
    const r2 = evaluateTodoGateAtStop({
      sessionId: "tg-soft",
      ulwEnabled: false,
      ultraworkFlag: false,
      openTodoCount: 2,
      lastAssistantMessage: "Still open todos but releasing.",
    });
    assert.equal(r2.block, false);
  });

  it("TodoGate soft outside ULW can be disabled", () => {
    clearTodoGateState("tg-off");
    const r = evaluateTodoGateAtStop({
      sessionId: "tg-off",
      ulwEnabled: false,
      ultraworkFlag: false,
      openTodoCount: 3,
      lastAssistantMessage: "Stopping.",
      softOutsideUlw: false,
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
    assert.match(text, /numbered window is current file text/);
    assert.doesNotMatch(text, /check truncation/);
    assert.match(text, /State your reading first/i);
    assert.match(text, /Finish, don't hand off/i);
    assert.match(text, /Finish the (defect )?class/i);
    assert.match(text, /hostile reviewer|Hostile self-review/i);
    assert.match(text, /callers|siblings/i);
    assert.match(text, /Pure questions are not work orders/i);
    assert.match(text, /Prefer ask_user when requirements are ambiguous/i);
    assert.match(text, /Tests must be able to fail/i);
    assert.match(text, /Handoff guard/i);
    assert.match(text, /Proof-claim guard/i);
    assert.match(text, /TodoGate/i);
    assert.match(text, /serendipity/i);
    // Live counters should NOT be baked as the only source — protocol is static
    assert.match(
      text,
      /Live counters\/mandate (?:are injected|arrive) mid-conversation/i,
    );
    assert.match(text, /Reliability \(runtime self-heal\)/);
    assert.match(text, /doom-loop/i);
    assert.match(text, /Context overflow|overflow/i);
  });

  it("baseline prompt stays lean (grok-build style size ceiling)", async () => {
    // The baseline system prompt is re-sent on every model call; runaway
    // growth is a per-turn token tax on every session. Ceiling includes the
    // compact forge-* skills catalog + forge-method body (~3–4k). Regressions
    // toward unbounded doctrine bloat (15k+ without cause) fail here.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    // Isolate FORGE_HOME so cross-session project memory from the developer's
    // machine cannot inflate the baseline. Also note: an empty .git dir is NOT
    // a real repo — git rev-parse walks up — so bare TMPDIR under this repo can
    // still resolve the parent root for project memory.
    const prevHome = process.env.FORGE_HOME;
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sp-home-"));
    process.env.FORGE_HOME = fakeHome;
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sp-size-"));
    // npm test runs with TMPDIR inside this repo — give the bare workspace its
    // own .git so the rules walk stops here instead of slurping the repo's
    // AGENTS.md (which would make the ceiling meaningless).
    fs.mkdirSync(path.join(bare, ".git"));
    try {
      const { DEFAULT_CONFIG } = await import("../src/config/types.js");
      const text = buildBaselineSystemPrompt({
        config: { ...DEFAULT_CONFIG },
        workspace: bare,
        git: null,
        project: null,
      });
      assert.ok(
        text.length < 14_200,
        `baseline system prompt grew to ${text.length} chars`,
      );
      // Without builtins the core doctrine alone must stay small.
      const prev = process.env.FORGE_BUILTIN_SKILLS;
      process.env.FORGE_BUILTIN_SKILLS = "0";
      try {
        const lean = buildBaselineSystemPrompt({
          config: { ...DEFAULT_CONFIG },
          workspace: bare,
          git: null,
          project: null,
        });
        assert.ok(
          lean.length < 8500,
          `core baseline (no builtins) grew to ${lean.length} chars`,
        );
      } finally {
        if (prev === undefined) delete process.env.FORGE_BUILTIN_SKILLS;
        else process.env.FORGE_BUILTIN_SKILLS = prev;
      }
    } finally {
      if (prevHome === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prevHome;
      try {
        fs.rmSync(fakeHome, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });
});

describe("plan mode permission enforcement", () => {
  it("denies writes and mutating bash; allows read-only bash", async () => {
    const gate = new PermissionGate({ interactive: false });
    const write = await gate.request({
      toolName: "write_file",
      input: { path: "a.ts", content: "x" },
      mode: "plan",
      workspace: process.cwd(),
    });
    assert.equal(write.decision, "deny");
    assert.match(write.reason, /plan_mode/);

    // Read-only research shell is allowed in plan (git status, ls, …)
    const ro = await gate.request({
      toolName: "bash",
      input: { command: "git status" },
      mode: "plan",
      workspace: process.cwd(),
    });
    assert.equal(ro.decision, "allow");

    // Mutating bash still hard-denied
    const bash = await gate.request({
      toolName: "bash",
      input: { command: "npm install left-pad" },
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
