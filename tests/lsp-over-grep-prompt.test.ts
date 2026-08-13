import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { buildBaselineSystemPrompt } from "../src/agent/system-prompt.js";
import { TOOL_DEFINITIONS } from "../src/agent/tools/definitions.js";

describe("LSP over grep steering", () => {
  it("system prompt prefers LSP for known symbols", () => {
    const text = buildBaselineSystemPrompt({
      config: { ...DEFAULT_CONFIG, permissionMode: "default" },
      workspace: process.cwd(),
    });
    assert.match(text, /LSP over grep for symbols/);
    assert.match(text, /workspace_symbols/);
  });

  it("grep and lsp tool descriptions steer the same way", () => {
    const grep = TOOL_DEFINITIONS.find((t) => t.function.name === "grep");
    const lsp = TOOL_DEFINITIONS.find((t) => t.function.name === "lsp");
    assert.match(grep?.function.description ?? "", /prefer lsp/i);
    assert.match(
      lsp?.function.description ?? "",
      /workspace_symbols over repo-wide grep/,
    );
  });
});
