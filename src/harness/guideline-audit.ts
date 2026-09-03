/**
 * Agent-guidelines audit — the first action of a session.
 *
 * A badly written AGENTS.md / CLAUDE.md caps the quality of every session no
 * matter how strong the model is: the prompt loader clips each file at
 * 12,000 chars (a 27k manual loses its Conventions / Non-negotiables past
 * the cap), stale paths steer reads into nothing, and "ask before every
 * edit" rules fight the harness. Nothing used to detect any of that.
 *
 * The harness surveys the guideline files (size, stamp, hash, stale paths,
 * anti-harness rules), briefs the model once per session as its first
 * action, records whether the model actually looked, stamps
 * `<!-- proofread <UTC> · forge -->` when it did, and tells the user when a
 * file was really changed. Activating Forge authorises those edits; the
 * brief says so, whatever the files say about themselves.
 *
 * The audited set is the loaded set: `surveyGuidelines` walks workspace →
 * git root through the same `collectInstructionFiles` the prompt's rules
 * loader uses (`src/agent/instruction-paths.ts`), so a nested
 * `packages/api/AGENTS.md` is audited (and shadows the monorepo root)
 * exactly as it is loaded. The two sets differ in exactly two documented
 * ways, both because the audit is about the repo and the loader is about
 * this session, and `tests/guideline-audit.test.ts` pins both:
 *
 *   1. Audited, never loaded: `AUDIT_ONLY_GUIDELINE_FILES` — `GEMINI.md`,
 *      `.windsurfrules`, `.clinerules`, `.claude/CLAUDE.md`. Sibling tools'
 *      maps. Forge does not steer by them, but they are in the repo and a
 *      stale one misleads whoever opens it next, so they get surveyed.
 *   2. Loaded, never audited: `~/.forge/AGENTS.md`, the loader's global
 *      fallback (`globalAgentsFallback`, which only the prompt side passes).
 *      It is the user's own file rather than this project's map, so the
 *      audit will not rewrite or stamp it, and a project with no primary of
 *      its own is still `missingPrimary`. It is *reported* though:
 *      `GuidelineSurvey.globalFallback` names it, and the status line and
 *      the brief say it is what steers in the meantime. Reporting
 *      "AGENTS.md missing" while never mentioning the file actually
 *      steering the session was the bug that made this explicit.
 *
 * Nothing else may differ; the name-set test fails if a file is added to one
 * list and not the other.
 *
 * Registry: `~/.forge/guidelines/<projectKey>.json` (hash per file, mode 0600).
 * Sibling stamps (`· sisyphus-all`, `· oh-my-claude`) count as proofread.
 *
 * **Advisory Q&A turns never audit.** A question is not a work turn: it may
 * not be diverted into a proofread, may not be held at Stop for one, and may
 * not end with a write to a file the user never asked anyone to touch. Every
 * other Stop-blocking guard in this directory carves Q&A out the same way
 * (`looksLikeAdvisoryUserMessage`); the audit does it at all three of its
 * turn-acting doors — brief, Stop, stamp. It is a **defer, not a skip**:
 * `phase` stays `"pending"`, so the next real work prompt in the same
 * session audits exactly as it would have.
 *
 * Kill-switch: FORGE_GUIDELINE_AUDIT=0. Subagents never audit.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isFalsy } from "../util/bool.js";
import { looksLikeAdvisoryUserMessage } from "../util/advisory-intent.js";
import { ensureDir, forgeHome, nowIso, readJsonFile, writeJsonFile } from "../util/fs.js";
import {
  collectInstructionFiles,
  globalAgentsPath,
  nearestGitRoot,
  RULES_PER_FILE_CHARS,
} from "../agent/instruction-paths.js";
import {
  primaryCommand,
  splitShellSegments,
  tokenizeSimple,
} from "../agent/shell-parse.js";
import { projectMemoryKey } from "./project-memory.js";

/**
 * The system-prompt rules loader's own cap, not a copy of it — past it the
 * file is invisible, and the issue text says so in the loader's name.
 */
export const GUIDELINE_MANUAL_CHARS = RULES_PER_FILE_CHARS;
export const GUIDELINE_MANUAL_LINES = 300;
/** A proofread older than this is due again. */
export const GUIDELINE_RECHECK_DAYS = 14;
export const GUIDELINE_STAMP_TOOL = "forge";

/** Primary files: a project should have one of these (nearest wins). */
export const PRIMARY_GUIDELINE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "FORGE.md",
  "GEMINI.md",
] as const;

/** Secondary files: audited when present, never required. */
export const SECONDARY_GUIDELINE_FILES = [
  ".github/copilot-instructions.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  ".forge/rules.md",
  ".claude/CLAUDE.md",
] as const;

export const GUIDELINE_FILES = [
  ...PRIMARY_GUIDELINE_FILES,
  ...SECONDARY_GUIDELINE_FILES,
] as const;

/**
 * Difference 1 from the prompt loader (see the module header): sibling
 * tools' maps. The audit surveys them because they sit in the repo; the
 * prompt never loads them, so they cannot steer a Forge session. Pinned
 * against `PROMPT_RULE_FILES` by test, so a name added to one list and not
 * the other turns the suite red rather than drifting quietly.
 */
export const AUDIT_ONLY_GUIDELINE_FILES = [
  "GEMINI.md",
  ".windsurfrules",
  ".clinerules",
  ".claude/CLAUDE.md",
] as const;

const STAMP_RE =
  /^[ \t]*<!--\s*proofread\s+(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?)\s*(?:[·\-|]\s*([\w.+-]+))?\s*-->[ \t]*$/im;
const STAMP_LINE_RE =
  /^[ \t]*<!--\s*proofread\s+[^>]*-->[ \t]*(?:\r?\n|$)/gim;

export type GuidelineFreshness =
  | "never"
  | "fresh"
  | "edited"
  | "due"
  | "import";

export type GuidelineIssueKind =
  | "manual"
  | "no-commands"
  | "stale-paths"
  | "conflict"
  | "empty";

export interface GuidelineIssue {
  kind: GuidelineIssueKind;
  detail: string;
}

export interface GuidelineFileSurvey {
  /** Path relative to the project root (display + registry key). */
  rel: string;
  abs: string;
  primary: boolean;
  bytes: number;
  lines: number;
  /** sha256 of the body with stamp lines removed. */
  hash: string;
  stampedAt?: string;
  stampedBy?: string;
  freshness: GuidelineFreshness;
  issues: GuidelineIssue[];
  /** True when the model should read and possibly revise this file. */
  needsAudit: boolean;
}

