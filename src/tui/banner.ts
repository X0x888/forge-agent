/**
 * REPL startup banner — slim, testable, first-run aware.
 * Live › chrome lives on the live-run header, not here.
 */
import { clipAnsi, visibleWidth } from "../util/format.js";

export interface BannerInput {
  version: string;
  provider: string;
  model: string;
  authLabel: string;
  sessionId: string;
  sessionTitle?: string;
  permissionMode: string;
  sandbox: string;
  blockingStop: boolean;
  gitBranch?: string | null;
  gitDirty?: boolean;
  projectBits?: string[];
  ulwArmed?: boolean;
  posture: string;
  postureWarnings?: string[];
  /** Fresh session with no real user turns. */
  showEmptyState?: boolean;
  /** Full first-run /setup card (once). */
  setupCard?: string;
  /** Compact residue while recommended items remain. */
  setupCompact?: string;
  /** Same-cwd resume: last-turn peek + files/verify (empty = omit). */
  resumeOrientation?: string;
  /** Override TTY width (tests). Non-TTY defaults to 80. */
  columns?: number;
  /**
   * When the sticky dock is on, drop provider/model/auth/ULW/PLAN that the
   * dock already paints. Session, sandbox, git, project, and posture stay.
   */
  dockOn?: boolean;
}

function resolveBannerColumns(columns?: number): number {
  if (typeof columns === "number" && columns > 0) return Math.max(24, columns);
  if (process.stdout.isTTY && process.stdout.columns) {
    return Math.max(24, process.stdout.columns);
  }
  return 80;
}

/** Drop optional identity bits from the right so the line stays one TTY row. */
export function clipBannerIdentity(line: string, columns?: number): string {
  const max = resolveBannerColumns(columns);
  if (visibleWidth(line) <= max) return line;
  const parts = line.split("  ·  ");
  while (parts.length > 2 && visibleWidth(parts.join("  ·  ")) > max) {
    parts.pop();
  }
  const kept = parts.join("  ·  ");
  return visibleWidth(kept) <= max ? kept : clipAnsi(kept, max);
}

export function formatBanner(input: BannerInput): string {
  const sid = String(input.sessionId || "").slice(0, 8);
  const title = input.sessionTitle?.trim()
    ? ` · ${input.sessionTitle.trim().slice(0, 40)}`
    : "";
  const git = input.gitBranch
    ? `  ·  ${input.gitBranch}${input.gitDirty ? "*" : ""}`
    : "";
  const project =
    input.projectBits && input.projectBits.length
      ? `  ·  ${input.projectBits.join(" · ")}`
      : "";
  const planNote =
    input.permissionMode === "plan" ? " (exit_plan_mode or /build)" : "";
  const identity = input.dockOn
    ? clipBannerIdentity(
        `  session ${sid}${title}  ·  sandbox ${input.sandbox}${git}${project}`,
        input.columns,
      )
    : clipBannerIdentity(
        `  ${input.provider}/${input.model} · ${input.authLabel}  ·  session ${sid}${title}  ·  perms ${input.permissionMode}${planNote}  ·  sandbox ${input.sandbox}${git}${project}`,
        input.columns,
      );
  const lines = [
    `  ⚒  Forge v${input.version}`,
    identity,
  ];
  if (input.ulwArmed && !input.dockOn) {
    lines.push(
      `  ULW on`,
    );
  }
  if (input.posture) {
    lines.push(`  ${input.posture}`);
  }
  for (const w of input.postureWarnings || []) {
    lines.push(`  ⚠ ${w}`);
  }
  if (input.postureWarnings?.length) {
    lines.push(`  ↳ review: /config · forge doctor`);
  }
  if (input.showEmptyState) {
    lines.push("");
    lines.push(
      `  Type a task in English.  Or:  1–6 on the card  ·  /setup  ·  /help  ·  Tab`,
    );
  }
  if (input.setupCard) {
    lines.push("");
    for (const row of input.setupCard.split("\n")) {
      lines.push(row ? `  ${row}` : "");
    }
  } else if (input.setupCompact) {
    lines.push(`  ${input.setupCompact}`);
  }
  const resume = input.resumeOrientation?.trim();
  if (resume && !input.showEmptyState) {
    lines.push("");
    for (const row of resume.split("\n")) {
      if (row.trim()) lines.push(`  ${row}`);
    }
    lines.push(`  ↳ /last  ·  /files  ·  /retry`);
  }
  return lines.join("\n");
}
