import fs from "node:fs";
import path from "node:path";
import { forgeHome, isWithinRoot, realpathWithinRoot } from "../../util/fs.js";
import {
  isProtectedReadTarget,
  isProtectedWritePath,
  protectedReadReason,
  protectedWriteReason,
} from "../protected-paths.js";

export function resolvePath(workspace: string, p: string): string {
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve(workspace, p);
}

/**
 * Realpath an existing path, or the nearest existing ancestor + rejoin
 * trailing segments. Handles missing files and macOS `/var` → `/private/var`.
 */
export function realpathExistingPrefix(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (true) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Workspace-relative path for tool transcripts / diffs.
 * Realpath-normalizes macOS `/var` vs `/private/var` (and similar) so
 * `path.relative` does not leak `../../../../private/var/...` into output.
 */
export function displayRelPath(workspace: string, filePath: string): string {
  const ws = path.resolve(workspace);
  const fp = path.resolve(filePath);
  const clean = (rel: string): string | null => {
    if (!rel) return ".";
    if (path.isAbsolute(rel)) return null;
    if (rel === "..") return null;
    if (rel.startsWith(`..${path.sep}`)) return null;
    return rel;
  };
  const first = clean(path.relative(ws, fp));
  if (first != null) return first;
  try {
    const wsReal = realpathExistingPrefix(ws);
    const fpReal = realpathExistingPrefix(fp);
    const second = clean(path.relative(wsReal, fpReal));
    if (second != null) return second;
  } catch {
    /* ignore */
  }
  // Outside the workspace — keep the logical absolute path the caller gave
  // (do not realpath `/etc` → `/private/etc` on macOS; that confuses UX/tests).
  return fp;
}

/**
 * Writes must stay inside workspace or ~/.forge/sessions|logs|tmp.
 * Uses realpath to defeat symlink escapes; blocks credentials/.git hooks.
 */
export async function assertWritablePath(
  workspace: string,
  target: string,
): Promise<string> {
  const logical = path.resolve(target);

  // Fast path: logical protected check before realpath
  if (isProtectedWritePath(logical)) {
    throw new Error(protectedWriteReason(logical));
  }

  const ws = await realpathWithinRoot(workspace, target);
  if (ws.ok) {
    if (isProtectedWritePath(ws.path)) {
      throw new Error(protectedWriteReason(ws.path));
    }
    return ws.path;
  }

  const home = forgeHome();
  const fh = await realpathWithinRoot(home, target);
  if (fh.ok) {
    if (isProtectedWritePath(fh.path)) {
      throw new Error(protectedWriteReason(fh.path));
    }
    // Only sessions/logs/tmp under forge home
    const p = fh.path.replace(/\\/g, "/");
    const forge = home.replace(/\\/g, "/");
    if (
      p.startsWith(`${forge}/sessions/`) ||
      p.startsWith(`${forge}/logs/`) ||
      p.startsWith(`${forge}/tmp/`)
    ) {
      return fh.path;
    }
    throw new Error(
      `Refusing write under ~/.forge outside sessions/logs/tmp: ${fh.path}. ` +
        "Agent-writable: ~/.forge/sessions/, logs/, tmp/ only. " +
        "Use forge login/config/doctor for credentials and config.",
    );
  }

  // Logical within-root when path does not exist yet (no symlink leap)
  if (isWithinRoot(workspace, logical)) {
    if (ws.reason.includes("escapes")) throw new Error(ws.reason);
    if (isProtectedWritePath(logical)) {
      throw new Error(protectedWriteReason(logical));
    }
    return logical;
  }

  throw new Error(
    `Path escapes workspace: ${target} (workspace: ${workspace}). ` +
      "Use a path under the project root, or enable --read-outside only for reads (writes stay sandboxed).",
  );
}

/** Soft check for reads: prefer realpath but still return resolved path if missing. */
export async function resolveReadablePath(
  workspace: string,
  target: string,
): Promise<string> {
  const logical = resolvePath(workspace, target);
  try {
    const checked = await realpathWithinRoot(workspace, logical);
    if (checked.ok) return checked.path;
    // Symlink escaped workspace — still return logical for soft read of missing;
    // caller may read outside only if permission gate allowed it.
    if (checked.reason.includes("escapes")) {
      // Prefer denying escape: return path that will fail or be outside
      return checked.reason.includes("→")
        ? logical
        : logical;
    }
  } catch {
    /* */
  }
  return logical;
}

/**
 * Reads must not dump credential surfaces into the model (auth.json, private
 * keys). Realpath so a workspace symlink cannot launder ~/.forge/auth.json.
 * YOLO / --read-outside allow cannot bypass this.
 */
export async function assertReadablePath(
  workspace: string,
  target: string,
): Promise<string> {
  const logical = resolvePath(workspace, target);
  if (isProtectedReadTarget(logical)) {
    throw new Error(protectedReadReason(logical));
  }
  const resolved = await resolveReadablePath(workspace, target);
  const candidates = [resolved, realpathExistingPrefix(resolved)];
  try {
    candidates.push(fs.realpathSync(resolved));
  } catch {
    /* missing / dangling */
  }
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) {
      const dest = fs.readlinkSync(resolved);
      const absDest = path.isAbsolute(dest)
        ? path.resolve(dest)
        : path.resolve(path.dirname(resolved), dest);
      candidates.push(absDest, realpathExistingPrefix(absDest));
    }
  } catch {
    /* */
  }
  for (const c of candidates) {
    if (isProtectedReadTarget(c)) {
      throw new Error(protectedReadReason(c));
    }
  }
  return resolved;
}
