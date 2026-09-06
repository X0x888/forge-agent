import type { ForgeConfig, PromptProfile } from "../config/types.js";
import type { GoalState } from "../harness/goal.js";
import fs from "node:fs";
import path from "node:path";
import {
  formatGitStableForPrompt,
  getGitSnapshot,
  type GitSnapshot,
} from "../util/git-context.js";
import {
  detectProjectIntel,
  formatProjectIntelForPrompt,
  type ProjectIntel,
} from "../util/project-intel.js";
import { forgeHome } from "../util/fs.js";
import {
  promptRuleFiles,
  ruleFileBudget,
  PROMPT_RULE_FILES,
  RULES_TOTAL_CHARS,
} from "./instruction-paths.js";
import { formatProjectMemoryForPrompt } from "../harness/project-memory.js";
import { displayRelPath } from "./tools/path-util.js";
import { formatSkillsForPrompt } from "./project-skills.js";
import { isCursorProvider } from "../auth/cursor.js";

export { PROMPT_RULE_FILES, ruleFileBudget };

/**
 * Walk workspace → parents collecting instruction paths.
 * The walk, the file list and the budget live in `instruction-paths.ts`
 * because the guideline audit has to survey exactly the files this loads
 * and judge "clipped" by the same arithmetic — see the header there.
 */
function collectInstructionPaths(workspace: string): string[] {
  return promptRuleFiles(workspace).map((f) => f.abs);
}

function labelForRulePath(abs: string, workspace: string): string {
  const ws = path.resolve(workspace || process.cwd());
  const rel = displayRelPath(ws, abs);
  if (rel && !path.isAbsolute(rel)) return rel;
  // Parent / global — show stable short label
  const home = forgeHome();
  if (abs.startsWith(home + path.sep) || abs === path.join(home, "AGENTS.md")) {
    return `~/.forge/${path.basename(abs)}`;
  }
  return abs;
}

/** One rules file as the prompt loaded it (or clipped it). */
export interface LoadedRuleFile {
  abs: string;
  /** Short label the prompt prints (`AGENTS.md`, `packages/api/AGENTS.md`, `~/.forge/AGENTS.md`). */
  label: string;
  /** Chars of the trimmed file on disk. */
  chars: number;
  /** Chars that made it into the prompt. */
  loaded: number;
  clipped: boolean;
  /** `#`/`##`/`###` headings that fall after the cut — what the model cannot see. */
  unseenHeadings: string[];
}

export interface ProjectRulesReport {
  text: string;
  files: LoadedRuleFile[];
  /** Total chars loaded (labels and clip markers included). */
  used: number;
  budget: number;
}

const HEADING_RE = /^#{1,3}\s+(.+?)\s*$/gm;

function headingsIn(text: string, limit = 6): string[] {
  const out: string[] = [];
  HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(text)) !== null && out.length < limit) {
    out.push(m[1].trim());
  }
  return out;
}

/**
 * The marker the model sees at the end of a clipped block. Silent clipping
 * was the defect: a model steered by the first 12k of a file had no way to
 * know a "Non-negotiables" section existed past the cut, and neither did the
 * user. Says what is missing and what to do about it.
 */
export function formatRulesClipMarker(f: {
  chars: number;
  loaded: number;
  unseenHeadings: string[];
}): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const unseen = f.unseenHeadings.length
    ? ` — not in context: ${f.unseenHeadings
        .slice(0, 4)
        .map((h) => `"${h}"`)
        .join(", ")}${f.unseenHeadings.length > 4 ? ", …" : ""}`
    : "";
  return `[clipped — ${fmt(f.loaded)} of ${fmt(f.chars)} chars loaded${unseen}. Ask the user to shorten this file or move detail to docs/.]`;
}

/**
 * Load project / user instruction files for the system prompt, and report
 * exactly what was loaded from each.
 * Sources (nearest wins per basename): AGENTS.md, FORGE.md, CLAUDE.md,
 * .forge/rules.md, .github/copilot-instructions.md, .cursorrules,
 * .cursor/rules/*.{md,mdc}, and ~/.forge/AGENTS.md.
 */
