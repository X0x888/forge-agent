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

export interface LastReflectLedgerFacts {
  waves?: Array<{
    proof?: boolean;
    proofKind?: string;
    chrome?: boolean;
    millClass?: boolean;
    siblingMill?: boolean;
    jobMoved?: boolean;
  }>;
  sameSurfaceStreak?: number;
  pinCreditRefused?: number;
  fullSuitePassed?: boolean;
  playLoopRan?: boolean;
  mandate?: string;
  wave?: number;
}

/**
 * Harness-filled must-fix holes from the wave ledger. The model may add,
 * not erase. `Must-fix: none` is illegal when any of these are true.
 */
export function ledgerMustFixItems(facts: LastReflectLedgerFacts): string[] {
  const holes: string[] = [];
  const waves = facts.waves ?? [];
  const hadIsolate = waves.some((w) => w.proofKind === "isolate");
  const hadFull = waves.some(
    (w) => w.proofKind === "full" || (w.proof === true && w.proofKind !== "isolate"),
  );
  if (
    (hadIsolate || (facts.pinCreditRefused ?? 0) > 0) &&
    !facts.fullSuitePassed &&
    !hadFull
  ) {
    holes.push(
      "Full check suite never passed this run (isolates are proof=ran, not proof=✓).",
    );
  }
  const unproven = waves.filter(
    (w) => !w.proof && w.proofKind !== "isolate" && w.proofKind !== "full",
  );
  if (unproven.length >= 2 && !facts.fullSuitePassed) {
    holes.push(
      `${unproven.length} wave(s) closed without successful proof.`,
    );
  }
  if ((facts.pinCreditRefused ?? 0) > 0) {
    holes.push(
      `Pin-only tests refused credit ${facts.pinCreditRefused} time(s).`,
    );
  }
  if ((facts.sameSurfaceStreak ?? 0) >= 2) {
    holes.push(
      `Same-surface streak ${facts.sameSurfaceStreak} — mill siblings, not distinct ships.`,
    );
  }
  const chromeN = waves.filter((w) => w.chrome).length;
  if (chromeN >= 2) {
    holes.push(`Chrome-only path cluster on ${chromeN} credited waves.`);
  }
  const millN = waves.filter((w) => w.millClass || w.siblingMill).length;
  if (millN >= 3) {
    holes.push(
      `${millN} mill/sibling-module wave(s) — numbered foo-n.js is not a job.`,
    );
  }
  const jobN = waves.filter((w) => w.jobMoved).length;
  if (waves.length >= 4 && jobN === 0) {
    holes.push(
      "Last credited waves did not close a named/pick/play job (volume is not movement).",
    );
  }
  const userFacing =
    /\b(game|app|application|tui|cli)\b/i.test(facts.mandate || "") ||
    /\b(evaluate|build|redesign)\b/i.test(facts.mandate || "");
  if (
    userFacing &&
    !facts.playLoopRan &&
    (facts.wave ?? waves.length) >= 4 &&
    !waves.some((w) => w.proofKind === "full" && w.proof)
  ) {
    holes.push(
      "User-facing product had no play-loop / screenshot look and no full-suite ✓ this run.",
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of holes) {
    const k = h.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(clipHole(h));
  }
  return out.slice(0, 8);
}

export function mergeLastScorecard(
  card: LastScorecard,
  ledger: string[],
): LastScorecard {
  const holes: string[] = [];
  const seen = new Set<string>();
  const push = (item: string) => {
    const body = clipHole(item);
    if (!body) return;
    const k = body.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    holes.push(body);
  };
  for (const h of ledger) push(h);
  if (card.present) {
    for (const item of card.mustFix) push(item);
  }
  if (!card.present && holes.length === 0) return card;
  return { present: true, mustFix: holes.slice(0, 8) };
}

/** Parse a LAST scorecard. Ledger holes cannot be erased with Must-fix: none. */
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
  lastReflectHoles?: string[];
}): string {
  const ledger = (s.lastReflectHoles ?? []).filter(Boolean);
  const noneIllegal = ledger.length > 0;
  return [
    `[Forge ULW cycle driver] Stop blocked — LAST reflect (score this run).`,
    `Wrap of the product wave is done enough to score. Automatic — the user does not type another command.`,
    lastReflectGitHint(s),
    ``,
    `Write a LAST scorecard, then Stop. No edits. No spawn. No leftover-chrome hunt.`,
    ``,
    `## LAST scorecard`,
    noneIllegal
      ? [
          `Must-fix: (harness-filled from the wave ledger — you may add, not erase)`,
          ...ledger.map((h) => `- ${h}`),
          `Must-fix: none is illegal while the ledger lists holes.`,
        ].join("\n")
      : [
          `Must-fix: none`,
          `  — or —`,
          `Must-fix:`,
          `- path:line — safety/correctness hole THIS run admitted and did not close`,
        ].join("\n"),
    `Live-with:`,
    `- designed leftovers / chrome / "would be nicer" (do not ship these)`,
    ``,
    `Must-fix is safety/correctness only. If none, **Cycle complete.** may follow on the same turn.`,
    `If Must-fix has items, do not attest yet — one close-out wave is next (automatic).`,
    (s.lastReflectScoreDemands ?? 0) >= 1
      ? noneIllegal
        ? `Second bounce — keep the ledger holes (or add). Must-fix: none will not skip close-out.`
        : `Second bounce — a scorecard with \`Must-fix: none\` or a bullet list is required, or the harness will skip reflect (fail-open).`
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
  opts?: {
    attested?: boolean;
    editDelta?: number;
    ledgerMustFix?: string[];
  },
): LastReflectGateResult {
  if (!lastReflectEnabled()) {
    s.lastReflect = "done";
    return { block: false };
  }
  if (s.lastReflect === "done") return { block: false };

  const ledger = (opts?.ledgerMustFix ?? s.lastReflectHoles ?? []).filter(Boolean);
  if (ledger.length && !s.lastReflectHoles?.length) {
    s.lastReflectHoles = ledger.slice(0, 8);
  }
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
        if (ledger.length) {
          s.lastReflectMustFix = ledger.length;
          s.lastReflectHoles = ledger.slice(0, 8);
          s.lastReflect = "closeout";
          return {
            block: true,
            reanchor: formatLastReflectCloseoutReanchor(ledger),
            lastReflectCloseout: true,
          };
        }
        s.lastReflect = "done";
        return { block: false };
      }
      return {
        block: true,
        reanchor: formatLastReflectScoreReanchor({
          ...s,
          lastReflectHoles: ledger.length ? ledger : s.lastReflectHoles,
        }),
        lastReflectDemanded: true,
      };
    }
    const merged = mergeLastScorecard(card, ledger);
    s.lastReflectMustFix = merged.mustFix.length;
    s.lastReflectHoles = merged.mustFix;
    if (merged.mustFix.length === 0) {
      s.lastReflect = "done";
      return { block: false };
    }
    s.lastReflect = "closeout";
    return {
      block: true,
      reanchor: formatLastReflectCloseoutReanchor(merged.mustFix),
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
