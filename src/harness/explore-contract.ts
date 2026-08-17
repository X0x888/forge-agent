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

export function loadExploreMapPicks(sessionId: string): string[] {
  if (!sessionId) return [];
  try {
    const p = path.join(forgeHome(), "sessions", sessionId, "meta.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
      exploreMaps?: unknown;
    };
    const maps = normalizeExploreMaps(raw.exploreMaps);
    return (maps ?? [])
      .map((m) => (m.pick || "").trim())
      .filter((t) => t.length >= 12);
  } catch {
    return [];
  }
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
