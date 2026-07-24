# Changelog

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
- Expanded suite (**231** tests) covering reliability, sessions, doctor, completion, tool-output, sandbox log
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
