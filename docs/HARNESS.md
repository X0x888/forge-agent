# Forge Harness Design

This document explains the control plane that drives the agent — and what we ported from other tools.

## Problem statement

Agent CLIs fail in two opposite ways:

1. **Stopping short** — model declares “done” while tests fail, todos remain, or the user’s goal is half-shipped.
2. **Running forever** — no escape when the model is stuck looping without progress.

Grok Build exposes lifecycle hooks, but **`Stop` is non-blocking**. That means any external harness that depends on “block stop until green” cannot work. Claude Code’s exit-code-2 Stop hooks and Codex’s `/goal` both need a **runtime that can refuse to end the turn**.

Forge’s job is to be that runtime.

## Loop

```
User message
    │
    ▼
UserPromptSubmit hooks
    │
    ▼
┌─ model (tools enabled) ◄──────────────────────────────────┐
│       │                                                   │
│       ├─ tool_calls? ──► PreToolUse → permission → tool   │
│       │                       │              │            │
│       │                    deny            PostToolUse    │
│       │                                       │           │
│       └─ no tool_calls ──► Stop guard ────────┘           │
│                               │                           │
│                    allow ─► end turn                      │
│                    block ─► inject reason ────────────────┘
```

## Stop guard composition

`runStopGuard` evaluates in order:

1. **User Stop hooks** (if `blockingStopHooks`)
   - exit `2` or `{ "decision": "block" }` → continue
2. **`/goal` driver** (if armed and not paused)
   - no `**Goal achieved.**` attestation → continue
   - attestation after edits without machine-checkable evidence → bounce once demanding a real check, then normal blocks (capped — never an infinite trap)
   - stuck-wall (N no-edit Stop attempts) → release + surface to user
3. **ULW cycle driver** (`cycle=1` re-anchor / `/cycle 0` stop at N+1 then LAST attestation). **Wave 1 is PLAN** (`/plan` permission mode + yolo-proof `ulw_orient`); a written plan auto-`/build`s. User `/build` skips research; user `/plan` is a human pause.
4. **TodoGate** — open todos under ULW without `**Cycle complete.**` / `**Goal achieved.**`; outside ULW, soft-blocks **once** per prompt so half-finished checklists are finished or cancelled (`FORGE_TODO_SOFT_OUTSIDE_ULW=0` disables). Soft fire count is reset on wind-down (`/done`, `/goal done`, `/goal clear`, `/ulw-off`, `/clear`, `/new`, safety-valve CONTINUE→LAST, **max_waves auto LAST**, **ULW stuck-wall**, **goal stuck-wall**, **goal attestation / `markGoalDone`**, **`setMaxWaves` when already at/over cap**) **and** on fresh driver arm (`/ulw`, `/goal set`) via `clearSoftTodoGateOnWindDown`
5. **Ultrawork open-todos backstop** (session flag if cycle state missing)
6. **Handoff guard** — premature “let me know if…”, “shall I continue?”, “want me to…?” yields (and incomplete mid-implementation closers) are blocked under ULW/goal/open todos so the agent finishes instead of re-steering the user. Soft Q&A closers (“let me know if you have questions”) still allow Stop outside a driver. Cap: `FORGE_HANDOFF_BLOCK_CAP` (default 3) releases a stuck polite model.
7. **Proof-claim guard** — “tests pass” / “all green” / “typecheck clean” without a structural `verificationRan` (bash check actually executed) blocks Stop once when edits/goal/ULW/todos are in flight. Complements ULW proof-demand for goal-only and plain implementation turns. Cap: `FORGE_PROOF_CLAIM_BLOCK_CAP` (default 1).
8. **Report guard** (`src/harness/report-guard.ts`) — the closing message must stand on its own. It runs twice: an **attestation pass ahead of the drivers** (below) and step 8 for every other closer. (a) **Homework hand-back**: a *directive* to the user — “you **should** run…”, “you'll **need to** configure…”, “next step for you: add…”, “when you're ready, run…”, or an imperative that coordinates work (“run X **and fix** Y”) — blocks once. Telling the user what they *can now* do with the result is an affordance, not homework, and passes. The only things a closer may leave to the user are a missing secret, a hard external blocker, an irreversible action, or a decision that is the user's, each as an `Operator:` line (lines that name those reasons are exempt). (b) **Run-wide shape**: after ≥ 2 harness rounds with edits, a closer that is not outcome-first with ≥ 2 labelled sections (any markdown heading or a short standalone bold/underlined label — **What shipped** / **Verified** / **Not done** / **Needs you** are the examples the prompt gives, not a required vocabulary) is bounced once with the harness facts (files, commits, verify state, open items) so the model reports the whole run since the request, not the last round. Advisory Q&A and driver attestations never bounce. Both classifiers are pinned against `tests/fixtures/prose-corpus.ts` (`tests/prose-classifiers.test.ts`): every regex change has to keep the labelled corpus green, so a narrower homework pattern cannot quietly start passing real hand-backs or a wider one start bouncing affordances. Cap: `FORGE_REPORT_BLOCK_CAP` (default 2); `FORGE_REPORT_GUARD=0` off.