export interface GuidelineSurvey {
  root: string;
  files: GuidelineFileSurvey[];
  /** No primary file at all — the model should write a short AGENTS.md. */
  missingPrimary: boolean;
  /**
   * Absolute path of `~/.forge/AGENTS.md` when the prompt loader's global
   * fallback is what steers this session (the walk found no project
   * `AGENTS.md` and the user's file exists), else null. Never surveyed,
   * never stamped, never rewritten — only named, so `missingPrimary` does
   * not report a hole while a file the user cannot see is doing the steering.
   */
  globalFallback: string | null;
  /** Anything to do (missing primary, or any file needsAudit). */
  needsAudit: boolean;
  /** Not a project (no git, no manifest) — nothing to audit. */
  notAProject: boolean;
}

interface RegistryFile {
  hash: string;
  stampedAt?: string;
  auditedAt?: string;
  bytes?: number;
  lines?: number;
  revisedAt?: string;
  revisedBySession?: string;
}

export interface GuidelineRegistry {
  version: 1;
  root: string;
  files: Record<string, RegistryFile>;
  lastAuditAt?: string;
  lastAuditSession?: string;
  updatedAt: string;
}

export function guidelineAuditEnabled(): boolean {
  return !isFalsy(process.env.FORGE_GUIDELINE_AUDIT ?? "1");
}

/**
 * Registry file for a root. The **key** is canonicalized, the root is not:
 * `projectMemoryKey` hashes the string it is given, and project memory feeds
 * it `resolveProjectMemoryRoot` (`git rev-parse`, which resolves symlinks),
 * so the same repo reached through a link — or through `/var` rather than
 * `/private/var` — was one project-memory store but two guideline
 * registries, and the second one had no hashes, so `edited` could not be
 * detected. The survey root stays the literal walk result: it is the ceiling
 * of the prompt loader's walk and every `rel` label is relative to it.
 */
export function guidelineRegistryPath(root: string): string {
  let key = path.resolve(root);
  try {
    key = fs.realpathSync(key);
  } catch {
    /* not on disk (yet) — the literal path is the key */
  }
  return path.join(
    forgeHome(),
    "guidelines",
    `${projectMemoryKey(key)}.json`,
  );
}

export function loadGuidelineRegistry(root: string): GuidelineRegistry {
  const p = guidelineRegistryPath(root);
  const empty: GuidelineRegistry = {
    version: 1,
    root: path.resolve(root),
    files: {},
    updatedAt: nowIso(),
  };
  const r = readJsonFile<GuidelineRegistry>(p, empty);
  if (!r || typeof r !== "object" || !r.files) return empty;
  return r;
}

export function saveGuidelineRegistry(reg: GuidelineRegistry): void {
  const p = guidelineRegistryPath(reg.root);
  ensureDir(path.dirname(p));
  reg.updatedAt = nowIso();
  writeJsonFile(p, reg, 0o600);
}

/** Body without proofread stamp lines (hash input). */
export function stripGuidelineStamp(text: string): string {
  return text
    .replace(STAMP_LINE_RE, "")
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "");
}

/**
 * Nearest directory containing `.git` (dir or worktree file), else the start.
 * The same walk the prompt's rules loader stops at, so the survey root and
 * the loader's ceiling can never drift apart.
 */
export function resolveGuidelineRoot(workspace: string): string {
  const start = path.resolve(workspace || process.cwd());
  return nearestGitRoot(start) ?? start;
}

export function hashGuidelineBody(text: string): string {
  return createHash("sha256")
    .update(stripGuidelineStamp(text))
    .digest("hex")
    .slice(0, 24);
}

export function parseGuidelineStamp(
  text: string,
): { at: string; by?: string } | null {
  const m = text.match(STAMP_RE);
  if (!m) return null;
  return { at: m[1], by: m[2] || undefined };
}

/** `<!-- proofread 2026-09-03T14:05Z · forge -->` */
export function formatGuidelineStamp(at = nowIso()): string {
  const iso = at.replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z");
  return `<!-- proofread ${iso} · ${GUIDELINE_STAMP_TOOL} -->`;
}

/**
 * Replace an existing stamp or insert one on the first line after any YAML
 * frontmatter (top of file: visible to humans and inside the loader's cap).
 */
export function applyGuidelineStamp(text: string, at = nowIso()): string {
  const body = stripGuidelineStamp(text);
  const stamp = formatGuidelineStamp(at);
  if (!body.trim()) return `${stamp}\n`;
  const fm = body.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (fm) {
    const head = fm[0];
    const rest = body.slice(head.length).replace(/^\s*\n/, "");
    return `${head}${stamp}\n\n${rest}\n`;
  }
  return `${stamp}\n\n${body.replace(/^\s*\n/, "")}\n`;
}

function stampAgeDays(at: string | undefined): number | null {
  if (!at) return null;
  const t = Date.parse(at.length === 10 ? `${at}T00:00:00Z` : at);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

/** CLAUDE.md that only points at AGENTS.md (`@AGENTS.md` / "see AGENTS.md"). */
export function isImportOnlyGuideline(text: string): boolean {
  const body = stripGuidelineStamp(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^#/.test(l));
  if (body.length === 0 || body.length > 3) return false;
  return body.every((l) =>
    /^@[\w./-]+\.md$/i.test(l) ||
    /\b(?:see|read|follow|use)\b[^\n]{0,40}\b(?:AGENTS|CLAUDE|FORGE|GEMINI)\.md\b/i.test(l) ||
    /^\[[^\]]*\]\([^)]*\.md\)$/i.test(l),
  );
}

