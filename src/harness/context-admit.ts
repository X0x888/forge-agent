/**
 * Mid-conversation harness admission (OpenCode-inspired).
 *
 * Keep the baseline system prompt stable (provider-cache friendly). Admit
 * harness state changes (ULW cycle/wave, goal, open todos) as chronological
 * user messages at a safe provider-turn boundary — not by rewriting the
 * entire system string every wave.
 */

import type { GoalState } from "./goal.js";
import type { UlwCycleState } from "./ulw-cycle.js";
import type { TodoItem } from "../session/session.js";
import { formatUlwCounts } from "./ulw-cycle.js";
import {
  formatGitBranchLine,
  formatGitTreeLine,
  type GitSnapshot,
} from "../util/git-context.js";
import { formatMemoryForPrompt } from "./decision-memory.js";

export interface HarnessSnapshot {
  ulwEnabled: boolean;
  cycle: 0 | 1 | null;
  wave: number;
  /** null = unlimited */
  maxWaves: number | null;
  blocks: number;
  mandate: string;
  softPrompt: boolean;
  goalActive: boolean;
  goalObjective: string;
  goalPaused: boolean;
  openTodos: number;
  permissionMode: string;
  /**
   * Volatile git branch line (e.g. "Branch: main → origin/main"). Lives here
   * instead of the system prompt so branch switches don't rewrite message[0]
   * and invalidate the provider prompt cache. "" when not a git repo.
   */
  gitBranch?: string;
  /**
   * Coarse working-tree line (clean / dirty + file count). Display-only count;
   * fingerprint uses `gitDirty` so per-edit count churn does not re-admit.
   */
  gitTree?: string;
  /** Boolean dirty bit — real change when it flips (first edit / commit). */
  gitDirty?: boolean;
  /** Fingerprint of active decisions.json (admit on change, not every turn). */
  decisionsFp?: string;
  /** Short active-constraint block for the admit message. */
  decisionsText?: string;
}

const lastAdmitted = new Map<string, string>();
const lastAdmittedSnap = new Map<string, HarnessSnapshot>();

export function snapshotHarness(opts: {
  ulw: UlwCycleState | null | undefined;
  goal: GoalState | null | undefined;
  todos: TodoItem[];
  permissionMode: string;
  git?: GitSnapshot | null;
  sessionId?: string;
}): HarnessSnapshot {
  const ulw = opts.ulw?.enabled ? opts.ulw : null;
  const goal =
    opts.goal &&
    opts.goal.objective &&
    opts.goal.status === "active" &&
    !opts.goal.paused
      ? opts.goal
      : null;
  const openTodos = opts.todos.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  ).length;

  let decisionsFp = "";
  let decisionsText = "";
  if (opts.sessionId) {
    try {
      const mem = formatMemoryForPrompt(opts.sessionId, {
        budget: 1600,
        includeWave: false,
      });
      if (mem.activeCount > 0) {
        decisionsText = mem.text;
        decisionsFp = `${mem.activeCount}:${mem.text.length}:${mem.text.slice(0, 80)}`;
      }
    } catch {
      /* sidecar optional */
    }
  }

  return {
    ulwEnabled: Boolean(ulw),
    cycle: ulw ? ulw.cycle : null,
    wave: ulw?.wave ?? 0,
    maxWaves: ulw?.maxWaves ?? null,
    blocks: ulw?.blocks ?? 0,
    mandate: ulw?.mandate ?? "",
    softPrompt: Boolean(ulw?.softPrompt),
    goalActive: Boolean(goal),
    goalObjective: goal?.objective ?? "",
    goalPaused: Boolean(opts.goal?.paused),
    openTodos,
    permissionMode: opts.permissionMode,
    gitBranch: opts.git ? formatGitBranchLine(opts.git) : "",
    gitTree: opts.git?.root ? formatGitTreeLine(opts.git) : "",
    gitDirty: Boolean(opts.git?.dirty),
    decisionsFp,
    decisionsText,
  };
}

export function fingerprintSnapshot(s: HarnessSnapshot): string {
  return [
    s.ulwEnabled ? "1" : "0",
    s.cycle === null ? "-" : String(s.cycle),
    String(s.wave),
    s.maxWaves == null ? "-" : String(s.maxWaves),
    String(s.blocks),
    s.mandate,
    s.softPrompt ? "1" : "0",
    s.goalActive ? "1" : "0",
    s.goalObjective,
    s.goalPaused ? "1" : "0",
    String(s.openTodos),
    s.permissionMode,
    s.gitBranch ?? "",
    s.gitDirty ? "1" : "0",
    s.decisionsFp ?? "",
  ].join("\x1f");
}

export function getLastAdmittedFingerprint(sessionId: string): string | null {
  return lastAdmitted.get(sessionId) ?? null;
}

export function setLastAdmittedFingerprint(
  sessionId: string,
  fp: string,
): void {
  lastAdmitted.set(sessionId, fp);
}

/** Test helper */
export function clearAdmittedFingerprints(sessionId?: string): void {
  if (sessionId) {
    lastAdmitted.delete(sessionId);
    lastAdmittedSnap.delete(sessionId);
  } else {
    lastAdmitted.clear();
    lastAdmittedSnap.clear();
  }
}

