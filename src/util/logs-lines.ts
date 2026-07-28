/**
 * Shared logs line-count parsing for `forge logs -n` and `/logs`.
 * 0/all/max/full → entire read window; 1–200 recent events.
 */

export const LOGS_LINES_MAX = 200;

export type LogsLinesResult =
  | { ok: true; lines: number }
  | { ok: false };

/**
 * Parse a logs tail size token.
 * - omit/empty → caller default (usually 30)
 * - 0|all|max|full → 0 (full window)
 * - 1–200 → that many recent events
 */
export function parseLogsLines(raw: unknown): LogsLinesResult {
  if (raw == null) return { ok: false };
  const s = String(raw).trim();
  if (!s) return { ok: false };
  const key = s.toLowerCase();
  if (key === "all" || key === "max" || key === "full" || key === "--all") {
    return { ok: true, lines: 0 };
  }
  if (!/^\d+$/.test(key)) return { ok: false };
  const n = parseInt(key, 10);
  if (!Number.isFinite(n) || n < 0 || n > LOGS_LINES_MAX) {
    return { ok: false };
  }
  return { ok: true, lines: n };
}

export function logsLinesHelp(): string {
  return "0/all/max/full (window) or 1–200";
}
