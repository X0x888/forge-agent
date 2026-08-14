/**
 * Once-per-session, dismissible first-day hints.
 * Never unsolicited /ulw or /goal — those start work immediately.
 */

export type HintId =
  | "no_agents"
  | "no_budget"
  | "long_run_notify"
  | "first_permission";

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
  "This is normal in default mode. Enter / y = once · /permissions acceptEdits to stop asking.";

/** Printed after a SIGINT abort so the user knows how to continue. */
export const ABORT_RECOVERY =
  "⚠ Run aborted. Type to continue · /retry same prompt · Ctrl+C again to quit.";

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
