/**
 * Evaluate-class explore-map contract for unlimited ULW.
 *
 * Wave-1 explores name the hard work (picks). After K ships that do not
 * touch a pick, hold — reprint the picks. Not a session cap.
 */
import fs from "node:fs";
import path from "node:path";
import { forgeHome } from "../util/fs.js";
import { activeMemoryRecords } from "./decision-memory.js";

export const OFF_CONTRACT_HOLD = 8;

/** Tokens that walked the log10 contract hold (`same` + `copy` from the pick). */
const GENERIC_CONTRACT_TOKENS = new Set([
  "same",
  "copy",
  "find",
  "past",
  "next",
  "just",
  "then",
  "they",
  "them",
  "this",
  "that",
  "with",
  "from",
  "into",
  "have",
  "been",
  "does",
  "than",
  "your",
  "their",
  "when",
  "after",
  "before",
  "first",
  "last",
  "also",
  "only",
  "real",
  "hard",
  "still",
  "what",
  "will",
  "feel",
  "felt",
  "more",
  "over",
  "under",
  "both",
  "must",
  "floor",
  "not",
]);

export interface ExploreMapEntry {
  pick: string;
  claims: string[];
  paths: string[];
}

/** Topic words that must not complete a pick or refresh a spent list. */
const TOPIC_PICK_TOKENS = new Set([
  ...GENERIC_CONTRACT_TOKENS,
  "online",
  "joiner",
  "toast",
  "host",
  "laptop",
  "chrome",
  "juice",
  "combat",
  "leftover",
  "ships",
  "play",
  "hurting",
  "wave",
  "give",
  "should",
  "own",
  "more",
  "never",
  "exist",
  "several",
  "couple",
  "fairness",
]);

export function loadExploreMapEntries(sessionId: string): ExploreMapEntry[] {
  if (!sessionId) return [];
  try {
    const p = path.join(forgeHome(), "sessions", sessionId, "meta.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
      exploreMaps?: unknown;
    };
    // Do not run path-deduping normalize here — several claims often
    // share one file, and pick-done needs every claim sentence.
    const maps = Array.isArray(raw.exploreMaps) ? raw.exploreMaps : [];
    const out: ExploreMapEntry[] = [];
    for (const item of maps) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const m = item as { pick?: unknown; files?: unknown };
      const pick = typeof m.pick === "string" ? m.pick.trim() : "";
      if (pick.length < 12) continue;
      const files = Array.isArray(m.files) ? m.files : [];
      const claims: string[] = [];
      const paths: string[] = [];
      for (const f of files) {
        if (!f || typeof f !== "object" || Array.isArray(f)) continue;
        const ff = f as { claim?: unknown; path?: unknown };
        const claim = typeof ff.claim === "string" ? ff.claim.trim() : "";
        if (claim.length >= 8) claims.push(claim);
        const fp = typeof ff.path === "string" ? ff.path.trim() : "";
        if (fp.length >= 3 && !paths.includes(fp)) paths.push(fp);
      }
      out.push({ pick, claims, paths });
    }
    return out;
  } catch {
    return [];
  }
}

export function loadExploreMapPicks(sessionId: string): string[] {
  return loadExploreMapEntries(sessionId).map((e) => e.pick);
}

