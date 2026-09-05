/**
 * Agent-guidelines audit — fix facts directly, propose doctrine.
 *
 * A wrong AGENTS.md / CLAUDE.md caps every session no matter how strong the
 * model is: a cited path that no longer exists steers reads into nothing, an
 * `npm run lint` with no such script wastes a round, a map the prompt has to
 * clip loses its tail. Nothing used to detect any of that.
 *
 * Two kinds of wrong, two treatments:
 *
 *   **Fact defects** are checkable against the repo — a backticked path that
 *   does not exist, a `package.json` script / Makefile target that is not
 *   there, a package-manager command that contradicts the lockfile, a file
 *   the prompt loader has to clip, an empty file. The model is briefed to
 *   **fix these in the file**, every time, whatever the file's size. Nobody
 *   wants a dead path in their map, so there is no authority question.
 *
 *   **Doctrine** — too long, contradictory, rules that fight verification,
 *   no commands at all — is a judgement about what deserves to be in the
 *   user's instructions. The model does the thinking and writes the pruned
 *   version to a **proposal file outside the repo**; the user lands it with
 *   `/guidelines apply` (or sets `guidelineAutoApply` to have it land
 *   directly, journaled for `/undo`). The tracked file is never rewritten
 *   for doctrine without that call. The model that is bound by a rule is not
 *   the one who silently decides the rule goes.
 *
 * Trigger is evidence, not a calendar: a file is briefed when it has a fact
 * defect, or when its body changed since the last proofread and it has any
 * issue. A stamp means "no fact defects at this hash" — doctrine issues
 * never withhold it, so a file can never nag forever. `/guidelines stamp`
 * acknowledges the current issues (they stay quiet until the body changes).
 *
 * The audited set is the loaded set: `surveyGuidelines` walks workspace →
 * git root through the same `collectInstructionFiles` the prompt's rules
 * loader uses (`src/agent/instruction-paths.ts`), so a nested
 * `packages/api/AGENTS.md` is audited (and shadows the monorepo root)
 * exactly as it is loaded. The two sets differ in exactly two documented
 * ways, both pinned by `tests/guideline-audit.test.ts`:
 *
 *   1. Audited, never loaded, never briefed: `AUDIT_ONLY_GUIDELINE_FILES` —
 *      `GEMINI.md`, `.windsurfrules`, `.clinerules`, `.claude/CLAUDE.md`.
 *      Sibling tools' maps. Surveyed so `/guidelines` and doctor can say
 *      "this one cites a dead path"; never stamped or rewritten by Forge,
 *      because Forge does not steer by them and they are another tool's.
 *   2. Loaded, never audited: `~/.forge/AGENTS.md`, the loader's global
 *      fallback. The user's own file, reported as what steers in the
 *      meantime (`GuidelineSurvey.globalFallback`), never surveyed.
 *
 * Registry: `~/.forge/guidelines/<projectKey>.json` (hash per file, mode
 * 0600); proposals: `~/.forge/guidelines/<projectKey>/<rel>.proposed.md`.
 * Sibling stamps (`· sisyphus-all`, `· oh-my-claude`) count as proofread.
 *
 * **Advisory Q&A turns never audit.** A question is not a work turn: it may
 * not be diverted into a proofread and may not end with a write to a file
 * the user never asked anyone to touch. The brief and the stamp both defer
 * on `looksLikeAdvisoryUserMessage`; `phase` stays `"pending"`, so the next
 * real work prompt in the same session audits exactly as it would have.
 *
 * There is no Stop block. An ignored fact brief is a line in the run report
 * and re-briefs next session; fact defects are cheap and unambiguous.
 *
 * Kill-switch: FORGE_GUIDELINE_AUDIT=0. Subagents never audit.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isFalsy } from "../util/bool.js";
import { looksLikeAdvisoryUserMessage } from "../util/advisory-intent.js";
import { ensureDir, forgeHome, nowIso, readJsonFile, writeJsonFile } from "../util/fs.js";
import {
  collectInstructionFiles,
  globalAgentsPath,
  nearestGitRoot,
  promptRuleFiles,
  ruleFileBudget,
  RULES_PER_FILE_CHARS,
} from "../agent/instruction-paths.js";
import {
  primaryCommand,
  splitShellSegments,
  tokenizeSimple,
} from "../agent/shell-parse.js";
import { multipleLockfiles, type PackageManager } from "../util/project-intel.js";
import { appendFileMutation } from "../session/mutations.js";
import { createChildEnv } from "../agent/tools/env-policy.js";
import { projectMemoryKey } from "./project-memory.js";

/**
 * The prompt loader's per-file floor. A lone file gets the whole 28k total
 * now (`ruleFileBudget`), so "over the cap" is computed per repo, not from
 * this number; it is kept for the display text and the pin test.
 */
export const GUIDELINE_MANUAL_CHARS = RULES_PER_FILE_CHARS;
/** Over this many lines a file is a manual, not a map — doctrine, never a nag. */
export const GUIDELINE_MANUAL_LINES = 300;
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
 * Difference 1 from the prompt loader (module header): sibling tools' maps.
 * Surveyed for the card and doctor, never briefed, stamped or written.
 */
export const AUDIT_ONLY_GUIDELINE_FILES = [
  "GEMINI.md",
  ".windsurfrules",
  ".clinerules",
  ".claude/CLAUDE.md",
] as const;

const AUDIT_ONLY_SET: ReadonlySet<string> = new Set<string>(AUDIT_ONLY_GUIDELINE_FILES);

const STAMP_RE =
  /^[ \t]*<!--\s*proofread\s+(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?)\s*(?:[·\-|]\s*([\w.+-]+))?\s*-->[ \t]*$/im;
const STAMP_LINE_RE =
  /^[ \t]*<!--\s*proofread\s+[^>]*-->[ \t]*(?:\r?\n|$)/gim;

export type GuidelineFreshness = "never" | "fresh" | "edited" | "import";

export type GuidelineIssueClass = "fact" | "doctrine";

export type GuidelineIssueKind =
  // fact — checkable against the repo; the model fixes these in the file
  | "stale-paths"
  | "stale-commands"
  | "pm-mismatch"
  | "clipped"
  | "empty"
  // doctrine — a judgement; the model proposes, the user applies
  | "long"
  | "conflict"
  | "no-commands";

export const FACT_ISSUE_KINDS: ReadonlySet<GuidelineIssueKind> = new Set<GuidelineIssueKind>([
  "stale-paths",
  "stale-commands",
  "pm-mismatch",
  "clipped",
  "empty",
]);

export function issueClass(kind: GuidelineIssueKind): GuidelineIssueClass {
  return FACT_ISSUE_KINDS.has(kind) ? "fact" : "doctrine";
}

export interface GuidelineIssue {
  kind: GuidelineIssueKind;
  class: GuidelineIssueClass;
  detail: string;
}

