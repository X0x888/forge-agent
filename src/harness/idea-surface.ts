/**
 * Idea-surface hold — one sentence painted onto every chrome.
 *
 * The same-surface hold is per **file**: three declared ships on the same
 * 1–3 production files. The HashPet dogfood (791 waves) never tripped it
 * (streak max 1) while one idea — "sit-days hushes the lecture" — shipped
 * in 114 waves across 33 files and "names the found chew" in 84 waves
 * across 29, ten of them consecutive: toolbar, then miner card, then
 * ticker, then flask, each a different file, each the same sentence.
 * `resolveHomeIntent` went from 4 to 15 arguments and `sitDays >= 2`
 * appeared in 114 places; the closer was always "X names the found chew".
 *
 * This hold keys on the **idea** instead: the distinctive terms and
 * bigrams of the closer, compared against the last IDEA_LOOKBACK credited
 * ships. When one idea has landed on IDEA_FILE_HOLD distinct production
 * files with no file in common — a paint, not a build-out (a capability
 * with a home touches its module on every slice) — unlimited ULW holds
 * until a collapse ship (the idea's files rewired through one new module,
 * or three of them at once), a different idea, or /cycle 0.
 *
 * Structural, not a score: the terms come from the closer, the files from
 * the dirty tree. On-bet and on-contract ships are **not** exempt — the
 * bet exemption is exactly how the HashPet paint got credited. Terms that
 * appear in most of the window ("never a hostname" rode 171 closers) are
 * mantras, not ideas, and are dropped before comparing.
 *
 * Kill-switch: FORGE_ULW_IDEA_HOLD=0.
 */

import { isFalsy } from "../util/bool.js";
import { productionRelPaths, type ProdEditKind } from "./job-delta.js";

/** Credited ships compared against the new closer. */
export const IDEA_LOOKBACK = 10;
/** Distinct production files carrying one idea before unlimited ULW holds. */
export const IDEA_FILE_HOLD = 4;
/** Distinct files before the re-anchor warns. */
export const IDEA_FILE_ADVISORY = 3;
/** Shared distinctive terms (or one bigram + one term) that make two closers one idea. */
export const IDEA_MIN_SHARED = 2;
/** A term present in this share of the window is a mantra, not an idea. */
export const IDEA_MANTRA_SHARE = 0.6;
/** Carrier files a single ship must touch to count as a collapse sweep. */
export const IDEA_COLLAPSE_SWEEP = 3;

export function ideaHoldEnabled(): boolean {
  return !isFalsy(process.env.FORGE_ULW_IDEA_HOLD ?? "1");
}

/**
 * Closer ritual and harness vocabulary — never an idea. Kept apart from
 * same-surface's RITUAL_WORD_RE: this list is about what a wave *says*
 * (verify, exit, green), not about what makes two surfaces one.
 */
const IDEA_STOP = new Set<string>([
  "wave", "waves", "ship", "shipped", "landed", "using", "verify", "verified",
  "proof", "proved", "prove", "exit", "green", "clean", "tests", "test", "files",
  "file", "suite", "check", "checks", "typecheck", "build", "npm", "run", "still",
  "only", "never", "always", "also", "then", "than", "that", "this", "these",
  "those", "with", "from", "into", "onto", "over", "under", "after", "before",
  "when", "while", "where", "which", "what", "your", "they", "them", "their",
  "have", "been", "does", "done", "will", "would", "should", "could", "first",
  "last", "next", "same", "other", "every", "each", "more", "most", "less",
  "keeps", "keep", "kept", "stays", "stay", "stayed", "wins", "win", "won",
  "reads", "read", "says", "said", "prints", "print", "shows", "show", "shown",
  "line", "lines", "copy", "text", "label", "title", "caption", "string",
  "player", "user", "users", "companion", "forge", "harness", "veteran",
  "consolidation", "hostile", "review", "reviewer", "regressions", "leftover",
  "leftovers", "stubs", "serendipity", "reading", "cycle", "complete",
  "extension", "src", "lib", "components", "popup", "background", "index",
  "true", "false", "null", "undefined", "return", "const", "function",
  // Filler adverbs / prepositions: never an idea on their own.
  "again", "round", "above", "below", "since", "until", "there", "here",
  "another", "within", "without", "across", "through", "toward", "towards",
  "between", "because", "already", "instead", "rather", "really", "quite",
  "longer", "later", "earlier", "sooner", "twice", "once", "thrice",
]);

