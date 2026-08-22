/**
 * Durable decision / constraint memory (Mastra-inspired observational memory lite).
 *
 * Append-only records live in sessions/<id>/decisions.json so long ULW runs and
 * cliff compaction cannot lobotomize the user's mandate, priorities, or
 * out-of-scope decisions. Wave-boundary facts and agent-written notes share
 * the same ledger.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import {
  forgeHome,
  readJsonFile,
  writeJsonFile,
  nowIso,
} from "../util/fs.js";

export type MemoryKind =
  | "constraint"
  | "decision"
  | "fact"
  | "out_of_scope"
  | "priority"
  | "blocker"
  | "observation"
  | "wave";

export type MemorySource = "user" | "plan" | "agent" | "compact" | "harness" | "ulw";

export interface MemoryRecord {
  id: string;
  at: string;
  wave?: number;
  kind: MemoryKind;
  /** Exact short wording — not paraphrased away by compact */
  text: string;
  source: MemorySource;
  status: "active" | "superseded";
  supersedes?: string;
}

export interface DecisionMemoryStore {
  version: 1;
  sessionId: string;
  records: MemoryRecord[];
  /** Mandate fingerprint when last seeded (avoid re-seed spam) */
  mandateFp?: string;
  /** True when load failed and harness should fail-closed once */
  corrupt?: boolean;
  updatedAt: string;
}

const MAX_RECORDS = 400;
const MAX_TEXT = 800;
/** Dedicated budget for compact / re-anchor injection (chars). */
export const MEMORY_PROMPT_BUDGET = 6_000;

export function decisionMemoryPath(sessionId: string): string {
  return path.join(forgeHome(), "sessions", sessionId, "decisions.json");
}

function emptyStore(sessionId: string): DecisionMemoryStore {
  return {
    version: 1,
    sessionId,
    records: [],
    updatedAt: nowIso(),
  };
}

export function loadDecisionMemory(sessionId: string): DecisionMemoryStore {
  const p = decisionMemoryPath(sessionId);
  try {
    const raw = readJsonFile<DecisionMemoryStore | null>(p, null);
    if (!raw || typeof raw !== "object") return emptyStore(sessionId);
    if (!Array.isArray(raw.records)) {
      return { ...emptyStore(sessionId), corrupt: true };
    }
    return {
      version: 1,
      sessionId,
      records: raw.records
        .filter((r) => r && typeof r === "object" && typeof r.text === "string")
        .map((r) => normalizeRecord(r as MemoryRecord)),
      mandateFp: typeof raw.mandateFp === "string" ? raw.mandateFp : undefined,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
    };
  } catch {
    return { ...emptyStore(sessionId), corrupt: true };
  }
}

function normalizeRecord(r: MemoryRecord): MemoryRecord {
  return {
    id: String(r.id || makeId("m")),
    at: String(r.at || nowIso()),
    wave: typeof r.wave === "number" ? r.wave : undefined,
    kind: (r.kind || "fact") as MemoryKind,
    text: String(r.text || "").trim().slice(0, MAX_TEXT),
    source: (r.source || "harness") as MemorySource,
    status: r.status === "superseded" ? "superseded" : "active",
    supersedes: r.supersedes ? String(r.supersedes) : undefined,
  };
}

export function saveDecisionMemory(store: DecisionMemoryStore): void {
  store.updatedAt = nowIso();
  store.records = store.records.slice(-MAX_RECORDS);
  writeJsonFile(decisionMemoryPath(store.sessionId), store);
}

