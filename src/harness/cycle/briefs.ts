/**
 * Role briefs — what the fresh-context Planner and Reviewer are handed.
 *
 * A brief is facts plus the output contract. The executor's prose never
 * enters: the Planner reads the mandate, the identity, the prior cycles'
 * plans and reviews, the user's interjections and the tree; the Reviewer
 * reads the plan and the cycle diff. Freshness is the point — the model that
 * made the changes is not the one that judges them. The mandate is passed
 * through verbatim (no rewriter, no classifier); quality is invariant — see
 * MANDATE_QUALITY_BAR.
 *
 * Each role runs in two turns, and the split is the doctrine enforced by
 * sequence: the Planner's turn 1 (the scout) has the product and none of the
 * record, because forge-planner starts by exercising the product, and a Planner that read
 * two thousand characters of history first planned the history's next line.
 * The Reviewer's turn 1 (the look) has the product and none of the diff,
 * because forge-prove says run, read, then claim. The single-brief builders
 * remain as the fallback when two turns are off or unavailable.
 */
import { planArtifactContract, reviewArtifactContract, scoutArtifactContract } from "./artifacts.js";
import type { CycleRecord, CycleState, ReviewVerdict } from "./state.js";

export interface PlannerBriefInput {
  state: CycleState;
  workspace: string;
  gitLog: string;
  gitStatus: string;
  guidelineSurvey: string;
  projectChecks: string[];
  userMessages: string[];
}

/** Turn 1 of the Planner: the product, the tree, the procedure — no record. */
export interface PlannerScoutInput {
  state: CycleState;
  workspace: string;
  gitStatus: string;
  projectChecks: string[];
}

/** What the run has cost so far, from the record — a boss knows the budget. */
export interface RunSpend {
  cycles: number;
  committed: number;
  plannerTokens: number;
  reviewerTokens: number;
  /** Priced only when the caller can price it; the brief shows tokens otherwise. */
  usd?: number;
}

/** Turn 2 of the Planner: the scout back, then the record. `scoutText` absent = single-brief mode. */
export interface PlannerPlanInput extends PlannerBriefInput {
  scoutText?: string;
  spend: RunSpend;
}

export function runSpend(s: CycleState): RunSpend {
  let plannerTokens = 0;
  let reviewerTokens = 0;
  let committed = 0;
  for (const c of s.cycles) {
    plannerTokens += c.plannerTokens ?? 0;
    reviewerTokens += c.reviewerTokens ?? 0;
    if (c.commitSha) committed++;
  }
  return { cycles: s.cycles.length, committed, plannerTokens, reviewerTokens };
}

/**
 * One line per shipped cycle: what it set out to do and how it was judged.
 * A record of what shipped, deliberately not the previous plan's body — a
 * 30-cycle HashPet run continued the last plan's theme and its Out-of-scope
 * list for nine cycles of one-string renames. The Planner starts from the
 * product every cycle; this tells it what is already done. The Planner's
 * `Worth the cycle:` claim sits beside the Reviewer's `Worth:` finding so a
 * reader sees whether the boss's sentence held.
 */
function cycleLine(c: CycleRecord): string {
  const bits = [
    `cycle ${c.n}${c.title ? ` — ${c.title}` : ""}`,
    c.direction ? clipBlock(c.direction, 220).replace(/\n/g, " ") : "",
    c.reviewVerdict ? `review: ${c.reviewVerdict}` : "",
    c.worthClaim ? `worth claimed: ${clipBlock(c.worthClaim, 160).replace(/\n/g, " ")}` : "",
    c.worth ? `worth found: ${clipBlock(c.worth, 160).replace(/\n/g, " ")}` : "",
    c.commitSha ? `commit ${c.commitSha}` : c.endedAt ? "no commit" : "",
  ].filter(Boolean);
  return bits.join(" · ");
}

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function spendLines(spend: RunSpend): string[] {
  const usd = spend.usd != null ? ` · about $${spend.usd.toFixed(2)}` : "";
  return [
    `## Spend so far`,
    `${spend.committed} committed cycle${spend.committed === 1 ? "" : "s"} of ${spend.cycles} planned · Planner ${fmtTokens(spend.plannerTokens)} tokens · Reviewer ${fmtTokens(spend.reviewerTokens)} tokens${usd}. A cycle costs roughly what the last one did; a boss decides whether to spend as much as what on.`,
  ];
}

