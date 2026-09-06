/**
 * Verification classification — what counts as a check that ran, passed,
 * and proved the project (full suite) rather than one file.
 *
 * One classification for every channel that observes a check run: a
 * foreground bash result, a background task the model joined with
 * get_task_output, or a background task that settled while the model kept
 * working. The *spawn* of a background task observes nothing.
 */
import { nowIso } from "../util/fs.js";
import { isTruthy } from "../util/bool.js";
import { VERIFICATION_CMD_RE, isVerificationCommand } from "./verify-command.js";

export { VERIFICATION_CMD_RE, isObserverOnlyCommand, isVerificationCommand } from "./verify-command.js";

/**
 * Names of the tests a check run reported as failing, for the runners the
 * stack table knows: node:test (`✖ name` / `not ok N - name`), jest / vitest
 * (`✕ name`, `× name`, `FAIL path`), pytest (`FAILED path::name`), cargo
 * (`test name ... FAILED`), go (`--- FAIL: Name`), mocha (`N) name`).
 * Durations are stripped so the same failure hashes the same across runs.
 * Empty when the runner is unknown — callers treat that as opaque red.
 */
export function extractFailingTests(output: string): string[] {
  const out = new Set<string>();
  const push = (raw: string) => {
    const t = raw
      .replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (t && !/^failing tests:?$/i.test(t)) out.add(t);
  };
  for (const line of String(output || "").split("\n")) {
    const l = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r$/, "");
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^\s*✖\s+(.+)$/))) push(m[1]);
    else if ((m = l.match(/^\s*not ok\s+\d+\s*-\s*(.+)$/))) push(m[1]);
    else if ((m = l.match(/^\s*[✕×]\s+(.+)$/))) push(m[1]);
    else if ((m = l.match(/^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b/))) push(m[1]);
    else if ((m = l.match(/^FAILED\s+(\S+::\S+)/))) push(m[1]);
    else if ((m = l.match(/^test\s+(\S+)\s+\.\.\.\s+FAILED\s*$/))) push(m[1]);
    else if ((m = l.match(/^\s*---\s+FAIL:\s+(\S+)/))) push(m[1]);
    else if ((m = l.match(/^\s+\d+\)\s+(.+)$/))) push(m[1]);
  }
  return [...out];
}

/** Evidence required on a cycle=0 attestation: checklist marks or command results. */
const ATTEST_EVIDENCE_RE =
  /✅|❌|✓|\b\d+\s+(?:tests?|specs?|checks?)\s+(?:pass(?:ed)?|ok|green)\b|\btests?\s+(?:pass(?:es|ed|ing)?|green)\b|\b(?:npm|pnpm|yarn|bun|pytest|jest|vitest|cargo|go test|tsc|typecheck|lint|build|make)\b[^\n]{0,60}?\b(?:pass(?:ed|ing)?|green|succeed(?:ed)?|ok|clean|exit\s*0)\b|\b(?:pass(?:ed|ing)?|green|ok|clean)\b[^\n]{0,40}?\b(?:tests?|specs?|typecheck|lint|build)\b|\bexit(?:\s*code)?\s*0\b/i;

/**
 * True when a bash tool call counts toward the structural verification
 * signals (verificationRan / verificationPassed / last-verify trail).
 * Excludes background starts: a fire-and-forget spawn observes no exit code,
 * so it must not satisfy wave proof, attestations, or the last✓ trail.
 * Background detection mirrors the bash tool exactly — both key spellings
 * (`background`, `run_in_background`) and all isTruthy variants (`true`, `1`,
 * `"true"`, `"1"`, `"yes"`) — or the alias becomes a gaming bypass. The model
 * can always run the check in the foreground for it to count.
 */
export function countsTowardVerification(
  args: {
    command?: unknown;
    background?: unknown;
    run_in_background?: unknown;
  },
  preferredCheckCommands?: string[],
): boolean {
  const cmd = typeof args.command === "string" ? args.command : "";
  if (!cmd.trim()) return false;
  if (isTruthy(args.background) || isTruthy(args.run_in_background)) {
    return false;
  }
  return isVerificationCommand(cmd, preferredCheckCommands);
}

