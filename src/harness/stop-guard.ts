/**
 * Built-in Stop guard — the harness that Grok Build is missing.
 *
 * Composes:
 *  1. User-defined Stop hooks (blocking)
 *  2. /goal relentless driver
 *  3. Ultrawork mode (no-defer: block premature stops when work is open)
 */
import type { ForgeConfig } from "../config/types.js";
import type { HookRunner, HookContext, HookResult } from "./hooks.js";
import {
  evaluateGoalAtStop,
  loadGoal,
  type GoalDecision,
} from "./goal.js";

export interface StopGuardInput {
  config: ForgeConfig;
  hooks: HookRunner;
  ctx: HookContext;
  ultrawork: boolean;
  /** Open todos still pending */
  openTodoCount: number;
  editCount: number;
  lastAssistantMessage: string;
}

export interface StopGuardResult {
  allowStop: boolean;
  reason?: string;
  additionalContext?: string;
  systemMessage?: string;
  goal?: GoalDecision;
  hook?: HookResult;
}

export async function runStopGuard(input: StopGuardInput): Promise<StopGuardResult> {
  const { config, hooks, ctx } = input;

  // 1. User hooks first
  const goal = loadGoal(ctx.sessionId);
  const hookCtx: HookContext = {
    ...ctx,
    goalObjective: goal?.objective,
    ultrawork: input.ultrawork,
    editCount: input.editCount,
    lastAssistantMessage: input.lastAssistantMessage,
    stopReason: "agent_end",
  };

  let hookResult: HookResult = { decision: "allow", blocked: false };
  if (config.blockingStopHooks) {
    hookResult = await hooks.run("Stop", hookCtx);
  } else {
    // Passive only (Grok-compatible mode)
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

  // 2. Goal driver
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

  // 3. Ultrawork: block stop when open todos remain and agent didn't attest done
  if (input.ultrawork && input.openTodoCount > 0) {
    const attested = /\*\*Goal achieved\.\*\*|all tasks complete|TODOS? COMPLETE/i.test(
      input.lastAssistantMessage || "",
    );
    if (!attested) {
      const msg = [
        `[Forge ultrawork] Stop blocked — ${input.openTodoCount} open todo(s) remain.`,
        `Continue working the next unfinished item. Do not stop mid-mandate.`,
      ].join("\n");
      return {
        allowStop: false,
        reason: msg,
        additionalContext: msg,
        systemMessage: msg,
        hook: hookResult,
        goal: goalDecision,
      };
    }
  }

  return {
    allowStop: true,
    additionalContext: hookResult.additionalContext,
    systemMessage: hookResult.systemMessage,
    hook: hookResult,
    goal: goalDecision,
  };
}
