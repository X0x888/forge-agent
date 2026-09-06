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
  enterSessionPlanMode,
  exitSessionPlanMode,
  saveSession,
  type SessionData,
} from "../../session/session.js";
import { pushLiveNotice } from "../../harness/live-notices.js";
import { appendMemoryRecord } from "../../harness/decision-memory.js";
import {
  cycleActive,
  loadCycleState,
  requestReplan,
  setHumanPlan,
} from "../../harness/cycle/index.js";
import { toolAskUser } from "./ask-user.js";
import type { ToolResult } from "./types.js";

const PLAN_MAX = 8000;

export function isExitPlanModeToolName(name: string): boolean {
  const n = (name || "").trim();
  return n === "exit_plan_mode" || n === "ExitPlanMode" || n === "exitPlanMode";
}

export function isEnterPlanModeToolName(name: string): boolean {
  const n = (name || "").trim();
  return (
    n === "enter_plan_mode" || n === "EnterPlanMode" || n === "enterPlanMode"
  );
}

/**
 * Agent-callable plan-mode entry (grok-build enter_plan_mode).
 * Ambiguous / architectural work should pause writes without waiting for /plan.
 * Subagents never get this tool. No-op (not an error) if already in plan.
 */
export async function toolEnterPlanMode(
  input: { reason?: string },
  ctx: { session?: SessionData; config?: ForgeConfig },
): Promise<ToolResult> {
  const session = ctx.session;
  const config = ctx.config;
  if (!session || !config) {
    return {
      output:
        "enter_plan_mode error: session/config unavailable. Stay in the current mode.",
      isError: true,
    };
  }
  if (config.permissionMode === "plan") {
    return {
      output:
        "Already in plan mode. Research and design only; call exit_plan_mode when the plan is ready.",
    };
  }
  const reason = String(input.reason ?? "").trim();
  const previous = config.permissionMode;
  // Under ULW the executor does not research in-session: a fresh Planner
  // does. Entering plan mode is a request to close this cycle and re-plan.
  const cycle = loadCycleState(session.meta.id);
  if (cycle && cycleActive(cycle) && cycle.phase === "execute") {
    const r = requestReplan(session.meta.id);
    pushLiveNotice(session.meta.id, `enter_plan_mode under ULW → ${r.line}`);
    return {
      output:
        `ULW: re-plan requested${reason ? ` (${reason.slice(0, 160)})` : ""}. ` +
        `Finish or stop the item you are on; at the next Stop the cycle is reviewed, verified and committed, and a fresh Planner writes the next plan with your reason in front of it. Write tools stay available until then.`,
    };
  }
  enterSessionPlanMode(config, session);
  saveSession(session);
  pushLiveNotice(
    session.meta.id,
    `Mode ${previous} → plan` + (reason ? ` — ${reason.slice(0, 120)}` : ""),
  );
  return {
    output:
      `Entered plan mode (was ${previous}). Write tools are now denied. ` +
      `Research and produce a concrete plan, then call exit_plan_mode — do not wait for /plan or /build.` +
      (reason ? `\nReason: ${reason}` : ""),
  };
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

  const reading = /^\s*reading\s*:/i.test(plan) ? plan : `Reading: ${plan}`;
  try {
    appendMemoryRecord(session.meta.id, {
      kind: "decision",
      text: reading.slice(0, 800),
      source: "plan",
    });
  } catch {
    /* */
  }
  // A human /plan pause under ULW ends here: the harness Planner takes over
  // at the next boundary with this reading in decision memory.
  setHumanPlan(session.meta.id, false);

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
