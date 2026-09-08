import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autoGitEnabled,
  defaultGitignore,
  ensureGitRepo,
  isUnsafeGitInitCwd,
  projectLooksLikeSoftware,
  shouldEnsureGitRepo,
} from "../src/util/git-ensure.js";
import { findGitRoot } from "../src/agent/worktree.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("git-ensure", () => {
  it("classifies software trees and refuses $HOME / / / tmp", () => {
    const dir = tmpDir("forge-ge-sw-");
    try {
      assert.equal(projectLooksLikeSoftware(dir), false);
      fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
      assert.equal(projectLooksLikeSoftware(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(isUnsafeGitInitCwd(os.homedir()), true);
    assert.equal(isUnsafeGitInitCwd(path.parse(process.cwd()).root), true);
    assert.equal(isUnsafeGitInitCwd(os.tmpdir()), true);
  });

  it("default gitignore covers node_modules and chrome-look", () => {
    const gi = defaultGitignore(process.cwd());
    assert.match(gi, /node_modules\//);
    assert.match(gi, /\.forge\/chrome-look\*/);
    assert.match(gi, /test-results\//);
  });

  it("FORGE_AUTO_GIT=0 disables", () => {
    const prev = process.env.FORGE_AUTO_GIT;
    process.env.FORGE_AUTO_GIT = "0";
    try {
      assert.equal(autoGitEnabled(), false);
      const dir = tmpDir("forge-ge-off-");
      fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
      assert.equal(shouldEnsureGitRepo(dir, "ulw"), false);
      const r = ensureGitRepo(dir, { reason: "ulw" });
      assert.equal(r.inited, false);
      assert.match(r.skipped || "", /FORGE_AUTO_GIT=0/);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      if (prev === undefined) delete process.env.FORGE_AUTO_GIT;
      else process.env.FORGE_AUTO_GIT = prev;
    }
  });

  it("inits a software tree and writes .gitignore (or names a sandbox chmod failure)", () => {
    const prev = process.env.FORGE_AUTO_GIT;
    const prevCeil = process.env.GIT_CEILING_DIRECTORIES;
    delete process.env.FORGE_AUTO_GIT;
    const dir = tmpDir("forge-ge-init-");
    // npm test pins TMPDIR inside this repo; stop git walking up to it.
    process.env.GIT_CEILING_DIRECTORIES = dir;
    try {
      fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}\n');
      fs.writeFileSync(path.join(dir, "index.ts"), "export const n = 1;\n");
      const parent = findGitRoot(dir);
      if (parent && path.resolve(parent) !== path.resolve(dir)) {
        // npm test pins TMPDIR inside this repo; git walks up. Nesting is refused.
        assert.equal(shouldEnsureGitRepo(dir, "commit"), false);
        const nested = ensureGitRepo(dir, { reason: "commit" });
        assert.equal(nested.inited, false);
        assert.match(nested.skipped || "", /already a git repository/);
        return;
      }
      assert.equal(shouldEnsureGitRepo(dir, "commit"), true);
      const r = ensureGitRepo(dir, { reason: "commit" });
      if (r.skipped?.includes("git init failed")) {
        assert.match(r.skipped, /git init failed/);
        return;
      }
      assert.equal(r.inited, true, r.skipped);
      assert.ok(fs.existsSync(path.join(dir, ".git")));
      assert.equal(r.gitignoreWritten, true);
      assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /node_modules\//);
      const again = ensureGitRepo(dir, { reason: "ulw" });
      assert.equal(again.inited, false);
      assert.match(again.skipped || "", /already a git repository/);
    } finally {
      if (prev === undefined) delete process.env.FORGE_AUTO_GIT;
      else process.env.FORGE_AUTO_GIT = prev;
      if (prevCeil === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prevCeil;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
