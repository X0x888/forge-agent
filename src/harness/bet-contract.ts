/**
 * Bet contract for open mandates (soft / improve-class with no deliverable).
 *
 * Every other unlimited-ULW mechanism is satisfiable by a proven hole-close,
 * and the explore contract only produces holes (`pick:`). 2,407 dogfood
 * waves across 17 open-mandate runs stamped zero `new-module` ships — the
 * harness had no word for a capability, only for a defect.
 *
 * A **Bet** is the counterpart of a pick: one capability THIS product cannot
 * do today that a demanding user would notice, named with the files it
 * creates and its first provable slice. Structural, not a score: a slice is
 * a production change on the bet's files or directory — the tree, never a
 * closer that names the job (a bet is only adopted with a path, so a term
 * match could only ever credit work that did not touch it). On-bet ships
 * are job moves, never sibling mill, and never count toward the same-surface
 * hold (four slices in a row on the bet's file are the wave, not a grind);
 * six credited job-moving ships that do not touch a bet (on file or not)
 * hold unlimited ULW until a slice lands, a new `Bet:` with a path is
 * written (two unshipped swaps, then only a slice), `Bet: none — <why>`
 * declines, or `/cycle 0`. No blocking demand before that — the kickoff,
 * PLAN prompt and re-anchor ask first.
 */
import { pathsMatch } from "../session/explore-map.js";
import { distinctivePickTerms } from "./explore-contract.js";
import { productionRelPaths, type ProdEditKind } from "./job-delta.js";
import { isDumpCatalogPick } from "./same-surface.js";

/** Credited job-moving ships off any bet before the re-anchor warns. */
export const BET_OFF_ADVISORY = 3;
/** Credited job-moving ships off any bet before unlimited ULW holds. */
export const BET_OFF_HOLD = 6;
/** Unshipped bets a run may replace before only a slice releases the hold. */
export const BET_MAX_SWAPS = 2;

/**
 * Concrete-deliverable markers — a mandate with one of these is a work
 * order, not an open wish. Shared with isSoftPrompt so "open" and "soft"
 * agree on what concrete means.
 */
export const CONCRETE_DELIVERABLE_RE =
  /\b(test|tests|pass|endpoint|file|bug|error|fail|migrate|add|implement|remove|delete|until|acceptance|criteria|must|should not)\b/i;