export function distinctivePickTerms(
  pick: string,
  claims: string[] = [],
): string[] {
  const blob = [pick, ...claims].join(" ");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of contractWords(blob)) {
    if (w.length < 6 || TOPIC_PICK_TOKENS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function hasLongBigram(words: string[], blob: string): boolean {
  for (let i = 0; i < words.length - 1; i++) {
    const g = `${words[i]} ${words[i + 1]}`;
    if (g.length >= 10 && blob.includes(g)) return true;
  }
  return false;
}

function jobTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of contractWords(text)) {
    if (w.length < 5 || TOPIC_PICK_TOKENS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function pathsOverlap(
  claimPaths: string[] | undefined,
  changedPaths: string[] | undefined,
): boolean {
  if (!claimPaths?.length || !changedPaths?.length) return false;
  for (const a of claimPaths) {
    for (const b of changedPaths) {
      if (pathsMatchRel(a, b)) return true;
    }
  }
  return false;
}

function pathsMatchRel(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const nb = b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (na === nb) return true;
  return na.endsWith("/" + nb) || nb.endsWith("/" + na);
}

export interface ExplorePickDoneOpts {
  claimPaths?: string[];
  changedPaths?: string[];
}

/**
 * True when the closer ships the pick's job (distinctive terms / claims /
 * cited files), not when it only shares a topic (online / joiner / toast).
 *
 * Maze `d3fe69aa` w20 shipped empty-lives marks via `contributionToken` but
 * `isExplorePickDone` wanted pick-title words (`session` / `carving`).
 * Flavor-only `carving`+`thanks` copy must not complete that pick.
 */
export function isExplorePickDone(
  closer: string,
  pick: string,
  claims: string[] = [],
  opts?: ExplorePickDoneOpts,
): boolean {
  const blob = (closer || "").toLowerCase().replace(/-/g, " ");
  if (!blob.trim() || pick.trim().length < 12) return false;

  const pickLong = distinctivePickTerms(pick, []);
  const claimLong = distinctivePickTerms("", claims);
  const allLong = distinctivePickTerms(pick, claims);
  if (hasLongBigram(allLong, blob)) return true;

  const pickHits = pickLong.filter((t) => blob.includes(t));
  const claimHits = claimLong.filter((t) => blob.includes(t));
  // Two long hits only count when at least one is from a file claim —
  // pick-title flavor (carving + thanks) is not the job.
  if (pickHits.length + claimHits.length >= 2 && claimHits.length >= 1) {
    return true;
  }

  const pickJobHits = jobTerms(pick).filter((t) => blob.includes(t));
  const claimTokenHit = claimLong.some(
    (t) => t.length >= 8 && blob.includes(t),
  );
  const pathHit = pathsOverlap(opts?.claimPaths, opts?.changedPaths);
  if (pickJobHits.length >= 1 && (claimTokenHit || pathHit)) return true;
  if (pathHit && pickHits.length + claimHits.length + pickJobHits.length >= 1) {
    return true;
  }
  return false;
}

/** New reading only restates a spent pick's topic — not a new class. */
export function isSamePickTopic(text: string, donePicks: string[]): boolean {
  const blob = (text || "").toLowerCase().replace(/-/g, " ");
  if (!blob.trim() || !donePicks.length) return false;
  if (donePicks.some((p) => isExplorePickDone(blob, p))) return false;
  const topic =
    /\bonline\b/.test(blob) ||
    /\bjoiner\b/.test(blob) ||
    /\btoast\b/.test(blob) ||
    /\bhost (?:heard|laptop)\b/.test(blob);
  if (!topic) return false;
  return donePicks.some((p) => {
    const terms = distinctivePickTerms(p);
    const jobHits = terms.filter((t) => t.length >= 7 && blob.includes(t));
    return jobHits.length === 0;
  });
}

export function loadWave1Reading(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  try {
    const recs = activeMemoryRecords(sessionId);
    for (const r of recs) {
      const m = String(r.text || "").match(
        /\*{0,2}Reading:\*{0,2}\s+(.{20,400})/i,
      );
      if (m?.[1]) return m[1].replace(/\s+/g, " ").trim().slice(0, 280);
    }
  } catch {
    /* */
  }
  return undefined;
}

function contractWords(text: string): string[] {
  const raw = (text || "").toLowerCase().replace(/-/g, " ");
  const all = raw.match(/[a-z][a-z0-9']{2,}/g) || [];
  return all.filter((w) => w.length >= 4 && !GENERIC_CONTRACT_TOKENS.has(w));
}

export function isOnExploreContract(
  text: string,
  picks: string[],
): boolean {
  const blob = (text || "").toLowerCase().replace(/-/g, " ");
  if (!blob.trim() || !picks.length) return false;
  for (const pick of picks) {
    const words = contractWords(pick);
    const bigrams: string[] = [];
    for (let i = 0; i < words.length - 1; i++) {
      const g = `${words[i]} ${words[i + 1]}`;
      if (g.length >= 8) bigrams.push(g);
    }
    // "memory walk" / "online hearth" — garnish "same copy" is not a pick.
    if (bigrams.some((g) => blob.includes(g))) return true;
    const tokens = words.filter((w) => w.length >= 5);
    const hits = tokens.filter((t) => blob.includes(t));
    if (hits.length >= 2) return true;
    // One distinctive pick word (topology, couplemaze, memories).
    if (hits.some((t) => t.length >= 8)) return true;
  }
  return false;
}

export function formatHoldContextAppendix(sessionId: string): string {
  const lines: string[] = [];
  const reading = loadWave1Reading(sessionId);
  if (reading) lines.push(`Wave 1 reading: ${reading}`);
  const picks = loadExploreMapPicks(sessionId);
  if (picks.length) {
    lines.push("Explore-map picks still open (not a new noun):");
    for (const p of picks.slice(0, 4)) {
      lines.push(`- ${p.slice(0, 200)}`);
    }
  }
  if (lines.length) {
    lines.push(
      "Ship a pick, retire it with evidence, or /cycle 0. Stuck-wall will not release.",
    );
  }
  return lines.join("\n");
}