/** The executor's `Dispute:` lines, newest cycle first — a push-back with evidence, for the Planner to weigh. */
function disputeLines(s: CycleState): string[] {
  const out: string[] = [];
  for (const c of [...s.cycles].reverse()) {
    for (const l of c.disputes ?? []) {
      if (out.length >= SERENDIPITY_BRIEF_KEEP) return out;
      out.push(`cycle ${c.n}: ${clipBlock(l, 300).replace(/\n/g, " ")}`);
    }
  }
  return out;
}

function promiseLines(s: CycleState): string[] {
  if (!s.promises?.length) return [];
  return [
    ``,
    `## Promises as you last recorded them (re-inspect every one against the tree as it is now; do not copy)`,
    ...s.promises.map((p) => `- ${p.text} — ${p.state}${p.seen ? ` — ${p.seen}` : ""}`),
  ];
}

function clipBlock(text: string, max: number): string {
  const t = (text || "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n… [clipped ${t.length - max} chars]`;
}

const SERENDIPITY_BRIEF_KEEP = 12;

/**
 * The executor's `Serendipity:` lines, newest cycle first. Evidence from
 * inside the work — a Planner that never sees them plans from the outside
 * only, and the protocol promised the executor they would be read.
 */
function serendipityLines(s: CycleState): string[] {
  const out: string[] = [];
  for (const c of [...s.cycles].reverse()) {
    for (const l of c.serendipity ?? []) {
      if (out.length >= SERENDIPITY_BRIEF_KEEP) return out;
      out.push(`cycle ${c.n}: ${clipBlock(l, 240).replace(/\n/g, " ")}`);
    }
  }
  return out;
}

/** The previous review's shape notes — the Reviewer reads them to name a recurrence. */
function previousShapeLines(s: CycleState): string[] {
  const prior = [...s.cycles].reverse().find((c) => c.n < s.cycle && c.architecture?.length);
  if (!prior) return [];
  return [
    `## The last review's shape notes (cycle ${prior.n}) — is any of it back?`,
    ...prior.architecture!.slice(0, 6).map((a) => `- ${clipBlock(a, 300).replace(/\n/g, " ")}`),
    `Check whether a repeated note identifies an unresolved defect in this cycle. Acceptance defects are Must-fix; nonblocking improvements remain Architecture observations.`,
    ``,
  ];
}

/**
 * The mandate is the user's attention, not a spec and not a quality ceiling.
 * The harness never rewrites it — that was `ulwExpandedMandate` / `isSoftPrompt`,
 * and a `/` in "UI/UX" once picked the wrong contract for a 250-wave run.
 * The Planner translates after using the product; these lines are in every
 * brief so a sloppy prompt cannot set the floor.
 */
export const MANDATE_QUALITY_BAR = [
  `The mandate is attention — what they care about — not a spec, not a checklist, and not a quality ceiling. Vague, hype or laundry-list wording does not license vague, hype or laundry-list work. A specific request is still that request, done like a veteran — not a product rewrite they did not ask for.`,
  `Direction: is your sentence after using the product and knowing the category's bar. Do not copy their adjectives into Direction: or Items:. If you do not already know what a demanding user of this kind of product notices first, web_search it and/or read the matching shipped forge-* skill from the catalog (games: forge-game-assets / forge-game-ui / forge-imagine; UI: forge-surface / forge-polish; CLI: forge-shape). The bar is that user, not the prompt.`,
];

function mandateLines(s: CycleState): string[] {
  return [
    `## Mandate`,
    s.mandate
      ? s.mandate
      : `(none) — the user gave no direction. Derive it from the product itself: what it is, who it serves, what it promises, what a tool of this kind is expected to do, and where this tree falls short. That gap is the direction.`,
    ...MANDATE_QUALITY_BAR,
  ];
}

/** Steps 1–6: the product, before any history. */
const SCOUT_PROCEDURE = [
  `1. Identity: what is this product, who uses it, for what job. README, docs, --help, manifests, tests as spec. One paragraph.`,
  `2. Use it. Exercise a representative job end to end before proposing changes: build and run the CLI, navigate the app through completion and back out (call_mcp → playwright), run a library's consumer example, or exercise a service, pipeline or harness through its public boundary. Include relevant failure, recovery and repeated-use conditions; read setup or safety instructions first when needed. Use local fixtures for actions with external effects. Do not edit. Write observations and limits under Looked:. If a surface cannot run here, name what remains unverified; source inspection is evidence about implementation, not proof the flow works.`,
  `3. Promises: the product's own checklist. Claims in README, --help, tests and the identity are evidence of intended behavior, not an exhaustive definition of excellence. Mark each kept | broken | absent | unknown with where you saw it. Unknown means unverified: investigate before proposing repair, rather than calling it kept or missing. Preserve the product's purpose; removing a promise does not fulfill it. Re-inspect the current state rather than copying the previous list.`,
  `4. Category: know the bar for this kind of product. If you do not, web_search what a demanding user of this category notices first, and/or read the matching shipped forge-* skill. Competitors are context, not a feature checklist. The user's adjectives are not the bar. Consider the first-session user, the repeat user, the operator and the maintainer. Delegate independent reads with different lenses when useful. Infer reasonable choices from this project's purpose and constraints; do not require a prompt to find its next improvement.`,
  `5. Tree: inspect the core job and its dependencies. Consider correctness, usability and accessibility, reliability and recovery, security and privacy, performance and resource cost, compatibility, operability, documentation and maintainability where they matter to this product. These are discovery lenses, not quotas or scores. Follow evidence to the most consequential gaps.`,
  `6. Considered: compare the strongest evidenced candidates with their benefits, risks and cost. Missing capability, broken promise, rough edge and architectural debt are possible sources, not required bins; do not invent a candidate for an empty bin. Always include leave it — <why leaving this area unchanged may be better>. An investigation that resolves a consequential unknown is legitimate work; state the question and the observation that would change the decision.`,
];

/** Steps 7–11: the record arrives; harmonize, price, verdict. */
const PLAN_PROCEDURE = [
  `7. Strike what is done. Read the record below; drop the candidates it already covers. If the record shows the same kind of change twice, investigate whether a shared cause remains and whether one decision resolves the remaining instances. Similar labels alone do not prove a shared cause; independent defects need not become an abstraction. The record is not a thread; it tells you what is done, not what to continue.`,
  `8. Harmonize: one coherent theme, as many items as it needs. Direction: is the cycle's intended benefit in your words after using the product — never a restatement of the mandate. Each item names its files; serves: the job in Identity it serves; red now: an observed defect, measured limitation, concrete regression risk or consequential evidence gap (unchecked — <why> only when you could not look); proof: the command or observable that would distinguish improvement from no improvement. Existing behavior may already pass while its regression protection is missing: a test-only item must identify the plausible fault its new check catches. An investigation may conclude no change is justified. A vocabulary, copy or consistency gap is one item across its affected surfaces, or Out of scope. The last review's Must-fix and unfinished items come first.`,
  `9. Worth the cycle: identify the benefit to this product's user, operator or maintainer and the evidence for it; weigh added complexity, compatibility risk and ongoing cost against leave it. Prevented data loss, safer behavior, recovery, reduced resource use and effective regression protection can be valuable without a visible feature. A general practice earns a cycle through a concrete problem here, not its reputation. The spend so far is above.`,
  `10. Guidelines: does the AGENTS.md-class file describe this product and carry the conventions an executor needs? Fact defects and missing conventions are the plan's first item; removing existing doctrine is a proposal, not an edit.`,
  `11. Verdict: fulfilled releases a run only when its explicit mandate is met. An explicit mandate is fulfilled when the job they pointed at is met at veteran quality, not when every adjective is ticked. With no mandate the run continues investigating: kept promises and a clean first session are not proof of excellence. If no change is justified, plan a bounded investigation of the most consequential remaining uncertainty with a decision it can inform; leave that area unchanged when the evidence supports it. A no-mandate fulfilled is redirected into further work by the harness. Never invent defects or edits to keep running. Use blocked only when an external dependency or user-only decision prevents meaningful progress across the available work.`,
];

/**
 * Turn 1 — the scout. The Planner uses the product, holds it to its own
 * promises, and weighs the alternatives before it has seen one line of what
 * this run has done. Nothing from the record is here by construction.
 */
export function buildPlannerScoutBrief(input: PlannerScoutInput): string {
  const s = input.state;
  const next = s.cycle + 1;
  const lines: string[] = [
    `[Forge cycle planner — cycle ${next}, turn 1 of 2: the scout]`,
    `You are the Planner for an autonomous plan-cycle run. You have no prior context on purpose: use the product, judge it against its own promises, weigh what could be done. You do not implement. The record of what this run has already shipped arrives in your next turn — do not guess at it; every cycle starts from the product.`,
    ``,
    `## Workspace`,
    input.workspace,
    ``,
    ...mandateLines(s),
  ];
  if (s.identity) {
    lines.push(``, `## Identity (persisted — reaffirm in the scout, or propose a change as an Operator: line in the plan)`, s.identity);
  }
  lines.push(...promiseLines(s));
  lines.push(
    ``,
    `## Tree`,
    input.gitStatus || "(git status unavailable)",
    ``,
    `## Project checks the stack table knows`,
    input.projectChecks.length ? input.projectChecks.map((c) => `- \`${c}\``).join("\n") : "- (none detected)",
    ``,
    `## Procedure`,
    ...SCOUT_PROCEDURE,
    ``,
    `## Output`,
    `Your final message this turn is the scout and nothing else, in exactly this shape:`,
    scoutArtifactContract(next),
  );
  return lines.join("\n");
}

/** The record: what shipped, what the last review left, what the executor and the user said, what it cost. */
function recordLines(input: PlannerPlanInput): string[] {
  const s = input.state;
  const lines: string[] = [];
  if (s.direction) {
    lines.push(``, `## Direction so far`, s.direction);
  }
  if (s.cycles.length) {
    lines.push(
      ``,
      `## What this run has shipped (a record, not a thread — do not continue the last theme because it was last; start from the product)`,
    );
    for (const c of s.cycles) lines.push(`- ${cycleLine(c)}`);
    // "The last review" is the last cycle a Reviewer read, not the last record.
    const last = [...s.cycles].reverse().find((c) => c.reviewVerdict) ?? s.cycles[s.cycles.length - 1];
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
        `Reassess the evidence and alternatives. Plan a concrete benefit or resolve a consequential unknown; do not manufacture a visible change to satisfy Worth:. A mandate may be fulfilled; a no-mandate run continues investigating.`,
      );
    }
    const unfulfilled = s.items.filter((i) => i.status === "open");
    if (unfulfilled.length) {
      lines.push(``, `## Plan items not finished last cycle`);
      for (const i of unfulfilled) lines.push(`- ${i.title}`);
    }
  }
  const noticed = serendipityLines(s);
  if (noticed.length) {
    lines.push(
      ``,
      `## What the executor noticed and left alone (its Serendipity: lines — evidence from inside the work; weigh it, do not obey it)`,
    );
    for (const l of noticed) lines.push(`- ${l}`);
  }
  const disputed = disputeLines(s);
  if (disputed.length) {
    lines.push(
      ``,
      `## What the executor disputed in the last review (its Dispute: lines — a push-back with evidence; weigh the evidence, not the tone)`,
    );
    for (const l of disputed) lines.push(`- ${l}`);
  }
  if (input.userMessages.length) {
    lines.push(``, `## What the user said since the last plan (weigh it; it outranks the previous direction)`);
    for (const m of input.userMessages.slice(-6)) lines.push(`- ${clipBlock(m, 600).replace(/\n/g, " ")}`);
  }
  lines.push(``, `## Commits this run`, input.gitLog || "(none yet)", ``, ...spendLines(input.spend));
  return lines;
}

