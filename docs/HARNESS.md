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
   - stuck-wall (N no-edit Stop attempts) → release + surface to user
3. **ULW cycle driver** (`cycle=1` re-anchor / `cycle=0` last-wave attestation)
4. **TodoGate** — open todos under ULW without `**Cycle complete.**` / `**Goal achieved.**`
5. **Ultrawork open-todos backstop** (session flag if cycle state missing)

Safety: a hard cap (`maxStopContinues`, default 50; ULW default 200) prevents infinite continue loops at the process level.

## Mid-conversation context (OpenCode-inspired)

The **baseline system prompt** stays stable within a session epoch (workspace, tools, ULW *protocol*, project rules). Live harness fields (cycle/wave/mandate, goal objective, open todo counts) are **admitted** as chronological user messages:

```text
[Forge harness — mid-conversation update]
## ULW
ON | cycle=1 wave=3 blocks=5 (CONTINUE)
…
```

Admission runs only at a **safe provider-turn boundary** (before each model call), after promoting live slash notices and free-text interjections.

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

## What we deliberately did not copy

- Full TUI (Ink/Bubbletea) — REPL first; TUI can layer later
- Proprietary plugin marketplaces
- Cross-session durable goal backlog (oh-my-claude’s No-Out-of-Scope ruling)
- Silent infinite Stop blocks without stuck-wall

## Extending

- Add hooks under `~/.forge/hooks/*.json` or `.forge/hooks/*.json`
- Programmatic: `import { runAgentLoop, armGoal, HookRunner } from "forge-agent"`
