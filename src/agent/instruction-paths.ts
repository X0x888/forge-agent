/**
 * Where the project's instruction files live — one walk, two consumers.
 *
 * The system prompt's rules loader decides which `AGENTS.md`-class files
 * actually steer a session; the guideline audit decides which ones get
 * proofread and stamped. Those have to be the same set. They were not: the
 * loader walked workspace → git worktree root and let a nested `AGENTS.md`
 * shadow the monorepo root, while `surveyGuidelines` looked only at the git
 * root. Run forge in `repo/packages/api` with its own `AGENTS.md` saying
 * "never run tests" and the prompt loaded that file while the audit read
 * `repo/AGENTS.md` and reported it fine — the conflict rule never fired and
 * the stamp attested to a file nobody was steered by.
 *
 * Leaf module on purpose (fs + path + forgeHome): the harness imports it
 * without pulling the whole prompt builder in behind it.
 */
import fs from "node:fs";
import path from "node:path";
import { forgeHome } from "../util/fs.js";

/**
 * Per-file cap the rules loader clips at, so one huge AGENTS.md cannot
 * dominate the system prompt. It lives here because the guideline audit
 * reports "over the N-char cap **the prompt loads**" — a claim about this
 * number — and had its own copy of it to drift against.
 */
export const RULES_PER_FILE_CHARS = 12_000;

/** Total project-rules budget (OpenCode-style multi-source instructions). */
export const RULES_TOTAL_CHARS = 28_000;

/**
 * Per-file cap for `n` loaded rules files. A lone `AGENTS.md` gets the whole
 * total budget; two share it; from three up the classic per-file floor
 * applies. Nearer files are loaded first, so a nested map still wins room.
 *
 * The old fixed 12k per file left a lone 26.8k `AGENTS.md` two-thirds unseen
 * while 16k of the 28k total sat idle — the bug the guideline audit was
 * built around instead of fixing here. Lives in this leaf so the audit can
 * ask "would the prompt clip this file?" without importing the prompt.
 */
export function ruleFileBudget(fileCount: number): number {
  const n = Math.max(1, fileCount);
  return Math.max(RULES_PER_FILE_CHARS, Math.floor(RULES_TOTAL_CHARS / n));
}

/**
 * The rule files the system prompt actually steers a session by. Exported
 * so the guideline audit's `GUIDELINE_FILES` can be pinned against it by
 * test: the two sets are allowed to differ only by `AUDIT_ONLY_GUIDELINE_FILES`
 * and the `~/.forge/AGENTS.md` fallback, both documented in the audit's header.
 */
export const PROMPT_RULE_FILES = [
  "AGENTS.md",
  "FORGE.md",
  "CLAUDE.md",
  ".forge/rules.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
] as const;

/** Of those, the ones where the nearest copy shadows the monorepo root. */
export const PROMPT_SHADOW_BASENAMES = [
  "AGENTS.md",
  "FORGE.md",
  "CLAUDE.md",
  ".cursorrules",
] as const;

/**
 * The files the prompt loader would load from `workspace`, in load order.
 * The audit uses the count to compute the per-file budget a surveyed file
 * competes for, so "clipped" means the same thing on both sides.
 */
export function promptRuleFiles(workspace: string): InstructionFile[] {
  return collectInstructionFiles(workspace, {
    files: PROMPT_RULE_FILES,
    shadowBasenames: PROMPT_SHADOW_BASENAMES,
    cursorRules: true,
    globalAgentsFallback: true,
  });
}

/**
 * The user-level `AGENTS.md` the prompt loader falls back to when the walk
 * found no project one. Exported because the guideline audit deliberately
 * does not survey it (the user's file, not this project's map) and so has to
 * be able to *name* it: without this, a project with no `AGENTS.md` of its
 * own is reported as "AGENTS.md missing" while this file steers every turn.
 */
export function globalAgentsPath(): string {
  return path.join(forgeHome(), "AGENTS.md");
}

