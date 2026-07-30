# Changelog

## Unreleased

### Added

- **Doctor `sessionsWithLastError`**: count of sessions with `meta.lastError` (report tip + `doctor --json`) for CI recovery backlog hygiene
- **/sessions errors** · **`forge sessions list --errors`**: filter recovery backlog (lastError only; aliases failed|err)
- **`/goal` auto-titles untitled sessions**: arming a goal (slash, `--goal`, auto-detect) derives a scannable title via `maybeSetTitle` without overwriting an existing title

## 0.9.7 — Session lastError recovery surface

Expert recovery after provider failures: stamp, surface, and clear `meta.lastError` across status/resume/share/list/HUD/JSON.

### Added

- **Session `lastError`**: provider/run failures stamp `meta.lastError` with code/message/tips; `/status`, resume orientation, `/share`, `sessions show`/`list` (ERR badge), and `forge status` HUD/tmux/compact + `--json` surface recovery (`lastError` + `ERR:<code>` badge); `forge run --json` fail payloads include `lastError`; cleared on the next successful turn, `/clear`, and `/fork`. `/config` tips plan → `/build`

### Changed

- **First-run tip** mentions `/plan` · `/build` · live `/model` · `/commands` (v0.9.6 expert surface)

## 0.9.6 — Expert production UX (/plan·/build, project commands, recovery tips)

Learned from OpenCode (plan/build, custom commands, instruction walk-up) and production expert workflows. Session-scoped design mode, headless CI slash probes, multi-source project rules, provider recovery tips, smarter titles, and doctor hygiene counts.


### Added

- **`/plan` · `/build` · `/execute`** (OpenCode-style): session-scoped PLAN mode without sticky-prefs footgun. `/plan [focus]` hard-denies mutations (writes/bash/apply_patch); `/build` restores the prior mode and notifies the agent mid-run. Live controls; resume restores session plan unless `--permission-mode` is explicit. System prompt PLAN block lists goal/steps/risks/verification; deny reasons point at `/build`. `/permissions plan|build` aliases; sessions list/share/status show PLAN badge
- **Smarter auto session titles**: `deriveSessionTitle` prefers `User mandate:` / Goal lines, strips ULW harness boilerplate, drops pure slash controls, trims polite filler, capitalizes, and word-boundary truncates — session lists stay scannable without `--title`
- **Richer project instructions** (OpenCode-style): walk-up discovery for `AGENTS.md` / `FORGE.md` / `CLAUDE.md` / `.forge/rules.md` / `.github/copilot-instructions.md` / `.cursorrules` / `.cursor/rules/*.{md,mdc}` + optional `~/.forge/AGENTS.md`; nested AGENTS shadows parent; total budget 28k; `/context` lists loaded sources
- **Project custom slash commands** (OpenCode-style): `.forge/commands/<name>.md` + `~/.forge/commands/` with optional `description:` frontmatter and `$ARGUMENTS` / `$1..$9` placeholders; `/name args` expands and starts a turn; `/commands` lists them; Tab + unknown-slash Did-you-mean include customs; reserved built-ins cannot be shadowed
- **Provider error recovery tips**: `formatProviderError` maps HTTP/auth/rate-limit/quota/overflow/network failures to expert next steps; REPL + headless human path print tips; `forge run --json` fail payload includes `recovery: { code, tips }` and structured `reason`
- **Headless slash prompts**: `forge run "/plan"` · `"/commands"` · custom `.forge/commands` work without a model call when pure control; templates with `$ARGUMENTS` expand then run the agent. JSON success uses `reason: "slash"`. Pure-control slashes run **before auth** so CI can probe without credentials. Ephemeral only for **readonly** probes (`/help`, `/commands`, …) — mutating `/plan`/`/build` still persist the session
- **Richer `/init`**: guided AGENTS.md prompt covers multi-source instruction loading, `.forge/commands` templates, safety/blast-radius notes, and `/plan`·`/build` tips
- **Doctor JSON `projectRulesCount` / `projectCommandsCount`**: CI can assert instruction + custom-command hygiene without parsing report text
- **`suggestNames` multi-tip**: unknown tools return up to 3 Did-you-mean candidates (agent self-recovery)
- **Smarter empty-response nudge**: empty model turns mention plan mode / open todos and finish_reason; continue-cap release points at `/retry` · `/compact` · `/model`
- **`/news` includes Unreleased**: in-flight CHANGELOG notes surface before the next tag so experts see `/plan`, headless slash, recovery tips without waiting for a release
- **`productionWarnings` for plan mode**: `forge run --json` flags `permissionMode=plan` so CI does not silently stay read-only
- **`/news` pairs Unreleased + latest tag**: default count still shows the last shipped release under in-flight notes
- **Sample project commands**: `examples/forge-commands/{review,shipcheck}.md` — copy into `.forge/commands/`
- **ULW `max_waves`**: optional wave cap (default unlimited). `/max-waves N|off|status` live mid-run; CLI `--max-waves N` (0 = unlimited; N&gt;0 implies ULW). When the wave counter hits N, harness auto-flips to LAST (`**Cycle complete.**`). Counts show as `wave=2/5`; JSON `ulwMaxWaves`; compact/admission/status/HUD aware
- **Multi-account auth**: store many logins per provider (e.g. two SuperGrok emails + API keys) in `~/.forge/auth.json` v2
- **`forge accounts`**: `list` · `status` · `switch` · `remove` · `rename` · `priority` · `disable`/`enable` · `clear-cooldown` · `auto-switch on|off [--threshold N]`
- **`forge login --add`**: add another account without replacing existing ones; `--label` for API-key display names
- **Smart auto-switch**: on 429/quota (and proactive when plan usage ≥ threshold or active in cooldown/expired) Forge switches to another same-provider account (cooldown on exhausted); `FORGE_ACCOUNT_SWITCH_MAX` caps mid-run switches; post-switch OAuth refresh; auth-failure uses shorter cooldown (`switchOnAuthFailure`)
- **Unattended readiness**: `forge accounts status` / `/accounts status`; doctor reports multi-account eligible/cooldown; stale plan probes (>6h) ignored for proactive switch
- **REPL**: `/accounts` list/status/switch/clear-cooldown/auto-switch; `/accounts switch` hot-swaps live provider token; `/auth` shows multi-account table; statusline shows account label + `×N` when multi
- **`forge auth --json`**: includes `accounts[]`, `autoSwitch`, `switchThresholdPercent`, `active.accountId` (never tokens); `forge doctor --json` includes `multiAccount`
- **GitHub Copilot provider**: `forge login --from-copilot` / `forge login -p copilot` reuses a local Copilot CLI keychain or VS Code `~/.config/github-copilot` session; falls back to GitHub device-code OAuth; auto re-exchanges short-lived Copilot session tokens; OpenAI-compat chat via `https://api.githubcopilot.com`
- **Provider aliases**: `github` / `github-copilot` / `gh-copilot` → `copilot`
- **Env**: `COPILOT_GITHUB_TOKEN` / `GITHUB_COPILOT_TOKEN` / `GH_COPILOT_TOKEN` for CI-style GitHub OAuth tokens (exchanged on resolve)

### Changed

- **`/model` is live mid-run**: switch model (and optional effort) while a turn is running; bare `/model` stays readonly catalog. Live notice + session meta update; next provider call picks up the new model. Doctor tips when no project instruction files are present (`/init`)
- **`/status` plan tip**: `perms plan (read-only · /build to implement)`; expert tips list `/plan` · `/build` · `/model` as live mid-run controls

### Fixed

- **`/build` clears session plan override**: leaving plan restores prior live mode and drops `meta.permissionMode` so resume falls back to sticky prefs/CLI (plan is temporary, not sticky-by-accident). Sticky `/permissions <mode>` no longer writes non-plan session overrides
- **Custom-command reserved-name drift guard**: test asserts every built-in `SLASH_COMMANDS` entry is reserved so project templates cannot shadow `/plan`, `/build`, etc.

## 0.9.5 — File-aware undo, /init, /review, /compact-and + SuperGrok OIDC

### Added

Production recovery, review, and onboarding learned from OpenCode (snapshot/revert, guided AGENTS.md, `/review`) and Warp (`/compact-and`). Native SuperGrok OIDC login for subscription auth without Grok Build import.

