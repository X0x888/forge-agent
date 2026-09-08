/**
 * Rehome look artefacts and reap leftover Playwright / Chromium scratch.
 *
 * Agent screenshots, look HTML and browser profiles belong under
 * ~/.forge/sessions/<id>/looks (or ~/.forge/tmp/playwright-output), never in
 * the project tree. Playwright MCP is launched `--isolated` with that output
 * dir; this module moves leftover looks, removes `.forge/chrome-look*`
 * profiles, and kills Chromium whose --user-data-dir is one of ours.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isTruthy } from "./bool.js";
import { forgeHome } from "./fs.js";
import { createChildEnv } from "../agent/tools/env-policy.js";

const CHROME_LOOK_DIR_RE = /^chrome-look[^/]*$/i;

export function playwrightOutputDir(): string {
  return path.join(forgeHome(), "tmp", "playwright-output");
}

export function playwrightKeepOutput(): boolean {
  return isTruthy(process.env.FORGE_PLAYWRIGHT_KEEP);
}

/** Paths this process owns — only browsers whose cmdline cites these die. */
export function agentBrowserOwnedPaths(workspace?: string): string[] {
  const out = [playwrightOutputDir(), path.join(forgeHome(), "tmp")];
  if (workspace) {
    out.push(path.join(path.resolve(workspace), ".forge"));
  }
  return out;
}

export function isAgentBrowserCommand(cmd: string, ownedPaths: string[]): boolean {
  const c = cmd.replace(/\\/g, "/");
  if (!/(chrom(e|ium)|msedge|playwright)/i.test(c)) return false;
  for (const raw of ownedPaths) {
    const p = raw.replace(/\\/g, "/");
    if (p.length >= 8 && c.includes(p)) return true;
  }
  // Playwright MCP default profile names, only when the cmdline also
  // mentions a Forge tmp / .forge path we already checked — do not kill
  // a user's own mcp-chrome from another tool.
  return false;
}

export function listChromeLookDirs(cwd: string): string[] {
  const forge = path.join(path.resolve(cwd), ".forge");
  let names: string[] = [];
  try {
    names = fs.readdirSync(forge);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (!CHROME_LOOK_DIR_RE.test(n)) continue;
    const abs = path.join(forge, n);
    try {
      if (fs.statSync(abs).isDirectory()) out.push(abs);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function removeChromeLookDirs(cwd: string): string[] {
  const removed: string[] = [];
  for (const dir of listChromeLookDirs(cwd)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(path.relative(path.resolve(cwd), dir).replace(/\\/g, "/") || dir);
    } catch {
      /* leave it */
    }
  }
  return removed;
}

export function wipePlaywrightOutput(): boolean {
  if (playwrightKeepOutput()) return false;
  const dir = playwrightOutputDir();
  try {
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Move look files out of the workspace into destDir. Cross-device rename
 * falls back to copy+unlink. Dest names stay unique.
 */
export function rehomeFiles(opts: {
  cwd: string;
  relPaths: string[];
  destDir: string;
}): { moved: string[]; failed: string[] } {
  const cwd = path.resolve(opts.cwd);
  const destDir = path.resolve(opts.destDir);
  fs.mkdirSync(destDir, { recursive: true });
  const moved: string[] = [];
  const failed: string[] = [];
  const used = new Set<string>();
  for (const rel of opts.relPaths) {
    const src = path.resolve(cwd, rel);
    const base = path.basename(rel) || "look";
    let dest = path.join(destDir, base);
    let i = 1;
    while (used.has(dest) || fs.existsSync(dest)) {
      const ext = path.extname(base);
      const stem = ext ? base.slice(0, -ext.length) : base;
      dest = path.join(destDir, `${stem}-${i}${ext}`);
      i += 1;
    }
    used.add(dest);
    try {
      fs.renameSync(src, dest);
      moved.push(rel);
    } catch {
      try {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
        moved.push(rel);
      } catch {
        failed.push(rel);
      }
    }
  }
  return { moved, failed };
}

interface PsRow {
  pid: number;
  cmd: string;
}

function listProcesses(): PsRow[] {
  if (process.platform === "win32") return [];
  try {
    const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: createChildEnv(),
    });
    const rows: PsRow[] = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      rows.push({ pid, cmd: m[2] });
    }
    return rows;
  } catch {
    return [];
  }
}

/** SIGTERM then SIGKILL browsers whose cmdline cites an owned Forge path. */
export function killOrphanAgentBrowsers(workspace?: string): number {
  const owned = agentBrowserOwnedPaths(workspace);
  const self = process.pid;
  let n = 0;
  for (const row of listProcesses()) {
    if (row.pid === self) continue;
    if (!isAgentBrowserCommand(row.cmd, owned)) continue;
    try {
      process.kill(row.pid, "SIGTERM");
      n += 1;
    } catch {
      /* already gone */
    }
  }
  return n;
}

export interface BrowserScratchCleanup {
  chromeLooks: string[];
  playwrightWiped: boolean;
  killed: number;
  rehomed: string[];
}

/**
 * Session / MCP teardown: drop chrome-look profiles, wipe Playwright MCP
 * output, reap orphan Chromiums we spawned.
 */
export function cleanupAgentBrowserScratch(opts: {
  workspace?: string;
  sessionId?: string;
}): BrowserScratchCleanup {
  const chromeLooks = opts.workspace ? removeChromeLookDirs(opts.workspace) : [];
  const playwrightWiped = wipePlaywrightOutput();
  const killed = killOrphanAgentBrowsers(opts.workspace);
  return { chromeLooks, playwrightWiped, killed, rehomed: [] };
}
