/**
 * Strict truthy for tool/CLI args.
 * Models often emit `"false"` / `"0"` as strings — `Boolean("false")` is true in JS.
 * Only explicit true-ish scalars count.
 */
export function isTruthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes" || s === "on";
  }
  return false;
}

/**
 * Explicit false-ish scalars (including the string `"false"` / `"0"` trap).
 * Useful for non-negotiable defaults like blockingStopHooks where a stringy
 * false must still count as off.
 */
export function isFalsy(v: unknown): boolean {
  if (v === false || v === 0) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return (
      s === "false" ||
      s === "0" ||
      s === "no" ||
      s === "off" ||
      s === "disabled"
    );
  }
  return false;
}

/** Coerce unknown config/CLI values to boolean; nullish stays undefined. */
export function coerceBool(v: unknown): boolean | undefined {
  if (v == null || v === "") return undefined;
  if (isTruthy(v)) return true;
  if (isFalsy(v)) return false;
  return undefined;
}
