/**
 * Tree-shape meter: what the run is growing. HashPet grew 440 exports in
 * 40 existing files, a 15-argument resolver, `sitDays >= 2` in 114 places,
 * 319 "used to" comments, a hard-false flag and 78 unreferenced looks —
 * with every stalling meter green.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SHAPE_EXPORT_SPRAWL_MIN,
  SHAPE_HISTORY_COMMENTS,
  SHAPE_PREDICATE_FILES,
  SHAPE_WIDE_ARITY,
  analyzeTreeShapeDiff,
  findUnreferencedAssets,
  formatTreeShapeConsolidationClause,
  formatTreeShapeHoldAdmit,
  formatTreeShapeStatusLine,
  gitHeadSha,
  measureTreeShape,
  snapshotFromFacts,
  treeShapeTrips,
  unimprovedTrips,
} from "../src/harness/tree-shape.js";
import { ledgerMustFixItems } from "../src/harness/last-reflect.js";
import {
  CONSOLIDATION_EVERY,
  armUlwCycle,
  evaluateUlwAtStop,
  formatUlwStatus,
  loadUlwCycle,
  markUlwPlanDone,
  maybeStampUlwWave,
  notePlayLoopRan,
  scheduleCycleZeroStop,
  treeShapeHolding,
} from "../src/harness/ulw-cycle.js";

function fileDiff(rel: string, added: string[], opts?: { newFile?: boolean; removed?: string[] }): string {
  const head = [
    `diff --git a/${rel} b/${rel}`,
    ...(opts?.newFile ? ["new file mode 100644", "index 0000000..1111111"] : ["index 1111111..2222222 100644"]),
    `--- ${opts?.newFile ? "/dev/null" : `a/${rel}`}`,
    `+++ b/${rel}`,
    "@@ -1,0 +1,1 @@",
  ];
  return [
    ...head,
    ...(opts?.removed ?? []).map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");
}

describe("tree-shape — diff facts", () => {
  it("counts exports in existing files vs new modules, TS / Python / Rust / Go", () => {
    const diff = [
      fileDiff("src/lib/pet-mood.ts", [
        "export function sitDaysLine(a: number) { return a; }",
        "export const HUSH = 3;",
        "export type Mood = 'calm';",
        "function local() {}",
      ]),
      fileDiff("src/lib/voice.ts", ["export function mealCaption(f: string) { return f; }"], { newFile: true }),
      fileDiff("server/app.py", ["def handler(req):", "    return 1", "class Store:"]),
      fileDiff("crate/src/lib.rs", ["pub fn run() {}", "fn hidden() {}"]),
      fileDiff("cmd/main.go", ["func Serve() {}", "func helper() {}"]),
      fileDiff("src/__tests__/pet-mood.test.ts", ["export function fixture() {}"]),
    ].join("\n");
    const f = analyzeTreeShapeDiff(diff);
    assert.equal(f.newModules, 1);
    // pet-mood 3 + voice 1 + py 2 + rs 1 + go 1 = 8; the test file is not production.
    assert.equal(f.netExports, 8);
    assert.equal(f.exportsInExistingFiles, 7);
    assert.equal(f.filesTouched, 5);
  });

  it("removed exports subtract — a collapse shows as a smaller number", () => {
    const diff = fileDiff("src/lib/badge.ts", ["export function one() {}"], {
      removed: ["export function a() {}", "export function b() {}", "export function c() {}"],
    });
    const f = analyzeTreeShapeDiff(diff);
    assert.equal(f.netExports, -2);
    assert.equal(f.exportsInExistingFiles, 1);
  });

  it("wide signatures: single-line and prettier-wrapped, TS and Python", () => {
    const diff = [
      fileDiff("src/lib/home-intent.ts", [
        "export function resolveHomeIntent(",
        "  digesting: Digest | null,",
        "  fridge: Meal[],",
        "  appetite: Appetite,",
        "  reunion: boolean,",
        "  ghosts: Ghost[],",
        "  garden: Garden,",
        "  asleep: boolean,",
        "  sitDays: number,",
        "  hunt: Hunt | null,",
        "): HomeIntent {",
      ]),
      fileDiff("src/lib/badge.ts", [
        "export function careBadgeTitle(kind: string, mood: string, a: boolean, b: boolean, c: boolean, d: boolean, n: number, e: boolean): string {",
        "export function small(a: number, b: number): number {",
        "const fn = (x: number, y: number, z: number) => x;",
      ]),
      fileDiff("app/views.py", ["def render(a, b, c, d, e, f, g, h):"]),
    ].join("\n");
    const f = analyzeTreeShapeDiff(diff);
    const names = f.wideSignatures.map((w) => `${w.name}:${w.arity}`).sort();
    assert.deepEqual(names, ["careBadgeTitle:8", "render:8", "resolveHomeIntent:9"]);
    assert.ok(f.wideSignatures.every((w) => w.arity >= SHAPE_WIDE_ARITY));
  });

  it("one predicate literal across files; loop counters and length checks are not an idea", () => {
    const files = ["pet-mood.ts", "badge.ts", "insight-generator.ts", "first-hour.ts", "death.ts"];
    const diff = files
      .map((f) =>
        fileDiff(`src/lib/${f}`, [
          "  const hush = sitDays >= 2 ? quiet : loud;",
          "  for (let i = 0; i < n; i++) {}",
          "  if (items.length === 0) return;",
          "  // sitDays >= 2 in a comment does not count",
        ]),
      )
      .join("\n");
    const f = analyzeTreeShapeDiff(diff);
    assert.equal(f.repeatedPredicates.length, 1);
    assert.equal(f.repeatedPredicates[0]!.predicate, "sitDays >= 2");
    assert.equal(f.repeatedPredicates[0]!.files, 5);
    assert.equal(f.repeatedPredicates[0]!.count, 5);
    // Under the bar: three files.
    const under = files
      .slice(0, SHAPE_PREDICATE_FILES - 1)
      .map((x) => fileDiff(`src/lib/${x}`, ["  if (sitDays >= 2) {}"]))
      .join("\n");
    assert.equal(analyzeTreeShapeDiff(under).repeatedPredicates.length, 0);
  });

  it("history comments, constant flags, and assets", () => {
    const diff = [
      fileDiff("src/lib/pet-face.ts", [
        "// The gaze used to follow the cursor; it no longer does.",
        "# previously the face blinked on every tick",
        "/* was once a caption */",
        "const x = 1; // not a history note",
        "// We now draw the chew on the stage.",
        "export const ritualXpVisible = false;",
        "export const ritualXpFlashVisible: boolean = false;",
        "export const RATE = 3;",
      ]),
      fileDiff("images/death-care-look.png", [], { newFile: true }),
      "diff --git a/images/shot.png b/images/shot.png",
      "new file mode 100644",
      "Binary files /dev/null and b/images/shot.png differ",
      fileDiff("images/leftover-beat-look.html", ["<html></html>"], { newFile: true }),
    ].join("\n");
    const f = analyzeTreeShapeDiff(diff);
    assert.equal(f.historyComments, 4);
    assert.deepEqual(
      f.constantFlags.map((c) => c.name),
      ["ritualXpVisible", "ritualXpFlashVisible"],
    );
    assert.deepEqual(
      [...f.assetsAdded].sort(),
      ["images/death-care-look.png", "images/leftover-beat-look.html", "images/shot.png"],
    );
  });

  it("untracked files count as all-added new modules", () => {
    const f = analyzeTreeShapeDiff("", {
      untracked: [
        { path: "src/lib/voice.ts", content: "export function mealCaption(f: string) { return f; }\nexport const A = 1;\n" },
        { path: "images/new-look.png", content: "" },
        { path: "tests/voice.test.ts", content: "export const t = 1;" },
      ],
    });
    assert.equal(f.newModules, 1);
    assert.equal(f.netExports, 2);
    assert.equal(f.exportsInExistingFiles, 0);
    assert.deepEqual(f.assetsAdded, ["images/new-look.png"]);
  });
});