/** Wipe session decisions on /clear so leftover-chrome ships do not survive. */
export function clearDecisionMemory(sessionId: string): void {
  if (!sessionId) return;
  saveDecisionMemory(emptyStore(sessionId));
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function mandateFingerprint(mandate: string): string {
  return createHash("sha256")
    .update(mandate.replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16);
}

const DURABLE_MEMORY_KINDS: MemoryKind[] = [
  "constraint",
  "priority",
  "blocker",
  "out_of_scope",
];

function isDurableMemoryRecord(r: MemoryRecord): boolean {
  if (r.status !== "active") return false;
  if (DURABLE_MEMORY_KINDS.includes(r.kind)) return true;
  // Seeded mandate line is always load-bearing even if kind is off-list.
  return /^MANDATE:/i.test(r.text);
}

/**
 * Fingerprint of load-bearing memory only (mandate / constraints / scope).
 * Ship logs, readings, and "Wave N pick" decisions must not count — they
 * used to flip context-admit on every wave close.
 */
export function durableMemoryFingerprint(sessionId: string): string {
  const store = loadDecisionMemory(sessionId);
  const lines = store.records
    .filter(isDurableMemoryRecord)
    .map((r) => `${r.kind}\t${r.text}`)
    .sort();
  if (lines.length === 0) return "";
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/** Split mandate into bullet/heading lines for seeding. */
export function extractMandateBullets(mandate: string): string[] {
  const text = mandate.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(?:#{1,6}\s+|[-*•]\s+|\d+[\).]\s+)(.+)$/);
    if (m) {
      const body = m[1].trim();
      if (body.length >= 8) bullets.push(body.slice(0, MAX_TEXT));
      continue;
    }
    // Section headers without markdown
    if (
      /^(Product|First-run|Reliability|Accuracy|Privacy|macOS|UX|UI|Security)\b/i.test(
        line,
      ) &&
      line.length < 80
    ) {
      bullets.push(line.slice(0, MAX_TEXT));
    }
  }
  if (bullets.length >= 2) return bullets.slice(0, 40);
  // Verb-order sentences ("evaluate X and then improve Y") are one mandate,
  // not two backlog items. Those used to become [priority] evaluate +
  // [priority] improve and survive every compact.
  if (isEvaluateClassMandate(text)) return [];
  // Explicit "do A then do B" checklists that are not evaluate-class.
  const thenParts = text
    .split(/\s+and then\s+|\s+then\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
  if (thenParts.length >= 2 && thenParts.length <= 4) {
    return thenParts.map((s) => s.slice(0, MAX_TEXT));
  }
  // Fallback: semicolon / "and" split for short mandates
  const parts = text
    .split(/\s*;\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
    .slice(0, 12);
  return parts.length >= 2 ? parts : [text.slice(0, MAX_TEXT)];
}

/**
 * Mandate whose first verb is evaluate/audit/review (often followed by ship).
 * Length-independent — "comprehensively evaluate this tool and then improve
 * the ui" is the product case and used to miss the 80-char broad gate.
 */
export function isEvaluateClassMandate(mandate: string): boolean {
  const t = mandate.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/comprehensively|full.?audit|end.to.end\s+(audit|review|eval)/i.test(t)) {
    return true;
  }
  return (
    /\b(evaluate|audit|assess|inspect)\b/i.test(t) &&
    /\b(improve|fix|ship|polish|harden|ux|ui)\b/i.test(t)
  );
}

/**
 * True when the mandate is a multi-section checklist / comprehensive audit
 * rather than a single tight objective.
 */
export function isBroadMandate(mandate: string): boolean {
  const raw = mandate.replace(/\r\n/g, "\n");
  const t = raw.replace(/\s+/g, " ").trim();
  // Evaluate-class ("evaluate then improve") is a verb order, not a backlog.
  // A 1-sentence product prompt must not force todo_write ≥2 and then
  // "execute the board" as leftover chrome for five hours.
  const dashBullets = (t.match(/(?:^|\s)[-*•]\s+\S/g) || []).length;
  if (dashBullets >= 4) return true;
  const bullets = extractMandateBullets(raw);
  if (bullets.length >= 5) return true;
  // Long multi-section prose — not the 1-sentence evaluate-then-improve case.
  if (
    t.length >= 160 &&
    /comprehensively|end.to.end|full.?audit|all aspects/i.test(t)
  ) {
    return true;
  }
  return false;
}

export function appendMemoryRecord(
  sessionId: string,
  partial: {
    kind: MemoryKind;
    text: string;
    source: MemorySource;
    wave?: number;
    supersedes?: string;
  },
): MemoryRecord | null {
  const text = String(partial.text || "").trim().slice(0, MAX_TEXT);
  if (!text) return null;
  const store = loadDecisionMemory(sessionId);
  // Dedupe exact active text+kind
  const exists = store.records.some(
    (r) =>
      r.status === "active" &&
      r.kind === partial.kind &&
      r.text.toLowerCase() === text.toLowerCase(),
  );
  if (exists) return null;
  if (partial.supersedes) {
    for (const r of store.records) {
      if (r.id === partial.supersedes) r.status = "superseded";
    }
  }
  const rec: MemoryRecord = {
    id: makeId(partial.kind.slice(0, 3)),
    at: nowIso(),
    wave: partial.wave,
    kind: partial.kind,
    text,
    source: partial.source,
    status: "active",
    supersedes: partial.supersedes,
  };
  store.records.push(rec);
  saveDecisionMemory(store);
  return rec;
}

/**
 * Seed constraint/priority records from the ULW mandate (once per mandate fp).
 * Always stores a single full-mandate constraint when bullets are sparse.
 */
export function seedMemoryFromMandate(
  sessionId: string,
  mandate: string,
  opts?: { softPrompt?: boolean; force?: boolean },
): { seeded: number; store: DecisionMemoryStore } {
  const store = loadDecisionMemory(sessionId);
  const fp = mandateFingerprint(mandate);
  if (!opts?.force && store.mandateFp === fp && store.records.length > 0) {
    return { seeded: 0, store };
  }
  // A new mandate replaces the previous MANDATE:/priority seeds — do not
  // leave "MANDATE: continue" next to the real objective.
  if (store.mandateFp && store.mandateFp !== fp) {
    for (const r of store.records) {
      if (r.status !== "active" || r.source !== "ulw") continue;
      if (
        r.kind === "constraint" &&
        /^MANDATE:/i.test(r.text)
      ) {
        r.status = "superseded";
      }
      if (r.kind === "priority" || r.kind === "decision") {
        if (
          /^Soft mandate:|^Broad mandate:|^Mandate verbs/i.test(r.text)
        ) {
          r.status = "superseded";
        }
      }
    }
    saveDecisionMemory(store);
  }
  let seeded = 0;
  const bullets = extractMandateBullets(mandate);
  const full = mandate.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  if (full) {
    const r = appendMemoryRecord(sessionId, {
      kind: "constraint",
      text: `MANDATE: ${full}`,
      source: "ulw",
    });
    if (r) seeded++;
  }
  // Prefer priority for early bullets, constraint for the rest.
  // Skip for evaluate-class one-liners — the verb-order decision below
  // is the contract, not two fake priorities.
  if (!(isEvaluateClassMandate(mandate) && !isBroadMandate(mandate))) {
    bullets.slice(0, 12).forEach((b, i) => {
      const r = appendMemoryRecord(sessionId, {
        kind: i < 3 ? "priority" : "constraint",
        text: b,
        source: "ulw",
      });
      if (r) seeded++;
    });
  }
  // Evaluate-class already has a verb-order contract. The generic
  // "invent work" line used to survive compact and restart chrome grinding.
  if (opts?.softPrompt && !isEvaluateClassMandate(mandate)) {
    const r = appendMemoryRecord(sessionId, {
      kind: "decision",
      text: "Soft mandate: agent invents high-leverage work; never ask user to pick tasks.",
      source: "ulw",
    });
    if (r) seeded++;
  }
  if (isBroadMandate(mandate)) {
    const r = appendMemoryRecord(sessionId, {
      kind: "decision",
      text: "Broad mandate: decompose into ordered todos first; waves execute backlog, not free invent.",
      source: "ulw",
    });
    if (r) seeded++;
  }
  if (isEvaluateClassMandate(mandate)) {
    const r = appendMemoryRecord(sessionId, {
      kind: "decision",
      text: "Mandate verbs in order: written evaluation/reading first (that is the Wave 1 deliverable, not advice), then ship the one item the reading picked.",
      source: "ulw",
    });
    if (r) seeded++;
  }
  const next = loadDecisionMemory(sessionId);
  next.mandateFp = fp;
  saveDecisionMemory(next);
  return { seeded, store: next };
}

/** Active records for prompt injection. */
export function activeMemoryRecords(sessionId: string): MemoryRecord[] {
  return loadDecisionMemory(sessionId).records.filter((r) => r.status === "active");
}

/**
 * True when the agent has produced a real reading/judgment — not the
 * auto-seeded "Soft mandate:" / "Broad mandate:" templates.
 */
const READING_HEAD_RE = /^\s*\*{0,2}(reading|judgment)\s*:\*{0,2}/im;
const SEEDED_MANDATE_RE =
  /^(Soft mandate:|Broad mandate:|Mandate verbs|MANDATE:)/i;

/** True when text is a Wave-1 plan (Reading:/Judgment: with a real body). */
export function isPlanShapedText(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  if (!READING_HEAD_RE.test(t)) return false;
  const body = t.replace(READING_HEAD_RE, "").trim();
  return body.length >= 12;
}

/** Verify command or a cited file — a catalog of leftovers is not a plan. */
const PLAN_VERIFY_RE =
  /\b(verify(?:ing|ied)?|npm test|npm run |pnpm (?:test|run)|yarn (?:test|run)|bun test|pytest|cargo test|go test|tsc\b|typecheck|lint)\b/i;
const PLAN_PATH_RE = /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|md)\b/;

export function planBodyHasEvidence(text: string): boolean {
  const t = String(text || "");
  return PLAN_VERIFY_RE.test(t) || PLAN_PATH_RE.test(t);
}

export function hasMandateJudgment(
  sessionId: string,
  lastAssistantMessage?: string,
): boolean {
  const recs = activeMemoryRecords(sessionId);
  if (
    recs.some(
      (r) =>
        r.source === "agent" &&
        (r.kind === "decision" || r.kind === "observation") &&
        r.text.length >= 40 &&
        !SEEDED_MANDATE_RE.test(r.text),
    )
  ) {
    return true;
  }
  const msg = String(lastAssistantMessage || "").trim();
  if (!msg) return false;
  if (isPlanShapedText(msg)) return true;
  if (
    msg.length > 80 &&
    /\b(highest-leverage|what i (passed|skipped) on|i will (evaluate|audit|ship))\b/i.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * ULW Wave-1 plan gate — stricter than hasMandateJudgment.
 * Random 40-char notes and a Reading: without a verify command or file
 * path are not a plan. source=plan records from exit_plan_mode / /build
 * still need that evidence.
 */
export function hasUlwPlan(
  sessionId: string,
  lastAssistantMessage?: string,
): boolean {
  const recs = activeMemoryRecords(sessionId);
  if (
    recs.some((r) => {
      if (SEEDED_MANDATE_RE.test(r.text)) return false;
      if (
        (r.source === "agent" ||
          r.source === "plan" ||
          r.source === "user") &&
        (r.kind === "decision" || r.kind === "observation") &&
        isPlanShapedText(r.text) &&
        planBodyHasEvidence(r.text)
      ) {
        return true;
      }
      return false;
    })
  ) {
    return true;
  }
  const msg = String(lastAssistantMessage || "");
  return isPlanShapedText(msg) && planBodyHasEvidence(msg);
}

const SHIP_LOG_RE =
  /^(Wave\s+\d+|Wave shipped|Daily-REPL set|Harness still|Wave LAST)/i;

function isReadingRecord(text: string): boolean {
  return /\bReading:/i.test(text);
}

/** Durable + last reading + last few ship logs — not 80 sibling ships. */
export function selectMemoryForPrompt(recs: MemoryRecord[]): MemoryRecord[] {
  const durable: MemoryRecord[] = [];
  const readings: MemoryRecord[] = [];
  const ships: MemoryRecord[] = [];
  for (const r of recs) {
    if (
      r.kind === "priority" ||
      r.kind === "constraint" ||
      r.kind === "blocker" ||
      r.kind === "out_of_scope"
    ) {
      durable.push(r);
    } else if (isReadingRecord(r.text)) {
      readings.push(r);
    } else if (SHIP_LOG_RE.test(r.text)) {
      ships.push(r);
    } else {
      durable.push(r);
    }
  }
  return [...durable, ...readings.slice(-2), ...ships.slice(-3)];
}

/**
 * Format active memory for re-anchor / compact / kickoff.
 * Never silently empty when corrupt flag is set — caller should fail-closed.
 */
export function formatMemoryForPrompt(
  sessionId: string,
  opts?: { budget?: number; includeWave?: boolean },
): { text: string; corrupt: boolean; activeCount: number } {
  const store = loadDecisionMemory(sessionId);
  const budget = opts?.budget ?? MEMORY_PROMPT_BUDGET;
  let recs = store.records.filter((r) => r.status === "active");
  if (!opts?.includeWave) {
    recs = recs.filter((r) => r.kind !== "wave");
  }
  // Wave-shipped / leftover-chrome logs crowd out the reading. Keep the
  // durable set + last reading + last 3 ship logs (compaction must not
  // re-inject 80 "Wave 2 sibling" lines and restart chrome grinding).
  recs = selectMemoryForPrompt(recs);
  // Priority first, then constraint, then rest; newest last within kind
  const order: MemoryKind[] = [
    "priority",
    "constraint",
    "blocker",
    "out_of_scope",
    "decision",
    "fact",
    "observation",
    "wave",
  ];
  recs = [...recs].sort((a, b) => {
    const da = order.indexOf(a.kind);
    const db = order.indexOf(b.kind);
    if (da !== db) return da - db;
    return a.at.localeCompare(b.at);
  });
  const lines: string[] = [];
  let used = 0;
  for (const r of recs) {
    const line = `- [${r.kind}] ${r.text}`;
    if (used + line.length + 1 > budget) {
      // Always keep at least priorities + first constraints
      if (lines.length >= 4) {
        lines.push(`- … (+${recs.length - lines.length} more in decisions.json)`);
        break;
      }
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) {
    return {
      text: store.corrupt
        ? "- ⚠ Decision memory corrupt or unreadable — re-arm /ulw or /memory restore"
        : "- (none yet)",
      corrupt: Boolean(store.corrupt),
      activeCount: 0,
    };
  }
  return {
    text: lines.join("\n"),
    corrupt: Boolean(store.corrupt),
    activeCount: recs.length,
  };
}

export function formatMemoryStatus(sessionId: string): string {
  const store = loadDecisionMemory(sessionId);
  const active = store.records.filter((r) => r.status === "active");
  const byKind = new Map<string, number>();
  for (const r of active) {
    byKind.set(r.kind, (byKind.get(r.kind) || 0) + 1);
  }
  const kinds = [...byKind.entries()]
    .map(([k, n]) => `${k}=${n}`)
    .join(" · ");
  const head = active.slice(0, 20).map((r) => `  [${r.kind}] ${r.text}`);
  return [
    `Decision memory: ${active.length} active / ${store.records.length} total` +
      (store.corrupt ? "  ⚠ CORRUPT" : ""),
    kinds ? `  kinds: ${kinds}` : "",
    ...head,
    active.length > 20 ? `  … +${active.length - 20} more` : "",
    `  path: ${decisionMemoryPath(sessionId)}`,
    `  /memory add <text>  ·  /memory list  ·  tool memory_write`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Copy memory to a forked session. */
export function copyDecisionMemory(
  fromId: string,
  toId: string,
): DecisionMemoryStore | null {
  if (!fromId || !toId || fromId === toId) return null;
  const src = loadDecisionMemory(fromId);
  if (!src.records.length && !src.mandateFp) return null;
  const next: DecisionMemoryStore = {
    version: 1,
    sessionId: toId,
    records: structuredClone(src.records),
    mandateFp: src.mandateFp,
    updatedAt: nowIso(),
  };
  saveDecisionMemory(next);
  return next;
}

/**
 * Heuristic: free-text interjection that looks like a hard constraint.
 */
export function maybeRecordUserConstraint(
  sessionId: string,
  text: string,
  wave?: number,
): MemoryRecord | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 12 || t.length > 500) return null;
  if (
    !/\b(don't|do not|never|must not|out of scope|P0|P1|priority|only\s+\w+|no\s+more|stop\s+\w+|constraint|must\b)/i.test(
      t,
    )
  ) {
    return null;
  }
  const kind: MemoryKind = /out of scope|don't touch|do not touch|never edit/i.test(
    t,
  )
    ? "out_of_scope"
    : /P0|priority|first|only/i.test(t)
      ? "priority"
      : "constraint";
  return appendMemoryRecord(sessionId, {
    kind,
    text: t.slice(0, MAX_TEXT),
    source: "user",
    wave,
  });
}

/** OM-lite: append wave-boundary fact. */
export function recordWaveObservation(
  sessionId: string,
  wave: number,
  fact: string,
): void {
  appendMemoryRecord(sessionId, {
    kind: "wave",
    text: `w${wave}: ${fact}`.slice(0, MAX_TEXT),
    source: "harness",
    wave,
  });
}

/**
 * Seed todo items from mandate bullets (for backlog contract).
 * Returns TodoItem-shaped objects without writing the session.
 */
export function todosFromMandate(
  mandate: string,
  opts?: { max?: number },
): Array<{ id: string; content: string; status: "pending" }> {
  const max = opts?.max ?? 12;
  const bullets = extractMandateBullets(mandate);
  const items = (bullets.length >= 2 ? bullets : [mandate.trim()]).slice(0, max);
  return items.map((content, i) => ({
    id: `m${i + 1}`,
    content: content.slice(0, 200),
    status: "pending" as const,
  }));
}
