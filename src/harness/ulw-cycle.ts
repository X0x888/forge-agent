/**
 * Ultrawork relentless cycle driver.
 *
 * User-facing control:
 *   cycle = 1  → keep looping research → waves → serendipity → review → repeat
 *   /cycle 0   → finish the open wave, ship one more, then LAST at wave N+1
 *                (sets maxWaves; stays CONTINUE until that cap). Not an abort.
 *   cycle = 0  → LAST wrap, then attest Cycle complete
 *                budget LAST (cap / polish / safety valve / /done) wraps this wave only
 *   /ulw-off   → disarm immediately (no wrap)
 *   maxWaves   → optional cap; when the wave counter hits the cap, auto LAST
 *                (default null = unlimited)
 *
 * Armed by /ulw (and forge --ulw). Soft prompts ("improve the code") are
 * expanded into a god-scope mandate so the harness still drives correctly.
 */
import path from "node:path";
import { forgeHome, readJsonFile, writeJsonFile, nowIso, nowEpoch } from "../util/fs.js";
import { isTruthy } from "../util/bool.js";
import { clearSoftTodoGateOnWindDown } from "./todo-gate.js";
import { maybeDesktopNotify } from "../util/attention.js";
import {
  formatMemoryForPrompt,
  isBroadMandate,
  isEvaluateClassMandate,
  hasMandateJudgment,
  recordWaveObservation,
  seedMemoryFromMandate,
  activeMemoryRecords,
} from "./decision-memory.js";
import { createSafetyCheckpoint } from "../util/git-checkpoint.js";
import { gitDiffFingerprint, isCleanTreeDiffFp } from "../util/git-context.js";
import { looksLikeAdvisoryUserMessage } from "../util/advisory-intent.js";
import {
  extractShipSummary,
  isDeclaredWaveClose,
  isShipCloseText,
} from "./ship-close.js";
import {
  isUserFacingProductWork,
  harvestProductQualityNotes,
  harvestStoredProductQuality,
  evaluateProductQuality,
  formatProductQualityReanchor,
  hasStoredJobInsight,
  hasStoredProductEdge,
  type ProductQualityResult,
} from "./product-quality.js";
import {
  SAME_SURFACE_ADVISORY,
  SAME_SURFACE_HOLD,
  isLeftoverSiblingShip,
  matchesRecentSurface,
  nextSameSurfaceStreak,
  surfaceKey,
} from "./same-surface.js";
import {
  factoryClassHolding,
  isChangelogOnlySummary,
  isFactoryFingerprint,
  isMillClassShip,
  isSameClassReading,
} from "./work-class.js";
import {
  OFF_CONTRACT_HOLD,
  formatHoldContextAppendix,
  isOnExploreContract,
  loadExploreMapPicks,
} from "./explore-contract.js";

export {
  extractShipSummary,
  isDeclaredWaveClose,
  isShipCloseText,
  pickShipHint,
} from "./ship-close.js";

export type CycleFlag = 0 | 1;

export interface NamedShipItem {
  text: string;
  status: "open" | "done";
  doneAt?: string;
}

export type UlwWrapSource = "named" | "todo" | "open_wave";
/** Who flipped LAST: `/done` can be user wrap; budget LAST wraps the wave. */
export type UlwLastReason = "user" | "budget";

export interface UlwWrapItem {
  text: string;
  source: UlwWrapSource;
  status: "open" | "done" | "cancelled";
  doneAt?: string;
}

/**
 * Factual record of one completed wave. Facts only — no invented quality
 * scores: edit delta + whether verification actually ran + a clipped summary.
 * The "quality bar" is anchored to the best factual wave, not a metric.
 */
export interface UlwWaveRecord {
  wave: number;
  /** File edits made during this wave (editCount delta across the Stop boundary) */
  editDelta: number;
  /**
   * Working-tree diff movement at the wave boundary (git fingerprint):
   * "new" = unseen diff state (real progress), "revisit" = a previously seen
   * state (edit→revert churn), "none" = diff unchanged. Undefined when the
   * workspace is not a git repo or the wave predates fingerprinting.
   */
  netDiff?: "new" | "revisit" | "none";
  /** True when verification evidence was detected (test/typecheck/lint/build run or cited) */
  proof: boolean;
  /** One-line clip of the wave's closing assistant message */
  summary: string;
  /** Significant tokens from the summary (same-surface classifier). */
  surfaceKey?: string;
  /**
   * Full closer clip used for mill/schema (not the commit subject).
   * `summary` is the Shipped: line; mill phrases live here.
   */
  classText?: string;
  /** Full closer was adjacent-share / factory and not an explore-map pick. */
  millClass?: boolean;
  ts: string;
  /**
   * Todos closed (completed|cancelled) during this wave — structural intent
   * signal for thin-wave detection (Phase 5). Optional for back-compat.
   */
  todoProgress?: number;
}

export interface UlwCycleState {
  /** Ultrawork cycle driver armed */
  enabled: boolean;
  /**
   * 1 = continue relentless cycles
   * 0 = LAST wrap, then allow stop after attestation
   */
  cycle: CycleFlag;
  /** Wave counter (increments each Stop re-anchor while cycle=1 / max-waves LAST) */
  wave: number;
  /**
   * Optional max wave number. When the counter reaches this value on Stop,
   * the driver auto-flips to LAST (finish + attest). `null` = unlimited (default).
   */
  maxWaves: number | null;
  /** Total Stop blocks by this driver */
  blocks: number;
  /** Consecutive no-progress blocks */
  stuckBlocks: number;
  lastBlockEditCount: number;
  /**
   * Working-tree diff fingerprint at the previous Stop evaluation
   * (gitDiffFingerprint; undefined until the first git-backed evaluation).
   * Progress = editCount delta OR a changed fingerprint, so work done via
   * bash (heredocs/sed) still counts and churn does not fake it forever.
   */
  lastDiffFp?: string;
  /** Recent fingerprints (capped) — a wave closing on a seen fp is churn. */
  seenDiffFps?: string[];
  /** Original user mandate (possibly soft) */
  mandate: string;
  /** Expanded operational mandate shown to the model */
  expandedMandate: string;
  softPrompt: boolean;
  /**
   * Wave ledger (newest last, capped). Facts per wave for the quality bar,
   * thin-wave detection, and /cycle status transparency. Optional for
   * back-compat with older sidecars.
   */
  waves?: UlwWaveRecord[];
  /**
   * Consecutive same-surface ships (openings siblings, leftover rest card).
   * Unlimited ULW holds at SAME_SURFACE_HOLD until a different-surface
   * reading or /cycle 0. Not a quality score.
   */
  sameSurfaceStreak?: number;
  /** Unlimited hold is armed — Stop stays blocked. */
  sameSurfaceHold?: boolean;
  /** Hold admits this run (stronger copy after the first). */
  sameSurfaceAdmitCount?: number;
  /**
   * Consecutive themed ships that did not touch an explore-map pick.
   * Unlimited evaluate-class holds at OFF_CONTRACT_HOLD.
   */
  offContractStreak?: number;
  contractHold?: boolean;
  /**
   * Unlimited hold requires one mid-run explore before the next ship.
   * Wave-1 maps go stale; reprinting them is not a new reading.
   */
  exploreRequired?: boolean;
  exploreRequiredAt?: string;
  /** Playwright / play-loop ran this open wave — different class. */
  playLoopPending?: boolean;
  /** New raw readFileSync test this wave — consume at next stamp. */
  rawPinProofTaint?: boolean;
  /** Loop should merge recent mill tool ids into sticky omit. */
  millHoldPrunePending?: boolean;
  /** Consecutive waves with negligible edits AND no verification */
  thinStreak?: number;
  /**
   * Consecutive declared ships that are the same polish class (clip / one-line
   * chrome / leftover dump). High edit counts still look "thick" to thinStreak
   * — this catches leftover-chrome grinding.
   */
  polishStreak?: number;
  /** Proof demands already issued for the current proof-less streak (capped) */
  proofDemands?: number;
  /** Evidence demands issued against weak cycle=0 attestations (capped at 1) */
  evidenceNudges?: number;
  /**
   * Broad checklist mandate: wave 1 must seed a todo backlog before inventing
   * free-form scope (Phase 2 contract). Cleared once backlog is present.
   */
  backlogRequired?: boolean;
  /**
   * Evaluate-class mandate: wave 0 cannot close until a written reading
   * exists (memory_write or "Reading:" in the assistant message). Capped.
   */
  judgmentRequired?: boolean;
  /** Times we bounced Stop for a missing reading (capped, never a trap). */
  judgmentDemands?: number;
  /**
   * Named ships parsed from the Wave-1 reading. Unlimited evaluate-class
   * asks for a new reading when every item is done (once). Ignored when
   * maxWaves is set — remaining budget is still spent.
   */
  namedShips?: NamedShipItem[];
  /** True after the empty-backlog Stop admit for the *current* named list. */
  namedShipAdmitDone?: boolean;
  /** Empty-list admits this run (unlimited). Stronger copy after 3. */
  namedShipAdmitCount?: number;
  /**
   * Frozen LAST wrap list. Immediate LAST (`/done`, cap, safety valve)
   * snapshots this. User `/cycle 0` schedules maxWaves=N+1 instead.
   */
  wrapItems?: UlwWrapItem[];
  wrapKind?: UlwLastReason;
  wrapFrozenAt?: string;
  /**
   * User `/cycle 0` stop wave (maxWaves was set to this). HUD/admits can
   * say "stop at wave N+1" instead of a regular budget.
   */
  cycleZeroStopAt?: number;
  /** One Cycle-complete bounce while named wrap items are still open. */
  wrapNudgeDone?: boolean;
  /** One product-quality bounce (user-facing ships). Never a trap. */
  soulNudgeDone?: boolean;
  /**
   * evaluate-class Wave 1: `orient` hides spawn/edits until a reading exists.
   * Absent on old sidecars — infer from judgmentRequired.
   */
  phase?: "orient" | "ship";
  /** Open todo count snapshot at previous wave boundary (for todoProgress). */
  lastOpenTodoCount?: number;
  /**
   * Signature of the last stamped wave (`editCount:diffFp`). Stop will not
   * double-increment if mid-loop already recorded this progress.
   */
  lastWaveSig?: string;
  /** editCount at the last mid-loop or Stop wave stamp. */
  lastProgressEditCount?: number;
  startedAt: string;
  updatedAt: string;
  sessionId: string;
  /** Auto safety checkpoint sha taken at arm (git stash create). */
  checkpointSha?: string;
  checkpointAt?: string;

}

export interface UlwStopDecision {
  block: boolean;
  reason?: string;
  reanchor?: string;
  stuckReleased?: boolean;
  lastCycleReleased?: boolean;
  /** True when LAST mode was forced because maxWaves was reached */
  maxWavesHit?: boolean;
  /** True when the re-anchor demands missing verification evidence */
  proofDemanded?: boolean;
  /** True when waves are thinning — surface a diminishing-returns advisory */
  thinStreakAdvisory?: boolean;
  /** True when a weak attestation was bounced for missing evidence */
  evidenceDemanded?: boolean;
  /** True when Cycle complete was bounced because named wrap items are still open. */
  wrapDemanded?: boolean;
  /** True when a user-facing ship was bounced for product-quality (edges/job). */
  soulDemanded?: boolean;
  /** True when Stop is holding for a different-surface reading. */
  sameSurfaceDemanded?: boolean;
  /** True when this Stop actually closed a wave (not a gate / already-stamped). */
  waveClosed?: boolean;
}

const LAST_CYCLE_ATTEST_RE =
  /\*\*Cycle complete\.\*\*|\*\*Wave complete\.\*\*|\*\*Last cycle complete\.\*\*|CYCLE COMPLETE|LAST CYCLE COMPLETE/i;

/**
 * Evidence that a verification command ran or its result is cited.
 * Gate = execution, not judgment: a wave "proved" only when a check actually
 * ran (loop passes verificationRan) or the message cites command + outcome.
 */
const WAVE_PROOF_RE =
  /\b(?:npm|pnpm|yarn|bun|deno|pytest|jest|vitest|mocha|ava|cargo|go|mvn|gradle|make|tsc|mypy|pyright|ruff|eslint|golangci|ctest|phpunit|rspec|dotnet)\b[^\n]{0,60}?\b(?:test|tests|spec|check|typecheck|type-check|lint|clippy|vet|build|compile|ci|verify)\b|\b(?:tsc|mypy|pyright|ruff|eslint|golangci(?:-lint)?|clippy)\b[^\n]{0,40}?\b(?:pass(?:ed|ing)?|clean|ok|no errors?|✓|✅)\b|\b(?:test|tests|spec|typecheck|lint|build)\b[^\n]{0,60}?\b(?:pass(?:ed|ing)?|green|succeed(?:ed)?|ok|clean|✓|✅)\b|\b\d+\s+(?:tests?|specs?|checks?)\s+(?:pass(?:ed)?|ok|green)\b|\bpass(?:ed|ing)?\b[^\n]{0,40}?\b(?:tests?|specs?|typecheck|lint|build)\b|✅|✓\s*(?:tests?|checks?|build)/i;

/** Evidence required on a cycle=0 attestation: checklist marks or command results. */
const ATTEST_EVIDENCE_RE =
  /✅|❌|✓|\b\d+\s+(?:tests?|specs?|checks?)\s+(?:pass(?:ed)?|ok|green)\b|\btests?\s+(?:pass(?:es|ed|ing)?|green)\b|\b(?:npm|pnpm|yarn|bun|pytest|jest|vitest|cargo|go test|tsc|typecheck|lint|build|make)\b[^\n]{0,60}?\b(?:pass(?:ed|ing)?|green|succeed(?:ed)?|ok|clean|exit\s*0)\b|\b(?:pass(?:ed|ing)?|green|ok|clean)\b[^\n]{0,40}?\b(?:tests?|specs?|typecheck|lint|build)\b|\bexit(?:\s*code)?\s*0\b/i;

/** Wave ledger cap — enough for an 8-hour unlimited run + status. */
const WAVE_LEDGER_KEEP = 256;
/** Recent diff fingerprints kept for churn (revisit) detection. */
const DIFF_FP_KEEP = 12;
/** Proof demands per proof-less streak before accepting a stated rationale. */
const MAX_PROOF_DEMANDS = 2;
const MAX_JUDGMENT_DEMANDS = 2;
/** Evidence bounces allowed on cycle=0 attestation before releasing anyway. */
const MAX_EVIDENCE_NUDGES = 1;
/** Thin waves in a row before surfacing a diminishing-returns advisory. */
const THIN_ADVISORY_STREAK = 3;

/**
 * Bash command shape that counts as running verification. The agent loop
 * matches executed commands against this to produce the structural
 * `verificationRan` signal — execution, not prose.
 */
export const VERIFICATION_CMD_RE =
  /\b(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|tests|spec|typecheck|type-check|lint|check|build|ci|verify|smoke|tsc|format-check|fmt-check)\b|\b(?:pytest|py\.test|jest|vitest|mocha|ava|phpunit|rspec|ctest|mypy|pyright|ruff|golangci-lint|staticcheck|biome)\b|\bcargo\s+(?:test|check|build|clippy)\b|\bgo\s+(?:test|vet|build)\b|\bmvn\s+(?:test|verify|package|compile)\b|\bgradle(?:w)?\s+(?:test|check|build)\b|\bmake\s+(?:test|check|build|all|ci)\b|\bmix\s+test\b|\bcomposer\s+test\b|\bturbo\s+run\s+(?:test|tests|typecheck|type-check|lint|check|build|ci|verify|smoke)\b|\bnx\s+(?:run-many|run)\b|\btsc\b|\beslint\b|\bdotnet\s+(?:test|build)\b|\bnpx\s+(?:tsc|eslint|vitest|jest|prettier|biome)\b|\b(?:yarn\s+dlx|bunx)\s+(?:tsc|eslint|vitest|jest)\b|\bforge\s+(?:test|check|typecheck|ci|smoke)\b|\b(?:node|tsx)\b[^\n]{0,120}--test\b/i;

/**
 * True when a bash command counts as structural verification.
 * Matches VERIFICATION_CMD_RE, or an exact preferred project check command
 * (from project-intel) so custom scripts like `npm run unit` still count.
 */
