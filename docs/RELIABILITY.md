# Forge production reliability

What experts should expect from Forge in long, unattended, or CI runs.

## Provider layer

| Behavior | Detail |
|---|---|
| **Retry-After** | `429` / `5xx` honor `Retry-After` and `retry-after-ms` (capped at 2 min) |
| **Context overflow** | Detected across vendors (incl. xAI `maximum prompt length`); not retried with the same payload; progressive prune + compact (keep 8→4→2) then re-issue |
| **Token estimate** | Conservative (~3.2 chars/token + per-message framing + tool-schema overhead) so auto-compact fires before the hard API max |
| **Headroom compact** | Also compacts when estimate exceeds 92% of `context_window`, not only `auto_compact_threshold` |
| **ULW after overflow** | Re-admits mandate/cycle after recovery so long tool-only waves do not die with `cycle=1 wave=0` and no resume guidance |
| **Compact thrash guard** | Threshold compact that does not shrink history is not repeated until the message list grows |
| **Structured errors** | `ProviderApiError` carries status + headers; retry classifier uses them |
| **Abortable streams** | `AbortSignal` cancels `fetch` and releases the SSE reader (Ctrl+C works mid-token) |
| **Provider timeout** | Default 5 min wall clock (`FORGE_PROVIDER_TIMEOUT_MS`); timeout is retryable, user abort is not |
| **Stream usage** | OpenAI-compat requests set `stream_options.include_usage` so `/cost` is accurate |
| **Tool name merge** | Streamed names that re-send full chunks do not become `bashbash` |
| **Empty choices** | Non-stream responses with no choices throw a clear error |
| **Empty / error SSE** | Mid-stream `error` events throw; fully empty streams (no content/tools/finish) throw as retryable dropped-connection |

## Tool / message integrity

| Behavior | Detail |
|---|---|
| **JSON arg repair** | Truncated / fenced / trailing-comma / unescaped-quote tool args are repaired when possible |
| **Orphan tool_calls** | Abort mid-batch or compact cut injects synthetic tool results so the next API call does not 400 |
| **Compact boundary** | Compaction never starts a keep-window on a bare `tool` message |
| **Empty name** | Tool calls with blank names after stream glitches return a clear error instead of crashing |
| **Doom-loop** | Same tool + same args ×N injects a hard strategy-change nudge (OpenCode-inspired; default N=3, override `FORGE_DOOM_LOOP_THRESHOLD`); fingerprints ignore transport-only fields (`timeout_ms`, `background`, `stream`, `tail`, `allow_local`) |
| **Error-streak** | N consecutive tool errors (any args) injects a circuit-breaker nudge (Grok-inspired; default N=5, override `FORGE_ERROR_STREAK_THRESHOLD`); permission/hard denies do not count |
| **Atomic file writes** | `write_file` / `search_replace` / `apply_patch` write via tmp+rename |
| **File mutation journal** | Successful edits append pre-images to `sessions/<id>/mutations.jsonl` (mode `0600`, ~1.5 MiB/body cap) so `/undo` / `/retry` restore **disk + chat** (OpenCode-inspired; large bodies skipped with an explicit note) |
| **apply_patch** | Multi-file patch tool; all hunks validated before disk mutation; protected-path hard deny; missing update/delete targets suggest nearby path typos; delete/update pre-images journaled for undo |
| **Permission ask timeout** | Optional `FORGE_PERMISSION_TIMEOUT_MS` auto-denies stalled interactive prompts (min 5s) |
| **metrics.jsonl** | Append-only run counters (tokens, edits, duration) under `~/.forge/metrics.jsonl` — no prompts/secrets; auto-prunes past ~2000 events / 2 MiB; `forge prune-metrics --keep 500` |

## Auth / sessions

