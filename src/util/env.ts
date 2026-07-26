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

/**
 * Parse a CLI `--keep` style count.
 * Unlike `Number(x) || fallback`, **0 is valid** (keep nothing / clear).
 * NaN, negative, empty → fallback.
 */
export function parseKeepCount(
  raw: unknown,
  fallback: number,
): number {
  if (raw == null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** Default foreground bash timeout (ms). Min 5s, max 30m. */
export function defaultBashTimeoutMs(): number {
  const n = envPositiveInt("FORGE_BASH_TIMEOUT_MS", 120_000);
  return Math.min(30 * 60_000, Math.max(5_000, n));
}

/** Default background bash task timeout (ms). Min 30s, max 6h. */
export function defaultBashBackgroundTimeoutMs(): number {
  const n = envPositiveInt("FORGE_BASH_BG_TIMEOUT_MS", 30 * 60_000);
  return Math.min(6 * 60 * 60_000, Math.max(30_000, n));
}
