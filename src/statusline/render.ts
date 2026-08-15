import chalk from "chalk";
import type { StatusSnapshot, StatuslineRenderOptions, PlanUsageInfo } from "./types.js";
import { formatTokens, formatCost, clipAnsi } from "../util/format.js";
import { getForgeVersion } from "../util/version.js";
import { forgeHome } from "../util/fs.js";
import { isFormatOnWriteEnabled } from "../agent/tools/format-on-write.js";
import { detectProjectIntel, hasNodeModules, multipleLockfiles } from "../util/project-intel.js";
import { formatHudTodos } from "../agent/todos.js";
import { formatCacheRatio } from "../session/prompt-cache.js";

function colorEnabled(opts: StatuslineRenderOptions): boolean {
  if (opts.plain || opts.color === false) return false;
  if (process.env.NO_COLOR != null) return false;
  return Boolean(opts.color ?? process.stdout.isTTY);
}

function paint(
  enabled: boolean,
  text: string,
  style: "dim" | "cyan" | "green" | "yellow" | "red" | "magenta" | "blue" | "bold",
): string {
  if (!enabled) return text;
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
}

function shortModel(model: string): string {
  // anthropic/claude-sonnet-4 → sonnet-4 ; grok-4 → grok-4
  const base = model.includes("/") ? model.split("/").pop()! : model;
  return base.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function contextBar(pct: number, width = 12): string {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, width - filled));
}

function barColor(
  enabled: boolean,
  pct: number,
  bar: string,
): string {
  if (!enabled) return bar;
  if (pct >= 90) return chalk.red(bar);
  if (pct >= 70) return chalk.yellow(bar);
  return chalk.green(bar);
}

function liveGlyph(liveness: StatusSnapshot["liveness"], enabled: boolean): string {
  const map = {
    live: { g: "●", s: "green" as const },
    working: { g: "◉", s: "magenta" as const },
    idle: { g: "○", s: "yellow" as const },
    stale: { g: "◌", s: "dim" as const },
    unknown: { g: "·", s: "dim" as const },
  };
  const m = map[liveness] || map.unknown;
  return paint(enabled, m.g, m.s) + paint(enabled, ` ${liveness}`, "dim");
}

function formatActivity(snap: StatusSnapshot, enabled: boolean): string | null {
  const a = snap.activity;
  if (!a) return null;
  const parts: string[] = [];
  if (a.busy && a.phase && a.phase !== "idle") {
    const label =
      a.phase === "tool" && a.detail
        ? `tool:${shortLabel(a.detail, 24)}`
        : a.phase === "thinking"
          ? "thinking…"
          : a.phase === "compacting"
            ? "compacting…"
            : a.phase === "stop_guard"
              ? "harness…"
              : a.phase === "waiting"
                ? "bg wait…"
                : a.phase;
    parts.push(paint(enabled, label, "magenta"));
    if (a.turnElapsedSec != null && a.turnElapsedSec > 0) {
      parts.push(paint(enabled, formatDuration(a.turnElapsedSec), "dim"));
    }
  }
  if (a.bgRunning > 0) {
    const hint = a.bgHint ? shortLabel(a.bgHint, 28) : "";
    parts.push(
      paint(
        enabled,
        hint ? `bg:${a.bgRunning} ${hint}` : `bg:${a.bgRunning}`,
        "yellow",
      ),
    );
  }
  return parts.length ? parts.join("  ") : null;
}