| Behavior | Detail |
|---|---|
| **OAuth refresh** | `resolveAuthFresh` exchanges `refresh_token` before start when near expiry |
| **Mid-run 401** | One forced refresh + `provider.updateCredentials` then retry chat |
| **Sensitive JSON mode** | `auth.json`, `permissions.json`, `preferences.json` written `0600`; `/doctor` flags group/world-readable files; `forge doctor --json` exposes structured `secureFiles` (`exists` / `mode` / `modeOk`) and sets `ok: false` when any `modeOk` is false |
| **Session lock** | REPL and `forge run` acquire `session.lock`; headless **fails closed** on a foreign live lock (exit 1) unless `FORGE_FORCE_SESSION_LOCK=1`; REPL still warns and continues; steal only dead pids or parseable age past TTL; corrupt lock JSON / invalid pid treated as absent; live pid + invalid `acquiredAt` is still held |
| **Atomic session write** | `session.json` written via tmp+rename; load recovers newest leftover tmp after crash |
| **JSON store isolation** | `readJsonFile` clones object fallbacks; auth + always-allow stores never share mutable empty constants |
| **Session fork/export/import** | `forge sessions fork\|export\|import\|show` and `/fork` / `/export [--json]` for expert branching & artifacts; export files written mode `0600`; import rejects bad roles; load soft-sanitizes corrupt on-disk messages, heals orphan tool_call pairs, and **re-saves** when healed only if no foreign live lock; **fork copies** mutation journal + **ULW/goal** sidecars so mid-ULW branches keep the driver; `listSessions({cwd,query,limit})` filters before limit (CLI `--cwd`/`-q` or bare `forge sessions <query>`, `/sessions` same-cwd default); corrupt dirs skipped (doctor/`/sessions` never throw) |
| **meta.json sidecar** | Each save writes lightweight meta for fast list/prune (no full history parse) |
| **sessions prune/delete** | `forge sessions prune --keep 50` / `/sessions prune` (active protected; foreign live locks skipped); `delete` refuses foreign locks unless `--force` |
| **tool-output prune** | Full dumps under `~/.forge/tool-output` auto-pruned (keep 80 / 14d); `forge prune-tool-output` |
| **sandbox.jsonl rotate** | Safety event log rotates at 2 MiB (keeps one `.1` backup); never logs secrets |
| **`/logs` · `forge logs`** | Tail recent sandbox/safety events (deny/fallback/hard_deny/…) for incident triage; `--json` / `--path` |

## Agent loop

| Behavior | Detail |
|---|---|
| **Threshold auto-compact** | When estimated request tokens exceed `context_window * auto_compact_threshold` (or 92% headroom) |
| **`finish_reason=length`** | Continues generation instead of treating truncation as a final answer (shared stop-continue cap); **at cap** appends a clear release note to `finalText` so headless JSON is not a silent partial |
| **`content_filter`** | Surfaces provider safety blocks and steers the model to narrow scope; **cap checked before** injecting steerage (no orphan user msgs on release); **at cap** appends a release note to `finalText`; Anthropic `stop_reason=refusal` maps to `content_filter` |
| **Empty assistant** | Nudges the model to continue rather than stopping on a blank turn; **cap checked before** nudge inject; **at cap** sets non-empty `finalText` |
| **Stop-continue cap** | When harness keeps blocking Stop until the shared cap, empty `finalText` gets an explicit release message (tools-only last turn); loop sets `releasedOnContinueCap` (headless JSON + metrics) for CI visibility |
| **maxTurns** | `max_turns = 0` (default) is **unlimited**; positive values cap agent turns. Hitting the cap sets `hitMaxTurns` + annotates `finalText` (clean Stop on the final allowed turn is **not** flagged) |
| **Headless SIGINT/SIGTERM** | `forge run` aborts the in-flight loop cleanly (exit 130 when aborted) |
| **Headless session resume** | `forge run … --session <id>` continues a prior headless/REPL session (multi-step CI) |
| **Headless wall-clock** | Optional `FORGE_MAX_RUN_MS` aborts the run (exit 124; JSON `timedOut: true`) |
| **Bash abort** | Sandbox/`runRaw` children receive SIGTERM on turn abort |
| **Web tool abort** | `web_fetch` / `web_search` merge turn signal + timeout so Ctrl+C / `FORGE_MAX_RUN_MS` cancel in-flight HTTP; bodies stream-capped (`web_fetch` 5 MiB, search HTML 2 MiB) so missing Content-Length cannot OOM |
| **grep abort** | `grep` honors turn `AbortSignal` (kills `rg` / stops JS fallback) |
| **Abort hygiene** | Cooperative `Aborted` tool results do not count toward error-streak; loop asserts abort immediately after tool batches |
| **Background task teardown** | REPL exit and headless `forge run` end force-kill in-process `background=true` shells; `beforeExit`/`exit` safety net; SessionEnd runs before kill so hooks can observe tasks |
| **Parallel reads** | Up to 8 consecutive read-only tools run in parallel; results stay ordered |

