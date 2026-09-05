/**
 * Tree-shape meter — what the run is growing, not whether it is moving.
 *
 * Every ULW rule before this one measured stalling: thin waves, churn,
 * the same file three times, mill siblings, no proof. The HashPet dogfood
 * (791 waves, 599 commits, $740) satisfied all of them — proof ✓ on 256 of
 * 256 retained waves, job-move 75%, same-surface streak never above 1 —
 * while `resolveHomeIntent` went from 4 to 15 arguments, 197 → 637
 * `export function`s landed in the same ~40 files, `sitDays >= 2` appeared
 * in 114 places, 319 comments narrated the change ("X used to Y"), a
 * hard-`false` flag kept eight assertions alive, and 78 unreferenced look
 * PNG/HTML files were committed. Grok scored architecture 74 → 36. Nothing
 * in the harness had a number for any of it.
 *
 * This module reads the run's cumulative diff (`git diff <head-at-arm>`,
 * plus untracked files) at every consolidation wave and reports facts:
 * exports added to existing files vs new modules, the widest added
 * signature, one predicate literal repeated across files, change-history
 * comments, exported constant booleans, new image/HTML files nothing
 * references. A **trip** is a fact past its threshold. Trips fill the
 * consolidation Must-fix, flip the consolidation prompt from "fix real
 * defects only" to "collapse: <trip>", ride `/cycle status`, and — when
 * the same trip is still there and no better at the next consolidation —
 * hold unlimited ULW until a ship moves that number down or /cycle 0.
 *
 * Facts only; thresholds are exported constants. Kill-switches:
 * FORGE_TREE_SHAPE=0 (meter off), FORGE_TREE_SHAPE_HOLD=0 (meter on, hold off).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createChildEnv } from "../agent/tools/env-policy.js";
import { isFalsy } from "../util/bool.js";
import { productionRelPaths } from "./job-delta.js";

export function treeShapeEnabled(): boolean {
  return !isFalsy(process.env.FORGE_TREE_SHAPE ?? "1");
}
export function treeShapeHoldEnabled(): boolean {
  return treeShapeEnabled() && !isFalsy(process.env.FORGE_TREE_SHAPE_HOLD ?? "1");
}

/** Exports added to *existing* production files before sprawl is a trip… */
export const SHAPE_EXPORT_SPRAWL_MIN = 30;
/** …when they outnumber new modules by this ratio (30 exports / 2 modules = 15). */
export const SHAPE_EXPORTS_PER_MODULE = 15;
/** An added function signature with this many parameters is a context object in denial. */
export const SHAPE_WIDE_ARITY = 7;
/** One predicate literal in this many distinct files. */
export const SHAPE_PREDICATE_FILES = 4;
/** Change-history comments ("used to", "no longer") before the trip. */
export const SHAPE_HISTORY_COMMENTS = 10;
/** Exported constant booleans (`export const xVisible = false`). */
export const SHAPE_CONSTANT_FLAGS = 2;
/** New image / HTML files no production file references. */
export const SHAPE_UNREFERENCED_ASSETS = 3;
/** Diff bytes read before the meter gives up (a 30 MB diff is not a shape). */
export const SHAPE_DIFF_CAP = 6 * 1024 * 1024;
/** Asset reference lookups per measure. */
const ASSET_LOOKUP_CAP = 40;

export type TreeShapeTripKey =
  | "export-sprawl"
  | "wide-signature"
  | "repeated-predicate"
  | "history-comments"
  | "constant-flags"
  | "unreferenced-assets";