function shortLabel(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function formatBgTasks(snap: StatusSnapshot, enabled: boolean): string | null {
  const tasks = snap.backgroundTasks;
  if (!tasks?.length) return null;
  const running = tasks.filter((t) => t.status === "running");
  const recent = tasks
    .filter((t) => t.status !== "running")
    .slice(-2)
    .reverse();
  const lines: string[] = [];
  for (const t of running) {
    lines.push(
      paint(enabled, "  ↻", "yellow") +
        paint(enabled, ` ${t.id.slice(0, 14)}  ${formatDuration(t.elapsedSec)}  `, "dim") +
        paint(enabled, t.command, "cyan"),
    );
  }
  for (const t of recent) {
    const mark =
      t.status === "completed"
        ? paint(enabled, "  ✓", "green")
        : t.status === "failed"
          ? paint(enabled, "  ✗", "red")
          : paint(enabled, "  ·", "dim");
    lines.push(
      mark +
        paint(
          enabled,
          ` ${t.id.slice(0, 14)}  ${t.status}  ${t.command}`,
          "dim",
        ),
    );
  }
  return lines.length ? lines.join("\n") : null;
}

/**
 * Plan / quota segment for HUD + bottom dock.
 * Prefer percent + reset countdown (SuperGrok weekly); never show bare
 * "week" with no numbers (that was the broken-parse failure mode).
 */
export function formatPlan(
  plan: PlanUsageInfo | undefined,
  enabled: boolean,
): string | null {
  if (!plan) return null;
  // Skip pure "N/A" notes for API keys — keep HUD dense
  if (
    plan.note &&
    plan.percent == null &&
    plan.remaining == null &&
    plan.used == null &&
    !plan.resetsAt &&
    /API key|N\/A|not applicable|session tokens only|no plan adapter|billing HTTP|billing unavailable/i.test(
      plan.note,
    )
  ) {
    return null;
  }

  const parts: string[] = [];
  if (plan.percent != null) {
    const p = `use:${plan.percent}%`;
    parts.push(
      plan.percent >= 90
        ? paint(enabled, p, "red")
        : plan.percent >= 70
          ? paint(enabled, p, "yellow")
          : paint(enabled, p, "cyan"),
    );
  }
  if (plan.used != null && plan.limit != null) {
    parts.push(
      paint(
        enabled,
        `${formatCompact(plan.used)}/${formatCompact(plan.limit)}`,
        "dim",
      ),
    );
  } else if (plan.remaining != null) {
    const unit = plan.unit === "credits" ? "" : plan.unit ? ` ${plan.unit}` : "";
    parts.push(
      paint(enabled, `${formatCompact(plan.remaining)}${unit} left`, "dim"),
    );
  }
  if (plan.resetsAt) {
    const left = resetCountdown(plan.resetsAt);
    if (left) parts.push(paint(enabled, left, "dim"));
  } else if (plan.periodLabel && parts.length) {
    // Only attach period label when we already have a usage signal
    parts.push(paint(enabled, plan.periodLabel, "dim"));
  }
  if (!parts.length && plan.note) {
    return paint(enabled, plan.note.slice(0, 48), "dim");
  }
  if (!parts.length) return null;
  return parts.join("  ");
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n * 10) / 10);
}

/** Public for bottom dock + tests. */
export function resetCountdown(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const sec = Math.floor((t - Date.now()) / 1000);
  if (sec <= 0) return "reset soon";
  if (sec < 3600) return `reset ${Math.ceil(sec / 60)}m`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 && h < 12 ? `reset ${h}h${m}m` : `reset ${Math.max(1, Math.ceil(sec / 3600))}h`;
  }
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  // Prefer "3d2h" under 7d so weekly SuperGrok resets read clearly
  if (h > 0 && d < 7) return `reset ${d}d${h}h`;
  return `reset ${Math.max(1, d)}d`;
}

