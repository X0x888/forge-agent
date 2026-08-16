/**
 * Product-quality bar for user-facing work Forge is building.
 *
 * Soul here is quality (depth, finished edges, at most one job-adjacent
 * discovery) — not a persona for Forge and not a character for the product.
 * Infra, bugfix, and generic UI chrome never enter this path.
 */
import {
  appendMemoryRecord,
  activeMemoryRecords,
} from "./decision-memory.js";

const JOB_PREFIX = "Job:";
const NEXT_NEED_PREFIX = "Next need:";
const EDGE_PREFIX = "Edge:";

/** A product being built or reshaped — not a generic "the ui" chrome grind. */
const PRODUCT_OBJECT_RE =
  /\b(app|application|site|landing|onboarding|empty state|error state|first[- ]run|dashboard|settings page|notes app|game)\b/i;
/** Surfaces that only count with evaluate/build, not bare "improve the ui". */
const PRODUCT_SURFACE_RE = /\b(cli|tui|ux|ui|product)\b/i;
const BUILD_RE = /\b(build|make|create|redesign|reshape)\b/i;
const EVAL_RE = /\b(evaluate|audit|assess)\b/i;
const POLISH_RE = /\b(improve|polish)\b/i;
const INFRA_RE =
  /\b(typecheck|type.?error|tsc\b|infra|lockfile|ci yaml|add a flag|add the flag|flaky test|refactor internals)\b/i;
const BUGFIX_RE =
  /^(fix|bugfix|hotfix|repair)\b|\bfix the\b|\bbug in\b/i;

const JOB_INSIGHT_RE =
  /(?:hard work is|what(?:'s| is) actually hard|the (?:user'?s )?job is|Job:)\s+(.{12,200})/i;