/**
 * Session last-verify trail is success-only. Structural `verificationRan`
 * still counts failed check runs for the ULW cycle ledger (execution); proof-claim
 * uses successful runs only. The trail experts read on /status /share /export
 * must not look green after red.
 * Callers should also clear any prior trail when a verification command fails.
 */
export function shouldStampLastVerification(opts: {
  command: string;
  isError?: boolean;
  preferredCheckCommands?: string[];
}): boolean {
  if (opts.isError) return false;
  return isVerificationCommand(opts.command, opts.preferredCheckCommands);
}

/** True when a failed verification bash should wipe a prior green trail. */
export function shouldClearLastVerification(opts: {
  command: string;
  isError?: boolean;
  preferredCheckCommands?: string[];
}): boolean {
  if (!opts.isError) return false;
  return isVerificationCommand(opts.command, opts.preferredCheckCommands);
}

/** Stamp last-verify. Green sets ok; red keeps the command (do not pretend none ran). */
export function applyVerificationTrail(
  meta: {
    lastVerificationCommand?: string;
    lastVerificationAt?: string;
    lastVerificationOk?: boolean;
    lastVerificationExitCode?: number;
  },
  opts: {
    command: string;
    isError?: boolean;
    preferredCheckCommands?: string[];
  },
): void {
  const cmd = (opts.command || "").trim().slice(0, 240);
  if (!cmd) return;
  if (shouldStampLastVerification(opts)) {
    meta.lastVerificationCommand = cmd;
    meta.lastVerificationAt = nowIso();
    meta.lastVerificationOk = true;
    meta.lastVerificationExitCode = 0;
    return;
  }
  if (shouldClearLastVerification(opts)) {
    meta.lastVerificationCommand = cmd;
    meta.lastVerificationAt = nowIso();
    meta.lastVerificationOk = false;
    meta.lastVerificationExitCode = 1;
  }
}

