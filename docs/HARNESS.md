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

Safety: a hard cap (`maxStopContinues`, default 50; ULW default 200) prevents infinite continue loops at the process level. Unlimited ULW CONTINUE Stop-blocks are the product (one per wave) and do not trip that cap. Length / empty / content_filter use a separate fuse of the same size so 200 waves do not make the next truncated completion release without `/cycle 0`.

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
