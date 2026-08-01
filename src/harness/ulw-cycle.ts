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
import { clearSoftTodoGateOnWindDown } from "./todo-gate.js";

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
  /** True when verification evidence was detected (test/typecheck/lint/build run or cited) */
  proof: boolean;
  /** One-line clip of the wave's closing assistant message */
  summary: string;
  ts: string;
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
  startedAt: string;
  updatedAt: string;
  sessionId: string;
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
/** Proof demands per proof-less streak before accepting a stated rationale. */
const MAX_PROOF_DEMANDS = 2;
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
  /\b(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|tests|spec|typecheck|type-check|lint|check|build|ci|verify|smoke)\b|\b(?:pytest|py\.test|jest|vitest|mocha|ava|phpunit|rspec|ctest|mypy|pyright|ruff|golangci-lint|staticcheck)\b|\bcargo\s+(?:test|check|build|clippy)\b|\bgo\s+(?:test|vet|build)\b|\bmvn\s+(?:test|verify|package|compile)\b|\bgradle(?:w)?\s+(?:test|check|build)\b|\bmake\s+(?:test|check|build|all|ci)\b|\bmix\s+test\b|\bcomposer\s+test\b|\bturbo\s+run\s+(?:test|tests|typecheck|type-check|lint|check|build|ci|verify|smoke)\b|\bnx\s+(?:run-many|run)\b|\btsc\b|\beslint\b|\bdotnet\s+(?:test|build)\b/i;

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
    if (compact.endsWith(` && ${want}`) || compact.endsWith(`; ${want}`)) {
      return true;
    }
    // Leading env assignments: `FOO=1 npm test`
    if (new RegExp(`(?:^|[;&|]\\s*)${escapeRegExp(want)}(?:\\s|$)`).test(compact)) {
      return true;
    }
  }
  return false;
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

function summarizeWave(message: string): string {
  const t = (message || "").replace(/\s+/g, " ").trim();
  if (!t) return "(no closing summary)";
  return t.length <= 140 ? t : `${t.slice(0, 139)}…`;
}

/**
 * Best factual wave so far: prefer waves with proof, then largest edit delta.
 * Used to anchor the bar ("match or beat your best wave") — not a score.
 */
export function bestWave(waves: UlwWaveRecord[] | undefined): UlwWaveRecord | null {
  if (!waves?.length) return null;
  const proven = waves.filter((w) => w.proof);
  const pool = proven.length ? proven : waves;
  return pool.reduce((best, w) => (w.editDelta > best.editDelta ? w : best), pool[0]);
}

/** One-line factual ledger for re-anchors/status: `w1 +12e ✓ · w2 +1e ✗`. */
export function formatWaveLedger(
  waves: UlwWaveRecord[] | undefined,
  max = 8,
): string {
  if (!waves?.length) return "";
  return waves
    .slice(-max)
    .map((w) => `w${w.wave} +${w.editDelta}e ${w.proof ? "✓" : "✗"}`)
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
  return raw;
}

export function saveUlwCycle(state: UlwCycleState): void {
  state.updatedAt = nowIso();
  state.maxWaves = normalizeMaxWaves(state.maxWaves);
  writeJsonFile(ulwStatePath(state.sessionId), state);
}

