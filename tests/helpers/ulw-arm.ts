/**
 * Arm ULW already past Wave-1 PLAN so wave-ledger tests can stamp ships.
 * Production `/ulw` still starts in PLAN.
 */
import {
  armUlwCycle,
  loadUlwCycle,
  markUlwPlanDone,
  type UlwCycleState,
} from "../../src/harness/ulw-cycle.js";

export function armUlwReady(
  sessionId: string,
  mandate: string,
  opts?: Parameters<typeof armUlwCycle>[2],
): UlwCycleState {
  armUlwCycle(sessionId, mandate, opts);
  markUlwPlanDone(sessionId);
  return loadUlwCycle(sessionId)!;
}
