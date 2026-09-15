/**
 * Built-in MCP servers shipped with Forge.
 *
 * Always loaded as the lowest-priority base layer (user/project mcp.json can
 * override or disable any entry). Opt out entirely with FORGE_MCP_DEFAULTS=0.
 *
 * - context7 — up-to-date library docs (npx @upstash/context7-mcp)
 * - playwright — isolated browser (npx @playwright/mcp --isolated) unless a
 *   session look profile is bound (`--user-data-dir`); output under
 *   ~/.forge/tmp/playwright-output so the workspace is not a dump; on macOS a
 *   Playwright-managed Chromium, never the user's Chrome.app (playwright-browser.ts)
 */
import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "./types.js";
import { isFalsy } from "../util/bool.js";
import { playwrightOutputDir } from "../util/look-cleanup.js";
import { managedBrowserArgs } from "./playwright-browser.js";

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
      args: playwrightMcpArgs(),
      env: {
        PLAYWRIGHT_MCP_ISOLATED: "1",
      },
      // Cold npx + Chromium; initialize used to hard-cap at 30s and never came up.
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

function playwrightMcpArgs(): string[] {
  const outDir = playwrightOutputDir();
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    /* output-dir is best-effort; --isolated still prevents disk profiles */
  }
  const spec =
    process.env.FORGE_PLAYWRIGHT_MCP?.trim() || "@playwright/mcp@0.0.41";
  const args = [
    "-y",
    spec,
    "--isolated",
    "--headless",
    "--output-dir",
    outDir,
  ];
  if (isFalsy(process.env.FORGE_PLAYWRIGHT_HEADLESS)) {
    return args.filter((a) => a !== "--headless");
  }
  return args;
}

export function isPlaywrightMcp(cfg: McpServerConfig, name: string): boolean {
  const blob = `${name} ${cfg.command || ""} ${(cfg.args || []).join(" ")}`;
  return /@playwright\/mcp/i.test(blob) || /^playwright$/i.test(name);
}

function hasUserDataDirArg(args: string[]): boolean {
  return args.some(
    (a) => a === "--user-data-dir" || a.startsWith("--user-data-dir="),
  );
}

function isIsolatedArg(a: string): boolean {
  return a === "--isolated" || a.startsWith("--isolated=");
}

/**
 * `@playwright/mcp@latest` drifts. forge-init mcp.json used it; a new CLI
 * flag then exits 0 (`error: unknown option`) and every `call_mcp` is dead.
 * Pin unversioned / @latest specs; an explicit @x.y.z in the entry stays.
 */
function pinPlaywrightPackageArgs(args: string[]): string[] {
  const pin =
    process.env.FORGE_PLAYWRIGHT_MCP?.trim() || "@playwright/mcp@0.0.41";
  return args.map((a) =>
    a === "@playwright/mcp" || a === "@playwright/mcp@latest" ? pin : a,
  );
}

/**
 * Playwright throws `userDataDir is not supported in isolated mode` and the
 * stdio child exits 0. Never emit both `--isolated` and `--user-data-dir`.
 */
export function compatPlaywrightProfile(cfg: McpServerConfig): McpServerConfig {
  if (!isPlaywrightMcp(cfg, cfg.name || "playwright")) return cfg;
  const args = pinPlaywrightPackageArgs([...(cfg.args || [])]);
  const env = { ...(cfg.env || {}) };
  if (!hasUserDataDirArg(args)) {
    return { ...cfg, args, env };
  }
  return {
    ...cfg,
    args: args.filter((a) => !isIsolatedArg(a)),
    env: { ...env, PLAYWRIGHT_MCP_ISOLATED: "0" },
  };
}

/**
 * Existing ~/.forge/mcp.json from `forge init` overrides built-ins and would
 * drop `--isolated`. Re-apply isolation unless the user set a profile dir or
 * FORGE_PLAYWRIGHT_ISOLATED=0. `--isolated` cannot combine with `--user-data-dir`.
 * Either way the entry gets a Playwright-managed browser on macOS.
 */
