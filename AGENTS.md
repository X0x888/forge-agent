<!-- proofread 2026-09-07T13:48Z · oh-my-claude -->

# AGENTS.md — Forge CLI

Forge is a TypeScript (Node 20+) AI coding agent CLI. The product is the **harness**: blocking Stop hooks, `/goal`, and ULW — a **plan-cycle** driver where a fresh-context Planner writes the plan, the session model executes it, a fresh-context Reviewer revises the cycle diff, and the harness runs the verify command and commits. Everything else (providers, auth, TUI) serves that.

## Commands

```bash
npm install
npm run typecheck        # tsc --noEmit (fast, run after every edit)
npm test                 # node:test via tsx; ≈2,450 tests in about a minute; FORGE_HOME is sandboxed to .tmp/
npm run build            # tsc → dist/ (bin: forge)
npm run dev -- "…"       # tsx src/cli.ts
npm run smoke            # build + scripts/smoke.mjs
```

One test file: `npx tsx --test tests/foo.test.ts` (an isolate is proof=ran, not proof=✓ — the suite is the bar). Colour tests import `tests/helpers/pin-color.ts` first so `NO_COLOR` from a parent session cannot flip them.
The script clears `.tmp/forge-*` first: `TMPDIR` is pinned inside the repo and fixtures leave their scratch behind, and a `.tmp` grown to six figures of files makes the background-task tests time out at 10s with an unrelated-looking failure. `npm test` also unsets `NO_COLOR` and sets `FORCE_COLOR=1`. User-home Claude/Cursor hooks are not loaded under `node:test`.

## Layout (where things live)

