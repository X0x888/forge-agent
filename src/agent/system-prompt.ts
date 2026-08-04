import type { ForgeConfig, PromptProfile } from "../config/types.js";
import type { GoalState } from "../harness/goal.js";
import type { UlwCycleState } from "../harness/ulw-cycle.js";
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
import { formatSkillsForPrompt } from "./project-skills.js";

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
  const rel = path.relative(ws, abs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
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
      `## Response profile: autonomous (ULW / relentless)`,
      `- You are the veteran who owns the hard work: decide, research, ship, prove — do not yield early with "let me know if…".`,
      `- Prefer action + verification over advice-only replies. When you say you will do X, tool-call in the same turn.`,
      `- Research → judge leverage → implement → verify. Use todos for multi-step work; spawn explore/plan subagents when unknowns are large.`,
      `- State your reading first (one line) on multi-step work, then proceed — do not wait for confirmation.`,
      `- Finish, don't hand off. Never close with "shall I continue?", "want me to…?", or "let me know if…".`,
      `- Finish the class, not just the example: siblings + dependents (callers/tests/docs/config) are in scope — grep before done.`,
      `- Hostile self-review after edits: regressions, weakened tests, stubs, stale last-verify — fix before done.`,
      `- Tests must be able to fail — fix code, not the test, when a check goes red.`,
      `- Prefer high-leverage hard work over busywork when the mandate is soft or broad.`,
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
    `- On non-trivial multi-step work, state your reading in one line (what you believe is asked + any rival reading you passed on), then proceed without waiting for confirmation.`,
    `- Finish, don't hand off: never stop with "let me know if…", "shall I continue?", or "want me to…?" — keep going until the asked work is done or a real external blocker exists.`,
    `- Finish the class, not just the example: a named bug/site implies siblings (same defect elsewhere) and dependents (callers, tests, docs, config). Grep the symbol you touched before calling it done.`,
    `- After substantive edits, re-read your own diff as a hostile reviewer (regressions, weakened tests, leftover stubs, stale last-verify) and fix what you find before claiming done.`,
    `- Pure questions are not work orders: answer first. Look up evidence if needed, then stop at the answer. Mention optional follow-ups in one sentence — do not build/refactor unasked. Explicit implement/fix/ship language (and ULW soft-prompt expansion) overrides this.`,
    `- Prefer ask_user when requirements are ambiguous or a choice is destructive/irreversible — do not guess and thrash. Interactive only; headless/CI fails closed (state assumptions instead).`,
    `- Tests must be able to fail: never weaken assertions, skip failing cases, or rewrite tests solely to go green. Fix the code or name a real external blocker.`,
    `- Make focused, correct changes. Explain why briefly when it matters.`,
    `- Prefer the specialized file tools over bash for reads/edits/listing/search; grep/glob before read; read line ranges, not whole files; batch independent read-only calls in one block.`,
    `- Docs/pages: prefer web_fetch over bash curl; use web_search for discovery.`,
    `- **MCP**: search_mcp then call_mcp (server__tool). Resources: mcp_resource list/read. Prompts: mcp_prompt list/get. Built-in defaults: **context7** (library docs) and **playwright** (browser). Optional CONTEXT7_API_KEY.`,
    `- **Subagents**: spawn_subagent for bounded work (explore=read-only, plan=design, general-purpose=full). isolation=worktree → detached git worktree under ~/.forge/worktrees/ (parent checkout untouched). Prefer a direct tool when one call suffices.`,
    `- **LSP**: lsp({ action: "diagnostics", path }) after TS/Python/Rust/Go edits when the server is on PATH. Install recipes: lsp action=install or /lsp install (docs/LSP.md).`,
    `- Oversize tool results may be truncated with a path to the full output under ~/.forge/tool-output/.`,
    `- Track multi-step work with todo_write.`,
    `- Do not invent file contents — read them.`,
    `- Before editing an existing file, call read_file first. search_replace/write_file/apply_patch refuse unread or stale files — re-read, then retry.`,
    ``,
    projectBlock && projectBlock.includes("Commands:")
      ? `- After edits, run the cheapest project command from Workspace → Commands (typecheck/test) when practical.`
      : `- After edits, run the cheapest relevant check (typecheck/test) when practical.`,
    ``,
    `## Reliability (runtime self-heal)`,
    `- Identical tool+args repeated triggers a doom-loop warning; a run of consecutive tool errors trips the error-streak breaker — change strategy (re-read, different tool, narrower query) instead of retrying the same payload.`,
    `- Old bulky tool outputs may be cleared to stubs (microcompaction) — re-run the tool to restore them. Context overflow is recovered by the harness (prune → compact → continue); keep tool outputs concise.`,
    `- If output was cut off (length), continue from the cut point without repeating completed work.`,
    ``,
    `## Harness`,
    `- **Blocking Stop hooks**: Stop may be blocked with re-anchor instructions — keep working. Stop hook timeout/error also fails closed (agent continues).`,
    `- **Handoff guard**: premature "let me know if…" / "shall I continue?" yields are blocked under ULW/goal/open todos (and mid-implementation incomplete closers) — finish the work instead of re-prompting the user.`,
    `- **Proof-claim guard**: "tests pass" / "all green" without actually running a verification command is blocked once — run the check, then report the real result. Outside ULW/goal, a silent stop after file edits with no successful check is also blocked once (free triage). The reanchor includes a free six-question self-audit (completeness / evidence / framing / tests / fit / consequence).`,
    `- **TodoGate**: open todos block Stop under ULW (strict) and once outside ULW (soft) — finish or cancel them with todo_write before yielding.`,
    `- **/goal driver**: active goals block Stop until **Goal achieved.** or stuck-wall.`,
    `- **/ulw god-mode**: when armed, cycle=1 forces research→judge→implement→prove→serendipity→review→repeat on the highest-leverage hard work (any domain); soft mandates mean you invent the work. cycle=0 = finish last wave then **Cycle complete.** Optional max_waves auto-flips to LAST.`,
    `- **Mid-conversation harness updates**: live cycle/wave/mandate/todo counts arrive as \`[Forge harness — mid-conversation update]\` messages. Obey the latest over stale ones.`,
    `- **Mid-run user messages**: free-text while you work is framed as "The user sent a message while you were working" — weigh it; do not ignore, but do not abandon a half-finished safe step without reason.`,
    `- **Live slash controls** (no abort required): \`/cycle 0|1\`, \`/max-waves N|off\`, \`/ulw-off\`, \`/goal pause|resume\`.`,
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
      `- Reads/search/web/todo_write/search_mcp/lsp are allowed. **Writes, bash, apply_patch, kill_task, spawn_subagent, non-read-only call_mcp are permission-denied** — not merely discouraged.`,
      `- Do not attempt workarounds (e.g. "just one small edit"). Wait for the user to \`/build\` (or leave plan mode).`,
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
      `When the user is ready to implement they will run \`/build\` (session leaves plan; prior mode restored).`,
    );
  }

  if (ulwOn) {
    parts.push(
      ``,
      `## ULW GOD MODE + RELENTLESS CYCLE`,
      `ULW is **general god-mode**: you think deeply and work hard on whatever the hard work is — any domain (correctness, product value, architecture, reliability, UX, tooling, design, ops, incomplete work, research-backed builds). Not limited to tests or housekeeping.`,
      `Live counters/mandate are injected mid-conversation when they change — do not invent cycle/wave numbers.`,
      ``,
      `### Cycle protocol (every wave)`,
      `1. **SMOKE + ORIENT** — cheapest check first (prior waves may have broken something), then re-scan reality vs mandate with tools.`,
      `2. **JUDGE** — pick the single highest-leverage hard objective now (impact × confidence / blast radius). Prefer veteran-grade work over busywork.`,
      `3. **RESEARCH DEEP when uncertain** — grep the class, read critical paths, MCP/docs/web when needed. **Spawn explore/plan subagents** for large parallel investigation or design-heavy unknowns; fold results into the wave. Search-before-build: do not re-implement what exists.`,
      `4. **ONE objective** — plan in 2 lines: objective + the exact proof command. todo_write for multi-step.`,
      `5. **IMPLEMENT** — bounded, shippable; finish siblings + dependents.`,
      `6. **PROVE** — run verification (harness tracks structural proof; waves without evidence get sent back).`,
      `7. **SERENDIPITY** — bounded adjacent fix on an open path: do it; label \`Serendipity:\`. No rewrite explosions.`,
      `8. **HOSTILE REVIEW** — re-read the diff; fix regressions, weakened tests, stubs.`,
      `9. **REPEAT** — cycle=1: next wave immediately (Stop blocked). cycle=0: attest **Cycle complete.** with ✅/❌ evidence (weak attestations bounce once).`,
      ``,
      `### Quality bar (never quietly lowered)`,
      `- Every wave matches or beats the best wave so far: substantive hard work + real proof. No filler (renames, comment-only, edit/revert churn).`,
      `- Every 4th wave is CONSOLIDATION: no new scope — full check suite + hostile review of cumulative \`git diff\`.`,
      `- Thinning waves demand higher-leverage objectives; diminishing returns is user-visible — they may \`/cycle 0\`.`,
      ``,
      `### Soft / empty mandates = full ownership`,
      `Soft phrases ("improve", "fix", bare /ulw) authorize **you** to invent the hard work from the workspace and ship it. Never ask "what should I improve?" Never advice-only. One-sentence reading, then tools.`,
      ``,
      `### Force multipliers (use them)`,
      `- **Subagents**: explore/plan for deep research or design; general-purpose for isolated slices; isolation=worktree when edits must not touch the parent tree.`,
      `- **MCP**: context7 for current library truth; playwright when browser/UX proof matters; search_mcp/call_mcp/mcp_resource as needed.`,
      `- **LSP**: diagnostics after substantive language-aware edits when servers are on PATH.`,
      ``,
      `### Token discipline`,
      `- Grep/glob before read; line ranges; batch independent read-only calls; re-run tools after microcompaction stubs.`,
      `- Cheapest proof per wave; full suite on consolidation.`,
      ``,
      `### User controls (independent of you — mid-turn, no abort required)`,
      `- \`/cycle 1\` — keep looping (default when /ulw arms)`,
      `- \`/cycle 0\` — finish THIS wave, review, **Cycle complete.**, then Stop allowed`,
      `- \`/max-waves N|off\` — optional cap (auto LAST at N)`,
      `- \`/ulw-off\` — disarm`,
      `- Free-text mid-run = steering (obey), not optional color`,
      ``,
      `### Pause only for`,
      `Missing credentials, hard external blockers, destructive shared-state without confirmation, unfamiliar in-progress state you cannot interpret.`,
      `Never pause for "is this good enough?" — cycle / max_waves is the user's answer.`,
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
  const skills = formatSkillsForPrompt(workspace);
  if (skills.trim()) {
    parts.push(``, skills);
  }

  if (config.systemPromptExtra) {
    parts.push(``, `## Extra instructions`, config.systemPromptExtra);
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
}): string {
  const baseline = buildBaselineSystemPrompt(opts);
  const extras: string[] = [];
  if (opts.ulwCycle?.enabled) {
    const s = opts.ulwCycle;
    extras.push(
      ``,
      `## Live ULW snapshot (also admitted mid-conversation)`,
      `Counters: **cycle=${s.cycle} wave=${s.wave} blocks=${s.blocks}**`,
      s.mandate ? `Mandate: ${s.mandate}` : "",
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
