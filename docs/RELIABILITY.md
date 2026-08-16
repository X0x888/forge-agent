# Forge production reliability

What experts should expect from Forge in long, unattended, or CI runs.

## Provider layer

| Behavior | Detail |
|---|---|
| **Model fallback** | After same-model 429/5xx retries exhaust, switch to the next same-provider model (`fallback_models` / `FORGE_FALLBACK_MODELS` / `--fallback-models` / `/fallback`; defaults on, `off` disables). Quota/auth still switch accounts. Last hop is persisted (`lastModelFallback`) and shown on `/share` / `/status` / resume. ULW + fallback off is a production warning. |
| **Retry-After** | `429` / `5xx` honor `Retry-After` and `retry-after-ms` (capped at 2 min; the server hint wins over the client backoff cap so sustained limiting does not burn the retry budget) |
| **Context overflow** | Detected across vendors (incl. xAI `maximum prompt length`); not retried with the same payload; progressive prune + compact (keep 8→4→2) then re-issue |
| **Per-model context window** | Unless `context_window` is set explicitly, the window follows the active model (`config/model-info.ts` + `grok-model.ts`: grok-4.6/4.5=500k, newer Grok flagships inherit, grok-4=256k, grok-3=131k, claude-*=200k, gpt-4.1=1M …) on load, `/model`, and provider fallback — a stale 500k budget no longer overflows smaller models |
| **Token estimate** | Conservative (~3.2 chars/token + per-message framing + tool-schema overhead) so auto-compact fires before the hard API max |
| **Headroom compact** | Also compacts when estimate exceeds 92% of `context_window`, not only `auto_compact_threshold` |
| **ULW after overflow** | Re-admits mandate/cycle after recovery so long tool-only waves do not die with `cycle=1 wave=0` and no resume guidance |
| **Compact thrash guard** | Threshold compact that does not shrink history is not repeated until the message list grows |
| **Structured errors** | `ProviderApiError` carries status + headers; retry classifier uses them |
| **Prune lastError protect** | `pruneSessions` skips sessions with `meta.lastError` by default (`skippedLastError`); `forceLastError` / `--force-last-error` required to delete failure backlog |
| **Session lastError** | Provider/run failures stamp `meta.lastError` (code/message/tips); `/status`, resume, `/share`, sessions list ERR badge, HUD/tmux, `forge status --json`, and `forge run --json` fail payloads surface it; cleared on success/`/clear`/`/fork` |
| **Expert recovery tips** | `formatProviderError` maps auth/rate-limit/quota (incl. 403 body), overflow (incl. Anthropic “prompt is too long”), network/DNS, 5xx, Anthropic 529/`overloaded`, model-not-found, Azure/OpenAI `content_filter`, empty/no-choice responses, unsupported model features, org verification, and deprecated-model to next steps; REPL + headless print tips; `forge run --json` fail payloads include `recovery: { code, tips }` and structured `reason` |
| **Abortable streams** | `AbortSignal` cancels `fetch` and releases the SSE reader (Ctrl+C works mid-token) |
| **Provider timeout** | Default 10 min **stall** silence budget (`FORGE_PROVIDER_TIMEOUT_MS`) — aborts only when no stream activity; healthy long streams call `touch()` on each chunk so ULW / max-effort / large outputs are not killed at a fixed wall clock. Optional absolute ceiling via `FORGE_PROVIDER_MAX_MS` (off by default). Timeout is retryable; user abort is not |
| **Prompt-cache stability** | System prompt (message[0]) carries only stable git state (root/remote); the volatile branch + coarse dirty/clean tree are admitted append-only via context-admit (dirty↔clean flips re-admit; file-count churn does not). xAI requests send `x-grok-conv-id` and replay `reasoning_content`. Outbound is append-only until ~180k. Dock `cache N%` is the last provider round (not the lifetime smear). |
| **Stream usage** | OpenAI-compat requests set `stream_options.include_usage` so `/cost` is accurate; `prompt_tokens_details.cached_tokens` is surfaced as `cache_read_input_tokens` |
| **Tool name merge** | Streamed names that re-send full chunks do not become `bashbash` |
| **Empty choices** | Non-stream responses with no choices throw a clear error |
| **Empty / error SSE** | Mid-stream `error` events throw; fully empty streams (no content/tools/finish) throw as retryable dropped-connection |

