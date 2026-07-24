# Forge production reliability

What experts should expect from Forge in long, unattended, or CI runs.

## Provider layer

| Behavior | Detail |
|---|---|
| **Retry-After** | `429` / `5xx` honor `Retry-After` and `retry-after-ms` (capped at 2 min) |
| **Context overflow** | Not retried with the same payload; force compact once then re-issue (OpenCode-style) |
| **Compact thrash guard** | Threshold compact that does not shrink history is not repeated until the message list grows |
| **Structured errors** | `ProviderApiError` carries status + headers; retry classifier uses them |
| **Abortable streams** | `AbortSignal` cancels `fetch` and releases the SSE reader (Ctrl+C works mid-token) |
| **Provider timeout** | Default 5 min wall clock (`FORGE_PROVIDER_TIMEOUT_MS`); timeout is retryable, user abort is not |
| **Stream usage** | OpenAI-compat requests set `stream_options.include_usage` so `/cost` is accurate |
| **Tool name merge** | Streamed names that re-send full chunks do not become `bashbash` |
| **Empty choices** | Non-stream responses with no choices throw a clear error |

## Tool / message integrity

| Behavior | Detail |
|---|---|
| **JSON arg repair** | Truncated / fenced / trailing-comma / unescaped-quote tool args are repaired when possible |
| **Orphan tool_calls** | Abort mid-batch or compact cut injects synthetic tool results so the next API call does not 400 |
| **Compact boundary** | Compaction never starts a keep-window on a bare `tool` message |
| **Empty name** | Tool calls with blank names after stream glitches return a clear error instead of crashing |
| **Doom-loop** | Same tool + same args ×3 injects a hard strategy-change nudge (OpenCode-inspired) |

## Auth / sessions

| Behavior | Detail |
|---|---|
| **OAuth refresh** | `resolveAuthFresh` exchanges `refresh_token` before start when near expiry |
| **Mid-run 401** | One forced refresh + `provider.updateCredentials` then retry chat |
| **auth.json mode** | Written `0600`; `/doctor` flags group/world-readable files |
| **Session lock** | REPL acquires `session.lock`; warns if another live pid holds it; steals stale locks |
| **meta.json sidecar** | Each save writes lightweight meta for fast list/prune (no full history parse) |
| **sessions prune/delete** | `forge sessions prune --keep 50` / `/sessions prune` (active session protected) |
| **tool-output prune** | Full dumps under `~/.forge/tool-output` auto-pruned (keep 80 / 14d); `forge prune-tool-output` |
| **sandbox.jsonl rotate** | Safety event log rotates at 2 MiB (keeps one `.1` backup); never logs secrets |

## Agent loop

| Behavior | Detail |
|---|---|
| **Threshold auto-compact** | When estimated tokens exceed `context_window * auto_compact_threshold` |
| **`finish_reason=length`** | Continues generation instead of treating truncation as a final answer |
| **`content_filter`** | Surfaces provider safety blocks and steers the model to narrow scope (no infinite retry of the same phrasing) |
| **Empty assistant** | Nudges the model to continue rather than stopping on a blank turn |
| **Headless SIGINT/SIGTERM** | `forge run` aborts the in-flight loop cleanly (exit 130 when aborted) |
| **Headless wall-clock** | Optional `FORGE_MAX_RUN_MS` aborts the run (exit 124; JSON `timedOut: true`) |
| **Bash abort** | Sandbox/`runRaw` children receive SIGTERM on turn abort |
| **Parallel reads** | Up to 8 consecutive read-only tools run in parallel; results stay ordered |

## Operator checks

```bash
forge doctor          # auth, sandbox backend, auth.json mode, blocking Stop, session count
forge doctor --json   # CI-friendly summary (exit 1 when unhealthy; still prints JSON)
forge auth            # stored credentials + active resolution (refreshes OAuth)
FORGE_LOG_JSON=1 forge run "…"   # structured logs on stderr
forge sessions prune --keep 50   # disk hygiene
forge prune-tool-output          # prune ~/.forge/tool-output dumps
npm test              # full suite (uses workspace .tmp for tsx)
npm run check         # typecheck + test
npm run smoke         # build + CLI binary smoke
npm run ci            # check + smoke (GitHub Actions entrypoint)
```

## Non-negotiables (still)

1. `blockingStopHooks` defaults **true**
2. `/goal` stuck-wall can always release
3. Auth files mode `0600`
