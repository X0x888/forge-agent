/**
 * /checkpoint is the sit-down rewind key — never git stash apply.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  classifyLiveSlash,
  completeSlash,
  handleSlash,
} from "../src/commands/slash.js";
import { searchHelpCatalog } from "../src/commands/help-text.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import { armUlwCycle } from "../src/harness/ulw-cycle.js";
import { createSession } from "../src/session/session.js";
import { isDestructiveGitCommand } from "../src/agent/tools/bash.js";
import { createSafetyCheckpoint } from "../src/util/git-checkpoint.js";
import {
  formatCheckpointCard,
  parseCheckpointArg,
  resolveCheckpointSha,
  runCheckpoint,
} from "../src/tui/checkpoint-card.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

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

describe("/checkpoint card", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevCeiling: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ckpt-cmd-"));
    prevHome = process.env.FORGE_HOME;
    prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.FORGE_HOME = path.join(tmp, "home");
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(tmp);
    fs.mkdirSync(process.env.FORGE_HOME, { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  function sess(cwd = tmp) {
    const session = createSession({ cwd, provider: "xai", model: "grok-4" });
    const config = { ...DEFAULT_CONFIG, workspace: cwd };
    return { session, config };
  }

  it("parseCheckpointArg maps peek / snap / restore", () => {
    assert.deepEqual(parseCheckpointArg(""), { verb: "peek", sha: undefined });
    assert.deepEqual(parseCheckpointArg("status"), { verb: "peek", sha: undefined });
    assert.deepEqual(parseCheckpointArg("snap"), { verb: "snap" });
    assert.deepEqual(parseCheckpointArg("create"), { verb: "snap" });
    assert.deepEqual(parseCheckpointArg("restore"), {
      verb: "restore",
      sha: undefined,
    });
    assert.deepEqual(parseCheckpointArg("apply abcdef1"), {
      verb: "restore",
      sha: "abcdef1",
    });
    assert.equal(parseCheckpointArg("deadbeef").verb, "restore");
    assert.equal(parseCheckpointArg("help").verb, "help");
  });

  it("designed empty is none + Next /checkpoint snap", () => {
    const out = formatCheckpointCard({
      kind: "none",
      next: ["/checkpoint snap"],
      color: false,
    });
    assert.match(out, /checkpoint {2}· {2}none/);
    assert.match(out, /Next {2}\/checkpoint snap/);
    assert.doesNotMatch(out, /git stash apply/);
  });

  it("live: peek is readonly, snap/restore are control", () => {
    assert.equal(classifyLiveSlash("/checkpoint"), "readonly");
    assert.equal(classifyLiveSlash("/checkpoint status"), "readonly");
    assert.equal(classifyLiveSlash("/checkpoint snap"), "control");
    assert.equal(classifyLiveSlash("/checkpoint restore"), "control");
    assert.equal(classifyLiveSlash("/snap restore"), "control");
  });

  it("Tab completes snap and restore", () => {
    const hits = completeSlash("/checkpoint s");
    assert.ok(hits.some((h) => h.includes("snap")));
    const rest = completeSlash("/checkpoint r");
    assert.ok(rest.some((h) => h.includes("restore")));
  });

  it("help finds checkpoint from stash", () => {
    const hits = searchHelpCatalog("stash");
    assert.ok(hits.some((h) => h.command === "/checkpoint"));
  });

  it("bare /checkpoint peeks none when no sha", async () => {
    const { session, config } = sess();
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/checkpoint", { session, config, hooks });
    assert.equal(r.handled, true);
    const out = strip(String(r.output || ""));
    assert.match(out, /checkpoint {2}· {2}none/);
    assert.match(out, /Next {2}\/checkpoint snap/);
    assert.doesNotMatch(out, /git stash apply/);
  });

  it("restore uses ulw.checkpointSha when meta is empty", async () => {
    initRepo(tmp);
    firstCommit(tmp);
    fs.writeFileSync(path.join(tmp, "wip.ts"), "a\n");
    const snap = createSafetyCheckpoint(tmp);
    assert.ok(snap.sha);

    const { session, config } = sess();
    armUlwCycle(session.meta.id, "test checkpoint restore", {
      cycle: 1,
      cwd: tmp,
      skipCheckpoint: true,
    });
    const ulwPath = path.join(
      process.env.FORGE_HOME!,
      "sessions",
      session.meta.id,
      "ulw.json",
    );
    const ulw = JSON.parse(fs.readFileSync(ulwPath, "utf8")) as {
      checkpointSha?: string;
    };
    ulw.checkpointSha = snap.sha;
    fs.writeFileSync(ulwPath, JSON.stringify(ulw));

    assert.equal(session.meta.lastCheckpoint, undefined);
    assert.equal(resolveCheckpointSha(session), snap.sha);

    fs.writeFileSync(path.join(tmp, "wip.ts"), "b\n");
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/checkpoint restore", {
      session,
      config,
      hooks,
    });
    assert.equal(r.handled, true);
    const out = strip(String(r.output || ""));
    assert.match(out, /checkpoint {2}· {2}restored/);
    assert.match(out, /Next {2}\/diff/);
    assert.doesNotMatch(out, /git stash apply/);
    assert.equal(fs.readFileSync(path.join(tmp, "wip.ts"), "utf8"), "a\n");
  });

  it("snap then restore rewinds an untracked file", async () => {
    initRepo(tmp);
    firstCommit(tmp);
    fs.writeFileSync(path.join(tmp, "fresh.ts"), "one\n");
    const { session, config } = sess();
    const hooks = new HookRunner(config, tmp);
    const snap = await handleSlash("/checkpoint snap", {
      session,
      config,
      hooks,
    });
    const snapOut = strip(String(snap.output || ""));
    assert.match(snapOut, /checkpoint {2}· {2}/);
    assert.match(snapOut, /Next {2}\/checkpoint restore/);
    assert.ok(session.meta.lastCheckpoint);

    fs.writeFileSync(path.join(tmp, "fresh.ts"), "two\n");
    const restored = await handleSlash("/checkpoint restore", {
      session,
      config,
      hooks,
    });
    const out = strip(String(restored.output || ""));
    assert.match(out, /restored/);
    assert.equal(fs.readFileSync(path.join(tmp, "fresh.ts"), "utf8"), "one\n");
  });

  it("plan mode refuses restore", () => {
    const { session, config } = sess();
    const r = runCheckpoint({
      session,
      config: { ...config, permissionMode: "plan" },
      arg: "restore",
      color: false,
      persist: false,
    });
    assert.equal(r.failed, true);
    assert.match(r.output, /checkpoint {2}· {2}plan/);
    assert.match(r.output, /Next {2}\/build/);
  });

  it("destructive-git detector still flags reset --hard", () => {
    assert.equal(isDestructiveGitCommand("git reset --hard HEAD"), true);
  });
});
