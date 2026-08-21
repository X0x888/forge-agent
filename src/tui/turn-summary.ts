import type { SessionData } from "../session/session.js";
import { isLastVerificationStale } from "../session/session.js";
import type { FileMutation } from "../session/mutations.js";
import { readFileMutations } from "../session/mutations.js";
import { displayRelPath } from "../agent/tools/path-util.js";
import { detectProjectIntel } from "../util/project-intel.js";
import chalk, { Chalk } from "chalk";
import { clipAnsi, formatTokens, visibleWidth } from "../util/format.js";
import { formatRunFailureCloser } from "../providers/errors.js";

/**
 * Pure formatter for the end-of-turn change summary (unattended runs):
 * which files actually changed on disk this turn + whether a verification
 * command has run since the last edit. Returns null when nothing was
 * edited — the REPL stays silent then.
 */
export function formatTurnChangeSummary(
  edits: FileMutation[],
  cwd: string,
  meta: SessionData["meta"],
  preferredCheck?: string | null,
): string | null {
  if (!edits.length) return null;
  const byPath = new Map<string, string>();
  for (const m of edits) byPath.set(m.path, m.kind);
  const names = [...byPath.entries()].map(([p, kind]) => {
    const label = displayRelPath(cwd, p);
    return kind === "create" ? `${label} (new)` : label;
  });
  const lv = meta.lastVerificationCommand?.trim();
  const next = preferredCheck?.trim();
  const red = meta.lastVerificationOk === false;
  const stale = isLastVerificationStale(meta);
  const verify = lv
    ? stale
      ? `verify: ${lv}${red ? " ✗" : ""} (stale — predates last edit)`
      : red
        ? `verify: ${lv} ✗`
        : `verify: ${lv} ✓`
    : next
      ? `verify: none — run ${next}`
      : `verify: none — edits unverified`;
  const cols = process.stdout.isTTY ? process.stdout.columns || 80 : 80;
  const prefix = `  Δ ${byPath.size} file${byPath.size === 1 ? "" : "s"}: `;
  const callout = !lv || red || stale;
  const fitNames = (budget: number): string => {
    let shown = names.slice(0, 6);
    let more = names.length > shown.length ? ` +${names.length - shown.length} more` : "";
    while (
      shown.length > 1 &&
      visibleWidth(`${shown.join(", ")}${more}`) > budget
    ) {
      shown = shown.slice(0, -1);
      more = ` +${names.length - shown.length} more`;
    }
    let mid = `${shown.join(", ")}${more}`;
    if (visibleWidth(mid) > budget) mid = clipAnsi(mid, budget);
    return mid;
  };
  if (callout) {
    const mid = fitNames(Math.max(8, cols - visibleWidth(prefix)));
    const files = clipAnsi(`${prefix}${mid}`, cols);
    const check = clipAnsi(`  ${verify}`, cols);
    return `${files}\n${chalk.yellow(check)}`;
  }
  const suffix = `  ·  ${verify}`;
  const reserved = visibleWidth(prefix) + visibleWidth(suffix);
  if (reserved >= cols) {
    return `${prefix}${clipAnsi(suffix.trimStart(), Math.max(8, cols - visibleWidth(prefix)))}`;
  }
  const mid = fitNames(cols - reserved);
  return `${prefix}${mid}${suffix}`;
}

/**
 * Journal + intel shim for the Δ closer. Shared by the REPL and
 * non-JSON `forge run` so unattended logs show the same files+verify line.
 * Returns null when nothing was edited this turn (or the journal is missing).
 */
export function formatTurnChangeSummaryForSession(
  session: SessionData,
  turnAtStart: number,
): string | null {
  const edits = readFileMutations(session.meta.id).filter(
    (m) => m.turn > turnAtStart,
  );
  let preferred: string | null = null;
  try {
    preferred =
      detectProjectIntel(session.meta.cwd || process.cwd()).checkCommands[0] ??
      null;
  } catch {
    /* intel is best-effort */
  }
  return formatTurnChangeSummary(
    edits,
    session.meta.cwd,
    session.meta,
    preferred,
  );
}

/** Inputs for the dim why-this-run-stopped closer (REPL + non-JSON forge run). */
export interface RunStopReasonInput {
  hitCostCap?: boolean;
  hitMaxTurns?: boolean;
  releasedOnContinueCap?: boolean;
  stuckReleased?: boolean;
  lastCycleReleased?: boolean;
  aborted?: boolean;
  stopContinues?: number;
  lastErrorCode?: string | null;
}

