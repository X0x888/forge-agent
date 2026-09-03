/**
 * Standalone run report — the end-of-run / status view that stands on its own.
 *
 * The user will not scroll. After many review rounds the model's last
 * message covers the last round; the harness knows the whole run: the
 * request, the wave ledger, files changed, commits landed in the window,
 * the last verification, open todos / named ships / bet / must-fix, the
 * guideline audit, and what only the user can do.
 *
 * Shape (sisyphus REPORT.md, made native): one outcome line first, then
 * short bold-labelled sections with one-or-two-sentence bullets, numbers
 * beside the thing they count. Rendered at ULW release / sit-down and
 * `/done`, by `/report`, at the head of `/status`, in `forge run --json`
 * (`report`), and written to `~/.forge/sessions/<id>/report.md`.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { SessionData, TodoItem } from "../session/session.js";
import {
  isLastVerificationStale,
  isSyntheticUserMessage,
  sessionDir,
} from "../session/session.js";
import { readFileMutations } from "../session/mutations.js";
import { loadUlwCycle, type UlwCycleState } from "./ulw-cycle.js";
import { loadGoal, type GoalState } from "./goal.js";
import { formatGuidelineReportLines } from "./guideline-audit.js";
import { looksLikeRunReport } from "./report-guard.js";
import { displayRelPath } from "../agent/tools/path-util.js";
import { createChildEnv } from "../agent/tools/env-policy.js";
import { ensureDir } from "../util/fs.js";

export interface RunReportSection {
  title: string;
  lines: string[];
}

export interface RunReport {
  /** One plain sentence: done / partly done / blocked, and what the user has. */
  outcome: string;
  /** The request this run answers (mandate or last real user prompt), clipped. */
  request: string;
  sections: RunReportSection[];
  /** Plain markdown (bold labels, `- ` bullets). */
  markdown: string;
  /** Facts the model needs to write its own run-wide closing message. */
  facts: string[];
}

export interface RunReportInput {
  session: SessionData;
  workspace: string;
  /** Loop outcome flags (omit for a live /status peek). */
  result?: {
    aborted?: boolean;
    hitMaxTurns?: boolean;
    hitCostCap?: boolean;
    stuckReleased?: boolean;
    lastCycleReleased?: boolean;
    lastCycleSatDown?: boolean;
    releasedOnContinueCap?: boolean;
    stopContinues?: number;
    finalText?: string;
  };
  ulw?: UlwCycleState | null;
  goal?: GoalState | null;
  /** Override guideline lines (tests). */
  guidelineLines?: string[];
  /** Skip git (tests / speed). */
  noGit?: boolean;
}

const OPERATOR_LINE_RE = /^\s*(?:[-*•]\s*)?(?:\*\*)?Operator:(?:\*\*)?\s*(.+)$/im;

