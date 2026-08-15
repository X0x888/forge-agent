/**
 * Sticky bottom status region for the Forge REPL.
 *
 * Reserves the last terminal row via DECSTBM scroll margins so scrolling
 * transcript never overwrites the dock. Paints model + plan quota + weekly
 * reset + context without fighting the prompt editor (save/restore cursor).
 *
 * Disable: FORGE_BOTTOM_STATUS=0 | false | off
 */
import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import type { SessionData } from "../session/session.js";
import type { ResolvedAuth } from "../auth/types.js";
import { listAccounts } from "../auth/store.js";
import { sessionToSnapshot, outboundTokenEstimate } from "../statusline/snapshot.js";
import { collectPlanUsage } from "../statusline/plan.js";
import {
  formatPlan,
  resetCountdown,
} from "../statusline/render.js";
import type { AuthMethod, PlanUsageInfo } from "../statusline/types.js";
import { formatTokens, formatCost, clipAnsi, visibleWidth } from "../util/format.js";
import { formatCacheRatio } from "../session/prompt-cache.js";

import { resolveReasoningEffort } from "../config/reasoning.js";
import { getActivity } from "../statusline/activity.js";
import { listTasks } from "../agent/tools/background-tasks.js";
import { loadUlwCycle, formatUlwBadge } from "../harness/ulw-cycle.js";
import { loadGoal } from "../harness/goal.js";
import { normalizePermissionMode } from "../util/mode-aliases.js";
import { formatHudTodos } from "../agent/todos.js";

export interface BottomStatusContext {
  config: ForgeConfig;
  session: SessionData;
  auth: ResolvedAuth;
}

