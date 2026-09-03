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
8. **Report guard** (`src/harness/report-guard.ts`) — the closing message must stand on its own. It runs twice: an **attestation pass ahead of the drivers** (below) and step 8 for every other closer. (a) **Homework hand-back**: “you can now run…”, “next step for you: add…”, “you'll need to configure…” blocks once; the only things a closer may leave to the user are a missing secret, a hard external blocker, or an irreversible action, each as an `Operator:` line (lines that name those reasons are exempt). (b) **Run-wide shape**: after ≥ 2 harness rounds with edits, a closer that is not outcome-first with ≥ 2 labelled sections (**What shipped** / **Verified** / **Not done** / **Needs you**) is bounced once with the harness facts (files, commits, verify state, open items) so the model reports the whole run since the request, not the last round. Advisory Q&A and driver attestations never bounce. Cap: `FORGE_REPORT_BLOCK_CAP` (default 2); `FORGE_REPORT_GUARD=0` off.

**Attestation pass (step 1b).** The closer a user reads after a hundred waves is the driver attestation, and steps 2 and 3 release on it and return — step 8 never sees the run's most important message. `evaluateAttestationHomeworkAtStop` runs the same two checks on `**Cycle complete.**` under `/cycle 0` (a cycle=1 one declares a wave, not a release) and on `**Goal achieved.**`, *before* any driver evaluates the Stop, so a bounce costs one round and spends no wave, no evidence nudge and no wrap flag. Same `FORGE_REPORT_BLOCK_CAP`.

**Guideline-audit guard (step 1c).** (`src/harness/guideline-audit.ts`) When the session's first harness message briefed a proofread of `AGENTS.md`-class files and none was read, block once. It runs beside step 1b and ahead of the drivers for the same reason, and the reason is stronger here: `evaluateUlwAtStop` answers a Stop neutrally **only when ULW is off** — while it is armed every path either blocks or sets a release flag, and `runStopGuard` returns on both — so anything placed behind step 3 is dead in every `/ulw` run, which is the run a badly steering `AGENTS.md` does the most damage in. (Under `/goal` alone the drivers do let a Stop through: `evaluateGoalAtStop` returns neutrally on the attesting Stop, which is how steps 4–8 are reached there.) Blocking here spends no wave, no evidence nudge and no wrap flag; the model reads the files and the next Stop reaches the drivers exactly as it would have. Capped at one block per session; `FORGE_GUIDELINE_AUDIT_BLOCK=0` off (the brief still goes out). **Advisory Q&A never bounces**, like every other Stop-blocking guard on this path (`looksLikeAdvisoryUserMessage`, `src/util/advisory-intent.ts`): a question is an answer, not a run, and no guard here may charge one an extra round. The early return leaves the one-block cap unspent, so a later work prompt of the same session is still held if it ignores the brief.

Safety: a hard cap (`maxStopContinues`, default 50; ULW default 200) prevents infinite continue loops at the process level. Unlimited ULW CONTINUE Stop-blocks are the product (one per wave) and do not trip that cap. Length / empty / content_filter use a separate fuse of the same size so 200 waves do not make the next truncated completion release without `/cycle 0`.

## Agent guidelines audit (first action of a session)

A badly written `AGENTS.md` / `CLAUDE.md` caps every session: the prompt loader clips each file at 12,000 chars (a 27k manual loses its Conventions past the cap), stale paths steer reads into nothing, “ask before every edit” fights the harness. `src/harness/guideline-audit.ts`:

