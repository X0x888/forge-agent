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
}

const lastAdmitted = new Map<string, string>();

export function snapshotHarness(opts: {
  ulw: UlwCycleState | null | undefined;
  goal: GoalState | null | undefined;
  todos: TodoItem[];
  permissionMode: string;
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
  if (sessionId) lastAdmitted.delete(sessionId);
  else lastAdmitted.clear();
}

/**
 * If harness state changed since last admission, return a message body to
 * inject. Returns null when unchanged (or when idle harness with nothing to say).
 */
export function admitHarnessIfChanged(
  sessionId: string,
  snap: HarnessSnapshot,
): string | null {
  const fp = fingerprintSnapshot(snap);
  const prev = lastAdmitted.get(sessionId);
  if (prev === fp) return null;

  // First admit of an idle session with no goal/ULW: skip empty noise
  if (
    !snap.ulwEnabled &&
    !snap.goalActive &&
    snap.openTodos === 0 &&
    prev === undefined
  ) {
    lastAdmitted.set(sessionId, fp);
    return null;
  }

  lastAdmitted.set(sessionId, fp);
  return renderHarnessAdmission(snap);
}

export function renderHarnessAdmission(s: HarnessSnapshot): string {
  const lines: string[] = [
    `[Forge harness — mid-conversation update]`,
    `Obey this state over earlier harness messages. Baseline system protocol is unchanged.`,
  ];

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
      s.mandate ? `Mandate: ${s.mandate}` : "",
      s.softPrompt
        ? `Soft original prompt — keep discovering real gaps; do not ask what to improve.`
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

  return lines.filter((l) => l !== undefined).join("\n");
}
