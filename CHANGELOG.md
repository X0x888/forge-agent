# Changelog

## 0.9.2 — Error-streak, session ops, apply_patch

Learned from Grok Build (consecutive-failure circuit breaker) and OpenCode (session branch/export, apply_patch).

### Reliability / smartness
- **Error-streak circuit breaker**: 5 consecutive tool errors (different args OK) inject a hard strategy-change nudge; permission/hard denies excluded
- **Tunable loop guards**: `FORGE_DOOM_LOOP_THRESHOLD`, `FORGE_ERROR_STREAK_THRESHOLD`, `FORGE_ULW_MAX_CONTINUES` (invalid values fall back safely)
- **Richer retry HUD**: status shows human wait (`1.2s`) + HTTP reason / Retry-After
- **Session crash recovery**: load promotes newest leftover atomic-write tmp when `session.json` is missing/corrupt
- **`apply_patch` tool**: multi-file add/update/delete/move (OpenAI/OpenCode patch grammar); validate-then-apply; hard-deny path scan
- **Atomic file writes**: `write_file` / `search_replace` / `apply_patch` use tmp+rename (no truncated files on crash)
- **Permission ask timeout**: `FORGE_PERMISSION_TIMEOUT_MS` auto-denies stalled interactive Allow? prompts
- **metrics.jsonl**: counter-only run telemetry (`~/.forge/metrics.jsonl`); headless JSON includes `durationMs`; auto-prune ~2000 events / 2 MiB; `forge prune-metrics`

### Expert UX
- **`forge sessions show|export|import|fork`** — inspect, markdown/JSON export/import, branch a session
- **`/title` / `/rename`** — show/set/clear session title (live-safe mid-run)
- **`/bell [on|off|test]`** — optional terminal BEL on turn end (pref + `FORGE_BELL`); long-run attention
- **Interactive auto-resume** — bare `forge` continues newest same-cwd session (≤14d); skips foreign live locks; `--new` / `FORGE_NO_AUTO_RESUME=1` for fresh
- **`forge doctor --json`** exposes doom-loop / error-streak / ULW continue thresholds + perm-ask timeout
- **`/fork`**, **`/export [--json]`**, **`/diff`**, **`/metrics`** in the REPL (diff/metrics live-safe)
- Richer bash completion for sessions show/export/import/fork
- Doctor surfaces metrics + perm-ask-timeout
- **Readable permission previews** for `apply_patch` (A/M/D ops list instead of raw patch dump)
- **Stream resilience**: OpenAI-compat + Anthropic SSE `error` events + fully empty streams throw as retryable (dropped connection)
- **Soft-dangerous** `git commit/push --no-verify` (and `commit -n`, not dry-run `-n` on other verbs) so acceptEdits still prompts
- **`forge run --session <id>`** resume prior headless/REPL session for multi-step CI pipelines
- **Headless session lock** — `forge run` takes the same `session.lock` as the REPL (warn on conflict; steal stale)
- **`forge sessions` / `/sessions` / `/status` / `forge status`** surface lock holders (HUD tags `LOCK:<pid>` for foreign live locks)

### Tests / docs
- Coverage for error-streak, fork/export JSON, tmp recovery, apply_patch, atomic write, metrics, perm timeout, env parsers, bell, title, same-cwd auto-resume
- `docs/RELIABILITY.md` + `docs/PRODUCTION.md` + `docs/TOOLS.md` + `.env.example` + `AGENTS.md` updated

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
