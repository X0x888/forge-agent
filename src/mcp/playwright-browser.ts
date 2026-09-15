/**
 * Which Chromium the Playwright MCP server drives on macOS.
 *
 * Left to itself `@playwright/mcp` uses the `chrome` channel: the user's own
 * /Applications/Google Chrome.app. A headless copy of that bundle registers
 * with LaunchServices as `com.google.Chrome` (BackgroundOnly), so opening
 * Chrome from the Dock or Spotlight activates the windowless look browser and
 * the user sees nothing while a session looks. Forge points the server at a
 * Playwright-managed build instead: the newest Chrome for Testing / Chromium
 * (its own bundle id), else chrome-headless-shell (no bundle) for a headless
 * look, else `--browser chromium` so Playwright never falls back to Chrome.app.
 *
 * An entry that already picks a browser is left alone, and so are other
 * platforms (no LaunchServices). FORGE_PLAYWRIGHT_MANAGED_BROWSER=0 keeps the
 * `chrome` channel.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerConfig } from "./types.js";
import { isFalsy, isTruthy } from "../util/bool.js";

type Env = Record<string, string | undefined>;

/** Flags that already choose the browser (a `--config` file may, too). */
const BROWSER_CHOICE_FLAGS = [
  "--browser",
  "--executable-path",
  "--cdp-endpoint",
  "--extension",
  "--config",
];

/** The env Playwright MCP reads for the same choice. */
const BROWSER_CHOICE_ENV = [
  "PLAYWRIGHT_MCP_BROWSER",
  "PLAYWRIGHT_MCP_EXECUTABLE_PATH",
  "PLAYWRIGHT_MCP_CDP_ENDPOINT",
  "PLAYWRIGHT_MCP_CONFIG",
];

const CFT_APP = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const CHROMIUM_APP = "Chromium.app/Contents/MacOS/Chromium";

export interface ManagedBrowserOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Defaults to process.env; the entry's own env is layered on top. */
  env?: Env;
  /** ms-playwright root; default PLAYWRIGHT_BROWSERS_PATH, else ~/Library/Caches/ms-playwright. */
  browsersRoot?: string;
}

/**
 * Args to append to a Playwright MCP entry: `--executable-path <managed build>`,
 * `--browser chromium` when none is installed, or nothing (not macOS, not the
 * official server, a browser already chosen, or switched off).
 */
export function managedBrowserArgs(
  cfg: McpServerConfig,
  opts: ManagedBrowserOptions = {},
): string[] {
  if ((opts.platform ?? process.platform) !== "darwin") return [];
  const args = cfg.args || [];
  const env: Env = { ...(opts.env ?? process.env), ...cfg.env };
  if (isFalsy(env.FORGE_PLAYWRIGHT_MANAGED_BROWSER)) return [];
  const blob = `${cfg.command || ""} ${args.join(" ")}`;
  if (!/@playwright\/mcp|mcp-server-playwright/i.test(blob)) return [];
  if (browserChosen(args, env)) return [];
  const headless =
    args.includes("--headless") || isTruthy(env.PLAYWRIGHT_MCP_HEADLESS);
  const root = opts.browsersRoot ?? browsersRoot(env);
  const exe = root
    ? findManagedChromium(
        root,
        headless,
        opts.arch ?? process.arch,
        opts.platform ?? process.platform,
      )
    : undefined;
  return exe ? ["--executable-path", exe] : ["--browser", "chromium"];
}

/**
 * Newest complete Playwright Chromium on this machine. Used by the MCP
 * decorator and by the harness look Chrome when MCP is down. Never Chrome.app.
 */
export function managedChromiumExecutable(
  opts: ManagedBrowserOptions & { headless?: boolean } = {},
): string | undefined {
  const env: Env = { ...(opts.env ?? process.env) };
  const root = opts.browsersRoot ?? browsersRoot(env);
  if (!root) return undefined;
  return findManagedChromium(
    root,
    opts.headless ?? true,
    opts.arch ?? process.arch,
    opts.platform ?? process.platform,
  );
}

function browserChosen(args: string[], env: Env): boolean {
  const flagged = args.some((a) =>
    BROWSER_CHOICE_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)),
  );
  return flagged || BROWSER_CHOICE_ENV.some((k) => Boolean(env[k]?.trim()));
}

/** Undefined for PLAYWRIGHT_BROWSERS_PATH=0 (browsers inside the npx package). */
function browsersRoot(env: Env): string | undefined {
  const custom = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (custom === "0") return undefined;
  if (custom && !custom.includes("${")) return path.resolve(custom);
  return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
}

/**
 * Newest complete Playwright Chromium: the full build first (it can open a
 * window and renders like Chrome), chrome-headless-shell only when headless.
 */
function findManagedChromium(
  root: string,
  headless: boolean,
  arch: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const { full, shell } = chromiumRels(platform, arch);
  const kinds: Array<[string, string[]]> = [["chromium", full]];
  if (headless) kinds.push(["chromium_headless_shell", shell]);
  for (const [prefix, rels] of kinds) {
    for (const dir of installedRevisions(root, prefix)) {
      for (const rel of rels) {
        const exe = path.join(dir, rel);
        if (isExecutableFile(exe)) return exe;
      }
    }
  }
  return undefined;
}

function chromiumRels(
  platform: NodeJS.Platform,
  arch: string,
): { full: string[]; shell: string[] } {
  if (platform === "darwin") {
    const mac = arch === "arm64" ? "mac-arm64" : "mac-x64";
    return {
      full: [`chrome-${mac}`, "chrome-mac"].flatMap((d) => [
        path.join(d, CFT_APP),
        path.join(d, CHROMIUM_APP),
      ]),
      shell: [
        `chrome-headless-shell-${mac}/chrome-headless-shell`,
        "chrome-mac/headless_shell",
      ],
    };
  }
  if (platform === "linux") {
    const linux = arch === "arm64" ? "linux-arm64" : "linux64";
    return {
      full: [`chrome-${linux}/chrome`, `chromium-${linux}/chrome`],
      shell: [`chrome-headless-shell-${linux}/chrome-headless-shell`],
    };
  }
  return { full: [], shell: [] };
}

/** `<root>/<prefix>-<rev>` dirs Playwright finished installing, newest first. */
function installedRevisions(root: string, prefix: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  return names
    .map((n) => ({ dir: path.join(root, n), rev: Number(re.exec(n)?.[1]) }))
    .filter(
      (r) =>
        Number.isFinite(r.rev) &&
        fs.existsSync(path.join(r.dir, "INSTALLATION_COMPLETE")),
    )
    .sort((a, b) => b.rev - a.rev)
    .map((r) => r.dir);
}

function isExecutableFile(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