/**
 * Turn 2 — the plan. The scout comes back to its author, then the record;
 * the Planner strikes what is done, names the class if there is one, and
 * writes the plan the contract asks for.
 */
export function buildPlannerPlanBrief(input: PlannerPlanInput): string {
  const s = input.state;
  const next = s.cycle + 1;
  const lines: string[] = [
    `[Forge cycle planner — cycle ${next}, turn 2 of 2: the plan]`,
    `Your scout is below, then the record of this run. Strike what is done, find the class if there is one, harmonize one theme, price it against leave it, write the plan. You do not implement.`,
    ``,
    `## Workspace`,
    input.workspace,
    ``,
    ...mandateLines(s),
  ];
  if (s.identity) {
    lines.push(``, `## Identity (persisted — reaffirm or propose a change as an Operator: line)`, s.identity);
  }
  lines.push(``, `## Your scout (turn 1)`, clipBlock(input.scoutText ?? "", 8_000) || "(no scout document came back — judge from what you saw this session)");
  lines.push(...recordLines(input));
  lines.push(
    ``,
    `## Tree`,
    input.gitStatus || "(git status unavailable)",
    ``,
    `## Project checks the stack table knows`,
    input.projectChecks.length ? input.projectChecks.map((c) => `- \`${c}\``).join("\n") : "- (none detected — declare one or say none)",
    ``,
    `## Agent guidelines survey`,
    input.guidelineSurvey || "(no AGENTS.md-class file found — the plan's first item may create one)",
    ``,
    `## Procedure`,
    ...PLAN_PROCEDURE,
    ``,
    `## Output`,
    `Your final message is the plan and nothing else, in exactly this shape:`,
    planArtifactContract(next),
  );
  return lines.join("\n");
}

