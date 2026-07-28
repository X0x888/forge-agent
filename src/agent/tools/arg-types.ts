/**
 * Shared tool-arg type guards — fail closed with clear messages
 * instead of String(object) → "[object Object]" in error text.
 */

export function nonStringKind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** When a string field is present but not a string. */
export function stringFieldError(
  tool: string,
  field: string,
  value: unknown,
  hint?: string,
): string {
  const base = `${tool} error: ${field} must be a string (got ${nonStringKind(value)}).`;
  return hint ? `${base} ${hint}` : base;
}

/** When a numeric field is present but not a finite number or numeric string. */
export function numberFieldError(
  tool: string,
  field: string,
  value: unknown,
  hint: string,
): string {
  if (value !== null && typeof value === "object") {
    return `${tool} error: ${field} must be a number (got ${nonStringKind(value)}). ${hint}`;
  }
  return `${tool} error: invalid ${field} "${value}". ${hint}`;
}
