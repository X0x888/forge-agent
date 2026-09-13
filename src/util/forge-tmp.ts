/**
 * ~/.forge/tmp scratch — leftover Chrome-for-Testing / look profiles.
 *
 * Playwright isolation and session leases are supposed to reap these; a
 * crashed ULW still leaves multi-GB chrome-cft-* dirs. Doctor surfaces the
 * size; `forge tmp prune` deletes stale immediate children.
 */
import fs from "node:fs";
import path from "node:path";
import { forgeHome } from "./fs.js";

/** Immediate children of ~/.forge/tmp that look like agent look/Chrome scratch. */
const SCRATCH_NAME_RE =
  /^(chrome-|hashpet-|mom-|maze-|arts-|hearth-|cycle\d|playwright-output$)/i;
const SCRATCH_TAIL_RE = /-(scout|look|reviewer-look|chrome)/i;

export const FORGE_TMP_PRUNE_DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function forgeTmpDir(): string {
  return path.join(forgeHome(), "tmp");
}

export function isForgeTmpScratchName(name: string): boolean {
  const base = String(name || "").trim();
  if (!base || base === "." || base === "..") return false;
  return SCRATCH_NAME_RE.test(base) || SCRATCH_TAIL_RE.test(base);
}

function dirBytes(root: string, cap = 80_000): number {
  let total = 0;
  let seen = 0;
  const walk = (dir: string): void => {
    if (seen >= cap) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (seen >= cap) return;
      seen += 1;
      const p = path.join(dir, ent.name);
      try {
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile()) {
          const st = fs.statSync(p);
          total += st.size;
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(root);
  return total;
}

export interface ForgeTmpChild {
  name: string;
  bytes: number;
  mtimeMs: number;
  scratch: boolean;
}

export interface ForgeTmpStats {
  dir: string;
  exists: boolean;
  bytes: number;
  dirs: number;
  scratchDirs: number;
  scratchBytes: number;
  oldestScratchMs: number | null;
}

function listChildren(dir: string): ForgeTmpChild[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: ForgeTmpChild[] = [];
  for (const name of names) {
    if (name === "." || name === "..") continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (!st.isDirectory() && !st.isFile()) continue;
      const bytes = st.isDirectory() ? dirBytes(p) : st.size;
      out.push({
        name,
        bytes,
        mtimeMs: st.mtimeMs,
        scratch: isForgeTmpScratchName(name),
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

export function forgeTmpStats(): ForgeTmpStats {
  const dir = forgeTmpDir();
  const empty: ForgeTmpStats = {
    dir,
    exists: false,
    bytes: 0,
    dirs: 0,
    scratchDirs: 0,
    scratchBytes: 0,
    oldestScratchMs: null,
  };
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return empty;
  } catch {
    return empty;
  }
  const kids = listChildren(dir);
  let bytes = 0;
  let dirs = 0;
  let scratchDirs = 0;
  let scratchBytes = 0;
  let oldest: number | null = null;
  for (const k of kids) {
    bytes += k.bytes;
    if (k.scratch) {
      scratchDirs += 1;
      scratchBytes += k.bytes;
      if (oldest == null || k.mtimeMs < oldest) oldest = k.mtimeMs;
    } else {
      dirs += 1;
    }
  }
  return {
    dir,
    exists: true,
    bytes,
    dirs: kids.length,
    scratchDirs,
    scratchBytes,
    oldestScratchMs: oldest,
  };
}

export interface PruneForgeTmpResult {
  deleted: string[];
  freedBytes: number;
  skippedFresh: number;
  skippedOther: number;
  dry: boolean;
}

/**
 * Delete stale scratch children of ~/.forge/tmp.
 * Never deletes the tmp root, never follows symlinks, never touches sessions.
 */
export function pruneForgeTmp(opts?: {
  maxAgeMs?: number;
  /** When true, ignore mtime (still only scratch names). */
  force?: boolean;
  dry?: boolean;
}): PruneForgeTmpResult {
  const dir = forgeTmpDir();
  const maxAgeMs =
    typeof opts?.maxAgeMs === "number" && Number.isFinite(opts.maxAgeMs)
      ? Math.max(0, opts.maxAgeMs)
      : FORGE_TMP_PRUNE_DEFAULT_MAX_AGE_MS;
  const force = Boolean(opts?.force);
  const dry = Boolean(opts?.dry);
  const result: PruneForgeTmpResult = {
    deleted: [],
    freedBytes: 0,
    skippedFresh: 0,
    skippedOther: 0,
    dry,
  };
  const kids = listChildren(dir);
  const now = Date.now();
  for (const k of kids) {
    if (!k.scratch) {
      result.skippedOther += 1;
      continue;
    }
    const age = now - k.mtimeMs;
    if (!force && maxAgeMs > 0 && age < maxAgeMs) {
      result.skippedFresh += 1;
      continue;
    }
    const p = path.join(dir, k.name);
    if (dry) {
      result.deleted.push(k.name);
      result.freedBytes += k.bytes;
      continue;
    }
    try {
      fs.rmSync(p, { recursive: true, force: true });
      result.deleted.push(k.name);
      result.freedBytes += k.bytes;
    } catch {
      /* leave it */
    }
  }
  return result;
}