/**
 * Single-brief fallback (`FORGE_ULW_TWO_TURN=0`, or a runtime that cannot
 * keep a role session): scout and plan in one message. The order of the
 * sections still puts the product before the record, but nothing enforces
 * the order of reading — that is what the two turns are for.
 */
export function buildPlannerBrief(input: PlannerPlanInput): string {
  const s = input.state;
  const next = s.cycle + 1;
  const lines: string[] = [
    `[Forge cycle planner — cycle ${next}]`,
    `You are the Planner for an autonomous plan-cycle run. You have no prior context on purpose: read, research, judge, write the plan. You do not implement. This is one turn: do steps 1–6 with the product before you read the record further down, then steps 7–11.`,
    ``,
    `## Workspace`,
    input.workspace,
    ``,
    ...mandateLines(s),
  ];
  if (s.identity) {
    lines.push(``, `## Identity (persisted — reaffirm or propose a change as an Operator: line)`, s.identity);
  }
  lines.push(...promiseLines(s));
  if (input.scoutText?.trim()) {
    // Turn 1 ran but its session could not be resumed: what it saw stands.
    lines.push(``, `## A scout written earlier this cycle (its findings stand; verify anything you doubt)`, clipBlock(input.scoutText, 8_000));
  }
  lines.push(
    ``,
    `## Tree`,
    input.gitStatus || "(git status unavailable)",
    ``,
    `## Project checks the stack table knows`,
    input.projectChecks.length ? input.projectChecks.map((c) => `- \`${c}\``).join("\n") : "- (none detected — declare one or say none)",
    ``,
    `## Procedure`,
    ...SCOUT_PROCEDURE,
    ``,
    `## The record — read only after steps 1–6`,
  );
  lines.push(...recordLines(input));
  lines.push(
    ``,
    `## Agent guidelines survey`,
    input.guidelineSurvey || "(no AGENTS.md-class file found — the plan's first item may create one)",
    ``,
    `## Procedure, continued`,
    ...PLAN_PROCEDURE,
    ``,
    `## Output`,
    `Your final message is the plan and nothing else, in exactly this shape — with one addition: a \`Promises:\` section (the scout's rows, \`<promise> — kept | broken | absent | unknown — <where seen>\`) right after \`Considered:\`, since there is no separate scout this turn.`,
    planArtifactContract(next),
  );
  return lines.join("\n");
}