function clip(s: string, n: number): string {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * Prose lifted out of the ledger (wave summaries, named ships, bets, holes)
 * arrives with the markdown it was written in, and the extractor keeps
 * orphans: real ledgers hold `** CLI \`together run\` still cannot…`. The
 * report renders its own emphasis, so strip theirs.
 */
function clipProse(s: string, n: number): string {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[*_]{1,3}/g, "")
    .replace(/`/g, "")
    .replace(/^(?:[#>\-–—•]+\s*)+/, "")
    .trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      env: createChildEnv(),
    }).trim();
  } catch {
    return null;
  }
}

/** Commits landed in the run window (any channel — model, harness, user). */
export function gitCommitsSince(
  cwd: string,
  sinceIso: string,
  limit = 20,
): Array<{ sha: string; subject: string }> {
  const out = git(
    ["log", `--since=${sinceIso}`, "--format=%h%x1f%s", `-n${limit}`],
    cwd,
  );
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => l.split("\x1f"))
    .filter((p) => p.length >= 2 && p[0])
    .map(([sha, subject]) => ({ sha, subject }));
}

/**
 * How many commits really landed in the window. `gitCommitsSince` stops at
 * `limit` for display, and a 250-wave run that reported "20 commits" was
 * reporting the page size as the total.
 */
export function gitCommitCountSince(cwd: string, sinceIso: string): number {
  const out = git(["rev-list", "--count", `--since=${sinceIso}`, "HEAD"], cwd);
  const n = Number(String(out || "").trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** The last real (non-synthetic) user prompt and its transcript index. */
export function lastRealUserPrompt(
  session: SessionData,
): { text: string; index: number } | null {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m?.role !== "user" || typeof m.content !== "string") continue;
    if (isSyntheticUserMessage(m)) continue;
    const text = m.content.trim();
    if (!text) continue;
    return { text, index: i };
  }
  return null;
}

/** Operator: lines the model wrote in its closing message. */
export function operatorItemsFrom(text: string | undefined): string[] {
  const out: string[] = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(OPERATOR_LINE_RE);
    if (m) out.push(clip(m[1], 160));
  }
  return out;
}

function openTodoList(todos: TodoItem[]): TodoItem[] {
  return (todos || []).filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  );
}

/** ISO timestamp the run window starts at (ULW arm, else the request). */
export function runWindowStart(
  session: SessionData,
  ulw: UlwCycleState | null | undefined,
): string {
  if (ulw?.enabled && ulw.startedAt) return ulw.startedAt;
  // Mutations carry the turn; the request turn is the current turnCount.
  const turn = session.meta.turnCount;
  try {
    const muts = readFileMutations(session.meta.id);
    const first = muts.find((m) => m.turn === turn);
    if (first?.ts) return first.ts;
  } catch {
    /* */
  }
  return session.meta.updatedAt || session.meta.createdAt;
}

export function buildRunReport(input: RunReportInput): RunReport {
  const { session, workspace } = input;
  const meta = session.meta;
  const ulw =
    input.ulw !== undefined ? input.ulw : safeLoadUlw(meta.id);
  const goal = input.goal !== undefined ? input.goal : safeLoadGoal(meta.id);
  const r = input.result || {};
  const cwd = workspace || meta.cwd || process.cwd();

  const request = ulw?.enabled && ulw.mandate
    ? clipProse(ulw.mandate, 160)
    : clipProse(lastRealUserPrompt(session)?.text || meta.lastUserPreview || meta.title || "", 160);

  const since = runWindowStart(session, ulw);
  const requestTurn = meta.turnCount;

  // --- files changed this run
  let mutations: ReturnType<typeof readFileMutations> = [];
  try {
    mutations = readFileMutations(meta.id);
  } catch {
    mutations = [];
  }
  const sinceMs = Date.parse(since) || 0;
  const runMuts = mutations.filter((m) =>
    ulw?.enabled ? Date.parse(m.ts || "") >= sinceMs - 1000 : m.turn === requestTurn,
  );
  const byPath = new Map<string, string>();
  for (const m of runMuts) byPath.set(m.path, m.kind);
  const changedNames = [...byPath.entries()].map(([p, kind]) => {
    const label = displayRelPath(cwd, p);
    return kind === "create" ? `${label} (new)` : label;
  });

  // --- commits in the window (`commits` is the display page, not the total)
  const commits = input.noGit ? [] : gitCommitsSince(cwd, since);
  const commitTotal = input.noGit
    ? 0
    : Math.max(commits.length, gitCommitCountSince(cwd, since));

  // --- waves
  const waves = ulw?.waves ?? [];
  const provenWaves = waves.filter((w) => w.proof).length;

  // --- verification
  const lv = meta.lastVerificationCommand?.trim();
  const stale = isLastVerificationStale(meta);
  const red = meta.lastVerificationOk === false;
  const verifyState: "green" | "red" | "stale" | "none" = !lv
    ? "none"
    : red
      ? "red"
      : stale
        ? "stale"
        : "green";

  // --- open work
  const todos = openTodoList(session.todos);
  const openShips = (ulw?.namedShips ?? []).filter((s) => s.status === "open");
  const mustFix = ulw?.lastReflectHoles ?? [];
  const bet = ulw?.bet;
  const goalActive =
    goal && goal.objective && goal.status === "active" && !goal.paused
      ? goal
      : null;

  // --- outcome line
  const filesPhrase = `${byPath.size} file${byPath.size === 1 ? "" : "s"} changed`;
  const verifyPhrase =
    verifyState === "green"
      ? `verified with \`${clip(lv || "", 60)}\``
      : verifyState === "red"
        ? `last check \`${clip(lv || "", 60)}\` is RED`
        : verifyState === "stale"
          ? `last check predates the last edit (stale)`
          : byPath.size > 0
            ? "no check run"
            : "";
  let outcome: string;
  if (r.aborted) {
    outcome = `Aborted by the user — ${filesPhrase}${verifyPhrase ? `, ${verifyPhrase}` : ""}.`;
  } else if (r.lastCycleReleased) {
    outcome = `Done — ULW run complete: ${waves.length} wave${waves.length === 1 ? "" : "s"} shipped (${provenWaves} with proof), ${commitTotal} commit${commitTotal === 1 ? "" : "s"} landed, ${filesPhrase}.`;
  } else if (r.lastCycleSatDown) {
    outcome = `Paused — /cycle 0 sat down after ${ulw?.wave ?? waves.length} wave${(ulw?.wave ?? waves.length) === 1 ? "" : "s"}; ULW stays on. ${commitTotal} commit${commitTotal === 1 ? "" : "s"} landed, ${filesPhrase}.`;
  } else if (r.stuckReleased) {
    outcome = `Stalled — the driver released after repeated no-progress stops. ${filesPhrase}${verifyPhrase ? `, ${verifyPhrase}` : ""}.`;
  } else if (r.hitCostCap) {
    outcome = `Stopped at the spend cap — ${filesPhrase}${verifyPhrase ? `, ${verifyPhrase}` : ""}.`;
  } else if (r.hitMaxTurns) {
    outcome = `Stopped at max turns — ${filesPhrase}${verifyPhrase ? `, ${verifyPhrase}` : ""}.`;
  } else if (ulw?.enabled && ulw.cycle === 1) {
    outcome = `In progress — ULW wave ${ulw.wave}${ulw.maxWaves != null ? `/${ulw.maxWaves}` : ""}, ${waves.length} shipped so far, ${filesPhrase}.`;
  } else if (ulw?.enabled) {
    // cycle=0 with no driver-end flag: LAST is armed and nothing has closed.
    // The wrap, the LAST reflect score and **Cycle complete.** are all still
    // ahead, so this report must not read like the run finished. `/done`
    // flips the cycle and then asks for a report in the same breath.
    outcome = `Winding down — ULW is on its last cycle after ${ulw.wave ?? waves.length} wave${(ulw.wave ?? waves.length) === 1 ? "" : "s"}; the wrap, LAST reflect and **Cycle complete.** are still ahead. ${filesPhrase}.`;
  } else if (goalActive) {
    outcome = `In progress — goal still active: ${clipProse(goalActive.objective, 80)}. ${filesPhrase}.`;
  } else if (byPath.size === 0 && commitTotal === 0) {
    outcome = `Answered — no files changed.`;
  } else if (verifyState === "green") {
    outcome = `Done — ${filesPhrase}, ${verifyPhrase}${todos.length ? `; ${todos.length} todo${todos.length === 1 ? "" : "s"} still open` : ""}.`;
  } else if (verifyState === "red") {
    outcome = `Partly done — ${filesPhrase}, but the ${verifyPhrase}.`;
  } else {
    outcome = `Done, unverified — ${filesPhrase}, ${verifyPhrase || "no check run"}.`;
  }

  // --- sections
  const sections: RunReportSection[] = [];

  const shipped: string[] = [];
  if (waves.length) {
    const shown = waves.slice(-10);
    if (waves.length > shown.length) shipped.push(`${waves.length - shown.length} earlier wave${waves.length - shown.length === 1 ? "" : "s"} not listed.`);
    for (const w of shown) {
      shipped.push(
        `Wave ${w.wave} ${w.proof ? "✓" : "✗"} ${clipProse(w.summary || "(no summary)", 110)}`,
      );
    }
  }
  if (commits.length) {
    const shown = commits.slice(0, 8);
    shipped.push(
      `${commitTotal} commit${commitTotal === 1 ? "" : "s"} since the request: ${shown.map((c) => `${c.sha} ${clipProse(c.subject, 50)}`).join(" · ")}${commitTotal > shown.length ? ` · +${commitTotal - shown.length} more` : ""}`,
    );
  }
  if (byPath.size) {
    const shown = changedNames.slice(0, 8);
    shipped.push(
      `${filesPhrase}: ${shown.join(", ")}${changedNames.length > shown.length ? ` +${changedNames.length - shown.length} more` : ""}`,
    );
  }
  if (!shipped.length) shipped.push("Nothing on disk changed this run.");
  sections.push({ title: "What shipped", lines: shipped });

  const verified: string[] = [];
  if (lv) {
    const when = meta.lastVerificationAt
      ? ` at ${meta.lastVerificationAt.slice(0, 16).replace("T", " ")}`
      : "";
    verified.push(
      verifyState === "green"
        ? `\`${clip(lv, 90)}\` passed${when}.`
        : verifyState === "red"
          ? `\`${clip(lv, 90)}\` FAILED${when}${meta.lastVerificationExitCode != null ? ` (exit ${meta.lastVerificationExitCode})` : ""}.`
          : `\`${clip(lv, 90)}\` passed${when}, but files were edited afterwards — re-run before trusting it.`,
    );
  } else {
    verified.push(byPath.size ? "No verification command ran this run." : "Nothing to verify.");
  }
  if (waves.length) {
    verified.push(
      `${provenWaves} of ${waves.length} waves closed with proof${ulw?.fullSuitePassed ? "; the full suite passed this run" : "; the full suite never passed this run"}.`,
    );
  }
  sections.push({ title: "Verified", lines: verified });

  const notDone: string[] = [];
  for (const t of todos.slice(0, 8)) notDone.push(`Todo ${t.status === "in_progress" ? "(in progress)" : "(open)"}: ${clipProse(t.content, 120)}`);
  if (todos.length > 8) notDone.push(`+${todos.length - 8} more open todos.`);
  for (const s of openShips.slice(0, 6)) notDone.push(`Named ship still open: ${clipProse(s.text, 120)}`);
  if (bet && bet.slices === 0) notDone.push(`Bet not yet sliced: ${clipProse(bet.text, 120)}`);
  for (const h of mustFix.slice(0, 6)) notDone.push(`Must-fix from LAST reflect: ${clipProse(h, 140)}`);
  if (goalActive) {
    notDone.push(`Goal not attested: ${clipProse(goalActive.objective, 120)}`);
    for (const c of goalActive.criteria.slice(0, 6)) notDone.push(`  criterion: ${clipProse(c, 110)}`);
  }
  if (verifyState === "red") notDone.push("The last check is red — fix before shipping.");
  if (verifyState === "stale") notDone.push("Re-run the last check — edits landed after it.");
  if (r.hitCostCap) notDone.push("Run stopped at the spend cap (`/budget` to raise).");
  if (r.hitMaxTurns) notDone.push("Run stopped at max turns (`--max-turns` to raise).");
  if (r.stuckReleased) notDone.push("Driver released on a stuck-wall: repeated Stops without progress.");
  if (!notDone.length) notDone.push("Nothing left open.");
  sections.push({ title: "Not done", lines: notDone });

  const guidelineLines =
    input.guidelineLines ??
    safeGuidelineLines(meta.id, cwd);
  if (guidelineLines.length) {
    sections.push({ title: "Agent guidelines", lines: guidelineLines });
  }

  const needs: string[] = [];
  for (const o of operatorItemsFrom(r.finalText)) needs.push(`Operator: ${o}`);
  const err = meta.lastError;
  if (err && /auth|quota|login|credential|token/i.test(`${err.code} ${err.message}`)) {
    needs.push(`Operator: ${clip(err.message, 120)} (${err.code})`);
  }
  if (!needs.length) needs.push("Nothing — no secret, external blocker, or irreversible action is pending on you.");
  sections.push({ title: "Needs you", lines: needs });

  const resume: string[] = [
    `Session ${meta.id.slice(0, 8)}${meta.title ? ` · ${clipProse(meta.title, 60)}` : ""} — \`forge --continue\` resumes it; \`/report\` reprints this.`,
  ];
  if (ulw?.enabled && !r.lastCycleReleased) {
    // cycle=0 is two different states: the driver actually sat a wrap down,
    // or LAST is armed and the wrap has not happened yet. Saying "sat down"
    // for the second one tells the user the run is over when it is not.
    resume.push(
      ulw.cycle === 1
        ? `ULW is still ON (cycle=1, wave ${ulw.wave}). Type to steer, \`/cycle 0\` to wind down, \`/done\` to end.`
        : r.lastCycleSatDown
          ? `ULW wrap sat down (cycle=0) and ULW stays on. Type to continue, \`/done\` or \`/ulw-off\` to end.`
          : `ULW is on LAST (cycle=0): wrap the open work, LAST reflect scores the run, then **Cycle complete.** \`/cycle 1\` to keep going instead.`,
    );
  }
  sections.push({ title: "Resume", lines: resume });

  const facts: string[] = [
    `Request: ${request}`,
    `Run window since ${since.slice(0, 16).replace("T", " ")}${r.stopContinues != null ? ` · ${r.stopContinues} harness round${r.stopContinues === 1 ? "" : "s"}` : ""}`,
    ...shipped.map((l) => `Shipped: ${l}`),
    ...verified.map((l) => `Verified: ${l}`),
    ...notDone.map((l) => `Open: ${l}`),
  ];

  const markdown = renderRunReportMarkdown({ outcome, request, sections });
  return { outcome, request, sections, markdown, facts };
}

export function renderRunReportMarkdown(r: {
  outcome: string;
  request: string;
  sections: RunReportSection[];
}): string {
  const out: string[] = [r.outcome];
  if (r.request) out.push(`Request: ${r.request}`);
  for (const s of r.sections) {
    out.push(``, `**${s.title}**`);
    for (const l of s.lines) out.push(`- ${l}`);
  }
  return out.join("\n");
}

/**
 * Colour is opt-in and `NO_COLOR` vetoes it, the same call every other Forge
 * surface makes (`src/tui/bottom-status.ts`, `src/tui/turn-summary.ts`,
 * `src/statusline/render.ts`). These two renderers hand-roll SGR instead of
 * going through chalk, and chalk is the thing that self-disables under
 * `NO_COLOR` — so the veto lives here rather than at the call sites, where
 * every caller passes a bare `isTTY` and the fifth one would reintroduce it.
 */
function ansiOn(color: boolean | undefined): boolean {
  return Boolean(color) && process.env.NO_COLOR == null;
}

/** Terminal rendering (bold labels via ANSI when `color` and no `NO_COLOR`). */
export function renderRunReportText(
  report: RunReport,
  opts?: { color?: boolean; width?: number },
): string {
  const paint = ansiOn(opts?.color);
  const bold = (s: string) => (paint ? `\x1b[1m${s}\x1b[22m` : s);
  const dim = (s: string) => (paint ? `\x1b[2m${s}\x1b[22m` : s);
  const out: string[] = [bold(report.outcome)];
  if (report.request) out.push(dim(`Request: ${report.request}`));
  for (const s of report.sections) {
    out.push(``, bold(s.title));
    for (const l of s.lines) out.push(`  - ${l}`);
  }
  return out.join("\n");
}

/**
 * Addendum label column. Every row's text starts at the same character —
 * `guidelines` is the widest label at 10, plus two spaces. Padding, not hand
 * counting: `needs you  ` shipped one short and the column bent around it.
 */
const ADDENDUM_LABEL_WIDTH = 12;

/**
 * What the harness knows that the model's own closing report cannot: the
 * guideline audit (finalized after the model's last message), where the
 * report was saved, and how to resume. Printed instead of the full card when
 * the closer already carries What shipped / Verified / Not done / Needs you,
 * so the run does not end with the same four headings twice.
 */
export function renderRunReportAddendum(
  report: RunReport,
  opts?: { color?: boolean; savedPath?: string | null },
): string {
  const paint = ansiOn(opts?.color);
  const dim = (s: string) => (paint ? `\x1b[2m${s}\x1b[22m` : s);
  const row = (label: string, text: string) =>
    dim(`  ${label.padEnd(ADDENDUM_LABEL_WIDTH)}${text}`);
  const out: string[] = [];
  for (const title of ["Agent guidelines", "Needs you"]) {
    const s = report.sections.find((x) => x.title === title);
    if (!s) continue;
    // "Nothing pending" is the model's line to write, not a second copy.
    const lines = s.lines.filter((l) => !/^Nothing\b/i.test(l));
    if (!lines.length) continue;
    const label = title === "Needs you" ? "needs you" : "guidelines";
    for (const l of lines) out.push(row(label, l));
  }
  const resume = report.sections.find((x) => x.title === "Resume");
  for (const l of resume?.lines || []) out.push(row("resume", l));
  if (opts?.savedPath) out.push(row("saved", opts.savedPath));
  return out.join("\n");
}

/**
 * `/status` head: the outcome sentence plus what is still open, in two or
 * three lines. Full sections stay behind `/report`.
 */
export function statusHeadLines(report: RunReport): string[] {
  const out: string[] = [`run      ${report.outcome}`];
  const notDone = report.sections.find((s) => s.title === "Not done");
  const open = (notDone?.lines || []).filter(
    (l) => !/^Nothing left open/i.test(l),
  );
  if (open.length) {
    out.push(
      `open     ${open.length} item${open.length === 1 ? "" : "s"}: ${open
        .slice(0, 2)
        .map((l) => l.replace(/\s+/g, " ").trim())
        .join(" · ")}${open.length > 2 ? ` · +${open.length - 2} more` : ""}  · /report`,
    );
  }
  const needs = report.sections.find((s) => s.title === "Needs you");
  const ops = (needs?.lines || []).filter((l) => /^Operator:/i.test(l));
  // 9-char label column, same as the card's `plan     ` / `stack` rows.
  if (ops.length) out.push(`needs    ${ops.slice(0, 2).join(" · ")}`);
  return out;
}

export function runReportPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "report.md");
}

