/**
 * Role briefs — what the fresh-context Planner and Reviewer are handed.
 *
 * A brief is facts plus the output contract. The executor's prose never
 * enters: the Planner reads the mandate, the identity, the prior cycles'
 * plans and reviews, the user's interjections and the tree; the Reviewer
 * reads the plan and the cycle diff. Freshness is the point — the model that
 * made the changes is not the one that judges them.
 */
import { planArtifactContract, reviewArtifactContract } from "./artifacts.js";
import type { CycleRecord, CycleState } from "./state.js";

export interface PlannerBriefInput {
  state: CycleState;
  workspace: string;
  gitLog: string;
  gitStatus: string;
  guidelineSurvey: string;
  projectChecks: string[];
  userMessages: string[];
}

/**
 * One line per shipped cycle: what it set out to do and how it was judged.
 * A record of what shipped, deliberately not the previous plan's body — a
 * 30-cycle HashPet run continued the last plan's theme and its Out-of-scope
 * list for nine cycles of one-string renames. The Planner starts from the
 * product every cycle; this tells it what is already done.
 */
function cycleLine(c: CycleRecord): string {
  const bits = [
    `cycle ${c.n}${c.title ? ` — ${c.title}` : ""}`,
    c.direction ? clipBlock(c.direction, 220).replace(/\n/g, " ") : "",
    c.reviewVerdict ? `review: ${c.reviewVerdict}` : "",
    c.worth ? `worth: ${clipBlock(c.worth, 160).replace(/\n/g, " ")}` : "",
    c.commitSha ? `commit ${c.commitSha}` : c.endedAt ? "no commit" : "",
  ].filter(Boolean);
  return bits.join(" · ");
}

