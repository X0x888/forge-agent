/**
 * Non-mutating safety checkpoints.
 *
 * `git stash create` only snapshots tracked dirty files and `git stash apply`
 * 3-way-merges them back. That is not a rewind: untracked files vanish from
 * the snapshot, and a later edit of the same hunk conflicts or mixes.
 *
 * Snapshot: temp index + `git add -A` + `commit-tree` (worktree untouched).
 * Untracked files are included; secrets / disposable fixtures are dropped
 * from the tree only. Restore: `git restore --source=<sha>` overwrite, then
 * mixed `git reset` so new files return to untracked. Not `stash apply`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChildEnv } from "../agent/tools/env-policy.js";
import { findGitRoot, parsePorcelainPath } from "../agent/worktree.js";
import {
  formatGitExecError,
  isDisposableTestRelPath,
  isSensitiveRelPath,
} from "./git-auto-commit.js";

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
  extraEnv?: NodeJS.ProcessEnv,
): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  }).trimEnd();
}

function slugLabel(label?: string): string {
  return (
    String(label || "snap")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "snap"
  );
}

function listDirtyRelPaths(root: string): {
  dirty: string[];
  skipped: string[];
  error?: string;
} {
  let porcelain = "";
  try {
    porcelain = git(["status", "--porcelain", "-uall"], root, 15_000);
  } catch (err) {
    return { dirty: [], skipped: [], error: formatGitExecError(err) };
  }
  const dirty: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const p = parsePorcelainPath(line);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (isSensitiveRelPath(p) || isDisposableTestRelPath(p)) {
      skipped.push(p);
      continue;
    }
    dirty.push(p);
  }
  return { dirty, skipped };
}

function dropCachedPaths(
  root: string,
  env: NodeJS.ProcessEnv,
  paths: string[],
): void {
  if (!paths.length) return;
  const chunk = 80;
  for (let i = 0; i < paths.length; i += chunk) {
    const slice = paths.slice(i, i + chunk);
    try {
      git(
        ["rm", "--cached", "--ignore-unmatch", "-q", "--", ...slice],
        root,
        15_000,
        env,
      );
    } catch {
      /* best-effort — snapshot still better than stash create */
    }
  }
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

  const listed = listDirtyRelPaths(root);
  if (listed.error) {
    return { ok: false, detail: `status failed: ${listed.error}` };
  }
  if (!listed.dirty.length) {
    return {
      ok: true,
      clean: true,
      detail: listed.skipped.length
        ? "only sensitive or disposable paths remain"
        : "working tree clean",
    };
  }

  // Index file lives in tmpdir — writing under `.git/` is EPERM in the
  // workspace sandbox (and would dirty porcelain if it landed in-tree).
  const tmpIndex = path.join(
    os.tmpdir(),
    `forge-ckpt-${process.pid}-${Date.now().toString(36)}.idx`,
  );
  try {
    const env = { GIT_INDEX_FILE: tmpIndex };
    git(["add", "-A", "--"], root, 60_000, env);

    let cached = "";
    try {
      cached = git(["diff", "--cached", "--name-only", "-z"], root, 15_000, env);
    } catch {
      cached = "";
    }
    const cachedPaths = cached.split("\0").filter(Boolean);
    const extraDrop = cachedPaths.filter(
      (p) => isSensitiveRelPath(p) || isDisposableTestRelPath(p),
    );
    dropCachedPaths(root, env, [...new Set([...listed.skipped, ...extraDrop])]);

    const tree = git(["write-tree"], root, 15_000, env);
    if (!tree) {
      return { ok: true, clean: true, detail: "write-tree empty" };
    }

    let parent = "";
    try {
      parent = git(["rev-parse", "HEAD"], root, 5_000);
    } catch {
      parent = "";
    }
    const label = slugLabel(opts?.label);
    const msg = `forge checkpoint ${label}`;
    const sha = parent
      ? git(["commit-tree", tree, "-p", parent, "-m", msg], root, 15_000)
      : git(["commit-tree", tree, "-m", msg], root, 15_000);
    if (!sha) {
      return { ok: false, detail: "commit-tree empty" };
    }

    const ref = `refs/forge/checkpoint/${label}-${Date.now().toString(36)}`;
    try {
      git(["update-ref", ref, sha], root, 8_000);
    } catch {
      /* best-effort pin so GC does not drop the dangling commit */
    }

    return { ok: true, sha, ref, dirtyPaths: listed.dirty.length };
  } catch (err) {
    return {
      ok: false,
      detail: `snapshot failed: ${formatGitExecError(err)}`,
    };
  } finally {
    try {
      fs.unlinkSync(tmpIndex);
    } catch {
      /* */
    }
  }
}

/** Rewind the worktree to a previously created checkpoint sha (overwrite, not merge). */
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
    const kind = git(["cat-file", "-t", id], root, 5_000);
    if (kind !== "commit") {
      return { ok: false, detail: `not a commit (${kind || "unknown"})` };
    }
  } catch (err) {
    return { ok: false, detail: `unknown sha: ${formatGitExecError(err)}` };
  }
  try {
    try {
      git(
        ["restore", `--source=${id}`, "--worktree", "--staged", "--", "."],
        root,
        60_000,
      );
    } catch {
      git(["checkout", id, "--", "."], root, 60_000);
    }
    try {
      git(["reset", "--quiet"], root, 15_000);
    } catch {
      /* mixed reset is hygiene — tree already matches the snapshot */
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: formatGitExecError(err) };
  }
}