### Loop hygiene
- **Structured CLI errors**: `failInvalidFlag` / usage / session-miss / Commander `--json` errors include `version`
- **`emitFailJson` / `emitOkJson`**: all common `--json` success/failure payloads include `version` for CI matrices (sessions, auth, tips, completion, init, stats, status, export/import, typos, locks)
- **Bare command aliases**: `forge cfg|log|session|whoami|hud|whatsnew|tip|…` recover with `command_typo` + suggestion before auth (expert muscle-memory)
- **Sessions action suggestions**: include `rename`/`clone`/`dir`/`location` aliases so `renam`/`clonee` get Did you mean?
- **Provider aliases**: `-p oai|haiku|bard|router` map to openai/anthropic/google/openrouter (with existing claude/gpt/gemini)
- **Permission alias**: `--permission-mode ask` maps to `dontAsk` (with deny/dont-ask)
- **Effort aliases**: `--effort hi|lo` map to high/low (with existing h/l/med/max)
- **Shell completion**: provider/permission/effort/sandbox completions include expert aliases (`oai`, `yolo`, `hi`/`lo`, `readonly`/`ro`, …)
- **`forge news all|full|max`**: alias for count 10 (cap); `latest` → 1
- **`stats --days` / `logs -n` aliases**: week|month|today|7d|all · logs all|max|full → entire window
- **Slash parity**: `/stats week|month|today|all` and `/news all|full|max|latest` match CLI aliases
- **`/logs max|full`**: parity with `forge logs -n all|max|full`
- **`parseDaysWindow`**: shared CLI `/stats` day-window parser (anti-drift)
- **`parseNewsCount`**: shared CLI `/news` count parser (anti-drift)
- **`parseLogsLines`**: shared CLI `/logs` line-count parser (anti-drift)
- **Shared mode normalizers**: `normalizeProviderId` / permission / sandbox aliases apply to CLI flags **and** `FORGE_*` env vars
- **`login`/`logout -p` aliases**: same provider normalizer (`claude`→anthropic, suggestions on typos)
- **`/permissions ask`**: alias for `dontAsk` (parity with CLI `--permission-mode ask`)
- **Preferences aliases**: `preferences.json` `permissionMode` accepts yolo/ask/accept (normalized on load/save)
- **Nested-command footguns**: `forge auth logout` / `doctor login` / `config auth` excess-args hints; `forge sessions login` fails closed (not silent search)
- **Doctor yolo**: `permissionMode=bypassPermissions` is a blocking issue (CI should not ship YOLO)
- **Doctor sandbox off**: `sandbox=off` is a blocking issue on production hosts
- **`sessions list --limit all|max|unlimited`**: alias for unlimited (0)
- **Completion**: `sessions --limit` values include `0|all|max|unlimited`
- **Bash IMDS deny**: hard-deny `curl`/`wget` to `169.254.169.254` / GCE metadata host (cloud SSRF footgun)
- **Bash `file://` deny**: hard-deny `curl`/`wget` local file fetches (use `read_file`)
- **Sticky login provider** (not silent cross-provider auth): `forge login -p claude` saves provider preference; explicit `-p xai` will not use anthropic keys
- **Doctor/run provider align**: when stored auth is a different provider than config default, doctor report/JSON and `forge run` follow active credentials
- **Sticky login provider**: `forge login -p …` saves `provider` to preferences.json; switches default model to that provider’s catalog default when no model pref is set
- **`forge login` without `-p`**: uses sticky provider preference (not always xai)
- **`sessions prune --max-age-days all|none|off`**: alias for 0 (no age filter)
- **`prune-tool-output --max-age-days all|none`**: same no-age-filter aliases
- **Completion**: `--max-age-days` values include `0|all|none|off|7|14|30|90`
- **`--keep all|max|unlimited`**: prune commands keep everything (sessions/metrics/tool-output)
- **`sessions prune --json`**: includes resolved `keep` + `maxAgeDays` for CI audit
- **Logout clears sticky provider**: full logout or logout of the sticky provider drops preferences.provider
- **Resume auth follows session provider**: `forge run --continue/--session` resolves credentials for the session’s provider (sticky login cannot silently switch a resumed chat)
- **Statusline PIN badge**: pinned sessions show `PIN` in HUD tags and tmux status-right (parity with session list)
- **`FORGE_JSON_COMPACT=1`**: single-line `--json` success payloads for CI log aggregation
- **`forge run --json`**: includes `pinned` + `foreignLock` for CI/ops session audit
- **`forge run --json` error path**: includes `reasoningEffort`, `sandboxNetwork`, `goalActive`, `maxTurns` (parity with success)
- **`forge run --json`**: includes `stickyProvider` from preferences (null when unset) for CI audit
- **`forge run --json`**: includes `sandboxMissingBackend`; doctor flags `sandbox-missing=fallback` as production risk
- **`forge run --read-outside ask|allow|deny`**: CI-controllable outside-workspace reads; run JSON includes `readOutsideWorkspace`
- **`forge doctor`**: flags `read-outside=allow` as production risk (prefer ask|deny)
- **`forge logs -n ''` / `forge news ''`**: fail-closed `invalid_lines` / `invalid_count` (omit still defaults)
- **`forge prune-tool-output --max-age-days ''`**: fail-closed `invalid_max_age_days` (omit still defaults to 14)
- **`forge run --json`**: includes truncated `goal` text + `denyRules`/`allowRules`/`askRules` counts for CI audit
- **`forge doctor --json`**: includes `sandboxNetwork`, `sandboxMissingBackend`, `readOutsideWorkspace`, `stickyProvider`, rule counts
- **`sessions export --format` typos**: `jsn` → Did you mean: json (JSON `suggestion`)
- **Typo suggestions**: `completion bas`→bash, `logs -n al`→all, `news al`→all, `stats --days wek`→week
- **`--json` payloads**: include `node` (process.version) via `emitOkJson`/`emitFailJson` for CI support bundles
- **`forge config --json` / `/config`**: includes `stickyProvider` from preferences
- **`forge run --session` + `--continue`**: fail-closed `conflicting_flags` (pick one resume mode)
- **`get_task_output` stream typos**: `stdot`/`err`/`all` → Did you mean stdout|stderr|both
- **`web_fetch` format typos**: `txt`/`md`/`htm` → Did you mean text|markdown|html
- **`forge run --help` CI tips**: include `--sandbox-missing fail-closed` and `--read-outside deny`
- **`forge status --interval ''`**: fail-closed `invalid_interval` (omit still defaults to 1000ms)
- **`todo_write` status typos**: `doing`/`done`/`canceled` → Did you mean in_progress|completed|cancelled
- **`forge tips --json`**: structured `lines` + `sections` (plus full `tips` string)
- **`forge run --json`**: includes `authMethod` (api_key|oauth|…) for support bundles
- **`list_dir` file path**: clearer recovery tip (use read_file/grep)
- **Shell completion**: bare `forge` top-flags include `--read-outside`/`--sandbox-missing`/`--effort` (parity with `run`)
- **`forge run --json`**: includes `maxTurnsUnlimited` (parity with doctor/config)
- **`forge run --json`**: includes `productionWarnings[]` for sandbox=off / yolo / read-outside=allow / sandbox-missing=fallback / blockingStop off
- **`forge run --json`**: includes `blockingStop`; `forge run --no-blocking-stop` available (warns via productionWarnings)
- **`mergeRunOpts`**: carries `blockingStop`/`readOutside` so `forge run --no-blocking-stop` / `--read-outside` are not clobbered by subcommand defaults
- **`web_fetch` non-http schemes**: `ftp`/`file`/`ws` errors include Did you mean https://…?
- **`--base-url` non-http schemes**: `ftp`/`ws` errors include Did you mean https://…?
- **`forge run --json`**: includes `ulwCycle`/`ulwWave` when ultrawork is armed (null otherwise)
- **`forge sessions show --json`**: includes `ulw` {cycle,wave,blocks} and truncated `goal` when present
- **`forge sessions list --json`**: includes `ulwCycle`/`ulwWave`/`goalActive` per session
- **`forge status --json` / HUD**: session snapshots include `ulwCycle`/`ulwWave`; plain tags show `ULW c=N`
- **Statusline**: colored compact strip ULW badge shows cycle; remove duplicate plain GOAL tag
- **`forge run --json`**: includes truncated `ulwMandate` when ultrawork is armed
- **`forge run --json`**: includes `ulwSoftPrompt`; sessions show `ulw` includes softPrompt + mandate
- **`apply_patch`**: `*** Move File:` mistakes hint correct `Update File` + `Move to` grammar
- **`apply_patch`**: empty Add/Delete File paths include recovery example
- **`forge run --json`**: includes `openTodos` and `messageCount` for CI session health
- **`grep` head_limit**: accepts `all|max|full|unlimited` as unlimited (parity with logs -n)
- **`web_search` num_results**: accepts `all|max|full` as 10 (cap)
- **`get_task_output` tail**: accepts `all|max|full` as full output; typos get Did you mean
- **`bash` timeout_ms**: accepts `default|max|all` (max/all → 30m ceiling); typos get Did you mean; duration suffixes `30s`/`1m`/`2h`/`500ms`
- **`web_fetch` timeout_ms**: duration suffixes via shared `parseDurationMs` (parity with bash)
- **`FORGE_BASH_TIMEOUT_MS` / `FORGE_BASH_BG_TIMEOUT_MS`**: accept duration suffixes (`90s`, `2m`)
- **`FORGE_MAX_RUN_MS` / `FORGE_PROVIDER_TIMEOUT_MS`**: accept duration suffixes (`10m`, `5m`)
- **`FORGE_PERMISSION_TIMEOUT_MS`**: accept duration suffixes (`30s`, `2m`)
- **Tool schemas + system prompt**: document timeout/head_limit/tail/num_results aliases for the model
- **`sessions export --json` without `--out`**: structured envelope `{ id, format, body }` (no raw markdown on stdout)
- **`sessions fork --json`**: includes copied `ulw`/`goal` sidecars
- **`sessions import`**: accepts `export --json` envelope files (unwraps `body`)
- **`forge doctor`**: what-if flags `--sandbox`/`--read-outside`/`--permission-mode`/`--no-blocking-stop`/`--sandbox-missing`
- **`forge config`**: same what-if safety flags as doctor for effective snapshot previews
- **`apply_patch`**: empty/context-only `@@` update hunks without `Move to` rejected as no-ops
- **`forge run --json`**: includes `goalStuckThreshold` from config
- **`forge run --json` / sessions show|fork**: include `goalBlocks`/`goalStuckBlocks` when a goal is armed
- **`forge run --json`**: includes truncated `goalCriteria[]` when a goal is armed
- **`sessions show|fork --json`**: goal object includes `criteria[]`
- **`forge run --json`**: includes `maxRunMs` from `FORGE_MAX_RUN_MS` (null when unset)
- **`forge run --json`**: includes `providerTimeoutMs`/`bashTimeoutMs`/`bashBackgroundTimeoutMs` (parity with doctor)
- **`forge run --json`**: includes `permissionAskTimeoutMs`/`doomLoopThreshold`/`errorStreakThreshold` (parity with doctor)
- **`forge run --json`**: includes `ulwMaxContinues` (parity with doctor)
- **`forge run --json`**: includes compact `git` snapshot (branch/dirty/changedFiles/ahead/behind)
- **`forge run --json`**: includes `projectLabel` + `projectHints` (node/rust/python/…)
- **`forge run --json`**: includes `packageName` from nearest package.json (monorepo CI) + `packageVersion`
- **`forge run --json`**: includes `packageEnginesNode`; doctor flags runtime below engines.node floor
- **`forge doctor --json`**: includes `packageEnginesNode` from workspace package.json
- **`sessions show --json`**: includes `git`, `projectHints`, `packageName`/`packageVersion`/`packageEnginesNode`
- **`/share` card**: includes git branch/dirty and project/package identity for handoff
- **`/share` card**: ULW cycle/wave flags + active goal one-liner for handoff
- **`forge run --json`**: includes `sessionPath` (absolute session dir) for ops/support bundles
- **`sessions list --json`**: includes `path` (absolute session dir) per row
- **`forge status --json`**: session snapshots include `sessionPath`
- **`session_not_found --json`**: includes structured `suggestions[]` (id/title/path/relativeAge)
- **Session lookup anti-drift**: shared `collectSessionLookupHits` powers human miss text + JSON `suggestions[]` (title edit-distance + id-prefix recovery)
- **`apply_patch` empty Move to path**: recovery example (Update File + Move to)
- **`forge tips` CI line**: documents `suggestions[]` + `sessionPath`/`forgeHome` support-bundle fields
- **`unauthenticated --json`**: includes `forgeHome` for support bundles
- **`sessions title --json`**: includes `forgeHome`
- **Tool schemas**: document empty-arg fail-closed + recovery examples (bash/read/write/edit/grep/glob/web_*)
- **`emitOkJson`/`emitFailJson`**: always stamp `forgeHome` (support-bundle parity on every JSON path)
- **`list_dir` empty path**: correct recovery example (was wrongly showing glob pattern)
- **`stringifyJsonResult`**: stamps `version`/`node`/`forgeHome` defaults (doctor/run JSON anti-drift)
- **System prompt**: never call tools with empty required args — errors include recovery examples
- **`/goal` verb typos**: `stauts`/`resum`/`cler` → Did you mean status|resume|clear (not silent arm)
- **`/cycle` unknown args**: Did you mean 0|1|status|off|on|last?
- **`todo_write` empty id/content**: recovery example item JSON
- **`sessions show` summary**: includes path + git branch/dirty + project/package identity
- **`sessions show` summary**: ULW cycle/wave + active goal one-liner (parity with `/share`)
- **`sessions list` human**: ULW c=N + GOAL badges (parity with statusline/JSON)
- **`forge run --json` `ok`**: false on empty/no-turn runs (aligned with exit 1; was ok:true + exit 1 CI footgun)
- **`forge run --json`**: sets `reason=empty_run|timeout|aborted` when `ok:false` on completed payload path
- **`isEmptyRunResult`**: shared empty/no-turn check keeps exit 1 + `ok:false` + `reason=empty_run` in lockstep (defensive turns coerce)
- **`forge run --json`**: `ok:false` completed payloads include `error` for empty_run|timeout|aborted (CI parsers)
- **`isEmptyRunResult`**: whitespace-only `finalText` counts as empty
- **Docs**: `FORGE_MAX_TURNS`/`--max-turns` clarified as soft cap (`hitMaxTurns`), not exit 124
- **`grep` empty path / `apply_patch` empty patchText**: recovery examples with tool prefixes
- **`sessions fork` human**: ULW c=N + GOAL badges when sidecars copied
- **`/status`/`/hud` details**: include on-disk session path
- **`/tasks`**: `kill|stop <id>` + `log|peek <id> [tail]` subcommands (live: kill=control, log=readonly)
- **`/tasks` unknown id**: uses same Did-you-mean task list as agent `kill_task`/`get_task_output`
- **`/tasks log` tail**: accepts `all|max|full` (full output) + Did you mean
- **Tool `Aborted` results**: annotated as `Aborted: <tool> (turn cancel / timeout / Ctrl+C)` (keeps cancel classifiers)
- **`web_fetch` no response**: recovery tip (network/abort/redirect)
- **JSON arg repair**: successful auto-repairs prefix tool output with `[json_arg_repair]` note for the model
- **System prompt**: note `[json_arg_repair]` prefix so the model emits valid JSON next time
- **`sessions show|list --json`**: `sessionPath` alias of `path` (parity with `forge run --json`)
- **`sessions path --json`**: includes `path`/`sessionPath` aliases of `dir`
- **`sessions import|export --json`**: include `sessionPath` (and import `path`) for ops handoff
- **`sessions fork|title|pin --json`**: include `path`/`sessionPath`
- **`sessions delete --json`**: include `sessionPath` for audit (even after delete)
- **`/undo`/`/rewind`**: `last|all|max|full` aliases + Did you mean on bad counts
- **`/last`**: `last|all|max|full` aliases + Did you mean on bad counts
- **Provider empty choices**: clearer retry/switch-model error
- **Provider empty stream**: retry/switch-model hint on dropped connections (OpenAI-compat + Anthropic)
- **Protected-path writes**: clearer recovery (forge CLI / git / ssh-keygen; agent-writable ~/.forge dirs)
- **Outside-workspace writes**: clearer recovery (project root / agent-writable ~/.forge dirs)
- **Outside-workspace reads**: permission deny/ask reasons include --read-outside recovery tip
- **Sandbox fail-closed**: recovery tip (install backend or explicit fallback)
- **SSRF blocks**: clearer recovery (public URL vs allow_local loopback-only)
- **DNS / web_search failures**: recovery tips (hostname/network / simpler query / web_fetch)
- **`locked --json`**: structured `hint` for concurrent-session recovery (parity with continue_miss)
- **`unauthenticated`/`empty_prompt --json`**: structured `hint` recovery commands
- **`unknown_option --json`**: structured `suggestion`/`hint` for flag typos (`--josn`→`--json`)
- **`apply_patch` verification failures**: grammar recovery hint when missing
- **`forge tips` live line**: includes `/tasks kill|log`
- **`forge tips` CI line**: documents empty run → `ok:false reason=empty_run`
- **`glob`/`list_dir` type errors**: prefixed tool name for clearer attribution
- **`/files` unknown args**: Did you mean writes|mutations|all?
- **`suggestName` tie-break**: prefer lower edit distance so `writs`→`writes` (not `edits`)
- **`/bell` unknown args**: Did you mean on|off|test|status?
- **`/logs`/`/stats`/`/news` invalid args**: Did you mean recovery (parity with CLI typos)
- **`/review` target typos**: `uncommited`/`stageed` → Did you mean uncommitted|staged
- **`grep`/`write_file`/`search_replace` type errors**: prefixed tool name for clearer attribution
- **`read_file`/`get_task_output`/`kill_task` type errors**: prefixed tool name
- **`/pin` unknown args**: Did you mean on|off|status|toggle? (not silent pin)
- **`glob` empty path**: prefixed `glob error:` for clearer tool attribution
- **`continue_miss`/`continue_locked --json`**: includes recent same-cwd `suggestions[]` for `--session` recovery
- **Library**: export `listSessionLookupSuggestions`
- **`forge doctor --json`**: includes `forgeHome` + `node` for support bundles
- **`forge config --json` / `/config`**: includes `forgeHome`
- **`forge status --json`**: includes `forgeHome` + `node`
- **`forge stats --json`**: includes `forgeHome`
- **`forge auth --json` / `tips --json`**: include `forgeHome`
- **JSON support-bundle parity**: `sessions list`, `completion`, `news`, `logs`, `models` include `forgeHome`
- **`forge run --json`**: includes `forgeHome` (parity with doctor/status/config)
- **`grep` invalid regex**: includes engine detail + escape hint (not bare pattern dump)
- **`sessions show` / `login` / `logout --json`**: include `forgeHome`
- **`sessions fork|export --json`**: include `forgeHome`
- **`sessions import|path --json`**: include `forgeHome`
- **`web_search`/`web_fetch` empty args**: error includes recovery example JSON
- **`bash` empty command**: error includes recovery examples (timeout + background)
- **`read_file`/`write_file`/`search_replace`/`glob` empty path**: recovery examples
- **`grep`/`glob` empty pattern**: recovery examples
- **`sessions prune` / `prune-tool-output` / `prune-metrics --json`**: include `forgeHome`
- **`sessions pin|unpin|delete --json`**: include `forgeHome`
- **`/share` card**: export line includes `--json` envelope tip
- **`sessions import`**: markdown export files get a clear re-export-with-json hint
- **`sessions import`**: rejects markdown `export --json` envelopes with a clear re-export hint
- **`search_replace`**: whitespace-only `old_string` fails closed (no blank-line matches)
- **`forge doctor`/`config`**: `--sandbox-network` what-if flag
- **`forge run --json`**: includes `ulwBlocks` when ultrawork is armed
- **`forge run --json`**: includes truncated `ulwExpandedMandate` when soft-prompt ULW is armed
- **`apply_patch`**: clearer missing Begin/End Patch marker diagnostics
- **`forge run --json` unauthenticated**: includes `authMethod: null` for field parity
- **`apply_patch` empty patch**: clearer recovery hint (Add/Update/Delete/Move File hunks required)
- **`sessions list --json`**: includes `relativeAge` per row (parity with human list ages)
- **`forge run --json`**: includes `baseUrl` when overridden (custom/provider base)
- **`--max-turns` / `FORGE_MAX_TURNS`**: cap agent turns from CLI/env (0 = unlimited); empty/invalid fail closed (`invalid_max_turns`)
- **`forge config --json` / `/config`**: includes `version`; hook `timeout` floored to ≥1s (avoids instant Stop fail-closed)
- **`forge run --json` success**: includes `version`, `reasoningEffort`, `cwd`, `permissionMode`, `sandbox`, `sandboxNetwork`, `ultrawork`, `goalActive`, `maxTurns` for CI audit
- **Unauthenticated `--json`**: error text points at `forge login --api-key $KEY --json` for CI
- **`forge run --json` success**: includes `provider` + `model` for CI audit trails
- **Blocking Stop timeout**: Stop/SubagentStop hooks that time out or error **fail closed** (keep agent working) when `blockingStopHooks` is on — was fail-open like Grok
- **Doctor model catalog**: warns when `model` is not in the active provider's known list (free-form still allowed)
- **Provider switch model default**: `-p anthropic` / `FORGE_PROVIDER` without `-m` uses that provider's `defaultModel` (no longer sticks on `grok-4.5`)
- **`--sandbox-network` aliases**: `none`/`off`/`block`→`blocked`, `open`/`full`→`unrestricted`
- **`--sandbox` aliases**: `readonly`/`ro`→`read-only`, `ws`→`workspace`, `none`→`off`, `full`→`strict`
- **`--provider` aliases**: `claude`→`anthropic`, `gpt`→`openai`, `gemini`→`google` (plus existing `grok`→`xai`)
- **`--sandbox-missing` aliases**: `fail_closed`/`failclosed`→`fail-closed`
- **Shell completion**: enum values for `--permission-mode`/`--effort`/`--sandbox`/`--sandbox-network`/`--sandbox-missing`
- **`--permission-mode` aliases**: `deny`/`dont-ask`→`dontAsk`, `yolo`/`always`→`bypassPermissions`, `accept`→`acceptEdits`
- **`/permissions dontAsk`**: mode listed in tab-complete and mode menu (CI-safe deny-without-allow; was missing from interactive choices)
- **CLI `--json` parse errors**: unknown options/args emit `{ ok:false, reason:unknown_option|… }` on stdout (no stderr scrape)
- **Shell env injection scrub**: always drop `LD_PRELOAD`/`NODE_OPTIONS`/`DYLD_*`/`PYTHONSTARTUP`/`BASH_ENV`/`GIT_SSH_COMMAND`/`GIT_CONFIG_*`/… from inherited env (policy `set` can still opt in); also scrub `SSLKEYLOGFILE`
- **Numeric tool-arg errors**: object `timeout_ms`/`offset`/`head_limit`/`num_results` report `must be a number (got object)` instead of `invalid … "[object Object]"`
- **`get_task_output` stream type**: non-string `stream` fails closed (clearer than invalid stream "[object Object]")
- **`web_fetch` format type**: non-string `format` fails closed (clearer than invalid format "[object Object]")
- **Background task ids**: non-string `task_id` on get/kill fails closed (no `[object Object]` lookup)
- **`todo_write` field types**: non-string `id`/`content`/`status` fail closed (no `[object Object]` todos)
- **Tool path/pattern types**: non-string `path`/`pattern` on read/write/edit/list/grep/glob fail closed
- **Tool string args**: non-string `bash.command` / `web_search.query` / `web_fetch.url` / `apply_patch.patchText` fail closed (no `[object Object]` shell/search)
- **`search_replace` string args**: non-string `old_string`/`new_string` fail closed (no `[object Object]` edits)
- **`write_file` content type**: missing/non-string `content` fails closed (objects no longer become `[object Object]` on disk)
- **`get_task_output` arg order**: invalid `tail`/`stream` reported even when `task_id` is omitted (was masked by task_id required)
- **Slash count bounds**: `/undo` 1–100, `/files` 1–200, `/last` turns 1–20 and max-chars 40–2000 fail closed (no silent clamp)
- **`forge status --watch --json`**: single-shot snapshot (no infinite NDJSON hang in CI); human `--watch` still loops
- **`forge logs -n` / `/logs`**: values above 200 fail closed (`invalid_lines`) instead of silent clamp
- **`forge news` count**: values above 10 fail closed (`invalid_count`) instead of silent clamp
- **Whitespace-only grep patterns**: `"   "` fails closed as `pattern is required` (was a useless full-tree search)
- **Session title length**: storage cap raised to 200 (was silent 72 truncate); `/title` and `sessions title` fail closed above 200 (parity with `--title`)
- **Shell env scrub connection strings**: bash child env drops `DATABASE_URL` / `*_URI` / `CONNECTION_STRING` / `MYSQL_PWD` / `PGPASSFILE` (and peers) — previously only `*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*`/`*CREDENTIAL*` matched, so postgres/redis URLs with embedded passwords leaked into sandboxed shells
- **`forge models -p|--provider`**: filter model list to one provider (parent `forge -p xai models` works). Empty/invalid provider fail closed with `invalid_provider` (JSON)
- **SSRF weird IPv4 literals**: `web_fetch` blocks decimal/hex/octal/short forms (`2130706433`, `0x7f000001`, `127.1`, `0177.0.0.1`) that expand to loopback/RFC1918 — classic inet_aton bypasses
- **Library exports**: `PermissionGate`, hard-safety helpers (`checkBashHardDeny` / `hardSafetyCheck`), `isReadOnlyCommand`, SSRF guards (`assertUrlSafe` / `normalizeIpHost` / `expandWeirdIpv4Literal` / …), and `createShellEnv` / `ShellEnvPolicy` available from `forge-agent` for embedders/tests
- **`web_fetch allow_local` permission gate**: headless/dontAsk/plan no longer auto-allow loopback fetches as a free read-only tool — requires allow rule, interactive approval, pattern always, or YOLO (public URLs still auto-allow)
- **`web_fetch allow_local` + session-tool**: approving `[s]ession` on a public `web_fetch` no longer free-passes later `allow_local` loopback fetches (session-tool alone is not enough)
- **Doom-loop fingerprint**: also ignores `run_in_background` (alias of `background`) so transport-only retries still trip
- **SSRF IPv4-mapped hex**: `web_fetch` blocks `::ffff:7f00:1` / `::ffff:a0a:a0a` (and expanded forms) — previously only dotted-quad `::ffff:127.0.0.1` was peeled, so hex-mapped loopback/RFC1918 could bypass
- **SSRF bracketed IPv6 hostnames**: Node keeps brackets on `URL.hostname` for IPv6 (`[::ffff:7f00:1]`). `assertUrlSafe` / `isNonPublicIp` peel brackets via `normalizeIpHost` before `net.isIP` so mapped private literals are blocked (and explicit loopback + `allow_local` works)
- **acceptEdits read-only shell**: `find`/`git branch`/`git remote` no longer auto-allow mutations via bare prefix match — `find -delete|-exec|-ok|-fprint*`, `git branch -d|-D|-m|-c|-f|create`, and `git remote add|remove|set-url|prune` require approval (or allow rule / YOLO). Listing forms (`find -name`, `git branch -a|--contains`, `git remote -v`) still pass.
- **acceptEdits version probes**: `node --version` / `npm -v` / `python -V` / `git --version` (and peers) auto-allow again — flag-stripping had dropped `--version` so the RO prefix never matched
- **acceptEdits git `--output`**: `git log|show|diff|branch --output=path` is not read-only (file write) even though the subcommand prefix is
- **`--goal` / `/goal` length**: objectives longer than 4000 chars fail closed (`invalid_goal` / clear slash error)
- **Missing `--cwd`**: non-existent / non-directory paths fail closed (`invalid_cwd`); `--title` capped at 200 chars
- **First-run tip**: mentions doctor --json + unknown-slash Did you mean?
- **Doctor permission rules**: invalid `Bash()` entries flagged; non-array deny/allow/ask not character-iterated
- **Empty permission rules**: `--deny 'Bash()'` fails closed (`invalid_deny`); use `Bash` or `Bash(*)`
- **Tool name aliases + tips**: `Shell`/`read`/`write`/`edit`/`StrReplace` map to canonical tools; unknown names get Did you mean?
- **`todo_write` without session**: clearer `todo_write error: not available in this context` (was bare "not available")
- **`forge sessions search <q>`**: first-class query (parity with `/sessions search` and `-q`); empty query is usage error
- **System prompt**: documents tool-arg fail-closed so models fix invalid timeout_ms/offset/head_limit/format instead of retrying
- **Tool arg fail-closed**: invalid `bash`/`web_fetch` `timeout_ms`, `web_fetch` `format`, `get_task_output` `tail`/`stream` error clearly (were silent defaults)
- **`grep` `head_limit` / `web_search` `num_results`**: explicit invalid values fail closed (were silent defaults)
- **`--base-url` empty host**: `https://` fails closed (hostname required)
- **`--base-url` validation**: non-http(s) / unparseable URLs fail closed (`invalid_base_url`) before API retries
- **`read_file` offset/limit**: explicit non-numeric/negative values fail closed (were silent defaults)
- **Conflicting session flags**: `--continue --new` / `--session --new` fail closed (`conflicting_flags`) instead of silently preferring `--new`
- **`forge --version --json`**: structured `{ ok, version, name, node }` for CI
- **Doctor large undo-journal**: warns when mutations journals exceed ~20 MiB or 2k entries (prune tip)
- **Enum/flag typos**: `--sandbox workspac` → `workspace`; `--permission-mode aceptEdits` → `acceptEdits`; `--effort medum` → `medium`; `--sandbox-network blokced` → `blocked`; `/model grok-45` + `/effort medum` suggest instead of saving; `/permissions aceptEdits` suggests
- **Provider/model typos**: `--provider xaai` → `xai`; `--model grok-45` → `grok-4.5` (free-form unknown ids still pass preflight)
- **Session title typos**: `/resume alpa-project` → Did you mean `alpha-project` (edit-distance on recent titles)
- **Sessions action typos**: `forge sessions prun` / `/sessions serach x` → `unknown_session_action` + suggestion (was empty title search)
- **Bare CLI subcommand typos**: `forge sesions --json` → `command_typo` + suggestion `sessions` (was treated as a free-form prompt)
- **Whitespace-only paths**: `read_file`/`write_file`/`search_replace`/`list_dir`/`grep`/`glob` reject `"   "` as `path is required` (was opaque not-found / Directory not found)
- **`bash` whitespace-only command**: fails with `command is required` (was silent success no-op)
- **Slash count args fail-closed**: `/last abc`, `/news 0`, `/stats abc`, `/logs abc`, `/files abc`, `/rewind abc` error clearly (were silent defaults)
- **Unknown slash typos**: `/exprot` → `Did you mean: /export?` (edit-distance + prefix; gibberish stays clean)
- **`/sessions prune --keep`**: invalid values error clearly (parity with CLI `invalid_keep`)
- **`apply_patch` context miss**: tips to re-read the file / refresh @@ hunks (or fall back to search_replace)
- **`bash` background start**: includes `timeout_ms` so operators know the wall-clock cap
- **`status --interval` / `news <count>`**: invalid values fail closed (`invalid_interval`/`invalid_count`) even without `--watch` (shared scripts)
- **Invalid `stats --days` / `logs -n`**: empty/NaN fail closed (`invalid_days`/`invalid_lines`) instead of silent default
- **Invalid CLI counts**: explicit `--keep`/`--limit`/`--max-age-days` that are empty/NaN/negative fail closed (`invalid_keep`/`invalid_limit`/`invalid_max_age_days`) instead of silently falling back to defaults
- **`bash` timeout**: wall-clock timeout reports `Command timed out after Nms` with exit code **124** (was an opaque killed-process code)
- **Error-streak hygiene**: `kill_task` on already-finished tasks does not count toward the circuit breaker; `get_task_output` notes when a task is final
- **`todo_write` validation**: requires id/content/valid status; `merge:true` + `[]` is a no-op warning; validation failures are `isError` (`todo_write error:`)
- **`web_fetch` empty body**: notes empty extraction and suggests `format=html` / another URL
- **`list_dir` empty**: names the path + tips (not bare “(empty directory)”)
- **`kill_task` already finished**: isError + command snippet + get_task_output hint (was a soft success)
- **`grep`/`glob` empty results**: include pattern/path context + recovery tips (not a bare “No matches found”)
- **`bash` non-zero exit**: always appends `[exit code N]` even when stdout/stderr is non-empty (models no longer miss the code in noisy output)
- **`forge status --cwd ''`**: fail closed with `invalid_cwd` (was treated as no filter → listed all)
- **`forge logout -p ''`**: fail closed with `invalid_provider` (was treated as omit → cleared **all** credentials)
- **`sessions list -q ''`**: fail closed with `invalid_query` (was treated as no filter)
- **Tool schemas / docs**: `search_replace` multi-match + miss guidance, `read_file` past-EOF, and unknown `task_id` suggestions documented in model-facing descriptions + `docs/TOOLS.md`
- **Empty `--goal`**: fail closed with `invalid_goal` (was silently ignored as falsy)
- **Empty `--deny`/`--allow`/`--ask`**: fail closed with `invalid_deny`/`invalid_allow`/`invalid_ask` (was silently ignored via `parseRuleString` null)
- **`sessions list|import --cwd ''`**: fail closed with `invalid_cwd` (was treated as “no filter” via truthy check)
- **Bare `--continue`/`--session` preflight**: does not apply `--title` before auth (failed login can no longer leave a half-renamed session)
- **`/logs` tab-complete**: offers `0`/`all` (full window) alongside 20/50/path
- **`forge config` empty flags**: `--provider`/`--model`/`--cwd` `''` fail closed (`invalid_*`); parent flag merge parity with doctor; shell completion offers `--json` for tips/init/completion
- **Empty-file `search_replace`**: miss hint says the file is empty and points at `write_file` (not generic closest-line tips)
- **`forge news` newest-first**: when a release section exceeds the display budget, take bullets from the **top** of the active `###` section (prepend convention) — tail-slice was hiding recent work and could surface stale duplicates
- **`/share` card**: `--continue` annotated fail-closed; CI line includes `forge tips --json`
- **`read_file` past-EOF**: offset beyond last line reports a clear past-end message (not “empty file” / inverted showing range)
- **`search_replace` multi-match**: lists line numbers + previews for each hit (cap 8) so the model can disambiguate without re-grepping blindly
- **`search_replace` miss guidance**: content-oriented closest-line hints + block-drift notes (no longer dumps path “did you mean?” when the file exists)
- **`get_task_output` / `kill_task` unknown id**: lists active tasks and suggests prefix/typo matches instead of a bare “Unknown task_id”
- **Empty `--cwd` / `--title` fail-closed**: structured `invalid_cwd` / `invalid_title` (no silent `path.resolve('')` → `.` or dropped title)
- **`forge logs -n 0`**: all events in the read window (was coerced to 30 via `Number(x)||30`); status `--interval 0` floors to 250ms
- **`--continue` fail-closed**: `forge run "…" --continue` and bare `forge "…" --continue` no longer silently start a fresh session when nothing is resumable — structured `{ ok:false, reason:continue_miss|continue_locked }` + exit 1 (CI-safe; omit `--continue` for fresh). Interactive same-cwd auto-resume (no flag) still soft-starts.
- **`forge tips --json` / `forge init --json` / `forge completion --json`**: structured envelopes for CI/onboarding; unknown completion shell → `reason:invalid_shell` (exit 1) instead of dumping bash script
- **content_filter / empty-response continues**: check stop-continue cap **before** injecting steerage user messages (avoids orphan prompts when releasing at cap; parity with `finish_reason=length`); empty-at-cap sets a clear `finalText` for headless JSON
- **length / stop-continue / content_filter cap release notes**: truncated-at-cap and content-filter-at-cap append Forge notes to `finalText`; stop-cap with blank assistant text no longer returns empty headless JSON
- **`list_dir` file-path error**: reports "not a directory" instead of "Directory not found" (parity with `glob`)
- **`forge tips` / `/tips` single source**: shared `formatExpertTips()` so CLI and REPL cheat sheets cannot drift (`/clear hard` included)
- **`releasedOnContinueCap` / `hitMaxTurns`**: headless JSON + metrics when stop-continue cap or `max_turns` releases (not a clean Stop) — CI can alert without hard-failing; stats aggregates `continueCapReleases` + `maxTurnsHits`; `forge run --help` documents JSON fields; library exports `LoopResult`
- **`max_turns = 0` is unlimited**: no longer silently capped at 200 (matches default config.toml comment); `/config` + doctor show `unlimited`; `forge config --json` includes `maxTurnsUnlimited`
- **`forge sessions title <id> <name|clear>`**: headless relabel (parity with `/title`; multi-word labels joined; searchable via list `-q`)
- **Doom-loop fingerprint**: ignore `background` / `stream` / `tail` / `allow_local` (plus existing timeout fields) so transport-only retries still trip; RELIABILITY docs updated
- **`forge sessions pin|title|fork` foreign-lock warn**: headless pin/title/fork warn (JSON: `foreignLock` / `sourceForeignLock`) when another live process holds `session.lock`
- **Tool schemas**: `glob` / `list_dir` descriptions note file-path → not-a-directory (parity with runtime)
- **`forge doctor --json`**: includes `maxTurns` + `maxTurnsUnlimited` (parity with `/config`)
- **`forge sessions show|export` lock hygiene**: show JSON includes `foreignLock`; export warns when source is foreign-locked
- **`/share` card**: includes `forge sessions title` headless relabel command
- **Anthropic `refusal` → `content_filter`**: maps stop_reason so loop content-filter steerage/cap applies (parity with OpenAI-compat); exported as `mapAnthropicStopReason`
- **`forge sessions path|list --json`**: includes `foreignLock` (list per-session); plain list + `/sessions`/`/resume` LOCK badge only for **foreign** live holders (own-pid locks are noise)
- **`forge sessions delete|import --json`**: structured failure payloads (`ok:false`, `reason`, …) for CI (still exit 1)
- **`forge run --json` early failures**: empty prompt / unauthenticated / session-not-found / foreign lock emit structured `{ ok:false, reason, … }` on stdout (still non-zero exit); `forge run` merges parent `optsWithGlobals` so `--session`/`--new`/`--title` bind correctly (was silently starting fresh)
- **`forge sessions * --json` lookup misses**: show/path/export/pin/title/fork emit `{ ok:false, reason:session_not_found, … }` (shared `failSessionLookup`); export invalid `--format` → `reason:invalid_format`
- **Bare `forge --continue`**: parent flag resumes newest same-cwd session for headless bare `forge "…"` (parity with `forge run --continue`; overrides `FORGE_NO_AUTO_RESUME`; `--title` relabels)
- **`forge sessions * --json` usage misses**: missing args emit `{ ok:false, reason:usage, error }` (shared `failUsage`) instead of stderr-only text
- **`finishReason` on headless JSON / `LoopResult`**: last provider `finish_reason` (or null); mid-run catch path adds `reason=error|timeout|aborted`
- **`invalid_effort` JSON**: `forge run --json --effort nope` emits `{ ok:false, reason:invalid_effort, … }` instead of stderr-only
- **CLI flag validation**: `--permission-mode` / `--sandbox` / `--sandbox-network` / `--sandbox-missing` reject unknown values (JSON reasons `invalid_permission_mode` · `invalid_sandbox` · …) instead of silently accepting typos; `mergeRunOpts` prefers CLI-sourced parent flags over run subcommand defaults (fixes parent `--permission-mode` being clobbered by run’s `acceptEdits` default) and unions parent/local `--deny`/`--allow`/`--ask` (empty run defaults no longer wipe parent rules)
- **`forge news` / `/news`**: prefer **newest** bullets when a release section exceeds the display budget (long 0.9.x bodies no longer hide recent work behind “+N more”)
- **`invalid_provider` JSON**: `--provider bogus` fails fast with structured reason (alias `grok` → `xai`) instead of a confusing unauthenticated/API error
- **Env enum hygiene**: invalid `FORGE_PROVIDER` / `FORGE_PERMISSION_MODE` / `FORGE_SANDBOX*` / `FORGE_READ_OUTSIDE` are ignored (keep defaults) instead of poisoning runtime config — parity with `FORGE_EFFORT`
- **`custom` provider requires base URL**: `--provider custom` without `--base-url` / `FORGE_BASE_URL` fails with `reason:missing_base_url` (no silent OpenAI fallback)
- **`--keep 0` is valid**: `sessions prune` / `prune-tool-output` / `prune-metrics` no longer treat `0` as missing via `Number(x)||default` (shared `parseKeepCount`; negative/NaN still fall back); `/sessions prune --keep=0` (and `--keep N`) parity; `--max-age-days 0` means no age filter (not coerced to 14)
- **`sessions list --limit 0`**: unlimited list (was coerced to default 30/20); `listSessions({ limit: 0 })` library parity
- **`sessions list|show --json`**: success payloads include `ok:true` (+ list `count`/`limit`) for CI parity with other session commands
- **`FORGE_ULW_STUCK_THRESHOLD`**: parsed via `envPositiveInt` (invalid/0 no longer poison stuck-wall)
- **`FORGE_GOAL_STUCK_THRESHOLD`**: ignore invalid/0 (0 would disable stuck-wall release forever)
- **`get_task_output` `tail: 0`**: full captured output (was coerced to 200 via `Number(x)||200`)
- **`forge stats --json`**: includes `ok:true` for CI parity
- **`read_file` `limit: 0` / `grep` `head_limit: 0`**: unlimited (was coerced to defaults via `Number(x)||n`); `forge news|models --json` and `/config json` include `ok:true`
- **`forge logs|prune-*|sessions prune --json`**: structured `{ ok:true, … }` envelopes; `web_fetch`/`web_search` ignore 0/invalid timeout/num_results (keep defaults)
- **`forge status --json`**: includes `ok`/`count`; `--session` miss → `{ ok:false, reason:session_not_found }` (exit 1) instead of empty HUD/array
- **`forge auth --json`**: structured auth status (`ok`, `authenticated`, `active`, `stored[]`) — **never** dumps tokens; exit 1 when unauthenticated
- **`forge logout --json`**: `{ ok, cleared, removed[], count }` (no tokens); `status --watch --session` miss fails fast (no empty watch loop)
- **`forge login --json`**: structured success/failure for `--from-grok` and `--api-key <key>` (never echoes keys; interactive OAuth/device rejected with `interactive_required`); tips CI line includes `forge auth --json`
- **`forge login -p/--provider`**: parent CLI provider no longer clobbered by login’s default `xai`; unknown providers → `invalid_provider` (JSON or stderr)
- **`forge login --api-key '' --json`**: empty key → `api_key_required` (no silent Grok import fallthrough)
- **Bare `forge "…" --json`**: parent `--json` forces headless and emits the same success/failure payload as `forge run --json` (empty prompt / unauthenticated / session-not-found structured); completion top-flags include `--json`/`--continue`; share card CI line + tips
- **Parent `--json` + subcommands**: `auth`/`doctor`/`models`/`stats`/`news`/`logs`/`config`/`prune-*` honor parent-attached `--json` via shared `flagJson` (Commander was binding the flag to the parent only, so `forge auth --json` printed human text); smoke covers bare `forge --json`; help example + AGENTS
- **`sessions export --out <dir>`**: structured `{ ok:false, reason:is_directory, hint }` (and plain error) instead of uncaught `EISDIR`; creates parent dirs for file targets; write failures → `reason:write_failed`
- **`sessions import <dir>` / `/export <dir>`**: directory targets fail closed with clear errors (`reason:is_directory` for import JSON; `/export` file-path hint) instead of `EISDIR`
- **`apply_patch` Move to existing path**: refuse when destination file/dir already exists (was silent clobber; undo journaled create could not restore prior dest body)
- **Shell hard-deny peels `bash -c` / `sh -c` and `$(…)` / `` `…` ``**: `bash -c "rm -rf /"` and `echo $(rm -rf /)` no longer bypass catastrophic deny (peelWrappers + commandCheckTargets)
- **`env`/`timeout` + `bash -c`**: re-join peeled tokens with shell quoting so multi-word `-c` bodies stay intact (`/usr/bin/env bash -c "rm -rf /"` no longer peels to bare `rm`)
- **`eval` / `xargs … bash -c` peels + runtime `system`/`execSync` rm-root**: hard-deny catches `eval "rm -rf /"`, `xargs bash -c "rm -rf /"`, and language-runtime shell deletes of `/` or `$HOME`
- **Heredoc-aware shell split + strip**: `git commit` / `cat <<EOF` payloads mentioning catastrophic commands no longer false-positive hard-deny; `bash <<EOF` bodies still scanned
- **`apply_patch` same-batch path tracking**: move/add refuse destinations created earlier in the same patch (was silent clobber across hunks)
- **`sessions export --out ''`**: structured `reason:usage` instead of treating empty as “no --out” and dumping the body on stdout
- **Shell peels**: `nohup`/`setsid`/`watch`, `busybox sh -c`, `su -c`, and `script -c` unwrap for hard-deny; RELIABILITY docs the peel matrix
- **Empty enum CLI flags**: `--permission-mode ''` / `--sandbox ''` / `--effort ''` (and sandbox-network/missing) fail with structured `invalid_*` instead of skipping validation and hitting the API
- **Empty `--provider` / `--model` / `--base-url`**: structured `invalid_provider` · `invalid_model` · `invalid_base_url` (was truthy-skip → silent default / API error)
- **Empty `--session` / export `--format ''`**: `session_not_found` (no silent fresh session) · `invalid_format` (no coerce to md via `|| "md"`)
- **`status --session ''`**: structured `session_not_found` (was silent empty HUD/`ok:true` list-all)
- **`doctor -p` parent merge**: parent/local `-p`/`--provider` honored (including empty → `invalid_provider`); was ignoring parent `-p` and doctor `-p bogus`
- **`forge auth --json` when unauthenticated**: `ok:false` + `reason:unauthenticated` (still exit 1; was `ok:true` with only `authenticated:false`)

