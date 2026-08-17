/**
 * Built-in Stop guard — the harness that Grok Build is missing.
 *
 * Composes:
 *  1. User-defined Stop hooks (blocking)
 *  2. /goal relentless driver
 *  3. ULW cycle driver (cycle=1 loop / cycle=0 last-wave)
 *  4. TodoGate (open todos under ULW; soft once outside ULW)
 *  5. Ultrawork open-todos backstop
 *  6. Handoff guard — premature "let me know if…" / "shall I continue?" yields
 *  7. Proof-claim guard — "tests pass" / silent edits-without-verify (free triage)
 */
import type { ForgeConfig } from "../config/types.js";
import type { HookRunner, HookContext, HookResult } from "./hooks.js";
import { isFalsy } from "../util/bool.js";
import {
  evaluateGoalAtStop,
  loadGoal,
  type GoalDecision,
} from "./goal.js";
import { evaluateUlwAtStop, loadUlwCycle, type UlwStopDecision } from "./ulw-cycle.js";
import { evaluateTodoGateAtStop } from "./todo-gate.js";
import {
  evaluateHandoffAtStop,
  type HandoffStopDecision,
} from "./handoff-guard.js";
import {
  evaluateProofClaimAtStop,
  type ProofClaimStopDecision,
} from "./proof-claim-guard.js";
import { envPositiveInt } from "../util/env.js";
import { gitDiffFingerprint } from "../util/git-context.js";

export interface StopGuardInput {
  config: ForgeConfig;
  hooks: HookRunner;
  ctx: HookContext;
  ultrawork: boolean;
  openTodoCount: number;
  editCount: number;
  lastAssistantMessage: string;
  /** Latest user message (for advisory TodoGate release). */
  lastUserMessage?: string;
  /**
   * Structural proof signal: a verification command (test/typecheck/lint/build)
   * actually executed since the previous Stop evaluation. Gate = execution,
   * not judgment — the wave ledger trusts this over prose claims.
   */
  verificationRan?: boolean;
  /**
   * Successful structural verification only. Proof-claim + goal/ULW attestation
   * evidence prefer this so a red check cannot unlock "Done." / **Goal achieved.**
   */
  verificationPassed?: boolean;
  /** Only helper-only isolate checks ran this wave. */
  verificationHelperOnly?: boolean;
  /** Preferred project checks for handoff/proof-claim reanchor tips. */
  preferredCheckCommands?: string[];
  lastVerificationCommand?: string;
  lastVerificationStale?: boolean;
  /**
   * How many times handoff-guard already blocked this process turn streak.
   * After FORGE_HANDOFF_BLOCK_CAP (default 3) the guard releases.
   */
  handoffBlocks?: number;
  /**
   * How many times proof-claim guard already blocked this process turn streak.
   * After FORGE_PROOF_CLAIM_BLOCK_CAP (default 1) the guard releases.
   */
  proofClaimBlocks?: number;
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
  /** Handoff-guard decision when it evaluated (block or release). */
  handoff?: HandoffStopDecision;
  /** Proof-claim guard decision when it evaluated (block or release). */
  proofClaim?: ProofClaimStopDecision;
}

