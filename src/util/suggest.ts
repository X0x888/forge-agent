/**
 * Lightweight name suggestion (subcommand / slash typos).
 * Prefers prefix/substring, then small Levenshtein with shared 3-char prefix.
 */
import { editDistance } from "./string-distance.js";

export function suggestName(
  raw: string,
  candidates: readonly string[],
  opts?: {
    /** Minimum query length (default 3). */
    minLength?: number;
    /** Minimum score to accept (default 38). */
    minScore?: number;
    /** Require first 3 chars match for pure edit-distance hits (default true). */
    requirePrefix3?: boolean;
  },
): string | null {
  const q = raw.trim().toLowerCase();
  const minLength = opts?.minLength ?? 3;
  const minScore = opts?.minScore ?? 38;
  const requirePrefix3 = opts?.requirePrefix3 !== false;
  if (!q || q.length < minLength) return null;
  if (candidates.some((c) => c.toLowerCase() === q)) return null;

  const alnum = (s: string) => s.replace(/[^a-z0-9]+/g, "");
  const qNorm = alnum(q);

  let best: { name: string; score: number; d: number } | null = null;
  for (const cand of candidates) {
    const name = cand.toLowerCase();
    const nNorm = alnum(name);
    let score = 0;
    let d = 0;
    // Punctuation-insensitive exact (grok-45 ↔ grok-4.5)
    if (qNorm && nNorm && qNorm === nNorm) {
      score = 95;
    } else if (name.startsWith(q) || q.startsWith(name)) {
      // Prefer near-equal length so "grok-45" does not lock onto shorter "grok-4"
      score = 80 - Math.min(40, Math.abs(name.length - q.length) * 12);
    } else if (name.includes(q) || q.includes(name)) {
      score = 55;
    } else {
      d = editDistance(q, name);
      // With prefix gate: allow more drift. Without: keep short tokens strict
      // so "foo" does not match "fork" (d=2) while "serach"→"search" (d=2, len6) still hits.
      const maxD = requirePrefix3
        ? q.length <= 5
          ? 2
          : q.length <= 9
            ? 3
            : 4
        : q.length <= 3
          ? 1
          : q.length <= 6
            ? 2
            : 3;
      if (d > maxD) continue;
      if (
        requirePrefix3 &&
        q.length >= 3 &&
        name.length >= 3 &&
        q.slice(0, 3) !== name.slice(0, 3)
      ) {
        continue;
      }
      score = 40 - d;
      if (name.length === q.length) score += 3;
      if (name[0] === q[0]) score += 2;
    }
    // Tie-break: higher score, then lower edit distance, then nearer length.
    // (writs→writes d=1 beats edits d=2 when same-length bonus ties the score.)
    if (
      !best ||
      score > best.score ||
      (score === best.score && d < best.d) ||
      (score === best.score &&
        d === best.d &&
        Math.abs(name.length - q.length) <
          Math.abs(best.name.length - q.length))
    ) {
      best = { name: cand, score, d };
    }
  }
  if (!best || best.score < minScore) return null;
  return best.name;
}

/**
 * Ranked multi-suggestion (tool names, etc.). Same scoring as suggestName.
 * Returns up to `limit` unique candidates above minScore.
 */
