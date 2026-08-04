/**
 * Load MCP server configs from project + user paths (Claude/Cursor compatible).
 *
 * Precedence (later keys override earlier on same server name; project wins):
 * 1. ~/.forge/mcp.json
 * 2. ~/.cursor/mcp.json (compat)
 * 3. <workspace>/.mcp.json
 * 4. <workspace>/.cursor/mcp.json
 * 5. <workspace>/.forge/mcp.json
 *
 * Env: FORGE_MCP=0 disables entirely. FORGE_MCP_CONFIG=path loads extra file last.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { forgeHome, readJsonFile } from "../util/fs.js";
import { isTruthy } from "../util/bool.js";
import type { McpConfigFile, McpServerConfig } from "./types.js";

export interface LoadedMcpConfig {
  servers: Record<string, McpServerConfig>;
  /** Absolute paths that contributed (for /mcp status + doctor). */
  sources: string[];
  enabled: boolean;
}

function isDisabledByEnv(): boolean {
  const v = process.env.FORGE_MCP?.trim().toLowerCase();
  if (!v) return false;
  return v === "0" || v === "false" || v === "off" || v === "no";
}

function normalizeServerEntry(
  name: string,
  raw: unknown,
): McpServerConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const cfg: McpServerConfig = { name };
  if (o.disabled === true || o.enabled === false) cfg.disabled = true;
  if (typeof o.command === "string" && o.command.trim()) {
    cfg.command = o.command.trim();
  }
  if (Array.isArray(o.args)) {
    cfg.args = o.args.map((a) => String(a));
  }
  if (o.env && typeof o.env === "object" && !Array.isArray(o.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (v == null) continue;
      env[k] = String(v);
    }
    cfg.env = env;
  }
  if (typeof o.cwd === "string" && o.cwd.trim()) cfg.cwd = o.cwd.trim();
  if (typeof o.url === "string" && o.url.trim()) cfg.url = o.url.trim();
  // Cursor sometimes uses "serverUrl"
  if (!cfg.url && typeof o.serverUrl === "string" && o.serverUrl.trim()) {
    cfg.url = o.serverUrl.trim();
  }
  if (o.headers && typeof o.headers === "object" && !Array.isArray(o.headers)) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      o.headers as Record<string, unknown>,
    )) {
      if (v == null) continue;
      headers[k] = String(v);
    }
    cfg.headers = headers;
  }
  if (Array.isArray(o.include)) {
    cfg.include = o.include.map((x) => String(x));
  }
  if (Array.isArray(o.exclude)) {
    cfg.exclude = o.exclude.map((x) => String(x));
  }
  if (typeof o.timeoutMs === "number" && Number.isFinite(o.timeoutMs)) {
    cfg.timeoutMs = Math.max(1000, Math.floor(o.timeoutMs));
  } else if (typeof o.timeout === "number" && Number.isFinite(o.timeout)) {
    // seconds (Claude-style) → ms
    cfg.timeoutMs = Math.max(1000, Math.floor(o.timeout * 1000));
  }
  // Must have either stdio command or remote url
  if (!cfg.command && !cfg.url) return null;
  return cfg;
}

function parseConfigFile(file: string): Record<string, McpServerConfig> {
  if (!fs.existsSync(file)) return {};
  const raw = readJsonFile<McpConfigFile & Record<string, unknown>>(file, {});
  const map =
    (raw.mcpServers && typeof raw.mcpServers === "object"
      ? raw.mcpServers
      : null) ||
    (raw.servers && typeof raw.servers === "object" ? raw.servers : null) ||
    {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(map)) {
    const n = name.trim();
    if (!n || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(n)) continue;
    const cfg = normalizeServerEntry(n, entry);
    if (cfg) out[n] = cfg;
  }
  return out;
}

export function mcpConfigPaths(workspace: string): string[] {
  const home = forgeHome();
  const ws = path.resolve(workspace || process.cwd());
  const userHome = os.homedir();
  return [
    path.join(home, "mcp.json"),
    path.join(userHome, ".cursor", "mcp.json"),
    path.join(ws, ".mcp.json"),
    path.join(ws, ".cursor", "mcp.json"),
    path.join(ws, ".forge", "mcp.json"),
  ];
}

/**
 * Merge MCP configs. Later sources override same-named servers (project last).
 */
export function loadMcpConfig(workspace: string): LoadedMcpConfig {
  if (isDisabledByEnv()) {
    return { servers: {}, sources: [], enabled: false };
  }
  const sources: string[] = [];
  const servers: Record<string, McpServerConfig> = {};
  for (const p of mcpConfigPaths(workspace)) {
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = parseConfigFile(p);
      if (Object.keys(parsed).length === 0) {
        // Empty file still counts as a source if it exists
        sources.push(p);
        continue;
      }
      sources.push(p);
      Object.assign(servers, parsed);
    } catch {
      /* ignore malformed — doctor will surface if needed */
    }
  }
  const extra = process.env.FORGE_MCP_CONFIG?.trim();
  if (extra) {
    try {
      const abs = path.resolve(extra);
      if (fs.existsSync(abs)) {
        Object.assign(servers, parseConfigFile(abs));
        sources.push(abs);
      }
    } catch {
      /* */
    }
  }
  return {
    servers,
    sources,
    enabled: true,
  };
}

/** Glob-ish match: * only (not full regex). */
export function matchToolFilter(name: string, patterns: string[]): boolean {
  if (!patterns.length) return true;
  const n = name.toLowerCase();
  for (const raw of patterns) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    if (p === "*" || p === n) return true;
    if (p.includes("*")) {
      const re = new RegExp(
        "^" +
          p
            .split("*")
            .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*") +
          "$",
      );
      if (re.test(n)) return true;
    }
  }
  return false;
}

export function toolAllowedByFilters(
  toolName: string,
  cfg: McpServerConfig,
): boolean {
  if (cfg.exclude?.length && matchToolFilter(toolName, cfg.exclude)) {
    return false;
  }
  if (cfg.include?.length) {
    return matchToolFilter(toolName, cfg.include);
  }
  return true;
}

/** Expand ${env:VAR} and ${VAR} in env values (common Claude pattern). */
export function expandEnvVars(value: string): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    return process.env[key] ?? "";
  });
}

export function expandServerEnv(
  env?: Record<string, string>,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = expandEnvVars(v);
  }
  return out;
}

export function isMcpFeatureEnabled(): boolean {
  if (isDisabledByEnv()) return false;
  // Default on — empty config is a no-op
  return !isTruthy(process.env.FORGE_MCP_OFF);
}