export interface GuidelineFileSurvey {
  /** Path relative to the project root (display + registry key). */
  rel: string;
  abs: string;
  primary: boolean;
  /** Sibling-tool file: surveyed for display only (never briefed / stamped / written). */
  auditOnly: boolean;
  bytes: number;
  lines: number;
  /** sha256 of the body with stamp lines removed. */
  hash: string;
  stampedAt?: string;
  stampedBy?: string;
  freshness: GuidelineFreshness;
  issues: GuidelineIssue[];
  /** Issues the user acknowledged with `/guidelines stamp` at this hash (hidden from `issues`). */
  acknowledged: number;
  /** True when the model should be briefed about this file. */
  needsAudit: boolean;
  /** A doctrine proposal is parked for this file. */
  proposalPath?: string;
}

export interface GuidelineSurvey {
  root: string;
  files: GuidelineFileSurvey[];
  /** No primary file at all — the model should write a short AGENTS.md. */
  missingPrimary: boolean;
  /**
   * Absolute path of `~/.forge/AGENTS.md` when the prompt loader's global
   * fallback is what steers this session, else null. Never surveyed, never
   * stamped, never rewritten — only named.
   */
  globalFallback: string | null;
  /** Anything to brief (missing primary, or any file needsAudit). */
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
  /** Issue keys (`kind:detail`) the user acknowledged at `hash` via /guidelines stamp. */
  acknowledged?: string[];
  /** Parked doctrine proposal (path outside the repo). */
  proposal?: { path: string; hash: string; at: string; bySession?: string };
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

function registryKey(root: string): string {
  let key = path.resolve(root);
  try {
    key = fs.realpathSync(key);
  } catch {
    /* not on disk (yet) — the literal path is the key */
  }
  return projectMemoryKey(key);
}

/**
 * Registry file for a root. The **key** is canonicalized (realpath), the
 * root is not: the same repo reached through a symlink must be one registry.
 */
export function guidelineRegistryPath(root: string): string {
  return path.join(forgeHome(), "guidelines", `${registryKey(root)}.json`);
}

/**
 * Where a doctrine proposal for `rel` is parked: beside the registry, never
 * in the repo — so it cannot dirty the tree, enter a ULW auto-commit, or be
 * scored as a chrome wave.
 */
export function guidelineProposalPath(root: string, rel: string): string {
  return path.join(
    forgeHome(),
    "guidelines",
    registryKey(root),
    `${rel.replace(/[\\/]/g, "__")}.proposed.md`,
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
 * The same walk the prompt's rules loader stops at.
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

// ---------------------------------------------------------------------------
// Command extraction (shared by the fact check and the doctrine check)
// ---------------------------------------------------------------------------

const INLINE_CODE_RE = /`([^`\n]+)`/g;
const FENCE_RE = /```(?:bash|sh|shell|zsh|console|fish)?[ \t]*\n([\s\S]*?)```/gi;

/** Command lines a guideline file offers: inline code spans + shell fences. */
export function extractGuidelineCommands(text: string): string[] {
  const out: string[] = [];
  const body = stripGuidelineStamp(text);
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(body)) !== null) {
    for (const raw of m[1].split(/\r?\n/)) {
      const line = raw.replace(/^\s*[$>]\s*/, "").replace(/\s+#.*$/, "").trim();
      if (line && !line.startsWith("#")) out.push(line);
    }
  }
  const noFences = body.replace(FENCE_RE, "");
  INLINE_CODE_RE.lastIndex = 0;
  while ((m = INLINE_CODE_RE.exec(noFences)) !== null) {
    const span = m[1].trim();
    // A span with no space and no slash is a symbol or a path, not a command.
    if (!/\s/.test(span) && !/^\.{0,2}\//.test(span)) continue;
    out.push(span);
  }
  return out;
}

/** Heads that make a span read as "a command an agent can run". */
const COMMAND_HEAD_RE =
  /^(?:npm|pnpm|yarn|bun|npx|node|deno|cargo|rustc|go|gofmt|pytest|python3?|pip3?|uv|poetry|tox|ruff|black|mypy|make|cmake|ninja|meson|ctest|just|task|earthly|bazel|bazelisk|buck2?|pants|nix|nix-shell|nix-build|swift|swiftc|xcodebuild|fastlane|pod|tuist|dotnet|msbuild|nuget|gradle|gradlew|mvn|mvnw|ant|sbt|scala|scala-cli|mill|lein|clj|clojure|boot|mix|elixir|iex|erl|rebar3|bundle|rake|rspec|ruby|gem|zig|dart|flutter|melos|tsc|vitest|jest|mocha|ava|tap|eslint|prettier|biome|oxlint|composer|php|artisan|stack|cabal|ghc|ghcup|dune|opam|ocaml|nimble|nim|crystal|shards|v|odin|gleam|roc|julia|Rscript|R|terraform|tofu|pulumi|ansible|helm|kubectl|docker|docker-compose|podman|vagrant|act|gh|git|turbo|nx|lerna|moon|rush|wasm-pack|trunk|forge|anchor|hardhat|truffle|foundry|sh|bash|zsh|\.\/[\w.-]+|scripts\/[\w.-]+|bin\/[\w.-]+)\b/;

export function guidelineHasCommands(text: string, root?: string): boolean {
  const cmds = extractGuidelineCommands(text);
  if (!cmds.length) return false;
  const scripts = root ? packageScripts(root) : null;
  const targets = root ? makeTargets(root) : null;
  for (const c of cmds) {
    const head = c.split(/\s+/)[0] || "";
    if (COMMAND_HEAD_RE.test(c)) return true;
    if (scripts?.has(head) || targets?.has(head)) return true;
    if (/^\.{0,2}\//.test(head)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fact checks
// ---------------------------------------------------------------------------

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function packageScripts(root: string): Set<string> | null {
  const pkg = readJsonSafe(path.join(root, "package.json"));
  if (!pkg) return null;
  const s = pkg.scripts;
  return s && typeof s === "object" ? new Set(Object.keys(s as object)) : new Set();
}

function makeTargets(root: string): Set<string> | null {
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    try {
      const text = fs.readFileSync(path.join(root, name), "utf8");
      const out = new Set<string>();
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z0-9_][\w.-]*)\s*:(?!=)/);
        if (m) out.add(m[1]);
      }
      return out;
    } catch {
      /* next */
    }
  }
  return null;
}

/** npm lifecycle names that run without `run`. */
/**
 * npm subcommands that are only aliases for a `package.json` script — these
 * fail when the script is missing. `install` / `ci` / `publish` / `version`
 * are built-ins that work without one (they merely *also* run hooks), so a
 * README's `npm install` is never stale.
 */
const NPM_LIFECYCLE = new Set(["test", "start", "stop", "restart"]);

/**
 * Backticked / fenced commands that name a `package.json` script or a
 * Makefile target that does not exist, or a `./script` path that is not on
 * disk. Bare binaries (`cargo`, `bazel`, `pytest`) are **not** checked: a
 * machine without rust does not make the guideline wrong. Kept to what the
 * repo itself can prove.
 */
export function findStaleGuidelineCommands(text: string, root: string, limit = 8): string[] {
  const stale: string[] = [];
  const seen = new Set<string>();
  const scripts = packageScripts(root);
  const targets = makeTargets(root);
  for (const cmd of extractGuidelineCommands(text)) {
    for (const seg of splitShellSegments(cmd)) {
      const toks = tokenizeSimple(seg).filter((t) => t && !t.startsWith("-"));
      if (!toks.length) continue;
      const head = toks[0];
      let label: string | null = null;
      if (scripts && /^(?:npm|pnpm|yarn|bun)$/.test(head)) {
        let name: string | undefined;
        if (toks[1] === "run" || toks[1] === "run-script") name = toks[2];
        else if (head === "npm" && toks[1] && NPM_LIFECYCLE.has(toks[1])) name = toks[1];
        else if (head === "yarn" && toks[1] && !/^(?:add|remove|install|up|dlx|why|info|init|link|unlink|set|config|create|workspace|workspaces|exec|node|bin|cache|pack|publish|patch|version)$/.test(toks[1])) name = toks[1];
        else if (head === "pnpm" && toks[1] && /^(?:test|start|build|lint|typecheck|check|dev)$/.test(toks[1])) name = toks[1];
        else if (head === "bun" && toks[1] && /^(?:test)$/.test(toks[1])) name = undefined; // bun test is the runner, not a script
        if (name && !/[$*{}<>]/.test(name) && !scripts.has(name)) {
          // `npm test` with no `test` script still runs the npm default error; flag it.
          label = `\`${seg.trim()}\` — no \`${name}\` script in package.json`;
        }
      } else if (head === "make") {
        const target = toks.slice(1).find((t) => !t.includes("="));
        if (target && !/[$*{}<>]/.test(target)) {
          if (targets == null) label = `\`${seg.trim()}\` — no Makefile in the repo`;
          else if (!targets.has(target)) label = `\`${seg.trim()}\` — no \`${target}\` target in the Makefile`;
        }
      } else if (/^\.{0,2}\//.test(head) || /^(?:scripts|bin|tools)\//.test(head)) {
        if (/[*{}$<>]/.test(head)) continue;
        const abs = path.resolve(root, head);
        if (abs.startsWith(path.resolve(root)) && !fs.existsSync(abs)) {
          label = `\`${seg.trim()}\` — ${head} does not exist`;
        }
      }
      if (label && !seen.has(label)) {
        seen.add(label);
        stale.push(label);
        if (stale.length >= limit) return stale;
      }
    }
  }
  return stale;
}

