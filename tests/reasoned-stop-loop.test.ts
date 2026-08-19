/**
 * Loop-level: reasoned empty Stop must not inject the empty-continue poke.
 * Maze unlimited: 50k-char thought + finish_reason=stop → "Do not stop. Act."
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgentLoop } from "../src/agent/loop.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { McpManager } from "../src/mcp/manager.js";
import { LspManager } from "../src/lsp/manager.js";
import { armUlwCycle, disarmUlwCycle } from "../src/harness/ulw-cycle.js";
import { REASONING_WALL_FINISH } from "../src/agent/reasoned-stop.js";
import type { LLMProvider, ChatResponse } from "../src/providers/types.js";

function reasonedEmpty(): ChatResponse {
  return {
    id: "chatcmpl_thought",
    model: "grok-4.6",
    message: {
      role: "assistant",
      content: null,
      reasoning_content: "I MUST pick a DIFFERENT surface. ".repeat(40),
    },
    finish_reason: "stop",
    usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 },
  };
}

function trueEmpty(): ChatResponse {
  return {
    id: "chatcmpl_blank",
    model: "grok-4.6",
    message: { role: "assistant", content: null },
    finish_reason: "stop",
    usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 },
  };
}

function reasoningWall(): ChatResponse {
  return {
    id: "chatcmpl_wall",
    model: "grok-4.6",
    message: {
      role: "assistant",
      content: null,
      reasoning_content: "still picking a surface",
    },
    finish_reason: REASONING_WALL_FINISH,
    usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 },
  };
}

function textReply(text: string): ChatResponse {
  return {
    id: "chatcmpl_text",
    model: "grok-4.6",
    message: { role: "assistant", content: text },
    finish_reason: "stop",
    usage: { prompt_tokens: 22, completion_tokens: 6, total_tokens: 28 },
  };
}

function scriptedProvider(
  replies: ChatResponse[],
): LLMProvider & { calls: number; reqs: import("../src/providers/types.js").ChatRequest[] } {
  const state = {
    calls: 0,
    reqs: [] as import("../src/providers/types.js").ChatRequest[],
  };
  return {
    id: "xai",
    get calls() {
      return state.calls;
    },
    get reqs() {
      return state.reqs;
    },
    async chat(req) {
      state.reqs.push(req);
      const i = Math.min(state.calls, replies.length - 1);
      state.calls += 1;
      return replies[i]!;
    },
    async chatStream(req, onDelta) {
      state.reqs.push(req);
      const i = Math.min(state.calls, replies.length - 1);
      state.calls += 1;
      const r = replies[i]!;
      if (r.message.reasoning_content) {
        onDelta({ reasoning_content: r.message.reasoning_content });
      }
      if (r.message.content) onDelta({ content: r.message.content });
      return r;
    },
  };
}

describe("reasoned empty Stop in the agent loop", () => {
  let tmp: string;
  const prevHome = process.env.FORGE_HOME;
  const prevMcp = process.env.FORGE_MCP;
  const prevLsp = process.env.FORGE_LSP;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-reasoned-"));
    process.env.FORGE_HOME = path.join(tmp, "home");
    process.env.FORGE_MCP = "0";
    process.env.FORGE_LSP = "0";
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevMcp === undefined) delete process.env.FORGE_MCP;
    else process.env.FORGE_MCP = prevMcp;
    if (prevLsp === undefined) delete process.env.FORGE_LSP;
    else process.env.FORGE_LSP = prevLsp;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  function harness() {
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.6",
    });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      maxTurns: 4,
      goal: { ...DEFAULT_CONFIG.goal, autoArm: false },
    };
    return {
      session,
      config,
      hooks: new HookRunner(config, tmp),
      permissions: new PermissionGate({ interactive: false }),
      mcp: new McpManager({
        workspace: tmp,
        config: { enabled: false, servers: {}, sources: [] },
      }),
      lsp: new LspManager({
        workspace: tmp,
        config: { enabled: false, servers: [], sources: [] },
      }),
    };
  }

  it("does not empty-continue after a reasoned stop", async () => {
    const h = harness();
    const provider = scriptedProvider([reasonedEmpty(), textReply("Should not be asked.")]);
    const result = await runAgentLoop({
      ...h,
      provider,
      userMessage: "continue the mandate",
      stream: true,
      disableHarnessAutoArm: true,
    });
    assert.equal(result.aborted, false);
    assert.equal(provider.calls, 1, "Stop after thought — no second provider call");
    const dumped = JSON.stringify(h.session.messages);
    assert.doesNotMatch(dumped, /Previous model response was empty/);
  });

  it("does not empty-continue after a reasoning-wall finish", async () => {
    const h = harness();
    const provider = scriptedProvider([reasoningWall(), textReply("Should not be asked.")]);
    const result = await runAgentLoop({
      ...h,
      provider,
      userMessage: "continue the mandate",
      stream: true,
      disableHarnessAutoArm: true,
    });
    assert.equal(result.aborted, false);
    assert.equal(provider.calls, 1, "reasoning_wall is Stop, not a glitch");
    const dumped = JSON.stringify(h.session.messages);
    assert.doesNotMatch(dumped, /Previous model response was empty/);
  });

  it("ULW still re-anchors a reasoned stop (no empty-continue poke)", async () => {
    const h = harness();
    armUlwCycle(h.session.meta.id, "Ship the feature.", {
      cycle: 1,
      skipCheckpoint: true,
    });
    const provider = scriptedProvider([
      reasonedEmpty(),
      textReply("Acting on the ULW re-anchor."),
    ]);
    try {
      const result = await runAgentLoop({
        ...h,
        provider,
        userMessage: "continue the mandate",
        stream: true,
        disableHarnessAutoArm: true,
      });
      assert.equal(result.aborted, false);
      assert.ok(provider.calls >= 2, "cycle=1 must keep driving after reasoned Stop");
      assert.equal(
        provider.reqs[1]?.tool_choice,
        "required",
        "next call after thought-only must force a tool",
      );
      const dumped = JSON.stringify(h.session.messages);
      assert.doesNotMatch(dumped, /Previous model response was empty/);
      assert.match(dumped, /Forge ULW cycle driver/);
      assert.match(dumped, /Acting on the ULW re-anchor/);
      assert.match(dumped, /next output MUST be a tool call/);
    } finally {
      disarmUlwCycle(h.session.meta.id);
    }
  });

  it("still empty-continues a true glitch (no thought)", async () => {
    const h = harness();
    const provider = scriptedProvider([trueEmpty(), textReply("Acting now.")]);
    const result = await runAgentLoop({
      ...h,
      provider,
      userMessage: "continue the mandate",
      stream: true,
      disableHarnessAutoArm: true,
    });
    assert.equal(result.aborted, false);
    assert.ok(provider.calls >= 2, "true empty still nudges");
    const dumped = JSON.stringify(h.session.messages);
    assert.match(dumped, /Previous model response was empty/);
    assert.match(dumped, /Acting now/);
  });
});
