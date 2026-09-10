/**
 * Rehome look artefacts and reap leftover Playwright / Chromium scratch.
 *
 * Agent screenshots, look HTML and browser profiles belong under
 * ~/.forge/sessions/<id>/looks (or ~/.forge/tmp/playwright-output), never in
 * the project tree. Playwright MCP is launched `--isolated` with that output
 * dir; this module moves leftover looks, removes `.forge/chrome-(look|cft|fresh|…)*`
 * profiles, and kills Chromium whose --user-data-dir is one of ours (including
 * /tmp/hashpet-* · mom-* bash-spawned Chrome for Testing).
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isFalsy, isTruthy } from "./bool.js";
import { forgeHome } from "./fs.js";
import { createChildEnv } from "../agent/tools/env-policy.js";

const CHROME_LOOK_DIR_RE = /^chrome-(look|cft|fresh|desk|phone)[^/]*$/i;
const SESSION_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TMP_SCRATCH_RE = /hashpet|mom-|maze-|arts-/i;
const NAMED_PROFILE_RE =
  /chrome-cft|chrome-fresh|chrome-look|playwright-output|\/browsers\//i;

export function playwrightOutputDir(): string {
  return path.join(forgeHome(), "tmp", "playwright-output");
}

export function playwrightKeepOutput(): boolean {
  return isTruthy(process.env.FORGE_PLAYWRIGHT_KEEP);
}

/** Paths this process owns — only browsers whose cmdline cites these die. */
export function agentBrowserOwnedPaths(
  workspace?: string,
  sessionId?: string,
): string[] {
  const out = [playwrightOutputDir(), path.join(forgeHome(), "tmp")];
  if (workspace) {
    out.push(path.join(path.resolve(workspace), ".forge"));
  }
  if (sessionId && SESSION_SLUG_RE.test(sessionId)) {
    out.push(path.join(forgeHome(), "sessions", sessionId));
    out.push(...readSessionLeaseUdds(sessionId));
  }
  return out;
}

export function extractUserDataDir(cmd: string): string | undefined {
  const m = cmd.match(
    /--user-data-dir(?:\s*=\s*|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i,
  );
  const v = (m?.[1] || m?.[2] || m?.[3] || "").trim();
  return v || undefined;
}

export function extractRemoteDebuggingPort(cmd: string): number | undefined {
  const m = cmd.match(/--remote-debugging-port(?:\s*=\s*|\s+)(\d+)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

function isTmpAgentProfile(udd: string): boolean {
  const u = udd.replace(/\\/g, "/");
  if (!/^(\/private)?\/tmp\//i.test(u)) return false;
  return TMP_SCRATCH_RE.test(u);
}

function readSessionLeaseUdds(sessionId: string): string[] {
  try {
    const file = path.join(forgeHome(), "sessions", sessionId, "browsers.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      leases?: Array<{ udd?: unknown }>;
    };
    if (!Array.isArray(raw.leases)) return [];
    const out: string[] = [];
    for (const row of raw.leases) {
      if (typeof row?.udd === "string" && row.udd.trim()) out.push(row.udd.trim());
    }
    return out;
  } catch {
    return [];
  }
}

export function isAgentBrowserCommand(cmd: string, ownedPaths: string[]): boolean {
  const c = cmd.replace(/\\/g, "/");
  if (!/(chrom(e|ium)|msedge|playwright)/i.test(c)) return false;
  for (const raw of ownedPaths) {
    const p = raw.replace(/\\/g, "/");
    if (p.length >= 8 && c.includes(p)) return true;
  }
  const udd = extractUserDataDir(cmd);
  if (!udd) return false;
  const u = udd.replace(/\\/g, "/");
  for (const raw of ownedPaths) {
    const p = raw.replace(/\\/g, "/");
    if (p.length >= 8 && (u === p || u.startsWith(`${p}/`) || u.includes(p))) {
      return true;
    }
  }
  if (isTmpAgentProfile(u)) return true;
  if (NAMED_PROFILE_RE.test(u)) return true;
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

/** Test helper — same rows killOrphanAgentBrowsers uses when `opts.rows` is omitted. */
export function _listProcessesForTests(): Array<{ pid: number; cmd: string }> {
  return listProcesses();
}

function browserReapDisabled(): boolean {
  return isFalsy(process.env.FORGE_BROWSER_REAP);
}

/** SIGTERM browsers whose cmdline cites an owned Forge path (or a leased UDD). */
export function killOrphanAgentBrowsers(
  workspace?: string,
  opts?: {
    sessionId?: string;
    rows?: Array<{ pid: number; cmd: string }>;
    /** Lease reap: cmdline must also cite one of these paths (never a global pkill). */
    requirePath?: string[];
  },
): number {
  if (browserReapDisabled()) return 0;
  const owned = [
    ...agentBrowserOwnedPaths(workspace, opts?.sessionId),
    ...(opts?.requirePath ?? []),
  ];
  const requirePath = (opts?.requirePath ?? [])
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => p.length >= 8);
  const self = process.pid;
  let n = 0;
  for (const row of opts?.rows ?? listProcesses()) {
    if (row.pid === self || row.pid <= 1) continue;
    if (!isAgentBrowserCommand(row.cmd, owned)) continue;
    if (requirePath.length) {
      const c = row.cmd.replace(/\\/g, "/");
      if (!requirePath.some((p) => c.includes(p))) continue;
    }
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

export type SessionBrowserReapResult = { killed: number; removed: string[] };
type SessionBrowserReaper = (
  sessionId: string,
  opts?: { workspace?: string },
) => SessionBrowserReapResult;

let sessionBrowserReaper: SessionBrowserReaper | undefined;

/** Wired by browser-lease.ts so cleanup can reap leases without a circular import. */
export function bindSessionBrowserReaper(fn: SessionBrowserReaper): void {
  sessionBrowserReaper = fn;
}

/**
 * Session / MCP teardown: drop chrome-look profiles, wipe Playwright MCP
 * output, reap orphan Chromiums we spawned. When sessionId is set, also
 * reap that session's bash-spawned leases.
 */
export function cleanupAgentBrowserScratch(opts: {
  workspace?: string;
  sessionId?: string;
}): BrowserScratchCleanup {
  const chromeLooks = opts.workspace ? removeChromeLookDirs(opts.workspace) : [];
  const playwrightWiped = wipePlaywrightOutput();
  let killed = 0;
  const extraRemoved: string[] = [];
  if (opts.sessionId && sessionBrowserReaper) {
    try {
      const r = sessionBrowserReaper(opts.sessionId, { workspace: opts.workspace });
      killed += r.killed;
      extraRemoved.push(...r.removed);
    } catch {
      /* fail-open */
    }
  }
  killed += killOrphanAgentBrowsers(opts.workspace, { sessionId: opts.sessionId });
  return {
    chromeLooks: [...chromeLooks, ...extraRemoved],
    playwrightWiped,
    killed,
    rehomed: [],
  };
}
