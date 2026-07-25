/**
 * Small env parsers for operator knobs.
 * Invalid / missing values fall back so mis-set CI vars never crash the agent.
 */

/** Positive integer (≥1) from env, else fallback. */
export function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/** Non-negative integer (≥0) from env, else fallback. */
export function envNonNegInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}
