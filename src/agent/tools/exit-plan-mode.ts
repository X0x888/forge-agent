/**
 * Agent-callable plan-mode exit (Claude Code / grok-build ExitPlanMode).
 *
 * `/plan` is read-only research. Waiting for a human to type `/build` is a
 * steering tax. The model proposes a plan via this tool; interactive sessions
 * confirm, then the loop continues in the restored write mode.
 *
 * Headless: fail closed (stay in plan) unless the session entered plan from
 * bypassPermissions (`--yolo`). Subagents never get this tool.
 */
import type { ForgeConfig } from "../../config/types.js";
import {
  exitSessionPlanMode,
  saveSession,
  type SessionData,
} from "../../session/session.js";
import { pushLiveNotice } from "../../harness/live-notices.js";
import { toolAskUser } from "./ask-user.js";
import type { ToolResult } from "./types.js";

const PLAN_MAX = 8000;

export function isExitPlanModeToolName(name: string): boolean {
  const n = (name || "").trim();
  return n === "exit_plan_mode" || n === "ExitPlanMode" || n === "exitPlanMode";
}

function userApprovedImplement(answer: string): boolean {
  const t = answer.toLowerCase();
  if (
    t.includes("stay in plan") ||
    t.includes("declined") ||
    t.includes("timed out") ||
    t.includes("empty answer")
  ) {
    return false;
  }
  if (t.includes("implement now") || t.includes("option 1")) return true;
  return /\b(yes|y|ok|go|implement|build|proceed|do it)\b/.test(t);
}

export async function toolExitPlanMode(
  input: { plan?: string },
  ctx: { session?: SessionData; config?: ForgeConfig },
): Promise<ToolResult> {
  const session = ctx.session;
  const config = ctx.config;
  if (!session || !config) {
    return {
      output:
        "exit_plan_mode error: session/config unavailable. Stay in plan mode.",
      isError: true,
    };
  }
  if (config.permissionMode !== "plan") {
    return {
      output:
        "exit_plan_mode error: not in plan mode. Continue implementing, or /plan to re-enter.",
      isError: true,
    };
  }

  const plan = String(input.plan ?? "").trim();
  if (!plan) {
    return {
      output:
        "exit_plan_mode error: plan is required (non-empty summary of what you will implement).\n" +
        'Example: { "plan": "1. Add X\\n2. Test Y" }',
      isError: true,
    };
  }
  if (plan.length > PLAN_MAX) {
    return {
      output: `exit_plan_mode error: plan too long (max ${PLAN_MAX} chars).`,
      isError: true,
    };
  }

  // Auto-approve only when the user entered plan from yolo/bypass.
  // Plan mode itself is a confirmation gate; dontAsk is not enough.
  const fromYolo = session.meta.permissionModeBeforePlan === "bypassPermissions";
  if (!fromYolo) {
    const asked = await toolAskUser({
      question: "Leave plan mode and start implementing this plan?",
      choices: ["implement now", "stay in plan"],
      context: plan.slice(0, 500),
    });
    if (asked.isError || !userApprovedImplement(asked.output)) {
      return {
        output:
          "Staying in plan mode (implementation not approved).\n" +
          asked.output +
          "\nRefine the plan and call exit_plan_mode again, or wait for /build.",
        isError: true,
      };
    }
  }

  const previous = config.permissionMode;
  const { mode, wasPlan } = exitSessionPlanMode(config, session);
  if (wasPlan) {
    saveSession(session);
    pushLiveNotice(
      session.meta.id,
      `Mode ${previous} → ${mode} — implementing approved plan.`,
    );
  }

  return {
    output:
      `Plan approved. Left plan mode (now ${mode}, was ${previous}). ` +
      `Implement the plan now — do not wait for /build.\n\nApproved plan:\n${plan}`,
  };
}
