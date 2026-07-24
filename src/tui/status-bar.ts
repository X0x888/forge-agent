/**
 * In-REPL status surfaces — so users do not need a second `forge status --watch` pane.
 *
 * 1. Compact strip in the prompt (always-on session health)
 * 2. Working indicator during agent turns (phase + elapsed)
 * 3. Post-turn footer (context / tokens / bg / todos)
 */
import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import type { SessionData } from "../session/session.js";
import type { ResolvedAuth } from "../auth/types.js";
import { describeAuth } from "../auth/resolve.js";
import { loadGoal } from "../harness/goal.js";
import { loadUlwCycle } from "../harness/ulw-cycle.js";
import { sessionToSnapshot } from "../statusline/snapshot.js";
import { renderCompactStrip, renderHud } from "../statusline/render.js";
import {
  getActivity,
  activityElapsedSec,
  phaseElapsedSec,
  type AgentPhase,
  type SessionActivity,
} from "../statusline/activity.js";
import { listTasks } from "../agent/tools/background-tasks.js";
import { formatTokens, formatCost, estimateCostUsd } from "../util/format.js";
import { estimateTokens } from "../session/session.js";
import type { AuthMethod } from "../statusline/types.js";

export interface StatusBarContext {
  config: ForgeConfig;
  session: SessionData;
  auth: ResolvedAuth;
}

function authMethodOf(auth: ResolvedAuth): AuthMethod {
  return (auth.method as AuthMethod) || "unknown";
}

export function buildLiveSnapshot(ctx: StatusBarContext) {
  return sessionToSnapshot(ctx.session, {
    windowTokens: ctx.config.contextWindow,
    authMethod: authMethodOf(ctx.auth),
    authLabel: ctx.auth.accountLabel,
    permissionMode: ctx.config.permissionMode,
  });
}

/** Flags shown before `forge ›` — ULW, GOAL, PLAN, YOLO, bg, working. */
export function buildPromptFlags(ctx: StatusBarContext): string {
  const flags: string[] = [];
  const { session, config } = ctx;
  if (session.meta.ultrawork) flags.push(chalk.magenta("ULW"));
  const ulw = loadUlwCycle(session.meta.id);
  if (ulw?.enabled) {
    flags.push(ulw.cycle === 1 ? chalk.magenta("c=1") : chalk.yellow("c=0"));
  }
  const g = loadGoal(session.meta.id);
  if (g?.objective && !g.paused && g.status === "active") {
    flags.push(chalk.yellow("GOAL"));
  }
  if (config.permissionMode === "plan") flags.push(chalk.blue("PLAN"));
  if (config.permissionMode === "bypassPermissions") {
    flags.push(chalk.red("YOLO"));
  } else if (config.permissionMode === "acceptEdits") {
    flags.push(chalk.green("auto"));
  }

  const act = getActivity();
  const bgRunning =
    act.bgRunning || listTasks().filter((t) => t.status === "running").length;
  if (bgRunning > 0) {
    flags.push(chalk.yellow(`bg:${bgRunning}`));
  }
  if (act.busy) {
    flags.push(chalk.magenta(phaseShort(act)));
  }

  return flags.length ? chalk.dim(`[${flags.join(" ")}] `) : "";
}

function phaseShort(act: SessionActivity): string {
  if (act.phase === "tool" && act.detail) {
    const d = act.detail.replace(/\s+/g, " ").slice(0, 16);
    return d;
  }
  switch (act.phase) {
    case "thinking":
      return "…";
    case "compacting":
      return "compact";
    case "stop_guard":
      return "harness";
    case "waiting":
      return "wait";
    case "tool":
      return "tool";
    default:
      return act.phase;
  }
}

/**
 * Compact health strip for the line above the prompt (idle).
 * Returns empty string when nothing useful to show (fresh session).
 */
export function renderIdleStatusLine(ctx: StatusBarContext): string {
  const snap = buildLiveSnapshot(ctx);
  const width = process.stdout.columns ?? 100;
  // Skip noise on brand-new empty sessions
  if (
    snap.turnCount === 0 &&
    snap.tokens.totalTokens === 0 &&
    !snap.activity?.busy &&
    !(snap.activity?.bgRunning)
  ) {
    // Still show context window readiness + model briefly
    return chalk.dim(
      `  ${snap.provider}/${shortModel(snap.model)}  ctx 0/${formatTokens(snap.context.windowTokens)}  ${describeAuth(ctx.auth)}`,
    );
  }
  return "  " + renderCompactStrip(snap, { width: width - 2, showActivity: true });
}

