/**
 * Git worktree helpers for subagent isolation.
 *
 * Creates a detached linked worktree under ~/.forge/worktrees/ so nested
 * agents can edit without touching the parent checkout. Best-effort cleanup
 * with `git worktree remove --force` (and directory rm fallback).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { forgeHome, ensureDir } from "../util/fs.js";
import { log } from "../util/log.js";

export interface SubagentWorktree {
  /** Absolute path of the worktree checkout. */
  path: string;
  /** Git common dir / main repo root (absolute). */
  gitRoot: string;
  /** Detached or branch name used. */
  ref: string;
  /** Remove the worktree from disk + git metadata. */
  cleanup: () => Promise<void>;
}

function git(
  args: string[],
  cwd: string,
  opts?: { timeoutMs?: number },
): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts?.timeoutMs ?? 30_000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
}

/** Resolve git top-level for a workspace path, or null if not a repo. */
export function findGitRoot(start: string): string | null {
  try {
    const root = git(["rev-parse", "--show-toplevel"], start);
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

export function worktreeBaseDir(): string {
  return path.join(forgeHome(), "worktrees");
}

/**
 * Create a detached worktree at HEAD for isolated subagent work.
 * Throws with a clear message when git is unavailable or not a repo.
 */
export function createSubagentWorktree(opts: {
  workspace: string;
  /** Short label for the directory name (sanitized). */
  label?: string;
  sessionId?: string;
}): SubagentWorktree {
  const workspace = path.resolve(opts.workspace);
  const gitRoot = findGitRoot(workspace);
  if (!gitRoot) {
    throw new Error(
      "isolation=worktree requires a git repository (no .git found from workspace). " +
        "Use isolation=none (default) or init a git repo first.",
    );
  }

  // Verify git binary works
  try {
    git(["--version"], gitRoot);
  } catch {
    throw new Error(
      "isolation=worktree requires the `git` CLI on PATH.",
    );
  }

  const slug = sanitizeLabel(opts.label || "sub");
  const id =
    (opts.sessionId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) ||
    randomBytes(4).toString("hex");
  const dirName = `sub-${slug}-${id}-${Date.now().toString(36)}`.slice(0, 80);
  const wtPath = path.join(worktreeBaseDir(), dirName);
  ensureDir(worktreeBaseDir());

  // Detached HEAD at current commit — no branch pollution.
  // --force not needed for new path.
  try {
    git(
      ["worktree", "add", "--detach", wtPath, "HEAD"],
      gitRoot,
      { timeoutMs: 60_000 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Clean partial dir
    try {
      fs.rmSync(wtPath, { recursive: true, force: true });
    } catch {
      /* */
    }
    throw new Error(
      `Failed to create git worktree at ${wtPath}: ${msg.slice(0, 400)}`,
    );
  }

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      git(
        ["worktree", "remove", "--force", wtPath],
        gitRoot,
        { timeoutMs: 60_000 },
      );
    } catch {
      // Fallback: prune + rm
      try {
        git(["worktree", "prune"], gitRoot, { timeoutMs: 15_000 });
      } catch {
        /* */
      }
      try {
        fs.rmSync(wtPath, { recursive: true, force: true });
      } catch (e) {
        log.warn(
          `worktree cleanup incomplete: ${wtPath} (${(e as Error).message})`,
        );
      }
    }
  };

  return {
    path: wtPath,
    gitRoot,
    ref: "HEAD (detached)",
    cleanup,
  };
}

function sanitizeLabel(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "sub"
  );
}

export function resolveIsolationMode(raw: unknown): "none" | "worktree" {
  const s = String(raw ?? "none")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (
    s === "worktree" ||
    s === "wt" ||
    s === "git-worktree" ||
    s === "isolated" ||
    s === "isolate"
  ) {
    return "worktree";
  }
  return "none";
}
