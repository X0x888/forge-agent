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

/** LAST attest that skips close-out (Must-fix: none). */
export function lastAttest(extra?: string): string {
  const body =
    extra?.trim() ||
    "**Cycle complete.**\n✅ npm run typecheck — green";
  if (/\bmust-fix\b/i.test(body)) return body;
  return `${body}\nMust-fix: none\nLive-with: none this run.`;
}