export const CONCRETE_TOKEN_RE = /`[^`]+`|\.[a-z]{1,4}\b|\/[\w./-]+/;

/**
 * Open wishes with no object to build: "invent something", "build what's
 * missing", "create anything valuable". Word-bounded and object-gated —
 * `build a login page`, `design the onboarding flow`, `handle missing
 * config` are work orders and must stay hard.
 */
export const OPEN_WISH_RE =
  /\binvent\b|\b(?:build|create|design|make|ship)\s+(?:something|anything|whatever|what'?s missing|what is missing)\b|\b(?:what'?s|what is) missing\b/i;

/**
 * Improve-class verbs and "make it better" asks. Length-independent —
 * "Improve the UI, UX, performance, reliability of this tool
 * comprehensively" is 80+ chars and used to read as a hard mandate.
 * Grow/evolve/reimagine only count aimed at the product itself, never at a
 * named object (`evolve the schema for v2` is a work order).
 */
const OPEN_MANDATE_RE =
  /\b(?:improve|polish|enhance)\b|\bcomprehensively\b|\bbe creative\b|\b(?:grow|evolve|advance|elevate|reimagine|level up)\s+(?:it|this|the (?:product|tool|app|cli|codebase|project|game|ui|ux))\b|\bmake (?:it|this|the|our|my)(?: \w+)? (?:better|great|greater|useful|more useful|interesting|more interesting|addictive|attractive|delightful|excellent|world-class)\b/i;

/** Soft prompt, or an improve-class ask with no concrete deliverable. */
export function isOpenMandate(mandate: string, soft: boolean): boolean {
  if (soft) return true;
  const t = (mandate || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (!OPEN_MANDATE_RE.test(t) && !OPEN_WISH_RE.test(t)) return false;
  if (CONCRETE_DELIVERABLE_RE.test(t)) return false;
  if (CONCRETE_TOKEN_RE.test(t)) return false;
  return true;
}

export interface BetState {
  /** One sentence: the capability, the files, the first slice. */
  text: string;
  /** Files / directories the bet creates or lives in (relative). */
  paths: string[];
  setAt: string;
  setWave: number;
  /** Declared ships that touched this bet. */
  slices: number;
}

export type ParsedBet =
  | { kind: "bet"; text: string; paths: string[] }
  | { kind: "none"; reason: string };

const BET_LINE_RE = /\*{0,2}\bBet:\*{0,2}[ \t]*([^\n]{1,400})/i;
const BET_NONE_RE = /^none\b[\s—–:-]*(.*)$/i;
const MIN_BET_TEXT = 16;
const MIN_DECLINE_REASON = 12;

const FILE_TOKEN_RE = /^[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,6}$/;
const DIR_TOKEN_RE = /^[\w-]+(?:\/[\w.-]+)+\/?$/;
const EXT_RE = /\.[A-Za-z0-9]{1,6}$/;

function normPath(p: string): string {
  return (p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** File and directory tokens named by a bet line (`src/export/`, `src/export/csv.ts`). */
export function extractBetPaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const n = normPath(raw);
    if (!n || n.length < 3) return;
    const k = n.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(n);
  };
  for (const tok of (text || "").split(/[\s,;()`'"<>[\]]+/)) {
    const t = tok.replace(/[.:!?]+$/, "");
    if (!t) continue;
    if (FILE_TOKEN_RE.test(t) && t.includes("/")) {
      push(t);
      continue;
    }
    if (FILE_TOKEN_RE.test(t) && /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|swift|kt|java|rb|md)$/i.test(t)) {
      push(t);
      continue;
    }
    if (DIR_TOKEN_RE.test(t) && !EXT_RE.test(t.replace(/\/$/, ""))) push(t);
  }
  return out.slice(0, 8);
}

/** Parse a `Bet:` line. `Bet: none — <why>` is a decline; short bodies are not a bet. */
export function parseBetLine(text: string): ParsedBet | null {
  const m = (text || "").match(BET_LINE_RE);
  if (!m?.[1]) return null;
  const body = m[1].replace(/\s+/g, " ").trim().replace(/\*+$/, "").trim();
  if (!body) return null;
  const none = body.match(BET_NONE_RE);
  if (none) {
    const reason = (none[1] || "").trim();
    if (reason.length < MIN_DECLINE_REASON) return null;
    return { kind: "none", reason: reason.slice(0, 240) };
  }
  if (body.length < MIN_BET_TEXT) return null;
  if (isDumpCatalogPick(body)) return null;
  return { kind: "bet", text: body.slice(0, 400), paths: extractBetPaths(body) };
}

