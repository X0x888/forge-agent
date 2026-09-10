/**
 * Session sidecar for bash-spawned Chromium UDDs.
 * Browsers outlive the bash child (CDP), so leases persist after the wrapper exits.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isFalsy } from "../util/bool.js";
import { envPositiveInt } from "../util/env.js";
import { withFileLock } from "../util/file-lock.js";
import {
  forgeHome,
  isWithinRoot,
  nowIso,
  readJsonFile,
  writeJsonFile,
} from "../util/fs.js";
import {
  bindSessionBrowserReaper,
  extractRemoteDebuggingPort,
  extractUserDataDir,
  killOrphanAgentBrowsers,
  removeChromeLookDirs,
} from "../util/look-cleanup.js";

export interface BrowserLease {
  id: string;
  pid?: number;
  udd: string;
  port?: number;
  cmd?: string;
  createdAt: string;
}

interface BrowserLeaseFile {
  leases: BrowserLease[];
}

const SESSION_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CHROME_SCRATCH_DIR_RE = /^chrome-(look|cft|fresh|desk|phone)[^/]*$/i;
const TMP_BASENAME_RE = /^(hashpet-|mom-|maze-|arts-)/i;
const DEFAULT_SESSION_MAX = 2;
const DEFAULT_MACHINE_MAX = 6;

function emptyStore(): BrowserLeaseFile {
  return { leases: [] };
}

function safeSessionId(id: string): string {
  const s = String(id || "").trim();
  return SESSION_SLUG_RE.test(s) ? s : "anon";
}

function safeLeaseId(id: string): string {
  const s = String(id || "").trim();
  return SESSION_SLUG_RE.test(s) ? s : "lease";
}

function browsersJsonPath(sessionId: string): string {
  return path.join(forgeHome(), "sessions", safeSessionId(sessionId), "browsers.json");
}

function sessionLeaseMax(): number {
  return envPositiveInt("FORGE_BROWSER_LEASE_MAX", DEFAULT_SESSION_MAX);
}

function machineLeaseMax(): number {
  return envPositiveInt("FORGE_BROWSER_LEASE_MACHINE_MAX", DEFAULT_MACHINE_MAX);
}

function browserReapDisabled(): boolean {
  return isFalsy(process.env.FORGE_BROWSER_REAP);
}

function newLeaseId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function normalizeUdd(udd: string): string {
  return path.resolve(String(udd || "").trim());
}

function posixish(p: string): string {
  return p.replace(/\\/g, "/");
}

/** realpath when the path exists so macOS /var/folders and /private/var/folders match. */
function realPathOrResolve(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    let cursor = resolved;
    const missing: string[] = [];
    while (true) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      missing.push(path.basename(cursor));
      try {
        return path.join(fs.realpathSync(parent), ...missing.reverse());
      } catch {
        cursor = parent;
      }
    }
  }
}

function scrubStore(raw: BrowserLeaseFile): BrowserLeaseFile {
  const leases: BrowserLease[] = [];
  if (!Array.isArray(raw?.leases)) return emptyStore();
  for (const row of raw.leases) {
    if (!row || typeof row !== "object") continue;
    if (typeof row.udd !== "string" || !row.udd.trim()) continue;
    const id = typeof row.id === "string" && SESSION_SLUG_RE.test(row.id)
      ? row.id
      : newLeaseId();
    const createdAt =
      typeof row.createdAt === "string" && row.createdAt.trim()
        ? row.createdAt
        : nowIso();
    const lease: BrowserLease = { id, udd: row.udd.trim(), createdAt };
    if (typeof row.pid === "number" && Number.isInteger(row.pid) && row.pid > 1) {
      lease.pid = row.pid;
    }
    if (typeof row.port === "number" && Number.isInteger(row.port) && row.port > 0) {
      lease.port = row.port;
    }
    if (typeof row.cmd === "string" && row.cmd.trim()) {
      lease.cmd = row.cmd.trim().slice(0, 800);
    }
    leases.push(lease);
  }
  return { leases };
}

function readStore(sessionId: string): BrowserLeaseFile {
  const file = browsersJsonPath(sessionId);
  return scrubStore(readJsonFile<BrowserLeaseFile>(file, emptyStore()));
}

function writeStore(sessionId: string, data: BrowserLeaseFile): void {
  writeJsonFile(browsersJsonPath(sessionId), { leases: data.leases }, 0o600);
}

export function defaultBrowserUdd(sessionId: string, leaseId: string): string {
  return path.join(
    forgeHome(),
    "sessions",
    safeSessionId(sessionId),
    "browsers",
    safeLeaseId(leaseId),
  );
}

