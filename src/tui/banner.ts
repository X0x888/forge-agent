/**
 * REPL startup banner — slim, testable, first-run aware.
 * Live › /cycle 0 chrome lives on the live-run header, not here.
 */

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
  const lines = [
    `  ⚒  Forge v${input.version}`,
    `  ${input.provider}/${input.model} · ${input.authLabel}  ·  session ${sid}${title}  ·  perms ${input.permissionMode}${planNote}  ·  sandbox ${input.sandbox}${git}${project}`,
  ];
  if (input.ulwArmed) {
    lines.push(
      `  ULW on  ·  type at live › mid-run (/cycle 0 last wave)`,
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
      `  Type a task in English.  Or:  /setup  ·  /help start  ·  /plan  ·  Tab starters`,
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
