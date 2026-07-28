/**
 * Strict truthy for tool/CLI args.
 * Models often emit `"false"` / `"0"` as strings — `Boolean("false")` is true in JS.
 * Only explicit true-ish scalars count.
 */
export function isTruthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}
