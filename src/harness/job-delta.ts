/**
 * Job-delta credit — tree and tests, not closer poetry.
 *
 * Pin-only = stdout/stderr/help/source-text asserts without a production
 * function return/state check. Language-agnostic (JS assert.match, Python
 * assertIn). A production file whose diff is string-literal / TTY / help
 * plus those pins is chrome, not a job. Second consecutive chrome ship
 * does not increment w.
 */
import fs from "node:fs";
import path from "node:path";
import { gitUnifiedDiff } from "../util/git-context.js";
import { isTestOrHarnessPath, isWaveTestPath } from "./tests-without-body.js";

const PIN_API_RE =
  /\bpinPresent\s*\(|\bpinAbsent\s*\(|\breadSrc\s*\(|\breadSrcMany\s*\(/;
const RAW_READ_RE = /\breadFileSync\s*\(/;
const JS_PROD_IMPORT_RE = /from\s+['"](?:\.\.\/)+src\//;
const ASSERT_RE =
  /\bassert\.(?:equal|deepEqual|strictEqual|notEqual|ok|match|doesNotMatch)\s*\(/;

/** Second consecutive css/md/test-only (or string-literal production) ship does not increment w. */
export const CHROME_PATH_HOLD = 1;

export const PIN_ONLY_ADMIT = [
  "[Forge harness — mid-conversation update]",
  "Wave shipped on pin-only tests does not increment w.",
  "TTY / help / source-text pins (assertIn, assert.match on stdout) are not proof. Assert a production function's return or state, or run a play-loop.",
  "Unlimited ULW continues. This w=N/M is the only wave number.",
].join("\n");

export const JOB_FLAT_ADMIT = [
  "[Forge harness — mid-conversation update]",
  "Wave shipped on chrome-only paths (css / markdown / tests / string-literal TTY) does not increment w after the first of that class.",
  "Batch a production play-path, architecture, or play-loop so the job moves. Unlimited ULW continues.",
  "This w=N/M is the only wave number.",
].join("\n");

/** Second consecutive slash-peek remainder does not increment w. */
export const PEEK_MILL_HOLD = 1;

export const PEEK_MILL_ADMIT = [
  "[Forge harness — mid-conversation update]",
  "Wave shipped on a slash-peek remainder (formatXCard / catalog dump) does not increment w after the first of that class.",
  "A leftover dump is not a new job. Different class or /cycle 0.",
  "This w=N/M is the only wave number.",
].join("\n");

export const REORIENT_EVIDENCE_ADMIT = [
  "[Forge ULW cycle driver] Stop blocked — PLAN is re-armed and a new Reading is not a ticket.",
  "Named-ship exhaust / same-surface hold requires a real look: one explore child (parseable map) or a play-loop.",
  "Then write the Reading. A new noun is not a new class. A red test suite or open defect is a different class.",
  "Unlimited ULW continues. Or /cycle 0.",
].join("\n");

export type WaveTestProofKind = "behavioral" | "pin-only" | "none";

export type ProdEditKind =
  | "string-literal"
  | "tty"
  | "control-flow"
  | "new-module"
  | "unknown";

export type StampJobDecision =
  | { ok: true; chrome: boolean; kind: ProdEditKind }
  | {
      ok: false;
      reason: "pin" | "chrome" | "peek";
      admit: string;
      kind: ProdEditKind;
    };

const PY_STDLIB_RE =
  /^(os|sys|re|json|unittest|pytest|pathlib|typing|io|textwrap|argparse|subprocess|tempfile|shutil|collections|functools|itertools|math|datetime|copy|enum|dataclasses|abc|contextlib|logging|traceback|inspect|struct|hashlib|base64|uuid|random|string|time|platform|glob|fnmatch|csv|configparser|unittest\.mock|mock)$/i;

const TTY_NAME_RE =
  /\b(?:stdout|stderr|std_out|std_err|getvalue|capfd|capsys|help_text|help_output|epilog|cli_output|captured|output|out\b|err\b)\b/i;

export function isChromeKind(kind: ProdEditKind | undefined): boolean {
  return kind === "string-literal" || kind === "tty";
}

function normPath(p: string): string {
  return (p || "").replace(/\\/g, "/").trim();
}

export function productionRelPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths || []) {
    const n = normPath(raw);
    if (!n || isChromeOnlyPath(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Surface key from the dirty tree, not the closer.
 * `kind:file|file` — same 1–3 production files + chrome-kind family = one surface.
 */
export function treeSurfaceKey(
  paths: string[],
  kind: ProdEditKind = "unknown",
): string {
  const prod = productionRelPaths(paths).sort().slice(0, 3);
  const k = isChromeKind(kind) ? "chrome" : kind;
  if (!prod.length) {
    const rest = (paths || [])
      .map(normPath)
      .filter(Boolean)
      .sort()
      .slice(0, 3);
    if (!rest.length) return "";
    return `chrome:${rest.join("|")}`;
  }
  return `${k}:${prod.join("|")}`;
}

export function sameTreeSurface(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = parseTreeKey(a);
  const pb = parseTreeKey(b);
  if (!pa.files.length || !pb.files.length) return false;
  const chromeA = pa.kind === "chrome" || isChromeKind(pa.kind as ProdEditKind);
  const chromeB = pb.kind === "chrome" || isChromeKind(pb.kind as ProdEditKind);
  const overlap = pa.files.some((f) => pb.files.includes(f));
  if (!overlap) return false;
  if (chromeA && chromeB) return true;
  return pa.kind === pb.kind;
}

function parseTreeKey(key: string): { kind: string; files: string[] } {
  const idx = key.indexOf(":");
  if (idx < 0) return { kind: "unknown", files: [] };
  return {
    kind: key.slice(0, idx) || "unknown",
    files: key
      .slice(idx + 1)
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function stripQuoted(s: string): string {
  return s
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""');
}

function isCommentOrBlank(l: string): boolean {
  const t = l.trim();
  return (
    !t ||
    t.startsWith("#") ||
    t.startsWith("//") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("*/")
  );
}

function isTtyLine(l: string): boolean {
  return (
    /\bprint\s*\(/.test(l) ||
    /\bconsole\.(?:log|error|info|warn|debug)\s*\(/.test(l) ||
    /\b(?:sys\.stderr|sys\.stdout|argparse|add_argument|formatter_class)\b/.test(
      l,
    ) ||
    /\b(?:stderr|stdout)\.(?:write|print)/.test(l) ||
    /\b(?:epilog|description|help)\s*=/.test(l) ||
    /\b(?:lines\.push|format\w*Card|chalk\.)/.test(l) ||
    /`[^`]*·[^`]*`/.test(l)
  );
}

function isStringLiteralLine(l: string): boolean {
  const t = l.trim();
  if (isCommentOrBlank(t)) return true;
  if (/^[\w.]+\s*=\s*['"`]/.test(t)) return true;
  if (/^['"`]/.test(t)) return true;
  if (/['"`]\s*,?\s*$/.test(t) && /['"`]/.test(t) && !isControlFlowLine(t)) {
    return true;
  }
  return false;
}

function isStringReturnLine(l: string): boolean {
  return /\breturn\s*(?:`|'|"|lines\.|String\()/.test(l);
}

function isControlFlowLine(l: string): boolean {
  if (isTtyLine(l) || isStringLiteralLine(l) || isStringReturnLine(l)) {
    return false;
  }
  const t = stripQuoted(l);
  if (!t.trim() || isCommentOrBlank(t)) return false;
  return (
    /\b(?:if|elif|else|for|while|switch|case|try|except|catch|finally|throw|raise|return|await|yield|break|continue|with|match)\b/.test(
      t,
    ) ||
    /\b(?:async\s+def|def|function|class)\b/.test(t) ||
    /=>|&&|\|\||===|!==/.test(t)
  );
}

export function classifyProdEditKindFromDiff(diff: string): ProdEditKind {
  const raw = String(diff || "");
  if (!raw.trim()) return "unknown";
  const isNewFile = /\bnew file mode\b/.test(raw);
  const changed: string[] = [];
  for (const line of raw.split("\n")) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("@@")
    ) {
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) {
      const body = line.slice(1);
      if (body.trim() && !/^[{}();,]+$/.test(body.trim())) changed.push(body);
    }
  }
  if (!changed.length) return "unknown";
  const flow = changed.filter(isControlFlowLine);
  const tty = changed.filter(isTtyLine);
  const decorative = changed.filter(
    (l) => isStringLiteralLine(l) || isTtyLine(l),
  ).length;
  // if/return wrapping string builders is still TTY chrome, not a job.
  if (decorative >= Math.ceil(changed.length * 0.7)) {
    return tty.length ? "tty" : "string-literal";
  }
  if (flow.length > 0) return isNewFile ? "new-module" : "control-flow";
  if (changed.every((l) => isStringLiteralLine(l) || isTtyLine(l))) {
    return tty.length ? "tty" : "string-literal";
  }
  return "unknown";
}

export function inspectProdEditKind(opts: {
  cwd?: string;
  paths?: string[];
  diffs?: Record<string, string>;
}): ProdEditKind {
  const prod = productionRelPaths(opts.paths || []);
  if (!prod.length) return "unknown";
  const kinds: ProdEditKind[] = [];
  for (const rel of prod) {
    const provided = opts.diffs?.[rel];
    if (typeof provided === "string") {
      kinds.push(classifyProdEditKindFromDiff(provided));
      continue;
    }
    if (opts.cwd) {
      try {
        const d = gitUnifiedDiff(opts.cwd, [rel]);
        if (d && d.trim()) {
          kinds.push(classifyProdEditKindFromDiff(d));
          continue;
        }
      } catch {
        /* git optional */
      }
    }
    kinds.push("unknown");
  }
  if (kinds.includes("new-module")) return "new-module";
  if (kinds.includes("control-flow")) return "control-flow";
  if (kinds.includes("tty")) return "tty";
  if (kinds.includes("string-literal")) return "string-literal";
  return "unknown";
}

function pythonProductionImports(src: string): string[] {
  const out: string[] = [];
  const re =
    /^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src || "")) !== null) {
    const mod = (m[1] || m[2] || "").split(".")[0] || "";
    if (!mod || PY_STDLIB_RE.test(mod) || /^tests?$/i.test(mod)) continue;
    out.push(mod);
  }
  return out;
}

function hasTtyOrSourcePin(src: string): boolean {
  const t = src || "";
  if (PIN_API_RE.test(t)) return true;
  if (RAW_READ_RE.test(t) && /\bassert\.match\b/.test(t)) return true;
  if (/\bassert(?:In|NotIn|Regex)\s*\(/.test(t) && TTY_NAME_RE.test(t)) {
    return true;
  }
  if (/\bassert\.(?:match|doesNotMatch)\s*\(/.test(t)) return true;
  if (
    /assert(?:Equal|strictEqual)\s*\(\s*(?:stdout|stderr|output|help|captured|text|body|out|err)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /assert\s+.{0,160}\bin\s+.{0,80}(?:stdout|stderr|output|help|getvalue|out\b|err\b)/i.test(
      t,
    )
  ) {
    return true;
  }
  if (TTY_NAME_RE.test(t) && /\bassert(?:In|NotIn|Equal|Regex|match)\b/i.test(t)) {
    return true;
  }
  return false;
}

function hasBehavioralReturnOrStateAssert(src: string): boolean {
  const t = src || "";
  if (JS_PROD_IMPORT_RE.test(t) && ASSERT_RE.test(t)) {
    const stripped = t
      .replace(/pinPresent\s*\([\s\S]*?\)\s*;?/g, "")
      .replace(/pinAbsent\s*\([\s\S]*?\)\s*;?/g, "")
      .replace(/readSrc(?:Many)?\s*\([^)]*\)/g, "");
    const ttyOnly =
      hasTtyOrSourcePin(stripped) &&
      !/\bassert\.(?:equal|deepEqual|strictEqual|ok)\s*\(\s*(?!stdout|stderr|output|help)/i.test(
        stripped,
      );
    if (JS_PROD_IMPORT_RE.test(stripped) && ASSERT_RE.test(stripped) && !ttyOnly) {
      return true;
    }
  }
  if (!pythonProductionImports(t).length) return false;
  if (
    /(?:self\.)?assert(?:True|False|Is|IsNone|IsNotNone|IsInstance|Greater|Less|AlmostEqual|CountEqual|SetEqual|DictEqual|ListEqual)\s*\(\s*[A-Za-z_]\w*\s*\(/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /(?:self\.)?assertEqual\s*\(\s*[A-Za-z_]\w*\s*\([^)]*\)/.test(t) &&
    !/(?:self\.)?assertEqual\s*\(\s*(?:stdout|stderr|output|help|captured|out|err|buf)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /=\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*\([^)]*\)[\s\S]{0,240}(?:self\.)?assert(?:Equal|True|False|Is|IsNone)/.test(
      t,
    ) &&
    !TTY_NAME_RE.test(t.slice(0, Math.min(t.length, 8000)))
  ) {
    return true;
  }
  return false;
}

/** True when the file's contract is source-text / TTY pins, not a function return. */
export function isPinOnlyTestSource(src: string): boolean {
  const t = src || "";
  if (hasBehavioralReturnOrStateAssert(t)) return false;
  const hasPinApi = PIN_API_RE.test(t);
  const hasRawPin = RAW_READ_RE.test(t) && /\bassert\.match\b/.test(t);
  if (hasPinApi || hasRawPin) {
    if (!JS_PROD_IMPORT_RE.test(t) || !ASSERT_RE.test(t)) return true;
    const stripped = t
      .replace(/pinPresent\s*\([\s\S]*?\)\s*;?/g, "")
      .replace(/pinAbsent\s*\([\s\S]*?\)\s*;?/g, "")
      .replace(/readSrc(?:Many)?\s*\([^)]*\)/g, "");
    return !(JS_PROD_IMPORT_RE.test(stripped) && ASSERT_RE.test(stripped));
  }
  return hasTtyOrSourcePin(t);
}

export function isBehavioralTestSource(src: string): boolean {
  return hasBehavioralReturnOrStateAssert(src || "");
}

export function isChromeOnlyPath(p: string): boolean {
  const n = normPath(p);
  if (!n) return false;
  if (isTestOrHarnessPath(n)) return true;
  if (/\.(css|md)$/i.test(n)) return true;
  if (/(^|\/)CHANGELOG\.md$/i.test(n)) return true;
  if (/(^|\/)style\.css$/i.test(n)) return true;
  return false;
}

export function isChromeOnlyPaths(
  paths: string[],
  kind?: ProdEditKind,
): boolean {
  const list = (paths || []).map(normPath).filter(Boolean);
  if (!list.length) return false;
  if (list.every(isChromeOnlyPath)) return true;
  return false;
}

function readMaybe(cwd: string | undefined, rel: string): string {
  if (!cwd || !rel) return "";
  try {
    return fs.readFileSync(path.resolve(cwd, rel), "utf8");
  } catch {
    return "";
  }
}

export function waveTestProofKind(opts: {
  cwd?: string;
  paths?: string[];
}): WaveTestProofKind {
  const tests = (opts.paths || []).map(normPath).filter(isWaveTestPath);
  if (!tests.length) return "none";
  if (!opts.cwd) return "none";
  let anyBeh = false;
  let anyPin = false;
  for (const rel of tests) {
    const src = readMaybe(opts.cwd, rel);
    if (!src) continue;
    if (isBehavioralTestSource(src)) anyBeh = true;
    else if (isPinOnlyTestSource(src)) anyPin = true;
  }
  if (anyBeh) return "behavioral";
  if (anyPin) return "pin-only";
  return "none";
}

/**
 * Should this declared ship increment `w`?
 * Empty paths with no cwd do not refuse (closer-only tests). Declared ships
 * that pass a cwd and still have no dirty paths are chrome, not unknown-ok.
 */
export function decideWaveJobCredit(opts: {
  paths?: string[];
  cwd?: string;
  pinTaint?: boolean;
  playLoop?: boolean;
  chromeStreak?: number;
  peekMill?: boolean;
  peekMillStreak?: number;
  declared?: boolean;
  diffs?: Record<string, string>;
  prodKind?: ProdEditKind;
}): StampJobDecision {
  if (opts.playLoop) return { ok: true, chrome: false, kind: "control-flow" };
  const paths = opts.paths || [];
  const kind =
    opts.prodKind ??
    inspectProdEditKind({ cwd: opts.cwd, paths, diffs: opts.diffs });
  if (opts.peekMill && (opts.peekMillStreak ?? 0) >= PEEK_MILL_HOLD) {
    return { ok: false, reason: "peek", admit: PEEK_MILL_ADMIT, kind };
  }
  if (opts.declared && paths.length === 0 && opts.cwd) {
    if ((opts.chromeStreak ?? 0) >= CHROME_PATH_HOLD) {
      return { ok: false, reason: "chrome", admit: JOB_FLAT_ADMIT, kind };
    }
    return { ok: true, chrome: true, kind: kind === "unknown" ? "tty" : kind };
  }
  const testKind = waveTestProofKind({ cwd: opts.cwd, paths });
  const pinBlocked =
    (testKind === "pin-only" && kind !== "control-flow" && kind !== "new-module") ||
    (Boolean(opts.pinTaint) && testKind !== "behavioral");
  if (pinBlocked) {
    return { ok: false, reason: "pin", admit: PIN_ONLY_ADMIT, kind };
  }
  const chrome =
    isChromeOnlyPaths(paths, kind) ||
    (isChromeKind(kind) && productionRelPaths(paths).length > 0);
  if (chrome && (opts.chromeStreak ?? 0) >= CHROME_PATH_HOLD) {
    return { ok: false, reason: "chrome", admit: JOB_FLAT_ADMIT, kind };
  }
  return { ok: true, chrome, kind };
}

/** 3 numbered / same-dir new-module siblings hold — files may differ. */
export const SIBLING_MILL_HOLD = 3;

export const SIBLING_MILL_ADMIT = [
  "[Forge ULW cycle driver] Stop blocked — last ships are sibling new-modules (same stem or same-dir factory).",
  "PLAN is re-armed. Spawn one explore (or play-loop), then a different-surface Reading. A numbered foo-n.js is not a new job.",
  "Unlimited ULW continues. Stuck-wall will not release. Or /cycle 0.",
].join("\n");

const NUMBERED_STEM_RE = /^(.*?)[-_.](?:v|w)?(\d+)$/i;

export function siblingStem(rel: string): {
  dir: string;
  stem: string;
  numbered: boolean;
} {
  const n = normPath(rel).replace(/^\.\//, "");
  const slash = n.lastIndexOf("/");
  const dir = slash >= 0 ? n.slice(0, slash) : "";
  const file = slash >= 0 ? n.slice(slash + 1) : n;
  const base = file.replace(/\.[^.]+$/, "");
  const m = NUMBERED_STEM_RE.exec(base);
  if (m?.[1] && m[1].length >= 2) {
    return { dir, stem: m[1].toLowerCase(), numbered: true };
  }
  return { dir, stem: base.toLowerCase(), numbered: false };
}

/** `kind:file|file` tree key → production paths. */
export function filesFromTreeKey(key: string | undefined): string[] {
  const raw = String(key || "");
  const idx = raw.indexOf(":");
  if (idx < 0) return [];
  return raw
    .slice(idx + 1)
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Same recipe, rotating file: `foo.js` vs `foo-2.js`, or `npc-1` vs `npc-2`
 * in one directory. Root-level files are never mill by path.
 */
export function isSiblingPathMill(
  current: string[],
  previous: string[],
): boolean {
  const a = productionRelPaths(current);
  const b = productionRelPaths(previous);
  if (!a.length || !b.length) return false;
  for (const p of a) {
    const sa = siblingStem(p);
    if (!sa.dir) continue;
    for (const q of b) {
      if (normPath(p) === normPath(q)) continue;
      const sb = siblingStem(q);
      if (sa.dir === sb.dir && sa.stem === sb.stem && sa.stem.length >= 2) {
        return true;
      }
    }
  }
  return false;
}

export type SiblingMillWave = {
  editKind?: ProdEditKind | string;
  treeSurfaceKey?: string;
};

/**
 * How many recent waves share this ship's numbered stem or same-dir
 * new-module factory. Maze regex is not required.
 */
export function siblingMillHits(
  prevWaves: SiblingMillWave[] | undefined,
  currentPaths: string[],
  currentKind: ProdEditKind | string = "unknown",
  lookback = 8,
): number {
  const files = productionRelPaths(currentPaths);
  if (!files.length) return 0;
  const dirs = new Set(
    files.map((p) => siblingStem(p).dir).filter(Boolean),
  );
  const recent = (prevWaves || []).slice(-lookback);
  let hits = 0;
  for (const w of recent) {
    const prevFiles = filesFromTreeKey(w.treeSurfaceKey);
    if (!prevFiles.length) continue;
    if (isSiblingPathMill(files, prevFiles)) {
      hits += 1;
      continue;
    }
    if (currentKind !== "new-module" || w.editKind !== "new-module") continue;
    const prevDirs = prevFiles.map((p) => siblingStem(p).dir);
    if ([...dirs].some((d) => prevDirs.includes(d))) hits += 1;
  }
  return hits;
}

/** True when this ship is the 3rd sibling mill (do not increment w). */
export function siblingMillHolding(
  prevWaves: SiblingMillWave[] | undefined,
  currentPaths: string[],
  currentKind: ProdEditKind | string = "unknown",
): boolean {
  return (
    siblingMillHits(prevWaves, currentPaths, currentKind) >=
    SIBLING_MILL_HOLD - 1
  );
}
