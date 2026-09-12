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
  _listProcessesForTests,
  bindSessionBrowserReaper,
  extractRemoteDebuggingPort,
  extractUserDataDir,
  isAgentBrowserCommand,
  killOrphanAgentBrowsers,
  removeChromeLookDirs,
} from "../util/look-cleanup.js";
import { escalateKillPid, pidAlive } from "../util/process-tree.js";

export interface BrowserLease {
  id: string;
  pid?: number;
  pgid?: number;
  udd: string;
  port?: number;
  cmd?: string;
  createdAt: string;
  /** Root session that owns the registry (child leases live here, not on the child dir). */
  rootSessionId?: string;
  /** Child / role session that spawned this, when different from the root. */
  ownerSessionId?: string;
  kind?: "browser" | "gui" | "tmpdir";
  bundleId?: string;
  state?: "live" | "zombie";
}

interface BrowserLeaseFile {
  leases: BrowserLease[];
}

const SESSION_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CHROME_SCRATCH_DIR_RE = /^chrome-(look|cft|fresh|desk|phone)[^/]*$/i;
const DEFAULT_SESSION_MAX = 3;
const DEFAULT_MACHINE_MAX = 16;

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
    if (typeof row.pgid === "number" && Number.isInteger(row.pgid) && row.pgid > 1) {
      lease.pgid = row.pgid;
    }
    if (typeof row.rootSessionId === "string" && SESSION_SLUG_RE.test(row.rootSessionId)) {
      lease.rootSessionId = row.rootSessionId;
    }
    if (typeof row.ownerSessionId === "string" && SESSION_SLUG_RE.test(row.ownerSessionId)) {
      lease.ownerSessionId = row.ownerSessionId;
    }
    if (row.kind === "browser" || row.kind === "gui" || row.kind === "tmpdir") {
      lease.kind = row.kind;
    }
    if (typeof row.bundleId === "string" && row.bundleId.trim()) {
      lease.bundleId = row.bundleId.trim().slice(0, 120);
    }
    if (row.state === "live" || row.state === "zombie") lease.state = row.state;
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
 * Only profiles we created: forge-home session/tmp trees, any `/tmp/<subdir>`
 * (nested included — `/tmp/mom-c20/cdp-profile8`, `/tmp/hearth-*`),
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
  if (/^(\/private)?\/tmp\//i.test(n)) {
    const rel = n.replace(/^(\/private)?\/tmp\//i, "");
    return Boolean(rel) && rel !== n && !rel.startsWith("..");
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
): { killed: number; removed: string[]; alive: boolean } {
  let killed = 0;
  if (typeof lease.pgid === "number") killed += escalateKillPid(lease.pgid);
  else if (typeof lease.pid === "number") killed += escalateKillPid(lease.pid);
  if (isReapableBrowserUdd(lease.udd, opts?.workspace) || lease.kind === "gui") {
    killed += killOrphanAgentBrowsers(opts?.workspace, {
      sessionId,
      requirePath: lease.udd ? [lease.udd] : undefined,
      escalate: true,
    });
  }
  if (lease.kind === "gui" && opts?.workspace) {
    killed += killGuiMatchingWorkspace(lease, opts.workspace);
  }
  const removed: string[] = [];
  const gone = lease.udd ? removeUddDir(lease.udd, opts?.workspace) : undefined;
  if (gone) removed.push(gone);
  const alive =
    (typeof lease.pid === "number" && pidAlive(lease.pid)) ||
    (typeof lease.pgid === "number" && pidAlive(lease.pgid)) ||
    (lease.udd ? fs.existsSync(lease.udd) && dirStillHeld(lease.udd) : false);
  if (opts?.dropRecord !== false && !alive) dropLeaseRecord(sessionId, lease.id);
  return { killed, removed, alive };
}

function dirStillHeld(udd: string): boolean {
  try {
    const st = fs.statSync(udd);
    if (!st.isDirectory()) return false;
  } catch {
    return false;
  }
  // A UDD Chrome still has open is typically non-empty; empty marker dirs are gone.
  try {
    return fs.readdirSync(udd).length > 0 && chromeStillCites(udd);
  } catch {
    return false;
  }
}

function chromeStillCites(udd: string): boolean {
  for (const row of _listProcessesForTests()) {
    if (isAgentBrowserCommand(row.cmd, [udd])) return true;
  }
  return false;
}

function killGuiMatchingWorkspace(lease: BrowserLease, workspace: string): number {
  const ws = path.resolve(workspace);
  if (ws.length < 8) return 0;
  const blob = `${lease.cmd ?? ""} ${lease.bundleId ?? ""}`;
  if (!/godot/i.test(blob) && lease.kind !== "gui") return 0;
  let n = 0;
  for (const row of _listProcessesForTests()) {
    if (row.pid <= 1) continue;
    if (!/Godot/i.test(row.cmd)) continue;
    if (!row.cmd.includes(ws) && !/--write-movie|--quit-after|--path\s/i.test(row.cmd)) {
      continue;
    }
    n += escalateKillPid(row.pid);
  }
  return n;
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
  pgid?: number;
  port?: number;
  cmd?: string;
  rootSessionId?: string;
  kind?: BrowserLease["kind"];
  bundleId?: string;
}): BrowserLease {
  const ownerId = safeSessionId(opts.sessionId);
  const sessionId = safeSessionId(opts.rootSessionId || opts.sessionId);
  const udd = normalizeUdd(opts.udd);
  const kind = opts.kind ?? "browser";
  if (kind !== "gui" && (!udd || !isReapableBrowserUdd(udd, opts.workspace))) {
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
      rootSessionId: sessionId,
    };
    if (ownerId !== sessionId) created.ownerSessionId = ownerId;
    if (typeof opts.pid === "number" && opts.pid > 1) created.pid = opts.pid;
    if (typeof opts.pgid === "number" && opts.pgid > 1) created.pgid = opts.pgid;
    if (typeof opts.port === "number" && opts.port > 0) created.port = opts.port;
    if (opts.cmd) created.cmd = opts.cmd.trim().slice(0, 800);
    if (kind !== "browser") created.kind = kind;
    if (opts.bundleId) created.bundleId = opts.bundleId.trim().slice(0, 120);
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
  opts?: { workspace?: string; chromeLooks?: boolean; ownerSessionId?: string },
): { killed: number; removed: string[] } {
  // Kill-switch: leave debug browsers (UDDs and lease records) alone.
  if (browserReapDisabled()) {
    return { killed: 0, removed: [] };
  }
  const sid = safeSessionId(sessionId);
  const data = readStore(sid);
  const mine = opts?.ownerSessionId
    ? data.leases.filter(
        (l) => (l.ownerSessionId ?? sid) === safeSessionId(opts.ownerSessionId!),
      )
    : data.leases;
  const keep = opts?.ownerSessionId
    ? data.leases.filter(
        (l) => (l.ownerSessionId ?? sid) !== safeSessionId(opts.ownerSessionId!),
      )
    : [];
  const requirePath = [
    ...mine.map((l) => l.udd).filter((u) => isReapableBrowserUdd(u, opts?.workspace)),
    path.join(forgeHome(), "sessions", sid, "browsers"),
  ].filter((p) => p.length >= 8);
  let killed = 0;
  if (requirePath.length) {
    killed += killOrphanAgentBrowsers(opts?.workspace, {
      sessionId: sid,
      requirePath,
      escalate: true,
    });
  }
  const removed: string[] = [];
  const zombies: BrowserLease[] = [];
  for (const lease of mine) {
    const r = reapOneLease(sid, lease, {
      dropRecord: false,
      workspace: opts?.workspace,
    });
    killed += r.killed;
    removed.push(...r.removed);
    if (r.alive) zombies.push({ ...lease, state: "zombie" });
  }
  try {
    writeStore(sid, { leases: [...keep, ...zombies] });
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

/** Root session id: the parent of a subagent, else this session. */
export function rootSessionIdFromMeta(meta: {
  id?: string;
  subagent?: { parentId?: string };
}): string {
  const parent = meta.subagent?.parentId;
  if (parent && SESSION_SLUG_RE.test(parent)) return parent;
  return safeSessionId(String(meta.id || "anon"));
}

/**
 * Harness-owned look profile under the session. Planner/Reviewer reuse this
 * UDD instead of mkdir /tmp/<project>-cN-*.
 */
export function ensureSessionLookProfile(
  sessionId: string,
  opts?: { workspace?: string; rootSessionId?: string },
): string {
  const root = safeSessionId(opts?.rootSessionId || sessionId);
  const udd = path.join(forgeHome(), "sessions", root, "browsers", "look");
  try {
    fs.mkdirSync(udd, { recursive: true });
  } catch {
    /* */
  }
  registerBrowserLease({
    sessionId,
    rootSessionId: root,
    udd,
    workspace: opts?.workspace,
    cmd: "harness-look-profile",
    kind: "browser",
  });
  return udd;
}

/** Godot / `open -a Godot` — not Chrome, still a session-owned GUI. */
export function guiLeaseFromCommand(command: string): { app: string } | undefined {
  const cmd = String(command || "");
  if (/\bopen\s+(?:-[a-zA-Z]+\s+)*-a\s+["']?([^"'\n]+?)["']?(?:\s|$)/i.test(cmd)) {
    const m = cmd.match(/\bopen\s+(?:-[a-zA-Z]+\s+)*-a\s+["']?([^"'\n]+?)["']?(?:\s|$)/i);
    const app = (m?.[1] || "").trim();
    if (/godot/i.test(app)) return { app };
    return undefined;
  }
  if (/\bgodot(?:\.app)?\b/i.test(cmd) && !/chrome/i.test(cmd)) {
    return { app: "Godot" };
  }
  return undefined;
}

/**
 * Register every session-owned side effect visible on a bash command:
 * Chrome UDD, Godot, and the harness look profile when the cmd cites it.
 */
export function registerSpawnedResources(opts: {
  command: string;
  sessionId: string;
  workspace?: string;
  pid?: number;
  rootSessionId?: string;
}): void {
  const cmd = String(opts.command || "");
  const parsed = browserLeaseFromCommand(cmd);
  if (parsed) {
    registerBrowserLease({
      sessionId: opts.sessionId,
      rootSessionId: opts.rootSessionId,
      udd: parsed.udd,
      workspace: opts.workspace,
      pid: opts.pid,
      pgid: opts.pid,
      port: parsed.port,
      cmd: cmd.slice(0, 800),
      kind: "browser",
    });
  }
  const gui = guiLeaseFromCommand(cmd);
  if (gui) {
    const marker = path.join(
      forgeHome(),
      "sessions",
      safeSessionId(opts.rootSessionId || opts.sessionId),
      "browsers",
      `gui-${gui.app.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "app"}`,
    );
    try {
      fs.mkdirSync(marker, { recursive: true });
    } catch {
      /* */
    }
    registerBrowserLease({
      sessionId: opts.sessionId,
      rootSessionId: opts.rootSessionId,
      udd: marker,
      workspace: opts.workspace,
      pid: opts.pid,
      pgid: opts.pid,
      cmd: cmd.slice(0, 800),
      kind: "gui",
      bundleId: gui.app,
    });
  }
}
