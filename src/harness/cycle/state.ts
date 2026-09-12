/**
 * ULW plan-cycle state — the sidecar the driver stands on.
 *
 * A run is a sequence of cycles. Each cycle is PLAN → EXECUTE → REVIEW →
 * VERIFY → COMMIT, then either RELEASED or the next PLAN. The state records
 * facts only: which phase, which plan items are open, what the ledger saw at
 * each Stop, what each cycle shipped and how it was reviewed and committed.
 * No prose is classified here; the Planner and Reviewer judge, the harness
 * enforces the sequence.
 *
 * Path: ~/.forge/sessions/<id>/ulw.json (schema 2). A schema-1 sidecar from
 * the retired wave engine loads as `legacy: true`, disabled — the user
 * re-arms with /ulw.
 */
import path from "node:path";
import { forgeHome, readJsonFile, writeJsonFile, nowIso, ensureDir } from "../../util/fs.js";

export const CYCLE_SCHEMA = 2 as const;

export type CyclePhase =
  | "plan"
  | "execute"
  | "review"
  | "verify"
  | "fix"
  | "commit"
  | "released";

export type PlanVerdict = "continue" | "fulfilled" | "blocked";
export type ReviewVerdict = "ship" | "ship-with-revisions" | "blocked";

export type CycleEndReason =
  | "fulfilled"
  | "blocked"
  | "cycle-zero"
  | "max-cycles"
  | "stuck"
  | "fix-cap"
  | "no-progress"
  | "disarmed"
  | "safety-valve"
  | "runtime-unavailable";

export interface CyclePlanItem {
  id: string;
  title: string;
  files: string[];
  proof?: string;
  /** The job in Identity this item serves, in the Planner's words (forge-surface: every decision traceable to subject + audience + job). */
  serves?: string;
  /** What the Planner ran or saw that shows the item is not yet so (forge-redgreen: a proof that already passes is not an item). */
  redNow?: string;
  status: "open" | "done" | "cancelled";
}

/**
 * One promise the product makes — README, `--help`, tests as spec, the
 * identity — and whether the tree keeps it, as the Planner last inspected it
 * (forge-assay: a checklist against current state, never memory).
 */
export interface CyclePromise {
  text: string;
  state: "kept" | "broken" | "absent" | "unknown";
  seen?: string;
}

/** One Stop boundary inside EXECUTE — facts, never scores. */
export interface CycleWaveRecord {
  cycle: number;
  wave: number;
  ts: string;
  editDelta: number;
  /** Working-tree movement at the boundary; "n/a" outside git. */
  netDiff: "new" | "revisit" | "none" | "n/a";
  proofRan: boolean;
  proofPassed: boolean;
  fullSuite: boolean;
  summary: string;
}

export interface CycleRecord {
  n: number;
  title?: string;
  /** The plan's Direction line — what the cycle set out to make a user notice. */
  direction?: string;
  /** The plan's Looked line — what the Planner ran or opened before judging. */
  looked?: string;
  /** The scout document the Planner wrote before it was handed the record (turn 1). */
  scoutPath?: string;
  /** The alternatives the Planner weighed, `leave it` among them (forge-shape). */
  considered?: string[];
  /** The Planner's `Worth the cycle:` — its claim before the spend; the Reviewer's `worth` is the finding after. */
  worthClaim?: string;
  /** The look document the Reviewer wrote before it was handed the diff (turn 1). */
  lookPath?: string;
  /** What the Reviewer ran or opened before reading the diff (forge-prove: run, read, then claim). */
  reviewerLooked?: string;
  /** `Dispute:` lines the executor wrote about the last review, with its evidence — for the next Planner. */
  disputes?: string[];
  startedAt: string;
  endedAt?: string;
  planPath?: string;
  reviewPath?: string;
  planVerdict?: PlanVerdict;
  reviewVerdict?: ReviewVerdict;
  itemsTotal: number;
  itemsDone: number;
  waves: number;
  verifyCommand?: string;
  verifyPassed?: boolean;
  /** Pre-existing failures the gate tolerated (green vs baseline). */
  verifyInherited?: number;
  commitSha?: string;
  commitSubject?: string;
  /** Paths the cycle commit staged (facts for the next Planner — not a meter). */
  commitFiles?: string[];
  /** docs-only vs source/product; docs does not reset the no-progress wall. */
  commitKind?: "docs" | "substance";
  mustFix: string[];
  /** The Reviewer's shape notes and its answer to "would a user notice this cycle?" */
  architecture?: string[];
  worth?: string;
  /** What the Reviewer changed in the executor's work, and why — the executor reads these at the next plan. */
  revisions?: string[];
  /** Plan items the Reviewer judged partial or missing against the executor's board. */
  disputed?: string[];
  /** `Serendipity:` lines the executor wrote at its Stops — what it noticed and left alone, for the next Planner. */
  serendipity?: string[];
  plannerTokens?: number;
  reviewerTokens?: number;
  /** How the plan was admitted — status/report distinguish scout-ok / synthesized. */
  plannerStatus?: "planned" | "scout-admitted" | "synthesized";
}