function betDirs(paths: string[]): string[] {
  const dirs: string[] = [];
  for (const raw of paths) {
    const p = normPath(raw);
    if (!p) continue;
    const isDir = !EXT_RE.test(p);
    const dir = isDir ? p : p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    // `src/` alone would match the whole tree — a bet surface is ≥2 segments.
    if (dir && dir.split("/").length >= 2 && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/** Changed production paths touch the bet's files or its directory. */
export function betPathHit(betPaths: string[], changedPaths: string[]): boolean {
  const changed = productionRelPaths(changedPaths || []).map(normPath);
  if (!changed.length || !betPaths?.length) return false;
  const files = betPaths.map(normPath).filter((p) => EXT_RE.test(p));
  const dirs = betDirs(betPaths);
  for (const c of changed) {
    if (files.some((f) => pathsMatch(c, f))) return true;
    const lc = c.toLowerCase();
    if (dirs.some((d) => lc === d.toLowerCase() || lc.startsWith(`${d.toLowerCase()}/`))) {
      return true;
    }
  }
  return false;
}

/**
 * Declared ship is a slice of the open bet — tree only: a production change
 * on the bet's files or directory that is not TTY/string-literal chrome.
 * The closer is not consulted. A bet is only adopted with a path, so a
 * closer that merely names the job (a "session ledger" hole-close beside a
 * "CSV export of the session ledger" bet) is off-bet work, not a slice.
 */
export function betShipHit(
  bet: Pick<BetState, "text" | "paths"> | undefined,
  paths: string[] | undefined,
  kind: ProdEditKind | string | undefined,
): boolean {
  if (!bet) return false;
  if (kind === "tty" || kind === "string-literal") return false;
  return betPathHit(bet.paths, paths || []);
}

/** Same bet re-written — a restated Bet: does not reset the off-streak. */
export function sameBetText(a: string, b: string): boolean {
  const na = (a || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const nb = (b || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = distinctivePickTerms(a, []);
  const tbList = distinctivePickTerms(b, []);
  const tb = new Set(tbList);
  if (ta.length < 2 || tbList.length < 2) return false;
  const hit = ta.filter((t) => tb.has(t)).length;
  // Denominator is the shorter side so a clipped copy still reads as same.
  return hit / Math.min(ta.length, tbList.length) >= 0.7;
}

export interface BetHoldSource {
  cycle: number;
  wrapKind?: string;
  maxWaves: number | null;
  cycleZeroStopAt?: number;
  openMandate?: boolean;
  bet?: BetState;
  betHold?: boolean;
  /** Consecutive credited job-moving ships that did not touch a bet. */
  betOffStreak?: number;
  betDeclined?: string;
  betSwaps?: number;
}

/** Unlimited CONTINUE on an open, undeclined mandate. Cap is a budget. */
export function betHoldArmable(s: BetHoldSource): boolean {
  return (
    s.cycle === 1 &&
    !s.wrapKind &&
    s.maxWaves == null &&
    s.cycleZeroStopAt == null &&
    Boolean(s.openMandate) &&
    !s.betDeclined
  );
}

export function betHolding(s: BetHoldSource): boolean {
  if (!betHoldArmable(s)) return false;
  return Boolean(s.betHold || (s.betOffStreak ?? 0) >= BET_OFF_HOLD);
}

function betPathsClip(bet: Pick<BetState, "paths">): string {
  return bet.paths.length ? ` (${bet.paths.slice(0, 3).join(", ")})` : "";
}

/** Hold admit when a bet is on file and the run keeps closing holes instead. */
export function formatBetHoldAdmit(s: {
  bet: Pick<BetState, "text" | "paths" | "slices">;
  betOffStreak?: number;
  betSwaps?: number;
}): string {
  const swapsSpent = (s.betSwaps ?? 0) > BET_MAX_SWAPS;
  return [
    `[Forge ULW cycle driver] Stop blocked — ${s.betOffStreak ?? 0} job-moving ships since the open Bet last moved. Hole-closing is not the spine of an open mandate.`,
    `Open Bet: ${s.bet.text}${betPathsClip(s.bet)} — slices shipped: ${s.bet.slices}.`,
    swapsSpent
      ? `${BET_MAX_SWAPS} bets were already replaced unshipped — a new Bet: no longer releases. Ship a slice (production change on the bet's files + a test that calls it), or \`Bet: none — <why no capability is worth more than the holes>\`, or /cycle 0.`
      : "Ship its next slice (production change on the bet's files + a test that calls it), or write a new `Bet:` with a path and a first slice, or `Bet: none — <why no capability is worth more than the holes>`, or /cycle 0.",
    "Fixes are smoke and Serendipity:, not the wave. Stuck-wall will not release this hold.",
  ].join("\n");
}

/** Hold admit when the open mandate never named a bet. */
export function formatBetOwedAdmit(opts: {
  mandate: string;
  betOffStreak?: number;
  candidates?: string[];
}): string {
  const cands = (opts.candidates || []).filter(Boolean).slice(0, 4);
  return [
    `[Forge ULW cycle driver] Stop blocked — ${opts.betOffStreak ?? 0} job-moving ships on an open mandate and no Bet on file. Repair is not the mandate.`,
    `Mandate: ${opts.mandate}`,
    "A pick is a hole. A Bet is a capability this product cannot do today that a demanding user would notice — the work a veteran would be proud to have invented here, not a smaller fix.",
    "Write one line and memory_write it: `Bet: <capability> — <files it creates, e.g. src/export/csv.ts> — first slice: <what lands this wave + the command that proves it>`. Then ship that slice.",
    "Or decline once with a reason: `Bet: none — <why no capability is worth more than the open holes>`. Or /cycle 0.",
    cands.length
      ? `Explore bets on file (candidates, not tickets): ${cands.map((c) => c.slice(0, 160)).join(" · ")}`
      : "No explore bet on file — an explore child may answer `bet:` alongside `pick:`.",
    "Stuck-wall will not release this hold.",
  ].join("\n");
}

export interface BetStatusSource {
  openMandate?: boolean;
  bet?: BetState;
  betRequired?: boolean;
  betDeclined?: string;
  betHold?: boolean;
  betOffStreak?: number;
}

export function formatBetStatusLine(s: BetStatusSource): string | undefined {
  if (!s.openMandate) return undefined;
  const off = s.betOffStreak ?? 0;
  const holding = s.betHold || off >= BET_OFF_HOLD;
  if (s.bet) {
    const b = s.bet;
    const hold = holding ? " · HOLD (ship a slice, new Bet:, or /cycle 0)" : "";
    return `  Bet: ${b.text.slice(0, 120)} — slices ${b.slices} · ${off} ship(s) since it moved${hold}`;
  }
  if (s.betDeclined) {
    return `  Bet: declined — ${s.betDeclined.slice(0, 120)}`;
  }
  if (s.betRequired) {
    const hold = holding ? " · HOLD (write one, decline, or /cycle 0)" : "";
    return `  Bet: none yet — open mandate; the next Reading names one (\`Bet: <capability> — <path> — first slice\`) or declines (\`Bet: none — why\`) · ${off} job-moving ship(s) without one${hold}`;
  }
  return undefined;
}

/** Job-card line — reprinted on compact / CONTINUE re-anchor. */
export function formatBetCardLine(s: BetStatusSource): string | undefined {
  if (!s.openMandate) return undefined;
  const off = s.betOffStreak ?? 0;
  if (s.bet) {
    const b = s.bet;
    return `Open bet: ${b.text.slice(0, 200)}${betPathsClip(b)} — slices ${b.slices} · ${off} ship(s) since it moved. A bet slice is the wave; a hole is smoke.`;
  }
  if (s.betDeclined) return `Bet: declined — ${s.betDeclined.slice(0, 160)}`;
  if (s.betRequired) {
    return "Bet: none on file (open mandate) — name one: `Bet: <capability this product cannot do today> — <path> — first slice`, or `Bet: none — why`.";
  }
  return undefined;
}

/** Re-anchor advisory between the advisory and hold thresholds. */
export function formatBetReanchorLine(s: BetStatusSource): string | undefined {
  if (!s.openMandate || s.betDeclined) return undefined;
  const off = s.betOffStreak ?? 0;
  if (s.bet) {
    if (off >= BET_OFF_HOLD) {
      return `⚠ ${off} job-moving ships since the Bet moved — HOLD is armed: the next Stop is blocked unless this wave is a Bet slice (or a new \`Bet:\` with a path).`;
    }
    if (off >= BET_OFF_ADVISORY) {
      return `⚠ ${off} job-moving ships since the Bet moved — this wave is a Bet slice (or a new \`Bet:\`), not another hole-close. Unlimited ULW holds at ${BET_OFF_HOLD}.`;
    }
    return undefined;
  }
  if (s.betRequired) {
    if (off >= BET_OFF_HOLD) {
      return `⚠ ${off} job-moving ships on an open mandate with no Bet on file — HOLD is armed: write \`Bet: <capability> — <path> — first slice\` (or \`Bet: none — why\`) before the next Stop.`;
    }
    return `⚠ Open mandate with no Bet on file${off >= BET_OFF_ADVISORY ? ` (${off} job-moving ships without one; unlimited ULW holds at ${BET_OFF_HOLD})` : ""} — name one this wave (\`Bet: <capability> — <path> — first slice\`) or \`Bet: none — why\`.`;
  }
  return undefined;
}
