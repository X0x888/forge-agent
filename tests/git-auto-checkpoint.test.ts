/**
 * Destructive git detection + auto-checkpoint gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDestructiveGitCommand } from "../src/agent/tools/bash.js";

describe("isDestructiveGitCommand", () => {
  it("flags hard reset / force push / clean -fd", () => {
    assert.equal(isDestructiveGitCommand("git reset --hard HEAD~1"), true);
    assert.equal(isDestructiveGitCommand("git clean -fd"), true);
    assert.equal(isDestructiveGitCommand("git clean -fxd"), true);
    assert.equal(isDestructiveGitCommand("git push --force origin main"), true);
    assert.equal(isDestructiveGitCommand("git push -f origin main"), true);
    assert.equal(isDestructiveGitCommand("git checkout -- ."), true);
    assert.equal(isDestructiveGitCommand("git branch -D feature"), true);
    assert.equal(isDestructiveGitCommand("git stash drop"), true);
  });

  it("allows safe git", () => {
    assert.equal(isDestructiveGitCommand("git status"), false);
    assert.equal(isDestructiveGitCommand("git diff"), false);
    assert.equal(isDestructiveGitCommand("git commit -m msg"), false);
    assert.equal(isDestructiveGitCommand("git push origin main"), false);
    assert.equal(isDestructiveGitCommand("git reset HEAD~1"), false); // mixed reset
    assert.equal(isDestructiveGitCommand("npm test"), false);
  });

  it("detects after && chains", () => {
    assert.equal(
      isDestructiveGitCommand("npm test && git reset --hard HEAD"),
      true,
    );
  });
});
