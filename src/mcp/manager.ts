/**
 * Multi-server MCP manager: lazy connect, tool registry, search + call.
 */
import { suggestNames } from "../util/suggest.js";
import { boundToolOutput } from "../agent/tools/truncate.js";
import { loadMcpConfig, toolAllowedByFilters, type LoadedMcpConfig } from "./config.js";
import { McpClient } from "./client.js";
import {
  isMcpToolReadOnly,
  mcpToolNameLooksReadOnly,
  parseQualifiedMcpTool,
  qualifyMcpTool,
  type McpCallResult,
  type McpRegisteredPrompt,
  type McpRegisteredResource,
  type McpRegisteredTool,
  type McpServerStatus,
} from "./types.js";

export interface McpManagerOptions {
  workspace: string;
  signal?: AbortSignal;
  /** Skip auto-load (tests). */
  config?: LoadedMcpConfig;
}

export class McpManager {
  private readonly workspace: string;
  private readonly signal?: AbortSignal;
  private readonly clients = new Map<string, McpClient>();
  private readonly disabled = new Set<string>();
  private config: LoadedMcpConfig;
  private registry: McpRegisteredTool[] = [];
  private started = false;

  constructor(opts: McpManagerOptions) {
    this.workspace = opts.workspace;
    this.signal = opts.signal;
    this.config = opts.config ?? loadMcpConfig(opts.workspace);
    for (const [name, cfg] of Object.entries(this.config.servers)) {
      if (cfg.disabled) this.disabled.add(name);
    }
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get sources(): string[] {
    return this.config.sources.slice();
  }

  serverNames(): string[] {
    return Object.keys(this.config.servers).sort();
  }

  /**
   * Create clients for configured servers (does not connect yet — lazy).
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.config.enabled) return;
    for (const [name, cfg] of Object.entries(this.config.servers)) {
      if (cfg.disabled || this.disabled.has(name)) continue;
      this.clients.set(
        name,
        new McpClient({
          name,
          config: cfg,
          workspace: this.workspace,
          signal: this.signal,
        }),
      );
    }
  }

  async dispose(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    this.registry = [];
    this.started = false;
    await Promise.all(all.map((c) => c.dispose().catch(() => {})));
  }

  /** Connect all servers and refresh tool registry (best-effort). */
  async connectAll(): Promise<McpServerStatus[]> {
    this.start();
    const statuses: McpServerStatus[] = [];
    await Promise.all(
      [...this.clients.entries()].map(async ([name, client]) => {
        try {
          await client.ensureReady();
          await client.listTools(true);
        } catch {
          /* status captures error */
        }
        statuses.push(this.statusFor(name, client));
      }),
    );
    this.rebuildRegistry();
    // Also report disabled/configured-not-started
    for (const name of Object.keys(this.config.servers)) {
      if (!this.clients.has(name)) {
        const cfg = this.config.servers[name];
        statuses.push({
          name,
          transport: cfg.url ? "http" : "stdio",
          state: "disabled",
          toolCount: 0,
          command: cfg.command,
          url: cfg.url,
        });
      }
    }
    return statuses.sort((a, b) => a.name.localeCompare(b.name));
  }

  async ensureRegistry(): Promise<void> {
    this.start();
    const pending = [...this.clients.values()].filter((c) => {
      const st = c.getStatus().state;
      return st === "idle" || st === "connecting";
    });
    if (pending.length === 0 && this.registry.length) return;
    // Connect idle/connecting servers — parallel, fail-open. Do not return
    // early on a partial registry (playwright ready, context7 still idle).
    await Promise.all(
      pending.map(async (c) => {
        try {
          await c.listTools();
        } catch {
          /* leave error state */
        }
      }),
    );
    this.rebuildRegistry();
  }

  listRegisteredTools(): McpRegisteredTool[] {
    return this.registry.slice();
  }

  status(): McpServerStatus[] {
    this.start();
    const out: McpServerStatus[] = [];
    for (const [name, client] of this.clients) {
      out.push(this.statusFor(name, client));
    }
    for (const name of Object.keys(this.config.servers)) {
      if (!this.clients.has(name)) {
        const cfg = this.config.servers[name];
        out.push({
          name,
          transport: cfg.url ? "http" : "stdio",
          state: "disabled",
          toolCount: 0,
          command: cfg.command,
          url: cfg.url,
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Search registered tools by keyword (name + description).
   * Connects servers on first search.
   */
  async search(
    query: string,
    limit = 8,
  ): Promise<{
    tools: Array<{
      name: string;
      server: string;
      description: string;
      readOnly: boolean;
      inputSchema?: Record<string, unknown>;
    }>;
    partial: boolean;
    serverErrors: string[];
  }> {
    await this.ensureRegistry();
    const q = (query || "").trim().toLowerCase();
    const serverErrors = this.status()
      .filter((s) => s.state === "error" && s.error)
      .map((s) => `${s.name}: ${s.error}`);

    let scored = this.registry.map((t) => {
      const name = t.tool.name.toLowerCase();
      const qn = t.qualifiedName.toLowerCase();
      const desc = (t.tool.description || "").toLowerCase();
      let score = 0;
      if (!q) score = 1;
      else if (qn === q || name === q) score = 100;
      else if (qn.includes(q) || name.includes(q)) score = 80;
      else if (desc.includes(q)) score = 50;
      else {
        // token overlap
        const tokens = q.split(/[\s,_-]+/).filter(Boolean);
        let hits = 0;
        for (const tok of tokens) {
          if (qn.includes(tok) || name.includes(tok) || desc.includes(tok)) {
            hits += 1;
          }
        }
        if (hits) score = 20 + hits * 10;
      }
      return { t, score };
    });

    if (q) {
      scored = scored.filter((x) => x.score > 0);
    }
    scored.sort((a, b) => b.score - a.score || a.t.qualifiedName.localeCompare(b.t.qualifiedName));
    const lim = Math.min(50, Math.max(1, limit));
    const tools = scored.slice(0, lim).map(({ t }) => ({
      name: t.qualifiedName,
      server: t.serverName,
      description: (t.tool.description || "").slice(0, 400),
      readOnly: t.readOnly,
      inputSchema: t.tool.inputSchema,
    }));

    const partial = this.status().some(
      (s) => s.state === "error" || s.state === "connecting",
    );
    return { tools, partial, serverErrors };
  }

  async call(
    qualifiedOrTool: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult & { qualifiedName?: string; readOnly?: boolean }> {
    await this.ensureRegistry();
    const resolved = this.resolveTool(qualifiedOrTool);
    if (!resolved) {
      const names = this.registry.map((t) => t.qualifiedName);
      const tips = suggestNames(qualifiedOrTool, names, {
        minLength: 2,
        minScore: 36,
        requirePrefix3: false,
        limit: 5,
      });
      return {
        content:
          `Unknown MCP tool: ${qualifiedOrTool}.` +
          (tips.length ? ` Did you mean: ${tips.join(", ")}?` : "") +
          (names.length
            ? `\nUse search_mcp to discover tools. ${names.length} tool(s) registered.`
            : "\nNo MCP tools registered. Configure .forge/mcp.json or ~/.forge/mcp.json."),
        isError: true,
      };
    }
    const client = this.clients.get(resolved.serverName);
    if (!client) {
      return {
        content: `MCP server not available: ${resolved.serverName}`,
        isError: true,
      };
    }
    const result = await client.callTool(resolved.tool.name, args);
    const managed = await boundToolOutput(result.content, {
      maxChars: 80_000,
    });
    return {
      content: managed.text,
      isError: result.isError,
      structured: result.structured,
      qualifiedName: resolved.qualifiedName,
      readOnly: resolved.readOnly,
    };
  }

  isReadOnlyTool(qualifiedOrTool: string): boolean {
    const r = this.resolveTool(qualifiedOrTool);
    if (r) return r.readOnly;
    // Unknown / not-yet-connected: name heuristic (kebab + snake), fail-closed.
    return mcpToolNameLooksReadOnly(qualifiedOrTool);
  }

  /** List resources across connected servers (connects on demand). */
  async listResources(opts?: {
    server?: string;
    query?: string;
    limit?: number;
  }): Promise<{
    resources: McpRegisteredResource[];
    serverErrors: string[];
  }> {
    await this.ensureRegistry();
    const serverErrors: string[] = [];
    const out: McpRegisteredResource[] = [];
    const wantServer = opts?.server?.trim().toLowerCase();
    const q = (opts?.query || "").trim().toLowerCase();
    const lim = Math.min(100, Math.max(1, opts?.limit ?? 40));

    for (const [name, client] of this.clients) {
      if (wantServer && name.toLowerCase() !== wantServer) continue;
      try {
        const resources = await client.listResources();
        for (const r of resources) {
          if (!r?.uri) continue;
          const blob = `${r.uri} ${r.name || ""} ${r.description || ""}`.toLowerCase();
          if (q && !blob.includes(q)) continue;
          out.push({
            qualifiedName: qualifyMcpTool(name, r.uri),
            serverName: name,
            resource: r,
          });
        }
      } catch (err) {
        serverErrors.push(`${name}: ${(err as Error).message}`);
      }
    }
    return { resources: out.slice(0, lim), serverErrors };
  }

  async readResource(
    uriOrQualified: string,
    serverHint?: string,
  ): Promise<McpCallResult & { serverName?: string; uri?: string }> {
    await this.ensureRegistry();
    const raw = (uriOrQualified || "").trim();
    if (!raw) {
      return { content: "read_mcp_resource error: uri is required.", isError: true };
    }
    // server__uri form (uri may contain :// so parse carefully)
    let server = serverHint?.trim();
    let uri = raw;
    const parsed = parseQualifiedMcpTool(raw);
    if (parsed && !server) {
      // Only treat as qualified when left side matches a known server
      if (this.clients.has(parsed.server)) {
        server = parsed.server;
        uri = parsed.tool;
      }
    }
    // If still no server, find unique uri across servers
    if (!server) {
      const listed = await this.listResources({ limit: 100 });
      const matches = listed.resources.filter(
        (r) => r.resource.uri === uri || r.qualifiedName === raw,
      );
      if (matches.length === 1) {
        server = matches[0].serverName;
        uri = matches[0].resource.uri;
      } else if (matches.length > 1) {
        return {
          content:
            `Ambiguous resource uri "${uri}" on servers: ${matches.map((m) => m.serverName).join(", ")}. Pass server=.`,
          isError: true,
        };
      } else if (this.clients.size === 1) {
        server = [...this.clients.keys()][0];
      } else {
        return {
          content:
            `Unknown resource: ${raw}. Use mcp_resource({ action: "list" }) first.` +
            (listed.resources.length
              ? `\nExamples: ${listed.resources
                  .slice(0, 5)
                  .map((r) => r.resource.uri)
                  .join(", ")}`
              : ""),
          isError: true,
        };
      }
    }
    const client = this.clients.get(server!);
    if (!client) {
      return { content: `MCP server not available: ${server}`, isError: true };
    }
    const result = await client.readResource(uri);
    const managed = await boundToolOutput(result.content, { maxChars: 80_000 });
    return {
      content: managed.text,
      isError: result.isError,
      serverName: server,
      uri,
    };
  }

  async listPrompts(opts?: {
    server?: string;
    query?: string;
    limit?: number;
  }): Promise<{
    prompts: McpRegisteredPrompt[];
    serverErrors: string[];
  }> {
    await this.ensureRegistry();
    const serverErrors: string[] = [];
    const out: McpRegisteredPrompt[] = [];
    const wantServer = opts?.server?.trim().toLowerCase();
    const q = (opts?.query || "").trim().toLowerCase();
    const lim = Math.min(100, Math.max(1, opts?.limit ?? 40));

    for (const [name, client] of this.clients) {
      if (wantServer && name.toLowerCase() !== wantServer) continue;
      try {
        const prompts = await client.listPrompts();
        for (const p of prompts) {
          if (!p?.name) continue;
          const blob = `${p.name} ${p.description || ""}`.toLowerCase();
          if (q && !blob.includes(q)) continue;
          out.push({
            qualifiedName: qualifyMcpTool(name, p.name),
            serverName: name,
            prompt: p,
          });
        }
      } catch (err) {
        serverErrors.push(`${name}: ${(err as Error).message}`);
      }
    }
    return { prompts: out.slice(0, lim), serverErrors };
  }

  async getPrompt(
    nameOrQualified: string,
    args?: Record<string, string>,
    serverHint?: string,
  ): Promise<McpCallResult & { serverName?: string; promptName?: string }> {
    await this.ensureRegistry();
    const raw = (nameOrQualified || "").trim();
    if (!raw) {
      return { content: "get_mcp_prompt error: name is required.", isError: true };
    }
    let server = serverHint?.trim();
    let promptName = raw;
    const parsed = parseQualifiedMcpTool(raw);
    if (parsed && this.clients.has(parsed.server)) {
      server = parsed.server;
      promptName = parsed.tool;
    }
    if (!server) {
      const listed = await this.listPrompts({ limit: 100 });
      const matches = listed.prompts.filter(
        (p) =>
          p.prompt.name === promptName ||
          p.qualifiedName === raw ||
          p.prompt.name.toLowerCase() === promptName.toLowerCase(),
      );
      if (matches.length === 1) {
        server = matches[0].serverName;
        promptName = matches[0].prompt.name;
      } else if (matches.length > 1) {
        return {
          content:
            `Ambiguous prompt "${promptName}" on: ${matches.map((m) => m.serverName).join(", ")}. Pass server=.`,
          isError: true,
        };
      } else if (this.clients.size === 1) {
        server = [...this.clients.keys()][0];
      } else {
        return {
          content: `Unknown prompt: ${raw}. Use mcp_prompt({ action: "list" }) first.`,
          isError: true,
        };
      }
    }
    const client = this.clients.get(server!);
    if (!client) {
      return { content: `MCP server not available: ${server}`, isError: true };
    }
    const result = await client.getPrompt(promptName, args);
    const managed = await boundToolOutput(result.content, { maxChars: 80_000 });
    return {
      content: managed.text,
      isError: result.isError,
      serverName: server,
      promptName,
    };
  }

  private resolveTool(name: string): McpRegisteredTool | null {
    const raw = (name || "").trim();
    if (!raw) return null;
    // Exact qualified
    let hit = this.registry.find(
      (t) => t.qualifiedName === raw || t.qualifiedName.toLowerCase() === raw.toLowerCase(),
    );
    if (hit) return hit;
    // Parse server__tool
    const parsed = parseQualifiedMcpTool(raw);
    if (parsed) {
      hit = this.registry.find(
        (t) =>
          t.serverName === parsed.server &&
          t.tool.name === parsed.tool,
      );
      if (hit) return hit;
      // server name case-insensitive + tool
      hit = this.registry.find(
        (t) =>
          t.serverName.toLowerCase() === parsed.server.toLowerCase() &&
          t.tool.name.toLowerCase() === parsed.tool.toLowerCase(),
      );
      if (hit) return hit;
    }
    // Unique bare tool name
    const bare = this.registry.filter(
      (t) => t.tool.name === raw || t.tool.name.toLowerCase() === raw.toLowerCase(),
    );
    if (bare.length === 1) return bare[0];
    return null;
  }

  private rebuildRegistry(): void {
    const reg: McpRegisteredTool[] = [];
    for (const [serverName, client] of this.clients) {
      const cfg = this.config.servers[serverName];
      for (const tool of client.getTools()) {
        if (!tool?.name) continue;
        if (cfg && !toolAllowedByFilters(tool.name, cfg)) continue;
        reg.push({
          qualifiedName: qualifyMcpTool(serverName, tool.name),
          serverName,
          tool,
          readOnly: isMcpToolReadOnly(tool),
        });
      }
    }
    this.registry = reg;
  }

  private statusFor(name: string, client: McpClient): McpServerStatus {
    const st = client.getStatus();
    const cfg = this.config.servers[name];
    return {
      name,
      transport: client.transport,
      state: st.state,
      toolCount: st.toolCount,
      resourceCount: st.resourceCount,
      promptCount: st.promptCount,
      error: st.error,
      command: cfg?.command,
      url: cfg?.url,
    };
  }
}

/** Process-wide manager for REPL dispose + slash commands (set by loop/repl). */
let activeManager: McpManager | null = null;

export function setActiveMcpManager(m: McpManager | null): void {
  activeManager = m;
}

export function getActiveMcpManager(): McpManager | null {
  return activeManager;
}

/** `/mcp` status peek. Catalog is `/mcp tools`. */
export function formatMcpStatus(
  manager: McpManager,
  opts?: { note?: string },
): string {
  if (!manager.enabled) {
    return ["mcp  ·  off", "  FORGE_MCP=0"].join("\n");
  }
  const statuses = manager.status();
  if (!statuses.length) {
    return [
      "mcp  ·  none",
      "  Built-ins: context7 + playwright",
      "Next  /mcp connect",
    ].join("\n");
  }
  const ready = statuses.filter((s) => s.state === "ready");
  const errors = statuses.filter((s) => s.state === "error");
  const connecting = statuses.filter((s) => s.state === "connecting");
  let verdict = "mcp  ·  idle";
  if (errors.length) verdict = "mcp  ·  error";
  else if (ready.length === statuses.length) verdict = "mcp  ·  ready";
  else if (ready.length)
    verdict = `mcp  ·  ${ready.length}/${statuses.length} ready`;
  else if (connecting.length) verdict = "mcp  ·  connecting";
  const lines = [verdict];
  const note = opts?.note?.trim();
  if (note) lines.push(`  ${note}`);
  for (const s of statuses.slice(0, 6)) {
    const tools = s.toolCount ? `  tools=${s.toolCount}` : "";
    const err = s.error ? `  ${s.error.slice(0, 60)}` : "";
    lines.push(`  ${s.name}  ${s.state}${tools}${err}`);
  }
  if (statuses.length > 6) {
    lines.push(`  … +${statuses.length - 6} more`);
  }
  const next = errors.length || ready.length === 0 ? "/mcp connect" : "/mcp tools";
  lines.push(`Next  ${next}`);
  return lines.join("\n");
}

/** `/mcp tools` — the catalog, not the sit-down peek. */
export function formatMcpToolsList(manager: McpManager): string {
  const tools = manager.listRegisteredTools();
  if (!tools.length) {
    return ["mcp tools  ·  none", "Next  /mcp connect"].join("\n");
  }
  const lines = [`mcp tools  ·  ${tools.length}`];
  for (const t of tools.slice(0, 40)) {
    lines.push(
      `  ${t.qualifiedName}${t.readOnly ? "  (read-only)" : ""}`,
    );
  }
  if (tools.length > 40) lines.push(`  … +${tools.length - 40} more`);
  lines.push("Next  /mcp");
  return lines.join("\n");
}
