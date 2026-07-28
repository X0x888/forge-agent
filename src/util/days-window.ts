/**
 * Shared day-window parsing for `forge stats --days` and `/stats`.
 * Keeps CLI and slash aliases from drifting.
 */

const DAY_ALIASES: Record<string, number> = {
  all: 0,
  any: 0,
  forever: 0,
  today: 1,
  day: 1,
  d: 1,
  week: 7,
  w: 7,
  month: 30,
  m: 30,
  quarter: 90,
  q: 90,
  year: 365,
  y: 365,
};

export type DaysWindowResult =
  | { ok: true; days: number }
  | { ok: false };

/**
 * Parse a stats window token.
 * - omit/empty → caller decides default (usually 0 = all time)
 * - all|week|month|today|7d|N → days
 */
export function parseDaysWindow(raw: unknown): DaysWindowResult {
  if (raw == null) return { ok: false };
  const s = String(raw).trim();
  if (!s) return { ok: false };
  const key = s.toLowerCase();
  if (key in DAY_ALIASES) {
    return { ok: true, days: DAY_ALIASES[key]! };
  }
  const md = /^(\d+)\s*d$/.exec(key);
  if (md) {
    const n = Number(md[1]);
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
      return { ok: false };
    }
    return { ok: true, days: n };
  }
  // plain integer (and --days=N form for slash)
  const m = /^(?:--days=)?(\d+)$/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
      return { ok: false };
    }
    return { ok: true, days: n };
  }
  return { ok: false };
}

export function daysWindowHelp(): string {
  return "non-negative integer, or all|week|month|today|7d";
}
