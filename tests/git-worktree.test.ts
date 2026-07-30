/**
 * Git linked worktree detection.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatGitBranchLine,
  formatGitForPrompt,
  type GitSnapshot,
} from "../src/util/git-context.js";

describe("git worktree formatting", () => {
  it("formatGitBranchLine marks linked worktrees", () => {
    const snap: GitSnapshot = {
      root: "/repo",
      branch: "feat/x",
      isWorktree: true,
      upstream: "origin/feat/x",
    };
    assert.match(formatGitBranchLine(snap), /worktree/);
    assert.match(formatGitForPrompt(snap), /linked worktree|worktree/);
  });

  it("omits worktree marker for main checkout", () => {
    const snap: GitSnapshot = {
      root: "/repo",
      branch: "main",
      isWorktree: false,
    };
    assert.doesNotMatch(formatGitBranchLine(snap), /worktree/);
  });
});
