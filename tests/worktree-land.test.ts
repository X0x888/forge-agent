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
import { fileURLToPath } from "node:url";
import {
  applyWorktreePatch,
  captureWorktreePatch,
  createSubagentWorktree,
  findGitRoot,
  formatWorktreeLandSummary,
  landSubagentWorktree,
  listWorktreeChangedFiles,
  resolveWorktreeLandMode,
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

/** Non-gitignored disposable relative path under tests/__wt_land__/. */
function testRel(prefix: string, ext = ".txt"): string {
  return path.join("tests", "__wt_land__", uniqueName(prefix) + ext);
}

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
      fs.rmSync(path.join(REPO!, "tests", "__wt_land__"), {
        recursive: true,
        force: true,
      });
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
    await wt.cleanup();
  });
});