export function sessionBrowserOwnedPaths(sessionId: string): string[] {
  const sid = safeSessionId(sessionId);
  const out = [
    path.join(forgeHome(), "sessions", sid),
    path.join(forgeHome(), "sessions", sid, "browsers"),
  ];
  for (const lease of readStore(sid).leases) {
    if (lease.udd && isReapableBrowserUdd(lease.udd)) out.push(lease.udd);
  }
  return out;
}

/** Chrome/Chromium/chrome-headless-shell with a UDD — the bash-spawn shape. */
export function browserLeaseFromCommand(
  command: string,
): { udd: string; port?: number } | undefined {
  const cmd = String(command || "");
  if (!/(chrome-headless-shell|chrom(?:e|ium))/i.test(cmd)) return undefined;
  const udd = extractUserDataDir(cmd);
  if (!udd) return undefined;
  const port = extractRemoteDebuggingPort(cmd);
  return port != null ? { udd, port } : { udd };
}

/**
 * Only profiles we created: forge-home session/tmp trees, /tmp hashpet|mom-|maze-|arts-,
 * or workspace .forge/chrome-(look|cft|fresh|desk|phone)*. Never $HOME or stock Chrome.
 */
export function isReapableBrowserUdd(udd: string, workspace?: string): boolean {
  const real = realPathOrResolve(udd);
  const n = posixish(real);
  if (n.length < 12) return false;
  const home = posixish(realPathOrResolve(os.homedir()));
  if (
    n === "/" ||
    n === "/tmp" ||
    n === "/private/tmp" ||
    n === home ||
    (home && home.startsWith(`${n}/`))
  ) {
    return false;
  }
  const fh = realPathOrResolve(forgeHome());
  const fhN = posixish(fh);
  if (n === fhN || n === posixish(path.join(fh, "sessions")) || n === posixish(path.join(fh, "tmp"))) {
    return false;
  }
  if (isWithinRoot(fh, real)) {
    const rel = path.relative(fh, real).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    const parts = rel.split("/").filter(Boolean);
    if (parts[0] === "sessions" && parts.length >= 3) return true;
    if (parts[0] === "tmp" && parts.length >= 2) return true;
    return false;
  }
  if (/^(\/private)?\/tmp\//i.test(n) && TMP_BASENAME_RE.test(path.basename(n))) {
    return path.basename(n) !== "tmp";
  }
  if (workspace) {
    const scratch = realPathOrResolve(path.join(path.resolve(workspace), ".forge"));
    if (isWithinRoot(scratch, real) && scratch !== real) {
      if (CHROME_SCRATCH_DIR_RE.test(path.basename(real))) return true;
    }
  }
  return false;
}

function removeUddDir(udd: string, workspace?: string): string | undefined {
  if (!isReapableBrowserUdd(udd, workspace)) return undefined;
  try {
    if (!fs.existsSync(udd)) return undefined;
    fs.rmSync(udd, { recursive: true, force: true });
    return udd;
  } catch {
    return undefined;
  }
}

function dropLeaseRecord(sessionId: string, leaseId: string): void {
  const sid = safeSessionId(sessionId);
  const file = browsersJsonPath(sid);
  withFileLock(file, () => {
    const data = readStore(sid);
    data.leases = data.leases.filter((l) => l.id !== leaseId);
    writeStore(sid, data);
  });
}

function reapOneLease(
  sessionId: string,
  lease: BrowserLease,
  opts?: { workspace?: string; dropRecord?: boolean },
): { killed: number; removed: string[] } {
  const killed = isReapableBrowserUdd(lease.udd, opts?.workspace)
    ? killOrphanAgentBrowsers(opts?.workspace, {
        sessionId,
        requirePath: [lease.udd],
      })
    : 0;
  const removed: string[] = [];
  const gone = removeUddDir(lease.udd, opts?.workspace);
  if (gone) removed.push(gone);
  if (opts?.dropRecord !== false) dropLeaseRecord(sessionId, lease.id);
  return { killed, removed };
}

function listAllLeases(): Array<{ sessionId: string; lease: BrowserLease }> {
  const root = path.join(forgeHome(), "sessions");
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: Array<{ sessionId: string; lease: BrowserLease }> = [];
  for (const name of names) {
    if (!SESSION_SLUG_RE.test(name)) continue;
    for (const lease of readStore(name).leases) {
      out.push({ sessionId: name, lease });
    }
  }
  return out;
}