export interface TreeShapeFacts {
  /** `export`-class declarations added minus removed, in production files. */
  netExports: number;
  /** Added exports that landed in files that already existed. */
  exportsInExistingFiles: number;
  /** New production files in the diff. */
  newModules: number;
  /** Added function signatures with SHAPE_WIDE_ARITY+ parameters. */
  wideSignatures: Array<{ file: string; name: string; arity: number }>;
  /** Predicate literal → distinct files it was added to (only those over the bar). */
  repeatedPredicates: Array<{ predicate: string; files: number; count: number }>;
  /** Added comment lines that narrate the change. */
  historyComments: number;
  /** Added `export const x = true|false`. */
  constantFlags: Array<{ file: string; name: string }>;
  /** New image / HTML files in the diff. */
  assetsAdded: string[];
  /** Those with no reference from any tracked non-asset file (needs a tree). */
  unreferencedAssets: string[];
  /** Production files touched. */
  filesTouched: number;
}

export interface TreeShapeTrip {
  key: TreeShapeTripKey;
  /** The number the hold watches — must go down to release. */
  value: number;
  text: string;
}

export interface TreeShapeSnapshot {
  atWave: number;
  measuredAt: string;
  /** `git diff <base>` — HEAD at arm. */
  base: string;
  facts: TreeShapeFacts;
  /** Trip texts (ledger / Must-fix), parallel to `tripKeys`. */
  trips: string[];
  tripKeys: TreeShapeTripKey[];
  tripValues: Partial<Record<TreeShapeTripKey, number>>;
}

const ASSET_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|html?)$/i;

const EXPORT_RE =
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\b|^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|mod)\b|^(?:def|class)\s+[A-Za-z_]|^func\s+(?:\([^)]*\)\s*)?[A-Z]/;

const HISTORY_COMMENT_RE =
  /\bused to\b|\bno longer\b|\bpreviously\b|\bformerly\b|\bwas once\b|\bbefore this (?:change|wave|fix|commit)\b|\bwe now\b|\binstead of the old\b|\bthe old (?:way|code|path|behaviou?r)\b/i;