function renderSession(
  snap: StatusSnapshot,
  opts: StatuslineRenderOptions,
): string {
  const c = colorEnabled(opts);
  const width = opts.width ?? process.stdout.columns ?? 100;

  // Line 1: project · git · provider/model · auth · flags · live
  const l1: string[] = [];
  l1.push(paint(c, snap.projectLabel, "bold"));
  if (snap.git) {
    const dirty = snap.git.dirty ? "*" : "";
    const wt = snap.git.isWorktree ? "+wt" : "";
    l1.push(paint(c, `git:${snap.git.branch}${dirty}${wt}`, "cyan"));
  }
  l1.push(
    paint(c, `${snap.provider}/${shortModel(snap.model)}`, "blue"),
  );
  if (snap.authMethod && snap.authMethod !== "unknown") {
    const auth =
      snap.authMethod === "subscription"
        ? "sub"
        : snap.authMethod === "api_key"
          ? "key"
          : snap.authMethod;
    const multi =
      snap.accountCount && snap.accountCount > 1
        ? `×${snap.accountCount}`
        : "";
    const label = snap.authLabel
      ? shortLabel(snap.authLabel.replace(/^(grok:|copilot:|env:)/, ""), 18)
      : "";
    l1.push(
      paint(
        c,
        label ? `${auth}:${label}${multi}` : `${auth}${multi}`,
        "dim",
      ),
    );
  }
  if (snap.tags.length) {
    const tagStr = snap.tags.join(" ");
    // Foreign locks are yellow/red; other tags stay magenta
    const lockish = snap.tags.some((t) => t.startsWith("LOCK:"));
    l1.push(paint(c, tagStr, lockish ? "yellow" : "magenta"));
  }
  if (snap.lock && !snap.lock.mine && snap.lock.alive) {
    l1.push(paint(c, `lock:pid${snap.lock.pid}`, "yellow"));
  }
  const goal = snap.goal;
  if (goal?.active) {
    l1.push(paint(c, "GOAL", "yellow"));
  }
  if (snap.lastError?.message) {
    l1.push(
      paint(
        c,
        `ERR:${snap.lastError.code} ${snap.lastError.message.slice(0, 40)}`,
        "yellow",
      ),
    );
  }
  l1.push(liveGlyph(snap.liveness, c));

  // Line 2: context bar · duration · tokens · plan · todos
  const l2: string[] = [];
  const bar = contextBar(snap.context.percent);
  l2.push(
    barColor(c, snap.context.percent, bar) +
      paint(
        c,
        ` ${snap.context.percent}% (${formatTokens(snap.context.usedTokens)}/${formatTokens(snap.context.windowTokens)})`,
        "dim",
      ),
  );
  l2.push(paint(c, formatDuration(snap.durationSec), "dim"));
  if (snap.tokens.totalTokens > 0) {
    let tok = `tok:${formatTokens(snap.tokens.totalTokens)}`;
    if (snap.tokens.estimatedUsd != null && snap.tokens.estimatedUsd > 0) {
      tok += ` ~${formatCost(snap.tokens.estimatedUsd)}`;
    }
    l2.push(paint(c, tok, "dim"));
    if (
      snap.tokens.cacheRatio != null &&
      (snap.tokens.cacheRatioPromptTokens || snap.tokens.promptTokens || 0) >=
        8_000
    ) {
      l2.push(
        paint(c, `cache ${formatCacheRatio(snap.tokens.cacheRatio)}`, "dim"),
      );
    }
  }
  if (snap.budget) {
    const b = snap.budget;
    const label = `budget ${b.percent}% $${b.spentUsd.toFixed(b.spentUsd < 0.01 ? 4 : 3)}/$${b.capUsd.toFixed(b.capUsd < 0.01 ? 4 : 3)}`;
    l2.push(
      paint(
        c,
        b.hit ? `budget HIT` : label,
        b.hit ? "red" : b.percent >= 80 ? "yellow" : "dim",
      ),
    );
  }
  const planStr = formatPlan(snap.plan, c);
  if (planStr) l2.push(planStr);
  {
    const todos = formatHudTodos(snap.openTodos, snap.activeTodo);
    if (todos) l2.push(paint(c, todos, "yellow"));
  }
  if (snap.turnCount > 0) {
    l2.push(paint(c, `t:${snap.turnCount}`, "dim"));
  }
  if (snap.editCount > 0) {
    l2.push(paint(c, `edits:${snap.editCount}`, "dim"));
  }

  // Line 3 (optional): live activity + background
  const act = formatActivity(snap, c);
  const bgBlock = formatBgTasks(snap, c);

  let line1 = l1.join("  ");
  let line2 = l2.join("  ");

  // Width-fit: shed low-priority tails
  if (width > 20) {
    line1 = shed(line1, width);
    line2 = shed(line2, width);
  }

  if (opts.singleLine || opts.tmux) {
    const bits = [line1, line2];
    if (act) bits.push(act);
    return bits.join(" │ ");
  }
  const lines = [line1, line2];
  if (act) lines.push(shed(act, width > 20 ? width : 100));
  if (bgBlock && !opts.singleLine) lines.push(bgBlock);
  return lines.join("\n");
}