const COMMAND_HEAD_RE =
  /`[^`\n]*\b(?:npm|pnpm|yarn|bun|npx|node|cargo|go|pytest|python3?|uv|poetry|make|just|task|swift|xcodebuild|dotnet|gradle|gradlew|mvn|mix|bundle|rake|rspec|zig|dart|flutter|tsc|vitest|jest|mocha|deno|ruff|black|eslint|prettier|\.\/[\w.-]+\.sh|scripts\/[\w.-]+)\b[^`\n]*`/i;
const FENCE_COMMAND_RE =
  /```(?:bash|sh|shell|zsh|console|fish)?\s*\n[\s\S]*?\b(?:npm|pnpm|yarn|bun|npx|cargo|go|pytest|python3?|uv|poetry|make|just|task|swift|xcodebuild|dotnet|gradle|mvn|mix|bundle|rake|zig|dart|flutter|tsc|deno)\b[\s\S]*?```/i;

export function guidelineHasCommands(text: string): boolean {
  return COMMAND_HEAD_RE.test(text) || FENCE_COMMAND_RE.test(text);
}

/**
 * Rules that fight verification or autonomy. Kept narrow: a guideline may
 * legitimately say "never push" or "never commit secrets".
 */
const CONFLICT_RULES: Array<{ re: RegExp; label: string }> = [
  {
    re: /\b(?:never|do not|don't|avoid)\s+(?:run(?:ning)?|execut(?:e|ing))\s+(?:the\s+)?(?:tests?|test suite|checks?|typecheck|lint(?:er)?)\b/i,
    label: "forbids running tests/checks",
  },
  {
    re: /\b(?:always\s+)?ask\s+(?:for\s+)?(?:permission|confirmation|approval)\s+before\s+(?:every|each|any|making|editing|changing|writing)\b/i,
    label: "asks permission before every edit",
  },
  {
    re: /\b(?:wait|pause)\s+for\s+(?:my|user|human)\s+(?:confirmation|approval|go[- ]?ahead)\s+(?:before|after)\s+(?:every|each|any)\b/i,
    label: "waits for confirmation per step",
  },
  {
    re: /\b(?:never|do not|don't)\s+(?:read|open|inspect)\s+(?:any\s+)?(?:files?|the code|source)\b/i,
    label: "forbids reading files",
  },
  {
    re: /\b(?:do not|don't|never)\s+(?:modify|edit|change|touch)\s+(?:this|the)\s+(?:file|AGENTS\.md|CLAUDE\.md)\b/i,
    label: "forbids revising the guideline file (Forge overrides this)",
  },
];

export function detectGuidelineConflicts(text: string): string[] {
  const out: string[] = [];
  for (const r of CONFLICT_RULES) {
    if (r.re.test(text)) out.push(r.label);
  }
  return out;
}

const PATH_TOKEN_RE = /`((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[a-z0-9]{1,8})(?:[:#][^`]*)?`/gi;

/**
 * Backticked relative paths (`src/foo/bar.ts`) that do not exist under root.
 * Globs, URLs, ~ paths and placeholders are ignored.
 */
export function findStaleGuidelinePaths(
  text: string,
  root: string,
  limit = 12,
): string[] {
  const seen = new Set<string>();
  const stale: string[] = [];
  let m: RegExpExecArray | null;
  PATH_TOKEN_RE.lastIndex = 0;
  while ((m = PATH_TOKEN_RE.exec(text)) !== null) {
    const raw = m[1];
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (/[*{}<>$~]/.test(raw)) continue;
    if (/^(?:https?:|node_modules\/|dist\/|\.tmp\/|~\/)/i.test(raw)) continue;
    if (/^[a-z]+\.[a-z]+$/i.test(raw)) continue;
    const abs = path.resolve(root, raw);
    if (!abs.startsWith(path.resolve(root))) continue;
    try {
      if (fs.existsSync(abs)) continue;
    } catch {
      continue;
    }
    stale.push(raw);
    if (stale.length >= limit) break;
  }
  return stale;
}

function looksLikeProject(root: string): boolean {
  try {
    if (fs.existsSync(path.join(root, ".git"))) return true;
  } catch {
    /* */
  }
  const manifests = [
    "package.json",
    "pyproject.toml",
    "setup.py",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "Package.swift",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Gemfile",
    "mix.exs",
    "build.zig",
    "pubspec.yaml",
    "Makefile",
    "CMakeLists.txt",
  ];
  return manifests.some((f) => {
    try {
      return fs.existsSync(path.join(root, f));
    } catch {
      return false;
    }
  });
}

function surveyOne(
  root: string,
  rel: string,
  abs: string,
  primary: boolean,
  reg: GuidelineRegistry,
  now: number,
): GuidelineFileSurvey | null {
  let text: string;
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = text.split(/\r?\n/).length;
  const hash = hashGuidelineBody(text);
  const stamp = parseGuidelineStamp(text);
  const prev = reg.files[rel];
  const issues: GuidelineIssue[] = [];

  const importOnly = isImportOnlyGuideline(text);
  let freshness: GuidelineFreshness;
  if (!stripGuidelineStamp(text).trim()) {
    freshness = "never";
    issues.push({ kind: "empty", detail: "file is empty" });
  } else if (importOnly) {
    freshness = "import";
  } else if (!stamp) {
    freshness = "never";
  } else {
    const age = stampAgeDays(stamp.at);
    const recheck = envRecheckDays();
    if (prev?.hash && prev.hash !== hash) freshness = "edited";
    else if (age == null || age > recheck) freshness = "due";
    else freshness = "fresh";
  }

  if (!importOnly) {
    if (bytes > GUIDELINE_MANUAL_CHARS || lines > GUIDELINE_MANUAL_LINES) {
      issues.push({
        kind: "manual",
        // Every caller prints the size beside the detail, so do not repeat it.
        detail:
          bytes > GUIDELINE_MANUAL_CHARS
            ? `over the ${fmtChars(GUIDELINE_MANUAL_CHARS)}-char cap the prompt loads, so the tail is invisible to agents`
            : `a map, not a manual (over ${GUIDELINE_MANUAL_LINES} lines)`,
      });
    }
    if (primary && !guidelineHasCommands(text)) {
      issues.push({
        kind: "no-commands",
        detail: "no build/test/typecheck commands an agent can run",
      });
    }
    const stale = findStaleGuidelinePaths(text, root);
    if (stale.length) {
      issues.push({
        kind: "stale-paths",
        detail: `${stale.length} path${stale.length === 1 ? "" : "s"} no longer exist${stale.length === 1 ? "s" : ""}: ${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", …" : ""}`,
      });
    }
    for (const c of detectGuidelineConflicts(text)) {
      issues.push({ kind: "conflict", detail: c });
    }
  }

  void now;
  const needsAudit =
    freshness !== "import" && (freshness !== "fresh" || issues.length > 0);
  return {
    rel,
    abs,
    primary,
    bytes,
    lines,
    hash,
    stampedAt: stamp?.at,
    stampedBy: stamp?.by,
    freshness,
    issues,
    needsAudit,
  };
}

function envRecheckDays(): number {
  const raw = process.env.FORGE_GUIDELINE_RECHECK_DAYS?.trim();
  if (!raw) return GUIDELINE_RECHECK_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : GUIDELINE_RECHECK_DAYS;
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
}

/** Exact char counts read better than `12k over the 12k cap`. */
function fmtChars(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Registry key and display label for a surveyed file: its path relative to
 * the resolved root (`AGENTS.md`, `packages/api/AGENTS.md`). The walk's
 * ceiling is the root, so the fallback never fires in practice.
 */
function relFromRoot(root: string, abs: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return !rel || rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel;
}

const PRIMARY_SET: ReadonlySet<string> = new Set<string>(PRIMARY_GUIDELINE_FILES);

/**
 * Names whose nearest copy shadows the ones above it, matching the prompt
 * loader: in a monorepo the package's own `AGENTS.md` is the one loaded, so
 * it is the one audited and the root's is left out of both.
 */
const SHADOW_GUIDELINE_BASENAMES: readonly string[] = [
  ...PRIMARY_GUIDELINE_FILES,
  ".cursorrules",
];

/**
 * Survey the guideline files that steer a session started in `workspace`.
 *
 * Seeded by the same workspace → git-root walk the system prompt loads from
 * (`collectInstructionFiles`), never by a fixed list at the git root: the
 * file the audit proofreads has to be the file the prompt loaded. `rel`
 * stays relative to the resolved root, so registry keys and every display
 * string read the same as before for a single-root repo, and a nested file
 * shows as `packages/api/AGENTS.md`.
 */
export function surveyGuidelines(workspace: string): GuidelineSurvey {
  const root = resolveGuidelineRoot(workspace);
  const notAProject = !looksLikeProject(root);
  const reg = loadGuidelineRegistry(root);
  const now = Date.now();
  const files: GuidelineFileSurvey[] = [];
  const found = collectInstructionFiles(workspace, {
    files: GUIDELINE_FILES,
    shadowBasenames: SHADOW_GUIDELINE_BASENAMES,
    cursorRules: true,
  });
  // Primary is the rule that matched, not the basename: `.claude/CLAUDE.md`
  // is a secondary even though it is called CLAUDE.md.
  for (const entry of found.filter((e) => PRIMARY_SET.has(e.name))) {
    const f = surveyOne(root, relFromRoot(root, entry.abs), entry.abs, true, reg, now);
    if (f) files.push(f);
  }
  for (const entry of found.filter((e) => !PRIMARY_SET.has(e.name))) {
    const f = surveyOne(root, relFromRoot(root, entry.abs), entry.abs, false, reg, now);
    if (f) files.push(f);
  }
  const missingPrimary = !notAProject && !files.some((f) => f.primary);
  const needsAudit =
    !notAProject && (missingPrimary || files.some((f) => f.needsAudit));
  // Difference 2 from the loader (module header): the walk above passes no
  // `globalAgentsFallback`, so `~/.forge/AGENTS.md` is never in `files`.
  // The loader's condition is the same test on the same walk — no file named
  // `AGENTS.md` — so this is the file the prompt is loading right now.
  const global = globalAgentsPath();
  let globalFallback: string | null = null;
  try {
    if (!found.some((e) => e.name === "AGENTS.md") && fs.statSync(global).isFile()) {
      globalFallback = global;
    }
  } catch {
    /* no global map */
  }
  return { root, files, missingPrimary, needsAudit, notAProject, globalFallback };
}

export function describeGuidelineFile(f: GuidelineFileSurvey): string {
  const size = `${fmtK(f.bytes)} chars / ${f.lines} lines`;
  const fresh =
    f.freshness === "fresh"
      ? `proofread ${f.stampedAt}${f.stampedBy && f.stampedBy !== GUIDELINE_STAMP_TOOL ? ` by ${f.stampedBy}` : ""}`
      : f.freshness === "due"
        ? `proofread ${f.stampedAt} — due again`
        : f.freshness === "edited"
          ? `edited since proofread ${f.stampedAt}`
          : f.freshness === "import"
            ? "import-only pointer — fine"
            : "never proofread";
  const issues = f.issues.map((i) => i.detail);
  return `${f.rel} — ${size} — ${fresh}${issues.length ? ` — ${issues.join("; ")}` : ""}`;
}

/**
 * How the loader's global fallback reads to a user: `~/.forge/AGENTS.md`,
 * never the expanded home path (the same short label
 * `labelForRulePath` prints in the prompt's own rules header).
 */
export function globalFallbackLabel(abs: string): string {
  return `~/.forge/${path.basename(abs)}`;
}

/** One-line status for doctor / /status / report. */
export function formatGuidelineStatusLine(s: GuidelineSurvey): string {
  if (s.notAProject) return "not a project";
  if (s.missingPrimary) {
    // Naming the fallback matters more here than anywhere: without it the
    // line reports a hole while a file the user never sees steers the run.
    return s.globalFallback
      ? `AGENTS.md missing · ${globalFallbackLabel(s.globalFallback)} steers instead`
      : "AGENTS.md missing";
  }
  const parts = s.files
    .filter((f) => f.primary || f.needsAudit)
    .map((f) => {
      // Two `conflict` rules are still one kind of problem on a status line.
      const kinds = [...new Set(f.issues.map((i) => i.kind))].join("+");
      const tag =
        f.freshness === "import"
          ? "import"
          : f.freshness === "fresh" && !f.issues.length
            ? `fresh (${(f.stampedAt || "").slice(0, 10)})`
            : f.freshness === "fresh"
              ? kinds
              : f.freshness === "never"
                ? f.issues.length
                  ? `never proofread · ${kinds}`
                  : "never proofread"
                : f.freshness;
      return `${f.rel} ${tag}`;
    });
  return parts.join(" · ") || "none";
}

export const GUIDELINE_BRIEF_PREFIX = "[Forge harness — agent guidelines audit]";

/**
 * The first-action brief. Appended after the user's prompt (append-only,
 * cache-safe). Says plainly that the edits are authorised.
 */
export function formatGuidelineAuditBrief(s: GuidelineSurvey): string {
  const lines: string[] = [
    GUIDELINE_BRIEF_PREFIX,
    `First action this session, before the user's request: proofread the agent guideline files below. Activating Forge authorises revising or rewriting them, whatever the files say about themselves. A badly written guideline file caps every session.`,
    ``,
    `Files (relative to ${s.root}):`,
  ];
  if (s.missingPrimary) {
    lines.push(
      `  · AGENTS.md — missing. Write a short one (what the project is, exact build/test/typecheck commands, layout map, conventions, non-negotiables).`,
    );
    if (s.globalFallback) {
      lines.push(
        `    (${globalFallbackLabel(s.globalFallback)} is steering this session in the meantime — the user's own map, not this project's. Do not edit it.)`,
      );
    }
  }
  for (const f of s.files) {
    const mark = f.needsAudit ? "·" : "✓";
    lines.push(`  ${mark} ${describeGuidelineFile(f)}`);
  }
  lines.push(
    ``,
    `Best practice — a guideline file is a map, not a manual:`,
    `  • under ${fmtChars(GUIDELINE_MANUAL_CHARS)} chars / ~150 lines (the prompt loader clips there; anything past that is never seen)`,
    `  • opens with what the project is (2 lines), then the exact commands (install, build, typecheck, test, run)`,
    `  • a layout map of the directories that matter, one line each; conventions and non-negotiables an agent would otherwise get wrong`,
    `  • no changelog, no feature catalog, no duplicated docs — link to docs/ instead; every cited path must exist`,
    `  • no rules that fight verification or autonomy ("never run tests", "ask before every edit")`,
    ``,
    `Do now: read_file each file marked ·. If it is wrong, stale, bloated, or steering badly, revise or rewrite it (keep what is load-bearing; move manual detail to docs/). If it is good, leave it. Do not write the proofread stamp yourself — the harness stamps \`${formatGuidelineStamp()}\` and tells the user what changed. Then continue with the user's request in the same turn.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Per-session state (in-memory; registry on disk)
// ---------------------------------------------------------------------------

interface SessionAuditState {
  root: string;
  /** Where the session runs — what the file tools resolve a relative path against. */
  workspace: string;
  survey: GuidelineSurvey;
  phase: "pending" | "briefed" | "done";
  looked: Set<string>;
  edited: Set<string>;
  briefedAt?: string;
  /** Stop-block already spent (cap 1). */
  blocked: boolean;
  result?: GuidelineFinalizeResult;
  /**
   * The run that closed this audit has ended, so every surface has already
   * announced it once. Set on the *repeat* finalize and not on the first one,
   * because `finalizeGuidelineAuditForRun` runs inside `runAgentLoop` while
   * the report is rendered after it returns: setting this on the first close
   * would strip the audit from the report of the very run that performed it.
   */
  reported?: boolean;
}

const sessions = new Map<string, SessionAuditState>();

export function clearGuidelineAuditState(sessionId?: string): void {
  if (sessionId) sessions.delete(sessionId);
  else sessions.clear();
}

export function guidelineAuditState(sessionId: string): SessionAuditState | undefined {
  return sessions.get(sessionId);
}

/**
 * Decide whether to brief this session now. Returns the brief text when it
 * should be appended to the transcript; null otherwise. Idempotent per
 * session: the brief is emitted once; later calls return null.
 */
export function maybeGuidelineAuditBrief(opts: {
  sessionId: string;
  workspace: string;
  /** Nested agents never audit. */
  subagent?: boolean;
  /** Mutations are denied (plan mode / ULW orient) — defer. */
  readOnly?: boolean;
  /** The user's own last prompt. Advisory Q&A defers, exactly as readOnly does. */
  lastUserMessage?: string;
}): string | null {
  if (!guidelineAuditEnabled()) return null;
  if (opts.subagent) return null;
  let st = sessions.get(opts.sessionId);
  if (!st) {
    const survey = surveyGuidelines(opts.workspace);
    st = {
      root: survey.root,
      workspace: path.resolve(opts.workspace || process.cwd()),
      survey,
      phase: survey.needsAudit ? "pending" : "done",
      looked: new Set(),
      edited: new Set(),
      blocked: false,
    };
    sessions.set(opts.sessionId, st);
  }
  if (st.phase !== "pending") return null;
  if (opts.readOnly) return null;
  // A pure question is not a work turn. Ordering a proofread ahead of it
  // spends the user's round on something they did not ask for, and the Stop
  // guard then costs a second one. Defer exactly as `readOnly` does — `phase`
  // stays "pending", so the next work prompt of this same session audits.
  // Deferring is not skipping.
  if (opts.lastUserMessage && looksLikeAdvisoryUserMessage(opts.lastUserMessage)) {
    return null;
  }
  st.phase = "briefed";
  st.briefedAt = nowIso();
  return formatGuidelineAuditBrief(st.survey);
}

/** True while a brief has been emitted and the audit has not been finalized. */
export function guidelineAuditBriefed(sessionId: string): boolean {
  return sessions.get(sessionId)?.phase === "briefed";
}

/** The files a tool call could be about, with the paths they really live at. */
function guidelineTargets(st: SessionAuditState): Array<{ rel: string; abs: string }> {
  const out = st.survey.files.map((f) => ({ rel: f.rel, abs: path.resolve(f.abs) }));
  if (st.survey.missingPrimary) {
    // Nothing on disk yet: writing it at the root or at the workspace counts.
    for (const base of [st.root, st.workspace]) {
      out.push({ rel: "AGENTS.md", abs: path.resolve(base, "AGENTS.md") });
    }
  }
  return out;
}

/**
 * Guideline files that a path-carrying argument of this call **resolves to**.
 *
 * Evidence, not mention. The old test was `JSON.stringify(args).includes(rel)`,
 * and for a root-level primary the rel *is* the bare basename `AGENTS.md`, so
 * `grep { pattern: "AGENTS.md" }` — or any call quoting the name in prose, a
 * diff, or a commit message — credited a proofread of a file that was never
 * opened, defeating both the stamp and the step-1c Stop block. A token is
 * resolved against the workspace (what the file tools resolve a relative path
 * against) and, only if that hits nothing, against the survey root (what the
 * brief prints its paths relative to). Root-first would let a nested
 * `.forge/rules.md` and its monorepo-root twin credit each other.
 * The stamp is an attestation; it has to be earned.
 */
function resolveGuidelineHits(st: SessionAuditState, tokens: string[]): string[] {
  if (!tokens.length) return [];
  const targets = guidelineTargets(st);
  if (!targets.length) return [];
  const hits = new Set<string>();
  for (const raw of tokens) {
    const tok = raw.trim().replace(/^["'`]|["'`]$/g, "");
    if (!tok || tok === "-") continue;
    for (const base of [st.workspace, st.root]) {
      let abs: string;
      try {
        abs = path.resolve(base, tok);
      } catch {
        continue;
      }
      const found = targets.filter((t) => t.abs === abs);
      if (!found.length) continue;
      for (const t of found) hits.add(t.rel);
      break; // workspace wins; do not re-resolve the same token at the root
    }
  }
  return [...hits];
}

