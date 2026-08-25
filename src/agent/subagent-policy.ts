/**
 * Nested-agent budgets, last-turn report-only, and typed parent Next.
 *
 * Explore/plan are information-gain (short cap). General-purpose is a work
 * unit (higher cap). Last turn is report-only. Incomplete children expose a
 * resume path instead of "do not re-spawn."
 */
import { envPositiveInt } from "../util/env.js";

export type SubagentBudgetType = "general-purpose" | "explore" | "plan";

export const DEFAULT_EXPLORE_MAX_TURNS = 25;
export const DEFAULT_PLAN_MAX_TURNS = 25;
export const DEFAULT_GP_MAX_TURNS = 80;
export const SUBAGENT_WRAP_FRACTION = 0.8;

export const SUBAGENT_WRAP_POKE = "[Forge system-reminder — wrap]";
export const SUBAGENT_LAST_TURN_POKE = "[Forge system-reminder — last turn]";
export const CITE_DELTA_PICK_POKE = "[Forge system-reminder — emit pick]";

function envIntIfSet(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(200, Math.floor(n));
}

/** Type-specific child turn cap. FORGE_SUBAGENT_MAX_TURNS overrides all types. */
export function defaultSubagentMaxTurns(
  type: SubagentBudgetType = "general-purpose",
): number {
  const global = envIntIfSet("FORGE_SUBAGENT_MAX_TURNS");
  if (global) return global;
  if (type === "explore") {
    return Math.min(
      200,
      envPositiveInt(
        "FORGE_SUBAGENT_EXPLORE_MAX_TURNS",
        DEFAULT_EXPLORE_MAX_TURNS,
      ),
    );
  }
  if (type === "plan") {
    return Math.min(
      200,
      envPositiveInt("FORGE_SUBAGENT_PLAN_MAX_TURNS", DEFAULT_PLAN_MAX_TURNS),
    );
  }
  return Math.min(
    200,
    envPositiveInt("FORGE_SUBAGENT_GP_MAX_TURNS", DEFAULT_GP_MAX_TURNS),
  );
}

/**
 * ~80% wrap poke. Null when the budget is too small to warn before last turn.
 */
export function subagentWrapTurn(maxTurns: number): number | null {
  if (!Number.isFinite(maxTurns) || maxTurns < 4) return null;
  const wrap = Math.max(1, Math.floor(maxTurns * SUBAGENT_WRAP_FRACTION));
  return wrap < maxTurns ? wrap : null;
}

export function formatSubagentWrapPoke(turns: number, maxTurns: number): string {
  const left = Math.max(0, maxTurns - turns);
  return (
    `${SUBAGENT_WRAP_POKE}\n` +
    `Turn budget ${turns}/${maxTurns} (~80%, ${left} left). ` +
    `Wrap, drop remaining scope, or start the structured report. ` +
    `The last turn is report-only (no new search/edit unless one citation is missing).`
  );
}

export function formatSubagentLastTurnPoke(maxTurns: number): string {
  return (
    `${SUBAGENT_LAST_TURN_POKE}\n` +
    `Turn budget exhausted next iteration (${maxTurns}/${maxTurns}). ` +
    `Emit the structured findings now (citations, ranked gaps, what you did not cover). ` +
    `Do not start a new search unless one citation is missing. ` +
    `New search/edit tools will not run this turn.`
  );
}

export function formatCiteDeltaPickPoke(): string {
  return (
    `${CITE_DELTA_PICK_POKE}\n` +
    `Cite-delta poke was followed by another search. Emit the map NOW — no new search:\n` +
    `pick: <one sentence naming the hole — required>\n` +
    `passed_on: <what you skipped>\n` +
    `files:\n` +
    `  <path>:<line>  <claim>\n` +
    `A file list without pick: is not a map.`
  );
}

const REPORT_ONLY_ALLOWED = new Set([
  "read_file",
  "Read",
  "read",
  "memory_write",
  "todo_write",
  "get_task_output",
  "mcp_resource",
  "mcp_prompt",
]);

/** New search/edit/spawn — skipped on last-turn / cite-delta report-only. */
export function isReportOnlyBlockedTool(name: string): boolean {
  const n = String(name || "").trim();
  if (!n) return true;
  if (REPORT_ONLY_ALLOWED.has(n)) return false;
  if (n.toLowerCase() === "read") return false;
  return true;
}

export function formatReportOnlySkip(
  name: string,
  kind: "last-turn" | "cite-delta",
): string {
  if (kind === "cite-delta") {
    return (
      `[Forge cite-delta] Map poke already sent. \`${name}\` was not run. ` +
      `Emit pick: / passed_on: / files: now. read_file is allowed if one citation is missing.`
    );
  }
  return (
    `[Forge last-turn] Report only. \`${name}\` was not run. ` +
    `Emit the structured findings now (citations, ranked gaps, what you did not cover). ` +
    `read_file is allowed if one citation is missing.`
  );
}

export function formatSubagentNext(opts: {
  status: string;
  subagentType: SubagentBudgetType | string;
  sessionId?: string;
  artifactPath?: string;
  worktreePath?: string;
  worktreeKept?: boolean;
}): string {
  const type = String(opts.subagentType || "general-purpose");
  const id = (opts.sessionId || "").trim();
  const artifact = (opts.artifactPath || "").trim();
  const wt =
    opts.worktreeKept && opts.worktreePath
      ? ` Kept worktree: ${opts.worktreePath}.`
      : "";

  if (opts.status === "skipped_explore_ledger") {
    return (
      "Spend or retire the open explore-map ships. This spawn was not a look."
    );
  }
  if (opts.status === "incomplete_max_turns" && type === "explore") {
    const resume = id
      ? ` spawn_subagent({ resume_session_id: "${id}" }) only if pick: is missing.`
      : "";
    return (
      `read_file the artifact${artifact ? ` (${artifact})` : ""} and use pick:. ` +
      `Do not start a new explore.` +
      resume
    );
  }
  if (opts.status === "incomplete_max_turns") {
    const resume = id
      ? ` spawn_subagent({ resume_session_id: "${id}" }) to continue this child.`
      : " Continue in the parent.";
    return resume + wt + " Do not start a new implementer from scratch.";
  }
  if (opts.status === "incomplete_cost_cap") {
    return (
      "Raise /budget or /budget off, then resume this child or finish in the parent." +
      wt
    );
  }
  if (opts.status === "aborted" || opts.status === "error") {
    return (
      (id
        ? `read_file the artifact${artifact ? ` (${artifact})` : ""}; resume_session_id="${id}" if the session was kept.`
        : "Finish remaining work in the parent.") + wt
    );
  }
  if (opts.status === "stop_hook_blocked") {
    return (
      "SubagentStop requested continue — resume this child or finish remaining work in the parent."
    );
  }
  if (artifact) {
    return `Child result is the brief — read_file ${artifact} if you need the full body.`;
  }
  return "";
}
