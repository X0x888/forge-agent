/**
 * User controls over the cycle driver: arm, disarm, /cycle 0|1, /max-cycles,
 * /replan, human /plan pause. Every control writes the sidecar and returns
 * the line the REPL prints; none of them runs a role — the loop does that
 * at its next safe boundary.
 */
import { gitHeadSha } from "../../util/git-context.js";
import { clearSoftTodoGateOnWindDown } from "../todo-gate.js";
import {
  cycleActive,
  loadActiveCycle,
  loadCycleState,
  newCycleState,
  normalizeMaxCycles,
  saveCycleState,
  type CycleState,
} from "./state.js";

export const ULW_LIVE_CONTROLS_HINT =
  "Live: /cycle 0 (finish this cycle, then stop) · /cycle 1 (keep cycling) · /replan · /max-cycles N|off · /budget · /notify · /ulw-off";

/** Prompts that are a follow-up to a running session, not a mandate. */
const RESUME_FOLLOW_UP_RE =
  /^(?:continue|keep going|go on|resume|carry on|proceed|next|go|ok|okay|yes|y|do it|again|more)\b[.!]*$/i;

export function isResumeFollowUp(prompt: string): boolean {
  const t = (prompt || "").replace(/\s+/g, " ").trim();
  return !t || RESUME_FOLLOW_UP_RE.test(t);
}

/** `/ulw` with nothing after it, or a follow-up word, is case c: no mandate. */
export function mandateFromUserText(text: string): string | null {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || isResumeFollowUp(t)) return null;
  return t;
}

export function armCycle(opts: {
  sessionId: string;
  mandate: string | null;
  cwd: string;
  maxCycles?: number | null;
}): CycleState {
  const prev = loadCycleState(opts.sessionId);
  const head = gitHeadSha(opts.cwd);
  const s = newCycleState({
    sessionId: opts.sessionId,
    mandate: opts.mandate,
    maxCycles: opts.maxCycles ?? null,
    runStartHead: head,
  });
  // A re-arm on the same session keeps the identity the run already learned.
  if (prev && !prev.legacy && prev.identity) s.identity = prev.identity;
  saveCycleState(s);
  clearSoftTodoGateOnWindDown(opts.sessionId);
  return s;
}

export function disarmCycle(sessionId: string): CycleState | null {
  const s = loadCycleState(sessionId);
  if (!s) return null;
  s.enabled = false;
  s.phase = "released";
  s.endReason = "disarmed";
  saveCycleState(s);
  clearSoftTodoGateOnWindDown(sessionId);
  return s;
}

/**
 * /cycle 0 — finish the open cycle (execute → review → verify → commit), then
 * stop. /cycle 1 — keep re-planning after each commit.
 */
export function setCycleFlag(sessionId: string, flag: 0 | 1): { ok: boolean; line: string } {
  const s = loadActiveCycle(sessionId);
  if (!s) {
    return { ok: false, line: "ULW is not armed — /ulw [mandate] arms it." };
  }
  s.cycleZeroRequested = flag === 0;
  saveCycleState(s);
  if (flag === 0) {
    const where =
      s.phase === "plan" && s.cycle === 0
        ? "no cycle has started yet — the run stops after the first plan is written"
        : s.phase === "execute"
          ? `cycle ${s.cycle} finishes its ${s.items.filter((i) => i.status === "open").length} open item(s), is reviewed and committed, then the run stops`
          : `cycle ${s.cycle} finishes ${s.phase}, commits, then the run stops`;
    return { ok: true, line: `ULW /cycle 0 — ${where}. /cycle 1 resumes cycling; /ulw-off aborts.` };
  }
  return { ok: true, line: `ULW /cycle 1 — the run re-plans after each committed cycle until the Planner says fulfilled.` };
}

export function requestReplan(sessionId: string): { ok: boolean; line: string } {
  const s = loadActiveCycle(sessionId);
  if (!s) return { ok: false, line: "ULW is not armed." };
  if (s.phase !== "execute") {
    return { ok: false, line: `ULW is in ${s.phase}; /replan applies while a plan is executing.` };
  }
  s.replanRequested = true;
  saveCycleState(s);
  return {
    ok: true,
    line: `ULW /replan — cycle ${s.cycle} closes at the next Stop: review, verify, commit, then a fresh plan.`,
  };
}

