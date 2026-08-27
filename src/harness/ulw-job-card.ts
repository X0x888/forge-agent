/**
 * Job card for the ULW wire — Wave-1 reading, open ships, last job-move.
 *
 * Sidecars already have this. Compact / CONTINUE re-anchor / memory inject
 * must reprint it, or w125 only sees mill volume. Facts only — no scores.
 */
import { activeMemoryRecords, isPlanShapedText } from "./decision-memory.js";
import {
  loadExploreMapEntries,
  loadWave1Reading,
} from "./explore-contract.js";
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

const FILE_PATH_RE = /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|md)\b/g;

export function extractReadingFilePaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(FILE_PATH_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || "")) !== null) {
    const p = m[0]!.replace(/\\/g, "/");
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export function collectUlwJobKeepPaths(
  sessionId: string,
  extra?: { namedShips?: Array<{ text: string; status?: string }> },
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    const n = (p || "").replace(/\\/g, "/").trim();
    if (!n || seen.has(n.toLowerCase())) return;
    seen.add(n.toLowerCase());
    out.push(n);
  };
  const reading = sessionId ? loadWave1Reading(sessionId) : undefined;
  for (const p of extractReadingFilePaths(reading || "")) push(p);
  try {
    for (const e of loadExploreMapEntries(sessionId)) {
      for (const p of e.paths) push(p);
    }
  } catch {
    /* */
  }
  for (const n of extra?.namedShips ?? []) {
    for (const p of extractReadingFilePaths(n.text || "")) push(p);
  }
  return out;
}

export function pathsOnReadingFiles(
  paths: string[] | undefined,
  readingFiles: string[] | undefined,
): boolean {
  if (!paths?.length || !readingFiles?.length) return false;
  const keep = new Set(readingFiles.map((p) => p.replace(/\\/g, "/").toLowerCase()));
  for (const p of paths) {
    const n = (p || "").replace(/\\/g, "/").toLowerCase();
    if (!n) continue;
    if (keep.has(n)) return true;
    for (const k of keep) {
      if (n.endsWith("/" + k) || k.endsWith("/" + n)) return true;
      const a = n.split("/").pop();
      const b = k.split("/").pop();
      if (a && b && a === b && a.length >= 8) return true;
    }
  }
  return false;
}

/**
 * Job movement — named/pick/play or the reading's files.
 * A full-suite pass or any control-flow net=new is not a job move.
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
  if (w.proofKind === "play") return true;
  if (PLAY_LOOK_RE.test(text)) return true;
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
    "Bar is a job-moving ship (named/pick/play, or control-flow on the reading's files), not mill edit count or a suite pass.",
  );
  let out = lines.filter(Boolean).join("\n");
  if (out.length > max) out = `${out.slice(0, max - 1)}…`;
  return out;
}
