/**
 * Command-prefix arities for human-understandable "always allow" patterns.
 * Ported (trimmed) from OpenCode permission/arity.ts.
 *
 * `git checkout main` → always-pattern `git checkout *`
 * `npm run dev` → `npm run *` when arity says 3 for "npm run"
 */
import {
  commandCheckTargets,
  normalizeSegment,
  tokenizeSimple,
} from "./shell-parse.js";

const ARITY: Record<string, number> = {
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  grep: 1,
  kill: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  tail: 1,
  touch: 1,
  which: 1,
  rg: 1,
  find: 1,
  head: 1,
  wc: 1,
  sort: 1,
  uniq: 1,
  aws: 3,
  brew: 2,
  bun: 2,
  "bun run": 3,
  "bun x": 3,
  cargo: 2,
  "cargo add": 3,
  "cargo run": 3,
  "cargo test": 3,
  docker: 2,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  gh: 3,
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  go: 2,
  kubectl: 2,
  make: 2,
  npm: 2,
  "npm exec": 3,
  "npm run": 3,
  "npm test": 2,
  "npm view": 3,
  pnpm: 2,
  "pnpm run": 3,
  "pnpm exec": 3,
  "pnpm dlx": 3,
  pip: 2,
  poetry: 2,
  python: 2,
  "python -m": 3,
  node: 1,
  npx: 2,
  yarn: 2,
  "yarn run": 3,
  terraform: 2,
  tsc: 1,
  vitest: 1,
  jest: 1,
  pytest: 1,
};

/** Longest matching prefix wins; returns token slice of length arity. */
export function commandPrefix(tokens: string[]): string[] {
  if (tokens.length === 0) return [];
  for (let len = tokens.length; len > 0; len--) {
    const prefix = tokens.slice(0, len).join(" ");
    const arity = ARITY[prefix];
    if (arity !== undefined) return tokens.slice(0, arity);
  }
  return tokens.slice(0, 1);
}

/** Pattern stored for "always allow this command family". */
export function alwaysPatternFromTokens(tokens: string[]): string {
  const pref = commandPrefix(tokens);
  if (pref.length === 0) return "*";
  return pref.join(" ") + " *";
}

/**
 * Always-pattern for a full command string — the single implementation wired
 * to the interactive permission prompt ([a]lways display + persisted rule).
 * Segment-aware: the grant covers the FIRST executable segment after wrapper/
 * env peeling (`FOO=1 npm test` → `npm test *`, `npm test && rm x` → `npm test *`),
 * quote-aware tokenization, flags after the first word dropped.
 */
export function alwaysPatternFromCommand(command: string): string {
  const segs = commandCheckTargets(command);
  const seg = segs[0] || command;
  const toks = tokenizeSimple(normalizeSegment(seg));
  const words: string[] = [];
  for (const t of toks) {
    if (t.startsWith("-") && words.length > 0) continue;
    words.push(t);
  }
  return alwaysPatternFromTokens(words.length ? words : toks);
}

/**
 * Conservative read-only command prefixes (Warp-inspired).
 * Prefix membership alone is not enough for find / git branch / git remote —
 * those need subcommand-aware checks in isReadOnlyCommand.
 *
 * Version probes (`node --version`) are handled separately: flag-stripping
 * would otherwise drop `--version` and never match a "bin --version" prefix.
 */
const READ_ONLY_PREFIXES = new Set([
  "ls",
  "pwd",
  "echo",
  "cat",
  "head",
  "tail",
  "wc",
  "which",
  "whoami",
  "uname",
  "date",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git remote",
  "rg",
  "grep",
  "find",
  "npm ls",
  "npm list",
  "npm view",
]);

/**
 * Bins whose `--version` / `-v` / `-V` alone is a safe read-only probe.
 * Do not include package managers' `version` subcommand (e.g. `npm version patch`).
 */
const VERSION_PROBE_BINS = new Set([
  "node",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "python",
  "python3",
  "cargo",
  "tsc",
  "go",
  "rustc",
  "git",
  "rg",
  "tsx",
]);

/** find action predicates that mutate or run arbitrary commands. */
const FIND_MUTATING = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fls",
  "-fprintf",
]);

/**
 * `node --version`, `npm -v`, `python -V`, `git --version`, …
 * Flag-stripping prefix match cannot see these (every token after the bin is a flag).
 */
function isVersionProbeCommand(rawTokens: string[]): boolean {
  const words = rawTokens.filter((t) => !t.startsWith("-"));
  if (words.length !== 1) return false;
  const bin = words[0]!;
  if (!VERSION_PROBE_BINS.has(bin)) return false;
  const flags = rawTokens.filter((t) => t.startsWith("-"));
  if (flags.length === 0) return false;
  return flags.every((f) => f === "--version" || f === "-v" || f === "-V");
}

/**
 * git branch mutations: delete/move/copy/set-upstream, or creating a branch
 * (`git branch name` / `git branch name start-point`). Listing forms stay RO.
 */
