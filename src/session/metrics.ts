/**
 * Append-only session metrics for experts / CI post-mortems.
 * Never logs secrets or full prompts — counters and durations only.
 */
import fs from "node:fs";
import path from "node:path";
import { forgeHome, ensureDir, nowIso } from "../util/fs.js";
import { estimateCostUsd } from "../util/format.js";

export interface SessionMetricsEvent {
  ts: string;
  type: "run_end" | "session_end";
  sessionId: string;
  provider?: string;
  model?: string;
  cwd?: string;
  turns?: number;
  stopContinues?: number;
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
  editCount: number;
  promptTokens: number;
  completionTokens: number;
  durationMs?: number;
  aborted?: boolean;
  timedOut?: boolean;
  ok?: boolean;
  headless?: boolean;
  ultrawork?: boolean;
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
    editCount: opts.editCount,
    promptTokens: opts.promptTokens,
    completionTokens: opts.completionTokens,
    estCostUsd: estimateCostUsd(
      opts.provider,
      opts.promptTokens,
      opts.completionTokens,
    ),
    durationMs: opts.durationMs,
    aborted: opts.aborted,
    timedOut: opts.timedOut,
    ok: opts.ok,
    headless: opts.headless,
    ultrawork: opts.ultrawork,
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