**Attestation pass (step 1b).** The closer a user reads after a hundred waves is the driver attestation, and steps 2 and 3 release on it and return — step 8 never sees the run's most important message. `evaluateAttestationHomeworkAtStop` runs the same two checks on `**Cycle complete.**` under `/cycle 0` (a cycle=1 one declares a wave, not a release) and on `**Goal achieved.**`, *before* any driver evaluates the Stop, so a bounce costs one round and spends no wave, no evidence nudge and no wrap flag. Same `FORGE_REPORT_BLOCK_CAP`.

**No guideline-audit guard.** Earlier builds blocked one Stop when the session's first brief asked for a proofread of `AGENTS.md`-class files and none was read (step 1c). It is gone: the audit now fixes fact defects and *proposes* doctrine (below), and neither deserves a bounce — an ignored fact brief is a line in the run report and re-briefs next session; a proposal waits for `/guidelines apply`. `FORGE_GUIDELINE_AUDIT_BLOCK` is no longer read.

Safety: a hard cap (`maxStopContinues`, default 50; ULW default 200) prevents infinite continue loops at the process level. Unlimited ULW CONTINUE Stop-blocks are the product (one per wave) and do not trip that cap. Length / empty / content_filter use a separate fuse of the same size so 200 waves do not make the next truncated completion release without `/cycle 0`.

## Agent guidelines audit (fix facts, propose doctrine)

A wrong `AGENTS.md` / `CLAUDE.md` caps every session no matter how strong the model is: a cited path that no longer exists steers reads into nothing, an `npm run lint` with no such script wastes a round, a map the prompt has to clip loses its tail. `src/harness/guideline-audit.ts` (first action of a work turn; `FORGE_GUIDELINE_AUDIT=0` off; subagents never audit):

