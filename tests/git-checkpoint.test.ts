/**
 * Safety snapshot: untracked in, secrets out, restore overwrites (not stash apply).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  applySafetyCheckpoint,
  createSafetyCheckpoint,
} from "../src/util/git-checkpoint.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

/** Minimal repo without `git init` — sandbox chmod on config.lock fails. */
function initRepo(root: string): void {
  fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".git", "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n" +
      "[user]\n\tname = Forge Test\n\temail = forge@test\n",
  );
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
}

function firstCommit(root: string): void {
  fs.writeFileSync(path.join(root, "README.md"), "base\n");
  git(["add", "README.md"], root);
  git(
    [
      "-c",
      "user.name=Forge Test",
      "-c",
      "user.email=forge@test",
      "commit",
      "-m",
      "init",
    ],
    root,
  );
}

describe("createSafetyCheckpoint / applySafetyCheckpoint", () => {
  let tmp: string;
  let prevCeiling: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ckpt-git-"));
    prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
    // TMPDIR is inside the project git tree — do not walk up to it.
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(tmp);
  });

  afterEach(() => {
    if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("is not a repo", () => {
    const r = createSafetyCheckpoint(tmp);
    assert.equal(r.ok, false);
    assert.match(r.detail || "", /not a git repository/i);
  });

  it("clean tree is designed empty", () => {
    initRepo(tmp);
    firstCommit(tmp);
    const r = createSafetyCheckpoint(tmp);
    assert.equal(r.ok, true);
    assert.equal(r.clean, true);
    assert.ok(!r.sha);
  });

  it("snapshots an untracked file that git stash create misses", () => {
    initRepo(tmp);
    firstCommit(tmp);
    const untracked = path.join(tmp, "src", "new.ts");
    fs.mkdirSync(path.dirname(untracked), { recursive: true });
    fs.writeFileSync(untracked, "export const n = 1;\n");

    const stash = git(["stash", "create"], tmp);
    assert.equal(stash, "", "stash create ignores untracked");

    const snap = createSafetyCheckpoint(tmp, { label: "untracked" });
    assert.equal(snap.ok, true);
    assert.ok(snap.sha);
    assert.ok((snap.dirtyPaths ?? 0) >= 1);

    fs.unlinkSync(untracked);
    assert.equal(fs.existsSync(untracked), false);

    const applied = applySafetyCheckpoint(tmp, snap.sha!);
    assert.equal(applied.ok, true);
    assert.equal(fs.readFileSync(untracked, "utf8"), "export const n = 1;\n");
  });

  it("restore overwrites a later edit (stash apply would 3-way)", () => {
    initRepo(tmp);
    firstCommit(tmp);
    const file = path.join(tmp, "README.md");
    fs.writeFileSync(file, "snap\n");
    const snap = createSafetyCheckpoint(tmp);
    assert.ok(snap.sha);

    fs.writeFileSync(file, "later\n");
    const applied = applySafetyCheckpoint(tmp, snap.sha!);
    assert.equal(applied.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "snap\n");
  });

  it("excludes .env from the snapshot tree", () => {
    initRepo(tmp);
    firstCommit(tmp);
    fs.writeFileSync(path.join(tmp, ".env"), "SECRET=1\n");
    fs.writeFileSync(path.join(tmp, "keep.ts"), "export {}\n");
    const snap = createSafetyCheckpoint(tmp);
    assert.ok(snap.sha);
    const names = git(["ls-tree", "-r", "--name-only", snap.sha!], tmp);
    assert.ok(!names.split("\n").includes(".env"));
    assert.ok(names.split("\n").includes("keep.ts"));
  });

  it("host GIT_DIR cannot redirect the snapshot to a decoy repo", () => {
    initRepo(tmp);
    firstCommit(tmp);
    const dirty = path.join(tmp, "keep.ts");
    fs.writeFileSync(dirty, "export const n = 1;\n");

    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ckpt-decoy-"));
    initRepo(decoy);
    firstCommit(decoy);
    const prevGitDir = process.env.GIT_DIR;
    const prevIndex = process.env.GIT_INDEX_FILE;
    process.env.GIT_DIR = path.join(decoy, ".git");
    process.env.GIT_INDEX_FILE = path.join(decoy, "evil.idx");
    let sha = "";
    try {
      const snap = createSafetyCheckpoint(tmp, { label: "gitdir" });
      assert.equal(snap.ok, true, snap.detail);
      assert.ok(snap.sha, "workspace dirty file must be snapshotted, not the clean decoy");
      assert.ok((snap.dirtyPaths ?? 0) >= 1);
      sha = snap.sha!;
    } finally {
      if (prevGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prevGitDir;
      if (prevIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = prevIndex;
      try {
        fs.rmSync(decoy, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
    const names = git(["ls-tree", "-r", "--name-only", sha], tmp);
    assert.ok(names.split("\n").includes("keep.ts"));
  });

  it("apply of a missing sha fails closed", () => {
    initRepo(tmp);
    firstCommit(tmp);
    const r = applySafetyCheckpoint(tmp, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    assert.equal(r.ok, false);
    assert.match(r.detail || "", /unknown sha|not a commit/i);
  });
});
