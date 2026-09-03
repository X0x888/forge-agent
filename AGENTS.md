<!-- proofread 2026-09-03T20:45Z · forge -->

# AGENTS.md — Forge CLI

Forge is a TypeScript (Node 20+) AI coding agent CLI. The product is the **harness**: blocking Stop hooks, `/goal`, and ULW (relentless waves) with a wave ledger, proof demands, and a Bet contract. Everything else (providers, auth, TUI) serves that.

## Commands

```bash
npm install
npm run typecheck        # tsc --noEmit (fast, run after every edit)
npm test                 # node:test via tsx; ~2,700 tests in about a minute; FORGE_HOME is sandboxed to .tmp/
npm run build            # tsc → dist/ (bin: forge)
npm run dev -- "…"       # tsx src/cli.ts
npm run smoke            # build + scripts/smoke.mjs
```

One test file: `npx tsx --test tests/foo.test.ts` (an isolate is proof=ran, not proof=✓ — the suite is the bar).
The script clears `.tmp/forge-*` first: `TMPDIR` is pinned inside the repo and fixtures leave their scratch behind, and a `.tmp` grown to six figures of files makes the background-task tests time out at 10s with an unrelated-looking failure.
Known baseline: 11 loop/retry tests fail on a clean `main` (hooks TypeError from a Cursor-native `~/.cursor/hooks.json`) — diff the `✖` lines against a run at the merge-base before blaming a change.

## Layout (where things live)

- `src/cli.ts` — commander entry: interactive REPL, headless `forge run` (`--json`), `doctor`, `sessions`, `stats`.
- `src/agent/loop.ts` — the agent loop: tool dispatch, Stop path (`runStopGuard`), safe-boundary admissions, background-task credit. Big; grep for the guard name you need.
- `src/agent/system-prompt.ts` — baseline prompt (cache-stable) + project rules loader (`AGENTS.md` / `CLAUDE.md` / cursor / copilot, **12k chars per file**, 28k total); `instruction-paths.ts` is the workspace → git-root walk it shares with the guideline audit — change the walk there, never in one of the two.
- `src/agent/tools/` — file/bash/search/MCP/LSP/subagent tools; `file-read-state.ts` (stale-edit guard), `edit-receipt.ts`, `format-on-write.ts`.
- `src/agent/` also: `permissions.ts` / `rules.ts` / `sandbox.ts` / `shell-parse.ts` (deny > ask > allow; segment-strict bash), `subagent.ts` (explore / plan / general-purpose, worktree isolation).
- `src/harness/` — the product:
  - `stop-guard.ts` composes, in order: user Stop hooks → `report-guard.ts` (attestation pass) → `guideline-audit.ts` — both **before the drivers**, which never hand a Stop on while ULW is armed → `goal.ts` → `ulw-cycle.ts` → `todo-gate.ts` → `handoff-guard.ts` → `proof-claim-guard.ts` → `report-guard.ts`.
  - `ulw-cycle.ts` — cycle flag, wave ledger, LAST wrap, holds (`same-surface.ts`, `explore-contract.ts`, `bet-contract.ts`), `job-delta.ts`, `tests-without-body.ts`, `declared-checks.ts`, `verify-command.ts`, `last-reflect.ts`.
  - `context-admit.ts` — live counters as mid-conversation messages (never rewrite message[0]); `live-notices.ts`, `interjection.ts`.
  - `decision-memory.ts` (session `decisions.json`) and `project-memory.ts` (`~/.forge/project-memory/*.json` + tracked `.forge/MEMORY.md` mirror).
  - `guideline-audit.ts` — first action of a session: survey/brief/stamp the `AGENTS.md`-class files the prompt actually loads (registry `~/.forge/guidelines/`); a look is an argument that resolves to the file, never a mention of its name.
  - `run-report.ts` — standalone end-of-run report (`/report`, `/status` head, `forge run --json`.report, `~/.forge/sessions/<id>/report.md`).
