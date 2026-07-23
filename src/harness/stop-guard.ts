/**
 * Built-in Stop guard — the harness that Grok Build is missing.
 *
 * Composes:
 *  1. User-defined Stop hooks (blocking)
 *  2. /goal relentless driver
 *  3. ULW cycle driver (cycle=1 loop / cycle=0 last-wave)
 *  4. Ultrawork open-todos backstop
 */
import type { ForgeConfig } from "../config/types.js";
import type { HookRunner, HookContext, HookResult } from "./hooks.js";
import {
  evaluateGoalAtStop,
  loadGoal,
  type GoalDecision,
} from "./goal.js";
import { evaluateUlwAtStop, loadUlwCycle, type UlwStopDecision } from "./ulw-cycle.js";

export interface StopGuardInput {
  config: ForgeConfig;
  hooks: HookRunner;
  ctx: HookContext;
  ultrawork: boolean;
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
  ulw?: UlwStopDecision;
  hook?: HookResult;
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

  // ULW relentless cycle (even for soft prompts)
  const stuckThreshold =
    Number(process.env.FORGE_ULW_STUCK_THRESHOLD) ||
    config.goal.stuckThreshold ||
    5;

  const ulwDecision = evaluateUlwAtStop({
    sessionId: ctx.sessionId,
    lastAssistantMessage: input.lastAssistantMessage,
    editCount: input.editCount,
    openTodoCount: input.openTodoCount,
    stuckThreshold,
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
