/**
 * Non-mutating safety checkpoints via `git stash create`.
 *
 * Creates a dangling commit of the current index+worktree and (best-effort)
 * pins it under refs/forge/checkpoint/ so GC won't drop it immediately.
 * Working tree stays byte-identical — unlike `git stash push`.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { findGitRoot } from "../agent/worktree.js";

export interface SafetyCheckpointResult {
  ok: boolean;
  /** Empty tree / nothing to snapshot */
  clean?: boolean;
  sha?: string;
  ref?: string;
  dirtyPaths?: number;
  detail?: string;
}

function git(
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

/**
 * Snapshot the current worktree without mutating it.
 * @param label short tag for the ref name (session id / "ulw" / …)
 */
export function createSafetyCheckpoint(
  workspace: string,
  opts?: { label?: string },
): SafetyCheckpointResult {
  const start = path.resolve(workspace || process.cwd());
  const root = findGitRoot(start);
  if (!root) {
    return { ok: false, detail: "not a git repository" };
  }
  try {
    git(["rev-parse", "--is-inside-work-tree"], root, 5_000);
  } catch {
    return { ok: false, detail: "not a git repository" };
  }

  let porcelain = "";
  try {
    porcelain = git(["status", "--porcelain"], root, 15_000);
  } catch (err) {
    return {
      ok: false,
      detail: `status failed: ${String((err as Error)?.message || err).slice(0, 200)}`,
    };
  }
  if (!porcelain) {
    return { ok: true, clean: true, detail: "working tree clean" };
  }

  let sha = "";
  try {
    sha = git(["stash", "create"], root, 60_000);
  } catch (err) {
    return {
      ok: false,
      detail: `stash create failed: ${String((err as Error)?.message || err).slice(0, 300)}`,
    };
  }
  if (!sha) {
    return {
      ok: true,
      clean: true,
      detail: "stash create empty (nothing snapshot-able)",
    };
  }

  const slug = String(opts?.label || "snap")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "snap";
  const ref = `refs/forge/checkpoint/${slug}-${Date.now().toString(36)}`;
  try {
    git(["update-ref", ref, sha], root, 8_000);
  } catch {
    /* best-effort pin */
  }

  const dirtyPaths = porcelain.split("\n").filter(Boolean).length;
  return { ok: true, sha, ref, dirtyPaths };
}

/** Apply a previously created checkpoint sha into the working tree. */
export function applySafetyCheckpoint(
  workspace: string,
  sha: string,
): { ok: boolean; detail?: string } {
  const start = path.resolve(workspace || process.cwd());
  const root = findGitRoot(start);
  if (!root) return { ok: false, detail: "not a git repository" };
  const id = String(sha || "").trim();
  if (!id) return { ok: false, detail: "missing sha" };
  try {
    git(["cat-file", "-t", id], root, 5_000);
    git(["stash", "apply", id], root, 60_000);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: String((err as Error)?.message || err).slice(0, 400),
    };
  }
}