const COMMENT_LINE_RE = /^\s*(?:\/\/|#(?!\[)|\/\*|\*)/;

const CONSTANT_FLAG_RE =
  /^\s*export\s+const\s+([A-Za-z_]\w*)\s*(?::\s*boolean)?\s*=\s*(?:true|false)\s*;?\s*(?:\/\/.*)?$/;

/** `ident op literal` — the shape of `sitDays >= 2`. */
const PREDICATE_RE =
  /\b([A-Za-z_][\w.]*)\s*(>=|<=|===|!==|==|!=|>|<)\s*(-?\d+(?:\.\d+)?|true|false|null|None|'[^'\n]{1,40}'|"[^"\n]{1,40}")/g;
/** Loop counters and length checks are not an idea. */
const GENERIC_PREDICATE_IDENT_RE =
  /^(?:i|j|k|n|len|length|size|count|index|idx|\w+\.length|\w+\.size|\w+\.count|argc|status|code|exitCode|res\.status|response\.status)$/;

const SIG_OPEN_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\((.*)$|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:<[^>]*>)?\((.*)$|^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\((.*)$|^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\((.*)$/;

function countTopLevelParams(inner: string): number {
  let depth = 0;
  let count = 0;
  let seen = false;
  for (const ch of inner) {
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      count++;
      seen = true;
    } else if (!/\s/.test(ch)) seen = true;
  }
  return seen ? count + 1 : 0;
}

function closeParenIndex(rest: string): number {
  let depth = 1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function normalizeRel(p: string): string {
  return p.replace(/^[ab]\//, "").replace(/\\/g, "/").trim();
}

function isTestish(rel: string): boolean {
  return productionRelPaths([rel]).length === 0;
}

/**
 * Pure: facts from a unified diff. `newFiles` lets the caller add
 * untracked files (all-added) that `git diff` does not show.
 */
export function analyzeTreeShapeDiff(
  diff: string,
  opts?: { untracked?: Array<{ path: string; content: string }> },
): TreeShapeFacts {
  const facts: TreeShapeFacts = {
    netExports: 0,
    exportsInExistingFiles: 0,
    newModules: 0,
    wideSignatures: [],
    repeatedPredicates: [],
    historyComments: 0,
    constantFlags: [],
    assetsAdded: [],
    unreferencedAssets: [],
    filesTouched: 0,
  };
  const predicateFiles = new Map<string, { files: Set<string>; count: number }>();
  const touched = new Set<string>();
  let file = "";
  let isNew = false;
  let production = false;
  // Multi-line signature collection.
  let sig: { name: string; params: number } | null = null;

  const addedLine = (body: string) => {
    if (!production) return;
    // Signature spanning lines: `function f(` … params one per line … `)`.
    if (sig) {
      if (/^\s*\)/.test(body)) {
        if (sig.params >= SHAPE_WIDE_ARITY) {
          facts.wideSignatures.push({ file, name: sig.name, arity: sig.params });
        }
        sig = null;
      } else if (/^\s*[A-Za-z_$*{[][\w$]*/.test(body) && !/^\s*(?:\/\/|\*)/.test(body)) {
        sig.params += 1;
      }
    }
    if (EXPORT_RE.test(body)) {
      facts.netExports += 1;
      if (!isNew) facts.exportsInExistingFiles += 1;
    }
    const cf = body.match(CONSTANT_FLAG_RE);
    if (cf) facts.constantFlags.push({ file, name: cf[1]! });
    if (COMMENT_LINE_RE.test(body) && HISTORY_COMMENT_RE.test(body)) {
      facts.historyComments += 1;
    }
    const sm = body.match(SIG_OPEN_RE);
    if (sm) {
      const name = sm[1] || sm[3] || sm[5] || sm[7] || "";
      const rest = sm[2] ?? sm[4] ?? sm[6] ?? sm[8] ?? "";
      const close = closeParenIndex(rest);
      if (close >= 0) {
        const arity = countTopLevelParams(rest.slice(0, close));
        if (arity >= SHAPE_WIDE_ARITY) {
          facts.wideSignatures.push({ file, name, arity });
        }
      } else if (!rest.trim() || /^\s*(?:\/\/.*)?$/.test(rest)) {
        sig = { name, params: 0 };
      } else {
        // First params on the opening line, rest below.
        sig = { name, params: countTopLevelParams(rest.replace(/,\s*$/, "")) };
      }
    }
    if (!COMMENT_LINE_RE.test(body)) {
      let m: RegExpExecArray | null;
      PREDICATE_RE.lastIndex = 0;
      while ((m = PREDICATE_RE.exec(body)) !== null) {
        const ident = m[1]!;
        if (GENERIC_PREDICATE_IDENT_RE.test(ident)) continue;
        const key = `${ident} ${m[2]} ${m[3]}`;
        const rec = predicateFiles.get(key) ?? { files: new Set<string>(), count: 0 };
        rec.files.add(file);
        rec.count += 1;
        predicateFiles.set(key, rec);
      }
    }
  };

  const startFile = (rel: string, fresh: boolean) => {
    file = rel;
    isNew = fresh;
    sig = null;
    production = !isTestish(rel) && !ASSET_EXT_RE.test(rel);
    if (production) touched.add(rel);
    if (fresh && production) facts.newModules += 1;
    if (fresh && ASSET_EXT_RE.test(rel)) facts.assetsAdded.push(rel);
  };

  const text = diff.length > SHAPE_DIFF_CAP ? diff.slice(0, SHAPE_DIFF_CAP) : diff;
  let pendingNew = false;
  let pendingPath = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      pendingPath = m ? normalizeRel(m[2]!) : "";
      pendingNew = false;
      continue;
    }
    if (line.startsWith("new file mode")) {
      pendingNew = true;
      continue;
    }
    if (line.startsWith("Binary files ")) {
      if (pendingPath && pendingNew && ASSET_EXT_RE.test(pendingPath)) {
        facts.assetsAdded.push(pendingPath);
      }
      production = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const rel = line.slice(4).trim();
      if (rel === "/dev/null") {
        production = false;
        continue;
      }
      startFile(normalizeRel(rel), pendingNew);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("index ") || line.startsWith("@@")) {
      continue;
    }
    if (line.startsWith("+")) {
      addedLine(line.slice(1));
      continue;
    }
    if (line.startsWith("-") && production) {
      const body = line.slice(1);
      if (EXPORT_RE.test(body)) facts.netExports -= 1;
    }
  }
  for (const u of opts?.untracked ?? []) {
    startFile(normalizeRel(u.path), true);
    if (!production) continue;
    for (const l of (u.content || "").split("\n")) addedLine(l);
  }
  facts.filesTouched = touched.size;
  facts.repeatedPredicates = [...predicateFiles.entries()]
    .filter(([, v]) => v.files.size >= SHAPE_PREDICATE_FILES)
    .map(([predicate, v]) => ({ predicate, files: v.files.size, count: v.count }))
    .sort((a, b) => b.files - a.files || b.count - a.count)
    .slice(0, 5);
  facts.assetsAdded = [...new Set(facts.assetsAdded)];
  return facts;
}

/** Trips from facts. Pure. */
export function treeShapeTrips(f: TreeShapeFacts): TreeShapeTrip[] {
  const out: TreeShapeTrip[] = [];
  if (
    f.exportsInExistingFiles >= SHAPE_EXPORT_SPRAWL_MIN &&
    f.exportsInExistingFiles >= SHAPE_EXPORTS_PER_MODULE * Math.max(1, f.newModules)
  ) {
    out.push({
      key: "export-sprawl",
      value: f.exportsInExistingFiles,
      text: `export sprawl — +${f.exportsInExistingFiles} exports added to existing files against ${f.newModules} new module(s); one home per idea, not one export per surface`,
    });
  }
  if (f.wideSignatures.length) {
    const widest = f.wideSignatures.reduce((a, b) => (b.arity > a.arity ? b : a));
    out.push({
      key: "wide-signature",
      value: widest.arity,
      text: `${f.wideSignatures.length} signature(s) with ${SHAPE_WIDE_ARITY}+ parameters (widest \`${widest.name}\` ${widest.arity} in ${widest.file}) — thread one context object`,
    });
  }
  if (f.repeatedPredicates.length) {
    const top = f.repeatedPredicates[0]!;
    out.push({
      key: "repeated-predicate",
      value: top.files,
      text: `\`${top.predicate}\` added in ${top.files} files (${top.count} places) — one predicate, one function that owns it`,
    });
  }
  if (f.historyComments >= SHAPE_HISTORY_COMMENTS) {
    out.push({
      key: "history-comments",
      value: f.historyComments,
      text: `${f.historyComments} comments narrate the change ("used to", "no longer") — comments describe the code as it is; history lives in the closer and the commit`,
    });
  }
  if (f.constantFlags.length >= SHAPE_CONSTANT_FLAGS) {
    const names = f.constantFlags.slice(0, 3).map((c) => c.name).join(", ");
    out.push({
      key: "constant-flags",
      value: f.constantFlags.length,
      text: `${f.constantFlags.length} exported constant booleans (${names}) — a dead branch with a name; delete the branch`,
    });
  }
  if (f.unreferencedAssets.length >= SHAPE_UNREFERENCED_ASSETS) {
    out.push({
      key: "unreferenced-assets",
      value: f.unreferencedAssets.length,
      text: `${f.unreferencedAssets.length} new image/HTML files no production file references (${f.unreferencedAssets.slice(0, 2).join(", ")}, …) — looks belong under ~/.forge, not in the repo`,
    });
  }
  return out;
}

function git(args: string[], cwd: string, timeout = 8000, maxBuffer = SHAPE_DIFF_CAP + 1024 * 1024): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      maxBuffer,
      env: createChildEnv(),
    });
  } catch {
    return null;
  }
}

