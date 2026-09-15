/**
 * Harness-owned Chromium when Playwright MCP is down.
 *
 * Never Chrome.app. The model still cannot write looks/*.mjs — this module
 * sits the look URL itself so never-sit-down is a product sit, not Ghostty.
 * FORGE_LOOK_CHROME=0 off. Tests do not spawn unless FORGE_LOOK_CHROME_TEST=1.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { registerBrowserLease } from "../agent/browser-lease.js";
import { managedChromiumExecutable } from "../mcp/playwright-browser.js";
import { isFalsy, isTruthy } from "./bool.js";
import { forgeHome } from "./fs.js";
import { lookChromePortForSession } from "./look-port.js";
import { lookServerUrl } from "./look-server.js";
import { pidAlive } from "./process-tree.js";
import { playwrightLookApplies } from "./product-kind.js";

export interface LookChromeSpawn {
  command: string;
  args: string[];
  udd: string;
  port: number;
}

export interface LookChromeState {
  url: string;
  port: number;
  udd: string;
  started: boolean;
  pid?: number;
  error?: string;
}

export interface LookChromeShot {
  command: string;
  args: string[];
  udd: string;
}

const live = new Map<string, { pid: number; port: number; udd: string }>();

export function lookChromeDisabled(): boolean {
  if (isFalsy(process.env.FORGE_LOOK_CHROME)) return true;
  if (process.env.NODE_TEST_CONTEXT && !isTruthy(process.env.FORGE_LOOK_CHROME_TEST)) {
    return true;
  }
  return false;
}

export function lookChromeUdd(sessionId: string, kind: "live" | "shot" = "live"): string {
  const name = kind === "shot" ? "look-shot" : "look-chrome";
  return path.join(forgeHome(), "sessions", sessionId || "anon", "browsers", name);
}

/** Headless Chromium args that sit `url` — never Chrome.app. */
export function lookChromeShotArgs(opts: {
  exe: string;
  dest: string;
  url: string;
  udd: string;
}): LookChromeShot {
  return {
    command: opts.exe,
    udd: opts.udd,
    args: [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--hide-scrollbars",
      `--user-data-dir=${opts.udd}`,
      "--window-size=1280,800",
      `--screenshot=${opts.dest}`,
      opts.url,
    ],
  };
}

export function lookChromeLiveArgs(opts: {
  exe: string;
  udd: string;
  port: number;
  url: string;
}): LookChromeSpawn {
  return {
    command: opts.exe,
    udd: opts.udd,
    port: opts.port,
    args: [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      `--user-data-dir=${opts.udd}`,
      `--remote-debugging-port=${opts.port}`,
      "--remote-debugging-address=127.0.0.1",
      opts.url,
    ],
  };
}

export async function ensureLookChrome(opts: {
  sessionId: string;
  workspace: string;
  url?: string;
}): Promise<LookChromeState> {
  const sessionId = String(opts.sessionId || "").trim() || "anon";
  const port = lookChromePortForSession(sessionId);
  const url = opts.url?.trim() || lookServerUrl(sessionId);
  const udd = lookChromeUdd(sessionId, "live");
  const existing = live.get(sessionId);
  if (existing && existing.pid > 1 && pidAlive(existing.pid)) {
    return { url, port, udd: existing.udd, started: true, pid: existing.pid };
  }
  if (lookChromeDisabled()) {
    return { url, port, udd, started: false, error: "look chrome disabled" };
  }
  if (!playwrightLookApplies(opts.workspace)) {
    return { url, port, udd, started: false, error: "look chrome does not apply" };
  }
  const exe = managedChromiumExecutable({ headless: true });
  if (!exe) {
    return { url, port, udd, started: false, error: "no Playwright Chromium (never Chrome.app)" };
  }
  try {
    fs.mkdirSync(udd, { recursive: true });
  } catch {
    /* */
  }
  const spec = lookChromeLiveArgs({ exe, udd, port, url });
  let child;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: opts.workspace,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
  } catch (err) {
    return { url, port, udd, started: false, error: (err as Error).message || "spawn failed" };
  }
  const pid = child.pid;
  if (!pid || pid <= 1) {
    return { url, port, udd, started: false, error: "look chrome spawned without pid" };
  }
  child.unref?.();
  live.set(sessionId, { pid, port, udd });
  registerBrowserLease({
    sessionId,
    rootSessionId: sessionId,
    udd,
    workspace: opts.workspace,
    pid,
    pgid: pid,
    port,
    cmd: `${spec.command} ${spec.args.join(" ")}`.slice(0, 800),
    kind: "browser",
  });
  return { url, port, udd, started: true, pid };
}

/**
 * One-shot screenshot of the look URL into dest. Own UDD so it does not
 * fight Playwright's SingletonLock. Never grabs the TUI.
 */
export function captureLookChromePng(opts: {
  dest: string;
  url: string;
  sessionId: string;
}): { ok: boolean; error?: string; dest: string } {
  const dest = opts.dest;
  if (lookChromeDisabled()) {
    return { ok: false, dest, error: "look chrome disabled" };
  }
  const exe = managedChromiumExecutable({ headless: true });
  if (!exe) {
    return { ok: false, dest, error: "no Playwright Chromium (never Chrome.app)" };
  }
  const udd = lookChromeUdd(opts.sessionId, "shot");
  try {
    fs.mkdirSync(udd, { recursive: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch {
    /* */
  }
  const spec = lookChromeShotArgs({ exe, dest, url: opts.url, udd });
  const run = spawnSync(spec.command, spec.args, {
    timeout: 20_000,
    stdio: "ignore",
    windowsHide: true,
  });
  if (run.error) {
    return { ok: false, dest, error: run.error.message };
  }
  if (run.status !== 0) {
    return { ok: false, dest, error: `look chrome shot exit ${run.status ?? "null"}` };
  }
  try {
    if (fs.statSync(dest).size < 32) {
      return { ok: false, dest, error: "look chrome shot was empty" };
    }
  } catch {
    return { ok: false, dest, error: "look chrome shot missing" };
  }
  return { ok: true, dest };
}

/** Test helper — drop the in-process live table. */
export function forgetLookChrome(sessionId: string): void {
  live.delete(sessionId);
}
