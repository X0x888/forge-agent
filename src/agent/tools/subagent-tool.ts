/**
 * Model-facing spawn_subagent (Task) tool.
 */
import type { ToolContext, ToolResult } from "./types.js";
import {
  resolveCapabilityMode,
  resolveSubagentType,
  runSubagentTracked,
} from "../subagent.js";

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

  const prompt = String(args.prompt ?? args.task ?? args.message ?? "").trim();
  if (!prompt) {
    return {
      output:
        "spawn_subagent error: prompt is required (the task for the subagent).",
      isError: true,
    };
  }

  const description = String(
    args.description ?? args.summary ?? "",
  ).trim();
  const subagentType = resolveSubagentType(
    args.subagent_type ?? args.type ?? args.agent_type,
  );
  const capabilityMode = resolveCapabilityMode(
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

  try {
    const result = await ctx.runSubagent({
      prompt,
      description: description || undefined,
      subagentType,
      capabilityMode,
      maxTurns,
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