/**
 * Argument keys that carry a path. Everything else in a tool call — a regex,
 * a glob, a commit message, file *content* — may name a guideline file
 * without touching it.
 */
const PATH_ARG_KEYS: ReadonlySet<string> = new Set([
  "path",
  "file",
  "file_path",
  "filepath",
  "filename",
  "notebook_path",
  "target",
  "target_file",
  "source",
  "src",
  "dest",
  "destination",
  "paths",
  "files",
]);

/** `*** Update File: x` / `Add File:` / `Delete File:` / `Move to:` targets. */
const PATCH_TARGET_RE = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$|^\*\*\*\s+Move to:\s*(.+?)\s*$/gim;

/** Path-like tokens from a structured tool-call argument object. */
function argPathTokens(args: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || out.length > 64) return out;
  if (Array.isArray(args)) {
    for (const v of args) argPathTokens(v, depth + 1, out);
    return out;
  }
  if (!args || typeof args !== "object") return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (typeof v === "string") {
      if (PATH_ARG_KEYS.has(key)) out.push(v);
      else if (key === "patchtext" || key === "patch") {
        PATCH_TARGET_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = PATCH_TARGET_RE.exec(v)) !== null && out.length <= 64) {
          out.push(m[1] ?? m[2] ?? "");
        }
      }
    } else if (v && typeof v === "object") {
      argPathTokens(v, depth + 1, out);
    }
  }
  return out;
}