/**
 * The file says `pnpm …` / `yarn …` while the repo has exactly one lockfile
 * and it belongs to a different package manager. Only when unambiguous:
 * multiple lockfiles or no lockfile at all is not a defect of the file.
 */
export function findGuidelinePmMismatch(text: string, root: string): string | null {
  if (!fs.existsSync(path.join(root, "package.json"))) return null;
  if (multipleLockfiles(root).length > 1) return null;
  // A hard signal only: one lockfile, or an explicit `packageManager` field.
  // `detectPackageManager` defaults a bare package.json to npm, and a default
  // is not evidence the file is wrong.
  const lock: PackageManager | null = fs.existsSync(path.join(root, "pnpm-lock.yaml"))
    ? "pnpm"
    : fs.existsSync(path.join(root, "yarn.lock"))
      ? "yarn"
      : fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock"))
        ? "bun"
        : fs.existsSync(path.join(root, "package-lock.json")) || fs.existsSync(path.join(root, "npm-shrinkwrap.json"))
          ? "npm"
          : null;
  const detected = lock ?? (() => {
    const pkg = readJsonSafe(path.join(root, "package.json"));
    const field = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0]?.trim().toLowerCase() : "";
    return field === "npm" || field === "pnpm" || field === "yarn" || field === "bun" ? (field as PackageManager) : null;
  })();
  if (!detected) return null;
  const used = new Set<PackageManager>();
  for (const cmd of extractGuidelineCommands(text)) {
    for (const seg of splitShellSegments(cmd)) {
      const head = primaryCommand(seg);
      if (head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") used.add(head);
    }
  }
  used.delete(detected);
  if (!used.size) return null;
  const other = [...used].join("/");
  return `says \`${other}\` but the repo uses ${detected} (its lockfile is the only one)`;
}

/**
 * Rules that fight verification or autonomy — the two that matter. A
 * guideline may legitimately say "never push", "never commit secrets", or
 * "do not run tests against production"; those are not conflicts.
 */
