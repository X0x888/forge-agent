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
| **Doom-loop** | Same tool + same args ×N injects a hard strategy-change nudge (OpenCode-inspired; default N=3, override `FORGE_DOOM_LOOP_THRESHOLD`) |
| **Error-streak** | N consecutive tool errors (any args) injects a circuit-breaker nudge (Grok-inspired; default N=5, override `FORGE_ERROR_STREAK_THRESHOLD`); permission/hard denies do not count |
| **Atomic file writes** | `write_file` / `search_replace` / `apply_patch` write via tmp+rename |
| **apply_patch** | Multi-file patch tool; all hunks validated before disk mutation; protected-path hard deny |
| **Permission ask timeout** | Optional `FORGE_PERMISSION_TIMEOUT_MS` auto-denies stalled interactive prompts (min 5s) |
| **metrics.jsonl** | Append-only run counters (tokens, edits, duration) under `~/.forge/metrics.jsonl` — no prompts/secrets; auto-prunes past ~2000 events / 2 MiB; `forge prune-metrics --keep 500` |

## Auth / sessions

| Behavior | Detail |
|---|---|
| **OAuth refresh** | `resolveAuthFresh` exchanges `refresh_token` before start when near expiry |
| **Mid-run 401** | One forced refresh + `provider.updateCredentials` then retry chat |
| **auth.json mode** | Written `0600`; `/doctor` flags group/world-readable files |
| **Session lock** | REPL and `forge run` acquire `session.lock`; warn if another live pid holds it; steal stale locks |
| **Atomic session write** | `session.json` written via tmp+rename; load recovers newest leftover tmp after crash |
| **Session fork/export/import** | `forge sessions fork\|export\|import\|show` and `/fork` / `/export [--json]` for expert branching & artifacts |
| **meta.json sidecar** | Each save writes lightweight meta for fast list/prune (no full history parse) |
| **sessions prune/delete** | `forge sessions prune --keep 50` / `/sessions prune` (active session protected) |
| **tool-output prune** | Full dumps under `~/.forge/tool-output` auto-pruned (keep 80 / 14d); `forge prune-tool-output` |
| **sandbox.jsonl rotate** | Safety event log rotates at 2 MiB (keeps one `.1` backup); never logs secrets |

## Agent loop

| Behavior | Detail |
|---|---|
| **Threshold auto-compact** | When estimated request tokens exceed `context_window * auto_compact_threshold` (or 92% headroom) |
| **`finish_reason=length`** | Continues generation instead of treating truncation as a final answer |
| **`content_filter`** | Surfaces provider safety blocks and steers the model to narrow scope (no infinite retry of the same phrasing) |
| **Empty assistant** | Nudges the model to continue rather than stopping on a blank turn |
| **Headless SIGINT/SIGTERM** | `forge run` aborts the in-flight loop cleanly (exit 130 when aborted) |
| **Headless session resume** | `forge run … --session <id>` continues a prior headless/REPL session (multi-step CI) |
| **Headless wall-clock** | Optional `FORGE_MAX_RUN_MS` aborts the run (exit 124; JSON `timedOut: true`) |
| **Bash abort** | Sandbox/`runRaw` children receive SIGTERM on turn abort |
| **Parallel reads** | Up to 8 consecutive read-only tools run in parallel; results stay ordered |

## Operator env knobs

| Variable | Default | Purpose |
|---|---|---|
| `FORGE_PROVIDER_TIMEOUT_MS` | `300000` | Provider fetch/stream wall clock |
| `FORGE_MAX_RUN_MS` | off | Headless `forge run` wall-clock cap (exit 124) |
| `FORGE_PERMISSION_TIMEOUT_MS` | off | Auto-deny stalled interactive Allow? prompts (min 5s) |
| `FORGE_DOOM_LOOP_THRESHOLD` | `3` | Identical tool+args streak before strategy nudge |
| `FORGE_ERROR_STREAK_THRESHOLD` | `5` | Consecutive tool errors before circuit-breaker nudge |
| `FORGE_ULW_MAX_CONTINUES` | `200` | Stop-continue cap while ULW is armed |
| `FORGE_LOG_JSON` | off | Structured JSON logs on stderr |
| `FORGE_BELL` | off | `1`/`0` force turn-end terminal BEL (overrides `/bell` preference) |
| `FORGE_NO_AUTO_RESUME` | off | `1` disables interactive same-cwd session auto-resume |
| `FORGE_HOME` | `~/.forge` | Config/session root (tests/CI isolation) |

Invalid numeric values fall back to defaults (never crash the agent).

## Operator checks

```bash
forge doctor          # auth, sandbox backend, auth.json mode, blocking Stop, session count
forge doctor --json   # CI-friendly summary (exit 1 when unhealthy; still prints JSON)
forge auth            # stored credentials + active resolution (refreshes OAuth)
FORGE_LOG_JSON=1 forge run "…"   # structured logs on stderr
forge sessions prune --keep 50   # disk hygiene
forge prune-tool-output          # prune ~/.forge/tool-output dumps
forge prune-metrics --keep 500   # prune counter-only metrics.jsonl
npm test              # full suite (uses workspace .tmp for tsx)
npm run check         # typecheck + test
npm run smoke         # build + CLI binary smoke
npm run ci            # check + smoke (GitHub Actions entrypoint)
```

## Non-negotiables (still)

1. `blockingStopHooks` defaults **true**
2. `/goal` stuck-wall can always release
3. Auth files mode `0600`