/** Path-like tokens of one bash segment (quotes stripped, flags and redirects peeled). */
function bashSegmentTokens(segment: string): string[] {
  const out: string[] = [];
  for (const t of tokenizeSimple(segment)) {
    const tok = t.replace(/^[<>&|]+/, "");
    if (!tok || (tok.startsWith("-") && tok !== "-")) continue;
    out.push(tok);
  }
  return out;
}

/**
 * `grep` and `glob` are NOT a look, and neither is bash `grep` / `rg`.
 * A pattern match returns matching lines or matching paths, not the file —
 * the brief asks the model to read each flagged file and judge it, and a
 * `grep` for a symbol that happens to sit in `AGENTS.md` is no evidence
 * anybody read the guideline. They were in this set, which is what made the
 * bare-basename hole above reachable from a single tool call.
 */
const READ_TOOLS = new Set(["read_file"]);
const WRITE_TOOLS = new Set(["write_file", "search_replace", "apply_patch"]);
// bash is both, and which one depends on the command — handled below.

/** Segment heads that put a file's contents in front of the model. */
const BASH_LOOK_HEADS = new Set([
  "cat",
  "bat",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "sed",
]);
/** Segment shapes that write a file (redirects included — `echo x > AGENTS.md`). */
const BASH_EDIT_RE =
  /(?:>|>>|\btee\b|\bsed\s+-i|\bperl\s+-p?i|\bmv\b|\bcp\b|\brm\b)/;

