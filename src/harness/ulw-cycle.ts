/**
 * Ultrawork relentless cycle driver.
 *
 * User-facing control:
 *   cycle = 1  → keep looping research → waves → serendipity → review → repeat
 *   cycle = 0  → finish the current wave as the LAST cycle, then release Stop
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
import { gitDiffFingerprint } from "../util/git-context.js";

export type CycleFlag = 0 | 1;

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
   * 0 = last cycle — finish current wave then allow stop after attestation
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
  /** Consecutive waves with negligible edits AND no verification */
  thinStreak?: number;
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

/** Wave ledger cap — enough for bar anchoring + status, bounded sidecar size. */
const WAVE_LEDGER_KEEP = 20;
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
  /\b(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|tests|spec|typecheck|type-check|lint|check|build|ci|verify|smoke|tsc|format-check|fmt-check)\b|\b(?:pytest|py\.test|jest|vitest|mocha|ava|phpunit|rspec|ctest|mypy|pyright|ruff|golangci-lint|staticcheck|biome)\b|\bcargo\s+(?:test|check|build|clippy)\b|\bgo\s+(?:test|vet|build)\b|\bmvn\s+(?:test|verify|package|compile)\b|\bgradle(?:w)?\s+(?:test|check|build)\b|\bmake\s+(?:test|check|build|all|ci)\b|\bmix\s+test\b|\bcomposer\s+test\b|\bturbo\s+run\s+(?:test|tests|typecheck|type-check|lint|check|build|ci|verify|smoke)\b|\bnx\s+(?:run-many|run)\b|\btsc\b|\beslint\b|\bdotnet\s+(?:test|build)\b|\bnpx\s+(?:tsc|eslint|vitest|jest|prettier|biome)\b|\b(?:yarn\s+dlx|bunx)\s+(?:tsc|eslint|vitest|jest)\b|\bforge\s+(?:test|check|typecheck|ci|smoke)\b/i;

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
    t.length < 220 &&
    /verifying|confirming|checking the|closing wave|looks pre-existing|proof is green|lsp still/i.test(
      t,
    )
  );
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

/**
 * Clip a wave-boundary closer. Prefer **Reading:** / Ship landed / Cycle
 * complete over the last mid-thought sentence (ULW Stop often fires while
 * the model is still "verifying the unused import").
 */
export function summarizeWave(message: string, sessionId?: string): string {
  const t = (message || "").replace(/\s+/g, " ").trim();
  if (!t) {
    if (sessionId) {
      const fromMem = readingFromMemory(sessionId);
      if (fromMem) return clipWaveSummary(fromMem);
    }
    return "(no closing summary)";
  }
  const reading = t.match(/\*{0,2}Reading:\*{0,2}\s+(.{20,240})/i);
  if (reading?.[1]) return clipWaveSummary(reading[1]);
  const ship = t.match(/Ship landed:\s*(.{10,180})/i);
  if (ship?.[1]) return clipWaveSummary(ship[1]);
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
  if (diffChanged) return diffRevisit ? "revisit" : "new";
  // First fingerprint after edits already landed: the tree moved from
  // the arm-time (or empty) state even though this call is the baseline.
  if (firstObservation && editDelta > 0) return "new";
  return "none";
}

function flipUlwToLast(s: UlwCycleState, sessionId: string): void {
  if (s.cycle !== 1) return;
  s.cycle = 0;
  try {
    clearSoftTodoGateOnWindDown(sessionId);
  } catch {
    /* */
  }
}

