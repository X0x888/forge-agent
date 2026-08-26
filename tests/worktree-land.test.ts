/**
 * Subagent worktree capture + land-into-parent.
 *
 * Uses the real project git root (sandbox blocks `git init` chmod on fresh
 * repos) and unique disposable paths under a temp FORGE_HOME.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyWorktreePatch,
  captureWorktreePatch,
  createSubagentWorktree,
  findGitRoot,
  formatWorktreeLandSummary,
  landSubagentWorktree,
  listWorktreeChangedFiles,
  parsePorcelainPath,
  restoreParentPreimages,
  resolveWorktreeLandMode,
  unquotePorcelainPath,
  worktreeDiffStat,
} from "../src/agent/worktree.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = findGitRoot(path.resolve(HERE, ".."));

function tmpRoot(): string {
  const base = process.env.TMPDIR || path.join(process.cwd(), ".tmp");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Disposable relative path that `git status -uall` will list.
 * `tests/__wt_land__/` is gitignored, so untracked files there never
 * appear in worktree capture.
 */
function testRel(prefix: string, ext = ".txt"): string {
  return path.join("src", "agent", `__wt_land_${uniqueName(prefix)}${ext}`);
}

describe("parsePorcelainPath", () => {
  it("keeps the first path char on unstaged-only lines", () => {
    assert.equal(
      parsePorcelainPath(" M src/agent/worktree.ts"),
      "src/agent/worktree.ts",
    );
    assert.equal(
      parsePorcelainPath("?? src/agent/__land_probe.ts"),
      "src/agent/__land_probe.ts",
    );
    assert.equal(parsePorcelainPath("M  src/cli.ts"), "src/cli.ts");
    assert.equal(parsePorcelainPath("A  src/new.ts"), "src/new.ts");
    assert.equal(parsePorcelainPath("D  src/gone.ts"), "src/gone.ts");
    assert.equal(
      parsePorcelainPath('R  "old.ts" -> "new file.ts"'),
      "new file.ts",
    );
    assert.equal(unquotePorcelainPath('"foo bar.ts"'), "foo bar.ts");
    assert.equal(parsePorcelainPath(""), null);
    assert.equal(parsePorcelainPath(" M"), null);
    // trim() of a whole porcelain dump turns `" M src/…"` into `"M src/…"`.
    assert.equal(
      parsePorcelainPath("M src/agent/permissions.ts"),
      "src/agent/permissions.ts",
    );
  });
});

describe("resolveWorktreeLandMode", () => {
  it("defaults to auto", () => {
    const prev = process.env.FORGE_SUBAGENT_LAND;
    const prev2 = process.env.FORGE_WORKTREE_LAND;
    delete process.env.FORGE_SUBAGENT_LAND;
    delete process.env.FORGE_WORKTREE_LAND;
    try {
      assert.equal(resolveWorktreeLandMode(), "auto");
      assert.equal(resolveWorktreeLandMode("auto"), "auto");
      assert.equal(resolveWorktreeLandMode("keep"), "keep");
      assert.equal(resolveWorktreeLandMode("discard"), "discard");
      assert.equal(resolveWorktreeLandMode("off"), "discard");
      assert.equal(resolveWorktreeLandMode("manual"), "keep");
    } finally {
      if (prev === undefined) delete process.env.FORGE_SUBAGENT_LAND;
      else process.env.FORGE_SUBAGENT_LAND = prev;
      if (prev2 === undefined) delete process.env.FORGE_WORKTREE_LAND;
      else process.env.FORGE_WORKTREE_LAND = prev2;
    }
  });
});

