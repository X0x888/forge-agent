/**
 * Same-surface sibling grind — structural, not a quality score.
 *
 * Maze dogfood stamped 20 thick+proven waves on openings / rest-card /
 * leftover-audio. thinStreak and polishStreak stayed 0. This classifier
 * sees near-duplicate summaries and leftover-sibling language.
 * Adjacent-share / factory schema (work-class.ts) is a second signal:
 * rotating nouns on one couple-share recipe are the same surface.
 */

import { matchesRecentSchema } from "./work-class.js";

export const SAME_SURFACE_MIN_HITS = 2;
export const SAME_SURFACE_OVERLAP = 0.5;
export const SAME_SURFACE_ADVISORY = 2;
export const SAME_SURFACE_HOLD = 3;
/** Compare a new closer against this many prior wave summaries. */
export const SAME_SURFACE_LOOKBACK = 3;

const RITUAL_WORD_RE =
  /^(smoke|green|objective|proof|npm|test|tests|suite|wave|ship|ships|shipped|landed|what|will|feel|felt|still|only|then|they|them|this|that|with|from|into|have|been|does|than|your|their|when|after|before|first|last|next|also|just|more|pass|passed|passing|consolidat|consolidation|closer|proofed)$/i;

const STOP_WORD_RE =
  /^(this|that|with|from|into|ship|landed|wave|your|their|them|they|have|been|does|than|when|after|before)$/i;

/** Explicit leftover / sibling grind — maze wave 40 "Fix that only." */
const LEFTOVER_SIBLING_RE =
  /\bleftover\b|\bfix that only\b|\bstill leaks?\b|\bsibling of\b|\bthe leftover\b|\bfix that leftover\b|\bsame openings?\b/i;

export function normalizeSurfaceKey(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function surfaceTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of normalizeSurfaceKey(text).split(/\s+/)) {
    if (w.length < 4) continue;
    if (RITUAL_WORD_RE.test(w) || STOP_WORD_RE.test(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

export function surfaceKey(text: string): string {
  return surfaceTokens(text).slice(0, 12).join(" ");
}

export function surfaceOverlap(a: string, b: string): number {
  const aw = surfaceTokens(a);
  const bw = surfaceTokens(b);
  if (aw.length === 0 || bw.length === 0) return 0;
  const bset = new Set(bw);
  const hit = aw.filter((w) => bset.has(w)).length;
  return hit / Math.min(aw.length, bw.length);
}

export function surfaceHits(a: string, b: string): number {
  const aw = surfaceTokens(a);
  const bw = surfaceTokens(b);
  if (aw.length === 0 || bw.length === 0) return 0;
  const bset = new Set(bw);
  return aw.filter((w) => bset.has(w)).length;
}

export function isLeftoverSiblingShip(text: string): boolean {
  return LEFTOVER_SIBLING_RE.test(text || "");
}

export function isSameSurface(prev: string, next: string): boolean {
  if (!prev?.trim() || !next?.trim()) return false;
  if (isLeftoverSiblingShip(next) && surfaceHits(prev, next) >= 1) {
    return true;
  }
  if (isLeftoverSiblingShip(next) && isLeftoverSiblingShip(prev)) {
    return true;
  }
  const hits = surfaceHits(prev, next);
  if (hits < SAME_SURFACE_MIN_HITS) return false;
  return surfaceOverlap(prev, next) >= SAME_SURFACE_OVERLAP;
}

export function matchesRecentSurface(
  prevSummaries: string[],
  closer: string,
): boolean {
  const recent = prevSummaries.filter((s) => s && s.trim()).slice(-SAME_SURFACE_LOOKBACK);
  if (isLeftoverSiblingShip(closer) && recent.length > 0) return true;
  if (recent.some((s) => isSameSurface(s, closer))) return true;
  return matchesRecentSchema(prevSummaries, closer);
}

export interface SameSurfaceNote {
  streak: number;
  same: boolean;
  surfaceKey: string;
}

/**
 * Next streak after a closer. Consolidation does not increment and does
 * not reset. A new surface resets to 1 (this ship starts a new run).
 */
export function nextSameSurfaceStreak(
  prevSummaries: string[],
  closer: string,
  currentStreak = 0,
  opts?: { consolidation?: boolean },
): SameSurfaceNote {
  const key = surfaceKey(closer);
  if (opts?.consolidation) {
    return { streak: currentStreak, same: false, surfaceKey: key };
  }
  const same = matchesRecentSurface(prevSummaries, closer);
  if (same) {
    return { streak: Math.max(1, currentStreak) + 1, same: true, surfaceKey: key };
  }
  return { streak: 1, same: false, surfaceKey: key };
}
