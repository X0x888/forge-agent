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
    assert.match(formatGitForPrompt(snap), /Parallel agent sessions/);
    assert.match(formatGitForPrompt(snap), /sibling worktrees/);
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

describe("detectProjectHints monorepo markers", () => {
  it("tags turbo / monorepo / nx from config files", async () => {
    const { detectProjectHints } = await import("../src/util/git-context.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hints-"));
    fs.writeFileSync(path.join(d, "package.json"), "{}");
    fs.writeFileSync(path.join(d, "turbo.json"), "{}");
    fs.writeFileSync(path.join(d, "pnpm-workspace.yaml"), "packages: []\n");
    const hints = detectProjectHints(d);
    assert.ok(hints.includes("turbo"));
    assert.ok(hints.includes("monorepo"));
    assert.ok(hints.includes("node"));
  });

  it("tags monorepo from package.json workspaces field", async () => {
    const { detectProjectHints } = await import("../src/util/git-context.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hints-ws-"));
    fs.writeFileSync(
      path.join(d, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    );
    const hints = detectProjectHints(d);
    assert.ok(hints.includes("monorepo"));
    assert.ok(hints.includes("node"));
  });
});
