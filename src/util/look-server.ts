/**
 * Per-session look HTTP server so concurrent mills do not share :5173.
 *
 * Starts Vite (or npm run dev/preview) on lookPortForSession, registers a
 * GUI lease, and fails open. FORGE_LOOK_SERVER=0 off. Skipped under
 * node:test unless FORGE_LOOK_SERVER_TEST=1.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createChildEnv } from "../agent/tools/env-policy.js";
import { registerBrowserLease } from "../agent/browser-lease.js";
import { isFalsy, isTruthy } from "./bool.js";
import { forgeHome } from "./fs.js";
import { lookPortForSession } from "./look-port.js";
import { pidAlive } from "./process-tree.js";
import { playwrightLookApplies } from "./product-kind.js";

export interface LookServerSpawn {
  command: string;
  args: string[];
  cwd: string;
}

export interface LookServerState {
  url: string;
  port: number;
  started: boolean;
  reused?: boolean;
  pid?: number;
  error?: string;
}

const started = new Map<
  string,
  { pid: number; port: number; url: string; child?: ChildProcess }
>();

export function lookServerUrl(sessionId: string): string {
  return `http://127.0.0.1:${lookPortForSession(sessionId)}`;
}

function hasViteConfig(workspace: string): boolean {
  const names = [
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
    "vite.config.cts",
  ];
  return names.some((n) => fs.existsSync(path.join(workspace, n)));
}

function readPkgScripts(workspace: string): Record<string, string> | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(workspace, "package.json"), "utf8"),
    ) as { scripts?: unknown };
    if (!raw.scripts || typeof raw.scripts !== "object" || Array.isArray(raw.scripts)) {
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.scripts as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Args to serve this tree on `port`, or undefined when Playwright look does not apply. */
export function lookServerSpawnArgs(
  workspace: string,
  port: number,
): LookServerSpawn | undefined {
  if (!workspace || !playwrightLookApplies(workspace)) return undefined;
  const portArgs = ["--port", String(port), "--strictPort", "--host", "127.0.0.1"];
  if (hasViteConfig(workspace) || fs.existsSync(path.join(workspace, "index.html"))) {
    return {
      command: "npx",
      args: ["--yes", "vite", ...portArgs],
      cwd: workspace,
    };
  }
  const scripts = readPkgScripts(workspace);
  if (scripts?.dev) {
    return {
      command: "npm",
      args: ["run", "dev", "--", ...portArgs],
      cwd: workspace,
    };
  }
  if (scripts?.preview) {
    return {
      command: "npm",
      args: ["run", "preview", "--", ...portArgs],
      cwd: workspace,
    };
  }
  return undefined;
}

export function isLookPortListening(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 250,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

async function waitForPort(port: number, waitMs: number): Promise<boolean> {
  if (waitMs <= 0) return isLookPortListening(port);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isLookPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return isLookPortListening(port);
}

function lookServerDisabled(): boolean {
  if (isFalsy(process.env.FORGE_LOOK_SERVER)) return true;
  if (process.env.NODE_TEST_CONTEXT && !isTruthy(process.env.FORGE_LOOK_SERVER_TEST)) {
    return true;
  }
  return false;
}

export async function ensureLookServer(opts: {
  workspace: string;
  sessionId: string;
  waitMs?: number;
}): Promise<LookServerState> {
  const sessionId = String(opts.sessionId || "").trim() || "anon";
  const port = lookPortForSession(sessionId);
  const url = `http://127.0.0.1:${port}`;
  const existing = started.get(sessionId);
  if (existing && existing.pid > 1 && pidAlive(existing.pid)) {
    return { url, port, started: true, reused: true, pid: existing.pid };
  }
  if (await isLookPortListening(port)) {
    return { url, port, started: false, reused: true };
  }
  if (lookServerDisabled()) {
    return { url, port, started: false, error: "look server disabled" };
  }
  const spec = lookServerSpawnArgs(opts.workspace, port);
  if (!spec) {
    return { url, port, started: false, error: "no look server for this tree" };
  }
  let child: ChildProcess;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: createChildEnv({ BROWSER: "none" }),
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
  } catch (err) {
    return {
      url,
      port,
      started: false,
      error: (err as Error).message || "spawn failed",
    };
  }
  const pid = child.pid;
  if (!pid || pid <= 1) {
    return { url, port, started: false, error: "look server spawned without pid" };
  }
  child.unref?.();
  const marker = path.join(
    forgeHome(),
    "sessions",
    sessionId,
    "browsers",
    "gui-vitepreview",
  );
  try {
    fs.mkdirSync(marker, { recursive: true });
  } catch {
    /* */
  }
  const cmd = `${spec.command} ${spec.args.join(" ")}`.slice(0, 800);
  registerBrowserLease({
    sessionId,
    rootSessionId: sessionId,
    udd: marker,
    workspace: opts.workspace,
    pid,
    pgid: pid,
    port,
    cmd,
    kind: "gui",
    bundleId: "vite-preview",
  });
  started.set(sessionId, { pid, port, url, child });
  const waitMs = opts.waitMs ?? 0;
  if (waitMs > 0) {
    const up = await waitForPort(port, waitMs);
    if (!up) {
      return {
        url,
        port,
        started: true,
        pid,
        error: `look server started but :${port} not listening yet`,
      };
    }
  }
  return { url, port, started: true, pid };
}

/** Test helper — drop the in-process spawn table (reap still owns the pid). */
export function forgetLookServer(sessionId: string): void {
  started.delete(sessionId);
}
