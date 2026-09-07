/**
 * Two-turn role runs — the doctrine enforced by sequence.
 *
 * The harness cannot judge a plan's taste; it can decide what a role reads
 * before what. The Planner's first turn (the scout) has the product and no
 * record, so "use it before you read a line of source" is a fact of the
 * transcript and not an instruction the model may skim past; the Reviewer's
 * first turn (the look) has the product and no diff, so `Worth:` is judged
 * from what a user meets and not from the diff's effort. The second turn
 * resumes the same kept session — the role that used the product is the one
 * that writes the document — and a parse retry re-enters only that second
 * turn, so strictness in the contract costs a short turn, not a re-scout.
 *
 * Every failure of the mechanism falls back to the single brief the roles
 * ran on before: two turns off (`FORGE_ULW_TWO_TURN=0`), a runtime that
 * does not keep sessions, a resume that errors. Nothing here releases a run.
 */
import { envPositiveInt } from "../../util/env.js";
import type { CycleRole, CycleRuntime, RoleRunResult } from "./orchestrator.js";

export function twoTurnEnabled(): boolean {
  return process.env.FORGE_ULW_TWO_TURN !== "0";
}

/** Turn budget for the Planner's plan turn: the scouting is done, the document remains. */
export function plannerPlanTurns(): number {
  return envPositiveInt("FORGE_ULW_PLANNER_PLAN_TURNS", 0) || 12;
}

/** Turn budget for the Reviewer's look turn: build, run, open, write what was seen. */
export function reviewerLookTurns(): number {
  return envPositiveInt("FORGE_ULW_REVIEWER_LOOK_TURNS", 0) || 15;
}

export interface TwoTurnOptions {
  cycle: number;
  /** Turn 1: the product, no history. */
  firstBrief: string;
  /** Turn 2, given turn 1's document: the history, the contract. */
  secondBrief: (firstText: string) => string;
  /** One message for both, given whatever turn 1 produced (may be empty). */
  singleBrief: (firstText: string) => string;
  firstMaxTurns?: number;
  secondMaxTurns?: number;
}

export interface TwoTurnResult {
  /** Turn 1's run; absent in single mode. */
  first?: RoleRunResult;
  /** The run that produced the document (turn 2, or the single brief). */
  second: RoleRunResult;
  mode: "two-turn" | "single";
  /** The kept session, for a retry of turn 2 and for the caller's cleanup. */
  sessionId?: string;
}

/** Strip the subagent result header so the artifact is the document alone. */
export function roleBody(text: string): string {
  const t = String(text || "");
  const idx = t.search(/^\s*(?:#\s*Cycle\s+\d+\s+(?:plan|review|scout|look)\b|Verdict\s*:|Identity\s*:|Looked\s*:)/im);
  return idx > 0 ? t.slice(idx).replace(/^\s+/, "") : t;
}

function tokensOf(r: RoleRunResult | undefined): number {
  return r ? r.promptTokens + r.completionTokens : 0;
}

/**
 * What a role run cost. A resumed turn reports the child session's
 * cumulative usage (turn 1 included), so two turns on one session are the
 * larger figure, not the sum; a single-brief fallback ran on its own session
 * and adds to whatever turn 1 spent.
 */
export function roleTokens(tt: TwoTurnResult, ...again: RoleRunResult[]): number {
  if (tt.mode === "two-turn") {
    return Math.max(tokensOf(tt.first), tokensOf(tt.second), ...again.map(tokensOf));
  }
  return tokensOf(tt.first) + tokensOf(tt.second) + again.reduce((n, r) => n + tokensOf(r), 0);
}

export async function runRoleTwoTurn(
  rt: CycleRuntime,
  role: CycleRole,
  opts: TwoTurnOptions,
): Promise<TwoTurnResult> {
  if (!twoTurnEnabled()) {
    const second = await rt.runRole(role, opts.singleBrief(""), { cycle: opts.cycle });
    return { second, mode: "single" };
  }
  const first = await safeRun(rt, role, opts.firstBrief, {
    cycle: opts.cycle,
    keepSession: true,
    ...(opts.firstMaxTurns ? { maxTurns: opts.firstMaxTurns } : {}),
  });
  const firstText = roleBody(first.text);
  if (!first.sessionId) {
    // The runtime did not keep the session (a fake, an older loop): one
    // message carries both, with whatever turn 1 saw.
    const second = await rt.runRole(role, opts.singleBrief(firstText), { cycle: opts.cycle });
    return { first, second, mode: "single" };
  }
  const second = await safeRun(rt, role, opts.secondBrief(firstText), {
    cycle: opts.cycle,
    resumeSessionId: first.sessionId,
    keepSession: true,
    ...(opts.secondMaxTurns ? { maxTurns: opts.secondMaxTurns } : {}),
  });
  if (!second.ok && !second.text.trim()) {
    // The resume itself failed (session gone, provider error before a word):
    // a fresh single run with the scout inlined, never a release.
    await safeCleanup(rt, first.sessionId);
    const single = await rt.runRole(role, opts.singleBrief(firstText), { cycle: opts.cycle });
    return { first, second: single, mode: "single" };
  }
  return { first, second, mode: "two-turn", sessionId: first.sessionId };
}

/** Re-enter a kept role session for one more document turn (a parse retry). */
export async function runRoleTurnAgain(
  rt: CycleRuntime,
  role: CycleRole,
  sessionId: string,
  brief: string,
  opts: { cycle: number; maxTurns?: number },
): Promise<RoleRunResult> {
  return safeRun(rt, role, brief, {
    cycle: opts.cycle,
    resumeSessionId: sessionId,
    keepSession: true,
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
  });
}

export async function safeCleanup(rt: CycleRuntime, sessionId: string | undefined): Promise<void> {
  if (!sessionId || !rt.cleanupRoleSession) return;
  try {
    await rt.cleanupRoleSession(sessionId);
  } catch {
    /* a kept session that could not be removed is a stray file, not a failed cycle */
  }
}

async function safeRun(
  rt: CycleRuntime,
  role: CycleRole,
  brief: string,
  o: Parameters<CycleRuntime["runRole"]>[2],
): Promise<RoleRunResult> {
  try {
    return await rt.runRole(role, brief, o);
  } catch (err) {
    return {
      ok: false,
      text: "",
      status: "error",
      promptTokens: 0,
      completionTokens: 0,
      editCount: 0,
      error: (err as Error).message,
    };
  }
}
