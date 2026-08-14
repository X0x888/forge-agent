/**
 * In-REPL status surfaces — so users do not need a second `forge status --watch` pane.
 *
 * 1. Prompt flags (ULW / GOAL / YOLO / bg) on `forge ›`
 * 2. Working indicator during agent turns (phase + elapsed)
 * 3. Post-turn footer (context / tokens / bg / todos)
 *
 * Session health (model · ctx · plan) lives on the always-on bottom dock,
 * not a second idle strip above the prompt.
 */
import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import { resolveReasoningEffort } from "../config/reasoning.js";
import { formatFallbackChain } from "../config/model-fallback.js";
import type { SessionData } from "../session/session.js";
import { isLastVerificationStale } from "../session/session.js";
import type { ResolvedAuth } from "../auth/types.js";
import { describeAuth } from "../auth/resolve.js";
import { listAccounts } from "../auth/store.js";
import { loadGoal } from "../harness/goal.js";
import {
  loadUlwCycle,
  formatUlwBadge,
  ULW_LIVE_CONTROLS_HINT,
} from "../harness/ulw-cycle.js";
import { listActiveProjectMemory } from "../harness/project-memory.js";
import { listActiveSubagents } from "../agent/subagent.js";
import { peekInterjections } from "../harness/interjection.js";
import { sessionToSnapshot } from "../statusline/snapshot.js";
import { renderCompactStrip, renderHud } from "../statusline/render.js";
import {
  getActivity,
  activityElapsedSec,
  type AgentPhase,
  type SessionActivity,
} from "../statusline/activity.js";
import { listTasks } from "../agent/tools/background-tasks.js";
import { formatTokens, formatCost, estimateCostUsd, visibleWidth, clipAnsi } from "../util/format.js";
import { estimateTokens, sessionDir } from "../session/session.js";
import { readSessionLock, formatLockHolder } from "../session/lock.js";
import { getGitSnapshot } from "../util/git-context.js";
import { detectProjectIntel } from "../util/project-intel.js";
import type { AuthMethod, PlanUsageInfo } from "../statusline/types.js";
import { normalizePermissionMode } from "../util/mode-aliases.js";

export interface StatusBarContext {
  config: ForgeConfig;
  session: SessionData;
  auth: ResolvedAuth;
  /** Optional plan/quota from bottom dock or /status probe */
  plan?: PlanUsageInfo;
  /** REPL-local `/verbose` — diffs + full tool output (failures always show a tail) */
  verbose?: boolean;
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
  const snap = sessionToSnapshot(ctx.session, {
    windowTokens: ctx.config.contextWindow,
    authMethod: authMethodOf(ctx.auth),
    authLabel: ctx.auth.accountLabel,
    accountId: ctx.auth.accountId,
    accountCount,
    permissionMode: ctx.config.permissionMode,
    maxCostUsd: ctx.config.maxCostUsd,
  });
  if (ctx.plan) snap.plan = ctx.plan;
  return snap;
}

