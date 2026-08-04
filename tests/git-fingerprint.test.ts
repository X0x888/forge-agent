import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitDiffFingerprint } from "../src/util/git-context.js";

/**
 * Scaffold a usable git repo without `git init`.
 * Some sandboxes deny chmod on .git/config.lock, which makes `git init` fail
 * even though add/commit/diff work once the repo layout exists.
 */
function scaffoldGitRepo(dir: string): void {
  const gitDir = path.join(dir, ".git");
  fs.mkdirSync(path.join(gitDir, "objects"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(
    path.join(gitDir, "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n",
  );
  fs.writeFileSync(path.join(gitDir, "description"), "forge-fp-test\n");
}

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", args, {
    cwd: dir,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("gitDiffFingerprint", () => {
  it("returns empty outside a git repo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fp-nogit-"));
    try {
      // npm test may set TMPDIR inside this checkout — a broken gitdir stops
      // `rev-parse --show-toplevel` from walking up into the parent forge root.
      fs.writeFileSync(path.join(dir, ".git"), "gitdir: /nonexistent-forge-fp\n");
      // null (or "") — callers treat both as "no usable fingerprint".
      const fp = gitDiffFingerprint(dir);
      assert.ok(fp == null || fp === "", "outside git should not fingerprint");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes when tracked content is edited (bash-channel edits count)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fp-"));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      HOME: dir,
    };
    try {
      scaffoldGitRepo(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
      git(dir, ["add", "a.txt"], env);
      git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], env);
      const base = gitDiffFingerprint(dir);
      assert.ok(base.length > 0, "committed repo should fingerprint");
      fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
      const after = gitDiffFingerprint(dir);
      assert.notEqual(after, base, "content edit must change fingerprint");
      // Revert → same fingerprint (edit→revert churn detection).
      fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
      assert.equal(gitDiffFingerprint(dir), base);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes when a new untracked file appears", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fp-u-"));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      HOME: dir,
    };
    try {
      scaffoldGitRepo(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
      git(dir, ["add", "a.txt"], env);
      git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], env);
      const base = gitDiffFingerprint(dir);
      fs.writeFileSync(path.join(dir, "b.txt"), "new\n");
      const after = gitDiffFingerprint(dir);
      assert.notEqual(after, base, "untracked file must change fingerprint");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
