import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "../src/providers/types.js";
import {
  synthesizeSubagentFindings,
  resolveSubagentHandoffStatus,
  shouldSkipWorktreeLand,
  shouldFoldChildMutations,
  writeSubagentArtifact,
  formatSubagentResult,
  defaultSubagentMaxTurns,
  loadResumableSubagent,
} from "../src/agent/subagent.js";
import {
  formatSubagentNext,
  subagentWrapTurn,
  isReportOnlyBlockedTool,
} from "../src/agent/subagent-policy.js";
import { createSession, saveSession } from "../src/session/session.js";
import { clearStaleToolResults } from "../src/session/tool-clearing.js";
import { extractSavedOutputPath } from "../src/session/tool-clearing.js";

describe("subagent handoff", () => {
  it("classifies max-turns as incomplete, not completed", () => {
    assert.equal(
      resolveSubagentHandoffStatus({ hitMaxTurns: true }),
      "incomplete_max_turns",
    );
    assert.equal(
      resolveSubagentHandoffStatus({ hitCostCap: true }),
      "incomplete_cost_cap",
    );
    assert.equal(resolveSubagentHandoffStatus({}), "completed");
    assert.equal(
      resolveSubagentHandoffStatus({ error: "boom" }),
      "error",
    );
    assert.equal(
      resolveSubagentHandoffStatus({ aborted: true }),
      "aborted",
    );
    assert.equal(
      resolveSubagentHandoffStatus({ stopHookBlocked: true }),
      "stop_hook_blocked",
    );
  });

  it("skips worktree land unless the child completed", () => {
    assert.equal(shouldSkipWorktreeLand("completed"), false);
    assert.equal(shouldSkipWorktreeLand("incomplete_max_turns"), true);
    assert.equal(shouldSkipWorktreeLand("incomplete_cost_cap"), true);
    assert.equal(shouldSkipWorktreeLand("aborted"), true);
    assert.equal(shouldSkipWorktreeLand("error"), true);
    assert.equal(shouldSkipWorktreeLand("stop_hook_blocked"), true);
    assert.equal(shouldSkipWorktreeLand("skipped_explore_ledger"), true);
  });

  it("types child turn caps and wrap poke", () => {
    const prev = process.env.FORGE_SUBAGENT_MAX_TURNS;
    const prevGp = process.env.FORGE_SUBAGENT_GP_MAX_TURNS;
    const prevEx = process.env.FORGE_SUBAGENT_EXPLORE_MAX_TURNS;
    delete process.env.FORGE_SUBAGENT_MAX_TURNS;
    delete process.env.FORGE_SUBAGENT_GP_MAX_TURNS;
    delete process.env.FORGE_SUBAGENT_EXPLORE_MAX_TURNS;
    try {
      assert.equal(defaultSubagentMaxTurns("explore"), 25);
      assert.equal(defaultSubagentMaxTurns("plan"), 25);
      assert.equal(defaultSubagentMaxTurns("general-purpose"), 80);
      assert.equal(subagentWrapTurn(25), 20);
      assert.equal(subagentWrapTurn(80), 64);
      assert.equal(subagentWrapTurn(3), null);
      assert.equal(isReportOnlyBlockedTool("grep"), true);
      assert.equal(isReportOnlyBlockedTool("read_file"), false);
      assert.equal(isReportOnlyBlockedTool("bash"), true);
      assert.equal(isReportOnlyBlockedTool("lsp"), true);
    } finally {
      if (prev === undefined) delete process.env.FORGE_SUBAGENT_MAX_TURNS;
      else process.env.FORGE_SUBAGENT_MAX_TURNS = prev;
      if (prevGp === undefined) delete process.env.FORGE_SUBAGENT_GP_MAX_TURNS;
      else process.env.FORGE_SUBAGENT_GP_MAX_TURNS = prevGp;
      if (prevEx === undefined) delete process.env.FORGE_SUBAGENT_EXPLORE_MAX_TURNS;
      else process.env.FORGE_SUBAGENT_EXPLORE_MAX_TURNS = prevEx;
    }
  });

  it("types Next for incomplete vs skip vs explore", () => {
    const impl = formatSubagentNext({
      status: "incomplete_max_turns",
      subagentType: "general-purpose",
      sessionId: "child-abc",
    });
    assert.match(impl, /resume_session_id/);
    assert.match(impl, /child-abc/);
    const explore = formatSubagentNext({
      status: "incomplete_max_turns",
      subagentType: "explore",
      sessionId: "ex-1",
      artifactPath: "/tmp/a.md",
    });
    assert.match(explore, /pick:/);
    assert.match(explore, /Do not start a new explore/);
    const skip = formatSubagentNext({
      status: "skipped_explore_ledger",
      subagentType: "explore",
    });
    assert.match(skip, /not a look/);
  });

  it("resumes only a stamped child of this parent", () => {
    const prev = process.env.FORGE_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resume-"));
    process.env.FORGE_HOME = dir;
    try {
      const parent = createSession({
        cwd: dir,
        provider: "xai",
        model: "grok-4.6",
      });
      saveSession(parent);
      const child = createSession({
        cwd: dir,
        provider: "xai",
        model: "grok-4.6",
        title: "subagent: implement foo",
      });
      child.meta.subagent = {
        parentId: parent.meta.id,
        type: "general-purpose",
        isolation: "none",
      };
      saveSession(child);
      const ok = loadResumableSubagent(child.meta.id, parent.meta.id);
      assert.equal(ok.ok, true);
      const foreign = loadResumableSubagent(child.meta.id, "other-parent");
      assert.equal(foreign.ok, false);
      const missing = loadResumableSubagent("nope", parent.meta.id);
      assert.equal(missing.ok, false);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("folds isolation=none child mutations; worktree land owns parent journal", () => {
    assert.equal(shouldFoldChildMutations("none"), true);
    assert.equal(shouldFoldChildMutations(""), true);
    assert.equal(shouldFoldChildMutations("worktree"), false);
    assert.equal(shouldFoldChildMutations("git-worktree"), false);
    assert.equal(shouldFoldChildMutations("WORKTREE"), false);
  });

  it("synthesizes findings from a tool-only last turn", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "Mapped overflow compact and microcompaction." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"src/session/compaction.ts"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "t1",
        content:
          "File: src/session/compaction.ts (300 lines, showing 1-40)\nexport function compactMessages",
      },
      { role: "assistant", content: "I have enough evidence. One last check." },
    ];
    const text = synthesizeSubagentFindings(msgs);
    assert.match(text, /Synthesized findings/);
    assert.match(text, /Mapped overflow compact/);
    assert.match(text, /compaction\.ts/);
    assert.match(text, /One last check/);
  });

  it("writes an artifact the parent can restore after tool-clear", () => {
    const prev = process.env.FORGE_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-handoff-"));
    process.env.FORGE_HOME = dir;
    try {
      const body = "### Findings\n- steal OpenCode skill tool\n" + "x".repeat(2000);
      const artifact = writeSubagentArtifact({
        childId: "child-1",
        header: "### Subagent result: OSS audit\n- status: incomplete_max_turns",
        body,
      });
      assert.ok(fs.existsSync(artifact));
      assert.match(fs.readFileSync(artifact, "utf8"), /steal OpenCode skill tool/);

      const formatted = formatSubagentResult({
        header:
          "### Subagent result: OSS audit\n- status: incomplete_max_turns\n- session_id: child-1",
        text: body,
        artifactPath: artifact,
      });
      assert.match(formatted, /artifact_path:/);
      assert.match(formatted, /incomplete_max_turns/);

      const msgs: ChatMessage[] = [
        { role: "system", content: "sys" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "s1",
              type: "function",
              function: { name: "spawn_subagent", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "s1", content: formatted },
        { role: "user", content: "u0" },
        { role: "assistant", content: "a0" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u3" },
        { role: "assistant", content: "a3" },
        { role: "user", content: "u4" },
        { role: "assistant", content: "a4" },
        { role: "user", content: "u5" },
        { role: "assistant", content: "a5" },
        { role: "user", content: "u6" },
        { role: "assistant", content: "a6" },
        { role: "user", content: "u7" },
        { role: "assistant", content: "a7" },
      ];
      const cleared = clearStaleToolResults(msgs, { keepRecent: 4, minChars: 100 });
      assert.ok(cleared.cleared >= 1);
      const stub = cleared.messages[2].content as string;
      assert.match(stub, /Full output:/);
      assert.match(stub, /Do not re-run spawn_subagent/);
      const saved = extractSavedOutputPath(stub);
      assert.ok(saved);
      const restored = fs.readFileSync(saved!, "utf8");
      assert.match(restored, /steal OpenCode skill tool|artifact_path/);
    } finally {
      if (prev === undefined) delete process.env.FORGE_HOME;
      else process.env.FORGE_HOME = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