- **Two kinds of wrong, two treatments.** **Fact defects** are checkable against the repo — `stale-paths` (a backticked path that does not exist), `stale-commands` (a `package.json` script / Makefile target / `just` recipe that is not there), `pm-mismatch` (a `pnpm …` line beside a lone `package-lock.json`, or against an explicit `packageManager` field — a lockfile-less repo is not a mismatch), `clipped` (the prompt loader cannot show all of it at the budget the loaded set leaves it), `empty`. The model is briefed to **fix these in the file**, whatever the file's size; nobody wants a dead path in their map, so there is no authority question. **Doctrine** — `long`, `conflict` (forbids tests / asks permission per edit / forbids revising itself), `no-commands` — is a judgement about what belongs in the user's instructions. The model writes the pruned version to a **proposal file outside the repo** (`~/.forge/guidelines/<projectKey>/<rel>.proposed.md`) and the tracked file is not touched until the user runs `/guidelines apply` — or sets `guidelineAutoApply` (`[guidelines] auto_apply = true` · `FORGE_GUIDELINE_AUTO_APPLY=1`), which lands the proposal directly, journaled for `/undo`. The model that is bound by a rule is not the one who silently decides the rule goes.
- **Trigger is evidence, not a calendar.** A file is briefed when it has a fact defect, or when its body changed since the last proofread (hash ≠ registry) and it has any issue. Freshness is `never` / `fresh` / `edited` / `import` (`@AGENTS.md` pointer); there is no `due` — a stamp means “no fact defects at this hash” and doctrine issues never withhold it, so a file can never nag forever. `/guidelines stamp` acknowledges the current issues (`acknowledged[]` in the registry at that hash; quiet until the body changes). A project with no primary file of its own is `missingPrimary` (import-only pointers do not count as a primary); a scratch dir (no git, no manifest) is skipped.
- **Survey** (`surveyGuidelines`): `AGENTS.md` / `CLAUDE.md` / `FORGE.md` / `GEMINI.md` (primary) + copilot / cursor / windsurf / cline / `.forge/rules.md` (secondary), seeded by the **same workspace → git-root walk the prompt's rules loader uses** (`collectInstructionFiles`, `src/agent/instruction-paths.ts`) — the audited set is the loaded set, so a nested `packages/api/AGENTS.md` is audited (and shadows the monorepo root) exactly as it is loaded; `rel` stays relative to the resolved root and is the registry key. `clipped` is computed with the loader's own `ruleFileBudget(promptRuleFiles(ws).length)`, so “clipped” means the same thing on both sides. The two sets differ in exactly two documented ways, pinned by `tests/guideline-audit.test.ts`: **(1) audited, never loaded, never briefed** — `AUDIT_ONLY_GUIDELINE_FILES` (`GEMINI.md`, `.windsurfrules`, `.clinerules`, `.claude/CLAUDE.md`), sibling tools' maps that `/guidelines` and doctor report on but Forge never stamps or rewrites; **(2) loaded, never audited** — `~/.forge/AGENTS.md`, the loader's global fallback, the user's own file, reported as what steers in the meantime (`GuidelineSurvey.globalFallback`; doctor / `/status` read `AGENTS.md missing · ~/.forge/AGENTS.md steers instead`). Nothing else may differ: `GUIDELINE_FILES` minus `PROMPT_RULE_FILES` has to equal `AUDIT_ONLY_GUIDELINE_FILES`, and `PROMPT_RULE_FILES` minus `GUIDELINE_FILES` has to be empty.
- **Brief**: the first harness message after the prompt (`[Forge harness — agent guidelines audit]`, synthetic user role) lists each briefed file with its fact defects (fix in place) and its doctrine issues (write the proposal), names the proposal path, and tells the model to continue with the request afterwards. Deferred while plan mode / ULW orient deny mutations, and on a pure question (`looksLikeAdvisoryUserMessage` — a question is an answer, not a run; `phase` stays `pending`, so the next work prompt of the same session audits exactly as it would have, judged by `lastRealUserPrompt(session)` because the last user-role row is a harness admit by then).
- **What counts as a look**: an argument that *resolves to the file*. Path-carrying tool arguments (`path`, `file_path`, an `apply_patch` `*** Update File:` header) are resolved against the workspace first and the survey root second and compared to the file's absolute path; a regex, a glob, a commit message, file *content* may name `AGENTS.md` without touching it. `grep` / `glob` and bash `grep` / `rg` are not a look; bash is segment-strict — the reader (`cat` / `bat` / `head` / `tail` / `less` / `more` / `nl` / `sed` as the segment's head) and the path have to be in the **same** segment, and a write redirect / `tee` / `sed -i` / `perl -pi` / `mv` / `cp` / `rm` in the segment is an edit. A body-hash change credits a look whatever the tool trail says.
- **Finalize** (Stop allow / run end): re-survey. A briefed file with no fact defects left is stamped `<!-- proofread <UTC> · forge -->` on the first line after any frontmatter (sibling stamps `· sisyphus-all` / `· oh-my-claude` count) and its hash goes to `~/.forge/guidelines/<projectKey>.json` (mode 0600); one that still trips a fact defect is reported `checked but not stamped — <what survived>` and briefed again next session. A proposal file the model wrote is recorded (`proposals[]`) and, under `guidelineAutoApply`, applied. The user is told exactly what changed (`AGENTS.md: 2 dead paths fixed`, `AGENTS.md revised (139 → 68 lines) — proposal parked, /guidelines diff`) or that a briefed file was ignored. The model never writes the stamp itself.
- Surfaces: `/guidelines` (status per file: freshness, issues, proposal), `/guidelines audit` (re-brief next prompt), `/guidelines stamp` (acknowledge), `/guidelines diff` (unified diff of each parked proposal, read-only), `/guidelines apply` (land, journaled for `/undo`), `/guidelines discard`; `forge doctor` row + `--json` `guidelines` / `guidelinesAuditDue` / `rulesClipped`; `forge run --json` `guidelines`; the run report's **Agent guidelines** section. `/context` prints each rule file as `loaded/total` chars with `[clipped]` and the headings the model never saw; the REPL startup posture warns when a rule file is clipped.

## Run report (end of run / status)

