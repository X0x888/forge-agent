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