/**
 * True when only soft counters changed between two snapshots (ULW wave/blocks,
 * open todo count). Those deltas are already carried by Stop re-anchors and
 * the model's own todo_write calls, so re-admitting them as a full harness
 * message is redundant tokens. Real changes (cycle flag, mandate, goal,
 * permission mode) always admit.
 */
function countersOnlyChange(a: HarnessSnapshot, b: HarnessSnapshot): boolean {
  return (
    a.ulwEnabled === b.ulwEnabled &&
    a.cycle === b.cycle &&
    a.maxWaves === b.maxWaves &&
    a.mandate === b.mandate &&
    a.softPrompt === b.softPrompt &&
    a.goalActive === b.goalActive &&
    a.goalObjective === b.goalObjective &&
    a.goalPaused === b.goalPaused &&
    a.permissionMode === b.permissionMode &&
    (a.gitBranch ?? "") === (b.gitBranch ?? "") &&
    Boolean(a.gitDirty) === Boolean(b.gitDirty) &&
    (a.decisionsFp ?? "") === (b.decisionsFp ?? "")
  );
}

/**
 * If harness state changed since last admission, return a message body to
 * inject. Returns null when unchanged (or when idle harness with nothing to say).
 * With `suppressCounterOnlyChanges`, a delta limited to wave/blocks/openTodos
 * updates the stored fingerprint without emitting a message.
 */
export function admitHarnessIfChanged(
  sessionId: string,
  snap: HarnessSnapshot,
  opts?: { suppressCounterOnlyChanges?: boolean },
): string | null {
  const fp = fingerprintSnapshot(snap);
  const prev = lastAdmitted.get(sessionId);
  if (prev === fp) return null;

  // First admit of an idle session with no goal/ULW: skip empty noise — but
  // still surface git branch + coarse tree once (they no longer live in the
  // system prompt, so this is the model's only git context on plain sessions).
  if (
    !snap.ulwEnabled &&
    !snap.goalActive &&
    snap.openTodos === 0 &&
    prev === undefined
  ) {
    lastAdmitted.set(sessionId, fp);
    lastAdmittedSnap.set(sessionId, snap);
    const gitLines = [snap.gitBranch, snap.gitTree].filter(Boolean).join("\n");
    return gitLines
      ? `[Forge harness — mid-conversation update]\n${gitLines}`
      : null;
  }

  const prevSnap = lastAdmittedSnap.get(sessionId);
  if (
    opts?.suppressCounterOnlyChanges &&
    prevSnap &&
    countersOnlyChange(prevSnap, snap)
  ) {
    lastAdmitted.set(sessionId, fp);
    lastAdmittedSnap.set(sessionId, snap);
    return null;
  }

  lastAdmitted.set(sessionId, fp);
  lastAdmittedSnap.set(sessionId, snap);
  return renderHarnessAdmission(snap);
}

export function renderHarnessAdmission(s: HarnessSnapshot): string {
  const lines: string[] = [
    `[Forge harness — mid-conversation update]`,
    `Obey this state over earlier harness messages. Baseline system protocol is unchanged.`,
  ];

  if (s.gitBranch || s.gitTree) {
    lines.push(
      ``,
      `## Git`,
      [s.gitBranch, s.gitTree].filter(Boolean).join("\n"),
    );
  }

  if (s.ulwEnabled) {
    lines.push(
      ``,
      `## ULW`,
      `ON | **${formatUlwCounts({
        cycle: s.cycle ?? 1,
        wave: s.wave,
        blocks: s.blocks,
        maxWaves: s.maxWaves,
      })}** ${
        s.cycle === 0 ? "(LAST cycle — finish wave then **Cycle complete.**)" : "(CONTINUE)"
      }`,
      s.maxWaves != null
        ? `max_waves=${s.maxWaves} — when wave hits the cap, harness auto-flips to LAST.`
        : `max_waves=off (unlimited).`,
      `Harness w=N/M is the only wave counter. Do not invent Wave K. Close a unit with Wave shipped. / Ship landed: so w can move.`,
      s.mandate ? `Mandate: ${s.mandate}` : "",
      s.softPrompt
        ? `Soft original prompt — invent high-leverage work; after the reading's ship, change surface or close. Do not hunt leftover chrome.`
        : "",
    );
  } else {
    lines.push(``, `## ULW`, `OFF`);
  }

  if (s.goalActive) {
    lines.push(
      ``,
      `## Goal`,
      `ACTIVE: ${s.goalObjective}`,
      `Attest **Goal achieved.** with evidence when done.`,
    );
  } else if (s.goalPaused) {
    lines.push(``, `## Goal`, `PAUSED`);
  }

  lines.push(
    ``,
    `## Todos`,
    s.openTodos > 0
      ? `${s.openTodos} open (pending/in_progress) — clear or complete before claiming done.`
      : `No open todos.`,
    ``,
    `Permission mode: ${s.permissionMode}`,
  );

  if (s.decisionsText) {
    lines.push(``, `## Active decisions`, s.decisionsText);
  }

  if (s.gitBranch || s.gitTree) {
    lines.push(
      ``,
      `## Git`,
      [s.gitBranch, s.gitTree].filter(Boolean).join("\n"),
    );
  }

  return lines.filter((l) => l !== undefined).join("\n");
}
