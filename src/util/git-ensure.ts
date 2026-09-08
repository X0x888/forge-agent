/**
 * Initialize a git repo when a software project needs one.
 *
 * ULW commits, worktree isolation and checkpoints all require a repository.
 * A new project (package.json / src / manifest, or an armed ULW run) that
 * is not already inside a repo gets `git init -b main` and a starter
 * `.gitignore`. Never inits $HOME, `/`, or the OS temp dir itself; never
 * nests a repo inside another. Kill-switch: FORGE_AUTO_GIT=0.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { isFalsy } from "./bool.js";
import { forgeHome } from "./fs.js";
import { createChildEnv } from "../agent/tools/env-policy.js";
import { findGitRoot } from "../agent/worktree.js";

export type EnsureGitReason = "ulw" | "commit" | "project";

export interface EnsureGitResult {
  inited: boolean;
  root?: string;
  gitignoreWritten?: boolean;
  skipped?: string;
}

const SOFTWARE_MARKERS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Pipfile",
  "Gemfile",
  "composer.json",
  "CMakeLists.txt",
  "Makefile",
  "mix.exs",
  "Package.swift",
  "pubspec.yaml",
  "deno.json",
  "tsconfig.json",
  "manifest.json",
];

const SOFTWARE_DIRS = ["src", "lib", "app", "extension", "cmd", "pkg"];

export function autoGitEnabled(): boolean {
  return !isFalsy(process.env.FORGE_AUTO_GIT ?? "1");
}

function git(args: string[], cwd: string, timeoutMs = 15_000): string {
  const raw = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: createChildEnv(),
  });
  return raw.trimEnd();
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Locations where `git init` would surprise the user or the OS. */
export function isUnsafeGitInitCwd(cwd: string): boolean {
  let abs: string;
  try {
    abs = real(cwd);
  } catch {
    return true;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return true;
  }
  if (!st.isDirectory()) return true;
  const home = real(os.homedir());
  if (abs === home) return true;
  if (abs === path.parse(abs).root) return true;
  const tmp = real(os.tmpdir());
  if (abs === tmp) return true;
  return false;
}

export function projectLooksLikeSoftware(cwd: string): boolean {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(cwd);
  } catch {
    return false;
  }
  const names = new Set(entries.map((e) => e.toLowerCase()));
  for (const m of SOFTWARE_MARKERS) {
    if (names.has(m.toLowerCase())) return true;
  }
  for (const d of SOFTWARE_DIRS) {
    if (names.has(d)) return true;
  }
  // A handful of source files with no marker still wants version control.
  const srcExt = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|swift|java|kt|rb|php|cs|c|cc|cpp|h|hpp|vue|svelte)$/i;
  let n = 0;
  for (const e of entries) {
    if (srcExt.test(e)) {
      n += 1;
      if (n >= 3) return true;
    }
  }
  return false;
}

/** Starter ignore list. Only written when the tree has no `.gitignore`. */
export function defaultGitignore(cwd: string): string {
  const lines = [
    ".DS_Store",
    "*.log",
    ".env",
    ".env.*",
    "!.env.example",
    "node_modules/",
    "dist/",
    "build/",
    "coverage/",
    ".tmp/",
    ".forge/chrome-look*",
    ".forge/tmp/",
    "test-results/",
    "playwright-report/",
    "blob-report/",
    ".playwright-mcp/",
  ];
  try {
    const names = new Set(fs.readdirSync(cwd).map((e) => e.toLowerCase()));
    if (names.has("cargo.toml")) lines.push("/target/");
    if (names.has("go.mod")) lines.push("vendor/");
    if (names.has("pyproject.toml") || names.has("requirements.txt")) {
      lines.push(".venv/", "venv/", "__pycache__/", "*.pyc");
    }
  } catch {
    /* keep the common set */
  }
  return `${lines.join("\n")}\n`;
}

export function shouldEnsureGitRepo(
  cwd: string,
  reason: EnsureGitReason = "project",
): boolean {
  if (!autoGitEnabled()) return false;
  if (isUnsafeGitInitCwd(cwd)) return false;
  if (findGitRoot(cwd)) return false;
  if (reason === "ulw" || reason === "commit") return true;
  return projectLooksLikeSoftware(cwd);
}

function emptyTemplateDir(): string {
  const dir = path.join(forgeHome(), "tmp", "git-template-empty");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * `git init -b main` when the workspace needs a repo. Writes `.gitignore`
 * only when missing. Fail-open: a sandbox that denies chmod on `.git` returns
 * `skipped` instead of throwing.
 */
export function ensureGitRepo(
  cwd: string,
  opts?: { reason?: EnsureGitReason },
): EnsureGitResult {
  const reason = opts?.reason ?? "project";
  if (!autoGitEnabled()) {
    return { inited: false, skipped: "FORGE_AUTO_GIT=0" };
  }
  const abs = path.resolve(cwd);
  if (isUnsafeGitInitCwd(abs)) {
    return { inited: false, skipped: "unsafe cwd for git init" };
  }
  const existing = findGitRoot(abs);
  if (existing) {
    return { inited: false, root: existing, skipped: "already a git repository" };
  }
  if (reason === "project" && !projectLooksLikeSoftware(abs)) {
    return { inited: false, skipped: "not a software project" };
  }

  const template = emptyTemplateDir();
  try {
    try {
      git(["init", "-b", "main", "--template", template], abs);
    } catch {
      git(["init", "--template", template], abs);
      try {
        git(["symbolic-ref", "HEAD", "refs/heads/main"], abs);
      } catch {
        /* default branch name is whatever git chose */
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      inited: false,
      skipped: `git init failed: ${msg.replace(/\s+/g, " ").trim().slice(0, 200)}`,
    };
  }

  const root = findGitRoot(abs) ?? abs;
  let gitignoreWritten = false;
  const gi = path.join(abs, ".gitignore");
  if (!fs.existsSync(gi)) {
    try {
      fs.writeFileSync(gi, defaultGitignore(abs), { encoding: "utf8" });
      gitignoreWritten = true;
    } catch {
      /* commit can still proceed */
    }
  }
  return { inited: true, root, gitignoreWritten };
}