/**
 * Record that the model looked at / edited a guideline file this session.
 *
 * Only while a brief is open (`phase === "briefed"`), which is also what
 * keeps an advisory turn free of it: the brief defers on a question, so a
 * `read_file AGENTS.md` that answers "what does this repo do?" credits
 * nothing and earns no stamp. Evidence is evidence *of a proofread*.
 */
export function noteGuidelineToolCall(
  sessionId: string,
  toolName: string,
  args: unknown,
): void {
  const st = sessions.get(sessionId);
  if (!st || st.phase !== "briefed") return;
  const name = String(toolName || "").toLowerCase();
  if (name === "bash") {
    // Segment-strict, like the rest of the bash handling in this repo: the
    // verb and the path have to be in the *same* segment, so
    // `cat docs/notes.md | grep AGENTS.md` credits nothing.
    const cmd = String((args as { command?: unknown })?.command ?? "");
    for (const segment of splitShellSegments(cmd)) {
      const hits = resolveGuidelineHits(st, bashSegmentTokens(segment));
      if (!hits.length) continue;
      if (BASH_LOOK_HEADS.has(primaryCommand(segment))) {
        for (const h of hits) st.looked.add(h);
      }
      if (BASH_EDIT_RE.test(segment)) for (const h of hits) st.edited.add(h);
    }
    return;
  }
  const read = READ_TOOLS.has(name);
  const write = WRITE_TOOLS.has(name);
  if (!read && !write) return;
  const hits = resolveGuidelineHits(st, argPathTokens(args));
  if (!hits.length) return;
  if (read) for (const h of hits) st.looked.add(h);
  if (write) for (const h of hits) st.edited.add(h);
}

export interface GuidelineRevisedFile {
  rel: string;
  before: { bytes: number; lines: number };
  after: { bytes: number; lines: number };
  created?: boolean;
}

export interface GuidelineUnresolvedFile {
  rel: string;
  issues: string[];
}

export interface GuidelineFinalizeResult {
  /** Files stamped this run. */
  stamped: string[];
  /** Files whose body actually changed (created or edited). */
  revised: GuidelineRevisedFile[];
  /** Files the model neither read nor edited after the brief. */
  ignored: string[];
  /**
   * Files the model looked at that still fail the check the brief named.
   * Deliberately left unstamped: a proofread stamp tells the next fortnight
   * of sessions the file is fine, and it is not.
   */
  unresolved: GuidelineUnresolvedFile[];
  /** Model was never briefed (fresh / disabled / subagent / advisory / not a project). */
  skipped: boolean;
  /**
   * This audit was already closed and reported by an earlier run of the same
   * session — nothing happened on *this* turn. The caller must not announce
   * it again or hang it on this run's result.
   */
  repeat?: boolean;
}

/**
 * Close the audit for this session: stamp files the model looked at or
 * changed, update the registry, and report what really changed. Safe to
 * call more than once — the second call returns the stored result, flagged
 * `repeat` so a later run does not announce a turn's work as its own.
 */
