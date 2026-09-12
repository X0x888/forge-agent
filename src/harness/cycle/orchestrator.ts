/**
 * Cycle orchestrator — performs the action the machine chose.
 *
 * The runtime is injected: the loop supplies subagent spawning, the check
 * runner, git, the todo board and the transcript admit; tests supply fakes.
 * Every step leaves an artifact (plan.md, review.md, verify.log) under the
 * session's cycles/ directory, so the next Planner and the user read the
 * same record.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ensureSessionLookProfile,
  reapSessionBrowsers,
} from "../../agent/browser-lease.js";
import { loadSession } from "../../session/session.js";
import { janitorBackgroundTasks } from "../../agent/tools/background-tasks.js";
import { getActiveMcpManager, MCP_PREWARM_ADMIT_WAIT_MS } from "../../mcp/manager.js";
import { isFalsy } from "../../util/bool.js";
import { nowIso } from "../../util/fs.js";
import { ensureGitRepo } from "../../util/git-ensure.js";
import { envPositiveInt } from "../../util/env.js";
import { appendMemoryRecord } from "../decision-memory.js";
import type { AutoCommitResult } from "../../util/git-auto-commit.js";
import { appendRoleRunLine } from "../../session/subagent-usage.js";
import {
  architectureHoldMessage,
  explainPlanParseFailure,
  extractDisputeLines,
  extractSerendipityLines,
  isSurfaceSit,
  lookCouldNotLook,
  parseLookArtifact,
  parsePlanArtifact,
  parseReviewArtifact,
  parseScoutArtifact,
  lookInfraFailed,
  planAddressesArchitectureClass,
  planArtifactContract,
  planCollapsesArchitectureClass,
  recurringArchitectureClass,
  architectureClassMustCollapse,
  type ParsedPlan,
  type ParsedScout,
} from "./artifacts.js";
import {
  buildPlannerBrief,
  buildPlannerPlanBrief,
  buildPlannerScoutBrief,
  buildReviewerBrief,
  buildReviewerLookBrief,
  buildReviewerReviewBrief,
  formatFixReanchor,
  formatItemsOpenReanchor,
  formatPlanAdmission,
  runSpend,
  type PlannerPlanInput,
  type ReviewerBriefInput,
  type ReviewNotesForExecutor,
} from "./briefs.js";
import { decideAtStop, syncItemsFromTodos, type CycleAction, type StopFacts } from "./machine.js";
import {
  plannerPlanTurns,
  reviewerLookTurns,
  roleBody,
  roleTokens,
  runRoleTurnAgain,
  runRoleTwoTurn,
  safeCleanup,
  type TwoTurnResult,
} from "./roles.js";
import {
  adoptLiveControls,
  currentCycleAlreadyClosed,
  currentCycleRecord,
  cycleActive,
  ensureCycleArtifactsDir,
  loadActiveCycle,
  openItems,
  saveCycleState,
  type CycleEndReason,
  type CyclePlanItem,
  type CyclePromise,
  type CycleRecord,
  type CycleReviewNotes,
  type CycleState,
} from "./state.js";
import { judgeAgainstBaseline, type CheckRun, type GateVerdict } from "./verify.js";
import {
  isFullSuiteCommand,
  isIsolateTestCommand,
  isTypecheckCommand,
} from "../verification.js";

export type CycleRole = "planner" | "reviewer";

export interface RoleRunResult {
  ok: boolean;
  text: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  editCount: number;
  error?: string;
  /** The child session, when the runtime kept it for a second turn. */
  sessionId?: string;
}

export interface RoleRunOptions {
  cycle: number;
  /** Continue the role's kept session with this brief as its second turn. */
  resumeSessionId?: string;
  /** Keep the session after this turn so a second turn can resume it. */
  keepSession?: boolean;
  /** Turn budget for this turn (a role's default otherwise). */
  maxTurns?: number;
  /** Every turn is report-only: emit the document, do not explore (the plan turn). */
  documentOnly?: boolean;
}

export interface CycleRuntime {
  workspace: string;
  runRole(role: CycleRole, brief: string, opts: RoleRunOptions): Promise<RoleRunResult>;
  /** Remove a role session the harness asked to keep, once its second turn is done. */
  cleanupRoleSession?(sessionId: string): Promise<void>;
  runCheck(command: string): Promise<CheckRun>;
  /**
   * The gate's verdict on a run the harness made — what the run-level
   * verification totals should count (green vs baseline is a pass even
   * when the exit code is not 0).
   */
  creditCheck?(run: CheckRun, passed: boolean): void;
  commit(opts: { subject: string; body: string; sessionId?: string }): AutoCommitResult;
  /** Replace the executor's board with the plan items (id = item id). */
  seedTodos(items: CyclePlanItem[]): void;
  todos(): ReadonlyArray<{ id: string; status: string }>;
  /** Push a synthetic `[Forge …]` user message onto the transcript. */
  admit(text: string): void;
  gitHead(): string | null;
  gitDiffSince(head: string | null): { diff: string; files: string[]; truncated: boolean };
  gitLogSince(head: string | null): string;
  gitStatus(): string;
  /** Exact repository-root cleanliness, including untracked files; null if unknown. */
  gitIsClean?(): boolean | null;
  userMessagesSince(iso: string): string[];
  guidelineSurvey(): string;
  projectChecks(): string[];
  /** Persist the product identity outside the session (project memory). */
  rememberIdentity?(text: string): void;
  /** Persist the product's promises as last inspected (project memory), beside the identity. */
  rememberPromises?(promises: CyclePromise[]): void;
  log?(line: string): void;
}

export interface CycleStopOutcome {
  /** True when the turn may end (released, or yielded to a human /plan). */
  allowStop: boolean;
  /** True when the run is over (ULW disarmed). */
  released: boolean;
  endReason?: CycleEndReason;
  /** Injected as the next user message when the Stop is blocked. */
  reanchor?: string;
  /** One line for the log / stop card. */
  reason: string;
  planAdmitted?: boolean;
  cycleClosed?: boolean;
  committed?: { sha?: string; subject?: string; skipped?: string };
  /** Facts for the loop's proof accounting: the cycle's ledger row was written. */
  waveStamped: boolean;
  phase: CycleState["phase"];
}

export const FIX_ROUNDS_DEFAULT = 3;

export function fixRoundsCap(configured?: number): number {
  const env = envPositiveInt("FORGE_ULW_FIX_ROUNDS", 0);
  if (env > 0) return env;
  return configured && configured > 0 ? configured : FIX_ROUNDS_DEFAULT;
}

export function stuckThresholdDefault(configured?: number): number {
  const env = envPositiveInt("FORGE_ULW_STUCK_THRESHOLD", 0);
  if (env > 0) return env;
  return configured && configured > 0 ? configured : 4;
}

