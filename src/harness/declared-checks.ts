/**
 * Declared verify commands — the Reading's "command that proves it".
 *
 * Every ULW Wave-1 Reading (and every Bet:) is asked for the command that
 * can fail. Dogfood wrote them (`./build.sh && --self-test`, `cargo test
 * -p together-core`) and the harness threw them away: only project-intel's
 * stack table (npm/cargo/pytest/…) and VERIFICATION_CMD_RE decided what a
 * check was, so a Swift app with a build.sh earned proof=✗ on 248 of 256
 * waves while running its suite twenty times.
 *
 * Harvest is strict: a candidate must look like a shell command that runs
 * a check — an allow-listed head (`npm`, `cargo`, `swift`, `make`, `just`,
 * …) with a check keyword, or a script path shaped like a test/check
 * runner. Prose (`Verify: the login flow works`), observers (`echo`,
 * `pgrep`), and product commands (`forge export --csv`) are refused.
 */
import { isObserverOnlyCommand, isVerificationCommand } from "./verify-command.js";

export const MAX_DECLARED_CHECKS = 4;

const LABEL_RE =
  /\b(?:verify(?:\s+with|\s+command)?|verification|proof|prove[sd]?(?:\s+it)?|check(?:\s+command)?|proves it|the command that proves it|run)\s*[:=—–-]\s*([^\n]{2,220})/gi;
const INLINE_CODE_RE = /`([^`\n]{2,220})`/g;

/** Heads that run something — must still carry a check keyword. */
const CHECK_HEAD_RE =
  /^(?:npm|pnpm|yarn|bun|deno|node|tsx|npx|python3?|py\.test|pytest|cargo|go|mvn|gradlew?|\.\/gradlew|make|mix|composer|turbo|nx|tsc|eslint|dotnet|swift|xcodebuild|zig|flutter|dart|bundle|rake|just|task|stack|cabal|sbt|lein|ctest|cmake|forge|jest|vitest|mocha|ava|phpunit|rspec|mypy|pyright|ruff|biome|elm-test|bash|sh|zsh)$/i;
const CHECK_KEYWORD_RE =
  /\b(?:test|tests|spec|check|checks|verify|lint|typecheck|type-check|build|ci|smoke|self-?test|clippy|vet|unittest|nextest)\b|--self-?test\b|\.(?:test|spec)\.[cm]?[jt]sx?\b/i;
/** With an allow-listed runner head, a target that *contains* a check word (`make selfcheck`, `just verify-all`). */
const CHECK_KEYWORD_LOOSE_RE =
  /(?:test|spec|check|verif|lint|typecheck|build|smoke|clippy|unittest|nextest)|\b(?:ci|vet)\b/i;
/** Script runners: `./build.sh`, `scripts/test.sh`, `bash ci/check.sh`, `python tools/selftest.py`. */
const SCRIPT_PATH_RE =
  /(?:^|\s)(?:\.\/|(?:scripts?|bin|tools?|ci)\/)[\w./-]+(?:\s|$)/;

function stripQuotes(cmd: string): string {
  return cmd
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function headOf(cmd: string): string {
  const seg = stripQuotes(cmd).split(/&&|\|\||;|\|/)[0] || "";
  const head =
    seg
      .trim()
      .replace(/^(?:[A-Za-z_][\w]*=\S*\s+)+/, "")
      .replace(/^(?:env|time|nice)\s+(?:-\S+\s+)*/, "")
      .split(/\s+/)[0] || "";
  return head;
}

function cleanCandidate(raw: string): string {
  let c = raw.replace(/\s+/g, " ").trim();
  // Trailing prose: "npm test — 12 pass", "cargo test (workspace)".
  c = c.replace(/\s+(?:—|–|->|→|=>)\s+.*$/, "").trim();
  c = c.replace(/[.,;:!?)]+$/, "").trim();
  c = c.replace(/^[(`'"]+/, "").replace(/[`'"]+$/, "").trim();
  return c;
}

/** Shell-shaped and runs a check — not prose, not an observer, not a product verb. */
export function looksLikeCheckCommand(candidate: string): boolean {
  const c = cleanCandidate(candidate);
  if (c.length < 3 || c.length > 200) return false;
  if (/\s(?:and|or|that|which|the|so|then)\s/i.test(c) && !/&&|\|\||;/.test(c)) {
    // Sentence, not a command ("build the thing and run it").
    if (!isVerificationCommand(c)) return false;
  }
  if (isObserverOnlyCommand(c)) return false;
  if (isVerificationCommand(c)) return true;
  const head = headOf(c).replace(/^.*\//, "");
  if (!head) return false;
  const scriptShaped = SCRIPT_PATH_RE.test(` ${stripQuotes(c)} `);
  if (scriptShaped && CHECK_KEYWORD_RE.test(c)) return true;
  if (!CHECK_HEAD_RE.test(head)) return false;
  return CHECK_KEYWORD_RE.test(c) || CHECK_KEYWORD_LOOSE_RE.test(c);
}

/** Verify commands declared in a Reading / Bet / closer — newest first, deduped. */
export function extractDeclaredChecks(text: string): string[] {
  const t = String(text || "");
  if (!t.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const c = cleanCandidate(raw);
    if (!c || !looksLikeCheckCommand(c)) return;
    const k = c.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  // Labeled first — `Verify: …` / `proof: …` is the strongest signal.
  const label = new RegExp(LABEL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = label.exec(t)) !== null) {
    const body = m[1] || "";
    // Body may hold the command in backticks; prefer that span.
    const code = body.match(/`([^`]{2,220})`/);
    push(code?.[1] || body);
  }
  const inline = new RegExp(INLINE_CODE_RE.source, "g");
  while ((m = inline.exec(t)) !== null) push(m[1] || "");
  return out.slice(0, MAX_DECLARED_CHECKS);
}

/** Declared checks first (project-specific), then the stack table; deduped. */
export function mergePreferredChecks(
  base: string[] | undefined,
  declared: string[] | undefined,
): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of [...(declared || []), ...(base || [])]) {
    const t = String(c || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.length ? out : base;
}