const CONFLICT_RULES: Array<{ re: RegExp; label: string }> = [
  {
    // "never run tests" but not "never run tests against/on/in <env>"
    re: /\b(?:never|do not|don't)\s+(?:run(?:ning)?|execut(?:e|ing))\s+(?:the\s+)?(?:tests?|test suite|checks?|typecheck|lint(?:er)?)\b(?!\s+(?:against|on|in|with|for|from|at)\b)/i,
    label: "forbids running tests/checks",
  },
  {
    re: /\b(?:always\s+)?ask\s+(?:for\s+)?(?:permission|confirmation|approval)\s+before\s+(?:every|each|any|making|editing|changing|writing)\b/i,
    label: "asks permission before every edit",
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

function issueKey(i: { kind: string; detail: string }): string {
  return `${i.kind}:${i.detail}`;
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
}

function fmtChars(n: number): string {
  return n.toLocaleString("en-US");
}

function surveyOne(opts: {
  root: string;
  rel: string;
  abs: string;
  primary: boolean;
  auditOnly: boolean;
  reg: GuidelineRegistry;
  /** Per-file budget the prompt would give this file (loaded files only). */
  promptBudget: number | null;
}): GuidelineFileSurvey | null {
  const { root, rel, abs, primary, auditOnly, reg } = opts;
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
  const found: GuidelineIssue[] = [];
  const push = (kind: GuidelineIssueKind, detail: string) =>
    found.push({ kind, class: issueClass(kind), detail });

  const importOnly = isImportOnlyGuideline(text);
  let freshness: GuidelineFreshness;
  if (!stripGuidelineStamp(text).trim()) {
    freshness = "never";
    push("empty", "file is empty");
  } else if (importOnly) {
    freshness = "import";
  } else if (!stamp) {
    freshness = "never";
  } else if (prev?.hash && prev.hash !== hash) {
    freshness = "edited";
  } else {
    freshness = "fresh";
  }

  if (!importOnly && stripGuidelineStamp(text).trim()) {
    // fact
    if (opts.promptBudget != null && bytes > opts.promptBudget) {
      push(
        "clipped",
        `over the ${fmtChars(opts.promptBudget)}-char share the prompt can load, so the tail is invisible to agents`,
      );
    }
    const stalePaths = findStaleGuidelinePaths(text, root);
    if (stalePaths.length) {
      push(
        "stale-paths",
        `${stalePaths.length} path${stalePaths.length === 1 ? "" : "s"} no longer exist${stalePaths.length === 1 ? "s" : ""}: ${stalePaths.slice(0, 3).join(", ")}${stalePaths.length > 3 ? ", …" : ""}`,
      );
    }
    for (const c of findStaleGuidelineCommands(text, root)) push("stale-commands", c);
    const pm = findGuidelinePmMismatch(text, root);
    if (pm) push("pm-mismatch", pm);
    // doctrine
    if (lines > GUIDELINE_MANUAL_LINES) {
      push("long", `a map, not a manual (over ${GUIDELINE_MANUAL_LINES} lines)`);
    }
    if (primary && !guidelineHasCommands(text, root)) {
      push("no-commands", "no build/test/typecheck commands an agent can run");
    }
    for (const c of detectGuidelineConflicts(text)) push("conflict", c);
  }

  // Acknowledged at this exact hash → hidden. A body change resets it.
  const ack = new Set(prev?.hash === hash ? prev?.acknowledged ?? [] : []);
  const issues = found.filter((i) => !ack.has(issueKey(i)));
  const acknowledged = found.length - issues.length;

  const factIssues = issues.filter((i) => i.class === "fact");
  const proposalPath = (() => {
    const p = prev?.proposal?.path;
    try {
      return p && fs.existsSync(p) ? p : undefined;
    } catch {
      return undefined;
    }
  })();

  // Evidence trigger: a fact defect always; otherwise only when the body is
  // not the one that was last proofread and something is still flagged.
  const needsAudit =
    !auditOnly &&
    freshness !== "import" &&
    (factIssues.length > 0 || (freshness !== "fresh" && issues.length > 0));

  return {
    rel,
    abs,
    primary,
    auditOnly,
    bytes,
    lines,
    hash,
    stampedAt: stamp?.at,
    stampedBy: stamp?.by,
    freshness,
    issues,
    acknowledged,
    needsAudit,
    ...(proposalPath ? { proposalPath } : {}),
  };
}

/**
 * Registry key and display label for a surveyed file: its path relative to
 * the resolved root (`AGENTS.md`, `packages/api/AGENTS.md`).
 */
function relFromRoot(root: string, abs: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return !rel || rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel;
}

const PRIMARY_SET: ReadonlySet<string> = new Set<string>(PRIMARY_GUIDELINE_FILES);

/** Names whose nearest copy shadows the ones above it, matching the prompt loader. */
const SHADOW_GUIDELINE_BASENAMES: readonly string[] = [
  ...PRIMARY_GUIDELINE_FILES,
  ".cursorrules",
];

/**
 * Survey the guideline files that steer a session started in `workspace`,
 * seeded by the same workspace → git-root walk the system prompt loads from.
 */
export function surveyGuidelines(workspace: string): GuidelineSurvey {
  const root = resolveGuidelineRoot(workspace);
  const notAProject = !looksLikeProject(root);
  const reg = loadGuidelineRegistry(root);
  const files: GuidelineFileSurvey[] = [];
  const found = collectInstructionFiles(workspace, {
    files: GUIDELINE_FILES,
    shadowBasenames: SHADOW_GUIDELINE_BASENAMES,
    cursorRules: true,
  });
  // What the prompt would actually load, so "clipped" is the prompt's own
  // arithmetic: a lone file has the whole total, two share it, …
  const loaded = promptRuleFiles(workspace);
  const loadedAbs = new Set(loaded.map((f) => path.resolve(f.abs)));
  const budget = ruleFileBudget(loaded.length);
  const one = (entry: { abs: string; name: string }, primary: boolean) =>
    surveyOne({
      root,
      rel: relFromRoot(root, entry.abs),
      abs: entry.abs,
      primary,
      auditOnly: AUDIT_ONLY_SET.has(entry.name),
      reg,
      promptBudget: loadedAbs.has(path.resolve(entry.abs)) ? budget : null,
    });
  // Primary is the rule that matched, not the basename: `.claude/CLAUDE.md`
  // is a secondary even though it is called CLAUDE.md.
  for (const entry of found.filter((e) => PRIMARY_SET.has(e.name))) {
    const f = one(entry, true);
    if (f) files.push(f);
  }
  for (const entry of found.filter((e) => !PRIMARY_SET.has(e.name))) {
    const f = one(entry, false);
    if (f) files.push(f);
  }
  // An import-only pointer (`CLAUDE.md` = `@AGENTS.md`) is not a map of its
  // own: with nothing behind it the project still has no primary file.
  const missingPrimary =
    !notAProject &&
    !files.some((f) => f.primary && !f.auditOnly && f.freshness !== "import");
  const needsAudit =
    !notAProject && (missingPrimary || files.some((f) => f.needsAudit));
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
      : f.freshness === "edited"
        ? `edited since proofread ${f.stampedAt}`
        : f.freshness === "import"
          ? "import-only pointer — fine"
          : "never proofread";
  const facts = f.issues.filter((i) => i.class === "fact").map((i) => i.detail);
  const doctrine = f.issues.filter((i) => i.class === "doctrine").map((i) => i.detail);
  const parts = [`${f.rel} — ${size} — ${fresh}`];
  if (facts.length) parts.push(`defects: ${facts.join("; ")}`);
  if (doctrine.length) parts.push(`doctrine: ${doctrine.join("; ")}`);
  if (f.acknowledged) parts.push(`${f.acknowledged} acknowledged`);
  if (f.proposalPath) parts.push("proposal pending");
  if (f.auditOnly) parts.push("another tool's file — reported only");
  return parts.join(" — ");
}

/** `~/.forge/AGENTS.md`, never the expanded home path. */
export function globalFallbackLabel(abs: string): string {
  return `~/.forge/${path.basename(abs)}`;
}

/** One-line status for doctor / /status / report. */
export function formatGuidelineStatusLine(s: GuidelineSurvey): string {
  if (s.notAProject) return "not a project";
  if (s.missingPrimary) {
    return s.globalFallback
      ? `AGENTS.md missing · ${globalFallbackLabel(s.globalFallback)} steers instead`
      : "AGENTS.md missing";
  }
  const parts = s.files
    .filter((f) => (f.primary && !f.auditOnly) || f.needsAudit || f.proposalPath)
    .map((f) => {
      const facts = f.issues.filter((i) => i.class === "fact").length;
      const doctrine = f.issues.filter((i) => i.class === "doctrine").length;
      const bits: string[] = [];
      if (f.freshness === "import") bits.push("import");
      else if (f.freshness === "never") bits.push("never proofread");
      else if (f.freshness === "edited") bits.push("edited");
      else bits.push(`fresh (${(f.stampedAt || "").slice(0, 10)})`);
      if (facts) bits.push(`${facts} defect${facts === 1 ? "" : "s"}`);
      if (doctrine) bits.push(`${doctrine} doctrine`);
      if (f.proposalPath) bits.push("proposal pending");
      return `${f.rel} ${bits.join(" · ")}`;
    });
  return parts.join(" · ") || "none";
}

export const GUIDELINE_BRIEF_PREFIX = "[Forge harness — agent guidelines audit]";

/**
 * The brief. Appended after the user's prompt (append-only, cache-safe).
 * Two sections: facts to fix in the file, doctrine to propose.
 */
export function formatGuidelineAuditBrief(s: GuidelineSurvey, opts?: { autoApply?: boolean }): string {
  const lines: string[] = [
    GUIDELINE_BRIEF_PREFIX,
    `Alongside the user's request this turn, check the agent guideline files below. A wrong map caps every session; fix the facts, propose the doctrine.`,
    ``,
    `Files (relative to ${s.root}):`,
  ];
  const briefed = s.files.filter((f) => !f.auditOnly);
  if (s.missingPrimary) {
    lines.push(
      `  · AGENTS.md — missing. Write a short one (what the project is, exact build/test/typecheck commands that exist in this repo, layout map, conventions, non-negotiables).`,
    );
    if (s.globalFallback) {
      lines.push(
        `    (${globalFallbackLabel(s.globalFallback)} is steering this session in the meantime — the user's own map, not this project's. Do not edit it.)`,
      );
    }
  }
  for (const f of briefed) {
    const mark = f.needsAudit ? "·" : "✓";
    lines.push(`  ${mark} ${describeGuidelineFile(f)}`);
  }
  const factFiles = briefed.filter((f) => f.needsAudit && f.issues.some((i) => i.class === "fact"));
  const doctrineFiles = briefed.filter((f) => f.needsAudit && f.issues.some((i) => i.class === "doctrine"));
  if (factFiles.length || s.missingPrimary) {
    lines.push(``, `Fix now — factual defects (edit the file directly; you are authorised):`);
    for (const f of factFiles) {
      for (const i of f.issues.filter((x) => x.class === "fact")) {
        lines.push(`  • ${f.rel}: ${i.detail}`);
      }
    }
    lines.push(
      `  Correct the path or command to what actually exists, or delete the line. Over the prompt's share: move detail to docs/ and link it. Change nothing else while you are in there.`,
    );
  }
  if (doctrineFiles.length) {
    lines.push(``, `Propose — doctrine (judgement, so it is the user's call):`);
    for (const f of doctrineFiles) {
      const ds = f.issues.filter((x) => x.class === "doctrine").map((x) => x.detail);
      lines.push(`  • ${f.rel}: ${ds.join("; ")}`);
      lines.push(`    proposal file: ${guidelineProposalPath(s.root, f.rel)}`);
    }
    lines.push(
      `  If you judge a file bloated, contradictory, or steering badly, write the pruned version with write_file to its proposal file (full file text; keep what is load-bearing — exact commands, layout, non-negotiables; move manual detail to docs/). Do NOT edit the tracked file for doctrine. If the file is fine as it is, leave it and say so. Summarise any proposal under **Agent guidelines** in your closing message.`,
    );
    if (opts?.autoApply) {
      lines.push(`  (guidelineAutoApply is on for this repo: the harness lands the proposal itself, journaled for /undo.)`);
    }
  }
  lines.push(
    ``,
    `A guideline file is a map, not a manual: what the project is (2 lines), the exact commands (install, build, typecheck, test, run), a layout map one line per directory, conventions and non-negotiables an agent would otherwise get wrong. Every cited path and command must exist. No changelog, no feature catalog.`,
    `Do not write the proofread stamp yourself — the harness stamps \`${formatGuidelineStamp()}\` when the re-check is clean and tells the user what changed. Then finish the user's request in the same turn.`,
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
  /** Proposal files written this session, by tracked rel. */
  proposed: Set<string>;
  briefedAt?: string;
  result?: GuidelineFinalizeResult;
  /** The run that closed this audit has ended; later runs must not re-announce it. */
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
  autoApply?: boolean;
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
      proposed: new Set(),
    };
    sessions.set(opts.sessionId, st);
  }
  if (st.phase !== "pending") return null;
  if (opts.readOnly) return null;
  // A pure question is not a work turn. Defer exactly as `readOnly` does —
  // `phase` stays "pending", so the next work prompt of this session audits.
  if (opts.lastUserMessage && looksLikeAdvisoryUserMessage(opts.lastUserMessage)) {
    return null;
  }
  st.phase = "briefed";
  st.briefedAt = nowIso();
  return formatGuidelineAuditBrief(st.survey, { autoApply: opts.autoApply });
}

/** True while a brief has been emitted and the audit has not been finalized. */
export function guidelineAuditBriefed(sessionId: string): boolean {
  return sessions.get(sessionId)?.phase === "briefed";
}

interface Target {
  rel: string;
  abs: string;
  proposal: boolean;
}

/** The files a tool call could be about, with the paths they really live at. */
function guidelineTargets(st: SessionAuditState): Target[] {
  const out: Target[] = [];
  for (const f of st.survey.files) {
    if (f.auditOnly) continue;
    out.push({ rel: f.rel, abs: path.resolve(f.abs), proposal: false });
    out.push({ rel: f.rel, abs: path.resolve(guidelineProposalPath(st.root, f.rel)), proposal: true });
  }
  if (st.survey.missingPrimary) {
    for (const base of [st.root, st.workspace]) {
      out.push({ rel: "AGENTS.md", abs: path.resolve(base, "AGENTS.md"), proposal: false });
    }
  }
  return out;
}

/**
 * Guideline files that a path-carrying argument of this call **resolves to**.
 * Evidence, not mention: a token is resolved against the workspace and, only
 * if that hits nothing, against the survey root. Absolute paths resolve as
 * themselves, which is how a proposal file (under ~/.forge) is credited.
 */
function resolveGuidelineHits(st: SessionAuditState, tokens: string[]): Target[] {
  if (!tokens.length) return [];
  const targets = guidelineTargets(st);
  if (!targets.length) return [];
  const hits = new Map<string, Target>();
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
      for (const t of found) hits.set(`${t.rel}:${t.proposal}`, t);
      break;
    }
  }
  return [...hits.values()];
}

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

