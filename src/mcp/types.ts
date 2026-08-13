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
  resourceCount?: number;
  promptCount?: number;
  error?: string;
  command?: string;
  url?: string;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
  structured?: unknown;
}

/** MCP resource descriptor (resources/list). */
export interface McpResourceDef {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** MCP prompt descriptor (prompts/list). */
export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface McpRegisteredResource {
  qualifiedName: string;
  serverName: string;
  resource: McpResourceDef;
}

export interface McpRegisteredPrompt {
  qualifiedName: string;
  serverName: string;
  prompt: McpPromptDef;
}

export function qualifyMcpTool(server: string, tool: string): string {
  const s = server.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const t = tool.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `${s}__${t}`;
}

/** Tools that invoke a named MCP server tool (`server__tool`). */
export function isMcpInvocationTool(toolName: string): boolean {
  const n = String(toolName || "").toLowerCase();
  return n === "call_mcp" || n === "mcp_call" || n === "use_mcp";
}

/**
 * Target for persist/match. Prefer `server__tool`; never invent `*` —
 * one Context7 approve must not unlock Playwright / GitHub mutations.
 */
export function mcpAlwaysAllowPattern(
  input: Record<string, unknown>,
): string | null {
  const raw = String(
    input.tool_name ?? input.name ?? input.tool ?? "",
  ).trim();
  if (!raw) return null;
  const parsed = parseQualifiedMcpTool(raw);
  if (parsed) return qualifyMcpTool(parsed.server, parsed.tool);
  if (raw.includes("*") || raw === ".") return null;
  return raw;
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
  return mcpToolNameLooksReadOnly(tool.name);
}

/**
 * Name-only fallback when MCP servers omit annotations.
 * Matches snake_case (`list_issues`) and kebab-case (`query-docs`,
 * `resolve-library-id`) — default Context7 tools use hyphens.
 * Fail-closed on unknown verbs so mutations never slip through /plan.
 */
export function mcpToolNameLooksReadOnly(name: string): boolean {
  const n = String(name || "")
    .trim()
    .toLowerCase();
  if (!n) return false;
  const bare = n.includes("__") ? n.slice(n.lastIndexOf("__") + 2) : n;
  return /^(get|list|search|find|read|fetch|query|describe|show|lookup|inspect|resolve)([_-]|$)/.test(
    bare,
  );
}
