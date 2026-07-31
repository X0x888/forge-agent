import path from "node:path";
import {
  listSessions,
  loadSession,
  sessionDir,
  estimateTokens,
  type SessionData,
} from "../session/session.js";
import { loadGoal } from "../harness/goal.js";
import { loadUlwCycle } from "../harness/ulw-cycle.js";
import { loadConfig } from "../config/load.js";
import { resolveAuth } from "../auth/resolve.js";
import { getGitSnapshot } from "../util/git-context.js";
import { estimateCostUsd } from "../util/format.js";
import { costCapStatus } from "../util/cost-budget.js";
import { computeLiveness, getActiveEntry } from "./active.js";
import { collectPlanUsage } from "./plan.js";
import {
  getActivity,
  activityElapsedSec,
  type SessionActivity,
} from "./activity.js";
import { listTasks } from "../agent/tools/background-tasks.js";
import { readSessionLock } from "../session/lock.js";
import type {
  StatusSnapshot,
  CollectOptions,
  AuthMethod,
  ContextInfo,
  TokenUsageInfo,
  BudgetInfo,
  GoalInfo,
  ActivityInfo,
  BackgroundTaskSummary,
} from "./types.js";

function summarizeCommand(cmd: string, max = 48): string {
  const one = cmd.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function collectBackgroundSummaries(): BackgroundTaskSummary[] {
  try {
    return listTasks().map((t) => ({
      id: t.id,
      status: t.status,
      command: summarizeCommand(t.command),
      elapsedSec: Math.max(
        0,
        Math.floor(((t.endedAt || Date.now()) - t.startedAt) / 1000),
      ),
      exitCode: t.exitCode,
    }));
  } catch {
    return [];
  }
}

function buildActivity(
  sessionId: string,
  bg: BackgroundTaskSummary[],
  localActivity?: SessionActivity,
): ActivityInfo | undefined {
  const running = bg.filter((t) => t.status === "running");
  const local = localActivity || getActivity();
  const active = getActiveEntry(sessionId);

  // Prefer in-process activity when this PID owns the session
  const sameProcess = active && active.pid === process.pid;
  if (sameProcess && (local.busy || local.bgRunning > 0 || running.length)) {
    return {
      busy: local.busy || running.length > 0,
      phase: local.busy ? local.phase : running.length ? "waiting" : "idle",
      detail: local.detail || (running[0] ? running[0].command : undefined),
      turnElapsedSec: local.busy ? activityElapsedSec(local) : undefined,
      bgRunning: Math.max(local.bgRunning, running.length),
      bgTotal: Math.max(local.bgTotal, bg.length),
      bgHint: local.bgHint || running[0]?.command,
    };
  }

  // Cross-process: use heartbeat fields from active registry
  if (active && (active.busy || (active.bgRunning ?? 0) > 0)) {
    return {
      busy: Boolean(active.busy) || (active.bgRunning ?? 0) > 0,
      phase: active.phase || (active.busy ? "thinking" : "idle"),
      detail: active.phaseDetail,
      bgRunning: active.bgRunning ?? 0,
      bgHint: active.phaseDetail,
    };
  }

  if (running.length) {
    return {
      busy: true,
      phase: "waiting",
      detail: running[0].command,
      bgRunning: running.length,
      bgTotal: bg.length,
      bgHint: running[0].command,
    };
  }

  return undefined;
}

function projectLabel(cwd: string, levels = 2): string {
  const parts = path.resolve(cwd).split(path.sep).filter(Boolean);
  if (parts.length <= levels) return parts.join("/") || cwd;
  return parts.slice(-levels).join("/");
}

function durationSec(createdAt: string): number {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function buildContext(session: SessionData, windowTokens: number): ContextInfo {
  const used = estimateTokens(session.messages);
  const win = windowTokens > 0 ? windowTokens : 128_000;
  return {
    usedTokens: used,
    windowTokens: win,
    percent: Math.min(100, Math.round((used / win) * 100)),
    source: "session_estimate",
  };
}

function buildTokens(session: SessionData, provider: string): TokenUsageInfo {
  const prompt = session.meta.totalPromptTokens || 0;
  const completion = session.meta.totalCompletionTokens || 0;
  const total = prompt + completion;
  const estimatedUsd =
    total > 0
      ? estimateCostUsd(provider, prompt, completion, session.meta.model)
      : undefined;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    estimatedUsd,
    source: "session",
  };
}

function buildBudget(
  session: SessionData,
  opts: {
    maxCostUsd?: number;
    provider?: string;
    model?: string;
  },
): BudgetInfo | undefined {
  try {
    const st = costCapStatus(
      {
        maxCostUsd:
          typeof opts.maxCostUsd === "number" && Number.isFinite(opts.maxCostUsd)
            ? opts.maxCostUsd
            : 0,
        provider: opts.provider || session.meta.provider || "xai",
        model: opts.model || session.meta.model,
      },
      session.meta,
    );
    if (st.cap == null) return undefined;
    return {
      capUsd: st.cap,
      spentUsd: st.spent,
      percent: Math.max(0, Math.round((st.ratio ?? 0) * 100)),
      remainingUsd: st.remaining ?? 0,
      hit: st.hit,
    };
  } catch {
    return undefined;
  }
}

function buildGoal(sessionId: string): GoalInfo | undefined {
  const g = loadGoal(sessionId);
  if (!g?.objective) return undefined;
  return {
    active: !g.paused && g.status === "active",
    status: g.status,
    objective: g.objective,
    blocks: g.blocks,
  };
}

export function sessionToSnapshot(
  session: SessionData,
  opts: {
    windowTokens?: number;
    authMethod?: AuthMethod;
    authLabel?: string;
    accountId?: string;
    accountCount?: number;
    permissionMode?: string;
    /** Config maxCostUsd (session.meta.maxCostUsd still wins when set). */
    maxCostUsd?: number;
  } = {},
): StatusSnapshot {
  const meta = session.meta;
  const gitSnap = getGitSnapshot(meta.cwd);
  const { liveness, idleSec } = computeLiveness(meta.id, meta.updatedAt);
  const openTodos = session.todos.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  ).length;
  const tags: string[] = [];
  if (meta.ultrawork) tags.push("ULW");
  const ulw = loadUlwCycle(meta.id);
  if (ulw?.enabled) {
    tags.push(ulw.cycle === 1 ? "c=1" : "c=0");
    if (ulw.maxWaves != null) tags.push(`mw=${ulw.maxWaves}`);
  }
  if (meta.pinned) tags.push("PIN");
  if (opts.permissionMode === "plan") tags.push("PLAN");
  if (opts.permissionMode === "bypassPermissions") tags.push("YOLO");
  else if (opts.permissionMode === "acceptEdits") tags.push("auto");
  if (meta.lastError?.message) tags.push(`ERR:${meta.lastError.code}`);
  if (gitSnap.isWorktree) tags.push("WORKTREE");
  // BUDGET tag when a spend cap is armed (session override or config).
  try {
    const st = costCapStatus(
      {
        maxCostUsd:
          typeof opts.maxCostUsd === "number" && Number.isFinite(opts.maxCostUsd)
            ? opts.maxCostUsd
            : 0,
        provider: meta.provider || "xai",
        model: meta.model,
      },
      meta,
    );
    if (st.cap != null) {
      tags.push(st.hit ? "BUDGET:HIT" : `BUDGET:${Math.round((st.ratio ?? 0) * 100)}%`);
    }
  } catch {
    /* */
  }

  const bg = collectBackgroundSummaries();
  const activity = buildActivity(meta.id, bg);

  // Prefer working when activity says so
  let live = liveness;
  if (activity?.busy && (live === "live" || live === "idle" || live === "unknown")) {
    live = "working";
  }

  let lock: StatusSnapshot["lock"];
  try {
    const info = readSessionLock(meta.id);
    if (info) {
      let alive = false;
      try {
        process.kill(info.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      const mine = info.pid === process.pid;
      lock = {
        pid: info.pid,
        hostname: info.hostname,
        acquiredAt: info.acquiredAt,
        mine,
        alive,
      };
      // Surface foreign live locks in tags for HUD / tmux
      if (!mine && alive) tags.push(`LOCK:${info.pid}`);
    }
  } catch {
    /* lock optional */
  }

  return {
    sessionId: meta.id,
    sessionPath: sessionDir(meta.id),
    title: meta.title,
    cwd: meta.cwd,
    projectLabel: projectLabel(meta.cwd),
    provider: meta.provider,
    model: meta.model,
    authMethod: opts.authMethod || "unknown",
    authLabel: opts.authLabel,
    accountId: opts.accountId,
    accountCount: opts.accountCount,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    durationSec: durationSec(meta.createdAt),
    idleSec,
    liveness: live,
    turnCount: meta.turnCount,
    editCount: meta.editCount,
    openTodos,
    ultrawork: meta.ultrawork,
    ...(() => {
      try {
        const u = loadUlwCycle(meta.id);
        if (!u?.enabled) return { ulwCycle: null, ulwWave: null };
        return { ulwCycle: u.cycle, ulwWave: u.wave };
      } catch {
        return { ulwCycle: null, ulwWave: null };
      }
    })(),
    pinned: Boolean(meta.pinned),
    permissionMode: opts.permissionMode,
    git: gitSnap.branch
      ? {
          branch: gitSnap.branch,
          dirty: Boolean(gitSnap.dirty),
          root: gitSnap.root,
          isWorktree: gitSnap.isWorktree || undefined,
        }
      : undefined,
    context: buildContext(session, opts.windowTokens || 128_000),
    tokens: buildTokens(session, meta.provider),
    budget: buildBudget(session, {
      maxCostUsd: opts.maxCostUsd,
      provider: meta.provider,
      model: meta.model,
    }),
    goal: buildGoal(meta.id),
    activity,
    backgroundTasks: bg.length ? bg : undefined,
    lock,
    lastError: meta.lastError?.message
      ? {
          at: meta.lastError.at,
          code: meta.lastError.code,
          message: meta.lastError.message,
          tips: meta.lastError.tips,
        }
      : undefined,
    tags,
    collectedAt: new Date().toISOString(),
  };
}

export async function collectSnapshots(
  opts: CollectOptions = {},
): Promise<StatusSnapshot[]> {
  const config = opts.config || loadConfig({}, opts.cwd || process.cwd());
  const auth = resolveAuth(config);
  const authMethod = (auth?.method as AuthMethod) || "unknown";
  const authLabel = auth?.accountLabel;
  const accountId = auth?.accountId;

  let sessions: SessionData[] = [];

  if (opts.sessionId) {
    const s = loadSession(opts.sessionId);
    if (s) {
      sessions = [s];
    }
    // Miss: leave sessions empty — CLI/JSON consumers see count:0 (not a silent
    // fallback to newest cwd session, which would mislead CI/scripts).
  } else {
    // Native cwd filter before limit so multi-project experts don't miss
    // same-cwd sessions buried under other workspaces' recent activity.
    const metas = listSessions({
      limit: opts.all ? 50 : 20,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    for (const m of metas) {
      const s = loadSession(m.id);
      if (s) sessions.push(s);
    }
    if (!opts.all && sessions.length > 1) {
      // Prefer live, else most recently updated
      sessions.sort((a, b) => {
        const la = computeLiveness(a.meta.id, a.meta.updatedAt).liveness;
        const lb = computeLiveness(b.meta.id, b.meta.updatedAt).liveness;
        const score = (l: string) =>
          l === "working" ? 0 : l === "live" ? 1 : l === "idle" ? 2 : 3;
        const d = score(la) - score(lb);
        if (d !== 0) return d;
        return a.meta.updatedAt < b.meta.updatedAt ? 1 : -1;
      });
      sessions = sessions.slice(0, 1);
    }
  }

  let accountCount: number | undefined;
  try {
    const { listAccounts } = await import("../auth/store.js");
    if (auth?.provider) {
      accountCount = listAccounts(String(auth.provider)).length;
    }
  } catch {
    /* optional */
  }

  const snaps: StatusSnapshot[] = [];
  for (const s of sessions) {
    const sameProvider = Boolean(auth && auth.provider === s.meta.provider);
    const snap = sessionToSnapshot(s, {
      windowTokens: config.contextWindow,
      authMethod: sameProvider ? authMethod : "unknown",
      authLabel: sameProvider ? authLabel : undefined,
      accountId: sameProvider ? accountId : undefined,
      accountCount: sameProvider ? accountCount : undefined,
      permissionMode: config.permissionMode,
      maxCostUsd: config.maxCostUsd,
    });
    snaps.push(snap);
  }

  // Plan probes are network calls (cached, short timeout) — run them in
  // parallel: serial awaits made `forge status` cost N × timeout when the
  // billing endpoint was down.
  if (opts.fetchPlan !== false) {
    await Promise.all(
      snaps.map(async (snap, i) => {
        const s = sessions[i]!;
        const sameProvider = Boolean(auth && auth.provider === s.meta.provider);
        try {
          snap.plan = await collectPlanUsage({
            provider: s.meta.provider,
            authMethod: snap.authMethod,
            accountId: sameProvider ? accountId : undefined,
          });
        } catch {
          /* plan optional */
        }
      }),
    );
  }

  return snaps;
}
