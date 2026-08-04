/**
 * MCP · LSP · subagent unit tests (no live language servers required).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTool, TOOL_DEFINITIONS, normalizeToolName } from "../src/agent/tools/index.js";
import { isReadOnlyToolName } from "../src/agent/loop.js";
import {
  loadMcpConfig,
  toolAllowedByFilters,
  expandEnvVars,
  matchToolFilter,
} from "../src/mcp/config.js";
import { McpManager } from "../src/mcp/manager.js";
import {
  qualifyMcpTool,
  parseQualifiedMcpTool,
  isMcpToolReadOnly,
} from "../src/mcp/types.js";
import { loadLspConfig } from "../src/lsp/config.js";
import { languageIdForPath, DEFAULT_LSP_SERVERS } from "../src/lsp/types.js";
import {
  filterToolsForSubagent,
  resolveSubagentType,
  resolveCapabilityMode,
  defaultMaxSubagentDepth,
} from "../src/agent/subagent.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { JsonRpcStdioClient } from "../src/util/jsonrpc-stdio.js";

let tmpRoot: string;
const prevHome = process.env.FORGE_HOME;
const prevMcp = process.env.FORGE_MCP;
const prevLsp = process.env.FORGE_LSP;

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-mcp-lsp-"));
  process.env.FORGE_HOME = path.join(tmpRoot, "forge-home");
  fs.mkdirSync(process.env.FORGE_HOME, { recursive: true });
});

after(async () => {
  if (prevHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = prevHome;
  if (prevMcp === undefined) delete process.env.FORGE_MCP;
  else process.env.FORGE_MCP = prevMcp;
  if (prevLsp === undefined) delete process.env.FORGE_LSP;
  else process.env.FORGE_LSP = prevLsp;
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe("tool definitions include MCP/LSP/subagent", () => {
  it("registers search_mcp, call_mcp, spawn_subagent, lsp", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    for (const n of [
      "search_mcp",
      "call_mcp",
      "spawn_subagent",
      "lsp",
    ]) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
  });

  it("normalizeToolName maps aliases", () => {
    assert.equal(normalizeToolName("Task"), "Task");
    assert.equal(normalizeToolName("mcp_search"), "mcp_search");
    assert.equal(normalizeToolName("LSP"), "LSP");
  });

  it("read-only classification", () => {
    assert.equal(isReadOnlyToolName("search_mcp"), true);
    assert.equal(isReadOnlyToolName("lsp"), true);
    assert.equal(isReadOnlyToolName("call_mcp"), false);
    assert.equal(isReadOnlyToolName("spawn_subagent"), false);
  });
});

describe("MCP config + types", () => {
  it("ships context7 + playwright as built-in defaults", () => {
    delete process.env.FORGE_MCP;
    delete process.env.FORGE_MCP_DEFAULTS;
    const cfg = loadMcpConfig(path.join(tmpRoot, "empty-ws-defaults"));
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.defaultsApplied, true);
    assert.ok(cfg.servers.context7);
    assert.ok(cfg.servers.playwright);
    assert.equal(cfg.servers.context7.command, "npx");
    assert.ok(
      cfg.servers.context7.args?.some((a) => a.includes("context7-mcp")),
    );
    assert.ok(
      cfg.servers.playwright.args?.some((a) => a.includes("@playwright/mcp")),
    );
  });

  it("FORGE_MCP_DEFAULTS=0 disables only built-ins", () => {
    process.env.FORGE_MCP_DEFAULTS = "0";
    delete process.env.FORGE_MCP;
    const cfg = loadMcpConfig(path.join(tmpRoot, "no-defaults"));
    assert.equal(cfg.defaultsApplied, false);
    assert.equal(cfg.servers.context7, undefined);
    assert.equal(cfg.servers.playwright, undefined);
    delete process.env.FORGE_MCP_DEFAULTS;
  });

  it("loads project .forge/mcp.json (overrides defaults)", async () => {
    delete process.env.FORGE_MCP;
    delete process.env.FORGE_MCP_DEFAULTS;
    const ws = path.join(tmpRoot, "proj-mcp");
    await fsp.mkdir(path.join(ws, ".forge"), { recursive: true });
    await fsp.writeFile(
      path.join(ws, ".forge", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: {
            command: "node",
            args: ["-e", "process.stdin.resume()"],
            env: { FOO: "${env:HOME}" },
          },
          // Override built-in playwright command
          playwright: {
            command: "node",
            args: ["-e", "process.stdin.resume()"],
            disabled: true,
          },
        },
      }),
      "utf8",
    );
    const cfg = loadMcpConfig(ws);
    assert.equal(cfg.enabled, true);
    assert.ok(cfg.servers.echo);
    assert.equal(cfg.servers.echo.command, "node");
    assert.equal(cfg.servers.playwright?.disabled, true);
    assert.ok(cfg.servers.context7); // default still present
    assert.ok(cfg.sources.some((s) => s.includes("mcp.json")));
  });

  it("FORGE_MCP=0 disables", () => {
    process.env.FORGE_MCP = "0";
    const cfg = loadMcpConfig(tmpRoot);
    assert.equal(cfg.enabled, false);
    delete process.env.FORGE_MCP;
  });

  it("qualify / parse / readOnly heuristics", () => {
    assert.equal(qualifyMcpTool("github", "list_issues"), "github__list_issues");
    const p = parseQualifiedMcpTool("github__list_issues");
    assert.deepEqual(p, { server: "github", tool: "list_issues" });
    assert.equal(
      isMcpToolReadOnly({ name: "list_issues", annotations: { readOnlyHint: true } }),
      true,
    );
    assert.equal(
      isMcpToolReadOnly({ name: "delete_repo", annotations: { destructiveHint: true } }),
      false,
    );
    assert.equal(isMcpToolReadOnly({ name: "get_file" }), true);
  });

  it("tool filters", () => {
    assert.equal(matchToolFilter("list_issues", ["list_*"]), true);
    assert.equal(
      toolAllowedByFilters("delete_repo", {
        exclude: ["delete_*"],
      }),
      false,
    );
    assert.equal(
      toolAllowedByFilters("list_issues", {
        include: ["list_*"],
      }),
      true,
    );
  });

  it("expandEnvVars", () => {
    process.env.FORGE_TEST_VAR = "hello";
    assert.equal(expandEnvVars("${env:FORGE_TEST_VAR}"), "hello");
    assert.equal(expandEnvVars("${FORGE_TEST_VAR}"), "hello");
    delete process.env.FORGE_TEST_VAR;
  });

  it("search_mcp with empty config is graceful", async () => {
    const ws = path.join(tmpRoot, "empty-mcp");
    await fsp.mkdir(ws, { recursive: true });
    const manager = new McpManager({
      workspace: ws,
      config: { servers: {}, sources: [], enabled: true },
    });
    manager.start();
    const r = await executeTool(
      "search_mcp",
      JSON.stringify({ query: "anything" }),
      { workspace: ws, mcp: manager },
    );
    assert.equal(r.isError, false);
    assert.match(r.output, /No MCP tools/i);
    await manager.dispose();
  });

  it("default mcp manager includes context7 + playwright recipes", () => {
    delete process.env.FORGE_MCP_DEFAULTS;
    const ws = path.join(tmpRoot, "default-mgr");
    const manager = new McpManager({ workspace: ws });
    manager.start();
    const names = manager.serverNames();
    assert.ok(names.includes("context7"));
    assert.ok(names.includes("playwright"));
  });

  it("call_mcp unknown tool suggests", async () => {
    const ws = path.join(tmpRoot, "call-mcp");
    await fsp.mkdir(ws, { recursive: true });
    const manager = new McpManager({
      workspace: ws,
      config: { servers: {}, sources: [], enabled: true },
    });
    manager.start();
    const r = await executeTool(
      "call_mcp",
      JSON.stringify({ tool_name: "nope__thing", arguments: {} }),
      { workspace: ws, mcp: manager },
    );
    assert.equal(r.isError, true);
    assert.match(r.output, /Unknown MCP tool/i);
    await manager.dispose();
  });
});

describe("JSON-RPC stdio framing", () => {
  it("round-trips request/response with Content-Length", async () => {
    // Tiny echo server: read Content-Length frames, reply with result=params
    const script = `
const net = require('net');
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const s = buf.toString('utf8');
    const m = s.match(/Content-Length:\\s*(\\d+)\\r?\\n\\r?\\n/i);
    if (!m) break;
    const headerLen = m[0].length;
    const len = Number(m[1]);
    if (buf.length < headerLen + len) break;
    const body = buf.subarray(headerLen, headerLen + len).toString('utf8');
    buf = buf.subarray(headerLen + len);
    const msg = JSON.parse(body);
    if (msg.id != null) {
      const resp = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.params || {} }), 'utf8');
      process.stdout.write('Content-Length: ' + resp.length + '\\r\\n\\r\\n');
      process.stdout.write(resp);
    }
  }
});
`;
    const client = new JsonRpcStdioClient({
      command: process.execPath,
      args: ["-e", script],
      label: "test-rpc",
    });
    client.start();
    const result = (await client.request("ping", { hello: "world" }, 5000)) as {
      hello?: string;
    };
    assert.equal(result.hello, "world");
    await client.dispose();
  });
});

describe("LSP config", () => {
  it("loads defaults", () => {
    delete process.env.FORGE_LSP;
    const cfg = loadLspConfig(tmpRoot);
    assert.equal(cfg.enabled, true);
    assert.ok(cfg.servers.some((s) => s.languageId === "typescript"));
  });

  it("languageIdForPath", () => {
    assert.equal(
      languageIdForPath("src/foo.ts", DEFAULT_LSP_SERVERS),
      "typescript",
    );
    assert.equal(
      languageIdForPath("main.py", DEFAULT_LSP_SERVERS),
      "python",
    );
    assert.equal(languageIdForPath("readme.md", DEFAULT_LSP_SERVERS), null);
  });

  it("lsp status tool without servers still works", async () => {
    process.env.FORGE_LSP = "0";
    const { LspManager } = await import("../src/lsp/manager.js");
    const mgr = new LspManager({
      workspace: tmpRoot,
      config: { enabled: false, servers: [], sources: [] },
    });
    const r = await executeTool(
      "lsp",
      JSON.stringify({ action: "status" }),
      { workspace: tmpRoot, lsp: mgr },
    );
    assert.match(r.output, /disabled/i);
    delete process.env.FORGE_LSP;
  });

  it("lsp diagnostics missing path fails closed", async () => {
    const { LspManager } = await import("../src/lsp/manager.js");
    const mgr = new LspManager({
      workspace: tmpRoot,
      config: {
        enabled: true,
        servers: [
          {
            languageId: "typescript",
            extensions: ["ts"],
            command: "typescript-language-server-that-does-not-exist-xyz",
            args: ["--stdio"],
          },
        ],
        sources: [],
      },
    });
    const r = await executeTool(
      "lsp",
      JSON.stringify({ action: "diagnostics", path: "nope.ts" }),
      { workspace: tmpRoot, lsp: mgr },
    );
    assert.equal(r.isError, true);
    await mgr.dispose();
  });
});

describe("subagent helpers", () => {
  it("resolves types and capability modes", () => {
    assert.equal(resolveSubagentType("explore"), "explore");
    assert.equal(resolveSubagentType("plan"), "plan");
    assert.equal(resolveSubagentType("coder"), "general-purpose");
    assert.equal(resolveCapabilityMode("explore"), "read-only");
    assert.equal(resolveCapabilityMode("general-purpose", "read-only"), "read-only");
    assert.equal(resolveCapabilityMode("general-purpose", "full"), "full");
  });

  it("filters tools for read-only subagents", () => {
    const ro = filterToolsForSubagent("read-only");
    const names = ro.map((t) => t.function.name);
    assert.ok(names.includes("read_file"));
    assert.ok(names.includes("grep"));
    assert.ok(names.includes("search_mcp"));
    assert.ok(names.includes("lsp"));
    assert.ok(!names.includes("write_file"));
    assert.ok(!names.includes("bash"));
    assert.ok(!names.includes("spawn_subagent"));
  });

  it("filters tools for full subagents (no spawn by default)", () => {
    const full = filterToolsForSubagent("full");
    const names = full.map((t) => t.function.name);
    assert.ok(names.includes("write_file"));
    assert.ok(names.includes("bash"));
    assert.ok(!names.includes("spawn_subagent"));
  });

  it("default depth is positive", () => {
    assert.ok(defaultMaxSubagentDepth() >= 1);
  });

  it("spawn_subagent without runner fails closed", async () => {
    const r = await executeTool(
      "spawn_subagent",
      JSON.stringify({ prompt: "do a thing", description: "test" }),
      { workspace: tmpRoot },
    );
    assert.equal(r.isError, true);
    assert.match(r.output, /not available/i);
  });
});

describe("permissions for new tools", () => {
  it("plan mode allows search_mcp and lsp, denies spawn_subagent", async () => {
    const gate = new PermissionGate({ interactive: false });
    const cfg = {
      ...DEFAULT_CONFIG,
      permissionMode: "plan" as const,
      workspace: tmpRoot,
    };
    const search = await gate.request({
      toolName: "search_mcp",
      input: { query: "x" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(search.decision, "allow");

    const lsp = await gate.request({
      toolName: "lsp",
      input: { action: "status" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(lsp.decision, "allow");

    const spawn = await gate.request({
      toolName: "spawn_subagent",
      input: { prompt: "x", subagent_type: "explore" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(spawn.decision, "deny");
  });

  it("headless allows explore subagent, denies full without acceptEdits", async () => {
    const gate = new PermissionGate({ interactive: false });
    const cfg = { ...DEFAULT_CONFIG, workspace: tmpRoot };
    const explore = await gate.request({
      toolName: "spawn_subagent",
      input: { prompt: "find X", subagent_type: "explore" },
      mode: "default",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(explore.decision, "allow");

    const full = await gate.request({
      toolName: "spawn_subagent",
      input: { prompt: "implement X", subagent_type: "general-purpose" },
      mode: "default",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(full.decision, "deny");

    const fullAccept = await gate.request({
      toolName: "spawn_subagent",
      input: { prompt: "implement X", subagent_type: "general-purpose" },
      mode: "acceptEdits",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(fullAccept.decision, "allow");
  });
});