describe("tree-shape — trips and hold arithmetic", () => {
  const base = () => analyzeTreeShapeDiff("");

  it("export sprawl trips on exports-per-new-module, not on volume alone", () => {
    const sprawl = { ...base(), exportsInExistingFiles: 60, netExports: 60, newModules: 2 };
    assert.ok(treeShapeTrips(sprawl).some((t) => t.key === "export-sprawl"));
    // 60 exports across 6 new modules is a build-out.
    const build = { ...base(), exportsInExistingFiles: 60, netExports: 120, newModules: 6 };
    assert.ok(!treeShapeTrips(build).some((t) => t.key === "export-sprawl"));
    const small = { ...base(), exportsInExistingFiles: SHAPE_EXPORT_SPRAWL_MIN - 1, newModules: 0 };
    assert.ok(!treeShapeTrips(small).some((t) => t.key === "export-sprawl"));
  });

  it("every other trip has a threshold and a value the hold can watch", () => {
    const f = {
      ...base(),
      wideSignatures: [{ file: "a.ts", name: "resolveHomeIntent", arity: 15 }],
      repeatedPredicates: [{ predicate: "sitDays >= 2", files: 14, count: 114 }],
      historyComments: SHAPE_HISTORY_COMMENTS,
      constantFlags: [{ file: "a.ts", name: "ritualXpVisible" }, { file: "a.ts", name: "ritualXpFlashVisible" }],
      unreferencedAssets: ["images/a.png", "images/b.png", "images/c.html"],
    };
    const trips = treeShapeTrips(f);
    const byKey = Object.fromEntries(trips.map((t) => [t.key, t.value]));
    assert.deepEqual(byKey, {
      "wide-signature": 15,
      "repeated-predicate": 14,
      "history-comments": SHAPE_HISTORY_COMMENTS,
      "constant-flags": 2,
      "unreferenced-assets": 3,
    });
    assert.match(trips.find((t) => t.key === "wide-signature")!.text, /resolveHomeIntent.*15/);
    assert.match(trips.find((t) => t.key === "repeated-predicate")!.text, /sitDays >= 2.*14 files/);
  });

  it("unimproved = present in both snapshots and not smaller; status/admit/clause name the trips", () => {
    const f1 = { ...base(), repeatedPredicates: [{ predicate: "sitDays >= 2", files: 5, count: 9 }], historyComments: 12 };
    const s1 = snapshotFromFacts(f1, { wave: 4 });
    const f2 = { ...f1, repeatedPredicates: [{ predicate: "sitDays >= 2", files: 7, count: 20 }], historyComments: 11 };
    const s2 = snapshotFromFacts(f2, { wave: 8 });
    assert.deepEqual(unimprovedTrips(s1, s2), ["repeated-predicate"]);
    assert.deepEqual(unimprovedTrips(undefined, s2), []);
    const clean = snapshotFromFacts(base(), { wave: 12 });
    assert.deepEqual(unimprovedTrips(s2, clean), []);
    assert.match(formatTreeShapeStatusLine(s2, false) || "", /⚠ 2 trip\(s\) at w8.*`sitDays >= 2` in 7 files.*11 history comments/);
    assert.match(formatTreeShapeStatusLine(s2, true) || "", /HOLD/);
    assert.match(formatTreeShapeStatusLine(clean, false) || "", /Tree shape: ok at w12/);
    const admit = formatTreeShapeHoldAdmit(s2, ["repeated-predicate"]);
    assert.match(admit, /did not improve since the last consolidation/);
    assert.match(admit, /sitDays >= 2/);
    assert.doesNotMatch(admit, /narrate the change/, "only the unimproved trip is listed");
    assert.match(formatTreeShapeConsolidationClause(s2) || "", /COLLAPSE, not "fix real defects only"/);
    assert.equal(formatTreeShapeConsolidationClause(clean), undefined);
  });

  it("Must-fix carries the trips", () => {
    const holes = ledgerMustFixItems({ waves: [], treeShapeTrips: ["export sprawl — +60 exports"] });
    assert.deepEqual(holes, ["Tree shape: export sprawl — +60 exports"]);
  });
});