function shortModel(model: string): string {
  const base = model.includes("/") ? model.split("/").pop()! : model;
  return base.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/** Full HUD for /status — same as forge status, for this session. */
export function renderSessionHud(
  ctx: StatusBarContext,
  opts: { plain?: boolean } = {},
): string {
  const snap = buildLiveSnapshot(ctx);
  // Attach plan only when caller already fetched it; keep slash path snappy
  return renderHud([snap], {
    plain: opts.plain,
    width: process.stdout.columns,
  });
}

/** One-line footer printed after each agent turn. */
export function renderTurnFooter(
  ctx: StatusBarContext,
  turn: { promptTokens: number; completionTokens: number; stopContinues?: number },
): string {
  const snap = buildLiveSnapshot(ctx);
  const width = process.stdout.columns ?? 100;
  const cost = estimateCostUsd(
    String(ctx.config.provider),
    turn.promptTokens,
    turn.completionTokens,
  );
  const parts: string[] = [];
  parts.push(chalk.dim("──"));
  parts.push(
    chalk.dim(
      `ctx ${snap.context.percent}% (${formatTokens(snap.context.usedTokens)}/${formatTokens(snap.context.windowTokens)})`,
    ),
  );
  if (turn.promptTokens + turn.completionTokens > 0) {
    parts.push(
      chalk.dim(
        `turn in=${formatTokens(turn.promptTokens)} out=${formatTokens(turn.completionTokens)} ~${formatCost(cost)}`,
      ),
    );
  }
  if (snap.openTodos > 0) {
    parts.push(chalk.yellow(`todos:${snap.openTodos}`));
  }
  const bg = listTasks().filter((t) => t.status === "running");
  if (bg.length) {
    parts.push(chalk.yellow(`bg:${bg.length} running`));
  }
  if (turn.stopContinues && turn.stopContinues > 0) {
    parts.push(chalk.magenta(`harness×${turn.stopContinues}`));
  }
  if (snap.goal?.active) parts.push(chalk.yellow("GOAL"));

  let line = parts.join("  ");
  if (visibleWidth(line) > width && width > 20) {
    line = clipAnsi(line, width);
  }
  return line;
}

// ─── Working indicator (mid-turn) ───────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface WorkingIndicator {
  /** Start spinner / phase display */
  start: () => void;
  /** Update phase text (thinking / tool / compact…) */
  setPhase: (phase: AgentPhase, detail?: string) => void;
  /**
   * Pause spinner (refcount). Nested pause/resume safe for parallel tools
   * and permission prompts.
   */
  pause: () => void;
  /** Resume when pause depth hits 0 */
  resume: () => void;
  /** Clear line and stop */
  stop: () => void;
  /** True while indicator owns the line */
  active: () => boolean;
  /** Current pause depth (for tests) */
  pauseDepth: () => number;
}

/**
 * In-place working line on stderr so stdout token streams stay clean.
 * Uses \r redraw; safe when TTY. Falls back to one-shot dim lines when not.
 * Pause is reference-counted so parallel tools / permission prompts nest safely.
 */
export function createWorkingIndicator(): WorkingIndicator {
  const isTty = Boolean(process.stderr.isTTY);
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let pauseDepth = 0;
  let running = false;
  let phase: AgentPhase = "thinking";
  let detail: string | undefined;

  const label = (): string => {
    const act = getActivity();
    const turnSec = activityElapsedSec(act);
    const phaseSec = phaseElapsedSec(act);
    const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    let body: string;
    if (phase === "tool" && detail) {
      body = `tool ${chalk.cyan(shortDetail(detail))}`;
    } else if (phase === "compacting") {
      body = chalk.yellow("compacting…");
    } else if (phase === "stop_guard") {
      body = chalk.magenta("harness check…");
    } else if (phase === "waiting") {
      body = chalk.yellow(`waiting on bg${detail ? `: ${shortDetail(detail)}` : "…"}`);
    } else {
      body = chalk.dim("thinking…");
    }
    const time =
      turnSec > 0
        ? chalk.dim(` ${formatSec(turnSec)}`)
        : phaseSec > 0
          ? chalk.dim(` ${formatSec(phaseSec)}`)
          : "";
    const bg =
      act.bgRunning > 0 ? chalk.yellow(`  bg:${act.bgRunning}`) : "";
    return `${chalk.magenta(spin)} ${chalk.magenta("⚒")} ${body}${time}${bg}`;
  };

  const paint = () => {
    if (!running || pauseDepth > 0 || !isTty) return;
    const text = label();
    const width = process.stderr.columns || 80;
    const plainLen = visibleWidth(text);
    const pad = Math.max(0, Math.min(width, plainLen + 4) - plainLen);
    const line = clipAnsi(text + " ".repeat(pad), width);
    process.stderr.write("\r" + line);
  };

  const clearLine = () => {
    if (!isTty) return;
    const width = process.stderr.columns || 80;
    process.stderr.write("\r" + " ".repeat(width) + "\r");
  };

  return {
    start() {
      running = true;
      pauseDepth = 0;
      frame = 0;
      if (!isTty) {
        process.stderr.write(chalk.dim("  ⚒ working…\n"));
        return;
      }
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        frame += 1;
        paint();
      }, 80);
      timer.unref?.();
      paint();
    },
    setPhase(p, d) {
      phase = p;
      detail = d;
      if (running && pauseDepth === 0) paint();
    },
    pause() {
      if (!running) return;
      pauseDepth += 1;
      if (pauseDepth === 1) clearLine();
    },
    resume() {
      if (!running) return;
      if (pauseDepth > 0) pauseDepth -= 1;
      if (pauseDepth === 0) paint();
    },
    stop() {
      running = false;
      pauseDepth = 0;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      clearLine();
    },
    active: () => running,
    pauseDepth: () => pauseDepth,
  };
}