### Recovery (disk + chat)
- **File mutation journal**: successful `write_file` / `search_replace` / `apply_patch` ops append pre-images to `~/.forge/sessions/<id>/mutations.jsonl` (mode `0600`, ~1.5 MiB cap per body)
- **`/undo` / `/rewind [n]`**: rewinds chat **and** restores journaled files for those turns (create→unlink, update/delete→pre-image)
- **`/retry` / `/again`**: same disk restore before re-running the prompt
- **Fork copies journal + ULW/goal harness sidecars** (`ulw.json` / `goal.json`) so `/fork` mid-ULW keeps the relentless driver; `/fork` output reports `Harness copied: …` when applicable
- **`/clear` resets timeline cleanly**: drops mutation journal, `editCount` / token counters, **and** ULW/goal `lastBlockEditCount` / `stuckBlocks` (stuck-wall must not treat pre-clear edits as progress)
- **`/new` does not inherit `ultrawork`**: fresh session id starts clean; re-arm with `/ulw` or `/goal` (avoids Stop backstop without `ulw.json`)
- **`/clear hard`**: brand-new session id (documented + Tab-complete); same clean-start rules as `/new`
- Large / unreadable pre-images are skipped with an explicit note (never silent data loss claims)

### Expert UX
- **`/init [focus]`**: OpenCode-style guided `AGENTS.md` bootstrap / improve (forwards a high-signal research+write prompt)
- **`/review [target]`**: OpenCode-style code review — `uncommitted` (default) · `staged` · `<commit>` · `<branch>` · `<pr#|url>`
- **`/compact-and <prompt>`**: Warp-style compact then continue with a follow-up in one step
- **`/fork-and-compact [prompt]`**: fork → compact the fork → optional continue (original history preserved)
- **`/config [json]`** · **`forge config [--json]`**: live-safe effective config snapshot (provider/model/sandbox/permissions/timeouts/FORGE_HOME — **never** dumps API keys)
- **`/export` path writes mode `0600`** (parity with `forge sessions export --out`)
- Help, tips, tab-complete updated