## Tool / message integrity

| Behavior | Detail |
|---|---|
| **JSON arg repair** | Truncated / fenced / trailing-comma / unescaped-quote tool args are repaired when possible; also bare `undefined`/`NaN` → `null`, empty values after colon, unquoted keys, and `//`/`/* */` comments outside strings |
| **CLI JSON `version`** | `emitOkJson` / `emitFailJson` stamp every common `--json` success/failure payload with package version for CI matrices |
| **Orphan tool_calls** | Abort mid-batch or compact cut injects synthetic tool results so the next API call does not 400 |
| **Compact boundary** | Compaction never starts a keep-window on a bare `tool` message |
| **Empty name** | Tool calls with blank names after stream glitches return a clear error instead of crashing |
| **Parallel read-only tools** | Consecutive read-only tools (read/grep/glob/list/web_*) batch via `Promise.all` after name normalize (`isReadOnlyToolName`) — aliases and doubled stream-bug names included |
| **Unknown tool tips** | Up to 3 Did-you-mean candidates (`suggestNames`) so the model can self-correct typos without a human |
| **Doom-loop** | Same tool + same args ×N injects a hard strategy-change nudge (OpenCode-inspired; default N=3, override `FORGE_DOOM_LOOP_THRESHOLD`); fingerprints ignore transport-only fields (`timeout_ms`, `background`, `run_in_background`, `stream`, `tail`, `allow_local`) |
| **Error-streak** | N consecutive tool errors (any args) injects a circuit-breaker nudge (Grok-inspired; default N=5, override `FORGE_ERROR_STREAK_THRESHOLD`); permission/hard denies do not count |
| **Request-time prune** | Outbound-only. Default is **append-only** until the estimate hits 180k (under the 200k 2× price cliff), then **one clip** whose omit set is frozen on `session.meta.requestPruneSticky`. Later rounds re-apply those stubs instead of re-aging (xAI prefix can cache again). A second shelf reclips only if the last clip got under the cliff and the suffix grew back over. Compact/`/clear` drop the set. Every-round prune (`FORGE_REQUEST_PRUNE=1`) still rewrites the prefix. Stored `session.json` messages are never rewritten. |
| **Unchanged read stub** | Full-file `read_file` (no offset/limit) with matching mtime/size and the last body still in the live tail returns `Unchanged since last read`. Windowed reads and post-write reads still return the body. `FORGE_UNCHANGED_READ_STUB=0` off |
| **Unattended cost meters** | `forge run --json` / `metrics.jsonl` / last-run session meta: `harnessUserPokes`, `admitCount`, `proofPokes`, `providerRounds` |
| **Store checkpoint** | Rare resume-file compact when the *store* is huge (`FORGE_CHECKPOINT_STORE_TOKENS` / `_MESSAGES`), not when outbound is 80k. Job card is extractive from sidecars + in-flight tail. FileReadState survives if mtime matches |
| **Adaptive effort** | Hard-round signals (doom-loop, error-streak, missing ULW wave proof / weak attestation) raise `reasoning_effort` one notch for the next turn only — escalate on failure, not by default; `FORGE_ADAPTIVE_EFFORT=0` disables; no-op for models without effort support |
| **Anthropic prompt caching** | `cache_control` breakpoints on the system prompt, the last tool definition, and a rolling breakpoint on the newest message so conversation history is cache-read (not re-billed) every turn; usage reports `cache_read_input_tokens` / `cache_creation_input_tokens`; `FORGE_ANTHROPIC_CACHE=0` restores legacy body shape |
| **ULW wave ledger** | Per-wave facts (`editDelta`, `proof`, summary) in `ulw.json` drive the quality bar: best-wave anchoring, proof demands (cap 2), thin-wave escalation, 4th-wave consolidation cadence, diminishing-returns advisory, and one-time evidence bounce on weak `**Cycle complete.**` attestations (never an infinite trap) |
| **Atomic file writes** | `write_file` / `search_replace` / `apply_patch` write via tmp+rename |
| **Edit miss guidance** | `search_replace` failures on existing files suggest closest lines + block-drift notes (not path typos); multi-match lists line numbers |
| **Path-not-found hints** | Missing paths suggest sibling typos; when the parent dir is also missing, walk up one level (`srcx/foo.ts` → `src/`) |
| **Config alias/bool load** | Global config file aliases (`yolo`→`bypassPermissions`, `none`→sandbox `off`, stringy `"false"`→bool) are coerced at `loadConfig` so runtime gates match doctor/`productionWarnings` |
| **Tool path display** | `displayRelPath` realpath-normalizes workspace/file pairs (macOS `/var` vs `/private/var`) across write/edit/read/grep/glob/apply_patch, permission-ask diffs, turn-end Δ, `/context` labels, and LSP locations — no `../../../../private/var/...` leaks |
| **todo_write validation** | Requires id/content/valid status; merge:true + [] warns; failures are tool errors |
| **bash exit code** | Non-zero exits always append `[exit code N]` even when stdout/stderr is non-empty |
| **grep/glob empty** | Empty results include pattern/path + recovery tips |
| **read_file past-EOF** | Offset beyond last line returns a clear past-end message (not a false empty-file) |
| **Unknown task_id** | `get_task_output` / `kill_task` list actives and suggest prefix/typo matches |
| **CLI/slash typos** | Bare `forge sesions`, `sessions prun`, `--model grok-45`, `--effort medum`, `/exprot` → structured Did you mean? (fail-closed where CI-safe); tool numeric/format args fail closed; doctor flags invalid config permission rules |
| **Headless slash** | `forge run "/plan"` / `forge run "!cmd"` / `"/commands"` / custom `.forge/commands` templates resolve without a model call when pure control (`reason: "slash"`); failed bang-shell exits 1; templates expand then run the agent |
| **Session plan mode** | `/plan` is session-scoped (no sticky prefs); resume restores plan unless `--permission-mode` is set; `exit_plan_mode` or `/build` clears the override |
| **Project instructions** | Walk-up within git root for AGENTS/CLAUDE/cursor/copilot rules; doctor JSON `projectRulesCount` / `projectCommandsCount` for CI hygiene |
| **File mutation journal** | Successful edits append pre-images to `sessions/<id>/mutations.jsonl` (mode `0600`, ~1.5 MiB/body cap) so `/undo` / `/retry` restore **disk + chat** (OpenCode-inspired; large bodies skipped with an explicit note) |
| **Project intelligence** | Detect package manager + preferred check commands; inject into system prompt, `/context`, doctor/status/config JSON, statusline, proof-claim reanchor, and post-edit verify tips — less “use pnpm / run npm test” steering. Monorepo walk-up (git-root bounded) + turbo/nx + bash recovery tips (wrong PM, missing script/binary, layout, next check) |
| **Stale/unread edit guard** | Agent-loop mutations require prior `read_file` and refuse mtime/size drift (`FORGE_FILE_READ_GUARD=0` off) — OpenCode-inspired blind-overwrite protection |
| **Edit receipt** | Successful `search_replace` / `write_file` / `apply_patch` return a numbered AFTER window to the model; TUI diffs stay on `ToolResult.diff`. `FORGE_EDIT_RECEIPT=legacy` restores the old embedded `--- a/` dump. |
| **apply_patch** | Multi-file patch tool; all hunks validated before disk mutation; protected-path hard deny; missing update/delete targets suggest nearby path typos; delete/update pre-images journaled for undo; **Move to** refuses existing dest (disk or earlier hunk in the same patch) |
| **Bash timeout** | Foreground/background wall-clock timeout reports `Command timed out after Nms` with exit code **124** |
| **Bash hard-deny peels** | Catastrophic deny sees through `env`/`timeout`/`nohup`/`setsid`/`watch`, `bash|sh|busybox sh|su|script -c`, `eval`, `xargs … bash -c`, and `$(…)` / `` `…` ``; language-runtime `system`/`execSync` rm-root/home denied; **heredoc data** (`git commit`/`cat <<EOF` payloads) is not a false positive — `bash <<EOF` bodies still scanned |
| **Permission ask timeout** | Optional `FORGE_PERMISSION_TIMEOUT_MS` (alias `FORGE_PERMISSION_ASK_TIMEOUT_MS`) auto-denies stalled interactive prompts (min 5s) |
| **metrics.jsonl** | Append-only run counters (tokens, edits, duration) under `~/.forge/metrics.jsonl` — no prompts/secrets; auto-prunes past ~2000 events / 2 MiB; `forge prune-metrics --keep 500` |

