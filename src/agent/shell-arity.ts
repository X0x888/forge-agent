/**
 * Command-prefix arities for human-understandable "always allow" patterns.
 * Ported (trimmed) from OpenCode permission/arity.ts.
 *
 * `git checkout main` → always-pattern `git checkout *`
 * `npm run dev` → `npm run *` when arity says 3 for "npm run"
 */

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

export function alwaysPatternFromCommand(command: string): string {
  // import lazily-shaped to avoid circular deps — tokenize inline
  const toks = command
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !t.startsWith("-"));
  // Keep flags out of arity tokens for simple cases; retain structure for git/npm
  // Prefer full simple tokenize without dropping flags after first word for arity map
  const raw = command.trim().split(/\s+/).filter(Boolean);
  const cleaned: string[] = [];
  for (const t of raw) {
    if (t.startsWith("-") && cleaned.length > 0) continue;
    cleaned.push(t);
  }
  return alwaysPatternFromTokens(cleaned.length ? cleaned : toks);
}

/** Conservative read-only command prefixes (Warp-inspired). */
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
  "node --version",
  "npm --version",
  "python --version",
  "cargo --version",
  "tsc --version",
]);

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
  for (let len = Math.min(words.length, 3); len >= 1; len--) {
    const p = words.slice(0, len).join(" ");
    if (READ_ONLY_PREFIXES.has(p)) return true;
  }
  return false;
}
