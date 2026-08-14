import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "../src/providers/types.js";
import {
  clearStaleToolResults,
  toolClearEnvConfig,
  TOOL_CLEARED_MARKER,
  extractSavedOutputPath,
  formatClearedToolStub,
  isIdempotentRestoreTool,
} from "../src/session/tool-clearing.js";
import {
  collectPinnedToolOutputPaths,
  pruneToolOutputsSync,
  saveFullOutputSync,
  toolOutputDir,
} from "../src/agent/tools/truncate.js";

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

function withForgeHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-clear-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("tool-clearing (microcompaction)", () => {
  it("clears long tool bodies older than the hot tail and spools them", () => {
    withForgeHome(() => {
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
      assert.ok(stub.includes(TOOL_CLEARED_MARKER));
      assert.ok(stub.includes("(read_file, 5000 chars)"));
      assert.ok(stub.includes("Full output:"));
      assert.ok(stub.includes("use read_file on that path"));
      assert.ok(!stub.includes("re-run the tool if you need it again"));
      const saved = extractSavedOutputPath(stub);
      assert.ok(saved);
      assert.equal(fs.readFileSync(saved!, "utf8"), body);
      assert.ok(stub.includes("Re-read the workspace path"));
      assert.equal(msgs[2].content, body);
    });
  });

  it("does not tell the model to re-run spawn_subagent", () => {
    withForgeHome(() => {
      const body = "OSS findings\n".repeat(400);
      const msgs: ChatMessage[] = [
        { role: "system", content: "sys" },
        assistantCall("c1", "spawn_subagent"),
        toolMsg("c1", body),
        ...tail(16),
      ];
      const r = clearStaleToolResults(msgs);
      assert.equal(r.cleared, 1);
      const stub = r.messages[2].content as string;
      assert.match(stub, /Do not re-run spawn_subagent/);
      assert.ok(!stub.includes("re-run the tool if you need it again"));
      const saved = extractSavedOutputPath(stub);
      assert.ok(saved && fs.existsSync(saved));
      assert.equal(fs.readFileSync(saved!, "utf8"), body);
    });
  });

  it("keeps the most recent keepRecent non-system messages intact even when long", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      assistantCall("c1", "bash"),
      toolMsg("c1", "y".repeat(9000)),
      ...tail(14),
    ];
    const r = clearStaleToolResults(msgs, { keepRecent: 16 });
    assert.equal(r.cleared, 0);
    assert.equal(r.freedChars, 0);
    assert.strictEqual(r.messages, msgs);
  });

  it("preserves the saved-to-path pointer from a truncation footer", () => {
    withForgeHome(() => {
      const existing = "/Users/x/.forge/tool-output/tool_123_abc.txt";
      const body =
        "z".repeat(3000) +
        `\n\n[Output truncated — full 91234 bytes / 2400 lines saved to ${existing}. ` +
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
      assert.ok(stub.includes(`Full output: ${existing}`), stub);
      assert.ok(stub.includes("use read_file on that path"));
      assert.ok(!stub.includes("\n"), "stub stays a single line");
    });
  });

  it("is idempotent — a second pass clears nothing", () => {
    withForgeHome(() => {
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

      const r3 = clearStaleToolResults(r1.messages, { minChars: 50 });
      assert.equal(r3.cleared, 0);
      assert.strictEqual(r3.messages, r1.messages);
      assert.ok((r1.messages[2].content as string).includes(TOOL_CLEARED_MARKER));
    });
  });

  it("returns the same array reference when nothing qualifies", () => {
    const short: ChatMessage[] = [
      { role: "system", content: "sys" },
      assistantCall("c1", "bash"),
      toolMsg("c1", "x".repeat(9999)),
    ];
    const r1 = clearStaleToolResults(short);
    assert.equal(r1.cleared, 0);
    assert.strictEqual(r1.messages, short);

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
    withForgeHome(() => {
      const msgs: ChatMessage[] = [
        { role: "system", content: "sys" },
        assistantCall("c1", "bash"),
        toolMsg("c1", "x".repeat(500)),
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
      ];
      const r1 = clearStaleToolResults(msgs, { keepRecent: 2, minChars: 100 });
      assert.equal(r1.cleared, 1);
      assert.ok(
        (r1.messages[2].content as string).includes("(bash, 500 chars)"),
      );
      const r2 = clearStaleToolResults(msgs, { keepRecent: 2, minChars: 1000 });
      assert.equal(r2.cleared, 0);
      assert.strictEqual(r2.messages, msgs);
      const r3 = clearStaleToolResults(msgs, { minChars: 100 });
      assert.equal(r3.cleared, 0);
      assert.strictEqual(r3.messages, msgs);
    });
  });

  it("preserves role / tool_call_id pairing and untouched message identity", () => {
    withForgeHome(() => {
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

      const orphan = r.messages[3];
      assert.equal(orphan.role, "tool");
      assert.equal(orphan.tool_call_id, "orphan");
      assert.ok((orphan.content as string).includes("(tool, 4000 chars)"));

      assert.strictEqual(r.messages[0], msgs[0]);
      assert.strictEqual(r.messages[1], msgs[1]);
      assert.strictEqual(r.messages[4], msgs[4]);
      assert.strictEqual(r.messages[r.messages.length - 1], msgs[msgs.length - 1]);
    });
  });

  it("toolClearEnvConfig: default off; FORGE_TOOL_CLEAR=1 enables", () => {
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
        enabled: false,
        keepRecent: 10,
        minChars: 1200,
        minStaleBytes: 12000,
      });

      process.env.FORGE_TOOL_CLEAR = "0";
      assert.equal(toolClearEnvConfig().enabled, false);
      process.env.FORGE_TOOL_CLEAR = "false";
      assert.equal(toolClearEnvConfig().enabled, false);
      process.env.FORGE_TOOL_CLEAR = "1";
      assert.equal(toolClearEnvConfig().enabled, true);
      process.env.FORGE_TOOL_CLEAR = "true";
      assert.equal(toolClearEnvConfig().enabled, true);

      process.env.FORGE_TOOL_CLEAR_KEEP_RECENT = "8";
      process.env.FORGE_TOOL_CLEAR_MIN_CHARS = "500";
      process.env.FORGE_TOOL_CLEAR_MIN_STALE_BYTES = "10000";
      const c = toolClearEnvConfig();
      assert.equal(c.keepRecent, 8);
      assert.equal(c.minChars, 500);
      assert.equal(c.minStaleBytes, 10000);

      process.env.FORGE_TOOL_CLEAR_KEEP_RECENT = "abc";
      process.env.FORGE_TOOL_CLEAR_MIN_CHARS = "-5";
      const d = toolClearEnvConfig();
      assert.equal(d.keepRecent, 10);
      assert.equal(d.minChars, 1200);
    } finally {
      for (const k of KEYS) {
        const v = saved.get(k);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("formatClearedToolStub distinguishes idempotent tools", () => {
    assert.equal(isIdempotentRestoreTool("read_file"), true);
    assert.equal(isIdempotentRestoreTool("spawn_subagent"), false);
    const idemp = formatClearedToolStub({
      name: "grep",
      chars: 10,
      outputPath: "/tmp/x.txt",
      idempotent: true,
    });
    assert.match(idemp, /Re-read the workspace path/);
    const once = formatClearedToolStub({
      name: "spawn_subagent",
      chars: 10,
      outputPath: "/tmp/x.txt",
      idempotent: false,
    });
    assert.match(once, /Do not re-run spawn_subagent/);
  });

  it("does not prune dumps still referenced by a session", () => {
    withForgeHome(() => {
      const dir = toolOutputDir();
      fs.mkdirSync(dir, { recursive: true });
      const pinned = saveFullOutputSync("keep me");
      const extra = saveFullOutputSync("delete me if old");
      const sessions = path.join(process.env.FORGE_HOME!, "sessions", "abc");
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(
        path.join(sessions, "session.json"),
        JSON.stringify({
          messages: [{ role: "tool", content: `Full output: ${pinned}` }],
        }),
      );
      const old = Date.now() - 30 * 86_400_000;
      fs.utimesSync(pinned, new Date(old / 1000), new Date(old / 1000));
      fs.utimesSync(extra, new Date(old / 1000), new Date(old / 1000));
      const pins = collectPinnedToolOutputPaths();
      assert.ok(pins.has(pinned) || [...pins].some((p) => p === pinned));
      pruneToolOutputsSync({ keep: 0, maxAgeDays: 1 });
      assert.ok(fs.existsSync(pinned), "referenced dump must survive");
      assert.equal(fs.existsSync(extra), false);
    });
  });
});
