/**
 * Cycle artifacts — plan.md and review.md — parsed structurally.
 *
 * The Planner and the Reviewer are fresh-context subagents; their whole
 * output is a document in a fixed shape. The harness reads labelled lines,
 * never intent: `Verdict:` decides whether the run continues, `Items:` seed
 * the executor's board, `Verify:` is harvested with the strict check-command
 * filter. A document that does not parse is a failed role run, reported as
 * such — the harness does not guess.
 */
import { looksLikeCheckCommand } from "../declared-checks.js";
import type {
  CyclePlanItem,
  CyclePromise,
  CycleRecord,
  CycleReviewNotes,
  PlanVerdict,
  ReviewVerdict,
} from "./state.js";

export const PLAN_COMPLETE_RE = /\*{0,2}Plan complete\.?\*{0,2}/i;

/**
 * The executor's declared tokens in its closers, read as labelled lines,
 * never as intent: the same-line remainder and any bullet lines directly
 * under a bare label.
 *
 * `Serendipity:` — what it noticed and did not build (the protocol promises
 * the line reaches the Reviewer and the next Planner).
 * `Dispute:` — a Reviewer revision it can show was wrong, with the evidence
 * (forge-absorb: push back with evidence; the next Planner reads it, the
 * tree is not re-argued).
 */
export type ExecutorLabel = "Serendipity" | "Dispute";
const LABELLED_KEEP = 12;

function labelledLineRe(label: ExecutorLabel): RegExp {
  return new RegExp(`^\\s*(?:[-*•]\\s*)?\\*{0,2}${label}\\*{0,2}\\s*:\\s*\\*{0,2}\\s*(.*)$`, "i");
}

export function extractLabelledLines(text: string, label: ExecutorLabel): string[] {
  const re = labelledLineRe(label);
  const out: string[] = [];
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const same = m[1].trim().replace(/\*{1,2}$/, "").trim();
    if (same && !/^(?:none|nothing|n\/a|-)\.?$/i.test(same)) out.push(same);
    if (same) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const bm = lines[j].match(/^\s*[-*•]\s+(.+)$/);
      if (!bm) break;
      const body = bm[1].trim();
      if (body && !/^(?:none|nothing|n\/a)\.?$/i.test(body)) out.push(body);
      i = j;
    }
  }
  const seen = new Set<string>();
  return out
    .map((l) => l.replace(/\s+/g, " ").slice(0, 300))
    .filter((l) => {
      const k = l.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, LABELLED_KEEP);
}

export function extractSerendipityLines(text: string): string[] {
  return extractLabelledLines(text, "Serendipity");
}

export function extractDisputeLines(text: string): string[] {
  return extractLabelledLines(text, "Dispute");
}

export interface ParsedPlan {
  title: string;
  verdict: PlanVerdict;
  identity?: string;
  direction?: string;
  /** What the Planner ran or opened before judging — the product, not the tree. */
  looked?: string;
  /** The alternatives weighed, one per gap bin plus `leave it` (forge-shape: no plan without the roads not taken). */
  considered: string[];
  /** Why this cycle beats leaving it, for the user in Identity — the Planner's claim before the spend. */
  worthClaim?: string;
  /** The product's promises as inspected, when the plan carries them (a scout does; a single-brief plan may). */
  promises: CyclePromise[];
  /** Declared and accepted by looksLikeCheckCommand; undefined when "none". */
  verifyCommand?: string;
  verifyNone?: string;
  /** Raw Verify: text that failed the strict harvest. */
  verifyRefused?: string;
  items: CyclePlanItem[];
  outOfScope: string[];
  guidelines?: string;
  operator: string[];
  /** Why the plan is fulfilled / blocked (verdict line remainder). */
  verdictNote?: string;
}

/** The Planner's turn-1 document: what it saw before it was handed the record. */
export interface ParsedScout {
  identity?: string;
  looked?: string;
  promises: CyclePromise[];
  considered: string[];
}