- `src/cli.ts` — commander entry: interactive REPL, headless `forge run` (`--json`), `doctor`, `sessions`, `stats`.
- `src/agent/loop.ts` — the agent loop: tool dispatch, Stop path (`runStopGuard`), safe-boundary admissions, background-task credit. Big; grep for the guard name you need.
- `src/agent/system-prompt.ts` — baseline prompt (cache-stable) + project rules loader (`AGENTS.md` / `CLAUDE.md` / cursor / copilot; **28k total, split fairly across the loaded files, 12k floor per file** — `ruleFileBudget`; a clipped file gets a visible `[clipped …]` marker, a startup warning, a `/context` `loaded/total` line and a doctor row); `instruction-paths.ts` is the workspace → git-root walk it shares with the guideline audit — change the walk there, never in one of the two.
- `src/agent/tools/` — file/bash/search/github/MCP/LSP/subagent tools; `file-read-state.ts` (stale-edit guard), `edit-receipt.ts`, `format-on-write.ts`.
- `src/agent/` also: `permissions.ts` / `rules.ts` / `sandbox.ts` / `shell-parse.ts` (deny > ask > allow; segment-strict bash), `subagent.ts` (explore / plan / general-purpose, worktree isolation).
- `src/harness/` — the product:
  - `stop-guard.ts` composes, in order: user Stop hooks → `report-guard.ts` (attestation pass for `**Goal achieved.**`, **before the drivers**) → `goal.ts` → `cycle/` (the ULW driver) → `todo-gate.ts` → `handoff-guard.ts` → `proof-claim-guard.ts` → `report-guard.ts`. Every block is counted per guard in `guardBlocks` (run JSON · `metrics.jsonl` · `forge stats` harness row).
  - `cycle/` — the ULW plan-cycle driver: `state.ts` (schema-2 `ulw.json`: cycle, phase, plan items, `cycles[]`, ledger), `machine.ts` (pure `decideAtStop`), `artifacts.ts` (`scout.md` / `plan.md` / `look.md` / `review.md` parsers — labelled lines, never intent; a `continue` plan owes `Considered:` with `leave it`, `serves:` and `red now:` per item), `briefs.ts` (what the fresh Planner / Reviewer are handed — in two turns: the product first, the record second — and what the executor hears of the last review at the next plan admission), `roles.ts` (the two-turn runner on one kept subagent session; `FORGE_ULW_TWO_TURN=0` = one brief), `orchestrator.ts` (runs the roles, the harness-run verify and the commit through an injected `CycleRuntime`; `ensureCyclePlanned` at turn start), `verify.ts`, `controls.ts` (`/cycle 0` = finish the open cycle then stop; `/replan`; `/max-cycles`), `status.ts`. There is **no mandate classifier and no wave meter** (the user's words are never rewritten — they are attention, not a quality ceiling; `Direction:` is the Planner's after using the product): the Planner decides `fulfilled`, the Reviewer judges the diff, the harness enforces sequence and facts. On a **no-mandate** run the model cannot stop itself — a scout that already parses as a `continue` plan is admitted; otherwise a plan-less Planner or a `fulfilled` becomes a synthesized work cycle (keep-promise / go-deeper / direct-execute), and the run releases only on a mandate fulfilled, a Planner `blocked`, a user control, or the no-progress wall (`directExecuteStreak` ≥ `FORGE_ULW_NO_PROGRESS_CAP`); a read-only role (Planner `denyEdits`) never hears the fix-until-green nudge (`toolSetCanEdit`), and its plan turn is `documentOnly`. Facts still gate everything (no writes before a plan, no executor `git commit` while armed, no commit before a completed review and a green harness-run check — green is "no new failures against the baseline", never an isolate; a `cargo -p && godot --headless` compound is the product gate) — the baseline is captured the first time each gate command is seen: cycle 1's tree, or the tree as the last commit left it when a later Planner declares a different check, then the accepted run after each commit; the order is verify → review → verify → commit so the Reviewer reads a tree that passes). HashPet (`~/.forge/sessions/23b2c2a5*`, 791 waves, every meter green, architecture 74 → 36) is why the meters became a Reviewer. `verification.ts` / `verify-command.ts` / `declared-checks.ts` classify what a check run is.
  - `context-admit.ts` — live counters as mid-conversation messages (never rewrite message[0]); `live-notices.ts`, `interjection.ts`.
  - `decision-memory.ts` (session `decisions.json`) and `project-memory.ts` (`~/.forge/project-memory/*.json` + tracked `.forge/MEMORY.md` mirror).
  - `guideline-audit.ts` — first action of a work turn: survey the `AGENTS.md`-class files the prompt actually loads; **fact defects** (dead paths, missing scripts, PM mismatch, clipped, empty) are fixed in place by the model, **doctrine** (long / conflict / no-commands) goes to a proposal outside the repo for `/guidelines diff|apply|discard` (or `guidelineAutoApply`); evidence-triggered, no Stop block (registry `~/.forge/guidelines/`); a look is an argument that resolves to the file, never a mention of its name.
  - `run-report.ts` — standalone end-of-run report (`/report`, `/status` head, `forge run --json`.report, `~/.forge/sessions/<id>/report.md` or `report-N.md` after a re-arm).
- `src/session/` — sessions under `~/.forge/sessions/<id>/` (`session.json`, `meta.json`, `ulw.json`, `goal.json`, `decisions.json`, `mutations.jsonl`), compaction, request prune, prompt cache, metrics (`~/.forge/metrics.jsonl` = run-level; `rounds.jsonl` = per provider round — never mix them back, the round volume evicted run history).
- `src/providers/` — xAI / OpenAI-compat / Anthropic / Cursor / Copilot / DeepSeek clients; `errors.ts` recovery tips.
- `src/auth/` — multi-account credentials (`auth.json` v2, mode 0600, never logged).
- `src/commands/slash.ts` — every `/command` (+ `runDoctorCheck`); `help-text.ts`; `project-commands.ts` (`.forge/commands/*.md`).
- `src/tui/` — REPL, bottom dock, status/turn/commit cards, markdown renderer.
- `src/mcp/`, `src/lsp/` — MCP (defaults context7 + isolated playwright) and LSP ensure packs. GitHub source is the native `github` tool.
- `skills/forge-*/` — built-in skill packs; `forge-planner` / `forge-reviewer` are the ULW role briefs, `forge-veteran` the shared doctrine; `docs/` — HARNESS, ULW, RELIABILITY, PRODUCTION, SAFETY, TOOLS.
- `tests/*.test.ts` — one file per module; `tests/helpers/cycle-arm.ts` arms ULW with a plan already admitted (`armWithPlan`) and makes a real git repo (`mkGitRepo`); `tests/cycle-*.test.ts` drive the orchestrator with a fake `CycleRuntime`.

