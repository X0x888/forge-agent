/**
 * Unattended ULW must not halt on continue-recoverable provider drops.
 *
 * Screenshot regression: `✖ terminated` / `[provider_error]` while auth was
 * still valid — typing "continue" refreshed OAuth and resumed. That must
 * happen in-loop (and via ULW auto-continue) without a typed prompt.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isRetryableError,
  isDroppedConnectionError,
  isContinueRecoverableProviderError,
  isPermanentProviderHalt,
} from "../src/util/retry.js";
import { formatProviderError } from "../src/providers/errors.js";
import { ProviderApiError } from "../src/providers/errors.js";
import { runAgentLoop, runAgentLoopThroughDrops } from "../src/agent/loop.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { McpManager } from "../src/mcp/manager.js";
import { LspManager } from "../src/lsp/manager.js";
import type { LLMProvider, ChatResponse } from "../src/providers/types.js";

function okReply(text = "Continuing the mandate."): ChatResponse {
  return {
    id: "chatcmpl_test",
    model: "grok-4.6",
    message: { role: "assistant", content: text },
    finish_reason: "stop",
    usage: {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
    },
  };
}

function mockProvider(opts: {
  failFirst?: number;
  failWith?: Error;
  onUpdate?: (token: string) => void;
}): LLMProvider & { calls: number; token: string } {
  const state = { calls: 0, token: "old" };
  const failFirst = opts.failFirst ?? 0;
  const failWith = opts.failWith ?? new Error("terminated");
  const provider: LLMProvider & { calls: number; token: string } = {
    id: "xai",
    get calls() {
      return state.calls;
    },
    get token() {
      return state.token;
    },
    updateCredentials(token: string) {
      state.token = token;
      opts.onUpdate?.(token);
    },
    async chat() {
      state.calls += 1;
      if (state.calls <= failFirst) throw failWith;
      return okReply();
    },
    async chatStream(_req, onDelta) {
      state.calls += 1;
      if (state.calls <= failFirst) throw failWith;
      onDelta({ content: "Continuing the mandate." });
      return okReply();
    },
  };
  return provider;
}

describe("dropped connection / continue-recoverable classification", () => {
  it("treats undici TypeError: terminated as a dropped connection", () => {
    const term = new Error("terminated");
    term.name = "TypeError";
    assert.equal(isDroppedConnectionError(term), true);
    assert.equal(isDroppedConnectionError(new Error("terminated")), true);
    assert.equal(isDroppedConnectionError(new Error("other side closed")), true);
    assert.equal(isDroppedConnectionError(new Error("socket hang up")), true);
    assert.equal(isRetryableError(term), true);
    assert.equal(isRetryableError(new Error("terminated")), true);
    assert.equal(isContinueRecoverableProviderError(term), true);
    assert.equal(isPermanentProviderHalt(term), false);
  });

  it("does not treat user abort, overflow, or quota as continue-recoverable", () => {
    assert.equal(isContinueRecoverableProviderError(new Error("Aborted")), false);
    assert.equal(
      isContinueRecoverableProviderError(
        new Error(
          "This model's maximum prompt length is 500000 but the request contains 500644 tokens.",
        ),
      ),
      false,
    );
    assert.equal(
      isContinueRecoverableProviderError(new Error("insufficient_quota")),
      false,
    );
    assert.equal(
      isContinueRecoverableProviderError(
        new ProviderApiError({
          provider: "xai",
          status: 429,
          body: "rate limit",
        }),
      ),
      false,
    );
    assert.equal(
      isPermanentProviderHalt(
        new ProviderApiError({
          provider: "xai",
          status: 400,
          body: "bad request: tools is not supported",
        }),
      ),
      true,
    );
  });

  it("classifies generic unknown errors as continue-recoverable (the screenshot)", () => {
    // formatProviderError used to leave this as provider_error + halt ULW
    const err = new Error("terminated");
    const fmt = formatProviderError(err);
    assert.equal(fmt.code, "network");
    assert.equal(isContinueRecoverableProviderError(err), true);
  });

  it("classifies provider glitch (non-retryable, non-HTTP) as continue-recoverable", () => {
    const err = new Error("provider glitch");
    assert.equal(isRetryableError(err), false);
    assert.equal(isContinueRecoverableProviderError(err), true);
  });
});

describe("in-loop + ULW auto-continue on provider drop", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevMcp: string | undefined;
  let prevLsp: string | undefined;
  let prevDrop: string | undefined;
  let prevAuto: string | undefined;
  let prevAutoMax: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-drop-recov-"));
    prevHome = process.env.FORGE_HOME;
    prevMcp = process.env.FORGE_MCP;
    prevLsp = process.env.FORGE_LSP;
    prevDrop = process.env.FORGE_PROVIDER_DROP_RECOVERY_MAX;
    prevAuto = process.env.FORGE_ULW_AUTO_CONTINUE;
    prevAutoMax = process.env.FORGE_ULW_AUTO_CONTINUE_MAX;
    process.env.FORGE_HOME = tmp;
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
    if (prevDrop === undefined) delete process.env.FORGE_PROVIDER_DROP_RECOVERY_MAX;
    else process.env.FORGE_PROVIDER_DROP_RECOVERY_MAX = prevDrop;
    if (prevAuto === undefined) delete process.env.FORGE_ULW_AUTO_CONTINUE;
    else process.env.FORGE_ULW_AUTO_CONTINUE = prevAuto;
    if (prevAutoMax === undefined) delete process.env.FORGE_ULW_AUTO_CONTINUE_MAX;
    else process.env.FORGE_ULW_AUTO_CONTINUE_MAX = prevAutoMax;
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
      ultrawork: true,
    });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "bypassPermissions" as const,
      goal: { ...DEFAULT_CONFIG.goal, autoArm: false },
    };
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
    return { session, config, hooks, permissions, mcp, lsp };
  }

  it("retries undici terminated inside withRetry and does not throw", async () => {
    const { session, config, hooks, permissions, mcp, lsp } = harness();
    const provider = mockProvider({
      failFirst: 1,
      failWith: Object.assign(new Error("terminated"), { name: "TypeError" }),
    });
    const result = await runAgentLoop({
      config,
      provider,
      session,
      hooks,
      permissions,
      userMessage: "keep going on the remaining holes",
      stream: true,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });
    assert.equal(result.aborted, false);
    assert.match(result.finalText, /Continuing/);
    assert.ok(provider.calls >= 2, "must retry after terminated");
  });

  it("force-retries a non-retryable generic provider_error in-loop (continue equivalent)", async () => {
    const { session, config, hooks, permissions, mcp, lsp } = harness();
    process.env.FORGE_PROVIDER_DROP_RECOVERY_MAX = "3";
    const provider = mockProvider({
      failFirst: 1,
      failWith: new Error("provider glitch"),
    });
    const result = await runAgentLoop({
      config,
      provider,
      session,
      hooks,
      permissions,
      userMessage: "keep going on the remaining holes",
      stream: true,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });
    assert.equal(result.aborted, false);
    assert.match(result.finalText, /Continuing/);
    assert.ok(provider.calls >= 2);
  });

  it("ULW auto-continues the same transcript when the loop still throws", async () => {
    const { session, config, hooks, permissions, mcp, lsp } = harness();
    // One in-loop drop retry, then escape; wrapper resumes without a new user turn.
    process.env.FORGE_PROVIDER_DROP_RECOVERY_MAX = "1";
    process.env.FORGE_ULW_AUTO_CONTINUE = "1";
    process.env.FORGE_ULW_AUTO_CONTINUE_MAX = "2";
    const provider = mockProvider({
      failFirst: 2,
      failWith: new Error("provider glitch"),
    });
    const result = await runAgentLoopThroughDrops({
      config,
      provider,
      session,
      hooks,
      permissions,
      userMessage: "keep going on the remaining holes",
      stream: true,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });
    assert.equal(result.aborted, false);
    assert.match(result.finalText, /Continuing/);
    const promptTurns = session.messages.filter(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("keep going on the remaining holes"),
    );
    assert.equal(
      promptTurns.length,
      1,
      "auto-continue must not append a second user 'continue' turn",
    );
    assert.ok(provider.calls >= 3);
  });
});