describe("worktree capture + land", { skip: !REPO }, () => {
  let prevHome = "";
  let fakeHome = "";
  const leftovers: string[] = [];

  before(() => {
    assert.ok(REPO, "expected to run inside a git checkout");
    prevHome = process.env.FORGE_HOME || "";
    fakeHome = fs.mkdtempSync(path.join(tmpRoot(), "forge-home-wt-"));
    process.env.FORGE_HOME = fakeHome;
  });

  it("restoreParentPreimages removes files that did not exist before apply", () => {
    const rel = testRel("restore-new");
    leftovers.push(rel);
    const abs = path.join(REPO!, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "should-not-survive\n");
    const snaps = new Map<
      string,
      { before?: string; mode?: number; existed: boolean }
    >([[rel, { existed: false }]]);
    restoreParentPreimages(REPO!, snaps);
    assert.equal(fs.existsSync(abs), false);
  });

  it("restoreParentPreimages rewrites files that existed before apply", () => {
    const rel = testRel("restore-old");
    leftovers.push(rel);
    const abs = path.join(REPO!, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "after-3way\n");
    const snaps = new Map<
      string,
      { before?: string; mode?: number; existed: boolean }
    >([[rel, { existed: true, before: "before-3way\n" }]]);
    restoreParentPreimages(REPO!, snaps);
    assert.equal(fs.readFileSync(abs, "utf8"), "before-3way\n");
  });

  after(() => {
    // Best-effort cleanup of any parent files we may have landed
    for (const rel of leftovers) {
      try {
        fs.rmSync(path.join(REPO!, rel), { force: true });
      } catch {
        /* */
      }
    }
    try {
      const agentDir = path.join(REPO!, "src", "agent");
      for (const name of fs.readdirSync(agentDir)) {
        if (name.startsWith("__wt_land_")) {
          fs.rmSync(path.join(agentDir, name), { force: true });
        }
      }
    } catch {
      /* */
    }
    if (prevHome) process.env.FORGE_HOME = prevHome;
    else delete process.env.FORGE_HOME;
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("captures tracked + untracked changes into a patch", async () => {
    const wt = createSubagentWorktree({
      workspace: REPO!,
      label: "cap",
    });
    try {
      const trackedRel = path.join("src", "agent", "worktree.ts");
      const trackedAbs = path.join(wt.path, trackedRel);
      const orig = fs.readFileSync(trackedAbs, "utf8");
      fs.writeFileSync(trackedAbs, orig + "\n// capture-marker\n");

      const untrackedRel = testRel("wt-cap-untracked");
      fs.mkdirSync(path.dirname(path.join(wt.path, untrackedRel)), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(wt.path, untrackedRel),
        "untracked-for-capture\n",
      );

      const changed = listWorktreeChangedFiles(wt.path);
      assert.ok(
        changed.some((c) => c.replace(/\\/g, "/").includes("worktree.ts")),
        `expected worktree.ts in ${JSON.stringify(changed)}`,
      );
      assert.ok(
        changed.some((c) => c.includes("wt-cap-untracked")),
        `expected untracked in ${JSON.stringify(changed)}`,
      );

      const { patch, changedFiles, diffStat } = captureWorktreePatch(wt.path);
      assert.ok(patch.length > 0, "patch should be non-empty");
      assert.ok(
        patch.includes("capture-marker") || patch.includes("worktree.ts"),
      );
      assert.ok(
        patch.includes("untracked-for-capture") ||
          patch.includes("wt-cap-untracked"),
      );
      assert.ok(changedFiles.length >= 2);
      assert.equal(typeof diffStat, "string");
      assert.ok(typeof worktreeDiffStat(wt.path) === "string");
    } finally {
      await wt.cleanup();
    }
  });

  it("lands clean patch into parent and removes worktree", async () => {
    const wt = createSubagentWorktree({
      workspace: REPO!,
      label: "land",
    });
    const rel = testRel("wt-landed", ".md");
    leftovers.push(rel);
    fs.mkdirSync(path.dirname(path.join(wt.path, rel)), { recursive: true });
    const body = `# landed ${Date.now()}\n`;
    fs.writeFileSync(path.join(wt.path, rel), body);

    const result = await landSubagentWorktree({
      worktree: wt,
      parentWorkspace: REPO!,
      mode: "auto",
    });

    assert.equal(result.status, "applied", result.detail ?? "");
    assert.equal(result.kept, false);
    assert.ok(
      result.changedFiles.some((c) => c.includes("wt-landed")),
      JSON.stringify(result.changedFiles),
    );
    const parentFile = path.join(REPO!, rel);
    assert.ok(fs.existsSync(parentFile), "parent should receive landed file");
    assert.equal(fs.readFileSync(parentFile, "utf8"), body);
    assert.equal(fs.existsSync(wt.path), false);

    const summary = formatWorktreeLandSummary(result);
    assert.match(summary, /landed into parent/i);
    assert.doesNotMatch(summary, /\/undo reverts/);
    assert.equal(result.journaled ?? false, false);
  });

  it("mode=keep reports diff without applying", async () => {
    const wt = createSubagentWorktree({
      workspace: REPO!,
      label: "keep",
    });
    const rel = testRel("wt-keep");
    fs.mkdirSync(path.dirname(path.join(wt.path, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt.path, rel), "keep-only\n");

    const result = await landSubagentWorktree({
      worktree: wt,
      parentWorkspace: REPO!,
      mode: "keep",
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.kept, true);
    assert.ok(fs.existsSync(wt.path));
    assert.equal(fs.existsSync(path.join(REPO!, rel)), false);
    await wt.cleanup();
  });

  it("mode=discard removes without applying", async () => {
    const wt = createSubagentWorktree({
      workspace: REPO!,
      label: "disc",
    });
    const rel = testRel("wt-disc");
    fs.mkdirSync(path.dirname(path.join(wt.path, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt.path, rel), "discard-me\n");

    const result = await landSubagentWorktree({
      worktree: wt,
      parentWorkspace: REPO!,
      mode: "discard",
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.kept, false);
    assert.equal(fs.existsSync(wt.path), false);
    assert.equal(fs.existsSync(path.join(REPO!, rel)), false);
  });

  it("clean worktree removes with status=clean", async () => {
    const wt = createSubagentWorktree({
      workspace: REPO!,
      label: "clean",
    });
    const result = await landSubagentWorktree({
      worktree: wt,
      parentWorkspace: REPO!,
      mode: "auto",
    });
    assert.equal(result.status, "clean");
    assert.equal(result.kept, false);
    assert.equal(fs.existsSync(wt.path), false);
  });

  it("skipApply keeps worktree even when land=discard", async () => {
    const wt = createSubagentWorktree({
      workspace: REPO!,
      label: "skip-disc",
    });
    const rel = testRel("wt-skip-disc");
    fs.mkdirSync(path.dirname(path.join(wt.path, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt.path, rel), "keep-me\n");

    const result = await landSubagentWorktree({
      worktree: wt,
      parentWorkspace: REPO!,
      mode: "discard",
      skipApply: true,
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.kept, true);
    assert.ok(fs.existsSync(wt.path));
    assert.equal(fs.existsSync(path.join(REPO!, rel)), false);
    await wt.cleanup();
  });

  it("skipApply keeps worktree and does not touch parent", async () => {
    const wt = createSubagentWorktree({
      workspace: REPO!,
      label: "skip",
    });
    const rel = testRel("wt-skip");
    fs.mkdirSync(path.dirname(path.join(wt.path, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt.path, rel), "skip-apply\n");

    const result = await landSubagentWorktree({
      worktree: wt,
      parentWorkspace: REPO!,
      mode: "auto",
      skipApply: true,
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.kept, true);
    assert.match(result.detail || "", /incomplete\/aborted\/failed/);
    assert.ok(fs.existsSync(wt.path));
    assert.equal(fs.existsSync(path.join(REPO!, rel)), false);
    await wt.cleanup();
  });

  it("applyWorktreePatch applies a captured untracked file patch", async () => {
    const wt = createSubagentWorktree({
      workspace: REPO!,
      label: "rt",
    });
    const rel = testRel("wt-rt");
    leftovers.push(rel);
    fs.mkdirSync(path.dirname(path.join(wt.path, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt.path, rel), "roundtrip-body\n");
    const { patch } = captureWorktreePatch(wt.path);
    assert.ok(patch.length > 0);

    const r = applyWorktreePatch(REPO!, patch);
    assert.equal(r.ok, true, r.detail ?? "");
    assert.ok(fs.existsSync(path.join(REPO!, rel)));
    assert.equal(
      fs.readFileSync(path.join(REPO!, rel), "utf8"),
      "roundtrip-body\n",
    );
    // git apply --3way must not leave the parent index dirty.
    const porcelain = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--", rel],
      { cwd: REPO!, encoding: "utf8" },
    );
    assert.match(porcelain, /^\?\? /, porcelain);
    await wt.cleanup();
  });

  it("journals landed files so /undo can revert the parent tree", async () => {
    const { createSession } = await import("../src/session/session.js");
    const {
      readFileMutations,
      restoreMutationsAfterTurn,
    } = await import("../src/session/mutations.js");
    const { fileReadsForSession, forgetFileReadsSession } = await import(
      "../src/agent/tools/file-read-state.js"
    );
    const {
      snapshotParentPreimages,
      journalLandedPreimages,
    } = await import("../src/agent/worktree.js");
    const s = createSession({
      cwd: REPO!,
      provider: "xai",
      model: "grok-4",
    });
    // Disposable fixture only — never land AGENTS.md / worktree.ts.
    const rel = testRel("wt-journal");
    leftovers.push(rel);
    const abs = path.join(REPO!, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "parent-before\n");
    const reads = fileReadsForSession(s.meta.id);
    try {
      assert.equal(await reads.noteFromDisk(abs), true);
      assert.ok(reads.get(abs));
      const snaps = snapshotParentPreimages(REPO!, [rel]);
      fs.writeFileSync(abs, "landed-after\n");
      journalLandedPreimages({
        sessionId: s.meta.id,
        parentPath: REPO!,
        relPaths: [rel],
        snapshots: snaps,
        turn: 3,
      });
      const journal = readFileMutations(s.meta.id);
      assert.ok(
        journal.some((m) => m.path === abs && m.kind === "update" && m.turn === 3),
        JSON.stringify(journal),
      );
      assert.equal(reads.get(abs), undefined);
      const blocked = await reads.checkBeforeMutate(abs, {
        tool: "search_replace",
        rel,
      });
      assert.ok(blocked);
      assert.match(blocked!, /has not been read/);
      const restored = restoreMutationsAfterTurn(s.meta.id, 2);
      assert.ok(restored.restored.length > 0, JSON.stringify(restored));
      assert.equal(fs.readFileSync(abs, "utf8"), "parent-before\n");
    } finally {
      forgetFileReadsSession(s.meta.id);
    }
  });

  it("add overlapping remove on one git root does not throw", async () => {
    const { enqueueGitWorktreeMeta } = await import(
      "../src/agent/spawn-join.js"
    );
    const first = createSubagentWorktree({
      workspace: REPO!,
      label: "addrm-a",
    });
    const add = enqueueGitWorktreeMeta(REPO!, () =>
      createSubagentWorktree({
        workspace: REPO!,
        label: "addrm-b",
      }),
    );
    const remove = enqueueGitWorktreeMeta(REPO!, () => first.cleanup());
    const second = await add;
    await remove;
    await second.cleanup();
  });
});
