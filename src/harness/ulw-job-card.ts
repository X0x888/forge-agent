/**
 * Job card for the ULW wire — Wave-1 reading, open ships, last job-move.
 *
 * Sidecars already have this. Compact / CONTINUE re-anchor / memory inject
 * must reprint it, or w125 only sees mill volume. Facts only — no scores.
 */
import { activeMemoryRecords, isPlanShapedText } from "./decision-memory.js";
import { loadWave1Reading } from "./explore-contract.js";
import {
  isFactoryFingerprint,
  isChangelogOnlySummary,
} from "./work-class.js";

/** Play / screenshot / Playwright — a look, not a mill grep. */
export const PLAY_LOOK_RE =
  /\bplaywright\b|\bplay-loop\b|\bplayed the game\b|\bplay the game\b|\bzero JS errors\b|\bscreenshot\b|\.png\b/i;

export interface UlwJobWaveFact {
  wave: number;
  editDelta: number;
  proof: boolean;
  proofKind?: string;
  summary: string;
  classText?: string;
  millClass?: boolean;
  siblingMill?: boolean;
  chrome?: boolean;
  jobMoved?: boolean;
  netDiff?: string;
  todoProgress?: number;
  editKind?: string;
  treeSurfaceKey?: string;
}

export interface UlwJobCardSource {
  sessionId?: string;
  mandate?: string;
  waves?: UlwJobWaveFact[];
  namedShips?: Array<{ text: string; status: string }>;
  playLoopRan?: boolean;
  fullSuitePassed?: boolean;
  midReflectHoles?: string[];
}

export interface UlwJobCard {
  wave1Reading?: string;
  openNamedShips: string[];
  lastNonMillShip?: {
    wave: number;
    summary: string;
    editDelta: number;
    proof: boolean;
  };
  lastPlayClaim?: string;
  lastFullSuite?: { wave: number; summary: string };
  midReflectHoles: string[];
  jobMovedCount: number;
}

/**
 * Job movement — named/pick/play/full-suite/control-flow, not mill volume.
 * Explicit `jobMoved` on the ledger wins for current stamps.
 */
export function waveMovedJob(w: UlwJobWaveFact | undefined): boolean {
  if (!w) return false;
  if (w.jobMoved === true) return true;
  if (w.jobMoved === false) return false;
  if (w.netDiff === "revisit") return false;
  if (w.millClass || w.siblingMill || w.chrome) return false;
  if (w.proofKind === "isolate") return false;
  const text = `${w.classText || ""} ${w.summary || ""}`;
  if (isChangelogOnlySummary(w.summary || "", w.editDelta ?? 0)) return false;
  if (isFactoryFingerprint(text)) return false;
  if (w.proofKind === "full" && w.proof) return true;
  if (PLAY_LOOK_RE.test(text)) return true;
  if (w.editKind === "control-flow" && w.netDiff === "new") return true;
  if ((w.todoProgress ?? 0) > 0 && w.proof) return true;
  return false;
}

export function lastJobMovingWave(
  waves: UlwJobWaveFact[] | undefined,
): UlwJobWaveFact | null {
  const list = waves || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const w = list[i]!;
    if (waveMovedJob(w)) return w;
  }
  return null;
}

function lastNonMillWave(
  waves: UlwJobWaveFact[] | undefined,
): UlwJobWaveFact | null {
  const job = lastJobMovingWave(waves);
  if (job) return job;
  const list = waves || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const w = list[i]!;
    if (w.millClass || w.siblingMill || w.chrome) continue;
    if (isFactoryFingerprint(w.classText || w.summary || "")) continue;
    if (isChangelogOnlySummary(w.summary || "", w.editDelta ?? 0)) continue;
    return w;
  }
  return null;
}

function lastFullSuiteWave(
  waves: UlwJobWaveFact[] | undefined,
): UlwJobWaveFact | null {
  const list = waves || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const w = list[i]!;
    if (w.proofKind === "full" && w.proof) return w;
  }
  return null;
}

