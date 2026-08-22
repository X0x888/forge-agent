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

- `src/harness/` — hooks, goal, stop-guard, handoff-guard, proof-claim-guard, project-memory (do not weaken blocking Stop defaults; leftover this-cycle notes auto-archive, `/memory project prune`)
- `src/agent/` — loop, tools, permissions, subagents (`spawn_subagent`; general-purpose defaults to `isolation=worktree` and auto-lands into parent only when status=completed; incomplete keeps the worktree, including `land=discard`). Credential reads (`auth.json`, `id_rsa`, `~/.grok/auth.json`) are hard-denied — YOLO / `--read-outside allow` cannot dump tokens into the model.
- `src/mcp/` — Model Context Protocol (search_mcp / call_mcp); built-in defaults **context7** + **playwright** (`src/mcp/defaults.ts`)
- `src/lsp/` — Language Server Protocol; ensure pack TS+Python (+ Rust/Go when detected); `forge lsp ensure`. Agent `lsp({ action: "ensure" })` is a mutation (not plan/read-only) — same gate class as `web_fetch allow_local`.
- `src/providers/` — LLM clients; `errors.ts` expert recovery tips (`formatProviderError`)
- `src/auth/` — multi-account credentials (never log tokens); `accounts.ts` smart switch; auth.json v2; `src/util/file-lock.ts` `withFileLock` serializes cross-process load→mutate→save on auth.json/preferences.json (fail-open, bounded wait — never brick login)
- `src/statusline/` — provider-agnostic HUD (`forge status`); never invent plan metrics; SuperGrok weekly `use%`+reset via nested `config.creditUsagePercent` / period end
- `src/util/git-auto-commit.ts` — unattended ULW commits the dirty tree at each wave close and on **Cycle complete.** (never push); `FORGE_ULW_AUTO_COMMIT=0` off
- `src/tui/bottom-status.ts` — always-on REPL bottom dock (model · ctx · `cache N%` last-round · plan quota · reset · `sub N $x` when children spent); `ULW` badge follows live `ulw.enabled` (stuck-wall / Cycle complete clear `meta.ultrawork`); `FORGE_BOTTOM_STATUS=0` off
- `src/session/subagent-usage.ts` — parent family spend ledger (`meta.subagentUsage`); fold uses child.meta so completed explores cannot vanish; `/budget` is the family cap (children pin to remaining; parent HIT refuses spawn; live-fold so parallel siblings share remaining; cost-cap handoff is `incomplete_cost_cap` and does not land)
- `src/commands/` — slash handlers; `project-commands.ts` (`.forge/commands/*.md`); `headless-slash.ts` for `forge run "/…"`
- `src/harness/ulw-cycle.ts` — ULW cycle flag 1/0; optional `maxWaves` cap (auto LAST on Stop; **idle epochs never increment `w`** — capped or unlimited; thought-only Stop (no text, no edits) does not increment `w` or FIFO a named ship; the counter is work units, not ~20 tool rounds; **`max_waves=N` is a budget** — evidenced **Cycle complete.** under cycle=1 does not release; LAST only at the cap or `/cycle 0`); **`/cycle 0` at wave N stops at N+1** (finish the open wave, ship one more, then budget LAST) — `/done` / cap / polish / safety LAST wraps the open wave only; **LAST reflect** (`src/harness/last-reflect.ts`) then scores this run automatically (read-only `Must-fix:` vs `Live-with:`; at most one must-fix close-out; `FORGE_ULW_LAST_REFLECT=0` skips); `/cycle 1` after LAST clears the wrap; `/ulw-off` aborts; every ULW Wave 1 is **PLAN** (`/plan` mode + yolo-proof `ulw_orient` — no spawn/edits until a written `Reading:` / `exit_plan_mode` / user `/build`; then the driver `/build`s); later waves skip the scout; evaluate-class mandates keep their verbs (the Wave 1 plan *is* the reading, not advice); follow-up user text does not re-arm or replace the mandate (`/ulw <new>` still does); soft prompts expand to god-scope; Stop blocks yield while cycle=1; wave ledger + quality bar (proof demands, thin-wave escalation, evidence attestation); **same-surface hold** (`src/harness/same-surface.ts`) — 3 declared ships on one theme (summary overlap / leftover-sibling / speak-once) blocks unlimited ULW until a different-surface `Reading:` or `/cycle 0` (stuck-wall does not increment; cap and `/cycle 0` N+1 are not held — they still advise at 2 and strongly advise at 3); **tests-without-body** (`src/harness/tests-without-body.ts`) — `Wave shipped` on a red-only test file does not increment `w`; unlimited seeds `namedShips` from explore-map picks (job-complete only, no FIFO) and exhausts when they are done; isolate `wN` / cited `fail N` is not wave proof; net-diff progress tracking (`gitDiffFingerprint`: bash-channel edits count as progress, edit→revert churn = revisit → thin + excluded from bestWave); auto-commit clean-tree is a new baseline (not revisit); unlimited CONTINUE never stuck-releases (user `/cycle 0` / `/ulw-off`); unlimited named-ship backlog asks for a new reading (stays blocked until a different-surface reading or `/cycle 0`; stuck-wall does not release that hold; a declared ship with edits still stamps `w`; glanceable ✓ re-lists are refused); leftover-chrome class includes glanceable ✓ + live › last-line / bang-shell / idle bg tails (consolidation does not reset polish-4); one ship grammar (`Ship landed` / `**Ship:**` / `Wave N ship` / `Wave shipped`) for stamps + ledger + auto-commit; HUD ctx follows last API `prompt_tokens`; user LAST bounces a dirty/unverified open wave once; background bash excluded from structural verification (`countsTowardVerification` — spawn observes no exit code)
- `src/harness/context-admit.ts` — mid-conversation harness admissions (stable system + live counters; counter-only churn suppressed; volatile git branch line admitted append-only — message[0] keeps cache-stable git root/remote only)
- `src/config/model-info.ts` — per-model context windows (xAI grok-4.6/4.5=500k, grok-4=256k, claude=200k, gpt-4.1=1M; **Cursor-hosted Grok 4.5+ = 256k**, native 500k on xAI); Grok flagship ids newer than the last known milestone inherit that milestone (`src/config/grok-model.ts`)
- `src/harness/interjection.ts` — free-text mid-run messages (Grok-style `<user_query>`)
- `src/util/advisory-intent.ts` — Q&A/advisory vs work-order classifier (compact handoff + mid-run interjections under ULW)
- `src/harness/todo-gate.ts` — TodoNudge + TodoGate under ULW; soft once outside ULW; `clearSoftTodoGateOnWindDown` on `/done`/`/goal done|clear`/`/ulw-off`/`/clear`/`/new`/safety-valve LAST **and** fresh driver arm (`/ulw`, `/goal set`); also max_waves auto LAST, stuck-wall, goal attestation/`markGoalDone`, and `setMaxWaves` when already at/over cap · advisory Q&A releases TodoGate + skips TodoNudge (pairs with compact ADVISORY framing)
- `src/harness/handoff-guard.ts` — premature “let me know if…” / “shall I continue?” Stop block (finish doctrine) · advisory Q&A allows soft continue-asks
- `src/harness/proof-claim-guard.ts` — “tests pass” / bare “Done.” after edits without *successful* verification (`verificationPassed`) Stop block (don't claim, prove) · advisory Q&A softens bare Done./Fixed. closers
- `src/util/cost-budget.ts` — session spend cap parse/resolve (`/budget`, `--max-cost`, `FORGE_MAX_COST_USD`)
- `src/tui/budget-card.ts` — `/budget` verdict-first (`HIT` / `ok` / `none`); set/off that leaves not-hit clears `max_cost` lastErr
- `src/util/production-warnings.ts` — `productionWarningsForRun` for `forge run --json` / CI (safety valves, ULW-without-budget, dirty tree, editsWithoutVerification, lockfile/node_modules)
- `src/session/compaction.ts` — structured compact preserving mandate/goal/todos
- `src/session/checkpoint.ts` + `compaction.ts` — store checkpoint (job card + in-flight tail) when session.json is huge; not outbound-80k FullReplace
- `src/session/prompt-cache.ts` — xAI `x-grok-conv-id`, reasoning replay, cache ratio, prune-at-180k decision
- `src/session/explore-map.ts` — structured explore child maps; parent `read_file` dereference + cited-line window
- `src/session/request-prune.ts` — outbound working-set prune (default **off** until 180k so the prefix can cache; first clip freezes a sticky omit set on `session.meta.requestPruneSticky`; later rounds apply that set instead of re-aging; `FORGE_REQUEST_PRUNE=1` legacy every-round)
- `src/session/tool-clearing.ts` — optional in-session stubbing (`FORGE_TOOL_CLEAR=1`; default off)
- `src/harness/product-quality.ts` — user-facing product **quality** bar (not a persona): job insight + one finished edge + at most one labeled `Serendipity:`; chrome catalogs are not a reading; bounce once (`/cycle 1` / fork / re-enable reset it); `/cycle status` lists the bar; harvest fail-open; generic UI chrome / infra / bugfix never arm
- `src/agent/project-skills.ts` — skill packs: package `skills/forge-*/` (builtin) + `.forge/skills/**/SKILL.md` + `.agents/skills` + `~/.forge/skills` (project > user > builtin; `FORGE_BUILTIN_SKILLS=0` off)
- `src/util/project-intel.ts` — package manager + preferred check commands (system prompt, `/context`, bash wrong-PM/missing-script/missing-binary tips; monorepo walk-up + turbo/nx; doctor/status/config/run JSON; last-verify trail + `editsWithoutVerification`)
- `src/agent/tools/file-read-state.ts` — session stale/unread edit guard (`FORGE_FILE_READ_GUARD=0` off); `refreshNotedFromDisk` restamps after apply_patch rollback so a retry is not "changed on disk"
- `src/agent/tools/edit-receipt.ts` — numbered AFTER receipt for search_replace/write_file/apply_patch (`FORGE_EDIT_RECEIPT=legacy` off)
- `src/agent/tools/ask-user.ts` — interactive clarifying questions (OpenCode-inspired)
- `src/agent/tools/format-on-write.ts` — format after file tools (`/format`, `FORGE_FORMAT_ON_WRITE`; auto when prettier/biome/ruff/… detected)
- `src/agent/sandbox.ts` + `rules.ts` + `shell-parse.ts` — OS sandbox, deny/allow/ask rules, segment-aware shell checks
- `src/agent/permission-preview.ts` — in-memory colored diff previews for edit-tool permission asks (never writes)
- `src/tui/markdown.ts` — streaming markdown renderer for assistant output (line-buffered; chunk-split invariant; non-TTY passthrough)

## Expert session UX

- `/plan` → session-scoped read-only design (read-only bash allowed); `/commit` is a verdict-first card, `/commit do` creates the local commit (never push); `/commit draft` is the model escape hatch; `/checkpoint` peeks the safety snapshot, `/checkpoint snap` takes it (untracked included), `/checkpoint restore` rewinds (never `git stash apply`); `/build` restores prior mode and implements
- `/model <name> [effort]` live mid-run; `/commands` lists `.forge/commands` templates
- Transcript is minimal by default (one status line per tool; failed tools also show a short error tail); `/verbose` opts into per-edit colored diffs + full tool output (session-local)
- Turn end prints a one-line change summary (files touched from the mutation journal + verification status) for unattended runs
- Startup `posture:` line shows resolved effort/ctx/temp/max_tokens; warnings only for silently-degrading pins (`src/tui/posture.ts`)
- Live `live ›` is phase + elapsed + work; identity/ctx/ULW stay on the bottom dock (`FORGE_BOTTOM_STATUS=0` still prints them on the live prompt). Assistant replies render as styled markdown
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
(path typo hints; directory-target errors), atomic file writes, OAuth refresh (start + mid-run 401/403 + socket `terminated` drop auto-continue under ULW; HTTP/2 `NGHTTP2_INTERNAL_ERROR` reconnects without rotating OAuth and may compact before rebase),
session locks (headless fail-closed; `FORGE_FORCE_SESSION_LOCK=1` override; live+bad timestamp held),
atomic session tmp recovery, session fork/export/import (export `0600`), headless `forge run
--session`, metrics.jsonl, permission ask timeout, empty-SSE retry, `finish_reason=length` continue (+ content_filter/empty cap hygiene),
`releasedOnContinueCap` / `hitMaxTurns` / `hitCostCap` / `finishReason` / `pinned` / `foreignLock` / `harnessUserPokes` / `admitCount` / `proofPokes` / `providerRounds` JSON/metrics + stats `continueCapReleases`/`maxTurnsHits`/`costCapHits`,
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
card, shared `formatExpertTips` (`forge tips`/`/tips`), first-run `/setup` card + grouped `/help`, unknown-slash Did you mean?, CLI `command_typo`/`conflicting_flags`/`invalid_base_url`, `/retry`/`/again`,
`/last [n]`, resume auto-peek, `forge news`/`/news`, `forge run --continue` (fail-closed `continue_miss`/`continue_locked`; empty CLI flags fail closed) / bare `forge --continue` / bare `forge "…" --json`, `forge auth|login|logout --json`, `/done`/`/pause`/
`/unpause`, session `lastUserPreview` list snippets, resume-by-title, relative session ages,
`/files`, `/path` (+ copy), `/pin` + `sessions pin` (fork clears pin; status PIN badge), resume
orientation + `--pinned` list, doctor `sessionsPinned`, session path helpers, sessions show file
snippet, file-aware `/undo` (`mutations.jsonl` pre-images + journaled file mode + isolation=none child fold; turn marks skip
synthetic harness user-messages — `isSyntheticUserMessage`), `/init`, `/review`, `/compact-and`,
`/fork-and-compact`, fork copies ULW/goal sidecars, `/clear`/`/clear hard`/`/new` hygiene, `/logs`
· `forge logs`, `/config` · `forge config`, `/export` mode `0600`, `--read-outside ask|allow|deny`, doctor flags `read-outside=allow` / `sandbox-missing=fallback`, `FORGE_BASH_TIMEOUT_MS` /
`FORGE_BASH_BG_TIMEOUT_MS` (foreground bash own-PGID; abort/timeout kill `-pid` + settle on `exit`; numeric `timeout_ms` cap 30m; second Ctrl+C force-quits), doctor `undoJournal`, `npm run smoke`, ULW wave ledger + quality bar
(facts-only per-wave edits/proof; best-wave anchoring, proof demands, thin-wave escalation, 4th-wave
consolidation, diminishing-returns advisory, one-time evidence bounce on weak attestations),
structural `verificationRan` (execution) + `verificationPassed` (success-only proof-claim/attestation/ULW wave proof) stop signals, project-intel (pm/checks/monorepo; `FORGE_FILE_READ_GUARD` / `FORGE_VERIFY_HINT`), last-verification trail (`lastVerificationCommand`/`At` + `lastEditAt` stale detection on session + resume/status/share/done/export/list ✓; `editsWithoutVerification` in run JSON), adaptive effort (`FORGE_ADAPTIVE_EFFORT`; hard rounds bump
reasoning one notch), request-time prune (`FORGE_REQUEST_PRUNE*`) + optional in-session `FORGE_TOOL_CLEAR`, counter-only
admission suppression, Anthropic prompt caching (`FORGE_ANTHROPIC_CACHE`; cache usage in `ChatUsage`,
cache buckets folded into `prompt_tokens` so totals/spend cap don't undercount),
per-model context windows (`context_window` explicit wins; `src/config/model-info.ts` otherwise — Cursor-hosted Grok 4.5+ auto 256k, not xAI 500k),
prompt-cache-stable system prompt (volatile git branch via context-admit, not message[0]), Stop hook
crash/HTTP fail-closed + stdin-EPIPE safe + 20k payload caps (all bulky fields) + 64KB hook
stdout/stderr caps + hook timeout process-group kill (TERM→KILL, unref'd timers), Retry-After
honored above client backoff
(≤120s), served-model divergence tracking (`servedModelDiverged`: provider-reported served model ≠ requested →
session `servedModels` + metrics + one onStatus warning per model — provider tier routing made visible), 10-min default provider **stall** timeout on stream silence (`FORGE_PROVIDER_TIMEOUT_MS`; optional absolute `FORGE_PROVIDER_MAX_MS`); 12-min **reasoning wall** (`FORGE_PROVIDER_REASONING_WALL_MS`) when a stream has no content/tool_call (thought-only `finish_reason=stop` is Stop, not empty-continue; does **not** count toward `FORGE_ULW_MAX_CONTINUES` / auto-LAST); repeating hidden thought is `reasoning_loop` Stop (not a 12m wait); consecutive thought-only this turn caps at `FORGE_THOUGHT_ONLY_MAX` (default 8, turn-end only, ULW stays CONTINUE), 4MB child-output caps
(bash/rg), streaming read_file for >2MB files, byte-guaranteed tool-output truncation, atomic
session-lock create (`wx`), cache-aware cost estimates (per-model `cacheIn`: DeepSeek cache-hit pricing, xAI $0.50/M cached, Anthropic 0.1×; DeepSeek `prompt_cache_hit_tokens` + xAI `cached_tokens` normalized into `ChatUsage.cache_read_input_tokens` → session `totalCacheReadTokens`; unknown-cache models price cached input at full rate), auto max_tokens (16k non-reasoning · 32k deepseek/64k other reasoning-active; `/max-tokens` pin wins), temperature omitted unless pinned (server-tuned defaults), OpenRouter nested `reasoning.effort` maps `max`→`xhigh` (native top-level keeps `max`).