### Operator knobs
- **`FORGE_BASH_TIMEOUT_MS`** (default 120s, min 5s, max 30m) and **`FORGE_BASH_BG_TIMEOUT_MS`** (default 30m) for CI/long builds
- **`forge doctor --json`**: `bashTimeoutMs` · `bashBackgroundTimeoutMs`; plain doctor reliability line includes bash timeouts + file-aware undo

### Incident triage
- **`/logs [n|path]`** (live-safe) + **`forge logs`**: tail sandbox/safety events from `~/.forge/logs/sandbox.jsonl` (no secrets; Warp-inspired)
- Shell completion + smoke cover `logs`
- **Doctor** surfaces `undo-journal:` aggregate (`mutations.jsonl` session/entry/byte counts) when present; **`forge doctor --json`** includes `undoJournal: { sessions, bytes, entries }`

### Production polish (post-merge review)
- **Smoke**: replace fragile shell-empty-arg chain with `scripts/smoke.mjs` (isolated FORGE_HOME/GROK_HOME, explicit argv, timeouts)
- **Hard-deny**: `git push origin +main` / `+master` refspec force; `rm -rf ~/`, `~/*`, `$HOME/`, `$HOME/*`
- **File-aware undo**: restore-before-truncate journal (failed undos keep pre-images); never restore disk when chat rewind is a no-op; rebuild `userTurnMarks` after compact
- **Auth**: mid-run 401 tries `resolveAuthFresh` (Grok re-import) after refresh failure; doctor uses `resolveAuthFresh` so SuperGrok TTL does not false-fail CI
- **OIDC callback**: honor `FORGE_XAI_REDIRECT_URI` path; HTML-escape error_description on local callback page
- **CI**: `npm run check` builds before tests (dist-dependent CLI tests run); smoke asserts `empty_prompt` + `invalid_provider`
- **Multi-day unattended**: proactive OAuth refresh each model turn (~10m skew); multi-recovery mid-run (`FORGE_AUTH_RECOVERY_MAX`); 401-only recovery (quota 403 no longer burns slot); clear dead refresh_token on `invalid_grant`; session locks never TTL-steal **live** pids + touch on save; REPL fail-closed on foreign live lock (`FORGE_FORCE_SESSION_LOCK=1` override); doctor flags missing refresh_token