/** Persist the report beside the session (never in the repo). */
export function writeRunReport(sessionId: string, report: RunReport): string | null {
  try {
    const p = runReportPath(sessionId);
    ensureDir(path.dirname(p));
    fs.writeFileSync(p, `${report.markdown}\n`, { encoding: "utf8", mode: 0o600 });
    return p;
  } catch {
    return null;
  }
}

/**
 * Run endings where no guard read the closing message, so its shape proves
 * nothing: the stuck-wall and the continue cap release before the step-8
 * guard, and the cost / turn caps end the loop without a Stop evaluation.
 */
export function endedUnshaped(r: {
  stuckReleased?: boolean;
  hitCostCap?: boolean;
  hitMaxTurns?: boolean;
  releasedOnContinueCap?: boolean;
}): boolean {
  return Boolean(
    r.stuckReleased || r.hitCostCap || r.hitMaxTurns || r.releasedOnContinueCap,
  );
}

/**
 * Should the harness print the standalone report at the end of this run?
 * Multi-round runs (harness re-anchored ≥ 2 times), driver ends
 * (ULW release / sit-down / stuck / caps), or `force`.
 */
export function shouldPrintRunReport(r: {
  stopContinues?: number;
  lastCycleReleased?: boolean;
  lastCycleSatDown?: boolean;
  stuckReleased?: boolean;
  hitCostCap?: boolean;
  hitMaxTurns?: boolean;
  aborted?: boolean;
  editCount?: number;
}): boolean {
  if (r.aborted) return false;
  if (
    r.lastCycleReleased ||
    r.lastCycleSatDown ||
    r.stuckReleased ||
    r.hitCostCap ||
    r.hitMaxTurns
  ) {
    return true;
  }
  return (r.stopContinues ?? 0) >= 2 && (r.editCount ?? 0) > 0;
}