/** HEAD sha, for the arm-time base. Null outside a repo / on an unborn branch. */
export function gitHeadSha(cwd: string): string | null {
  const out = git(["rev-parse", "HEAD"], cwd, 3000);
  const sha = (out || "").trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Assets nothing references: `git grep -l -F <basename>` over tracked files
 * that are not themselves assets. Capped; a repo of sprites that are all
 * wired into a manifest costs one grep per new sprite.
 */
export function findUnreferencedAssets(cwd: string, assets: string[]): string[] {
  const out: string[] = [];
  for (const rel of assets.slice(0, ASSET_LOOKUP_CAP)) {
    const base = path.basename(rel);
    if (!base) continue;
    const hits = git(
      [
        "grep",
        "-l",
        "-I",
        "-F",
        base,
        "--",
        ".",
        ":!*.png",
        ":!*.jpg",
        ":!*.jpeg",
        ":!*.gif",
        ":!*.webp",
        ":!*.bmp",
        ":!*.ico",
        ":!*.html",
        ":!*.htm",
      ],
      cwd,
      4000,
    );
    // Untracked (not yet committed) referrers: check the dirty tree too.
    const referenced =
      Boolean(hits && hits.trim()) ||
      untrackedReferences(cwd, base);
    if (!referenced) out.push(rel);
  }
  return out;
}

function untrackedFiles(cwd: string): string[] {
  const out = git(["ls-files", "--others", "--exclude-standard"], cwd, 4000);
  return (out || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function untrackedReferences(cwd: string, needle: string): boolean {
  for (const rel of untrackedFiles(cwd).slice(0, 200)) {
    if (ASSET_EXT_RE.test(rel)) continue;
    try {
      const st = fs.statSync(path.join(cwd, rel));
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      if (fs.readFileSync(path.join(cwd, rel), "utf8").includes(needle)) return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

/**
 * Measure the run's cumulative shape: `git diff <base>` (tracked, committed
 * and dirty) plus untracked production files. Null outside a repo, when the
 * base is unknown, or when the meter is off.
 */
export function measureTreeShape(opts: {
  cwd: string;
  base: string | undefined;
  wave: number;
}): TreeShapeSnapshot | null {
  if (!treeShapeEnabled()) return null;
  if (!opts.base || !/^[0-9a-f]{7,40}$/.test(opts.base)) return null;
  const root = (git(["rev-parse", "--show-toplevel"], opts.cwd, 3000) || "").trim();
  if (!root) return null;
  const diff = git(["diff", opts.base, "--no-color", "--unified=0", "--", "."], root, 15000);
  if (diff == null) return null;
  const untracked: Array<{ path: string; content: string }> = [];
  for (const rel of untrackedFiles(root).slice(0, 200)) {
    if (ASSET_EXT_RE.test(rel)) {
      untracked.push({ path: rel, content: "" });
      continue;
    }
    if (isTestish(rel)) continue;
    try {
      const abs = path.join(root, rel);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      untracked.push({ path: rel, content: fs.readFileSync(abs, "utf8") });
    } catch {
      /* skip */
    }
  }
  const facts = analyzeTreeShapeDiff(diff, { untracked });
  if (facts.assetsAdded.length) {
    facts.unreferencedAssets = findUnreferencedAssets(root, facts.assetsAdded);
  }
  const trips = treeShapeTrips(facts);
  const tripValues: Partial<Record<TreeShapeTripKey, number>> = {};
  for (const t of trips) tripValues[t.key] = t.value;
  return {
    atWave: opts.wave,
    measuredAt: new Date().toISOString(),
    base: opts.base,
    facts,
    trips: trips.map((t) => t.text),
    tripKeys: trips.map((t) => t.key),
    tripValues,
  };
}

/** Snapshot from facts alone (tests, and callers that already have a diff). */
export function snapshotFromFacts(
  facts: TreeShapeFacts,
  opts: { wave: number; base?: string },
): TreeShapeSnapshot {
  const trips = treeShapeTrips(facts);
  const tripValues: Partial<Record<TreeShapeTripKey, number>> = {};
  for (const t of trips) tripValues[t.key] = t.value;
  return {
    atWave: opts.wave,
    measuredAt: new Date().toISOString(),
    base: opts.base ?? "",
    facts,
    trips: trips.map((t) => t.text),
    tripKeys: trips.map((t) => t.key),
    tripValues,
  };
}

/**
 * Trip keys present in both snapshots whose number did not go down — the
 * hold condition at a consolidation, and the "still there" test at Stop.
 */
export function unimprovedTrips(
  prev: TreeShapeSnapshot | undefined,
  next: TreeShapeSnapshot,
): TreeShapeTripKey[] {
  if (!prev) return [];
  const out: TreeShapeTripKey[] = [];
  for (const [k, v] of Object.entries(next.tripValues) as Array<[TreeShapeTripKey, number]>) {
    const before = prev.tripValues[k];
    if (before === undefined) continue;
    if (v >= before) out.push(k);
  }
  return out;
}

export function formatTreeShapeStatusLine(
  snap: TreeShapeSnapshot | undefined,
  hold: boolean,
): string | undefined {
  if (!snap) return undefined;
  const f = snap.facts;
  const bits = [
    `+${f.netExports} exports (${f.exportsInExistingFiles} in existing files, ${f.newModules} new module${f.newModules === 1 ? "" : "s"})`,
  ];
  if (f.wideSignatures.length) {
    const widest = f.wideSignatures.reduce((a, b) => (b.arity > a.arity ? b : a));
    bits.push(`widest new signature ${widest.arity} params`);
  }
  if (f.repeatedPredicates.length) {
    const top = f.repeatedPredicates[0]!;
    bits.push(`\`${top.predicate}\` in ${top.files} files`);
  }
  if (f.historyComments) bits.push(`${f.historyComments} history comments`);
  if (f.constantFlags.length) bits.push(`${f.constantFlags.length} constant flags`);
  if (f.unreferencedAssets.length) bits.push(`${f.unreferencedAssets.length} unreferenced assets`);
  const head = snap.trips.length
    ? hold
      ? `  Tree shape: HOLD — ${snap.trips.length} trip(s) unimproved since the last consolidation; collapse or /cycle 0`
      : `  Tree shape: ⚠ ${snap.trips.length} trip(s) at w${snap.atWave}`
    : `  Tree shape: ok at w${snap.atWave}`;
  return `${head} — ${bits.join(" · ")}`;
}

export function formatTreeShapeHoldAdmit(snap: TreeShapeSnapshot, keys: TreeShapeTripKey[]): string {
  const lines = snap.trips.filter((_, i) => {
    const k = snap.tripKeys[i];
    return !k || keys.includes(k);
  });
  return [
    `[Forge ULW cycle driver] Stop blocked — the tree's shape did not improve since the last consolidation (measured at w${snap.atWave}).`,
    ...(lines.length ? lines : snap.trips).map((t) => `- ${t}`),
    "This wave is a collapse, not a surface: make one of those numbers go down (delete the forks, thread the context object, move the looks out) and prove it with the full suite. Re-measured at your next Stop; the first decrease releases. Or /cycle 0. Stuck-wall will not release this hold.",
  ].join("\n");
}

/** Consolidation prompt clause when trips exist. */
export function formatTreeShapeConsolidationClause(snap: TreeShapeSnapshot | undefined): string | undefined {
  if (!snap?.trips.length) return undefined;
  return `TREE SHAPE tripped at w${snap.atWave}: ${snap.trips.map((t) => `(${t})`).join(" ")}. This consolidation is a COLLAPSE, not "fix real defects only": pick one trip and make its number go down — one formatter/table the surfaces import, one context object instead of the argument list, delete the dead flag and its assertions, move the look files out of the repo. Prove with the full suite. A collapse is a job move.`;
}
