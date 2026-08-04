/**
 * Built-in MCP servers shipped with Forge.
 *
 * Always loaded as the lowest-priority base layer (user/project mcp.json can
 * override or disable any entry). Opt out entirely with FORGE_MCP_DEFAULTS=0.
 *
 * - context7 — up-to-date library docs (npx @upstash/context7-mcp)
 * - playwright — browser automation (npx @playwright/mcp)
 */
import type { McpServerConfig } from "./types.js";

/** Stable default server ids (reserved names for docs / doctor). */
export const DEFAULT_MCP_SERVER_IDS = ["context7", "playwright"] as const;

export type DefaultMcpServerId = (typeof DEFAULT_MCP_SERVER_IDS)[number];

/**
 * Default MCP server recipes.
 * API keys are optional: Context7 free tier works without CONTEXT7_API_KEY;
 * set the env for higher rate limits (https://context7.com/dashboard).
 */
export function defaultMcpServers(): Record<string, McpServerConfig> {
  return {
    context7: {
      name: "context7",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      // Expanded at connect time; empty when unset (server still works free-tier).
      env: {
        CONTEXT7_API_KEY: "${env:CONTEXT7_API_KEY}",
      },
      // Cold npx download can exceed the default 60s on first connect.
      timeoutMs: 120_000,
    },
    playwright: {
      name: "playwright",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      timeoutMs: 120_000,
    },
  };
}

/** True when built-in defaults should be merged (FORGE_MCP_DEFAULTS ≠ 0/false/off). */
export function defaultMcpServersEnabled(): boolean {
  const v = process.env.FORGE_MCP_DEFAULTS?.trim().toLowerCase();
  if (!v) return true;
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/** Human-readable blurb for /mcp status and doctor. */
export function formatDefaultMcpBlurb(): string {
  return (
    "Built-in defaults: context7 (library docs), playwright (browser automation). " +
    "Override or disable in ~/.forge/mcp.json · FORGE_MCP_DEFAULTS=0 turns defaults off."
  );
}
