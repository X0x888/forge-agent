/**
 * ULW plan-cycle engine — public surface.
 *
 * PLAN → EXECUTE → REVIEW → VERIFY → COMMIT → (RELEASED | PLAN). The
 * Planner and Reviewer are fresh-context subagents the harness launches; the
 * session model executes the plan; the harness runs the verify command and
 * commits. See docs/ULW.md.
 */
export * from "./state.js";
export * from "./machine.js";
export * from "./artifacts.js";
export * from "./briefs.js";
export * from "./orchestrator.js";
export * from "./roles.js";
export * from "./controls.js";
export * from "./status.js";
export * from "./verify.js";

import type { CycleState } from "./state.js";
import { displayUlwMandate } from "./status.js";
import { ULW_LIVE_CONTROLS_HINT } from "./controls.js";

/** Transcript line injected when /ulw arms — the Planner runs before the first model call. */
export function ulwKickoffMessage(s: CycleState): string {
  return [
    `[Forge ULW cycle driver] armed — plan-cycle mode.`,
    `Mandate: ${displayUlwMandate(s)}`,
    s.maxCycles != null ? `Budget: ${s.maxCycles} cycle(s).` : `Budget: unlimited cycles until the Planner judges the mandate fulfilled, or /cycle 0.`,
    `A fresh-context Planner is writing cycle 1's plan now (identity, category research, whole-tree survey, gap analysis). You will receive the plan as the next harness message and execute it as the plan's items; the harness then runs the verify command, a fresh Reviewer revises the cycle diff, the check runs again and the cycle commits.`,
    ULW_LIVE_CONTROLS_HINT,
  ].join("\n");
}
