/**
 * Append-only session metrics for experts / CI post-mortems.
 * Never logs secrets or full prompts — counters and durations only.
 */
import fs from "node:fs";
import path from "node:path";
import { forgeHome, ensureDir, nowIso } from "../util/fs.js";
import { estimateCostUsd, formatCost, formatTokens } from "../util/format.js";
import { isLastErrorProblem } from "./last-error.js";

export interface SessionMetricsEvent {
  ts: string;
  type: "run_end" | "session_end" | "provider_round";
  sessionId: string;
  provider?: string;
  model?: string;
  cwd?: string;
  turns?: number;
  stopContinues?: number;
  /** True when the agent loop released because the stop-continue cap was hit. */
  releasedOnContinueCap?: boolean;
  /** True when the agent loop exited because maxTurns was reached. */
  hitMaxTurns?: boolean;
  /** True when the agent loop released because maxCostUsd was reached. */
  hitCostCap?: boolean;
  /** True when ULW or /goal stuck-wall released the cycle. */
  stuckReleased?: boolean;
  /** True when ULW released on evidenced Cycle complete after LAST. */
  lastCycleReleased?: boolean;
  editCount?: number;
  /** Last structural verification bash command (truncated). */
  lastVerificationCommand?: string | null;
  lastVerificationAt?: string | null;
  lastEditAt?: string | null;
  lastVerificationStale?: boolean | null;
  promptTokens?: number;
  completionTokens?: number;
  /** Provider-reported cached-input tokens for this run (0 = unreported). */
  cacheReadTokens?: number;
  /** cache_read / prompt (provider_round or last round on run_end). */
  cacheRatio?: number;
  lastRoundPromptTokens?: number;
  lastRoundCacheReadTokens?: number;
  /** True when this outbound request was request-pruned. */
  pruned?: boolean;
  /** first_clip | sticky | reclip | always — how the wire was slimmed. */
  pruneKind?: string;
  /** True when cacheRatio fell below 5% after a prior round above 90%. */
  cacheDrop?: boolean;
  /** Distinct served models that diverged from the requested one this run. */
  servedModels?: string[];
  /** Harness-as-second-user meters (this run). */
  harnessUserPokes?: number;
  admitCount?: number;
  proofPokes?: number;
  /**
   * Stop-guard blocks and harness bounces by guard (`handoff`, `proofClaim`,
   * `report`, `todoGate`, `goal`, `ulw`, `hook`, `verify`, `fix`, …). Only
   * non-zero keys are written. The per-guard cost of the harness.
   */
  guardBlocks?: Record<string, number>;
  providerRounds?: number;
  estCostUsd?: number;
  durationMs?: number;
  aborted?: boolean;
  timedOut?: boolean;
  ok?: boolean;
  headless?: boolean;
  ultrawork?: boolean;
  /** Provider/run failure code when ok=false (never full bodies). */
  lastErrorCode?: string;
}

/** Run-level events (`run_end` / `session_end`) — what `forge stats` reads. */
export function metricsPath(): string {
  return path.join(forgeHome(), "metrics.jsonl");
}

/**
 * Per-provider-round events (`provider_round`). Kept apart from
 * `metrics.jsonl` on purpose: one ULW run writes hundreds of rounds, and
 * while both shared a 2,000-line file the auto-prune evicted every
 * `run_end` within a day — the run-level history `forge stats` reports on
 * was silently the last few hours.
 */
export function roundsPath(): string {
  return path.join(forgeHome(), "rounds.jsonl");
}

/** Soft cap — auto-prune when event count exceeds this after append. */
export const METRICS_AUTO_PRUNE_KEEP = 2_000;
/** Rounds are ~10× more frequent than runs and only matter for recent cache forensics. */
export const ROUNDS_AUTO_PRUNE_KEEP = 5_000;

function appendJsonlLine(file: string, event: SessionMetricsEvent): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(event) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

/** Cheap size check: prune the file to the newest `keep` lines when large. */
function maybeAutoPrune(file: string, keep: number): void {
  try {
    const st = fs.statSync(file);
    // ~200 bytes/line → 2000 lines ≈ 400KB; also hard-cap at 2 MiB
    if (st.size > 2 * 1024 * 1024) {
      pruneJsonl(file, keep);
    } else if (st.size > 400_000) {
      const n = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim()).length;
      if (n > keep) pruneJsonl(file, keep);
    }
  } catch {
    /* non-fatal */
  }
}

