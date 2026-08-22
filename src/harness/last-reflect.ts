/**
 * LAST reflect: after wrap, score this ULW run's git product, then at most
 * one must-fix close-out, then Cycle complete. Automatic — no extra slash.
 *
 * Kill-switch: FORGE_ULW_LAST_REFLECT=0 (fail-open, skip to attest).
 */
import { isFalsy } from "../util/bool.js";

export type UlwLastReflectPhase = "pending" | "score" | "closeout" | "done";

export const MAX_LAST_REFLECT_SCORE_DEMANDS = 2;

export function lastReflectEnabled(): boolean {
  return !isFalsy(process.env.FORGE_ULW_LAST_REFLECT ?? "1");
}

export function normalizeLastReflectPhase(
  raw: unknown,
): UlwLastReflectPhase | undefined {
  if (raw === "pending" || raw === "score" || raw === "closeout" || raw === "done") {
    return raw;
  }
  return undefined;
}

const MUST_FIX_NONE_RE =
  /\bmust-fix\b[:\s]*(?:none|0\b|n\/a|n\.a\.|nothing(?:\s+to\s+fix)?|empty|skip|no\s+must-fix)/i;

export interface LastScorecard {
  present: boolean;
  mustFix: string[];
}

function clipHole(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Parse a LAST scorecard. `Must-fix: none` (or empty) skips close-out.
 * Bullets under Must-fix: are the one close-out list (safety/correctness).
 */
export function parseLastScorecard(text: string): LastScorecard {
  const t = String(text || "");
  if (!/\bmust-fix\b/i.test(t) && !/\blast scorecard\b/i.test(t)) {
    return { present: false, mustFix: [] };
  }
  const section = t.match(
    /\bmust-fix\b[:\s]*\n([\s\S]*?)(?=\n\s*\*{0,2}live-with\b|\n\s*#{1,3}\s|\n\s*\*\*Cycle complete|\n\s*$)/i,
  );
  const items: string[] = [];
  if (section?.[1]) {
    for (const line of section[1].split("\n")) {
      const bullet = line.match(/^\s*[-*•]\s+(.+)/);
      if (!bullet) continue;
      const body = clipHole(bullet[1] || "");
      if (!body || /^(none|n\/a|nothing|empty|skip)\b/i.test(body)) continue;
      items.push(body);
    }
  }
  if (items.length) return { present: true, mustFix: items.slice(0, 8) };
  if (MUST_FIX_NONE_RE.test(t) || /\bmust-fix\b[:\s]*$/im.test(t)) {
    return { present: true, mustFix: [] };
  }
  // "LAST scorecard" heading without a Must-fix line is not a finished card.
  if (/\bmust-fix\b/i.test(t)) return { present: true, mustFix: [] };
  return { present: false, mustFix: [] };
}

export function lastReflectGitHint(s: { checkpointSha?: string }): string {
  const sha = String(s.checkpointSha || "").trim();
  if (sha.length >= 7) {
    const short = sha.slice(0, 12);
    return (
      `Read-only git of THIS run: \`git log --oneline ${short}..HEAD\` and ` +
      `\`git diff ${short}\`. Do not edit.`
    );
  }
  return "Read-only git of THIS run: `git log --oneline` and `git diff` (this ULW's auto-commits). Do not edit.";
}

export function formatLastReflectScoreReanchor(s: {
  checkpointSha?: string;
  lastReflectScoreDemands?: number;
}): string {
  return [
    `[Forge ULW cycle driver] Stop blocked — LAST reflect (score this run).`,
    `Wrap of the product wave is done enough to score. Automatic — the user does not type another command.`,
    lastReflectGitHint(s),
    ``,
    `Write a LAST scorecard, then Stop. No edits. No spawn. No leftover-chrome hunt.`,
    ``,
    `## LAST scorecard`,
    `Must-fix: none`,
    `  — or —`,
    `Must-fix:`,
    `- path:line — safety/correctness hole THIS run admitted and did not close`,
    `Live-with:`,
    `- designed leftovers / chrome / "would be nicer" (do not ship these)`,
    ``,
    `Must-fix is safety/correctness only. If none, **Cycle complete.** may follow on the same turn.`,
    `If Must-fix has items, do not attest yet — one close-out wave is next (automatic).`,
    (s.lastReflectScoreDemands ?? 0) >= 1
      ? `Second bounce — a scorecard with \`Must-fix: none\` or a bullet list is required, or the harness will skip reflect (fail-open).`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatLastReflectCloseoutReanchor(mustFix: string[]): string {
  const items = mustFix.length
    ? mustFix.map((h) => `  · ${h}`)
    : ["  · (scorecard listed must-fix — ship those only)"];
  return [
    `[Forge ULW cycle driver] Stop blocked — LAST reflect close-out (one wave).`,
    `Automatic must-fix close-out. Ship ONLY:`,
    ...items,
    ``,
    `Do not hunt leftover chrome. Do not start a new surface. Do not invent extra ships.`,
    `Then attest **Cycle complete.** with evidence. After this wave, leftover hunting is refused.`,
  ].join("\n");
}

export function formatLastReflectStatusLine(s: {
  cycle: 0 | 1;
  lastReflect?: UlwLastReflectPhase;
  lastReflectMustFix?: number;
}): string | undefined {
  if (s.cycle !== 0) return undefined;
  const phase = s.lastReflect;
  if (!phase || phase === "pending") {
    return "  LAST reflect: pending — after wrap, score this run (Must-fix vs Live-with), maybe one close-out";
  }
  if (phase === "score") {
    return "  LAST reflect: SCORE (read-only) — write Must-fix / Live-with; no edits";
  }
  if (phase === "closeout") {
    const n = s.lastReflectMustFix ?? 0;
    return `  LAST reflect: CLOSE-OUT (one wave) — ${n} must-fix hole(s), then Cycle complete`;
  }
  if (phase === "done") {
    return "  LAST reflect: done — attest **Cycle complete.**";
  }
  return undefined;
}

/** Skip ULW auto-commit during the read-only score phase (no MEMORY snapshots). */
export function skipUlwAutoCommitForLastReflect(
  s: { lastReflect?: UlwLastReflectPhase } | null | undefined,
): boolean {
  return s?.lastReflect === "score";
}

export interface LastReflectGateResult {
  block: boolean;
  reanchor?: string;
  lastReflectDemanded?: boolean;
  lastReflectCloseout?: boolean;
}

type LastReflectMut = {
  lastReflect?: UlwLastReflectPhase;
  lastReflectMustFix?: number;
  lastReflectHoles?: string[];
  lastReflectScoreDemands?: number;
  checkpointSha?: string;
};

/**
 * LAST wrap is settled (or attested). Score the run, maybe one close-out.
 * Fail-open after MAX_LAST_REFLECT_SCORE_DEMANDS scorecard bounces.
 */
export function applyLastReflectGate(
  s: LastReflectMut,
  msg: string,
  opts?: { attested?: boolean; editDelta?: number },
): LastReflectGateResult {
  if (!lastReflectEnabled()) {
    s.lastReflect = "done";
    return { block: false };
  }
  if (s.lastReflect === "done") return { block: false };

  const card = parseLastScorecard(msg);
  if (!s.lastReflect || s.lastReflect === "pending") {
    // Wrap the product wave first. Score starts on Cycle complete or when
    // the model already wrote a scorecard.
    if (!opts?.attested && !card.present) return { block: false };
    s.lastReflect = "score";
  }

  if (s.lastReflect === "score") {
    if (!card.present) {
      const n = (s.lastReflectScoreDemands ?? 0) + 1;
      s.lastReflectScoreDemands = n;
      if (n > MAX_LAST_REFLECT_SCORE_DEMANDS) {
        s.lastReflect = "done";
        return { block: false };
      }
      return {
        block: true,
        reanchor: formatLastReflectScoreReanchor(s),
        lastReflectDemanded: true,
      };
    }
    s.lastReflectMustFix = card.mustFix.length;
    s.lastReflectHoles = card.mustFix;
    if (card.mustFix.length === 0) {
      s.lastReflect = "done";
      return { block: false };
    }
    s.lastReflect = "closeout";
    return {
      block: true,
      reanchor: formatLastReflectCloseoutReanchor(card.mustFix),
      lastReflectCloseout: true,
    };
  }

  if (s.lastReflect === "closeout") {
    const retracted = card.present && card.mustFix.length === 0;
    const shipped = (opts?.editDelta ?? 0) > 0;
    if (!shipped && !retracted) {
      return {
        block: true,
        reanchor: formatLastReflectCloseoutReanchor(s.lastReflectHoles ?? []),
        lastReflectCloseout: true,
      };
    }
    s.lastReflect = "done";
    return { block: false };
  }

  return { block: false };
}
