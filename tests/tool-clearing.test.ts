import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../src/providers/types.js";
import {
  clearStaleToolResults,
  toolClearEnvConfig,
  TOOL_CLEARED_MARKER,
} from "../src/session/tool-clearing.js";

function assistantCall(id: string, name: string): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id, type: "function", function: { name, arguments: "{}" } },
    ],
  };
}

function toolMsg(id: string, body: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content: body };
}

/** n non-system filler messages (the "hot tail"). */
function tail(n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      i % 2 === 0
        ? { role: "user", content: `user ${i}` }
        : { role: "assistant", content: `assistant ${i}` },
    );
  }
  return out;
}

describe("tool-clearing (microcompaction)", () => {
  it("clears long tool bodies older than the hot tail", () => {
    const body = "x".repeat(5000);
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      assistantCall("c1", "read_file"),
      toolMsg("c1", body),
      ...tail(16),
    ];
    const r = clearStaleToolResults(msgs);
    assert.equal(r.cleared, 1);
    assert.notStrictEqual(r.messages, msgs);
    assert.equal(r.messages.length, msgs.length);

    const stub = r.messages[2].content as string;
    assert.equal(
      stub,
      `[Stale tool output cleared (read_file, 5000 chars) — ` +
        `re-run the tool if you need it again.]`,
    );
    assert.equal(r.freedChars, 5000 - stub.length);
    // non-mutating: original history untouched
    assert.equal(msgs[2].content, body);
  });

  it("keeps the most recent keepRecent non-system messages intact even when long", () => {
    // assistant(call) is the 16th-newest non-system message, the tool result
    // is 15th — both inside the default hot tail of 16.
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      assistantCall("c1", "bash"),
      toolMsg("c1", "y".repeat(9000)),
      ...tail(14),
    ];
    const r = clearStaleToolResults(msgs);
    assert.equal(r.cleared, 0);
    assert.equal(r.freedChars, 0);
    assert.strictEqual(r.messages, msgs);
  });

  it("preserves the saved-to-path pointer from a truncation footer", () => {
    const path = "/Users/x/.forge/tool-output/tool_123_abc.txt";
    const body =
      "z".repeat(3000) +
      `\n\n[Output truncated — full 91234 bytes / 2400 lines saved to ${path}. ` +
      `Use read_file on that path if you need more.]`;
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      assistantCall("c1", "bash"),
      toolMsg("c1", body),
      ...tail(16),
    ];
    const r = clearStaleToolResults(msgs);
    assert.equal(r.cleared, 1);
    const stub = r.messages[2].content as string;
    assert.ok(stub.includes(`Full output: ${path}`), stub);
    assert.ok(!stub.includes("Use read_file"), stub);
    assert.ok(!stub.includes("\n"), "stub stays a single line");
  });

  it("is idempotent — a second pass clears nothing", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      assistantCall("c1", "bash"),
      toolMsg("c1", "x".repeat(5000)),
      ...tail(16),
    ];
    const r1 = clearStaleToolResults(msgs);
    assert.equal(r1.cleared, 1);

    const r2 = clearStaleToolResults(r1.messages);
    assert.equal(r2.cleared, 0);
    assert.strictEqual(r2.messages, r1.messages);

    // marker guard specifically: with a tiny minChars the stub itself would
    // otherwise qualify by length
    const r3 = clearStaleToolResults(r1.messages, { minChars: 50 });
    assert.equal(r3.cleared, 0);
    assert.strictEqual(r3.messages, r1.messages);
    assert.ok((r1.messages[2].content as string).includes(TOOL_CLEARED_MARKER));
  });

  it("returns the same array reference when nothing qualifies", () => {
    // short history: fewer non-system messages than keepRecent
    const short: ChatMessage[] = [
      { role: "system", content: "sys" },
      assistantCall("c1", "bash"),
      toolMsg("c1", "x".repeat(9999)),
    ];
    const r1 = clearStaleToolResults(short);
    assert.equal(r1.cleared, 0);
    assert.strictEqual(r1.messages, short);

    // long history but every tool body is small
    const small: ChatMessage[] = [
      { role: "system", content: "sys" },
      assistantCall("c1", "bash"),
      toolMsg("c1", "small output"),
      ...tail(20),
    ];
    const r2 = clearStaleToolResults(small);
    assert.equal(r2.cleared, 0);
    assert.strictEqual(r2.messages, small);
  });

  it("respects custom keepRecent and minChars", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      assistantCall("c1", "bash"),
      toolMsg("c1", "x".repeat(500)),
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ];
    // hot tail of 2 → tool result is stale; minChars 100 → 500 chars clears
    const r1 = clearStaleToolResults(msgs, { keepRecent: 2, minChars: 100 });
    assert.equal(r1.cleared, 1);
    assert.ok(
      (r1.messages[2].content as string).includes("(bash, 500 chars)"),
    );
    // minChars above the body size → nothing qualifies
    const r2 = clearStaleToolResults(msgs, { keepRecent: 2, minChars: 1000 });
    assert.equal(r2.cleared, 0);
    assert.strictEqual(r2.messages, msgs);
    // default keepRecent (16) protects everything here
    const r3 = clearStaleToolResults(msgs, { minChars: 100 });
    assert.equal(r3.cleared, 0);
    assert.strictEqual(r3.messages, msgs);
  });

  it("preserves role / tool_call_id pairing and untouched message identity", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      assistantCall("c1", "read_file"),
      toolMsg("c1", "x".repeat(4000)),
      toolMsg("orphan", "y".repeat(4000)),
      ...tail(16),
    ];
    const r = clearStaleToolResults(msgs);
    assert.equal(r.cleared, 2);

    const c1 = r.messages[2];
    assert.equal(c1.role, "tool");
    assert.equal(c1.tool_call_id, "c1");

    // unknown tool_call_id falls back to "tool" in the stub
    const orphan = r.messages[3];
    assert.equal(orphan.role, "tool");
    assert.equal(orphan.tool_call_id, "orphan");
    assert.ok((orphan.content as string).includes("(tool, 4000 chars)"));

    // untouched messages are the exact same object references
    assert.strictEqual(r.messages[0], msgs[0]);
    assert.strictEqual(r.messages[1], msgs[1]);
    assert.strictEqual(r.messages[4], msgs[4]);
    assert.strictEqual(r.messages[r.messages.length - 1], msgs[msgs.length - 1]);
  });

  it("toolClearEnvConfig: sane defaults, FORGE_TOOL_CLEAR=0 disables", () => {
    const KEYS = [
      "FORGE_TOOL_CLEAR",
      "FORGE_TOOL_CLEAR_KEEP_RECENT",
      "FORGE_TOOL_CLEAR_MIN_CHARS",
      "FORGE_TOOL_CLEAR_MIN_STALE_BYTES",
    ];
    const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
    try {
      for (const k of KEYS) delete process.env[k];
      assert.deepEqual(toolClearEnvConfig(), {
        enabled: true,
        keepRecent: 16,
        minChars: 1200,
        minStaleBytes: 24000,
      });

      process.env.FORGE_TOOL_CLEAR = "0";
      assert.equal(toolClearEnvConfig().enabled, false);
      process.env.FORGE_TOOL_CLEAR = "false";
      assert.equal(toolClearEnvConfig().enabled, false);
      process.env.FORGE_TOOL_CLEAR = "1";
      assert.equal(toolClearEnvConfig().enabled, true);

      process.env.FORGE_TOOL_CLEAR_KEEP_RECENT = "8";
      process.env.FORGE_TOOL_CLEAR_MIN_CHARS = "500";
      process.env.FORGE_TOOL_CLEAR_MIN_STALE_BYTES = "10000";
      const c = toolClearEnvConfig();
      assert.equal(c.keepRecent, 8);
      assert.equal(c.minChars, 500);
      assert.equal(c.minStaleBytes, 10000);

      // invalid values fall back to defaults
      process.env.FORGE_TOOL_CLEAR_KEEP_RECENT = "abc";
      process.env.FORGE_TOOL_CLEAR_MIN_CHARS = "-5";
      const d = toolClearEnvConfig();
      assert.equal(d.keepRecent, 16);
      assert.equal(d.minChars, 1200);
    } finally {
      for (const k of KEYS) {
        const v = saved.get(k);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
