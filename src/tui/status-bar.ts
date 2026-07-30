/**
 * In-REPL status surfaces — so users do not need a second `forge status --watch` pane.
 *
 * 1. Compact strip in the prompt (always-on session health)
 * 2. Working indicator during agent turns (phase + elapsed)
 * 3. Post-turn footer (context / tokens / bg / todos)
 */
import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import { resolveReasoningEffort } from "../config/reasoning.js";
import type { SessionData } from "../session/session.js";
import type { ResolvedAuth } from "../auth/types.js";
import { describeAuth } from "../auth/resolve.js";
import { listAccounts } from "../auth/store.js";
import { loadGoal } from "../harness/goal.js";
import {
  loadUlwCycle,
  formatUlwBadge,
  ULW_LIVE_CONTROLS_HINT,
} from "../harness/ulw-cycle.js";
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
import { estimateTokens, sessionDir } from "../session/session.js";
import { readSessionLock, formatLockHolder } from "../session/lock.js";
import type { AuthMethod } from "../statusline/types.js";

export interface StatusBarContext {
  config: ForgeConfig;
  session: SessionData;
  auth: ResolvedAuth;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function authMethodOf(auth: ResolvedAuth): AuthMethod {
  return (auth.method as AuthMethod) || "unknown";
}

export function buildLiveSnapshot(ctx: StatusBarContext) {
  let accountCount: number | undefined;
  try {
    accountCount = listAccounts(String(ctx.auth.provider)).length;
  } catch {
    /* optional */
  }
  return sessionToSnapshot(ctx.session, {
    windowTokens: ctx.config.contextWindow,
    authMethod: authMethodOf(ctx.auth),
    authLabel: ctx.auth.accountLabel,
    accountId: ctx.auth.accountId,
    accountCount,
    permissionMode: ctx.config.permissionMode,
  });
}

/** Flags shown before `forge ›` — ULW, GOAL, PLAN, YOLO, bg, working. */
export function buildPromptFlags(ctx: StatusBarContext): string {
  const flags: string[] = [];
  const { session, config } = ctx;
  const ulw = loadUlwCycle(session.meta.id);
  if (ulw?.enabled) {
    flags.push(chalk.magenta("ULW"));
    const badge = formatUlwBadge(ulw);
    flags.push(
      ulw.cycle === 1 ? chalk.magenta(badge) : chalk.yellow(badge),
    );
  } else if (session.meta.ultrawork) {
    flags.push(chalk.magenta("ULW"));
  }
  const g = loadGoal(session.meta.id);
  if (g?.objective && !g.paused && g.status === "active") {
    flags.push(chalk.yellow("GOAL"));
  }
  if (session.meta.pinned) {
    flags.push(chalk.cyan("PIN"));
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

/**
 * Multi-line chrome printed once when an agent turn starts.
 * Makes mid-run controls discoverable (Grok-Build-like, native to Forge).
 */
export function renderLiveRunHeader(ctx: StatusBarContext): string {
  const { config, session } = ctx;
  const effort = resolveReasoningEffort(config.model, config.reasoningEffort);
  const ulw = loadUlwCycle(session.meta.id);
  const g = loadGoal(session.meta.id);
  const w = Math.min(process.stdout.columns || 72, 72);
  const bar = "─".repeat(Math.max(20, w - 2));

  const modelBits = [
    `${config.provider}/${shortModel(config.model)}`,
    effort ? `effort ${effort}` : null,
    config.permissionMode === "bypassPermissions"
      ? "YOLO"
      : config.permissionMode === "acceptEdits"
        ? "auto"
        : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const harnessBits: string[] = [];
  if (ulw?.enabled) {
    harnessBits.push(
      chalk.magenta(
        `ULW ${formatUlwBadge(ulw)} ${ulw.cycle === 1 ? "CONTINUE" : "LAST"}`,
      ),
    );
  } else if (session.meta.ultrawork) {
    harnessBits.push(chalk.magenta("ULW"));
  }
  if (g?.objective && !g.paused && g.status === "active") {
    harnessBits.push(chalk.yellow("GOAL"));
  }

  const lines = [
    chalk.cyan(`┌${bar}`),
    chalk.cyan("│ ") + chalk.bold("live run") + chalk.dim("  (input stays open — no Ctrl+C needed)"),
    chalk.cyan("│ ") + chalk.dim(modelBits),
  ];
  if (harnessBits.length) {
    lines.push(chalk.cyan("│ ") + harnessBits.join("  "));
  }
  lines.push(
    chalk.cyan("│ ") +
      chalk.dim("controls: ") +
      chalk.white("/cycle 0") +
      chalk.dim(" last · ") +
      chalk.white("/cycle 1") +
      chalk.dim(" continue · ") +
      chalk.white("/ulw-off") +
      chalk.dim(" · ") +
      chalk.white("/status") +
      chalk.dim(" · free-text queues"),
  );
  lines.push(
    chalk.cyan("│ ") +
      chalk.dim("type at the ") +
      chalk.cyan("live ›") +
      chalk.dim(" line below while the agent works"),
  );
  lines.push(chalk.cyan(`└${bar}`));
  return lines.join("\n");
}

/**
 * One-line busy status used by the working indicator (mid-reply, not only idle).
 */
export function renderBusyStatusLine(
  ctx: StatusBarContext,
  phase: AgentPhase,
  detail?: string,
  frame = 0,
): string {
  const act = getActivity();
  const turnSec = activityElapsedSec(act);
  const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const effort = resolveReasoningEffort(ctx.config.model, ctx.config.reasoningEffort);
  const ulw = loadUlwCycle(ctx.session.meta.id);

  let body: string;
  if (phase === "tool" && detail) {
    body = `tool ${chalk.cyan(shortDetail(detail, 28))}`;
  } else if (phase === "compacting") {
    body = chalk.yellow("compacting…");
  } else if (phase === "stop_guard") {
    body = chalk.magenta(
      detail ? `harness ${shortDetail(detail, 24)}` : "harness…",
    );
  } else if (phase === "waiting") {
    body = chalk.yellow(
      `waiting on bg${detail ? `: ${shortDetail(detail, 20)}` : "…"}`,
    );
  } else if (phase === "thinking" && detail === "streaming") {
    body = chalk.dim("replying…");
  } else {
    body = chalk.dim("thinking…");
  }

  const bits: string[] = [
    `${chalk.magenta(spin)} ${chalk.magenta("⚒")}`,
    body,
    turnSec > 0 ? chalk.dim(formatSec(turnSec)) : "",
    chalk.dim(`${ctx.config.provider}/${shortModel(ctx.config.model)}`),
  ];
  if (effort) bits.push(chalk.dim(effort));
  if (ulw?.enabled) {
    bits.push(
      ulw.cycle === 1
        ? chalk.magenta(formatUlwBadge(ulw))
        : chalk.yellow(formatUlwBadge(ulw)),
    );
  }
  if (act.bgRunning > 0) bits.push(chalk.yellow(`bg:${act.bgRunning}`));
  if (ulw?.enabled && ulw.cycle === 1) {
    bits.push(chalk.dim("/cycle 0"));
  }

  return bits.filter(Boolean).join(" ");
}

/**
 * Prompt string while an agent turn is in progress.
 * This IS the mid-run status dock (spinner + phase + harness) — not a bare
 * "live ›" that gets wiped by the stderr spinner or token stream.
 */
export function buildLivePrompt(
  ctx: StatusBarContext,
  opts?: { phase?: AgentPhase; detail?: string; frame?: number },
): string {
  const act = getActivity();
  const phase = opts?.phase ?? act.phase;
  const detail =
    opts?.detail ??
    (act.phase === "thinking" && act.detail === undefined && act.busy
      ? undefined
      : act.detail);
  const frame = opts?.frame ?? Math.floor(Date.now() / 80);
  const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const turnSec = activityElapsedSec(act);
  const effort = resolveReasoningEffort(ctx.config.model, ctx.config.reasoningEffort);
  const ulw = loadUlwCycle(ctx.session.meta.id);

  let phaseLabel: string;
  if (phase === "tool" && detail) {
    phaseLabel = `tool ${shortDetail(detail, 20)}`;
  } else if (phase === "compacting") phaseLabel = "compact";
  else if (phase === "stop_guard") phaseLabel = "harness";
  else if (phase === "waiting") phaseLabel = "wait";
  else if (detail === "streaming") phaseLabel = "reply";
  else phaseLabel = "think";

  const left: string[] = [
    chalk.magenta(spin),
    chalk.magenta("⚒"),
    chalk.cyan("LIVE"),
    chalk.dim(phaseLabel),
  ];
  if (turnSec > 0) left.push(chalk.dim(formatSec(turnSec)));
  if (ulw?.enabled) {
    left.push(
      ulw.cycle === 1
        ? chalk.magenta(formatUlwBadge(ulw))
        : chalk.yellow(formatUlwBadge(ulw)),
    );
  }
  if (effort) left.push(chalk.dim(effort));
  if (act.bgRunning > 0) left.push(chalk.yellow(`bg:${act.bgRunning}`));

  // Right side: explicit control affordance so it cannot be missed
  const hint =
    ulw?.enabled && ulw.cycle === 1
      ? chalk.dim(" /cycle 0")
      : chalk.dim(" /status");

  return (
    left.join(" ") +
    hint +
    " " +
    chalk.bold.cyan("live") +
    chalk.bold.cyan(" › ")
  );
}

/** Visible confirmation after a mid-run control command. */
export function formatLiveControlFeedback(
  command: string,
  output: string,
  kind: "ok" | "warn" | "info" = "ok",
): string {
  const color =
    kind === "warn" ? chalk.yellow : kind === "info" ? chalk.dim : chalk.green;
  const title =
    kind === "warn"
      ? "live (needs idle)"
      : kind === "info"
        ? "live"
        : "live ✓ applied";
  const body = output.trim() || "(no output)";
  return (
    "\n" +
    color(`── ${title} · ${command.trim()} ──`) +
    "\n" +
    body +
    "\n" +
    color("────────────────────────") +
    "\n" +
    chalk.dim("live › still open — type another control or wait for the run")
  );
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
    ctx.config.model,
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
  const ulw = loadUlwCycle(ctx.session.meta.id);
  if (ulw?.enabled) {
    parts.push(
      ulw.cycle === 1
        ? chalk.magenta(`ULW ${formatUlwBadge(ulw)}`)
        : chalk.yellow(`ULW ${formatUlwBadge(ulw)}`),
    );
    parts.push(chalk.dim("hint: /cycle 0"));
  }
  if (snap.goal?.active) parts.push(chalk.yellow("GOAL"));

  let line = parts.join("  ");
  if (visibleWidth(line) > width && width > 20) {
    line = clipAnsi(line, width);
  }
  return line;
}

// ─── Working indicator (mid-turn) ───────────────────────────────────────────

export interface WorkingIndicator {
  /** Start spinner / phase display */
  start: () => void;
  /** Update phase text (thinking / tool / compact…) */
  setPhase: (phase: AgentPhase, detail?: string) => void;
  /**
   * While model tokens stream on stdout, suppress \r paints (they garble the
   * reply) but keep periodic newline status ticks so the run never goes dark.
   */
  setStreaming: (on: boolean) => void;
  /**
   * Pause spinner (refcount). Nested pause/resume safe for parallel tools
   * and permission prompts.
   */
  pause: () => void;
  /** Resume when pause depth hits 0 */
  resume: () => void;
  /** Clear line and stop */
  stop: () => void;
  /** Force a paint (e.g. after live slash updates harness state) */
  repaint: () => void;
  /** True while indicator owns the line */
  active: () => boolean;
  /** Current pause depth (for tests) */
  pauseDepth: () => number;
}

export interface WorkingIndicatorOpts {
  /** Live session context for rich mid-run status (model, ULW, effort). */
  getContext?: () => StatusBarContext | null;
  /**
   * When true, do NOT paint a competing \r spinner on stderr.
   * The REPL docks status into the `live ›` prompt instead (recommended).
   */
  dockInPrompt?: boolean;
  /** Called on each tick when dockInPrompt — refresh the readline prompt. */
  onTick?: (frame: number, phase: AgentPhase, detail?: string) => void;
}

/**
 * Native mid-run status on stderr — OR prompt-docked mode for the REPL.
 *
 * dockInPrompt=true (REPL):
 *   No \r spinner (it erased `live ›`). Ticks call onTick so the prompt
 *   itself animates (spin + phase + ULW).
 *
 * dockInPrompt=false (fallback / tests):
 *   Spinning \r line; quiet during token stream with ~10s newline ticks.
 */
export function createWorkingIndicator(
  opts: WorkingIndicatorOpts = {},
): WorkingIndicator {
  const isTty = Boolean(process.stderr.isTTY);
  const dockInPrompt = Boolean(opts.dockInPrompt);
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let pauseDepth = 0;
  let running = false;
  let streaming = false;
  let phase: AgentPhase = "thinking";
  let detail: string | undefined;
  let lastTickAt = 0;
  const TICK_MS = 10_000;

  const label = (): string => {
    const ctx = opts.getContext?.() ?? null;
    if (ctx) {
      const paintPhase =
        streaming && phase === "thinking" ? "thinking" : phase;
      const paintDetail =
        streaming && phase === "thinking" ? "streaming" : detail;
      return renderBusyStatusLine(ctx, paintPhase, paintDetail, frame);
    }
    // Fallback when no context (tests / headless callers)
    const act = getActivity();
    const turnSec = activityElapsedSec(act);
    const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    let body: string;
    if (streaming) body = chalk.dim("replying…");
    else if (phase === "tool" && detail) {
      body = `tool ${chalk.cyan(shortDetail(detail))}`;
    } else if (phase === "compacting") body = chalk.yellow("compacting…");
    else if (phase === "stop_guard") {
      body = chalk.magenta(
        detail ? `harness ${shortDetail(detail)}` : "harness check…",
      );
    } else if (phase === "waiting") {
      body = chalk.yellow(
        `waiting on bg${detail ? `: ${shortDetail(detail)}` : "…"}`,
      );
    } else body = chalk.dim("thinking…");
    const time = turnSec > 0 ? chalk.dim(` ${formatSec(turnSec)}`) : "";
    const bg =
      act.bgRunning > 0 ? chalk.yellow(`  bg:${act.bgRunning}`) : "";
    return `${chalk.magenta(spin)} ${chalk.magenta("⚒")} ${body}${time}${bg}`;
  };

  const paint = () => {
    // Prompt-docked mode: never \r — that fought the live › line
    if (dockInPrompt) {
      if (running && pauseDepth === 0 && !streaming) {
        opts.onTick?.(frame, phase, detail);
      }
      return;
    }
    if (!running || pauseDepth > 0 || !isTty || streaming) return;
    const text = label();
    const width = process.stderr.columns || 80;
    const plainLen = visibleWidth(text);
    const pad = Math.max(0, Math.min(width, plainLen + 4) - plainLen);
    const line = clipAnsi(text + " ".repeat(pad), width);
    process.stderr.write("\r" + line);
  };

  const tickNewline = () => {
    if (!running || pauseDepth > 0) return;
    const now = Date.now();
    if (now - lastTickAt < TICK_MS) return;
    lastTickAt = now;
    if (dockInPrompt) {
      // Reminder that controls stay open during long streams
      process.stderr.write(
        "\n" +
          chalk.dim("  ⚒ still working · controls open at ") +
          chalk.cyan("live ›") +
          chalk.dim("  (e.g. /cycle 0)\n"),
      );
      return;
    }
    process.stderr.write("\n" + chalk.dim(label()) + "\n");
  };

  const clearLine = () => {
    if (dockInPrompt || !isTty) return;
    const width = process.stderr.columns || 80;
    process.stderr.write("\r" + " ".repeat(width) + "\r");
  };

  return {
    start() {
      running = true;
      pauseDepth = 0;
      streaming = false;
      frame = 0;
      lastTickAt = Date.now();
      if (!isTty && !dockInPrompt) {
        process.stderr.write(chalk.dim("  ⚒ working…\n"));
        return;
      }
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        frame += 1;
        if (streaming) tickNewline();
        else paint();
      }, dockInPrompt ? 200 : 80);
      timer.unref?.();
      paint();
    },
    setPhase(p, d) {
      phase = p;
      detail = d;
      if (running && pauseDepth === 0 && !streaming) paint();
    },
    setStreaming(on) {
      if (streaming === on) return;
      if (on) {
        clearLine();
        streaming = true;
        lastTickAt = Date.now();
      } else {
        streaming = false;
        if (running && pauseDepth === 0) paint();
      }
    },
    pause() {
      if (!running) return;
      pauseDepth += 1;
      if (pauseDepth === 1) clearLine();
    },
    resume() {
      if (!running) return;
      if (pauseDepth > 0) pauseDepth -= 1;
      if (pauseDepth === 0 && !streaming) paint();
    },
    stop() {
      running = false;
      streaming = false;
      pauseDepth = 0;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      clearLine();
    },
    repaint() {
      if (running && pauseDepth === 0 && !streaming) paint();
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
  const effort = resolveReasoningEffort(config.model, config.reasoningEffort);
  const lines = [
    chalk.dim("─".repeat(Math.min(48, process.stdout.columns || 48))),
    chalk.dim(`session  ${session.meta.id.slice(0, 8)}`) +
      (session.meta.title ? chalk.dim(` · ${session.meta.title.slice(0, 40)}`) : "") +
      (session.meta.pinned ? chalk.cyan(" · PIN") : ""),
    chalk.dim(`path     ${sessionDir(session.meta.id)}`),
    chalk.dim(`auth     ${describeAuth(auth)}`),
    chalk.dim(
      `model    ${config.provider}/${config.model}` +
        (effort ? ` · effort ${effort}` : ""),
    ),
    chalk.dim(
      `perms    ${config.permissionMode}` +
        (config.permissionMode === "plan"
          ? " (read-only · /build to implement)"
          : "") +
        `  ·  Stop ${config.blockingStopHooks ? "blocking" : "passive"}`,
    ),
    session.meta.lastError
      ? chalk.yellow(
          `lastErr  [${session.meta.lastError.code}] ${session.meta.lastError.message.slice(0, 120)}` +
            (session.meta.lastError.tips?.[0]
              ? `\n         → ${session.meta.lastError.tips[0]}`
              : ""),
        )
      : null,
    chalk.dim(
      `msgs     ${session.messages.length}  ·  ~${formatTokens(est)} ctx  ·  turns ${session.meta.turnCount}  edits ${session.meta.editCount}`,
    ),
    chalk.dim(
      `keep     ${session.meta.pinned ? "pinned (prune-safe) · /unpin" : "not pinned · /pin to protect from prune"}`,
    ),
  ];
  {
    const lock = readSessionLock(session.meta.id);
    lines.push(
      chalk.dim(
        `lock     ${lock ? formatLockHolder(lock) : "(none)"}`,
      ),
    );
  }
  if (ulw?.enabled) {
    lines.push(
      chalk.dim(
        `ulw      ${formatUlwBadge(ulw)}  blocks=${ulw.blocks}  ${ulw.mandate.slice(0, 50)}`,
      ),
    );
    lines.push(chalk.dim(`         ${ULW_LIVE_CONTROLS_HINT}`));
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
  return lines.filter((l): l is string => typeof l === "string" && l.length > 0).join("\n");
}