## Auth / sessions

| Behavior | Detail |
|---|---|
| **OAuth refresh** | `resolveAuthFresh` exchanges `refresh_token` before start when near expiry |
| **Mid-run 401/403 token death** | Forced refresh (+ Grok re-import) + `provider.updateCredentials` with the **refreshed access token directly** (not re-`resolveAuth`, which skipped bearers still marked expired when `expires_in` was omitted) then retry chat in a loop up to `FORGE_AUTH_RECOVERY_MAX`; multi-account auth-failure switch with shorter cooldown when refresh fails. SuperGrok often returns **HTTP 403** `"OAuth2 access token could not be validated"` (not 401) — classified via `isTokenAuthFailure` so ULW does not die mid-wave. Non-quota 403 token rejections recover; quota/billing 403s stay on the account-switch quota path. Proactive refresh failure also fails over to another same-provider account before the next chat call. Refresh responses without `expires_in` get a default 1h TTL (never keep a past `expiresAt` after rotation). |
| **Mid-run socket drop (`terminated`)** | Node/undici `TypeError: terminated` (and other dropped-connection errors) is retryable **and** continue-recoverable. xAI often RST the stream instead of returning 401/403; the previous path treated that as a fatal `provider_error` and waited for a typed `continue`. Forge now force-refreshes OAuth and retries in-loop (`FORGE_PROVIDER_DROP_RECOVERY_MAX`, default 5). If the loop still throws while ULW is armed, REPL/`forge run` auto-resumes the same transcript (`FORGE_ULW_AUTO_CONTINUE_MAX`, default 3; `FORGE_ULW_AUTO_CONTINUE=0` off). |
| **Multi-account failover** | Same-provider accounts: proactive switch on high plan usage / cooldown / dead token; reactive switch on 429/quota; post-switch OAuth refresh; cap via `FORGE_ACCOUNT_SWITCH_MAX` (default 3); stale plan probes (>6h) ignored |
| **Multi-account UX** | `forge accounts status` / `/accounts status` readiness; `clear-cooldown`; doctor surfaces eligible/cooldown; REPL `/accounts switch` hot-swaps live provider token |
| **Sensitive JSON mode** | `auth.json`, `permissions.json`, `preferences.json` written `0600`; `/doctor` flags group/world-readable files; `forge doctor --json` exposes structured `secureFiles` (`exists` / `mode` / `modeOk`) and sets `ok: false` when any `modeOk` is false |
| **Session lock** | REPL and `forge run` acquire `session.lock` via atomic create (`wx` — no two-process read-then-write race); headless **fails closed** on a foreign live lock (exit 1) unless `FORGE_FORCE_SESSION_LOCK=1`; REPL still warns and continues; steal only dead pids (`EPERM` counts as alive) — live holders are never stolen (no TTL), force aside; corrupt lock JSON / invalid pid treated as absent; live pid + invalid `acquiredAt` is still held; release re-verifies ownership immediately before unlink to shrink the read→unlink TOCTOU |
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
| **maxCostUsd** | `max_cost_usd = 0` (default) is **unlimited**; positive values cap session spend *estimate* (`estimateCostUsd`, not a bill). Sources: config / `FORGE_MAX_COST_USD` / `--max-cost` / `/budget`. Hitting the cap sets `hitCostCap` + annotates `finalText` and stamps `lastError.code=max_cost`. Session override via `/budget` (including `0`/`off` = unlimited for this session). Under ULW `cycle=1`, auto-flips to `cycle=0` (LAST) so resume is not stuck |
| **maxTurns + ULW** | Hitting `max_turns` under ULW CONTINUE also flips to LAST (`maybeFlipUlwToLastOnSafetyValve`) |
| **Continue-cap + ULW** | `releasedOnContinueCap` under ULW CONTINUE also flips to LAST (same helper) so length/Stop-block caps do not leave the session stuck |
| **Handoff guard** | Premature “let me know if…” / “shall I continue?” yields blocked under ULW/goal/open todos (and hard continue-asks always). Cap `FORGE_HANDOFF_BLOCK_CAP` (default 3) releases + stamps `lastError.code=handoff_released` |
| **Proof-claim guard** | “tests pass” / “all green” / bare “Done.”·“Fixed.”·“Ready to merge.” (after edits) without a *successful* structural check (`verificationPassed`) blocked once when work is in flight. Failed check runs still count as ULW `verificationRan` (execution) but do not satisfy proof-claim. Cap `FORGE_PROOF_CLAIM_BLOCK_CAP` (default 1) releases + stamps `lastError.code=proof_claim_released`. Terminal `**Goal achieved.**` / `**Cycle complete.**` attestations are never bounced | · advisory Q&A softens bare Done./Fixed. closers · reanchor includes free six-question self-audit checklist · silent edits-without-verify free-triage block outside ULW/goal
| **Last-verification trail** | Successful structural bash checks stamp `session.meta.lastVerificationCommand` + `lastVerificationAt` (fork/export/import preserve; `/clear` resets). Failed re-runs clear the trail. `lastEditAt` stamps on file edits; when edits land after verify, surfaces mark `⚠ stale (edits after verify)` (prompt `✓~`). Surfaced on resume/`/status`/`/stats`/`/share`/`/done`/`/export`/sessions list `✓`/`✓~`/JSON/notify. `/commit do` + `/done` warn when edits lack a recorded check; `forge run --json` adds `editsWithoutVerification` / `staleLastVerification` productionWarnings |
| **ULW wave proof** | Wave-ledger proof and proof-demand prefer `verificationPassed` (successful check). Proof-demand reanchor names preferred project checks. Failed runs still increment execution counters but do not clear proofDemands |
| **Soft TodoGate** | Outside ULW, open todos block Stop once per prompt (`FORGE_TODO_SOFT_OUTSIDE_ULW=0` disables) | · advisory Q&A releases Stop block + skips TodoNudge
| **Desktop notify** | `/notify on` / `FORGE_NOTIFY=1` — opt-in OS notification on turn end (with BEL via `maybeTurnEndAttention`) |
| **Interjection context** | Mid-run free-text includes active ULW/goal/todos/plan so steering does not drop the mandate |
| **finishReason** | Last provider `finish_reason` on `LoopResult` / headless JSON (`stop`, `length`, `content_filter`, `tool_calls`, …) or `null` if no model turn; mid-run catch adds `reason=error\|timeout\|aborted` |
| **Headless SIGINT/SIGTERM** | `forge run` aborts the in-flight loop cleanly (exit 130 when aborted) |
| **Headless session resume** | `forge run … --session <id>` continues a prior headless/REPL session (multi-step CI) |
| **`--continue` fail-closed** | Explicit `--continue` with no same-cwd session (or all foreign-locked) exits 1 with `continue_miss` / `continue_locked` — never silently starts fresh under CI |
| **`session_not_found` suggestions** | `--json` miss payloads include structured `suggestions[]` `{id,title,path,relativeAge}` (title typo + id prefix recovery) |
| **`continue_miss` suggestions** | `--continue` JSON failures include recent same-cwd `suggestions[]` so CI can pick `--session` without a second list call |
| **`forgeHome` / `sessionPath` JSON** | Support-bundle fields on `run`/`doctor`/`status`/`config`/`auth`/`sessions *` JSON for ops without scraping paths |
| **`run --json` ok vs exit** | `ok:false` on empty/no-turn runs (aligned with exit 1; whitespace-only finalText counts as empty; includes `error` + `reason=empty_run`) |
| **Session preflight hygiene** | Bare `--session`/`--continue` resolve before auth for structured reasons, but never apply `--title` until authenticated |
| **`forge news` newest-first** | Long release sections show bullets from the top of the active `###` (prepend convention) |
| **Empty CLI flags** | Empty `--cwd`/`--title`/`--goal`/`--query`/`--deny`/`--allow`/`--ask`, `logout -p ''`, and `status --cwd ''` fail closed with structured `invalid_*` (never silent no-ops that clear all creds or list everything) |
| **Blocking Stop fail-closed** | Stop/SubagentStop hook timeout, spawn error, non-zero/signal exit, and HTTP hook failure all fail closed (agent keeps working) when `blockingStopHooks` is on; hook stdin EPIPE cannot crash the CLI; hook payload `toolInput`/`toolOutput`/`prompt`/`lastAssistantMessage` capped at 20k chars; hook stdout/stderr capped at 64KB (head) without blocking the child; hook timeout kills the whole process group (detached + negative-pid) with TERM→KILL escalation and unref'd timers; malformed hooks dirs never crash startup |
| **Sandbox/provider aliases** | `readonly`/`ro`→`read-only`; `claude`→`anthropic`, `gpt`→`openai`, `gemini`→`google` |
| **Provider switch → default model** | `-p` / `FORGE_PROVIDER` without `-m` / `FORGE_MODEL` selects that provider's `defaultModel` |
| **Doctor `modelInCatalog`** | `doctor --json` includes whether model is in the provider catalog (soft signal; free-form still ok) |