/** Nearest ancestor containing `.git` (dir or worktree file), or null. */
export function nearestGitRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 48; i++) {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
    } catch {
      /* */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface InstructionFile {
  /** Absolute, resolved path. */
  abs: string;
  /** The rule that matched: an entry of `files`, or `.cursor/rules/<entry>`. */
  name: string;
  /** Directory of the walk it was found in. */
  dir: string;
}

export interface InstructionWalkOptions {
  /** Relative names to look for in each directory, in priority order. */
  files: readonly string[];
  /** Of those, the names where the nearest copy shadows every one above it. */
  shadowBasenames?: readonly string[];
  /** Also take `<dir>/.cursor/rules/*.{md,mdc,markdown}` (sorted, capped at 12). */
  cursorRules?: boolean;
  /** When the walk found no `AGENTS.md`, fall back to `~/.forge/AGENTS.md`. */
  globalAgentsFallback?: boolean;
}

const CURSOR_RULES_LIMIT = 12;

/**
 * Walk workspace → parents collecting instruction files.
 * Stops at the git worktree root (OpenCode-style) so unrelated parent
 * `AGENTS.md` files never leak in. When not in a git repo, only the
 * workspace directory is scanned.
 * Nearer files come first; a later file whose name is in `shadowBasenames`
 * is skipped, so a nested `AGENTS.md` wins over the monorepo root.
 */
export function collectInstructionFiles(
  workspace: string,
  opts: InstructionWalkOptions,
): InstructionFile[] {
  const out: InstructionFile[] = [];
  const seenAbs = new Set<string>();
  const seenBase = new Set<string>();
  const shadow = new Set(opts.shadowBasenames ?? []);

  const pushFile = (abs: string, name: string, dir: string, baseKey?: string) => {
    const resolved = path.resolve(abs);
    if (seenAbs.has(resolved)) return;
    if (baseKey && seenBase.has(baseKey)) return;
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return;
    } catch {
      return;
    }
    seenAbs.add(resolved);
    if (baseKey) seenBase.add(baseKey);
    out.push({ abs: resolved, name, dir });
  };

  const start = path.resolve(workspace || process.cwd());
  const gitRoot = nearestGitRoot(start);
  // Only walk up when workspace is inside that git worktree (never leak
  // unrelated parent AGENTS.md if TMPDIR sits under another repo).
  const underGit =
    !!gitRoot &&
    (start === path.resolve(gitRoot) ||
      start.startsWith(path.resolve(gitRoot) + path.sep));
  // Without git: workspace only. With git: workspace → git root (inclusive).
  const ceiling = underGit && gitRoot ? path.resolve(gitRoot) : start;

  let dir = start;
  for (let depth = 0; depth < 48; depth++) {
    for (const name of opts.files) {
      // Basename key so a nested file shadows its parent; path-unique for the rest.
      const baseKey = shadow.has(name) ? name : `${dir}::${name}`;
      pushFile(path.join(dir, name), name, dir, baseKey);
    }
    // Cursor project rules (directory of .md / .mdc)
    if (opts.cursorRules) {
      const cursorRules = path.join(dir, ".cursor", "rules");
      try {
        if (fs.existsSync(cursorRules) && fs.statSync(cursorRules).isDirectory()) {
          const entries = fs
            .readdirSync(cursorRules)
            .filter((f) => /\.(md|mdc|markdown)$/i.test(f))
            .sort()
            .slice(0, CURSOR_RULES_LIMIT);
          for (const f of entries) {
            pushFile(
              path.join(cursorRules, f),
              path.join(".cursor", "rules", f),
              dir,
            );
          }
        }
      } catch {
        /* */
      }
    }
    if (path.resolve(dir) === path.resolve(ceiling)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Global user instructions (lowest priority — only when no project AGENTS.md)
  if (opts.globalAgentsFallback && !out.some((f) => f.name === "AGENTS.md")) {
    try {
      const global = globalAgentsPath();
      pushFile(global, "AGENTS.md", path.dirname(global), "AGENTS.md");
    } catch {
      /* */
    }
  }

  return out;
}