export function finalizeGuidelineAudit(opts: {
  sessionId: string;
  workspace: string;
  /** The user's own last prompt. An advisory turn does not stamp. */
  lastUserMessage?: string;
}): GuidelineFinalizeResult {
  const nothing = (): GuidelineFinalizeResult => ({
    stamped: [],
    revised: [],
    ignored: [],
    unresolved: [],
    skipped: true,
  });
  const st = sessions.get(opts.sessionId);
  if (!st) return nothing();
  // Already closed by an earlier run of this session. Hand the stored result
  // back for the card, but flagged: without this every later prompt of the
  // session re-printed "AGENTS.md proofread … stamp updated" and hung
  // `guidelines` on a run that audited nothing.
  if (st.result) {
    st.reported = true;
    return { ...st.result, repeat: true };
  }
  if (st.phase !== "briefed") return nothing();
  // Decision (advisory turns do not stamp): a Q&A turn ends with no write to
  // the user's tracked guideline file. The stamp is an attestation that the
  // file was proofread; on a turn where nobody was asked to read it there is
  // nothing to attest, and silencing the audit for the next
  // FORGE_GUIDELINE_RECHECK_DAYS on the strength of it is the same defect the
  // unresolved-issue rule below already refuses. It is also a real write: on
  // ULW, `finalizeGuidelineAuditForRun` runs immediately before the release
  // auto-commit in loop.ts, so the stamp would land in a commit the user did
  // not ask for, off the back of a question. Reading AGENTS.md to *answer* a
  // question is not a proofread either — that is the point of the withheld
  // stamp, not a gap in it.
  //
  // Cheap to reverse: delete this one guard and an advisory turn stamps
  // again (the brief must also be un-deferred in `maybeGuidelineAuditBrief`
  // for the audit to reach this point at all).
  if (opts.lastUserMessage && looksLikeAdvisoryUserMessage(opts.lastUserMessage)) {
    return nothing();
  }
  const reg = loadGuidelineRegistry(st.root);
  const stamped: string[] = [];
  const revised: GuidelineRevisedFile[] = [];
  const ignored: string[] = [];
  const unresolved: GuidelineUnresolvedFile[] = [];
  const stampAt = nowIso();

  const before = new Map<string, GuidelineFileSurvey>();
  for (const f of st.survey.files) before.set(f.rel, f);
  const after = surveyGuidelines(opts.workspace);
  const afterMap = new Map<string, GuidelineFileSurvey>();
  for (const f of after.files) afterMap.set(f.rel, f);

  const rels = new Set<string>([...before.keys(), ...afterMap.keys()]);
  for (const rel of rels) {
    const prev = before.get(rel);
    const cur = afterMap.get(rel);
    if (!cur) continue; // deleted — nothing to stamp
    const changed = !prev || prev.hash !== cur.hash;
    const looked = st.looked.has(rel) || st.edited.has(rel) || changed;
    if (changed) {
      revised.push({
        rel,
        before: prev
          ? { bytes: prev.bytes, lines: prev.lines }
          : { bytes: 0, lines: 0 },
        after: { bytes: cur.bytes, lines: cur.lines },
        created: !prev,
      });
    }
    const wanted = prev ? prev.needsAudit : true;
    if (!looked) {
      if (wanted && cur.freshness !== "import") ignored.push(rel);
      continue;
    }
    if (cur.freshness === "import") {
      reg.files[rel] = { ...(reg.files[rel] || { hash: cur.hash }), hash: cur.hash, auditedAt: stampAt };
      continue;
    }
    if (cur.issues.length) {
      // Looked at, and the problem the brief named is still there. Stamping
      // would tell every session for the next FORGE_GUIDELINE_RECHECK_DAYS
      // that this file is fine, so the audit would never come back to it.
      // Record the look, withhold the stamp, and say what survived.
      unresolved.push({ rel, issues: cur.issues.map((i) => i.detail) });
      reg.files[rel] = {
        ...(reg.files[rel] || { hash: cur.hash }),
        hash: cur.hash,
        auditedAt: stampAt,
        bytes: cur.bytes,
        lines: cur.lines,
        ...(changed
          ? { revisedAt: stampAt, revisedBySession: opts.sessionId }
          : {}),
      };
      continue;
    }
    try {
      const text = fs.readFileSync(cur.abs, "utf8");
      const next = applyGuidelineStamp(text, stampAt);
      if (next !== text) fs.writeFileSync(cur.abs, next, "utf8");
      stamped.push(rel);
      reg.files[rel] = {
        hash: hashGuidelineBody(next),
        stampedAt: stampAt,
        auditedAt: stampAt,
        bytes: Buffer.byteLength(next, "utf8"),
        lines: next.split(/\r?\n/).length,
        ...(changed
          ? { revisedAt: stampAt, revisedBySession: opts.sessionId }
          : reg.files[rel]?.revisedAt
            ? {
                revisedAt: reg.files[rel].revisedAt,
                revisedBySession: reg.files[rel].revisedBySession,
              }
            : {}),
      };
    } catch {
      /* unwritable — leave unstamped */
    }
  }
  reg.lastAuditAt = stampAt;
  reg.lastAuditSession = opts.sessionId;
  try {
    saveGuidelineRegistry(reg);
  } catch {
    /* registry is best-effort */
  }
  st.phase = "done";
  st.result = { stamped, revised, ignored, unresolved, skipped: false };
  return st.result;
}

/**
 * User-facing lines after finalize (empty when nothing to say).
 *
 * One line per file, and the line says what actually happened to that file.
 * A revised file whose issue survived is not stamped, so it must never be
 * announced with "proofread stamp updated" and then contradicted two lines
 * later; the revision and the withheld stamp are one sentence.
 */
export function formatGuidelineAuditNotice(r: GuidelineFinalizeResult): string[] {
  if (r.skipped) return [];
  const out: string[] = [];
  const unresolvedBy = new Map(r.unresolved.map((u) => [u.rel, u]));
  const size = (f: GuidelineRevisedFile): string =>
    f.created
      ? `${f.after.lines} lines, ${fmtK(f.after.bytes)} chars`
      : `${f.before.lines} → ${f.after.lines} lines, ${fmtK(f.before.bytes)} → ${fmtK(f.after.bytes)} chars`;
  for (const f of r.revised) {
    const verb = f.created ? "written" : "revised";
    const open = unresolvedBy.get(f.rel);
    out.push(
      open
        ? `Agent guidelines: ${f.rel} ${verb} by the agent (${size(f)}) but not stamped — ${open.issues.join("; ")}. Next session audits it again (\`/guidelines stamp\` if you have read it and it is fine)`
        : `Agent guidelines: ${f.rel} ${verb} by the agent (${size(f)}) — proofread stamp ${f.created ? "added" : "updated"}`,
    );
  }
  const onlyStamped = r.stamped.filter((s) => !r.revised.some((v) => v.rel === s));
  if (onlyStamped.length) {
    out.push(
      `Agent guidelines: ${onlyStamped.join(", ")} proofread, no change needed — stamp updated`,
    );
  }
  for (const u of r.unresolved) {
    if (r.revised.some((v) => v.rel === u.rel)) continue; // already said above
    out.push(
      `Agent guidelines: ${u.rel} checked but not stamped — ${u.issues.join("; ")}. Next session audits it again (\`/guidelines stamp\` if you have read it and it is fine)`,
    );
  }
  if (r.ignored.length) {
    out.push(
      `Agent guidelines: ${r.ignored.join(", ")} not checked this session (audit brief ignored) — /guidelines to re-run next prompt`,
    );
  }
  return out;
}