| **CLI unknown option + `--json`** | Commander parse errors emit `{ ok:false, reason:unknown_option }` on stdout |
| **`/permissions dontAsk`** | Interactive menu + tab-complete include CI-safe deny-without-allow mode |
| **`--permission-mode` aliases** | `deny`/`dont-ask`→`dontAsk`, `yolo`→`bypassPermissions`, `accept`→`acceptEdits` |
| **`forge models -p`** | Filter model catalog by provider; empty/invalid provider → `invalid_provider` (parent `-p` merges) |
| **`status --watch --json`** | Single-shot snapshot (no infinite NDJSON hang); human `--watch` still loops until SIGINT |
| **`forge news` / `logs -n` bounds** | News count must be 1–10; logs lines 0 or 1–200 — over-range fails closed (`invalid_count` / `invalid_lines`) |
| **Session title length** | `MAX_SESSION_TITLE_CHARS=200` for `--title` / `sessions title` / `/title` (no silent 72-char truncate) |
| **SSRF bracketed IPv6** | `normalizeIpHost` peels `[::ffff:…]` before `net.isIP` so hex-mapped private literals block correctly |
| **Whitespace tool paths/patterns** | `list_dir`/`grep`/`glob` reject whitespace-only path; grep/glob reject whitespace-only pattern |