/* ----------------------------------------------------------------------- */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/**
 * A repo whose modules already exist: the waves below *modify* them, so
 * the edit kind is control-flow on a different file each time and neither
 * the sibling-mill nor the same-surface hold is what the test exercises.
 */
function initRepo(existing: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-shape-repo-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "lib", "core.ts"), "export const core = 1;\n");
  for (const f of existing) {
    fs.writeFileSync(
      path.join(dir, "src", "lib", `${f}.ts`),
      `export function ${f.replace(/-/g, "")}Line(sitDays: number) {\n  return 'loud';\n}\n`,
    );
  }
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"shape","scripts":{"test":"true"}}\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const MOOD_FILES = ["mood", "badge", "insight", "first-hour", "death", "ticker", "loot", "memorial", "stomach"];

/** Distinct closers per file — the same-surface closer overlap must not be what trips. */
const MOOD_CLOSERS: Record<string, string> = {
  mood: "Wave shipped: JOY drops slower once the player has settled in — `mood.ts` `applyDecay`. Verify: npm test — exit 0.",
  badge: "Wave shipped: toolbar title stops lecturing for a returning visitor — `badge.ts` `careBadgeTitle`. Verify: npm test — exit 0.",
  insight: "Wave shipped: the bubble skips the tutorial voice for regulars — `insight.ts` `pickInsight`. Verify: npm test — exit 0.",
  "first-hour": "Wave shipped: onboarding card hides itself for anyone past day two — `first-hour.ts` `guideVisible`. Verify: npm test — exit 0.",
  death: "Wave shipped: memorial copy is terse for a veteran keeper — `death.ts` `eulogyLine`. Verify: npm test — exit 0.",
  ticker: "Wave shipped: 12s beat quiets its exclamation marks with tenure — `ticker.ts` `beatCopy`. Verify: npm test — exit 0.",
  loot: "Wave shipped: nutrition sheet collapses to one row for regulars — `loot.ts` `lootRows`. Verify: npm test — exit 0.",
  memorial: "Wave shipped: gravestone omits the how-to for old hands — `memorial.ts` `stoneText`. Verify: npm test — exit 0.",
  stomach: "Wave shipped: flask label drops the explainer for tenured players — `stomach.ts` `flaskCaption`. Verify: npm test — exit 0.",
};

