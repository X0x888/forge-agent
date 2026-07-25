# AGENTS.md — Forge CLI

## What this is

Forge is a TypeScript (Node 20+) AI coding agent CLI. The product differentiator is the **harness**: blocking Stop hooks, Codex-style `/goal`, and ultrawork mode.

## Commands

```bash
npm install
npm run build
npm test
npm run typecheck
npm run dev
```

Binary entry: `src/cli.ts` → `dist/cli.js` (`bin: forge`).

## Layout

- `src/harness/` — hooks, goal, stop-guard (do not weaken blocking Stop defaults)
- `src/agent/` — loop, tools, permissions
- `src/providers/` — LLM clients
- `src/auth/` — credentials (never log tokens)
- `src/statusline/` — provider-agnostic HUD (`forge status`); never invent plan metrics
- `src/harness/ulw-cycle.ts` — ULW cycle flag 1/0; soft prompts expand to god-scope; Stop blocks while cycle=1
- `src/harness/context-admit.ts` — mid-conversation harness admissions (stable system + live counters)
- `src/harness/interjection.ts` — free-text mid-run messages (Grok-style `<user_query>`)
- `src/harness/todo-gate.ts` — TodoNudge + TodoGate under ULW
- `src/session/compaction.ts` — structured compact preserving mandate/goal/todos
- `src/agent/sandbox.ts` + `rules.ts` + `shell-parse.ts` — OS sandbox, deny/allow/ask rules, segment-aware shell checks

## Conventions

- ESM only (`"type": "module"`, `.js` extensions in imports)
- Strict TypeScript
- Prefer small focused modules
- Tests: `node:test` via `tsx --test`

## Non-negotiables

1. `blockingStopHooks` defaults to **true** — this is the Grok gap we close.
2. `/goal` stuck-wall must always be able to release (never infinite trap without progress).
3. Auth files written mode `0600`.

## Production reliability (v0.9+)

See `docs/RELIABILITY.md` and `docs/PRODUCTION.md`. Highlights: Retry-After, abortable streams/bash,
JSON arg repair, orphan tool_call heal, doom-loop, error-streak circuit breaker, apply_patch,
atomic file writes, OAuth refresh (start + mid-run 401), session locks, atomic session tmp recovery,
session fork/export/import, headless session lock + `forge run --session`, metrics.jsonl,
permission ask timeout, empty-SSE retry, `finish_reason=length` continue,
stream usage, `meta.json` session sidecar, tunable loop guards (`FORGE_DOOM_LOOP_THRESHOLD`,
`FORGE_ERROR_STREAK_THRESHOLD`), interactive same-cwd auto-resume, `/title`, `/bell` turn-end
attention, `forge sessions prune`, `forge completion`, `forge doctor --json`, `npm run smoke`.