const NEXT_NEED_RE =
  /(?:unspoken next(?: need)?|next need|what they(?:'ll| will) need|Next need:)\s+(.{12,200})/i;
const EDGE_RE =
  /\b(empty state|empty-state|nothing here yet|no results yet|first[- ]run|error state|when it fails|permission.?denied|404)\b/i;
/** One labeled discovery per line. Short bodies still count as a label. */
const SERENDIPITY_RE = /\*{0,2}Serendipity:\*{0,2}\s*([^\n]{1,180})/gi;
/** Preview catalogs are not a job. Mentioning leftover chrome in a reading is. */
const CHROME_CATALOG_RE =
  /first \d+\s+(?:lines?|hits?|names?)|under the [✓✔] row|last \d+\s+(?:log )?lines/i;

export function isUserFacingProductWork(mandate: string): boolean {
  const t = (mandate || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (INFRA_RE.test(t) && !PRODUCT_OBJECT_RE.test(t) && !PRODUCT_SURFACE_RE.test(t)) {
    return false;
  }
  if (BUGFIX_RE.test(t) && !BUILD_RE.test(t) && !EVAL_RE.test(t)) return false;

  if (BUILD_RE.test(t) && (PRODUCT_OBJECT_RE.test(t) || PRODUCT_SURFACE_RE.test(t))) {
    return true;
  }
  if (EVAL_RE.test(t) && (PRODUCT_OBJECT_RE.test(t) || PRODUCT_SURFACE_RE.test(t))) {
    return true;
  }
  // Polish a named product surface — not "improve the ui" / "polish the tui".
  if (POLISH_RE.test(t) && PRODUCT_OBJECT_RE.test(t)) return true;
  return false;
}

export function extractJobInsight(text: string): string | undefined {
  const t = text || "";
  const m = t.match(JOB_INSIGHT_RE);
  const body = m?.[1]?.replace(/\s+/g, " ").trim();
  if (body && body.length >= 12) {
    return body.replace(/[.]+$/, "").slice(0, 200);
  }
  const reading = t.match(/\*{0,2}Reading:\*{0,2}\s+(.{12,240})/i);
  const r = reading?.[1]?.replace(/\s+/g, " ").trim();
  if (r && r.length >= 12) return r.replace(/[.]+$/, "").slice(0, 200);
  return undefined;
}

export function extractNextNeed(text: string): string | undefined {
  const m = (text || "").match(NEXT_NEED_RE);
  const body = m?.[1]?.replace(/\s+/g, " ").trim();
  if (!body || body.length < 12) return undefined;
  return body.replace(/[.]+$/, "").slice(0, 200);
}

export function extractSerendipities(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(SERENDIPITY_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || "")) !== null) {
    const body = (m[1] || "").replace(/\s+/g, " ").trim();
    if (body) out.push(body.slice(0, 180));
  }
  return out;
}

export function hasProductEdge(text: string): boolean {
  return EDGE_RE.test(text || "");
}

function usableJob(text: string): string | undefined {
  const job = extractJobInsight(text);
  if (!job) return undefined;
  if (CHROME_CATALOG_RE.test(job)) return undefined;
  return job;
}

function agentTexts(sessionId: string): string[] {
  if (!sessionId) return [];
  return activeMemoryRecords(sessionId)
    .filter((r) => r.status === "active" && r.source === "agent")
    .map((r) => r.text);
}

export function harvestProductQualityNotes(
  sessionId: string,
  text: string,
): void {
  if (!sessionId || !text?.trim()) return;
  try {
    const job = usableJob(text);
    if (job) {
      appendMemoryRecord(sessionId, {
        kind: "decision",
        source: "agent",
        text: `${JOB_PREFIX} ${job}`,
      });
    }
    const next = extractNextNeed(text);
    if (next) {
      appendMemoryRecord(sessionId, {
        kind: "priority",
        source: "agent",
        text: `${NEXT_NEED_PREFIX} ${next}`,
      });
    }
    if (hasProductEdge(text)) {
      appendMemoryRecord(sessionId, {
        kind: "fact",
        source: "agent",
        text: `${EDGE_PREFIX} empty/error/first-run is in the product`,
      });
    }
  } catch {
    /* ledger is best-effort — never fail Stop or adopt */
  }
}

/** Promote Job/Edge already sitting in agent Readings onto the structured ledger. */
export function harvestStoredProductQuality(sessionId: string): void {
  if (!sessionId) return;
  for (const text of agentTexts(sessionId)) {
    harvestProductQualityNotes(sessionId, text);
  }
}

export function hasStoredJobInsight(sessionId: string): boolean {
  return agentTexts(sessionId).some((text) => Boolean(usableJob(text)));
}

export function hasStoredProductEdge(sessionId: string): boolean {
  return agentTexts(sessionId).some(
    (text) =>
      text.toLowerCase().startsWith(EDGE_PREFIX.toLowerCase()) ||
      hasProductEdge(text),
  );
}

export function storedNextNeeds(sessionId: string): string[] {
  return activeMemoryRecords(sessionId)
    .filter(
      (r) =>
        r.status === "active" &&
        r.text.toLowerCase().startsWith(NEXT_NEED_PREFIX.toLowerCase()),
    )
    .map((r) => r.text.slice(NEXT_NEED_PREFIX.length).trim());
}

export type ProductQualityMiss =
  | "job"
  | "edge"
  | "serendipity_budget"
  | "serendipity_chrome";

export interface ProductQualityResult {
  ok: boolean;
  missing: ProductQualityMiss[];
}

export function evaluateProductQuality(opts: {
  closer: string;
  sessionId: string;
  /** Stamped waves so far — edge is owed after the first product ship. */
  wave?: number;
  isLeftoverChrome?: (text: string) => boolean;
}): ProductQualityResult {
  const closer = opts.closer || "";
  const missing: ProductQualityMiss[] = [];

  const job =
    usableJob(closer) ||
    (opts.sessionId ? hasStoredJobInsight(opts.sessionId) : false);
  if (!job) missing.push("job");

  const edge =
    hasProductEdge(closer) ||
    (opts.sessionId ? hasStoredProductEdge(opts.sessionId) : false);
  if ((opts.wave ?? 0) >= 1 && !edge) missing.push("edge");

  const hits = extractSerendipities(closer);
  if (hits.length > 1) missing.push("serendipity_budget");
  if (hits.length === 1) {
    const chrome = opts.isLeftoverChrome ?? (() => false);
    const body = hits[0]!;
    if (chrome(`Serendipity: ${body}`) || chrome(body)) {
      missing.push("serendipity_chrome");
    }
  }
  return { ok: missing.length === 0, missing };
}

export function formatProductQualityReanchor(
  missing: ProductQualityMiss[],
): string {
  const lines = [
    "[Forge ULW cycle driver] Stop blocked — user-facing ship needs product quality.",
    "Name the hard user job, finish one edge, at most one job-adjacent discovery. Garnish is not quality.",
  ];
  if (missing.includes("job")) {
    lines.push(
      "Name the hard user job (Job: / hard work is …) and memory_write it.",
    );
  }
  if (missing.includes("edge")) {
    lines.push(
      "Finish one edge in this ship: empty state, error path, or first-run.",
    );
  }
  if (missing.includes("serendipity_budget")) {
    lines.push(
      "At most one Serendipity: per unit. A second one is garnish — drop it or /cycle 0.",
    );
  }
  if (missing.includes("serendipity_chrome")) {
    lines.push(
      "That Serendipity: is leftover chrome (✓-row / last-N lines), not a job-adjacent discovery.",
    );
  }
  lines.push("Fix the ship, then Stop again. This bounce is once.");
  return lines.join("\n");
}
