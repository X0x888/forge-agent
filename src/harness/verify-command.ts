/**
 * Verification command recognition — a leaf module so the ULW driver, the
 * loop, /verify, and the declared-check harvester can all agree on what
 * "ran a check" means without importing each other.
 *
 * Execution, not prose: the agent loop matches executed bash (foreground
 * results and settled background tasks) against these shapes to produce
 * the structural `verificationRan` / `verificationPassed` signals.
 */
/**
 * Bash command shape that counts as running verification. The agent loop
 * matches executed commands against this to produce the structural
 * `verificationRan` signal — execution, not prose.
 */
export const VERIFICATION_CMD_RE =
  /\b(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|tests|spec|typecheck|type-check|lint|check|build|ci|verify|smoke|tsc|format-check|fmt-check)\b|\b(?:pytest|py\.test|jest|vitest|mocha|ava|phpunit|rspec|ctest|mypy|pyright|ruff|golangci-lint|staticcheck|biome)\b|\bpython(?:3)?\s+-m\s+unittest\b|\bcargo\s+(?:test|check|build|clippy|nextest)\b|\bgo\s+(?:test|vet|build)\b|\bmvn\s+(?:test|verify|package|compile)\b|\bgradle(?:w)?\s+(?:test|check|build)\b|\bmake\s+(?:test|check|build|all|ci|verify)\b|\bmix\s+test\b|\bcomposer\s+test\b|\bturbo\s+run\s+(?:test|tests|typecheck|type-check|lint|check|build|ci|verify|smoke)\b|\bnx\s+(?:run-many|run)\b|\btsc\b|\beslint\b|\bdotnet\s+(?:test|build)\b|\bnpx\s+(?:tsc|eslint|vitest|jest|prettier|biome)\b|\b(?:yarn\s+dlx|bunx)\s+(?:tsc|eslint|vitest|jest)\b|\bforge\s+(?:test|check|typecheck|ci|smoke)\b|\b(?:node|tsx)\b[^\n]{0,120}--test\b|\bswift\s+(?:test|build)\b|\bxcodebuild\b[^\n]{0,120}\b(?:test|build)\b|\bzig\s+(?:build\s+)?test\b|\bzig\s+build\b|\b(?:flutter|dart)\s+test\b|\bbundle\s+exec\s+(?:rspec|rake\s+test)\b|\brake\s+(?:test|spec)\b|\b(?:just|task)\s+(?:test|check|verify|ci|build|lint)\b|\bstack\s+test\b|\bcabal\s+test\b|\bsbt\s+test\b|\blein\s+test\b|--self-?test\b|(?:^|[\s;&|(])(?:\.\/|(?:scripts?|bin|tools?|ci)\/)(?:[\w./-]*(?:test|check|verify|build|ci|smoke|lint|self-?test)[\w.-]*\.(?:sh|bash|zsh|py|mjs|cjs|js|ts)|[\w./-]*(?:test|check|verify|smoke|lint|self-?test)[\w.-]*)(?=\s|$|[;&|)])/i;

/**
 * Heads that only *observe* or *arrange* (`pgrep -lf 'cargo test'`, `echo
 * "npm test"`, `rm -rf ./test`, `git diff`) — never verification themselves.
 * The dogfood trail stamped `pgrep -lf 'cargo test --workspace'` as the last
 * check because the regex matched inside the quoted pattern.
 */
const OBSERVER_HEAD_RE =
  /^(?:pgrep|pkill|ps|grep|rg|egrep|fgrep|ag|echo|printf|cat|less|more|head|tail|ls|which|type|man|find|stat|wc|awk|sed|sleep|true|false|:|rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|cd|export|source|git|open|code|curl|wget|kill|killall)$/i;

function stripShellQuotes(cmd: string): string {
  return cmd
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function shellSegmentHeads(cmd: string): string[] {
  return stripShellQuotes(cmd)
    .split(/&&|\|\||;|\|/)
    .map((seg) =>
      seg
        .trim()
        .replace(/^(?:[A-Za-z_][\w]*=\S*\s+)+/, "")
        .replace(/^(?:env|time|nice|sudo|command|exec|nohup)\s+(?:-\S+\s+)*/, "")
        .split(/\s+/)[0] || "",
    )
    .map((h) => h.replace(/^.*\//, ""))
    .filter(Boolean);
}

/** Every segment is an observer (`pgrep`, `echo`, `grep`) — nothing ran a check. */
export function isObserverOnlyCommand(command: string): boolean {
  const heads = shellSegmentHeads(String(command || ""));
  if (!heads.length) return false;
  return heads.every((h) => OBSERVER_HEAD_RE.test(h));
}

/**
 * True when a bash command counts as structural verification.
 * Matches VERIFICATION_CMD_RE, or an exact preferred project check command
 * (from project-intel or a Reading's declared verify command) so custom
 * scripts like `npm run unit` / `./build.sh --self-test` still count.
 * Quoted spans are ignored — `pgrep -lf 'cargo test'` observes, it does not run.
 */
export function isVerificationCommand(
  command: string,
  preferredCheckCommands?: string[],
): boolean {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  if (isObserverOnlyCommand(cmd)) return false;
  if (VERIFICATION_CMD_RE.test(stripShellQuotes(cmd))) return true;
  const preferred = preferredCheckCommands || [];
  if (!preferred.length) return false;
  // Normalize whitespace; allow preferred as a full command or a trailing segment
  // after cd/&& (common agent pattern: `cd pkg && npm test`).
  const compact = stripShellQuotes(cmd).replace(/\s+/g, " ").trim();
  for (const p of preferred) {
    const want = String(p || "").replace(/\s+/g, " ").trim();
    if (!want) continue;
    if (compact === want) return true;
    if (
      compact.endsWith(` && ${want}`) ||
      compact.endsWith(`; ${want}`) ||
      compact.endsWith(` | ${want}`) ||
      compact.endsWith(` || ${want}`)
    ) {
      return true;
    }
    // Leading env assignments / prior segments: `FOO=1 npm test`, `cd x && npm test`
    if (new RegExp(`(?:^|[;&|]\\s*)${escapeRegExp(want)}(?:\\s|$)`).test(compact)) {
      return true;
    }
    // Preferred is a package script name ("unit") and cmd is `npm run unit` etc.
    if (/^[a-zA-Z0-9:_-]+$/.test(want)) {
      if (
        new RegExp(
          `\\b(?:npm|pnpm|yarn|bun|deno)\\s+run\\s+${escapeRegExp(want)}\\b`,
        ).test(compact)
      ) {
        return true;
      }
    }
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
