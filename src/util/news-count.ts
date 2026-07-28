/**
 * Shared news count parsing for `forge news` and `/news`.
 * Keeps CLI and slash aliases from drifting.
 */

const NEWS_ALIASES: Record<string, number> = {
  all: 10,
  full: 10,
  max: 10,
  latest: 1,
};

export const NEWS_COUNT_MIN = 1;
export const NEWS_COUNT_MAX = 10;

export type NewsCountResult =
  | { ok: true; count: number }
  | { ok: false };

/**
 * Parse a news release count token.
 * - omit/empty → caller default (usually 1)
 * - all|full|max → 10, latest → 1, N → N (1–10)
 */
export function parseNewsCount(raw: unknown): NewsCountResult {
  if (raw == null) return { ok: false };
  const s = String(raw).trim();
  if (!s) return { ok: false };
  const key = s.toLowerCase().replace(/^--count=/, "");
  if (key in NEWS_ALIASES) {
    return { ok: true, count: NEWS_ALIASES[key]! };
  }
  if (!/^\d+$/.test(key)) return { ok: false };
  const n = parseInt(key, 10);
  if (!Number.isFinite(n) || n < NEWS_COUNT_MIN || n > NEWS_COUNT_MAX) {
    return { ok: false };
  }
  return { ok: true, count: n };
}

export function newsCountHelp(): string {
  return "integer 1–10, or all|full|max|latest";
}
