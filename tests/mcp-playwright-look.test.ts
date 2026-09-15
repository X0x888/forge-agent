/**
 * Playwright look path. Unit tests never boot Chromium.
 * Live: FORGE_PLAYWRIGHT_LIVE=1 ./node_modules/.bin/tsx --test tests/mcp-playwright-look.test.ts
 * Use the local tsx binary — nested `npx tsx` can lock against the MCP npx.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpManager } from "../src/mcp/manager.js";
import { executeTool } from "../src/agent/tools/index.js";
import {
  bindPlaywrightSessionProfile,
  defaultMcpServers,
} from "../src/mcp/defaults.js";

describe("search_mcp empty vs playwright-down", () => {
  it("empty config stays a non-error miss", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pw-empty-"));
    const manager = new McpManager({
      workspace: ws,
      config: { servers: {}, sources: [], enabled: true },
    });
    manager.start();
    const r = await executeTool(
      "search_mcp",
      JSON.stringify({ query: "playwright screenshot browser" }),
      { workspace: ws, mcp: manager },
    );
    assert.equal(r.isError, false);
    assert.match(r.output, /No MCP tools/i);
    await manager.dispose();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("playwright configured but down is isError and forbids CDP scripts", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pw-down-"));
    fs.writeFileSync(path.join(ws, "vite.config.ts"), "export default {}\n");
    const manager = new McpManager({
      workspace: ws,
      config: {
        enabled: true,
        sources: [],
        servers: {
          playwright: {
            name: "playwright",
            command: "false",
            args: [],
            timeoutMs: 500,
          },
        },
      },
    });
    manager.start();
    await manager.prewarm(200);
    const r = await executeTool(
      "search_mcp",
      JSON.stringify({ query: "playwright screenshot browser" }),
      { workspace: ws, mcp: manager },
    );
    assert.equal(r.isError, true);
    assert.match(r.output, /Playwright MCP is down|No MCP tools/i);
    assert.match(r.output, /Do not write a Chrome\/CDP script/);
    await manager.dispose();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("bindPlaywrightSessionProfile drops --isolated for a UDD", () => {
    const cfg = defaultMcpServers().playwright;
    const bound = bindPlaywrightSessionProfile(cfg, "/tmp/look-udd");
    const blob = (bound.args || []).join(" ");
    assert.ok(blob.includes("--user-data-dir /tmp/look-udd"));
    assert.ok(!blob.includes("--isolated"));
    assert.equal(bound.env?.PLAYWRIGHT_MCP_ISOLATED, "0");
    const isolated = defaultMcpServers().playwright;
    assert.ok((isolated.args || []).includes("--isolated"));
    const user = bindPlaywrightSessionProfile(
      { name: "playwright", command: "npx", args: ["-y", "@playwright/mcp", "--user-data-dir", "/tmp/mine"] },
      "/tmp/look-udd",
    );
    assert.deepEqual(user.args, ["-y", "@playwright/mcp", "--user-data-dir", "/tmp/mine"]);
  });

  it("default recipe pins a versioned @playwright/mcp spec", () => {
    const prev = process.env.FORGE_PLAYWRIGHT_MCP;
    delete process.env.FORGE_PLAYWRIGHT_MCP;
    try {
      const pw = defaultMcpServers().playwright;
      const blob = (pw.args || []).join(" ");
      assert.match(blob, /@playwright\/mcp@0\.\d+\.\d+/);
      assert.ok(!blob.includes("@latest"));
      assert.ok((pw.args || []).includes("--headless"));
    } finally {
      if (prev === undefined) delete process.env.FORGE_PLAYWRIGHT_MCP;
      else process.env.FORGE_PLAYWRIGHT_MCP = prev;
    }
  });
});

const live = process.env.FORGE_PLAYWRIGHT_LIVE === "1";

describe("live Playwright MCP look", { skip: !live }, () => {
  it("search_mcp finds a screenshot tool and call_mcp writes a PNG", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pw-live-"));
    fs.writeFileSync(
      path.join(ws, "index.html"),
      "<!doctype html><title>forge-look</title><h1>forge-look</h1>",
    );
    fs.writeFileSync(path.join(ws, "vite.config.ts"), "export default {}\n");
    const manager = new McpManager({ workspace: ws, sessionId: "live-look" });
    manager.start();
    try {
      await manager.prewarm(20_000);
      const st = manager.playwrightStatus();
      const pw = manager.status().find((s) => /playwright/i.test(s.name));
      assert.equal(
        st,
        "ready",
        `playwright ${st ?? "missing"}: ${pw?.error || "no error"} args=${(manager.serverConfig("playwright")?.args || []).join(" ")}`,
      );
      const search = await executeTool(
        "search_mcp",
        JSON.stringify({ query: "screenshot", limit: 20 }),
        { workspace: ws, mcp: manager },
      );
      assert.ok(!search.isError, search.output);
      assert.match(search.output, /screenshot/i);
      const m = search.output.match(/\*\*(playwright__[\w-]+screenshot[\w-]*)\*\*/i)
        ?? search.output.match(/\*\*([\w]+__browser_take_screenshot)\*\*/i);
      assert.ok(m, `expected a screenshot tool in:\n${search.output}`);
      const nav = await executeTool(
        "call_mcp",
        JSON.stringify({
          tool_name: "playwright__browser_navigate",
          arguments: { url: `file://${path.join(ws, "index.html")}` },
        }),
        { workspace: ws, mcp: manager },
      );
      if (nav.isError) {
        const n2 = search.output.match(/\*\*(playwright__[\w-]*navigate[\w-]*)\*\*/i);
        if (n2) {
          const r2 = await executeTool(
            "call_mcp",
            JSON.stringify({
              tool_name: n2[1],
              arguments: { url: `file://${path.join(ws, "index.html")}` },
            }),
            { workspace: ws, mcp: manager },
          );
          assert.equal(r2.isError, false, r2.output);
        } else {
          assert.equal(nav.isError, false, nav.output);
        }
      }
      const shot = await executeTool(
        "call_mcp",
        JSON.stringify({
          tool_name: m![1],
          arguments: { filename: "look.png" },
        }),
        { workspace: ws, mcp: manager },
      );
      assert.equal(shot.isError, false, shot.output);
    } finally {
      await manager.dispose();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
