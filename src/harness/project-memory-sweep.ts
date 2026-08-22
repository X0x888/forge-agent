/**
 * Project-memory hygiene: leftover this-cycle readings and superseded notes.
 *
 * Cross-session memory is for durable conventions/gotchas/constraints.
 * ULW "this cycle" readings and ship lists do not belong there — they
 * re-steer later sessions. Newer notes that negate an older claim should
 * retire the stale one.
 *
 * Pure classifiers live here. Apply/archive is in project-memory.ts so the
 * store write path stays in one module.
 */
import type {
  ProjectMemoryArchiveReason,
  ProjectMemoryKind,
  ProjectMemoryRecord,
} from "./project-memory.js";
import { isFalsy } from "../util/bool.js";

export type { ProjectMemoryArchiveReason };

export interface ProjectMemorySweepHit {
  id: string;
  kind: ProjectMemoryKind;
  text: string;
  source: ProjectMemoryRecord["source"];
  reason: ProjectMemoryArchiveReason;
  detail: string;
  /** Auto-archive (agent/import). User-written cycle notes are remind-only. */
  auto: boolean;
}

export interface ProjectMemorySweepResult {
  hits: ProjectMemorySweepHit[];
  archived: ProjectMemorySweepHit[];
  reviewable: ProjectMemorySweepHit[];
  applied: boolean;
  activeBefore: number;
  activeAfter: number;
}

const CYCLE_SCOPED_RE: RegExp[] = [
  /\bthis cycle\b/i,
  /\bthis wave\b/i,
  /\bdaily[- ]loop reading\b/i,
  /\breading\s*\(\s*this cycle\s*\)/i,
  /\bships:\s*\//i,
  /\b(?:wave|cycle)\s+\d+\s+(?:reading|mandate|ship)\b/i,
];

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "via",
  "from",
  "that",
  "this",
  "then",
  "than",
  "into",
  "must",
  "use",
  "uses",
  "used",
  "using",
  "when",
  "after",
  "before",
  "plus",
  "also",
  "only",
  "just",
  "not",
  "never",
  "instead",
  "does",
  "did",
  "will",
  "can",
  "should",
  "off",
  "out",
  "are",
  "is",
  "be",
  "been",
  "was",
  "were",
  "it",
  "its",
  "as",
  "at",
  "by",
  "so",
  "if",
  "but",
  "no",
  "yes",
  "you",
  "your",
  "we",
  "our",
  "they",
  "them",
  "their",
  "auto",
  "default",
  "true",
  "false",
  "null",
  "keep",
  "stays",
  "stay",
]);

const SHORT_KEEP = new Set(["git", "ulw", "sha", "cwd", "tmp"]);

/** Too generic to count as a negated claim by themselves. */
const WEAK_TOKENS = new Set([
  "land",
  "src",
  "file",
  "path",
  "test",
  "tests",
  "live",
  "under",
  "agent",
  "keep",
  "next",
  "empty",
  "still",
  "key",
  "card",
  "note",
  "plus",
  "from",
  "with",
  "that",
  "this",
  "closer",
  "login",
  "slash",
  "apply",
  "restore",
  "clean",
  "work",
]);

const GIT_CLAIM = new Set([
  "stash",
  "commit",
  "push",
  "apply",
  "restore",
  "porcelain",
]);

const NEGATION_RE =
  /\b(not|never|no longer|instead of|do not|don't|does not|did not)\b(.{0,48})/gi;

/** Default on. FORGE_MEMORY_SWEEP=0 disables auto-archive (explicit prune still works). */
export function projectMemorySweepEnabled(): boolean {
  const v = process.env.FORGE_MEMORY_SWEEP;
  if (v == null || String(v).trim() === "") return true;
  return !isFalsy(v);
}

/** True when text is a session/ULW-scoped reading, not a durable project note. */
export function looksLikeCycleScopedMemory(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  return CYCLE_SCOPED_RE.some((re) => {
    re.lastIndex = 0;
    return re.test(t);
  });
}

export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  const raw = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ");
  for (const tok of raw.split(/\s+/)) {
    if (!tok || STOP.has(tok)) continue;
    if (tok.length >= 4 || SHORT_KEEP.has(tok)) out.add(tok);
  }
  return out;
}

export function negatedContentTokens(text: string): Set<string> {
  const out = new Set<string>();
  const src = String(text || "");
  NEGATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NEGATION_RE.exec(src))) {
    for (const tok of contentTokens(m[2] || "")) out.add(tok);
  }
  return out;
}