| **Headless wall-clock** | Optional `FORGE_MAX_RUN_MS` aborts the run (exit 124; JSON `timedOut: true`). `--max-turns` / `FORGE_MAX_TURNS` is a soft cap (`hitMaxTurns: true`, still `ok` unless empty/abort/timeout) |
| **Bash abort** | Sandbox/`runRaw` children receive SIGTERM on turn abort |
| **Bash file:// deny** | `curl`/`wget` `file://` local fetches hard-denied (use `read_file`) |
| **Bash IMDS deny** | `curl`/`wget`/python/node one-liners to link-local cloud metadata (`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`) hard-denied |
| **Web tool abort** | `web_fetch` / `web_search` merge turn signal + timeout so Ctrl+C / `FORGE_MAX_RUN_MS` cancel in-flight HTTP; bodies stream-capped (`web_fetch` 5 MiB, search HTML 2 MiB) so missing Content-Length cannot OOM |
| **Child output caps** | Sandboxed and `profile=off` bash cap accumulated stdout/stderr at 4 MB then kill (mirrors the exec fallback `maxBuffer`); `grep` (rg) caps at 4 MB — a runaway `yes` / log-spewing build cannot OOM the CLI |
| **read_file streaming** | Files > 2 MB are read via a chunked window (offset/limit) with long-line guards and a 1M-char collect cap — multi-GB logs no longer load whole into memory |
| **grep abort** | `grep` honors turn `AbortSignal` (kills `rg` / stops JS fallback); rg path resolved once per process |
| **Abort hygiene** | Cooperative `Aborted` tool results do not count toward error-streak; loop asserts abort immediately after tool batches |
| **Background task teardown** | REPL exit and headless `forge run` end force-kill in-process `background=true` shells; `beforeExit`/`exit` safety net; SessionEnd runs before kill so hooks can observe tasks |
| **Parallel reads** | Up to 8 consecutive read-only tools run in parallel; results stay ordered |

