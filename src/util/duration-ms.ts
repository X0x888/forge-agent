/**
 * Parse human duration tokens to milliseconds.
 * Accepts plain ms integers and suffixes: 500ms, 30s, 1m, 2h.
 */
export type ParseDurationResult =
  | { ok: true; ms: number }
  | { ok: false };

export function parseDurationMs(raw: unknown): ParseDurationResult {
  if (raw == null) return { ok: false };
  const key = String(raw).trim().toLowerCase();
  if (!key) return { ok: false };
  if (/^\d+$/.test(key)) {
    const n = Number(key);
    if (!Number.isFinite(n) || n < 1) return { ok: false };
    return { ok: true, ms: Math.floor(n) };
  }
  const dur = key.match(/^(\d+(?:\.\d+)?)(ms|s|sec|secs|m|min|mins|h|hr|hrs)$/);
  if (!dur) return { ok: false };
  const n = Number(dur[1]);
  if (!Number.isFinite(n) || n <= 0) return { ok: false };
  const unit = dur[2]!;
  let ms = n;
  if (unit === "s" || unit === "sec" || unit === "secs") ms = n * 1000;
  else if (unit === "m" || unit === "min" || unit === "mins") ms = n * 60_000;
  else if (unit === "h" || unit === "hr" || unit === "hrs") ms = n * 3_600_000;
  // ms unit keeps n
  const floor = Math.floor(ms);
  if (floor < 1) return { ok: false };
  return { ok: true, ms: floor };
}