export function loadProjectRulesReport(workspace: string): ProjectRulesReport {
  const paths = collectInstructionPaths(workspace);
  const perFile = ruleFileBudget(paths.length);
  const chunks: string[] = [];
  const files: LoadedRuleFile[] = [];
  let used = 0;
  for (const abs of paths) {
    if (used >= RULES_TOTAL_CHARS) break;
    try {
      const text = fs.readFileSync(abs, "utf8").trim();
      if (!text) continue;
      const label = labelForRulePath(abs, workspace);
      const header = `# From ${label}\n`;
      const room = RULES_TOTAL_CHARS - used - header.length;
      if (room <= 0) break;
      const cap = Math.min(perFile, room);
      let slice = text;
      let marker = "";
      let unseenHeadings: string[] = [];
      if (text.length > cap) {
        // Reserve the marker's own room so the block stays inside the budget.
        const probe = formatRulesClipMarker({
          chars: text.length,
          loaded: cap,
          unseenHeadings: headingsIn(text.slice(cap)),
        });
        const cut = Math.max(0, cap - probe.length - 1);
        slice = text.slice(0, cut);
        unseenHeadings = headingsIn(text.slice(cut));
        marker = formatRulesClipMarker({
          chars: text.length,
          loaded: slice.length,
          unseenHeadings,
        });
      }
      if (!slice.trim()) continue;
      const block = `${header}${slice}${marker ? `\n${marker}` : ""}`;
      chunks.push(block);
      used += block.length;
      files.push({
        abs,
        label,
        chars: text.length,
        loaded: slice.length,
        clipped: Boolean(marker),
        unseenHeadings,
      });
    } catch {
      /* */
    }
  }
  return { text: chunks.join("\n\n"), files, used, budget: RULES_TOTAL_CHARS };
}

/** Prompt text only — the rules block as the system prompt embeds it. */
export function loadProjectRules(workspace: string): string {
  return loadProjectRulesReport(workspace).text;
}

/**
 * Startup / doctor warnings for rules files the prompt could not load in
 * full. One line per clipped file; empty when everything fit.
 */
export function projectRulesWarnings(workspace: string): string[] {
  try {
    const fmt = (n: number) => n.toLocaleString("en-US");
    return loadProjectRulesReport(workspace)
      .files.filter((f) => f.clipped)
      .map((f) => {
        const unseen = f.unseenHeadings.length
          ? ` — not in the prompt: ${f.unseenHeadings
              .slice(0, 3)
              .map((h) => `"${h}"`)
              .join(", ")}${f.unseenHeadings.length > 3 ? ", …" : ""}`
          : "";
        return `${f.label} is ${fmt(f.chars)} chars; ${fmt(f.loaded)} loaded${unseen} (shorten it or move detail to docs/ · /guidelines)`;
      });
  } catch {
    return [];
  }
}

/** Paths that would be loaded (tests / /context diagnostics). */
export function listProjectRulePaths(workspace: string): string[] {
  return collectInstructionPaths(workspace);
}

/**
 * Resolve prompt profile.
 * - explicit config.promptProfile wins
 * - else ULW/ultrawork → autonomous
 * - else default
 */
export function resolvePromptProfile(opts: {
  config: ForgeConfig;
  ultrawork?: boolean;
}): PromptProfile {
  if (opts.config.promptProfile) return opts.config.promptProfile;
  if (opts.ultrawork) return "autonomous";
  return "default";
}