export function appendSessionMetrics(event: SessionMetricsEvent): void {
  try {
    const isRound = event.type === "provider_round";
    const file = isRound ? roundsPath() : metricsPath();
    appendJsonlLine(file, event);
    // Per-session copy — global prune dropped log10's first four hours.
    if (event.sessionId) {
      try {
        const dir = path.join(forgeHome(), "sessions", event.sessionId);
        appendJsonlLine(path.join(dir, "rounds.jsonl"), event);
      } catch {
        /* sidecar optional */
      }
    }
    maybeAutoPrune(
      file,
      isRound ? ROUNDS_AUTO_PRUNE_KEEP : METRICS_AUTO_PRUNE_KEEP,
    );
  } catch {
    /* never fail the agent on metrics I/O */
  }
}

export function buildRunEndMetrics(opts: {
  sessionId: string;
  provider: string;
  model: string;
  cwd?: string;
  turns: number;
  stopContinues: number;
  releasedOnContinueCap?: boolean;
  hitMaxTurns?: boolean;
  hitCostCap?: boolean;
  stuckReleased?: boolean;
  lastCycleReleased?: boolean;
  editCount: number;
  lastVerificationCommand?: string | null;
  lastVerificationAt?: string | null;
  lastEditAt?: string | null;
  lastVerificationStale?: boolean | null;
  promptTokens: number;
  completionTokens: number;
  /** Provider-reported cached-input tokens for this run (0 = unreported). */
  cacheReadTokens?: number;
  lastRoundPromptTokens?: number;
  lastRoundCacheReadTokens?: number;
  lastRoundCacheRatio?: number;
  /** Distinct served models that diverged from the requested one this run. */
  servedModels?: string[];
  harnessUserPokes?: number;
  admitCount?: number;
  proofPokes?: number;
  guardBlocks?: Record<string, number>;
  providerRounds?: number;
  durationMs?: number;
  aborted?: boolean;
  timedOut?: boolean;
  ok?: boolean;
  headless?: boolean;
  ultrawork?: boolean;
  lastErrorCode?: string;
}): SessionMetricsEvent {
  const guardBlocks = compactGuardBlocks(opts.guardBlocks);
  return {
    ts: nowIso(),
    type: "run_end",
    sessionId: opts.sessionId,
    provider: opts.provider,
    model: opts.model,
    cwd: opts.cwd,
    turns: opts.turns,
    stopContinues: opts.stopContinues,
    ...(opts.releasedOnContinueCap
      ? { releasedOnContinueCap: true }
      : {}),
    ...(opts.hitMaxTurns ? { hitMaxTurns: true } : {}),
    ...(opts.hitCostCap ? { hitCostCap: true } : {}),
    ...(opts.stuckReleased ? { stuckReleased: true } : {}),
    ...(opts.lastCycleReleased ? { lastCycleReleased: true } : {}),
    editCount: opts.editCount,
    ...(opts.lastVerificationCommand
      ? { lastVerificationCommand: opts.lastVerificationCommand }
      : {}),
    ...(opts.lastVerificationAt
      ? { lastVerificationAt: opts.lastVerificationAt }
      : {}),
    ...(opts.lastEditAt ? { lastEditAt: opts.lastEditAt } : {}),
    ...(opts.lastVerificationStale
      ? { lastVerificationStale: true }
      : {}),
    promptTokens: opts.promptTokens,
    completionTokens: opts.completionTokens,
    ...(opts.cacheReadTokens
      ? { cacheReadTokens: opts.cacheReadTokens }
      : {}),
    ...(opts.lastRoundPromptTokens
      ? { lastRoundPromptTokens: opts.lastRoundPromptTokens }
      : {}),
    ...(opts.lastRoundCacheReadTokens
      ? { lastRoundCacheReadTokens: opts.lastRoundCacheReadTokens }
      : {}),
    ...(opts.lastRoundCacheRatio != null
      ? {
          lastRoundCacheRatio: opts.lastRoundCacheRatio,
          cacheRatio: opts.lastRoundCacheRatio,
        }
      : {}),
    ...(opts.servedModels?.length
      ? { servedModels: opts.servedModels }
      : {}),
    ...(opts.harnessUserPokes
      ? { harnessUserPokes: opts.harnessUserPokes }
      : {}),
    ...(opts.admitCount ? { admitCount: opts.admitCount } : {}),
    ...(opts.proofPokes ? { proofPokes: opts.proofPokes } : {}),
    ...(guardBlocks ? { guardBlocks } : {}),
    ...(opts.providerRounds
      ? { providerRounds: opts.providerRounds }
      : {}),
    estCostUsd: estimateCostUsd(
      opts.provider,
      opts.promptTokens,
      opts.completionTokens,
      opts.model,
      opts.cacheReadTokens ?? 0,
    ),
    durationMs: opts.durationMs,
    aborted: opts.aborted,
    timedOut: opts.timedOut,
    ok: opts.ok,
    headless: opts.headless,
    ultrawork: opts.ultrawork,
    ...(opts.lastErrorCode
      ? { lastErrorCode: String(opts.lastErrorCode).slice(0, 64) }
      : {}),
  };
}