/**
 * Join the post-turn health footer with the Δ files+verify line.
 * When both exist they become one closer (two lines only if the TTY is
 * too narrow). An empty `──` footer collapses so Δ stands alone.
 */
export function composeTurnCloser(
  footer: string,
  delta: string | null,
): string {
  if (!delta) return footer;
  const bits = footer
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/^──\s*/, "")
    .trim();
  if (!bits) return delta;
  const one = `${footer}  ${delta}`;
  const width = process.stdout.columns ?? 100;
  if (visibleWidth(one) <= Math.max(40, width)) return one;
  return `${footer}\n${delta}`;
}

/**
 * One dim line when a run did not stop cleanly. Silent on a normal Stop
 * so the Δ closer stays the last chrome. Shared by REPL and `forge run`.
 */
export function formatRunStopReason(input: RunStopReasonInput): string | null {
  if (input.aborted) {
    return "  stop: aborted — /retry or forge run --continue";
  }
  if (input.hitCostCap) {
    return "  stop: cost cap — raise /budget · --max-cost · FORGE_MAX_COST_USD";
  }
  if (input.hitMaxTurns) {
    return "  stop: max turns — raise max_turns or continue with a follow-up";
  }
  if (input.stuckReleased) {
    return "  stop: stuck-wall — no progress; /cycle 1 or /ulw to resume";
  }
  if (input.lastCycleReleased) {
    return "  stop: cycle complete — /cycle 1 or /ulw if more work remains";
  }
  if (input.releasedOnContinueCap) {
    const n = input.stopContinues;
    const count =
      typeof n === "number" && Number.isFinite(n) && n > 0
        ? ` after ${n} harness continue${n === 1 ? "" : "s"}`
        : "";
    return `  stop: continue-cap${count} — narrow the task or raise FORGE_ULW_MAX_CONTINUES`;
  }
  const code = String(input.lastErrorCode || "").trim();
  if (code === "ulw_stuck_wall" || code === "goal_stuck_wall") {
    return "  stop: stuck-wall — no progress; /cycle 1 or /ulw to resume";
  }
  if (code === "ulw_cycle_complete") {
    return "  stop: cycle complete — /cycle 1 or /ulw if more work remains";
  }
  if (code === "handoff_released") {
    return "  stop: handoff-guard — finish the work instead of asking to continue";
  }
  if (code === "proof_claim_released") {
    return "  stop: proof-claim — run a check before claiming done";
  }
  if (code === "max_cost") {
    return "  stop: cost cap — raise /budget · --max-cost · FORGE_MAX_COST_USD";
  }
  if (code === "max_turns") {
    return "  stop: max turns — raise max_turns or continue with a follow-up";
  }
  if (code.startsWith("continue_cap")) {
    return "  stop: continue-cap — narrow the task or raise FORGE_ULW_MAX_CONTINUES";
  }
  if (code === "thought_only_cap") {
    return "  stop: thought-only — /retry (ULW still CONTINUE; model sat in thought with no tools)";
  }
  if (code === "max_run_ms") {
    return "  stop: wall-clock — raise FORGE_MAX_RUN_MS or narrow the task";
  }
  if (code === "empty_run") {
    return "  stop: empty run — forge doctor · forge auth · check model id";
  }
  // Provider / run failures that used to go silent — same Next grammar as /status.
  const closer = formatRunFailureCloser(code);
  return closer || null;
}

/**
 * Scannable turn opener. Idle Enter already leaves `forge › text` in
 * scrollback; this is for the cases that do not: mid-run queue (live ›
 * is abandoned when tokens stream), slash-forwarded prompts, initialPrompt,
 * and headless `forge run`.
 */
export function formatUserTurnOpen(
  text: string,
  opts?: { width?: number; queued?: number },
): string | null {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!one) return null;
  const cols = Math.max(
    8,
    opts?.width ??
      (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  const prefix = "you › ";
  const suffix =
    typeof opts?.queued === "number" && opts.queued > 0
      ? `  ·  queued q:${opts.queued}`
      : "";
  const budget = Math.max(4, cols - visibleWidth(prefix) - visibleWidth(suffix));
  const body = one.length > budget ? `${one.slice(0, budget - 1)}…` : one;
  return `${prefix}${body}${suffix}`;
}

/**
 * Label for the first token of an assistant burst. Pairs with `you ›`
 * so the live transcript (and headless stream) matches `/last` cards.
 */
export function formatAssistantTurnOpen(opts?: { color?: boolean }): string {
  const on = opts?.color ?? Boolean(process.stdout.isTTY);
  if (!on) return "forge ›";
  const paint = new Chalk({ level: Math.max(chalk.level, 1) as 1 | 2 | 3 });
  return paint.dim("forge ›");
}

/** Approx tokens from reasoning chars (count-only — never keep the text). */
export function estimateReasoningTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.max(1, Math.round(chars / 4));
}

