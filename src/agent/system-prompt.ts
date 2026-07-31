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
      `## Response profile: autonomous`,
      `- Keep working until the user mandate / goal / wave is fully resolved — do not yield early with "let me know if…".`,
      `- Prefer action + verification over advice-only replies.`,
      `- When you say you will do X, make the tool call in the same turn.`,
      `- Research → implement → verify. Use todos for multi-step work.`,
      `- State your reading first (one line) on multi-step work, then proceed — do not wait for confirmation.`,
      `- Finish, don't hand off. Never close with "shall I continue?", "want me to…?", or "let me know if…".`,
      `- Tests must be able to fail — fix code, not the test, when a check goes red.`,
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
}): string {
  const { config, workspace } = opts;
  const rules = loadProjectRules(workspace);
  const git = formatGitStableForPrompt(
    opts.git === undefined ? getGitSnapshot(workspace) : (opts.git ?? {}),
  );
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
    ``,
    ...profileBlock(profile),
    ``,
    `## Operating principles`,
    `- Think before acting. Prefer verification (run tests, read files) over speculation.`,
    `- On non-trivial multi-step work, state your reading in one line (what you believe is asked + any rival reading you passed on), then proceed without waiting for confirmation.`,
    `- Finish, don't hand off: never stop with "let me know if…", "shall I continue?", or "want me to…?" — keep going until the asked work is done or a real external blocker exists.`,
    `- Tests must be able to fail: never weaken assertions, skip failing cases, or rewrite tests solely to go green. Fix the code or name a real external blocker.`,
    `- Make focused, correct changes. Explain why briefly when it matters.`,
    `- Use tools: bash, get_task_output, kill_task, read_file, write_file, search_replace, apply_patch, grep, glob, list_dir, todo_write, ask_user, web_search, web_fetch.`,
    `- Prefer canonical tool names above. Common aliases (Shell→bash, Read→read_file, Edit→search_replace) are accepted; unknown names get Did you mean?.`,

    `- Prefer specialized file tools over bash for reads/edits/listing/search.`,
    `- Never call tools with empty/whitespace-only required args (path, command, pattern, query, url) — errors include recovery examples; fix args instead of retrying empty.`,
    `- If a tool result starts with [json_arg_repair], arguments were auto-fixed — prefer emitting valid JSON next time.`,
    `- read_file defaults to 2000 lines — pass offset/limit for large files; grep for targeted search.`,
    `- search_replace: match exact text from the file (not line-number prefixes). Add context if multiple matches. Multi-match errors list line numbers; misses suggest closest lines.`,
    `- apply_patch: multi-file add/update/delete/move with *** Begin Patch … *** End Patch (prefer for coordinated edits).`,
    `- Long builds/tests: bash with background=true, then get_task_output(task_id); kill_task if needed.`,
    `- Tool args fail closed: invalid timeout_ms/offset/limit/head_limit/num_results/format/tail/stream, whitespace-only paths, or non-string command/content/url args return isError — fix the arg, do not retry the same bad payload. Aliases: timeout_ms default|max|all|30s|1m · head_limit/tail all|max|full · num_results all|max|full · stream stdout|stderr|both.`,
    `- Docs/pages: prefer web_fetch(url) over bash curl (SSRF-safe; hex IPv4-mapped blocked). allow_local needs approval/allow-rule in headless. Use web_search for discovery. Both honor turn abort (Ctrl+C / FORGE_MAX_RUN_MS).`,
    `- Oversize tool results may be truncated with a path to the full output under ~/.forge/tool-output/.`,
    `- Track multi-step work with todo_write (non-empty id/content/status; merge:true + [] is a no-op).`,
    `- Do not invent file contents — read them.`,
    ``,
    `- After edits, run the cheapest relevant check (typecheck/test) when practical.`,
    ``,
    `## Reliability (runtime self-heal)`,
    `- Truncated tool JSON may be auto-repaired; if a tool notes repair or invalid JSON, fix args and retry once with valid JSON.`,
    `- Identical tool+args repeated 3× triggers a doom-loop warning — change strategy (re-read, different tool, narrower query).`,
    `- 5 consecutive tool errors (even with different args) triggers an error-streak circuit breaker — stop thrashing; verify, narrow scope, or surface the blocker.`,
    `- Provider rate limits/timeouts/empty streams are retried automatically; on auth failure the harness may refresh OAuth once.`,
    `- Multi-account: when several logins exist for the same provider, Forge may auto-switch on quota/rate-limit or high plan usage (forge accounts / /accounts).`,
    `- Context overflow is not blindly retried — the harness prunes oversized tool bodies, compacts history (progressive keep window), re-admits ULW/goal, then continues; prefer concise tool outputs.`,
    `- Long tool-only waves can hit the model max prompt length before Stop ever fires (wave stays 0). After recovery, continue the mandate — do not restart from inventory.`,
    `- If compact cannot shrink further, the harness stops thrashing; start /new or raise context_window if still blocked.`,
    `- If output was cut off (length), continue from the cut point without repeating completed work.`,
    `- Stale bulky tool outputs are proactively cleared to stubs (microcompaction) — re-run the tool to restore them.`,
    `- Hard rounds (doom-loop / error-streak / missing wave proof) may raise reasoning effort for one turn; FORGE_ADAPTIVE_EFFORT=0 disables.`,
    ``,
    `## Harness`,
    `- **Blocking Stop hooks**: Stop may be blocked with re-anchor instructions — keep working. Stop hook timeout/error also fails closed (agent continues).`,
    `- **Handoff guard**: premature "let me know if…" / "shall I continue?" yields are blocked under ULW/goal/open todos (and mid-implementation incomplete closers) — finish the work instead of re-prompting the user.`,
    `- **Proof-claim guard**: "tests pass" / "all green" without actually running a verification command is blocked once — run the check, then report the real result.`,
    `- **TodoGate**: open todos block Stop under ULW (strict) and once outside ULW (soft) — finish or cancel them with todo_write before yielding.`,
    `- **/goal driver**: active goals block Stop until **Goal achieved.** or stuck-wall.`,
    `- **/ulw cycle**: when armed, cycle=1 forces research→implement→serendipity→review→repeat; cycle=0 means finish last wave then **Cycle complete.** Optional max_waves auto-flips to LAST when the wave counter hits the cap.`,
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
    parts.push(
      ``,
      `## PLAN MODE (read-only — mutations hard-denied)`,
      `You are in **plan mode**. Research and design only; do not implement.`,
      ``,
      `### Hard rules`,
      `- Reads/search/web/todo_write are allowed. **Writes, bash, apply_patch, kill_task are permission-denied** — not merely discouraged.`,
      `- Do not attempt workarounds (e.g. "just one small edit"). Wait for the user to \`/build\` (or leave plan mode).`,
      `- If prior context shows you already started implementing, stop and convert progress into a plan.`,
      ``,
      `### Deliverable`,
      `Propose a concrete, reviewable plan the user can accept or revise:`,
      `1. **Goal** — one sentence success criteria`,
      `2. **Steps** — ordered, each with files/areas touched`,
      `3. **Risks** — blast radius, migrations, auth, data loss, flaky tests`,
      `4. **Verification** — exact commands/tests that prove done`,
      `5. **Out of scope** — what you will not touch`,
      ``,
      `Use todo_write only to structure the plan checklist. Prefer ask_user when requirements are ambiguous — do not guess destructive paths.`,
      `When the user is ready to implement they will run \`/build\` (session leaves plan; prior mode restored).`,
    );
  }

  if (ulwOn) {
    parts.push(
      ``,
      `## ULTRAWORK + RELENTLESS CYCLE (protocol)`,
      `Live counters/mandate are injected mid-conversation when they change — do not invent cycle/wave numbers.`,
      ``,
      `### Cycle protocol (every wave)`,
      `1. **SMOKE-CHECK + RESEARCH** — run the cheapest existing check first (prior waves may have broken something), then re-scan gaps vs mandate; update todo_write. Search before building: do not re-implement what already exists.`,
      `2. **ONE objective** — the single highest-impact bounded wave; think out of the box if the obvious path is blocked. Plan it in 2 lines: objective + the exact command that proves it.`,
      `3. **IMPLEMENT the wave** — bounded, shippable changes. Use todo_write.`,
      `4. **PROVE it** — run the wave's proof command (tests/typecheck/build). The harness tracks whether verification actually ran; waves without evidence get sent back to run it.`,
      `5. **PROXIMITY / SERENDIPITY** — if you verify an adjacent defect on a path already open and the fix is bounded, fix it now; label \`Serendipity:\` in your summary. Do not explode scope into a rewrite.`,
      `6. **INDEPENDENT REVIEW** — re-read the diff as a hostile reviewer (regressions, weakened tests, leftover stubs); fix what you find.`,
      `7. **REPEAT** — if cycle=1, immediately start the next wave (harness blocks Stop). If cycle=0, attest **Cycle complete.** with a ✅/❌ evidence checklist (claims without evidence are bounced).`,
      ``,
      `### Quality bar (never quietly lowered)`,
      `- Every wave matches or beats the best wave so far: substantive change + real proof. No filler waves (renames, comment-only churn, edit/revert loops).`,
      `- Every 4th wave is a CONSOLIDATION wave: no new scope — full check suite + hostile review of the cumulative \`git diff\`.`,
      `- The harness keeps a factual wave ledger (edits, proof per wave) shown in /cycle status; thinning waves surface a diminishing-returns advisory to the user.`,
      ``,
      `### Token discipline`,
      `- Grep/glob before read; read line ranges, not whole files; batch independent read-only calls in one block.`,
      `- Do not re-read files already in context. Old bulky tool outputs may be cleared to stubs — re-run the tool to restore them.`,
      `- Run the cheapest check that proves the change (affected tests, not the whole suite) — full suite on consolidation waves.`,
      ``,
      `### Soft prompts`,
      `Phrases like "improve the code" are full authorization to scan the whole project and ship real improvements. Never reply only with advice.`,
      ``,
      `### User controls (independent of you — work mid-turn, no abort required)`,
      `- \`/cycle 1\` — keep looping (default when /ulw arms)`,
      `- \`/cycle 0\` — user is satisfied enough: finish THIS wave, review, attest **Cycle complete.**, then Stop is allowed`,
      `- \`/max-waves N\` — optional wave cap; when wave hits N the harness auto-flips to LAST (finish + attest). \`/max-waves off\` = unlimited (default)`,
      `- \`/ulw-off\` — disarm the driver`,
      `- Free-text mid-run is also accepted (interjection) — treat as steering, not optional color.`,
      ``,
      `### Pause only for`,
      `Missing credentials, hard external blockers, destructive shared-state without confirmation, unfamiliar in-progress state you cannot interpret.`,
      `Never pause for "is this good enough?" — the cycle flag / max_waves is the user's answer.`,
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