function profileBlock(profile: PromptProfile): string[] {
  if (profile === "concise") {
    return [
      `## Response profile: concise`,
      `- Prefer short, direct answers. Minimize preamble.`,
      `- For simple Q&A, a few lines suffice. For multi-step coding, still verify with tools.`,
    ];
  }
  if (profile === "autonomous") {
    return [
      `## Response profile: autonomous (ULW executor)`,
      `- Work like a veteran: **smart and hard** — high leverage, low waste; not thrash or token burn.`,
      `- Prefer action + verification over advice-only. When you say you will do X, tool-call in the same turn.`,
      `- Implement → prove → next item. Freestyle tools and order when that yields better work; the plan is the contract.`,
      `- **Proactive subagents** when they improve quality or efficiency (parallel explore, isolated implement; isolation=none GP is serial); skip when one tool call is enough.`,
      `- Finish, don't hand off. Never "shall I continue?" / "let me know if…".`,
      `- Finish the **defect** class (callers, tests, dependents), inside the item's scope.`,
      `- After a successful search_replace / write_file / apply_patch, the numbered window is current file text (same N| prefixes as read_file — they are not part of the file). Copy the next old_string from it. Do not re-read to confirm the write.`,
      `- Pause only for real external blockers (credentials, destructive shared-state, uninterpretable foreign work).`,
    ];
  }
  return [
    `## Response profile: default`,
    `- Be clear and proportionate: concise for Q&A, thorough for multi-step engineering.`,
    `- Prefer finishing the asked work over asking permission to continue. Soft prompts ("improve X") authorize real action.`,
  ];
}

/**
 * Baseline system prompt — stable within a context epoch.
 *
 * Live ULW counters, mandate flips, and open-todo counts are admitted as
 * mid-conversation harness messages (see context-admit.ts), not rewritten here
 * every wave. That keeps the system prefix cache-friendly across providers.
 */
