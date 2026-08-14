import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "../src/providers/types.js";
import {
  compactMessagesStructured,
  clipUserMandate,
} from "../src/session/compaction.js";
import {
  splitInFlightTail,
  storeNeedsCheckpoint,
  lastRealUserText,
  DEFAULT_CHECKPOINT_STORE_TOKENS,
  DEFAULT_CHECKPOINT_STORE_MESSAGES,
  loadCheckpointSidecar,
} from "../src/session/checkpoint.js";
import { pruneMessagesForRequest } from "../src/session/request-prune.js";
import { estimateTokens } from "../src/session/session.js";
import { armUlwCycle, disarmUlwCycle } from "../src/harness/ulw-cycle.js";

function withForgeHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ckpt-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assistantCall(id: string, name: string, args: string): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
  };
}

describe("checkpoint compact", () => {
  it("splitInFlightTail keeps the last N assistant steps", () => {
    const rest: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) {
      rest.push(assistantCall(`c${i}`, "read_file", "{}"));
      rest.push({ role: "tool", tool_call_id: `c${i}`, content: "x" });
    }
    const { dropped, kept } = splitInFlightTail(rest, 3);
    const asst = kept.filter((m) => m.role === "assistant");
    assert.equal(asst.length, 3);
    assert.equal(kept[0]?.role, "assistant");
    assert.ok(dropped.length > 0);
  });

  it("800-read prune does not need a store checkpoint", () => {
    const msgs: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 800; i++) {
      msgs.push(
        assistantCall(`c${i}`, "read_file", JSON.stringify({ path: "a.ts" })),
      );
      msgs.push({
        role: "tool",
        tool_call_id: `c${i}`,
        content: "B".repeat(32_000),
      });
    }
    const outbound = estimateTokens(
      pruneMessagesForRequest(msgs, { spool: false }).messages,
    );
    const store = estimateTokens(msgs);
    assert.ok(outbound < 80_000, `outbound ${outbound}`);
    assert.ok(store > 1_000_000, `store ${store}`);
    // Token size of the pruned request must not force a store compact.
    assert.equal(storeNeedsCheckpoint(800, outbound), false);
    // 800 tool rounds ≈ 1600 messages — that *is* a store checkpoint now
    // (threshold 1000; 2500 let a 5h ULW overflow 528k/500k after one compact).
    assert.equal(storeNeedsCheckpoint(msgs.length, outbound), true);
  });

  it("storeNeedsCheckpoint fires on message count / store tokens", () => {
    assert.equal(storeNeedsCheckpoint(10, 100), false);
    assert.equal(
      storeNeedsCheckpoint(DEFAULT_CHECKPOINT_STORE_MESSAGES, 10),
      true,
    );
    assert.equal(
      storeNeedsCheckpoint(10, DEFAULT_CHECKPOINT_STORE_TOKENS),
      true,
    );
  });

  it("checkpoint writes a job card and keeps an in-flight tail", () => {
    withForgeHome(() => {
      const sid = "sess-ckpt-1";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const ulw = armUlwCycle(sid, "Ship the auth fix and prove it.", {
        cycle: 1,
        skipCheckpoint: true,
      });
      const msgs: ChatMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "Ship the auth fix and prove it." },
      ];
      for (let i = 0; i < 20; i++) {
        msgs.push(assistantCall(`c${i}`, "read_file", `{"path":"f${i}.ts"}`));
        msgs.push({
          role: "tool",
          tool_call_id: `c${i}`,
          content: "body".repeat(20),
        });
      }
      const result = compactMessagesStructured(msgs, {
        keepLast: 3,
        context: { sessionId: sid, ulw, todos: [] },
      });
      assert.ok(result.droppedCount > 0);
      assert.match(result.summary, /Forge checkpoint 1/);
      assert.match(result.summary, /Ship the auth fix/);
      assert.match(result.summary, /only wave counter/);
      assert.equal(result.messages[0]?.role, "system");
      assert.match(result.messages[1]?.content || "", /checkpoint 1/);
      const tailAsst = result.messages.filter((m) => m.role === "assistant");
      assert.equal(tailAsst.length, 3);
      const rec = loadCheckpointSidecar(sid);
      assert.ok(rec);
      assert.equal(rec!.epoch, 1);
      disarmUlwCycle(sid);
    });
  });

  it("lastRealUserText skips harness admits", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "real mandate please" },
      {
        role: "user",
        content: "[Forge harness — mid-conversation update]\ncycle=1",
      },
    ];
    assert.equal(lastRealUserText(msgs), "real mandate please");
  });

  it("clipUserMandate does not re-inject the god-mode dump", () => {
    const dump = [
      "## ULW GOD MODE (soft user signal — full operational ownership)",
      `User signal (SOFT — do **not** ask): "comprehensively evaluate this tool and then improve the ui and ux of it."`,
      "You decide what the hard work is " + "x".repeat(800),
    ].join("\n");
    const clipped = clipUserMandate(dump);
    assert.match(clipped, /comprehensively evaluate/);
    assert.doesNotMatch(clipped, /You decide what the hard work is/);
    assert.match(clipped, /ulw\.json/);
  });

  it("job card still names mandate if dropped span is deleted", () => {
    withForgeHome(() => {
      const sid = "sess-ckpt-card";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const ulw = armUlwCycle(sid, "Never weaken tests. Fix the race in auth.", {
        cycle: 1,
        skipCheckpoint: true,
      });
      const msgs: ChatMessage[] = [
        { role: "system", content: "You are Forge" },
        ...Array.from({ length: 30 }, (_, i) => ({
          role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
          content: `turn ${i} lorem ipsum filler content for compact window`,
        })),
      ];
      const result = compactMessagesStructured(msgs, {
        keepLast: 3,
        context: { sessionId: sid, ulw, todos: [] },
      });
      assert.ok(result.droppedCount > 0);
      assert.match(result.summary, /Decisions|constraints|Never weaken|auth/i);
      disarmUlwCycle(sid);
    });
  });
});
