import chalk from "chalk";
import { visibleWidth } from "../util/format.js";

/** REPL `/doctor` is slash keys; `forge doctor` keeps CLI verbs. */
export type DoctorSurface = "repl" | "cli";

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
    .replace(/\bforge doctor --json\b/gi, "/doctor");
}

/** Next command after the dump — login / permissions / setup. */
export function formatDoctorCloser(
  issues: string[],
  opts?: { columns?: number; surface?: DoctorSurface },
): string {
  const surface: DoctorSurface = opts?.surface ?? "repl";
  const blob = issues.join("\n");
  const keys: string[] = [];
  if (/not authenticated|forge login/i.test(blob)) {
    keys.push(surface === "cli" ? "forge login" : "/auth");
  }
  if (/bypassPermissions|yolo|dontAsk|permission mode/i.test(blob)) {
    keys.push("/permissions");
  }
  if (!issues.length || /not authenticated/i.test(blob)) {
    keys.push("/setup");
  }
  if (!keys.length) {
    keys.push(surface === "cli" ? "forge doctor --json" : "/status");
  }
  const line = `Next  ${keys.join("  ·  ")}`;
  const cols = Math.max(
    24,
    opts?.columns ??
      (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  if (visibleWidth(line) <= cols) return line;
  const tokens = keys;
  return [`Next  ${tokens[0]}`, ...tokens.slice(1).map((k) => `  ·  ${k}`)].join(
    "\n",
  );
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
  opts?: { color?: boolean; columns?: number; surface?: DoctorSurface },
): string {
  const surface: DoctorSurface = opts?.surface ?? "repl";
  const closer = formatDoctorCloser(issues, opts);
  const shown = issues.map((i) => rewriteDoctorIssueForSurface(i, surface));
  const header = formatDoctorHeader(shown, opts);
  const block = formatDoctorIssueBlock(shown, opts);
  const body = facts.filter((l, i) => !(i === 0 && l.trim() === ""));
  return [header, ...block, "", ...body, closer].join("\n");
}