- `src/session/` — sessions under `~/.forge/sessions/<id>/` (`session.json`, `meta.json`, `ulw.json`, `goal.json`, `decisions.json`, `mutations.jsonl`), compaction, request prune, prompt cache, metrics.
- `src/providers/` — xAI / OpenAI-compat / Anthropic / Cursor / Copilot / DeepSeek clients; `errors.ts` recovery tips.
- `src/auth/` — multi-account credentials (`auth.json` v2, mode 0600, never logged).
- `src/commands/slash.ts` — every `/command` (+ `runDoctorCheck`); `help-text.ts`; `project-commands.ts` (`.forge/commands/*.md`).
- `src/tui/` — REPL, bottom dock, status/turn/commit cards, markdown renderer.
- `src/mcp/`, `src/lsp/` — MCP (defaults context7 + playwright) and LSP ensure packs.
- `skills/forge-*/` — built-in skill packs; `docs/` — HARNESS, ULW, RELIABILITY, PRODUCTION, SAFETY, TOOLS.
- `tests/*.test.ts` — one file per module; `tests/helpers/ulw-arm.ts` arms ULW past PLAN for ledger tests.

## Conventions

- ESM only (`"type": "module"`, `.js` extensions in imports). Strict TypeScript. Small focused modules; new harness rules get their own `src/harness/<name>.ts` + `tests/<name>.test.ts`.
- Harness guards are **pure `evaluateXAtStop()` functions** with a capped block count and an env kill-switch (`FORGE_<NAME>=0`); wire them in `stop-guard.ts`, count blocks in `loop.ts`.
- Harness messages injected into the transcript are `role: "user"` and must start with `[Forge` (or another `SYNTHETIC_USER_PREFIXES` entry in `session.ts`) so `/undo`, `/retry` and turn marks skip them.
- Keep the system prompt cache-stable: live state goes through `context-admit.ts`, never into message[0].
- Structural proof beats prose: a check counts only when a verification command actually ran (`verificationRan` / `verificationPassed`); closer text never stamps proof.
- Sidecar JSON under `~/.forge` is written mode 0600 via `writeJsonFile`; nothing in the repo is a secret store.
- Tests must be able to fail: never weaken an assertion to go green; a revert of the change must turn the test red.
- Use the project's own vocabulary in code comments: wave, ship, Reading, Bet, LAST, hold, mill, chrome, job move.

## Non-negotiables

1. `blockingStopHooks` defaults to **true**. Stop/SubagentStop hook timeout or error **fails closed** (the agent keeps working).
2. Every driver must be able to release: `/goal` stuck-wall, ULW `/cycle 0` → `/done` / `/ulw-off`, guard caps. Never an infinite trap without progress.
3. Never push, never `rm -rf`, never drop data on the user's behalf; ULW auto-commit is local only (`FORGE_ULW_AUTO_COMMIT=0` off).
4. Credentials never enter the model: `auth.json`, `id_rsa`, `~/.grok/auth.json` reads are hard-denied even under YOLO.

## Working here

- After edits: `npm run typecheck`, then the test file for the module, then `npm test` before claiming done. The suite is a minute; there is no excuse for shipping on an isolate.
- Test fixtures must `git init` their temp workspace. An empty `.git` dir is not a repo, `TMPDIR` points inside this repo during `npm test`, and git walks up — a fixture that arms ULW will otherwise auto-commit the developer's working tree.
- Real ULW runs are the ground truth for harness changes: `~/.forge/sessions/*/ulw.json` (waves ledger, proofKind, bets). Survey them before adding a rule.
- Changelog: add an entry under `## Unreleased` in `CHANGELOG.md` for user-visible behaviour, in the same "job:" style as its neighbours.
- Deep detail lives in `docs/HARNESS.md` and `docs/ULW.md` — extend those, not this file. This file is a map, not a manual: keep it under 12k chars so the prompt loader shows all of it.