function withHome(fn: () => void): void {
  const prev = process.env.FORGE_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-shape-home-"));
  process.env.FORGE_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("tree-shape — measure against a real tree", () => {
  it("measures the cumulative diff from the arm-time HEAD, untracked included, and finds unreferenced assets", () => {
    const repo = initRepo();
    try {
      const base = gitHeadSha(repo)!;
      assert.match(base, /^[0-9a-f]{40}$/);
      // Four files fork one predicate; one look nobody references; one sprite the manifest names.
      for (const f of ["a", "b", "c", "d"]) {
        fs.writeFileSync(
          path.join(repo, "src", "lib", `${f}.ts`),
          `export function ${f}Line(sitDays: number) { return sitDays >= 2 ? 'hush' : 'loud'; }\n`,
        );
      }
      fs.mkdirSync(path.join(repo, "images"));
      fs.writeFileSync(path.join(repo, "images", "death-look.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      fs.writeFileSync(path.join(repo, "images", "sprite.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      fs.writeFileSync(path.join(repo, "src", "lib", "core.ts"), "export const core = 1;\nexport const ICON = 'images/sprite.png';\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "wave");
      // Plus an untracked new module.
      fs.writeFileSync(path.join(repo, "src", "lib", "e.ts"), "export function eLine(sitDays: number) { return sitDays >= 2; }\n");

      const snap = measureTreeShape({ cwd: repo, base, wave: 4 })!;
      assert.ok(snap, "measured");
      assert.equal(snap.facts.newModules, 5, "a–d committed + e untracked");
      assert.equal(snap.facts.repeatedPredicates[0]?.predicate, "sitDays >= 2");
      assert.equal(snap.facts.repeatedPredicates[0]?.files, 5);
      assert.deepEqual([...snap.facts.assetsAdded].sort(), ["images/death-look.png", "images/sprite.png"]);
      assert.deepEqual(snap.facts.unreferencedAssets, ["images/death-look.png"]);
      assert.ok(snap.tripKeys.includes("repeated-predicate"));
      assert.deepEqual(findUnreferencedAssets(repo, ["images/sprite.png"]), []);
      // Nothing to measure without a base or outside a repo.
      assert.equal(measureTreeShape({ cwd: repo, base: undefined, wave: 1 }), null);
      assert.equal(measureTreeShape({ cwd: os.tmpdir(), base, wave: 1 }), null);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("consolidation measures; an unimproved trip at the next consolidation holds Stop until a ship shrinks it", () => {
    withHome(() => {
      const repo = initRepo(MOOD_FILES);
      try {
        const sid = "shape-run";
        fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
        armUlwCycle(sid, "make `src/lib/mood.ts` and its callers hush the lecture after two sit days; npm test must pass", {
          cycle: 1,
          skipCheckpoint: true,
          editCount: 0,
          cwd: repo,
        });
        markUlwPlanDone(
          sid,
          `Reading: hush the lecture after two sit days across the callers. Ship: ${MOOD_FILES.map((f) => `src/lib/${f}.ts`).join(", ")}. Verify: npm test.`,
        );
        let s = loadUlwCycle(sid)!;
        assert.match(s.startHead || "", /^[0-9a-f]{40}$/, "arm recorded HEAD");

        let edits = 0;
        const files = MOOD_FILES.slice(0, 8);
        const ship = (i: number) => {
          const f = files[i]!;
          fs.writeFileSync(
            path.join(repo, "src", "lib", `${f}.ts`),
            `export function ${f.replace(/-/g, "")}Line(sitDays: number) {\n  if (sitDays >= 2) return 'hush';\n  return 'loud';\n}\n`,
          );
          edits += 6;
          return maybeStampUlwWave({
            sessionId: sid,
            editCount: edits,
            openTodoCount: 0,
            stepsSinceStamp: 1,
            lastAssistantMessage: MOOD_CLOSERS[f]!,
            verificationPassed: true,
            changedPaths: [`src/lib/${f}.ts`],
            cwd: repo,
          });
        };
        // Waves 1–4: the 4th is a consolidation and measures.
        for (let i = 0; i < CONSOLIDATION_EVERY; i++) assert.equal(ship(i).stamped, true, `wave ${i + 1}`);
        s = loadUlwCycle(sid)!;
        assert.equal(s.wave, CONSOLIDATION_EVERY);
        assert.ok(s.treeShape, "measured at w4");
        assert.equal(s.treeShape!.atWave, CONSOLIDATION_EVERY);
        assert.ok(s.treeShape!.tripKeys.includes("repeated-predicate"), JSON.stringify(s.treeShape!.tripValues));
        assert.equal(treeShapeHolding(s), false, "first trip is a warning, not a hold");
        assert.ok(s.midReflectHoles?.some((h) => /Tree shape: `sitDays >= 2`/.test(h)), JSON.stringify(s.midReflectHoles));
        assert.match(formatUlwStatus(s), /Tree shape: ⚠ 1 trip\(s\) at w4/);

        // Waves 5–8: the predicate keeps spreading; w8 re-measures — unimproved → hold.
        for (let i = CONSOLIDATION_EVERY; i < 2 * CONSOLIDATION_EVERY; i++) {
          const r = ship(i);
          assert.equal(r.stamped, true, `wave ${i + 1}: ${r.admit}`);
        }
        s = loadUlwCycle(sid)!;
        assert.equal(s.wave, 2 * CONSOLIDATION_EVERY);
        assert.equal(treeShapeHolding(s), true, "same trip, bigger number, two consolidations");
        assert.deepEqual(s.treeShapeHold!.keys, ["repeated-predicate"]);
        assert.match(formatUlwStatus(s), /Tree shape: HOLD/);

        // A 9th fork at Stop is blocked with the collapse admit.
        fs.writeFileSync(path.join(repo, "src", "lib", "stomach.ts"), "export function stomachLine(sitDays: number) {\n  if (sitDays >= 2) return 'hush';\n  return 'loud';\n}\n");
        edits += 6;
        notePlayLoopRan(sid);
        const blocked = evaluateUlwAtStop({
          sessionId: sid,
          lastAssistantMessage: MOOD_CLOSERS.stomach!,
          editCount: edits,
          openTodoCount: 0,
          stuckThreshold: 5,
          verificationPassed: true,
          changedPaths: ["src/lib/stomach.ts"],
          cwd: repo,
        });
        assert.equal(blocked.block, true);
        assert.equal(blocked.shapeDemanded, true, blocked.reanchor);
        assert.match(blocked.reanchor || "", /did not improve since the last consolidation/);
        assert.match(blocked.reanchor || "", /sitDays >= 2/);
        s = loadUlwCycle(sid)!;
        assert.equal(s.wave, 2 * CONSOLIDATION_EVERY, "the fork did not stamp");
        assert.equal(s.treeShapeHold!.admits, 1);

        // The collapse: one predicate home, callers import it — the number goes down, Stop releases.
        fs.writeFileSync(path.join(repo, "src", "lib", "sit.ts"), "export function isSitting(sitDays: number) {\n  return sitDays >= 2;\n}\n");
        for (const f of [...files, "stomach"]) {
          fs.writeFileSync(
            path.join(repo, "src", "lib", `${f}.ts`),
            `import { isSitting } from './sit.js';\nexport function ${f.replace(/-/g, "")}Line(sitDays: number) {\n  if (isSitting(sitDays)) return 'hush';\n  return 'loud';\n}\n`,
          );
        }
        edits += 6;
        notePlayLoopRan(sid);
        const released = evaluateUlwAtStop({
          sessionId: sid,
          lastAssistantMessage: "Wave shipped: one sitting predicate — `sit.ts` `isSitting`; nine callers import it. Verify: npm test — exit 0.",
          editCount: edits,
          openTodoCount: 0,
          stuckThreshold: 5,
          verificationPassed: true,
          changedPaths: ["src/lib/sit.ts", ...files.map((f) => `src/lib/${f}.ts`), "src/lib/stomach.ts"],
          cwd: repo,
        });
        assert.equal(released.shapeDemanded, undefined, released.reanchor);
        s = loadUlwCycle(sid)!;
        assert.equal(treeShapeHolding(s), false);
        assert.equal(s.treeShape!.tripKeys.includes("repeated-predicate"), false, "re-measured: the predicate has one home");
        assert.equal(s.wave, 2 * CONSOLIDATION_EVERY + 1, "the collapse stamped");
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  it("/cycle 0 clears the hold; FORGE_TREE_SHAPE=0 never measures", () => {
    withHome(() => {
      const repo = initRepo(MOOD_FILES);
      const prev = process.env.FORGE_TREE_SHAPE;
      try {
        process.env.FORGE_TREE_SHAPE = "0";
        const sid = "shape-off";
        fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
        armUlwCycle(sid, "make `src/lib/mood.ts` hush the lecture; npm test must pass", { cycle: 1, skipCheckpoint: true, editCount: 0, cwd: repo });
        markUlwPlanDone(sid, "Reading: hush. Ship: src/lib/mood.ts. Verify: npm test.");
        let edits = 0;
        for (let i = 0; i < CONSOLIDATION_EVERY; i++) {
          const f = MOOD_FILES[i]!;
          fs.writeFileSync(
            path.join(repo, "src", "lib", `${f}.ts`),
            `export function ${f.replace(/-/g, "")}Line(sitDays: number) {\n  if (sitDays >= 2) return 'hush';\n  return 'loud';\n}\n`,
          );
          edits += 6;
          maybeStampUlwWave({
            sessionId: sid,
            editCount: edits,
            openTodoCount: 0,
            stepsSinceStamp: 1,
            lastAssistantMessage: MOOD_CLOSERS[f]!,
            verificationPassed: true,
            changedPaths: [`src/lib/${f}.ts`],
            cwd: repo,
          });
        }
        const s = loadUlwCycle(sid)!;
        assert.equal(s.wave, CONSOLIDATION_EVERY);
        assert.equal(s.treeShape, undefined);
      } finally {
        if (prev === undefined) delete process.env.FORGE_TREE_SHAPE;
        else process.env.FORGE_TREE_SHAPE = prev;
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
    withHome(() => {
      const sid = "shape-cycle0";
      fs.mkdirSync(path.join(process.env.FORGE_HOME!, "sessions", sid), { recursive: true });
      armUlwCycle(sid, "make `src/lib/mood.ts` hush the lecture; npm test must pass", { cycle: 1, skipCheckpoint: true, editCount: 0 });
      // Hand-arm a hold on the sidecar and make sure /cycle 0 releases it.
      const s = loadUlwCycle(sid)!;
      s.treeShape = snapshotFromFacts(
        { ...analyzeTreeShapeDiff(""), historyComments: 20 },
        { wave: 8 },
      );
      s.treeShapeHold = { keys: ["history-comments"], since: 8, admits: 0 };
      // saveUlwCycle is internal to the module's own writers; go through a public mutation.
      fs.writeFileSync(
        path.join(process.env.FORGE_HOME!, "sessions", sid, "ulw.json"),
        JSON.stringify(s),
      );
      assert.equal(treeShapeHolding(loadUlwCycle(sid)!), true);
      scheduleCycleZeroStop(sid);
      assert.equal(treeShapeHolding(loadUlwCycle(sid)!), false);
    });
  });
});
