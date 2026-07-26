# Changelog

## 0.9.5 — File-aware undo, /init, /review, /compact-and

Production recovery, review, and onboarding learned from OpenCode (snapshot/revert, guided AGENTS.md, `/review`) and Warp (`/compact-and`).

### Loop hygiene
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

### Docs / tests
- RELIABILITY + PRODUCTION + README note file-aware undo and new slash commands
- Tests: `mutations-undo.test.ts`, `logs.test.ts` (journal, restore, `/logs`, bash timeout env)
- `.gitignore` covers `.tmp-*/` compile caches

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