function shed(line: string, width: number): string {
  // Strip ANSI for length check
  // eslint-disable-next-line no-control-regex
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length <= width) return line;
  // Truncate plain and give up on perfect ANSI — prefer shorter content
  const parts = line.split("  ");
  while (parts.length > 2) {
    parts.pop();
    const next = parts.join("  ");
    // eslint-disable-next-line no-control-regex
    if (next.replace(/\x1b\[[0-9;]*m/g, "").length <= width) return next;
  }
  // 2 segments left and still too wide: hard-clip without cutting inside an
  // ANSI escape (a naive slice bleeds SGR state and garbles the terminal).
  return clipAnsi(parts.join("  "), width);
}

export function renderHud(
  snaps: StatusSnapshot[],
  opts: StatuslineRenderOptions = {},
): string {
  const c = colorEnabled(opts);
  if (!snaps.length) {
    return paint(c, "forge-status · no sessions yet — run: forge", "dim");
  }
  return snaps.map((s) => renderSession(s, opts)).join("\n");
}

export function renderTmux(snap: StatusSnapshot | undefined): string {
  if (!snap) return "forge:idle";
  const pct = snap.context.percent;
  const live =
    snap.liveness === "working"
      ? "◉"
      : snap.liveness === "live"
        ? "●"
        : "○";
  const parts = [
    `forge`,
    shortModel(snap.model),
    snap.projectLabel,
    snap.git
      ? `${snap.git.branch}${snap.git.dirty ? "*" : ""}${snap.git.isWorktree ? "+wt" : ""}`
      : "",
    `ctx:${pct}%`,
    live,
  ].filter(Boolean);
  if (snap.activity?.busy) {
    parts.push(snap.activity.phase || "work");
  }
  if ((snap.activity?.bgRunning ?? 0) > 0) {
    parts.push(`bg:${snap.activity!.bgRunning}`);
  }
  if (snap.tags.includes("ULW") || snap.ultrawork) {
    const c =
      typeof snap.ulwCycle === "number" ? `ULW c=${snap.ulwCycle}` : "ULW";
    parts.push(c);
  }
  if (snap.tags.includes("PIN") || snap.pinned) parts.push("PIN");
  if (snap.lastError?.code || snap.tags.some((t) => t.startsWith("ERR:"))) {
    parts.push(`ERR:${snap.lastError?.code || "error"}`);
  }
  if (snap.goal?.active) parts.push("GOAL");
  if (snap.plan?.percent != null) parts.push(`use:${snap.plan.percent}%`);
  else if (snap.plan?.remaining != null) {
    parts.push(`${formatCompact(snap.plan.remaining)}left`);
  }
  if (snap.plan?.resetsAt) {
    const left = resetCountdown(snap.plan.resetsAt);
    if (left) parts.push(left.replace(/^reset /, "rst:"));
  }
  return parts.join(" ");
}

/**
 * Compact single-line strip for REPL prompt / post-turn footer.
 * Prefer dense signal over pretty bars when width is tight.
 */
