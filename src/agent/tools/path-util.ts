import path from "node:path";
import { forgeHome, isWithinRoot, realpathWithinRoot } from "../../util/fs.js";

export function resolvePath(workspace: string, p: string): string {
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve(workspace, p);
}

/**
 * Writes must stay inside workspace or ~/.forge (session files).
 * Uses realpath to defeat symlink escapes.
 */
export async function assertWritablePath(
  workspace: string,
  target: string,
): Promise<string> {
  const ws = await realpathWithinRoot(workspace, target);
  if (ws.ok) return ws.path;

  const home = forgeHome();
  const fh = await realpathWithinRoot(home, target);
  if (fh.ok) return fh.path;

  // Also allow logical within-root when neither path exists yet under a new tree
  // that is still under workspace by path.resolve (no symlink leap).
  const logical = path.resolve(target);
  if (isWithinRoot(workspace, logical) || isWithinRoot(home, logical)) {
    // Prefer reporting the realpath failure if an ancestor escaped.
    if (ws.reason.includes("escapes")) throw new Error(ws.reason);
    return logical;
  }

  throw new Error(
    `Path escapes workspace: ${target} (workspace: ${workspace}). Use a path under the project root.`,
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
  } catch {
    /* */
  }
  return logical;
}
