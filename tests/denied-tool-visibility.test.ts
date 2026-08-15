/**
 * Plan/permission denials must still pair onToolStart/onToolEnd so the
 * REPL prints ✗ write_file instead of a silent skip.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgentLoop } from "../src/agent/loop.js";
import {
  createSession,
  enterSessionPlanMode,
} from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { McpManager } from "../src/mcp/manager.js";
import { LspManager } from "../src/lsp/manager.js";
import { formatToolEnd } from "../src/util/format.js";
import type { LLMProvider, ChatResponse } from "../src/providers/types.js";

function replyWithWrite(): ChatResponse {
  return {
    id: "chatcmpl_deny",
    model: "grok-4.6",
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_write_1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "secret.txt",
              content: "should not land",
            }),
          },
        },
      ],
    },
    finish_reason: "tool_calls",
    usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
  };
}

function replyStop(text = "Staying in plan mode."): ChatResponse {
  return {
    id: "chatcmpl_stop",
    model: "grok-4.6",
    message: { role: "assistant", content: text },
    finish_reason: "stop",
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  };
}

describe("denied tool visibility", () => {
  let tmp: string;
  const prevHome = process.env.FORGE_HOME;
  const prevMcp = process.env.FORGE_MCP;
  const prevLsp = process.env.FORGE_LSP;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-deny-vis-"));
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

  it("emits onToolStart/onToolEnd when plan mode denies a write", async () => {
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.6",
    });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "default" as const,
      maxTurns: 4,
      goal: { ...DEFAULT_CONFIG.goal, autoArm: false },
    };
    enterSessionPlanMode(config, session);
    const hooks = new HookRunner(config, tmp);
    const permissions = new PermissionGate({ interactive: false });
    const mcp = new McpManager({
      workspace: tmp,
      config: { enabled: false, servers: {}, sources: [] },
    });
    const lsp = new LspManager({
      workspace: tmp,
      config: { enabled: false, servers: [], sources: [] },
    });

    let calls = 0;
    const provider: LLMProvider = {
      id: "xai",
      async chat() {
        calls += 1;
        return calls === 1 ? replyWithWrite() : replyStop();
      },
      async chatStream(_req, onDelta) {
        calls += 1;
        if (calls === 1) return replyWithWrite();
        onDelta({ content: "Staying in plan mode." });
        return replyStop();
      },
    };

    const starts: Array<{ name: string; input: Record<string, unknown> }> = [];
    const ends: Array<{
      name: string;
      isError?: boolean;
      output?: string;
    }> = [];

    const result = await runAgentLoop({
      config,
      provider,
      session,
      hooks,
      permissions,
      userMessage: "write a file",
      stream: true,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
      events: {
        onToolStart(name, input) {
          starts.push({ name, input });
        },
        onToolEnd(name, info) {
          ends.push({ name, isError: info.isError, output: info.output });
        },
      },
    });

    assert.equal(result.aborted, false);
    assert.equal(starts.length, 1, "denied write must still fire onToolStart");
    assert.equal(starts[0].name, "write_file");
    assert.equal(ends.length, 1, "denied write must still fire onToolEnd");
    assert.equal(ends[0].name, "write_file");
    assert.equal(ends[0].isError, true);
    assert.match(String(ends[0].output), /denied|plan/i);
    assert.match(
      formatToolEnd("write_file", {
        isError: true,
        ms: 0,
        bytes: 20,
        args: { path: "secret.txt" },
      }),
      /✗ write secret\.txt/,
    );
    assert.equal(
      fs.existsSync(path.join(tmp, "secret.txt")),
      false,
      "plan mode must still block the write",
    );
  });
});