## Operator env knobs

| Variable | Default | Purpose |
|---|---|---|
| `FORGE_PROVIDER_TIMEOUT_MS` | `300000` | Provider fetch/stream wall clock |
| `FORGE_BASH_TIMEOUT_MS` | `120000` | Default foreground `bash` timeout (min 5s, max 30m) |
| `FORGE_BASH_BG_TIMEOUT_MS` | `1800000` | Default background task timeout (min 30s, max 6h) |
| `FORGE_MAX_RUN_MS` | off | Headless `forge run` wall-clock cap (exit 124) |
| `FORGE_PERMISSION_TIMEOUT_MS` | off | Auto-deny stalled interactive Allow? prompts (min 5s) |
| `FORGE_DOOM_LOOP_THRESHOLD` | `3` | Identical tool+args streak before strategy nudge |
| `FORGE_ERROR_STREAK_THRESHOLD` | `5` | Consecutive tool errors before circuit-breaker nudge |
| `FORGE_ULW_MAX_CONTINUES` | `200` | Stop-continue cap while ULW is armed |
| `FORGE_FORCE_SESSION_LOCK` | off | Headless: force-steal / continue despite a foreign live `session.lock` |
| `FORGE_LOG_JSON` | off | Structured JSON logs on stderr |
| `FORGE_BELL` | off | `1`/`0` force turn-end terminal BEL (overrides `/bell` preference) |
| `FORGE_NO_AUTO_RESUME` | off | `1` disables interactive same-cwd session auto-resume |
| `FORGE_HOME` | `~/.forge` | Config/session root (tests/CI isolation) |

Invalid numeric values fall back to defaults (never crash the agent).

## Operator checks

```bash
forge doctor          # auth, sandbox backend, auth.json mode, blocking Stop, session count (exit 1 if issues)
forge doctor --json   # CI-friendly summary (exit 1 when unhealthy; includes secureFiles + issues[] + sessionsLocked + sessionsPinned + undoJournal)
forge auth            # stored credentials + active resolution (refreshes OAuth)
FORGE_LOG_JSON=1 forge run "…"   # structured logs on stderr
forge run "next" --continue --json   # multi-step same-cwd resume (no session id)
forge stats --days 7 --json      # counter-only usage dashboard
forge sessions prune --keep 50   # disk hygiene (skips locked + pinned)
forge prune-tool-output          # prune ~/.forge/tool-output dumps
forge prune-metrics --keep 500   # prune counter-only metrics.jsonl
npm test              # full suite (uses workspace .tmp for tsx)
npm run check         # typecheck + test
npm run smoke         # build + CLI binary smoke
npm run ci            # check + smoke (GitHub Actions entrypoint)
```

## Non-negotiables (still)

1. `blockingStopHooks` defaults **true** — doctor treats OFF as an issue; `forge doctor --json` sets `ok: false` when `blockingStop` is false (structured field + `issues[]`, never chalk/report regex)
2. `/goal` stuck-wall can always release
3. Auth / preferences / permissions files mode `0600`

`runDoctorCheck()` returns `{ report, issues, ok, authenticated, blockingStop }` — `forge doctor --json` and library consumers should use that, not scrape the human report.
