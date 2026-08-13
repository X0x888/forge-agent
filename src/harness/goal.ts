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
import { hasAttestationEvidence } from "./ulw-cycle.js";
import { maybeDesktopNotify } from "../util/attention.js";

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
  /**
   * Working-tree diff fingerprint at the previous Stop evaluation — progress
   * = editCount delta OR changed fingerprint, so bash-channel work (heredocs,
   * sed) cannot false-trigger the stuck-wall. Undefined until first git eval.
   */
  lastDiffFp?: string;
  /** Evidence bounces issued against weak attestations (capped at 1) */
  evidenceNudges?: number;
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

/** Evidence bounces allowed on weak **Goal achieved.** attestations before
 * falling through to the normal stuck-wall logic (parity with ULW). */
const MAX_GOAL_EVIDENCE_NUDGES = 1;

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
    evidenceNudges: 0,
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
  try {
    maybeDesktopNotify({
      title: "Forge · Goal achieved",
      body: (g.objective || "goal").slice(0, 180),
    });
  } catch {
    /* */
  }
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
  /**
   * Successful structural verification (preferred). When edits happened,
   * **Goal achieved.** without evidence is bounced once (same bar as ULW).
   */
  verificationPassed?: boolean;
  verificationRan?: boolean;
  preferredCheckCommands?: string[];
  /**
   * Working-tree diff fingerprint (gitDiffFingerprint). When it changes
   * between Stop evaluations the goal is progressing even without edit-tool
   * calls (bash heredocs/sed) — prevents false stuck-wall releases.
   */
  diffFingerprint?: string | null;
}): GoalDecision {
  if (!opts.enabled) return { block: false };
  const g = loadGoal(opts.sessionId);
  if (!g || !g.objective || g.paused || g.status === "achieved" || g.status === "cleared") {
    return { block: false };
  }

  const msg = opts.lastAssistantMessage || "";
  const attested = GOAL_ATTEST_RE.test(msg);
  const needEvidence = (opts.editCount || 0) > 0;
  const attestationHasEvidence =
    !attested ||
    !needEvidence ||
    hasAttestationEvidence(msg, opts.verificationPassed ?? opts.verificationRan);

  // Release on attestation — require evidence when the session had edits.
  if (attested && attestationHasEvidence) {
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

  // Progress detection: edits since last block, OR working-tree diff movement
  // (bash-channel work moves the tree without touching edit-tool counters).
  // Runs (and persists) BEFORE the evidence bounce below so repeated weak
  // attestations still feed the stuck-wall — the bounce can never become an
  // infinite trap.
  const fp = opts.diffFingerprint ?? null;
  let diffChanged = false;
  if (fp) {
    if (g.lastDiffFp === undefined) {
      g.lastDiffFp = fp;
    } else if (fp !== g.lastDiffFp) {
      diffChanged = true;
      g.lastDiffFp = fp;
    }
  }
  const progressed = opts.editCount > g.lastBlockEditCount || diffChanged;
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
    try {
      maybeDesktopNotify({
        title: "Forge · Goal stuck-wall",
        body: (g.objective || "goal").slice(0, 180),
      });
    } catch {
      /* */
    }
    // Wind-down: drop soft TodoGate once-blocks so stuck release is clean.
    try {
      clearSoftTodoGateOnWindDown(opts.sessionId);
    } catch {
      /* */
    }
    return {
      block: false,
      stuckReleased: true,
      reason: `Stuck-wall: ${g.stuckBlocks} consecutive Stop attempts with no file edits or working-tree changes. Goal released. Re-arm with /goal resume or /goal <objective>.`,
    };
  }

  // Weak attestation (edits but no machine-checkable evidence) → bounce once,
  // demanding a real check. Capped so it can never become an infinite trap:
  // stuck tracking above already ran and persisted, and after the cap the stop
  // falls through to the normal block path where the stuck-wall can engage.
  if (
    attested &&
    !attestationHasEvidence &&
    (g.evidenceNudges ?? 0) < MAX_GOAL_EVIDENCE_NUDGES
  ) {
    g.evidenceNudges = (g.evidenceNudges ?? 0) + 1;
    saveGoal(g);
    const preferred = (opts.preferredCheckCommands || [])
      .map((c) => String(c || "").trim())
      .filter(Boolean)
      .slice(0, 4);
    const checkLine = preferred.length
      ? preferred.map((c) => `\`${c}\``).join(" · ")
      : "`npm test` / typecheck / project check";
    return {
      block: true,
      reason:
        "Goal attestation needs evidence after edits — run a successful project check, then re-attest **Goal achieved.** with ✅/❌ per criterion.",
      reanchor:
        `[Forge system-reminder — Goal attestation needs evidence]\n` +
        `You claimed **Goal achieved.** after edits without a successful structural check.\n` +
        `Run now: ${checkLine}\n` +
        `Then re-attest with ✅/❌ per criterion + the command that passed.`,
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
