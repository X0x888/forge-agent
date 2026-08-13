import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksLikeSymbolPattern } from "../src/agent/tools/grep.js";
import { executeTool } from "../src/agent/tools/index.js";

describe("looksLikeSymbolPattern", () => {
  it("accepts identifiers and rejects regex", () => {
    assert.equal(looksLikeSymbolPattern("waitForTasks"), true);
    assert.equal(looksLikeSymbolPattern("formatFallbackChain"), true);
    assert.equal(looksLikeSymbolPattern("foo.bar"), true);
    assert.equal(looksLikeSymbolPattern("TODO|FIXME"), false);
    assert.equal(looksLikeSymbolPattern("foo.*bar"), false);
    assert.equal(looksLikeSymbolPattern("a"), false);
  });
});

describe("empty grep hint", () => {
  it("points at lsp workspace_symbols for a missing identifier", async () => {
    const r = await executeTool(
      "grep",
      JSON.stringify({
        pattern: "DefinitelyNotARealForgeSymbolZZZ",
        path: "src/util",
        head_limit: 5,
      }),
      { workspace: process.cwd() },
    );
    assert.match(r.output, /No matches found/);
    assert.match(r.output, /workspace_symbols/);
  });
});