`src/harness/run-report.ts` builds a report that stands on its own from harness facts — the request (ULW mandate or last real prompt), the wave ledger, files changed this run (mutations journal), commits landed in the run window (`git log --since`), last verification (green / red / stale), open todos / named ships / unsliced bet / LAST must-fix / goal criteria, the guideline audit, and `Operator:` items from the closer. Shape: one outcome sentence (`Done — 3 files changed, verified with \`npm test\``, `Paused — /cycle 0 sat down…`, `Partly done — … the last check is RED`), then **What shipped** · **Verified** · **Not done** · **Agent guidelines** · **Needs you** · **Resume**. **One report per run.** At the end of a model run the closing message *is* the report — the guard shapes it, on the terminal attestation too — so `maybeRenderRunReportForRun` prints only the addendum the model could not write (the guideline audit, resume, the saved `report.md` path) and keeps the full card for closers that are not report-shaped (guard released at its cap, `FORGE_REPORT_GUARD=0`) and for every ending no guard read at all — a stuck-wall release and the continue cap return before step 8, and the spend / turn caps end the loop with no Stop evaluation, so `endedUnshaped()` forces the full card there whatever the last message looked like. A cycle=0 ULW with no driver-end flag reads `Winding down`, never `Done`: `/done` flips the flag and asks for the report in the same breath, and the wrap, LAST reflect and the attestation are all still ahead. Printed after multi-round runs (≥ 2 harness rounds with edits) and at every driver end (ULW release / sit-down / stuck-wall / caps) in the REPL and headless; in full on `/done` (a typed command has no closer behind it); `/report` any time; the outcome + open items head `/status`; `forge run --json` carries `report` (markdown); saved to `~/.forge/sessions/<id>/report.md`. The LAST wrap card and the system prompt ask the model for the same shape in its own closing message; the report guard enforces it.

## Decision memory (Mastra-inspired)

Long ULW runs fail when cliff compaction or context rot drops the user's exact constraints. Forge keeps an append-only **decision ledger** per session:

- Path: `~/.forge/sessions/<id>/decisions.json`
- Seeded on `/ulw` arm from the mandate (priorities + constraints)
- Injected on every ULW Stop re-anchor and into structured compact (`## 1b. Decisions`)
- Agent tool: `memory_write`; slash: `/memory list|add …|seed`
- Wave-boundary OM-lite facts are recorded as `kind=wave` observations
- Cap 400 with a **load-bearing trim**: superseded rows go first, then wave observations beyond 48, then the oldest non-durable rows; priorities/constraints/blockers/out-of-scope, `MANDATE:`, `Bet:` and the first `Reading:` are never evicted (both 400-record dogfood runs had lost their mandate to an oldest-first slice)
- `Job:` / `Next need:` are one-slot notes — a new Reading supersedes the previous row instead of appending (107 duplicate `Job:` rows ate one ledger)
- Soft/broad mandates require a **todo backlog (≥2)** before free-invent Wave 1 (contract before god-mode)
- `/max-waves` and `/budget` remain **spend valves**, not substitutes for durable intent

## Mid-conversation context (OpenCode-inspired)

The **baseline system prompt** stays stable within a session epoch (workspace, tools, ULW *protocol*, project rules). Live harness fields (cycle/wave/mandate, goal objective, open todo counts) are **admitted** as chronological user messages:

```text
[Forge harness — mid-conversation update]
## ULW
ON | cycle=1 wave=3 blocks=5 (CONTINUE)
…
```

Admission runs only at a **safe provider-turn boundary** (before each model call), after promoting live slash notices and free-text interjections. Mid-run ULW admits are fingerprint-only (`emit: false`) so they do not rewrite the xAI prefix; Stop re-anchors still append.

## Free-text interjection (Grok-inspired)

While the agent is busy, non-slash input is queued (not rejected). On the next model step:

```text
The user sent a message while you were working:
<user_query>
…
</user_query>
```

No forced “drop everything” instruction — the model weighs the interjection against in-flight work.

## Structured compaction

Auto-compact and `/compact` produce a sectioned summary (mandate, goal, todos, user messages, tool sketch) so long ULW sessions keep the objective after history pruning.

## `/goal` state machine

```
         arm / auto-arm
              │
              ▼
          ┌ active ◄── resume
          │    │
   pause  │    │ attest **Goal achieved.**
          ▼    ▼
       paused  achieved
          │
   stuck-wall (no edits × N)
          ▼
        stuck (released)
```

State lives at `~/.forge/sessions/<id>/goal.json` (session-scoped, Codex “across turns” semantics).

## Hook wire format

stdin JSON (subset):

```json
{
  "hookEventName": "Stop",
  "sessionId": "…",
  "cwd": "…",
  "workspaceRoot": "…",
  "toolName": "bash",
  "toolInput": { "command": "npm test" },
  "goalObjective": "…",
  "ultrawork": true,
  "editCount": 3,
  "lastAssistantMessage": "…"
}
```

stdout JSON:

```json
{ "decision": "allow" }
{ "decision": "block", "reason": "…", "additionalContext": "…" }
{ "decision": "deny", "reason": "…" }
```

Exit code `2` is an alternate deny/block signal (Claude Code convention).

## Auth matrix