/** The last few cycles' Worth: judgments let the Reviewer see repeated low-value work. */
function recentWorthLines(s: CycleState): string[] {
  const prior = s.cycles.filter((c) => c.n < s.cycle && (c.worth || c.title)).slice(-4);
  if (!prior.length) return [];
  return [
    `## Recent cycles — did each justify its cost?`,
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

/** Turn 1 of the Reviewer: the product on the tree as the cycle left it — no diff. */
export interface ReviewerLookInput {
  state: CycleState;
  workspace: string;
  /** The plan's Direction: the intended benefit or question to resolve. */
  direction?: string;
  /** The plan's Looked: what the Planner saw before the cycle. */
  plannerLooked?: string;
  verifyCommand?: string;
}

/**
 * Turn 1 — the look. forge-prove: run, read, then claim. A Reviewer that
 * opens the diff first judges worth by the diff's effort; one that used the
 * product first judges it by what a user meets.
 */
export function buildReviewerLookBrief(input: ReviewerLookInput): string {
  const s = input.state;
  const lines: string[] = [
    `[Forge cycle reviewer — cycle ${s.cycle}, turn 1 of 2: the look]`,
    `You are the Reviewer for an autonomous plan-cycle run. You have no prior context on purpose. Before you read the diff — that comes next turn — exercise the job or condition the cycle intended to improve through the product's public boundary. Use complete workflows, consumer examples, representative inputs, failure or recovery conditions as appropriate to this project. Use local fixtures for external effects. Do not edit in this turn. Write what you did, what you observed and what remains unverified.`,
    ``,
    `## Workspace`,
    input.workspace,
  ];
  if (s.identity) lines.push(``, `## Identity`, s.identity);
  lines.push(
    ``,
    `## What this cycle set out to improve or establish`,
    input.direction || "(the plan gave no Direction: line)",
    ``,
    `## What the Planner saw before the cycle`,
    input.plannerLooked || "(the plan gave no Looked: line)",
  );
  if (input.verifyCommand) {
    lines.push(``, `## Verify`, `\`${input.verifyCommand}\` is the cycle gate; the harness ran it and it is green. You do not need to run it this turn.`);
  }
  lines.push(
    ``,
    `## Output`,
    `Your final message this turn is the look and nothing else, in exactly this shape:`,
    `# Cycle ${s.cycle} look`,
    `Looked: <what you ran or opened as the product's user and what you saw — or: could not run — <why>>`,
  );
  return lines.join("\n");
}

/** The record for the Reviewer: the class of each cycle is only visible against the ones before it. */
function reviewerRecordLines(s: CycleState): string[] {
  const prior = s.cycles.filter((c) => c.n < s.cycle);
  if (!prior.length) return [];
  return [
    `## What this run has shipped before this cycle`,
    ...prior.map((c) => `- ${cycleLine(c)}`),
    `If this cycle's change is the same class as earlier work, investigate whether a shared cause remains. Name the evidence and a concrete correction; similar labels or an arbitrary cycle count do not prove a defect. An unresolved acceptance defect belongs under Must-fix; nonblocking future work belongs under Architecture.`,
    ``,
  ];
}

const REVIEWER_DUTY = [
  `## Duty`,
  `- Fulfilment: for every plan item, is it done, partial, or missing? Judge from the tree, not the closer.`,
  `- Regressions, weakened or deleted assertions, stubs, TODOs left as work, error paths swallowed.`,
  `- Shape: one idea forked across files, a signature that grew arguments, a flag that is always the same value, comments that narrate the change ("used to", "no longer"), exports bolted onto an unrelated module when a new module was due.`,
  `- Tests: checks must catch a plausible fault, not mirror source text or assert a tautology. Test-only changes are valid when they add meaningful regression protection or resolve a concrete evidence gap; demonstrate the fault they would catch. Do not require a production edit for behavior that is already correct, and do not add coverage merely to grow the test count.`,
  `- Persisted data and public surface: a storage key, schema, exported API, CLI flag or wire format that changed needs a migration or a compatibility path in this diff, or a Must-fix that names the break.`,
  `- Class: use the record to investigate recurring defects and their shared cause. Require evidence before demanding an abstraction or another repair; repeated labels alone are not a defect.`,
  `- Revise what you can now — small, correct, in the project's own conventions. Repairable unresolved defects belong under Must-fix with Verdict: ship-with-revisions: the harness withholds commit, lets the executor fix them in this cycle, then runs a fresh review. Partial or missing items cannot ship. Reserve blocked for an unavailable review, an external constraint or a direction that requires replanning. Nonblocking observations and future improvements belong under Architecture for the next Planner to weigh.`,
  `- Worth: judge the benefit to this product's user, operator or maintainer from evidence, not visibility or the diff's effort. Judge against a demanding user of this product, not against whether the diff matches the mandate's adjectives. Reliability, security, accessibility, performance, recovery, compatibility, maintainability and regression protection can justify a cycle. Name the actual failure avoided, cost reduced or uncertainty resolved and weigh complexity and risk. Compare the plan's Considered: alternatives with leave it. A useful investigation may produce no code change. Worth: no means the benefit was not established or did not justify the cost; explain how the next Planner should reassess it without demanding cosmetic work. Repeated low-value cycles call for a different question or approach, not an arbitrary count-based defect.`,
  `- Do not widen scope. Do not start the next cycle's work.`,
];

function reviewerBodyLines(input: ReviewerBriefInput): string[] {
  const s = input.state;
  return [
    `## The plan this cycle executed (read its Considered: — the alternatives it weighed)`,
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
    ...reviewerRecordLines(s),
    ...recentWorthLines(s),
    ...previousShapeLines(s),
    `## Verify`,
    input.verifyCommand
      ? `\`${input.verifyCommand}\` — run it yourself after your revisions; the harness runs it again and a red run blocks the commit.`
      : `No project check is declared. Say so under Must-fix if this repo should have one.`,
    ``,
    ...REVIEWER_DUTY,
    ``,
    `## Output`,
    `Your final message is the review and nothing else, in exactly this shape:`,
    reviewArtifactContract(s.cycle),
  ];
}

/** Turn 2 — the review. The look comes back to its author, then the plan, the diff and the record. */
export function buildReviewerReviewBrief(input: ReviewerBriefInput & { lookText?: string }): string {
  const s = input.state;
  const lines: string[] = [
    `[Forge cycle reviewer — cycle ${s.cycle}, turn 2 of 2: the review]`,
    `You used the product last turn; your look is below. Now read the plan and the cycle's diff as a hostile senior reviewer and as an architect, and revise in place — you have write access. The harness runs the verify command after you and commits only on green.`,
    ``,
    `## Workspace`,
    input.workspace,
    ``,
    `## Your look (turn 1)`,
    clipBlock(input.lookText ?? "", 3_000) || "(no look document came back — say so under Looked:)",
    ``,
    ...reviewerBodyLines(input),
  ];
  return lines.join("\n");
}

/** Single-brief fallback: the look is asked for first, in the same message. */
export function buildReviewerBrief(input: ReviewerBriefInput): string {
  const s = input.state;
  const lines: string[] = [
    `[Forge cycle reviewer — cycle ${s.cycle}]`,
    `You are the Reviewer for an autonomous plan-cycle run. You have no prior context on purpose. Before you read the diff, exercise the cycle's intended benefit or question through a representative workflow, consumer example or failure condition, with local fixtures for external effects. Write observations and limits under Looked:. Then read the plan and cycle diff as a hostile senior reviewer and as an architect, and revise in place — you have write access. The harness runs the verify command after you and commits only after an accepting review and green verification.`,
    ``,
    `## Workspace`,
    input.workspace,
    ``,
    ...reviewerBodyLines(input),
  ];
  return lines.join("\n");
}

/** What the executor is told about the last review — the one reader the review had been missing. */
export interface ReviewNotesForExecutor {
  cycle: number;
  verdict: ReviewVerdict;
  revisions: string[];
  architecture: string[];
  disputed: string[];
  worth?: string;
}

/**
 * The Reviewer revises the executor's work in place and the next Planner reads
 * the review, but the executor — the author — used to hear none of it, so the
 * same revision was made cycle after cycle. This block is the review turned
 * toward its author: what changed and why, what the board overstated, the
 * shape notes, and the standing instruction that they carry forward.
 */
export function formatReviewNotesForExecutor(r: ReviewNotesForExecutor): string {
  const worth = r.worth ? ` · Worth: ${clipBlock(r.worth, 200).replace(/\n/g, " ")}` : "";
  const head = `## The Reviewer's notes on cycle ${r.cycle} — standing for this run`;
  if (!r.revisions.length && !r.architecture.length && !r.disputed.length) {
    return [head, `Verdict: ${r.verdict}${worth}. The Reviewer shipped the cycle as written; keep that bar.`].join("\n");
  }
  const lines = [head, `Verdict: ${r.verdict}${worth}`];
  if (r.revisions.length) {
    lines.push(`Changed in your work, and why:`);
    for (const x of r.revisions.slice(0, 6)) lines.push(`- ${clipBlock(x, 300).replace(/\n/g, " ")}`);
  }
  if (r.disputed.length) {
    lines.push(`Judged against your board:`);
    for (const x of r.disputed.slice(0, 4)) lines.push(`- ${clipBlock(x, 200).replace(/\n/g, " ")}`);
  }
  if (r.architecture.length) {
    lines.push(`Shape notes:`);
    for (const x of r.architecture.slice(0, 4)) lines.push(`- ${clipBlock(x, 300).replace(/\n/g, " ")}`);
  }
  lines.push(
    `Carry applicable corrections forward. A recurring acceptance defect is a Must-fix; nonblocking shape observations are future work for the Planner to weigh.`,
  );
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
  /** The previous cycle's review, turned toward the executor. */
  lastReview?: ReviewNotesForExecutor;
}): string {
  const board = opts.items?.length
    ? `Todo board (update these ids with todo_write; do not add copies): ${opts.items.map((i) => `${i.id} = ${i.title.slice(0, 60)}`).join(" · ")}`
    : "";
  const budget = opts.cycleZeroRequested
    ? `This is the last cycle (/cycle 0 is set): after review and commit the run stops.`
    : opts.maxCycles != null
      ? `Cycle ${opts.cycle} of ${opts.maxCycles}.`
      : `Cycle ${opts.cycle}; the run re-plans after each cycle. Fulfilled releases only an explicit mandate; a no-mandate run continues investigating until a user control or a blocking condition releases it.`;
  return [
    `[Forge ULW cycle driver] Cycle ${opts.cycle} plan — ${opts.title}`,
    ``,
    opts.planText.trim(),
    ``,
    ...(opts.lastReview ? [formatReviewNotesForExecutor(opts.lastReview), ``] : []),
    `You are the executor. Complete the items in order: implement or investigate as planned, run the item's proof, mark it done with todo_write. An investigation can conclude no edit is justified; record its evidence and decision. Cancel an item only with a reason. Ship at veteran quality — the mandate's wording does not license a sloppy ship or extra unplanned scope. Close with "Plan complete." when every item is done or cancelled. The harness then runs ${opts.verifyCommand ? `\`${opts.verifyCommand}\`` : "the project check"} (only failures that were not already failing before the cycle count), a fresh reviewer reads the cycle diff and revises, the check runs once more and changes commit only after an accepting review and green verification. ${budget}`,
    board,
    `Do not stop mid-item, do not ask the user to choose; Operator: lines are for a secret, an irreversible action, or an external blocker only. What you notice and leave alone goes on one \`Serendipity:\` line in your closer; the next Planner reads it. Live controls: /cycle 0 · /replan · /ulw-off.`,
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
    `Continue the plan: implement or investigate the next item as planned, run its proof${opts.verifyCommand ? ` (cheapest first; \`${opts.verifyCommand}\` is the cycle gate)` : ""}, mark it done with todo_write. Close with "Plan complete." when the board is clear.${stuck}`,
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
    `Fix the failure in the code — never weaken or delete an assertion to go green — then stop; the harness re-runs the check, runs a fresh review of the repaired tree, then checks again and commits only after acceptance and green verification.`,
  ]
    .filter(Boolean)
    .join("\n");
}
