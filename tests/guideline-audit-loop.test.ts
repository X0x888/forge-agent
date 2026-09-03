/**
 * Loop-level: the guideline brief is the first harness message after the
 * prompt, a read_file of AGENTS.md counts as the look, the harness stamps
 * the file at Stop and reports it on the LoopResult — and under ULW the
 * ignored brief is still bounced, because the cycle driver answers every
 * Stop it is given.
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
} from "../src/harness/guideline-audit.js";
import {
  loadUlwCycle,
  setCycleFlag,
  type UlwCycleState,
} from "../src/harness/ulw-cycle.js";
import { armUlwReady } from "./helpers/ulw-arm.js";
import type { LLMProvider, ChatResponse } from "../src/providers/types.js";

function readReply(p: string): ChatResponse {
  return {
    id: "chatcmpl_read",
    model: "grok-4.6",
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_read_1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: p }),
          },
        },
      ],
    },
    finish_reason: "tool_calls",
    usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
  };
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
    // this repo, git walks up from a fake one, and the ULW auto-commit in the
    // cycle test would then commit the developer's working tree.
    execFileSync("git", ["init", "-q", "."], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"x"}');
    fs.writeFileSync(
      path.join(tmp, "AGENTS.md"),
      "# AGENTS.md\n\n- `npm test`\n\n## Layout\n\n- `src/` code\n",
    );
    // Belt and braces: these tests are about the audit, not about committing.
    process.env.FORGE_ULW_AUTO_COMMIT = "0";
    // FORGE_HOME outside the workspace: session sidecars must not become
    // files an auto-commit could pick up.
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

  it("briefs first, credits the read, stamps at Stop, reports on the result", async () => {
    const { config, hooks, permissions, mcp, lsp } = harness();
    const session = createSession({ cwd: tmp, provider: "xai", model: "grok-4.6" });
    let calls = 0;
    const provider: LLMProvider = {
      id: "xai",
      async chat(req) {
        calls += 1;
        // The brief must already be in the transcript on the first call.
        if (calls === 1) {
          const users = req.messages.filter((m) => m.role === "user");
          const promptIdx = users.findIndex(
            (m) => typeof m.content === "string" && m.content === "what does this repo do?",
          );
          assert.ok(promptIdx >= 0, "user prompt present");
          // The brief follows the prompt (after the one-line git admit).
          const brief = users
            .slice(promptIdx + 1)
            .find(
              (m) =>
                typeof m.content === "string" &&
                m.content.startsWith(GUIDELINE_BRIEF_PREFIX),
            );
          assert.ok(brief, "guideline brief follows the prompt");
          assert.match(String(brief!.content), /AGENTS\.md — .* never proofread/);
          return readReply("AGENTS.md");
        }
        return stopReply("It is a small CLI. Done.");
      },
      async chatStream(req, onDelta) {
        const r = await this.chat(req);
        if (r.message.content) onDelta({ content: r.message.content });
        return r;
      },
    };

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
    assert.equal(result.aborted, false);
    assert.ok(result.guidelines, "LoopResult carries the audit outcome");
    assert.deepEqual(result.guidelines!.stamped, ["AGENTS.md"]);
    assert.deepEqual(result.guidelines!.revised, []);
    assert.deepEqual(result.guidelines!.ignored, []);
    const text = fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8");
    assert.match(text, /^<!-- proofread \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z · forge -->\n\n# AGENTS\.md/);
    // Registry written under FORGE_HOME.
    const regDir = path.join(home, "guidelines");
    assert.ok(fs.existsSync(regDir) && fs.readdirSync(regDir).length === 1);
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
      async chatStream(req, onDelta) {
        const r = await this.chat(req);
        if (r.message.content) onDelta({ content: r.message.content });
        return r;
      },
    };
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
  // The ULW cycle driver answers every Stop it is handed: while ULW is armed
  // `evaluateUlwAtStop` either blocks or sets a release flag, and stop-guard
  // returns on both. A guard placed behind the driver is therefore dead in
  // every `/ulw` run — which is exactly the run a badly steering AGENTS.md
  // does the most damage in. Move the guard back behind step 3 and this test
  // sees zero bounces.
  it("under ULW the ignored brief is still bounced, once, ahead of the driver", async () => {
    const { config: base, hooks, permissions, mcp, lsp } = harness();
    const config = {
      ...base,
      maxTurns: 8,
      goal: { ...base.goal, enabled: false },
    };
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.6",
      ultrawork: true,
    });
    armUlwReady(session.meta.id, "make the importer stream");
    setCycleFlag(session.meta.id, 0);
    const before = loadUlwCycle(session.meta.id)!;

    // A clean run-wide closer: nothing but the guideline guard may hold it.
    const closer = [
      "**Cycle complete.**",
      "",
      "Done — the importer streams now.",
      "",
      "**What shipped**",
      "- Streaming importer.",
      "",
      "**Verified**",
      "- `npm test` — green.",
      "",
      "**Needs you**",
      "- Nothing.",
      "",
      "Must-fix: none",
      "Live-with: none this run.",
    ].join("\n");

    const seen: string[] = [];
    const ledgerAtCall: Array<UlwCycleState | null> = [];
    let calls = 0;
    const provider: LLMProvider = {
      id: "xai",
      async chat(req) {
        calls += 1;
        ledgerAtCall.push(loadUlwCycle(session.meta.id));
        const last = req.messages[req.messages.length - 1];
        if (typeof last?.content === "string") seen.push(last.content);
        // Never reads AGENTS.md — the brief is ignored for the whole run.
        return stopReply(closer);
      },
      async chatStream(req, onDelta) {
        const r = await this.chat(req);
        if (r.message.content) onDelta({ content: r.message.content });
        return r;
      },
    };

    const result = await runAgentLoop({
      config,
      provider,
      session,
      hooks,
      permissions,
      userMessage: "ship it",
      stream: false,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });

    const bounces = seen.filter((m) =>
      /guideline-audit\] Stop blocked once/.test(m),
    );
    assert.equal(bounces.length, 1, "the guard fires under ULW, exactly once");
    assert.match(bounces[0], /none of AGENTS\.md was read/);
    // Round 2 is the bounce being answered; the ULW wrap nudge and the
    // release follow. Bounded so a second bounce cannot hide here.
    assert.ok(calls >= 2 && calls <= 4, `bounded rounds, got ${calls}`);

    // The bounce landed ahead of the driver, so the wave ledger is untouched:
    // no wave, no block, no evidence nudge was spent on it.
    const atBounce = ledgerAtCall[1]!;
    assert.ok(atBounce, "ULW sidecar still there on the bounce round");
    assert.equal(atBounce.waves?.length ?? 0, before.waves?.length ?? 0);
    assert.equal(atBounce.blocks, before.blocks);
    assert.equal(atBounce.evidenceNudges ?? 0, before.evidenceNudges ?? 0);
    assert.equal(atBounce.wrapNudgeDone ?? false, before.wrapNudgeDone ?? false);

    // …and the driver still releases on the very next Stop.
    assert.equal(result.lastCycleReleased, true);
    assert.equal(loadUlwCycle(session.meta.id)?.enabled, false);
    // The run report says the brief was ignored — no stamp was earned.
    assert.deepEqual(result.guidelines?.ignored, ["AGENTS.md"]);
    assert.deepEqual(result.guidelines?.stamped, []);
  });

  it("FORGE_GUIDELINE_AUDIT_BLOCK=0 keeps the brief but never bounces", async () => {
    process.env.FORGE_GUIDELINE_AUDIT_BLOCK = "0";
    try {
      const { config, hooks, permissions, mcp, lsp } = harness();
      const session = createSession({
        cwd: tmp,
        provider: "xai",
        model: "grok-4.6",
      });
      const seen: string[] = [];
      const provider: LLMProvider = {
        id: "xai",
        async chat(req) {
          const last = req.messages[req.messages.length - 1];
          if (typeof last?.content === "string") seen.push(last.content);
          return stopReply("It is a small CLI. Done.");
        },
        async chatStream(req, onDelta) {
          const r = await this.chat(req);
          if (r.message.content) onDelta({ content: r.message.content });
          return r;
        },
      };
      await runAgentLoop({
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
      assert.ok(
        seen.some((m) => m.startsWith(GUIDELINE_BRIEF_PREFIX)),
        "the brief is still emitted",
      );
      assert.equal(
        seen.filter((m) => /guideline-audit\] Stop blocked/.test(m)).length,
        0,
        "kill-switch off means no bounce",
      );
    } finally {
      delete process.env.FORGE_GUIDELINE_AUDIT_BLOCK;
    }
  });
});
