import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../src/providers/types.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { buildChatRequest } from "../src/agent/loop.js";
import { estimateRequestTokens, estimateTokens } from "../src/session/session.js";
import { outboundTokenEstimate } from "../src/statusline/snapshot.js";
import { TOOL_DEFINITIONS } from "../src/agent/tools/definitions.js";
import { REQUEST_PRUNE_AT_DEFAULT } from "../src/session/prompt-cache.js";
import {
  prepareOutboundMessages,
  applyStickyPrune,
  captureStickyPrune,
  stickyPruneValid,
  REQUEST_PRUNE_OMITTED,
  type RequestPruneSticky,
} from "../src/session/request-prune.js";

function assistantCall(id: string, name: string, args: string): ChatMessage {
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

function lastOmittedIndex(msgs: ChatMessage[]): number {
  let last = -1;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.startsWith(REQUEST_PRUNE_OMITTED)
    ) {
      last = i;
    }
  }
  return last;
}

describe("sticky request-prune", () => {
  it("two successive clips share an identical prefix after the first freeze", () => {
    const prev = process.env.FORGE_REQUEST_PRUNE;
    const prevAt = process.env.FORGE_REQUEST_PRUNE_AT;
    delete process.env.FORGE_REQUEST_PRUNE;
    delete process.env.FORGE_REQUEST_PRUNE_AT;
    try {
      const base = steps(40, { bodyChars: 24_000 });
      const est = 200_000;
      assert.ok(est >= REQUEST_PRUNE_AT_DEFAULT);
      const first = prepareOutboundMessages(base, {
        estimatedTokens: est,
        spool: false,
      });
      assert.equal(first.kind, "first_clip");
      assert.ok(first.sticky);
      assert.ok((first.sticky!.omitted.length || first.sticky!.collapsed.length) > 0);

      const grown = [
        ...base,
        assistantCall("hot", "read_file", JSON.stringify({ path: "z.ts" })),
        toolMsg("hot", "Z".repeat(4000)),
      ];
      const second = prepareOutboundMessages(grown, {
        estimatedTokens: est + 2000,
        sticky: first.sticky,
        spool: false,
      });
      assert.equal(second.kind, "sticky");
      const cut = lastOmittedIndex(first.messages);
      assert.ok(cut >= 0);
      assert.deepEqual(
        first.messages.slice(0, cut + 1),
        second.messages.slice(0, cut + 1),
      );
      const last = second.messages[second.messages.length - 1]!;
      assert.equal(last.role, "tool");
      assert.equal((last.content || "").length, 4000);
    } finally {
      if (prev === undefined) delete process.env.FORGE_REQUEST_PRUNE;
      else process.env.FORGE_REQUEST_PRUNE = prev;
      if (prevAt === undefined) delete process.env.FORGE_REQUEST_PRUNE_AT;
      else process.env.FORGE_REQUEST_PRUNE_AT = prevAt;
    }
  });

  it("invalidates when fewer than half the omitted ids remain", () => {
    const msgs = steps(14, { bodyChars: 5000 });
    const clip = prepareOutboundMessages(msgs, {
      estimatedTokens: 200_000,
      spool: false,
    });
    assert.ok(clip.sticky);
    assert.equal(stickyPruneValid(msgs, clip.sticky!), true);
    const dropped: ChatMessage[] = [
      { role: "system", content: "sys" },
      assistantCall("only", "read_file", "{}"),
      toolMsg("only", "x"),
    ];
    assert.equal(stickyPruneValid(dropped, clip.sticky!), false);
  });

  it("applyStickyPrune is byte-identical to the captured clip", () => {
    const msgs = steps(14, { bodyChars: 6000 });
    const clip = prepareOutboundMessages(msgs, {
      estimatedTokens: 200_000,
      spool: false,
    });
    assert.ok(clip.sticky);
    const applied = applyStickyPrune(msgs, clip.sticky!, { spool: false });
    assert.deepEqual(applied.messages, clip.messages);
    const recaptured = captureStickyPrune(msgs, clip.messages);
    assert.ok(recaptured.omitted.length >= clip.sticky!.omitted.length);
  });

  it("buildChatRequest freezes then reuses sticky across two calls", () => {
    const prev = process.env.FORGE_REQUEST_PRUNE;
    delete process.env.FORGE_REQUEST_PRUNE;
    try {
      const msgs = steps(40, { bodyChars: 24_000 });
      let sticky: RequestPruneSticky | undefined;
      const kinds: string[] = [];
      const r1 = buildChatRequest(
        { ...DEFAULT_CONFIG, model: "grok-4.6" },
        msgs,
        undefined,
        undefined,
        {
          estimatedTokens: 200_000,
          sticky,
          onPrune: (info) => {
            kinds.push(info.kind);
            sticky = info.sticky;
          },
        },
      );
      const grown = [
        ...msgs,
        assistantCall("n", "read_file", JSON.stringify({ path: "n.ts" })),
        toolMsg("n", "N".repeat(100)),
      ];
      const r2 = buildChatRequest(
        { ...DEFAULT_CONFIG, model: "grok-4.6" },
        grown,
        undefined,
        undefined,
        {
          estimatedTokens: 202_000,
          sticky,
          onPrune: (info) => {
            kinds.push(info.kind);
            sticky = info.sticky;
          },
        },
      );
      assert.deepEqual(kinds, ["first_clip", "sticky"]);
      const cut = lastOmittedIndex(r1.messages as ChatMessage[]);
      assert.ok(cut >= 0);
      assert.deepEqual(
        (r1.messages as ChatMessage[]).slice(0, cut + 1),
        (r2.messages as ChatMessage[]).slice(0, cut + 1),
      );
    } finally {
      if (prev === undefined) delete process.env.FORGE_REQUEST_PRUNE;
      else process.env.FORGE_REQUEST_PRUNE = prev;
    }
  });

  it("does not reclip every turn when the first clip is still over the cliff", () => {
    const prev = process.env.FORGE_REQUEST_PRUNE;
    const prevAt = process.env.FORGE_REQUEST_PRUNE_AT;
    delete process.env.FORGE_REQUEST_PRUNE;
    process.env.FORGE_REQUEST_PRUNE_AT = "100";
    try {
      const base = steps(14, { bodyChars: 8000 });
      const first = prepareOutboundMessages(base, {
        estimatedTokens: 200_000,
        spool: false,
      });
      assert.equal(first.kind, "first_clip");
      assert.ok((first.sticky?.wireTokens ?? 0) > 100);
      const grown = [
        ...base,
        assistantCall("n", "read_file", JSON.stringify({ path: "n.ts" })),
        toolMsg("n", "N".repeat(2000)),
      ];
      const second = prepareOutboundMessages(grown, {
        estimatedTokens: 210_000,
        sticky: first.sticky,
        spool: false,
      });
      assert.equal(second.kind, "sticky", "over-cliff first clip must freeze");
      const third = prepareOutboundMessages(grown, {
        estimatedTokens: 210_000,
        sticky: second.sticky,
        spool: false,
      });
      assert.equal(third.kind, "sticky");
    } finally {
      if (prev === undefined) delete process.env.FORGE_REQUEST_PRUNE;
      else process.env.FORGE_REQUEST_PRUNE = prev;
      if (prevAt === undefined) delete process.env.FORGE_REQUEST_PRUNE_AT;
      else process.env.FORGE_REQUEST_PRUNE_AT = prevAt;
    }
  });

  it("reclips once when a sub-cliff sticky wire grows back over", () => {
    const prev = process.env.FORGE_REQUEST_PRUNE;
    const prevAt = process.env.FORGE_REQUEST_PRUNE_AT;
    delete process.env.FORGE_REQUEST_PRUNE;
    process.env.FORGE_REQUEST_PRUNE_AT = "5000";
    try {
      const base = steps(20, { bodyChars: 12_000 });
      const first = prepareOutboundMessages(base, {
        estimatedTokens: 200_000,
        spool: false,
      });
      assert.equal(first.kind, "first_clip");
      assert.ok(first.sticky);
      // Last clip landed under the cliff; suffix then grows back over.
      first.sticky!.wireTokens = 1000;
      const grown = [...base];
      for (let i = 0; i < 6; i++) {
        grown.push(
          assistantCall(`g${i}`, "read_file", JSON.stringify({ path: `g${i}.ts` })),
        );
        grown.push(toolMsg(`g${i}`, "G".repeat(8000)));
      }
      const second = prepareOutboundMessages(grown, {
        estimatedTokens: 200_000,
        sticky: first.sticky,
        spool: false,
      });
      assert.equal(second.kind, "reclip");
      const third = prepareOutboundMessages(grown, {
        estimatedTokens: 200_000,
        sticky: second.sticky,
        spool: false,
      });
      assert.equal(third.kind, "sticky");
    } finally {
      if (prev === undefined) delete process.env.FORGE_REQUEST_PRUNE;
      else process.env.FORGE_REQUEST_PRUNE = prev;
      if (prevAt === undefined) delete process.env.FORGE_REQUEST_PRUNE_AT;
      else process.env.FORGE_REQUEST_PRUNE_AT = prevAt;
    }
  });

  it("HUD with a frozen set matches the sticky wire, not a sliding re-age", () => {
    const prev = process.env.FORGE_REQUEST_PRUNE;
    delete process.env.FORGE_REQUEST_PRUNE;
    try {
      const base = steps(40, { bodyChars: 24_000 });
      const first = prepareOutboundMessages(base, {
        estimatedTokens: 200_000,
        toolsJsonChars: JSON.stringify(TOOL_DEFINITIONS).length,
        spool: false,
      });
      assert.equal(first.kind, "first_clip");
      const grown = [
        ...base,
        assistantCall("hot", "read_file", JSON.stringify({ path: "z.ts" })),
        toolMsg("hot", "Z".repeat(4000)),
      ];
      const hud = outboundTokenEstimate(grown, first.sticky);
      const applied = prepareOutboundMessages(grown, {
        estimatedTokens: 210_000,
        toolsJsonChars: JSON.stringify(TOOL_DEFINITIONS).length,
        sticky: first.sticky,
        spool: false,
      });
      assert.equal(applied.kind, "sticky");
      assert.equal(
        hud,
        estimateRequestTokens(applied.messages, {
          toolsJsonChars: JSON.stringify(TOOL_DEFINITIONS).length,
          includeReasoning: true,
        }),
      );
    } finally {
      if (prev === undefined) delete process.env.FORGE_REQUEST_PRUNE;
      else process.env.FORGE_REQUEST_PRUNE = prev;
    }
  });

  it("HUD counts reasoning; prune estimator does not", () => {
    const prev = process.env.FORGE_REQUEST_PRUNE;
    delete process.env.FORGE_REQUEST_PRUNE;
    try {
      const msgs: ChatMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "ok",
          reasoning_content: "R".repeat(20_000),
        },
      ];
      const extras = { toolsJsonChars: 0 };
      const without = estimateRequestTokens(msgs, extras);
      const withR = estimateRequestTokens(msgs, {
        ...extras,
        includeReasoning: true,
      });
      assert.ok(withR > without, "20k reasoning must raise the HUD estimate");
      assert.equal(estimateTokens(msgs), without);
      const toolsChars = JSON.stringify(TOOL_DEFINITIONS).length;
      const hud = outboundTokenEstimate(msgs);
      assert.equal(
        hud,
        estimateRequestTokens(msgs, {
          toolsJsonChars: toolsChars,
          includeReasoning: true,
        }),
      );
      assert.ok(
        hud >
          estimateRequestTokens(msgs, {
            toolsJsonChars: toolsChars,
          }),
        "HUD must count reasoning; prune estimate must not",
      );
    } finally {
      if (prev === undefined) delete process.env.FORGE_REQUEST_PRUNE;
      else process.env.FORGE_REQUEST_PRUNE = prev;
    }
  });
});