### SuperGrok OIDC
- **`forge login` (xai default)**: browser SuperGrok / xAI OIDC with the public Grok CLI client (`b1a00492-…`), PKCE, callback `http://127.0.0.1:56121/callback`
- Correct OIDC endpoints: `oauth2/authorize`, `oauth2/token`, `oauth2/device/code` (replaces broken `/oauth/token` + fake `forge-cli` client)
- Scopes: `openid profile email offline_access grok-cli:access api:access` → subscription-backed API + refresh tokens
- **`forge login --device`**: SuperGrok device-code for SSH / headless
- **`forge login --from-grok`**: still imports `~/.grok/auth.json` when Grok Build is already logged in
- Refresh uses the same public client + token URL; stores `clientId` on login for long sessions
- CI: `login --json` still requires `--api-key` (interactive OAuth/device → `interactive_required`)

### Docs / tests
- RELIABILITY + PRODUCTION + README note file-aware undo and new slash commands
- Tests: `mutations-undo.test.ts`, `logs.test.ts` (journal, restore, `/logs`, bash timeout env)
- `.gitignore` covers `.tmp-*/` compile caches
- Tests: SuperGrok OIDC profile + id_token email decode (`tests/xai-oauth.test.ts`)

## 0.9.4 — Expert UX (retry, pin, stats, resume-by-title)