const SECTION_RE =
  /^\s*(?:#{1,6}\s*)?\*{0,2}(Verdict|Identity|Direction|Looked|Considered|Worth the cycle|Promises|Verify|Items|Out of scope|Guidelines|Operator|Title|Fulfillment|Revisions|Must-fix|Architecture|Worth|Notes|Summary)\*{0,2}\s*[:.]\s*(.*)$/i;

const LEAVE_IT_RE = /^\*{0,2}leave\s+it\b/i;

/**
 * `<promise> — kept | broken | absent | unknown — <where seen>`; `(kept)` at the end
 * is the short form. A line with no state is not a promise row — the
 * harness does not guess which way the Planner meant it.
 */
function parsePromiseLines(lines: string[] | undefined): CyclePromise[] {
  const out: CyclePromise[] = [];
  for (const b of bullets(lines)) {
    const m = b.match(/^(.*?)\s+(?:—|–|-|\|)\s*\*{0,2}(kept|broken|absent|unknown)\*{0,2}\b\s*(?:[—–:|-]\s*)?(.*)$/i);
    if (m) {
      const seen = (m[3] || "").trim();
      out.push({
        text: m[1].trim().slice(0, 240),
        state: m[2].toLowerCase() as CyclePromise["state"],
        ...(seen ? { seen: seen.slice(0, 240) } : {}),
      });
      continue;
    }
    const p = b.match(/^(.*?)\s*\(\s*(kept|broken|absent|unknown)\s*\)\s*$/i);
    if (p) out.push({ text: p[1].trim().slice(0, 240), state: p[2].toLowerCase() as CyclePromise["state"] });
  }
  return out;
}

function splitSections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const rawLine of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const m = line.match(SECTION_RE);
    if (m) {
      current = m[1].toLowerCase().replace(/\s+/g, "-");
      // `**Verdict.** continue` leaves `** continue` after the label; `**Items.**`
      // leaves a lone `**`. Strip leftover bold markers so the remainder is the value.
      const rest = (m[2] || "").replace(/^\*+\s*|\s*\*+$/g, "").trim();
      const arr = out.get(current) ?? [];
      if (rest) arr.push(rest);
      out.set(current, arr);
      continue;
    }
    if (current) {
      const arr = out.get(current) ?? [];
      arr.push(line);
      out.set(current, arr);
    }
  }
  return out;
}

function firstLine(lines: string[] | undefined): string | undefined {
  if (!lines) return undefined;
  const t = lines.map((l) => l.trim()).find(Boolean);
  return t || undefined;
}

function paragraph(lines: string[] | undefined): string | undefined {
  if (!lines) return undefined;
  const body = lines
    .map((l) => l.trim())
    .filter((l) => l && !/^[-*•]?\s*none\.?$/i.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return body || undefined;
}

function bullets(lines: string[] | undefined): string[] {
  if (!lines) return [];
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    const m = l.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    const body = (m ? m[1] : l).trim();
    // "none" / "omit" / "n/a" are the labelled way to say the section is empty.
    if (!body || /^(?:none|omit(?:ted)?|n\/a|nothing|-)\.?$/i.test(body)) continue;
    out.push(body.replace(/\s+/g, " "));
  }
  return out;
}

function titleOf(text: string, sections: Map<string, string[]>): string {
  const explicit = firstLine(sections.get("title"));
  if (explicit) return explicit.slice(0, 120);
  const h1 = text.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  if (h1) {
    const stripped = h1.replace(/^cycle\s+\d+\s+(?:plan|review|scout|look)\s*(?:[—–:-]\s*)?/i, "").trim();
    if (stripped) return stripped.slice(0, 120);
  }
  return "";
}

function parsePlanVerdict(raw: string | undefined): { verdict: PlanVerdict; note?: string } {
  const t = (raw || "").trim();
  const m = t.match(/^(continue|fulfilled|blocked)\b\s*(?:[—–:-]\s*)?(.*)$/i);
  if (!m) return { verdict: "continue", note: t || undefined };
  return {
    verdict: m[1].toLowerCase() as PlanVerdict,
    note: (m[2] || "").trim() || undefined,
  };
}

