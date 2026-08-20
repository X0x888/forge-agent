import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseCommitArg,
  formatCommitVerdict,
  formatCommitCard,
  draftCommitSubject,
  isUnmergedPorcelain,
  runCommit,
} from "../src/tui/commit-card.js";
import { createSession } from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import {
  classifyLiveSlash,
  completeSlash,
  handleSlash,
} from "../src/commands/slash.js";
import { resolveHeadlessSlashPrompt } from "../src/commands/headless-slash.js";
import { HookRunner } from "../src/harness/hooks.js";
import { searchHelpCatalog } from "../src/commands/help-text.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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

describe("/commit", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-commit-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = path.join(tmp, "home");
    fs.mkdirSync(process.env.FORGE_HOME, { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
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

  it("parseCommitArg maps do / staged / draft / help", () => {
    assert.deepEqual(parseCommitArg(""), {
      doCommit: false,
      stagedOnly: false,
      wantDraft: false,
      help: false,
    });
    assert.equal(parseCommitArg("do").doCommit, true);
    assert.equal(parseCommitArg("staged do").stagedOnly, true);
    assert.equal(parseCommitArg("draft").wantDraft, true);
    assert.equal(parseCommitArg("--help").help, true);
  });

  it("designed empty is nothing to commit — not commit · ok", () => {
    const card = strip(
      formatCommitCard({
        kind: "empty",
        note: "Working tree clean.",
        next: ["/diff", "/status"],
        color: false,
      }),
    );
    assert.match(card, /^commit  ·  nothing to commit/);
    assert.doesNotMatch(card, /commit\s+·\s+ok/);
    assert.match(card, /Next  \/diff/);
  });

  it("draftCommitSubject prefers a real title", () => {
    assert.equal(
      draftCommitSubject({ title: "Ship the key", files: ["a.ts"] }),
      "Ship the key",
    );
    assert.equal(
      draftCommitSubject({ title: "untitled", files: ["src/foo.ts"] }),
      "Update foo.ts",
    );
    assert.equal(
      draftCommitSubject({ files: ["a.ts", "b.ts", "c.ts"] }),
      "Update a.ts and 2 more",
    );
  });

  it("peek / do / draft live classes", () => {
    assert.equal(classifyLiveSlash("/commit"), "readonly");
    assert.equal(classifyLiveSlash("/commit staged"), "readonly");
    assert.equal(classifyLiveSlash("/commit do"), "control");
    assert.equal(classifyLiveSlash("/commit staged do"), "control");
    assert.equal(classifyLiveSlash("/commit draft"), "idle-only");
  });

  it("Tab completes do / staged / draft", () => {
    const hits = completeSlash("/commit d");
    assert.ok(hits.includes("/commit do"));
    assert.ok(hits.includes("/commit draft"));
  });

  it("help search finds the command", () => {
    const hits = searchHelpCatalog("/commit");
    assert.ok(hits.some((h) => h.command === "/commit"));
  });

  it("slash not-a-repo is failed and has no model turn", async () => {
    const missing = path.join(tmp, "no-such-work-tree");
    const { session, config } = sess(missing);
    const hooks = new HookRunner(config, missing);
    const r = await handleSlash("/commit", { session, config, hooks });
    assert.equal(r.handled, true);
    assert.equal(r.failed, true);
    assert.equal(r.forwardPrompt, undefined);
    assert.match(strip(String(r.output || "")), /^commit  ·  not a repo/);
  });

  it("plan /commit do is failed with Next /build", async () => {
    const { session } = sess();
    const config = { ...DEFAULT_CONFIG, workspace: tmp, permissionMode: "plan" as const };
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/commit do", { session, config, hooks });
    assert.equal(r.forwardPrompt, undefined);
    assert.equal(r.failed, true);
    const out = strip(String(r.output || ""));
    assert.match(out, /^commit  ·  plan/);
    assert.match(out, /Next  \/build/);
  });

  it("nested git: peek then do creates the commit", () => {
    const root = path.join(tmp, "repo");
    initRepo(root);
    fs.writeFileSync(path.join(root, "README.md"), "hi\n");
    git(["add", "README.md"], root);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], root);
    fs.writeFileSync(path.join(root, "ship.ts"), "export const n = 1;\n");
    const { session, config } = sess(root);
    session.meta.title = "Ship the commit key";
    const peek = runCommit({
      session,
      config,
      doCommit: false,
      color: false,
    });
    assert.equal(peek.failed, false);
    const peekOut = strip(peek.output);
    assert.match(peekOut, /^commit  ·  1 file/);
    assert.match(peekOut, /Ship the commit key/);
    assert.match(peekOut, /Next  \/commit do/);
    assert.doesNotMatch(peekOut, /commit\s+·\s+ok/);

    const created = runCommit({
      session,
      config,
      doCommit: true,
      color: false,
    });
    assert.equal(created.failed, false);
    assert.ok(created.sha);
    const ok = strip(created.output);
    assert.match(ok, /^commit  ·  ok/);
    assert.match(ok, /Next  \/last/);
    const log = git(["log", "-1", "--pretty=%s"], root);
    assert.equal(log, "Ship the commit key");
    assert.match(git(["status", "--porcelain"], root), /^$/);

    const empty = runCommit({
      session,
      config,
      doCommit: false,
      color: false,
    });
    assert.equal(empty.failed, false);
    assert.match(strip(empty.output), /^commit  ·  nothing to commit/);
  });

  it("stale verify names /verify on the peek", () => {
    const root = path.join(tmp, "stale");
    initRepo(root);
    fs.writeFileSync(path.join(root, "a.txt"), "x\n");
    git(["add", "a.txt"], root);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "i"], root);
    fs.writeFileSync(path.join(root, "a.txt"), "y\n");
    const { session, config } = sess(root);
    session.meta.editCount = 2;
    session.meta.lastVerificationCommand = "npm test";
    session.meta.lastVerificationAt = "2026-04-10T12:00:00.000Z";
    session.meta.lastEditAt = "2026-04-10T12:10:00.000Z";
    const peek = runCommit({ session, config, color: false });
    const out = strip(peek.output);
    assert.match(out, /stale/i);
    assert.match(out, /npm test/);
    assert.match(out, /Next  \/verify/);
    assert.match(out, /\/commit do/);
  });

  it("headless forge run /commit fails closed outside a repo", async () => {
    const { session, config } = sess(path.join(tmp, "missing-headless"));
    const hooks = new HookRunner(config, config.workspace);
    const r = await resolveHeadlessSlashPrompt({
      prompt: "/commit",
      session,
      config,
      hooks,
    });
    assert.equal(r.kind, "done");
    if (r.kind === "done") {
      assert.equal(r.failed, true);
      assert.match(strip(r.output), /commit  ·  not a repo/);
    }
  });

  it("isUnmergedPorcelain matches conflict XY only", () => {
    assert.equal(isUnmergedPorcelain("UU conflict.ts"), true);
    assert.equal(isUnmergedPorcelain("AA both-added.ts"), true);
    assert.equal(isUnmergedPorcelain("DU deleted-ours.ts"), true);
    assert.equal(isUnmergedPorcelain("M  staged.ts"), false);
    assert.equal(isUnmergedPorcelain(" M unstaged.ts"), false);
    assert.equal(isUnmergedPorcelain("?? new.ts"), false);
    assert.equal(isUnmergedPorcelain("R  old.ts -> new.ts"), false);
  });

  it("does not commit a staged .env the card skipped", () => {
    const root = path.join(tmp, "secret");
    initRepo(root);
    fs.writeFileSync(path.join(root, "README.md"), "hi\n");
    git(["add", "README.md"], root);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], root);
    fs.writeFileSync(path.join(root, "ship.ts"), "export const n = 1;\n");
    fs.writeFileSync(path.join(root, ".env"), "SECRET=do-not-commit\n");
    git(["add", "ship.ts", ".env"], root);
    const { session, config } = sess(root);
    const peek = runCommit({ session, config, color: false });
    const peekOut = strip(peek.output);
    assert.match(peekOut, /skipped\s+\.env/);
    assert.doesNotMatch(peekOut, /· \.env$/m);
    const created = runCommit({ session, config, doCommit: true, color: false });
    assert.equal(created.failed, false);
    const names = git(["show", "--pretty=format:", "--name-only", "HEAD"], root);
    assert.match(names, /ship\.ts/);
    assert.doesNotMatch(names, /\.env/);
    const still = git(["status", "--porcelain", "-uall"], root);
    assert.match(still, /\.env/);
  });

  it("unmerged paths refuse /commit do", () => {
    const root = path.join(tmp, "merge");
    initRepo(root);
    fs.writeFileSync(path.join(root, "a.txt"), "base\n");
    git(["add", "a.txt"], root);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"], root);
    const baseBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
    git(["checkout", "-q", "-b", "other"], root);
    fs.writeFileSync(path.join(root, "a.txt"), "other\n");
    git(["add", "a.txt"], root);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "other"], root);
    git(["checkout", "-q", baseBranch], root);
    fs.writeFileSync(path.join(root, "a.txt"), "main\n");
    git(["add", "a.txt"], root);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "main"], root);
    try {
      git(["merge", "--no-commit", "other"], root);
    } catch {
      /* conflict expected */
    }
    const { session, config } = sess(root);
    const peek = runCommit({ session, config, color: false });
    const peekOut = strip(peek.output);
    assert.match(peekOut, /Unmerged/i);
    assert.match(peekOut, /Next  \/diff/);
    assert.doesNotMatch(peekOut, /\/commit do/);
    const created = runCommit({ session, config, doCommit: true, color: false });
    assert.equal(created.failed, true);
    assert.equal(created.sha, undefined);
    assert.match(strip(created.output), /commit  ·  ✗/);
    assert.match(strip(created.output), /unmerged/i);
    assert.equal(git(["log", "-1", "--pretty=%s"], root), "main");
  });

  it("formatCommitVerdict kinds stay distinct", () => {
    assert.equal(
      strip(formatCommitVerdict("ok", { color: false })),
      "commit  ·  ok",
    );
    assert.equal(
      strip(formatCommitVerdict("empty", { color: false })),
      "commit  ·  nothing to commit",
    );
    assert.equal(
      strip(formatCommitVerdict("fail", { color: false })),
      "commit  ·  ✗",
    );
  });
});