## Conventions

- ESM only (`"type": "module"`, `.js` extensions in imports). Strict TypeScript. Small focused modules; new harness rules get their own `src/harness/<name>.ts` + `tests/<name>.test.ts`.
- Harness guards are **pure `evaluateXAtStop()` functions** with a capped block count and an env kill-switch (`FORGE_<NAME>=0`); wire them in `stop-guard.ts`, prefix the injected reason `[Forge <guard>]` and add that prefix to `GUARD_BLOCK_CLASSES` in `request-prune.ts` so the block is metered.
- Harness messages injected into the transcript are `role: "user"` and must start with `[Forge` (or another `SYNTHETIC_USER_PREFIXES` entry in `session.ts`) so `/undo`, `/retry` and turn marks skip them. Anything that classifies the user's or the model's prose by regex (`advisory-intent.ts`, `report-guard.ts`) is pinned to `tests/fixtures/prose-corpus.ts` — add the sentence that broke you to the corpus before you touch the pattern.
- Keep the system prompt cache-stable: live state goes through `context-admit.ts`, never into message[0].
- Structural proof beats prose: a check counts only when a verification command actually ran (`verificationRan` / `verificationPassed`); closer text never stamps proof.
- Sidecar JSON under `~/.forge` is written mode 0600 via `writeJsonFile`; nothing in the repo is a secret store.
- Tests must be able to fail: never weaken an assertion to go green; a revert of the change must turn the test red.
- Use the project's own vocabulary in code comments: cycle, plan, item, Planner, Reviewer, executor, verify, commit, wave (one Stop inside EXECUTE).

## Non-negotiables

1. `blockingStopHooks` defaults to **true**. Stop/SubagentStop hook timeout or error **fails closed** (the agent keeps working).
2. Every driver must be able to release: `/goal` stuck-wall, ULW `Verdict: fulfilled` / `/cycle 0` / `max_cycles` / `fix_rounds` / `/ulw-off`, guard caps. Never an infinite trap without progress.
3. Never push, never `rm -rf`, never drop data on the user's behalf; ULW auto-commit is local only (`FORGE_ULW_AUTO_COMMIT=0` off).
4. Credentials never enter the model: `auth.json`, `id_rsa`, `~/.grok/auth.json` reads are hard-denied even under YOLO.

## Working here

- After edits: `npm run typecheck`, then the test file for the module, then `npm test` before claiming done. The suite is a minute; there is no excuse for shipping on an isolate.
- Test fixtures must `git init` their temp workspace. An empty `.git` dir is not a repo, `TMPDIR` points inside this repo during `npm test`, and git walks up — a fixture that commits a cycle will otherwise commit the developer's working tree.
- Real ULW runs are the ground truth for harness changes: `~/.forge/sessions/*/ulw.json` (`cycles[]`, ledger) and `cycles/<n>/plan.md` / `review.md`. Survey them before adding a rule.
- Changelog: add an entry under `## Unreleased` in `CHANGELOG.md` for user-visible behaviour, in the same "job:" style as its neighbours.
- Deep detail lives in `docs/HARNESS.md`, `docs/ULW.md` and the per-module contracts in `docs/MODULES.md` — extend those, not this file. This file is a map, not a manual: keep it under 12k chars — that is the per-file floor when several rule files load (`ruleFileBudget` in `src/agent/instruction-paths.ts`), and every char here is paid on every prompt.