function isReadOnlyGitBranch(rawTokens: string[]): boolean {
  // rawTokens include flags; first word is "git", second non-flag is "branch"
  const after: string[] = [];
  let seenBranch = false;
  for (let i = 1; i < rawTokens.length; i++) {
    const t = rawTokens[i]!;
    if (!seenBranch) {
      if (t.startsWith("-")) continue; // git global opts rare here
      if (t === "branch") {
        seenBranch = true;
        continue;
      }
      return false;
    }
    after.push(t);
  }
  if (!seenBranch) return false;

  const flags = after.filter((t) => t.startsWith("-") && t !== "-");
  const positionals = after.filter((t) => !t.startsWith("-") || t === "-");

  for (const f of flags) {
    // Long forms
    if (
      f === "--delete" ||
      f === "--force" || // `git branch --force` / -f moves tip
      f === "--move" ||
      f === "--copy" ||
      f === "--set-upstream" ||
      f === "--set-upstream-to" ||
      f === "--unset-upstream" ||
      f.startsWith("--set-upstream-to=") ||
      f.startsWith("--edit-description")
    ) {
      return false;
    }
    // Short / clustered: -d -D -m -M -c -C -u -f (and combos like -D)
    if (f.startsWith("--")) continue;
    const body = f.replace(/^-+/, "");
    if (/[dDmMcCuf]/.test(body)) return false;
  }

  // Creating a branch: any positional name (not a pure listing flag combo)
  // `git branch`, `git branch -a`, `git branch -vv`, `git branch --list [pat]` OK
  const listingOnlyFlags = flags.every((f) => {
    if (f.startsWith("--")) {
      return (
        f === "--list" ||
        f === "--all" ||
        f === "--remotes" ||
        f === "--contains" ||
        f === "--no-contains" ||
        f === "--merged" ||
        f === "--no-merged" ||
        f === "--sort" ||
        f.startsWith("--sort=") ||
        f === "--format" ||
        f.startsWith("--format=") ||
        f === "--points-at" ||
        f.startsWith("--points-at=") ||
        f === "--verbose" ||
        f === "--color" ||
        f.startsWith("--color=") ||
        f === "--no-color" ||
        f === "--column" ||
        f.startsWith("--column=") ||
        f === "--no-column" ||
        f === "--ignore-case" ||
        f === "--abbrev" ||
        f.startsWith("--abbrev=") ||
        f === "--no-abbrev"
      );
    }
    const body = f.replace(/^-+/, "");
    // listing shorts: a r v l (list) i (ignore-case) — not d/D/m/M/c/C/u/f
    // allow clustered forms like -av, -vv, -vi
    return /^[arvli]+$/.test(body);
  });

  if (positionals.length === 0) return flags.length === 0 || listingOnlyFlags;
  // Listing forms that take a filter/commit positional:
  //   git branch --list 'feat*'
  //   git branch --contains <commit>
  //   git branch --merged [commit]
  const listingWithPositional = flags.some(
    (f) =>
      f === "--list" ||
      f === "-l" ||
      /^-[a-zA-Z]*l[a-zA-Z]*$/.test(f) ||
      f === "--contains" ||
      f === "--no-contains" ||
      f === "--merged" ||
      f === "--no-merged" ||
      f === "--points-at" ||
      f.startsWith("--points-at="),
  );
  if (listingWithPositional) return listingOnlyFlags;
  // positional without a listing flag is create/track → not read-only
  return false;
}

/** git remote: list/show/get-url only — not add/remove/rename/set-url/prune. */
function isReadOnlyGitRemote(rawTokens: string[]): boolean {
  const words: string[] = [];
  for (let i = 1; i < rawTokens.length; i++) {
    const t = rawTokens[i];
    if (t.startsWith("-") && words.length === 0) continue; // rare git globals
    if (t.startsWith("-") && words.length === 1 && words[0] === "remote") {
      // flags after `remote` before subcommand (e.g. -v)
      continue;
    }
    if (t.startsWith("-")) continue;
    words.push(t);
  }
  // words[0] should be remote
  if (words[0] !== "remote") return false;
  const sub = words[1];
  if (sub == null) return true; // `git remote` / `git remote -v`
  return sub === "show" || sub === "get-url";
}

/**
 * git porcelain that accepts `--output=<path>` writes a file even when the
 * subcommand is otherwise read-only (`git log --output=/tmp/x`).
 */
function hasGitOutputFlag(rawTokens: string[]): boolean {
  for (let i = 0; i < rawTokens.length; i++) {
    const t = rawTokens[i]!;
    if (t === "--output" || t.startsWith("--output=")) return true;
  }
  return false;
}

/**
 * True if every segment looks like a read-only command (no redirects/pipes assumed checked separately).
 */
export function isReadOnlyCommand(normalizedSegment: string): boolean {
  const toks = normalizedSegment.trim().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return false;
  // strip flags for prefix match
  const words: string[] = [];
  for (const t of toks) {
    if (t.startsWith("-")) continue;
    words.push(t);
  }
  if (words.length === 0) return false;

  // Version probes before prefix match (`node --version` → words=["node"])
  if (isVersionProbeCommand(toks)) return true;

  // find: prefix alone is not enough — action predicates mutate / exec
  if (words[0] === "find") {
    for (const t of toks) {
      if (FIND_MUTATING.has(t)) return false;
    }
    return true;
  }

  // git: --output writes a file even on otherwise RO porcelain (incl. branch)
  if (words[0] === "git" && hasGitOutputFlag(toks)) {
    return false;
  }

  // git branch / git remote need subcommand-aware checks (prefix alone is unsafe)
  if (words[0] === "git" && words[1] === "branch") {
    return isReadOnlyGitBranch(toks);
  }
  if (words[0] === "git" && words[1] === "remote") {
    return isReadOnlyGitRemote(toks);
  }

  for (let len = Math.min(words.length, 3); len >= 1; len--) {
    const p = words.slice(0, len).join(" ");
    if (READ_ONLY_PREFIXES.has(p)) return true;
  }
  return false;
}
