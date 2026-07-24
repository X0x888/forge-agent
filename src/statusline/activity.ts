/**
 * In-process agent activity — what the session is doing right now.
 * Written by the REPL / loop; read by HUD renderers and the prompt bar
 * so users see "working" without a second status panel.
 */

export type AgentPhase =
  | "idle"
  | "thinking"
  | "tool"
  | "compacting"
  | "stop_guard"
  | "waiting";

export interface SessionActivity {
  phase: AgentPhase;
  /** Tool name, compact note, etc. */
  detail?: string;
  /** When current phase began (epoch ms) */
  phaseStartedAt: number;
  /** When current agent turn began (epoch ms) */
  turnStartedAt?: number;
  busy: boolean;
  /** Running background shell tasks in this process */
  bgRunning: number;
  /** Total bg tasks still tracked (running + recent done) */
  bgTotal: number;
  /** Short command summary of first running bg task */
  bgHint?: string;
}

const state: SessionActivity = {
  phase: "idle",
  phaseStartedAt: Date.now(),
  busy: false,
  bgRunning: 0,
  bgTotal: 0,
};

export function getActivity(): SessionActivity {
  return { ...state };
}

export function setActivity(
  patch: Partial<Omit<SessionActivity, "phaseStartedAt">> & {
    phase?: AgentPhase;
  },
): SessionActivity {
  const phaseChanged =
    patch.phase !== undefined && patch.phase !== state.phase;
  Object.assign(state, patch);
  if (phaseChanged) {
    state.phaseStartedAt = Date.now();
  }
  if (patch.busy === false && patch.phase === undefined) {
    state.phase = "idle";
    state.detail = undefined;
    state.phaseStartedAt = Date.now();
    state.turnStartedAt = undefined;
  }
  return getActivity();
}

export function beginTurn(): SessionActivity {
  return setActivity({
    busy: true,
    phase: "thinking",
    detail: undefined,
    turnStartedAt: Date.now(),
  });
}

export function endTurn(): SessionActivity {
  return setActivity({
    busy: false,
    phase: "idle",
    detail: undefined,
    turnStartedAt: undefined,
  });
}

export function setPhase(
  phase: AgentPhase,
  detail?: string,
): SessionActivity {
  return setActivity({
    phase,
    detail,
    busy: phase !== "idle",
  });
}

/** Sync background-task counts into activity (call after spawn/poll/kill). */
export function syncBackgroundCounts(opts: {
  running: number;
  total: number;
  hint?: string;
}): SessionActivity {
  return setActivity({
    bgRunning: opts.running,
    bgTotal: opts.total,
    bgHint: opts.hint,
  });
}

export function activityElapsedSec(act: SessionActivity = state): number {
  if (!act.busy || !act.turnStartedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - act.turnStartedAt) / 1000));
}

export function phaseElapsedSec(act: SessionActivity = state): number {
  return Math.max(0, Math.floor((Date.now() - act.phaseStartedAt) / 1000));
}

/** Test helper */
export function _resetActivityForTests(): void {
  state.phase = "idle";
  state.detail = undefined;
  state.phaseStartedAt = Date.now();
  state.turnStartedAt = undefined;
  state.busy = false;
  state.bgRunning = 0;
  state.bgTotal = 0;
  state.bgHint = undefined;
}
