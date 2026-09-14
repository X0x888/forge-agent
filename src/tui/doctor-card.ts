import chalk from "chalk";
import { visibleWidth } from "../util/format.js";

/** REPL `/doctor` is slash keys; `forge doctor` keeps CLI verbs. */
export type DoctorSurface = "repl" | "cli";

export type DoctorRecSeverity = "quality" | "hygiene" | "setup";

/**
 * Actionable doctor follow-up that is not a CI `issues[]` fail.
 * Sit-down Next uses `replAction` only; CLI Next may use `cliAction`.
 */
export interface DoctorRecommendation {
  id: string;
  severity: DoctorRecSeverity;
  detail: string;
  /** Slash key at ›. Omit when there is no sit-down command. */
  replAction?: string;
  /** CLI verb for `forge doctor`. */
  cliAction?: string;
}

/** Verdict line — "Forge doctor" stays for existing scrapers. */
export function formatDoctorHeader(
  issues: string[],
  opts?: { color?: boolean },
): string {
  const color = opts?.color !== false;
  const title = color ? chalk.bold("Forge doctor") : "Forge doctor";
  if (!issues.length) {
    const ok = color ? chalk.green("ok") : "ok";
    return `${title}  ·  ${ok}`;
  }
  const n = issues.length;
  const bit = `${n} issue${n === 1 ? "" : "s"}`;
  return `${title}  ·  ${color ? chalk.yellow(bit) : bit}`;
}

/** Rewrite CLI verbs in doctor issue lines for the REPL card. */
export function rewriteDoctorIssueForSurface(
  issue: string,
  surface: DoctorSurface,
): string {
  if (surface !== "repl") return issue;
  return issue
    .replace(/\bforge login --add\b/gi, "/auth")
    .replace(/\bforge accounts clear-cooldown\b/gi, "/accounts clear-cooldown")
    .replace(/\bforge accounts switch\b/gi, "/accounts")
    .replace(/\bforge login -p \S+/gi, "/auth")
    .replace(/\bforge login --from-cursor\b/gi, "/auth")
    .replace(/\bforge login --from-copilot\b/gi, "/auth")
    .replace(/\bforge login --api-key\b/gi, "/auth")
    .replace(/\bforge login\b/gi, "/auth")
    .replace(/\bforge doctor --json\b/gi, "/doctor")
    .replace(
      /\bforge sessions prune --journals\b/gi,
      "/sessions prune --journals",
    );
}

function isCliSlashKey(k: string): boolean {
  return /^\s*\//.test(k);
}

function closerKeyForRec(
  rec: DoctorRecommendation,
  surface: DoctorSurface,
): string | null {
  if (surface === "cli") {
    const k = rec.cliAction;
    if (!k || isCliSlashKey(k)) return null;
    return k;
  }
  return rec.replAction || null;
}

/** Next command after the dump — login / permissions / setup / recs. */
export function formatDoctorCloser(
  issues: string[],
  opts?: {
    columns?: number;
    surface?: DoctorSurface;
    recommendations?: DoctorRecommendation[];
  },
): string {
  const surface: DoctorSurface = opts?.surface ?? "repl";
  const blob = issues.join("\n");
  const keys: string[] = [];
  const push = (k: string) => {
    if (!k) return;
    if (surface === "cli" && isCliSlashKey(k)) return;
    if (!keys.includes(k)) keys.push(k);
  };
  if (/not authenticated|forge login/i.test(blob)) {
    push(surface === "cli" ? "forge login" : "/auth");
  }
  if (/bypassPermissions|yolo|dontAsk|permission mode/i.test(blob)) {
    push(surface === "cli" ? "forge permissions default" : "/permissions");
  }
  if (/undo journal is large/i.test(blob)) {
    push(
      surface === "cli"
        ? "forge sessions prune --journals"
        : "/sessions prune --journals",
    );
  }
  if (/sessions on disk/i.test(blob)) {
    push(surface === "cli" ? "forge sessions prune --keep 50" : "/sessions");
  }
  for (const rec of opts?.recommendations ?? []) {
    const k = closerKeyForRec(rec, surface);
    if (k) push(k);
  }
  if (!issues.length || /not authenticated/i.test(blob)) {
    push(surface === "cli" ? "forge setup" : "/setup");
  }
  if (!keys.length) {
    push(surface === "cli" ? "forge doctor --json" : "/status");
  }
  const line = `Next  ${keys.slice(0, 4).join("  ·  ")}`;
  const cols = Math.max(
    24,
    opts?.columns ??
      (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  if (visibleWidth(line) <= cols) return line;
  const tokens = keys.slice(0, 4);
  return [`Next  ${tokens[0]}`, ...tokens.slice(1).map((k) => `  ·  ${k}`)].join(
    "\n",
  );
}

export function formatDoctorRecommended(
  recs: DoctorRecommendation[],
  opts?: { color?: boolean; surface?: DoctorSurface },
): string[] {
  if (!recs.length) return [];
  const color = opts?.color !== false;
  const surface: DoctorSurface = opts?.surface ?? "repl";
  const head = "Recommended";
  const out = [color ? chalk.cyan(head) : head];
  for (const rec of recs.slice(0, 8)) {
    const action =
      surface === "cli"
        ? rec.cliAction && !isCliSlashKey(rec.cliAction)
          ? rec.cliAction
          : undefined
        : rec.replAction || rec.cliAction;
    const arrow = action ? `  →  ${action}` : "";
    const row = `  • ${rec.detail}${arrow}`;
    out.push(color ? chalk.cyan(row) : row);
  }
  return out;
}

export function formatDoctorIssueBlock(
  issues: string[],
  opts?: { color?: boolean },
): string[] {
  const color = opts?.color !== false;
  if (!issues.length) {
    const ok = "✓ No blocking issues detected";
    return [color ? chalk.green(ok) : ok];
  }
  const head = `⚠ ${issues.length} issue(s):`;
  const out = [color ? chalk.yellow(head) : head];
  for (const i of issues) {
    const row = `  • ${i}`;
    out.push(color ? chalk.yellow(row) : row);
  }
  return out;
}

/** Assemble verdict-first report. `facts` should not include the old title. */
export function assembleDoctorReport(
  facts: string[],
  issues: string[],
  opts?: {
    color?: boolean;
    columns?: number;
    surface?: DoctorSurface;
    recommendations?: DoctorRecommendation[];
  },
): string {
  const surface: DoctorSurface = opts?.surface ?? "repl";
  const recs = opts?.recommendations ?? [];
  const closer = formatDoctorCloser(issues, { ...opts, recommendations: recs });
  const shown = issues.map((i) => rewriteDoctorIssueForSurface(i, surface));
  const header = formatDoctorHeader(shown, opts);
  const block = formatDoctorIssueBlock(shown, opts);
  const recBlock = formatDoctorRecommended(recs, { ...opts, surface });
  const body = facts.filter((l, i) => !(i === 0 && l.trim() === ""));
  const mid = recBlock.length ? ["", ...recBlock] : [];
  return [header, ...block, ...mid, "", ...body, closer].join("\n");
}