Daily-driver session operations and orientation for long-running experts. Builds on 0.9.3 reliability.

### Sessions & resume
- **`forge run --continue`**: headless same-cwd resume (≤14d, skips foreign locks) — multi-step CI without copying session ids (OpenCode-style)
- **Resume by title**: `/resume <title>` · `forge --session <title>` · `sessions show|export|fork|delete|path|pin` resolve unique exact/substring titles (and last-prompt); ambiguous matches list candidates
- **`lastUserPreview`**: session meta sidecar stores last user prompt (80 chars) for `/sessions` · `forge sessions list` · `-q` search · `sessions show`
- **Relative ages** in session lists: `just now` / `5m` / `3h` / `2d` instead of raw ISO timestamps
- **Resume orientation**: auto-resume / `/resume` / `forge run --session` show last turn + mutated files
- **`/last [n]`**: peek last N user/assistant turns (live-safe)
- **`/files [writes|n]`**: paths touched by tools this session (R/A/M/P/D tags; live-safe)
- **`/path [id|json|copy]`** · **`forge sessions path <id|title>`**: on-disk session dir / `session.json` (live-safe; optional clipboard)
- **`sessions show`**: relative age, path line, files snippet, last-turn peek; JSON includes `path`

### Pin / prune hygiene
- **`/pin` / `/unpin`** (live-safe) + **`forge sessions pin|unpin`**: protect sessions from prune (`meta.pinned`; lists show `PIN`)
- **Fork clears pin**; import never inherits pin; status/prompt show `PIN` badge
- **`/sessions pinned`** · **`forge sessions list --pinned`**
- **Prune** reports `skippedPinned`; doctor plain + `--json` **`sessionsPinned`**

