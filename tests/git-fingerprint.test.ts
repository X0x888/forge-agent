import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitDiffFingerprint } from "../src/util/git-context.js";

function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-fp-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(["add", "a.txt"]);
  git(["commit", "-qm", "init"]);
  return dir;
}

describe("gitDiffFingerprint", () => {
  it("moves on edits, returns to the same value on revert (churn signal)", () => {
    const dir = gitRepo();
    const clean = gitDiffFingerprint(dir);
    assert.ok(clean, "fingerprint inside a repo");

    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    const edited = gitDiffFingerprint(dir);
    assert.notEqual(edited, clean);

    execFileSync("git", ["checkout", "--", "a.txt"], { cwd: dir });
    assert.equal(
      gitDiffFingerprint(dir),
      clean,
      "revert to HEAD must restore the earlier fingerprint",
    );
  });

  it("moves for untracked files and their size changes", () => {
    const dir = gitRepo();
    const before = gitDiffFingerprint(dir);
    fs.writeFileSync(path.join(dir, "new.txt"), "x");
    const created = gitDiffFingerprint(dir);
    assert.notEqual(created, before);
    fs.writeFileSync(path.join(dir, "new.txt"), "xxxxxx");
    assert.notEqual(
      gitDiffFingerprint(dir),
      created,
      "same-path untracked content change still moves the fingerprint",
    );
  });

  it("is null outside a git repo", () => {
    // npm test runs with TMPDIR inside this repo — a plain os.tmpdir() dir
    // would walk up into the repo's .git. Use the real system temp root.
    const base = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
    const dir = fs.mkdtempSync(path.join(base, "forge-fp-nogit-"));
    assert.equal(gitDiffFingerprint(dir), null);
  });
});
