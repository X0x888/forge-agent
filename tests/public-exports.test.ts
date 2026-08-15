import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeAdvisoryUserMessage,
  FileReadState,
  fileReadGuardEnabled,
  fileReadsForSession,
  clearFileReadsForSession,
  detectProjectIntel,
  evaluateProofClaimAtStop,
  McpManager,
  LspManager,
  loadMcpConfig,
  loadLspConfig,
  filterToolsForSubagent,
  resolveSubagentType,
  isMcpToolReadOnly,
  mcpToolNameLooksReadOnly,
  isMcpInvocationTool,
  mcpAlwaysAllowPattern,
  parsePorcelainPath,
  snapshotParentPreimages,
  journalLandedPreimages,
  restoreParentPreimages,
  defaultIsolationForSpawn,
  shouldPruneOutbound,
  sessionCacheRatio,
  parseExploreMap,
  normalizeExploreMaps,
  REQUEST_PRUNE_AT_DEFAULT,
} from "../src/index.js";

describe("public package exports (index)", () => {
  it("exports advisory intent helper", () => {
    assert.equal(typeof looksLikeAdvisoryUserMessage, "function");
    assert.equal(looksLikeAdvisoryUserMessage("what do you think?"), true);
  });

  it("exports FileReadState + guard flag", () => {
    assert.equal(typeof FileReadState, "function");
    assert.equal(typeof fileReadGuardEnabled, "function");
    assert.equal(typeof fileReadsForSession, "function");
    assert.equal(typeof clearFileReadsForSession, "function");
    const s = new FileReadState();
    assert.ok(s);
  });

  it("still exports project intel + proof-claim", () => {
    assert.equal(typeof detectProjectIntel, "function");
    assert.equal(typeof evaluateProofClaimAtStop, "function");
  });

  it("exports MCP / LSP / subagent surfaces", () => {
    assert.equal(typeof McpManager, "function");
    assert.equal(typeof LspManager, "function");
    assert.equal(typeof loadMcpConfig, "function");
    assert.equal(typeof loadLspConfig, "function");
    assert.equal(typeof filterToolsForSubagent, "function");
    assert.equal(resolveSubagentType("explore"), "explore");
    assert.equal(typeof isMcpToolReadOnly, "function");
    assert.equal(typeof mcpToolNameLooksReadOnly, "function");
    assert.equal(mcpToolNameLooksReadOnly("context7__query-docs"), true);
    assert.equal(typeof isMcpInvocationTool, "function");
    assert.equal(typeof mcpAlwaysAllowPattern, "function");
    assert.equal(
      mcpAlwaysAllowPattern({ tool_name: "context7__query-docs" }),
      "context7__query-docs",
    );
  });

  it("exports porcelain path parser (worktree land)", () => {
    assert.equal(typeof parsePorcelainPath, "function");
    assert.equal(
      parsePorcelainPath(" M src/agent/worktree.ts"),
      "src/agent/worktree.ts",
    );
    assert.equal(
      parsePorcelainPath("M src/agent/permissions.ts"),
      "src/agent/permissions.ts",
    );
    assert.equal(typeof snapshotParentPreimages, "function");
    assert.equal(typeof journalLandedPreimages, "function");
    assert.equal(typeof restoreParentPreimages, "function");
    assert.equal(typeof defaultIsolationForSpawn, "function");
    assert.equal(typeof shouldPruneOutbound, "function");
    assert.equal(shouldPruneOutbound(100).prune, false);
    assert.equal(typeof sessionCacheRatio, "function");
    assert.equal(typeof parseExploreMap, "function");
    assert.equal(typeof normalizeExploreMaps, "function");
    assert.ok(REQUEST_PRUNE_AT_DEFAULT >= 100_000);
    assert.equal(
      defaultIsolationForSpawn({ type: "explore", workspace: process.cwd() }),
      "none",
    );
  });
});