function writeArtifact(sessionId: string, cycle: number, name: string, text: string): string {
  const dir = ensureCycleArtifactsDir(sessionId, cycle);
  const file = path.join(dir, name);
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

function readArtifact(file: string | undefined): string {
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function release(s: CycleState, reason: CycleEndReason, line: string): CycleStopOutcome {
  s.enabled = false;
  s.phase = "released";
  s.endReason = reason;
  saveCycleState(s);
  reapRunResources(s);
  return {
    allowStop: true,
    released: true,
    endReason: reason,
    reason: line,
    waveStamped: false,
    phase: s.phase,
  };
}

function reapRunResources(s: CycleState): void {
  let workspace: string | undefined;
  try {
    workspace = loadSession(s.sessionId)?.meta.cwd;
  } catch {
    /* */
  }
  safe(() => reapSessionBrowsers(s.sessionId, { workspace }), { killed: 0, removed: [] });
}

function closedCycleHow(s: CycleState): string {
  const rec = currentCycleRecord(s);
  if (rec?.commitSha) return ` and committed (${rec.commitSha})`;
  if (rec?.endedAt) return " (not committed)";
  return "";
}

/**
 * `/ulw-off` (or any disk release) while the orchestrator held an armed copy.
 * Live-control writes win; a harness release in memory is not revived.
 */
function ifUserDisarmed(s: CycleState): CycleStopOutcome | null {
  adoptLiveControls(s);
  if (cycleActive(s)) return null;
  saveCycleState(s);
  reapRunResources(s);
  const reason = s.endReason ?? "disarmed";
  return {
    allowStop: true,
    released: true,
    endReason: reason,
    reason: reason === "disarmed" ? "ULW released — /ulw-off." : `ULW released (${reason}).`,
    waveStamped: false,
    phase: s.phase,
  };
}

/**
 * After a Planner (or before admitting one): the previous cycle may already
 * have closed. `/cycle 0` / `max_cycles` then stop without starting another;
 * `/ulw-off` aborts; `/plan` yields. A first plan (cycle 0, nothing closed)
 * is still admitted so `/cycle 0` means "that plan is the last".
 */
function stopBeforeAdmittingNextPlan(s: CycleState): CycleStopOutcome | null {
  const disarmed = ifUserDisarmed(s);
  if (disarmed) return disarmed;
  if (s.humanPlan) {
    saveCycleState(s);
    return {
      allowStop: true,
      released: false,
      reason: "ULW armed — the user owns planning (/plan); /build hands it back to the harness Planner.",
      waveStamped: false,
      phase: s.phase,
    };
  }
  if (!currentCycleAlreadyClosed(s)) return null;
  const how = closedCycleHow(s);
  if (s.cycleZeroRequested) {
    return {
      ...release(s, "cycle-zero", `/cycle 0 — cycle ${s.cycle} reviewed${how}; ULW released.`),
      cycleClosed: true,
    };
  }
  if (s.maxCycles != null && s.cycle >= s.maxCycles) {
    return {
      ...release(
        s,
        "max-cycles",
        `max_cycles ${s.maxCycles} reached — cycle ${s.cycle} reviewed${how}; ULW released.`,
      ),
      cycleClosed: true,
    };
  }
  return null;
}

/** The Planner's turn-1 document, kept beside the plan as evidence it was written before the record. */
interface ScoutResult {
  raw: string;
  parsed: ParsedScout | null;
  path: string;
}

function planRecord(
  s: CycleState,
  plan: ParsedPlan,
  planPath: string,
  plannerTokens: number,
  scout?: ScoutResult,
): CycleRecord {
  return {
    n: s.cycle,
    title: plan.title,
    direction: plan.direction,
    looked: plan.looked ?? scout?.parsed?.looked,
    ...(scout ? { scoutPath: scout.path } : {}),
    ...(plan.considered.length ? { considered: plan.considered } : scout?.parsed?.considered.length ? { considered: scout.parsed.considered } : {}),
    ...(plan.worthClaim ? { worthClaim: plan.worthClaim } : {}),
    startedAt: nowIso(),
    planPath,
    planVerdict: plan.verdict,
    itemsTotal: s.items.length,
    itemsDone: 0,
    waves: 0,
    verifyCommand: s.verifyCommand,
    mustFix: [],
    plannerTokens,
  };
}

/**
 * Run the Planner in two turns — the scout with the product and no record,
 * then the plan with the record — and parse what came back. A plan that does
 * not parse is retried once: on the kept session as one more document turn
 * (the scouting stands), or as a fresh single brief when there is no session.
 */
async function runPlanner(
  s: CycleState,
  rt: CycleRuntime,
): Promise<
  | { plan: ParsedPlan; raw: string; tokens: number; scout?: ScoutResult }
  | { error: string; raw: string; tokens: number; scout?: ScoutResult; mustFix?: string[] }
> {
  const lastPlanAt = currentCycleRecord(s)?.startedAt ?? s.startedAt;
  const next = s.cycle + 1;
  // Older records (before direction/worth were stamped) read them back from
  // the artifacts so a resumed run gets the same ledger.
  for (const c of s.cycles) {
    if (!c.direction && c.planPath) {
      const p = parsePlanArtifact(readArtifact(c.planPath));
      if (p) {
        c.direction = p.direction;
        c.looked = p.looked;
      }
    }
    if (c.worth === undefined && !c.architecture && c.reviewPath) {
      const r = parseReviewArtifact(readArtifact(c.reviewPath));
      if (r) {
        c.architecture = r.architecture;
        c.worth = r.worth;
      }
    }
  }
  const gitStatus = safe(() => rt.gitStatus(), "");
  const projectChecks = safe(() => rt.projectChecks(), []);
  const planInput: Omit<PlannerPlanInput, "scoutText"> = {
    state: s,
    workspace: rt.workspace,
    gitLog: safe(() => rt.gitLogSince(s.runStartHead), ""),
    gitStatus,
    guidelineSurvey: safe(() => rt.guidelineSurvey(), ""),
    projectChecks,
    userMessages: safe(() => rt.userMessagesSince(lastPlanAt), []),
    spend: runSpend(s),
  };
  const tt = await runRoleTwoTurn(rt, "planner", {
    cycle: next,
    firstBrief: buildPlannerScoutBrief({
      state: s,
      workspace: rt.workspace,
      gitStatus,
      projectChecks,
      lookProfileUdd: sessionLookProfile(s.sessionId, rt.workspace),
    }),
    secondBrief: (scoutText) => buildPlannerPlanBrief({ ...planInput, scoutText }),
    singleBrief: (scoutText) => buildPlannerBrief({ ...planInput, ...(scoutText.trim() ? { scoutText } : {}) }),
    secondMaxTurns: plannerPlanTurns(),
    // The plan turn is prose: the scouting is done, so it emits the plan and
    // does not re-enter reading (that is how cycle 3 burned 60 turns and died).
    secondDocumentOnly: true,
  });
  let tokens = roleTokens(tt);
  adoptLiveControls(s);
  if (s.cycleZeroRequested && currentCycleAlreadyClosed(s)) {
    await persistAndCleanupRole(s.sessionId, "planner", rt, tt);
    return { error: "cycle-zero", raw: "", tokens };
  }
  let scout: ScoutResult | undefined;
  const scoutRaw = tt.first ? roleBody(tt.first.text) : "";
  if (scoutRaw.trim()) {
    scout = {
      raw: scoutRaw,
      parsed: parseScoutArtifact(scoutRaw),
      path: writeArtifact(s.sessionId, next, "scout.md", scoutRaw),
    };
  }
  let raw = roleBody(tt.second.text);
  if (!tt.second.ok && !raw.trim()) {
    await persistAndCleanupRole(s.sessionId, "planner", rt, tt);
    return { error: tt.second.error || `planner ${tt.second.status}`, raw, tokens, scout };
  }
  let plan = parsePlanArtifact(raw);
  let hold = continueArchitectureHold(s, plan);
  if (!plan || hold) {
    // One retry, with what was missing named (presence and shape, never intent).
    const why =
      hold ||
      explainPlanParseFailure(raw) ||
      "no `Verdict:` line, or `Verdict: continue` with an empty `Items:` list";
    const note = hold
      ? `[Forge] ${why}. Write the plan again and end with the contract exactly:\n${planArtifactContract(next)}`
      : `[Forge] Your previous plan did not parse: ${why}. Write the plan again and end with the contract exactly:\n${planArtifactContract(next)}`;
    const again =
      tt.mode === "two-turn" && tt.sessionId
        ? await runRoleTurnAgain(rt, "planner", tt.sessionId, note, { cycle: next, maxTurns: plannerPlanTurns(), documentOnly: true })
        : await rt.runRole("planner", `${buildPlannerBrief({ ...planInput, ...(scoutRaw.trim() ? { scoutText: scoutRaw } : {}) })}\n\n${note}`, { cycle: next });
    tokens = roleTokens(tt, again);
    const againRaw = roleBody(again.text);
    if (againRaw.trim()) raw = againRaw;
    plan = parsePlanArtifact(againRaw);
    hold = continueArchitectureHold(s, plan);
    if (hold) {
      await persistAndCleanupRole(s.sessionId, "planner", rt, tt, again);
      return { error: hold, raw, tokens, scout, mustFix: [hold] };
    }
  }
  await persistAndCleanupRole(s.sessionId, "planner", rt, tt);
  if (!plan) {
    const clsHold = classHoldMessage(s);
    return {
      error: "planner produced no parseable plan after a retry",
      raw,
      tokens,
      scout,
      ...(clsHold ? { mustFix: [clsHold] } : {}),
    };
  }
  return { plan, raw, tokens, scout };
}

/** The no-progress wall: consecutive synthesized cycles that never commit. */
function noProgressCap(): number {
  return envPositiveInt("FORGE_ULW_NO_PROGRESS_CAP", 0) || 3;
}

/** Consecutive synthesized cycles, even ones that committed. Default 2. */
function synthCap(): number {
  return envPositiveInt("FORGE_ULW_SYNTH_CAP", 0) || 2;
}

/**
 * A plan the harness writes when the model tries to stop working on an
 * unlimited run — because its Planner could not converge, or because it
 * declared a no-mandate product "done." The unit of work is handed to the
 * executor (which can edit). Further investigation still owes evidence of
 * a worthwhile change; an unlimited run does not require invented defects.
 */
function synthesizeWorkPlan(
  s: CycleState,
  scout: ScoutResult | undefined,
  kind: "no-plan" | "keep-promise" | "go-deeper",
  opts?: { targets?: CyclePromise[]; mustFix?: string[] },
): { plan: ParsedPlan; raw: string; mustFix: string[] } {
  const promises = s.promises ?? scout?.parsed?.promises ?? [];
  const unkept = (opts?.targets?.length ? opts.targets : promises.filter((p) => p.state !== "kept"));
  const considered = scout?.parsed?.considered ?? [];
  const looked = scout?.parsed?.looked ?? "";

  let title: string;
  let direction: string;
  let items: CyclePlanItem[];
  if (kind === "keep-promise" && unkept.length) {
    title = "Keep the promises still broken or unverified";
    direction =
      "The inventory contains broken, absent, or unverified promises. Reproduce confirmed gaps and repair them; investigate unknown promises before deciding whether a change is needed. Preserve working behavior.";
    items = unkept.slice(0, 5).map((p, i) => ({
      id: `i${i + 1}`,
      title: `${p.state === "unknown" ? "Investigate the promise" : "Keep the promise"}: ${p.text}${p.seen ? ` — today: ${p.seen}` : ""}${p.state === "unknown" ? ". Establish whether it holds before editing; record the evidence or the remaining limit if it cannot be exercised." : ""}`,
      files: [],
      serves: "a promise the product makes to its user",
      redNow: p.seen || (p.state === "unknown" ? "not yet verified; this is not a confirmed defect" : `the product does not keep this (${p.state})`),
      proof: "exercise the promise through its public interface; report the observation and any limits, plus the project gate for changes",
      status: "open",
    }));
  } else if (kind === "go-deeper") {
    title = "Go deeper — a flow the run has not walked";
    direction =
      "The Planner found no justified change in the area it inspected. Investigate a core workflow or consequential risk that earlier cycles have not exercised, using the product's own interfaces. Improve it only when the evidence beats leaving it alone.";
    items = [
      {
        id: "i1",
        title:
          "Exercise an untested core workflow or risk through the appropriate interface: screens and return paths for an app, public calls for a library, commands for a CLI, or requests and recovery for a service. Consider correctness, accessibility, security, performance, recovery, and maintenance where they matter to this product. Repair the best evidenced gap; if none is established, record what you tested and learned without inventing an edit.",
        files: [],
        serves: "the product's core job over its useful lifetime",
        redNow: looked ? `the scout only saw: ${looked.slice(0, 200)}` : "unwalked — exercise it now",
        proof: "a reproducible observation or measurement of the workflow or risk, plus the project gate for changes",
        status: "open",
      },
    ];
  } else {
    title = "Direct execute — ship what the scout found";
    direction =
      "The Planner could not produce a plan within its budget. Use the scout's evidence to select one worthwhile improvement for this product's users or maintainers. Investigate first when the evidence is incomplete.";
    items = [
      {
        id: "i1",
        title:
          "From the scout's findings, reproduce the highest-value gap in a core workflow or consequential risk and improve it. If the scout found nothing concrete, exercise the product through its public interface and record evidence before choosing a change. Do not manufacture production edits to fill a cycle; an investigation with no justified change should report its findings and limits.",
        files: [],
        serves: "the product's core job and the people who depend on it",
        redNow: looked ? `the scout saw: ${looked.slice(0, 200)}` : "use the product and find it",
        proof: "a reproducible observation or measurement of the selected gap, plus the project gate for changes",
        status: "open",
      },
    ];
  }

  const mustFix = [...(opts?.mustFix ?? [])];
  const hold = classHoldMessage(s);
  const cls = hold ? recurringArchitectureClass(s.cycles) : undefined;
  if (hold && cls) {
    const preview: ParsedPlan = {
      title,
      verdict: "continue",
      considered,
      promises,
      items,
      outOfScope: [],
      operator: [],
    };
    if (!planAddressesArchitectureClass(preview, cls)) {
      items = [architectureClassItem(cls), ...items];
      if (!mustFix.includes(hold)) mustFix.push(hold);
    }
  }

  const worthClaim = "Further investigation can reveal a consequential gap the scout did not establish; any edit must be justified by what is observed, its benefit, and its cost.";
  const raw = [
    `# Cycle ${s.cycle + 1} plan — ${title}`,
    `Verdict: continue`,
    s.identity ? `Identity: ${s.identity}` : "",
    looked ? `Looked: ${looked}` : "",
    considered.length ? `Considered:\n${considered.map((c) => `- ${c}`).join("\n")}` : "",
    `Direction: ${direction}`,
    `Worth the cycle: ${worthClaim}`,
    s.verifyCommand ? `Verify: \`${s.verifyCommand}\`` : "",
    `Items:`,
    ...items.map((it, i) => `${i + 1}. ${it.title}${it.files.length ? ` — files: ${it.files.join(", ")}` : ""} — serves: ${it.serves ?? ""} — red now: ${it.redNow ?? ""} — proof: ${it.proof ?? ""}`),
    promises.length ? `Promises:\n${promises.map((p) => `- ${p.text} — ${p.state}${p.seen ? ` — ${p.seen}` : ""}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const plan: ParsedPlan = {
    title,
    verdict: "continue",
    identity: s.identity,
    direction,
    looked: looked || undefined,
    considered,
    worthClaim,
    promises,
    verifyCommand: undefined,
    items,
    outOfScope: [],
    operator: [],
  };
  return { plan, raw, mustFix };
}

/**
 * Run the Planner and admit its plan. Returns the Stop outcome that follows.
 * The only self-stops the harness honours are a mandate fulfilled, a Planner
 * `blocked` (a secret / external / decision only the user can settle), the
 * user's own controls, and the no-progress wall. A Planner that cannot
 * produce a plan, or a no-mandate `fulfilled`, becomes work — never a release.
 */
export async function planNextCycle(s: CycleState, rt: CycleRuntime): Promise<CycleStopOutcome> {
  void prewarmLookPath(0);
  const git = ensureGitRepo(rt.workspace, { reason: "ulw" });
  if (git.inited) {
    rt.log?.(`ULW initialized git repository in ${git.root ?? rt.workspace} (local only; FORGE_AUTO_GIT=0 off)`);
  }
  s.phase = "plan";
  saveCycleState(s);
  const before = stopBeforeAdmittingNextPlan(s);
  if (before) return before;
  // The review the executor is about to hear: the cycle that just closed.
  const reviewForExecutor = reviewNotesForExecutor(s);
  const out = await runPlanner(s, rt);
  const stop = stopBeforeAdmittingNextPlan(s);
  if (stop) {
    if ("scout" in out && out.scout?.path) {
      try {
        fs.rmSync(out.scout.path);
      } catch {
        /* */
      }
    }
    return stop;
  }
  const scout = out.scout;
  // Identity and promises are the Planner's inventory of the product; persist
  // them from the plan or the scout whichever we got, for every outcome.
  const parsedForInventory = "plan" in out ? out.plan : undefined;
  const identity = parsedForInventory?.identity ?? scout?.parsed?.identity;
  if (identity) {
    s.identity = identity;
    safe(() => rt.rememberIdentity?.(identity), undefined);
  }
  const promises = scout?.parsed?.promises.length ? scout.parsed.promises : parsedForInventory?.promises ?? [];
  if (promises.length) {
    s.promises = promises;
    safe(() => rt.rememberPromises?.(promises), undefined);
  }

  if ("error" in out) {
    // The Planner burned its budget without a parseable plan. Keep the failed
    // artifact, then — unless we have hit the no-progress wall — turn its
    // findings into a direct-execute cycle rather than ending the run.
    const n = s.cycle + 1;
    writeArtifact(s.sessionId, n, "plan.failed.md", out.raw || out.error);
    if (s.directExecuteStreak >= noProgressCap()) {
      return release(
        s,
        "no-progress",
        `ULW released — ${s.directExecuteStreak} synthesized cycle(s) in a row shipped nothing (last: the Planner could not produce a plan). The run is not making progress; re-arm with /ulw or give a mandate.`,
      );
    }
    if (s.synthStreak >= synthCap()) {
      return release(
        s,
        "no-progress",
        `ULW released — ${s.synthStreak} synthesized cycle(s) already ran; the Planner must produce a parseable plan. Re-arm with /ulw or give a mandate.`,
      );
    }
    rt.log?.(`ULW planner did not converge for cycle ${n}; synthesizing a direct-execute cycle (streak ${s.directExecuteStreak + 1}/${noProgressCap()})`);
    const synth = synthesizeWorkPlan(s, scout, "no-plan", { mustFix: out.mustFix });
    s.directExecuteStreak += 1;
    const admitted = await admitPlan(s, rt, synth.plan, synth.raw, out.tokens, scout, reviewForExecutor);
    stampSynthMustFix(s, synth.mustFix);
    return admitted;
  }

  const { plan, raw, tokens } = out;
  s.synthStreak = 0;
  if (plan.direction) s.direction = plan.direction;

  if (plan.verdict === "blocked") {
    const n = s.cycle + 1;
    const planPath = writeArtifact(s.sessionId, n, "plan.md", raw);
    s.cycles.push({
      n,
      title: plan.title,
      startedAt: nowIso(),
      endedAt: nowIso(),
      planPath,
      ...(scout ? { scoutPath: scout.path } : {}),
      looked: plan.looked ?? scout?.parsed?.looked,
      ...(plan.considered.length ? { considered: plan.considered } : scout?.parsed?.considered.length ? { considered: scout.parsed.considered } : {}),
      planVerdict: plan.verdict,
      itemsTotal: 0,
      itemsDone: 0,
      waves: 0,
      mustFix: [],
      plannerTokens: tokens,
    });
    const why = plan.verdictNote ? ` — ${plan.verdictNote.replace(/[.\s]+$/, "")}` : "";
    const ops = plan.operator.length ? ` Operator: ${plan.operator.join("; ")}` : "";
    return release(s, "blocked", `Planner: blocked${why}.${ops}`);
  }

  if (plan.verdict === "fulfilled") {
    // A mandate that is met is a real, terminal answer. With no mandate,
    // "the product is in good shape" is the escape the user forbade: the
    // model looked at a broken product and called it done. It never ends the
    // run — it becomes deeper work, targeting a broken promise first.
    // Presence-only: a fulfilled plan (or its scout) must carry Looked: —
    // otherwise this is the low-hanging-fruit escape (README + hello world).
    const looked = (plan.looked || scout?.parsed?.looked || "").trim();
    // A mandate fulfilled before anyone has used the product (no Looked:,
    // no committed cycle) is the README-and-hello-world escape. After a
    // reviewed commit the Reviewer already used it; honour fulfilled.
    const usedTheProduct = Boolean(looked) || s.cycles.some((c) => c.commitSha);
    // A mandate cannot fulfil while broken/unknown promises have no Operator:.
    // absent may remain. FORGE_ULW_PROMISE_FULFILL=0 restores Looked:+used release.
    const outstanding = s.mandate != null ? unnamedBrokenOrUnknownPromises(s, plan) : [];
    if (s.mandate != null && usedTheProduct && outstanding.length === 0) {
      const n = s.cycle + 1;
      const planPath = writeArtifact(s.sessionId, n, "plan.md", raw);
      s.cycles.push({
        n,
        title: plan.title,
        startedAt: nowIso(),
        endedAt: nowIso(),
        planPath,
        ...(scout ? { scoutPath: scout.path } : {}),
        looked: plan.looked ?? scout?.parsed?.looked,
        planVerdict: plan.verdict,
        itemsTotal: 0,
        itemsDone: 0,
        waves: 0,
        mustFix: [],
        plannerTokens: tokens,
      });
      const why = plan.verdictNote ? ` — ${plan.verdictNote.replace(/[.\s]+$/, "")}` : "";
      const ops = plan.operator.length ? ` Operator: ${plan.operator.join("; ")}` : "";
      return release(s, "fulfilled", `Planner: mandate fulfilled${why}. ULW released after ${s.cycles.filter((c) => c.commitSha).length} committed cycle(s).${ops}`);
    }
    if (s.directExecuteStreak >= noProgressCap()) {
      return release(
        s,
        "no-progress",
        `ULW released — ${s.directExecuteStreak} deeper cycle(s) in a row shipped nothing after the Planner declared the product done. Nothing more is landing; re-arm with /ulw or give a mandate to aim it.`,
      );
    }
    if (s.synthStreak >= synthCap()) {
      return release(
        s,
        "no-progress",
        `ULW released — ${s.synthStreak} synthesized cycle(s) already ran; the Planner must produce a parseable plan. Re-arm with /ulw or give a mandate.`,
      );
    }
    const unkept = (s.promises ?? []).some((p) => p.state !== "kept");
    const kind = outstanding.length || unkept ? "keep-promise" : "go-deeper";
    const whySynth =
      s.mandate != null && !usedTheProduct
        ? "mandate fulfilled without Looked: (use the product before declaring the job done)"
        : outstanding.length
          ? "a broken or unknown promise is not named on Operator:"
          : unkept
            ? "a promise is unkept"
            : "all promises kept";
    rt.log?.(`ULW Planner declared ${s.mandate != null ? "mandate" : "no-mandate"} fulfilled; ${whySynth} — synthesizing a ${kind} cycle (streak ${s.directExecuteStreak + 1}/${noProgressCap()})`);
    const synth = synthesizeWorkPlan(s, scout, kind, outstanding.length ? { targets: outstanding } : undefined);
    s.directExecuteStreak += 1;
    const admitted = await admitPlan(s, rt, synth.plan, synth.raw, tokens, scout, reviewForExecutor);
    stampSynthMustFix(s, synth.mustFix);
    return admitted;
  }

  return admitPlan(s, rt, plan, raw, tokens, scout, reviewForExecutor);
}

/**
 * Seed the executor's board from a plan (a real one or a synthesized work
 * plan) and return the Stop outcome that admits it.
 */
async function admitPlan(
  s: CycleState,
  rt: CycleRuntime,
  plan: ParsedPlan,
  raw: string,
  tokens: number,
  scout: ScoutResult | undefined,
  reviewForExecutor: ReviewNotesForExecutor | undefined,
): Promise<CycleStopOutcome> {
  s.cycle += 1;
  s.phase = "execute";
  s.wave = 0;
  s.fixRounds = 0;
  s.stuckBlocks = 0;
  s.replanRequested = false;
  if (plan.direction) s.direction = plan.direction;
  s.planTitle = plan.title;
  s.planVerdict = plan.verdict;
  s.items = plan.items;
  // `Guidelines: fix: …` is the plan's first item unless the Planner already
  // wrote one (a guideline file among an item's files, or a Guidelines title).
  const guidelinesItem = s.items.some(
    (i) =>
      /^guidelines\b/i.test(i.title) ||
      i.files.some((f) => /(^|\/)(AGENTS|CLAUDE)\.md$/i.test(f)),
  );
  if (plan.guidelines && /^fix\b/i.test(plan.guidelines) && !guidelinesItem) {
    s.items.unshift({
      id: "i0",
      title: `Guidelines: ${plan.guidelines.replace(/^fix\s*[:—–-]?\s*/i, "")}`,
      files: ["AGENTS.md"],
      status: "open",
    });
  }
  s.outOfScope = plan.outOfScope;
  const gate = resolveVerifyCommand(plan, safe(() => rt.projectChecks(), []));
  s.verifyCommand = gate.command;
  if (gate.declared && !s.declaredChecks.some((c) => c.toLowerCase() === gate.declared!.toLowerCase())) {
    s.declaredChecks = [gate.declared, ...s.declaredChecks].slice(0, 4);
  }
  if (gate.note) rt.log?.(`ULW cycle ${s.cycle} verify: ${gate.note}`);
  s.cycleStartHead = safe(() => rt.gitHead(), null);
  const planPath = writeArtifact(s.sessionId, s.cycle, "plan.md", raw);
  s.cycles.push(planRecord(s, plan, planPath, tokens, scout));
  saveCycleState(s);
  safe(() => rt.seedTodos(s.items), undefined);
  safe(
    () =>
      appendMemoryRecord(s.sessionId, {
        kind: "decision",
        text: `Plan ${s.cycle}: ${plan.title}${plan.direction ? ` — ${plan.direction}` : ""}`.slice(0, 400),
        source: "harness",
      }),
    null,
  );
  const admission = formatPlanAdmission({
    cycle: s.cycle,
    title: plan.title,
    planText: raw,
    items: s.items.map((i) => ({ id: i.id, title: i.title })),
    verifyCommand: s.verifyCommand,
    maxCycles: s.maxCycles,
    cycleZeroRequested: s.cycleZeroRequested,
    lastReview: reviewForExecutor,
  });
  rt.log?.(`ULW cycle ${s.cycle} plan admitted — ${plan.title} (${s.items.length} item(s))`);
  const abortAdmit = ifUserDisarmed(s);
  if (abortAdmit) return abortAdmit;
  // The gate is judged against what was already failing under *this* command
  // before the cycle touched anything. Cycle 1 measures the user's tree; a
  // later cycle whose Planner declared a different gate (or the first cycle
  // to have one) measures the tree as the last commit left it — otherwise
  // the baseline's command never matches and every old failure is red again.
  if (s.verifyCommand && s.verifyBaseline?.command !== s.verifyCommand) {
    const previous = s.cycles.find((c) => c.n === s.cycle - 1);
    if (s.cycle === 1 || (previous?.commitSha && safe(() => rt.gitIsClean?.(), null) === true)) {
      await captureBaseline(s, rt);
    } else {
      rt.log?.("ULW baseline: a changed gate requires a clean tree after a committed cycle; retaining the prior baseline and requiring the new check to pass");
    }
  }
  const abortAfterBaseline = ifUserDisarmed(s);
  if (abortAfterBaseline) return abortAfterBaseline;
  return {
    allowStop: false,
    released: false,
    reanchor: admission,
    reason: `Cycle ${s.cycle} plan admitted — ${plan.title}`,
    planAdmitted: true,
    waveStamped: false,
    phase: s.phase,
  };
}

/** The last closed cycle's review, shaped for its author. */
function reviewNotesForExecutor(s: CycleState): ReviewNotesForExecutor | undefined {
  const r = s.lastReview;
  if (!r || s.cycle < 1) return undefined;
  const record = [...s.cycles].reverse().find((c) => c.reviewVerdict);
  if (!record) return undefined;
  return {
    cycle: record.n,
    verdict: r.verdict,
    revisions: r.revisions,
    architecture: r.architecture,
    disputed: record.disputed ?? [],
    worth: r.worth,
  };
}

async function captureBaseline(s: CycleState, rt: CycleRuntime): Promise<void> {
  if (!s.verifyCommand) return;
  rt.log?.(
    `ULW baseline: running \`${s.verifyCommand}\` on the tree ${s.cycle === 1 ? "as the user left it" : `as cycle ${s.cycle - 1} left it`}`,
  );
  try {
    const run = await rt.runCheck(s.verifyCommand);
    safe(() => rt.creditCheck?.(run, run.cls.passed), undefined);
    s.verifyBaseline = {
      command: run.command,
      exitCode: run.exitCode,
      failures: run.failures,
      at: nowIso(),
    };
    writeArtifact(
      s.sessionId,
      s.cycle,
      "verify.baseline.log",
      `$ ${run.command}\n# exit ${run.exitCode ?? "timeout"} · ${run.ms}ms · ${run.failures.length} failing\n${run.tail}`,
    );
    saveCycleState(s);
    rt.log?.(
      run.cls.passed
        ? `ULW baseline: green`
        : `ULW baseline: red — ${run.failures.length} pre-existing failure(s) will not count against the cycle`,
    );
  } catch (err) {
    rt.log?.(`ULW baseline: could not run (${(err as Error).message}); the gate is exit 0`);
  }
}

/**
 * The cycle gate. The Planner's `Verify:` is honoured when it is a whole
 * check; an isolate (one test file, a typecheck) is proof=ran, not proof=✓,
 * so the stack table's full suite gates instead and the isolate stays on
 * `declaredChecks` for the executor's own runs. `none — why` and a missing
 * line fall back to the stack table so a wrong "none" cannot switch the
 * gate off. Dogfood: the first real run declared a single-file test and the
 * suite never ran before the commit.
 */
export function resolveVerifyCommand(
  plan: Pick<ParsedPlan, "verifyCommand" | "verifyNone">,
  projectChecks: string[],
): { command?: string; declared?: string; note?: string } {
  const declared = plan.verifyCommand;
  // A monorepo root with a stray pyproject.toml lists `pytest` next to the
  // npm scripts; the fuller check must live in the same ecosystem as what
  // the Planner declared (or, absent that, as the stack table's first row).
  const eco = commandEcosystem(declared ?? projectChecks[0] ?? "");
  const suite = projectChecks.find(
    (c) => isFullSuiteCommand(c, projectChecks) && (eco === "other" || commandEcosystem(c) === eco),
  );
  const fallback = suite ?? projectChecks.find((c) => eco === "other" || commandEcosystem(c) === eco) ?? projectChecks[0];
  if (declared) {
    if (isIsolateTestCommand(declared) || isTypecheckCommand(declared)) {
      return fallback && fallback !== declared
        ? {
            command: fallback,
            declared,
            note: `\`${declared}\` is an isolate — the cycle gate is \`${fallback}\`; the isolate stays a declared check`,
          }
        : { command: declared, declared, note: `\`${declared}\` is an isolate and the stack table has no fuller check` };
    }
    return { command: declared, declared };
  }
  if (plan.verifyNone) {
    return fallback
      ? { command: fallback, note: `Planner said none (${plan.verifyNone}); the stack table's \`${fallback}\` gates` }
      : { command: undefined };
  }
  return { command: fallback };
}

type CommandEcosystem = "js" | "py" | "rust" | "go" | "other";

function commandEcosystem(command: string): CommandEcosystem {
  const c = command.toLowerCase();
  if (/\b(npm|npx|pnpm|yarn|bun|node|tsx|vitest|jest|mocha|deno)\b/.test(c)) return "js";
  if (/\b(pytest|python3?|uv|poetry|tox|pip)\b/.test(c)) return "py";
  if (/\bcargo\b/.test(c)) return "rust";
  if (/\bgo\s+(test|build|vet)\b/.test(c)) return "go";
  return "other";
}

/**
 * The Reviewer in two turns: the look — the product on the tree as the cycle
 * left it, no diff — then the review. forge-prove: run, read, then claim.
 */
async function runReviewer(s: CycleState, rt: CycleRuntime, executorCloser: string): Promise<CycleReviewNotes> {
  const record = currentCycleRecord(s);
  const planText = readArtifact(record?.planPath);
  const { diff, files, truncated } = safe(
    () => rt.gitDiffSince(s.cycleStartHead),
    { diff: "", files: [] as string[], truncated: false },
  );
  const reviewInput: ReviewerBriefInput = {
    state: s,
    workspace: rt.workspace,
    planText,
    diff,
    diffTruncated: truncated,
    changedFiles: files,
    verifyCommand: s.verifyCommand,
    executorCloser,
  };
  const tt = await runRoleTwoTurn(rt, "reviewer", {
    cycle: s.cycle,
    firstBrief: buildReviewerLookBrief({
      state: s,
      workspace: rt.workspace,
      direction: record?.direction ?? s.direction,
      plannerLooked: record?.looked,
      verifyCommand: s.verifyCommand,
      lookProfileUdd: sessionLookProfile(s.sessionId, rt.workspace),
    }),
    secondBrief: (lookText) => buildReviewerReviewBrief({ ...reviewInput, lookText }),
    singleBrief: () => buildReviewerBrief(reviewInput),
    firstMaxTurns: reviewerLookTurns(),
    secondDocumentOnly: true,
  });
  await persistAndCleanupRole(s.sessionId, "reviewer", rt, tt);
  const res = tt.second;
  if (record) record.reviewerTokens = (record.reviewerTokens ?? 0) + roleTokens(tt);
  const lookRaw = tt.first ? roleBody(tt.first.text) : "";
  let lookLooked: string | undefined;
  let lookCouldNot = false;
  const hasLookMd = Boolean(lookRaw.trim());
  if (hasLookMd) {
    const lookPath = writeArtifact(s.sessionId, s.cycle, "look.md", lookRaw);
    const lookParsed = parseLookArtifact(lookRaw);
    lookLooked = lookParsed?.looked;
    lookCouldNot = !lookParsed || lookParsed.couldNotLook;
    if (record) record.lookPath = lookPath;
  }
  const raw = roleBody(res.text);
  const completed = res.ok && res.status === "completed";
  let parsed = completed ? parseReviewArtifact(raw) : null;
  // No parseable review is a review that did not happen: fail closed (no
  // commit); the work stays in the tree and the next Planner sees why.
  let notes: CycleReviewNotes = parsed ?? {
    verdict: "blocked",
    fulfillment: [],
    revisions: res.editCount > 0 ? [`${res.editCount} edit(s) by the reviewer (no parseable review)`] : [],
    mustFix: [`Reviewer ${completed ? "returned no parseable review" : "did not complete"} (${res.status}${res.error ? `: ${res.error}` : ""})`],
    architecture: [],
    operator: [],
  };
  // The look is the Reviewer's own record of having used the product; the
  // review's Looked: restates it, and stands in when the look turn wrote none
  // (single-brief / FORGE_ULW_TWO_TURN=0 never writes look.md).
  if (!notes.looked && lookLooked) notes.looked = lookLooked;
  // A surface-claim ship whose look never opened the product is the same
  // incomplete review as an unparseable body — no commit.
  const infraFailed = lookInfraFailed(lookLooked ?? notes.looked ?? "");
  if (surfaceLookGateBlocks(s, notes, { hasLookMd, couldNotLook: lookCouldNot, infraFailed })) {
    const lookFix = infraFailed
      ? "look infrastructure failed — reuse the session browser lease; do not ship a surface claim from source"
      : "look the surface";
    notes = {
      ...notes,
      verdict: "blocked",
      mustFix: [lookFix, ...notes.mustFix.filter((m) => !/^look the surface$/i.test(m) && !/^look infrastructure failed/i.test(m))],
    };
    parsed = null;
    rt.log?.(`ULW cycle ${s.cycle} look gate: surface ship without a look — blocked`);
  }
  // A review that parsed is the artifact. Anything else — an errored child's
  // transcript synthesis, prose — is kept beside it as review.failed.md, and
  // review.md carries the structured blocked verdict the run actually used.
  if (!parsed && raw.trim()) writeArtifact(s.sessionId, s.cycle, "review.failed.md", raw);
  const reviewPath = writeArtifact(
    s.sessionId,
    s.cycle,
    "review.md",
    parsed ? raw : `# Cycle ${s.cycle} review\nVerdict: blocked\nMust-fix:\n- ${notes.mustFix.join("\n- ")}\n`,
  );
  if (record) {
    record.reviewPath = reviewPath;
    record.reviewVerdict = notes.verdict;
    record.mustFix = notes.mustFix;
    record.architecture = notes.architecture;
    record.worth = notes.worth;
    if (notes.looked) record.reviewerLooked = notes.looked;
    record.revisions = notes.revisions;
    record.disputed = notes.fulfillment
      .filter((f) => f.state !== "done")
      .map((f) => `${f.item} — ${f.state}${f.note ? ` — ${f.note}` : ""}`);
  }
  // Fulfilment from a fresh reader beats the executor's board.
  for (const f of notes.fulfillment) {
    const item = s.items.find((i) => i.title.toLowerCase().includes(f.item.toLowerCase().slice(0, 40)));
    if (!item) continue;
    if (f.state === "done") item.status = "done";
    else item.status = "open";
  }
  s.lastReview = notes;
  saveCycleState(s);
  return notes;
}

function commitCycle(s: CycleState, rt: CycleRuntime): AutoCommitResult {
  const record = currentCycleRecord(s);
  const done = s.items.filter((i) => i.status === "done").length;
  const subject = `ulw cycle ${s.cycle}: ${s.planTitle || "plan"}`;
  const body = [
    `Plan-cycle commit — local only (never pushed).`,
    s.mandate ? `Mandate: ${s.mandate.slice(0, 240)}` : `Mandate: (derived) ${s.direction?.slice(0, 200) ?? ""}`,
    `Items: ${done}/${s.items.length} done · ${s.wave} wave(s)`,
    ...s.items.map((i) => `- [${i.status === "done" ? "x" : i.status === "cancelled" ? "-" : " "}] ${i.title}`),
    s.lastReview ? `Review: ${s.lastReview.verdict}${s.lastReview.mustFix.length ? ` · must-fix: ${s.lastReview.mustFix.length}` : ""}` : "",
    s.verifyCommand ? `Verify: ${s.verifyCommand} ${record?.verifyPassed ? "✓" : record?.verifyPassed === false ? "✗" : "(none)"}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const res = rt.commit({ subject, body, sessionId: s.sessionId });
  if (record) {
    record.commitSha = res.sha;
    record.commitSubject = res.committed ? subject : undefined;
    if (res.stagedPaths?.length) record.commitFiles = res.stagedPaths.slice(0, 24);
    if (res.commitKind) record.commitKind = res.commitKind;
    record.itemsDone = done;
    record.waves = s.wave;
  }
  return res;
}

async function verifyCycle(
  s: CycleState,
  rt: CycleRuntime,
  label: string,
): Promise<{ run: CheckRun; verdict: GateVerdict } | null> {
  if (!s.verifyCommand) return null;
  s.phase = "verify";
  saveCycleState(s);
  const run = await rt.runCheck(s.verifyCommand);
  const verdict = judgeAgainstBaseline(run, s.verifyBaseline);
  safe(() => rt.creditCheck?.(run, verdict.passed), undefined);
  writeArtifact(
    s.sessionId,
    s.cycle,
    `verify.${label}.log`,
    `$ ${run.command}\n# exit ${run.exitCode ?? "timeout"} · ${run.ms}ms · ${verdict.note}\n` +
      (verdict.newFailures.length ? `# new: ${verdict.newFailures.join(" | ")}\n` : "") +
      (verdict.inherited.length ? `# pre-existing: ${verdict.inherited.join(" | ")}\n` : "") +
      run.output,
  );
  const record = currentCycleRecord(s);
  if (record) {
    record.verifyCommand = s.verifyCommand;
    record.verifyPassed = verdict.passed;
    record.verifyInherited = verdict.inherited.length || undefined;
  }
  s.lastVerifyTail = run.tail.slice(-3_000);
  rt.log?.(`ULW cycle ${s.cycle} verify (${label}): ${verdict.note}`);
  return { run, verdict };
}

/** After a cycle closes (committed or not): /cycle 0, max_cycles, or the next plan. */
async function advanceAfterCycle(
  s: CycleState,
  rt: CycleRuntime,
  committed: CycleStopOutcome["committed"],
): Promise<CycleStopOutcome> {
  const record = currentCycleRecord(s);
  if (record) {
    record.endedAt = nowIso();
    record.itemsDone = s.items.filter((i) => i.status === "done").length;
    record.waves = s.wave;
  }
  saveCycleState(s);
  const stop = stopBeforeAdmittingNextPlan(s);
  if (stop) return { ...stop, cycleClosed: true, committed };
  const next = await planNextCycle(s, rt);
  return { ...next, cycleClosed: true, committed };
}

/** Commit the cycle. The gate that passed becomes the next cycle's baseline. */
async function finishCycle(s: CycleState, rt: CycleRuntime, accepted: CheckRun | null): Promise<CycleStopOutcome> {
  s.phase = "commit";
  const ac = commitCycle(s, rt);
  if (ac.initializedGit) {
    rt.log?.(`ULW initialized git repository in ${rt.workspace} (local only; FORGE_AUTO_GIT=0 off)`);
  }
  if (ac.committed) {
    rt.log?.(`ULW cycle ${s.cycle} committed ${ac.sha ?? ""} — ${ac.subject}`);
    // Docs-only commits are not progress: a rename mill of READMEs would
    // otherwise reset the no-progress wall forever. Source/product files do.
    if (ac.commitKind !== "docs") {
      const rec = currentCycleRecord(s);
      const synth = /^(Direct execute|Keep the promises still broken|Go deeper)\b/i.test(
        rec?.title ?? "",
      );
      if (synth) s.synthStreak += 1;
      else {
        s.directExecuteStreak = 0;
        s.synthStreak = 0;
      }
    }
    // Bash Chrome outlives the cycle; reap after commit, never during a Reviewer look.
    safe(() => reapSessionBrowsers(s.sessionId, { workspace: rt.workspace }), {
      killed: 0,
      removed: [],
    });
    safe(() => janitorBackgroundTasks(), { scanned: 0, removed: [] });
  } else if (ac.skipped) {
    rt.log?.(`ULW cycle ${s.cycle} commit skipped: ${ac.skipped}`);
  }
  if (accepted && s.verifyCommand) {
    s.verifyBaseline = {
      command: accepted.command,
      exitCode: accepted.exitCode,
      failures: accepted.failures,
      at: nowIso(),
    };
  }
  return advanceAfterCycle(s, rt, { sha: ac.sha, subject: ac.subject, skipped: ac.skipped });
}

function fixOrRelease(
  s: CycleState,
  run: CheckRun,
  verdict: GateVerdict,
  opts: { fixRoundsCap: number; reviewed: boolean },
): CycleStopOutcome {
  s.fixRounds += 1;
  s.phase = "fix";
  saveCycleState(s);
  if (s.fixRounds > opts.fixRoundsCap) {
    return release(
      s,
      "fix-cap",
      `\`${run.command}\` stayed red after ${opts.fixRoundsCap} fix round(s) in cycle ${s.cycle} (${verdict.note}); nothing committed. Operator: the tree is dirty and the check is red — inspect ${path.join("cycles", String(s.cycle))}/verify.*.log.`,
    );
  }
  return {
    allowStop: false,
    released: false,
    reanchor: formatFixReanchor({
      cycle: s.cycle,
      command: run.command,
      round: s.fixRounds,
      cap: opts.fixRoundsCap,
      tail: run.tail,
      newFailures: verdict.newFailures,
      inherited: verdict.inherited,
      reviewed: opts.reviewed,
      mustFix: s.lastReview?.mustFix ?? [],
    }),
    reason: `Cycle ${s.cycle} verify RED (${run.command}: ${verdict.note}) — fix round ${s.fixRounds}/${opts.fixRoundsCap}`,
    waveStamped: false,
    phase: s.phase,
  };
}

/** Executor fixes change the reviewed tree, so persist the loss of approval first. */
function invalidateReview(s: CycleState): void {
  const record = currentCycleRecord(s);
  if (!record?.reviewPath) return;
  const raw = readArtifact(record.reviewPath);
  if (raw.trim()) writeArtifact(s.sessionId, s.cycle, `review.before-fix.${s.fixRounds + 1}.md`, raw);
  record.reviewPath = undefined;
  record.reviewVerdict = undefined;
  saveCycleState(s);
}

function fixReviewOrRelease(
  s: CycleState,
  findings: string[],
  cap: number,
): CycleStopOutcome {
  invalidateReview(s);
  s.fixRounds += 1;
  s.phase = "fix";
  saveCycleState(s);
  if (s.fixRounds > cap) {
    return release(
      s,
      "fix-cap",
      `Reviewer findings remain after ${cap} fix round(s) in cycle ${s.cycle}; nothing committed. Operator: ${findings.join("; ")}`,
    );
  }
  return {
    allowStop: false,
    released: false,
    reanchor: [
      `[Forge ULW cycle driver] Cycle ${s.cycle} review requires fixes (fix round ${s.fixRounds}/${cap}).`,
      ...findings.map((finding) => `- ${finding}`),
      "Resolve these findings in the current cycle. The harness will verify, run a fresh Reviewer, and verify again before committing.",
    ].join("\n"),
    reason: `Cycle ${s.cycle} review requires fixes - fix round ${s.fixRounds}/${cap}`,
    waveStamped: false,
    phase: s.phase,
  };
}

/**
 * EXECUTE is over. The sequence is verify → (fix) → review → verify → (fix)
 * → commit: the Reviewer reads a tree that already passes the gate, so what
 * the executor changed to get green is reviewed too, and the gate runs once
 * more after the Reviewer's own revisions. A Reviewer `blocked` verdict ends
 * the cycle without a commit; the work stays in the tree for the next plan.
 * Resumes from whichever phase the sidecar recorded when a transition was cut.
 */
async function closeCycle(
  s: CycleState,
  rt: CycleRuntime,
  facts: StopFacts,
  opts: { fixRoundsCap: number; why: string },
): Promise<CycleStopOutcome> {
  const record = currentCycleRecord(s);
  // Older sidecars retained approval while the executor repaired a red
  // post-review check. A resumed fix must not inherit that stale approval.
  if (record?.reviewVerdict !== "blocked" && (s.phase === "fix" || (s.phase === "verify" && record?.verifyPassed === false))) {
    invalidateReview(s);
  }
  const reviewed = Boolean(record?.reviewPath && record.reviewVerdict);
  // A Stop can resume after the blocked artifact was saved but before the
  // next plan began. Its presence is not permission to commit.
  if (reviewed && record?.reviewVerdict === "blocked") {
    return advanceAfterCycle(s, rt, { skipped: "review blocked" });
  }
  if (!reviewed) {
    if (s.phase === "execute") rt.log?.(`ULW cycle ${s.cycle} → verify (${opts.why})`);
    const pre = await verifyCycle(s, rt, s.fixRounds > 0 ? `pre-review.${s.fixRounds}` : "pre-review");
    const abortPre = ifUserDisarmed(s);
    if (abortPre) return abortPre;
    if (pre && !pre.verdict.passed) {
      return fixOrRelease(s, pre.run, pre.verdict, { fixRoundsCap: opts.fixRoundsCap, reviewed: false });
    }
    s.phase = "review";
    saveCycleState(s);
    rt.log?.(`ULW cycle ${s.cycle} → review`);
    const notes = await runReviewer(s, rt, facts.lastAssistantMessage);
    const abortReview = ifUserDisarmed(s);
    if (abortReview) return abortReview;
    if (notes.verdict === "blocked") {
      rt.log?.(`ULW cycle ${s.cycle} review: blocked — no commit; the next plan starts from the must-fix`);
      return advanceAfterCycle(s, rt, { skipped: "review blocked" });
    }
  }
  const findings = [...(record?.mustFix ?? []), ...(record?.disputed ?? [])];
  if (findings.length) return fixReviewOrRelease(s, findings, opts.fixRoundsCap);
  const post = await verifyCycle(s, rt, s.fixRounds > 0 ? `post-review.${s.fixRounds}` : "post-review");
  const abortPost = ifUserDisarmed(s);
  if (abortPost) return abortPost;
  if (post && !post.verdict.passed) {
    invalidateReview(s);
    return fixOrRelease(s, post.run, post.verdict, { fixRoundsCap: opts.fixRoundsCap, reviewed: true });
  }
  if (surfaceSitBlocksCommit(s, post)) {
    rt.log?.(`ULW cycle ${s.cycle} commit skipped: surface sit without proof`);
    return advanceAfterCycle(s, rt, { skipped: "surface sit without proof" });
  }
  return finishCycle(s, rt, post?.run ?? null);
}

export interface EvaluateCycleOptions {
  facts: StopFacts;
  runtime?: CycleRuntime;
  fixRoundsCap?: number;
}

/**
 * The ULW branch of the Stop guard. Returns null when the driver is not
 * armed so the caller falls through to the other guards.
 */
export async function evaluateCycleAtStop(
  sessionId: string,
  opts: EvaluateCycleOptions,
): Promise<CycleStopOutcome | null> {
  const s = loadActiveCycle(sessionId);
  if (!s) return null;
  const rt = opts.runtime;
  const cap = fixRoundsCap(opts.fixRoundsCap);
  if (rt) syncItemsFromTodos(s, rt.todos());
  const action: CycleAction = decideAtStop(s, opts.facts);
  const stamped = s.phase === "execute" && action.kind !== "plan" && action.kind !== "yield";
  if (stamped) rememberExecutorLines(s, opts.facts.lastAssistantMessage);
  saveCycleState(s);
  const needsRuntime = action.kind === "plan" || action.kind === "close-cycle" || action.kind === "verify";
  if (needsRuntime && !rt) {
    return {
      ...release(s, "runtime-unavailable", "ULW released — the cycle runtime (subagents / git) is not available in this loop."),
      waveStamped: stamped,
    };
  }
  switch (action.kind) {
    case "release":
      return { ...release(s, action.reason, `ULW released (${action.reason}).`), waveStamped: stamped };
    case "yield":
      return {
        allowStop: true,
        released: false,
        reason: "ULW armed — the user owns planning (/plan); /build hands it back to the harness Planner.",
        waveStamped: false,
        phase: s.phase,
      };
    case "plan":
      return planNextCycle(s, rt!);
    case "reanchor": {
      const items = openItems(s);
      const record = currentCycleRecord(s);
      if (record) {
        record.waves = s.wave;
        record.itemsDone = s.items.filter((i) => i.status === "done").length;
        saveCycleState(s);
      }
      return {
        allowStop: false,
        released: false,
        reanchor: formatItemsOpenReanchor({
          cycle: s.cycle,
          wave: s.wave,
          items,
          verifyCommand: s.verifyCommand,
          stuckBlocks: s.stuckBlocks,
          stuckThreshold: opts.facts.stuckThreshold,
        }),
        reason: `Cycle ${s.cycle} wave ${s.wave}: ${items.length} item(s) open`,
        waveStamped: true,
        phase: s.phase,
      };
    }
    case "verify":
      return { ...(await closeCycle(s, rt!, opts.facts, { fixRoundsCap: cap, why: "fix" })), waveStamped: false };
    case "close-cycle":
      return { ...(await closeCycle(s, rt!, opts.facts, { fixRoundsCap: cap, why: action.why })), waveStamped: true };
    default:
      return null;
  }
}

/**
 * Turn start: an armed run with no plan admitted runs the Planner before the
 * executor's first model call. Returns null when nothing was needed.
 */
export async function ensureCyclePlanned(
  sessionId: string,
  rt: CycleRuntime,
): Promise<CycleStopOutcome | null> {
  const s = loadActiveCycle(sessionId);
  if (!s) return null;
  if (s.phase !== "plan" || s.humanPlan) return null;
  await prewarmLookPath(MCP_PREWARM_ADMIT_WAIT_MS);
  return planNextCycle(s, rt);
}

function surfaceLookGateBlocks(
  s: CycleState,
  notes: CycleReviewNotes,
  look: { hasLookMd: boolean; couldNotLook: boolean; infraFailed?: boolean },
): boolean {
  if (isFalsy(process.env.FORGE_ULW_LOOK_GATE)) return false;
  if (notes.verdict !== "ship") return false;
  if (!isSurfaceSit(s.items)) return false;
  // Missing look.md is not a failed look when the review inlined a real Looked:.
  const hasLook = look.hasLookMd || Boolean(notes.looked?.trim());
  const couldNot = look.hasLookMd
    ? look.couldNotLook
    : notes.looked
      ? lookCouldNotLook(notes.looked)
      : true;
  // maxTurns / Godot crash / CFT died is not "opened the product" — block even
  // when Looked: does not match the could-not-look phrases.
  return !hasLook || couldNot || Boolean(look.infraFailed);
}

/** Fail-open: never hold the Planner on a 120s MCP init. */
async function prewarmLookPath(waitMs: number): Promise<void> {
  if (process.env.NODE_TEST_CONTEXT) return;
  const m = getActiveMcpManager();
  if (!m?.enabled) return;
  try {
    await m.prewarm(waitMs);
  } catch {
    /* a down playwright is a brief line, not a Stop */
  }
}

const EXECUTOR_LINES_KEEP = 12;

/**
 * The executor's labelled lines at this Stop join the cycle's record for the
 * next Planner: `Serendipity:` (noticed and left alone) and `Dispute:` (a
 * Reviewer revision it can show was wrong, with the evidence).
 */
function rememberExecutorLines(s: CycleState, closer: string): void {
  const record = currentCycleRecord(s);
  if (!record) return;
  const noticed = extractSerendipityLines(closer);
  if (noticed.length) record.serendipity = mergeLines(record.serendipity, noticed);
  const disputed = extractDisputeLines(closer);
  if (disputed.length) record.disputes = mergeLines(record.disputes, disputed);
}

function mergeLines(have: string[] | undefined, found: string[]): string[] {
  const out = [...(have ?? [])];
  const seen = new Set(out.map((l) => l.toLowerCase()));
  for (const l of found) {
    if (seen.has(l.toLowerCase())) continue;
    seen.add(l.toLowerCase());
    out.push(l);
  }
  return out.slice(-EXECUTOR_LINES_KEEP);
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function wordBounded(hay: string, needle: string): boolean {
  const n = needle.trim();
  if (!n) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`, "i").test(hay);
}

function promiseNamedInOperator(p: CyclePromise, operator: string[]): boolean {
  const blob = operator.join("\n");
  if (!blob.trim()) return false;
  const text = p.text.trim();
  if (!text) return false;
  if (wordBounded(blob, text)) return true;
  const ids = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const t = m[1].trim();
    if (t.length >= 2) ids.add(t);
  }
  for (const m of text.matchAll(/[a-z0-9]+(?:-[a-z0-9]+)+/gi)) ids.add(m[0]);
  for (const m of p.text.matchAll(/[A-Z][a-z0-9]*[A-Z][A-Za-z0-9]*/g)) ids.add(m[0]);
  return [...ids].some((id) => wordBounded(blob, id));
}

/** Broken/unknown promises not named on Operator:. Kill-switch restores mandate release. */
function unnamedBrokenOrUnknownPromises(s: CycleState, plan: ParsedPlan): CyclePromise[] {
  if (isFalsy(process.env.FORGE_ULW_PROMISE_FULFILL)) return [];
  return (s.promises ?? []).filter((p) => {
    if (p.state !== "broken" && p.state !== "unknown") return false;
    return !promiseNamedInOperator(p, plan.operator);
  });
}

function classHoldMessage(s: CycleState): string {
  if (isFalsy(process.env.FORGE_ULW_CLASS_HOLD)) return "";
  const cls = recurringArchitectureClass(s.cycles);
  return cls ? architectureHoldMessage(cls) : "";
}

function architectureClassItem(cls: string): CyclePlanItem {
  return {
    id: "i0",
    title: architectureHoldMessage(cls),
    files: [],
    serves: "the architecture class the last two shipped reviews named",
    redNow: "the class recurred and the plan did not address or leave it",
    proof: "the class is collapsed, bounded, or explicitly left",
    status: "open",
  };
}

function continueArchitectureHold(s: CycleState, plan: ParsedPlan | null): string {
  const hold = classHoldMessage(s);
  if (!hold) return "";
  if (!plan || plan.verdict !== "continue") return "";
  const cls = recurringArchitectureClass(s.cycles);
  if (!cls) return "";
  if (architectureClassMustCollapse(s.cycles, cls)) {
    if (planCollapsesArchitectureClass(plan, cls)) return "";
    return `the run is patching symptoms of \`${cls}\` (named in three shipped reviews); plan the collapse as an item — Considered: leave it is not enough`;
  }
  if (planAddressesArchitectureClass(plan, cls)) return "";
  return hold;
}

function stampSynthMustFix(s: CycleState, mustFix: string[]): void {
  if (!mustFix.length) return;
  const rec = currentCycleRecord(s);
  if (!rec) return;
  rec.mustFix = [...new Set([...(rec.mustFix ?? []), ...mustFix])];
  saveCycleState(s);
}

function surfaceSitBlocksCommit(
  s: CycleState,
  post: { run: CheckRun; verdict: GateVerdict } | null,
): boolean {
  if (!isSurfaceSit(s.items)) return false;
  return !post;
}

function sessionLookProfile(sessionId: string, workspace: string): string {
  return safe(
    () => ensureSessionLookProfile(sessionId, { workspace, rootSessionId: sessionId }),
    path.join(process.env.FORGE_HOME || "", "sessions", sessionId, "browsers", "look"),
  );
}

async function persistAndCleanupRole(
  parentId: string,
  role: CycleRole,
  rt: CycleRuntime,
  tt: TwoTurnResult,
  extra?: RoleRunResult,
): Promise<void> {
  const id = tt.sessionId;
  if (id) {
    const res = extra ?? tt.second;
    appendRoleRunLine(parentId, {
      id,
      type: role,
      status: res.status,
      turns: tt.mode === "two-turn" ? (extra ? 3 : 2) : 1,
      tokens: roleTokens(tt, ...(extra ? [extra] : [])),
      error: res.error,
    });
  }
  await safeCleanup(rt, tt.sessionId);
}
