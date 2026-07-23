import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export interface GitSnapshot {
  branch?: string;
  dirty?: boolean;
  remote?: string;
  root?: string;
}

/** Best-effort git summary for system prompt (never throws). */
export function getGitSnapshot(cwd: string): GitSnapshot {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    const status = execSync("git status --porcelain", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    let remote: string | undefined;
    try {
      remote = execSync("git config --get remote.origin.url", {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).trim();
    } catch {
      /* no remote */
    }
    return {
      root,
      branch,
      dirty: status.trim().length > 0,
      remote,
    };
  } catch {
    return {};
  }
}

export function formatGitForPrompt(snap: GitSnapshot): string {
  if (!snap.root) return "";
  const lines = [
    `Git root: ${snap.root}`,
    snap.branch ? `Branch: ${snap.branch}${snap.dirty ? " (dirty)" : " (clean)"}` : "",
    snap.remote ? `Remote: ${snap.remote}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Quick project fingerprint for the banner / doctor. */
export function detectProjectHints(cwd: string): string[] {
  const hints: string[] = [];
  const checks: Array<[string, string]> = [
    ["package.json", "node"],
    ["Cargo.toml", "rust"],
    ["go.mod", "go"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["Gemfile", "ruby"],
    ["pom.xml", "java"],
    ["build.gradle", "java"],
    ["Package.swift", "swift"],
  ];
  for (const [file, label] of checks) {
    if (fs.existsSync(path.join(cwd, file))) hints.push(label);
  }
  return [...new Set(hints)];
}
