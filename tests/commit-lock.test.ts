import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isGitCommitCommand, ulwGitCommitDenied } from "../src/harness/cycle/commit-lock.js";
import { armCycle } from "../src/harness/cycle/index.js";

describe("ulw commit lock", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevLock: string | undefined;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-commit-lock-"));
    prevHome = process.env.FORGE_HOME;
    prevLock = process.env.FORGE_ULW_DRIVER_COMMIT;
    process.env.FORGE_HOME = home;
    delete process.env.FORGE_ULW_DRIVER_COMMIT;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevLock === undefined) delete process.env.FORGE_ULW_DRIVER_COMMIT;
    else process.env.FORGE_ULW_DRIVER_COMMIT = prevLock;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("matches git commit and not commit-tree / log", () => {
    assert.equal(isGitCommitCommand("git commit -am 'x'"), true);
    assert.equal(isGitCommitCommand("git -C /tmp/repo commit -m x"), true);
    assert.equal(isGitCommitCommand("git commit-tree HEAD^{tree}"), false);
    assert.equal(isGitCommitCommand("git log --oneline"), false);
    assert.equal(isGitCommitCommand("echo git commit"), false);
  });

  it("denies while ULW is armed; FORGE_ULW_DRIVER_COMMIT=0 restores allow", () => {
    const sid = "lock-armed";
    armCycle({ sessionId: sid, mandate: "ship x", cwd: home });
    assert.match(ulwGitCommitDenied(sid) ?? "", /ulw-commit/);
    process.env.FORGE_ULW_DRIVER_COMMIT = "0";
    assert.equal(ulwGitCommitDenied(sid), null);
  });

  it("allows when the session is not an armed ULW", () => {
    assert.equal(ulwGitCommitDenied("never-armed"), null);
    assert.equal(ulwGitCommitDenied(undefined), null);
  });
});