export function setMaxCycles(sessionId: string, raw: number | null): { ok: boolean; line: string } {
  const s = loadActiveCycle(sessionId);
  if (!s) return { ok: false, line: "ULW is not armed — /ulw [mandate] arms it." };
  const n = normalizeMaxCycles(raw);
  s.maxCycles = n;
  saveCycleState(s);
  if (n == null) return { ok: true, line: "ULW max_cycles cleared — unlimited until fulfilled or /cycle 0." };
  if (s.cycle >= n) {
    return {
      ok: true,
      line: `ULW max_cycles ${n} — already at cycle ${s.cycle}; this cycle is the last (review, commit, stop).`,
    };
  }
  return { ok: true, line: `ULW max_cycles ${n} — the run stops after cycle ${n} is committed.` };
}

/** User `/plan`: the harness Planner stands down; `/build` hands it back. */
export function setHumanPlan(sessionId: string, on: boolean): void {
  const s = loadActiveCycle(sessionId);
  if (!s) return;
  s.humanPlan = on;
  if (!on && s.phase === "plan") {
    // /build with no plan on disk: the next boundary runs the Planner.
  }
  saveCycleState(s);
}

/** Cost / turn caps: finish the open cycle on resume instead of re-blocking. */
export function requestCycleZeroOnSafetyValve(sessionId: string): boolean {
  const s = loadActiveCycle(sessionId);
  if (!s) return false;
  if (s.cycleZeroRequested) return false;
  s.cycleZeroRequested = true;
  saveCycleState(s);
  return true;
}

/**
 * Unlimited cycling blocks one Stop per wave by design; those blocks must not
 * trip the process-level continue cap. A capped run or a /cycle 0 wrap still
 * fuses (they end on their own).
 */
export function stopBlockTripsContinueCap(s: CycleState | null | undefined): boolean {
  if (!s || !cycleActive(s)) return true;
  if (s.cycleZeroRequested) return true;
  return s.maxCycles != null;
}

/**
 * Length / empty / content_filter fuse. Independent of the Stop-block tally
 * so a long run does not make the next truncated completion trip the cap.
 */
export function providerFuseTripsContinueCap(
  providerContinues: number,
  maxStopContinues: number,
): boolean {
  if (!Number.isFinite(providerContinues) || !Number.isFinite(maxStopContinues)) {
    return false;
  }
  if (maxStopContinues <= 0) return false;
  return providerContinues > maxStopContinues;
}

/** Declared checks first (the Planner's `Verify:`), then the stack table. */
export function cyclePreferredCheckCommands(
  sessionId: string | undefined,
  base?: string[],
): string[] | undefined {
  if (!sessionId) return base;
  const s = loadActiveCycle(sessionId);
  const declared = s ? s.declaredChecks : [];
  if (!declared.length) return base;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of [...declared, ...(base || [])]) {
    const t = String(c || "").replace(/\s+/g, " ").trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.length ? out : base;
}

/** Paths request-prune must never stub while a plan is executing. */
export function cycleKeepPaths(sessionId: string | undefined): string[] | undefined {
  if (!sessionId) return undefined;
  const s = loadActiveCycle(sessionId);
  if (!s) return undefined;
  const out = new Set<string>();
  for (const i of s.items) for (const f of i.files) if (f) out.add(f);
  return out.size ? [...out] : undefined;
}

export function parseCycleArg(raw: string): 0 | 1 | "status" | null {
  const t = (raw || "").trim().toLowerCase();
  if (!t || t === "status" || t === "show") return "status";
  if (t === "0" || t === "off" || t === "last" || t === "finish" || t === "stop") return 0;
  if (t === "1" || t === "on" || t === "continue" || t === "go") return 1;
  return null;
}

export function parseMaxCyclesArg(raw: string): number | null | "status" | undefined {
  const t = (raw || "").trim().toLowerCase();
  if (!t || t === "status" || t === "show") return "status";
  if (t === "off" || t === "none" || t === "clear" || t === "unlimited" || t === "0") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}