export interface CycleReviewNotes {
  verdict: ReviewVerdict;
  /** What the Reviewer ran or opened as the product's user before judging worth. */
  looked?: string;
  fulfillment: Array<{ item: string; state: "done" | "partial" | "missing"; note?: string }>;
  revisions: string[];
  mustFix: string[];
  architecture: string[];
  /** The Reviewer's answer to "would a user notice this cycle?" */
  worth?: string;
  operator: string[];
}

export interface CycleState {
  schema: typeof CYCLE_SCHEMA;
  sessionId: string;
  enabled: boolean;
  /** Current cycle number; 0 before the first plan is admitted. */
  cycle: number;
  phase: CyclePhase;
  /** Stop boundaries inside the current cycle's EXECUTE. */
  wave: number;
  totalWaves: number;
  /** null = case c: no mandate, the Planner derives the direction. */
  mandate: string | null;
  identity?: string;
  direction?: string;
  /** The product's own promises as the Planner last inspected them; the run's checklist (forge-assay). */
  promises?: CyclePromise[];
  planTitle?: string;
  planVerdict?: PlanVerdict;
  items: CyclePlanItem[];
  outOfScope: string[];
  verifyCommand?: string;
  /** Strictly harvested check commands the Planner declared (newest first). */
  declaredChecks: string[];
  /** HEAD when the run armed and when the current cycle's EXECUTE began. */
  runStartHead: string | null;
  cycleStartHead: string | null;
  cycleZeroRequested: boolean;
  replanRequested: boolean;
  /** User typed /plan — the harness Planner stands down until /build. */
  humanPlan: boolean;
  maxCycles: number | null;
  /** VERIFY red after review → executor fix rounds this cycle. */
  fixRounds: number;
  stuckBlocks: number;
  /**
   * Consecutive harness-synthesized cycles (a Planner that could not converge,
   * or a no-mandate `fulfilled` the harness turned into deeper work) that did
   * not commit. Reset by any committed cycle. When it reaches the cap, an
   * unlimited run releases on a genuine no-progress wall — the only stop the
   * model cannot manufacture by declaring the product done.
   */
  directExecuteStreak: number;
  /**
   * Consecutive harness-synthesized cycles, including ones that committed.
   * Reset when a parseable Planner plan is admitted. Caps the first-hour mill
   * that used to reset the no-progress wall on every synth commit.
   */
  synthStreak: number;
  blocks: number;
  lastBlockEditCount: number;
  lastDiffFp: string | null;
  seenDiffFps: string[];
  ledger: CycleWaveRecord[];
  cycles: CycleRecord[];
  lastReview?: CycleReviewNotes;
  lastVerifyTail?: string;
  /**
   * The verify command's failures before the cycle touched anything: taken at
   * the first plan admission whose gate is this command (cycle 1's tree, or
   * the tree as the last commit left it when a later Planner declares a
   * different check), then the accepted run after each commit. The gate is
   * "no new failures", not "exit 0" — a repo with pre-existing environment
   * failures is otherwise never green, and a baseline keyed to another
   * command would match nothing.
   */
  verifyBaseline?: {
    command: string;
    exitCode: number | null;
    failures: string[];
    at: string;
  };
  endReason?: CycleEndReason;
  /**
   * Which report this arm belongs to. `/ulw` after a previous `endReason`
   * increments it so era-A's `report.md` is not `/report` for era B.
   */
  reportEpoch: number;
  startedAt: string;
  updatedAt: string;
  /** Schema-1 wave-engine sidecar found on disk; disabled, re-arm with /ulw. */
  legacy?: boolean;
}

