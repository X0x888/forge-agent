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
  CycleReviewNotes,
  PlanVerdict,
  ReviewVerdict,
} from "./state.js";

export const PLAN_COMPLETE_RE = /\*{0,2}Plan complete\.?\*{0,2}/i;

export interface ParsedPlan {
  title: string;
  verdict: PlanVerdict;
  identity?: string;
  direction?: string;
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

const SECTION_RE =
  /^\s*(?:#{1,6}\s*)?\*{0,2}(Verdict|Identity|Direction|Verify|Items|Out of scope|Guidelines|Operator|Title|Fulfillment|Revisions|Must-fix|Architecture|Notes|Summary)\*{0,2}\s*:\s*(.*)$/i;

function splitSections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const rawLine of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const m = line.match(SECTION_RE);
    if (m) {
      current = m[1].toLowerCase().replace(/\s+/g, "-");
      const rest = (m[2] || "").trim();
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
    if (!body || /^none\.?$/i.test(body)) continue;
    out.push(body.replace(/\s+/g, " "));
  }
  return out;
}

function titleOf(text: string, sections: Map<string, string[]>): string {
  const explicit = firstLine(sections.get("title"));
  if (explicit) return explicit.slice(0, 120);
  const h1 = text.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  if (h1) {
    const stripped = h1.replace(/^cycle\s+\d+\s+(?:plan|review)\s*(?:[—–:-]\s*)?/i, "").trim();
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
  // "<title> — files: a, b — proof: <cmd>"  (— or | or ; as separators)
  const parts = body.split(/\s+(?:—|–|\|)\s+/).map((p) => p.trim()).filter(Boolean);
  let title = parts[0] || body;
  const files: string[] = [];
  let proof: string | undefined;
  for (const p of parts.slice(1)) {
    const fm = p.match(/^files?\s*:\s*(.+)$/i);
    if (fm) {
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
      const raw = pm[1].trim();
      proof = /^`[^`]*`$/.test(raw) ? raw.slice(1, -1).trim() : raw;
      continue;
    }
    // Unlabelled trailing segments belong to the title.
    title = `${title} — ${p}`;
  }
  title = title.replace(/\*{1,2}/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    id: `i${index + 1}`,
    title,
    files,
    proof,
    status: "open",
  };
}

export function parsePlanArtifact(text: string): ParsedPlan | null {
  const sections = splitSections(text);
  if (!sections.has("verdict") && !sections.has("items")) return null;
  const { verdict, note } = parsePlanVerdict(firstLine(sections.get("verdict")));
  const items = bullets(sections.get("items")).map(parsePlanItemLine);
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
  if (verdict === "continue" && items.length === 0) return null;
  return {
    title: titleOf(text, sections) || items[0]?.title.slice(0, 80) || "cycle plan",
    verdict,
    verdictNote: note,
    identity: paragraph(sections.get("identity")),
    direction: paragraph(sections.get("direction")),
    verifyCommand,
    verifyNone,
    verifyRefused,
    items,
    outOfScope: bullets(sections.get("out-of-scope")),
    guidelines: paragraph(sections.get("guidelines")),
    operator: bullets(sections.get("operator")),
  };
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
    fulfillment,
    revisions: bullets(sections.get("revisions")),
    mustFix: bullets(sections.get("must-fix")),
    architecture: bullets(sections.get("architecture")),
    operator: bullets(sections.get("operator")),
  };
}

/** The exact shape the Planner must end with. Reprinted in its brief. */
export function planArtifactContract(cycle: number): string {
  return [
    `# Cycle ${cycle} plan — <short title>`,
    `Verdict: continue | fulfilled — <why the mandate is met> | blocked — <what only the user can unblock>`,
    `Identity: <one paragraph: who uses this product, for what job>`,
    `Direction: <this cycle's theme in one or two sentences>`,
    `Verify: <the one command that proves the cycle, e.g. \`npm test\`> | none — <why this repo has no check>`,
    `Items:`,
    `1. <ship title> — files: <path>, <path> — proof: <command or observable>`,
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
    `Fulfillment:`,
    `- <item title> — done | partial | missing — <note>`,
    `Revisions:`,
    `- <what you changed and why>`,
    `Must-fix:`,
    `- <defect you could not fix this review; the next plan's first items>`,
    `Architecture:`,
    `- <shape observations: duplication, wide signatures, dead flags, narrating comments>`,
    `Operator: <only what a human must decide — else omit>`,
  ].join("\n");
}