export function isVerificationCommand(
  command: string,
  preferredCheckCommands?: string[],
): boolean {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  if (VERIFICATION_CMD_RE.test(cmd)) return true;
  const preferred = preferredCheckCommands || [];
  if (!preferred.length) return false;
  // Normalize whitespace; allow preferred as a full command or a trailing segment
  // after cd/&& (common agent pattern: `cd pkg && npm test`).
  const compact = cmd.replace(/\s+/g, " ").trim();
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
 * still counts failed check runs for the ULW wave ledger (execution); proof-claim
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
  const m = tail.match(/(?:^|\n)\s*(?:ℹ|#)\s*fail\s+(\d+)\b/m);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
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
  if (isHelperOnlyTestCommand(opts.command)) return false;
  return true;
}

/**
 * Isolated `node --test tests/w161-foo.test.mjs` (and small wN families)
 * ran, but they are not wave proof — the mill's 5/5 helper file.
 */
/** `npm test` / `npm run test` with no single-file path — the mill's 15s red suite. */
export function isFullSuiteCommand(command: string): boolean {
  const c = String(command || "").replace(/\s+/g, " ").trim();
  if (!c) return false;
  if (!/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(c)) return false;
  if (/tests\/[^\s"'\\]+\.test\./i.test(c)) return false;
  return true;
}

export function isHelperOnlyTestCommand(command: string): boolean {
  const c = String(command || "").replace(/\s+/g, " ").trim();
  if (!c) return false;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(c)) return false;
  if (/node\s+--test\s+tests\/(?:\*\*|["']?\.\*|["']?$)/.test(c)) return false;
  const isNodeTest = /\bnode\b[^\n]*--test\b/.test(c) || /\btsx\s+--test\b/.test(c);
  if (!isNodeTest) return false;
  const files = [...c.matchAll(/tests\/[^\s"'\\]+\.test\.(?:mjs|js|cjs|ts)/gi)].map(
    (m) => m[0],
  );
  if (files.length === 0) return /tests\/w\d+/i.test(c);
  return files.length <= 6 && files.every((f) => /\/w\d+/i.test(f));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect verification evidence for a wave. `verificationRan` is the structural
 * signal (a bash command matching a check pattern executed during the wave);
 * the regex is the secondary signal (cited command + outcome in the message).
 */
export function detectWaveProof(
  lastAssistantMessage: string,
  verificationRan?: boolean,
): boolean {
  if (verificationRan) return true;
  return WAVE_PROOF_RE.test(lastAssistantMessage || "");
}

/** Attestation carries machine-checkable evidence, not just a claim. */
export function hasAttestationEvidence(
  lastAssistantMessage: string,
  verificationRan?: boolean,
): boolean {
  if (verificationRan) return true;
  return ATTEST_EVIDENCE_RE.test(lastAssistantMessage || "");
}

function clipWaveSummary(t: string): string {
  const s = t.replace(/\s+/g, " ").trim();
  if (!s) return "(no closing summary)";
  return s.length <= 140 ? s : `${s.slice(0, 139)}…`;
}

function looksLikeMidThought(t: string): boolean {
  return (
    t.length < 280 &&
    /verifying|confirming|checking the|closing wave|close Wave|I'?ll re-run|Wave \d+ starts|looks pre-existing|proof is green|lsp still/i.test(
      t,
    )
  );
}

function isReadingReprintOf(
  s: UlwCycleState,
  incoming: string,
  current: string,
): boolean {
  if (!incoming || !current || incoming === current) return false;
  if (extractShipSummary(incoming) || /\bCycle complete\b/i.test(incoming)) {
    return false;
  }
  try {
    const reading = readingFromMemory(s.sessionId);
    if (!reading) return false;
    const clip = clipWaveSummary(reading);
    if (!clip || clip.startsWith("(")) return false;
    const head = clip.slice(0, 40);
    return incoming === clip || (head.length >= 20 && incoming.startsWith(head));
  } catch {
    return false;
  }
}

function readingFromMemory(sessionId: string): string | undefined {
  try {
    const recs = activeMemoryRecords(sessionId);
    for (let i = recs.length - 1; i >= 0; i--) {
      const text = recs[i]?.text || "";
      const m = text.match(/\*{0,2}Reading:\*{0,2}\s+(.{20,240})/i);
      if (m?.[1]) return m[1];
    }
  } catch {
    /* memory is best-effort */
  }
  return undefined;
}



function shipFromMemory(sessionId: string): string | undefined {
  try {
    const recs = activeMemoryRecords(sessionId);
    const s = loadUlwCycle(sessionId);
    const since = s?.waves?.length ? s.waves[s.waves.length - 1]!.ts : "";
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i]!;
      if (r.source !== "agent") continue;
      if (since && r.at <= since) break;
      const ship = extractShipSummary(r.text);
      if (ship) return ship;
    }
  } catch {
    /* memory is best-effort */
  }
  return undefined;
}

/**
 * Clip a wave-boundary closer. Prefer a declared ship over **Reading:**
 * so the ledger is not the same paragraph four times. Mid-thought
 * fallbacks still use a durable reading when there is no newer ship.
 */
export function summarizeWave(message: string, sessionId?: string): string {
  const t = (message || "").replace(/\s+/g, " ").trim();
  const ship = extractShipSummary(t);
  if (ship) return clipWaveSummary(ship);
  if (sessionId) {
    const memShip = shipFromMemory(sessionId);
    if (memShip) return clipWaveSummary(memShip);
  }
  if (!t) {
    if (sessionId) {
      const fromMem = readingFromMemory(sessionId);
      if (fromMem) return clipWaveSummary(fromMem);
    }
    return "(no closing summary)";
  }
  const reading = t.match(/\*{0,2}Reading:\*{0,2}\s+(.{20,240})/i);
  if (reading?.[1]) return clipWaveSummary(reading[1]);
  if (/\bCycle complete\b/i.test(t)) {
    const after = t.replace(/^[\s\S]*?Cycle complete\.\s*/i, "").trim();
    if (after.length >= 20) return clipWaveSummary(`Cycle complete. ${after}`);
    return "Cycle complete.";
  }
  if (sessionId && looksLikeMidThought(t)) {
    const fromMem = readingFromMemory(sessionId);
    if (fromMem) return clipWaveSummary(fromMem);
  }
  return clipWaveSummary(t);
}

export const MID_WAVE_STAMP_STEPS = 20;

export function waveProgressSig(
  editCount: number,
  fp?: string | null,
): string {
  return `${Math.max(0, editCount)}:${fp || ""}`;
}

/** Update lastDiffFp / seenDiffFps. First observation is a baseline, not progress. */
export function applyDiffFingerprint(
  s: UlwCycleState,
  fp: string | null,
): { diffChanged: boolean; diffRevisit: boolean; firstObservation: boolean } {
  let diffChanged = false;
  let diffRevisit = false;
  let firstObservation = false;
  if (fp) {
    if (s.lastDiffFp === undefined) {
      s.lastDiffFp = fp;
      s.seenDiffFps = [...(s.seenDiffFps ?? []), fp].slice(-DIFF_FP_KEEP);
      firstObservation = true;
    } else if (fp !== s.lastDiffFp) {
      diffChanged = true;
      diffRevisit = (s.seenDiffFps ?? []).includes(fp);
      s.seenDiffFps = [...(s.seenDiffFps ?? []), fp].slice(-DIFF_FP_KEEP);
      s.lastDiffFp = fp;
    }
  }
  return { diffChanged, diffRevisit, firstObservation };
}

function classifyNetDiff(
  fp: string | null,
  diffChanged: boolean,
  diffRevisit: boolean,
  firstObservation: boolean,
  editDelta: number,
): UlwWaveRecord["netDiff"] {
  if (!fp) return undefined;
  if (diffChanged) {
    // Clean tree after a landed ship is the new baseline, not edit→revert.
    if (diffRevisit && isCleanTreeDiffFp(fp) && editDelta >= 1) return "none";
    return diffRevisit ? "revisit" : "new";
  }
  // First fingerprint after edits already landed: the tree moved from
  // the arm-time (or empty) state even though this call is the baseline.
  if (firstObservation && editDelta > 0) return "new";
  return "none";
}

function flipUlwToLast(
  s: UlwCycleState,
  sessionId: string,
  kind: UlwLastReason = "budget",
): void {
  if (s.cycle !== 1) return;
  s.cycle = 0;
  snapshotUlwWrap(s, kind);
  try {
    clearSoftTodoGateOnWindDown(sessionId);
  } catch {
    /* */
  }
}

function lastWaveAdmit(cap: number, wave: number, fromCycleZero?: boolean): string {
  return [
    "[Forge harness — mid-conversation update]",
    fromCycleZero
      ? `ULW /cycle 0 stop wave=${wave} reached — auto LAST.`
      : `ULW max_waves=${cap} reached at wave=${wave} — auto LAST.`,
    "Budget LAST — wrap this wave (prove + review), attest **Cycle complete.** Do not start a new ambitious wave.",
  ].join("\n");
}

function updateOpenWaveRecord(
  s: UlwCycleState,
  opts: {
    editDelta: number;
    proof: boolean;
    todoProgress: number;
    netDiff?: UlwWaveRecord["netDiff"];
    summary: string;
  },
): boolean {
  const last = s.waves?.length ? s.waves[s.waves.length - 1] : undefined;
  if (!last) return false;
  last.editDelta += opts.editDelta;
  if (opts.proof) last.proof = true;
  last.todoProgress = (last.todoProgress ?? 0) + opts.todoProgress;
  if (opts.netDiff === "new") last.netDiff = "new";
  else if (opts.netDiff === "revisit" && last.netDiff !== "new") {
    last.netDiff = "revisit";
  }
  if (
    opts.summary &&
    !opts.summary.startsWith("(") &&
    !isReadingReprintOf(s, opts.summary, last.summary)
  ) {
    last.summary = opts.summary;
  }
  last.ts = nowIso();
  return true;
}

function appendWaveRecord(
  s: UlwCycleState,
  opts: {
    sessionId: string;
    editDelta: number;
    netDiff?: UlwWaveRecord["netDiff"];
    proof: boolean;
    todoProgress: number;
    summary: string;
    /** Full closer — mill/schema classify this, not the Shipped: clip. */
    classText?: string;
    /** Declared / leftover-sibling ship — counts toward same-surface streak. */
    themed?: boolean;
  },
): UlwWaveRecord {
  s.wave += 1;
  // A stamped wave means the scout (if any) already named the next ships.
  s.phase = "ship";
  s.judgmentRequired = false;
  const classText = clipClassText(opts.classText || opts.summary);
  applySameSurfaceNote(s, classText, opts.themed === true, opts.sessionId);
  applyContractNote(s, classText, opts.themed === true, opts.sessionId);
  const proof = consumeProofTaint(s) ? false : opts.proof;
  const onContract = closerOnContract(opts.sessionId, classText);
  if (s.playLoopPending) s.playLoopPending = false;
  const rec: UlwWaveRecord = {
    wave: s.wave,
    editDelta: opts.editDelta,
    netDiff: opts.netDiff,
    proof,
    todoProgress: opts.todoProgress,
    summary: opts.summary,
    classText: classText || undefined,
    millClass: !onContract && isMillClassShip(classText) ? true : undefined,
    surfaceKey: surfaceKey(opts.summary) || undefined,
    ts: nowIso(),
  };
  s.waves = [...(s.waves ?? []), rec].slice(-WAVE_LEDGER_KEEP);
  try {
    recordWaveObservation(
      opts.sessionId,
      s.wave,
      `+${opts.editDelta}e proof=${proof ? "✓" : "✗"} todosΔ=${opts.todoProgress} net=${opts.netDiff ?? "n/a"} — ${opts.summary}`,
    );
  } catch {
    /* */
  }
  const thin =
    (opts.editDelta <= 1 && opts.netDiff !== "new" && !proof) ||
    opts.netDiff === "revisit" ||
    (opts.todoProgress === 0 &&
      !proof &&
      opts.editDelta <= 2 &&
      opts.netDiff !== "new");
  s.thinStreak = thin ? (s.thinStreak ?? 0) + 1 : 0;
  if (proof) s.proofDemands = 0;
  return rec;
}

export interface MidWaveStampResult {
  stamped: boolean;
  thin?: boolean;
  wave?: number;
  admit?: string;
  /** max_waves just flipped cycle to LAST */
  flippedToLast?: boolean;
  /** Open wave ledger updated in place (no new wave number) */
  updated?: boolean;
}

/** Clip / one-line / leftover-dump ships — a class that never ends if we "finish siblings". */
export function isPolishClassShip(text: string): boolean {
  return /one TTY row|one-line|one line chrome|blank-line|sandwich|leftover dump|leftover chrome|leftover (?:first-thing|after-turn|human-facing)|clip(?:ped|ping)? (?:to |the |banner|Δ|picker|row)|hard-clip|drop the extra|scannable line|last-verify dump|implementation-note|quieter (?:copy|chip|label|title|dump)|lowercase (?:label|title|chip|copy)|dock owns identity|banner slim|docked (?:forge|prompt) flags|dock overflow|drop provider\/model|identity strip/i.test(
    text || "",
  );
}

/**
 * Glanceable ✓ / last-N-lines preview siblings. Dogfood `693c5fb1` shipped
 * 16 of these after the reading's list was done; polish-class missed them.
 */
export function isGlanceableClassShip(text: string): boolean {
  return /glanceable|same glanceable-work|under the [✓✔] row|extraDefaultPreview|✓\s*preview|first \d+\s+(?:lines?|hits?|names?|result lines|prose lines)|last \d+\s+(?:log )?lines(?:\s+under)?|(?:web_search|web_fetch|call_mcp|search_mcp|get_task_output|lsp)\s+(?:diagnostics )?preview|lists (?:up to )?\d+ hit titles|child'?s report now prints|spawn_subagent.{0,60}first \d+ lines|live ›[^\n]{0,80}last[^\n]{0,40}line|bang-shell|!(?:cmd|npm)\b[^\n]{0,80}last[- ]line|last[- ]line[^\n]{0,48}live ›|(?:idle|bg-completion|background-task)[^\n]{0,80}last (?:log )?line|lsp diagnostics/i.test(
    text || "",
  );
}

/** Polish clip-class ∪ glanceable ✓-class — one leftover-chrome family. */
export function isLeftoverChromeShip(text: string): boolean {
  return isPolishClassShip(text) || isGlanceableClassShip(text);
}

/** Consolidation closers must not reset the leftover-chrome streak. */
export function isConsolidationCloser(text: string): boolean {
  const t = text || "";
  return (
    /\bconsolidat/i.test(t) &&
    /\b(?:no new scope|full (?:check )?suite|tests pass|\d+\s+tests)\b/i.test(t)
  );
}

export type UlwPhase = "orient" | "ship";

export function resolveUlwPhase(s: UlwCycleState | null | undefined): UlwPhase {
  if (!s?.enabled) return "ship";
  // Later waves never re-scout — the reading already named the next ships.
  if ((s.wave ?? 0) >= 1) return "ship";
  if (s.phase === "orient" || s.phase === "ship") return s.phase;
  return s.judgmentRequired ? "orient" : "ship";
}

/** True when evaluate-class should skip the scout (reading exists or a wave already stamped). */
export function shouldSkipOrient(
  s: UlwCycleState | null | undefined,
  sessionId?: string,
): boolean {
  if (!s?.enabled) return false;
  // A stamped wave already named the next ships — do not re-scout.
  if ((s.wave ?? 0) >= 1) return true;
  if (sessionId) {
    try {
      if (hasMandateJudgment(sessionId)) return true;
    } catch {
      /* */
    }
  }
  return false;
}

/** Flip orient → ship once a written reading exists. */
export function advanceUlwPhaseOnReading(
  sessionId: string,
  closer?: string,
): boolean {
  const s = loadUlwCycle(sessionId);
  if (!s?.enabled) return false;
  if (resolveUlwPhase(s) !== "orient") return false;
  if (!hasMandateJudgment(sessionId, closer)) return false;
  s.phase = "ship";
  s.judgmentRequired = false;
  maybeAdoptNamedShips(s, closer);
  saveUlwCycle(s);
  return true;
}

const POLISH_ADVISORY_STREAK = 3;
const POLISH_LAST_STREAK = 4;

function notePolishShip(s: UlwCycleState, message: string): number {
  // Every 4th wave is consolidation — that closer is not chrome, but it
  // must not wipe a 3-ship glanceable streak (693c5fb1 never reached 4).
  if (isConsolidationCloser(message)) return s.polishStreak ?? 0;
  if (isLeftoverChromeShip(message)) {
    s.polishStreak = (s.polishStreak ?? 0) + 1;
  } else {
    s.polishStreak = 0;
  }
  return s.polishStreak ?? 0;
}

/**
 * The model usually closes a unit in memory_write, not assistant prose.
 * Only count records newer than the last stamped wave so an old
 * "Wave 1 shipped" cannot re-trigger every edit burst.
 */
function closerText(sessionId: string, lastAssistant: string): string {
  let mem = "";
  try {
    const s = loadUlwCycle(sessionId);
    const since = s?.waves?.length ? s.waves[s.waves.length - 1]!.ts : "";
    const recs = activeMemoryRecords(sessionId);
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i]!;
      if (r.source !== "agent") continue;
      if (since && r.at <= since) break;
      if (
        isDeclaredWaveClose(r.text) ||
        isLeftoverChromeShip(r.text)
      ) {
        mem = r.text;
        break;
      }
    }
  } catch {
    /* memory is best-effort */
  }
  return [lastAssistant, mem].filter((t) => t && t.trim()).join("\n");
}

function polishAdmit(streak: number): string {
  return [
    `Last ${streak} ships are the same leftover-chrome class (clip / one-line / glanceable ✓ preview).`,
    "Next unit must be a different surface (trust, correctness, workflow) — or /cycle 0, then **Cycle complete.**",
    "Do not hunt leftover dumps. \"Finish the class\" means defect/call-site siblings, not chrome leftovers.",
  ].join(" ");
}

function canArmSameSurfaceHold(
  s: Pick<UlwCycleState, "cycle" | "wrapKind" | "maxWaves" | "cycleZeroStopAt">,
): boolean {
  return (
    s.cycle === 1 &&
    !s.wrapKind &&
    normalizeMaxWaves(s.maxWaves) == null &&
    s.cycleZeroStopAt == null
  );
}

export function sameSurfaceHolding(s: UlwCycleState): boolean {
  if (!s.enabled || !canArmSameSurfaceHold(s)) return false;
  return Boolean(
    s.sameSurfaceHold || (s.sameSurfaceStreak ?? 0) >= SAME_SURFACE_HOLD,
  );
}

function clearSameSurfaceHold(s: UlwCycleState): void {
  s.sameSurfaceHold = false;
  s.sameSurfaceAdmitCount = 0;
  s.contractHold = false;
  s.offContractStreak = 0;
  s.exploreRequired = false;
  s.exploreRequiredAt = undefined;
}

export function contractHolding(s: UlwCycleState): boolean {
  if (!s.enabled || !canArmSameSurfaceHold(s)) return false;
  return Boolean(
    s.contractHold || (s.offContractStreak ?? 0) >= OFF_CONTRACT_HOLD,
  );
}

export function consumeMillHoldPrune(s: UlwCycleState): boolean {
  if (!s.millHoldPrunePending) return false;
  s.millHoldPrunePending = false;
  saveUlwCycle(s);
  return true;
}

function markHoldArmed(s: UlwCycleState): void {
  if (!s.sameSurfaceHold && !s.contractHold) {
    s.millHoldPrunePending = true;
  }
}

function markExploreRequired(s: UlwCycleState): void {
  if (!s.exploreRequired) {
    s.exploreRequired = true;
    s.exploreRequiredAt = nowIso();
  }
}

export function exploreHolding(s: UlwCycleState): boolean {
  if (!s.enabled || !canArmSameSurfaceHold(s)) return false;
  return Boolean(s.exploreRequired);
}

/** A completed explore child after hold — parent may adopt/ship a pick. */
export function noteExploreChildCompleted(sessionId: string): boolean {
  if (!sessionId) return false;
  const s = loadUlwCycle(sessionId);
  if (!s?.enabled || !s.exploreRequired) return false;
  s.exploreRequired = false;
  s.exploreRequiredAt = undefined;
  saveUlwCycle(s);
  return true;
}

export function notePlayLoopRan(sessionId: string): void {
  if (!sessionId) return;
  try {
    const s = loadUlwCycle(sessionId);
    if (!s?.enabled) return;
    s.playLoopPending = true;
    saveUlwCycle(s);
  } catch {
    /* sidecar optional */
  }
}

export function isPlayLoopCloser(text: string): boolean {
  return /\bplaywright\b|\bplay-loop\b|\bplayed the game\b|\bplay the game\b|\bzero JS errors\b/i.test(
    text || "",
  );
}

function applyContractNote(
  s: UlwCycleState,
  summary: string,
  themed: boolean,
  sessionId: string,
): void {
  if (!themed || isConsolidationCloser(summary)) return;
  if (!canArmSameSurfaceHold(s)) return;
  const picks = loadExploreMapPicks(sessionId);
  if (!picks.length) return;
  if (isOnExploreContract(summary, picks)) {
    s.offContractStreak = 0;
    s.contractHold = false;
    return;
  }
  s.offContractStreak = (s.offContractStreak ?? 0) + 1;
  if (s.offContractStreak >= OFF_CONTRACT_HOLD) {
    markHoldArmed(s);
    s.contractHold = true;
    markExploreRequired(s);
  }
}

function consumeProofTaint(s: UlwCycleState): boolean {
  if (!s.rawPinProofTaint) return false;
  s.rawPinProofTaint = false;
  return true;
}

function holdAdmit(sessionId: string, base: string): string {
  const extra = formatHoldContextAppendix(sessionId);
  return extra ? `${base}\n${extra}` : base;
}

function waveClassTexts(s: UlwCycleState): string[] {
  return (s.waves ?? [])
    .map((w) => (w.classText || w.summary || "").trim())
    .filter(Boolean);
}

function clipClassText(text: string): string {
  const s = (text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length <= 400 ? s : `${s.slice(0, 399)}…`;
}

function closerOnContract(sessionId: string, text: string): boolean {
  return isOnExploreContract(text, loadExploreMapPicks(sessionId));
}

/** Mill sibling? On-contract (pick) ships are never mill. */
function isMillSiblingCloser(s: UlwCycleState, closer: string): boolean {
  if (s.playLoopPending || isPlayLoopCloser(closer)) return false;
  const onContract = closerOnContract(s.sessionId, closer);
  if (onContract) return false;
  const prev = waveClassTexts(s);
  return (
    isMillClassShip(closer) ||
    matchesRecentSurface(prev, closer) ||
    factoryClassHolding(prev, closer)
  );
}

function applySameSurfaceNote(
  s: UlwCycleState,
  classText: string,
  themed: boolean,
  sessionId: string,
): void {
  // Generic Stop closers ("did some edits") are not themed ships.
  if (!themed) return;
  const onContract = closerOnContract(sessionId, classText);
  const prev = waveClassTexts(s);
  const note = nextSameSurfaceStreak(prev, classText, s.sameSurfaceStreak ?? 0, {
    consolidation: isConsolidationCloser(classText),
    onContract,
  });
  s.sameSurfaceStreak = note.streak;
  const factoryHold =
    canArmSameSurfaceHold(s) &&
    factoryClassHolding(prev, classText, { onContract });
  if (
    (note.streak >= SAME_SURFACE_HOLD || factoryHold) &&
    canArmSameSurfaceHold(s)
  ) {
    markHoldArmed(s);
    s.sameSurfaceHold = true;
    if (factoryHold || isMillClassShip(classText, { onContract })) {
      markExploreRequired(s);
    }
  } else if (note.streak < SAME_SURFACE_HOLD && !factoryHold) {
    s.sameSurfaceHold = false;
    s.sameSurfaceAdmitCount = 0;
  }
}

const SAME_SURFACE_HOLD_ADMIT = [
  "[Forge ULW cycle driver] Stop blocked — last ships are the same surface (or the same adjacent-share / factory class).",
  "Write a new Reading: the ONE next ship on a different class (name an explore-map pick, or a play-path / architecture / honest red-suite ship). Or /cycle 0.",
  "A new noun is not a new surface. Do not recap the last ship as 'Last ship was' / 'what's still hard' — that is the mill template, not a new class.",
  "Different class: play-path bug, architecture, honest red suite, play-loop — or an unretired explore-map pick.",
  "Do not attest **Cycle complete.** Stuck-wall will not release this hold.",
].join("\n");

const CONTRACT_HOLD_ADMIT = [
  "[Forge ULW cycle driver] Stop blocked — last ships ignored the explore-map picks.",
  "Write a new Reading that ships or retires a pick with evidence, or /cycle 0.",
  "Eight off-contract ships is not a new class. Stuck-wall will not release this hold.",
].join("\n");

const EXPLORE_REQUIRED_ADMIT = [
  "[Forge ULW cycle driver] Stop blocked — last ships are the same class and no mid-run explore has run.",
  "Spawn ONE explore child (`spawn_subagent`, type=explore) whose prompt is the open picks plus: what did we abandon?",
  "Do not Mad-Lib a Reading from memory. Do not ship. Fold the child's map into the next Reading.",
  "Stuck-wall will not release. /cycle 0 wraps.",
].join("\n");



function splitNamedShipList(s: string): string[] {
  const parts = s
    .split(/\s*(?:,|;|\band\b)\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
  // "full-heals, so the 4 HP is usually 0" is one thought, not two ships.
  const out: string[] = [];
  for (const part of parts) {
    if (out.length > 0 && /^(so|then|which|because)\b/i.test(part)) {
      out[out.length - 1] = `${out[out.length - 1]}, ${part}`;
      continue;
    }
    out.push(part);
  }
  return out;
}

function clipNamedShipText(raw: string): string | undefined {
  let s = raw.replace(/^[-*•\d.)\s]+/, "").replace(/[.]+$/, "").trim();
  s = s.replace(/^(the\s+)?(one\s+)?(ship|item|thing)\s*(is|:)\s*/i, "").trim();
  s = s.replace(/\.\s*next\b.*$/i, "").trim();
  if (s.length < 8 || s.length > 160) return undefined;
  if (/^reading:/i.test(s)) return undefined;
  // Rationale / next-need fragments are not backlog items (maze dogfood).
  if (
    /^(so|because|then|which|do not|don't|next:|next is|a real play bug)\b/i.test(
      s,
    )
  ) {
    return undefined;
  }
  return s;
}

function splitPassedOnList(s: string): string[] {
  const t = s.trim();
  if (!t) return [];
  if (t.includes(";")) {
    return t.split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean);
  }
  return splitNamedShipList(t);
}

/** Pull the ONE ship + passed-on / next-ship list out of a reading. */
export function parseNamedShipsFromReading(text: string): string[] {
  const t = (text || "")
    .replace(/\(\s*later waves?[^)]*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return [];
  const out: string[] = [];
  const push = (raw: string) => {
    const s = clipNamedShipText(raw);
    if (!s) return;
    const key = s.toLowerCase();
    if (out.some((x) => x.toLowerCase() === key)) return;
    out.push(s);
  };
  const one = t.match(
    /(?:the\s+)?one\s+(?:ship|item)\s*(?:is|:)\s+(.+?)(?:\.|passed[\s-]+on|\.\s*next\b|$)/i,
  );
  if (one?.[1]) push(one[1]);
  const passed = t.match(
    /passed[\s-]+on\s*:?\s+(.+?)(?:\.\s*(?:the\s+)?one\s+ship|\s+(?:the\s+)?one\s+ship:|\.\s*next\b|\.\s*$|$)/i,
  );
  if (passed?.[1]) {
    for (const part of splitPassedOnList(passed[1])) push(part);
  }
  const next = t.match(/next\s+ships?\s*:?\s+(.{8,400}?)(?:\.|$)/i);
  if (next?.[1]) {
    for (const part of splitPassedOnList(next[1])) push(part);
  }
  return out.slice(0, 12);
}

function normalizeShipKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function significantShipWords(s: string): string[] {
  return normalizeShipKey(s)
    .split(/\s+/)
    .filter(
      (w) =>
        w.length >= 4 &&
        !/^(this|that|with|from|into|ship|landed|wave)$/.test(w),
    );
}

export function matchNamedShip(item: string, closer: string): boolean {
  const a = normalizeShipKey(item);
  const b = normalizeShipKey(closer);
  if (!a || !b) return false;
  if (b.includes(a) || a.includes(b)) return true;
  const aw = significantShipWords(a);
  const bw = significantShipWords(b);
  if (aw.length === 0) return false;
  const hit = aw.filter((w) => bw.includes(w)).length;
  return hit >= Math.min(2, aw.length) && hit / aw.length >= 0.5;
}

function sameNamedShipSet(prev: NamedShipItem[], parsed: string[]): boolean {
  const a = new Set(prev.map((x) => x.text.toLowerCase()));
  const b = new Set(parsed.map((x) => x.toLowerCase()));
  if (a.size === 0 || a.size !== b.size) return false;
  for (const x of b) {
    if (!a.has(x)) return false;
  }
  return true;
}

export function maybeAdoptNamedShips(
  s: UlwCycleState,
  text?: string,
): boolean {
  // LAST wrap is frozen — a new Reading must not grow the plan.
  if (s.cycle !== 1 || s.wrapKind) return false;
  const blob = [text, readingFromMemory(s.sessionId)]
    .filter((x): x is string => Boolean(x && x.trim()))
    .join("\n");
  const parsed = parseNamedShipsFromReading(blob);
  if (!parsed.length) return false;
  const prev = s.namedShips ?? [];
  const open = prev.filter((x) => x.status === "open");
  if (open.length > 0) return false;
  // Same reading still in memory after every item is done — do not reopen it.
  if (sameNamedShipSet(prev, parsed)) return false;
  if (
    prev.length > 0 &&
    prev.every((x) => x.status === "done") &&
    parsed.every((p) => prev.some((x) => matchNamedShip(x.text, p)))
  ) {
    return false;
  }
  // Unlimited: after we already asked for a new reading, do not adopt the
  // next sibling ✓ / clip leftover as a fresh plan (693c5fb1 ×3).
  if (
    normalizeMaxWaves(s.maxWaves) == null &&
    (s.namedShipAdmitCount ?? 0) >= 1 &&
    parsed.every((p) => isLeftoverChromeShip(p))
  ) {
    return false;
  }
  // Unlimited mill: refuse a one-ship reading that is the same adjacent-share
  // / factory class as the last ships (log10: 106 Mad-Lib adopts).
  // A pick (Memory Walk / topology) is a different class even if the
  // reading recaps the last mill ship.
  const picks = loadExploreMapPicks(s.sessionId);
  const adoptBlob = parsed.join("\n");
  const onContract =
    isOnExploreContract(adoptBlob, picks) ||
    parsed.some((p) => isOnExploreContract(p, picks));
  if (
    normalizeMaxWaves(s.maxWaves) == null &&
    (s.namedShipAdmitCount ?? 0) >= 1 &&
    isSameClassReading(waveClassTexts(s), parsed, { onContract })
  ) {
    return false;
  }
  // User-facing product: a preview/chrome catalog is not a reading.
  if (
    isUserFacingProductWork(s.mandate) &&
    parsed.length > 0 &&
    parsed.every((p) => isLeftoverChromeShip(p))
  ) {
    return false;
  }
  // Hold without a fresh look — refuse even a pick Mad-Lib.
  if (exploreHolding(s)) {
    return false;
  }
  // Contract hold: only an on-pick reading may adopt.
  if (contractHolding(s)) {
    if (!onContract) {
      return false;
    }
    s.contractHold = false;
    s.offContractStreak = 0;
  }
  // Same-surface hold: refuse a reading whose ONE ship is the last theme.
  // Passed-on items may name the old surface — that is "we are leaving it."
  // A pick reading is a different class even if it quotes mill flavor.
  if (s.sameSurfaceHold || (s.sameSurfaceStreak ?? 0) >= SAME_SURFACE_HOLD) {
    const prev = waveClassTexts(s);
    const one = parsed[0] ?? "";
    if (
      !onContract &&
      (matchesRecentSurface(prev, one) || isLeftoverSiblingShip(one))
    ) {
      return false;
    }
    clearSameSurfaceHold(s);
    s.sameSurfaceStreak = 0;
  }
  s.namedShips = parsed.map((item) => ({ text: item, status: "open" as const }));
  s.namedShipAdmitDone = false;
  if (text) {
    try {
      harvestProductQualityNotes(s.sessionId, text);
    } catch {
      /* ledger is best-effort */
    }
  }
  saveUlwCycle(s);
  return true;
}

const CANCEL_SHIP_RE =
  /\b(?:cancell?ed?|won'?t ship|skip(?:ping)?|out of scope)\b/i;

export function markNamedShipDone(s: UlwCycleState, closer: string): void {
  const items = s.namedShips;
  if (!items?.length) return;
  const open = items.filter((x) => x.status === "open");
  if (!open.length) return;
  const cancel = CANCEL_SHIP_RE.test(closer);
  const matched = open.filter((x) => matchNamedShip(x.text, closer));
  // Cycle complete / cancel must not FIFO-consume the next named item.
  // Cancel may close every listed leftover in one closer.
  const hits = cancel
    ? matched
    : matched.length
      ? [matched[0]!]
      : /\bCycle complete\b/i.test(closer)
        ? []
        : [open[0]!];
  for (const hit of hits) {
    hit.status = "done";
    hit.doneAt = nowIso();
    markWrapItemClosed(s, hit.text, closer, cancel ? "cancelled" : "done");
  }
}

export function namedShipsExhausted(s: UlwCycleState): boolean {
  const items = s.namedShips;
  return Boolean(
    items && items.length > 0 && items.every((x) => x.status === "done"),
  );
}

const NAMED_SHIP_EXHAUSTED_ADMIT = [
  "[Forge ULW cycle driver] Stop blocked — named ships from the reading are done.",
  "Write a new Reading: the ONE next ship on a different class (name an explore-map pick, or a play-path / architecture / honest red-suite ship). Or /cycle 0.",
  "A new noun is not a new surface. Do not recap the last ship as 'Last ship was' / 'what's still hard' — that is the mill template.",
  "A red test suite or open defect is a different surface — not leftover chrome.",
  "Unlimited ULW continues only after a new reading. Stuck-wall will not release this hold.",
].join("\n");

const NAMED_SHIP_EXHAUSTED_STRONG = [
  "[Forge ULW cycle driver] Stop blocked — named ships from the reading are done.",
  "Write a new Reading: the ONE next ship on a different class (name an explore-map pick, or a play-path / architecture / honest red-suite ship). Or /cycle 0.",
  "Do not Mad-Lib another beside-you / far-stays sibling. A red test suite or play-path bug is a different class.",
  "Do not attest **Cycle complete.** — /cycle 0 finishes this wave + one more, then LAST.",
  "Stuck-wall will not release this hold.",
].join("\n");

const MAX_NAMED_SHIP_ADMITS = 3;

const OPEN_WAVE_WRAP_TEXT =
  "Finish the open wave: ship or revert in-flight work, prove, review";

function clearUlwWrap(s: UlwCycleState): void {
  s.wrapItems = [];
  s.wrapKind = undefined;
  s.wrapFrozenAt = undefined;
  s.wrapNudgeDone = false;
}

/** Snapshot LAST wrap once. Immediate LAST (`/done` / safety / cap) only. */
export function snapshotUlwWrap(
  s: UlwCycleState,
  kind: UlwLastReason,
): void {
  if (s.wrapKind) return;
  s.wrapKind = kind;
  s.wrapFrozenAt = nowIso();
  s.wrapNudgeDone = false;
  const items: UlwWrapItem[] = [];
  if (kind === "user") {
    for (const n of s.namedShips ?? []) {
      if (n.status === "open") {
        items.push({ text: n.text, source: "named", status: "open" });
      }
    }
  }
  items.push({
    text: OPEN_WAVE_WRAP_TEXT,
    source: "open_wave",
    status: "open",
  });
  s.wrapItems = items;
}

/**
 * Older LAST sidecars have no wrapKind. Infer: cap already spent → budget;
 * otherwise treat as a user wrap so leftover named ships are not dropped.
 */
export function ensureUlwWrap(s: UlwCycleState): void {
  if (s.cycle !== 0 || s.wrapKind) return;
  const cap = normalizeMaxWaves(s.maxWaves);
  snapshotUlwWrap(s, cap != null && s.wave >= cap ? "budget" : "user");
}

export function openNamedWrapItems(s: UlwCycleState): UlwWrapItem[] {
  return (s.wrapItems ?? []).filter(
    (x) => x.source === "named" && x.status === "open",
  );
}

function markWrapItemClosed(
  s: UlwCycleState,
  namedText: string,
  closer: string | undefined,
  status: "done" | "cancelled",
): void {
  const items = s.wrapItems;
  if (!items?.length) return;
  const open = items.filter((x) => x.status === "open" && x.source === "named");
  if (!open.length) return;
  const blob = [namedText, closer].filter(Boolean).join("\n");
  const hit =
    open.find((x) => matchNamedShip(x.text, blob)) ??
    (namedText ? open.find((x) => matchNamedShip(x.text, namedText)) : undefined);
  if (!hit) return;
  hit.status = status;
  hit.doneAt = nowIso();
}

const WRAP_WAVE_SETTLED_RE =
  /\b(?:cancell?ed?|reverted|working tree clean|tree is clean|nothing to commit|already committed)\b/i;

function userWrapWaveUnfinished(
  s: UlwCycleState,
  opts: {
    verificationPassed?: boolean;
    diffFingerprint?: string | null;
  },
  msg: string,
): boolean {
  if (s.wrapKind !== "user") return false;
  if (WRAP_WAVE_SETTLED_RE.test(msg || "")) return false;
  const dirty = Boolean(
    opts.diffFingerprint && !isCleanTreeDiffFp(opts.diffFingerprint),
  );
  const unverified = opts.verificationPassed === false;
  return dirty || unverified;
}

function markOpenWaveWrapDone(s: UlwCycleState): void {
  for (const x of s.wrapItems ?? []) {
    if (x.source === "open_wave" && x.status === "open") {
      x.status = "done";
      x.doneAt = nowIso();
    }
  }
}

export function formatWrapCard(s: UlwCycleState): string {
  const named = (s.wrapItems ?? []).filter((x) => x.source === "named");
  const openNamed = named.filter((x) => x.status === "open");
  const lines: string[] = [
    "You may stop after this wrap. Carry in-flight work to done (or cancel with reason), then review and attest **Cycle complete.**",
    "Do not write a new Reading. Do not start a new surface.",
  ];
  if (s.wrapKind === "user" && named.length) {
    lines.push(
      `Already-named plan: ${named.length - openNamed.length}/${named.length} done.`,
    );
    for (const n of named) {
      const mark = n.status === "open" ? "·" : n.status === "done" ? "✓" : "✗";
      lines.push(`  ${mark} ${n.text}`);
    }
  } else if (s.wrapKind === "budget") {
    lines.push(
      "Budget LAST — wrap this wave only (prove + review). Leftover named ships past the cap are not new waves.",
    );
  }
  return lines.join("\n");
}

/** After auto-commit the tree is clean — that is a new baseline, not churn. */
export function applyCleanBaselineAfterCommit(
  s: UlwCycleState,
  fp: string | null,
): void {
  if (!fp) return;
  s.lastDiffFp = fp;
  s.seenDiffFps = (s.seenDiffFps ?? []).filter((x) => x !== fp);
}

export function noteUlwTreeAfterAutoCommit(
  sessionId: string,
  cwd?: string,
): void {
  const s = loadUlwCycle(sessionId);
  if (!s) return;
  let fp: string | null = null;
  if (cwd) {
    try {
      fp = gitDiffFingerprint(cwd);
    } catch {
      fp = null;
    }
  }
  applyCleanBaselineAfterCommit(s, fp);
  saveUlwCycle(s);
}

/**
 * Unattended quality-bar heartbeat. The user-facing wave counter increments
 * on Stop or a declared ship (`Wave N shipped` / `Ship landed` / `Cycle
 * complete`). Edit bursts and idle epochs update the open wave in place
 * so one 80-turn ship is not four harness waves. `max_waves` still
 * auto-LAST. Idle never increments `w` (capped or unlimited).
 */
export function maybeStampUlwWave(opts: {
  sessionId: string;
  editCount: number;
  openTodoCount: number;
  stepsSinceStamp: number;
  lastAssistantMessage?: string;
  verificationRan?: boolean;
  verificationPassed?: boolean;
  cwd?: string;
}): MidWaveStampResult {
  const s = loadUlwCycle(opts.sessionId);
  if (!s?.enabled) return { stamped: false };

  const cap = normalizeMaxWaves(s.maxWaves);
  if (cap != null && s.cycle === 1 && s.wave >= cap) {
    flipUlwToLast(s, opts.sessionId);
    saveUlwCycle(s);
    return {
      stamped: false,
      flippedToLast: true,
      wave: s.wave,
      admit: lastWaveAdmit(cap, s.wave, s.cycleZeroStopAt != null),
    };
  }

  let fp: string | null = null;
  if (opts.cwd) {
    try {
      fp = gitDiffFingerprint(opts.cwd);
    } catch {
      fp = null;
    }
  }
  // Do NOT applyDiffFingerprint here — that would advance lastDiffFp on
  // every edit burst and make the next Stop see net=none (wave 1 +10e none).
  const treeMoved = Boolean(fp && s.lastDiffFp && fp !== s.lastDiffFp);
  const baseline = s.lastProgressEditCount ?? s.lastBlockEditCount;
  const editDelta = Math.max(0, opts.editCount - baseline);
  const progressed = opts.editCount > baseline || treeMoved;
  const idleDue = opts.stepsSinceStamp >= MID_WAVE_STAMP_STEPS;
  if (!progressed && !idleDue) return { stamped: false };
  const sig = waveProgressSig(opts.editCount, fp);
  if (progressed && s.lastWaveSig === sig && !idleDue) {
    return { stamped: false };
  }
  const prevOpen =
    s.lastOpenTodoCount != null ? s.lastOpenTodoCount : opts.openTodoCount;
  const todoProgress = Math.max(0, prevOpen - opts.openTodoCount);
  s.lastOpenTodoCount = opts.openTodoCount;
  const netDiff: UlwWaveRecord["netDiff"] = !fp
    ? undefined
    : treeMoved
      ? (s.seenDiffFps ?? []).includes(fp) &&
        !(isCleanTreeDiffFp(fp) && editDelta >= 1)
        ? "revisit"
        : "new"
      : editDelta > 0
        ? "new"
        : "none";
  const closer = closerText(
    opts.sessionId,
    opts.lastAssistantMessage || "",
  );
  const proof = detectWaveProof(
    closer,
    opts.verificationPassed ?? opts.verificationRan,
  );
  const summary =
    summarizeWave(closer, opts.sessionId) || "(mid-loop epoch)";
  const facts = {
    editDelta,
    proof,
    todoProgress,
    netDiff,
    summary,
    themed: true,
  };

  // LAST: update the open wave's facts, never increment the counter.
  // Declared ships still close named/wrap items so LAST can wrap the plan.
  if (s.cycle !== 1) {
    if (progressed) {
      updateOpenWaveRecord(s, facts);
      s.lastProgressEditCount = opts.editCount;
    }
    if (isDeclaredWaveClose(closer) && progressed && editDelta >= 1) {
      markNamedShipDone(s, closer);
    }
    saveUlwCycle(s);
    return { stamped: false, updated: progressed, wave: s.wave };
  }

  if (s.judgmentRequired && hasMandateJudgment(opts.sessionId, opts.lastAssistantMessage)) {
    s.judgmentRequired = false;
    s.phase = "ship";
  }
  // Adopt even when already in ship — memory_write lands after the
  // assistant turn, so orient may have already flipped before the list exists.
  maybeAdoptNamedShips(s, opts.lastAssistantMessage);

  // Declared ship with real progress: this is a work unit. Capped ULW
  // must count it — otherwise the model invents Wave 3/4 while HUD stays 1/4
  // for hours (Stop never fires because cycle=1 blocks it).
  if (
    isDeclaredWaveClose(closer) &&
    progressed &&
    editDelta >= 1
  ) {
    if (
      s.judgmentRequired &&
      s.wave === 0 &&
      !hasMandateJudgment(opts.sessionId, closer)
    ) {
      /* still need a reading — fall through */
    } else {
      if (exploreHolding(s)) {
        saveUlwCycle(s);
        return {
          stamped: false,
          wave: s.wave,
          admit: holdAdmit(opts.sessionId, EXPLORE_REQUIRED_ADMIT),
        };
      }
      if (
        contractHolding(s) &&
        !isOnExploreContract(closer, loadExploreMapPicks(opts.sessionId))
      ) {
        s.contractHold = true;
        saveUlwCycle(s);
        return {
          stamped: false,
          wave: s.wave,
          admit: holdAdmit(opts.sessionId, CONTRACT_HOLD_ADMIT),
        };
      }
      if (
        sameSurfaceHolding(s) &&
        (isLeftoverChromeShip(closer) || isMillSiblingCloser(s, closer))
      ) {
        s.sameSurfaceHold = true;
        s.sameSurfaceAdmitCount = (s.sameSurfaceAdmitCount ?? 0) + 1;
        saveUlwCycle(s);
        return {
          stamped: false,
          wave: s.wave,
          admit: holdAdmit(opts.sessionId, SAME_SURFACE_HOLD_ADMIT),
        };
      }
      applyDiffFingerprint(s, fp);
      appendWaveRecord(s, {
        sessionId: opts.sessionId,
        ...facts,
        classText: closer,
      });
      markNamedShipDone(s, closer);
      s.lastWaveSig = sig;
      s.lastProgressEditCount = opts.editCount;
      const polish = notePolishShip(s, closer);
      let flipped = false;
      let polishLast = false;
      if (cap != null && s.wave >= cap) {
        flipUlwToLast(s, opts.sessionId);
        flipped = true;
      } else if (polish >= POLISH_LAST_STREAK && s.cycle === 1) {
        flipUlwToLast(s, opts.sessionId);
        flipped = true;
        polishLast = true;
      }
      saveUlwCycle(s);
      const counts = formatUlwCounts(s);
      const extra =
        polish >= POLISH_ADVISORY_STREAK ? `\n${polishAdmit(polish)}` : "";
      return {
        stamped: true,
        wave: s.wave,
        flippedToLast: flipped,
        admit: polishLast
          ? [
              "[Forge harness — mid-conversation update]",
              `ULW ${counts} — polish-class auto LAST.`,
              polishAdmit(polish),
            ].join("\n")
          : flipped
            ? lastWaveAdmit(cap!, s.wave, s.cycleZeroStopAt != null)
            : [
                "[Forge harness — mid-conversation update]",
                `ULW ${counts} — harness counter moved after a declared ship.`,
                "This w=N/M is the only wave number. Do not invent Wave K.",
                extra.trim(),
              ]
                .filter(Boolean)
                .join("\n"),
      };
    }
  }

  // Edit progress without an idle epoch: one burst = one wave.
  if (progressed && !idleDue) {
    updateOpenWaveRecord(s, facts);
    s.lastProgressEditCount = opts.editCount;
    saveUlwCycle(s);
    return { stamped: false, updated: true, wave: s.wave };
  }

  // Idle epoch: update the open wave, never increment w.
  // Capped: a cap of 4 used to LAST mid-ship (~80 tool rounds).
  // Unlimited: an 80-turn ship used to become four harness waves.
  if (idleDue) {
    if (
      s.judgmentRequired &&
      s.wave === 0 &&
      !hasMandateJudgment(opts.sessionId, opts.lastAssistantMessage)
    ) {
      s.judgmentDemands = Math.min(
        MAX_JUDGMENT_DEMANDS,
        (s.judgmentDemands ?? 0) + 1,
      );
      saveUlwCycle(s);
      if ((s.judgmentDemands ?? 0) >= MAX_JUDGMENT_DEMANDS) {
        s.judgmentRequired = false;
        s.phase = "ship";
        saveUlwCycle(s);
      } else {
        return {
          stamped: false,
          wave: s.wave,
          admit: [
            "[Forge harness — mid-conversation update]",
            "Evaluate-class mandate: write the reading (what the hard work is + the ONE ship) before a new wave opens.",
            "memory_write it, or start the next reply with `Reading:`.",
          ].join("\n"),
        };
      }
    }
    if (progressed) {
      updateOpenWaveRecord(s, facts);
      s.lastProgressEditCount = opts.editCount;
    }
    if (cap != null && s.wave >= cap) {
      flipUlwToLast(s, opts.sessionId);
      saveUlwCycle(s);
      return {
        stamped: false,
        flippedToLast: true,
        wave: s.wave,
        admit: lastWaveAdmit(cap, s.wave, s.cycleZeroStopAt != null),
      };
    }
    saveUlwCycle(s);
    return { stamped: false, updated: progressed, wave: s.wave };
  }

  return { stamped: false, wave: s.wave };
}

/**
 * Best factual wave so far: prefer waves with proof, then largest edit delta.
 * Churn waves (diff fingerprint revisit) are excluded from anchoring — an
 * edit→revert loop must not become the bar. Used to anchor the bar
 * ("match or beat your best wave") — not a score.
 */
export function bestWave(waves: UlwWaveRecord[] | undefined): UlwWaveRecord | null {
  if (!waves?.length) return null;
  const notChurn = waves.filter((w) => w.netDiff !== "revisit");
  const notMill = (notChurn.length ? notChurn : waves).filter(
    (w) =>
      !w.millClass &&
      !isFactoryFingerprint(w.classText || w.summary) &&
      !isChangelogOnlySummary(w.summary, w.editDelta),
  );
  const eligible = notMill.length ? notMill : notChurn.length ? notChurn : waves;
  const proven = eligible.filter((w) => w.proof);
  const pool = proven.length ? proven : eligible;
  return pool.reduce((best, w) => (w.editDelta > best.editDelta ? w : best), pool[0]);
}

/** One-line factual ledger for re-anchors/status: `w1 +12e ✓ · w2 +1e↺ ✗` (↺ = churn revisit). */
export function formatWaveLedger(
  waves: UlwWaveRecord[] | undefined,
  max = 8,
): string {
  if (!waves?.length) return "";
  return waves
    .slice(-max)
    .map(
      (w) =>
        `w${w.wave} +${w.editDelta}e${w.netDiff === "revisit" ? "↺" : ""}${
          w.todoProgress != null && w.todoProgress > 0
            ? ` tΔ${w.todoProgress}`
            : ""
        } ${w.proof ? "✓" : "✗"}`,
    )
    .join(" · ");
}

const SOFT_PROMPT_RE =
  /^(please\s+)?(improve|fix|polish|clean|harden|refactor|optimize|enhance|update|upgrade|review|audit|tidy|beautify|simplify|modernize)(\s+(the|this|our|my))?(\s+\w+){0,6}\.?$/i;

const BARE_IMPERATIVE_RE =
  /^(fix|improve|polish|clean|harden|refactor|optimize|ship|audit|review|test)\.?$/i;

export function ulwStatePath(sessionId: string): string {
  return path.join(forgeHome(), "sessions", sessionId, "ulw.json");
}

/** Normalize legacy/partial ulw.json into a valid maxWaves (null = unlimited). */
export function normalizeMaxWaves(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

export function loadUlwCycle(sessionId: string): UlwCycleState | null {
  const raw = readJsonFile<UlwCycleState | null>(ulwStatePath(sessionId), null);
  if (!raw) return null;
  // Back-compat: older sidecars omit maxWaves
  if (!("maxWaves" in raw) || raw.maxWaves === undefined) {
    raw.maxWaves = null;
  } else {
    raw.maxWaves = normalizeMaxWaves(raw.maxWaves);
  }
  // Back-compat: older sidecars omit the wave ledger / quality counters
  if (!Array.isArray(raw.waves)) raw.waves = [];
  if (typeof raw.thinStreak !== "number" || !Number.isFinite(raw.thinStreak)) {
    raw.thinStreak = 0;
  }
  if (typeof raw.polishStreak !== "number" || !Number.isFinite(raw.polishStreak)) {
    raw.polishStreak = 0;
  }
  if (typeof raw.proofDemands !== "number" || !Number.isFinite(raw.proofDemands)) {
    raw.proofDemands = 0;
  }
  if (
    typeof raw.evidenceNudges !== "number" ||
    !Number.isFinite(raw.evidenceNudges)
  ) {
    raw.evidenceNudges = 0;
  }
  if (typeof raw.judgmentRequired !== "boolean") raw.judgmentRequired = false;
  if (
    typeof raw.judgmentDemands !== "number" ||
    !Number.isFinite(raw.judgmentDemands)
  ) {
    raw.judgmentDemands = 0;
  }
  if (raw.phase !== "orient" && raw.phase !== "ship") {
    raw.phase = raw.judgmentRequired ? "orient" : "ship";
  }
  // Back-compat: older sidecars omit diff-fingerprint churn tracking
  if (!Array.isArray(raw.seenDiffFps)) raw.seenDiffFps = [];
  raw.namedShips = normalizeNamedShipItems(raw.namedShips);
  if (typeof raw.namedShipAdmitDone !== "boolean") {
    raw.namedShipAdmitDone = false;
  }
  if (
    typeof raw.namedShipAdmitCount !== "number" ||
    !Number.isFinite(raw.namedShipAdmitCount)
  ) {
    raw.namedShipAdmitCount = 0;
  }
  raw.wrapItems = normalizeWrapItems(raw.wrapItems);
  if (raw.wrapKind !== "user" && raw.wrapKind !== "budget") {
    raw.wrapKind = undefined;
  }
  if (typeof raw.wrapNudgeDone !== "boolean") raw.wrapNudgeDone = false;
  if (typeof raw.soulNudgeDone !== "boolean") raw.soulNudgeDone = false;
  {
    const stopAt = normalizeMaxWaves(raw.cycleZeroStopAt);
    raw.cycleZeroStopAt = stopAt ?? undefined;
  }
  if (
    typeof raw.sameSurfaceStreak !== "number" ||
    !Number.isFinite(raw.sameSurfaceStreak)
  ) {
    raw.sameSurfaceStreak = 0;
  }
  if (typeof raw.sameSurfaceHold !== "boolean") raw.sameSurfaceHold = false;
  if (
    typeof raw.sameSurfaceAdmitCount !== "number" ||
    !Number.isFinite(raw.sameSurfaceAdmitCount)
  ) {
    raw.sameSurfaceAdmitCount = 0;
  }
  if (
    typeof raw.offContractStreak !== "number" ||
    !Number.isFinite(raw.offContractStreak)
  ) {
    raw.offContractStreak = 0;
  }
  if (typeof raw.contractHold !== "boolean") raw.contractHold = false;
  if (typeof raw.exploreRequired !== "boolean") raw.exploreRequired = false;
  if (typeof raw.exploreRequiredAt !== "string") raw.exploreRequiredAt = undefined;
  if (typeof raw.playLoopPending !== "boolean") raw.playLoopPending = false;
  if (typeof raw.rawPinProofTaint !== "boolean") raw.rawPinProofTaint = false;
  if (typeof raw.millHoldPrunePending !== "boolean") {
    raw.millHoldPrunePending = false;
  }
  return raw;
}

function normalizeWrapItems(raw: unknown): UlwWrapItem[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  const out: UlwWrapItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim().slice(0, 200) : "";
    if (text.length < 8) continue;
    const source: UlwWrapSource =
      o.source === "named" || o.source === "todo" || o.source === "open_wave"
        ? o.source
        : "open_wave";
    const status: UlwWrapItem["status"] =
      o.status === "done" || o.status === "cancelled" ? o.status : "open";
    out.push({
      text,
      source,
      status,
      ...(typeof o.doneAt === "string" && o.doneAt ? { doneAt: o.doneAt } : {}),
    });
    if (out.length >= 16) break;
  }
  return out;
}

function normalizeNamedShipItems(raw: unknown): NamedShipItem[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  const out: NamedShipItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim().slice(0, 160) : "";
    if (text.length < 8) continue;
    out.push({
      text,
      status: o.status === "done" ? "done" : "open",
      ...(typeof o.doneAt === "string" && o.doneAt ? { doneAt: o.doneAt } : {}),
    });
    if (out.length >= 12) break;
  }
  return out;
}

export function saveUlwCycle(state: UlwCycleState): void {
  state.updatedAt = nowIso();
  state.maxWaves = normalizeMaxWaves(state.maxWaves);
  writeJsonFile(ulwStatePath(state.sessionId), state);
}

/**
 * Resume / keep-going follow-ups. These must NOT re-arm ULW or replace the
 * mandate — after quota/drop the user types "continue" to resume, not to
 * start a new god-mode task named "continue".
 */
export function isResumeFollowUp(prompt: string): boolean {
  const t = prompt.replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return false;
  return /^(continue|resume|keep going|go on|go ahead|proceed|yes|y|ok|okay)[.!?]*$/.test(
    t,
  );
}

/**
 * Auto-arm token when /cycle, /max-waves, or `forge --ulw` has no work-order
 * yet. Not a real mandate — adoptUlwMandate replaces it on the first one.
 * `/ulw` / `improve the codebase` is a real soft default and must NOT match.
 */
export const PLACEHOLDER_MANDATE = "continue prior mandate";

export function isUlwKickoffText(text: string): boolean {
  const t = (text || "").trimStart();
  return /^## ULW armed\b/i.test(t) || /^## ULW GOD MODE\b/i.test(t);
}

export function isPlaceholderMandate(mandate: string): boolean {
  const t = (mandate || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return true;
  if (isResumeFollowUp(t)) return true;
  return t === PLACEHOLDER_MANDATE;
}

/**
 * True when text is safe to become the ULW mandate on /cycle or CLI auto-arm.
 * Rejects acks, Q&A, kickoff dumps, and the placeholder itself.
 */
export function isArmableMandate(text: string): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || isPlaceholderMandate(t) || t.length < 12) return false;
  if (isUlwKickoffText(text || "")) return false;
  if (looksLikeAdvisoryUserMessage(t)) return false;
  if (
    /^(thanks|thank you|got it|sounds good|looks good|cool|nice|great|perfect|lgtm)[.!]*$/i.test(
      t,
    )
  ) {
    return false;
  }
  return true;
}

/** Resolve last-user / CLI prompt to a mandate, or null to keep the placeholder. */
export function mandateFromUserText(text: string): string | null {
  const raw = (text || "").trim();
  if (!raw) return null;
  if (isUlwKickoffText(raw)) {
    const m = raw.match(/^Mandate:\s*(.+)$/m);
    const inner = (m?.[1] || "").trim();
    return inner && isArmableMandate(inner) ? inner : null;
  }
  return isArmableMandate(raw) ? raw.replace(/\s+/g, " ").trim() : null;
}

/** Human/model-facing mandate. Never show the auto-arm placeholder. */
export function displayUlwMandate(mandate: string): string {
  const t = (mandate || "").trim();
  if (!t || isPlaceholderMandate(t)) return "(pending work-order)";
  return t;
}

/** Soft / weak prompts that need god-scope expansion under ULW. */
export function isSoftPrompt(prompt: string): boolean {
  const t = prompt.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (isResumeFollowUp(t)) return false;
  if (t.length < 12) return true;
  if (BARE_IMPERATIVE_RE.test(t)) return true;
  if (SOFT_PROMPT_RE.test(t)) return true;
  // No concrete deliverable markers
  const hasConcrete =
    /\b(test|tests|pass|endpoint|file|bug|error|fail|migrate|add|implement|remove|delete|until|acceptance|criteria|must|should not)\b/i.test(
      t,
    ) || /`[^`]+`|\.[a-z]{1,4}\b|\/[\w./-]+/.test(t);
  if (!hasConcrete && t.length < 80 && /improve|better|nice|clean|polish|fix/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * Expand a (possibly soft) user mandate into operational instructions
 * the model can execute wave-by-wave.
 *
 * Soft prompts become **ULW god-mode**: domain-agnostic ownership —
 * invent hard work when unspecified, work **smart** (high leverage, low waste)
 * and **proactively use subagents when that wins**, then ship + prove + repeat.
 * Philosophy over rigid checklists — freestyle when it yields better quality.
 */
export function expandUlwMandate(mandate: string): { expanded: string; soft: boolean } {
  const soft = isSoftPrompt(mandate);
  const base = mandate.replace(/\s+/g, " ").trim() || "do the hard work this workspace needs most";
  const broad = isBroadMandate(mandate);

  const smartDoctrine = [
    `### Smart + hard (IQ-class, not thrash)`,
    `Work **hard and smart**. Tokens and wall-clock are scarce — every tool call and every wave must buy leverage.`,
    `- Prefer the move a top senior makes: high impact × confidence / cost. Skip low-leverage churn when harder valuable work exists.`,
    `- Prefer **insight before volume**: a sharp read + one decisive ship beats ten shallow probes.`,
    `- **Batch** independent read-only work; greps/globs before wide reads; cheapest proof that can fail.`,
    `- Do **not** burn turns on ceremony, over-planning, or re-deriving what you already know.`,
    `- Do **not** gold-plate, infinite-research, or spawn work for its own sake.`,
    ``,
    `### Subagents — proactive when they win`,
    `Use \`spawn_subagent\` **whenever** it improves quality or efficiency — do not wait for the user to ask.`,
    `**Spawn when:** large surface to map in parallel; design/architecture tradeoffs need a clean think-space; independent workstreams can run without shared mid-flight state; isolation=worktree protects the parent tree; a deep dive would drown this thread.`,
    `**Types:** explore (read-only research), plan (design), general-purpose (implement slice). Brief the child with a crisp objective; fold the result and act.`,
    `**Skip when:** the next step is a single obvious tool call; overhead > benefit; you already have enough context to ship.`,
    `Fan-out intelligently (parallel explores), then **converge** and ship in the parent — subagents are force multipliers, not a substitute for judgment.`,
    ``,
    `### Doctrine, not a cage`,
    `The loop below is **philosophy**, not a rigid ritual. Freestyle sequence, tooling, and depth when that yields better work. Harness rails (Stop/proof/todos) stay; process theater does not.`,
  ].join("\n");

  const evaluateClass = isEvaluateClassMandate(mandate) || isEvaluateClassMandate(base);
  const backlogDoctrine = broad
    ? [
        ``,
        `### Backlog contract (broad mandate)`,
        `This mandate is multi-section. **First** materialize an ordered todo board (≥2 items) covering mandate sections via todo_write.`,
        `Waves execute the backlog against durable decisions — do **not** free-invent unrelated scope. Prefer P0 reliability/trust before polish when both appear.`,
        `Record new constraints with memory_write so compaction cannot erase them.`,
      ].join("\n")
    : "";
  const evaluateDoctrine = evaluateClass
    ? [
        ``,
        `### Evaluate-class mandate (verbs in order)`,
        `The user asked to **evaluate/audit then improve**. A written reading is Wave 1's deliverable — that is the first verb, **not** "advice-only".`,
        `1. Write the reading (one paragraph: what the hard work is, what you passed on, the ONE item you will ship). memory_write it.`,
        `2. Then ship that item. Do not burn the wave budget on catalog chrome if the mandate's first verb was evaluate.`,
        `Skipping the evaluation to jump to a tiny polish is a failed wave.`,
      ].join("\n")
    : "";
  const productQualityLine = isUserFacingProductWork(mandate)
    ? "User-facing product quality: name the hard user job, finish one edge (empty/error/first-run), at most one job-adjacent Serendipity:. Garnish is not quality."
    : "";

  if (!soft) {
    return {
      soft: false,
      expanded: [
        `User mandate: ${base}`,
        ``,
        `Execute under **ULW god-mode** until the wave cap (or /cycle 0 → this wave + one more) auto-LAST, then attest **Cycle complete.**`,
        smartDoctrine,
        backlogDoctrine,
        evaluateDoctrine,
        productQualityLine,
        ``,
        `- Own the outcome end-to-end. Research when uncertain; spawn subagents when that is smarter; then build — no thrash, no permission-to-continue asks.`,
        `- Every wave: highest-leverage next objective vs the mandate · search-before-build · ship · cheapest real proof · hostile review · next wave while cycle=1.`,
        `- Finish the **defect** class (callers, tests, dependents). Two clip/one-line chrome leftovers is enough — change surface or LAST. Do not hunt leftover dumps.`,
      ].join("\n"),
    };
  }

  return {
    soft: true,
    expanded: [
      `## ULW GOD MODE (soft user signal — full operational ownership)`,
      `User signal (SOFT — do **not** ask what they meant; do **not** wait for a clearer mandate): "${base}"`,
      ``,
      `You decide **what** the hard work is and **how** to do it like a top-tier veteran: sharp judgment, deep when needed, decisive shipping. Any domain this workspace needs — correctness, product value, architecture, reliability, UX, tooling, design, ops, incomplete work, research-backed builds — **not** a fixed menu, **not** tests/housekeeping theater by default.`,
      ``,
      `One-sentence reading (what the hard work is + what you passed on), then tools. No pep talks. No "what should I improve?".`,
      ``,
      smartDoctrine,
      backlogDoctrine,
      evaluateDoctrine,
      productQualityLine,
      ``,
      `### Operating loop (guidance — adapt freely when freestyle is better)`,
      `1. **ORIENT** — what this place is (stack, checks, entrypoints, git, AGENTS/README, real debt). Tools, not guesses.`,
      `2. **JUDGE** — single highest-leverage hard objective now (impact × confidence / cost). Write the reading.`,
      `3. **RESEARCH** — only as deep as uncertainty warrants; proactive subagents/MCP/web when that is the efficient path. Do not thrash blind.`,
      `4. **SHIP** one bounded high-leverage wave. Defect-class siblings only. Search-before-build.`,
      `5. **PROVE** — cheapest real check that can fail.`,
      `6. **SERENDIPITY** — bounded adjacent fix on an open path if cheap; label \`Serendipity:\`.`,
      `7. **HOSTILE REVIEW** — fix real defects in your diff; skip cosmetic noise.`,
      `8. **REPEAT** while cycle=1. \`/cycle 0\` means finish this wave, ship one more, then LAST — do not stop mid-wave. When cycle=0 (cap LAST), wrap this last wave and attest **Cycle complete.** with evidence.`,
      ``,
      `Optional: a short todo board for multi-wave work if it helps you; skip the board when the next move is already obvious.`,
      evaluateClass
        ? `Execute Wave 1 in this turn: the written reading first (mandate verb 1), then tools to start the one ship you picked.`
        : `Execute Wave 1 in this turn — tools, not advice.`,
      ``,
      `### Forbidden`,
      `- Asking the user to clarify a soft prompt or pick tasks.`,
      `- Advice-only / "looks fine" / defer to later — a written reading on an evaluate-class mandate is the work, not a deferral.`,
      `- Skipping the mandate's first verb (evaluate/audit) to ship a tiny adjacent polish.`,
      `- Low-leverage churn or token-burning busywork while harder work remains.`,
      `- Grinding a polish class (clip every chrome line, leftover-dump hunting) after the reading's one ship.`,
      `- Re-reading a file after a successful edit to confirm the write — use the numbered receipt window.`,
      `- Subagent spam, infinite research without shipping, gold-plating without proof.`,
      `- "Shall I continue?" — cycle / max_waves answers that.`,
    ].join("\n"),
  };
}

export function armUlwCycle(
  sessionId: string,
  mandate: string,
  opts?: {
    cycle?: CycleFlag;
    maxWaves?: number | null;
    editCount?: number;
    /** Workspace for auto safety checkpoint (git stash create). */
    cwd?: string;
    /** Skip auto-checkpoint (tests / FORGE_ULW_CHECKPOINT=0). */
    skipCheckpoint?: boolean;
  },
): UlwCycleState {
  const { expanded, soft } = expandUlwMandate(mandate);
  const prev = loadUlwCycle(sessionId);
  const maxWaves =
    opts?.maxWaves !== undefined
      ? normalizeMaxWaves(opts.maxWaves)
      : prev?.enabled
        ? normalizeMaxWaves(prev.maxWaves)
        : null;
  const cleanMandate =
    mandate.replace(/\s+/g, " ").trim() || PLACEHOLDER_MANDATE;
  // Backlog gate only for multi-section / comprehensive mandates — not every
  // soft "improve the code" (that would stall classic ULW wave tests forever).
  const broad = isBroadMandate(mandate) || isBroadMandate(cleanMandate);
  const state: UlwCycleState = {
    enabled: true,
    cycle: opts?.cycle ?? 1,
    wave: prev?.enabled ? prev.wave : 0,
    maxWaves,
    blocks: prev?.blocks ?? 0,
    stuckBlocks: 0,
    // Baseline = session-lifetime edit counter AT ARM TIME. Without it, arming
    // /ulw mid-session makes wave 1's editDelta count every pre-arm edit
    // (evaluateUlwAtStop deltas against lastBlockEditCount), and bestWave()
    // then anchors the quality bar to a wave that never ran.
    lastBlockEditCount: Math.max(0, Math.floor(opts?.editCount ?? 0)),
    mandate: cleanMandate,
    expandedMandate: expanded,
    softPrompt: soft,
    // Wave ledger persists across re-arms (same session story); streak
    // counters reset — a fresh mandate earns a fresh quality context.
    waves: prev?.waves ?? [],
    thinStreak: 0,
    polishStreak: 0,
    sameSurfaceStreak: 0,
    sameSurfaceHold: false,
    sameSurfaceAdmitCount: 0,
    offContractStreak: 0,
    contractHold: false,
    exploreRequired: false,
    playLoopPending: false,
    rawPinProofTaint: false,
    millHoldPrunePending: false,
    proofDemands: 0,
    evidenceNudges: 0,
    soulNudgeDone: false,
    backlogRequired: broad,
    judgmentRequired: (() => {
      const evaluate = isEvaluateClassMandate(cleanMandate);
      if (!evaluate) return false;
      if (prev?.enabled && shouldSkipOrient(prev, sessionId)) return false;
      return true;
    })(),
    judgmentDemands: 0,
    phase: (() => {
      const evaluate = isEvaluateClassMandate(cleanMandate);
      if (!evaluate) return "ship";
      if (prev?.enabled && shouldSkipOrient(prev, sessionId)) return "ship";
      return "orient";
    })(),
    lastOpenTodoCount: undefined,
    startedAt: prev?.enabled ? prev.startedAt : nowIso(),
    updatedAt: nowIso(),
    sessionId,
  };
  // Auto safety checkpoint before autonomous waves — zero-steering undo point.
  // Disable with FORGE_ULW_CHECKPOINT=0 or opts.skipCheckpoint.
  const cpOff = (process.env.FORGE_ULW_CHECKPOINT || "1").trim().toLowerCase();
  if (
    !opts?.skipCheckpoint &&
    cpOff !== "0" &&
    cpOff !== "false" &&
    cpOff !== "off" &&
    cpOff !== "no"
  ) {
    try {
      const cwd = opts?.cwd || process.cwd();
      const snap = createSafetyCheckpoint(cwd, {
        label: `ulw-${sessionId.slice(0, 10)}`,
      });
      if (snap.ok && snap.sha) {
        state.checkpointSha = snap.sha;
        state.checkpointAt = nowIso();
      }
    } catch {
      /* best-effort */
    }
  }
  // Baseline the working-tree fingerprint at arm so the first wave can
  // detect real progress (otherwise the first stamp is always net=none).
  // Only when cwd is explicit — tests that pass synthetic fingerprints
  // must keep the first-observation-is-baseline contract.
  if (opts?.cwd) {
    try {
      const fp = gitDiffFingerprint(opts.cwd);
      if (fp) {
        state.lastDiffFp = fp;
        state.seenDiffFps = [fp];
      }
    } catch {
      /* */
    }
  }
  saveUlwCycle(state);
  // Phase 1: durable decision memory — survive compact / multi-wave rot.
  // Do not seed "MANDATE: continue prior mandate" — adopt writes the real one.
  if (!isPlaceholderMandate(cleanMandate)) {
    try {
      seedMemoryFromMandate(sessionId, cleanMandate, { softPrompt: soft });
    } catch {
      /* memory best-effort at arm; compact fail-closed surfaces corrupt */
    }
  }
  return state;
}

/**
 * First real work-order after /cycle or /max-waves auto-armed with a
 * placeholder. Updates mandate + expansion without resetting the wave ledger.
 */
export function adoptUlwMandate(
  sessionId: string,
  mandate: string,
  opts?: { cwd?: string },
): UlwCycleState | null {
  const s = loadUlwCycle(sessionId);
  if (!s?.enabled) return null;
  const next = mandate.replace(/\s+/g, " ").trim();
  if (!next || isPlaceholderMandate(next) || isResumeFollowUp(next)) return s;
  if (isUlwKickoffText(mandate) || !isArmableMandate(next)) return s;
  if (!isPlaceholderMandate(s.mandate) && s.mandate === next) return s;
  if (!isPlaceholderMandate(s.mandate)) return s;
  const { expanded, soft } = expandUlwMandate(next);
  s.mandate = next;
  s.expandedMandate = expanded;
  s.softPrompt = soft;
  s.backlogRequired = isBroadMandate(next);
  const evaluate = isEvaluateClassMandate(next);
  if (evaluate && !shouldSkipOrient(s, sessionId)) {
    s.judgmentRequired = true;
    s.phase = "orient";
  } else {
    s.judgmentRequired = false;
    s.phase = "ship";
  }
  s.judgmentDemands = 0;
  if (opts?.cwd && !s.lastDiffFp) {
    try {
      const fp = gitDiffFingerprint(opts.cwd);
      if (fp) {
        s.lastDiffFp = fp;
        s.seenDiffFps = [fp];
      }
    } catch {
      /* */
    }
  }
  saveUlwCycle(s);
  try {
    seedMemoryFromMandate(sessionId, next, { softPrompt: soft, force: true });
  } catch {
    /* */
  }
  return s;
}

/**
 * Mid-run interjections are steering unless the armed mandate is still the
 * auto-arm placeholder — then the first real work-order IS the mandate.
 */
export function maybeAdoptMandateFromUserTexts(
  sessionId: string,
  texts: string[],
  opts?: { cwd?: string },
): UlwCycleState | null {
  const s = loadUlwCycle(sessionId);
  if (!s?.enabled || !isPlaceholderMandate(s.mandate)) return s;
  for (const t of texts) {
    if (isArmableMandate(t)) {
      return adoptUlwMandate(sessionId, t, opts) || s;
    }
  }
  return s;
}

/**
 * Stuck-wall / /ulw-off leave a disabled sidecar. "continue" must resume that
 * mandate, not re-arm a new cycle named "continue".
 */
export function reenableUlwCycle(sessionId: string): UlwCycleState | null {
  const s = loadUlwCycle(sessionId);
  if (!s) return null;
  if (s.enabled) return s;
  if (isPlaceholderMandate(s.mandate)) return null;
  s.enabled = true;
  s.cycle = 1;
  s.stuckBlocks = 0;
  s.soulNudgeDone = false;
  clearSameSurfaceHold(s);
  clearUlwWrap(s);
  saveUlwCycle(s);
  return s;
}

export function setCycleFlag(
  sessionId: string,
  cycle: CycleFlag,
  opts?: { lastReason?: UlwLastReason },
): UlwCycleState | null {
  const s = loadUlwCycle(sessionId);
  if (!s) return null;
  if (!s.enabled) {
    // Stuck-wall / /ulw-off / Cycle complete leave a sidecar. /cycle 1
    // must resume THAT mandate — auto-arm used to reset wave=0 and steal
    // lastUserText ("continue", a kickoff, or an older task).
    if (cycle !== 1) return null;
    s.enabled = true;
  }
  s.cycle = cycle;
  if (cycle === 1) {
    s.stuckBlocks = 0;
    s.soulNudgeDone = false;
    clearSameSurfaceHold(s);
    s.sameSurfaceStreak = 0;
    clearUlwWrap(s);
    if (s.cycleZeroStopAt != null) {
      if (normalizeMaxWaves(s.maxWaves) === s.cycleZeroStopAt) {
        s.maxWaves = null;
      }
      s.cycleZeroStopAt = undefined;
    }
  } else {
    snapshotUlwWrap(s, opts?.lastReason ?? "user");
  }
  saveUlwCycle(s);
  return s;
}

/**
 * User-facing current wave for `/cycle 0`.
 * HUD `w=N` is last *stamped* unit. Mid-wave work is N+1.
 */
export function cycleZeroCurrentWave(
  s: Pick<
    UlwCycleState,
    "wave" | "lastProgressEditCount" | "lastBlockEditCount"
  >,
  opts?: { editCount?: number; dirty?: boolean },
): number {
  const baseline = s.lastProgressEditCount ?? s.lastBlockEditCount ?? 0;
  const edits = opts?.editCount ?? 0;
  const open = edits > baseline || opts?.dirty === true;
  return open ? s.wave + 1 : s.wave;
}

/**
 * `/cycle 0` at wave N stops at wave N+1.
 * Mid-wave (edits since last stamp or dirty tree): N is the in-progress unit.
 */
export function cycleZeroTargetWave(
  s: Pick<
    UlwCycleState,
    "wave" | "lastProgressEditCount" | "lastBlockEditCount" | "maxWaves"
  >,
  opts?: { editCount?: number; dirty?: boolean },
): number {
  const current = cycleZeroCurrentWave(s, opts);
  const target = Math.max(1, current + 1);
  const existing = normalizeMaxWaves(s.maxWaves);
  if (existing != null) return Math.min(existing, target);
  return target;
}

/**
 * User `/cycle 0`: stay CONTINUE, set maxWaves so the run stops at N+1.
 * Finish the open wave, ship one more, then budget LAST. `/ulw-off` aborts.
 * `/done` and safety valves still call `setCycleFlag(0)` for immediate LAST.
 */
export function scheduleCycleZeroStop(
  sessionId: string,
  opts?: { editCount?: number; dirty?: boolean },
): UlwCycleState | null {
  const s = loadUlwCycle(sessionId);
  if (!s) return null;
  if (!s.enabled) {
    if (isPlaceholderMandate(s.mandate)) return null;
    s.enabled = true;
  }
  if (s.cycle === 0 && s.wrapKind) {
    saveUlwCycle(s);
    return s;
  }
  const stopAt = cycleZeroTargetWave(s, opts);
  s.maxWaves = stopAt;
  s.cycleZeroStopAt = stopAt;
  s.cycle = 1;
  s.stuckBlocks = 0;
  clearSameSurfaceHold(s);
  clearUlwWrap(s);
  if (s.wave >= stopAt) {
    flipUlwToLast(s, sessionId, "budget");
  }
  saveUlwCycle(s);
  return s;
}

/**
 * When a safety valve releases the agent under ULW cycle=1 (CONTINUE), flip to
 * cycle=0 (LAST) so the next continue/resume is not stuck re-blocking forever.
 * Used for spend cap (hitCostCap) and turn cap (hitMaxTurns).
 * No-op when ULW is off or already LAST. Returns the new state when flipped.
 */
/**
 * Whether a harness Stop-block should trip the process continue-cap.
 *
 * Unlimited ULW (`cycle=1`, no max_waves) *is* Stop-block + continue.
 * Counting those toward FORGE_ULW_MAX_CONTINUES (default 200) is a hidden
 * wave cap — maze log10 died at continue #201 without /cycle 0.
 * Length/empty provider loops still use the shared counter.
 * Capped ULW and LAST wrap still fuse.
 */
export function stopBlockTripsContinueCap(
  s: Pick<UlwCycleState, "enabled" | "cycle" | "maxWaves"> | null | undefined,
): boolean {
  if (!s?.enabled) return true;
  if (s.cycle !== 1) return true;
  return normalizeMaxWaves(s.maxWaves) != null;
}

/**
 * Length / empty / content_filter fuse. Independent of the Stop-block tally
 * so 200 unlimited waves do not make the next truncated completion trip
 * continue_cap without /cycle 0.
 */
export function providerFuseTripsContinueCap(
  providerContinues: number,
  maxStopContinues: number,
): boolean {
  if (!Number.isFinite(providerContinues) || !Number.isFinite(maxStopContinues)) {
    return false;
  }
  if (maxStopContinues <= 0) return false;
  return providerContinues > maxStopContinues;
}

export function maybeFlipUlwToLastOnSafetyValve(
  sessionId: string,
): UlwCycleState | null {
  const s = loadUlwCycle(sessionId);
  if (!s?.enabled || s.cycle !== 1) return null;
  const next = setCycleFlag(sessionId, 0, { lastReason: "budget" });
  // Wind-down parity with /cycle 0 / /done: drop soft TodoGate once-blocks so
  // leftover open todos do not fight the safety-valve release path.
  try {
    clearSoftTodoGateOnWindDown(sessionId);
  } catch {
    /* */
  }
  return next;
}

/** @deprecated Use maybeFlipUlwToLastOnSafetyValve — alias kept for callers/tests. */
export const maybeFlipUlwToLastOnCostCap = maybeFlipUlwToLastOnSafetyValve;

/**
 * Set or clear the optional max_waves cap for an armed ULW session.
 * Pass `null` to remove the cap (unlimited). Values &lt; 1 clear the cap.
 * Returns null when ULW is not armed.
 */
export function setMaxWaves(
  sessionId: string,
  maxWaves: number | null,
): UlwCycleState | null {
  const s = loadUlwCycle(sessionId);
  if (!s) return null;
  if (!s.enabled) {
    s.enabled = true;
    s.cycle = 1;
    s.stuckBlocks = 0;
  }
  s.maxWaves = normalizeMaxWaves(maxWaves);
  s.cycleZeroStopAt = undefined;
  // If the cap is already at/under the current wave counter while CONTINUE,
  // flip to LAST immediately so the user does not wait for the next Stop
  // evaluation (and clear soft TodoGate for wind-down parity).
  const cap = normalizeMaxWaves(s.maxWaves);
  if (cap != null && s.cycle === 1 && s.wave >= cap) {
    flipUlwToLast(s, sessionId);
  }
  saveUlwCycle(s);
  return s;
}

/**
 * Copy ULW cycle state onto a forked session id (expert branch keeps the driver).
 * No-op when source has no armed/persisted state.
 */
export function copyUlwCycle(fromId: string, toId: string): UlwCycleState | null {
  if (!fromId || !toId || fromId === toId) return null;
  const src = loadUlwCycle(fromId);
  if (!src) return null;
  const next: UlwCycleState = {
    ...src,
    sessionId: toId,
    // Fresh stuck/quality counters on the branch — progress is independent.
    // Clone the ledger so the two sessions never share a mutable array.
    waves: [...(src.waves ?? [])],
    namedShips: src.namedShips?.map((x) => ({ ...x })),
    wrapItems: src.wrapItems?.map((x) => ({ ...x })),
    stuckBlocks: 0,
    lastBlockEditCount: 0,
    thinStreak: 0,
    polishStreak: 0,
    proofDemands: 0,
    evidenceNudges: 0,
    soulNudgeDone: false,
    updatedAt: nowIso(),
  };
  saveUlwCycle(next);
  return next;
}

export function disarmUlwCycle(sessionId: string): void {
  const s = loadUlwCycle(sessionId);
  if (!s) return;
  s.enabled = false;
  s.cycle = 0;
  saveUlwCycle(s);
}

/**
 * /clear wipes the transcript but used to keep the old mandate + wave
 * ledger. The next typed sentence was then steering on leftover chrome.
 * Keep cycle/maxWaves/enabled; the next real work-order is adopted.
 */
export function resetUlwOnClear(sessionId: string): UlwCycleState | null {
  const s = loadUlwCycle(sessionId);
  if (!s) return null;
  s.lastBlockEditCount = 0;
  s.stuckBlocks = 0;
  s.lastProgressEditCount = undefined;
  s.lastWaveSig = undefined;
  s.lastOpenTodoCount = undefined;
  s.lastDiffFp = undefined;
  s.seenDiffFps = [];
  s.wave = 0;
  s.blocks = 0;
  s.waves = [];
  s.thinStreak = 0;
  s.polishStreak = 0;
  s.sameSurfaceStreak = 0;
  s.sameSurfaceHold = false;
  s.sameSurfaceAdmitCount = 0;
  s.exploreRequired = false;
  s.exploreRequiredAt = undefined;
  s.playLoopPending = false;
  s.proofDemands = 0;
  s.evidenceNudges = 0;
  s.judgmentDemands = 0;
  s.namedShips = [];
  s.namedShipAdmitDone = false;
  s.namedShipAdmitCount = 0;
  s.wrapItems = [];
  s.wrapKind = undefined;
  s.wrapFrozenAt = undefined;
  s.wrapNudgeDone = false;
  s.soulNudgeDone = false;
  s.cycleZeroStopAt = undefined;
  if (s.enabled) {
    s.mandate = PLACEHOLDER_MANDATE;
    s.expandedMandate = "";
    s.softPrompt = true;
    s.backlogRequired = false;
    s.judgmentRequired = false;
  }
  saveUlwCycle(s);
  return s;
}

/**
 * Compact counters for HUD / logs: `cycle=1 wave=3 blocks=5` or `wave=3/5` when capped.
 * Wave increments each time the driver re-anchors Stop while cycle=1 (or max-waves LAST).
 */
export function formatUlwCounts(
  s: Pick<UlwCycleState, "cycle" | "wave" | "blocks"> &
    Partial<Pick<UlwCycleState, "maxWaves">>,
): string {
  const cap = normalizeMaxWaves(s.maxWaves);
  const wavePart = cap != null ? `wave=${s.wave}/${cap}` : `wave=${s.wave}`;
  return `cycle=${s.cycle} ${wavePart} blocks=${s.blocks}`;
}

/** One-line badge for prompt flags / footers: `c=1 w=3 b=5` or `w=3/5`. */
export function formatUlwBadge(
  s: Pick<UlwCycleState, "cycle" | "wave" | "blocks"> &
    Partial<Pick<UlwCycleState, "maxWaves">>,
): string {
  const cap = normalizeMaxWaves(s.maxWaves);
  const parts = [`c=${s.cycle}`, cap != null ? `w=${s.wave}/${cap}` : `w=${s.wave}`];
  if (s.blocks > 0) parts.push(`b=${s.blocks}`);
  return parts.join(" ");
}

/**
 * Shown to humans during ULW turns (stop re-anchor logs, kickoff, status).
 * Mirrors live mid-run slash policy in the REPL.
 */
export const ULW_LIVE_CONTROLS_HINT =
  "Live mid-run (type while working — no Ctrl+C): /cycle 0 stop@N+1 · /cycle 1 continue · /max-waves N|off · /ulw-off disarm · /budget N|off · /notify on · /done";

function formatSameSurfaceStatusLine(s: UlwCycleState): string | undefined {
  const streak = s.sameSurfaceStreak ?? 0;
  if (exploreHolding(s)) {
    return `  Explore: required — spawn one explore child (what did we abandon?) or /cycle 0`;
  }
  if (contractHolding(s) && !sameSurfaceHolding(s)) {
    return `  Explore-map: hold — ship or retire a pick (${s.offContractStreak ?? 0} off-contract) or /cycle 0`;
  }
  if (sameSurfaceHolding(s)) {
    return `  Same surface: hold — new Reading on a different class or /cycle 0 (stuck-wall will not release)`;
  }
  if (streak >= SAME_SURFACE_ADVISORY) {
    return `  Same surface: ${streak} in a row — next ship must be a different surface (or /cycle 0)`;
  }
  return undefined;
}

function formatProductQualityStatusLine(s: UlwCycleState): string | undefined {
  if (!isUserFacingProductWork(s.mandate)) return undefined;
  const bits = ["on"];
  if (s.sessionId) {
    try {
      if (hasStoredJobInsight(s.sessionId)) bits.push("job named");
      if (hasStoredProductEdge(s.sessionId)) bits.push("edge in product");
    } catch {
      /* status is best-effort */
    }
  }
  if (s.soulNudgeDone) bits.push("bounced once");
  return `  Product quality: ${bits.join(" · ")}`;
}

/** Leftovers to print when a process fuse releases — not Cycle complete. */
export function formatUlwFuseLeftovers(s: UlwCycleState | null): string {
  if (!s?.enabled) return "";
  const named = (s.namedShips ?? []).filter((x) => x.status === "open");
  const wrap = (s.wrapItems ?? []).filter((x) => x.status === "open");
  const lines: string[] = [];
  if (named.length) {
    lines.push(
      `Open named ships: ${named.map((x) => x.text).slice(0, 8).join(" · ")}`,
    );
  }
  if (wrap.length) {
    lines.push(
      `Open wrap items: ${wrap.map((x) => x.text).slice(0, 8).join(" · ")}`,
    );
  }
  if (s.exploreRequired) {
    lines.push("Mid-run explore was still required.");
  }
  if (!lines.length) return "";
  return `Leftovers (not Cycle complete.): ${lines.join(" ")}`;
}

function formatNamedShipsStatusLine(s: UlwCycleState): string | undefined {
  const items = s.namedShips ?? [];
  if (!items.length) return undefined;
  const done = items.filter((x) => x.status === "done").length;
  const bits = items.map((x) =>
    x.status === "done" ? `${x.text} ✓` : x.text,
  );
  let body = bits.join(" · ");
  if (body.length > 160) body = `${body.slice(0, 159)}…`;
  const asked = s.namedShipAdmitDone
    ? normalizeMaxWaves(s.maxWaves) == null
      ? " · hold: new Reading or /cycle 0 (stuck-wall will not release)"
      : " · asked for new reading"
    : "";
  return `  Named ships: ${done}/${items.length} done — ${body}${asked}`;
}

export function formatUlwStatus(s: UlwCycleState | null): string {
  if (!s || !s.enabled) {
    return [
      "ULW cycle: OFF",
      "  Arm with: /ulw <task>   or   /ulw improve the code",
      "  Cycle flag: set with /cycle 1 (continue) or /cycle 0 (finish this wave + one more, then stop)",
      "  Wave cap:   /max-waves N  (optional; default unlimited) · /max-waves off",
      `  ${ULW_LIVE_CONTROLS_HINT}`,
    ].join("\n");
  }
  const cap = normalizeMaxWaves(s.maxWaves);
  const ledger = formatWaveLedger(s.waves);
  const best = bestWave(s.waves);
  const namedLine = formatNamedShipsStatusLine(s);
  const qualityLine = formatProductQualityStatusLine(s);
  return [
    `ULW cycle: ON  |  ${formatUlwCounts(s)}  ${s.cycle === 1 ? "(CONTINUE — relentless)" : "(LAST — wrap then attest)"}`,
    `  Mandate: ${displayUlwMandate(s.mandate)}`,
    `  Soft prompt expanded: ${s.softPrompt ? "yes" : "no"}`,
    `  max_waves: ${cap != null ? cap : "off (unlimited)"}${
      s.cycleZeroStopAt != null
        ? `  · /cycle 0 stop at wave ${s.cycleZeroStopAt}`
        : ""
    }`,
    ...(namedLine ? [namedLine] : []),
    ...(qualityLine ? [qualityLine] : []),
    ...(formatSameSurfaceStatusLine(s) ? [formatSameSurfaceStatusLine(s)!] : []),
    ...(s.wrapKind
      ? [
          s.wrapKind === "user"
            ? `  LAST wrap: user — in-flight wave + ${openNamedWrapItems(s).length} open named item(s)`
            : "  LAST wrap: budget — this wave only",
        ]
      : []),
    ...(ledger ? [`  Recent waves: ${ledger}`] : []),
    ...(best
      ? [
          `  Best wave (the bar to match/beat): w${best.wave} (+${best.editDelta} edits, proof ${best.proof ? "✓" : "✗"})`,
        ]
      : []),
    ...((s.thinStreak ?? 0) >= THIN_ADVISORY_STREAK
      ? [
          `  ⚠ Diminishing returns: ${s.thinStreak} thin waves in a row — consider /cycle 0`,
        ]
      : []),
    `  ${ULW_LIVE_CONTROLS_HINT}`,
    `  User controls:`,
    `    /cycle 1       — keep looping waves (until max_waves / stuck-wall / you stop)`,
    `    /cycle 0       — finish this wave + one more (stop at N+1), then LAST`,
    `    /max-waves N   — cap waves (auto LAST when wave hits N); /max-waves off clears`,
    `    /ulw-off       — disarm immediately`,
    `  Agent attestation when cycle=0 and wave done: **Cycle complete.**`,
  ].join("\n");
}

/**
 * Stop evaluation for ULW cycle driver.
 *
 * Quality mechanisms (research-backed, facts only — no invented scores):
 * - Wave ledger: each wave boundary records edit delta + whether verification
 *   actually ran (structural signal from the loop) or was cited.
 * - Quality bar: the re-anchor anchors to the best factual wave and forbids
 *   filler waves — the bar is maintained or raised, never quietly lowered.
 * - Proof demand: a wave with no verification triggers a demand to run the
 *   check NOW (capped; a stated rationale is accepted afterwards).
 * - Thin-wave escalation + diminishing-returns advisory (user-visible).
 * - Attestation evidence: cycle=0 "**Cycle complete.**" without machine-
 *   checkable evidence is bounced once, then released (never an infinite trap).
 * - Product quality: user-facing product ships name the hard job, finish one
 *   edge after wave 1, and keep at most one labeled Serendipity:. Bounce once.
 */
export function evaluateUlwAtStop(opts: {
  sessionId: string;
  lastAssistantMessage: string;
  editCount: number;
  openTodoCount: number;
  stuckThreshold: number;
  /** True when a verification command (test/typecheck/lint/build) ran this wave */
  verificationRan?: boolean;
  /**
   * Successful structural check only. Attestation evidence requires this so a
   * red `npm test` cannot unlock **Cycle complete.** / **Goal achieved.**
   * Wave ledger proof still uses verificationRan (execution).
   */
  verificationPassed?: boolean;
  preferredCheckCommands?: string[];
  /**
   * Working-tree diff fingerprint (gitDiffFingerprint) for net-diff progress
   * tracking: bash-channel edits count as progress, edit→revert churn counts
   * as thin. Null/undefined outside git — falls back to editCount-only.
   */
  diffFingerprint?: string | null;
}): UlwStopDecision {
  const s = loadUlwCycle(opts.sessionId);
  if (!s || !s.enabled) return { block: false };
  if (s.cycle === 0) ensureUlwWrap(s);

  const msg = opts.lastAssistantMessage || "";
  const cycleCompleteClaim = LAST_CYCLE_ATTEST_RE.test(msg);
  const attested = s.cycle === 0 && cycleCompleteClaim;
  const attestationHasEvidence =
    !attested ||
    hasAttestationEvidence(
      msg,
      opts.verificationPassed ?? opts.verificationRan,
    );
  // Edit delta since the previous Stop evaluation (wave boundary). Captured
  // before lastBlockEditCount is updated below.
  const editDelta = Math.max(0, opts.editCount - s.lastBlockEditCount);

  // Net-diff tracking: fingerprint the working tree at each boundary.
  // diffChanged = the tree's diff state moved (progress from ANY channel,
  // including bash); diffRevisit = it moved back to a previously seen state
  // (edit→revert churn). First git-backed evaluation only sets the baseline.
  const fp = opts.diffFingerprint ?? null;
  const { diffChanged, diffRevisit, firstObservation } = applyDiffFingerprint(
    s,
    fp,
  );

  // cycle=0 + attestation with evidence (or evidence already demanded once) → release
  if (
    attested &&
    (attestationHasEvidence || (s.evidenceNudges ?? 0) >= MAX_EVIDENCE_NUDGES)
  ) {
    markNamedShipDone(s, msg);
    const namedOpen = openNamedWrapItems(s);
    if (namedOpen.length > 0 && !s.wrapNudgeDone) {
      s.wrapNudgeDone = true;
      saveUlwCycle(s);
      const reanchor = [
        `[Forge ULW cycle driver] Stop blocked — wrap the named plan before **Cycle complete.**`,
        formatWrapCard(s),
        `Still open:`,
        ...namedOpen.map((n) => `  · ${n.text}`),
        `Ship or cancel each item (with reason), then re-attest **Cycle complete.** with evidence.`,
      ].join("\n");
      return {
        block: true,
        reason: reanchor,
        reanchor,
        wrapDemanded: true,
      };
    }
    if (userWrapWaveUnfinished(s, opts, msg) && !s.wrapNudgeDone) {
      s.wrapNudgeDone = true;
      saveUlwCycle(s);
      const reanchor = [
        `[Forge ULW cycle driver] Stop blocked — wrap the open wave before **Cycle complete.**`,
        formatWrapCard(s),
        `In-flight work is still open (dirty tree or no green check this wrap).`,
        `Ship, revert, or note the tree is clean, then re-attest **Cycle complete.** with evidence.`,
      ].join("\n");
      return {
        block: true,
        reason: reanchor,
        reanchor,
        wrapDemanded: true,
      };
    }
    markOpenWaveWrapDone(s);
    s.enabled = false;
    saveUlwCycle(s);
    return {
      block: false,
      lastCycleReleased: true,
      reason: "ULW last cycle attested complete — released.",
    };
  }

  // cycle=1 + **Cycle complete.** is a declared ship, not a release.
  // /max-waves N is a budget the user asked to spend. Fall through: stamp
  // the unit, auto-LAST only when w hits the cap, then Cycle complete on
  // cycle=0 can release. Yield ("shall I continue?") stays handoff-blocked.

  // Progress / stuck tracking: editCount delta OR working-tree diff movement
  // (bash heredocs/sed move the tree without touching edit-tool counters).
  const progressed = opts.editCount > s.lastBlockEditCount || diffChanged;
  // Unlimited named-ship exhaust is "write a new Reading or /cycle 0" —
  // those Stops are the harness holding, not a dead agent. Maze dogfood
  // Cycle-complete ×3 punched through stuck-wall without the user wrapping.
  const namedExhaustHolding =
    s.cycle === 1 &&
    !s.wrapKind &&
    normalizeMaxWaves(s.maxWaves) == null &&
    namedShipsExhausted(s);
  const exhaustHolding =
    namedExhaustHolding || sameSurfaceHolding(s) || contractHolding(s);
  if (progressed) {
    s.stuckBlocks = 0;
  } else if (!exhaustHolding) {
    s.stuckBlocks += 1;
  }
  s.blocks += 1;
  s.lastBlockEditCount = opts.editCount;

  if (
    !exhaustHolding &&
    opts.stuckThreshold > 0 &&
    s.stuckBlocks >= opts.stuckThreshold
  ) {
    s.enabled = false;
    s.cycle = 0;
    saveUlwCycle(s);
    try {
      maybeDesktopNotify({
        title: "Forge · ULW stuck-wall",
        body: "Cycle released after no file edits or working-tree changes.",
      });
    } catch {
      /* */
    }
    // Wind-down: drop soft TodoGate once-blocks so stuck release is clean.
    try {
      clearSoftTodoGateOnWindDown(opts.sessionId);
    } catch {
      /* */
    }
    return {
      block: false,
      stuckReleased: true,
      reason: `ULW stuck-wall: ${s.stuckBlocks} consecutive Stop attempts with no file edits or working-tree changes. Cycle released. Re-arm with /ulw or /cycle 1.`,
    };
  }

  // cycle=0 weak attestation → bounce once, demanding machine-checkable evidence.
  // Anti-gaming: structural (the only way out is running a real check or a
  // second attestation), capped so it can never become an infinite trap.
  if (attested && !attestationHasEvidence) {
    s.evidenceNudges = (s.evidenceNudges ?? 0) + 1;
    saveUlwCycle(s);
    const reanchor = [
      `[Forge ULW cycle driver] Stop blocked — attestation needs evidence.`,
      `Your **Cycle complete.** claim cites no machine-checkable evidence: no ✅/❌ checklist, no command result, and no verification command ran this wave.`,
      `Run the cheapest relevant check NOW (tests / typecheck / build), then re-attest **Cycle complete.** with:`,
      `- ✅/❌ per shipped item`,
      `- the command + its result for each ✓`,
      `Claims without evidence do not close the cycle.`,
    ].join("\n");
    return { block: true, reason: reanchor, reanchor, evidenceDemanded: true };
  }

  if (s.cycle === 1) {
    const cap = normalizeMaxWaves(s.maxWaves);
    // Phase 2: broad/soft mandate must have a todo backlog before inventing.
    if (
      s.backlogRequired &&
      opts.openTodoCount < 2 &&
      s.wave === 0
    ) {
      s.blocks += 1;
      saveUlwCycle(s);
      const reanchor = [
        `[Forge ULW cycle driver] Stop blocked — backlog required before Wave 1 invents scope.`,
        `Mandate is broad/soft. Decompose it into an ordered todo board (≥2 items) via todo_write covering the mandate sections, then execute the top item.`,
        `Mandate: ${displayUlwMandate(s.mandate)}`,
        `Durable decisions: /memory · decisions.json — do not re-derive the mandate.`,
        `Do not free-invent waves until the backlog exists. ${ULW_LIVE_CONTROLS_HINT}`,
      ].join("\n");
      return { block: true, reason: reanchor, reanchor };
    }
    if (s.backlogRequired && opts.openTodoCount >= 2) {
      s.backlogRequired = false;
    }

    // Evaluate-class: do not leave wave 0 without a written reading.
    // Capped so it can never become an infinite trap.
    if (
      s.judgmentRequired &&
      s.wave === 0 &&
      !hasMandateJudgment(opts.sessionId, msg) &&
      (s.judgmentDemands ?? 0) < MAX_JUDGMENT_DEMANDS
    ) {
      s.judgmentDemands = (s.judgmentDemands ?? 0) + 1;
      saveUlwCycle(s);
      const reanchor = [
        `[Forge ULW cycle driver] Stop blocked — evaluate-class mandate needs a written reading before Wave 1 closes.`,
        `Mandate: ${displayUlwMandate(s.mandate)}`,
        `Write the reading NOW (what the hard work is, what you passed on, the ONE item you will ship). memory_write it, or start the reply with \`Reading:\`.`,
        `That is the first verb of the mandate — not advice, not optional. Then execute the item.`,
        ULW_LIVE_CONTROLS_HINT,
      ].join("\n");
      return { block: true, reason: reanchor, reanchor };
    }
    if (s.judgmentRequired && hasMandateJudgment(opts.sessionId, msg)) {
      s.judgmentRequired = false;
      s.phase = "ship";
    }
    const adoptedNamed = maybeAdoptNamedShips(s, msg);

    // Already at/over cap (e.g. user lowered max_waves mid-run) → force LAST now.
    if (cap != null && s.wave >= cap) {
      flipUlwToLast(s, opts.sessionId, "budget");
      saveUlwCycle(s);
      const reanchor = buildCycleReanchor(s, {
        openTodos: opts.openTodoCount,
        mode: "last",
        maxWavesHit: true,
        preferredCheckCommands: opts.preferredCheckCommands,
      });
      return {
        block: true,
        reason: reanchor,
        reanchor,
        maxWavesHit: true,
      };
    }
    const sig = waveProgressSig(opts.editCount, fp);
    const alreadyStamped = Boolean(s.lastWaveSig && s.lastWaveSig === sig);
    const proof = detectWaveProof(
      msg,
      opts.verificationPassed ?? opts.verificationRan,
    );
    const netDiff = classifyNetDiff(
      fp,
      diffChanged,
      diffRevisit,
      firstObservation,
      editDelta,
    );
    const prevOpen =
      s.lastOpenTodoCount != null ? s.lastOpenTodoCount : opts.openTodoCount;
    const todoProgress = Math.max(0, prevOpen - opts.openTodoCount);
    s.lastOpenTodoCount = opts.openTodoCount;
    const closer = closerText(opts.sessionId, msg);
    if (
      s.cycle === 1 &&
      !s.wrapKind &&
      !s.soulNudgeDone &&
      isUserFacingProductWork(s.mandate) &&
      (isDeclaredWaveClose(closer) || cycleCompleteClaim)
    ) {
      try {
        harvestProductQualityNotes(opts.sessionId, closer);
        harvestStoredProductQuality(opts.sessionId);
      } catch {
        /* ledger is best-effort */
      }
      let quality: ProductQualityResult;
      try {
        quality = evaluateProductQuality({
          closer,
          sessionId: opts.sessionId,
          wave: s.wave,
          isLeftoverChrome: isLeftoverChromeShip,
        });
      } catch {
        quality = { ok: true, missing: [] };
      }
      if (!quality.ok) {
        s.soulNudgeDone = true;
        saveUlwCycle(s);
        const reanchor = formatProductQualityReanchor(quality.missing);
        return {
          block: true,
          reason: reanchor,
          reanchor,
          soulDemanded: true,
        };
      }
    }
    // Mid-run explore first — a Mad-Lib Reading is not a look.
    if (exploreHolding(s) && !adoptedNamed) {
      saveUlwCycle(s);
      const admit = holdAdmit(opts.sessionId, EXPLORE_REQUIRED_ADMIT);
      return {
        block: true,
        reason: admit,
        reanchor: admit,
        sameSurfaceDemanded: true,
      };
    }
    // Do not use parse(closer) here — later replies often reprint the
    // original Reading, which would skip the gate forever.
    if (cap == null && namedShipsExhausted(s) && !adoptedNamed) {
      // Stay blocked until a different-surface reading is adopted or
      // /cycle 0. Cycle complete / leftover chrome do not stamp. A real
      // declared ship with edits still increments w (maze 43–46 were invisible).
      const millSibling = isMillSiblingCloser(s, closer);
      const shipAfterExhaust =
        !alreadyStamped &&
        isShipCloseText(closer) &&
        editDelta >= 1 &&
        !isLeftoverChromeShip(closer) &&
        !millSibling;
      if (shipAfterExhaust) {
        appendWaveRecord(s, {
          sessionId: opts.sessionId,
          editDelta,
          netDiff,
          proof,
          todoProgress,
          summary: summarizeWave(closer, opts.sessionId),
          classText: closer,
          themed:
            isDeclaredWaveClose(closer) || isLeftoverSiblingShip(closer),
        });
        markNamedShipDone(s, closer);
        s.lastWaveSig = sig;
        s.lastProgressEditCount = opts.editCount;
        const polish = notePolishShip(s, closer);
        if (polish >= POLISH_LAST_STREAK && s.cycle === 1) {
          flipUlwToLast(s, opts.sessionId);
          saveUlwCycle(s);
          const reanchor = buildCycleReanchor(s, {
            openTodos: opts.openTodoCount,
            mode: "last",
            preferredCheckCommands: opts.preferredCheckCommands,
          });
          return {
            block: true,
            reason: reanchor,
            reanchor,
            waveClosed: true,
          };
        }
      }
      s.namedShipAdmitCount = (s.namedShipAdmitCount ?? 0) + 1;
      s.namedShipAdmitDone = true;
      const glanceable =
        (s.waves ?? []).slice(-3).filter((w) => isLeftoverChromeShip(w.summary))
          .length >= 2 || isLeftoverChromeShip(closer);
      const strong =
        (s.namedShipAdmitCount ?? 0) >= MAX_NAMED_SHIP_ADMITS ||
        glanceable ||
        s.namedShipAdmitCount > 1;
      const admit = holdAdmit(
        opts.sessionId,
        strong ? NAMED_SHIP_EXHAUSTED_STRONG : NAMED_SHIP_EXHAUSTED_ADMIT,
      );
      saveUlwCycle(s);
      return {
        block: true,
        reason: admit,
        reanchor: admit,
        waveClosed: shipAfterExhaust,
      };
    }
    if (sameSurfaceHolding(s) && !adoptedNamed) {
      const differentSurface =
        isShipCloseText(closer) &&
        editDelta >= 1 &&
        !isLeftoverChromeShip(closer) &&
        !isMillSiblingCloser(s, closer);
      if (!differentSurface || alreadyStamped) {
        s.sameSurfaceAdmitCount = (s.sameSurfaceAdmitCount ?? 0) + 1;
        s.sameSurfaceHold = true;
        saveUlwCycle(s);
        const admit = holdAdmit(opts.sessionId, SAME_SURFACE_HOLD_ADMIT);
        return {
          block: true,
          reason: admit,
          reanchor: admit,
          sameSurfaceDemanded: true,
        };
      }
    }
    if (
      contractHolding(s) &&
      !adoptedNamed &&
      !isOnExploreContract(closer, loadExploreMapPicks(opts.sessionId))
    ) {
      s.contractHold = true;
      saveUlwCycle(s);
      const admit = holdAdmit(opts.sessionId, CONTRACT_HOLD_ADMIT);
      return {
        block: true,
        reason: admit,
        reanchor: admit,
        sameSurfaceDemanded: true,
      };
    }
    if (!alreadyStamped) {
      appendWaveRecord(s, {
        sessionId: opts.sessionId,
        editDelta,
        netDiff,
        proof,
        todoProgress,
        summary: summarizeWave(closer, opts.sessionId),
        classText: closer,
        themed:
          isDeclaredWaveClose(closer) || isLeftoverSiblingShip(closer),
      });
      markNamedShipDone(s, closer);
      s.lastWaveSig = sig;
      s.lastProgressEditCount = opts.editCount;
      const polish = notePolishShip(s, closer);
      if (polish >= POLISH_LAST_STREAK && s.cycle === 1) {
        flipUlwToLast(s, opts.sessionId);
      }
    }
    const proofMissing = !proof && (s.proofDemands ?? 0) < MAX_PROOF_DEMANDS;
    if (!alreadyStamped && proofMissing) {
      s.proofDemands = (s.proofDemands ?? 0) + 1;
    }
    const thinStreak = s.thinStreak ?? 0;
    const qualityFlags = {
      proofDemanded: proofMissing,
      thinStreakAdvisory: thinStreak >= THIN_ADVISORY_STREAK,
    };

    // Cap hit on this increment: this wave is the last — force LAST re-anchor.
    if (cap != null && s.wave >= cap) {
      flipUlwToLast(s, opts.sessionId, "budget");
      saveUlwCycle(s);
      const reanchor = buildCycleReanchor(s, {
        openTodos: opts.openTodoCount,
        mode: "last",
        maxWavesHit: true,
        preferredCheckCommands: opts.preferredCheckCommands,
      });
      return {
        block: true,
        reason: reanchor,
        reanchor,
        maxWavesHit: true,
        waveClosed: !alreadyStamped,
        ...qualityFlags,
      };
    }

    saveUlwCycle(s);
    const reanchor = buildCycleReanchor(s, {
      openTodos: opts.openTodoCount,
      mode: "continue",
      proofMissing,
      verificationFailed: Boolean(
        proofMissing &&
          opts.verificationRan &&
          !opts.verificationPassed,
      ),
      consolidation: s.wave % CONSOLIDATION_EVERY === 0,
      thinStreak,
      preferredCheckCommands: opts.preferredCheckCommands,
      prematureCycleComplete: cycleCompleteClaim,
    });
    return {
      block: true,
      reason: reanchor,
      reanchor,
      waveClosed: !alreadyStamped,
      ...qualityFlags,
    };
  }

  // cycle === 0: wrap the frozen list, then attest (no new ambitious wave).
  markNamedShipDone(s, closerText(opts.sessionId, msg));
  saveUlwCycle(s);
  const reanchor = buildCycleReanchor(s, {
    openTodos: opts.openTodoCount,
    mode: "last",
    preferredCheckCommands: opts.preferredCheckCommands,
  });
  return { block: true, reason: reanchor, reanchor };
}

/** Every Nth wave is a consolidation wave: review + harden, no new scope. */
const CONSOLIDATION_EVERY = 4;

function remainingWaveBudgetLine(s: UlwCycleState): string {
  const cap = normalizeMaxWaves(s.maxWaves);
  if (cap == null) {
    return "max_waves=off. CONTINUE until /cycle 0 (finish this wave + one more, then LAST). **Cycle complete.** is refused while cycle=1.";
  }
  const left = Math.max(0, cap - s.wave);
  if (s.cycleZeroStopAt != null) {
    return (
      `User set /cycle 0 — finish the open wave, ship one more, LAST at wave=${cap}. ` +
      `${left} wave(s) remain after w=${s.wave}. ` +
      `**Cycle complete.** is refused until then. Do not wrap early.`
    );
  }
  return (
    `User set max_waves=${cap}. ${left} wave(s) remain after w=${s.wave}. ` +
    `Spend them on the next highest-leverage ship (different surface). ` +
    `**Cycle complete.** is refused until the cap (or /cycle 0). ` +
    `Do not invent leftover chrome.`
  );
}

function buildCycleReanchor(
  s: UlwCycleState,
  opts: {
    openTodos: number;
    mode: "continue" | "last";
    maxWavesHit?: boolean;
    proofMissing?: boolean;
    /** True when a check ran but failed (vs never ran). */
    verificationFailed?: boolean;
    consolidation?: boolean;
    thinStreak?: number;
    preferredCheckCommands?: string[];
    /** Model attested Cycle complete while cycle=1 and waves remain. */
    prematureCycleComplete?: boolean;
  },
): string {
  const cap = normalizeMaxWaves(s.maxWaves);
  // Mandate + last-wave line are enough. Full decisions.json used to be
  // re-dumped here AND in the following admit (3k × 171 rounds).
  const decisionsBlock = [
    `Durable decisions: /memory · decisions.json — do not re-derive the mandate.`,
  ];
  if (opts.mode === "continue") {
    const best = bestWave(s.waves);
    const lastEntry = s.waves?.length
      ? s.waves[s.waves.length - 1]
      : null;
    return [
      `[Forge ULW cycle driver] Stop blocked — ${formatUlwCounts(s)} (CONTINUE).`,
      opts.prematureCycleComplete
        ? `You attested **Cycle complete.** while cycle=1. That does not release. ${remainingWaveBudgetLine(s)}`
        : remainingWaveBudgetLine(s),
      `Mandate: ${displayUlwMandate(s.mandate)}`,
      ...decisionsBlock,
      `Wave ${s.wave} begins${cap != null ? ` (max ${cap})` : ""}. Protocol: research → plan → implement → verify → review (full cycle in system prompt).`,
      lastEntry
        ? `Last wave closed: +${lastEntry.editDelta} edits, proof ${lastEntry.proof ? "✓" : "✗"}${lastEntry.todoProgress != null ? `, todosΔ=${lastEntry.todoProgress}` : ""}.`
        : null,
      ``,
      `Wave rules:`,
      `1. SMOKE-CHECK first — run the cheapest existing check (tests/typecheck/build) to catch breakage from prior waves before adding scope.`,
      `2. ONE objective — prefer the next open todo (backlog) or highest-impact bounded item against the mandate/decisions; search before building.`,
      `3. Plan in 2 lines — objective + the exact command that proves it — then ship it and run that proof.`,
      best
        ? `Bar: best wave so far w${best.wave} (+${best.editDelta} edits${best.proof ? ", proof ✓" : ""}). Match or beat it — compound on shipped work; no filler waves (renames, comment-only churn, edit/revert loops).`
        : `Bar: these first waves set the standard — substantive change + real proof, every wave.`,
      opts.proofMissing
        ? (() => {
            const preferred = (opts.preferredCheckCommands || [])
              .map((c) => String(c || "").trim())
              .filter(Boolean)
              .slice(0, 3);
            const tip = preferred.length
              ? preferred.map((c) => `\`${c}\``).join(" · ")
              : "`npm test` / typecheck / project check";
            const why = opts.verificationFailed
              ? "Last wave's check failed (red) — fix the new file + one isolate; full suite at consolidation / LAST, not every wave"
              : "Last wave ran no successful verification — run proof NOW";
            return `⚠ ${why} before any new scope: ${tip}`;
          })()
        : null,
      opts.consolidation
        ? `CONSOLIDATION WAVE (every ${CONSOLIDATION_EVERY}th): no new scope — run the full check suite, then review the cumulative \`git diff\` as a hostile reviewer (regressions, weakened tests, leftover stubs). Fix real defects only.`
        : null,
      (opts.thinStreak ?? 0) >= 2
        ? `Waves are thinning (${opts.thinStreak} in a row with little substance). God-mode demand: pick a substantially higher-leverage hard objective (not churn) — or, if the hard work is genuinely exhausted, say so with evidence; the user can /cycle 0.`
        : null,
      (s.sameSurfaceStreak ?? 0) >= SAME_SURFACE_ADVISORY
        ? `Last ${s.sameSurfaceStreak} ships are the same surface. Next ship must be a different surface (trust, correctness, a new job) — or /cycle 0. Same-surface leftovers will not increment w.`
        : null,
      s.softPrompt
        ? `Soft signal still active — you own what the hard work is within the durable decisions above. Prefer backlog todos; never ask the user to clarify or pick tasks.`
        : null,
      s.backlogRequired
        ? `⚠ Backlog still required: todo_write ≥2 items covering mandate sections before free invent.`
        : null,
      opts.openTodos > 0
        ? `Open todos: ${opts.openTodos} — clear or complete them before claiming a wave done. Prefer ONE primary todo per wave.`
        : `No open todos — create a short wave plan via todo_write (or memory_write a decision that hard work is exhausted), then execute.`,
      `${ULW_LIVE_CONTROLS_HINT}`,
      `Do not stop. Do not ask permission to continue. Next tool calls now.`,
    ]
      .filter((line) => line != null)
      .join("\n");
  }

  const maxHitLine = opts.maxWavesHit
    ? `max_waves=${cap} reached at wave=${s.wave} — auto LAST (wrap this wave and attest; do not start a new ambitious wave).`
    : null;

  return [
    `[Forge ULW cycle driver] Stop blocked — ${formatUlwCounts(s)} (LAST CYCLE).`,
    `Mandate: ${displayUlwMandate(s.mandate)}`,
    ...decisionsBlock,
    `Wave: ${s.wave}${cap != null ? ` / max ${cap}` : ""} — LAST wrap, then attest.`,
    maxHitLine,
    formatWrapCard(s),
    ``,
    `Required before attestation:`,
    `1. Finish the wrap list (named items if user LAST; this wave if budget LAST). Cancel leftovers with reason.`,
    `2. Complete or cancel open todos and run the final check.`,
    `3. Review the cumulative diff (\`git diff\`) as a hostile reviewer: regressions, weakened tests, leftover stubs.`,
    `4. Attest exactly **Cycle complete.** with a ✅/❌ checklist — what shipped + evidence per item (command → result).`,
    `Attestations without machine-checkable evidence are bounced.`,
    ``,
    `Until you attest **Cycle complete.**, Stop remains blocked.`,
    `When you attest, Forge creates a local git commit of this wave's work (never pushed). FORGE_ULW_AUTO_COMMIT=0 to skip.`,
    opts.openTodos > 0
      ? `Still ${opts.openTodos} open todo(s) — close them or cancel with reason before LAST release.`
      : openNamedWrapItems(s).length > 0
        ? `Named wrap items still open — ship or cancel them before **Cycle complete.**`
        : `Wrap list has no open named items — review + attest if the wave is truly done.`,
    ``,
    `${ULW_LIVE_CONTROLS_HINT}`,
    `User may raise /max-waves or flip /cycle 1 if they want more waves after all.`,
  ]
    .filter((line) => line != null)
    .join("\n");
}

/** How to spend a small max_waves budget on a general mandate. */
export function formatCappedWaveDoctrine(
  cap: number,
  mandate: string,
): string {
  const evaluate = isEvaluateClassMandate(mandate);
  if (cap === 1) {
    return evaluate
      ? `max_waves=1 — one wave. Write the reading, ship the single highest-leverage item, prove.`
      : `max_waves=1 — one wave. One highest-leverage ship + proof. No second wave.`;
  }
  if (cap === 2) {
    return [
      `max_waves=2 — spend both.`,
      evaluate
        ? `Wave 1: written evaluation + first ship (evaluation IS the first verb — do not skip it).`
        : `Wave 1: written reading + first ship.`,
      `Wave 2: next highest-leverage ship on a different surface, prove.`,
      `**Cycle complete.** only after the cap auto-LAST (or /cycle 0). Do not invent leftover chrome.`,
    ].join(" ");
  }
  return (
    `max_waves=${cap} — spend all ${cap}. Wave 1 is judge/pick + first ship; ` +
    `waves 2..${cap} execute the next highest-leverage ships on different surfaces. ` +
    `**Cycle complete.** is refused until the cap (auto LAST) or /cycle 0. ` +
    `Do not invent leftover chrome.`
  );
}

/** Injected into the user message path when /ulw arms (soft or hard). */
export function ulwKickoffMessage(state: UlwCycleState): string {
  const cap = normalizeMaxWaves(state.maxWaves);
  const mem = formatMemoryForPrompt(state.sessionId, { budget: 2_000 });
  return [
    `## ULW armed`,
    `Mandate: ${displayUlwMandate(state.mandate)}`,
    `God-mode protocol is in the system prompt — do not re-derive it. Work the mandate.`,
    ``,
    `## Durable decisions / constraints`,
    mem.text,
    `Use memory_write for new decisions; /memory lists the ledger. Compaction must not erase these.`,
    state.checkpointSha
      ? `Safety checkpoint at arm: ${state.checkpointSha.slice(0, 12)}…  · /checkpoint restore`
      : null,
    ``,
    `## ULW runtime controls`,
    `- Counters RIGHT NOW: **${formatUlwCounts(state)}**  ${state.cycle === 1 ? "(CONTINUE — god-mode relentless loops)" : "(LAST — wrap then attest)"}`,
    `- The user can flip cycle any time with /cycle 0 or /cycle 1 — including while you are mid-turn (live controls). Independent of your opinion of "done".`,
    `- While cycle=1, the harness blocks Stop and forces the research→judge→implement→prove→serendipity→review→repeat loop.`,
    `- When cycle=0 (cap / /done / safety LAST), wrap this last wave, then attest **Cycle complete.** The harness commits the dirty tree at each wave close and on Cycle complete (never pushes). FORGE_ULW_AUTO_COMMIT=0 off.`,
    cap != null
      ? `- max_waves=${cap}: a budget the user asked to spend, not a suggestion to stop early. Close a unit with Wave shipped / Ship landed so w moves. When w reaches ${cap}, auto LAST, then attest **Cycle complete.** /cycle 0 at wave N stops at N+1. ${formatCappedWaveDoctrine(cap, state.mandate)}`
      : `- max_waves: off (unlimited). CONTINUE until /cycle 0 (finish this wave + one more, then LAST). **Cycle complete.** is refused while cycle=1. User may set /max-waves N mid-run.`,
    state.backlogRequired
      ? `- **Backlog gate:** todo_write ≥2 items covering mandate sections BEFORE free-inventing Wave 1 scope.`
      : null,
    state.judgmentRequired
      ? `- **Reading gate:** Wave 1 cannot close until you write the reading (\`Reading:\` or memory_write). That is the first mandate verb.`
      : null,
    `- ${ULW_LIVE_CONTROLS_HINT}`,
    ``,
    state.judgmentRequired
      ? `Start Wave 1 **now**: write the reading first (mandate verb 1), todo_write the backlog if required, then start the ONE ship you picked.`
      : state.backlogRequired
        ? `Start Wave 1 **now**: first todo_write a backlog from the mandate/decisions, then execute the top item with proof.`
        : state.softPrompt
          ? `Start Wave 1 **now**: sharp orient + highest-leverage objective against durable decisions; spawn subagents when that is smarter; ship with proof. Work smart — do not thrash or ask what to do.`
          : `Start Wave 1 **now**: research only as needed (subagents when they win), then ship against the mandate and decisions. Smart + hard — no permission-to-continue asks.`,
  ]
    .filter((l) => l != null)
    .join("\n");
}

export function parseCycleArg(arg: string): CycleFlag | null {
  const t = arg.trim().toLowerCase();
  if (t === "1" || t === "on" || t === "continue" || t === "go") return 1;
  if (t === "0" || t === "off" || t === "last" || t === "stop" || t === "done") return 0;
  return null;
}

/**
 * Parse /max-waves argument.
 * - off|none|clear|unlimited|0 → null (unlimited)
 * - positive integer → cap
 * - invalid → undefined (caller should error)
 */
export function parseMaxWavesArg(arg: string): number | null | undefined {
  const t = arg.trim().toLowerCase();
  if (!t) return undefined;
  if (
    t === "off" ||
    t === "none" ||
    t === "clear" ||
    t === "unlimited" ||
    t === "inf" ||
    t === "infinite" ||
    t === "0"
  ) {
    return null;
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) return undefined;
  return n;
}

// silence unused import if tree-shaken
void nowEpoch;