/** Drop zero / non-numeric entries; undefined when nothing is left. */
function compactGuardBlocks(
  rec: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!rec) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[k.slice(0, 32)] = Math.trunc(n);
  }
  return Object.keys(out).length ? out : undefined;
}

export interface MetricsStats {
  events: number;
  bytes: number;
  path: string;
  /** `rounds.jsonl` (provider_round events) — absent when never written. */
  rounds?: { events: number; bytes: number; path: string };
}

function countJsonl(file: string): { events: number; bytes: number } {
  try {
    if (!fs.existsSync(file)) return { events: 0, bytes: 0 };
    const st = fs.statSync(file);
    const raw = fs.readFileSync(file, "utf8");
    const events = raw.split("\n").filter((l) => l.trim()).length;
    return { events, bytes: st.size };
  } catch {
    return { events: 0, bytes: 0 };
  }
}

export function metricsStats(): MetricsStats {
  const file = metricsPath();
  const main = countJsonl(file);
  const rfile = roundsPath();
  const rounds = fs.existsSync(rfile)
    ? { ...countJsonl(rfile), path: rfile }
    : undefined;
  return { ...main, path: file, ...(rounds ? { rounds } : {}) };
}

export interface PruneMetricsResult {
  beforeEvents: number;
  afterEvents: number;
  deleted: number;
  kept: number;
  path: string;
  /** Same prune applied to `rounds.jsonl` (when it exists). */
  rounds?: Omit<PruneMetricsResult, "rounds">;
}

/**
 * Keep the newest N metrics lines (default 500). Counter-only log hygiene.
 * `rounds.jsonl` gets the same cut (it is the larger file; `forge metrics
 * prune` must not leave the round log growing unbounded).
 */
export function pruneMetrics(opts?: { keep?: number }): PruneMetricsResult {
  const keep = Math.max(1, opts?.keep ?? 500);
  const main = pruneJsonl(metricsPath(), keep);
  const rfile = roundsPath();
  if (fs.existsSync(rfile)) {
    return { ...main, rounds: pruneJsonl(rfile, keep) };
  }
  return main;
}

function pruneJsonl(
  file: string,
  keep: number,
): Omit<PruneMetricsResult, "rounds"> {
  const empty: Omit<PruneMetricsResult, "rounds"> = {
    beforeEvents: 0,
    afterEvents: 0,
    deleted: 0,
    kept: 0,
    path: file,
  };
  try {
    if (!fs.existsSync(file)) return empty;
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const before = lines.length;
    if (before <= keep) {
      return {
        beforeEvents: before,
        afterEvents: before,
        deleted: 0,
        kept: before,
        path: file,
      };
    }
    const keptLines = lines.slice(-keep);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, keptLines.join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* */
    }
    return {
      beforeEvents: before,
      afterEvents: keptLines.length,
      deleted: before - keptLines.length,
      kept: keptLines.length,
      path: file,
    };
  } catch {
    return empty;
  }
}