| Provider   | API key | OAuth/subscription attempt |
|------------|---------|----------------------------|
| xAI        | ✅      | ✅ browser / device        |
| OpenAI     | ✅      | ✅ browser / device        |
| Anthropic  | ✅      | ❌ public OAuth not standard |
| OpenRouter | ✅      | ❌                         |
| Google     | ✅      | ❌                         |

OAuth requires a provider-accepted public client id. When exchange fails, Forge falls back to API-key paste rather than lying about a subscription session.

## Production loop self-heal (v0.9+)

Beyond Stop/goal/ULW, the agent loop includes expert-grade recovery so long runs survive provider glitches:

| Mechanism | Behavior |
|---|---|
| **Doom-loop** | Identical tool+args: success repeats trip at 2; errors at N (`FORGE_DOOM_LOOP_THRESHOLD`, default 3). MCP `partial` / tool-clear stubs / `get_task_output` without `wait=` get a typed Next, not generic STOP. |
| **Error-streak** | N consecutive tool errors → circuit-breaker nudge (`FORGE_ERROR_STREAK_THRESHOLD`, default 5) |
| **Request-time prune** | Default **append-only** until outbound estimate ≥ 180k (xAI prefix cache). First clip freezes a sticky omit set on `session.meta.requestPruneSticky`; later rounds apply that set (prefix stays byte-identical). Re-clip on compact/`/clear` or if the already-pruned wire is still ≥180k. `FORGE_REQUEST_PRUNE=1` restores every-round slim. Session.json messages are not rewritten. Mid-run ULW admits are fingerprint-only (`emit: false`); Stop re-anchors still append. |
| **Adaptive effort** | Hard rounds (doom-loop / error-streak / missing wave proof) bump reasoning effort one notch for a turn (`FORGE_ADAPTIVE_EFFORT`) |
| **ULW quality bar** | Wave ledger (facts: edits, proof) → best-wave anchoring, proof demands, consolidation cadence, evidence attestation |
| **Admission suppression** | Counter-only harness churn (wave/blocks/todos) skips redundant mid-conversation admissions |
| **JSON arg repair** | Truncated / fenced tool args repaired when possible |
| **Orphan tool heal** | Abort/compact never leaves unpaired `tool_calls` |
| **Overflow → compact** | Progressive prune + keep 8→4→2; ULW mandate re-admitted |
| **`finish_reason=length`** | Continues generation instead of stopping mid-answer |
| **Empty / content_filter** | Nudge or narrow-scope steer (no blind infinite retry) |
| **OAuth mid-run 401/403** | Forced refresh loop (up to `FORGE_AUTH_RECOVERY_MAX`) + hot-swap refreshed bearer directly; multi-account failover |
| **Provider drop (`terminated`)** | Socket RST / generic `provider_error` force-refreshes OAuth and retries; ULW auto-continues instead of waiting for a typed continue |
| **HTTP/2 RST (`NGHTTP2_INTERNAL_ERROR`)** | Cursor AgentService stream RST is retryable `network`; reconnects without OAuth rotation; compact-before-rebase if same-payload retries fail |
| **File-aware `/undo`** | `mutations.jsonl` pre-images for write/edit/patch / bash / isolation=none spawn fold; `/retry` restores disk too |
| **Fork keeps harness** | `/fork` copies ULW + `/goal` sidecars (and mutation journal) onto the branch |

See [RELIABILITY.md](./RELIABILITY.md) for the full operator contract.

## Session continuity (expert UX)

- Bare interactive `forge` **auto-resumes** the newest same-cwd session (≤14d), skipping foreign live locks
- `forge --new` / `FORGE_NO_AUTO_RESUME=1` / `/new` for a clean slate
- `forge run --session <id|title>` and **`forge run --continue`** for multi-step CI
- `/title`, `/bell`, `/pin`, session fork/export/import for long-running incident work
- `/undo` · `/retry` · `/init` · `/review` · `/compact-and` · `/fork-and-compact` · `/logs` · `/config`
- `forge config --json` · `forge logs` · `forge doctor --json` (`undoJournal`, `bashTimeoutMs`, …)

## What we deliberately did not copy

- Full TUI (Ink/Bubbletea) — REPL first; TUI can layer later
- Proprietary plugin marketplaces
- Cross-session durable goal backlog (oh-my-claude’s No-Out-of-Scope ruling)
- Silent infinite Stop blocks without stuck-wall

## Extending

- Add hooks under `~/.forge/hooks/*.json` or `.forge/hooks/*.json`
- Programmatic: `import { runAgentLoop, armGoal, HookRunner } from "forge-agent"`