const LEDGER_KEEP = 256;
const DIFF_FP_KEEP = 12;

export function ulwStatePath(sessionId: string): string {
  return path.join(forgeHome(), "sessions", sessionId, "ulw.json");
}

export function cycleArtifactsDir(sessionId: string, cycle: number): string {
  return path.join(forgeHome(), "sessions", sessionId, "cycles", String(cycle));
}

export function ensureCycleArtifactsDir(sessionId: string, cycle: number): string {
  const dir = cycleArtifactsDir(sessionId, cycle);
  ensureDir(dir);
  return dir;
}

export function newCycleState(opts: {
  sessionId: string;
  mandate: string | null;
  maxCycles?: number | null;
  runStartHead?: string | null;
}): CycleState {
  const now = nowIso();
  return {
    schema: CYCLE_SCHEMA,
    sessionId: opts.sessionId,
    enabled: true,
    cycle: 0,
    phase: "plan",
    wave: 0,
    totalWaves: 0,
    mandate: opts.mandate,
    items: [],
    outOfScope: [],
    declaredChecks: [],
    runStartHead: opts.runStartHead ?? null,
    cycleStartHead: opts.runStartHead ?? null,
    cycleZeroRequested: false,
    replanRequested: false,
    humanPlan: false,
    maxCycles: normalizeMaxCycles(opts.maxCycles),
    fixRounds: 0,
    stuckBlocks: 0,
    directExecuteStreak: 0,
    synthStreak: 0,
    blocks: 0,
    lastBlockEditCount: 0,
    lastDiffFp: null,
    seenDiffFps: [],
    ledger: [],
    cycles: [],
    reportEpoch: 1,
    startedAt: now,
    updatedAt: now,
  };
}

