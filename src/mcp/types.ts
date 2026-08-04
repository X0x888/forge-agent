/**
 * MCP (Model Context Protocol) types — config + runtime tool registry.
 * Compatible with Claude/Cursor mcp.json shapes.
 */

export type McpTransport = "stdio" | "http" | "sse";

/** One server entry as written in mcp.json / forge config. */
export interface McpServerConfig {
  /** Optional display name; defaults to map key. */
  name?: string;
  /** Disable without deleting. */
  disabled?: boolean;
  /** stdio: command to spawn */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** HTTP / SSE remote URL */
  url?: string;
  headers?: Record<string, string>;
  /** Optional tool name allowlist (glob / exact). Empty = all. */
  include?: string[];
  /** Optional tool name denylist. */
  exclude?: string[];
  /** Per-call timeout ms (default 60s). */
  timeoutMs?: number;
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
  /** Alias used by some tools */
  servers?: Record<string, McpServerConfig>;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

/** Fully-qualified tool id: server__tool (double underscore). */
export interface McpRegisteredTool {
  /** server__tool */
  qualifiedName: string;
  serverName: string;
  tool: McpToolDef;
  readOnly: boolean;
}

export interface McpServerStatus {
  name: string;
  transport: McpTransport;
  state: "idle" | "connecting" | "ready" | "error" | "disabled";
  toolCount: number;
  error?: string;
  command?: string;
  url?: string;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
  structured?: unknown;
}

export function qualifyMcpTool(server: string, tool: string): string {
  const s = server.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const t = tool.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `${s}__${t}`;
}

export function parseQualifiedMcpTool(
  qualified: string,
): { server: string; tool: string } | null {
  const raw = (qualified || "").trim();
  if (!raw) return null;
  // server__tool (preferred)
  const idx = raw.indexOf("__");
  if (idx > 0 && idx < raw.length - 2) {
    return { server: raw.slice(0, idx), tool: raw.slice(idx + 2) };
  }
  // server/tool or server.tool fallbacks
  const slash = raw.indexOf("/");
  if (slash > 0) {
    return { server: raw.slice(0, slash), tool: raw.slice(slash + 1) };
  }
  const dot = raw.indexOf(".");
  if (dot > 0) {
    return { server: raw.slice(0, dot), tool: raw.slice(dot + 1) };
  }
  return null;
}

export function isMcpToolReadOnly(tool: McpToolDef): boolean {
  if (tool.annotations?.readOnlyHint === true) return true;
  if (tool.annotations?.destructiveHint === true) return false;
  // Heuristic when annotations missing: names that look like getters
  const n = (tool.name || "").toLowerCase();
  if (
    /^(get|list|search|find|read|fetch|query|describe|show|lookup|inspect)_/.test(
      n,
    ) ||
    /^(get|list|search|find|read|fetch|query|describe|show|lookup|inspect)$/.test(
      n,
    )
  ) {
    return true;
  }
  return false;
}
