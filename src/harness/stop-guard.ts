/**
 * Built-in Stop guard — the harness that Grok Build is missing.
 *
 * Composes:
 *  1. User-defined Stop hooks (blocking)
 *  2. /goal relentless driver
 *  3. ULW cycle driver (cycle=1 loop / cycle=0 last-wave)
 *  4. TodoGate (open todos under ULW)
 *  5. Ultrawork open-todos backstop
 */
import type { ForgeConfig } from "../config/types.js";
import type { HookRunner, HookContext, HookResult } from "./hooks.js";
import {
  evaluateGoalAtStop,
  loadGoal,
  type GoalDecision,
} from "./goal.js";
import { evaluateUlwAtStop, loadUlwCycle, type UlwStopDecision } from "./ulw-cycle.js";
import { evaluateTodoGateAtStop } from "./todo-gate.js";
import { envPositiveInt } from "../util/env.js";

export interface StopGuardInput {
  config: ForgeConfig;
  hooks: HookRunner;
  ctx: HookContext;
  ultrawork: boolean;
  openTodoCount: number;
  editCount: number;
  lastAssistantMessage: string;
  /**
   * Structural proof signal: a verification command (test/typecheck/lint/build)
   * actually executed since the previous Stop evaluation. Gate = execution,
   * not judgment — the wave ledger trusts this over prose claims.
   */
  verificationRan?: boolean;
}

export interface StopGuardResult {
  allowStop: boolean;
  reason?: string;
  additionalContext?: string;
  systemMessage?: string;
  goal?: GoalDecision;
  ulw?: UlwStopDecision;
  hook?: HookResult;
  /** True when Stop was blocked by TodoGate */
  todoGate?: boolean;
}

export async function runStopGuard(input: StopGuardInput): Promise<StopGuardResult> {
  const { config, hooks, ctx } = input;

  const goal = loadGoal(ctx.sessionId);
  const ulw = loadUlwCycle(ctx.sessionId);
  const hookCtx: HookContext = {
    ...ctx,
    goalObjective: goal?.objective,
    ultrawork: input.ultrawork || Boolean(ulw?.enabled),
    editCount: input.editCount,
    lastAssistantMessage: input.lastAssistantMessage,
    stopReason: "agent_end",
  };

  let hookResult: HookResult = { decision: "allow", blocked: false };
  if (config.blockingStopHooks) {
    hookResult = await hooks.run("Stop", hookCtx);
  } else {
    hookResult = await hooks.run("Stop", hookCtx);
    hookResult = { ...hookResult, blocked: false, decision: "allow" };
  }

  if (hookResult.blocked) {
    return {
      allowStop: false,
      reason: hookResult.reason || "Stop blocked by hook",
      additionalContext: hookResult.additionalContext || hookResult.reason,
      systemMessage: hookResult.systemMessage,
      hook: hookResult,
    };
  }

  // Goal driver
  const goalDecision = evaluateGoalAtStop({
    sessionId: ctx.sessionId,
    lastAssistantMessage: input.lastAssistantMessage,
    editCount: input.editCount,
    stuckThreshold: config.goal.stuckThreshold,
    enabled: config.goal.enabled,
  });

  if (goalDecision.stuckReleased) {
    return {
      allowStop: true,
      systemMessage: goalDecision.reason,
      goal: goalDecision,
      hook: hookResult,
    };
  }

  if (goalDecision.block) {
    return {
      allowStop: false,
      reason: goalDecision.reason,
      additionalContext: goalDecision.reanchor,
      systemMessage: goalDecision.reason,
      goal: goalDecision,
      hook: hookResult,
    };
  }

  // ULW relentless cycle (even for soft prompts).
  // Invalid/missing FORGE_ULW_STUCK_THRESHOLD falls back (0 is not a valid threshold).
  const stuckThreshold = envPositiveInt(
    "FORGE_ULW_STUCK_THRESHOLD",
    config.goal.stuckThreshold > 0 ? config.goal.stuckThreshold : 5,
  );

  const ulwDecision = evaluateUlwAtStop({
    sessionId: ctx.sessionId,
    lastAssistantMessage: input.lastAssistantMessage,
    editCount: input.editCount,
    openTodoCount: input.openTodoCount,
    stuckThreshold,
    verificationRan: input.verificationRan,
  });

  if (ulwDecision.stuckReleased || ulwDecision.lastCycleReleased) {
    return {
      allowStop: true,
      systemMessage: ulwDecision.reason,
      goal: goalDecision,
      ulw: ulwDecision,
      hook: hookResult,
    };
  }

  if (ulwDecision.block) {
    return {
      allowStop: false,
      reason: ulwDecision.reason,
      additionalContext: ulwDecision.reanchor,
      systemMessage: ulwDecision.reason,
      goal: goalDecision,
      ulw: ulwDecision,
      hook: hookResult,
    };
  }

  // TodoGate: open todos under ULW (cycle state or session flag)
  const todoGate = evaluateTodoGateAtStop({
    sessionId: ctx.sessionId,
    ulwEnabled: Boolean(ulw?.enabled),
    ultraworkFlag: input.ultrawork,
    openTodoCount: input.openTodoCount,
    lastAssistantMessage: input.lastAssistantMessage,
  });
  if (todoGate.block) {
    return {
      allowStop: false,
      reason: todoGate.reason,
      additionalContext: todoGate.reanchor,
      systemMessage: todoGate.reason,
      hook: hookResult,
      goal: goalDecision,
      ulw: ulwDecision,
      todoGate: true,
    };
  }

  // Backstop: ultrawork session flag with open todos (if cycle state missing)
  if (input.ultrawork && input.openTodoCount > 0) {
    const attested = /\*\*Goal achieved\.\*\*|\*\*Cycle complete\.\*\*|all tasks complete/i.test(
      input.lastAssistantMessage || "",
    );
    if (!attested) {
      const msg = [
        `[Forge ultrawork] Stop blocked — ${input.openTodoCount} open todo(s) remain.`,
        `Continue the next unfinished item, or set /cycle 0 and finish the last wave with **Cycle complete.**`,
      ].join("\n");
      return {
        allowStop: false,
        reason: msg,
        additionalContext: msg,
        systemMessage: msg,
        hook: hookResult,
        goal: goalDecision,
        ulw: ulwDecision,
        todoGate: true,
      };
    }
  }

  return {
    allowStop: true,
    additionalContext: hookResult.additionalContext,
    systemMessage: hookResult.systemMessage,
    hook: hookResult,
    goal: goalDecision,
    ulw: ulwDecision,
  };
}
