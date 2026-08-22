/**
 * `/status` + sit-down resume — the problem is the first line, not identity.
 *
 * HUD + session details stay below (scrapers / `/status` muscle memory).
 * Empty `/status` is `status  ·  ok`. Sit-down empty is the peek, not
 * another ✓-preview (`resume  ·  ok`). lastErr Next is a slash key
 * (`/accounts`), never a CLI dump that becomes a model prompt.
 */
import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import type { SessionData } from "../session/session.js";
import {
  formatCompactResumeCard,
  isLastErrorProblem,
  isLastVerificationStale,
  sitDownNextForLastError,
} from "../session/session.js";
import { outboundTokenEstimateForSession } from "../statusline/snapshot.js";
import { costCapStatus } from "../util/cost-budget.js";
import { formatTokens, visibleWidth } from "../util/format.js";
import { contextWindowCaps, contextWindowWarnings } from "../config/model-info.js";

export const STATUS_ISSUE_MAX = 3;

export type StatusIssueKind = "lastErr" | "budget" | "ctx" | "verify" | "served";

export interface StatusIssue {
  kind: StatusIssueKind;
  severity: "error" | "warn";
  line: string;
  next?: string;
}

export interface StatusIssueInput {
  config: Pick<
    ForgeConfig,
    | "contextWindow"
    | "contextWindowExplicit"
    | "autoCompactThreshold"
    | "maxCostUsd"
    | "provider"
    | "model"
    | "workspace"
  >;
  session: SessionData;
  /** Preferred project check (from detectProjectIntel when omitted). */
  checkCommand?: string;
  /** Override live ctx estimate (tests). */
  usedTokens?: number;
}

export function collectStatusIssues(input: StatusIssueInput): StatusIssue[] {
  const { config, session } = input;
  const issues: StatusIssue[] = [];
  const err = session.meta.lastError;
  if (isLastErrorProblem(err) && err?.message) {
    const msg = err.message.replace(/\s+/g, " ").trim().slice(0, 80);
    issues.push({
      kind: "lastErr",
      severity: "error",
      line: `lastErr  [${err.code}] ${msg}`,
      next: sitDownNextForLastError(err),
    });
  }

  const budget = costCapStatus(config, session.meta);
  if (budget.cap != null && budget.hit) {
    const spent = budget.spent.toFixed(budget.spent < 0.01 ? 4 : 2);
    const cap = budget.cap.toFixed(budget.cap < 0.01 ? 4 : 2);
    issues.push({
      kind: "budget",
      severity: "error",
      line: `budget   HIT $${spent}/$${cap}`,
      next: "/budget",
    });
  } else if (budget.cap != null && (budget.ratio ?? 0) >= 0.8) {
    const pct = Math.round((budget.ratio ?? 0) * 100);
    issues.push({
      kind: "budget",
      severity: "warn",
      line: `budget   ${pct}%`,
      next: "/budget",
    });
  }

  const win = config.contextWindow || 1;
  const used =
    input.usedTokens ?? outboundTokenEstimateForSession(session);
  const pct = Math.min(100, Math.round((used / win) * 100));
  const thr = Math.round((config.autoCompactThreshold || 0.8) * 100);
  const caps = contextWindowCaps(config.model, String(config.provider || ""));
  if (
    config.contextWindowExplicit &&
    caps &&
    config.contextWindow > caps.window
  ) {
    const overflow = contextWindowWarnings(config)[0];
    issues.push({
      kind: "ctx",
      severity: "warn",
      line: overflow
        ? `ctx      pin ${formatTokens(config.contextWindow)} > ${caps.source} ${formatTokens(caps.window)}`
        : `ctx      pin exceeds route max`,
      next: "/context-window auto",
    });
  }
  if (pct >= 92) {
    issues.push({
      kind: "ctx",
      severity: "warn",
      line: `ctx      ${pct}% HARD`,
      next: "/compact",
    });
  } else if (pct >= thr) {
    issues.push({
      kind: "ctx",
      severity: "warn",
      line: `ctx      ${pct}% above threshold (${thr}%)`,
      next: "/compact",
    });
  }

  const last = session.meta.lastVerificationCommand?.trim();
  const edits = session.meta.editCount || 0;
  if (last) {
    if (session.meta.lastVerificationOk === false) {
      issues.push({
        kind: "verify",
        severity: "warn",
        line: `verify   ${clipCmd(last)} ✗`,
        next: "/verify",
      });
    } else if (isLastVerificationStale(session.meta)) {
      issues.push({
        kind: "verify",
        severity: "warn",
        line: `verify   ${clipCmd(last)}  ⚠ stale`,
        next: "/verify",
      });
    }
  } else if (edits > 0) {
    issues.push({
      kind: "verify",
      severity: "warn",
      line: `verify   (none after ${edits} edit${edits === 1 ? "" : "s"})`,
      next: "/verify",
    });
  }

  if (session.meta.servedModels?.length) {
    issues.push({
      kind: "served",
      severity: "warn",
      line: `served   ⚠ ${session.meta.servedModels.join(", ")} for requested ${session.meta.model}`,
      next: "/model",
    });
  }

  return issues.slice(0, STATUS_ISSUE_MAX);
}

