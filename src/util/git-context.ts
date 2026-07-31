import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export interface GitSnapshot {
  branch?: string;
  dirty?: boolean;
  remote?: string;
  root?: string;
  /** Commits ahead of upstream (if tracking) */
  ahead?: number;
  /** Commits behind upstream (if tracking) */
  behind?: number;
  /** Count of modified/staged/untracked from porcelain */
  changedFiles?: number;
  /** Upstream short name e.g. origin/main */
  upstream?: string;
  /**
   * True when this checkout is a linked git worktree (not the main worktree).
   * Experts running parallel agent sessions per worktree need this signal.
   */
  isWorktree?: boolean;
  /** Common git dir (absolute) when in a linked worktree. */
  commonDir?: string;
}

/** Argv-based git (no shell) — args are fixed literals from this module. */
function git(
  args: string[],
  cwd: string,
  timeout = 2000,
): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    }).trim();
  } catch {
    return null;
  }
}

/** Best-effort git summary for system prompt / banner (never throws). */
export function getGitSnapshot(cwd: string): GitSnapshot {
  try {
    const root = git(["rev-parse", "--show-toplevel"], cwd);
    if (!root) return {};
    const branch =
      git(["rev-parse", "--abbrev-ref", "HEAD"], root) || undefined;
    const status = git(["status", "--porcelain"], root, 3000) || "";
    const changedFiles = status
      ? status.split("\n").filter((l) => l.trim()).length
      : 0;
    const remote =
      git(["config", "--get", "remote.origin.url"], root) || undefined;

    let ahead: number | undefined;
    let behind: number | undefined;
    let upstream: string | undefined;
    const ab = git(
      ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
      root,
      3000,
    );
    if (ab) {
      // format: "<behind>\t<ahead>" when using upstream...HEAD left-right
      const parts = ab.split(/\s+/).map((x) => Number(x));
      if (parts.length >= 2 && parts.every((n) => !Number.isNaN(n))) {
        behind = parts[0];
        ahead = parts[1];
      }
    }
    upstream =
      git(
        [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ],
        root,
      ) || undefined;

    // Linked worktree detection (OpenCode-style multi-worktree hygiene)
    let isWorktree: boolean | undefined;
    let commonDir: string | undefined;
    try {
      const gitDir = git(["rev-parse", "--git-dir"], root);
      const common = git(["rev-parse", "--git-common-dir"], root);
      if (gitDir && common) {
        const absGit = path.resolve(root, gitDir);
        const absCommon = path.resolve(root, common);
        commonDir = absCommon;
        // Main worktree: git-dir === common-dir. Linked: separate git dir + shared common.
        isWorktree = absGit !== absCommon;
      }
    } catch {
      /* */
    }

    return {
      root,
      branch,
      dirty: changedFiles > 0,
      remote,
      ahead,
      behind,
      changedFiles,
      upstream,
      isWorktree,
      commonDir,
    };
  } catch {
    return {};
  }
}

export function formatGitForPrompt(snap: GitSnapshot): string {
  if (!snap.root) return "";
  const dirtyDetail =
    snap.dirty && snap.changedFiles
      ? ` (dirty, ${snap.changedFiles} file${snap.changedFiles === 1 ? "" : "s"})`
      : snap.dirty
        ? " (dirty)"
        : " (clean)";
  const track: string[] = [];
  if (snap.upstream) {
    if (snap.ahead) track.push(`ahead ${snap.ahead}`);
    if (snap.behind) track.push(`behind ${snap.behind}`);
  }
  const lines = [
    `Git root: ${snap.root}${snap.isWorktree ? " (linked worktree)" : ""}`,
    snap.branch
      ? `Branch: ${snap.branch}${dirtyDetail}${
          track.length ? ` · ${track.join(", ")}` : ""
        }${snap.upstream ? ` → ${snap.upstream}` : ""}${
          snap.isWorktree ? " · worktree" : ""
        }`
      : "",
    snap.remote ? `Remote: ${snap.remote}` : "",
    snap.isWorktree
      ? "Linked worktree: prefer edits here only; do not mutate sibling worktrees/checkouts. Parallel agent sessions are expected — keep commits/pushes scoped to this tree."
      : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Stable subset for the system prompt (message[0]). Branch/dirty/ahead counts
 * change between prompts — embedding them rewrites message[0] and invalidates
 * the provider's server-side prompt cache for the ENTIRE conversation (xAI
 * cached-input is ~4x cheaper; this was the biggest per-prompt token leak).
 * Volatile state is admitted mid-conversation instead (see context-admit.ts).
 */
export function formatGitStableForPrompt(snap: GitSnapshot): string {
  if (!snap.root) return "";
  return [
    `Git root: ${snap.root}`,
    snap.remote ? `Remote: ${snap.remote}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Volatile branch line for mid-conversation admission. Deliberately excludes
 * dirty/changedFiles counts — those churn on every edit and are noise.
 */
export function formatGitBranchLine(snap: GitSnapshot): string {
  if (!snap.root || !snap.branch) return "";
  const track: string[] = [];
  if (snap.upstream) {
    if (snap.ahead) track.push(`ahead ${snap.ahead}`);
    if (snap.behind) track.push(`behind ${snap.behind}`);
  }
  const wt = snap.isWorktree ? " · worktree" : "";
  return `Branch: ${snap.branch}${track.length ? ` · ${track.join(", ")}` : ""}${
    snap.upstream ? ` → ${snap.upstream}` : ""
  }${wt}`;
}

/** Quick project fingerprint for the banner / doctor. */
export function detectProjectHints(cwd: string): string[] {
  const hints: string[] = [];
  const checks: Array<[string, string]> = [
    ["package.json", "node"],
    ["pnpm-lock.yaml", "pnpm"],
    ["pnpm-workspace.yaml", "monorepo"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["turbo.json", "turbo"],
    ["nx.json", "nx"],
    ["Cargo.toml", "rust"],
    ["go.mod", "go"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["Pipfile", "python"],
    ["Gemfile", "ruby"],
    ["pom.xml", "java"],
    ["build.gradle", "java"],
    ["build.gradle.kts", "java"],
    ["Package.swift", "swift"],
    ["mix.exs", "elixir"],
    ["composer.json", "php"],
    ["CMakeLists.txt", "cmake"],
    ["Makefile", "make"],
    ["Dockerfile", "docker"],
    ["docker-compose.yml", "compose"],
    ["docker-compose.yaml", "compose"],
    ["tsconfig.json", "typescript"],
    [".github/workflows", "gha"],
  ];
  const seen = new Set<string>();
  for (const [file, label] of checks) {
    if (seen.has(label)) continue;
    if (fs.existsSync(path.join(cwd, file))) {
      hints.push(label);
      seen.add(label);
    }
  }
  // package.json workspaces field (npm/yarn/bun monorepos without pnpm-workspace.yaml)
  if (!seen.has("monorepo")) {
    try {
      const pkgPath = path.join(cwd, "package.json");
      if (fs.existsSync(pkgPath)) {
        const raw = fs.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw) as { workspaces?: unknown };
        const ws = pkg?.workspaces;
        const has =
          (Array.isArray(ws) && ws.length > 0) ||
          (ws &&
            typeof ws === "object" &&
            !Array.isArray(ws) &&
            Array.isArray((ws as { packages?: unknown }).packages) &&
            ((ws as { packages: unknown[] }).packages?.length || 0) > 0);
        if (has) {
          hints.push("monorepo");
          seen.add("monorepo");
        }
      }
    } catch {
      /* */
    }
  }
  return hints;
}