function createdAtMs(lease: BrowserLease): number {
  const t = Date.parse(lease.createdAt);
  return Number.isFinite(t) ? t : 0;
}

function enforceMachineCap(keep?: { sessionId: string; leaseId: string }): Array<{
  sessionId: string;
  lease: BrowserLease;
}> {
  const max = machineLeaseMax();
  const all = listAllLeases().sort((a, b) => createdAtMs(a.lease) - createdAtMs(b.lease));
  if (all.length <= max) return [];
  const extras: Array<{ sessionId: string; lease: BrowserLease }> = [];
  let overflow = all.length - max;
  for (const row of all) {
    if (overflow <= 0) break;
    if (keep && row.sessionId === keep.sessionId && row.lease.id === keep.leaseId) {
      continue;
    }
    extras.push(row);
    overflow -= 1;
  }
  return extras;
}

export function registerBrowserLease(opts: {
  sessionId: string;
  udd: string;
  workspace?: string;
  pid?: number;
  port?: number;
  cmd?: string;
}): BrowserLease {
  const sessionId = safeSessionId(opts.sessionId);
  const udd = normalizeUdd(opts.udd);
  if (!udd || !isReapableBrowserUdd(udd, opts.workspace)) {
    return {
      id: "skipped",
      udd,
      createdAt: nowIso(),
    };
  }
  const file = browsersJsonPath(sessionId);
  const sessionExtras: BrowserLease[] = [];
  const lease = withFileLock(file, () => {
    const data = readStore(sessionId);
    const existing = data.leases.find((l) => normalizeUdd(l.udd) === udd);
    if (existing) {
      if (typeof opts.pid === "number" && opts.pid > 1) existing.pid = opts.pid;
      if (typeof opts.port === "number" && opts.port > 0) existing.port = opts.port;
      if (opts.cmd) existing.cmd = opts.cmd.trim().slice(0, 800);
      writeStore(sessionId, data);
      return existing;
    }
    const created: BrowserLease = {
      id: newLeaseId(),
      udd,
      createdAt: nowIso(),
    };
    if (typeof opts.pid === "number" && opts.pid > 1) created.pid = opts.pid;
    if (typeof opts.port === "number" && opts.port > 0) created.port = opts.port;
    if (opts.cmd) created.cmd = opts.cmd.trim().slice(0, 800);
    data.leases.push(created);
    data.leases.sort((a, b) => createdAtMs(a) - createdAtMs(b));
    const max = sessionLeaseMax();
    while (data.leases.length > max) {
      const old = data.leases.shift();
      if (old) sessionExtras.push(old);
    }
    writeStore(sessionId, data);
    return created;
  });
  for (const extra of sessionExtras) {
    reapOneLease(sessionId, extra, {
      dropRecord: false,
      workspace: opts.workspace,
    });
  }
  const machineExtras = enforceMachineCap({ sessionId, leaseId: lease.id });
  for (const extra of machineExtras) {
    reapOneLease(extra.sessionId, extra.lease, {
      dropRecord: true,
      workspace: opts.workspace,
    });
  }
  return lease;
}

export function reapSessionBrowsers(
  sessionId: string,
  opts?: { workspace?: string; chromeLooks?: boolean },
): { killed: number; removed: string[] } {
  const sid = safeSessionId(sessionId);
  const data = readStore(sid);
  const requirePath = [
    ...data.leases
      .map((l) => l.udd)
      .filter((u) => isReapableBrowserUdd(u, opts?.workspace)),
    path.join(forgeHome(), "sessions", sid, "browsers"),
  ].filter((p) => p.length >= 8);
  let killed = 0;
  if (!browserReapDisabled() && requirePath.length) {
    killed += killOrphanAgentBrowsers(opts?.workspace, {
      sessionId: sid,
      requirePath,
    });
  }
  const removed: string[] = [];
  for (const lease of data.leases) {
    const gone = removeUddDir(lease.udd, opts?.workspace);
    if (gone) removed.push(gone);
  }
  try {
    writeStore(sid, emptyStore());
  } catch {
    /* fail-open */
  }
  // Isolation-none children share the parent workspace; wipe look dirs only
  // on cycle commit / MCP dispose / process exit, never on child-session cleanup.
  if (opts?.workspace && opts.chromeLooks !== false) {
    try {
      for (const rel of removeChromeLookDirs(opts.workspace)) {
        removed.push(rel);
      }
    } catch {
      /* fail-open */
    }
  }
  return { killed, removed };
}

bindSessionBrowserReaper(reapSessionBrowsers);