- **Survey** (`surveyGuidelines`): `AGENTS.md` / `CLAUDE.md` / `FORGE.md` / `GEMINI.md` (primary) + copilot / cursor / windsurf / cline / `.forge/rules.md` (secondary), seeded by the **same workspace → git-root walk the prompt's rules loader uses** (`collectInstructionFiles`, `src/agent/instruction-paths.ts`) — the audited set is the loaded set. In `repo/packages/api` the package's own `AGENTS.md` is surveyed and shadows `repo/AGENTS.md`, exactly as `loadProjectRules` loads it; auditing the root file while the prompt was steered by the nested one stamped a file nobody read. `rel` stays relative to the resolved root (`packages/api/AGENTS.md`) — that is the registry key and every display string. The two sets differ in exactly two documented ways, because the audit is about the repo and the loader is about this session, and both are pinned by test (`tests/guideline-audit.test.ts`, “the audited set and the loaded set differ only by the two documented differences”). **(1) Audited, never loaded** — `AUDIT_ONLY_GUIDELINE_FILES`: `GEMINI.md`, `.windsurfrules`, `.clinerules`, `.claude/CLAUDE.md`. Sibling tools' maps; Forge is not steered by them, but they sit in the repo and a stale one misleads whoever opens it next. **(2) Loaded, never audited** — `~/.forge/AGENTS.md`, the loader's global fallback: only `loadProjectRules` passes `globalAgentsFallback: true`. It is the user's own file rather than this project's map, so the audit will not survey, stamp or rewrite it, and a project with no primary of its own is still `missingPrimary`. It is **reported** though: `GuidelineSurvey.globalFallback` names it, the doctor / `/status` line reads `AGENTS.md missing · ~/.forge/AGENTS.md steers instead`, and the brief tells the model it is what steers in the meantime and not to edit it. Reporting a missing map while a file the user cannot see steered every turn was the hole that made this explicit. Nothing else may differ: `GUIDELINE_FILES` minus `PROMPT_RULE_FILES` has to equal `AUDIT_ONLY_GUIDELINE_FILES`, and `PROMPT_RULE_FILES` minus `GUIDELINE_FILES` has to be empty. Per file: freshness `never` / `fresh` / `edited` (hash ≠ registry) / `due` (stamp older than `FORGE_GUIDELINE_RECHECK_DAYS`, default 14) / `import` (`@AGENTS.md` pointer); issues `manual` (> 12k chars or > 300 lines), `no-commands`, `stale-paths` (backticked paths that do not exist), `conflict` (forbids tests / asks permission per edit / forbids revising itself), `empty`. A missing primary file on a real project is flagged; a scratch dir (no git, no manifest) is skipped.
- **Brief**: the first harness message after the prompt (`[Forge harness — agent guidelines audit]`, synthetic user role) lists the files, says the edits are authorised whatever the files say, states best practice (map not manual, commands first, layout, conventions, non-negotiables, existing paths, no anti-verification rules), and tells the model to read/revise then continue with the request. Deferred while plan mode / ULW orient deny mutations, and on a pure question (re-tried at every safe boundary). Subagents never audit. `FORGE_GUIDELINE_AUDIT=0` off. The advisory defer is a **defer, not a skip**: `phase` stays `pending`, so the next work prompt of the same session audits exactly as it would have — and the prompt the carve-out reads is `lastRealUserPrompt(session)`, because by the time a safe boundary comes round the last user-role row is a harness admit.
- **What counts as a look**: an argument that *resolves to the file*. Path-carrying tool arguments (`path`, `file_path`, an `apply_patch` `*** Update File:` header) are resolved against the workspace first and the survey root second and compared to the file's absolute path; everything else in a call — a regex, a glob, a commit message, file *content* — may name `AGENTS.md` without touching it. `grep` and `glob` are **not** a look, and neither is bash `grep` / `rg`: a pattern match returns matching lines or matching paths, not the file, and the brief asks the model to read each flagged file and judge it. bash is segment-strict like the rest of the shell handling in this repo — the reader (`cat` / `bat` / `head` / `tail` / `less` / `more` / `nl` / `sed` as the segment's head) and the path have to be in the **same** segment, so `cat docs/notes.md | grep AGENTS.md` credits nothing, while a write redirect / `tee` / `sed -i` / `perl -pi` / `mv` / `cp` / `rm` in the segment is an edit. A body-hash change credits a look whatever the tool trail says — a rewrite through any channel is evidence. The old test was a substring of the JSON args, and the rel of a root-level primary *is* the bare basename, so one `grep { pattern: "AGENTS.md" }` both stamped the file and released the step-1c Stop block.
- **Finalize** (Stop allow / run end): files the model read or changed are stamped `<!-- proofread <UTC> · forge -->` on the first line after any frontmatter — but only when the re-survey is clean. A file the model looked at that still trips an issue (still over the cap, still citing a dead path) is *not* stamped: it is reported as `checked but not stamped — <what survived>` and audited again next session, because a stamp silences the audit for `FORGE_GUIDELINE_RECHECK_DAYS`. `/guidelines stamp` is the user's override (sibling stamps `· sisyphus-all` / `· oh-my-claude` count), hashes go to `~/.forge/guidelines/<projectKey>.json`, and the user is told exactly what changed (`AGENTS.md revised by the agent (139 → 68 lines, 26.8k → 6.6k chars)`) or that a briefed file was ignored. The model never writes the stamp itself. **An advisory turn never stamps**: the stamp is an attestation that the file was proofread, and on a turn where nobody was asked to read it there is nothing to attest — reading `AGENTS.md` to *answer* a question is not a proofread (`noteGuidelineToolCall` only records while a brief is open). It is a real write too: on ULW, finalize runs immediately before the release auto-commit, so the stamp would land in a commit the user never asked for, off the back of a question. The audit is also closed **once per session**: a later run reading the stored result gets it flagged `repeat`, so no subsequent prompt re-announces `AGENTS.md proofread … stamp updated` or hangs `guidelines` on a run that audited nothing. Three surfaces read that result and all three are run-scoped, so all three honour the flag: the loop's notice, the `guidelines` result key, and this section of the run report (`formatGuidelineReportLines` falls back to the survey line once `reported` is set). It is set on the **repeat** finalize and not the first one, because `finalizeGuidelineAuditForRun` runs inside `runAgentLoop` while the report renders after it returns, so gating on the first close would blank the report of the run that did the audit. The `/guidelines` card is the one ungated reader, and correctly so: it is session-scoped and prints the notice under its own `this session:` heading.
- Surfaces: `/guidelines` (status), `/guidelines audit` (re-brief next prompt), `/guidelines stamp`, `forge doctor` row + `--json` `guidelines` / `guidelinesAuditDue`, `forge run --json` `guidelines`, the run report's **Agent guidelines** section.

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