/** Repaint key: token bucket + elapsed second. */
export function thinkingLandmarkKey(chars: number, elapsedSec: number): string {
  return `${estimateReasoningTokens(chars)}:${Math.max(0, Math.floor(elapsedSec))}`;
}

/**
 * Designed empty-reply edge before `forge ›`. Count + elapsed only —
 * never thought text. Silent until chars > 0.
 */
export function formatThinkingTurnOpen(opts: {
  chars: number;
  elapsedSec?: number;
  width?: number;
  color?: boolean;
}): string | null {
  if (opts.chars <= 0) return null;
  const tokens = estimateReasoningTokens(opts.chars);
  const elapsed =
    typeof opts.elapsedSec === "number" && opts.elapsedSec > 0
      ? ` · ${formatThinkingElapsed(opts.elapsedSec)}`
      : "";
  const on = opts.color ?? Boolean(process.stdout.isTTY);
  const raw = `think › ${formatTokens(tokens)}${elapsed}`;
  const cols = Math.max(
    8,
    opts.width ??
      (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  const clipped = visibleWidth(raw) <= cols ? raw : clipAnsi(raw, cols);
  if (!on) return clipped;
  const paint = new Chalk({ level: Math.max(chalk.level, 1) as 1 | 2 | 3 });
  return paint.dim(clipped);
}

function formatThinkingElapsed(sec: number): string {
  const n = Math.max(0, Math.floor(sec));
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

export interface ThinkingLandmark {
  /** Count-only. Never pass thought text. */
  push: (chars: number) => void;
  /**
   * Replace the open think line with the reply opener (TTY) or append
   * it (non-TTY). Returns false when nothing was showing.
   */
  takeForReply: (replacement: string) => boolean;
  /** Keep think › in scrollback (tools started / turn ended with no text). */
  settle: () => void;
  chars: () => number;
}

/**
 * In-place `think › 1.2k · 18s` until the first content token.
 * Non-TTY: one line, no flood.
 */
export function createThinkingLandmark(opts?: {
  write?: (s: string) => void;
  tty?: boolean;
  columns?: () => number;
  now?: () => number;
  color?: boolean;
}): ThinkingLandmark {
  const write = opts?.write ?? ((s: string) => process.stdout.write(s));
  const tty =
    opts?.tty ?? Boolean(process.stdout.isTTY && process.env.NO_COLOR == null);
  const columns = opts?.columns ?? (() => process.stdout.columns || 80);
  const now = opts?.now ?? Date.now;
  const color = opts?.color ?? tty;
  let chars = 0;
  let startedAt = 0;
  let painted = false;
  let open = false;
  let lastKey = "";
  let lastWidth = 0;

  const elapsedSec = (): number =>
    startedAt ? Math.max(0, Math.floor((now() - startedAt) / 1000)) : 0;

  const lineFor = (): string | null =>
    formatThinkingTurnOpen({
      chars,
      elapsedSec: elapsedSec(),
      width: Math.max(8, columns()),
      color,
    });

  const paint = (first: boolean) => {
    const line = lineFor();
    if (!line) return;
    const key = thinkingLandmarkKey(chars, elapsedSec());
    if (!first && key === lastKey) return;
    lastKey = key;
    const width = visibleWidth(line);
    if (first) {
      write(tty ? `\n${line}` : `${line}\n`);
    } else if (tty) {
      const pad = Math.max(0, lastWidth - width);
      write(`\r${line}${" ".repeat(pad)}`);
    }
    lastWidth = width;
    painted = true;
    open = tty;
  };

  return {
    push(n: number) {
      const add = Math.max(0, Math.floor(n));
      if (add <= 0) return;
      chars += add;
      if (!startedAt) startedAt = now();
      paint(!painted);
    },
    takeForReply(replacement: string) {
      if (!painted) return false;
      if (open && tty) {
        const next = replacement || "";
        const pad = Math.max(0, lastWidth - visibleWidth(next));
        write(`\r${next}${" ".repeat(pad)}\n`);
      } else {
        write(`${replacement}\n`);
      }
      open = false;
      painted = false;
      chars = 0;
      startedAt = 0;
      lastKey = "";
      lastWidth = 0;
      return true;
    },
    settle() {
      if (open) write("\n");
      open = false;
      painted = false;
      chars = 0;
      startedAt = 0;
      lastKey = "";
      lastWidth = 0;
    },
    chars: () => chars,
  };
}
