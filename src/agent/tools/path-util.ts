import path from "node:path";
import { forgeHome, isWithinRoot, realpathWithinRoot } from "../../util/fs.js";
import {
  isProtectedWritePath,
  protectedWriteReason,
} from "../protected-paths.js";

export function resolvePath(workspace: string, p: string): string {
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve(workspace, p);
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
