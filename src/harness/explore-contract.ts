/**
 * Evaluate-class explore-map contract for unlimited ULW.
 *
 * Wave-1 explores name the hard work (picks). After K ships that do not
 * touch a pick, hold — reprint the picks. Not a session cap.
 */
import fs from "node:fs";
import path from "node:path";
import { forgeHome } from "../util/fs.js";
import { normalizeExploreMaps } from "../session/explore-map.js";
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
    const maps = normalizeExploreMaps(raw.exploreMaps);
    const out: ExploreMapEntry[] = [];
    for (const m of maps ?? []) {
      const pick = (m.pick || "").trim();
      if (pick.length < 12) continue;
      const claims = (m.files ?? [])
        .map((f) => (f.claim || "").trim())
        .filter((c) => c.length >= 8);
      out.push({ pick, claims });
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

/**
 * True when the closer ships the pick's job (distinctive terms / bigrams),
 * not when it only shares a topic (online / joiner / toast).
 */
export function isExplorePickDone(
  closer: string,
  pick: string,
  claims: string[] = [],
): boolean {
  const blob = (closer || "").toLowerCase().replace(/-/g, " ");
  if (!blob.trim() || pick.trim().length < 12) return false;
  const words = distinctivePickTerms(pick, claims);
  for (let i = 0; i < words.length - 1; i++) {
    const g = `${words[i]} ${words[i + 1]}`;
    if (g.length >= 10 && blob.includes(g)) return true;
  }
  const hits = words.filter((t) => blob.includes(t));
  return hits.length >= 2;
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