/**
 * Report section body (run report / addendum / `/status`).
 *
 * The stored result belongs to the run that produced it. Once that run has
 * ended (`reported`, set on the repeat finalize) this falls back to the plain
 * survey line, so a later prompt's report says what the files are like now
 * rather than re-announcing `AGENTS.md proofread … stamp updated` for work
 * that happened several prompts ago. The loop suppresses the same repeat on
 * its own notice and on the `guidelines` result key; this is the third
 * surface reading that state, and the only other one.
 */
export function formatGuidelineReportLines(opts: {
  sessionId?: string;
  workspace: string;
}): string[] {
  const st = opts.sessionId ? sessions.get(opts.sessionId) : undefined;
  if (st?.result && !st.result.skipped && !st.reported) {
    const lines = formatGuidelineAuditNotice(st.result).map((l) =>
      l.replace(/^Agent guidelines:\s*/, ""),
    );
    return lines.length ? lines : ["checked, no change needed"];
  }
  try {
    const s = surveyGuidelines(opts.workspace);
    if (s.notAProject) return [];
    return [formatGuidelineStatusLine(s)];
  } catch {
    return [];
  }
}

/**
 * Stop guard: the model was briefed to proofread first and did neither
 * read nor edit a flagged file. Block once (cap 1) with the brief again.
 * FORGE_GUIDELINE_AUDIT_BLOCK=0 turns the block off (brief only).
 *
 * Wired at stop-guard **step 1c**, ahead of the drivers — the ULW driver
 * answers every Stop it is handed while armed, so a guard behind it never
 * runs in a `/ulw` session. See the comment at the call site.
 *
 * Advisory Q&A never bounces, like every sibling guard on this path
 * (report-guard, todo-gate, handoff-guard, proof-claim-guard). The brief
 * already defers on an advisory prompt, so this is the second door on the
 * same rule: a question must not cost a round. Returning early leaves the
 * one-block cap unspent, so a later work prompt in the same session is still
 * held if it ignores the brief.
 */
export function evaluateGuidelineAuditAtStop(opts: {
  sessionId: string;
  /** The user's own last prompt. Q&A turns are answers, not runs. */
  lastUserMessage?: string;
}): { block: boolean; reason?: string; reanchor?: string } {
  const st = sessions.get(opts.sessionId);
  if (!st || st.phase !== "briefed") return { block: false };
  if (isFalsy(process.env.FORGE_GUIDELINE_AUDIT_BLOCK ?? "1")) return { block: false };
  if (st.blocked) return { block: false };
  if (opts.lastUserMessage && looksLikeAdvisoryUserMessage(opts.lastUserMessage)) {
    return { block: false };
  }
  const wanted = st.survey.files.filter((f) => f.needsAudit).map((f) => f.rel);
  if (st.survey.missingPrimary) wanted.push("AGENTS.md");
  const touched = wanted.filter((rel) => st.looked.has(rel) || st.edited.has(rel));
  if (touched.length > 0 || wanted.length === 0) return { block: false };
  st.blocked = true;
  const reanchor = [
    `[Forge guideline-audit] Stop blocked once — the first action of this session was to proofread the agent guideline files, and none of ${wanted.join(", ")} was read.`,
    `read_file each one now; revise or rewrite what is wrong, stale, bloated, or steering badly (you are authorised); then finish the user's request and stop.`,
  ].join("\n");
  return { block: true, reason: reanchor, reanchor };
}

/** `/guidelines` card. */
export function formatGuidelineCard(opts: {
  workspace: string;
  sessionId?: string;
}): string {
  const s = surveyGuidelines(opts.workspace);
  const lines: string[] = [];
  if (s.notAProject) {
    lines.push("guidelines  ·  not a project (no git / manifest) — nothing to audit");
    return lines.join("\n");
  }
  const verdict = s.needsAudit ? "audit due" : "ok";
  lines.push(`guidelines  ·  ${verdict}  ·  ${s.root}`);
  if (s.missingPrimary) {
    lines.push("  · AGENTS.md — missing (the agent writes a short one on the next prompt)");
    // The card is where a user comes to ask "what is steering this repo?".
    // Answering "nothing" while the prompt loads the global map is the same
    // omission the status line had.
    if (s.globalFallback) {
      lines.push(
        `    ${globalFallbackLabel(s.globalFallback)} steers meanwhile — the user's own map, not audited or stamped here`,
      );
    }
  }
  for (const f of s.files) {
    lines.push(`  ${f.needsAudit ? "·" : "✓"} ${describeGuidelineFile(f)}`);
  }
  const st = opts.sessionId ? sessions.get(opts.sessionId) : undefined;
  if (st) {
    lines.push(
      `  this session: ${st.phase}${st.looked.size ? ` · looked ${[...st.looked].join(", ")}` : ""}${st.edited.size ? ` · edited ${[...st.edited].join(", ")}` : ""}`,
    );
    if (st.result) for (const l of formatGuidelineAuditNotice(st.result)) lines.push(`  ${l}`);
  }
  lines.push(
    `  registry: ${guidelineRegistryPath(s.root)}`,
    `  /guidelines audit re-briefs on the next prompt · /guidelines stamp stamps now · FORGE_GUIDELINE_AUDIT=0 off`,
  );
  return lines.join("\n");
}

/** `/guidelines audit`: forget this session's state so the next prompt briefs again. */
export function requestGuidelineAudit(sessionId: string): void {
  sessions.delete(sessionId);
}

/** `/guidelines stamp`: stamp every non-import file now (user-driven proofread). */
export function stampGuidelinesNow(workspace: string): string[] {
  const s = surveyGuidelines(workspace);
  const reg = loadGuidelineRegistry(s.root);
  const at = nowIso();
  const out: string[] = [];
  for (const f of s.files) {
    if (f.freshness === "import") continue;
    try {
      const text = fs.readFileSync(f.abs, "utf8");
      const next = applyGuidelineStamp(text, at);
      if (next !== text) fs.writeFileSync(f.abs, next, "utf8");
      reg.files[f.rel] = {
        ...(reg.files[f.rel] || {}),
        hash: hashGuidelineBody(next),
        stampedAt: at,
        auditedAt: at,
        bytes: Buffer.byteLength(next, "utf8"),
        lines: next.split(/\r?\n/).length,
      };
      out.push(f.rel);
    } catch {
      /* */
    }
  }
  reg.lastAuditAt = at;
  try {
    saveGuidelineRegistry(reg);
  } catch {
    /* */
  }
  return out;
}