function envDisabled(): boolean {
  const v = (process.env.FORGE_BOTTOM_STATUS || "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

/** True when the sticky dock will paint (TTY + not opted out). */
export function isBottomStatusEnabled(): boolean {
  return (
    Boolean(process.stdout.isTTY) &&
    !envDisabled() &&
    process.env.NO_BOTTOM_STATUS !== "1"
  );
}

function shortModel(model: string): string {
  const base = model.includes("/") ? model.split("/").pop()! : model;
  return base.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/** Compact dock hop after a mid-run 429/5xx fallback (`fb: 4.6→4.5`). */
export function formatDockFallbackHop(
  hop: { from: string; to: string } | undefined,
): string | undefined {
  if (!hop?.from || !hop.to || hop.from === hop.to) return undefined;
  return `fb:${shortModel(hop.from)}→${shortModel(hop.to)}`;
}

function authMethodOf(auth: ResolvedAuth): AuthMethod {
  return (auth.method as AuthMethod) || "unknown";
}

/**
 * Build the single-line bottom dock body (ANSI). Width-clipped by caller.
 */
export function renderBottomStatusLine(
  ctx: BottomStatusContext,
  plan?: PlanUsageInfo,
  opts: { width?: number; plain?: boolean } = {},
): string {
  const { config, session, auth } = ctx;
  const width = opts.width ?? process.stdout.columns ?? 100;
  const c = !opts.plain && process.stdout.isTTY && process.env.NO_COLOR == null;

  let accountCount: number | undefined;
  try {
    accountCount = listAccounts(String(auth.provider)).length;
  } catch {
    /* optional */
  }

  const snap = sessionToSnapshot(session, {
    windowTokens: config.contextWindow,
    authMethod: authMethodOf(auth),
    authLabel: auth.accountLabel,
    accountId: auth.accountId,
    accountCount,
    permissionMode: config.permissionMode,
    maxCostUsd: config.maxCostUsd,
  });
  if (plan) snap.plan = plan;

  // Live ctx estimate while messages grow mid-run
  try {
    const used = outboundTokenEstimate(session.messages);
    const win = config.contextWindow || snap.context.windowTokens || 1;
    snap.context = {
      ...snap.context,
      usedTokens: used,
      windowTokens: win,
      percent: Math.min(100, Math.round((used / win) * 100)),
    };
  } catch {
    /* keep snapshot estimate */
  }

  const paint = (
    text: string,
    style: "dim" | "cyan" | "green" | "yellow" | "red" | "magenta" | "blue" | "bold",
  ): string => {
    if (!c) return text;
    switch (style) {
      case "dim":
        return chalk.dim(text);
      case "cyan":
        return chalk.cyan(text);
      case "green":
        return chalk.green(text);
      case "yellow":
        return chalk.yellow(text);
      case "red":
        return chalk.red(text);
      case "magenta":
        return chalk.magenta(text);
      case "blue":
        return chalk.blue(text);
      case "bold":
        return chalk.bold(text);
    }
  };

  // Higher prio survives narrow TTYs. Brand/auth/reset drop before
  // ctx / budget / ULW / GOAL / YOLO — right-clip used to eat those first.
  const bits: { text: string; prio: number }[] = [];
  bits.push({ text: paint("⚒ forge", "cyan"), prio: 0 });

  const effort = resolveReasoningEffort(config.model, config.reasoningEffort);
  bits.push({
    text: paint(
      `${config.provider}/${shortModel(config.model)}` +
        (effort ? ` ·${effort}` : ""),
      "blue",
    ),
    prio: 5,
  });

  const hop = formatDockFallbackHop(session.meta.lastModelFallback);
  if (hop) bits.push({ text: paint(hop, "yellow"), prio: 8 });

  if (snap.authMethod && snap.authMethod !== "unknown") {
    const authShort =
      snap.authMethod === "subscription"
        ? "sub"
        : snap.authMethod === "api_key"
          ? "key"
          : snap.authMethod;
    const multi =
      snap.accountCount && snap.accountCount > 1
        ? `×${snap.accountCount}`
        : "";
    bits.push({ text: paint(`${authShort}${multi}`, "dim"), prio: 1 });
  }

  const pct = snap.context.percent;
  const ctxBit = `ctx ${pct}% ${formatTokens(snap.context.usedTokens)}/${formatTokens(snap.context.windowTokens)}`;
  bits.push({
    text:
      pct >= 90
        ? paint(ctxBit, "red")
        : pct >= 70
          ? paint(ctxBit, "yellow")
          : paint(ctxBit, "dim"),
    prio: 8,
  });

  const planStr = formatPlan(snap.plan, c);
  if (planStr) {
    bits.push({ text: planStr, prio: 6 });
  } else if (snap.plan?.resetsAt) {
    const left = resetCountdown(snap.plan.resetsAt);
    if (left) bits.push({ text: paint(left, "dim"), prio: 2 });
  }

  const cachePrompt =
    snap.tokens.cacheRatioPromptTokens || snap.tokens.promptTokens || 0;
  if (snap.tokens.cacheRatio != null && cachePrompt >= 8_000) {
    const r = snap.tokens.cacheRatio;
    bits.push({
      text: paint(
        `cache ${formatCacheRatio(r)}`,
        r >= 0.95 ? "dim" : r >= 0.8 ? "dim" : "yellow",
      ),
      prio: 5,
    });
  }

  if (
    snap.tokens.subagentCount &&
    snap.tokens.subagentCount > 0 &&
    snap.tokens.subagentUsd != null
  ) {
    bits.push({
      text: paint(
        `sub ${snap.tokens.subagentCount} ${formatCost(snap.tokens.subagentUsd)}`,
        "dim",
      ),
      prio: 2,
    });
  }

  if (snap.budget) {
    const b = snap.budget;
    bits.push({
      text: paint(
        b.hit ? "budget:HIT" : `budget ${b.percent}%`,
        b.hit ? "red" : b.percent >= 80 ? "yellow" : "dim",
      ),
      prio: 9,
    });
  }

  const ulw = loadUlwCycle(session.meta.id);
  if (ulw?.enabled) {
    bits.push({
      text: paint(
        `ULW ${formatUlwBadge(ulw)}`,
        ulw.cycle === 1 ? "magenta" : "yellow",
      ),
      prio: 10,
    });
  } else if (session.meta.ultrawork) {
    bits.push({ text: paint("ULW", "magenta"), prio: 10 });
  }
  const g = loadGoal(session.meta.id);
  if (g?.objective && !g.paused && g.status === "active") {
    bits.push({ text: paint("GOAL", "yellow"), prio: 10 });
  }
  {
    const pm =
      normalizePermissionMode(config.permissionMode) ?? config.permissionMode;
    if (pm === "bypassPermissions") bits.push({ text: paint("YOLO", "red"), prio: 10 });
    else if (pm === "plan") bits.push({ text: paint("PLAN", "blue"), prio: 10 });
  }

  const act = getActivity();
  const bg = listTasks().filter((t) => t.status === "running").length;
  if (act.busy) {
    bits.push({
      text: paint(act.phase === "tool" ? "tool" : act.phase || "work", "magenta"),
      prio: 11,
    });
  }
  if (bg > 0) bits.push({ text: paint(`bg:${bg}`, "yellow"), prio: 11 });
  {
    const todos = formatHudTodos(snap.openTodos, snap.activeTodo);
    if (todos) bits.push({ text: paint(todos, "yellow"), prio: 9 });
  }

  const live = bits.filter((b) => b.text);
  const joinBits = (rows: { text: string }[]): string =>
    rows.map((b) => b.text).join("  ");
  let line = joinBits(live);
  while (live.length > 1 && width > 8 && visibleWidth(line) > width) {
    let drop = 0;
    for (let i = 1; i < live.length; i++) {
      if (live[i]!.prio < live[drop]!.prio) drop = i;
    }
    live.splice(drop, 1);
    line = joinBits(live);
  }
  if (width > 8 && visibleWidth(line) > width) {
    line = clipAnsi(line, width);
  }
  // Pad to full width so prior longer paint is cleared
  const pad = Math.max(0, width - visibleWidth(line));
  if (pad > 0 && pad < width) {
    line = line + " ".repeat(pad);
  }
  return line;
}

export interface BottomStatusDock {
  /** Install scroll region + first paint */
  start: () => void;
  /** Tear down scroll region and clear the dock line */
  stop: () => void;
  /**
   * Pause paints (refcount). Nested permission / ask_user prompts hold
   * stdin — the 2s timer must not save/restore the cursor over Allow?.
   */
  pause: () => void;
  /** Resume paints when pause depth hits 0 */
  resume: () => void;
  /** Recompute + paint from current ctx (sync; uses last known plan) */
  refresh: () => void;
  /** Fetch plan (network, cached) then paint — safe to call often */
  refreshPlan: () => Promise<void>;
  /** Inject a plan from outside (e.g. /status already fetched) */
  setPlan: (plan: PlanUsageInfo | undefined) => void;
  /** Last known plan (for idle strip / HUD reuse) */
  getPlan: () => PlanUsageInfo | undefined;
  /** True when dock owns the bottom row */
  active: () => boolean;
  /** Current pause depth (for tests) */
  pauseDepth: () => number;
}

export interface BottomStatusDockOpts {
  getContext: () => BottomStatusContext | null;
  /**
   * Plan refresh interval ms (default 45s — under the 60s plan cache TTL).
   * 0 = only fetch on start + explicit refreshPlan.
   */
  planIntervalMs?: number;
  /** Paint interval ms while running (default 2000) */
  paintIntervalMs?: number;
  /** Force the dock on (tests; skips TTY / FORGE_BOTTOM_STATUS checks). */
  forceEnabled?: boolean;
  /** Override stdout writes (tests). */
  write?: (s: string) => void;
}

/**
 * Create a sticky bottom status dock for a TTY REPL session.
 * No-op (safe) when stdout is not a TTY or FORGE_BOTTOM_STATUS=0.
 */
export function createBottomStatusDock(
  opts: BottomStatusDockOpts,
): BottomStatusDock {
  const enabled = Boolean(opts.forceEnabled) || isBottomStatusEnabled();
  const write = opts.write ?? ((s: string) => {
    process.stdout.write(s);
  });

  let running = false;
  let pauseDepth = 0;
  let plan: PlanUsageInfo | undefined;
  let planInFlight = false;
  let lastPaint = "";
  let rows = process.stdout.rows || 24;
  let paintTimer: ReturnType<typeof setInterval> | null = null;
  let planTimer: ReturnType<typeof setInterval> | null = null;
  let onResize: (() => void) | null = null;

  const planInterval = opts.planIntervalMs ?? 45_000;
  const paintInterval = opts.paintIntervalMs ?? 2_000;

  const applyScrollRegion = () => {
    if (!enabled || !running) return;
    rows = Math.max(4, process.stdout.rows || 24);
    // Leave last row for the dock; park cursor inside the scroll region so
    // the next console.log / prompt paint does not land on the dock line.
    if (rows >= 6) {
      write(`\x1b[1;${rows - 1}r\x1b[${rows - 1};1H`);
    }
  };

  const resetScrollRegion = () => {
    try {
      write("\x1b[r");
    } catch {
      /* ignore */
    }
  };

  const paintLine = (line: string) => {
    if (!enabled || !running || pauseDepth > 0) return;
    rows = Math.max(4, process.stdout.rows || 24);
    const cols = Math.max(20, process.stdout.columns || 80);
    // Save cursor, move to bottom row, clear+write, restore cursor.
    // DECSC/DECRC avoids fighting the prompt editor's relative moves.
    try {
      write(
        `\x1b7\x1b[${rows};1H\x1b[2K${line.slice(0, cols * 4)}\x1b8`,
      );
      lastPaint = line;
    } catch {
      /* ignore broken pipe */
    }
  };

  const doPaint = () => {
    if (!enabled || !running || pauseDepth > 0) return;
    const ctx = opts.getContext();
    if (!ctx) return;
    const cols = Math.max(20, process.stdout.columns || 80);
    const line = renderBottomStatusLine(ctx, plan, { width: cols });
    if (line !== lastPaint) paintLine(line);
    else {
      // Still repaint on resize (width change) even if content equal
      paintLine(line);
    }
  };

  const fetchPlan = async () => {
    if (!enabled || !running || planInFlight) return;
    const ctx = opts.getContext();
    if (!ctx) return;
    planInFlight = true;
    try {
      const next = await collectPlanUsage({
        provider: String(ctx.auth.provider || ctx.config.provider),
        authMethod: authMethodOf(ctx.auth),
        accountId: ctx.auth.accountId,
      });
      plan = next;
      doPaint();
    } catch {
      /* plan optional */
    } finally {
      planInFlight = false;
    }
  };

  return {
    start() {
      if (!enabled || running) return;
      running = true;
      applyScrollRegion();
      doPaint();
      void fetchPlan();

      if (paintInterval > 0) {
        paintTimer = setInterval(doPaint, paintInterval);
        paintTimer.unref?.();
      }
      if (planInterval > 0) {
        planTimer = setInterval(() => {
          void fetchPlan();
        }, planInterval);
        planTimer.unref?.();
      }

      onResize = () => {
        if (pauseDepth > 0) return;
        applyScrollRegion();
        lastPaint = "";
        doPaint();
      };
      process.stdout.on("resize", onResize);
    },

    stop() {
      if (!running) return;
      running = false;
      pauseDepth = 0;
      if (paintTimer) {
        clearInterval(paintTimer);
        paintTimer = null;
      }
      if (planTimer) {
        clearInterval(planTimer);
        planTimer = null;
      }
      if (onResize) {
        process.stdout.off("resize", onResize);
        onResize = null;
      }
      // Clear dock row then restore full scroll region
      try {
        rows = Math.max(4, process.stdout.rows || 24);
        write(`\x1b7\x1b[${rows};1H\x1b[2K\x1b8`);
      } catch {
        /* ignore */
      }
      resetScrollRegion();
      lastPaint = "";
    },

    pause() {
      if (!enabled || !running) return;
      pauseDepth += 1;
    },

    resume() {
      if (!enabled || !running) return;
      pauseDepth = Math.max(0, pauseDepth - 1);
      if (pauseDepth === 0) {
        // Resize during Allow? skipped applyScrollRegion — restore it now.
        applyScrollRegion();
        lastPaint = "";
        doPaint();
      }
    },

    refresh() {
      doPaint();
    },

    async refreshPlan() {
      await fetchPlan();
    },

    setPlan(p) {
      plan = p;
      doPaint();
    },

    getPlan: () => plan,
    active: () => running && enabled,
    pauseDepth: () => pauseDepth,
  };
}