/** Read metrics events newest-last (file order). Best-effort; skips bad lines. */
export function readMetricsEvents(opts?: {
  limit?: number;
}): SessionMetricsEvent[] {
  const file = metricsPath();
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const limit =
      typeof opts?.limit === "number" &&
      Number.isFinite(opts.limit) &&
      opts.limit > 0
        ? Math.floor(opts.limit)
        : lines.length;
    const slice = lines.slice(-limit);
    const out: SessionMetricsEvent[] = [];
    for (const line of slice) {
      try {
        const ev = JSON.parse(line) as SessionMetricsEvent;
        if (ev && typeof ev === "object" && ev.ts) out.push(ev);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface UsageStats {
  generatedAt: string;
  metricsPath: string;
  /** Events considered (after days filter). */
  events: number;
  /** Window in days (0 = all). */
  days: number;
  runs: number;
  okRuns: number;
  /** Runs with ok=false (provider/run failures). */
  failedRuns: number;
  abortedRuns: number;
  timedOutRuns: number;
  /** Runs that hit the stop-continue safety valve (length/filter/empty/Stop-block). */
  continueCapReleases: number;
  /** Runs that exited because maxTurns was reached. */
  maxTurnsHits: number;
  /** Runs that released because maxCostUsd was reached. */
  costCapHits: number;
  /** Runs that released on ULW/goal stuck-wall. */
  stuckWallHits: number;
  /** Runs that released on ULW Cycle complete after LAST. */
  cycleCompleteReleases: number;
  headlessRuns: number;
  ulwRuns: number;
  promptTokens: number;
  completionTokens: number;
  estCostUsd: number;
  durationMs: number;
  turns: number;
  edits: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  /** Top workspaces by run count (basename → count). */
  byProject: Record<string, number>;
  /** Failure codes from run_end.lastErrorCode (never bodies). */
  byLastErrorCode: Record<string, number>;
  /**
   * Harness overhead across the window: how much of the conversation the
   * harness itself spoke, and which guard bounced the model how often.
   */
  harness: {
    /** Provider rounds summed over runs that reported them. */
    providerRounds: number;
    /** Every Forge-injected user-channel message. */
    pokes: number;
    proofPokes: number;
    /** Runs whose run_end carried the meters (older records did not). */
    meteredRuns: number;
    /** Guard id → total blocks across the window. */
    guardBlocks: Record<string, number>;
  };
  /** On-disk session inventory (not limited to metrics window). */
  sessions: {
    total: number;
    locked: number;
    titled: number;
    ultrawork: number;
    /** Pin-protected sessions (survive prune). */
    pinned: number;
    /** Sessions with meta.lastError set (recovery backlog). */
    withLastError: number;
  };
}

/**
 * Aggregate counter-only usage for experts (`forge stats` / `/stats`).
 * Never includes prompts or secrets.
 */
export function collectUsageStats(opts?: {
  days?: number;
  /** Max metrics lines to scan (default 5000). */
  limit?: number;
}): UsageStats {
  const days =
    typeof opts?.days === "number" && Number.isFinite(opts.days) && opts.days > 0
      ? opts.days
      : 0;
  const cutoff =
    days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  const events = readMetricsEvents({ limit: opts?.limit ?? 5_000 });
  const filtered = cutoff
    ? events.filter((e) => {
        const t = Date.parse(e.ts || "");
        return Number.isFinite(t) && t >= cutoff;
      })
    : events;

  const byProvider: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  let runs = 0;
  let okRuns = 0;
  let failedRuns = 0;
  let abortedRuns = 0;
  let timedOutRuns = 0;
  let continueCapReleases = 0;
  let maxTurnsHits = 0;
  let costCapHits = 0;
  let stuckWallHits = 0;
  let cycleCompleteReleases = 0;
  let headlessRuns = 0;
  let ulwRuns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let estCostUsd = 0;
  let durationMs = 0;
  let turns = 0;
  let edits = 0;
  const byLastErrorCode: Record<string, number> = {};
  let hProviderRounds = 0;
  let hPokes = 0;
  let hProofPokes = 0;
  let hMeteredRuns = 0;
  const hGuardBlocks: Record<string, number> = {};

  for (const e of filtered) {
    if (e.type !== "run_end" && e.type !== "session_end") continue;
    runs += 1;
    if (
      e.harnessUserPokes != null ||
      e.providerRounds != null ||
      e.guardBlocks
    ) {
      hMeteredRuns += 1;
      hProviderRounds += Number(e.providerRounds) || 0;
      hPokes += Number(e.harnessUserPokes) || 0;
      hProofPokes += Number(e.proofPokes) || 0;
      if (e.guardBlocks && typeof e.guardBlocks === "object") {
        for (const [k, v] of Object.entries(e.guardBlocks)) {
          const n = Number(v) || 0;
          if (n > 0) hGuardBlocks[k] = (hGuardBlocks[k] || 0) + n;
        }
      }
    }
    if (e.ok) okRuns += 1;
    else if (e.ok === false) failedRuns += 1;
    if (e.aborted) abortedRuns += 1;
    if (e.timedOut) timedOutRuns += 1;
    if (e.releasedOnContinueCap) continueCapReleases += 1;
    if (e.hitMaxTurns) maxTurnsHits += 1;
    if (e.hitCostCap) costCapHits += 1;
    if (e.stuckReleased) stuckWallHits += 1;
    if (e.lastCycleReleased) cycleCompleteReleases += 1;
    if (e.headless) headlessRuns += 1;
    if (e.ultrawork) ulwRuns += 1;
    promptTokens += Number(e.promptTokens) || 0;
    completionTokens += Number(e.completionTokens) || 0;
    estCostUsd += Number(e.estCostUsd) || 0;
    durationMs += Number(e.durationMs) || 0;
    turns += Number(e.turns) || 0;
    edits += Number(e.editCount) || 0;
    const prov = (e.provider || "unknown").slice(0, 40);
    byProvider[prov] = (byProvider[prov] || 0) + 1;
    const model = (e.model || "unknown").slice(0, 64);
    byModel[model] = (byModel[model] || 0) + 1;
    if (e.lastErrorCode) {
      const code = String(e.lastErrorCode).slice(0, 64);
      byLastErrorCode[code] = (byLastErrorCode[code] || 0) + 1;
    }
    if (e.cwd) {
      try {
        const base = path.basename(path.resolve(e.cwd)).slice(0, 48) || e.cwd;
        byProject[base] = (byProject[base] || 0) + 1;
      } catch {
        /* */
      }
    }
  }

  // Session inventory (sidecar meta — fast)
  let sessionTotal = 0;
  let sessionLocked = 0;
  let sessionTitled = 0;
  let sessionUlw = 0;
  let sessionPinned = 0;
  let sessionWithLastError = 0;
  try {
    // Dynamic import avoided — listSessions is same package tree but metrics
    // must not create a hard cycle. Inline a light scan of meta.json only.
    const root = path.join(forgeHome(), "sessions");
    if (fs.existsSync(root)) {
      for (const id of fs.readdirSync(root)) {
        const dir = path.join(root, id);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
          const metaPath = path.join(dir, "meta.json");
          if (!fs.existsSync(metaPath)) continue;
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
            title?: string;
            ultrawork?: boolean;
            pinned?: boolean;
            lastError?: { message?: string };
          };
          sessionTotal += 1;
          if (meta.title) sessionTitled += 1;
          if (meta.ultrawork) sessionUlw += 1;
          if (meta.pinned) sessionPinned += 1;
          if (isLastErrorProblem(meta.lastError)) sessionWithLastError += 1;
          const lockPath = path.join(dir, "session.lock");
          if (fs.existsSync(lockPath)) {
            try {
              const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
                pid?: unknown;
              };
              const pid = Number(lock?.pid);
              if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
                try {
                  process.kill(Math.trunc(pid), 0);
                  sessionLocked += 1;
                } catch (err) {
                  // EPERM = alive but owned by another user — still locked
                  // (matches lock.ts pidAlive / sessionHasForeignLiveLock).
                  if (
                    typeof err === "object" &&
                    err !== null &&
                    (err as NodeJS.ErrnoException).code === "EPERM"
                  ) {
                    sessionLocked += 1;
                  }
                }
              }
            } catch {
              /* */
            }
          }
        } catch {
          /* skip dir */
        }
      }
    }
  } catch {
    /* */
  }

  return {
    generatedAt: nowIso(),
    metricsPath: metricsPath(),
    events: filtered.length,
    days,
    runs,
    okRuns,
    failedRuns,
    abortedRuns,
    timedOutRuns,
    continueCapReleases,
    maxTurnsHits,
    costCapHits,
    stuckWallHits,
    cycleCompleteReleases,
    headlessRuns,
    ulwRuns,
    promptTokens,
    completionTokens,
    estCostUsd,
    durationMs,
    turns,
    edits,
    byProvider,
    byModel,
    byProject,
    byLastErrorCode,
    harness: {
      providerRounds: hProviderRounds,
      pokes: hPokes,
      proofPokes: hProofPokes,
      meteredRuns: hMeteredRuns,
      guardBlocks: hGuardBlocks,
    },
    sessions: {
      total: sessionTotal,
      locked: sessionLocked,
      titled: sessionTitled,
      ultrawork: sessionUlw,
      pinned: sessionPinned,
      withLastError: sessionWithLastError,
    },
  };
}