function clipBlock(text: string, max: number): string {
  const t = (text || "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n… [clipped ${t.length - max} chars]`;
}

export function buildPlannerBrief(input: PlannerBriefInput): string {
  const s = input.state;
  const next = s.cycle + 1;
  const lines: string[] = [
    `[Forge cycle planner — cycle ${next}]`,
    `You are the Planner for an autonomous plan-cycle run. You have no prior context on purpose: read, research, judge, write the plan. You do not implement.`,
    ``,
    `## Workspace`,
    input.workspace,
    ``,
    `## Mandate`,
    s.mandate
      ? s.mandate
      : `(none) — the user gave no direction. Derive it from the product itself: what it is, who it serves, what a tool of this kind is expected to do, and where this tree falls short. That gap is the direction.`,
  ];
  if (s.identity) {
    lines.push(``, `## Identity (persisted — reaffirm or propose a change as an Operator: line)`, s.identity);
  }
  if (s.direction) {
    lines.push(``, `## Direction so far`, s.direction);
  }
  if (s.cycles.length) {
    lines.push(
      ``,
      `## What this run has shipped (a record, not a thread — do not continue the last theme because it was last; start from the product)`,
    );
    for (const c of s.cycles) lines.push(`- ${cycleLine(c)}`);
    const last = s.cycles[s.cycles.length - 1];
    if (last?.mustFix.length) {
      lines.push(``, `## Must-fix left by the last review (these come first)`);
      for (const m of last.mustFix) lines.push(`- ${m}`);
    }
    if (last?.architecture?.length) {
      lines.push(``, `## The last Reviewer's shape notes`);
      for (const a of last.architecture.slice(0, 6)) lines.push(`- ${clipBlock(a, 300).replace(/\n/g, " ")}`);
    }
    if (last?.worth && /^\s*no\b/i.test(last.worth)) {
      lines.push(
        ``,
        `## The last Reviewer judged the last cycle not worth a cycle`,
        clipBlock(last.worth, 400),
        `Plan work a user will notice, or write Verdict: fulfilled — the product is in good shape.`,
      );
    }
    const unfulfilled = s.items.filter((i) => i.status === "open");
    if (unfulfilled.length) {
      lines.push(``, `## Plan items not finished last cycle`);
      for (const i of unfulfilled) lines.push(`- ${i.title}`);
    }
  }
  if (input.userMessages.length) {
    lines.push(``, `## What the user said since the last plan (weigh it; it outranks the previous direction)`);
    for (const m of input.userMessages.slice(-6)) lines.push(`- ${clipBlock(m, 600).replace(/\n/g, " ")}`);
  }
  lines.push(
    ``,
    `## Tree`,
    input.gitStatus || "(git status unavailable)",
    ``,
    `## Commits this run`,
    input.gitLog || "(none yet)",
    ``,
    `## Project checks the stack table knows`,
    input.projectChecks.length ? input.projectChecks.map((c) => `- \`${c}\``).join("\n") : "- (none detected — declare one or say none)",
    ``,
    `## Agent guidelines survey`,
    input.guidelineSurvey || "(no AGENTS.md-class file found — the plan's first item may create one)",
    ``,
    `## Procedure`,
    `1. Identity: what is this product, who uses it, for what job. README, docs, --help, manifests, tests as spec. One paragraph.`,
    `2. Use it. Before you read a line of source, be its user: build it if it needs building, run the binary, start the app and open it in the browser (call_mcp → playwright), load the extension, walk the first minute a new user walks. You may run any command; you may not edit. Write what you did and saw under Looked:. If it cannot be run here, say why and judge from its user-facing surfaces — never from grep alone.`,
    `3. Category: research online what the best tools of this kind do and what their users complain about; recall what a demanding user expects.`,
    `4. Tree: the whole tree, not a surface — module map, coupling, hot files, dead code, duplication, coverage of the core job.`,
    `5. Gap: should-be minus is — missing capabilities, broken promises (docs vs behaviour), rough edges on the core job, architectural debt that blocks the above. The rank is one question: would a user notice this in their first minute, or first day? Something no user would notice is not a cycle.`,
    `6. Harmonize: one coherent theme, as many items as it needs (1 or 9). A vocabulary, copy or consistency gap is one item across every surface it touches, or it goes under Out of scope — never one string per cycle. Each item names its files and the observable or command that proves it. Invention and repair are both legitimate; the product decides which this cycle needs.`,
    `7. Guidelines: does the AGENTS.md-class file describe this product and carry the conventions an executor needs? Fact defects and missing conventions are the plan's first item; removing existing doctrine is a proposal, not an edit.`,
    `8. Leave it. A mandate that is already met is Verdict: fulfilled. With no mandate, a product in good shape whose remaining ideas no user would notice is also Verdict: fulfilled — say so and the run stops. A mandate that only the user can unblock is Verdict: blocked. Never invent work to avoid any of these.`,
    ``,
    `## Output`,
    `Your final message is the plan and nothing else, in exactly this shape:`,
    planArtifactContract(next),
  );
  return lines.join("\n");
}

/** The last few cycles' Worth: judgments — the record behind "third invisible cycle in a row". */
function recentWorthLines(s: CycleState): string[] {
  const prior = s.cycles.filter((c) => c.n < s.cycle && (c.worth || c.title)).slice(-4);
  if (!prior.length) return [];
  return [
    `## Recent cycles — was each worth a user's notice?`,
    ...prior.map((c) => `- cycle ${c.n}${c.title ? ` — ${c.title}` : ""}: ${c.worth ? clipBlock(c.worth, 160).replace(/\n/g, " ") : "(no Worth: recorded)"}`),
    ``,
  ];
}

export interface ReviewerBriefInput {
  state: CycleState;
  workspace: string;
  planText: string;
  diff: string;
  diffTruncated: boolean;
  changedFiles: string[];
  verifyCommand?: string;
  executorCloser: string;
}

export function buildReviewerBrief(input: ReviewerBriefInput): string {
  const s = input.state;
  const lines: string[] = [
    `[Forge cycle reviewer — cycle ${s.cycle}]`,
    `You are the Reviewer for an autonomous plan-cycle run. You have no prior context on purpose. You read the plan and the cycle's diff as a hostile senior reviewer and as an architect, and you revise in place — you have write access. The harness runs the verify command after you and commits only on green.`,
    ``,
    `## Workspace`,
    input.workspace,
    ``,
    `## The plan this cycle executed`,
    clipBlock(input.planText, 6_000),
    ``,
    `## Files changed this cycle (${input.changedFiles.length})`,
    input.changedFiles.length ? input.changedFiles.map((f) => `- ${f}`).join("\n") : "- (no tracked changes — check untracked files)",
    ``,
    `## Cycle diff${input.diffTruncated ? " (truncated — read the files for the rest)" : ""}`,
    "```diff",
    input.diff || "(empty)",
    "```",
    ``,
    `## Executor's closing message`,
    clipBlock(input.executorCloser, 2_000) || "(none)",
    ``,
    ...recentWorthLines(s),
    `## Verify`,
    input.verifyCommand
      ? `\`${input.verifyCommand}\` — run it yourself after your revisions; the harness runs it again and a red run blocks the commit.`
      : `No project check is declared. Say so under Must-fix if this repo should have one.`,
    ``,
    `## Duty`,
    `- Fulfilment: for every plan item, is it done, partial, or missing? Judge from the tree, not the closer.`,
    `- Regressions, weakened or deleted assertions, stubs, TODOs left as work, error paths swallowed.`,
    `- Shape: one idea forked across files, a signature that grew arguments, a flag that is always the same value, comments that narrate the change ("used to", "no longer"), exports bolted onto an unrelated module when a new module was due.`,
    `- Tests: a test that cannot fail is deleted; a test-only change with no production body is reverted or given its body; the suite is the gate, never the deliverable.`,
    `- Persisted data and public surface: a storage key, schema, exported API, CLI flag or wire format that changed needs a migration or a compatibility path in this diff, or a Must-fix that names the break.`,
    `- Revise what you can now — small, correct, in the project's own conventions. What you cannot fix in this review goes under Must-fix; it becomes the next plan's first items.`,
    `- Worth: you judge the cycle, not only the diff. Would a user notice what this cycle changed — in their first minute, first day? Answer under Worth:. A cycle no user would notice ships if it is correct, and your Worth: no tells the next Planner to find user-visible work or declare the product done; the third such cycle in a row is a Must-fix: stop planning invisible cycles.`,
    `- Do not widen scope. Do not start the next cycle's work.`,
    ``,
    `## Output`,
    `Your final message is the review and nothing else, in exactly this shape:`,
    reviewArtifactContract(s.cycle),
  ];
  return lines.join("\n");
}

/** What the executor reads when a plan lands. */
export function formatPlanAdmission(opts: {
  cycle: number;
  title: string;
  planText: string;
  items?: Array<{ id: string; title: string }>;
  verifyCommand?: string;
  maxCycles: number | null;
  cycleZeroRequested: boolean;
}): string {
  const board = opts.items?.length
    ? `Todo board (update these ids with todo_write; do not add copies): ${opts.items.map((i) => `${i.id} = ${i.title.slice(0, 60)}`).join(" · ")}`
    : "";
  const budget = opts.cycleZeroRequested
    ? `This is the last cycle (/cycle 0 is set): after review and commit the run stops.`
    : opts.maxCycles != null
      ? `Cycle ${opts.cycle} of ${opts.maxCycles}.`
      : `Cycle ${opts.cycle}; the run re-plans after each committed cycle until the Planner says fulfilled or you /cycle 0.`;
  return [
    `[Forge ULW cycle driver] Cycle ${opts.cycle} plan — ${opts.title}`,
    ``,
    opts.planText.trim(),
    ``,
    `You are the executor. Ship the items in order: implement, run the item's proof, mark it done with todo_write. Cancel an item only with a reason. Close with "Plan complete." when every item is done or cancelled. The harness then runs ${opts.verifyCommand ? `\`${opts.verifyCommand}\`` : "the project check"} (only failures that were not already failing before the cycle count), a fresh reviewer reads the cycle diff and revises, the check runs once more and the cycle commits on green. ${budget}`,
    board,
    `Do not stop mid-item, do not ask the user to choose; Operator: lines are for a secret, an irreversible action, or an external blocker only. Live controls: /cycle 0 · /replan · /ulw-off.`,
  ].join("\n");
}

export function formatItemsOpenReanchor(opts: {
  cycle: number;
  wave: number;
  items: Array<{ id: string; title: string; files: string[]; proof?: string }>;
  verifyCommand?: string;
  stuckBlocks: number;
  stuckThreshold: number;
}): string {
  const rows = opts.items
    .slice(0, 8)
    .map(
      (i) =>
        `  • ${i.id} ${i.title}${i.files.length ? ` (${i.files.slice(0, 3).join(", ")})` : ""}${i.proof ? ` — proof: ${i.proof}` : ""}`,
    );
  const stuck =
    opts.stuckBlocks > 0
      ? ` No tree movement for ${opts.stuckBlocks} Stop(s); at ${opts.stuckThreshold} the cycle closes and the reviewer takes over.`
      : "";
  return [
    `[Forge ULW cycle driver] Stop blocked — cycle ${opts.cycle}, wave ${opts.wave}: ${opts.items.length} plan item(s) still open.`,
    ...rows,
    opts.items.length > 8 ? `  … +${opts.items.length - 8} more` : "",
    `Continue the plan: implement the next item, run its proof${opts.verifyCommand ? ` (cheapest first; \`${opts.verifyCommand}\` is the cycle gate)` : ""}, mark it done with todo_write. Close with "Plan complete." when the board is clear.${stuck}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatFixReanchor(opts: {
  cycle: number;
  command: string;
  round: number;
  cap: number;
  tail: string;
  mustFix: string[];
  /** Failures the baseline did not have — the executor's to fix. */
  newFailures?: string[];
  /** Failures that were already there — named so they are left alone. */
  inherited?: string[];
  /** Whether the Reviewer has already read this cycle (post-review verify). */
  reviewed?: boolean;
}): string {
  const fresh = opts.newFailures ?? [];
  const inherited = opts.inherited ?? [];
  const stage = opts.reviewed ? "after review" : "before review";
  return [
    `[Forge ULW cycle driver] Stop blocked — cycle ${opts.cycle} ${stage}: \`${opts.command}\` is RED (fix round ${opts.round}/${opts.cap}).`,
    fresh.length
      ? `New failures (yours to fix): ${fresh.slice(0, 8).map((f) => `\`${f}\``).join(" · ")}${fresh.length > 8 ? ` · +${fresh.length - 8} more` : ""}`
      : "",
    inherited.length
      ? `${inherited.length} failure(s) were already failing before this cycle and do not count — do not edit those tests to chase them.`
      : "",
    opts.mustFix.length ? `Reviewer must-fix: ${opts.mustFix.slice(0, 4).join(" · ")}` : "",
    "```",
    clipBlock(opts.tail, 3_000) || "(no output captured)",
    "```",
    `Fix the failure in the code — never weaken or delete an assertion to go green — then stop; the harness re-runs the check${opts.reviewed ? " and commits on green" : ", then the reviewer reads the cycle"}.`,
  ]
    .filter(Boolean)
    .join("\n");
}