### Recovery & handoff
- **`/retry` / `/again` [prompt]**: rewind last user turn and re-run (optional rewritten prompt)
- **`/share`**: pasteable session card (resume/export cmds + optional clipboard)
- **`/done` / `/pause` / `/unpause`**: live-safe shorthands for `/goal done|pause|resume`

### Usage & discovery
- **`forge stats` / `/stats [days]`**: usage dashboard from metrics.jsonl (runs, tokens, est. cost, providers, projects) + session inventory (incl. pinned)
- **`forge news` / `/news` [n]**: in-app what's-new from packaged CHANGELOG (`forge changelog` alias; `--json`)
- **`forge tips` / `/tips`**: expert cheat sheet
- **First-run welcome tip** in REPL banner (once; `preferences.seenWelcomeTip`)
- **Install / banner / help**: surface `/news` · `/retry` · `/last` · `forge tips` · `--continue` · `stats`

### Docs / tests
- README, PRODUCTION, AGENTS, shell completion updated for the expert surface
- Tests: changelog, retry/last/files/pin/path, resume-by-title, continue, stats, live-controls, session-format

## 0.9.3 — Production lock & fetch hardening

Professional production polish on the 0.9.2 reliability surface after VM self-improvement review.

### Reliability / safety
- **`web_fetch` stream body cap**: reads via `ReadableStream` with a hard 5 MiB limit — missing/lying Content-Length cannot OOM the process; cancels body when oversize
- **`web_search` HTML scrape** capped at 2 MiB via the same reader
- **Headless session lock fail-closed**: `forge run` exits `1` when another live process holds `session.lock` (override `FORGE_FORCE_SESSION_LOCK=1`); REPL still warns and continues
- **Live lock + bad `acquiredAt`**: no longer treated as stale/stealable — only dead pids or parseable age past TTL
- **Heal re-save**: `loadSession` skips disk re-save when a foreign live lock is present (in-memory heal only)
- **External directory gate** covers `grep` / `glob` absolute paths (same as `read_file`) so models cannot bypass with search tools
- **`grep` abort**: honors turn `AbortSignal` (kills `rg`, cooperative JS fallback)
- **Session export `--out`**: writes mode `0600` (transcripts may contain secrets)
- **`forge sessions <query>`**: unknown first arg is title/id search (same as `-q`)
- **`install.sh`**: executable mode restored (`100755`)

### Docs / tests
- `docs/RELIABILITY.md`, `docs/PRODUCTION.md`, `.env.example` document lock fail-closed + body caps
- Tests: `readBodyCapped`, grep/glob external deny, live pid + invalid `acquiredAt` hold

## 0.9.2 — Error-streak, session ops, apply_patch

Learned from Grok Build (consecutive-failure circuit breaker) and OpenCode (session branch/export, apply_patch).

### Reliability / smartness
- **Error-streak circuit breaker**: 5 consecutive tool errors (different args OK) inject a hard strategy-change nudge; permission/hard denies excluded
- **Tunable loop guards**: `FORGE_DOOM_LOOP_THRESHOLD`, `FORGE_ERROR_STREAK_THRESHOLD`, `FORGE_ULW_MAX_CONTINUES` (invalid values fall back safely)
- **Background task teardown**: REPL exit + headless run end force-kill in-process `background=true` shells; `beforeExit`/`exit` safety net; SessionEnd runs before kill so hooks can observe tasks
- **Doctor** surfaces in-process background task counts + saved always-allow count; flags `auth.json` / `permissions.json` / `preferences.json` mode `0600`; `--json` includes structured `secureFiles` + `issues[]`; **Blocking Stop OFF** is a doctor issue; CI `ok` from `runDoctorCheck()` (never chalk/report regex); plain `forge doctor` also exits `1` on issues
- **`web_fetch` htmlToText**: invalid / out-of-range numeric entities no longer throw `RangeError` (keeps original token)
- **path-not-found hints**: typo tolerance via edit distance (e.g. `readmi.md` → `readme.md`), not substring-only
- **Shared `editDistance` / `stringSimilarity`** (`util/string-distance`) used by path-hints + block-anchor edit-match; stale “Levenshtein deferred” comment fixed
- **`glob` missing search root**: reports `Directory not found` + path hints instead of a false “No files matched”
- **`forge run`**: sandbox / network / missing-backend flags + `--deny`/`--allow`/`--ask`/`--base-url` (parity with top-level CLI); help documents exit codes 0/1/124/130
- **`grep` missing path**: errors with path hints instead of a false “No matches found”; JS fallback searches a single-file `path` correctly
- **Shell completion**: richer fish/zsh/bash for `run` (sandbox/deny/allow/ask) and `sessions export|import|prune` (`--format md|json`, `--out`, `--keep`, …)
- **`read_file`**: soft large-file size hint (≥2 MiB) steers agents toward offset/limit or grep
- **`write_file`**: structured errors (no throw-through); notes when parent directories were created
- **`/copy`**: multi-backend clipboard (`pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip` / `clip.exe`) with clear fallback preview; **live-safe** mid-run
- **`forge sessions export`**: rejects unknown `--format` (md|json only; validated before session lookup)
- **Tool schemas**: model-facing descriptions for read/write/grep/glob/list_dir document path hints, parent-dir creates, large-file guidance
- **Session import/load**: import rejects invalid message roles; `loadSession` soft-drops corrupt roles/todos, heals orphan tool_call pairs, and **re-saves** when healed so disk stays clean; `listSessions` / `loadSessionMeta` skip corrupt dirs; prune age filter ignores invalid timestamps
- **Session lock**: corrupt lock JSON / invalid pid treated as absent; dead pid or parseable age past TTL → stale steal; lock files mode `0600` (see 0.9.3 for headless fail-closed + live/bad-timestamp hold)
- **`apply_patch` path hints**: missing update/delete targets suggest nearby typos (parity with read/edit/grep)
- **Task tool schemas**: `kill_task` / `get_task_output` omit `task_id` from required (empty call lists actives; no empty `required: []`)
- **write_file / search_replace**: refuse directory targets with a clear message (no opaque `EISDIR`)
- **`apply_patch` add/update**: clear errors when path is a directory (no opaque `EISDIR`); add distinguishes dir vs file
- **`/diff` shell-safe**: filter args via `execFileSync` argv (no shell interpolation); deny write/exec git options (`--output`, `--ext-diff`, `--git-dir`, …); `git-context` also argv-based
- **sessions prune/delete**: never deletes sessions held by another live process (foreign `session.lock`); prune reports `skippedLocked`; delete refuses locked sessions unless `--force` (bash/zsh/fish completion includes `--force`)
- **Doctor sessions**: text line + `doctor --json` `sessionsLocked` count foreign live locks
- **`/diff` help**: documents argv-safe pathspecs/refs-only filters
- **`/resume`**: warns when target session has a foreign live lock; recent list shows LOCK tags
- **`forge sessions` list footer**: documents `delete [--force]`
- **`forge sessions list --cwd`**: filter sessions by workspace path (multi-project experts)
- **`listSessions({ cwd, query, limit })`**: native filter before limit; `/sessions` defaults to same-cwd, supports `all` / `search <q>`
- **`forge sessions list -q/--query`**: CLI title/id search; `/resume` picker defaults to same-cwd (`/resume all` for global)
- **`forge status --cwd`**: uses native `listSessions({ cwd })` so multi-project HUD is not starved by other workspaces
- **`forge` / `forge run --title`**: label sessions at create (CI-friendly; searchable via `-q` / `/sessions search`)
- **`web_fetch` / `web_search`**: honor turn abort signal (Ctrl+C / `FORGE_MAX_RUN_MS`); fetch signal stays live through body read; headless JSON includes `title`
- **Abort ≠ error-streak**: cooperative `Aborted` tool results excluded from circuit breaker; loop fail-fast after aborted tool batch
- **`forge sessions list`**: shows project basename when not filtered by `--cwd` (multi-project scan)
- **`/new [title]`**: optional searchable label on fresh REPL sessions; Tab completes `/sessions` / `/resume` verbs
- **`forge run`**: rejects empty/whitespace prompts before auth/session create (no orphan sessions, no API spend); help documents empty-prompt + `--title`
- **`kill_task` without id**: lists active tasks (parity with `get_task_output`) so agents can recover the id
- **permission-saved + auth store**: never mutate shared empty JSON fallbacks (always-allow / credential corruption fix)
- **`readJsonFile`**: clones object/array fallbacks so shared `EMPTY` constants cannot be corrupted
- **`/permissions list`** live-safe mid-run; menu numbers never assign `list`/`clear` as a permission mode
- **Richer retry HUD**: status shows human wait (`1.2s`) + HTTP reason / Retry-After
- **Session crash recovery**: load promotes newest leftover atomic-write tmp when `session.json` is missing/corrupt
- **`apply_patch` tool**: multi-file add/update/delete/move (OpenAI/OpenCode patch grammar); validate-then-apply; hard-deny path scan
- **Atomic file writes**: `write_file` / `search_replace` / `apply_patch` use tmp+rename (no truncated files on crash)
- **Permission ask timeout**: `FORGE_PERMISSION_TIMEOUT_MS` auto-denies stalled interactive Allow? prompts
- **metrics.jsonl**: counter-only run telemetry (`~/.forge/metrics.jsonl`); headless JSON includes `durationMs`; auto-prune ~2000 events / 2 MiB; `forge prune-metrics`