function lastWaveAdmit(cap: number, wave: number): string {
  return [
    "[Forge harness — mid-conversation update]",
    `ULW max_waves=${cap} reached at wave=${wave} — auto LAST.`,
    "Finish this wave, review, attest **Cycle complete.** Do not start a new ambitious wave.",
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
  if (opts.summary && !opts.summary.startsWith("(")) last.summary = opts.summary;
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
  },
): UlwWaveRecord {
  s.wave += 1;
  const rec: UlwWaveRecord = {
    wave: s.wave,
    editDelta: opts.editDelta,
    netDiff: opts.netDiff,
    proof: opts.proof,
    todoProgress: opts.todoProgress,
    summary: opts.summary,
    ts: nowIso(),
  };
  s.waves = [...(s.waves ?? []), rec].slice(-WAVE_LEDGER_KEEP);
  try {
    recordWaveObservation(
      opts.sessionId,
      s.wave,
      `+${opts.editDelta}e proof=${opts.proof ? "✓" : "✗"} todosΔ=${opts.todoProgress} net=${opts.netDiff ?? "n/a"} — ${opts.summary}`,
    );
  } catch {
    /* */
  }
  const thin =
    (opts.editDelta <= 1 && opts.netDiff !== "new" && !opts.proof) ||
    opts.netDiff === "revisit" ||
    (opts.todoProgress === 0 &&
      !opts.proof &&
      opts.editDelta <= 2 &&
      opts.netDiff !== "new");
  s.thinStreak = thin ? (s.thinStreak ?? 0) + 1 : 0;
  if (opts.proof) s.proofDemands = 0;
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

/** Agent closed a work unit in prose — that is a wave, not an idle heartbeat. */
export function isDeclaredWaveClose(message: string): boolean {
  const t = message || "";
  return (
    /\bCycle complete\b/i.test(t) ||
    /\bShip landed:/i.test(t) ||
    /\bWave\s+\d+\s+(LAST\s+)?shipped\b/i.test(t) ||
    /\bWave\s+\d+\s+LAST\b/i.test(t)
  );
}

/**
 * Unattended quality-bar heartbeat. The user-facing wave counter increments
 * on Stop, on a declared ship (`Wave N shipped` / `Ship landed` / `Cycle
 * complete`), or (uncapped only) on an idle epoch. Edit bursts update the
 * open wave in place so one search_replace is not one wave. `max_waves`
 * still auto-LAST. Idle epochs never burn a cap.
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
      admit: lastWaveAdmit(cap, s.wave),
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
      ? (s.seenDiffFps ?? []).includes(fp)
        ? "revisit"
        : "new"
      : editDelta > 0
        ? "new"
        : "none";
  const proof = detectWaveProof(
    opts.lastAssistantMessage || "",
    opts.verificationPassed ?? opts.verificationRan,
  );
  const summary =
    summarizeWave(opts.lastAssistantMessage || "", opts.sessionId) ||
    "(mid-loop epoch)";
  const facts = { editDelta, proof, todoProgress, netDiff, summary };

  // LAST: update the open wave's facts, never increment the counter.
  if (s.cycle !== 1) {
    if (progressed) {
      updateOpenWaveRecord(s, facts);
      s.lastProgressEditCount = opts.editCount;
    }
    saveUlwCycle(s);
    return { stamped: false, updated: progressed, wave: s.wave };
  }

  if (s.judgmentRequired && hasMandateJudgment(opts.sessionId, opts.lastAssistantMessage)) {
    s.judgmentRequired = false;
  }

  // Declared ship with real progress: this is a work unit. Capped ULW
  // must count it — otherwise the model invents Wave 3/4 while HUD stays 1/4
  // for hours (Stop never fires because cycle=1 blocks it).
  if (
    isDeclaredWaveClose(opts.lastAssistantMessage || "") &&
    progressed &&
    editDelta >= 1
  ) {
    if (
      s.judgmentRequired &&
      s.wave === 0 &&
      !hasMandateJudgment(opts.sessionId, opts.lastAssistantMessage)
    ) {
      /* still need a reading — fall through */
    } else {
      applyDiffFingerprint(s, fp);
      appendWaveRecord(s, {
        sessionId: opts.sessionId,
        ...facts,
      });
      s.lastWaveSig = sig;
      s.lastProgressEditCount = opts.editCount;
      let flipped = false;
      if (cap != null && s.wave >= cap) {
        flipUlwToLast(s, opts.sessionId);
        flipped = true;
      }
      saveUlwCycle(s);
      const counts = formatUlwCounts(s);
      return {
        stamped: true,
        wave: s.wave,
        flippedToLast: flipped,
        admit: flipped
          ? lastWaveAdmit(cap!, s.wave)
          : [
              "[Forge harness — mid-conversation update]",
              `ULW ${counts} — harness counter moved after a declared ship.`,
              "This w=N/M is the only wave number. Do not invent Wave K.",
            ].join("\n"),
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

  // Capped ULW: max_waves counts Stop-boundary work, not loop turns.
  // Idle epochs would burn a cap of 4 in ~80 tool rounds and LAST mid-ship.
  if (cap != null && idleDue) {
    if (progressed) {
      updateOpenWaveRecord(s, facts);
      s.lastProgressEditCount = opts.editCount;
    }
    if (s.wave >= cap) {
      flipUlwToLast(s, opts.sessionId);
      saveUlwCycle(s);
      return {
        stamped: false,
        flippedToLast: true,
        wave: s.wave,
        admit: lastWaveAdmit(cap, s.wave),
      };
    }
    saveUlwCycle(s);
    return { stamped: false, updated: progressed, wave: s.wave };
  }

  // Evaluate-class: do not open wave 1 on an idle epoch with no reading.
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

  // Idle epoch — unattended wave boundary. Honor the cap.
  if (cap != null && s.wave >= cap) {
    flipUlwToLast(s, opts.sessionId);
    saveUlwCycle(s);
    return {
      stamped: false,
      flippedToLast: true,
      wave: s.wave,
      admit: lastWaveAdmit(cap, s.wave),
    };
  }

  applyDiffFingerprint(s, fp);
  appendWaveRecord(s, {
    sessionId: opts.sessionId,
    ...facts,
  });
  s.lastWaveSig = sig;
  s.lastProgressEditCount = opts.editCount;
  if (!proof && (s.proofDemands ?? 0) < MAX_PROOF_DEMANDS) {
    s.proofDemands = (s.proofDemands ?? 0) + 1;
  }

  let flippedToLast = false;
  if (cap != null && s.wave >= cap) {
    flipUlwToLast(s, opts.sessionId);
    flippedToLast = true;
  }
  saveUlwCycle(s);
  const thin = (s.thinStreak ?? 0) > 0 && !progressed;
  const streak = s.thinStreak ?? 0;
  const thinAdmit =
    thin && (streak === 1 || streak === THIN_ADVISORY_STREAK)
      ? `[Forge harness — mid-conversation update]\nULW epoch ${s.wave}: this epoch added no tree movement. Next think must edit or prove — do not rescan from zero.`
      : undefined;
  return {
    stamped: true,
    thin,
    wave: s.wave,
    flippedToLast,
    admit: flippedToLast && cap != null ? lastWaveAdmit(cap, s.wave) : thinAdmit,
  };
}

/**
 * Best factual wave so far: prefer waves with proof, then largest edit delta.
 * Churn waves (diff fingerprint revisit) are excluded from anchoring — an
 * edit→revert loop must not become the bar. Used to anchor the bar
 * ("match or beat your best wave") — not a score.
 */
export function bestWave(waves: UlwWaveRecord[] | undefined): UlwWaveRecord | null {
  if (!waves?.length) return null;
  const eligible = waves.filter((w) => w.netDiff !== "revisit");
  const base = eligible.length ? eligible : waves;
  const proven = base.filter((w) => w.proof);
  const pool = proven.length ? proven : base;
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
  // Back-compat: older sidecars omit diff-fingerprint churn tracking
  if (!Array.isArray(raw.seenDiffFps)) raw.seenDiffFps = [];
  return raw;
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

  if (!soft) {
    return {
      soft: false,
      expanded: [
        `User mandate: ${base}`,
        ``,
        `Execute under **ULW god-mode** until cycle=0 and the last wave is attested **Cycle complete.**`,
        smartDoctrine,
        backlogDoctrine,
        evaluateDoctrine,
        ``,
        `- Own the outcome end-to-end. Research when uncertain; spawn subagents when that is smarter; then build — no thrash, no permission-to-continue asks.`,
        `- Every wave: highest-leverage next objective vs the mandate · search-before-build · ship · cheapest real proof · hostile review · next wave while cycle=1.`,
        `- Finish the class (siblings + dependents). Prefer substantive progress over busywork.`,
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
      ``,
      `### Operating loop (guidance — adapt freely when freestyle is better)`,
      `1. **ORIENT** — what this place is (stack, checks, entrypoints, git, AGENTS/README, real debt). Tools, not guesses.`,
      `2. **JUDGE** — single highest-leverage hard objective now (impact × confidence / cost). Write the reading.`,
      `3. **RESEARCH** — only as deep as uncertainty warrants; proactive subagents/MCP/web when that is the efficient path. Do not thrash blind.`,
      `4. **SHIP** one bounded high-leverage wave (siblings + dependents). Search-before-build.`,
      `5. **PROVE** — cheapest real check that can fail.`,
      `6. **SERENDIPITY** — bounded adjacent fix on an open path if cheap; label \`Serendipity:\`.`,
      `7. **HOSTILE REVIEW** — fix real defects in your diff; skip cosmetic noise.`,
      `8. **REPEAT** while cycle=1. If cycle=0, finish this wave and attest **Cycle complete.** with evidence.`,
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
    mandate.replace(/\s+/g, " ").trim() || "improve the codebase";
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
    proofDemands: 0,
    evidenceNudges: 0,
    backlogRequired: broad,
    judgmentRequired: isEvaluateClassMandate(cleanMandate),
    judgmentDemands: 0,
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
  try {
    seedMemoryFromMandate(sessionId, cleanMandate, { softPrompt: soft });
  } catch {
    /* memory best-effort at arm; compact fail-closed surfaces corrupt */
  }
  return state;
}

export function setCycleFlag(sessionId: string, cycle: CycleFlag): UlwCycleState | null {
  const s = loadUlwCycle(sessionId);
  if (!s || !s.enabled) {
    // Allow arming cycle control only when ULW is on — create dormant? better require /ulw first
    return null;
  }
  s.cycle = cycle;
  if (cycle === 1) {
    s.stuckBlocks = 0;
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
export function maybeFlipUlwToLastOnSafetyValve(
  sessionId: string,
): UlwCycleState | null {
  const s = loadUlwCycle(sessionId);
  if (!s?.enabled || s.cycle !== 1) return null;
  const next = setCycleFlag(sessionId, 0);
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
  if (!s || !s.enabled) return null;
  s.maxWaves = normalizeMaxWaves(maxWaves);
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
    stuckBlocks: 0,
    lastBlockEditCount: 0,
    thinStreak: 0,
    proofDemands: 0,
    evidenceNudges: 0,
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
  "Live mid-run (type while working — no Ctrl+C): /cycle 0 last · /cycle 1 continue · /max-waves N|off · /ulw-off disarm · /budget N|off · /notify on · /done";

export function formatUlwStatus(s: UlwCycleState | null): string {
  if (!s || !s.enabled) {
    return [
      "ULW cycle: OFF",
      "  Arm with: /ulw <task>   or   /ulw improve the code",
      "  Cycle flag: set with /cycle 1 (continue) or /cycle 0 (last wave then stop)",
      "  Wave cap:   /max-waves N  (optional; default unlimited) · /max-waves off",
      `  ${ULW_LIVE_CONTROLS_HINT}`,
    ].join("\n");
  }
  const cap = normalizeMaxWaves(s.maxWaves);
  const ledger = formatWaveLedger(s.waves);
  const best = bestWave(s.waves);
  return [
    `ULW cycle: ON  |  ${formatUlwCounts(s)}  ${s.cycle === 1 ? "(CONTINUE — relentless)" : "(LAST — finish current wave)"}`,
    `  Mandate: ${s.mandate}`,
    `  Soft prompt expanded: ${s.softPrompt ? "yes" : "no"}`,
    `  max_waves: ${cap != null ? cap : "off (unlimited)"}`,
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
    `    /cycle 0       — treat current work as the LAST cycle; agent finishes wave then stops`,
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

  const msg = opts.lastAssistantMessage || "";
  const attested = s.cycle === 0 && LAST_CYCLE_ATTEST_RE.test(msg);
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
    s.enabled = false;
    saveUlwCycle(s);
    return {
      block: false,
      lastCycleReleased: true,
      reason: "ULW last cycle attested complete — released.",
    };
  }

  // Progress / stuck tracking: editCount delta OR working-tree diff movement
  // (bash heredocs/sed move the tree without touching edit-tool counters).
  const progressed = opts.editCount > s.lastBlockEditCount || diffChanged;
  if (progressed) {
    s.stuckBlocks = 0;
  } else {
    s.stuckBlocks += 1;
  }
  s.blocks += 1;
  s.lastBlockEditCount = opts.editCount;

  if (opts.stuckThreshold > 0 && s.stuckBlocks >= opts.stuckThreshold) {
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
      const mem = formatMemoryForPrompt(opts.sessionId, { budget: 2500 });
      const reanchor = [
        `[Forge ULW cycle driver] Stop blocked — backlog required before Wave 1 invents scope.`,
        `Mandate is broad/soft. Decompose it into an ordered todo board (≥2 items) via todo_write covering the mandate sections, then execute the top item.`,
        `Mandate: ${s.mandate}`,
        mem.activeCount
          ? `## Active decisions / constraints\n${mem.text}`
          : null,
        `Do not free-invent waves until the backlog exists. ${ULW_LIVE_CONTROLS_HINT}`,
      ]
        .filter(Boolean)
        .join("\n");
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
        `Mandate: ${s.mandate}`,
        `Write the reading NOW (what the hard work is, what you passed on, the ONE item you will ship). memory_write it, or start the reply with \`Reading:\`.`,
        `That is the first verb of the mandate — not advice, not optional. Then execute the item.`,
        ULW_LIVE_CONTROLS_HINT,
      ].join("\n");
      return { block: true, reason: reanchor, reanchor };
    }
    if (s.judgmentRequired && hasMandateJudgment(opts.sessionId, msg)) {
      s.judgmentRequired = false;
    }

    // Already at/over cap (e.g. user lowered max_waves mid-run) → force LAST now.
    if (cap != null && s.wave >= cap) {
      s.cycle = 0;
      saveUlwCycle(s);
      // Auto LAST: parity with /cycle 0 wind-down for soft TodoGate.
      try {
        clearSoftTodoGateOnWindDown(opts.sessionId);
      } catch {
        /* */
      }
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
    if (!alreadyStamped) {
      appendWaveRecord(s, {
        sessionId: opts.sessionId,
        editDelta,
        netDiff,
        proof,
        todoProgress,
        summary: summarizeWave(msg, opts.sessionId),
      });
      s.lastWaveSig = sig;
      s.lastProgressEditCount = opts.editCount;
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
      s.cycle = 0;
      saveUlwCycle(s);
      // Auto LAST: parity with /cycle 0 wind-down for soft TodoGate.
      try {
        clearSoftTodoGateOnWindDown(opts.sessionId);
      } catch {
        /* */
      }
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
    });
    return { block: true, reason: reanchor, reanchor, ...qualityFlags };
  }

  // cycle === 0: force finish current wave (no "I'll stop mid-wave")
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
  },
): string {
  const cap = normalizeMaxWaves(s.maxWaves);
  const mem = formatMemoryForPrompt(s.sessionId, { budget: 3500 });
  const decisionsBlock =
    mem.activeCount > 0 || mem.corrupt
      ? [`## Active decisions / constraints (durable — do not re-derive)`, mem.text]
      : [];
  if (opts.mode === "continue") {
    const best = bestWave(s.waves);
    const lastEntry = s.waves?.length
      ? s.waves[s.waves.length - 1]
      : null;
    return [
      `[Forge ULW cycle driver] Stop blocked — ${formatUlwCounts(s)} (CONTINUE).`,
      `Mandate: ${s.mandate}`,
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
              ? "Last wave's check failed (red) — fix and re-run until green"
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
    ? `max_waves=${cap} reached at wave=${s.wave} — auto LAST (finish and attest; do not start a new ambitious wave).`
    : null;

  return [
    `[Forge ULW cycle driver] Stop blocked — ${formatUlwCounts(s)} (LAST CYCLE).`,
    `Mandate: ${s.mandate}`,
    ...decisionsBlock,
    `Wave: ${s.wave}${cap != null ? ` / max ${cap}` : ""} — finish THIS wave only, then attest and stop.`,
    maxHitLine,
    ``,
    `Required before attestation:`,
    `1. Complete or cancel all open todos (with reason) and run the final check.`,
    `2. Review the cumulative diff (\`git diff\`) as a hostile reviewer: regressions, weakened tests, leftover stubs.`,
    `3. Attest exactly **Cycle complete.** with a ✅/❌ checklist — what shipped + evidence per item (command → result).`,
    `Attestations without machine-checkable evidence are bounced.`,
    ``,
    `Until you attest **Cycle complete.**, Stop remains blocked.`,
    `When you attest, Forge creates a local git commit of this wave's work (never pushed). FORGE_ULW_AUTO_COMMIT=0 to skip.`,
    opts.openTodos > 0
      ? `Still ${opts.openTodos} open todo(s) — close them or cancel with reason before LAST release.`
      : `No open todos — review + attest if the wave is truly done.`,
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
      `max_waves=2 — two waves, spend them on the mandate's verbs in order.`,
      evaluate
        ? `Wave 1: written evaluation + pick ONE ship (evaluation IS the first verb — do not skip it).`
        : `Wave 1: written reading + pick ONE ship.`,
      `Wave 2: finish that ship, prove, attest. Do not start a new ambitious theme.`,
    ].join(" ");
  }
  return `max_waves=${cap} — Wave 1 is judge/pick; waves 2..${cap} execute. Last wave auto LAST.`;
}

/** Injected into the user message path when /ulw arms (soft or hard). */
export function ulwKickoffMessage(state: UlwCycleState): string {
  const cap = normalizeMaxWaves(state.maxWaves);
  const mem = formatMemoryForPrompt(state.sessionId, { budget: 4000 });
  return [
    state.expandedMandate,
    ``,
    `## Durable decisions / constraints`,
    mem.text,
    `Use memory_write for new decisions; /memory lists the ledger. Compaction must not erase these.`,
    state.checkpointSha
      ? `Safety checkpoint at arm: ${state.checkpointSha} (tree untouched). Restore: /checkpoint restore or git stash apply ${state.checkpointSha}`
      : null,
    ``,
    `## ULW runtime controls (read carefully)`,
    `- Counters RIGHT NOW: **${formatUlwCounts(state)}**  ${state.cycle === 1 ? "(CONTINUE — god-mode relentless loops)" : "(LAST cycle)"}`,
    `- The user can flip cycle any time with /cycle 0 or /cycle 1 — including while you are mid-turn (live controls). Independent of your opinion of "done".`,
    `- While cycle=1, the harness blocks Stop and forces the research→judge→implement→prove→serendipity→review→repeat loop.`,
    `- When cycle=0, finish the current wave and attest **Cycle complete.** The harness then commits the local diff (never pushes). FORGE_ULW_AUTO_COMMIT=0 off.`,
    cap != null
      ? `- max_waves=${cap}: when the wave counter reaches ${cap}, the harness auto-flips to LAST (finish + **Cycle complete.**). ${formatCappedWaveDoctrine(cap, state.mandate)}`
      : `- max_waves: off (unlimited). User may set /max-waves N mid-run. Prefer a cap on unattended multi-hour runs (spend valve — not a substitute for decision memory).`,
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
