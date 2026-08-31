/**
 * Once-per-session, dismissible first-day hints.
 * Never unsolicited /ulw or /goal — those start work immediately.
 */

export type HintId =
  | "no_agents"
  | "no_budget"
  | "long_run_notify"
  | "first_permission"
  | "live_steer";

export interface TurnHintInput {
  dismissed: readonly string[];
  /** Skip entirely (setup card already printed this process, or ULW CONTINUE). */
  skip?: boolean;
  hadFileEdits: boolean;
  projectRulesCount: number;
  sessionCostUsd: number;
  hasBudget: boolean;
  turnElapsedSec: number;
  notifyOn: boolean;
  bellOn: boolean;
}

export interface HintPick {
  id: HintId;
  text: string;
}

export const FIRST_PERMISSION_HINT =
  "This is normal. a persists · /permissions acceptEdits to stop asking.";

/**
 * First live › — peers train Ctrl+C. One dismissible line at the moment
 * the prompt appears. LIVE_CONTROLS_HINT stays on /ulw · /cycle (expert wall).
 */
export const LIVE_STEER_HINT =
  "type to queue · /status  (no Ctrl+C)";

/** Printed above the live prompt so the caret and the tip share a name. */
export function formatLiveSteerLine(text: string): string {
  return `  live ›  ${text}`;
}

export function pickLiveSteerHint(input: {
  dismissed: readonly string[];
  /** Skip (ULW already printed the long mid-run wall, or tests). */
  skip?: boolean;
}): HintPick | null {
  if (input.skip) return null;
  if (input.dismissed.map(String).includes("live_steer")) return null;
  return { id: "live_steer", text: LIVE_STEER_HINT };
}

/** Immediate SIGINT ack while the run is still winding down. Recovery lives on ABORT_RECOVERY. */
export const ABORT_ACK = "Aborting…";

/** Second Ctrl+C while abort is stuck (orphaned bash grandchildren). */
export const ABORT_STUCK_QUIT = "Abort stuck — quitting.";

/** Printed after a SIGINT abort so the user knows how to continue. */
export const ABORT_RECOVERY =
  "⚠ Run aborted. Type to continue · /retry same prompt · Ctrl+C again force-quits if abort sticks.";

export type SigintAction = "abort" | "force-quit" | "arm-quit" | "quit";

/** First Ctrl+C aborts the turn; second while aborting force-quits. */
export function nextSigintAction(state: {
  busy: boolean;
  aborting: boolean;
  quitArmed: boolean;
}): SigintAction {
  if (state.busy && state.aborting) return "force-quit";
  if (state.busy) return "abort";
  if (state.quitArmed) return "quit";
  return "arm-quit";
}

export function pickTurnEndHint(input: TurnHintInput): HintPick | null {
  if (input.skip) return null;
  const dismissed = new Set(input.dismissed.map((s) => String(s)));

  if (
    input.hadFileEdits &&
    input.projectRulesCount <= 0 &&
    !dismissed.has("no_agents")
  ) {
    return {
      id: "no_agents",
      text: "No AGENTS.md yet — /init writes project instructions.",
    };
  }
  if (
    input.sessionCostUsd > 0 &&
    !input.hasBudget &&
    !dismissed.has("no_budget")
  ) {
    return {
      id: "no_budget",
      text: "No spend cap — /budget 5 (or /setup).",
    };
  }
  if (
    input.turnElapsedSec >= 180 &&
    !input.notifyOn &&
    !input.bellOn &&
    !dismissed.has("long_run_notify")
  ) {
    return {
      id: "long_run_notify",
      text: "Long runs finish quietly — /notify on.",
    };
  }
  return null;
}

export function shouldShowFirstPermissionHint(
  dismissed: readonly string[],
): boolean {
  return !dismissed.map(String).includes("first_permission");
}
