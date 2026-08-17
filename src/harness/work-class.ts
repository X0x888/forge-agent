/**
 * Work-class / schema detection for unlimited ULW.
 *
 * Token-overlap same-surface missed the maze mill: rotating nouns
 * (brazier / moss / pot) on one schema (adjacent partner, far stays).
 * This module names that schema and a factory fingerprint so a hold
 * can fire without a wave cap.
 */

/** Adjacent-share schema: 3 of last 5 → treat as same surface. */
export const SCHEMA_LOOKBACK = 5;
/** One prior same-schema ship is enough to call this closer "same". */
export const SCHEMA_HOLD_HITS = 1;
/** Factory class: 5 of last 8 (including the closer) → hold. */
export const FACTORY_LOOKBACK = 8;
export const FACTORY_HOLD_HITS = 5;

const LAST_SHIP_WAS_RE = /\blast ship was\b/i;
const STILL_HARD_RE = /\b(?:what(?:'s| is) still hard|still hard is)\b/i;
const FAR_STAYS_RE =
  /\bfar stays\b|\bfar still\b|\bfar partner\b|\bfar waits\b/i;
const BESIDE_RE =
  /\bbeside (?:you|them|their|the other|a (?:downed |fallen )?(?:partner|body|walker))\b|\badjacent (?:partner|walker|body)\b|\bstood beside\b|\bstand beside\b/i;
const BOTH_RE =
  /\byou both\b|\bboth of you\b|\blights you both\b|\bcovers (?:you|them) both\b|\bboth (?:books|hearts|bags|names|of you)\b/i;
const SHARE_BOTH_RE =
  /\bshare(?:s|d)? (?:the |it |them )?(?:with )?(?:them|you both|the (?:one|partner) beside)\b/i;

export type WorkSchema = "adjacent-share" | "factory";

export function isFactoryFingerprint(text: string): boolean {
  const t = text || "";
  if (!t.trim()) return false;
  const last = LAST_SHIP_WAS_RE.test(t);
  const hard = STILL_HARD_RE.test(t);
  const far = FAR_STAYS_RE.test(t);
  // Mill closer: "Last ship was X. What's still hard is Y. Far stays."
  if (last && (hard || far)) return true;
  if (hard && far && BESIDE_RE.test(t)) return true;
  return false;
}

export function isAdjacentShareSchema(text: string): boolean {
  const t = text || "";
  if (!t.trim()) return false;
  // After summarizeWave the mill closer is often just "Far stays the walker's."
  if (FAR_STAYS_RE.test(t)) return true;
  let n = 0;
  if (BESIDE_RE.test(t)) n += 1;
  if (BOTH_RE.test(t) || SHARE_BOTH_RE.test(t)) n += 1;
  return n >= 2;
}

export function shipSchema(text: string): WorkSchema | undefined {
  // Factory is the tighter mill closer; adjacent-share is the theme.
  if (isFactoryFingerprint(text)) return "factory";
  if (isAdjacentShareSchema(text)) return "adjacent-share";
  return undefined;
}

export function sameWorkSchema(a: string, b: string): boolean {
  const sa = shipSchema(a);
  const sb = shipSchema(b);
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  // Rotating nouns walk factory ↔ adjacent-share as one class.
  return (
    (sa === "factory" || sa === "adjacent-share") &&
    (sb === "factory" || sb === "adjacent-share")
  );
}

export function schemaHitsIn(
  prevSummaries: string[],
  closer: string,
  lookback = SCHEMA_LOOKBACK,
): number {
  const schema = shipSchema(closer);
  if (!schema) return 0;
  const recent = (prevSummaries || [])
    .filter((s) => s && s.trim())
    .slice(-lookback);
  return recent.filter((s) => {
    const other = shipSchema(s);
    if (!other) return false;
    if (other === schema) return true;
    return (
      (schema === "factory" || schema === "adjacent-share") &&
      (other === "factory" || other === "adjacent-share")
    );
  }).length;
}

/** True when this closer continues an adjacent-share / factory run. */
export function matchesRecentSchema(
  prevSummaries: string[],
  closer: string,
): boolean {
  if (!shipSchema(closer)) return false;
  return schemaHitsIn(prevSummaries, closer) >= SCHEMA_HOLD_HITS;
}

export function factoryHitsIn(
  summaries: string[],
  lookback = FACTORY_LOOKBACK,
): number {
  return (summaries || [])
    .filter((s) => s && s.trim())
    .slice(-lookback)
    .filter((s) => isFactoryFingerprint(s)).length;
}

/** 5 factory fingerprints in the last 8 (include closer). */
export function factoryClassHolding(
  prevSummaries: string[],
  closer: string,
): boolean {
  const all = [...(prevSummaries || []), closer].filter((s) => s && s.trim());
  return factoryHitsIn(all) >= FACTORY_HOLD_HITS;
}

export function isMillClassShip(text: string): boolean {
  return isFactoryFingerprint(text) || isAdjacentShareSchema(text);
}

/** One-ship reading that continues the mill — refuse adopt. */
export function isSameClassReading(
  prevSummaries: string[],
  parsedShips: string[],
): boolean {
  if (!parsedShips.length) return false;
  const blob = parsedShips.join("\n");
  if (factoryClassHolding(prevSummaries, blob)) return true;
  if (matchesRecentSchema(prevSummaries, blob)) return true;
  if (parsedShips.length === 1) {
    const one = parsedShips[0]!;
    if (!isMillClassShip(one) && !isMillClassShip(blob)) return false;
    const last3 = (prevSummaries || []).filter((s) => s && s.trim()).slice(-3);
    if (last3.some((s) => sameWorkSchema(s, one) || sameWorkSchema(s, blob))) {
      return true;
    }
  }
  return parsedShips.every((p) => isMillClassShip(p)) &&
    (prevSummaries || []).slice(-3).some((s) => isMillClassShip(s));
}

export function isChangelogOnlySummary(text: string, editDelta = 0): boolean {
  if (editDelta > 2) return false;
  return /\bconsolidat(?:ion|e|ed|ing)\b/i.test(text || "");
}
