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

    return {
      root,
      branch,
      dirty: changedFiles > 0,
      remote,
      ahead,
      behind,
      changedFiles,
      upstream,
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
    `Git root: ${snap.root}`,
    snap.branch
      ? `Branch: ${snap.branch}${dirtyDetail}${
          track.length ? ` · ${track.join(", ")}` : ""
        }${snap.upstream ? ` → ${snap.upstream}` : ""}`
      : "",
    snap.remote ? `Remote: ${snap.remote}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Quick project fingerprint for the banner / doctor. */
export function detectProjectHints(cwd: string): string[] {
  const hints: string[] = [];
  const checks: Array<[string, string]> = [
    ["package.json", "node"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
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
  return hints;
}
