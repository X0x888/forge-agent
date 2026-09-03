/**
 * Loop-level: the ULW closer is the run's report. A `**Cycle complete.**`
 * that hands homework back is bounced before the driver sees it, the wave
 * ledger is untouched, and the clean re-attestation releases the cycle.
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
import { clearGuidelineAuditState } from "../src/harness/guideline-audit.js";
import { loadUlwCycle, setCycleFlag } from "../src/harness/ulw-cycle.js";
import { armUlwReady } from "./helpers/ulw-arm.js";
import type { LLMProvider, ChatResponse } from "../src/providers/types.js";

function stopReply(text: string): ChatResponse {
  return {
    id: "chatcmpl_stop",
    model: "grok-4.6",
    message: { role: "assistant", content: text },
    finish_reason: "stop",
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  };
}

const HOMEWORK_CLOSER = [
  "**Cycle complete.**",
  "",
  "Done — the importer streams now and 3 waves shipped since the mandate.",
  "",
  "**What shipped**",
  "- Streaming importer.",
  "",
  "**Verified**",
  "- `npm test` — green.",
  "",
  "Must-fix: none",
  "Live-with: none this run.",
  "",
  "You can now run the migration against staging when you are ready.",
].join("\n");

const CLEAN_CLOSER = HOMEWORK_CLOSER.replace(
  "You can now run the migration against staging when you are ready.",
  "**Needs you**\n- Nothing.",
);

describe("report guard in the agent loop", () => {
  let tmp: string;
  let home: string;
  const prevHome = process.env.FORGE_HOME;
  const prevMcp = process.env.FORGE_MCP;
  const prevLsp = process.env.FORGE_LSP;
  const prevAutoCommit = process.env.FORGE_ULW_AUTO_COMMIT;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rg-loop-"));
    // A real repo, not an empty `.git` dir: the suite's TMPDIR sits inside
    // this repo, git walks up from a fake one, and the ULW auto-commit would
    // then commit the developer's working tree.
    execFileSync("git", ["init", "-q", "."], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"x"}');
    // Belt and braces: this test is about the closer, not about committing.
    process.env.FORGE_ULW_AUTO_COMMIT = "0";
    // FORGE_HOME outside the workspace: session sidecars must not become
    // files the ULW auto-commit picks up.
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rg-home-"));
    process.env.FORGE_HOME = home;
    process.env.FORGE_MCP = "0";
    process.env.FORGE_LSP = "0";
    process.env.FORGE_GUIDELINE_AUDIT = "0";
    clearGuidelineAuditState();
  });

  afterEach(() => {
    clearGuidelineAuditState();
    delete process.env.FORGE_GUIDELINE_AUDIT;
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevMcp === undefined) delete process.env.FORGE_MCP;
    else process.env.FORGE_MCP = prevMcp;
    if (prevLsp === undefined) delete process.env.FORGE_LSP;
    else process.env.FORGE_LSP = prevLsp;
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

  it("bounces homework in the LAST attestation once, then releases on the clean one", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "acceptEdits" as const,
      maxTurns: 8,
      compatClaudeHooks: false,
      compatCursorHooks: false,
      goal: { ...DEFAULT_CONFIG.goal, autoArm: false, enabled: false },
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
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.6",
      ultrawork: true,
    });
    armUlwReady(session.meta.id, "improve the importer comprehensively");
    setCycleFlag(session.meta.id, 0);
    const before = loadUlwCycle(session.meta.id)!;

    const seen: string[] = [];
    let calls = 0;
    const provider: LLMProvider = {
      id: "xai",
      async chat(req) {
        calls += 1;
        const last = req.messages[req.messages.length - 1];
        if (typeof last?.content === "string") seen.push(last.content);
        return stopReply(calls === 1 ? HOMEWORK_CLOSER : CLEAN_CLOSER);
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
      userMessage: "wrap it up",
      stream: false,
      disableHarnessAutoArm: true,
      mcp,
      lsp,
    });

    // The homework closer is bounced once — and only once — by the report
    // guard; any further rounds belong to the ULW driver's own wrap demands.
    const bounces = seen.filter((m) =>
      /report-guard\] Stop blocked — the closing message hands work back/.test(m),
    );
    assert.equal(bounces.length, 1, "one report-guard bounce, then it lets go");
    assert.match(seen[1] || "", /report-guard\] Stop blocked/);
    assert.match(seen[1] || "", /migration against staging/);
    assert.ok(calls >= 2 && calls <= 4, `bounded rounds, got ${calls}`);
    // The bounce happened before the driver, so the wave ledger is untouched…
    const after = loadUlwCycle(session.meta.id);
    assert.equal(
      after?.waves?.length ?? 0,
      before.waves?.length ?? 0,
      "no wave was spent on the bounce",
    );
    // …and the clean re-attestation still releases the cycle.
    assert.equal(result.lastCycleReleased, true);
    assert.equal(after?.enabled, false);
  });
});