export function parsePlanItemLine(body: string, index: number): CyclePlanItem {
  // "<title> — files: a, b — serves: <job> — red now: <seen> — proof: <cmd>"  (— or | as separators)
  const parts = body.split(/\s+(?:—|–|\|)\s+/).map((p) => p.trim()).filter(Boolean);
  let title = parts[0] || body;
  const files: string[] = [];
  let proof: string | undefined;
  let serves: string | undefined;
  let redNow: string | undefined;
  // The prose labels keep an unlabelled segment that follows them (a dash
  // inside "red now: ran it — no card"); `files:` stays strict.
  let prose: "proof" | "serves" | "redNow" | null = null;
  for (const p of parts.slice(1)) {
    const fm = p.match(/^files?\s*:\s*(.+)$/i);
    if (fm) {
      prose = null;
      files.push(
        ...fm[1]
          .split(/[,\s]+/)
          .map((f) => f.replace(/^`|`$/g, "").trim())
          .filter((f) => f && f !== "-" && f !== "none"),
      );
      continue;
    }
    const pm = p.match(/^(?:proof|verify|proves?)\s*:\s*(.+)$/i);
    if (pm) {
      prose = "proof";
      const raw = pm[1].trim();
      proof = /^`[^`]*`$/.test(raw) ? raw.slice(1, -1).trim() : raw;
      continue;
    }
    const sm = p.match(/^serves?\s*:\s*(.+)$/i);
    if (sm) {
      prose = "serves";
      serves = sm[1].trim();
      continue;
    }
    const rm = p.match(/^red(?:\s+now)?\s*:\s*(.+)$/i);
    if (rm) {
      prose = "redNow";
      redNow = rm[1].trim();
      continue;
    }
    if (prose === "proof" && proof) {
      proof = `${proof} — ${p}`;
      continue;
    }
    if (prose === "serves" && serves) {
      serves = `${serves} — ${p}`;
      continue;
    }
    if (prose === "redNow" && redNow) {
      redNow = `${redNow} — ${p}`;
      continue;
    }
    // Unlabelled segments before any label belong to the title.
    title = `${title} — ${p}`;
  }
  title = title.replace(/\*{1,2}/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    id: `i${index + 1}`,
    title,
    files,
    proof,
    ...(serves ? { serves: serves.replace(/\s+/g, " ").slice(0, 300) } : {}),
    ...(redNow ? { redNow: redNow.replace(/\s+/g, " ").slice(0, 300) } : {}),
    status: "open",
  };
}

/**
 * Why a plan did not parse, for the Planner's retry. Empty when it parses.
 * Presence and shape only — the same rules `parsePlanArtifact` applies.
 */
export function explainPlanParseFailure(text: string): string {
  const sections = splitSections(text);
  const problems: string[] = [];
  if (!sections.has("verdict") && !sections.has("items")) {
    return "no Verdict: line (the document has none of the plan's labelled sections)";
  }
  const { verdict } = parsePlanVerdict(firstLine(sections.get("verdict")));
  if (verdict !== "continue") return "";
  const items = bullets(sections.get("items")).map(parsePlanItemLine);
  if (items.length === 0) problems.push("Verdict: continue with an empty Items: list");
  const considered = bullets(sections.get("considered"));
  if (considered.length < 2) {
    problems.push(
      "Considered: missing or a single entry (a continue plan lists the alternatives it weighed — one per gap bin — and leave it among them)",
    );
  } else if (!considered.some((c) => LEAVE_IT_RE.test(c))) {
    problems.push("Considered: has no `leave it` entry (say why leaving the product as it stands lost)");
  }
  items.forEach((it, i) => {
    const missing = [!it.serves ? "serves:" : "", !it.redNow ? "red now:" : ""].filter(Boolean);
    if (missing.length) problems.push(`item ${i + 1} (${it.title.slice(0, 60)}) has no ${missing.join(" / ")}`);
  });
  return problems.join("; ");
}

export function parsePlanArtifact(text: string): ParsedPlan | null {
  const sections = splitSections(text);
  if (!sections.has("verdict") && !sections.has("items")) return null;
  const { verdict, note } = parsePlanVerdict(firstLine(sections.get("verdict")));
  const items = bullets(sections.get("items")).map(parsePlanItemLine);
  const considered = bullets(sections.get("considered"));
  const verifyRaw = firstLine(sections.get("verify"));
  let verifyCommand: string | undefined;
  let verifyNone: string | undefined;
  let verifyRefused: string | undefined;
  if (verifyRaw) {
    const noneM = verifyRaw.match(/^none\b\s*(?:[—–:-]\s*)?(.*)$/i);
    if (noneM) {
      verifyNone = noneM[1]?.trim() || "no project check declared";
    } else {
      const code = verifyRaw.match(/`([^`]{2,220})`/)?.[1] || verifyRaw;
      const cleaned = code.replace(/\s+(?:—|–)\s+.*$/, "").trim();
      if (looksLikeCheckCommand(cleaned)) verifyCommand = cleaned;
      else verifyRefused = cleaned;
    }
  }
  if (verdict === "continue") {
    // The shape a continue plan owes (forge-shape: the roads not taken,
    // leave-it among them; forge-surface: every item traceable to the job;
    // forge-redgreen: every item red before it is planned). Presence only.
    if (items.length === 0) return null;
    if (considered.length < 2 || !considered.some((c) => LEAVE_IT_RE.test(c))) return null;
    if (items.some((i) => !i.serves || !i.redNow)) return null;
  }
  return {
    title: titleOf(text, sections) || items[0]?.title.slice(0, 80) || "cycle plan",
    verdict,
    verdictNote: note,
    identity: paragraph(sections.get("identity")),
    direction: paragraph(sections.get("direction")),
    looked: paragraph(sections.get("looked")),
    considered,
    worthClaim: paragraph(sections.get("worth-the-cycle")),
    promises: parsePromiseLines(sections.get("promises")),
    verifyCommand,
    verifyNone,
    verifyRefused,
    items,
    outOfScope: bullets(sections.get("out-of-scope")),
    guidelines: paragraph(sections.get("guidelines")),
    operator: bullets(sections.get("operator")),
  };
}