/** Human-readable multi-line stats report. */
export function formatUsageStats(stats: UsageStats): string {
  const top = (rec: Record<string, number>, n = 5): string => {
    const entries = Object.entries(rec).sort((a, b) => b[1] - a[1]).slice(0, n);
    if (!entries.length) return "  (none)";
    return entries.map(([k, v]) => `  ${k}: ${v}`).join("\n");
  };
  const window =
    stats.days > 0 ? `last ${stats.days}d` : "all recorded metrics";
  const okPct =
    stats.runs > 0 ? Math.round((stats.okRuns / stats.runs) * 100) : 0;
  const durMin = stats.durationMs / 60_000;
  const h = stats.harness;
  const harnessLine = (() => {
    if (!h || !h.meteredRuns) {
      return `  harness:    (no metered runs — meters ride run_end from v0.9.x on)`;
    }
    const share =
      h.providerRounds > 0
        ? ` (${Math.round((h.pokes / h.providerRounds) * 100)}% of ${h.providerRounds} rounds)`
        : "";
    const guards = Object.entries(h.guardBlocks)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    return `  harness:    pokes=${h.pokes}${share}  proof=${h.proofPokes}  blocks: ${guards || "none"}  · ${h.meteredRuns}/${stats.runs} runs metered`;
  })();
  return [
    `Forge usage (${window})`,
    `  runs:       ${stats.runs}  ok=${stats.okRuns} (${okPct}%)  failed=${stats.failedRuns}  aborted=${stats.abortedRuns}  timedOut=${stats.timedOutRuns}  continueCap=${stats.continueCapReleases}  maxTurns=${stats.maxTurnsHits}  costCap=${stats.costCapHits}  stuckWall=${stats.stuckWallHits}  cycleComplete=${stats.cycleCompleteReleases}`,
    `  mode:       headless=${stats.headlessRuns}  ULW=${stats.ulwRuns}`,
    `  tokens:     in=${formatTokens(stats.promptTokens)} out=${formatTokens(stats.completionTokens)}  est ${formatCost(stats.estCostUsd)}`,
    `  work:       turns=${stats.turns}  edits=${stats.edits}  wall≈${durMin.toFixed(1)}m`,
    harnessLine,
    `  sessions:   ${stats.sessions.total} on disk  titled=${stats.sessions.titled}  ULW=${stats.sessions.ultrawork}  pinned=${stats.sessions.pinned}  lastError=${stats.sessions.withLastError}  locked=${stats.sessions.locked}`,
    `By provider:`,
    top(stats.byProvider),
    `By model:`,
    top(stats.byModel),
    `By project:`,
    top(stats.byProject),
    Object.keys(stats.byLastErrorCode).length
      ? `By lastError code:\n${top(stats.byLastErrorCode)}`
      : null,
    `  metrics: ${stats.events} events · ${stats.metricsPath}`,
  ]
    .filter((x): x is string => x != null)
    .join("\n");
}
