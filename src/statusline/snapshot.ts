import path from "node:path";
import {
  listSessions,
  loadSession,
  estimateTokens,
  type SessionData,
} from "../session/session.js";
import { loadGoal } from "../harness/goal.js";
import { loadUlwCycle } from "../harness/ulw-cycle.js";
import { loadConfig } from "../config/load.js";
import { resolveAuth } from "../auth/resolve.js";
import { getGitSnapshot } from "../util/git-context.js";
import { estimateCostUsd } from "../util/format.js";
import { computeLiveness } from "./active.js";
import { collectPlanUsage } from "./plan.js";
import type {
  StatusSnapshot,
  CollectOptions,
  AuthMethod,
  ContextInfo,
  TokenUsageInfo,
  GoalInfo,
} from "./types.js";

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
    total > 0 ? estimateCostUsd(provider, prompt, completion) : undefined;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    estimatedUsd,
    source: "session",
  };
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
    permissionMode?: string;
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
  if (ulw?.enabled) tags.push(ulw.cycle === 1 ? "c=1" : "c=0");
  if (opts.permissionMode === "plan") tags.push("PLAN");

  return {
    sessionId: meta.id,
    title: meta.title,
    cwd: meta.cwd,
    projectLabel: projectLabel(meta.cwd),
    provider: meta.provider,
    model: meta.model,
    authMethod: opts.authMethod || "unknown",
    authLabel: opts.authLabel,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    durationSec: durationSec(meta.createdAt),
    idleSec,
    liveness,
    turnCount: meta.turnCount,
    editCount: meta.editCount,
    openTodos,
    ultrawork: meta.ultrawork,
    permissionMode: opts.permissionMode,
    git: gitSnap.branch
      ? {
          branch: gitSnap.branch,
          dirty: Boolean(gitSnap.dirty),
          root: gitSnap.root,
        }
      : undefined,
    context: buildContext(session, opts.windowTokens || 128_000),
    tokens: buildTokens(session, meta.provider),
    goal: buildGoal(meta.id),
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

  let sessions: SessionData[] = [];

  if (opts.sessionId) {
    const s = loadSession(opts.sessionId);
    if (s) sessions = [s];
  } else {
    const metas = listSessions(opts.all ? 50 : 20);
    for (const m of metas) {
      if (opts.cwd) {
        const resolved = path.resolve(opts.cwd);
        if (path.resolve(m.cwd) !== resolved) continue;
      }
      const s = loadSession(m.id);
      if (s) sessions.push(s);
    }
    if (!opts.all && sessions.length > 1) {
      // Prefer live, else most recently updated
      sessions.sort((a, b) => {
        const la = computeLiveness(a.meta.id, a.meta.updatedAt).liveness;
        const lb = computeLiveness(b.meta.id, b.meta.updatedAt).liveness;
        const score = (l: string) => (l === "live" ? 0 : l === "idle" ? 1 : 2);
        const d = score(la) - score(lb);
        if (d !== 0) return d;
        return a.meta.updatedAt < b.meta.updatedAt ? 1 : -1;
      });
      sessions = sessions.slice(0, 1);
    }
  }

  const snaps: StatusSnapshot[] = [];
  for (const s of sessions) {
    const snap = sessionToSnapshot(s, {
      windowTokens: config.contextWindow,
      authMethod:
        auth && auth.provider === s.meta.provider ? authMethod : "unknown",
      authLabel:
        auth && auth.provider === s.meta.provider ? authLabel : undefined,
      permissionMode: config.permissionMode,
    });

    if (opts.fetchPlan !== false) {
      try {
        snap.plan = await collectPlanUsage({
          provider: s.meta.provider,
          authMethod: snap.authMethod,
        });
      } catch {
        /* plan optional */
      }
    }
    snaps.push(snap);
  }

  return snaps;
}
