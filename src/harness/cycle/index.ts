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
export * from "./peer-scout.js";

import type { CycleState } from "./state.js";
import { displayUlwMandate } from "./status.js";
import { ULW_LIVE_CONTROLS_HINT } from "./controls.js";

/** Unlimited /ulw release conditions — the same facts `planNextCycle` honours. */
export const ULW_UNLIMITED_LIFECYCLE =
  "until a mandate fulfilled (after sitting the product), /cycle 0, max_cycles, or — with no mandate — the no-progress wall on repeating empty work. A Planner blocked, a dead look, or a still-open mandate is not a release."

/** Transcript line injected when /ulw arms — the Planner runs before the first model call. */
export function ulwKickoffMessage(s: CycleState): string {
  return [
    `[Forge ULW cycle driver] armed — plan-cycle mode.`,
    `Mandate: ${displayUlwMandate(s)}`,
    s.maxCycles != null ? `Budget: ${s.maxCycles} cycle(s).` : `Budget: unlimited cycles ${ULW_UNLIMITED_LIFECYCLE}`,
    `A fresh-context Planner is writing cycle 1's plan now (identity, category research, whole-tree survey, gap analysis). You will receive the plan as the next harness message and execute it as the plan's items; the harness then runs the verify command, a fresh Reviewer writes the review, the check runs again and the cycle commits.`,
    `A peer scout researches 1–3 maintained GitHub peers of this job in the background; the next Planner weighs the note after Looked:. The executor never sees it. /cycle peers · FORGE_ULW_PEERS=0 off.`,
    ULW_LIVE_CONTROLS_HINT,
  ].join("\n");
}