const PATCH_TARGET_RE = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$|^\*\*\*\s+Move to:\s*(.+?)\s*$/gim;

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

function bashSegmentTokens(segment: string): string[] {
  const out: string[] = [];
  for (const t of tokenizeSimple(segment)) {
    const tok = t.replace(/^[<>&|]+/, "");
    if (!tok || (tok.startsWith("-") && tok !== "-")) continue;
    out.push(tok);
  }
  return out;
}

/** `grep` / `glob` are NOT a look — a pattern match returns lines, not the file. */
const READ_TOOLS = new Set(["read_file"]);
const WRITE_TOOLS = new Set(["write_file", "search_replace", "apply_patch"]);

const BASH_LOOK_HEADS = new Set(["cat", "bat", "head", "tail", "less", "more", "nl", "sed"]);
const BASH_EDIT_RE = /(?:>|>>|\btee\b|\bsed\s+-i|\bperl\s+-p?i|\bmv\b|\bcp\b|\brm\b)/;

/**
 * Record that the model looked at / edited a guideline file, or wrote a
 * proposal, this session. Only while a brief is open.
 */
export function noteGuidelineToolCall(
  sessionId: string,
  toolName: string,
  args: unknown,
): void {
  const st = sessions.get(sessionId);
  if (!st || st.phase !== "briefed") return;
  const name = String(toolName || "").toLowerCase();
  const credit = (hits: Target[], read: boolean, write: boolean) => {
    for (const h of hits) {
      if (h.proposal) {
        if (write) st.proposed.add(h.rel);
        continue;
      }
      if (read) st.looked.add(h.rel);
      if (write) st.edited.add(h.rel);
    }
  };
  if (name === "bash") {
    const cmd = String((args as { command?: unknown })?.command ?? "");
    for (const segment of splitShellSegments(cmd)) {
      const hits = resolveGuidelineHits(st, bashSegmentTokens(segment));
      if (!hits.length) continue;
      credit(
        hits,
        BASH_LOOK_HEADS.has(primaryCommand(segment)),
        BASH_EDIT_RE.test(segment),
      );
    }
    return;
  }
  const read = READ_TOOLS.has(name);
  const write = WRITE_TOOLS.has(name);
  if (!read && !write) return;
  credit(resolveGuidelineHits(st, argPathTokens(args)), read, write);
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

export interface GuidelineProposal {
  rel: string;
  path: string;
  before: { bytes: number; lines: number };
  after: { bytes: number; lines: number };
}

export interface GuidelineFinalizeResult {
  /** Files stamped this run. */
  stamped: string[];
  /** Files whose tracked body actually changed (created or edited). */
  revised: GuidelineRevisedFile[];
  /** Briefed files the model neither read, edited nor proposed for. */
  ignored: string[];
  /** Files the model looked at that still carry a **fact** defect — not stamped. */
  unresolved: GuidelineUnresolvedFile[];
  /** Doctrine proposals parked this run (outside the repo). */
  proposals: GuidelineProposal[];
  /** Proposals landed into the tracked file this run (`guidelineAutoApply`). */
  applied: GuidelineProposal[];
  /** Model was never briefed (fresh / disabled / subagent / advisory / not a project). */
  skipped: boolean;
  /** Already closed by an earlier run of this session — do not re-announce. */
  repeat?: boolean;
}

function sizeOf(text: string): { bytes: number; lines: number } {
  return { bytes: Buffer.byteLength(text, "utf8"), lines: text.split(/\r?\n/).length };
}

/**
 * Land a proposal into its tracked file: journal the pre-image so `/undo`
 * can revert, write, stamp, drop the proposal file. Shared by autoApply and
 * `/guidelines apply`.
 */
function landProposal(opts: {
  root: string;
  rel: string;
  abs: string;
  proposalPath: string;
  sessionId?: string;
  turn?: number;
  reg: GuidelineRegistry;
  at: string;
}): GuidelineProposal | null {
  let proposed: string;
  try {
    proposed = fs.readFileSync(opts.proposalPath, "utf8");
  } catch {
    return null;
  }
  if (!proposed.trim()) return null;
  let before = "";
  let mode: number | undefined;
  let existed = false;
  try {
    before = fs.readFileSync(opts.abs, "utf8");
    existed = true;
    mode = fs.statSync(opts.abs).mode & 0o777;
  } catch {
    /* new file */
  }
  if (opts.sessionId) {
    try {
      appendFileMutation(opts.sessionId, {
        path: opts.abs,
        kind: existed ? "update" : "create",
        before: existed ? before : undefined,
        turn: opts.turn ?? 0,
        mode,
      });
    } catch {
      /* journal is best-effort */
    }
  }
  const next = applyGuidelineStamp(proposed, opts.at);
  fs.writeFileSync(opts.abs, next, "utf8");
  try {
    fs.unlinkSync(opts.proposalPath);
  } catch {
    /* */
  }
  const cur = opts.reg.files[opts.rel] || { hash: hashGuidelineBody(next) };
  opts.reg.files[opts.rel] = {
    ...cur,
    hash: hashGuidelineBody(next),
    stampedAt: opts.at,
    auditedAt: opts.at,
    bytes: Buffer.byteLength(next, "utf8"),
    lines: next.split(/\r?\n/).length,
    revisedAt: opts.at,
    revisedBySession: opts.sessionId,
    acknowledged: [],
    proposal: undefined,
  };
  return {
    rel: opts.rel,
    path: opts.proposalPath,
    before: sizeOf(before),
    after: sizeOf(next),
  };
}

/**
 * Close the audit for this session: stamp files whose facts are clean,
 * record proposals, land them when autoApply is on, update the registry,
 * and report what really happened. Safe to call more than once — the second
 * call returns the stored result flagged `repeat`.
 */
export function finalizeGuidelineAudit(opts: {
  sessionId: string;
  workspace: string;
  /** The user's own last prompt. An advisory turn does not stamp. */
  lastUserMessage?: string;
  /** Land doctrine proposals directly (journaled). */
  autoApply?: boolean;
  /** Current turn for the mutation journal. */
  turn?: number;
}): GuidelineFinalizeResult {
  const nothing = (): GuidelineFinalizeResult => ({
    stamped: [],
    revised: [],
    ignored: [],
    unresolved: [],
    proposals: [],
    applied: [],
    skipped: true,
  });
  const st = sessions.get(opts.sessionId);
  if (!st) return nothing();
  if (st.result) {
    st.reported = true;
    return { ...st.result, repeat: true };
  }
  if (st.phase !== "briefed") return nothing();
  // Advisory turns do not stamp: nothing was asked to be read, so there is
  // nothing to attest, and the stamp is a real write into a tracked file.
  if (opts.lastUserMessage && looksLikeAdvisoryUserMessage(opts.lastUserMessage)) {
    return nothing();
  }
  const reg = loadGuidelineRegistry(st.root);
  const stamped: string[] = [];
  const revised: GuidelineRevisedFile[] = [];
  const ignored: string[] = [];
  const unresolved: GuidelineUnresolvedFile[] = [];
  const proposals: GuidelineProposal[] = [];
  const applied: GuidelineProposal[] = [];
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
    if (!cur || cur.auditOnly) continue;
    const changed = !prev || prev.hash !== cur.hash;
    const proposalPath = guidelineProposalPath(st.root, rel);
    let proposalOnDisk = false;
    try {
      proposalOnDisk = fs.existsSync(proposalPath) && fs.statSync(proposalPath).size > 0;
    } catch {
      /* */
    }
    const proposedNow = st.proposed.has(rel) || (proposalOnDisk && !prev?.proposalPath);
    const looked = st.looked.has(rel) || st.edited.has(rel) || changed || proposedNow;
    if (changed) {
      revised.push({
        rel,
        before: prev ? { bytes: prev.bytes, lines: prev.lines } : { bytes: 0, lines: 0 },
        after: { bytes: cur.bytes, lines: cur.lines },
        created: !prev,
      });
    }
    const wanted = prev ? prev.needsAudit : true;
    if (!looked) {
      if (wanted && cur.freshness !== "import") ignored.push(rel);
      continue;
    }
    // A proposal written this session.
    if (proposedNow && proposalOnDisk) {
      let proposedText = "";
      try {
        proposedText = fs.readFileSync(proposalPath, "utf8");
      } catch {
        /* */
      }
      const trackedText = (() => {
        try {
          return fs.readFileSync(cur.abs, "utf8");
        } catch {
          return "";
        }
      })();
      if (proposedText.trim() && hashGuidelineBody(proposedText) !== hashGuidelineBody(trackedText)) {
        if (opts.autoApply) {
          const landed = landProposal({
            root: st.root,
            rel,
            abs: cur.abs,
            proposalPath,
            sessionId: opts.sessionId,
            turn: opts.turn,
            reg,
            at: stampAt,
          });
          if (landed) {
            applied.push(landed);
            stamped.push(rel);
            continue;
          }
        } else {
          proposals.push({ rel, path: proposalPath, before: sizeOf(trackedText), after: sizeOf(proposedText) });
          reg.files[rel] = {
            ...(reg.files[rel] || { hash: cur.hash }),
            hash: cur.hash,
            auditedAt: stampAt,
            proposal: { path: proposalPath, hash: hashGuidelineBody(proposedText), at: stampAt, bySession: opts.sessionId },
          };
        }
      } else {
        // Identical to the tracked file — nothing proposed. Drop it.
        try {
          fs.unlinkSync(proposalPath);
        } catch {
          /* */
        }
      }
    }
    if (cur.freshness === "import") {
      reg.files[rel] = { ...(reg.files[rel] || { hash: cur.hash }), hash: cur.hash, auditedAt: stampAt };
      continue;
    }
    const facts = cur.issues.filter((i) => i.class === "fact");
    if (facts.length) {
      // Looked at, and a fact defect the brief named is still there. A stamp
      // means "no fact defects at this hash", so it is withheld — and only
      // for facts: doctrine never withholds it.
      unresolved.push({ rel, issues: facts.map((i) => i.detail) });
      reg.files[rel] = {
        ...(reg.files[rel] || { hash: cur.hash }),
        hash: cur.hash,
        auditedAt: stampAt,
        bytes: cur.bytes,
        lines: cur.lines,
        ...(changed ? { revisedAt: stampAt, revisedBySession: opts.sessionId } : {}),
      };
      continue;
    }
    try {
      const text = fs.readFileSync(cur.abs, "utf8");
      const next = applyGuidelineStamp(text, stampAt);
      if (next !== text) fs.writeFileSync(cur.abs, next, "utf8");
      stamped.push(rel);
      const keep = reg.files[rel];
      reg.files[rel] = {
        ...(keep || { hash: cur.hash }),
        hash: hashGuidelineBody(next),
        stampedAt: stampAt,
        auditedAt: stampAt,
        bytes: Buffer.byteLength(next, "utf8"),
        lines: next.split(/\r?\n/).length,
        ...(changed
          ? { revisedAt: stampAt, revisedBySession: opts.sessionId }
          : keep?.revisedAt
            ? { revisedAt: keep.revisedAt, revisedBySession: keep.revisedBySession }
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
  st.result = { stamped, revised, ignored, unresolved, proposals, applied, skipped: false };
  return st.result;
}

/**
 * User-facing lines after finalize (empty when nothing to say). One line per
 * file, and the line says what actually happened to that file.
 */
export function formatGuidelineAuditNotice(r: GuidelineFinalizeResult): string[] {
  if (r.skipped) return [];
  const out: string[] = [];
  const unresolvedBy = new Map(r.unresolved.map((u) => [u.rel, u]));
  const size = (f: { before: { bytes: number; lines: number }; after: { bytes: number; lines: number }; created?: boolean }): string =>
    f.created
      ? `${f.after.lines} lines, ${fmtK(f.after.bytes)} chars`
      : `${f.before.lines} → ${f.after.lines} lines, ${fmtK(f.before.bytes)} → ${fmtK(f.after.bytes)} chars`;
  const appliedRels = new Set(r.applied.map((a) => a.rel));
  for (const f of r.revised) {
    if (appliedRels.has(f.rel)) continue; // said below
    const verb = f.created ? "written" : "revised";
    const open = unresolvedBy.get(f.rel);
    out.push(
      open
        ? `Agent guidelines: ${f.rel} ${verb} by the agent (${size(f)}) but not stamped — ${open.issues.join("; ")}. Re-briefs next prompt`
        : `Agent guidelines: ${f.rel} ${verb} by the agent (${size(f)}) — proofread stamp ${f.created ? "added" : "updated"}`,
    );
  }
  for (const a of r.applied) {
    out.push(
      `Agent guidelines: ${a.rel} doctrine proposal applied (guidelineAutoApply; ${size(a)}) — stamped; /undo reverts`,
    );
  }
  for (const p of r.proposals) {
    out.push(
      `Agent guidelines: ${p.rel} doctrine proposal written (${size(p)}) — /guidelines diff to review · /guidelines apply to accept · /guidelines discard`,
    );
  }
  const onlyStamped = r.stamped.filter(
    (s) => !r.revised.some((v) => v.rel === s) && !appliedRels.has(s),
  );
  if (onlyStamped.length) {
    out.push(`Agent guidelines: ${onlyStamped.join(", ")} checked, no defects — stamp updated`);
  }
  for (const u of r.unresolved) {
    if (r.revised.some((v) => v.rel === u.rel)) continue;
    out.push(
      `Agent guidelines: ${u.rel} checked but not stamped — ${u.issues.join("; ")}. Re-briefs next prompt (/guidelines stamp to acknowledge)`,
    );
  }
  if (r.ignored.length) {
    out.push(
      `Agent guidelines: ${r.ignored.join(", ")} not checked this session (brief ignored) — re-briefs next prompt`,
    );
  }
  return out;
}

/**
 * Report section body (run report / addendum / `/status`). Falls back to the
 * plain survey line once the run that produced the result has been reported.
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
    return lines.length ? lines : ["checked, no defects"];
  }
  try {
    const s = surveyGuidelines(opts.workspace);
    if (s.notAProject) return [];
    return [formatGuidelineStatusLine(s)];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// /guidelines
// ---------------------------------------------------------------------------

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
    lines.push("  · AGENTS.md — missing (the agent writes a short one on the next work prompt)");
    if (s.globalFallback) {
      lines.push(
        `    ${globalFallbackLabel(s.globalFallback)} steers meanwhile — the user's own map, not audited or stamped here`,
      );
    }
  }
  for (const f of s.files) {
    lines.push(`  ${f.needsAudit ? "·" : "✓"} ${describeGuidelineFile(f)}`);
  }
  const pending = s.files.filter((f) => f.proposalPath);
  for (const f of pending) {
    lines.push(`  proposal: ${f.rel} → ${f.proposalPath}  · /guidelines diff · /guidelines apply · /guidelines discard`);
  }
  const st = opts.sessionId ? sessions.get(opts.sessionId) : undefined;
  if (st) {
    lines.push(
      `  this session: ${st.phase}${st.looked.size ? ` · looked ${[...st.looked].join(", ")}` : ""}${st.edited.size ? ` · edited ${[...st.edited].join(", ")}` : ""}${st.proposed.size ? ` · proposed ${[...st.proposed].join(", ")}` : ""}`,
    );
    if (st.result) for (const l of formatGuidelineAuditNotice(st.result)) lines.push(`  ${l}`);
  }
  lines.push(
    `  registry: ${guidelineRegistryPath(s.root)}`,
    `  /guidelines audit re-briefs on the next prompt · /guidelines stamp acknowledges the current issues · FORGE_GUIDELINE_AUDIT=0 off · guideline_auto_apply lands proposals directly`,
  );
  return lines.join("\n");
}

/** `/guidelines audit`: forget this session's state so the next prompt briefs again. */
export function requestGuidelineAudit(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * `/guidelines stamp`: the user has read the files and they are fine as they
 * are. Stamps every non-import, non-sibling file **and acknowledges its
 * current issues at this hash**, so the same issues stay quiet until the
 * body changes. Without the acknowledgement a stamp on a file with an open
 * fact defect was re-briefed next session — the override did not override.
 */
export function stampGuidelinesNow(workspace: string): string[] {
  const s = surveyGuidelines(workspace);
  const reg = loadGuidelineRegistry(s.root);
  const at = nowIso();
  const out: string[] = [];
  for (const f of s.files) {
    if (f.freshness === "import" || f.auditOnly) continue;
    try {
      const text = fs.readFileSync(f.abs, "utf8");
      const next = applyGuidelineStamp(text, at);
      if (next !== text) fs.writeFileSync(f.abs, next, "utf8");
      const hash = hashGuidelineBody(next);
      const prevAck = reg.files[f.rel]?.hash === hash ? reg.files[f.rel]?.acknowledged ?? [] : [];
      reg.files[f.rel] = {
        ...(reg.files[f.rel] || {}),
        hash,
        stampedAt: at,
        auditedAt: at,
        bytes: Buffer.byteLength(next, "utf8"),
        lines: next.split(/\r?\n/).length,
        acknowledged: [...new Set([...prevAck, ...f.issues.map(issueKey)])],
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

/** Pending proposals for this repo (registry-recorded and on disk). */
export function listGuidelineProposals(workspace: string): Array<{ rel: string; abs: string; proposalPath: string }> {
  const s = surveyGuidelines(workspace);
  return s.files
    .filter((f) => f.proposalPath)
    .map((f) => ({ rel: f.rel, abs: f.abs, proposalPath: f.proposalPath! }));
}

/** `/guidelines diff`: tracked vs proposal, via `git diff --no-index`. */
export function formatGuidelineProposalDiff(workspace: string, rel?: string): string {
  const pending = listGuidelineProposals(workspace).filter((p) => !rel || p.rel === rel);
  if (!pending.length) return "No guideline proposal is pending.";
  const out: string[] = [];
  for (const p of pending) {
    out.push(`--- ${p.rel}  (tracked → proposal)`);
    let diff: string | null = null;
    try {
      diff = execFileSync(
        "git",
        ["diff", "--no-index", "--no-color", "--stat", "--", p.abs, p.proposalPath],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, env: createChildEnv() },
      );
    } catch (e) {
      // git diff exits 1 when files differ; stdout still carries the diff
      const err = e as { stdout?: string };
      diff = typeof err?.stdout === "string" ? err.stdout : null;
    }
    let body: string | null = null;
    try {
      body = execFileSync(
        "git",
        ["diff", "--no-index", "--no-color", "--", p.abs, p.proposalPath],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, env: createChildEnv() },
      );
    } catch (e) {
      const err = e as { stdout?: string };
      body = typeof err?.stdout === "string" ? err.stdout : null;
    }
    if (body && body.trim()) {
      const lines = body.split("\n");
      out.push(...(lines.length > 400 ? [...lines.slice(0, 400), `… (${lines.length - 400} more lines)`] : lines));
    } else {
      const a = sizeOf(fs.existsSync(p.abs) ? fs.readFileSync(p.abs, "utf8") : "");
      const b = sizeOf(fs.readFileSync(p.proposalPath, "utf8"));
      out.push(`${a.lines} → ${b.lines} lines, ${fmtK(a.bytes)} → ${fmtK(b.bytes)} chars${diff ? `\n${diff}` : ""}`);
    }
  }
  return out.join("\n");
}

/** `/guidelines apply`: land pending proposals (journaled for /undo), stamp. */
export function applyGuidelineProposals(opts: {
  workspace: string;
  sessionId?: string;
  turn?: number;
  rel?: string;
}): GuidelineProposal[] {
  const pending = listGuidelineProposals(opts.workspace).filter((p) => !opts.rel || p.rel === opts.rel);
  if (!pending.length) return [];
  const root = resolveGuidelineRoot(opts.workspace);
  const reg = loadGuidelineRegistry(root);
  const at = nowIso();
  const out: GuidelineProposal[] = [];
  for (const p of pending) {
    const landed = landProposal({
      root,
      rel: p.rel,
      abs: p.abs,
      proposalPath: p.proposalPath,
      sessionId: opts.sessionId,
      turn: opts.turn,
      reg,
      at,
    });
    if (landed) out.push(landed);
  }
  try {
    saveGuidelineRegistry(reg);
  } catch {
    /* */
  }
  return out;
}

/** `/guidelines discard`: drop pending proposals. */
export function discardGuidelineProposals(workspace: string, rel?: string): string[] {
  const pending = listGuidelineProposals(workspace).filter((p) => !rel || p.rel === rel);
  if (!pending.length) return [];
  const root = resolveGuidelineRoot(workspace);
  const reg = loadGuidelineRegistry(root);
  const out: string[] = [];
  for (const p of pending) {
    try {
      fs.unlinkSync(p.proposalPath);
    } catch {
      /* */
    }
    if (reg.files[p.rel]) reg.files[p.rel] = { ...reg.files[p.rel], proposal: undefined };
    out.push(p.rel);
  }
  try {
    saveGuidelineRegistry(reg);
  } catch {
    /* */
  }
  return out;
}
