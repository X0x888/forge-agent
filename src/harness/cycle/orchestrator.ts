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
import { nowIso } from "../../util/fs.js";
import { envPositiveInt } from "../../util/env.js";
import { appendMemoryRecord } from "../decision-memory.js";
import type { AutoCommitResult } from "../../util/git-auto-commit.js";
import {
  extractSerendipityLines,
  parsePlanArtifact,
  parseReviewArtifact,
  type ParsedPlan,
} from "./artifacts.js";
import {
  buildPlannerBrief,
  buildReviewerBrief,
  formatFixReanchor,
  formatItemsOpenReanchor,
  formatPlanAdmission,
  type ReviewNotesForExecutor,
} from "./briefs.js";
import { decideAtStop, syncItemsFromTodos, type CycleAction, type StopFacts } from "./machine.js";
import {
  currentCycleRecord,
  ensureCycleArtifactsDir,
  loadActiveCycle,
  openItems,
  saveCycleState,
  type CycleEndReason,
  type CyclePlanItem,
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
}

export interface CycleRuntime {
  workspace: string;
  runRole(role: CycleRole, brief: string, opts: { cycle: number }): Promise<RoleRunResult>;
  runCheck(command: string): Promise<CheckRun>;
  /**
   * The gate's verdict on a run the harness made — what the run-level
   * verification totals should count (green vs baseline is a pass even
   * when the exit code is not 0).
   */
  creditCheck?(run: CheckRun, passed: boolean): void;
  commit(opts: { subject: string; body: string }): AutoCommitResult;
  /** Replace the executor's board with the plan items (id = item id). */
  seedTodos(items: CyclePlanItem[]): void;
  todos(): ReadonlyArray<{ id: string; status: string }>;
  /** Push a synthetic `[Forge …]` user message onto the transcript. */
  admit(text: string): void;
  gitHead(): string | null;
  gitDiffSince(head: string | null): { diff: string; files: string[]; truncated: boolean };
  gitLogSince(head: string | null): string;
  gitStatus(): string;
  userMessagesSince(iso: string): string[];
  guidelineSurvey(): string;
  projectChecks(): string[];
  /** Persist the product identity outside the session (project memory). */
  rememberIdentity?(text: string): void;
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

/** Strip the subagent result header so the artifact is the document alone. */
function roleBody(text: string): string {
  const t = String(text || "");
  const idx = t.search(/^\s*(?:#\s*Cycle\s+\d+\s+(?:plan|review)|Verdict\s*:)/im);
  return idx > 0 ? t.slice(idx) : t;
}

function release(s: CycleState, reason: CycleEndReason, line: string): CycleStopOutcome {
  s.enabled = false;
  s.phase = "released";
  s.endReason = reason;
  saveCycleState(s);
  return {
    allowStop: true,
    released: true,
    endReason: reason,
    reason: line,
    waveStamped: false,
    phase: s.phase,
  };
}

function planRecord(
  s: CycleState,
  plan: ParsedPlan,
  planPath: string,
  plannerTokens: number,
): CycleRecord {
  return {
    n: s.cycle,
    title: plan.title,
    direction: plan.direction,
    looked: plan.looked,
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

async function runPlanner(
  s: CycleState,
  rt: CycleRuntime,
  opts: { retry?: boolean } = {},
): Promise<
  | { plan: ParsedPlan; raw: string; tokens: number }
  | { error: string; raw: string; tokens: number }
> {
  const lastPlanAt = currentCycleRecord(s)?.startedAt ?? s.startedAt;
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
  let brief = buildPlannerBrief({
    state: s,
    workspace: rt.workspace,
    gitLog: safe(() => rt.gitLogSince(s.runStartHead), ""),
    gitStatus: safe(() => rt.gitStatus(), ""),
    guidelineSurvey: safe(() => rt.guidelineSurvey(), ""),
    projectChecks: safe(() => rt.projectChecks(), []),
    userMessages: safe(() => rt.userMessagesSince(lastPlanAt), []),
  });
  if (opts.retry) {
    brief += `\n\n[Forge] Your previous plan did not parse: no \`Verdict:\` line, or \`Verdict: continue\` with an empty \`Items:\` list. End with the contract exactly.`;
  }
  const res = await rt.runRole("planner", brief, { cycle: s.cycle + 1 });
  const raw = roleBody(res.text);
  const tokens = res.promptTokens + res.completionTokens;
  if (!res.ok && !raw.trim()) {
    return { error: res.error || `planner ${res.status}`, raw, tokens };
  }
  const plan = parsePlanArtifact(raw);
  if (!plan) {
    if (!opts.retry) {
      const again = await runPlanner(s, rt, { retry: true });
      return { ...again, tokens: again.tokens + tokens };
    }
    return { error: "planner produced no parseable plan after a retry", raw, tokens };
  }
  return { plan, raw, tokens };
}

/**
 * Run the Planner and admit its plan. Returns the Stop outcome that follows:
 * a blocked Stop carrying the plan admission, or a release.
 */
export async function planNextCycle(s: CycleState, rt: CycleRuntime): Promise<CycleStopOutcome> {
  s.phase = "plan";
  saveCycleState(s);
  // The review the executor is about to hear: the cycle that just closed.
  const reviewForExecutor = reviewNotesForExecutor(s);
  const out = await runPlanner(s, rt);
  if ("error" in out) {
    const n = s.cycle + 1;
    const p = writeArtifact(s.sessionId, n, "plan.failed.md", out.raw || out.error);
    rt.log?.(`ULW planner failed: ${out.error} (${p})`);
    return release(
      s,
      "blocked",
      `Planner could not produce a plan for cycle ${n}: ${out.error}. Operator: read ${p} and re-arm with /ulw.`,
    );
  }
  const { plan, raw, tokens } = out;
  if (plan.identity) {
    s.identity = plan.identity;
    safe(() => rt.rememberIdentity?.(plan.identity!), undefined);
  }
  if (plan.direction) s.direction = plan.direction;
  if (plan.verdict !== "continue") {
    const n = s.cycle + 1;
    const planPath = writeArtifact(s.sessionId, n, "plan.md", raw);
    s.cycles.push({
      n,
      title: plan.title,
      startedAt: nowIso(),
      endedAt: nowIso(),
      planPath,
      planVerdict: plan.verdict,
      itemsTotal: 0,
      itemsDone: 0,
      waves: 0,
      mustFix: [],
      plannerTokens: tokens,
    });
    const why = plan.verdictNote ? ` — ${plan.verdictNote.replace(/[.\s]+$/, "")}` : "";
    const ops = plan.operator.length ? ` Operator: ${plan.operator.join("; ")}` : "";
    return release(
      s,
      plan.verdict,
      plan.verdict === "fulfilled"
        ? `Planner: ${s.mandate ? "mandate fulfilled" : "the product is in good shape — nothing left is worth a cycle"}${why}. ULW released after ${s.cycles.length - 1} committed cycle(s).${ops}`
        : `Planner: blocked${why}.${ops}`,
    );
  }
  // Admit the plan.
  s.cycle += 1;
  s.phase = "execute";
  s.wave = 0;
  s.fixRounds = 0;
  s.stuckBlocks = 0;
  s.replanRequested = false;
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
  s.cycles.push(planRecord(s, plan, planPath, tokens));
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
  // The gate is judged against what was already failing under *this* command
  // before the cycle touched anything. Cycle 1 measures the user's tree; a
  // later cycle whose Planner declared a different gate (or the first cycle
  // to have one) measures the tree as the last commit left it — otherwise
  // the baseline's command never matches and every old failure is red again.
  if (s.verifyCommand && s.verifyBaseline?.command !== s.verifyCommand) {
    await captureBaseline(s, rt);
  }
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

async function runReviewer(s: CycleState, rt: CycleRuntime, executorCloser: string): Promise<CycleReviewNotes> {
  const record = currentCycleRecord(s);
  const planText = readArtifact(record?.planPath);
  const { diff, files, truncated } = safe(
    () => rt.gitDiffSince(s.cycleStartHead),
    { diff: "", files: [] as string[], truncated: false },
  );
  const brief = buildReviewerBrief({
    state: s,
    workspace: rt.workspace,
    planText,
    diff,
    diffTruncated: truncated,
    changedFiles: files,
    verifyCommand: s.verifyCommand,
    executorCloser,
  });
  const res = await rt.runRole("reviewer", brief, { cycle: s.cycle });
  if (record) record.reviewerTokens = (record.reviewerTokens ?? 0) + res.promptTokens + res.completionTokens;
  const raw = roleBody(res.text);
  const parsed = parseReviewArtifact(raw);
  // No parseable review is a review that did not happen: fail closed (no
  // commit); the work stays in the tree and the next Planner sees why.
  const notes: CycleReviewNotes = parsed ?? {
    verdict: "blocked",
    fulfillment: [],
    revisions: res.editCount > 0 ? [`${res.editCount} edit(s) by the reviewer (no parseable review)`] : [],
    mustFix: [`Reviewer returned no parseable review (${res.status}${res.error ? `: ${res.error}` : ""})`],
    architecture: [],
    operator: [],
  };
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
    else if (f.state === "missing") item.status = "open";
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
  const res = rt.commit({ subject, body });
  if (record) {
    record.commitSha = res.sha;
    record.commitSubject = res.committed ? subject : undefined;
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
  const how = committed?.sha ? ` and committed (${committed.sha})` : committed?.skipped ? ` (not committed: ${committed.skipped})` : "";
  if (s.cycleZeroRequested) {
    const out = release(s, "cycle-zero", `/cycle 0 — cycle ${s.cycle} reviewed${how}; ULW released.`);
    return { ...out, cycleClosed: true, committed };
  }
  if (s.maxCycles != null && s.cycle >= s.maxCycles) {
    const out = release(
      s,
      "max-cycles",
      `max_cycles ${s.maxCycles} reached — cycle ${s.cycle} reviewed${how}; ULW released.`,
    );
    return { ...out, cycleClosed: true, committed };
  }
  const next = await planNextCycle(s, rt);
  return { ...next, cycleClosed: true, committed };
}

/** Commit the cycle. The gate that passed becomes the next cycle's baseline. */
async function finishCycle(s: CycleState, rt: CycleRuntime, accepted: CheckRun | null): Promise<CycleStopOutcome> {
  s.phase = "commit";
  const ac = commitCycle(s, rt);
  if (ac.committed) rt.log?.(`ULW cycle ${s.cycle} committed ${ac.sha ?? ""} — ${ac.subject}`);
  else if (ac.skipped) rt.log?.(`ULW cycle ${s.cycle} commit skipped: ${ac.skipped}`);
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
  const reviewed = Boolean(record?.reviewPath);
  if (!reviewed) {
    if (s.phase === "execute") rt.log?.(`ULW cycle ${s.cycle} → verify (${opts.why})`);
    const pre = await verifyCycle(s, rt, s.fixRounds > 0 ? `pre-review.${s.fixRounds}` : "pre-review");
    if (pre && !pre.verdict.passed) {
      return fixOrRelease(s, pre.run, pre.verdict, { fixRoundsCap: opts.fixRoundsCap, reviewed: false });
    }
    s.phase = "review";
    saveCycleState(s);
    rt.log?.(`ULW cycle ${s.cycle} → review`);
    const notes = await runReviewer(s, rt, facts.lastAssistantMessage);
    if (notes.verdict === "blocked") {
      rt.log?.(`ULW cycle ${s.cycle} review: blocked — no commit; the next plan starts from the must-fix`);
      return advanceAfterCycle(s, rt, { skipped: "review blocked" });
    }
  }
  const post = await verifyCycle(s, rt, s.fixRounds > 0 ? `post-review.${s.fixRounds}` : "post-review");
  if (post && !post.verdict.passed) {
    return fixOrRelease(s, post.run, post.verdict, { fixRoundsCap: opts.fixRoundsCap, reviewed: true });
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
  if (stamped) rememberSerendipity(s, opts.facts.lastAssistantMessage);
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
  return planNextCycle(s, rt);
}

const SERENDIPITY_RECORD_KEEP = 12;

/** The executor's `Serendipity:` lines at this Stop join the cycle's record for the next Planner. */
function rememberSerendipity(s: CycleState, closer: string): void {
  const found = extractSerendipityLines(closer);
  if (!found.length) return;
  const record = currentCycleRecord(s);
  if (!record) return;
  const have = record.serendipity ?? [];
  const seen = new Set(have.map((l) => l.toLowerCase()));
  for (const l of found) {
    if (seen.has(l.toLowerCase())) continue;
    seen.add(l.toLowerCase());
    have.push(l);
  }
  record.serendipity = have.slice(-SERENDIPITY_RECORD_KEEP);
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
