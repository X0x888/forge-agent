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
import {
  McpManager,
  formatMcpStatus,
  formatMcpToolsList,
  setActiveMcpManager,
} from "../src/mcp/manager.js";
import { mcpCallIsReadOnly } from "../src/mcp/tools.js";
import {
  qualifyMcpTool,
  parseQualifiedMcpTool,
  isMcpToolReadOnly,
  mcpToolNameLooksReadOnly,
  isMcpInvocationTool,
  mcpAlwaysAllowPattern,
} from "../src/mcp/types.js";
import { compileRules, evaluateRules } from "../src/agent/rules.js";
import { loadLspConfig } from "../src/lsp/config.js";
import { languageIdForPath, DEFAULT_LSP_SERVERS } from "../src/lsp/types.js";
import {
  filterToolsForSubagent,
  resolveSubagentType,
  resolveCapabilityMode,
  resolveChildPermissionMode,
  defaultMaxSubagentDepth,
} from "../src/agent/subagent.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { JsonRpcStdioClient } from "../src/util/jsonrpc-stdio.js";
import { handleSlash } from "../src/commands/slash.js";
import { createSession } from "../src/session/session.js";
import { HookRunner } from "../src/harness/hooks.js";

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
  it("registers search_mcp, call_mcp, mcp_resource, mcp_prompt, spawn_subagent, lsp", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    for (const n of [
      "search_mcp",
      "call_mcp",
      "mcp_resource",
      "mcp_prompt",
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
    assert.equal(isReadOnlyToolName("spawn_subagent"), false); // parallel-safe is a different predicate
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

  it("/mcp peek is verdict-first, not a 40-tool catalog", () => {
    const mgr = new McpManager({
      workspace: tmpRoot,
      config: { enabled: true, servers: {}, sources: [] },
    });
    const out = formatMcpStatus(mgr);
    assert.match(out, /^mcp  ·  none/m);
    assert.match(out, /Next  \/mcp connect/);
    assert.doesNotMatch(out, /Registered tools/);
    assert.doesNotMatch(out, /MCP servers:/);
    const tools = formatMcpToolsList(mgr);
    assert.match(tools, /^mcp tools  ·  none/m);
    const off = new McpManager({
      workspace: tmpRoot,
      config: { enabled: false, servers: {}, sources: [] },
    });
    const offOut = formatMcpStatus(off);
    assert.match(offOut, /^mcp  ·  off/m);
    assert.match(offOut, /FORGE_MCP=0/);
    assert.doesNotMatch(offOut, /Next  unset/);
  });

  it("/mcp list is the tools catalog, not the status peek", async () => {
    const prev = process.env.FORGE_MCP;
    process.env.FORGE_MCP = "0";
    try {
      const ws = path.join(tmpRoot, "mcp-list");
      fs.mkdirSync(ws, { recursive: true });
      const session = createSession({
        cwd: ws,
        provider: "xai",
        model: "grok-4.6",
      });
      const config = { ...DEFAULT_CONFIG, workspace: ws };
      const r = await handleSlash("/mcp list", {
        session,
        config,
        hooks: new HookRunner(config, ws),
      });
      const out = String(r.output || "");
      assert.match(out, /^mcp tools  ·  /m);
      assert.doesNotMatch(out, /^mcp  ·  (none|off)/m);
    } finally {
      setActiveMcpManager(null);
      if (prev === undefined) delete process.env.FORGE_MCP;
      else process.env.FORGE_MCP = prev;
    }
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
    // Default Context7 tools are kebab-case and omit annotations.
    assert.equal(isMcpToolReadOnly({ name: "query-docs" }), true);
    assert.equal(isMcpToolReadOnly({ name: "resolve-library-id" }), true);
    assert.equal(mcpToolNameLooksReadOnly("context7__query-docs"), true);
    assert.equal(mcpToolNameLooksReadOnly("context7__resolve-library-id"), true);
    assert.equal(mcpToolNameLooksReadOnly("playwright__browser_navigate"), false);
    assert.equal(mcpToolNameLooksReadOnly("github__create_issue"), false);
    assert.equal(mcpToolNameLooksReadOnly("github__list_issues"), true);
    assert.equal(mcpToolNameLooksReadOnly(""), false);
    // Batch/plan classification must work before MCP connects.
    assert.equal(
      mcpCallIsReadOnly(undefined, { tool_name: "context7__query-docs" }),
      true,
    );
    assert.equal(
      mcpCallIsReadOnly(undefined, { name: "resolve-library-id" }),
      true,
    );
    assert.equal(
      mcpCallIsReadOnly(undefined, { tool_name: "github__create_issue" }),
      false,
    );
    assert.equal(mcpCallIsReadOnly(undefined, {}), false);
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

  it("mcp_resource list on empty manager is graceful", async () => {
    const ws = path.join(tmpRoot, "mcp-res");
    await fsp.mkdir(ws, { recursive: true });
    const manager = new McpManager({
      workspace: ws,
      config: { servers: {}, sources: [], enabled: true },
    });
    manager.start();
    const r = await executeTool(
      "mcp_resource",
      JSON.stringify({ action: "list" }),
      { workspace: ws, mcp: manager },
    );
    assert.ok(!r.isError);
    assert.match(r.output, /No MCP resources/i);
    await manager.dispose();
  });

  it("mcp_prompt list on empty manager is graceful", async () => {
    const ws = path.join(tmpRoot, "mcp-prm");
    await fsp.mkdir(ws, { recursive: true });
    const manager = new McpManager({
      workspace: ws,
      config: { servers: {}, sources: [], enabled: true },
    });
    manager.start();
    const r = await executeTool(
      "mcp_prompt",
      JSON.stringify({ action: "list" }),
      { workspace: ws, mcp: manager },
    );
    assert.ok(!r.isError);
    assert.match(r.output, /No MCP prompts/i);
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

  it("install guide covers core languages", async () => {
    const { formatLspInstallGuide, LSP_INSTALL_RECIPES } = await import(
      "../src/lsp/install-guide.js"
    );
    assert.ok(LSP_INSTALL_RECIPES.some((r) => r.languageId === "typescript"));
    assert.ok(LSP_INSTALL_RECIPES.some((r) => r.languageId === "python"));
    const guide = formatLspInstallGuide();
    assert.match(guide, /typescript-language-server/);
    assert.match(guide, /pyright|rust-analyzer|gopls/i);
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

  it("formatLspStatus is a sit-down peek, not a schema dump", async () => {
    const { LspManager, formatLspStatus } = await import(
      "../src/lsp/manager.js"
    );
    const off = formatLspStatus(
      new LspManager({
        workspace: tmpRoot,
        config: { enabled: false, servers: [], sources: [] },
      }),
    );
    assert.match(off, /lsp  ·  off/);
    assert.match(off, /disabled/i);
    assert.doesNotMatch(off, /forge lsp ensure|lsp\(\{ action/);
    const none = formatLspStatus(
      new LspManager({
        workspace: tmpRoot,
        config: { enabled: true, servers: [], sources: [] },
      }),
    );
    assert.match(none, /lsp  ·  none/);
    assert.match(none, /Next  \/lsp ensure/);
    assert.doesNotMatch(none, /Tool: lsp|forge lsp ensure/);
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

  it("resolveIsolationMode", async () => {
    const { resolveIsolationMode } = await import("../src/agent/worktree.js");
    assert.equal(resolveIsolationMode("worktree"), "worktree");
    assert.equal(resolveIsolationMode("none"), "none");
    assert.equal(resolveIsolationMode(undefined), "none");
    const { defaultIsolationForSpawn, findGitRoot } = await import(
      "../src/agent/worktree.js"
    );
    assert.equal(
      defaultIsolationForSpawn({ type: "explore", workspace: tmpRoot }),
      "none",
    );
    assert.equal(
      defaultIsolationForSpawn({ type: "plan", workspace: tmpRoot }),
      "none",
    );
    assert.equal(
      defaultIsolationForSpawn({
        type: "general-purpose",
        isolation: "none",
        workspace: process.cwd(),
      }),
      "none",
    );
    const root = findGitRoot(process.cwd());
    if (root) {
      assert.equal(
        defaultIsolationForSpawn({
          type: "general-purpose",
          workspace: root,
        }),
        "worktree",
      );
    }
    // createChildEnv strips GIT_DIR. npm test sets TMPDIR=$PWD/.tmp, so
    // tmpRoot is already inside this work tree and a ceiling cannot hide it.
    // Use a directory that is not inside any repo.
    const outsideRepo = fs.mkdtempSync(path.join("/tmp", "forge-norepo-"));
    try {
      assert.equal(findGitRoot(outsideRepo), null);
      assert.equal(
        defaultIsolationForSpawn({
          type: "general-purpose",
          workspace: outsideRepo,
        }),
        "none",
      );
    } finally {
      fs.rmSync(outsideRepo, { recursive: true, force: true });
    }
    const prev = process.env.FORGE_SUBAGENT_ISOLATION;
    process.env.FORGE_SUBAGENT_ISOLATION = "none";
    try {
      if (root) {
        assert.equal(
          defaultIsolationForSpawn({
            type: "general-purpose",
            workspace: root,
          }),
          "none",
        );
      }
    } finally {
      if (prev === undefined) delete process.env.FORGE_SUBAGENT_ISOLATION;
      else process.env.FORGE_SUBAGENT_ISOLATION = prev;
    }
    process.env.FORGE_SUBAGENT_ISOLATION = "worktree";
    try {
      assert.equal(
        defaultIsolationForSpawn({
          type: "explore",
          workspace: tmpRoot,
        }),
        "none",
      );
      if (root) {
        assert.equal(
          defaultIsolationForSpawn({
            type: "general-purpose",
            isolation: "none",
            workspace: root,
          }),
          "none",
        );
      }
    } finally {
      if (prev === undefined) delete process.env.FORGE_SUBAGENT_ISOLATION;
      else process.env.FORGE_SUBAGENT_ISOLATION = prev;
    }
  });

  it("worktree isolation creates detached worktree in a git repo", async () => {
    const { createSubagentWorktree, findGitRoot } = await import(
      "../src/agent/worktree.js"
    );
    // npm test sets TMPDIR inside the repo — git walks up. Prefer real root.
    const root = findGitRoot(process.cwd());
    if (!root) {
      // Outside any git tree: fail closed
      const bare = path.join(tmpRoot, "not-a-git-repo");
      await fsp.mkdir(bare, { recursive: true });
      assert.throws(
        () => createSubagentWorktree({ workspace: bare, label: "test" }),
        /git repository/i,
      );
      return;
    }
    const wt = createSubagentWorktree({ workspace: root, label: "test-iso" });
    assert.ok(fs.existsSync(wt.path));
    assert.ok(fs.existsSync(path.join(wt.path, ".git")));
    await wt.cleanup();
  });

  it("filters tools for read-only subagents", () => {
    const ro = filterToolsForSubagent("read-only");
    const names = ro.map((t) => t.function.name);
    assert.ok(names.includes("read_file"));
    assert.ok(names.includes("grep"));
    assert.ok(names.includes("search_mcp"));
    assert.ok(names.includes("call_mcp"));
    assert.ok(names.includes("memory_write"));
    assert.ok(names.includes("mcp_resource"));
    assert.ok(names.includes("mcp_prompt"));
    assert.ok(names.includes("lsp"));
    assert.equal(
      resolveChildPermissionMode("explore", "read-only", "bypassPermissions"),
      "plan",
    );
    assert.equal(
      resolveChildPermissionMode("general-purpose", "full", "bypassPermissions"),
      "bypassPermissions",
    );
    assert.ok(!names.includes("write_file"));
    assert.ok(names.includes("bash"));
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
  it("plan mode allows search_mcp, lsp, and read-only spawn_subagent", async () => {
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
    assert.equal(spawn.decision, "allow");
    assert.equal(spawn.reason, "plan_readonly_subagent");

    const omitted = await gate.request({
      toolName: "spawn_subagent",
      input: { prompt: "x" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(omitted.decision, "allow");
    assert.equal(omitted.reason, "plan_readonly_subagent");

    const gpPlan = await gate.request({
      toolName: "spawn_subagent",
      input: { prompt: "x", subagent_type: "general-purpose" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(gpPlan.decision, "allow");
    assert.equal(gpPlan.reason, "plan_readonly_subagent");
  });

  it("plan mode denies lsp ensure and allows status / dry-run", async () => {
    const gate = new PermissionGate({ interactive: false });
    const cfg = {
      ...DEFAULT_CONFIG,
      permissionMode: "plan" as const,
      workspace: tmpRoot,
    };
    const ensure = await gate.request({
      toolName: "lsp",
      input: { action: "ensure" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(ensure.decision, "deny");
    assert.match(ensure.reason || "", /plan_mode: lsp ensure denied/);

    const dry = await gate.request({
      toolName: "lsp",
      input: { action: "ensure", dry_run: true },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(dry.decision, "allow");
    assert.equal(dry.reason, "plan_read");

    const status = await gate.request({
      toolName: "lsp",
      input: { action: "status" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(status.decision, "allow");
  });

  it("ulw_orient denies lsp ensure even under yolo", async () => {
    const gate = new PermissionGate({ interactive: false });
    const r = await gate.request({
      toolName: "lsp",
      input: { action: "ensure" },
      mode: "bypassPermissions",
      workspace: tmpRoot,
      config: DEFAULT_CONFIG,
      ulwPhase: "orient",
    });
    assert.equal(r.decision, "deny");
    assert.match(r.reason || "", /ulw_orient: lsp ensure denied/);
  });

  it("plan mode allows kebab-case Context7 call_mcp and denies mutations", async () => {
    const gate = new PermissionGate({ interactive: false });
    const cfg = {
      ...DEFAULT_CONFIG,
      permissionMode: "plan" as const,
      workspace: tmpRoot,
    };
    const query = await gate.request({
      toolName: "call_mcp",
      input: { tool_name: "context7__query-docs", arguments: { query: "zod" } },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(query.decision, "allow");

    const resolve = await gate.request({
      toolName: "call_mcp",
      input: { tool_name: "context7__resolve-library-id" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(resolve.decision, "allow");

    const bare = await gate.request({
      toolName: "call_mcp",
      input: { name: "query-docs" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(bare.decision, "allow");

    const mutate = await gate.request({
      toolName: "call_mcp",
      input: { tool_name: "github__create_issue" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(mutate.decision, "deny");
    assert.match(mutate.reason ?? "", /plan_mode: call_mcp denied/);
  });

  it("call_mcp always-allow is server__tool scoped", () => {
    assert.equal(isMcpInvocationTool("call_mcp"), true);
    assert.equal(isMcpInvocationTool("use_mcp"), true);
    assert.equal(isMcpInvocationTool("bash"), false);
    assert.equal(
      mcpAlwaysAllowPattern({ tool_name: "context7__query-docs" }),
      "context7__query-docs",
    );
    assert.equal(mcpAlwaysAllowPattern({ name: "*" }), null);
    assert.equal(mcpAlwaysAllowPattern({}), null);

    const star = evaluateRules(
      compileRules({ allow: ["call_mcp(*)"] }),
      "call_mcp",
      { tool_name: "playwright__browser_navigate" },
      tmpRoot,
    );
    assert.equal(star.decision, "none");

    const named = evaluateRules(
      compileRules({ allow: ["call_mcp(context7__query-docs)"] }),
      "call_mcp",
      { tool_name: "context7__query-docs" },
      tmpRoot,
    );
    assert.equal(named.decision, "allow");

    const other = evaluateRules(
      compileRules({ allow: ["call_mcp(context7__query-docs)"] }),
      "call_mcp",
      { tool_name: "github__create_issue" },
      tmpRoot,
    );
    assert.equal(other.decision, "none");
  });

  it("plan mode denies mutating call_mcp even when a saved allow exists", async () => {
    const gate = new PermissionGate({ interactive: false });
    const cfg = {
      ...DEFAULT_CONFIG,
      permissionMode: "plan" as const,
      workspace: tmpRoot,
      permissions: { allow: ["call_mcp(github__create_issue)"] },
    };
    const mutate = await gate.request({
      toolName: "call_mcp",
      input: { tool_name: "github__create_issue" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(mutate.decision, "deny");
    assert.match(mutate.reason ?? "", /plan_mode: call_mcp denied/);
  });

  it("plan mode allows research bash (sed -n / jq / git blame) and denies sed -i", async () => {
    const gate = new PermissionGate({ interactive: false });
    const cfg = {
      ...DEFAULT_CONFIG,
      permissionMode: "plan" as const,
      workspace: tmpRoot,
    };
    const sedN = await gate.request({
      toolName: "bash",
      input: { command: "sed -n '1,20p' src/cli.ts" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(sedN.decision, "allow");

    const jq = await gate.request({
      toolName: "bash",
      input: { command: "jq .name package.json" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(jq.decision, "allow");

    const blame = await gate.request({
      toolName: "bash",
      input: { command: "git blame -L 1,5 src/cli.ts" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(blame.decision, "allow");

    const sedI = await gate.request({
      toolName: "bash",
      input: { command: "sed -i 's/a/b/' src/cli.ts" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(sedI.decision, "deny");
    assert.match(sedI.reason ?? "", /plan_mode/);

    const redirect = await gate.request({
      toolName: "bash",
      input: { command: "sed -n '1,20p' src/cli.ts > out.txt" },
      mode: "plan",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(redirect.decision, "deny");
    assert.match(redirect.reason ?? "", /plan_mode/);
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

    const omittedDefault = await gate.request({
      toolName: "spawn_subagent",
      input: { prompt: "find X" },
      mode: "default",
      workspace: tmpRoot,
      config: cfg,
    });
    assert.equal(omittedDefault.decision, "deny");
    assert.match(omittedDefault.reason || "", /subagent_noninteractive_deny/);

    const omittedPlan = await gate.request({
      toolName: "spawn_subagent",
      input: { prompt: "find X" },
      mode: "plan",
      workspace: tmpRoot,
      config: { ...DEFAULT_CONFIG, permissionMode: "plan", workspace: tmpRoot },
    });
    assert.equal(omittedPlan.decision, "allow");
  });
});