export function normalizeMaxCycles(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function isLegacySidecar(raw: Record<string, unknown>): boolean {
  if (raw.schema === CYCLE_SCHEMA) return false;
  // The wave engine persisted `waves` / `cycle` (0|1 flag) / `wave` counters.
  return Array.isArray(raw.waves) || typeof raw.softPrompt === "boolean" || raw.schema == null;
}

export function loadCycleState(sessionId: string): CycleState | null {
  if (!sessionId) return null;
  const raw = readJsonFile<Record<string, unknown> | null>(ulwStatePath(sessionId), null);
  if (!raw || typeof raw !== "object") return null;
  if (isLegacySidecar(raw)) {
    return {
      ...newCycleState({
        sessionId,
        mandate: typeof raw.mandate === "string" ? raw.mandate : null,
      }),
      enabled: false,
      phase: "released",
      legacy: true,
      endReason: "disarmed",
    };
  }
  return normalizeState(raw as Partial<CycleState>, sessionId);
}

function normalizeState(raw: Partial<CycleState>, sessionId: string): CycleState {
  const base = newCycleState({ sessionId, mandate: raw.mandate ?? null });
  const s: CycleState = {
    ...base,
    ...raw,
    schema: CYCLE_SCHEMA,
    sessionId,
    items: Array.isArray(raw.items) ? raw.items : [],
    outOfScope: Array.isArray(raw.outOfScope) ? raw.outOfScope : [],
    declaredChecks: Array.isArray(raw.declaredChecks) ? raw.declaredChecks : [],
    seenDiffFps: Array.isArray(raw.seenDiffFps) ? raw.seenDiffFps : [],
    ledger: Array.isArray(raw.ledger) ? raw.ledger : [],
    cycles: Array.isArray(raw.cycles) ? raw.cycles : [],
    maxCycles: normalizeMaxCycles(raw.maxCycles),
  };
  if (typeof s.enabled !== "boolean") s.enabled = false;
  if (typeof s.cycle !== "number") s.cycle = 0;
  if (typeof s.wave !== "number") s.wave = 0;
  if (typeof s.totalWaves !== "number") s.totalWaves = 0;
  if (typeof s.fixRounds !== "number") s.fixRounds = 0;
  if (typeof s.stuckBlocks !== "number") s.stuckBlocks = 0;
  if (typeof s.directExecuteStreak !== "number") s.directExecuteStreak = 0;
  if (typeof s.synthStreak !== "number") s.synthStreak = 0;
  if (typeof s.blocks !== "number") s.blocks = 0;
  if (typeof s.lastBlockEditCount !== "number") s.lastBlockEditCount = 0;
  if (typeof s.reportEpoch !== "number" || !Number.isFinite(s.reportEpoch) || s.reportEpoch < 1) {
    s.reportEpoch = 1;
  } else {
    s.reportEpoch = Math.floor(s.reportEpoch);
  }
  return s;
}

/**
 * Overlay live controls from disk onto a long-lived in-memory copy.
 *
 * `/cycle 0`, `/max-cycles`, `/plan`, `/ulw-off` write the sidecar while the
 * orchestrator may still hold the object it loaded minutes earlier (Planner,
 * Reviewer, verify). A later persist of that stale copy must not clobber the
 * keystroke. Disk wins for those fields; a harness `release()` in memory is
 * not revived by an armed disk.
 */
export function adoptLiveControls(s: CycleState): void {
  if (!s.sessionId) return;
  const disk = loadCycleState(s.sessionId);
  if (!disk || disk.legacy) return;
  s.cycleZeroRequested = disk.cycleZeroRequested;
  s.humanPlan = disk.humanPlan;
  s.maxCycles = disk.maxCycles;
  if (!cycleActive(disk) && cycleActive(s)) {
    s.enabled = disk.enabled;
    s.phase = disk.phase;
    s.endReason = disk.endReason ?? s.endReason;
  }
}

/** Authoritative persist — control writers and arm/reset. Does not overlay. */
export function writeCycleState(s: CycleState): void {
  s.updatedAt = nowIso();
  if (s.ledger.length > LEDGER_KEEP) s.ledger = s.ledger.slice(-LEDGER_KEEP);
  if (s.seenDiffFps.length > DIFF_FP_KEEP) s.seenDiffFps = s.seenDiffFps.slice(-DIFF_FP_KEEP);
  writeJsonFile(ulwStatePath(s.sessionId), s);
}

/** Orchestrator persist: overlay live controls from disk, then write. */
export function saveCycleState(s: CycleState): void {
  adoptLiveControls(s);
  writeCycleState(s);
}

/** Armed and driving — the only predicate the rest of the harness needs. */
export function cycleActive(s: CycleState | null | undefined): boolean {
  return Boolean(s && s.enabled && !s.legacy && s.phase !== "released");
}

/** The sidecar when it is armed and driving, else null. */
export function loadActiveCycle(sessionId: string): CycleState | null {
  const s = loadCycleState(sessionId);
  return s && cycleActive(s) ? s : null;
}

export function openItems(s: CycleState): CyclePlanItem[] {
  return s.items.filter((i) => i.status === "open");
}

export function currentCycleRecord(s: CycleState): CycleRecord | undefined {
  return s.cycles.find((c) => c.n === s.cycle);
}

/** True when the current cycle number has already closed (we are planning the next). */
export function currentCycleAlreadyClosed(s: CycleState): boolean {
  return Boolean(currentCycleRecord(s)?.endedAt);
}

/** Copy the sidecar for /fork so the branch keeps the driver. */
export function copyCycleState(fromSessionId: string, toSessionId: string): boolean {
  const s = loadCycleState(fromSessionId);
  if (!s || s.legacy) return false;
  writeCycleState({ ...s, sessionId: toSessionId });
  return true;
}

/** /clear keeps the session id but wipes the run. */
export function resetCycleOnClear(sessionId: string): void {
  const s = loadCycleState(sessionId);
  if (!s) return;
  writeCycleState({
    ...newCycleState({ sessionId, mandate: null }),
    enabled: false,
    phase: "released",
    endReason: "disarmed",
    // Keep the epoch so the next /ulw does not reuse report-2.md.
    reportEpoch: s.reportEpoch,
  });
}