/** `ℹ fail 64` / `# fail 64` from node:test (and grepped tails). */
export function parseTestFailCount(output: string): number | undefined {
  const tail = (output || "").length > 12_000 ? output.slice(-12_000) : output || "";
  const node = tail.match(/(?:^|\n)\s*(?:ℹ|#)\s*fail\s+(\d+)\b/m);
  if (node) {
    const n = Number(node[1]);
    return Number.isFinite(n) ? n : undefined;
  }
  const pytest =
    tail.match(/(?:^|\n)=+[^\n]*\b(\d+)\s+failed\b/im) ||
    tail.match(/\b(\d+)\s+failed(?:,|\s)/i);
  if (pytest) {
    const n = Number(pytest[1]);
    return Number.isFinite(n) ? n : undefined;
  }
  const failures = tail.match(/FAILED\s*\(\s*failures\s*=\s*(\d+)/i);
  const errors = tail.match(/FAILED\s*\([^)]*errors\s*=\s*(\d+)/i);
  const failN = failures ? Number(failures[1]) : 0;
  const errN = errors ? Number(errors[1]) : 0;
  if (failures || errors) {
    const n = (Number.isFinite(failN) ? failN : 0) + (Number.isFinite(errN) ? errN : 0);
    return n;
  }
  if (
    /\b(?:hung|timed out)\b/i.test(tail) &&
    !/\b(?:ok|passed|fail 0|Ran \d+|tests?\s+\d+)\b/i.test(tail)
  ) {
    return 1;
  }
  return undefined;
}

/** `npm test | grep` / `| tail` hides the child's exit code. */
export function isVerificationOutputPipe(command: string): boolean {
  const c = String(command || "");
  if (!VERIFICATION_CMD_RE.test(c)) return false;
  return /\|\s*(?:grep|rg|egrep|tail|head|awk|sed)\b/.test(c);
}

/**
 * Success-only proof. A piped suite that prints `ℹ fail 64` is red even
 * when grep exits 0. A pipe with no fail count is "ran", not passed.
 */
export function verificationPassedFromResult(opts: {
  command: string;
  isError?: boolean;
  output?: string;
}): boolean {
  if (opts.isError) return false;
  const fail = parseTestFailCount(opts.output || "");
  if (fail != null && fail > 0) return false;
  if (isVerificationOutputPipe(opts.command) && fail == null) return false;
  // Isolates may be green for /verify; they are not ULW proof=✓ (see isIsolateTestCommand).
  return true;
}

export interface VerificationRunClass {
  /** The command is a check (VERIFICATION_CMD_RE / preferred / declared). */
  ran: boolean;
  /** Exit 0 and no `fail N` in the output. */
  passed: boolean;
  /** Isolate file/method check or typecheck — proof=ran, not proof=✓. */
  isolate: boolean;
  /** Project full suite (and passed). */
  fullSuite: boolean;
}

/**
 * One classification for a check run, whichever channel observed it: a
 * foreground bash result, a background task the model joined with
 * get_task_output, or a background task that settled while the model kept
 * working. The *spawn* of a background task observes nothing (that is why
 * countsTowardVerification refuses it); the settle/join observes the exit
 * code and the output — the same evidence a foreground run gives. Dogfood
 * ran 20 of 28 checks in the background on a Swift app and 45 of 61 on a
 * Rust workspace; every one of them was proof=✗ before this.
 */
export function classifyVerificationRun(opts: {
  command: string;
  exitCode?: number | null;
  isError?: boolean;
  output?: string;
  preferredCheckCommands?: string[];
}): VerificationRunClass {
  const cmd = String(opts.command || "");
  const none: VerificationRunClass = {
    ran: false,
    passed: false,
    isolate: false,
    fullSuite: false,
  };
  if (!isVerificationCommand(cmd, opts.preferredCheckCommands)) return none;
  const exitFailed =
    typeof opts.exitCode === "number" && Number.isFinite(opts.exitCode)
      ? opts.exitCode !== 0
      : Boolean(opts.isError);
  const passed = verificationPassedFromResult({
    command: cmd,
    isError: exitFailed,
    output: opts.output || "",
  });
  const isolate = isIsolateTestCommand(cmd) || isTypecheckCommand(cmd);
  const fullSuite =
    passed && !isolate && isFullSuiteCommand(cmd, opts.preferredCheckCommands);
  return { ran: true, passed, isolate, fullSuite };
}

/** `npm test` / `npm run test|ci|check` / unittest discover / bare pytest. */
export function isFullSuiteCommand(
  command: string,
  preferredCheckCommands?: string[],
): boolean {
  const c = String(command || "").replace(/\s+/g, " ").trim();
  if (!c) return false;
  if (isIsolateTestCommand(c)) return false;
  if (/\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:ci|check)\b/.test(c)) return true;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(c)) {
    if (/tests\/[^\s"'\\]+\.test\./i.test(c)) return false;
    return true;
  }
  if (/\bpython(?:3)?\s+-m\s+unittest\b/.test(c)) {
    if (/\bdiscover\b/.test(c)) return true;
    const rest = c.replace(/^.*\bunittest\b/, "").trim();
    return !rest || /^-[a-zA-Z]+$/.test(rest);
  }
  if (/\b(?:python(?:3)?\s+-m\s+)?pytest\b/.test(c) || /\bpy\.test\b/.test(c)) {
    if (/::/.test(c) || /\.py\b/.test(c)) return false;
    return true;
  }
  // Whole-project suites in other stacks (isolate shapes returned false above).
  if (
    /\bcargo\s+(?:test|nextest\s+run)\b|\bswift\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b|\b(?:flutter|dart)\s+test\b|\bmix\s+test\b|\brspec\b|\bzig\s+build\s+test\b|\bmake\s+(?:test|check|ci|verify)\b|\b(?:just|task)\s+(?:test|check|ci|verify)\b|\bgradle(?:w)?\s+test\b|\bmvn\s+(?:test|verify)\b|\bcomposer\s+test\b|\bstack\s+test\b|\bcabal\s+test\b|\bsbt\s+test\b|\blein\s+test\b/.test(
      c,
    )
  ) {
    return true;
  }
  const preferred = preferredCheckCommands || [];
  for (const p of preferred) {
    const want = String(p || "").replace(/\s+/g, " ").trim();
    if (!want) continue;
    if (c === want || c.endsWith(` && ${want}`) || c.endsWith(`; ${want}`)) {
      return !isIsolateTestCommand(want);
    }
    // Declared check runs with extra segments (`./build.sh && app --self-test; echo`).
    if (
      /^(?:\.\/|scripts?\/|bin\/|tools?\/)[\w./-]+/.test(want) &&
      new RegExp(`(?:^|[;&|]\\s*)${escapeRegExpLocal(want)}(?:\\s|$)`).test(c)
    ) {
      return !isIsolateTestCommand(want);
    }
  }
  return false;
}

function escapeRegExpLocal(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Targeted file/method check — ran, not wave proof=✓.
 * python -m unittest …TestCase.test_* and node --test tests/foo.test.ts.
 */
export function isIsolateTestCommand(command: string): boolean {
  const c = String(command || "").replace(/\s+/g, " ").trim();
  if (!c) return false;
  // tsc / typecheck — ran, not wave proof=✓ (same class as file/method isolates).
  if (isTypecheckCommand(c)) return true;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(c)) return false;
  if (/\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:ci|check)\b/.test(c)) return false;
  if (/\bpython(?:3)?\s+-m\s+unittest\b/.test(c)) {
    if (/\bdiscover\b/.test(c)) return false;
    const rest = c.replace(/^.*\bunittest\b/, "").trim();
    if (!rest || /^-[a-zA-Z]+\s*$/.test(rest)) return false;
    return true;
  }
  if (/\b(?:python(?:3)?\s+-m\s+)?pytest\b/.test(c) || /\bpy\.test\b/.test(c)) {
    return /::/.test(c) || /\.py\b/.test(c);
  }
  // Targeted runs in other stacks — a package / filter / single file.
  if (/\bcargo\s+(?:test|nextest\s+run)\b/.test(c)) {
    return (
      /\s(?:-p|--package|--test|--lib|--bin|--doc|--example)\b/.test(c) ||
      /\bcargo\s+(?:test|nextest\s+run)\s+(?!-)[\w:]+/.test(c)
    );
  }
  if (/\bswift\s+test\b/.test(c)) return /--filter\b/.test(c);
  if (/\bgo\s+test\b/.test(c)) {
    return (
      /\s-run\b/.test(c) ||
      (/\bgo\s+test\b[^\n]*\s\.\/[\w/-]+/.test(c) && !/\.\/\.\.\./.test(c))
    );
  }
  if (/\bdotnet\s+test\b/.test(c)) return /--filter\b/.test(c);
  if (/\b(?:flutter|dart)\s+test\b/.test(c)) return /\btest\/\S+\.dart\b/.test(c);
  if (/\bmix\s+test\b/.test(c)) return /\.exs\b/.test(c);
  if (/\brspec\b/.test(c)) return /\bspec\/\S+/.test(c);
  if (/[*?]/.test(c)) return false;
  // vitest / jest / mocha / ava: a handful of named files or a name filter is
  // an isolate; the bare runner is the suite.
  if (/\b(?:vitest|jest|mocha|ava)\b/.test(c)) {
    if (/\s(?:-t|--testNamePattern|--grep|-g|--match)\b/.test(c)) return true;
    const named = [...c.matchAll(/[^\s"'\\]+\.(?:test|spec)\.[cm]?[jt]sx?/gi)];
    return named.length > 0 && named.length <= 8;
  }
  if (/node\s+--test\s+tests\/(?:\*\*|["']?\.\*|["']?$)/.test(c)) return false;
  const isNodeTest = /\bnode\b[^\n]*--test\b/.test(c) || /\btsx\s+--test\b/.test(c);
  if (!isNodeTest) return false;
  const files = [...c.matchAll(/[^\s"'\\]+\.(?:test|spec)\.[cm]?[jt]sx?/gi)].map(
    (m) => m[0],
  );
  if (files.length === 0) return /tests\/w\d+/i.test(c);
  return files.length <= 8;
}

/** @deprecated isolate checks — kept as the historical name. */
export function isHelperOnlyTestCommand(command: string): boolean {
  return isIsolateTestCommand(command);
}


/**
 * Detect verification evidence for a wave. `verificationRan` is the structural
 * signal (a bash command matching a check pattern executed during the wave);
 * the regex is the secondary signal (cited command + outcome in the message).
 */
/** Full-suite fail count cited in a closer (`5008 / 65 fail`, `131 fail`). */
export function parseCitedSuiteFailCount(text: string): number | undefined {
  const t = text || "";
  const labeled = t.match(
    /(?:\d{3,5}\s*(?:\/|pass)\D{0,12})(\d{1,3})\s*fail/i,
  );
  if (labeled) {
    const n = Number(labeled[1]);
    return Number.isFinite(n) ? n : undefined;
  }
  const bare = t.match(/\b(\d{2,3})\s*fail(?:s|ed|ing)?\b/i);
  if (bare) {
    const n = Number(bare[1]);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Closer only cites an isolate `22/22` / `43/43 stay green`. */
export function citesIsolateOnlyPass(text: string): boolean {
  const t = text || "";
  if (parseCitedSuiteFailCount(t) != null) return false;
  if (/\bnpm\s+(?:run\s+)?test\b/i.test(t)) return false;
  return (
    /\b\d{1,2}\s*\/\s*\d{1,2}\s*(?:pass|green|stay)/i.test(t) ||
    /\bstay green\s*\(\d{1,2}\/\d{1,2}\)/i.test(t)
  );
}

export function detectWaveProof(
  lastAssistantMessage: string,
  verificationRan?: boolean,
  opts?: { helperOnly?: boolean },
): boolean {
  const fail = parseCitedSuiteFailCount(lastAssistantMessage || "");
  if (fail != null && fail > 0) return false;
  if (opts?.helperOnly) return false;
  if (verificationRan) return true;
  if (citesIsolateOnlyPass(lastAssistantMessage || "")) return false;
  // Closer speech is not proof. Background isolates + "typecheck green"
  // used to mint proof=full while structural verify stayed 0.
  return false;
}

/** `npm run typecheck` / `tsc --noEmit` / `turbo run typecheck` — ran, not wave proof=✓. */
export function isTypecheckCommand(command: string): boolean {
  const c = String(command || "").replace(/\s+/g, " ").trim();
  if (!c) return false;
  // Compound commands that also run tests are a suite, not typecheck-only.
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:check|ci|test)\b/.test(c)) {
    return false;
  }
  if (/\b(?:pytest|vitest|jest|mocha|cargo\s+test|go\s+test)\b/.test(c)) {
    return false;
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:typecheck|type-check|tsc)\b/.test(c)) {
    return true;
  }
  if (/\b(?:npx|yarn dlx|bunx)\s+tsc\b/.test(c)) return true;
  if (/\btsc\b/.test(c) && /--noEmit/.test(c)) return true;
  if (/\b(?:turbo|nx|moon)\s+(?:run\s+)?(?:typecheck|type-check|tsc)\b/.test(c)) {
    return true;
  }
  // Compile / lint-class checks in other stacks: real verification, ran
  // not ✓ — the suite is the proof, the build is the smoke.
  if (
    /\b(?:cargo\s+(?:check|build|clippy)|swift\s+build|go\s+(?:build|vet)|dotnet\s+build|zig\s+build)\b/.test(
      c,
    ) &&
    !/\b(?:cargo\s+(?:test|nextest)|swift\s+test|go\s+test|dotnet\s+test|zig\s+build\s+test)\b/.test(
      c,
    )
  ) {
    return true;
  }
  return false;
}

/** Attestation carries machine-checkable evidence, not just a claim. */
export function hasAttestationEvidence(
  lastAssistantMessage: string,
  verificationRan?: boolean,
): boolean {
  if (verificationRan) return true;
  return ATTEST_EVIDENCE_RE.test(lastAssistantMessage || "");
}
