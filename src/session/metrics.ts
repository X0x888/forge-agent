/**
 * Append-only session metrics for experts / CI post-mortems.
 * Never logs secrets or full prompts — counters and durations only.
 */
import fs from "node:fs";
import path from "node:path";
import { forgeHome, ensureDir, nowIso } from "../util/fs.js";
import { estimateCostUsd, formatCost, formatTokens } from "../util/format.js";

export interface SessionMetricsEvent {
  ts: string;
  type: "run_end" | "session_end";
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
  editCount?: number;
  promptTokens?: number;
  completionTokens?: number;
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

export function metricsPath(): string {
  return path.join(forgeHome(), "metrics.jsonl");
}

/** Soft cap — auto-prune when event count exceeds this after append. */
export const METRICS_AUTO_PRUNE_KEEP = 2_000;

export function appendSessionMetrics(event: SessionMetricsEvent): void {
  try {
    const file = metricsPath();
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(event) + "\n", { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* windows */
    }
    // Cheap size check: if file is large, prune to keep newest N
    try {
      const st = fs.statSync(file);
      // ~200 bytes/line → 2000 lines ≈ 400KB; also hard-cap at 2 MiB
      if (st.size > 2 * 1024 * 1024) {
        pruneMetrics({ keep: METRICS_AUTO_PRUNE_KEEP });
      } else if (st.size > 400_000) {
        // Count lines only when moderately large
        const n = fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l.trim()).length;
        if (n > METRICS_AUTO_PRUNE_KEEP) {
          pruneMetrics({ keep: METRICS_AUTO_PRUNE_KEEP });
        }
      }
    } catch {
      /* non-fatal */
    }
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
  editCount: number;
  promptTokens: number;
  completionTokens: number;
  durationMs?: number;
  aborted?: boolean;
  timedOut?: boolean;
  ok?: boolean;
  headless?: boolean;
  ultrawork?: boolean;
  lastErrorCode?: string;
}): SessionMetricsEvent {
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
    editCount: opts.editCount,
    promptTokens: opts.promptTokens,
    completionTokens: opts.completionTokens,
    estCostUsd: estimateCostUsd(
      opts.provider,
      opts.promptTokens,
      opts.completionTokens,
      opts.model,
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

export interface MetricsStats {
  events: number;
  bytes: number;
  path: string;
}

export function metricsStats(): MetricsStats {
  const file = metricsPath();
  try {
    if (!fs.existsSync(file)) return { events: 0, bytes: 0, path: file };
    const st = fs.statSync(file);
    const raw = fs.readFileSync(file, "utf8");
    const events = raw.split("\n").filter((l) => l.trim()).length;
    return { events, bytes: st.size, path: file };
  } catch {
    return { events: 0, bytes: 0, path: file };
  }
}

export interface PruneMetricsResult {
  beforeEvents: number;
  afterEvents: number;
  deleted: number;
  kept: number;
  path: string;
}

/**
 * Keep the newest N metrics lines (default 500). Counter-only log hygiene.
 */
export function pruneMetrics(opts?: { keep?: number }): PruneMetricsResult {
  const file = metricsPath();
  const keep = Math.max(1, opts?.keep ?? 500);
  const empty: PruneMetricsResult = {
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
  let headlessRuns = 0;
  let ulwRuns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let estCostUsd = 0;
  let durationMs = 0;
  let turns = 0;
  let edits = 0;
  const byLastErrorCode: Record<string, number> = {};

  for (const e of filtered) {
    if (e.type !== "run_end" && e.type !== "session_end") continue;
    runs += 1;
    if (e.ok) okRuns += 1;
    else if (e.ok === false) failedRuns += 1;
    if (e.aborted) abortedRuns += 1;
    if (e.timedOut) timedOutRuns += 1;
    if (e.releasedOnContinueCap) continueCapReleases += 1;
    if (e.hitMaxTurns) maxTurnsHits += 1;
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
          if (meta.lastError?.message) sessionWithLastError += 1;
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
                } catch {
                  /* dead */
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
  return [
    `Forge usage (${window})`,
    `  runs:       ${stats.runs}  ok=${stats.okRuns} (${okPct}%)  failed=${stats.failedRuns}  aborted=${stats.abortedRuns}  timedOut=${stats.timedOutRuns}  continueCap=${stats.continueCapReleases}  maxTurns=${stats.maxTurnsHits}`,
    `  mode:       headless=${stats.headlessRuns}  ULW=${stats.ulwRuns}`,
    `  tokens:     in=${formatTokens(stats.promptTokens)} out=${formatTokens(stats.completionTokens)}  est ${formatCost(stats.estCostUsd)}`,
    `  work:       turns=${stats.turns}  edits=${stats.edits}  wall≈${durMin.toFixed(1)}m`,
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