/** Visible character length ignoring ANSI CSI sequences. */
export function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Clip a chalk-colored string to `max` visible columns without mid-SGR cuts. */
export function clipAnsi(text: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(text) <= max) return text;
  let out = "";
  let vis = 0;
  // eslint-disable-next-line no-control-regex
  const re = /(\x1b\[[0-9;]*m)|./g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) {
      out += m[1];
      continue;
    }
    if (vis >= max) break;
    out += m[0];
    vis += 1;
  }
  return out + "\x1b[0m";
}

function shortDetail(s: string, max = 40): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function formatSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

/** Human list of background tasks for /tasks and /status. */
export function formatBackgroundTasksList(): string {
  const tasks = listTasks();
  if (!tasks.length) {
    return chalk.dim("No background tasks in this process.");
  }
  return tasks
    .map((t) => {
      const elapsed = Math.floor(
        ((t.endedAt || Date.now()) - t.startedAt) / 1000,
      );
      const stRaw =
        t.status === "running"
          ? "running"
          : t.status === "completed"
            ? "done"
            : t.status === "failed"
              ? "fail"
              : t.status;
      const stColored =
        t.status === "running"
          ? chalk.yellow(stRaw.padEnd(8))
          : t.status === "completed"
            ? chalk.green(stRaw.padEnd(8))
            : t.status === "failed"
              ? chalk.red(stRaw.padEnd(8))
              : chalk.dim(stRaw.padEnd(8));
      const cmd = t.command.replace(/\s+/g, " ").slice(0, 60);
      return `  ${t.id.slice(0, 18).padEnd(18)} ${stColored} ${formatSec(elapsed).padStart(5)}  ${cmd}`;
    })
    .join("\n");
}

/** Extra session detail block under the HUD for /status. */
export function formatSessionDetails(ctx: StatusBarContext): string {
  const { session, config, auth } = ctx;
  const g = loadGoal(session.meta.id);
  const ulw = loadUlwCycle(session.meta.id);
  const est = estimateTokens(session.messages);
  const lines = [
    chalk.dim("─".repeat(Math.min(48, process.stdout.columns || 48))),
    chalk.dim(`session  ${session.meta.id.slice(0, 8)}`) +
      (session.meta.title ? chalk.dim(` · ${session.meta.title.slice(0, 40)}`) : ""),
    chalk.dim(`auth     ${describeAuth(auth)}`),
    chalk.dim(
      `perms    ${config.permissionMode}  ·  Stop ${config.blockingStopHooks ? "blocking" : "passive"}`,
    ),
    chalk.dim(
      `msgs     ${session.messages.length}  ·  ~${formatTokens(est)} ctx  ·  turns ${session.meta.turnCount}  edits ${session.meta.editCount}`,
    ),
  ];
  if (ulw?.enabled) {
    lines.push(
      chalk.dim(
        `ulw      cycle=${ulw.cycle} wave=${ulw.wave}  ${ulw.mandate.slice(0, 50)}`,
      ),
    );
  }
  if (g?.objective) {
    lines.push(
      chalk.dim(
        `goal     [${g.status}${g.paused ? ",paused" : ""}] ${g.objective.slice(0, 60)}`,
      ),
    );
  }
  const bg = listTasks();
  if (bg.length) {
    lines.push(chalk.dim("bg tasks"));
    lines.push(formatBackgroundTasksList());
  }
  return lines.join("\n");
}