function wave1ReadingFromMemory(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  try {
    const fromExplore = loadWave1Reading(sessionId);
    if (fromExplore) return fromExplore;
    const recs = activeMemoryRecords(sessionId);
    for (const r of recs) {
      const t = String(r.text || "");
      if (!isPlanShapedText(t) && !/\bReading:/i.test(t)) continue;
      const m = t.match(/\*{0,2}Reading:\*{0,2}\s+(.{20,400})/i);
      if (m?.[1]) return m[1].replace(/\s+/g, " ").trim().slice(0, 400);
    }
  } catch {
    /* sidecar optional */
  }
  return undefined;
}

function lastPlayFromMemory(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  try {
    const recs = activeMemoryRecords(sessionId);
    for (let i = recs.length - 1; i >= 0; i--) {
      const t = String(recs[i]?.text || "");
      if (!PLAY_LOOK_RE.test(t)) continue;
      return t.replace(/\s+/g, " ").trim().slice(0, 240);
    }
  } catch {
    /* */
  }
  return undefined;
}

export function buildUlwJobCard(src: UlwJobCardSource): UlwJobCard {
  const waves = src.waves || [];
  const open = (src.namedShips ?? [])
    .filter((x) => x.status === "open")
    .map((x) => x.text.trim())
    .filter(Boolean);
  const last = lastNonMillWave(waves);
  const suite = lastFullSuiteWave(waves);
  const playFromWave = [...waves]
    .reverse()
    .find((w) => PLAY_LOOK_RE.test(`${w.classText || ""} ${w.summary || ""}`));
  const playMem = src.sessionId
    ? lastPlayFromMemory(src.sessionId)
    : undefined;
  return {
    wave1Reading: src.sessionId
      ? wave1ReadingFromMemory(src.sessionId)
      : undefined,
    openNamedShips: open.slice(0, 8),
    lastNonMillShip: last
      ? {
          wave: last.wave,
          summary: (last.summary || "").replace(/\s+/g, " ").trim().slice(0, 200),
          editDelta: last.editDelta,
          proof: Boolean(last.proof),
        }
      : undefined,
    lastPlayClaim:
      playMem ||
      (playFromWave
        ? (playFromWave.summary || playFromWave.classText || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200)
        : src.playLoopRan
          ? "play-loop ran this cycle"
          : undefined),
    lastFullSuite: suite
      ? {
          wave: suite.wave,
          summary: (suite.summary || "").replace(/\s+/g, " ").trim().slice(0, 160),
        }
      : undefined,
    midReflectHoles: (src.midReflectHoles ?? []).filter(Boolean).slice(0, 6),
    jobMovedCount: waves.filter((w) => waveMovedJob(w)).length,
  };
}

export function formatUlwJobCard(
  card: UlwJobCard,
  opts?: { maxChars?: number },
): string {
  const max = opts?.maxChars ?? 2_400;
  const lines: string[] = [];
  if (card.wave1Reading) {
    lines.push(`Wave 1 reading: ${card.wave1Reading}`);
  }
  if (card.openNamedShips.length) {
    const body = card.openNamedShips
      .slice(0, 6)
      .map((t) => t.slice(0, 160))
      .join(" · ");
    lines.push(`Open named ships (${card.openNamedShips.length}): ${body}`);
  }
  if (card.lastNonMillShip) {
    const s = card.lastNonMillShip;
    lines.push(
      `Last job-moving ship: w${s.wave} (+${s.editDelta}e, proof ${s.proof ? "✓" : "✗"}) — ${s.summary}`,
    );
  } else {
    lines.push(
      "Last job-moving ship: (none yet — mill/chrome/isolate rows do not count)",
    );
  }
  if (card.lastPlayClaim) {
    lines.push(`Last play/look: ${card.lastPlayClaim}`);
  }
  if (card.lastFullSuite) {
    lines.push(
      `Last full-suite proof: w${card.lastFullSuite.wave} — ${card.lastFullSuite.summary}`,
    );
  }
  if (card.midReflectHoles.length) {
    lines.push("Mid-run Must-fix (ledger, not a score):");
    for (const h of card.midReflectHoles) {
      lines.push(`- ${h}`);
    }
  }
  lines.push(
    "Bar is a job-moving ship (named/pick/play/full-suite/control-flow on the reading's files), not mill edit count.",
  );
  let out = lines.filter(Boolean).join("\n");
  if (out.length > max) out = `${out.slice(0, max - 1)}…`;
  return out;
}