export function renderCompactStrip(
  snap: StatusSnapshot,
  opts: StatuslineRenderOptions & { showActivity?: boolean } = {},
): string {
  const c = colorEnabled(opts);
  const width = opts.width ?? process.stdout.columns ?? 100;
  const parts: string[] = [];

  parts.push(
    barColor(c, snap.context.percent, contextBar(snap.context.percent, 8)) +
      paint(c, ` ${snap.context.percent}%`, "dim"),
  );
  if (snap.tokens.totalTokens > 0) {
    let tok = formatTokens(snap.tokens.totalTokens);
    if (snap.tokens.estimatedUsd != null && snap.tokens.estimatedUsd > 0) {
      tok += ` ~${formatCost(snap.tokens.estimatedUsd)}`;
    }
    parts.push(paint(c, tok, "dim"));
    if (
      snap.tokens.cacheRatio != null &&
      (snap.tokens.cacheRatioPromptTokens || snap.tokens.promptTokens || 0) >=
        8_000
    ) {
      parts.push(
        paint(c, `cache ${formatCacheRatio(snap.tokens.cacheRatio)}`, "dim"),
      );
    }
  }
  if (snap.budget) {
    const b = snap.budget;
    parts.push(
      paint(
        c,
        b.hit ? "budget:HIT" : `budget:${b.percent}%`,
        b.hit ? "red" : b.percent >= 80 ? "yellow" : "dim",
      ),
    );
  }
  {
    const planStr = formatPlan(snap.plan, c);
    if (planStr) parts.push(planStr);
  }
  {
    const todos = formatHudTodos(snap.openTodos, snap.activeTodo);
    if (todos) parts.push(paint(c, todos, "yellow"));
  }
  if ((snap.activity?.bgRunning ?? 0) > 0) {
    parts.push(paint(c, `bg:${snap.activity!.bgRunning}`, "yellow"));
  }
  if (opts.showActivity !== false) {
    const act = formatActivity(snap, c);
    if (act) parts.push(act);
  }
  if (snap.goal?.active) parts.push(paint(c, "GOAL", "yellow"));
  if (snap.tags.includes("ULW") || snap.ultrawork) {
    const label =
      typeof snap.ulwCycle === "number" ? `ULW c=${snap.ulwCycle}` : "ULW";
    parts.push(paint(c, label, "magenta"));
  }
  if (snap.tags.includes("PIN") || snap.pinned) parts.push(paint(c, "PIN", "cyan"));
  if (snap.lastError?.code || snap.tags.some((t) => t.startsWith("ERR:"))) {
    parts.push(
      paint(c, `ERR:${snap.lastError?.code || "error"}`, "yellow"),
    );
  }
  if (snap.lock && !snap.lock.mine && snap.lock.alive) {
    parts.push(paint(c, `LOCK:${snap.lock.pid}`, "yellow"));
  }

  parts.push(liveGlyph(snap.liveness, c));

  return shed(parts.join("  "), width);
}

export function snapshotsToJson(snaps: StatusSnapshot[]): string {
  // Workspace project stack at the envelope level so empty session lists still
  // expose packageManager/checkCommands for CI dashboards (smoke/doctor parity).
  let packageManager: string | null = null;
  let checkCommands: string[] = [];
  let projectStackSummary: string | null = null;
  let monorepoRoot: string | null = null;
  let workspaces: string[] = [];
  let nodeModulesPresent: boolean | null = null;
  let multipleLockfilesList: string[] = [];
  try {
    // Prefer first session cwd, else process cwd.
    const cwd = snaps[0]?.cwd || process.cwd();
    const intel = detectProjectIntel(cwd);
    packageManager = intel.packageManager ?? null;
    checkCommands = [...intel.checkCommands];
    projectStackSummary = intel.summary || null;
    monorepoRoot = intel.monorepoRoot ?? null;
    workspaces = [...(intel.workspaces || [])];
    nodeModulesPresent = hasNodeModules(cwd);
    multipleLockfilesList = multipleLockfiles(cwd);
  } catch {
    /* optional */
  }
  const body = {
    ok: true,
    version: getForgeVersion(),
    node: process.version,
    forgeHome: forgeHome(),
    count: snaps.length,
    /** Effective format-on-write (env FORGE_FORMAT_ON_WRITE wins over preference). */
    formatOnWrite: isFormatOnWriteEnabled(),
    packageManager,
    checkCommands,
    projectStackSummary,
    monorepoRoot,
    workspaces,
    nodeModulesPresent,
    multipleLockfiles: multipleLockfilesList,
    // Prefer first session's last verification; null when none / empty list.
    lastVerificationCommand: snaps[0]?.lastVerificationCommand ?? null,
    lastVerificationAt: snaps[0]?.lastVerificationAt ?? null,
    lastEditAt: snaps[0]?.lastEditAt ?? null,
    lastVerificationStale: snaps[0]?.lastVerificationStale ?? null,
    sessions: snaps,
    generatedAt: new Date().toISOString(),
  };
  const compact =
    process.env.FORGE_JSON_COMPACT === "1" ||
    process.env.FORGE_JSON_COMPACT === "true";
  return compact ? JSON.stringify(body) : JSON.stringify(body, null, 2);
}