/**
 * End-of-run hook for the REPL and headless `forge run`: when the run was
 * multi-round or a driver ended, build + persist the report and return the
 * terminal rendering. Null when the one-line turn closer is enough.
 *
 * The call: the report the user reads is the model's own closing message —
 * the report guard makes it outcome-first with the four labelled sections,
 * on the terminal attestation too. So when the closer already reads as a
 * run-wide report, the harness prints only what it knows and the model
 * cannot (the guideline audit, resume, the saved path) instead of a second
 * copy of the same four headings.
 *
 * That trade only holds where a guard actually read the closer. A stuck-wall
 * release returns `allowStop` before the step-8 guard, step 1b only inspects
 * a terminal attestation and a stuck run has none, and a cost/turn cap ends
 * the loop with no Stop evaluation at all. Those are exactly the endings
 * whose "Not done" lines the user needs ("released on a stuck-wall", "run
 * stopped at the spend cap"), and `looksLikeRunReport` is a two-label
 * heuristic that a mid-work message can pass by accident. So a run that
 * ended stuck, capped, or released on the continue cap always gets the full
 * card, whatever its last message looked like.
 */
export function maybeRenderRunReportForRun(opts: {
  session: SessionData;
  workspace: string;
  result: NonNullable<RunReportInput["result"]>;
  color?: boolean;
  force?: boolean;
  /** Print the full card even when the closer already is a report. */
  full?: boolean;
}): string | null {
  const { session, result } = opts;
  if (
    !opts.force &&
    !shouldPrintRunReport({ ...result, editCount: session.meta.editCount })
  ) {
    return null;
  }
  try {
    const report = buildRunReport({
      session,
      workspace: opts.workspace,
      result,
    });
    const saved = writeRunReport(session.meta.id, report);
    if (!opts.full && !endedUnshaped(result) && looksLikeRunReport(result.finalText || "")) {
      const addendum = renderRunReportAddendum(report, {
        color: opts.color,
        savedPath: saved,
      });
      return addendum || null;
    }
    const text = renderRunReportText(report, { color: opts.color });
    return saved ? `${text}\n  saved: ${saved}` : text;
  } catch {
    return null;
  }
}

function safeLoadUlw(id: string): UlwCycleState | null {
  try {
    return loadUlwCycle(id);
  } catch {
    return null;
  }
}

function safeLoadGoal(id: string): GoalState | null {
  try {
    return loadGoal(id);
  } catch {
    return null;
  }
}

function safeGuidelineLines(sessionId: string, workspace: string): string[] {
  try {
    return formatGuidelineReportLines({ sessionId, workspace });
  } catch {
    return [];
  }
}