function intersection(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  const inter = intersection(a, b).size;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function clip(text: string, n = 72): string {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function canAutoArchive(r: ProjectMemoryRecord, reason: ProjectMemoryArchiveReason): boolean {
  if (r.source === "user") return false;
  if (r.kind === "constraint" && reason !== "cycle-scoped") return false;
  return true;
}

function isDuplicate(
  older: ProjectMemoryRecord,
  newer: ProjectMemoryRecord,
): boolean {
  const a = contentTokens(older.text);
  const b = contentTokens(newer.text);
  if (a.size < 5 || b.size < 5) return false;
  const inter = intersection(a, b).size;
  if (inter < 5) return false;
  const coverageOlder = inter / a.size;
  if (coverageOlder >= 0.85) return true;
  return jaccard(a, b) >= 0.68;
}

function distinctiveTokens(tokens: Iterable<string>): string[] {
  const out: string[] = [];
  const set = tokens instanceof Set ? tokens : new Set(tokens);
  for (const tok of set) {
    if (WEAK_TOKENS.has(tok)) continue;
    if (tok.length >= 5) out.push(tok);
  }
  if (
    set.has("git") &&
    [...set].some((t) => GIT_CLAIM.has(t)) &&
    !out.includes("git")
  ) {
    out.push("git");
  }
  return out;
}

function isSuperseded(
  older: ProjectMemoryRecord,
  newer: ProjectMemoryRecord,
): { hit: boolean; shared: string[] } {
  const newerNeg = negatedContentTokens(newer.text);
  const distinctiveNeg = distinctiveTokens(newerNeg);
  if (distinctiveNeg.length < 2) return { hit: false, shared: [] };
  const olderTok = contentTokens(older.text);
  const olderNeg = negatedContentTokens(older.text);
  const shared = distinctiveNeg.filter(
    (tok) => olderTok.has(tok) && !olderNeg.has(tok),
  );
  return { hit: shared.length >= 2, shared };
}

/**
 * Classify active records. Does not mutate.
 * Priority per record: cycle-scoped, then superseded, then duplicate.
 */
export function classifyStaleProjectMemory(
  records: readonly ProjectMemoryRecord[],
): ProjectMemorySweepHit[] {
  const active = records
    .map((r, index) => ({ r, index }))
    .filter((x) => x.r.status === "active");
  const hits = new Map<string, ProjectMemorySweepHit>();

  const add = (hit: ProjectMemorySweepHit): void => {
    const prev = hits.get(hit.id);
    if (!prev) {
      hits.set(hit.id, hit);
      return;
    }
    const rank: Record<ProjectMemoryArchiveReason, number> = {
      "cycle-scoped": 0,
      superseded: 1,
      duplicate: 2,
    };
    if (rank[hit.reason] < rank[prev.reason]) hits.set(hit.id, hit);
  };

  for (const { r } of active) {
    if (!looksLikeCycleScopedMemory(r.text)) continue;
    add({
      id: r.id,
      kind: r.kind,
      text: r.text,
      source: r.source,
      reason: "cycle-scoped",
      detail: "this-cycle / this-wave reading — belongs in session memory, not project",
      auto: canAutoArchive(r, "cycle-scoped"),
    });
  }

  const ordered = [...active].sort(
    (a, b) => a.r.at.localeCompare(b.r.at) || a.index - b.index,
  );

  for (let i = 0; i < ordered.length; i++) {
    const older = ordered[i]!.r;
    const olderHit = hits.get(older.id);
    if (olderHit?.reason === "cycle-scoped" && olderHit.auto) continue;
    for (let j = i + 1; j < ordered.length; j++) {
      const newer = ordered[j]!.r;
      const newerHit = hits.get(newer.id);
      if (newerHit?.reason === "cycle-scoped" && newerHit.auto) continue;
      if (older.text.trim().toLowerCase() === newer.text.trim().toLowerCase()) {
        continue;
      }
      const sup = isSuperseded(older, newer);
      if (sup.hit) {
        add({
          id: older.id,
          kind: older.kind,
          text: older.text,
          source: older.source,
          reason: "superseded",
          detail: `negated by later ${newer.kind} (${sup.shared.slice(0, 4).join(", ")})`,
          auto: canAutoArchive(older, "superseded"),
        });
        break;
      }
      if (isDuplicate(older, newer)) {
        add({
          id: older.id,
          kind: older.kind,
          text: older.text,
          source: older.source,
          reason: "duplicate",
          detail: `restated by later ${newer.kind}`,
          auto: canAutoArchive(older, "duplicate"),
        });
        break;
      }
    }
  }

  return [...hits.values()];
}

export function formatProjectMemoryBannerLine(opts: {
  active: number;
  archived?: readonly ProjectMemorySweepHit[];
  reviewable?: readonly ProjectMemorySweepHit[];
  leftoverDry?: readonly ProjectMemorySweepHit[];
}): string | null {
  const archived = opts.archived?.length ?? 0;
  const reviewable = opts.reviewable?.length ?? 0;
  const leftoverDry = opts.leftoverDry?.length ?? 0;
  if (opts.active <= 0 && archived <= 0 && leftoverDry <= 0) return null;
  const bits: string[] = [];
  bits.push(opts.active > 0 ? `${opts.active} active` : "none");
  if (archived > 0) {
    bits.push(`archived ${archived} leftover`);
  } else if (leftoverDry > 0) {
    bits.push(`${leftoverDry} leftover — /memory project prune`);
  }
  if (reviewable > 0) {
    bits.push(
      `${reviewable} user cycle-note${reviewable === 1 ? "" : "s"} kept`,
    );
  }
  bits.push("Next  /memory project");
  return `memory  ·  ${bits.join("  ·  ")}`;
}

export function formatProjectMemoryPruneCard(
  result: ProjectMemorySweepResult,
  opts?: { dry?: boolean },
): string {
  const dry = Boolean(opts?.dry);
  const n = dry ? result.hits.filter((h) => h.auto).length : result.archived.length;
  const review = result.reviewable.length;
  const lines: string[] = [];
  if (n === 0 && review === 0) {
    lines.push("memory prune  ·  none");
  } else if (dry) {
    lines.push(`memory prune  ·  ${n} leftover (dry)`);
  } else {
    lines.push(`memory prune  ·  archived ${n} leftover`);
  }
  const show = dry
    ? result.hits.filter((h) => h.auto)
    : result.archived;
  for (const h of show.slice(0, 8)) {
    lines.push(`  - [${h.kind}] ${clip(h.text)}  (${h.reason})`);
  }
  if (show.length > 8) lines.push(`  … +${show.length - 8} more`);
  for (const h of result.reviewable.slice(0, 4)) {
    lines.push(`  - [${h.kind}] ${clip(h.text)}  (user — kept)`);
  }
  lines.push(
    dry
      ? "  Next  /memory project prune"
      : "  Next  /memory project",
  );
  return lines.join("\n");
}
