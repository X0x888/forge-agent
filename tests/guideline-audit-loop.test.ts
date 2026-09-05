/**
 * Loop-level: the guideline brief is a harness message after the prompt, a
 * read_file of AGENTS.md counts as the look, a write that clears the fact
 * defect earns the stamp at Stop, and the outcome rides the LoopResult.
 *
 * And the other half of that: a turn that is only a question is not a work
 * turn. It is not diverted into a proofread and does not end with a write to
 * the user's tracked AGENTS.md — but the audit stays pending, so the next
 * real work prompt of the same session audits.
 *
 * There is no Stop block any more: an ignored fact brief is one line in the
 * report and re-briefs next session. This file pins that too.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runAgentLoop } from "../src/agent/loop.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { McpManager } from "../src/mcp/manager.js";
import { LspManager } from "../src/lsp/manager.js";
import {
  GUIDELINE_BRIEF_PREFIX,
  clearGuidelineAuditState,
  guidelineAuditState,
} from "../src/harness/guideline-audit.js";
import { buildRunReport } from "../src/harness/run-report.js";
import type { LLMProvider, ChatResponse } from "../src/providers/types.js";

const BROKEN_MAP =
  "# AGENTS.md\n\n- `npm test`\n\n## Layout\n\n- `src/gone.ts` the importer\n";
const FIXED_MAP =
  "# AGENTS.md\n\n- `npm test`\n\n## Layout\n\n- `src/index.ts` the importer\n";

function toolReply(id: string, name: string, args: Record<string, unknown>): ChatResponse {
  return {
    id: `chatcmpl_${id}`,
    model: "grok-4.6",
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_${id}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    finish_reason: "tool_calls",
    usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
  };
}

function readReply(p: string): ChatResponse {
  return toolReply("read", "read_file", { path: p });
}

function writeReply(p: string, content: string): ChatResponse {
  return toolReply("write", "write_file", { path: p, content });
}

function stopReply(text: string): ChatResponse {
  return {
    id: "chatcmpl_stop",
    model: "grok-4.6",
    message: { role: "assistant", content: text },
    finish_reason: "stop",
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  };
}

describe("guideline audit in the agent loop", () => {
  let tmp: string;
  let home: string;
  const prevHome = process.env.FORGE_HOME;
  const prevMcp = process.env.FORGE_MCP;
  const prevLsp = process.env.FORGE_LSP;
  const prevAudit = process.env.FORGE_GUIDELINE_AUDIT;
  const prevAutoCommit = process.env.FORGE_ULW_AUTO_COMMIT;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-guide-loop-"));
    // A real repo, not an empty `.git` dir: the suite's TMPDIR sits inside
    // this repo and git walks up from a fake one.
    execFileSync("git", ["init", "-q", "."], { cwd: tmp });
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      '{"name":"x","scripts":{"test":"node --test"}}',
    );
    fs.mkdirSync(path.join(tmp, "src"));
    fs.writeFileSync(path.join(tmp, "src", "index.ts"), "export {};\n");
    // One fact defect: the cited `src/gone.ts` does not exist.
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), BROKEN_MAP);
    process.env.FORGE_ULW_AUTO_COMMIT = "0";
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-guide-home-"));
    process.env.FORGE_HOME = home;
    process.env.FORGE_MCP = "0";
    process.env.FORGE_LSP = "0";
    delete process.env.FORGE_GUIDELINE_AUDIT;
    clearGuidelineAuditState();
  });

  afterEach(() => {
    clearGuidelineAuditState();
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevMcp === undefined) delete process.env.FORGE_MCP;
    else process.env.FORGE_MCP = prevMcp;
    if (prevLsp === undefined) delete process.env.FORGE_LSP;
    else process.env.FORGE_LSP = prevLsp;
    if (prevAudit === undefined) delete process.env.FORGE_GUIDELINE_AUDIT;
    else process.env.FORGE_GUIDELINE_AUDIT = prevAudit;
    if (prevAutoCommit === undefined) delete process.env.FORGE_ULW_AUTO_COMMIT;
    else process.env.FORGE_ULW_AUTO_COMMIT = prevAutoCommit;
    for (const d of [tmp, home]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  function harness() {
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "acceptEdits" as const,
      maxTurns: 6,
      compatClaudeHooks: false,
      compatCursorHooks: false,
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
    return { config, hooks, permissions, mcp, lsp };
  }

  function streamOf(provider: Pick<LLMProvider, "chat">): LLMProvider["chatStream"] {
    return async function (this: LLMProvider, req, onDelta) {
      const r = await provider.chat(req);
      if (r.message.content) onDelta({ content: r.message.content });
      return r;
    };
  }

  it("briefs the fact defect, credits read + fix, stamps at Stop, reports on the result", async () => {
    const { config, hooks, permissions, mcp, lsp } = harness();
    const session = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    let calls = 0;
    const provider: LLMProvider = {
      id: "xai",
      async chat(req) {
        calls += 1;
        if (calls === 1) {
          const users = req.messages.filter((m) => m.role === "user");
          const promptIdx = users.findIndex(
            (m) => typeof m.content === "string" && m.content === "add a streaming importer",
          );
          assert.ok(promptIdx >= 0, "user prompt present");
          const brief = users
            .slice(promptIdx + 1)
            .find(
              (m) => typeof m.content === "string" && m.content.startsWith(GUIDELINE_BRIEF_PREFIX),
            );
          assert.ok(brief, "guideline brief follows the prompt");
          const text = String(brief!.content);
          assert.match(text, /Fix now — factual defects/);
          assert.match(text, /AGENTS\.md: 1 path no longer exists: src\/gone\.ts/);
          assert.doesNotMatch(text, /Propose — doctrine/, "no doctrine issue on this file");
          return readReply("AGENTS.md");
        }
        if (calls === 2) return writeReply("AGENTS.md", FIXED_MAP);
        return stopReply("Fixed the dead path in AGENTS.md; the importer streams now.");
      },
      chatStream: undefined as unknown as LLMProvider["chatStream"],
    };
    provider.chatStream = streamOf(provider);

    const result = await runAgentLoop({
      config,
      provider,
      session,
      hooks,
      permissions,
      userMessage: "add a streaming importer",
      stream: false,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });
    assert.equal(result.aborted, false);
    assert.ok(result.guidelines, "LoopResult carries the audit outcome");
    assert.deepEqual(result.guidelines!.stamped, ["AGENTS.md"]);
    assert.equal(result.guidelines!.revised.length, 1);
    assert.deepEqual(result.guidelines!.ignored, []);
    assert.deepEqual(result.guidelines!.unresolved, []);
    assert.deepEqual(result.guidelines!.proposals, []);
    const text = fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8");
    assert.match(text, /^<!-- proofread \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z · forge -->\n\n# AGENTS\.md/);
    assert.match(text, /src\/index\.ts/);
    const regDir = path.join(home, "guidelines");
    assert.ok(fs.existsSync(regDir) && fs.readdirSync(regDir).some((f) => f.endsWith(".json")));
  });

  // The class this closes: a harness mechanism that fires on a turn which is
  // not work. A question in any repo whose AGENTS.md has a defect must not
  // cost an injected brief or a write into the user's tracked file.
  it("a plain question is not audited: no brief, no stamp — and the next work prompt still audits", async () => {
    const { config, hooks, permissions, mcp, lsp } = harness();
    const session = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    const seen: string[] = [];
    let calls = 0;
    const provider: LLMProvider = {
      id: "xai",
      async chat(req) {
        calls += 1;
        for (const m of req.messages) {
          if (m.role === "user" && typeof m.content === "string") seen.push(m.content);
        }
        return stopReply("It is a small CLI that runs an agent loop.");
      },
      chatStream: undefined as unknown as LLMProvider["chatStream"],
    };
    provider.chatStream = streamOf(provider);

    const result = await runAgentLoop({
      config,
      provider,
      session,
      hooks,
      permissions,
      userMessage: "what does this repo do?",
      stream: false,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });

    assert.equal(calls, 1, `a question costs one round, got ${calls}`);
    assert.equal(result.aborted, false);
    assert.equal(seen.filter((m) => m.startsWith(GUIDELINE_BRIEF_PREFIX)).length, 0);
    assert.equal(result.guidelines, undefined, "no audit outcome on a Q&A run");
    assert.doesNotMatch(fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8"), /proofread/);
    assert.equal(fs.existsSync(path.join(home, "guidelines")), false);
    assert.equal(guidelineAuditState(session.meta.id)?.phase, "pending");

    const seen2: string[] = [];
    let calls2 = 0;
    const provider2: LLMProvider = {
      id: "xai",
      async chat(req) {
        calls2 += 1;
        for (const m of req.messages) {
          if (m.role === "user" && typeof m.content === "string") seen2.push(m.content);
        }
        if (calls2 === 1) return readReply("AGENTS.md");
        if (calls2 === 2) return writeReply("AGENTS.md", FIXED_MAP);
        return stopReply("Done — the importer streams now.");
      },
      chatStream: undefined as unknown as LLMProvider["chatStream"],
    };
    provider2.chatStream = streamOf(provider2);
    const result2 = await runAgentLoop({
      config,
      provider: provider2,
      session,
      hooks,
      permissions,
      userMessage: "add a streaming importer",
      stream: false,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });
    assert.ok(seen2.some((m) => m.startsWith(GUIDELINE_BRIEF_PREFIX)), "deferred brief goes out on the work prompt");
    assert.deepEqual(result2.guidelines?.stamped, ["AGENTS.md"]);
    assert.match(fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8"), /proofread/);
  });

  it("a later turn does not re-report the audit an earlier turn closed", async () => {
    const { config, hooks, permissions, mcp, lsp } = harness();
    const session = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    let calls = 0;
    const provider: LLMProvider = {
      id: "xai",
      async chat() {
        calls += 1;
        if (calls === 1) return readReply("AGENTS.md");
        if (calls === 2) return writeReply("AGENTS.md", FIXED_MAP);
        return stopReply("Done.");
      },
      chatStream: undefined as unknown as LLMProvider["chatStream"],
    };
    provider.chatStream = streamOf(provider);
    const first = await runAgentLoop({
      config,
      provider,
      session,
      hooks,
      permissions,
      userMessage: "add a streaming importer",
      stream: false,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });
    assert.deepEqual(first.guidelines?.stamped, ["AGENTS.md"]);

    const second = await runAgentLoop({
      config,
      provider,
      session,
      hooks,
      permissions,
      userMessage: "now add a retry",
      stream: false,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });
    assert.equal(second.guidelines, undefined, "the audit belongs to the turn that ran it");

    const guidelineSection = (): string =>
      (
        buildRunReport({ session, workspace: tmp, result: {} }).sections.find(
          (s) => s.title === "Agent guidelines",
        )?.lines || []
      ).join("\n");
    assert.doesNotMatch(guidelineSection(), /stamp updated|revised by the agent/);
  });

  it("with the kill-switch off there is no brief and no stamp", async () => {
    process.env.FORGE_GUIDELINE_AUDIT = "0";
    const { config, hooks, permissions, mcp, lsp } = harness();
    const session = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    const provider: LLMProvider = {
      id: "xai",
      async chat(req) {
        const briefed = req.messages.some(
          (m) => typeof m.content === "string" && m.content.startsWith(GUIDELINE_BRIEF_PREFIX),
        );
        assert.equal(briefed, false);
        return stopReply("Done.");
      },
      chatStream: undefined as unknown as LLMProvider["chatStream"],
    };
    provider.chatStream = streamOf(provider);
    const result = await runAgentLoop({
      config,
      provider,
      session,
      hooks,
      permissions,
      userMessage: "hi",
      stream: false,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });
    assert.equal(result.guidelines, undefined);
    assert.doesNotMatch(fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8"), /proofread/);
  });

  // The Stop block is gone. A model that ignores the fact brief is not held
  // for homework — the run ends in one round, the report says "not checked",
  // and the next session is briefed again. The old block cost a full provider
  // round on every session whose model chose the user's request first, and
  // under ULW it fired ahead of the cycle driver on every run.
  it("an ignored brief is never bounced — one round, reported as not checked, re-briefed next session", async () => {
    const { config, hooks, permissions, mcp, lsp } = harness();
    const session = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    const seen: string[] = [];
    let calls = 0;
    const provider: LLMProvider = {
      id: "xai",
      async chat(req) {
        calls += 1;
        const last = req.messages[req.messages.length - 1];
        if (typeof last?.content === "string") seen.push(last.content);
        return stopReply("Added the streaming importer in src/index.ts.");
      },
      chatStream: undefined as unknown as LLMProvider["chatStream"],
    };
    provider.chatStream = streamOf(provider);
    const result = await runAgentLoop({
      config,
      provider,
      session,
      hooks,
      permissions,
      userMessage: "add a streaming importer",
      stream: false,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });
    assert.equal(calls, 1, `no bounce: one round, got ${calls}`);
    assert.equal(seen.filter((m) => /guideline-audit\] Stop blocked/.test(m)).length, 0);
    assert.deepEqual(result.guidelines?.ignored, ["AGENTS.md"]);
    assert.deepEqual(result.guidelines?.stamped, []);
    assert.doesNotMatch(fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8"), /proofread/);

    // Next session: briefed again, because the defect is still there.
    clearGuidelineAuditState();
    const session2 = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    const seen2: string[] = [];
    const provider2: LLMProvider = {
      id: "xai",
      async chat(req) {
        for (const m of req.messages) {
          if (m.role === "user" && typeof m.content === "string") seen2.push(m.content);
        }
        return stopReply("ok");
      },
      chatStream: undefined as unknown as LLMProvider["chatStream"],
    };
    provider2.chatStream = streamOf(provider2);
    await runAgentLoop({
      config,
      provider: provider2,
      session: session2,
      hooks,
      permissions,
      userMessage: "add a retry",
      stream: false,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });
    assert.ok(seen2.some((m) => m.startsWith(GUIDELINE_BRIEF_PREFIX)), "re-briefed next session");
  });
});