## Operator env knobs

| Variable | Default | Purpose |
|---|---|---|
| `FORGE_PROVIDER_TIMEOUT_MS` | `10m` / `600000` | Provider **stall** silence budget (ms or `5m`/`10m`); resets on each stream chunk. Raise if first-token thinking often exceeds this with no bytes yet |
| `FORGE_PROVIDER_MAX_MS` | off (`0`) | Optional absolute wall-clock ceiling for one provider call (stall resets do not extend it); e.g. `2h` for hard unattended caps |
| `FORGE_BASH_TIMEOUT_MS (ms or 90s/2m)` | `120000` | Default foreground `bash` timeout (min 5s, max 30m) |
| `FORGE_BASH_BG_TIMEOUT_MS` | `1800000` | Default background task timeout (min 30s, max 6h) |
| `FORGE_MAX_RUN_MS` | off | Headless `forge run` wall-clock cap (ms or `30m`; exit 124) |
| `FORGE_PERMISSION_TIMEOUT_MS` | off | Auto-deny stalled interactive Allow? prompts (min 5s). Alias: `FORGE_PERMISSION_ASK_TIMEOUT_MS` |
| `FORGE_DOOM_LOOP_THRESHOLD` | `3` | Identical tool+args streak before strategy nudge |
| `FORGE_ERROR_STREAK_THRESHOLD` | `5` | Consecutive tool errors before circuit-breaker nudge |
| `FORGE_ULW_MAX_CONTINUES` | `200` | Stop-continue cap while ULW is armed |
| `FORGE_ULW_STUCK_THRESHOLD` | goal config / `5` | ULW stuck-wall blocks before release (`envPositiveInt`; invalid/0 ignored) |
| `FORGE_ADAPTIVE_EFFORT` | on | `0`/`false` disables one-notch reasoning escalation on hard rounds |
| `FORGE_CHECKPOINT_STORE_TOKENS` | `1500000` | Store-token trigger for checkpoint compact (not outbound) |
| `FORGE_CHECKPOINT_STORE_MESSAGES` | `2500` | Store message-count trigger for checkpoint compact |
| `FORGE_REQUEST_PRUNE` | threshold | Default: prune only when outbound estimate ≥ `FORGE_REQUEST_PRUNE_AT` (180k) so xAI can cache the prefix; first clip is sticky. `1`/`true` = every-round prune (legacy; breaks cache). `0`/`false` = never |
| `FORGE_REQUEST_PRUNE_AT` | `180000` | Token estimate that turns append-only off and slims the wire (stay under the 200k 2× card) |
| `FORGE_REQUEST_PRUNE_KEEP_TURNS` | `3` | Newest assistant steps kept verbatim |
| `FORGE_REQUEST_PRUNE_HARD_AGE` | `10` | Older tool results become `[Tool result omitted — too old]` |
| `FORGE_TOOL_CLEAR` | off | `1`/`true` enables in-session stubbing (mutates history) |
| `FORGE_TOOL_CLEAR_KEEP_RECENT` | `10` | Hot tail: most recent non-system messages never cleared |
| `FORGE_TOOL_CLEAR_MIN_CHARS` | `1200` | Only tool bodies larger than this are cleared |
| `FORGE_TOOL_CLEAR_MIN_STALE_BYTES` | `12000` | Minimum net chars a clearing pass must free to apply |
| `FORGE_TOOL_CLEAR_EVERY_TURNS` | `4` | Minimum turns between clearing passes |
| `FORGE_ANTHROPIC_CACHE` | on | `0`/`false` disables Anthropic `cache_control` breakpoints |
| `FORGE_GOAL_STUCK_THRESHOLD` | config `3` | Goal stuck-wall blocks before release (invalid/0 ignored — 0 would never release) |
| `FORGE_FORCE_SESSION_LOCK` | off | Headless: force-steal / continue despite a foreign live `session.lock` |
| `FORGE_ACCOUNT_SWITCH_MAX` | `3` | Max mid-run multi-account switches per agent loop (proactive + quota + auth) |
| `FORGE_AUTH_RECOVERY_MAX` | `20` | Max mid-run OAuth refresh recoveries per agent loop |
| `FORGE_PROVIDER_DROP_RECOVERY_MAX` | `5` | Max in-loop retries after a continue-recoverable drop (`terminated`, empty stream, 5xx) with forced OAuth refresh |
| `FORGE_ULW_AUTO_CONTINUE` | on | `0`/`false` disables ULW auto-resume when a recoverable provider error still escapes the loop |
| `FORGE_ULW_AUTO_COMMIT` | on | `0`/`false` disables local git commits at each ULW wave close and on **Cycle complete.** (never pushes). Commits the dirty tree minus secrets |
| `FORGE_ULW_AUTO_CONTINUE_MAX` | `3` | Max transcript-resume attempts after a drop escapes the loop (unattended ULW only) |
| `FORGE_JSON_COMPACT` | off | Single-line `--json` success payloads (CI log aggregation) |
| `FORGE_LOG_JSON` | off | Structured JSON logs on stderr |
| `FORGE_BELL` | off | `1`/`0` force turn-end terminal BEL (overrides `/bell` preference) |
| `FORGE_NO_AUTO_RESUME` | off | `1` disables interactive same-cwd session auto-resume |
| `FORGE_HOME` | `~/.forge` | Config/session root (tests/CI isolation) |

