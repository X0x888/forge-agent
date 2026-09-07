import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitIsClean } from "../src/util/git-context.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repo(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-git-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "initial\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["-c", "user.name=Forge Test", "-c", "user.email=forge@test", "commit", "-q", "-m", "initial"]);
  return root;
}

describe("gitIsClean", () => {
  it("distinguishes a clean tree from staged and unstaged tracked changes", (t) => {
    const root = repo(t);
    assert.equal(gitIsClean(root), true);
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    assert.equal(gitIsClean(root), false);
    git(root, ["add", "tracked.txt"]);
    assert.equal(gitIsClean(root), false);
  });

  it("checks the repository root when the workspace is a subdirectory", (t) => {
    const root = repo(t);
    const workspace = path.join(root, "packages", "app");
    fs.mkdirSync(workspace, { recursive: true });
    assert.equal(gitIsClean(workspace), true);
    fs.writeFileSync(path.join(root, "tracked.txt"), "change outside workspace\n");
    assert.equal(gitIsClean(workspace), false);
  });

  it("detects untracked files despite status configuration and unusual filenames", (t) => {
    const root = repo(t);
    git(root, ["config", "status.showUntrackedFiles", "no"]);
    fs.writeFileSync(path.join(root, "new\nfile.txt"), "untracked\n");
    assert.equal(gitIsClean(root), false);
  });

  it("does not treat ignored build output as a dirty tree", (t) => {
    const root = repo(t);
    fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "\noutput/\n");
    fs.mkdirSync(path.join(root, "output"));
    fs.writeFileSync(path.join(root, "output", "build.js"), "generated\n");
    assert.equal(gitIsClean(root), true);
  });

  it("returns unknown when Git status fails after locating the root", (t) => {
    const root = repo(t);
    fs.writeFileSync(path.join(root, ".git", "index"), "invalid index\n");
    assert.equal(gitIsClean(root), null);
  });

  it("returns unknown without a working tree or accessible directory", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-git-context-bare-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    git(root, ["init", "--bare", "-q"]);
    assert.equal(gitIsClean(root), null);
    assert.equal(gitIsClean(path.join(root, "missing")), null);
  });
});
