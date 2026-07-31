/**
 * /goal — Codex-style relentless driver.
 *
 * Arms a durable objective that the Stop harness re-anchors until:
 *   (a) the agent attests **Goal achieved.** after a completeness check, or
 *   (b) stuck-wall: N consecutive Stop blocks with no file edits.
 *
 * Unlike Grok Build (no blocking Stop), Forge actually enforces this.
 */
import path from "node:path";
import { forgeHome, readJsonFile, writeJsonFile, nowEpoch, nowIso } from "../util/fs.js";
import { clearSoftTodoGateOnWindDown } from "./todo-gate.js";

export type GoalStatus = "active" | "paused" | "achieved" | "cleared" | "stuck";

export interface GoalState {
  status: GoalStatus;
  objective: string;
  /** Numbered acceptance criteria declared at arm time */
  criteria: string[];
  setAt: string;
  setEpoch: number;
  paused: boolean;
  blocks: number;
  stuckBlocks: number;
  lastBlockEditCount: number;
  lastBlockEpoch: number;
  achievedAt?: string;
  armSource: "manual" | "auto";
  sessionId: string;
}

export interface GoalDecision {
  block: boolean;
  reason?: string;
  /** Injected into next turn */
  reanchor?: string;
  stuckReleased?: boolean;
}

const GOAL_ATTEST_RE =
  /\*\*Goal achieved\.\*\*|\*\*Objective coverage\.\*\*|Goal achieved\.|OBJECTIVE COMPLETE/i;

export function goalStatePath(sessionId: string): string {
  return path.join(forgeHome(), "sessions", sessionId, "goal.json");
}

export function loadGoal(sessionId: string): GoalState | null {
  const g = readJsonFile<GoalState | null>(goalStatePath(sessionId), null);
  return g;
}

export function saveGoal(goal: GoalState): void {
  writeJsonFile(goalStatePath(goal.sessionId), goal);
}

export function clearGoal(sessionId: string): void {
  const g = loadGoal(sessionId);
  if (!g) return;
  g.status = "cleared";
  g.paused = true;
  saveGoal(g);
  // wipe content but keep file for audit? wipe:
  writeJsonFile(goalStatePath(sessionId), {
    status: "cleared",
    objective: "",
    criteria: [],
    setAt: nowIso(),
    setEpoch: nowEpoch(),
    paused: true,
    blocks: g.blocks,
    stuckBlocks: 0,
    lastBlockEditCount: 0,
    lastBlockEpoch: 0,
    armSource: g.armSource,
    sessionId,
  } satisfies GoalState);
}

/** Derive short acceptance criteria from objective text (heuristic). */
export function deriveCriteria(objective: string): string[] {
  const text = objective.trim();
  // Split on ; or numbered lists if present
  const numbered = [...text.matchAll(/(?:^|\s)(?:\d+[\).\]]\s*|[-*]\s+)([^\n;]+)/g)].map(
    (m) => m[1].trim(),
  );
  if (numbered.length >= 2) return numbered.slice(0, 7);

  const parts = text
    .split(/\s+and\s+|;\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 8)
    .slice(0, 5);
  if (parts.length >= 2) return parts;

  return [
    `Objective end-state is met: ${text.slice(0, 120)}`,
    "Relevant tests or verification commands pass",
    "No known incomplete sub-tasks remain for this objective",
  ];
}

export function armGoal(
  sessionId: string,
  objective: string,
  source: "manual" | "auto" = "manual",
): GoalState {
  const cleaned = objective.replace(/\s+/g, " ").trim();
  const goal: GoalState = {
    status: "active",
    objective: cleaned,
    criteria: deriveCriteria(cleaned),
    setAt: nowIso(),
    setEpoch: nowEpoch(),
    paused: false,
    blocks: 0,
    stuckBlocks: 0,
    lastBlockEditCount: 0,
    lastBlockEpoch: 0,
    armSource: source,
    sessionId,
  };
  saveGoal(goal);
  return goal;
}

export function pauseGoal(sessionId: string): GoalState | null {
  const g = loadGoal(sessionId);
  if (!g || !g.objective) return null;
  g.paused = true;
  g.status = "paused";
  saveGoal(g);
  return g;
}

export function resumeGoal(sessionId: string): GoalState | null {
  const g = loadGoal(sessionId);
  if (!g || !g.objective) return null;
  g.paused = false;
  g.status = "active";
  saveGoal(g);
  return g;
}

export function markGoalDone(sessionId: string, reason?: string): GoalState | null {
  const g = loadGoal(sessionId);
  if (!g || !g.objective) return null;
  g.status = "achieved";
  g.paused = true;
  g.achievedAt = nowIso();
  if (reason) g.objective = g.objective; // keep
  saveGoal(g);
  // Achieve is wind-down: drop soft TodoGate once-blocks (parity with stuck-wall /
  // /goal done slash). Safe if slash also clears — clear is idempotent.
  try {
    clearSoftTodoGateOnWindDown(sessionId);
  } catch {
    /* */
  }
  return g;
}