### Expert UX
- **`forge sessions show|export|import|fork|delete [--force]|list --cwd`** — inspect, markdown/JSON export/import, branch; lock-safe delete/prune; multi-project list filter
- **`/title` / `/rename`** — show/set/clear session title (live-safe mid-run)
- **`/bell [on|off|test]`** — optional terminal BEL on turn end (pref + `FORGE_BELL`); long-run attention
- **Interactive auto-resume** — bare `forge` continues newest same-cwd session (≤14d); skips foreign live locks (with skip count in resume log); `--new` / `FORGE_NO_AUTO_RESUME=1` for fresh
- **Richer model catalogs** for OpenAI / OpenRouter / Google (`forge models`)
- **`forge doctor --json`** exposes doom-loop / error-streak / ULW continue thresholds, perm-ask timeout, bell, auto-resume, **`sessionsLocked`** (see 0.9.4 for `sessionsPinned`)
- **`/fork`**, **`/export [--json]`**, **`/diff`** (shell-safe), **`/metrics`** in the REPL (diff/metrics live-safe)
- Richer bash completion for sessions show/export/import/fork/delete (`--force`)
- Doctor surfaces metrics + perm-ask-timeout + foreign-locked session count
- **Readable permission previews** for `apply_patch` (A/M/D ops list instead of raw patch dump)
- **Stream resilience**: OpenAI-compat + Anthropic SSE `error` events + fully empty streams throw as retryable (dropped connection)
- **Soft-dangerous** `git commit/push --no-verify` (and `commit -n`, not dry-run `-n` on other verbs) so acceptEdits still prompts
- **`forge run --session <id>`** resume prior headless/REPL session for multi-step CI pipelines
- **Headless session lock** — `forge run` takes the same `session.lock` as the REPL (warn on conflict; steal stale)
- **`forge sessions` / `/sessions` / `/status` / `forge status`** surface lock holders (HUD tags `LOCK:<pid>` for foreign live locks)

### Tests / docs
- Coverage for error-streak, fork/export JSON, tmp recovery, apply_patch, atomic write, metrics, perm timeout, env parsers, bell, title, same-cwd auto-resume, bg kill-all, lock-skip resume, permission-saved, readJsonFile isolation, inspectSecureFile / doctor secureFiles
- `docs/RELIABILITY.md` + `docs/PRODUCTION.md` + `docs/TOOLS.md` + `docs/HARNESS.md` + `.env.example` + `AGENTS.md` updated

## 0.9.1 — Context overflow + ULW survival

- **xAI overflow detect**: match `maximum prompt length is N but the request contains M tokens` (was missed → run died raw 400)
- **Conservative token estimate** (~3.2 chars/tok + framing + tool schemas) so HUD/auto-compact no longer lag ~15% behind the API
- **Progressive overflow recovery**: prune oversized tool/assistant bodies → keep 8→4→2 → nuclear; then re-issue
- **ULW re-admit after overflow**: long tool-only waves never hit Stop (`wave=0 blocks=0 cycle=1`); recovery now re-anchors mandate instead of hard death
- **92% headroom compact** before riding the absolute model max

## 0.9.0 — Production reliability

Learned from OpenCode / peer agent loops; aimed at expert daily-driver and CI use.

### Reliability
- **Retry-After** honored on provider `429`/`5xx` (`ProviderApiError` + structured headers)
- **Abortable** chat streams and sandboxed bash (Ctrl+C cancels in-flight work)
- **JSON tool-arg repair** for truncated / fenced / trailing-comma / unescaped-quote args
- **Orphan tool_call healing** after abort or compact (prevents next-turn API 400)
- **Compact keep-boundary** never cuts mid tool batch
- **`finish_reason=length`** continues generation instead of stopping mid-answer
- **Empty model response** nudge instead of silent stop
- **Doom-loop detection** — identical tool+args ×3 injects strategy-change nudge
- **Stream usage** via `stream_options.include_usage` for accurate `/cost`
- **Provider wall-clock timeout** (default 5m, `FORGE_PROVIDER_TIMEOUT_MS`) — timeout retryable, user abort not
- **Mid-run OAuth refresh** on 401/403 (hot-swaps bearer on the live provider)
- **Headless CI exit codes** — abort → 130; structured JSON errors on failure

### Auth & sessions
- `resolveAuthFresh` proactively refreshes OAuth before REPL/headless start
- Session **file lock** (`session.lock`) with stale-pid steal + multi-REPL warning
- `/doctor` reports token expiry, auth.json mode bits, sandbox fail-closed, reliability features

### Docs
- `docs/RELIABILITY.md` — operator-facing production contract

### Tests
- Expanded suite (**251+** tests) covering reliability, sessions, doctor, completion, tool-output, sandbox log
- **Context overflow recovery**: detect prompt-too-long, skip blind retries, force compact + one re-issue
- **Compact thrash guard**: no-op threshold compacts are not repeated every turn
- **`forge prune-tool-output`** + auto-prune of `~/.forge/tool-output` (keep 80 / 14d); doctor surfaces size
- **sandbox.jsonl rotation** at 2 MiB (one backup); doctor surfaces log size
- Doctor shows **session count** / tool-output / sandbox-log; `--json` includes `sessionCount`, `toolOutput`, `sandboxLog` + exit 1 when unhealthy
- `npm run smoke` / `npm run ci` for CI (tolerates unauthenticated doctor; includes prune-tool-output)
- **`FORGE_MAX_RUN_MS`** optional headless wall-clock deadline (exit 124 / `timedOut`)
- Legacy sessions **backfill meta.json** on first list
- **Session `meta.json` sidecar** — fast `listSessions` / prune without parsing multi-MB histories
- **`forge completion bash|zsh|fish`** shell completions for experts
- CLI help epilogue with production examples + docs pointers
- Version read from `package.json` (no more dual hardcodes in cli/repl)
- **`FORGE_LOG_JSON=1`** structured stderr logs for CI
- **`forge doctor --json`** machine-readable health summary
- **web_search** DuckDuckGo HTML fallback when Instant Answer is empty
- Richer **git context** (ahead/behind, changed file count, more project fingerprints)
- **`forge models --json`** / **`forge doctor --json`** exit code 1 on unhealthy
- **`forge sessions delete|prune`** disk hygiene for long-running expert machines
- GitHub Actions **CI** (Node 20/22 · typecheck · test · build · CLI smoke)
- Expert **docs/PRODUCTION.md** checklist
- System prompt **Reliability (runtime self-heal)** section (doom-loop, JSON repair, length continue)
- `forge doctor` prints **Version**; install.sh runs doctor after link
- `SECURITY.md` + `CONTRIBUTING.md`

## 0.8.0 — Bar A daily-driver safety

Fail-closed headless shell/writes, segment-strict allow rules, protected paths, project config cannot YOLO / redirect credentials / turn sandbox off.

## 0.7.x — Tool quality

Edit match fallbacks, managed truncation, env scrubbing, path hints.

## 0.6.x — Safety stack + harness

Blocking Stop, `/goal`, ULW cycle, sandbox profiles.