Invalid numeric values fall back to defaults (never crash the agent). Invalid enum env values (`FORGE_PROVIDER`, `FORGE_PERMISSION_MODE`, `FORGE_SANDBOX*`, `FORGE_READ_OUTSIDE`) are ignored the same way (keep prior/default config).

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


## Subagent worktree land (v0.9+)

`spawn_subagent` general-purpose defaults to `isolation=worktree` when the workspace is a git repo (explore/plan stay in-place; pass `isolation=none` or `FORGE_SUBAGENT_ISOLATION=none` to write the parent). Successful auto-land journals parent pre-images so `/undo` can revert the landed files.
Forge captures the worktree diff (tracked + untracked) and `git apply`s it into the parent
workspace. On conflict the worktree is **kept** with a recovery summary in the tool result.

- `FORGE_SUBAGENT_LAND=auto|keep|discard` (default `auto`; alias `FORGE_WORKTREE_LAND`)
- `FORGE_SUBAGENT_KEEP_WORKTREE=1` forces keep (no apply)
- `FORGE_SUBAGENT_ISOLATION=none|worktree` overrides the implicit general-purpose default
- Aborted/failed subagents skip apply and keep the worktree so work is not lost

## Mid-loop auto-verify nudge

After an edit streak without a fresh green check, the agent loop injects a synthetic
user message (`[Forge harness — verify nudge]`) so the model runs the cheapest project
check without waiting for the user. Cap: 2 nudges per user prompt.

- `FORGE_AUTO_VERIFY_NUDGE=0` disables
- `FORGE_AUTO_VERIFY_EDIT_THRESHOLD` (default `3`)

## Fix-until-green after red checks

When a preferred project check fails, Forge injects a synthetic
`[Forge harness — fix until green]` user message so the model continues
repairing without waiting for the human. Disable with `FORGE_FIX_UNTIL_GREEN=0`.

## Background task completion notify

When a background bash task exits, Forge queues a mid-run interjection
(`[Forge harness — background task …]`) so the agent continues without a poll
loop. Disable with `FORGE_BG_NOTIFY=0`. Prefer `get_task_output wait=` when you
can block; `wait_mode=any|all` (+ optional `task_ids`) waits on several jobs in
one call. If `/notify` (or `FORGE_NOTIFY`) is on, a desktop ping also fires so
you notice a fire-and-forget test/build without watching the transcript.
