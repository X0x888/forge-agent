import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildAutoCommitSubject,
  commitIdentArgs,
  formatLeftUnstagedAdmit,
  gitHasAuthorIdentity,
  isForgeScratchRelPath,
  isLookArtefactRelPath,
  isSensitiveRelPath,
  isChangelogRelPath,
  isDisposableTestRelPath,
  maybeAutoCommitOnUlwDone,
  porcelainPaths,
  sessionLooksDir,
  stageAutoCommitPaths,
  ulwAutoCommitEnabled,
  ULW_COMMIT_EMAIL,
  ULW_COMMIT_NAME,
} from "../src/util/git-auto-commit.js";
import {
  armUlwCycle,
  evaluateUlwAtStop,
  loadUlwCycle,
  saveUlwCycle,
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

/**
 * Minimal repo without `git init` — sandbox chmod on .git/hooks fails.
 */
function scaffoldGitRepo(root: string): void {
  const gitDir = path.join(root, ".git");
  fs.mkdirSync(path.join(gitDir, "objects"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(
    path.join(gitDir, "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n" +
      "[user]\n\tname = Forge Test\n\temail = forge@test\n",
  );
}

function withRepo(fn: (root: string) => void): void {
  const prevHome = process.env.FORGE_HOME;
  const prevFlag = process.env.FORGE_ULW_AUTO_COMMIT;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ac-home-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ac-repo-"));
  process.env.FORGE_HOME = home;
  try {
    scaffoldGitRepo(root);
    fs.writeFileSync(path.join(root, "README.md"), "hi\n");
    git(["add", "README.md"], root);
    git(
      [
        "-c",
        "user.email=forge@test",
        "-c",
        "user.name=Forge Test",
        "commit",
        "-q",
        "-m",
        "init",
      ],
      root,
    );
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

  it("does not use the raw mandate when the wave summary is Cycle complete", () => {
    const s = buildAutoCommitSubject(
      "comprehensively evaulate this tool and then improve it.",
      "Cycle complete. w10 LAST: /auth returns formatAuthCard.",
    );
    assert.match(s, /\/auth|formatAuthCard/i);
    assert.doesNotMatch(s, /comprehensively evaulate/i);
  });

  it("does not title a commit from the ULW re-anchor", () => {
    const s = buildAutoCommitSubject(
      "improve this game",
      "Acting on the ULW re-anchor. Do not stop. Do not ask permission to continue.",
    );
    assert.doesNotMatch(s, /Acting on the ULW re-anchor/i);
    assert.match(s, /improve this game/i);
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
          "**Cycle complete.**\n✅ npm run typecheck — green\nMust-fix: none",
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

  it("skips during LAST reflect score (read-only)", () => {
    withRepo((root) => {
      const sid = "sess-ac-score";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "improve the ui chrome", {
        cycle: 0,
        skipCheckpoint: true,
        cwd: root,
      });
      evaluateUlwAtStop({
        sessionId: sid,
        lastAssistantMessage: "**Cycle complete.**\n✅ npm run typecheck — green",
        editCount: 1,
        openTodoCount: 0,
        stuckThreshold: 20,
        verificationPassed: true,
      });
      assert.equal(loadUlwCycle(sid)?.lastReflect, "score");
      fs.writeFileSync(path.join(root, "extra.ts"), "export const n = 2;\n");
      const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(r.committed, false);
      assert.match(r.skipped || "", /LAST reflect score/i);
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

  it("skips slash-peek mill snapshots after the first of that class", () => {
    withRepo((root) => {
      const sid = "sess-ac-peek-mill";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve the ui and ux of this tool.", {
        cycle: 1,
        skipCheckpoint: true,
        cwd: root,
      });
      const s = loadUlwCycle(sid)!;
      s.wave = 2;
      s.peekMillStreak = 2;
      s.waves = [
        {
          wave: 1,
          editDelta: 4,
          proof: false,
          summary:
            "Ship landed: `/model` is a verdict-first sit-down card, not formatParamMenu.",
          classText: "`/model` is a sit-down peek.",
          millClass: true,
          ts: new Date().toISOString(),
        },
        {
          wave: 2,
          editDelta: 3,
          proof: false,
          summary:
            "Ship landed: `/context` is a sit-down peek, not a bar lecture.",
          classText: "`/context` is a sit-down peek.",
          millClass: true,
          ts: new Date().toISOString(),
        },
      ];
      saveUlwCycle(s);
      fs.mkdirSync(path.join(root, "src/tui"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/tui/context-card.ts"), "x\n");
      const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(r.committed, false, r.skipped);
      assert.match(r.skipped || "", /slash-peek mill|mill ship/i);
    });
  });

  it("skips LAST close-out tests-only snapshots", () => {
    withRepo((root) => {
      const sid = "sess-ac-last-tests";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "Improve the ui and ux of this tool.", {
        cycle: 0,
        skipCheckpoint: true,
        cwd: root,
      });
      const s = loadUlwCycle(sid)!;
      s.lastReflect = "closeout";
      s.lastReflectMustFix = 1;
      saveUlwCycle(s);
      fs.mkdirSync(path.join(root, "tests"), { recursive: true });
      fs.writeFileSync(path.join(root, "tests/git-auto-commit.test.ts"), "x\n");
      const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(r.committed, false, r.skipped);
      assert.equal(r.skipped, "LAST close-out tests-only");
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
          "**Cycle complete.**\n✅ npm run typecheck — green\nMust-fix: none",
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
      // Rewrite config on disk — `git config --unset` chmod's config.lock (sandbox).
      fs.writeFileSync(
        path.join(root, ".git", "config"),
        "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n" +
          "[user]\n\tuseConfigOnly = true\n",
      );
      // createChildEnv strips GIT_CONFIG_GLOBAL/SYSTEM (injection). Isolate
      // identity via HOME so `git var GIT_AUTHOR_IDENT` cannot see ~/.gitconfig.
      const emptyHome = path.join(root, ".empty-home");
      fs.mkdirSync(emptyHome, { recursive: true });
      const prev = {
        HOME: process.env.HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
      };
      process.env.HOME = emptyHome;
      delete process.env.XDG_CONFIG_HOME;
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

  it("does not commit worktree-land fixtures", () => {
    withRepo((root) => {
      const sid = "sess-ac-wtland";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      const junk = path.join(
        root,
        "src",
        "agent",
        "__wt_land_wt-landed-23589-temrip.md",
      );
      fs.mkdirSync(path.dirname(junk), { recursive: true });
      fs.writeFileSync(junk, "landed\n");
      assert.equal(isDisposableTestRelPath("src/agent/__wt_land_wt-landed-23589-temrip.md"), true);
      const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(r.committed, false);
      assert.match(r.skipped || "", /disposable test fixtures/);
      assert.ok(fs.existsSync(junk));
    });
  });

  it("strips the model's own Wave N prefix from the subject (the body carries the harness wave)", () => {
    assert.equal(
      buildAutoCommitSubject("improve this game", "Wave 160 — Consolidation. No new product scope. Verify: npm test."),
      "Consolidation. No new product scope. Verify: npm test.",
    );
    assert.equal(
      buildAutoCommitSubject("improve this game", "Ship landed: Wave 84: Appetite hunt. Digest is no longer FIFO wallpaper."),
      "Appetite hunt. Digest is no longer FIFO wallpaper.",
    );
    // A subject that merely mentions a wave mid-sentence is untouched.
    assert.equal(
      buildAutoCommitSubject("improve this game", "Ship landed: the ledger shows wave 3 twice."),
      "the ledger shows wave 3 twice.",
    );
  });

  it("classifies look artefacts and .forge scratch", () => {
    for (const p of [
      "images/death-care-look.png",
      "images/leftover-beat-look.html",
      "images/badge-states.png",
      "screenshots/home.png",
      "docs/shots/after-fix.jpg",
      "capture-01.webp",
      "before.png",
    ]) {
      assert.equal(isLookArtefactRelPath(p), true, p);
    }
    for (const p of [
      "extension/public/icon-128.png",
      "assets/sprite-idle.png",
      "index.html",
      "src/popup/popup.html",
      "images/logo.svg",
      "src/lib/look.ts",
    ]) {
      assert.equal(isLookArtefactRelPath(p), false, p);
    }
    for (const p of [
      ".forge/chrome-look/Default/Cookies",
      ".forge/chrome-look12/Local State",
      ".forge/tmp/x.json",
    ]) {
      assert.equal(isForgeScratchRelPath(p), true, p);
    }
    for (const p of [
      ".forge/MEMORY.md",
      ".forge/commands/deploy.md",
      ".forge/skills/game/SKILL.md",
      ".forge/hooks.json",
      "src/.forge-like/x.ts",
    ]) {
      assert.equal(isForgeScratchRelPath(p), false, p);
    }
  });

  it("leaves unreferenced looks and .forge scratch unstaged; a referenced sprite commits", () => {
    withRepo((root) => {
      const sid = "sess-ac-looks";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      armUlwCycle(sid, "improve this game", { cycle: 1, skipCheckpoint: true, editCount: 0 });
      const s = loadUlwCycle(sid)!;
      s.waves = [
        {
          wave: 1,
          editDelta: 5,
          proof: true,
          summary: "Ship landed: the companion blinks — `pet-face.ts` `blinkOpenness`.",
          ts: new Date().toISOString(),
        },
      ];
      saveUlwCycle(s);
      // Product change + a sprite it loads + two looks nobody loads + a browser profile.
      fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "src", "lib", "pet-face.ts"),
        "export const SPRITE = 'images/sprite-idle.png';\nexport function blinkOpenness(t: number) { return t % 2; }\n",
      );
      fs.mkdirSync(path.join(root, "images"));
      fs.writeFileSync(path.join(root, "images", "sprite-idle.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      fs.writeFileSync(path.join(root, "images", "death-care-look.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      fs.writeFileSync(path.join(root, "images", "leftover-beat-look.html"), "<html>look</html>\n");
      fs.mkdirSync(path.join(root, ".forge", "chrome-look", "Default"), { recursive: true });
      fs.writeFileSync(path.join(root, ".forge", "chrome-look", "Default", "Cookies"), "sqlite\n");
      fs.mkdirSync(path.join(root, ".forge", "commands"), { recursive: true });
      fs.writeFileSync(path.join(root, ".forge", "commands", "deploy.md"), "# deploy\n");

      const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(r.committed, true, r.skipped);
      assert.deepEqual(
        [...(r.leftUnstaged ?? [])].sort(),
        [".forge/chrome-look/Default/Cookies", "images/death-care-look.png", "images/leftover-beat-look.html"],
      );
      const committed = git(["show", "--name-only", "--format=", "HEAD"], root)
        .split("\n")
        .filter(Boolean)
        .sort();
      assert.deepEqual(committed, [".forge/commands/deploy.md", "images/sprite-idle.png", "src/lib/pet-face.ts"]);
      // Left on disk, still dirty — not deleted, just not shipped.
      assert.ok(fs.existsSync(path.join(root, "images", "death-care-look.png")));
      const dirty = porcelainPaths(root).sort();
      assert.deepEqual(dirty, [".forge/chrome-look/Default/Cookies", "images/death-care-look.png", "images/leftover-beat-look.html"]);

      const admit = formatLeftUnstagedAdmit(r, sid)!;
      assert.match(admit, /^\[Forge harness — mid-conversation update\]/);
      assert.match(admit, /left 3 file\(s\) unstaged/);
      assert.match(admit, /death-care-look\.png/);
      assert.ok(admit.includes(sessionLooksDir(sid)));
      assert.match(admit, /do not `git add` them/);
      assert.equal(formatLeftUnstagedAdmit({ leftUnstaged: [] }, sid), undefined);
    });
  });

  it("a dirty tree of looks alone is not a commit", () => {
    withRepo((root) => {
      const sid = "sess-ac-looks-only";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), {
        recursive: true,
      });
      fs.mkdirSync(path.join(root, "images"));
      fs.writeFileSync(path.join(root, "images", "home-look.png"), Buffer.from([1, 2, 3]));
      const r = maybeAutoCommitOnUlwDone({ cwd: root, sessionId: sid });
      assert.equal(r.committed, false);
      assert.match(r.skipped || "", /only look artefacts \/ scratch remain/);
      assert.deepEqual(r.leftUnstaged, ["images/home-look.png"]);
    });
  });
});
