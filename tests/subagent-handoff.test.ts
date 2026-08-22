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
  writeSubagentArtifact,
  formatSubagentResult,
} from "../src/agent/subagent.js";
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
