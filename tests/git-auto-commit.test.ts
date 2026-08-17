import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildAutoCommitSubject,
  commitIdentArgs,
  gitHasAuthorIdentity,
  isSensitiveRelPath,
  isChangelogRelPath,
  maybeAutoCommitOnUlwDone,
  porcelainPaths,
  stageAutoCommitPaths,
  ulwAutoCommitEnabled,
  ULW_COMMIT_EMAIL,
  ULW_COMMIT_NAME,
} from "../src/util/git-auto-commit.js";
import {
  armUlwCycle,
  evaluateUlwAtStop,
  PLACEHOLDER_MANDATE,
} from "../src/harness/ulw-cycle.js";
import { appendFileMutation } from "../src/session/mutations.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function withRepo(fn: (root: string) => void): void {
  const prevHome = process.env.FORGE_HOME;
  const prevFlag = process.env.FORGE_ULW_AUTO_COMMIT;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ac-home-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ac-repo-"));
  process.env.FORGE_HOME = home;
  try {
    git(["init", "-q"], root);
    git(["config", "user.email", "forge@test"], root);
    git(["config", "user.name", "Forge Test"], root);
    fs.writeFileSync(path.join(root, "README.md"), "hi\n");
    git(["add", "README.md"], root);
    git(["commit", "-q", "-m", "init"], root);
    fn(root);
  } finally {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevFlag === undefined) delete process.env.FORGE_ULW_AUTO_COMMIT;
    else process.env.FORGE_ULW_AUTO_COMMIT = prevFlag;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("ULW auto-commit", () => {
  it("names changelog-only snapshots", () => {
    assert.equal(isChangelogRelPath("CHANGELOG.md"), true);
    assert.equal(isChangelogRelPath("docs/CHANGELOG"), true);
    assert.equal(isChangelogRelPath("src/changelog.ts"), false);
  });

  it("names sensitive paths", () => {
    assert.equal(isSensitiveRelPath(".env"), true);
    assert.equal(isSensitiveRelPath("src/.env.local"), true);
    assert.equal(isSensitiveRelPath("certs/prod.pem"), true);
    assert.equal(isSensitiveRelPath("src/tui/repl.ts"), false);
  });

  it("clips mandate subjects", () => {
    const s = buildAutoCommitSubject("comprehensively evaluate this tool and then improve the ui and ux of it.");
    assert.ok(s.length <= 68);
    assert.match(s, /evaluate/i);
  });

  it("prefers a Ship landed hint over the raw mandate", () => {
    const s = buildAutoCommitSubject(
      "comprehensively evaluate this tool and then improve the ui and ux of it.",
      "Ship landed: idle footer unverified check tip is next <cmd>, not a fake pass.",
    );
    assert.match(s, /idle footer/i);
    assert.doesNotMatch(s, /comprehensively evaluate/i);
    const w4 = buildAutoCommitSubject(
      "comprehensively evaluate this tool and then improve the ui and ux of it.",
      "Wave 4 LAST shipped (cycle=0): failed-tool tails + live redock.",
    );
    assert.match(w4, /failed-tool tails/i);
  });

  it("defaults on and honors FORGE_ULW_AUTO_COMMIT=0", () => {
    delete process.env.FORGE_ULW_AUTO_COMMIT;
    assert.equal(ulwAutoCommitEnabled(), true);
    process.env.FORGE_ULW_AUTO_COMMIT = "0";
    assert.equal(ulwAutoCommitEnabled(), false);
    delete process.env.FORGE_ULW_AUTO_COMMIT;
  });

  it("commits journaled files after cycle complete", () => {
    withRepo((root) => {
      const sid = "sess-ac-1";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "improve the ui chrome", {
        cycle: 1,
        maxWaves: 1,
        skipCheckpoint: true,
        cwd: root,
      });
      const dest = path.join(root, "src", "ui.ts");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, "export const x = 1;\n");
      appendFileMutation(sid, {
        path: dest,
        kind: "create",
        turn: 1,
      });
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "**Cycle complete.**\n✅ npm run typecheck — green",
        editCount: 1,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.ok(
        porcelainPaths(root).includes("src/ui.ts"),
        `expected file-level porcelain, got ${porcelainPaths(root).join(",")}`,
      );
      const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(r.committed, true, r.skipped);
      assert.ok(r.sha);
      assert.match(r.subject || "", /improve the ui chrome/i);
      assert.equal(porcelainPaths(root).length, 0);
      const log = git(["log", "-1", "--format=%s"], root);
      assert.match(log, /improve the ui chrome/i);
    });
  });

  it("skips when disabled", () => {
    withRepo((root) => {
      process.env.FORGE_ULW_AUTO_COMMIT = "0";
      const sid = "sess-ac-off";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, "a.ts"), "a\n");
      const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(r.committed, false);
      assert.match(r.skipped || "", /FORGE_ULW_AUTO_COMMIT=0/);
    });
  });

  it("skips a changelog-only dirty tree", () => {
    withRepo((root) => {
      const sid = "sess-ac-cl";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve this game based on comprehensive evaluation.", {
        cycle: 1,
        skipCheckpoint: true,
        cwd: root,
      });
      fs.writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n");
      const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(r.committed, false, r.skipped);
      assert.equal(r.skipped, "changelog-only");
    });
  });

  it("skips plan mode and clean trees", () => {
    withRepo((root) => {
      const sid = "sess-ac-plan";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const plan = maybeAutoCommitOnUlwDone({
        cwd: root,
        sessionId: sid,
        permissionMode: "plan",
      });
      assert.equal(plan.skipped, "plan mode");
      const clean = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(clean.skipped, "working tree clean");
    });
  });

  it("keeps the first char of an unstaged src/ path (no trimStart)", () => {
    withRepo((root) => {
      const dest = path.join(root, "src", "agent.ts");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, "export const x = 1;\n");
      git(["add", "src/agent.ts"], root);
      git(["commit", "-q", "-m", "add src"], root);
      fs.writeFileSync(dest, "export const x = 2;\n");
      assert.deepEqual(porcelainPaths(root), ["src/agent.ts"]);
    });
  });

  it("commits an unstaged src/ edit after cycle complete", () => {
    withRepo((root) => {
      const sid = "sess-ac-unstaged";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const dest = path.join(root, "src", "agent.ts");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, "export const x = 1;\n");
      git(["add", "src/agent.ts"], root);
      git(["commit", "-q", "-m", "add src"], root);
      fs.writeFileSync(dest, "export const x = 2;\n");
      appendFileMutation(sid, { path: dest, kind: "edit", turn: 1 });
      armUlwCycle(sid, "fix the stdin lease", {
        cycle: 1,
        maxWaves: 1,
        skipCheckpoint: true,
        cwd: root,
      });
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage:
          "**Cycle complete.**\n✅ npm run typecheck — green",
        editCount: 1,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(r.committed, true, r.skipped);
      assert.equal(porcelainPaths(root).length, 0);
    });
  });

  it("stages survivors when one path is missing", () => {
    withRepo((root) => {
      const good = path.join(root, "src", "ok.ts");
      fs.mkdirSync(path.dirname(good), { recursive: true });
      fs.writeFileSync(good, "export const ok = 1;\n");
      const { staged, failed } = stageAutoCommitPaths(root, [
        "rc/agent/permissions.ts",
        "src/ok.ts",
      ]);
      assert.deepEqual(staged, ["src/ok.ts"]);
      assert.deepEqual(failed, ["rc/agent/permissions.ts"]);
    });
  });

  it("skips a pending placeholder mandate", () => {
    withRepo((root) => {
      const sid = "sess-ac-ph";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, PLACEHOLDER_MANDATE, {
        cycle: 1,
        skipCheckpoint: true,
        cwd: root,
      });
      fs.writeFileSync(path.join(root, "a.ts"), "a\n");
      const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(r.committed, false);
      assert.match(r.skipped || "", /pending work-order/);
    });
  });

  it("commits when git author identity is unknown", () => {
    withRepo((root) => {
      git(["config", "--unset", "user.name"], root);
      git(["config", "--unset", "user.email"], root);
      git(["config", "user.useConfigOnly", "true"], root);
      const emptyCfg = path.join(root, ".empty-gitconfig");
      fs.writeFileSync(emptyCfg, "");
      const prev = {
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
      };
      process.env.GIT_CONFIG_GLOBAL = emptyCfg;
      process.env.GIT_CONFIG_SYSTEM = emptyCfg;
      delete process.env.GIT_AUTHOR_NAME;
      delete process.env.GIT_AUTHOR_EMAIL;
      delete process.env.GIT_COMMITTER_NAME;
      delete process.env.GIT_COMMITTER_EMAIL;
      try {
        assert.equal(gitHasAuthorIdentity(root), false);
        assert.deepEqual(commitIdentArgs(root), [
          "-c",
          `user.name=${ULW_COMMIT_NAME}`,
          "-c",
          `user.email=${ULW_COMMIT_EMAIL}`,
        ]);
        const sid = "sess-ac-noident";
        fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
          recursive: true,
        });
        armUlwCycle(sid, "improve this game.", {
          cycle: 1,
          skipCheckpoint: true,
          cwd: root,
        });
        fs.writeFileSync(path.join(root, "ship.ts"), "export const n = 1;\n");
        const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
        assert.equal(r.committed, true, r.skipped);
        const ident = git(["log", "-1", "--format=%an <%ae>"], root);
        assert.match(ident, /Forge <forge@local>/);
      } finally {
        for (const [k, v] of Object.entries(prev)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  });

  it("does not stage .env", () => {
    withRepo((root) => {
      const sid = "sess-ac-env";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const envPath = path.join(root, ".env");
      fs.writeFileSync(envPath, "SECRET=1\n");
      appendFileMutation(sid, { path: envPath, kind: "create", turn: 1 });
      const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(r.committed, false);
      assert.match(r.skipped || "", /sensitive/);
    });
  });
});
