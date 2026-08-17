import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "../src/providers/types.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { buildChatRequest } from "../src/agent/loop.js";
import { estimateTokens, estimateRequestTokens } from "../src/session/session.js";
import { outboundTokenEstimate } from "../src/statusline/snapshot.js";
import { TOOL_DEFINITIONS } from "../src/agent/tools/definitions.js";
import { repairToolCallPairing } from "../src/session/message-repair.js";
import {
  pruneMessagesForRequest,
  requestPruneEnvConfig,
  assistantStepAges,
  REQUEST_PRUNE_OMITTED,
  REQUEST_PRUNE_DEFAULT_KEEP_TURNS,
  REQUEST_PRUNE_DEFAULT_HARD_AGE,
  HARNESS_USER_STUB,
  collapseStaleHarnessUserMessages,
} from "../src/session/request-prune.js";

function assistantCall(
  id: string,
  name: string,
  args: string,
): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id, type: "function", function: { name, arguments: args } },
    ],
  };
}

function toolMsg(id: string, body: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content: body };
}

function steps(
  n: number,
  opts?: { bodyChars?: number; args?: string; name?: string },
): ChatMessage[] {
  const bodyChars = opts?.bodyChars ?? 8000;
  const args = opts?.args ?? JSON.stringify({ path: "src/foo.ts", offset: 1 });
  const name = opts?.name ?? "read_file";
  const out: ChatMessage[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < n; i++) {
    const id = `c${i}`;
    out.push(assistantCall(id, name, args));
    out.push(toolMsg(id, "B".repeat(bodyChars)));
  }
  return out;
}

function withForgeHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rprune-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("request-prune", () => {
  it("does not mutate the stored transcript", () => {
    const msgs = steps(12);
    const before = JSON.stringify(msgs);
    const r = pruneMessagesForRequest(msgs, { spool: false });
    assert.equal(JSON.stringify(msgs), before);
    assert.ok(r.changed);
    assert.notStrictEqual(r.messages, msgs);
    assert.equal(r.messages.length, msgs.length);
  });

  it("leaves a young session (≤ keepTurns steps) untouched", () => {
    const msgs = steps(REQUEST_PRUNE_DEFAULT_KEEP_TURNS);
    const r = pruneMessagesForRequest(msgs, { spool: false });
    assert.equal(r.changed, false);
    assert.strictEqual(r.messages, msgs);
    assert.equal(r.prunedResults, 0);
    assert.equal(r.collapsedCalls, 0);
  });

  it("soft-trims fat results and collapses args outside the last 3 steps", () => {
    const msgs = steps(6, { bodyChars: 8000 });
    const r = pruneMessagesForRequest(msgs, { spool: false });
    assert.ok(r.changed);
    // 6 steps, keep 3 → oldest 3 collapse + soft-trim
    assert.equal(r.collapsedCalls, 3);
    assert.equal(r.prunedResults, 3);

    const ages = assistantStepAges(r.messages);
    for (let i = 0; i < r.messages.length; i++) {
      const m = r.messages[i]!;
      const age = ages[i]!;
      if (m.role === "tool" && age >= 3 && age < 10) {
        const c = m.content || "";
        assert.ok(c.includes("\n\n…\n\n"));
        assert.ok(c.length < 8000);
        assert.ok(!c.startsWith(REQUEST_PRUNE_OMITTED));
      }
      if (m.role === "assistant" && age >= 3) {
        const args = m.tool_calls![0]!.function.arguments;
        const parsed = JSON.parse(args);
        assert.equal(parsed._cleared, true);
        assert.equal(parsed.path, undefined);
      }
      if (m.role === "assistant" && age < 3) {
        assert.ok(m.tool_calls![0]!.function.arguments.includes("offset"));
      }
    }
  });

  it("hard-omits results older than 10 assistant steps", () => {
    const msgs = steps(14, { bodyChars: 5000 });
    const r = pruneMessagesForRequest(msgs, { spool: false });
    const ages = assistantStepAges(r.messages);
    let omitted = 0;
    let hot = 0;
    for (let i = 0; i < r.messages.length; i++) {
      const m = r.messages[i]!;
      if (m.role !== "tool") continue;
      if (ages[i]! >= REQUEST_PRUNE_DEFAULT_HARD_AGE) {
        assert.ok((m.content || "").startsWith(REQUEST_PRUNE_OMITTED));
        omitted += 1;
      }
      if (ages[i]! < REQUEST_PRUNE_DEFAULT_KEEP_TURNS) {
        assert.equal((m.content || "").length, 5000);
        hot += 1;
      }
    }
    assert.equal(omitted, 4); // ages 10..13
    assert.equal(hot, 3);
  });

  it("keeps tool_call pairing legal after collapse + omit", () => {
    const msgs = steps(14);
    const r = pruneMessagesForRequest(msgs, { spool: false });
    const healed = repairToolCallPairing(r.messages);
    assert.equal(healed.changed, false);
    assert.equal(healed.filledOrphanToolCalls, 0);
    assert.equal(healed.droppedOrphanToolResults, 0);
    const ids = new Set<string>();
    for (const m of r.messages) {
      if (m.role === "assistant") {
        for (const tc of m.tool_calls || []) ids.add(tc.id);
      }
    }
    const resultIds = r.messages
      .filter((m) => m.role === "tool")
      .map((m) => m.tool_call_id);
    assert.equal(resultIds.length, ids.size);
    for (const id of resultIds) assert.ok(ids.has(id!));
  });

  it("does not tell the model to re-run bash; read_file may re-read the tree", () => {
    const bash = steps(12, {
      name: "bash",
      args: JSON.stringify({ command: "npm test -- tests/foo.test.ts" }),
      bodyChars: 6000,
    });
    const br = pruneMessagesForRequest(bash, { spool: false });
    const oldBash = br.messages.find(
      (m) =>
        m.role === "tool" &&
        (m.content || "").startsWith(REQUEST_PRUNE_OMITTED),
    );
    assert.ok(oldBash);
    assert.ok((oldBash!.content || "").includes("Do not re-run bash."));
    const collapsed = br.messages.find(
      (m) => m.role === "assistant" && m.tool_calls?.[0]?.function.name === "bash",
    );
    const args = JSON.parse(collapsed!.tool_calls![0]!.function.arguments);
    assert.equal(args._cleared, true);
    assert.ok(String(args.command).startsWith("npm test"));

    const reads = steps(12, { name: "read_file", bodyChars: 6000 });
    const rr = pruneMessagesForRequest(reads, { spool: false });
    const oldRead = rr.messages.find(
      (m) =>
        m.role === "tool" &&
        (m.content || "").startsWith(REQUEST_PRUNE_OMITTED),
    );
    assert.ok((oldRead!.content || "").startsWith(REQUEST_PRUNE_OMITTED));
    assert.ok(!(oldRead!.content || "").includes("Do not re-run"));
  });

  it("800-read fixture stays under 80k outbound tokens", () => {
    const msgs = steps(800, {
      bodyChars: 32_000,
      args: JSON.stringify({
        path: "/Users/s./code/hobby/forge-agent/src/agent/loop.ts",
        offset: 1,
        limit: 2000,
      }),
    });
    const stored = estimateTokens(msgs);
    const r = pruneMessagesForRequest(msgs, { spool: false });
    const outbound = estimateTokens(r.messages);
    assert.ok(stored > 1_000_000, `stored should be huge, got ${stored}`);
    assert.ok(
      outbound < 80_000,
      `outbound ${outbound} tok should be < 80k (stored ${stored})`,
    );
    // Cemetery of full read_file arg blobs is gone
    let fullArgs = 0;
    for (const m of r.messages) {
      if (m.role !== "assistant") continue;
      const a = m.tool_calls?.[0]?.function.arguments || "";
      if (a.includes("limit")) fullArgs += 1;
    }
    assert.equal(fullArgs, 3);
  });

  it("keeps reasoning_content when collapsing old tool_calls", () => {
    const msgs = steps(8, { bodyChars: 8000 });
    const firstAsst = msgs.find((m) => m.role === "assistant");
    assert.ok(firstAsst);
    firstAsst!.reasoning_content = "prior thought";
    const r = pruneMessagesForRequest(msgs, { spool: false });
    const same = r.messages.find(
      (m) => m.role === "assistant" && m.reasoning_content,
    );
    assert.equal(same?.reasoning_content, "prior thought");
  });

  it("HUD ctx includes tool-schema tokens like the wire", () => {
    const prev = process.env.FORGE_REQUEST_PRUNE;
    delete process.env.FORGE_REQUEST_PRUNE;
    try {
      const msgs = steps(4, { bodyChars: 200 });
      const hud = outboundTokenEstimate(msgs);
      const extras = { toolsJsonChars: JSON.stringify(TOOL_DEFINITIONS).length };
      assert.equal(hud, estimateRequestTokens(msgs, extras));
      assert.ok(hud > estimateTokens(msgs));
    } finally {
      if (prev === undefined) delete process.env.FORGE_REQUEST_PRUNE;
      else process.env.FORGE_REQUEST_PRUNE = prev;
    }
  });

  it("HUD ctx matches the wire (append-only under 180k)", () => {
    const prev = process.env.FORGE_REQUEST_PRUNE;
    delete process.env.FORGE_REQUEST_PRUNE;
    try {
      const msgs = steps(8, { bodyChars: 2000 });
      const extras = { toolsJsonChars: JSON.stringify(TOOL_DEFINITIONS).length };
      const raw = estimateRequestTokens(msgs, extras);
      const hud = outboundTokenEstimate(msgs);
      assert.equal(hud, raw);
      assert.ok(hud >= estimateTokens(msgs));
      const pruned = estimateRequestTokens(
        pruneMessagesForRequest(msgs, { spool: false }).messages,
        extras,
      );
      assert.ok(pruned <= raw);
    } finally {
      if (prev === undefined) delete process.env.FORGE_REQUEST_PRUNE;
      else process.env.FORGE_REQUEST_PRUNE = prev;
    }
  });

  it("buildChatRequest is append-only by default (prefix cache)", () => {
    withForgeHome(() => {
      const prev = process.env.FORGE_REQUEST_PRUNE;
      delete process.env.FORGE_REQUEST_PRUNE;
      try {
        const msgs = steps(14, { bodyChars: 9000 });
        const snap = JSON.stringify(msgs);
        const req = buildChatRequest(
          { ...DEFAULT_CONFIG, model: "grok-4.6" },
          msgs,
        );
        assert.equal(JSON.stringify(msgs), snap);
        const omitted = req.messages.filter(
          (m) =>
            typeof m.content === "string" &&
            m.content.startsWith(REQUEST_PRUNE_OMITTED),
        );
        assert.equal(omitted.length, 0);
      } finally {
        if (prev === undefined) delete process.env.FORGE_REQUEST_PRUNE;
        else process.env.FORGE_REQUEST_PRUNE = prev;
      }
    });
  });

  it("buildChatRequest prunes when FORGE_REQUEST_PRUNE=1 (legacy)", () => {
    withForgeHome(() => {
      const prev = process.env.FORGE_REQUEST_PRUNE;
      process.env.FORGE_REQUEST_PRUNE = "1";
      try {
        const msgs = steps(14, { bodyChars: 9000 });
        const snap = JSON.stringify(msgs);
        const req = buildChatRequest(
          { ...DEFAULT_CONFIG, model: "grok-4.6" },
          msgs,
        );
        assert.equal(JSON.stringify(msgs), snap);
        const omitted = req.messages.filter(
          (m) =>
            typeof m.content === "string" &&
            m.content.startsWith(REQUEST_PRUNE_OMITTED),
        );
        assert.ok(omitted.length >= 4);
        const collapsed = req.messages.filter((m) => {
          if (m.role !== "assistant" || !m.tool_calls?.length) return false;
          return m.tool_calls[0]!.function.arguments.includes("_cleared");
        });
        assert.ok(collapsed.length >= 10);
      } finally {
        if (prev === undefined) delete process.env.FORGE_REQUEST_PRUNE;
        else process.env.FORGE_REQUEST_PRUNE = prev;
      }
    });
  });

  it("spool:true writes a stable path and reuses it", () => {
    withForgeHome(() => {
      const msgs = steps(12, { bodyChars: 5000 });
      const r1 = pruneMessagesForRequest(msgs, { spool: true });
      const r2 = pruneMessagesForRequest(msgs, { spool: true });
      const a = r1.messages.find(
        (m) =>
          m.role === "tool" &&
          (m.content || "").startsWith(REQUEST_PRUNE_OMITTED),
      )!.content as string;
      const b = r2.messages.find(
        (m) =>
          m.role === "tool" &&
          (m.content || "").startsWith(REQUEST_PRUNE_OMITTED),
      )!.content as string;
      const pathOf = (s: string) => {
        const m = /Full output: (\S+)/.exec(s);
        return m?.[1];
      };
      const p1 = pathOf(a);
      const p2 = pathOf(b);
      assert.ok(p1);
      assert.equal(p1, p2);
      assert.ok(fs.existsSync(p1!));
      assert.equal(fs.readFileSync(p1!, "utf8").length, 5000);
      const dir = path.dirname(p1!);
      const files = fs.readdirSync(dir).filter((f) => f.startsWith("req_"));
      const hard = assistantStepAges(r1.messages).filter(
        (age, i) => r1.messages[i]?.role === "tool" && age >= 10,
      ).length;
      assert.equal(files.length, hard);
    });
  });

  it("FORGE_REQUEST_PRUNE=0 disables", () => {
    const prev = process.env.FORGE_REQUEST_PRUNE;
    process.env.FORGE_REQUEST_PRUNE = "0";
    try {
      assert.equal(requestPruneEnvConfig().enabled, false);
      const msgs = steps(14);
      const r = pruneMessagesForRequest(msgs);
      assert.equal(r.changed, false);
      assert.strictEqual(r.messages, msgs);
    } finally {
      if (prev === undefined) delete process.env.FORGE_REQUEST_PRUNE;
      else process.env.FORGE_REQUEST_PRUNE = prev;
    }
  });

  it("harness user messages do not reset assistant-step age", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "real mandate" },
      ...steps(12).slice(1), // drop extra system
      {
        role: "user",
        content: "[Forge harness — mid-conversation update]\ncycle=1",
      },
      assistantCall("hot", "read_file", JSON.stringify({ path: "z.ts" })),
      toolMsg("hot", "Z".repeat(8000)),
    ];
    const r = pruneMessagesForRequest(msgs, { spool: false });
    const lastTool = [...r.messages].reverse().find((m) => m.role === "tool");
    assert.equal((lastTool!.content || "").length, 8000);
    const firstTool = r.messages.find((m) => m.role === "tool");
    assert.ok((firstTool!.content || "").startsWith(REQUEST_PRUNE_OMITTED));
  });

  it("keeps the newest admit and Stop re-anchor; stubs older ones", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "## ULW armed\nMandate: evaluate then improve" },
    ];
    for (let i = 0; i < 4; i++) {
      msgs.push({
        role: "user",
        content: `[Forge harness — mid-conversation update]\nwave=${i}  ${"x".repeat(200)}`,
      });
      msgs.push({
        role: "user",
        content: `[Forge ULW cycle driver] Stop blocked — cycle=1 wave=${i} ${"y".repeat(200)}`,
      });
    }
    const orig = msgs.map((m) =>
      m.role === "user" ? String(m.content) : "",
    );
    const r = pruneMessagesForRequest(msgs, { spool: false });
    assert.ok((r.stubbedHarness ?? 0) >= 6);
    const users = r.messages.filter((m) => m.role === "user");
    const stubs = users.filter((m) => m.content === HARNESS_USER_STUB);
    const liveAdmits = users.filter(
      (m) =>
        typeof m.content === "string" &&
        m.content.startsWith("[Forge harness — mid-conversation update]"),
    );
    const liveStops = users.filter(
      (m) =>
        typeof m.content === "string" &&
        m.content.startsWith("[Forge ULW cycle driver]"),
    );
    assert.equal(liveAdmits.length, 1);
    assert.equal(liveStops.length, 1);
    assert.match(String(liveAdmits[0]!.content), /wave=3/);
    assert.match(String(liveStops[0]!.content), /wave=3/);
    assert.ok(stubs.length >= 6);
    // session-shaped input is not mutated
    assert.equal(
      msgs.filter((m) => m.role === "user" && m.content === HARNESS_USER_STUB)
        .length,
      0,
    );
    assert.ok(orig[1]?.startsWith("## ULW armed"));
    const kick = users.find((m) =>
      String(m.content).startsWith("## ULW armed"),
    );
    assert.ok(kick);
    const collapsed = collapseStaleHarnessUserMessages(msgs);
    assert.equal(collapsed.changed, true);
    assert.ok(collapsed.stubbed >= 6);
  });

  it("countHarnessUserPokes meters admits, stops, and proof pokes", async () => {
    const { countHarnessUserPokes } = await import(
      "../src/session/request-prune.js"
    );
    const msgs: ChatMessage[] = [
      { role: "user", content: "## ULW armed\nMandate: evaluate" },
      {
        role: "user",
        content: "[Forge harness — mid-conversation update]\nw=1",
      },
      { role: "user", content: "[Forge ULW cycle driver] Stop blocked" },
      { role: "user", content: "[Forge harness — verify nudge]\nrun tests" },
      { role: "user", content: "real user steering" },
    ];
    const c = countHarnessUserPokes(msgs);
    assert.equal(c.harnessUserPokes, 3);
    assert.equal(c.admitCount, 2);
    assert.equal(c.proofPokes, 1);
    const withUlwProof = countHarnessUserPokes([
      ...msgs,
      {
        role: "user",
        content:
          "[Forge ULW cycle driver] Last wave ran no successful verification — run proof NOW",
      },
    ]);
    assert.equal(withUlwProof.proofPokes, 2);
    assert.equal(withUlwProof.harnessUserPokes, 4);
    assert.equal(withUlwProof.admitCount, 3);
  });
});