/** Soft / weak prompts that need god-scope expansion under ULW. */
export function isSoftPrompt(prompt: string): boolean {
  const t = prompt.replace(/\s+/g, " ").trim();
  if (!t) return true;
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
 */
export function expandUlwMandate(mandate: string): { expanded: string; soft: boolean } {
  const soft = isSoftPrompt(mandate);
  const base = mandate.replace(/\s+/g, " ").trim() || "improve the codebase";

  if (!soft) {
    return {
      soft: false,
      expanded: [
        `User mandate: ${base}`,
        `Execute relentlessly under the ULW cycle protocol until cycle flag is 0 and the last wave is attested complete.`,
      ].join("\n"),
    };
  }

  return {
    soft: true,
    expanded: [
      `User mandate (SOFT — expand to full god-scope, do not ask what they meant): "${base}"`,
      ``,
      `Interpret as: identify real quality/correctness/DX gaps in THIS workspace and ship improvements end-to-end.`,
      `You own technical judgment. Declare your interpretation in one sentence and start working.`,
      ``,
      `God-scope scan (do this, not a vague pep talk):`,
      `1. Inventory: project type, how to build/test, obvious entrypoints, git status, existing TODOs/FIXMEs.`,
      `2. Gap list: bugs, missing tests, broken scripts, brittle paths, security footguns, dead code that blocks clarity, UX/CLI gaps — prioritize by impact × confidence.`,
      `3. Wave plan: 3–7 concrete waves; execute Wave 1 immediately.`,
      `4. Serendipity: if you verify an adjacent bug on a path already open, fix it when the fix is bounded (log as Serendipity).`,
      `5. Independent review after each wave: re-read diffs, run cheapest proof, then either next wave or (if cycle=0) attest last cycle complete.`,
      ``,
      `Forbidden: stopping with "looks fine", asking "what should I improve?", deferring to a future session, inventing scope to gold-plate forever without shipping.`,
    ].join("\n"),
  };
}

export function armUlwCycle(
  sessionId: string,
  mandate: string,
  opts?: { cycle?: CycleFlag; maxWaves?: number | null; editCount?: number },
): UlwCycleState {
  const { expanded, soft } = expandUlwMandate(mandate);
  const prev = loadUlwCycle(sessionId);
  const maxWaves =
    opts?.maxWaves !== undefined
      ? normalizeMaxWaves(opts.maxWaves)
      : prev?.enabled
        ? normalizeMaxWaves(prev.maxWaves)
        : null;
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
    mandate: mandate.replace(/\s+/g, " ").trim() || "improve the codebase",
    expandedMandate: expanded,
    softPrompt: soft,
    // Wave ledger persists across re-arms (same session story); streak
    // counters reset — a fresh mandate earns a fresh quality context.
    waves: prev?.waves ?? [],
    thinStreak: 0,
    proofDemands: 0,
    evidenceNudges: 0,
    startedAt: prev?.enabled ? prev.startedAt : nowIso(),
    updatedAt: nowIso(),
    sessionId,
  };
  saveUlwCycle(state);
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
    s.cycle = 0;
    try {
      clearSoftTodoGateOnWindDown(sessionId);
    } catch {
      /* */
    }
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

  // Progress / stuck tracking
  const progressed = opts.editCount > s.lastBlockEditCount;
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
    // Wind-down: drop soft TodoGate once-blocks so stuck release is clean.
    try {
      clearSoftTodoGateOnWindDown(opts.sessionId);
    } catch {
      /* */
    }
    return {
      block: false,
      stuckReleased: true,
      reason: `ULW stuck-wall: ${s.stuckBlocks} consecutive Stop attempts with no file edits. Cycle released. Re-arm with /ulw or /cycle 1.`,
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
    s.wave += 1;
    // Record the wave that closed at this boundary — facts for the quality bar.
    // Prefer successful verification for wave proof so a red check cannot
  // satisfy the quality bar / clear proofDemands.
  const proof = detectWaveProof(
    msg,
    opts.verificationPassed ?? opts.verificationRan,
  );
    s.waves = [
      ...(s.waves ?? []),
      {
        wave: s.wave, // boundary index (counter value after increment)
        editDelta,
        proof,
        summary: summarizeWave(msg),
        ts: nowIso(),
      },
    ].slice(-WAVE_LEDGER_KEEP);
    const thin = editDelta <= 1 && !proof;
    s.thinStreak = thin ? (s.thinStreak ?? 0) + 1 : 0;
    if (proof) {
      s.proofDemands = 0;
    }
    const proofMissing = !proof && (s.proofDemands ?? 0) < MAX_PROOF_DEMANDS;
    if (proofMissing) s.proofDemands = (s.proofDemands ?? 0) + 1;
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
  if (opts.mode === "continue") {
    const best = bestWave(s.waves);
    const lastEntry = s.waves?.length
      ? s.waves[s.waves.length - 1]
      : null;
    return [
      `[Forge ULW cycle driver] Stop blocked — ${formatUlwCounts(s)} (CONTINUE).`,
      `Mandate: ${s.mandate}`,
      `Wave ${s.wave} begins${cap != null ? ` (max ${cap})` : ""}. Protocol: research → plan → implement → verify → review (full cycle in system prompt).`,
      lastEntry
        ? `Last wave closed: +${lastEntry.editDelta} edits, proof ${lastEntry.proof ? "✓" : "✗"}.`
        : null,
      ``,
      `Wave rules:`,
      `1. SMOKE-CHECK first — run the cheapest existing check (tests/typecheck/build) to catch breakage from prior waves before adding scope.`,
      `2. ONE objective — the highest-impact bounded item; search before building so you don't re-implement what exists.`,
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
        ? `Waves are thinning (${opts.thinStreak} in a row with little substance). Commit to a substantially higher-impact wave — or, if the mandate is genuinely exhausted, say so with evidence; the user can /cycle 0.`
        : null,
      s.softPrompt
        ? `Soft original prompt — keep discovering real gaps; do not ask the user to clarify "improve".`
        : null,
      opts.openTodos > 0
        ? `Open todos: ${opts.openTodos} — clear or complete them before claiming a wave done.`
        : `No open todos — create a short wave plan via todo_write, then execute.`,
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
    `Wave: ${s.wave}${cap != null ? ` / max ${cap}` : ""} — finish THIS wave only, then attest and stop.`,
    maxHitLine,
    ``,
    `Required before attestation:`,
    `1. Complete all open work for this wave (todos, verification) and run the final check.`,
    `2. Review the cumulative diff (\`git diff\`) as a hostile reviewer: regressions, weakened tests, leftover stubs.`,
    `3. Attest exactly **Cycle complete.** with a ✅/❌ checklist — what shipped + evidence per item (command → result).`,
    `Attestations without machine-checkable evidence are bounced.`,
    ``,
    `Until you attest **Cycle complete.**, Stop remains blocked.`,
    opts.openTodos > 0
      ? `Still ${opts.openTodos} open todo(s) — close them or cancel with reason.`
      : `No open todos — review + attest if the wave is truly done.`,
    ``,
    `${ULW_LIVE_CONTROLS_HINT}`,
    `User may raise /max-waves or flip /cycle 1 if they want more waves after all.`,
  ]
    .filter((line) => line != null)
    .join("\n");
}

/** Injected into the user message path when /ulw arms on a soft prompt. */
export function ulwKickoffMessage(state: UlwCycleState): string {
  const cap = normalizeMaxWaves(state.maxWaves);
  return [
    state.expandedMandate,
    ``,
    `## ULW runtime controls (read carefully)`,
    `- Counters RIGHT NOW: **${formatUlwCounts(state)}**  ${state.cycle === 1 ? "(CONTINUE relentless loops)" : "(LAST cycle)"}`,
    `- The user can flip cycle any time with /cycle 0 or /cycle 1 — including while you are mid-turn (live controls). Independent of your opinion of "done".`,
    `- While cycle=1, the harness will block Stop and force the research→implement→serendipity→review→repeat loop.`,
    `- When cycle=0, finish the current wave and attest **Cycle complete.**`,
    cap != null
      ? `- max_waves=${cap}: when the wave counter reaches ${cap}, the harness auto-flips to LAST (finish + **Cycle complete.**).`
      : `- max_waves: off (unlimited). User may set /max-waves N mid-run.`,
    `- ${ULW_LIVE_CONTROLS_HINT}`,
    ``,
    `Start Wave 1 now: research first, then ship.`,
  ].join("\n");
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