/** Flags shown before `forge ›` — ULW, GOAL, PLAN, YOLO, VERBOSE, bg, working. */
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
  // Linked worktree — experts running parallel agent sessions need this signal
  // on every prompt, not only the turn footer / status details.
  try {
    const git = getGitSnapshot(
      config.workspace || session.meta.cwd || process.cwd(),
    );
    if (git.isWorktree) flags.push(chalk.cyan("WT"));
  } catch {
    /* */
  }
  if (session.meta.lastVerificationCommand?.trim()) {
    flags.push(
      isLastVerificationStale(session.meta)
        ? chalk.yellow("✓~")
        : chalk.green("✓"),
    );
  }
  {
    const permissionMode =
      normalizePermissionMode(config.permissionMode) ?? config.permissionMode;
    if (permissionMode === "plan") flags.push(chalk.blue("PLAN"));
    if (permissionMode === "bypassPermissions") {
      flags.push(chalk.red("YOLO"));
    } else if (permissionMode === "acceptEdits") {
      flags.push(chalk.green("auto"));
    }
  }

  const act = getActivity();
  const bgRunning =
    act.bgRunning || listTasks().filter((t) => t.status === "running").length;
  if (bgRunning > 0) {
    flags.push(chalk.yellow(`bg:${bgRunning}`));
  }
  if (ctx.verbose) {
    flags.push(chalk.cyan("VERBOSE"));
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
 * Compact health strip (model · ctx · plan). The idle REPL reprints this
 * only when the bottom dock is off (`FORGE_BOTTOM_STATUS=0` / non-TTY).
 */
export function renderIdleStatusLine(ctx: StatusBarContext): string {
  const snap = buildLiveSnapshot(ctx);
  const width = process.stdout.columns ?? 100;
  // Skip noise on brand-new empty sessions — still surface model + plan when known
  if (
    snap.turnCount === 0 &&
    snap.tokens.totalTokens === 0 &&
    !snap.activity?.busy &&
    !(snap.activity?.bgRunning) &&
    !snap.plan?.percent &&
    !snap.plan?.resetsAt
  ) {
    // Still show context window readiness + model briefly
    return chalk.dim(
      `  ${snap.provider}/${shortModel(snap.model)}  ctx 0/${formatTokens(snap.context.windowTokens)}  ${describeAuth(ctx.auth)}`,
    );
  }
  // Compact strip now includes plan when snap.plan is set (use% + reset)
  const modelBit = chalk.dim(`${snap.provider}/${shortModel(snap.model)}`);
  const strip = renderCompactStrip(snap, {
    width: Math.max(20, width - 2 - 24),
    showActivity: true,
  });
  return "  " + modelBit + "  " + strip;
}

function shortModel(model: string): string {
  const base = model.includes("/") ? model.split("/").pop()! : model;
  return base.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/**
 * Live token/context bits for the mid-run status dock. Reads the SAME session
 * object the agent loop mutates (usage lands after each response), so no new
 * event plumbing is needed — the 200ms prompt tick picks changes up.
 */
let liveCtxCache: { key: string; value: number } | null = null;

function liveCtxEstimate(session: SessionData): number {
  const msgs = session.messages;
  const last = msgs[msgs.length - 1];
  // Messages are append-whole during a run (assistant/tool results push
  // complete messages), so id + length + tail size is a safe memo key.
  const key = `${session.meta.id}:${msgs.length}:${last ? (last.content || "").length : 0}:${session.meta.totalCompletionTokens}`;
  if (liveCtxCache?.key === key) return liveCtxCache.value;
  const value = estimateTokens(msgs);
  liveCtxCache = { key, value };
  return value;
}

/** `⇣3.2k` cumulative completion tokens + `ctx 41k/500k` live context use. */
function liveTokenBits(ctx: StatusBarContext): string[] {
  const bits: string[] = [];
  const comp = ctx.session.meta.totalCompletionTokens || 0;
  if (comp > 0) bits.push(chalk.dim(`⇣${formatTokens(comp)}`));
  const win = ctx.config.contextWindow || 0;
  if (win > 0) {
    bits.push(
      chalk.dim(
        `ctx ${formatTokens(liveCtxEstimate(ctx.session))}/${formatTokens(win)}`,
      ),
    );
  }
  return bits;
}

/**
 * One-line chrome printed when an agent turn starts.
 * Identity + the two controls that matter mid-run — not a 6-line box.
 */
export function renderLiveRunHeader(ctx: StatusBarContext): string {
  const { config, session } = ctx;
  const effort = resolveReasoningEffort(config.model, config.reasoningEffort);
  const ulw = loadUlwCycle(session.meta.id);
  const g = loadGoal(session.meta.id);

  const identity = [
    `${config.provider}/${shortModel(config.model)}`,
    effort ? `effort ${effort}` : null,
    (() => {
      const pm =
        normalizePermissionMode(config.permissionMode) ?? config.permissionMode;
      return pm === "bypassPermissions"
        ? "YOLO"
        : pm === "acceptEdits"
          ? "auto"
          : pm === "plan"
            ? "PLAN"
            : null;
    })(),
  ]
    .filter(Boolean)
    .join(" · ");

  const harness: string[] = [];
  if (ulw?.enabled) {
    harness.push(
      chalk.magenta(
        `ULW ${formatUlwBadge(ulw)} ${ulw.cycle === 1 ? "CONTINUE" : "LAST"}`,
      ),
    );
  } else if (session.meta.ultrawork) {
    harness.push(chalk.magenta("ULW"));
  }
  if (g?.objective && !g.paused && g.status === "active") {
    harness.push(chalk.yellow("GOAL"));
  }

  const bits = [
    chalk.bold.cyan("live run"),
    chalk.dim(identity),
    ...harness,
    chalk.dim(
      `${chalk.white("/cycle 0")} last · ${chalk.white("/budget")} · type at ${chalk.cyan("live ›")}`,
    ),
  ];
  return bits.join(chalk.dim("  ·  "));
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
  bits.push(...liveTokenBits(ctx));
  if (ulw?.enabled) {
    bits.push(
      ulw.cycle === 1
        ? chalk.magenta(formatUlwBadge(ulw))
        : chalk.yellow(formatUlwBadge(ulw)),
    );
  }
  if (act.bgRunning > 0) bits.push(chalk.yellow(`bg:${act.bgRunning}`));
  if (ulw?.enabled && ulw.cycle === 1) {
    bits.push(chalk.dim("last=/cycle 0"));
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
  left.push(...liveTokenBits(ctx));
  if (ulw?.enabled) {
    left.push(
      ulw.cycle === 1
        ? chalk.magenta(formatUlwBadge(ulw))
        : chalk.yellow(formatUlwBadge(ulw)),
    );
  }
  if (effort) left.push(chalk.dim(effort));
  if (act.bgRunning > 0) left.push(chalk.yellow(`bg:${act.bgRunning}`));
  try {
    const q = peekInterjections(ctx.session.meta.id).length;
    if (q > 0) left.push(chalk.cyan(`q:${q}`));
  } catch {
    /* */
  }
  try {
    const subs = listActiveSubagents();
    if (subs.length) left.push(chalk.magenta(`sub:${subs.length}`));
  } catch {
    /* */
  }

  // Right side: explicit control affordance so it cannot be missed
  const hint =
    ulw?.enabled && ulw.cycle === 1
      ? chalk.dim(" last=/cycle 0")
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
  turn: { promptTokens: number; completionTokens: number; cacheReadTokens?: number; stopContinues?: number },
): string {
  const snap = buildLiveSnapshot(ctx);
  const width = process.stdout.columns ?? 100;
  const cost = estimateCostUsd(
    String(ctx.config.provider),
    turn.promptTokens,
    turn.completionTokens,
    ctx.config.model,
    turn.cacheReadTokens ?? 0,
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
  if (snap.budget) {
    const b = snap.budget;
    const label = `$${b.spentUsd.toFixed(b.spentUsd < 0.01 ? 4 : 3)}/$${b.capUsd.toFixed(b.capUsd < 0.01 ? 4 : 3)}`;
    parts.push(
      b.hit
        ? chalk.red(`budget HIT ${label}`)
        : b.percent >= 80
          ? chalk.yellow(`budget ${b.percent}% ${label}`)
          : chalk.dim(`budget ${b.percent}% ${label}`),
    );
  }
  if (snap.openTodos > 0) {
    parts.push(chalk.yellow(`todos:${snap.openTodos}`));
  }
  // After edits, surface last-verify (when recorded) or the cheapest preferred
  // project check early (before ULW badges) so narrow terminals still show it.
  try {
    const last = ctx.session.meta.lastVerificationCommand?.trim();
    if (last) {
      const short = last.length > 22 ? `${last.slice(0, 21)}…` : last;
      if (isLastVerificationStale(ctx.session.meta)) {
        parts.push(chalk.yellow(`last✓ ${short} stale`));
      } else {
        parts.push(chalk.green(`last✓ ${short}`));
      }
    } else if ((ctx.session.meta.editCount || 0) > 0) {
      const intel = detectProjectIntel(
        ctx.config.workspace || ctx.session.meta.cwd || process.cwd(),
      );
      if (intel.checkCommands[0]) {
        const c = intel.checkCommands[0];
        // Suggested next check — never a ✓. A checkmark here is read as
        // "already passed" when nothing has been verified this session.
        parts.push(
          chalk.dim(
            `next ${c.length > 22 ? `${c.slice(0, 21)}…` : c}`,
          ),
        );
      }
    }
  } catch {
    /* */
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
  /**
   * Prompt-docked streaming heartbeat. REPL reprints `live ›` below the
   * current token stream so mid-run controls stay reachable. Does not
   * fire while the \r spinner owns the line.
   */
  onStreamTick?: (frame: number, phase: AgentPhase, detail?: string) => void;
  /** Min ms between streaming heartbeats (default 10s). */
  streamTickMs?: number;
}

/**
 * After tokens/tools, restore the `live ›` dock on these phases.
 * `waiting` (retries, ULW auto-continue) must redock — otherwise the
 * advertised control line vanishes until the next think/tool.
 * Never redock while a tool hold is still open.
 */
export function shouldRedockLiveOnPhase(
  phase: AgentPhase,
  pendingTools = 0,
): boolean {
  if (pendingTools > 0) return false;
  return (
    phase === "thinking" ||
    phase === "compacting" ||
    phase === "stop_guard" ||
    phase === "waiting"
  );
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
  const TICK_MS = Math.max(200, opts.streamTickMs ?? 10_000);

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
      if (opts.onStreamTick) {
        opts.onStreamTick(frame, phase, detail);
        return;
      }
      // Fallback reminder when the REPL did not wire a redock hook
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
    (() => {
      try {
        const g = getGitSnapshot(
          config.workspace || session.meta.cwd || process.cwd(),
        );
        if (!g.root) return null;
        const dirty = g.dirty ? "*" : "";
        const wt = g.isWorktree ? chalk.cyan(" · WORKTREE") : "";
        return chalk.dim(
          `git      ${g.branch || "?"}${dirty}${wt}  ·  ${g.root}`,
        );
      } catch {
        return null;
      }
    })(),
    chalk.dim(`auth     ${describeAuth(auth)}`),
    chalk.dim(
      `model    ${config.provider}/${config.model}` +
        (effort ? ` · effort ${effort}` : ""),
    ),
    chalk.dim(`fallback ${formatFallbackChain(config)}`),
    ctx.session?.meta.lastModelFallback
      ? chalk.dim(
          `lastHop  ${ctx.session.meta.lastModelFallback.from} → ${ctx.session.meta.lastModelFallback.to}`,
        )
      : null,
    (() => {
      if (!ctx.plan) return null;
      const p = ctx.plan;
      const bits: string[] = [];
      if (p.percent != null) bits.push(`use ${p.percent}%`);
      if (p.used != null && p.limit != null) {
        bits.push(`${p.used}/${p.limit}${p.unit ? ` ${p.unit}` : ""}`);
      } else if (p.remaining != null) {
        bits.push(`${p.remaining}${p.unit ? ` ${p.unit}` : ""} left`);
      }
      if (p.resetsAt) {
        try {
          const t = Date.parse(p.resetsAt);
          if (!Number.isNaN(t)) {
            const sec = Math.floor((t - Date.now()) / 1000);
            if (sec <= 0) bits.push("reset soon");
            else if (sec < 3600) bits.push(`reset ${Math.ceil(sec / 60)}m`);
            else if (sec < 86400) bits.push(`reset ${Math.ceil(sec / 3600)}h`);
            else bits.push(`reset ${Math.ceil(sec / 86400)}d`);
          }
        } catch {
          /* */
        }
      } else if (p.periodLabel) bits.push(p.periodLabel);
      if (p.product) bits.push(p.product);
      if (!bits.length && p.note) return chalk.dim(`plan     ${p.note}`);
      if (!bits.length) return null;
      return chalk.dim(`plan     ${bits.join(" · ")}`);
    })(),
    chalk.dim(
      `perms    ${config.permissionMode}` +
        (config.permissionMode === "plan"
          ? " (read-only · exit_plan_mode or /build)"
          : "") +
        `  ·  Stop ${config.blockingStopHooks ? "blocking" : "passive"}`,
    ),
    (() => {
      try {
        const n = listActiveProjectMemory(
          config.workspace || session.meta.cwd || process.cwd(),
        ).length;
        if (!n) return null;
        return chalk.dim(
          `memory   ${n} project note${n === 1 ? "" : "s"}  · /memory project`,
        );
      } catch {
        return null;
      }
    })(),
    (() => {
      try {
        const subs = listActiveSubagents();
        if (!subs.length) return null;
        const labels = subs
          .slice(0, 4)
          .map((s) => `${s.type}:${s.description.slice(0, 28)}`)
          .join(" · ");
        return chalk.cyan(
          `subs     ${subs.length} active  ${labels}${subs.length > 4 ? " …" : ""}`,
        );
      } catch {
        return null;
      }
    })(),
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
    (() => {
      const last = session.meta.lastVerificationCommand?.trim();
      if (last) {
        const stale = isLastVerificationStale(session.meta)
          ? "  ⚠ stale"
          : "";
        return chalk.dim(
          `verify   ${last.length > 60 ? `${last.slice(0, 59)}…` : last}${stale}`,
        );
      }
      if ((session.meta.editCount || 0) > 0) {
        let tip = "npm test / typecheck";
        try {
          const intel = detectProjectIntel(
            config.workspace || session.meta.cwd || process.cwd(),
          );
          if (intel.checkCommands[0]) tip = intel.checkCommands[0];
        } catch {
          /* */
        }
        return chalk.yellow(
          `verify   (none after ${session.meta.editCount} edit(s) — prefer \`${tip}\`)`,
        );
      }
      return null;
    })(),
    (() => {
      const win = config.contextWindow || 1;
      const pct = Math.min(100, Math.round((est / win) * 100));
      const thr = Math.round((config.autoCompactThreshold || 0.8) * 100);
      if (pct >= 92) {
        return chalk.yellow(
          `ctx      ${pct}% HARD · autoCompact@${thr}%  ·  /compact · /new`,
        );
      }
      if (pct >= thr) {
        return chalk.yellow(
          `ctx      ${pct}% above threshold (${thr}%)  ·  /compact · /context`,
        );
      }
      if (pct >= Math.max(50, thr - 15)) {
        return chalk.dim(
          `ctx      ${pct}% elevated (autoCompact@${thr}%)  ·  /context`,
        );
      }
      return chalk.dim(`ctx      ${pct}% of ${formatTokens(win)}  ·  autoCompact@${thr}%`);
    })(),
    chalk.dim(
      `keep     ${session.meta.pinned ? "pinned (prune-safe) · /unpin" : "not pinned · /pin to protect from prune"}`,
    ),
    session.meta.servedModels?.length
      ? chalk.yellow(
          `served   ⚠ provider served ${session.meta.servedModels.join(", ")} for requested ${session.meta.model} — check billing/routing`,
        )
      : null,
  ].filter((x): x is string => x != null);
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