export function suggestNames(
  raw: string,
  candidates: readonly string[],
  opts?: {
    minLength?: number;
    minScore?: number;
    requirePrefix3?: boolean;
    limit?: number;
  },
): string[] {
  const q = raw.trim().toLowerCase();
  const minLength = opts?.minLength ?? 3;
  const minScore = opts?.minScore ?? 38;
  const requirePrefix3 = opts?.requirePrefix3 !== false;
  const limit = Math.max(1, Math.min(opts?.limit ?? 3, 8));
  if (!q || q.length < minLength) return [];
  if (candidates.some((c) => c.toLowerCase() === q)) return [];

  const alnum = (s: string) => s.replace(/[^a-z0-9]+/g, "");
  const qNorm = alnum(q);
  const scored: { name: string; score: number; d: number }[] = [];

  for (const cand of candidates) {
    const name = cand.toLowerCase();
    const nNorm = alnum(name);
    let score = 0;
    let d = 0;
    if (qNorm && nNorm && qNorm === nNorm) {
      score = 95;
    } else if (name.startsWith(q) || q.startsWith(name)) {
      score = 80 - Math.min(40, Math.abs(name.length - q.length) * 12);
    } else if (name.includes(q) || q.includes(name)) {
      score = 55;
    } else {
      d = editDistance(q, name);
      const maxD = requirePrefix3
        ? q.length <= 5
          ? 2
          : q.length <= 9
            ? 3
            : 4
        : q.length <= 3
          ? 1
          : q.length <= 6
            ? 2
            : 3;
      if (d > maxD) continue;
      if (
        requirePrefix3 &&
        q.length >= 3 &&
        name.length >= 3 &&
        q.slice(0, 3) !== name.slice(0, 3)
      ) {
        continue;
      }
      score = 40 - d;
      if (name.length === q.length) score += 3;
      if (name[0] === q[0]) score += 2;
    }
    if (score >= minScore) scored.push({ name: cand, score, d });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.d - b.d ||
      Math.abs(a.name.length - q.length) - Math.abs(b.name.length - q.length) ||
      a.name.localeCompare(b.name),
  );

  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    const key = s.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.name);
    if (out.length >= limit) break;
  }
  return out;
}

/** Known forge sessions subcommands (canonical names for suggestions). */
export const SESSION_ACTIONS = [
  "list",
  "show",
  "path",
  "dir",
  "location",
  "export",
  "import",
  "fork",
  "clone",
  "pin",
  "unpin",
  "title",
  "rename",
  "delete",
  "prune",
  "search",
  "errors",
  "failed",
  "err",
  "untitled",
  "notitle",
  "nameless",
] as const;

/**
 * Split `grok-4.6` / `x-ai/grok-4.7-latest` / `claude-sonnet-4` into family +
 * dotted version. Used so a version bump is not treated as a typo of the
 * previous catalog id (grok-4.6 vs grok-4.5).
 */
export function splitModelFamilyVersion(
  id: string,
): { family: string; version: string } | null {
  const base = id.includes("/") ? id.split("/").pop()! : id;
  const s = base.trim().toLowerCase().replace(/:.*$/, "");
  const m = s.match(/^(.*?)[-](\d+(?:\.\d+)*)(?:-(.+))?$/);
  if (!m) return null;
  return { family: m[1]!, version: m[2]! };
}

/** Same model family at different dotted versions (not a punctuation typo). */
export function isVersionedModelSibling(a: string, b: string): boolean {
  const pa = splitModelFamilyVersion(a);
  const pb = splitModelFamilyVersion(b);
  if (!pa || !pb) return false;
  return pa.family === pb.family && pa.version !== pb.version;
}

/**
 * True when `raw` should be accepted even though `tip` is a close catalog hit.
 * `grok-45` → `grok-4.5` is still a typo; `grok-4.7` → `grok-4.6` is a bump.
 */
export function isAcceptableUnknownModelId(raw: string, tip: string): boolean {
  const q = raw.trim();
  const t = tip.trim();
  if (!q || !t) return true;
  if (q.toLowerCase() === t.toLowerCase()) return true;
  const alnum = (s: string) => s.replace(/[^a-z0-9]+/g, "").toLowerCase();
  if (alnum(q) === alnum(t)) return false;
  return isVersionedModelSibling(q, t);
}

export function suggestSessionAction(raw: string): string | null {
  // Session action names are short; allow transpositions (serach→search)
  // without the 3-char prefix gate used for longer CLI command names.
  return suggestName(raw, SESSION_ACTIONS, {
    minLength: 3,
    minScore: 36,
    requirePrefix3: false,
  });
}