function clipCmd(cmd: string): string {
  return cmd.length > 48 ? `${cmd.slice(0, 47)}…` : cmd;
}

export function formatStatusVerdict(
  issues: readonly StatusIssue[],
  opts?: { color?: boolean; title?: string },
): string {
  const color = opts?.color !== false;
  const rawTitle = opts?.title?.trim() || "status";
  const title = color ? chalk.bold(rawTitle) : rawTitle;
  if (!issues.length) {
    const ok = color ? chalk.green("ok") : "ok";
    return `${title}  ·  ${ok}`;
  }
  const n = issues.length;
  const bit = `${n} issue${n === 1 ? "" : "s"}`;
  const head = `${title}  ·  ${color ? chalk.yellow(bit) : bit}`;
  const rows = issues.map((i) => {
    const row = `⚠ ${i.line}`;
    if (!color) return row;
    return i.severity === "error" ? chalk.red(row) : chalk.yellow(row);
  });
  return [head, ...rows].join("\n");
}

export function formatStatusCloser(
  issues: readonly StatusIssue[],
  opts?: { columns?: number },
): string {
  if (!issues.length) return "";
  const keys: string[] = [];
  for (const i of issues) {
    const n = i.next?.trim();
    if (n && !keys.includes(n)) keys.push(n);
    if (keys.length >= STATUS_ISSUE_MAX) break;
  }
  if (!keys.length) return "";
  const line = `Next  ${keys.join("  ·  ")}`;
  const cols = Math.max(
    24,
    opts?.columns ??
      (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  if (visibleWidth(line) <= cols) return line;
  return [`Next  ${keys[0]}`, ...keys.slice(1).map((k) => `  ·  ${k}`)].join(
    "\n",
  );
}

export function assembleStatusReport(parts: {
  hud: string;
  planLine?: string;
  detail: string;
  stackLine?: string;
  issues: readonly StatusIssue[];
  columns?: number;
  color?: boolean;
}): string {
  const verdict = formatStatusVerdict(parts.issues, { color: parts.color });
  const closer = formatStatusCloser(parts.issues, { columns: parts.columns });
  return [
    verdict,
    String(parts.hud || "").trimEnd(),
    String(parts.planLine || "").trimEnd(),
    String(parts.detail || "").trimEnd(),
    String(parts.stackLine || "").trimEnd(),
    closer,
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

/** True when sit-down already printed a problem-specific Next closer. */
export function resumeCardHasNext(text: string): boolean {
  return /(?:^|\n)Next  /.test(text || "");
}

function stripLastErrFlag(body: string): string {
  return String(body || "")
    .replace(/  ·  lastErr \S+/g, "")
    .replace(/^lastErr \S+  ·  /m, "")
    .replace(/^lastErr \S+$/m, "")
    .replace(/  ·  $/gm, "")
    .trim();
}

/**
 * Sit-down (`forge` auto-resume + `/resume`) — verdict-first when something
 * is wrong. Designed empty is the compact peek, not `resume  ·  ok`.
 */
export function formatSitDownResume(
  session: SessionData,
  config: StatusIssueInput["config"],
  opts?: {
    maxChars?: number;
    fileLimit?: number;
    columns?: number;
    color?: boolean;
  },
): string {
  const issues = collectStatusIssues({ config, session });
  const raw = formatCompactResumeCard(session, {
    maxChars: opts?.maxChars,
    fileLimit: opts?.fileLimit,
  });
  if (!issues.length) return raw;
  const body = issues.some((i) => i.kind === "lastErr")
    ? stripLastErrFlag(raw)
    : raw;
  const verdict = formatStatusVerdict(issues, {
    color: opts?.color,
    title: "resume",
  });
  const closer = formatStatusCloser(issues, { columns: opts?.columns });
  return [verdict, body, closer].filter((s) => s && s.trim()).join("\n");
}
