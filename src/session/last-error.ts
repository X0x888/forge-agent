/**
 * lastError is a stop-reason bag: provider failures AND successful wraps.
 * Human cards (status / sessions / HUD ERR / prune) must not treat a
 * finished ULW cycle as a crash.
 */

/** Codes that mean the run ended as designed — keep on meta, not as lastErr. */
export const LAST_ERROR_OUTCOME_CODES = new Set(["ulw_cycle_complete"]);

export function isLastErrorProblem(
  err?: { code?: string; message?: string } | null,
): boolean {
  if (!err) return false;
  const code = String(err.code || "").trim();
  if (LAST_ERROR_OUTCOME_CODES.has(code)) return false;
  return Boolean(code || String(err.message || "").trim());
}