export async function runStopGuard(input: StopGuardInput): Promise<StopGuardResult> {
  const { config, hooks, ctx } = input;

  const goal = loadGoal(ctx.sessionId);
  const ulw = loadUlwCycle(ctx.sessionId);
  // Net-diff progress tracking (goal + ULW): bash-channel edits must count as
  // progress and edit→revert churn must not. Two cheap git calls, only when a
  // driver is actually armed — never on plain sessions' Stop path.
  const driverArmed =
    Boolean(ulw?.enabled) ||
    Boolean(
      goal && goal.objective && !goal.paused && goal.status === "active",
    );
  const diffFingerprint = driverArmed
    ? gitDiffFingerprint(ctx.workspaceRoot)
    : undefined;
  const hookCtx: HookContext = {
    ...ctx,
    goalObjective: goal?.objective,
    ultrawork: input.ultrawork || Boolean(ulw?.enabled),
    editCount: input.editCount,
    lastAssistantMessage: input.lastAssistantMessage,
    stopReason: "agent_end",
  };

  let hookResult: HookResult = { decision: "allow", blocked: false };
  // isFalsy: stringy "false"/"0" must strip block decisions (match doctor).
  if (!isFalsy(config.blockingStopHooks)) {
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
    verificationRan: input.verificationRan,
    verificationPassed: input.verificationPassed,
    preferredCheckCommands: input.preferredCheckCommands,
    diffFingerprint,
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
    verificationPassed: input.verificationPassed,
    verificationHelperOnly: input.verificationHelperOnly,
    preferredCheckCommands: input.preferredCheckCommands,
    diffFingerprint,
    cwd: ctx.workspaceRoot,
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
    lastUserMessage: input.lastUserMessage,
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
        `Continue the next unfinished item, or set /cycle 0 (finish this wave + one more, then LAST).`,
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

  // Handoff guard: block premature "let me know if…" / "shall I continue?" yields
  // so experts are not forced to re-steer mid-mandate (oh-my-kimi finish doctrine).
  const goalActive = Boolean(
    goal &&
      goal.objective &&
      !goal.paused &&
      goal.status !== "achieved" &&
      goal.status !== "cleared",
  );
  const handoffDecision = evaluateHandoffAtStop({
    lastAssistantMessage: input.lastAssistantMessage,
    lastUserMessage: input.lastUserMessage,
    ultrawork: Boolean(input.ultrawork || ulw?.enabled),
    goalActive,
    openTodoCount: input.openTodoCount,
    editCount: input.editCount,
    handoffBlocks: input.handoffBlocks,
    preferredCheckCommands: input.preferredCheckCommands,
  });
  if (handoffDecision.block) {
    return {
      allowStop: false,
      reason: handoffDecision.reason,
      additionalContext: handoffDecision.reanchor || handoffDecision.reason,
      systemMessage: handoffDecision.reason,
      hook: hookResult,
      goal: goalDecision,
      ulw: ulwDecision,
      handoff: handoffDecision,
    };
  }

  // Proof-claim guard: "tests pass" / "all green" without verificationRan.
  // Complements ULW proof-demand for goal-only and plain implementation turns.
  const proofClaimDecision = evaluateProofClaimAtStop({
    lastAssistantMessage: input.lastAssistantMessage,
    lastUserMessage: input.lastUserMessage,
    verificationRan: Boolean(
      input.verificationPassed ?? input.verificationRan,
    ),
    ultrawork: Boolean(input.ultrawork || ulw?.enabled),
    goalActive,
    openTodoCount: input.openTodoCount,
    editCount: input.editCount,
    proofClaimBlocks: input.proofClaimBlocks,
    preferredCheckCommands: input.preferredCheckCommands,
    lastVerificationCommand: input.lastVerificationCommand,
    lastVerificationStale: input.lastVerificationStale,
  });
  if (proofClaimDecision.block) {
    return {
      allowStop: false,
      reason: proofClaimDecision.reason,
      additionalContext:
        proofClaimDecision.reanchor || proofClaimDecision.reason,
      systemMessage: proofClaimDecision.reason,
      hook: hookResult,
      goal: goalDecision,
      ulw: ulwDecision,
      handoff:
        handoffDecision.detection?.handoff || handoffDecision.released
          ? handoffDecision
          : undefined,
      proofClaim: proofClaimDecision,
    };
  }

  return {
    allowStop: true,
    additionalContext: hookResult.additionalContext,
    systemMessage:
      (handoffDecision.released && handoffDecision.reason) ||
      (proofClaimDecision.released && proofClaimDecision.reason) ||
      hookResult.systemMessage,
    hook: hookResult,
    goal: goalDecision,
    ulw: ulwDecision,
    handoff: handoffDecision.detection?.handoff || handoffDecision.released
      ? handoffDecision
      : undefined,
    proofClaim:
      proofClaimDecision.detection?.claim || proofClaimDecision.released
        ? proofClaimDecision
        : undefined,
  };
}