export function decoratePlaywrightServer(
  name: string,
  cfg: McpServerConfig,
): McpServerConfig {
  if (!isPlaywrightMcp(cfg, name)) return cfg;
  if (isFalsy(process.env.FORGE_PLAYWRIGHT_ISOLATED)) return withManagedBrowser(cfg);
  const args = [...(cfg.args || [])];
  const hasUserData = hasUserDataDirArg(args);
  if (!hasUserData && !args.includes("--isolated")) args.push("--isolated");
  if (
    !isFalsy(process.env.FORGE_PLAYWRIGHT_HEADLESS) &&
    !args.includes("--headless")
  ) {
    args.push("--headless");
  }
  if (!args.some((a) => a === "--output-dir" || a.startsWith("--output-dir="))) {
    const outDir = playwrightOutputDir();
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch {
      /* */
    }
    args.push("--output-dir", outDir);
  }
  return compatPlaywrightProfile(
    withManagedBrowser({
      ...cfg,
      args: pinPlaywrightPackageArgs(args),
      env: { PLAYWRIGHT_MCP_ISOLATED: hasUserData ? "0" : "1", ...cfg.env },
    }),
  );
}

/** Never the `chrome` channel on macOS — see playwright-browser.ts. */
function withManagedBrowser(cfg: McpServerConfig): McpServerConfig {
  const extra = managedBrowserArgs(cfg);
  return extra.length ? { ...cfg, args: [...(cfg.args || []), ...extra] } : cfg;
}

/**
 * Bind Playwright MCP to the session look profile. `--isolated` cannot
 * combine with `--user-data-dir`; drop isolation when a UDD is supplied.
 * Leaves an explicit user `--user-data-dir` alone.
 */
export function bindPlaywrightSessionProfile(
  cfg: McpServerConfig,
  udd: string,
): McpServerConfig {
  if (isFalsy(process.env.FORGE_PLAYWRIGHT_ISOLATED)) return cfg;
  const dir = String(udd || "").trim();
  if (!dir) return cfg;
  const args = [...(cfg.args || [])];
  if (hasUserDataDirArg(args)) return compatPlaywrightProfile(cfg);
  const out = args.filter((a) => !isIsolatedArg(a));
  out.push("--user-data-dir", dir);
  if (
    !isFalsy(process.env.FORGE_PLAYWRIGHT_HEADLESS) &&
    !out.includes("--headless")
  ) {
    out.push("--headless");
  }
  const sessionOut = path.join(path.dirname(dir), "mcp-output");
  try {
    fs.mkdirSync(sessionOut, { recursive: true });
  } catch {
    /* */
  }
  const withOut: string[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "--output-dir") {
      i += 1;
      continue;
    }
    if (out[i]?.startsWith("--output-dir=")) continue;
    withOut.push(out[i]!);
  }
  withOut.push("--output-dir", sessionOut);
  return compatPlaywrightProfile({
    ...cfg,
    args: withOut,
    env: { ...cfg.env, PLAYWRIGHT_MCP_ISOLATED: "0" },
  });
}

/** Swap the session UDD after a dead child (look-N). Strips the previous dir first. */
export function rebindPlaywrightUserDataDir(
  cfg: McpServerConfig,
  udd: string,
): McpServerConfig {
  const stripped: string[] = [];
  const args = [...(cfg.args || [])];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--user-data-dir") {
      i += 1;
      continue;
    }
    if (args[i]?.startsWith("--user-data-dir=")) continue;
    stripped.push(args[i]!);
  }
  return bindPlaywrightSessionProfile({ ...cfg, args: stripped }, udd);
}

/** Human-readable blurb for /mcp status and doctor. */
export function formatDefaultMcpBlurb(): string {
  return (
    "Built-in defaults: context7 (library docs), playwright (session look profile, or --isolated; Playwright's own Chromium on macOS; output under ~/.forge/tmp). " +
    "GitHub source is the native `github` tool, not an MCP. " +
    "Override or disable in ~/.forge/mcp.json · FORGE_MCP_DEFAULTS=0 turns defaults off."
  );
}
