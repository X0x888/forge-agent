import type { ForgeConfig, PromptProfile } from "../config/types.js";
import type { GoalState } from "../harness/goal.js";
import type { UlwCycleState } from "../harness/ulw-cycle.js";
import { displayUlwMandate, resolveUlwPhase } from "../harness/ulw-cycle.js";
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
import { formatProjectMemoryForPrompt } from "../harness/project-memory.js";
import { displayRelPath } from "./tools/path-util.js";
import { formatSkillsForPrompt } from "./project-skills.js";
import { isCursorProvider } from "../auth/cursor.js";

/** Per-file cap so one huge AGENTS.md cannot dominate the system prompt. */
const RULES_PER_FILE_CHARS = 12_000;
/** Total project-rules budget (OpenCode-style multi-source instructions). */
const RULES_TOTAL_CHARS = 28_000;

const ROOT_RULE_FILES = [
  "AGENTS.md",
  "FORGE.md",
  "CLAUDE.md",
  ".forge/rules.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
] as const;

/** Nearest git worktree root (directory containing .git), or null. */
function findGitRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 48; i++) {
    try {
      const git = path.join(dir, ".git");
      if (fs.existsSync(git)) return dir;
    } catch {
      /* */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Walk workspace → parents collecting instruction paths.
 * Stops at the git worktree root (OpenCode-style) so unrelated parent
 * AGENTS.md files never leak in. When not in a git repo, only the workspace
 * directory is scanned (plus optional ~/.forge/AGENTS.md).
 * Prefer nearer files first; later duplicates of the same basename are skipped
 * so nested AGENTS.md wins over monorepo root when both exist.
 */
function collectInstructionPaths(workspace: string): string[] {
  const out: string[] = [];
  const seenAbs = new Set<string>();
  const seenBase = new Set<string>();

  const pushFile = (abs: string, baseKey?: string) => {
    const resolved = path.resolve(abs);
    if (seenAbs.has(resolved)) return;
    if (baseKey && seenBase.has(baseKey)) return;
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return;
    } catch {
      return;
    }
    seenAbs.add(resolved);
    if (baseKey) seenBase.add(baseKey);
    out.push(resolved);
  };

  const start = path.resolve(workspace || process.cwd());
  const gitRoot = findGitRoot(start);
  // Only walk up when workspace is inside that git worktree (never leak
  // unrelated parent AGENTS.md if TMPDIR sits under another repo).
  const underGit =
    !!gitRoot &&
    (start === path.resolve(gitRoot) ||
      start.startsWith(path.resolve(gitRoot) + path.sep));
  // Without git: workspace only. With git: workspace → git root (inclusive).
  const ceiling = underGit && gitRoot ? path.resolve(gitRoot) : start;

  let dir = start;
  for (let depth = 0; depth < 48; depth++) {
    for (const name of ROOT_RULE_FILES) {
      // Basename key so nested AGENTS.md shadows parent; path-unique for others
      const baseKey =
        name === "AGENTS.md" ||
        name === "FORGE.md" ||
        name === "CLAUDE.md" ||
        name === ".cursorrules"
          ? name
          : `${dir}::${name}`;
      pushFile(path.join(dir, name), baseKey);
    }
    // Cursor project rules (directory of .md / .mdc)
    const cursorRules = path.join(dir, ".cursor", "rules");
    try {
      if (fs.existsSync(cursorRules) && fs.statSync(cursorRules).isDirectory()) {
        const entries = fs
          .readdirSync(cursorRules)
          .filter((f) => /\.(md|mdc|markdown)$/i.test(f))
          .sort()
          .slice(0, 12);
        for (const f of entries) {
          pushFile(path.join(cursorRules, f));
        }
      }
    } catch {
      /* */
    }
    if (path.resolve(dir) === path.resolve(ceiling)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Global user instructions (lowest priority — only when no project AGENTS.md)
  if (!seenBase.has("AGENTS.md")) {
    try {
      pushFile(path.join(forgeHome(), "AGENTS.md"), "AGENTS.md");
    } catch {
      /* */
    }
  }

  return out;
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

/**
 * Load project / user instruction files for the system prompt.
 * Sources (nearest wins per basename): AGENTS.md, FORGE.md, CLAUDE.md,
 * .forge/rules.md, .github/copilot-instructions.md, .cursorrules,
 * .cursor/rules/*.{md,mdc}, and ~/.forge/AGENTS.md.
 */
export function loadProjectRules(workspace: string): string {
  const paths = collectInstructionPaths(workspace);
  const chunks: string[] = [];
  let used = 0;
  for (const abs of paths) {
    if (used >= RULES_TOTAL_CHARS) break;
    try {
      const text = fs.readFileSync(abs, "utf8").trim();
      if (!text) continue;
      const room = RULES_TOTAL_CHARS - used;
      const slice = text.slice(0, Math.min(RULES_PER_FILE_CHARS, room));
      if (!slice.trim()) continue;
      const label = labelForRulePath(abs, workspace);
      const block = `# From ${label}\n${slice}`;
      chunks.push(block);
      used += block.length;
    } catch {
      /* */
    }
  }
  return chunks.join("\n\n");
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
  ulwCycle?: UlwCycleState | null;
}): PromptProfile {
  if (opts.config.promptProfile) return opts.config.promptProfile;
  if (opts.ulwCycle?.enabled || opts.ultrawork) return "autonomous";
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
      `## Response profile: autonomous (ULW / god-mode)`,
      `- Own the hard work like a top senior: **smart and hard** — high leverage, low waste; not thrash or token burn.`,
      `- Prefer action + verification over advice-only. When you say you will do X, tool-call in the same turn.`,
      `- Judge leverage → research only as deep as needed → implement → prove. Freestyle when freestyle is better; doctrine is compass, not cage.`,
      `- **Proactive subagents** when they improve quality or efficiency (parallel explore, design plan, isolated implement); skip when one tool call is enough.`,
      `- State your reading first (one line) on multi-step work, then proceed — do not wait for confirmation.`,
      `- Finish, don't hand off. Never "shall I continue?" / "let me know if…".`,
      `- Finish the **defect** class (callers, tests, dependents). Do not grind leftover chrome (clip/one-line/sandwich) as a class — two is enough, then change surface or stop.`,
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
  ulwCycle?: UlwCycleState | null;
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
  const ulwOn = Boolean(opts.ulwCycle?.enabled || opts.ultrawork);
  const profile =
    opts.profile ??
    resolvePromptProfile({
      config,
      ultrawork: opts.ultrawork,
      ulwCycle: opts.ulwCycle,
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
    `- Vague / soft wishes ("improve this", "make it better"): decide what better means for THIS product, what a veteran would chase, then research (codebase, web_search, GitHub, skills) → plan directions → ship one piece → review → commit. If the reading is stale, call enter_plan_mode and research again. Never ask the user what to improve.`,
    `- Ambiguous / multi-option / architectural work: call enter_plan_mode before implementing — do not wait for the user to type /plan. Then research and exit_plan_mode. Mid-run: enter_plan_mode again when the plan is stale.`,
    `- **Imagine**: image_gen / image_edit / image_to_video / reference_to_video write under images/. read_file on png/jpg attaches vision. After Playwright screenshots, read_file the png. Load forge-imagine / forge-game-* skills when making art.`,
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
    `- **Subagents**: spawn_subagent for bounded work (explore=read-only, plan=design, general-purpose=full). General-purpose defaults to isolation=worktree (auto-lands only when completed; incomplete_max_turns keeps the worktree; /undo reverts a land). Prefer a direct tool when one call suffices.`,
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
    `- Doom-loop / error-streak: change tool or write; do not reread the same window. Cleared stubs: read_file the ~/.forge/tool-output path; do not re-spawn or re-run bash. Overflow: prune → compact → continue.`,
    `- If output was cut off (length), continue from the cut point without repeating completed work.`,
    ``,
    `## Harness`,
    `- **Blocking Stop hooks**: Stop may be blocked with re-anchor instructions — keep working. Stop hook timeout/error also fails closed (agent continues).`,
    `- **Handoff guard**: premature "let me know if…" / "shall I continue?" yields are blocked under ULW/goal/open todos — finish instead of re-prompting.`,
    `- **Proof-claim guard**: "tests pass" / "all green" without a verification command is blocked once — run the check, then report the real result. Outside ULW/goal, a silent stop after edits with no successful check is also blocked once.`,
    `- **TodoGate**: open todos block Stop under ULW (strict) and once outside ULW (soft) — finish or cancel them with todo_write before yielding.`,
    `- **/goal driver**: active goals block Stop until **Goal achieved.** or stuck-wall.`,
    `- **/ulw god-mode**: Wave 1 is PLAN (written Reading:), then BUILD. cycle=1 forces plan→ship→prove→review; \`/cycle 0\` = finish this wave + one more, then LAST. \`/plan\` / \`/build\` are the same keys. Durable decisions live in decisions.json.`,
    `- **Mid-conversation harness updates**: live cycle/wave/mandate/todo counts arrive as \`[Forge harness — mid-conversation update]\` messages. Obey the latest over stale ones.`,
    `- **Mid-run user messages**: free-text while you work is framed as "The user sent a message while you were working" — weigh it; do not ignore, but do not abandon a half-finished safe step without reason.`,
    `- **Live slash controls** (no abort required): \`/cycle 0|1\`, \`/max-waves N|off\`, \`/plan\`, \`/build\`, \`/ulw-off\`, \`/goal pause|resume\`.`,
    ``,
    `## Safety`,
    `- Never exfiltrate secrets. Never run destructive commands without necessity.`,
    `- Stay inside the workspace for writes.`,
    `- Force-push, rm -rf, drop database: avoid unless the user explicitly required it.`,
    `- Cloud instance metadata (IMDS): do not curl/wget/fetch 169.254.169.254 or metadata.google.internal — hard-denied.`,
    `- Do not curl/wget file:// paths — use read_file for workspace files (file:// is hard-denied).`,
  ];

  const ulwOrient = ulwOn && resolveUlwPhase(opts.ulwCycle) === "orient";
  if (config.permissionMode === "plan" && !ulwOrient) {
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
      `- spawn_subagent is allowed read-only (explore/plan). Do not attempt write workarounds — call exit_plan_mode when ready (or type \`/build\`).`,
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
    if (resolveUlwPhase(opts.ulwCycle) === "orient") {
      parts.push(
        ``,
        `## ULW PLAN (research, then directions — no product edits)`,
        `Wave 1 starts here. Later waves re-enter when the reading is stale (same-surface hold, named-ship exhaust, enter_plan_mode).`,
        `This is not a random todo. For a vague mandate, answer first:`,
        `1. What would "better" mean here, for THIS product?`,
        `2. What would a veteran actually chase (not chrome, not a sibling of the last ship)?`,
        `3. Research: codebase (grep/read, spawn explore), web_search, GitHub, matching forge-* / game skills.`,
        `Then write directions — the ONE next ship, what you passed on, the verify command.`,
        `Spawn explore/plan to research. Do not spawn general-purpose. Do not edit. Do not image_gen yet.`,
        `memory_write a \`Reading:\` **or** call exit_plan_mode({ plan }) — the driver /builds (no user confirm). Type /build to skip remaining research.`,
        `That write ends this phase. Then you get edits.`,
      );
    } else {
      parts.push(
        ``,
        `## ULW GOD MODE + RELENTLESS CYCLE`,
        `ULW is **general god-mode**: sharp judgment + hard execution on whatever the hard work is — any domain. **Smart and hard** (high leverage, low waste) — not thrash, not token burn, not process theater.`,
        `General prompts are the product. "Comprehensively evaluate then improve UX" is a complete mandate — do not wait for a tighter spec. Spend the max_waves budget: Wave 1 writes the reading and ships the first item; remaining waves ship the next highest-leverage items on different surfaces. **Cycle complete.** only after cycle=0 (cap auto-LAST). \`/cycle 0\` at wave N stops at N+1 — finish the open wave, ship one more, then LAST. LAST then scores this run automatically (Must-fix vs Live-with) and at most one must-fix close-out; the user does not type another command.`,
        `Live counters/mandate arrive mid-conversation — do not invent cycle/wave numbers.`,
        ``,
        `### Philosophy (compass, not cage)`,
        `- Own outcomes. Soft/empty mandates mean **you** invent the hard work; never ask what to improve.`,
        `- Optimize impact × confidence / cost. Busywork while harder work remains is failure.`,
        `- Freestyle tools, order, and depth when freestyle yields better quality. Harness rails (Stop/proof/todos) stay; ritual checklists do not.`,
        `- Insight before volume. Batch reads. Cheapest proof that can fail.`,
        ``,
        `### Subagents (proactive)`,
        `Spawn explore/plan/general-purpose **whenever** that improves quality or efficiency (parallel map, clean design space, isolated implement, worktree isolation). Skip when one call is enough. The child result is the brief — if incomplete or artifact_path is set, read_file that path; do not re-spawn the same explore. Converge and ship in the parent.`,
        ``,
        `### Wave loop (the product loop — not a todo mill)`,
        `vague wish → what would better mean for THIS product / what a veteran would chase → research/explore (codebase, web, GitHub, skills) → plan (directions, not a random todo) → implement ONE piece → review → commit.`,
        `Then: plan still good? next piece. Plan stale / we learned something? call enter_plan_mode (back to research). Same-surface hold and named-ship exhaust re-enter PLAN automatically.`,
        `Smoke first. Prove the ship. Serendipity if cheap. Hostile review. Repeat while cycle=1. \`/cycle 0\` is not an abort: finish this wave, ship one more, then LAST. When cycle=0, wrap that last wave, LAST reflect scores this run (read-only Must-fix vs Live-with; at most one must-fix close-out), then attest **Cycle complete.** with evidence.`,
        `Use Imagine when the product needs to look like something (games, UI mockups, sprites). read_file screenshots. Load forge-veteran / forge-imagine / forge-game-* when they match.`,
        ``,
        `### Quality bar (harness-enforced facts)`,
        `- Beat or match best wave so far: substance + real proof. No filler churn.`,
        `- Every 4th wave: consolidation (hostile cumulative diff + cheapest proof). Never foreground the full suite (\`npm test\` / \`npm run ci\` / \`npm run check\`) — a hung test pins the REPL; background it or skip it.`,
        `- Thin waves → demand higher leverage; user may \`/cycle 0\`.`,
        `- Same-surface siblings (leftover / near-duplicate ships) → harness holds after 3 until a different-surface Reading or \`/cycle 0\`.`,
        ``,
        `### Other force multipliers`,
        `MCP (docs/browser/resources, Playwright screenshots), LSP after language-aware edits, Imagine (image_gen/image_edit/image_to_video), forge-* skills (catalog + read_file when matching).`,
        ``,
        `### User controls (mid-turn)`,
        `\`/cycle 1|0\` · \`/max-waves N|off\` · \`/ulw-off\` · free-text steering. Never pause for "is this good enough?" — cycle/max_waves is the answer.`,
        `The harness auto-commits the local dirty tree at each wave close and on **Cycle complete.** (never push). Do not start a wave just to commit. FORGE_ULW_AUTO_COMMIT=0 disables.`,
        `Pause only for real external blockers (credentials, destructive shared-state, uninterpretable foreign work).`,
      );
    }
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
  const skills = formatSkillsForPrompt(workspace);
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

/**
 * @deprecated Prefer buildBaselineSystemPrompt + mid-conversation admissions.
 * Kept for callers that want a single combined system string (includes a
 * snapshot of live ULW/goal when provided).
 */
export function buildSystemPrompt(opts: {
  config: ForgeConfig;
  workspace: string;
  goal?: GoalState | null;
  ultrawork?: boolean;
  ulwCycle?: UlwCycleState | null;
  subagentDepth?: number;
}): string {
  const baseline = buildBaselineSystemPrompt(opts);
  const extras: string[] = [];
  if (opts.ulwCycle?.enabled) {
    const s = opts.ulwCycle;
    extras.push(
      ``,
      `## Live ULW snapshot (also admitted mid-conversation)`,
      `Counters: **cycle=${s.cycle} wave=${s.wave} blocks=${s.blocks}**`,
      s.mandate ? `Mandate: ${displayUlwMandate(s.mandate)}` : "",
    );
  }
  if (
    opts.goal &&
    opts.goal.objective &&
    !opts.goal.paused &&
    opts.goal.status === "active"
  ) {
    extras.push(
      ``,
      `## Live goal snapshot`,
      `Objective: ${opts.goal.objective}`,
      ...opts.goal.criteria.map((c, i) => `  ${i + 1}. ${c}`),
    );
  }
  return [baseline, ...extras].filter((p) => p !== undefined && p !== "").join("\n");
}
