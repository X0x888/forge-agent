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
import { surfaceTokens } from "./same-surface.js";

export const OFF_CONTRACT_HOLD = 8;

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

export function isOnExploreContract(
  text: string,
  picks: string[],
): boolean {
  const blob = (text || "").toLowerCase();
  if (!blob.trim() || !picks.length) return false;
  for (const pick of picks) {
    const words = (pick.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || []).filter(
      (w) => w.length >= 4,
    );
    const bigrams: string[] = [];
    for (let i = 0; i < words.length - 1; i++) {
      const g = `${words[i]} ${words[i + 1]}`;
      if (g.length >= 8) bigrams.push(g);
    }
    if (bigrams.some((g) => blob.includes(g))) return true;
    const tokens = surfaceTokens(pick).filter((w) => w.length >= 4);
    const hits = tokens.filter((t) => blob.includes(t)).length;
    if (hits >= 2) return true;
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