function tokensOf(text: string): string[] {
  // Backticked identifiers are the idea carriers (`pokeHashingLine`,
  // `sitDays`); keep them whole and lowercase everything else.
  const raw = (text || "").replace(/[*_]+/g, " ");
  const out: string[] = [];
  for (const piece of raw.split(/[^A-Za-z0-9]+/)) {
    const w = piece.toLowerCase();
    if (w.length < 4) continue;
    if (/^\d+$/.test(w)) continue;
    if (IDEA_STOP.has(w)) continue;
    out.push(w);
  }
  return out;
}

/** Distinctive terms (≥5 chars) plus adjacent bigrams; order-free set. */
export function ideaSignature(text: string): string[] {
  const toks = tokensOf(text);
  const set = new Set<string>();
  for (const t of toks) if (t.length >= 5) set.add(t);
  for (let i = 0; i < toks.length - 1; i++) {
    const g = `${toks[i]} ${toks[i + 1]}`;
    if (g.length >= 9) set.add(g);
  }
  return [...set];
}

/**
 * Terms that ride most of the window are the run's mantra ("never a
 * hostname", "sit days"), not this ship's idea. Computed over the window
 * every time so a run that changes its mantra re-learns it.
 */
export function ideaMantras(windowSigs: string[][]): Set<string> {
  const out = new Set<string>();
  if (windowSigs.length < 4) return out;
  const counts = new Map<string, number>();
  for (const sig of windowSigs) {
    for (const t of new Set(sig)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const bar = Math.ceil(windowSigs.length * IDEA_MANTRA_SHARE);
  for (const [t, n] of counts) if (n >= bar) out.add(t);
  return out;
}

/** Shared idea terms after mantra removal. */
export function sharedIdeaTerms(
  a: string[],
  b: string[],
  mantras: Set<string> = new Set(),
): string[] {
  const bs = new Set(b);
  const out: string[] = [];
  for (const t of a) {
    if (mantras.has(t)) continue;
    if (bs.has(t)) out.push(t);
  }
  return out;
}

/** Two closers carry one idea: two shared terms, or a shared bigram plus one term. */
export function sameIdea(
  a: string[],
  b: string[],
  mantras: Set<string> = new Set(),
): string[] | null {
  const shared = sharedIdeaTerms(a, b, mantras);
  if (shared.length < IDEA_MIN_SHARED) return null;
  const bigram = shared.some((t) => t.includes(" "));
  if (bigram || shared.length >= 3) return shared;
  return null;
}

/** `kind:file|file` → production files. */
export function treeKeyFiles(key: string | undefined): string[] {
  const k = (key || "").trim();
  if (!k) return [];
  const idx = k.indexOf(":");
  const rest = idx >= 0 ? k.slice(idx + 1) : k;
  return rest
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p && /[./]/.test(p));
}

export interface IdeaWaveFact {
  classText?: string;
  summary?: string;
  treeSurfaceKey?: string;
  chrome?: boolean;
}

export interface IdeaNote {
  /** Shared terms with the window — the idea. Empty when this closer is its own idea. */
  terms: string[];
  /** Distinct production files the idea has landed on, this ship included. */
  files: string[];
  /** A file every carrier ship touched — the idea has a home (a build-out, not a paint). */
  home?: string;
  /** IDEA_FILE_HOLD distinct files, no home → hold. */
  hold: boolean;
}

/**
 * Compare a new declared ship against the last IDEA_LOOKBACK credited
 * ships. Returns the idea it continues (terms + distinct carrier files)
 * or an empty note when it is its own idea.
 */
export function ideaNoteFor(
  prevWaves: IdeaWaveFact[],
  closer: string,
  paths: string[] | undefined,
): IdeaNote {
  const empty: IdeaNote = { terms: [], files: [], hold: false };
  const window = prevWaves
    .filter((w) => (w.classText || w.summary || "").trim())
    .slice(-IDEA_LOOKBACK);
  if (!window.length) return empty;
  const mine = ideaSignature(closer);
  if (!mine.length) return empty;
  const sigs = window.map((w) => ideaSignature(w.classText || w.summary || ""));
  const mantras = ideaMantras([...sigs, mine]);
  const myFiles = productionRelPaths(paths || []);
  const carriers: string[][] = [];
  const termCounts = new Map<string, number>();
  for (let i = 0; i < window.length; i++) {
    const shared = sameIdea(mine, sigs[i]!, mantras);
    if (!shared) continue;
    const files = treeKeyFiles(window[i]!.treeSurfaceKey);
    if (!files.length) continue;
    carriers.push(files);
    for (const t of shared) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
  }
  if (!carriers.length) return empty;
  if (myFiles.length) carriers.push(myFiles);
  const distinct = new Set<string>();
  for (const fs of carriers) for (const f of fs) distinct.add(f);
  // A home: one file present in every carrier ship (the module the idea
  // lives in). Slices of a real capability all touch it.
  let home: string | undefined;
  for (const f of carriers[0]!) {
    if (carriers.every((fs) => fs.includes(f))) {
      home = f;
      break;
    }
  }
  const terms = [...termCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t)
    .slice(0, 6);
  const files = [...distinct].slice(0, 12);
  return {
    terms,
    files,
    home,
    hold: !home && files.length >= IDEA_FILE_HOLD,
  };
}

export interface IdeaHoldState {
  terms: string[];
  files: string[];
  wave: number;
  admits: number;
}

/**
 * Does this ship release an idea hold? A different idea (no overlap with
 * the held terms) does; so does a collapse — a new module touched together
 * with a carrier file, or a sweep across IDEA_COLLAPSE_SWEEP carriers. A
 * "new module" is the diff's `new-module` kind or, when the diff is not
 * available, a production path the run's ledger has never recorded.
 */
export function ideaHoldReleases(
  hold: IdeaHoldState,
  closer: string,
  paths: string[] | undefined,
  kind: ProdEditKind | string | undefined,
  opts?: { knownFiles?: string[] },
): "different" | "collapse" | null {
  const files = productionRelPaths(paths || []);
  const carriersTouched = files.filter((f) => hold.files.includes(f)).length;
  if (kind === "new-module" && carriersTouched >= 1) return "collapse";
  if (opts?.knownFiles && carriersTouched >= 1) {
    const known = new Set([...opts.knownFiles, ...hold.files]);
    if (files.some((f) => !known.has(f))) return "collapse";
  }
  if (carriersTouched >= IDEA_COLLAPSE_SWEEP) return "collapse";
  const shared = sharedIdeaTerms(ideaSignature(closer), hold.terms);
  if (shared.length < IDEA_MIN_SHARED) return "different";
  return null;
}

export function formatIdeaHoldAdmit(hold: IdeaHoldState): string {
  return [
    `[Forge ULW cycle driver] Stop blocked — one idea painted onto ${hold.files.length} surfaces: "${hold.terms.slice(0, 4).join(", ")}" landed on ${hold.files.slice(0, 6).join(", ")}${hold.files.length > 6 ? ", …" : ""}.`,
    `The ${IDEA_FILE_HOLD}th file for one sentence is not a new ship — it is the same sentence. Collapse it: one formatter / table in ONE new module (name it in a \`Reading:\`), and the carrier files import it. That collapse ship releases (a new module touched with a carrier, or ${IDEA_COLLAPSE_SWEEP}+ carriers rewired at once).`,
    "A different idea also releases — its own 4th surface will hold again. Or /cycle 0. Stuck-wall will not release this hold.",
  ].join("\n");
}

export function formatIdeaStatusLine(
  hold: IdeaHoldState | undefined,
  note: { terms?: string[]; files?: string[] } | undefined,
): string | undefined {
  if (hold) {
    return `  Idea surface: hold — "${hold.terms.slice(0, 3).join(", ")}" on ${hold.files.length} files; collapse into one module, a different idea, or /cycle 0`;
  }
  const n = note?.files?.length ?? 0;
  if (n >= IDEA_FILE_ADVISORY && note?.terms?.length) {
    return `  Idea surface: "${note.terms.slice(0, 3).join(", ")}" on ${n} files — the next surface holds (${IDEA_FILE_HOLD}); collapse it instead`;
  }
  return undefined;
}

export function formatIdeaReanchorLine(
  note: { terms?: string[]; files?: string[] } | undefined,
): string | undefined {
  const n = note?.files?.length ?? 0;
  if (n < IDEA_FILE_ADVISORY || !note?.terms?.length) return undefined;
  return `⚠ One idea ("${note.terms.slice(0, 3).join(", ")}") has landed on ${n} files with no shared module — the ${IDEA_FILE_HOLD}th holds. Collapse it into one formatter that those files import, not another surface.`;
}