const LOOK_COULD_NOT_RE =
  /could not run|never opened|did not open popup|playwright mcp never/i;
const LOOK_NEGATED_OPEN_RE =
  /could not run|never(?:\s+\w+){0,3}\s+opened|did(?: not|n't) open(?: popup)?|could not open|playwright mcp never(?: initialized)?/gi;
/** Opening evidence after stripping fail phrases. Bare "lease" is the brief hint, not a look. */
const LOOK_DID_OPEN_RE =
  /\b(?:clicked|clicking|click|loaded|loading|load|opened|opening|navigated|unpacked)\b|file:\/\/|bash chrome|SMOKE_[A-Z0-9_]+_OK|\bgodot\b[^\n]*--headless|headless smoke/i;
const LOOK_INFRA_RE =
  /maxTurns?\s*\(\d+\)\s*reached|look turn ended before|turn budget ended before|Playwright MCP was down.{0,80}(?:never|could not)|Chrome for Testing died|GPU unusable|godot(?:\.app)? (?:quit unexpectedly|crashed)|Vulkan[^\n]{0,40}hang/i;

/** True when Looked: reports a failed look and does not also describe opening the product. */
export function lookCouldNotLook(looked: string): boolean {
  const t = (looked || "").trim();
  if (!t || !LOOK_COULD_NOT_RE.test(t)) return false;
  const rest = t.replace(LOOK_NEGATED_OPEN_RE, " ");
  return !LOOK_DID_OPEN_RE.test(rest);
}

/** Chrome/Godot/MCP died or the look-turn budget ran out before a sitting. */
export function lookInfraFailed(looked: string): boolean {
  return LOOK_INFRA_RE.test(String(looked || ""));
}

/** The Reviewer's turn-1 document: what it ran or opened before the diff. Null when there is no Looked: line. */
export function parseLookArtifact(text: string): { looked: string; couldNotLook: boolean } | null {
  const looked = paragraph(splitSections(text).get("looked"));
  if (!looked) return null;
  return { looked, couldNotLook: lookCouldNotLook(looked) };
}

/**
 * A surface sit is a browser/popup/first-hour claim — not "visit", not
 * go-deeper "walk"/"screen" prose, not a CLI whose proof is npm test / JSON-RPC.
 */
const SURFACE_SIT_RE =
  /\b(?:popup|chrome|browser|sit|door|gallery)\b|first[- ]hour|file:\/\//i;
const CLI_OR_RPC_PROOF_RE =
  /npm\s+test|json-rpc|godot\b[^\n]*--headless|headless smoke|SMOKE_[A-Z0-9_]+_OK/i;

export function isSurfaceSit(items: readonly CyclePlanItem[]): boolean {
  if (!items.length) return false;
  const proofs = items.map((i) => (i.proof ?? "").trim()).filter(Boolean);
  if (proofs.length > 0 && proofs.every((p) => CLI_OR_RPC_PROOF_RE.test(p))) return false;
  return items.some((i) => SURFACE_SIT_RE.test(`${i.proof ?? ""} ${i.redNow ?? ""} ${i.title}`));
}

/**
 * Distinctive tokens in Architecture notes: backticked identifiers, or a
 * normalized 3-word key. Not a meter — a class two shipped reviews named.
 */
const ARCH_STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for", "on",
  "with", "this", "that", "same", "still", "left", "alone", "from", "was",
  "were", "are", "be", "as", "by", "at", "not", "no", "one", "two", "its",
  "but", "had", "has", "have", "been", "into", "over", "than", "then", "they",
  "them", "when", "what", "which", "their", "pre", "existing",
]);

function archWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/`[^`]+`/g, (m) => ` ${m.slice(1, -1)} `)
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !ARCH_STOP.has(w));
}

function normalizeArchHay(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokens a Reviewer's Architecture notes contribute to the class hold. */
export function architectureClassTokens(notes: readonly string[]): string[] {
  const distinctive = new Set<string>();
  const grams = new Set<string>();
  for (const note of notes) {
    const n = String(note || "");
    for (const m of n.matchAll(/`([^`]+)`/g)) {
      const t = m[1].trim().toLowerCase();
      if (t.length >= 2) distinctive.add(t);
    }
    for (const m of n.matchAll(/[a-z0-9]+(?:-[a-z0-9]+)+/gi)) {
      distinctive.add(m[0].toLowerCase());
    }
    const words = archWords(n);
    for (let i = 0; i <= words.length - 3; i++) {
      grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
  }
  return [...distinctive, ...grams];
}

function archTokenRank(t: string): number {
  if (t.includes(" ")) return 2;
  if (t.includes("-")) return 1;
  return 0;
}

/**
 * The class the last two shipped reviews both named, if any. Prefers a
 * backticked identifier, then a hyphenated one, then a 3-word key; longer when tied.
 */
export function recurringArchitectureClass(
  cycles: ReadonlyArray<Pick<CycleRecord, "commitSha" | "architecture">>,
): string | undefined {
  const shipped = cycles.filter((c) => c.commitSha && (c.architecture?.length ?? 0) > 0);
  if (shipped.length < 2) return undefined;
  const a = architectureClassTokens(shipped[shipped.length - 2].architecture ?? []);
  const b = new Set(architectureClassTokens(shipped[shipped.length - 1].architecture ?? []));
  const shared = a.filter((t) => b.has(t));
  if (shared.length) {
    shared.sort((x, y) => archTokenRank(x) - archTokenRank(y) || y.length - x.length);
    return shared[0];
  }
  // Same class named in three shipped reviews anywhere in the run — not only
  // the last two consecutive (HUD clip at cycles 3, 11, 16).
  const counts = new Map<string, number>();
  for (const c of shipped) {
    for (const t of new Set(architectureClassTokens(c.architecture ?? []))) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const triples = [...counts.entries()].filter(([, n]) => n >= 3).map(([t]) => t);
  if (!triples.length) return undefined;
  triples.sort((x, y) => archTokenRank(x) - archTokenRank(y) || y.length - x.length);
  return triples[0];
}

/**
 * When a class has shipped three times, leave-it in Considered: is not enough —
 * the plan must carry an item that names the class (collapse) or not touch the
 * files those reviews already named.
 */
export function architectureClassMustCollapse(
  cycles: ReadonlyArray<Pick<CycleRecord, "commitSha" | "architecture" | "commitFiles">>,
  cls: string,
): boolean {
  const shipped = cycles.filter((c) => c.commitSha && (c.architecture?.length ?? 0) > 0);
  let n = 0;
  for (const c of shipped) {
    if (architectureClassTokens(c.architecture ?? []).some((t) => t === cls || hayMentionsClass(t, cls))) {
      n += 1;
    }
  }
  return n >= 3;
}

function hayMentionsClass(hay: string, cls: string): boolean {
  const n = normalizeArchHay(cls);
  if (!n) return false;
  return ` ${normalizeArchHay(hay)} `.includes(` ${n} `);
}

/** True when an item title/serves names the class, or Considered: leave-it does. */
export function planAddressesArchitectureClass(plan: ParsedPlan, cls: string): boolean {
  if (planCollapsesArchitectureClass(plan, cls)) return true;
  return plan.considered.some((c) => LEAVE_IT_RE.test(c) && hayMentionsClass(c, cls));
}

/** An item (not merely leave-it) names the class. */
export function planCollapsesArchitectureClass(plan: ParsedPlan, cls: string): boolean {
  return plan.items.some((i) => hayMentionsClass(`${i.title} ${i.serves ?? ""}`, cls));
}

export function architectureHoldMessage(cls: string): string {
  return `the last two shipped reviews named the architecture class \`${cls}\`; a continue plan must include an item whose title/serves mentions that class, or \`leave it\` that class in Considered:`;
}

/** The Planner's turn-1 document. Null only when none of its sections is there. */
export function parseScoutArtifact(text: string): ParsedScout | null {
  const sections = splitSections(text);
  if (!["identity", "looked", "promises", "considered"].some((k) => sections.has(k))) return null;
  return {
    identity: paragraph(sections.get("identity")),
    looked: paragraph(sections.get("looked")),
    promises: parsePromiseLines(sections.get("promises")),
    considered: bullets(sections.get("considered")),
  };
}

/** Why a review did not parse, for the Reviewer's retry. Empty when it parses. */
export function explainReviewParseFailure(text: string): string {
  const sections = splitSections(text);
  if (!sections.has("verdict")) {
    return "no Verdict: line (need `ship` | `ship-with-revisions` | `blocked`)";
  }
  const verdict = parseReviewVerdict(firstLine(sections.get("verdict")));
  if (!verdict) return "Verdict: is not ship, ship-with-revisions, or blocked";
  return "";
}

function parseReviewVerdict(raw: string | undefined): ReviewVerdict | null {
  const t = (raw || "").trim().toLowerCase();
  if (/^ship-with-revisions\b/.test(t) || /^ship with revisions\b/.test(t)) return "ship-with-revisions";
  if (/^ship\b/.test(t)) return "ship";
  if (/^blocked\b/.test(t)) return "blocked";
  return null;
}

export function parseReviewArtifact(text: string): CycleReviewNotes | null {
  const sections = splitSections(text);
  const verdict = parseReviewVerdict(firstLine(sections.get("verdict")));
  if (!verdict) return null;
  const fulfillment = bullets(sections.get("fulfillment")).map((b) => {
    const m = b.match(/^(.*?)\s+(?:—|–|-|:)\s*(done|partial|missing)\b\s*(?:[—–:-]\s*)?(.*)$/i);
    if (!m) return { item: b, state: "partial" as const };
    return {
      item: m[1].trim(),
      state: m[2].toLowerCase() as "done" | "partial" | "missing",
      note: (m[3] || "").trim() || undefined,
    };
  });
  return {
    verdict,
    looked: paragraph(sections.get("looked")),
    fulfillment,
    revisions: bullets(sections.get("revisions")),
    mustFix: bullets(sections.get("must-fix")),
    architecture: bullets(sections.get("architecture")),
    worth: paragraph(sections.get("worth")),
    operator: bullets(sections.get("operator")),
  };
}

/** The exact shape the Planner's first turn ends with — written before it is handed the record. */
export function scoutArtifactContract(cycle: number): string {
  return [
    `# Cycle ${cycle} scout`,
    `Identity: <one paragraph: who uses this product, for what job>`,
    `Looked: <what you ran or opened as its user and what you saw — or: could not run — <why>>`,
    `Promises:`,
    `- <what the product promises: README, --help, tests as spec, the identity> — kept | broken | absent | unknown — <where seen, or what remains unverified and why>`,
    `Considered:`,
    `- <evidenced candidate or consequential investigation> — <benefit, risk and cost>`,
    `- <another credible alternative, if any> — <trade-off>`,
    `- leave it — <why leaving this area unchanged may be better>`,
  ].join("\n");
}

/** The exact shape the Planner must end with. Reprinted in its brief. */
export function planArtifactContract(cycle: number): string {
  return [
    `# Cycle ${cycle} plan — <short title>`,
    `Verdict: continue | fulfilled — <why the explicit mandate is met; no-mandate runs continue investigating> | blocked — <what prevents meaningful progress without the user>`,
    `Identity: <one paragraph: who uses this product, for what job — reaffirmed, or an Operator: line>`,
    `Looked: <what you ran or opened as its user and what you saw — or: could not run — <why>>`,
    `Considered:`,
    `- <credible alternatives weighed after the record — and always: leave it — <why it lost, or why it wins>>`,
    `Direction: <this cycle's intended benefit or consequential question, in your words after using the product — never a paraphrase of the mandate's adjectives>`,
    `Worth the cycle: <concrete benefit to this product's user, operator or maintainer; why its evidence justifies the cost and risk over leave it>`,
    `Verify: <the one command that proves the cycle, e.g. \`npm test\`> | none — <why this repo has no check>`,
    `Items:`,
    `1. <item title> — files: <path>, <path> — serves: <the job in Identity this serves> — red now: <observed defect, limitation, regression risk or evidence gap; or unchecked — why> — proof: <command or observable distinguishing improvement or resolving the question>`,
    `2. …`,
    `Out of scope:`,
    `- <what was deliberately passed on and why>`,
    `Guidelines: ok | fix: <what AGENTS.md-class file needs and why>`,
    `Operator: <only a secret, an irreversible action, an external blocker, or an identity change — else omit>`,
  ].join("\n");
}

/** The exact shape the Reviewer must end with. */
export function reviewArtifactContract(cycle: number): string {
  return [
    `# Cycle ${cycle} review`,
    `Verdict: ship | ship-with-revisions | blocked — <why>`,
    `Looked: <what you ran or opened as the product's user before you read the diff, and what you saw — or: could not run — <why>>`,
    `Fulfillment:`,
    `- <item title> — done | partial | missing — <note>`,
    `Revisions:`,
    `- <what you changed and why>`,
    `Must-fix:`,
    `- <repairable unresolved defect: ship-with-revisions sends it to the executor for same-cycle repair and fresh review before commit>`,
    `Architecture:`,
    `- <nonblocking observations or future improvements for the next Planner to weigh>`,
    `Worth: yes — <evidenced benefit or consequential uncertainty resolved> | no — <why the benefit did not justify the cost or risk>`,
    `Operator: <only what a human must decide — else omit>`,
  ].join("\n");
}