/**
 * Copy /goal state onto a forked session id so the branch keeps the driver.
 * Skips cleared/empty goals. Resets stuck counters for the new timeline.
 */
export function copyGoal(fromId: string, toId: string): GoalState | null {
  if (!fromId || !toId || fromId === toId) return null;
  const src = loadGoal(fromId);
  if (!src || !src.objective) return null;
  if (src.status === "cleared") return null;
  const next: GoalState = {
    ...src,
    sessionId: toId,
    stuckBlocks: 0,
    lastBlockEditCount: 0,
    lastBlockEpoch: 0,
    // Keep achieved/paused status as-is so experts can inspect; active stays active
  };
  saveGoal(next);
  return next;
}

export function formatGoalStatus(g: GoalState | null): string {
  if (!g || !g.objective) return "No active goal. Set one with /goal <objective>";
  const lines = [
    `Goal [${g.status}${g.paused ? ", paused" : ""}]: ${g.objective}`,
    `  Armed: ${g.setAt} (${g.armSource})`,
    `  Blocks: ${g.blocks}  stuck-streak: ${g.stuckBlocks}`,
    `  Criteria:`,
    ...g.criteria.map((c, i) => `    ${i + 1}. ${c}`),
    `  Lifecycle: /goal · /goal pause · /goal resume · /goal clear · /goal done`,
  ];
  return lines.join("\n");
}

/**
 * Called at Stop. Returns whether to block the agent from finishing.
 */
export function evaluateGoalAtStop(opts: {
  sessionId: string;
  lastAssistantMessage: string;
  editCount: number;
  stuckThreshold: number;
  enabled: boolean;
}): GoalDecision {
  if (!opts.enabled) return { block: false };
  const g = loadGoal(opts.sessionId);
  if (!g || !g.objective || g.paused || g.status === "achieved" || g.status === "cleared") {
    return { block: false };
  }

  // Release on attestation
  if (GOAL_ATTEST_RE.test(opts.lastAssistantMessage || "")) {
    g.status = "achieved";
    g.paused = true;
    g.achievedAt = nowIso();
    saveGoal(g);
    // Attestation is wind-down: clear soft TodoGate so Stop is not once-blocked
    // for leftover open todos after **Goal achieved.**
    try {
      clearSoftTodoGateOnWindDown(opts.sessionId);
    } catch {
      /* */
    }
    return { block: false };
  }

  // Progress detection: edits since last block
  const progressed = opts.editCount > g.lastBlockEditCount;
  if (progressed) {
    g.stuckBlocks = 0;
  } else {
    g.stuckBlocks += 1;
  }
  g.blocks += 1;
  g.lastBlockEditCount = opts.editCount;
  g.lastBlockEpoch = nowEpoch();

  // Stuck wall
  if (opts.stuckThreshold > 0 && g.stuckBlocks >= opts.stuckThreshold) {
    g.status = "stuck";
    g.paused = true;
    saveGoal(g);
    // Wind-down: drop soft TodoGate once-blocks so stuck release is clean.
    try {
      clearSoftTodoGateOnWindDown(opts.sessionId);
    } catch {
      /* */
    }
    return {
      block: false,
      stuckReleased: true,
      reason: `Stuck-wall: ${g.stuckBlocks} consecutive Stop attempts with no file edits. Goal released. Re-arm with /goal resume or /goal <objective>.`,
    };
  }

  saveGoal(g);

  const excerpt = g.objective.slice(0, 600);
  const criteria = g.criteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
  const reanchor = [
    `[Forge /goal driver] Stop blocked — goal not yet achieved.`,
    `Goal: ${excerpt}`,
    `Acceptance criteria:`,
    criteria,
    `Blocks so far: ${g.blocks} (stuck-streak ${g.stuckBlocks}/${opts.stuckThreshold || "∞"})`,
    `Continue working. Drive the next concrete sub-step.`,
    `When done: run a completeness check, then attest **Goal achieved.** with a per-criterion checklist (✅/❌ + evidence).`,
    `Do NOT stop with partial progress. Do NOT ask permission to continue.`,
  ].join("\n");

  return {
    block: true,
    reason: reanchor,
    reanchor,
  };
}

/** High-precision auto-arm markers (mirrors oh-my-claude goal_auto_arm). */
export function detectAutoGoal(prompt: string): string | null {
  const patterns = [
    /(?:^|\n)\s*goal\s*:\s*(.+)$/im,
    /don't stop until\s+(.+)/i,
    /do not stop until\s+(.+)/i,
    /keep (?:going|working) until\s+(.+)/i,
    /your goal is\s+(.+)/i,
    /relentlessly\s+(.+)/i,
  ];
  for (const re of patterns) {
    const m = prompt.match(re);
    if (m?.[1]) {
      const obj = m[1].replace(/[."']+$/, "").trim();
      if (obj.length > 8) return obj;
    }
  }
  return null;
}
