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

- `src/harness/` — hooks, goal, stop-guard, handoff-guard, proof-claim-guard (do not weaken blocking Stop defaults)
- `src/agent/` — loop, tools, permissions
- `src/providers/` — LLM clients; `errors.ts` expert recovery tips (`formatProviderError`)
- `src/auth/` — multi-account credentials (never log tokens); `accounts.ts` smart switch; auth.json v2; `src/util/file-lock.ts` `withFileLock` serializes cross-process load→mutate→save on auth.json/preferences.json (fail-open, bounded wait — never brick login)
- `src/statusline/` — provider-agnostic HUD (`forge status`); never invent plan metrics
- `src/commands/` — slash handlers; `project-commands.ts` (`.forge/commands/*.md`); `headless-slash.ts` for `forge run "/…"`
- `src/harness/ulw-cycle.ts` — ULW cycle flag 1/0; optional `maxWaves` cap (auto LAST); soft prompts expand to god-scope; Stop blocks while cycle=1; wave ledger + quality bar (proof demands, thin-wave escalation, evidence attestation)
- `src/harness/context-admit.ts` — mid-conversation harness admissions (stable system + live counters; counter-only churn suppressed; volatile git branch line admitted append-only — message[0] keeps cache-stable git root/remote only)
- `src/config/model-info.ts` — per-model context windows (grok-4.5=500k, grok-4=256k, claude=200k, gpt-4.1=1M); used when `context_window` is not explicit
- `src/harness/interjection.ts` — free-text mid-run messages (Grok-style `<user_query>`)
- `src/util/advisory-intent.ts` — Q&A/advisory vs work-order classifier (compact handoff + mid-run interjections under ULW)
- `src/harness/todo-gate.ts` — TodoNudge + TodoGate under ULW; soft once outside ULW; `clearSoftTodoGateOnWindDown` on `/done`/`/goal done|clear`/`/cycle 0`/`/ulw-off`/`/clear`/`/new`/safety-valve LAST **and** fresh driver arm (`/ulw`, `/goal set`); also max_waves auto LAST, stuck-wall, goal attestation/`markGoalDone`, and `setMaxWaves` when already at/over cap · advisory Q&A releases TodoGate + skips TodoNudge (pairs with compact ADVISORY framing)
- `src/harness/handoff-guard.ts` — premature “let me know if…” / “shall I continue?” Stop block (finish doctrine) · advisory Q&A allows soft continue-asks
- `src/harness/proof-claim-guard.ts` — “tests pass” / bare “Done.” after edits without *successful* verification (`verificationPassed`) Stop block (don't claim, prove) · advisory Q&A softens bare Done./Fixed. closers
- `src/util/cost-budget.ts` — session spend cap parse/resolve (`/budget`, `--max-cost`, `FORGE_MAX_COST_USD`)
- `src/util/production-warnings.ts` — `productionWarningsForRun` for `forge run --json` / CI (safety valves, ULW-without-budget, dirty tree, editsWithoutVerification, lockfile/node_modules)
- `src/session/compaction.ts` — structured compact preserving mandate/goal/todos
- `src/session/tool-clearing.ts` — proactive stale tool-result clearing (microcompaction; `FORGE_TOOL_CLEAR*`)
- `src/agent/project-skills.ts` — OpenCode-style skill packs (`.forge/skills/**/SKILL.md`)
- `src/util/project-intel.ts` — package manager + preferred check commands (system prompt, `/context`, bash wrong-PM/missing-script/missing-binary tips; monorepo walk-up + turbo/nx; doctor/status/config/run JSON; last-verify trail + `editsWithoutVerification`)
- `src/agent/tools/file-read-state.ts` — session stale/unread edit guard (`FORGE_FILE_READ_GUARD=0` off)
- `src/agent/tools/ask-user.ts` — interactive clarifying questions (OpenCode-inspired)
- `src/agent/tools/format-on-write.ts` — opt-in format after file tools (`/format`, `FORGE_FORMAT_ON_WRITE`)
- `src/agent/sandbox.ts` + `rules.ts` + `shell-parse.ts` — OS sandbox, deny/allow/ask rules, segment-aware shell checks
- `src/agent/permission-preview.ts` — in-memory colored diff previews for edit-tool permission asks (never writes)
- `src/tui/markdown.ts` — streaming markdown renderer for assistant output (line-buffered; chunk-split invariant; non-TTY passthrough)

## Expert session UX

- `/plan` → session-scoped read-only design; `/commit [do]` drafts/creates commits from the diff (never pushes) (no sticky prefs); `/build` restores prior mode and implements
- `/model <name> [effort]` live mid-run; `/commands` lists `.forge/commands` templates
- Transcript shows per-edit diffs (green `+` / red `-`) under each edit-tool line; `/verbose` toggles full tool output vs 5-line dimmed head (session-local)
- Live `live ›` dock shows cumulative completion tokens + `ctx used/window`; assistant replies render as styled markdown
- Project instructions: walk-up within git root for AGENTS/CLAUDE/cursor/copilot rules; `/context` lists sources
- Headless: `forge run "/plan"` / custom templates work in CI (`reason: "slash"` when no model call)
- Provider failures print recovery tips; JSON fail payloads include `recovery: { code, tips }`

## Conventions

- ESM only (`"type": "module"`, `.js` extensions in imports)
- Strict TypeScript
- Prefer small focused modules
- Tests: `node:test` via `tsx --test`

## Non-negotiables

1. `blockingStopHooks` defaults to **true** — this is the Grok gap we close. Stop/SubagentStop hook **timeout/error fails closed** (agent keeps working).
2. `/goal` stuck-wall must always be able to release (never infinite trap without progress).
3. Sensitive JSON under `~/.forge` written mode `0600` (`auth.json`, `permissions.json`, `preferences.json`).

## Production reliability (v0.9+)

See `docs/RELIABILITY.md` and `docs/PRODUCTION.md`. Highlights: Retry-After, abortable streams/bash,
stream-capped `web_fetch`/`web_search`, JSON arg repair, CLI `--json` always stamps `version`
(`emitOkJson`/`emitFailJson` include `node`; `FORGE_JSON_COMPACT=1` for single-line success; `forge run --json` includes `productionWarnings[]`), doctor flags yolo/`sandbox=off`, bash IMDS deny, sticky login provider (preferences.json), orphan tool_call heal (load/import +
**re-save** when healed and no foreign lock), doom-loop, error-streak circuit breaker, apply_patch
(path typo hints; directory-target errors), atomic file writes, OAuth refresh (start + mid-run 401),
session locks (headless fail-closed; `FORGE_FORCE_SESSION_LOCK=1` override; live+bad timestamp held),
atomic session tmp recovery, session fork/export/import (export `0600`), headless `forge run
--session`, metrics.jsonl, permission ask timeout, empty-SSE retry, `finish_reason=length` continue (+ content_filter/empty cap hygiene),
`releasedOnContinueCap` / `hitMaxTurns` / `hitCostCap` / `finishReason` / `pinned` / `foreignLock` JSON/metrics + stats `continueCapReleases`/`maxTurnsHits`/`costCapHits`,
`--max-turns` / `FORGE_MAX_TURNS` / `max_turns=0` unlimited, `--max-cost` / `FORGE_MAX_COST_USD` / `max_cost_usd` / `/budget` session spend cap (estimateCostUsd; run JSON `effectiveMaxCostUsd`/`sessionCostUsd`), handoff-guard + proof-claim-guard Stop blocks (incl. silent edits-without-verify free triage), soft TodoGate outside ULW, interjection harness context, `/done` winds ULW+goal, safety valves under ULW CONTINUE auto-flip to LAST (`maybeFlipUlwToLastOnSafetyValve`), `forge sessions title`, `forge models -p`, stream usage, `meta.json`
session sidecar (authoritative for title/pinned — title/pin writes are meta-only via
`saveSessionMetaSidecar` so they never roll back racing messages; `saveSession` merges
externally-set title/pin), strict session-id slugs (`isValidSessionId`; resolve + sidecar-normalize
reject traversal), foreign-lock EPERM counts as ALIVE (sessionHasForeignLiveLock + stats), tunable loop guards (`FORGE_DOOM_LOOP_THRESHOLD`, `FORGE_ERROR_STREAK_THRESHOLD`),
interactive same-cwd auto-resume, `/title`, `--title` on `forge`/`forge run`, `/bell` turn-end
attention, `/notify` desktop notify (osascript/notify-send; `FORGE_NOTIFY`), `turnEndOutcomeLabel` safety-valve notify bodies, background-task teardown on exit, JSON store isolation (`readJsonFile` clones
fallbacks; auth/permissions/preferences mode `0600`), `listSessions({ cwd, query, limit })` +
`forge sessions list --cwd`/`-q`, `/sessions` same-cwd default + search, `forge sessions prune`
(skips foreign locks) / `delete --force`, shell-safe `/diff` (argv + filter allowlist),
external_directory on grep/glob/list_dir, `forge completion`, `forge doctor` / `doctor --json`
(structured `runDoctorCheck` + `issues[]` / `secureFiles`; exit 1 on issues), path-not-found typo
hints, session import/load message-role sanitization, `forge stats` / `/stats`, `/share` handoff (git/goal/ULW), `sessionPath`/`forgeHome` on run/status/doctor JSON, `session_not_found` `suggestions[]`
card, shared `formatExpertTips` (`forge tips`/`/tips`), first-run welcome tip, unknown-slash Did you mean?, CLI `command_typo`/`conflicting_flags`/`invalid_base_url`, `/retry`/`/again`,
`/last [n]`, resume auto-peek, `forge news`/`/news`, `forge run --continue` (fail-closed `continue_miss`/`continue_locked`; empty CLI flags fail closed) / bare `forge --continue` / bare `forge "…" --json`, `forge auth|login|logout --json`, `/done`/`/pause`/
`/unpause`, session `lastUserPreview` list snippets, resume-by-title, relative session ages,
`/files`, `/path` (+ copy), `/pin` + `sessions pin` (fork clears pin; status PIN badge), resume
orientation + `--pinned` list, doctor `sessionsPinned`, session path helpers, sessions show file
snippet, file-aware `/undo` (`mutations.jsonl` pre-images + journaled file mode; turn marks skip
synthetic harness user-messages — `isSyntheticUserMessage`), `/init`, `/review`, `/compact-and`,
`/fork-and-compact`, fork copies ULW/goal sidecars, `/clear`/`/clear hard`/`/new` hygiene, `/logs`
· `forge logs`, `/config` · `forge config`, `/export` mode `0600`, `--read-outside ask|allow|deny`, doctor flags `read-outside=allow` / `sandbox-missing=fallback`, `FORGE_BASH_TIMEOUT_MS` /
`FORGE_BASH_BG_TIMEOUT_MS`, doctor `undoJournal`, `npm run smoke`, ULW wave ledger + quality bar
(facts-only per-wave edits/proof; best-wave anchoring, proof demands, thin-wave escalation, 4th-wave
consolidation, diminishing-returns advisory, one-time evidence bounce on weak attestations),
structural `verificationRan` (execution) + `verificationPassed` (success-only proof-claim/attestation/ULW wave proof) stop signals, project-intel (pm/checks/monorepo; `FORGE_FILE_READ_GUARD` / `FORGE_VERIFY_HINT`), last-verification trail (`lastVerificationCommand`/`At` + `lastEditAt` stale detection on session + resume/status/share/done/export/list ✓; `editsWithoutVerification` in run JSON), adaptive effort (`FORGE_ADAPTIVE_EFFORT`; hard rounds bump
reasoning one notch), stale tool-result clearing (`FORGE_TOOL_CLEAR*` microcompaction), counter-only
admission suppression, Anthropic prompt caching (`FORGE_ANTHROPIC_CACHE`; cache usage in `ChatUsage`,
cache buckets folded into `prompt_tokens` so totals/spend cap don't undercount),
per-model context windows (`context_window` explicit wins; `src/config/model-info.ts` otherwise),
prompt-cache-stable system prompt (volatile git branch via context-admit, not message[0]), Stop hook
crash/HTTP fail-closed + stdin-EPIPE safe + 20k payload caps (all bulky fields) + 64KB hook
stdout/stderr caps + hook timeout process-group kill (TERM→KILL, unref'd timers), Retry-After
honored above client backoff
(≤120s), 10-min default provider timeout (`FORGE_PROVIDER_TIMEOUT_MS`), 4MB child-output caps
(bash/rg), streaming read_file for >2MB files, byte-guaranteed tool-output truncation, atomic
session-lock create (`wx`), model-aware cost estimates (grok-4.5 $2/$6), auto max_tokens (16k non-reasoning · 32k deepseek/64k other reasoning-active; `/max-tokens` pin wins), temperature omitted unless pinned (server-tuned defaults), OpenRouter nested `reasoning.effort` maps `max`→`xhigh` (native top-level keeps `max`).