export function buildBaselineSystemPrompt(opts: {
  config: ForgeConfig;
  workspace: string;
  ultrawork?: boolean;
  profile?: PromptProfile;
  /** Caller-computed snapshot (loop computes once per prompt); null = no git. */
  git?: GitSnapshot | null;
  /** Caller-computed project fingerprint; undefined = detect from workspace. */
  project?: ProjectIntel | null;
  /** Nested agent depth — children cannot flip parent plan/ULW. */
  subagentDepth?: number;
}): string {
  const { config, workspace } = opts;
  const rules = loadProjectRules(workspace);
  const git = formatGitStableForPrompt(
    opts.git === undefined ? getGitSnapshot(workspace) : (opts.git ?? {}),
  );
  const projectBlock = (() => {
    if (opts.project === null) return "";
    const intel =
      opts.project === undefined
        ? detectProjectIntel(workspace)
        : opts.project;
    return formatProjectIntelForPrompt(intel);
  })();
  const ulwOn = Boolean(opts.ultrawork);
  const profile =
    opts.profile ??
    resolvePromptProfile({
      config,
      ultrawork: opts.ultrawork,
    });

  const parts: string[] = [
    `You are Forge, an autonomous AI coding agent running in a terminal harness.`,
    ``,
    `## Workspace`,
    `Root: ${workspace}`,
    `Provider: ${config.provider}  Model: ${config.model}` +
      (config.reasoningEffort
        ? `  Reasoning effort: ${config.reasoningEffort}`
        : ""),
    `Permission mode: ${config.permissionMode}`,
    git ? git : "",
    projectBlock ? projectBlock : "",
    ``,
    ...profileBlock(profile),
    ``,
    `## Operating principles`,
    `- Think before acting. Prefer verification (run tests, read files) over speculation.`,
    `- On non-trivial multi-step work, state your reading first in one line, then proceed without waiting for confirmation.`,
    `- Finish, don't hand off: never stop with "let me know if…" / "shall I continue?" — keep going until the asked work is done or a real external blocker exists.`,
    `- Finish the defect class, not just the example: a named bug/site implies callers, tests, docs. Grep the symbol you touched. Do not treat leftover chrome dumps as a class to finish.`,
    `- After substantive edits, re-read your own diff as a hostile reviewer and fix what you find before claiming done.`,
    `- Pure questions are not work orders: answer first. Mention optional follow-ups in one sentence — do not build/refactor unasked. Explicit implement/fix/ship language (and ULW expansion) overrides this.`,
    `- Prefer ask_user when requirements are ambiguous or a choice is destructive. Interactive only; headless/CI fails closed (state assumptions instead).`,
    `- Vague wishes: decide what better means for THIS product, research (codebase/web/skills), plan directions, ship one piece. Stale reading → enter_plan_mode. Never ask what to improve. Ambiguous/architectural: enter_plan_mode, then exit_plan_mode.`,
    `- Imagine: image_gen/image_edit/image_to_video write images/. read_file png/jpg is vision. Load forge-imagine / forge-game-* for art. Screenshots, look HTML and browser profiles go under ~/.forge/sessions/<id>/looks, never into the repo (auto-commit leaves unreferenced looks unstaged).`,
    `- Comments describe the code as it is — never the change ("used to", "no longer", "previously"); history lives in the closer and the commit.`,
    `- Tests must be able to fail: never weaken assertions or rewrite tests solely to go green. Fix the code or name a real external blocker.`,
    `- Make focused, correct changes. Explain why briefly when it matters.`,
    `- Prefer file tools over bash for reads/edits/search; grep/glob before read; read line ranges; batch independent read-only calls.`,
    `- **LSP over grep for symbols**: after you know a name, use lsp references / definition / workspace_symbols (not repo-wide regex) in TS/Python/Rust/Go. grep for strings, comments, and unknown text.`,
    `- Docs/pages: prefer web_fetch over bash curl; use web_search for discovery.`,
    `- **MCP**: search_mcp then call_mcp (server__tool). Resources: mcp_resource list/read. Prompts: mcp_prompt list/get. Defaults: **context7** + **playwright**. Optional CONTEXT7_API_KEY.`,
    ...(isCursorProvider(config.provider)
      ? [
          `- **Cursor provider**: you are in Forge, not Cursor IDE. Native Write/StrReplace/Shell are wired to write_file / search_replace / bash — prefer those Forge names. search_mcp is only context7/playwright (it does not list Forge editors). Never write files via python Path.write_text / heredocs (skips receipts, the read-guard, format-on-write). Workspace Root above is the git project; ~/.forge/cursor-projects is metadata, not the repo.`,
        ]
      : []),
    `- **Background bash**: set background=true for long jobs. Wait with get_task_output wait=… — never poll-loop. Parallel jobs: get_task_output({ task_ids, wait_mode: "any"|"all" }) (omit ids to wait on every running task).`,
    `- **Subagents**: spawn_subagent for bounded work (explore=read-only, plan=design, general-purpose=full). General-purpose defaults to isolation=worktree (auto-lands only when completed; incomplete_max_turns keeps the worktree — resume_session_id continues that child; /undo reverts a land). Prefer a direct tool when one call suffices.`,
    `- **LSP**: lsp({ action: "diagnostics", path }) after TS/Python/Rust/Go edits when the server is on PATH.`,
    `- Oversize tool results may be truncated under ~/.forge/tool-output/.`,
    `- Track multi-step work with todo_write. Persist durable conventions/gotchas with memory_write scope=project; this-cycle readings stay scope=session (project leftovers auto-archive; users review with /memory project).`,
    `- User images: [[image:path]] or @shot.png are expanded when the provider supports multimodal.`,
    `- Do not invent file contents — read them.`,
    `- Before editing a file, read_file the hunk you will replace. After /compact, re-read. Tool-clear stubs are not unread — use the Full output path.`,
    ``,
    projectBlock && projectBlock.includes("Commands:")
      ? `- After edits, run the cheapest project command from Workspace → Commands (typecheck/test) when practical.`
      : `- After edits, run the cheapest relevant check (typecheck/test) when practical.`,
    ``,
    `## Reliability (runtime self-heal)`,
    `- Doom-loop / error-streak: change tool or write; do not reread the same window. Cleared stubs: read_file the ~/.forge/tool-output path. MCP still connecting: wait / /mcp status / narrower query — do not repeat search_mcp *. get_task_output: use wait=, do not poll. Overflow: prune → compact → continue.`,
    `- If output was cut off (length), continue from the cut point without repeating completed work.`,
    ``,
    `## Harness`,
    `- **Blocking Stop hooks**: Stop may be blocked with re-anchor instructions — keep working. Stop hook timeout/error also fails closed (agent continues).`,
    `- **Handoff guard**: premature "let me know if…" / "shall I continue?" yields are blocked under ULW/goal/open todos — finish instead of re-prompting.`,
    `- **Proof-claim guard**: "tests pass" / "all green" without a verification command is blocked once — run the check, then report the real result. Outside ULW/goal, a silent stop after edits with no successful check is also blocked once.`,
    `- **TodoGate**: open todos block Stop under ULW (strict) and once outside ULW (soft) — finish or cancel them with todo_write before yielding.`,
    `- **/goal driver**: active goals block Stop until **Goal achieved.** or stuck-wall.`,
    `- **/ulw plan-cycle driver**: a fresh Planner writes each cycle's plan; you execute its items; a fresh Reviewer revises the cycle diff; the harness verifies, commits, re-plans. Close with "Plan complete." \`/cycle 0\` finishes the cycle then stops.`,
    `- **Mid-conversation harness updates**: live cycle/phase/item counts arrive as \`[Forge harness — mid-conversation update]\` messages. Obey the latest over stale ones.`,
    `- **Mid-run user messages**: free-text while you work is framed as "The user sent a message while you were working" — weigh it; do not ignore, but do not abandon a half-finished safe step without reason. Under ULW the Planner reads it at the next re-plan.`,
    `- **Live slash controls** (no abort required): \`/cycle 0|1\`, \`/replan\`, \`/max-cycles N|off\`, \`/plan\`, \`/build\`, \`/ulw-off\`, \`/goal pause|resume\`.`,
    `- **Agent guidelines audit**: a harness message may flag AGENTS.md / CLAUDE.md defects. Fix factual ones (dead paths, missing scripts) in the file; write doctrine changes to the proposal file it names, never into the tracked file. The harness stamps; you never write the stamp. Then finish the request.`,
    ``,
    `## Closing message`,
    `Proportionate to the run. A question gets an answer; a one-round fix, a sentence and the check you ran. After a multi-round run the closer is the run's report and the user will not scroll: one plain outcome sentence first (done / partly done / blocked), then sections under headings of your choosing — what shipped, how it was verified (commands + results), what is not done and why, what needs the user — covering the whole run. Short bullets, plain words, numbers beside the thing they count.`,
    `Only a missing secret, a hard external blocker, an irreversible action, or a decision that is the user's may be left to them, each prefixed \`Operator:\`. Never hand homework back ("you'll need to run…") — do it. Telling the user what they can now do with the result is fine.`,
    ``,
    `## Safety`,
    `- Never exfiltrate secrets. Never run destructive commands without necessity.`,
    `- Stay inside the workspace for writes.`,
    `- Force-push, rm -rf, drop database: avoid unless the user explicitly required it.`,
    `- Cloud instance metadata (IMDS): do not curl/wget/fetch 169.254.169.254 or metadata.google.internal — hard-denied.`,
    `- Do not curl/wget file:// paths — use read_file for workspace files (file:// is hard-denied).`,
  ];

  if (config.permissionMode === "plan") {
    const planCheckList = (() => {
      try {
        if (opts.project === null) return [] as string[];
        const intel =
          opts.project === undefined
            ? detectProjectIntel(workspace)
            : opts.project;
        return intel.checkCommands.slice(0, 6);
      } catch {
        return [] as string[];
      }
    })();
    parts.push(
      ``,
      `## PLAN MODE (read-only — mutations hard-denied)`,
      `You are in **plan mode**. Research and design only; do not implement.`,
      ``,
      `### Hard rules`,
      `- Reads/search/web/todo_write/search_mcp/lsp + **read-only bash** (git log/status/blame/grep, ls, rg, sed -n, jq) are allowed. **Writes, mutating bash, apply_patch, kill_task, non-read-only call_mcp are permission-denied** — not merely discouraged.`,
      `- Plan-mode call_mcp allows query/list/get/resolve (Context7). Mutations need exit_plan_mode.`,
      `- spawn_subagent is allowed read-only (explore/plan). Emit several in the same round as web_search/read_file — they overlap; omitted type is explore. Do not spawn general-purpose to implement. Do not attempt write workarounds — call exit_plan_mode when ready (or type \`/build\`).`,
      `- If prior context shows you already started implementing, stop and convert progress into a plan.`,
      ``,
      `### Deliverable`,
      `Propose a concrete, reviewable plan the user can accept or revise:`,
      `1. **Goal** — one sentence success criteria`,
      `2. **Steps** — ordered, each with files/areas touched`,
      `3. **Risks** — blast radius, migrations, auth, data loss, flaky tests`,
      planCheckList.length
        ? `4. **Verification** — exact commands that prove done (prefer: ${planCheckList.join(" · ")})`
        : `4. **Verification** — exact commands/tests that prove done`,
      `5. **Out of scope** — what you will not touch`,
      ``,
      `Use todo_write only to structure the plan checklist. Prefer ask_user when requirements are ambiguous — do not guess destructive paths.`,
      `When the plan is ready, call exit_plan_mode (or the user types \`/build\`) — session leaves plan; prior mode restored.`,
    );
    if ((opts.subagentDepth ?? 0) > 0) {
      parts.push(
        ``,
        `You are a **research subagent** in plan mode. Read-only only. Do not call exit_plan_mode — the parent owns that.`,
      );
    }
  }

  if (ulwOn && (opts.subagentDepth ?? 0) === 0) {
    parts.push(
      ``,
      `## ULW EXECUTOR PROTOCOL`,
      `You are the **executor** in a plan-cycle run. The unit of work is a cycle: a fresh-context Planner writes the plan, you execute it, the harness runs the verify command (only failures that were not already failing count), a fresh-context Reviewer reads the cycle diff and revises, the check runs once more and the cycle commits, then a new plan arrives. Every cycle is coherent and reviewed; there is no wave quota and no meter to satisfy.`,
      ``,
      `### Your part`,
      `- The plan arrives as a \`[Forge ULW cycle driver] Cycle N plan\` message; its items are on your todo board by id. Ship them in order: implement, run the item's proof, mark it done with todo_write. Cancel an item only with a reason.`,
      `- Close with **"Plan complete."** when every item is done or cancelled. Do not stop mid-item. Do not invent extra items — what you noticed goes in one line under \`Serendipity:\` for the Reviewer and the next Planner.`,
      `- Tests must be able to fail; never weaken an assertion to go green. A test-only change with no production body is not a ship.`,
      `- Proof: the cheapest check that can fail per item; the cycle gate is the declared verify command, run by the harness after review.`,
      `- Need to re-think the plan? call enter_plan_mode with the reason — the cycle closes at the next Stop and a fresh Planner reads your reason. Do not research in-session.`,
      `- Operator: lines are for a secret, an irreversible action, or an external blocker only. Never ask the user to choose.`,
      ``,
      `### Controls`,
      `\`/cycle 0\` (finish this cycle, then stop) · \`/cycle 1\` · \`/replan\` · \`/max-cycles N|off\` · \`/plan\` (human pause) · \`/ulw-off\`. The harness commits each reviewed, green cycle locally (never push; FORGE_ULW_AUTO_COMMIT=0 off). Do not commit yourself.`,
    );
  }

  // Goal protocol (static) — live objective admitted mid-conversation
  parts.push(
    ``,
    `## Goal protocol`,
    `When a goal is active (see harness updates): work until criteria are met, then attest **Goal achieved.** with ✅/❌ per criterion + evidence.`,
    `The harness blocks Stop until you do (or hit stuck-wall).`,
  );

  if (rules) {
    parts.push(``, `## Project rules`, rules);
  }
  const skills = formatSkillsForPrompt(workspace, {
    inlineNames: ulwOn ? ["forge-veteran"] : undefined,
  });
  if (skills.trim()) {
    parts.push(``, skills);
  }

  if (config.systemPromptExtra) {
    parts.push(``, `## Extra instructions`, config.systemPromptExtra);
  }

  // Cross-session project memory (survives /new — not session decisions.json)
  try {
    const pm = formatProjectMemoryForPrompt(workspace);
    if (pm.trim()) parts.push(``, pm);
  } catch {
    /* */
  }

  return parts.filter((p) => p !== undefined && p !== "").join("\n");
}
