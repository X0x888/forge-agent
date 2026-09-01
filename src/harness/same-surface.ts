/**
 * Same-surface sibling grind — structural, not a quality score.
 *
 * Primary signal is the dirty tree (job-delta treeSurfaceKey): same 1–3
 * production files + chrome/TTY kind. Closer token overlap and maze
 * schemas (work-class.ts) are extra hints, not the hold.
 */

import { matchesRecentSchema } from "./work-class.js";
import { productionRelPaths, sameTreeSurface } from "./job-delta.js";

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

/**
 * Operator-facing CLI/TUI glance — argv, --help, stderr first line,
 * dashboard — and Forge slash peeks (one user job: verdict + Next).
 */
const SIT_DOWN_THESIS_RE =
  /\bsit-?down\b|\bkey you type\b|\bverdict-first\b|\bslash key\b|\bnot a (?:config dump|model (?:turn|prompt)|cli dump)\b/i;
const SIT_DOWN_SLASH_RE =
  /\/(verify|commit|budget|checkpoint|undo|resume|accounts|auth|retry|done|share|last|sessions|model|context|help|memory|mcp|lsp|effort|fallback|provider|permissions|files|compact)\b/i;
const SIT_DOWN_GLANCE_RE =
  /\b(?:argv|--help|--status|help epilog|operator-facing)\b/i;
const PEEK_MILL_BODY_RE =
  /\bsit-?down\b|\bverdict-first\b|\bpeek\b|\bformatParamMenu\b|\bcatalog (?:dump|lecture|wall)\b|\bnumbered (?:1–6|menu|catalog)\b|\bformat\w*Card\b|\bNext\s+\/|\bleftover dumps?\b|\bdump lecture\b|\bremainder catalog\b/i;
/** TUI sit-down cards — a new *-card.ts is not a new job. */
const PEEK_MILL_CARD_RE = /(^|\/)(?:src\/)?tui\/[^/]+-card\.tsx?$/i;
const PEEK_MILL_SLASH_RE = /(^|\/)(?:src\/)?commands\/slash\.ts$/i;

export const SIT_DOWN_SURFACE_KEY = "sit-down-card";
/** Dirty-tree key for slash-peek remainders — new *-card.ts is not a new job. */
export const PEEK_SLASH_TREE_KEY = "peek:slash-card";

export function isSitDownCardShip(text: string): boolean {
  const t = text || "";
  if (!SIT_DOWN_THESIS_RE.test(t)) return false;
  const glance =
    SIT_DOWN_GLANCE_RE.test(t) ||
    (/\bstderr\b/i.test(t) && /\bfirst line\b/i.test(t));
  return (
    SIT_DOWN_SLASH_RE.test(t) ||
    glance ||
    /\b(slash key|sit-down key|key you type|sit-down resume)\b/i.test(t)
  );
}

/**
 * Remainder catalog / formatXCard mill — one user job regardless of which
 * slash name or new card file. Explore-map dump picks are this class.
 */
export function isSlashPeekMillShip(text: string): boolean {
  const t = text || "";
  if (!t.trim()) return false;
  if (isSitDownCardShip(t)) return true;
  if (!SIT_DOWN_SLASH_RE.test(t) && !/\bformat\w*Card\b/.test(t)) return false;
  return PEEK_MILL_BODY_RE.test(t);
}

export function isDumpCatalogPick(text: string): boolean {
  const t = text || "";
  if (isSlashPeekMillShip(t)) return true;
  return /\bformatParamMenu\b|\bcatalog (?:dump|lecture|wall)\b|\bnumbered (?:menu|catalog)\b|\bstill (?:dumps?|lectures?)\b|\bleftover dumps?\b|\bdump lecture\b|\bremainder catalog\b/i.test(
    t,
  );
}

export function isPeekMillRelPath(rel: string): boolean {
  const n = (rel || "").replace(/\\/g, "/");
  return PEEK_MILL_CARD_RE.test(n) || PEEK_MILL_SLASH_RE.test(n);
}

/**
 * Dirty tree is only sit-down cards (and maybe slash.ts dispatcher).
 * slash.ts alone is a real command ship, not remainder mill.
 */
export function isPeekMillPaths(paths: string[]): boolean {
  const prod = productionRelPaths(paths || []);
  if (!prod.length) return false;
  const cards = prod.filter((p) => PEEK_MILL_CARD_RE.test(p.replace(/\\/g, "/")));
  if (!cards.length) return false;
  return prod.every((p) => isPeekMillRelPath(p));
}

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
  if (isSlashPeekMillShip(text) || isSitDownCardShip(text)) {
    return SIT_DOWN_SURFACE_KEY;
  }
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
  if (isSlashPeekMillShip(prev) && isSlashPeekMillShip(next)) {
    return true;
  }
  if (isSitDownCardShip(prev) && isSitDownCardShip(next)) {
    return true;
  }
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
  opts?: {
    onContract?: boolean;
    /** Bet slice — the bet's own files are a class, not a surface to leave. */
    onBet?: boolean;
    treeKey?: string;
    prevTreeKeys?: string[];
  },
): boolean {
  // A pick or a bet slice is its own class; a dump-pick remainder is not.
  // Maze picks still skip this mill.
  if ((opts?.onContract || opts?.onBet) && !isSlashPeekMillShip(closer)) {
    return false;
  }
  if (
    opts?.treeKey &&
    (opts.prevTreeKeys || []).some((k) => sameTreeSurface(k, opts.treeKey!))
  ) {
    return true;
  }
  const recent = prevSummaries.filter((s) => s && s.trim()).slice(-SAME_SURFACE_LOOKBACK);
  if (isLeftoverSiblingShip(closer) && recent.length > 0) return true;
  if (recent.some((s) => isSameSurface(s, closer))) return true;
  // Maze schemas are extra signals, not the primary hold.
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
  opts?: {
    consolidation?: boolean;
    onContract?: boolean;
    /** Bet slice — consecutive slices on one file are the wave, not a grind. */
    onBet?: boolean;
    treeKey?: string;
    prevTreeKeys?: string[];
  },
): SameSurfaceNote {
  const mill = isSlashPeekMillShip(closer);
  const key =
    mill && !opts?.treeKey
      ? SIT_DOWN_SURFACE_KEY
      : opts?.treeKey || surfaceKey(closer);
  if (opts?.consolidation) {
    return { streak: currentStreak, same: false, surfaceKey: key };
  }
  // A pick ship is a different class even if it quotes mill flavor —
  // except slash-peek remainders, which are the same job as the last dump.
  // A bet slice is the same: the bet's files are where the capability
  // lives, so the streak never counts them.
  if ((opts?.onContract || opts?.onBet) && !mill) {
    return { streak: 1, same: false, surfaceKey: key };
  }
  const same = matchesRecentSurface(prevSummaries, closer, {
    onContract: Boolean(opts?.onContract) && !mill,
    onBet: Boolean(opts?.onBet) && !mill,
    treeKey: mill ? PEEK_SLASH_TREE_KEY : opts?.treeKey,
    prevTreeKeys: opts?.prevTreeKeys,
  });
  if (same) {
    return { streak: Math.max(1, currentStreak) + 1, same: true, surfaceKey: key };
  }
  return { streak: 1, same: false, surfaceKey: key };
}
