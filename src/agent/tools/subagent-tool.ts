/**
 * Model-facing spawn_subagent (Task) tool.
 */
import type { ToolContext, ToolResult } from "./types.js";
import {
  resolveCapabilityMode,
  resolveSpawnSubagentType,
  resolveSubagentType,
  runSubagentTracked,
} from "../subagent.js";
import {
  defaultIsolationForSpawn,
  isolationArgFromSpawn,
} from "../worktree.js";

export { isolationArgFromSpawn };

export async function toolSpawnSubagent(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.runSubagent) {
    return {
      output:
        "spawn_subagent error: subagents are not available in this context " +
        "(nested depth limit, or unit-test tool harness without a runner).",
      isError: true,
    };
  }

  const resumeSessionId = String(
    args.resume_session_id ?? args.resume_from ?? args.resumeSessionId ?? "",
  ).trim();
  const prompt = String(args.prompt ?? args.task ?? args.message ?? "").trim();
  if (!prompt && !resumeSessionId) {
    return {
      output:
        "spawn_subagent error: prompt is required (the task for the subagent). " +
        "To continue an incomplete child, pass resume_session_id.",
      isError: true,
    };
  }

  const description = String(
    args.description ?? args.summary ?? "",
  ).trim();
  const subagentType = resolveSpawnSubagentType(
    args.subagent_type ?? args.type ?? args.agent_type,
    {
      planMode: ctx.config?.permissionMode === "plan",
      ulwOrient: ctx.ulwPhase === "orient",
      ulwLastReflectScore: ctx.ulwLastReflectScore,
    },
  );
  const capabilityMode =
    ctx.config?.permissionMode === "plan"
      ? "read-only"
      : resolveCapabilityMode(
          subagentType,
          args.capability_mode ?? args.mode ?? args.capability,
        );

  let maxTurns: number | undefined;
  if (args.max_turns != null && String(args.max_turns).trim() !== "") {
    const n = Number(args.max_turns);
    if (!Number.isFinite(n) || n < 1) {
      return {
        output:
          "spawn_subagent error: max_turns must be a positive integer.",
        isError: true,
      };
    }
    maxTurns = Math.min(200, Math.floor(n));
  }

  const isolationRaw = isolationArgFromSpawn(args);
  const isolation =
    isolationRaw === undefined
      ? defaultIsolationForSpawn({
          type: subagentType,
          workspace: ctx.workspace,
        })
      : defaultIsolationForSpawn({
          type: subagentType,
          isolation: isolationRaw,
          workspace: ctx.workspace,
        });

  try {
    const result = await ctx.runSubagent({
      prompt,
      description: description || undefined,
      subagentType,
      capabilityMode,
      maxTurns,
      isolation,
      resumeSessionId: resumeSessionId || undefined,
    });
    return {
      output: result.error && !result.text
        ? result.error
        : result.text,
      isError: Boolean(result.error && !result.ok),
    };
  } catch (err) {
    return {
      output: `spawn_subagent error: ${(err as Error).message}`,
      isError: true,
    };
  }
}

// re-export helpers used by permissions
export { resolveSubagentType, resolveCapabilityMode, runSubagentTracked };
