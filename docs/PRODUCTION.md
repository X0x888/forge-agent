# Forge production checklist (experts)

Use this before putting Forge on a critical path (CI, shared machines, long ULW runs).

## Install & health

```bash
./install.sh                 # Node 20+, build, npm link
npm run check                # typecheck + full test suite
npm run smoke                # build + CLI binary smoke
npm run ci                   # check + smoke (GitHub Actions)
forge doctor                 # human report (exit 1 if issues)
forge doctor --json          # CI: structured JSON + exit 1 if unhealthy
forge doctor --json --sandbox off --read-outside allow  # what-if production risk scan
forge config --json --sandbox strict --read-outside deny  # effective snapshot what-if
# forge run --json also includes productionWarnings[] for sandbox=off / yolo / read-outside=allow
# sessions export --json → { ok, id, format, body }; import accepts that envelope file (unwraps body)
# FORGE_JSON_COMPACT=1       # single-line --json success payloads (log aggregation)
FORGE_READ_OUTSIDE=deny    # CI: hard-deny absolute reads outside workspace
FORGE_SANDBOX_MISSING_BACKEND=fail-closed  # default; never silent unsandboxed bash
forge models -p xai --json   # filter catalog; empty/invalid -p → invalid_provider
# aliases: -p claude|gpt|gemini · --sandbox readonly|ro · --permission-mode deny|yolo
forge status --watch --json # single-shot (no hang); omit --json for live TTY loop
forge login                  # SuperGrok OIDC (browser) · --device · --from-grok · --api-key
forge auth                   # status + refresh OAuth if needed
forge auth --json            # CI: {ok,authenticated,active,stored[]} — never tokens; ok:false + exit 1 when unauthenticated
forge login --api-key "$KEY" --json   # CI login (no interactive prompt)
forge logout --json          # CI clear stored creds
eval "$(forge completion bash)"   # optional shell completions
forge sessions prune --keep 50
forge sessions list --cwd .          # filter by workspace (native listSessions cwd)
forge sessions list -q incident      # id/title/last-prompt substring filter
forge sessions search incident       # same filter (parity with /sessions search)
forge sessions list --pinned         # only pin-protected sessions
forge run "fix" --title ci-pipeline-42 --json   # label headless session at create
# run --json includes sessionPath (~/.forge/sessions/<id>) for support bundles
# empty/whitespace prompts exit 1 before any API call
# REPL: /sessions (same-cwd) · all · pinned · search · /resume <id|title> · /new [title] · /pin
forge sessions show <id|title>       # relative age · files · path · last-turn peek
forge sessions path <id|title>       # print ~/.forge/sessions/<id> (and session.json)
forge sessions export <id> --format json --out ./session.json   # md|json; file mode 0600
forge sessions export <id> --format json --json                 # envelope { ok, id, format, body }
forge sessions import ./session.json   # accepts export --json envelope (json body); rejects md envelopes; never inherits pin
forge sessions fork <id>             # fork clears pin (source stays protected)
forge sessions pin <id|title>        # protect from prune · /pin in REPL
forge sessions title <id> my label   # headless relabel (multi-word ok) · /title in REPL
forge prune-tool-output
forge prune-metrics --keep 500
forge stats                  # usage dashboard (runs/tokens/cost/projects)
forge stats --days 7 --json  # also: week|month|today|all
forge tips                   # expert cheat sheet
forge tips --json            # { ok, tips } for CI/docs
forge init --json            # bootstrap config/hooks/AGENTS.md (structured wrote/existed)
forge completion bash --json # { ok, shell, script } · unknown shell → invalid_shell
forge news                   # what's new from packaged CHANGELOG
forge news all                # up to 10 recent releases (also full|max)
forge news 2 --json          # last 2 releases as JSON
forge logs                   # tail sandbox/safety events (incident triage)
forge logs -n 50 --json      # machine-readable safety log
forge config --json          # effective config snapshot (no secrets)
forge run "next" --continue --json   # headless same-cwd resume (fail-closed if none)
forge "next" --continue              # bare headless same-cwd resume (parity; fail-closed)
forge "next" --json                  # bare headless JSON (same payload as forge run --json)
# REPL: /share · /files · /pin · /stats · /tips · /news · /retry [prompt] · /last [n]
# REPL: /undo [n] · /init · /review · /compact-and · /fork-and-compact · /logs [n|path] · /config [json]
# Resume (bare forge / /resume) peeks last turn + mutated files
# Optional: FORGE_BASH_TIMEOUT_MS=600000 for long test suites
```

CI (GitHub Actions) runs `npm run check` + `npm run smoke` on Node 20 and 22.

### `forge doctor --json` shape

```json
{
  "ok": true,
  "version": "0.9.5",
  "node": "v22.0.0",
  "forgeHome": "/home/runner/.forge",
  "provider": "xai",
  "model": "grok-4.5",
  "auth": "xai via …",
  "authenticated": true,
  "blockingStop": true,
  "modelInCatalog": true,
  "permissionMode": "default",
  "sandbox": "workspace",
  "sandboxNetwork": "unrestricted",
  "sandboxMissingBackend": "fail-closed",
  "readOutsideWorkspace": "ask",
  "stickyProvider": null,
  "denyRules": 10,
  "allowRules": 0,
  "askRules": 0,
  "maxTurns": 0,
  "maxTurnsUnlimited": true,
  "sessionCount": 3,
  "sessionsLocked": 0,
  "sessionsPinned": 1,
  "toolOutput": { "files": 2, "bytes": 12345 },
  "sandboxLog": { "bytes": 4096, "backupBytes": 0 },
  "metrics": { "events": 12, "bytes": 4096 },
  "undoJournal": { "sessions": 2, "bytes": 8192, "entries": 14 },
  "backgroundTasks": { "running": 0, "total": 0 },
  "savedAllows": 0,
  "secureFiles": {
    "auth": { "exists": true, "mode": "600", "modeOk": true },
    "permissions": { "exists": false, "mode": null, "modeOk": null },
    "preferences": { "exists": true, "mode": "600", "modeOk": true }
  },
  "issues": [],
  "providerTimeoutMs": 300000,
  "bashTimeoutMs": 120000,
  "bashBackgroundTimeoutMs": 1800000,
  "maxRunMs": null,
  "permissionAskTimeoutMs": null,
  "doomLoopThreshold": 3,
  "errorStreakThreshold": 5,
  "ulwMaxContinues": 200,
  "bellOnTurnEnd": false,
  "autoResume": true,
  "node": "v22.x.x",
  "packageEnginesNode": ">=20",
  "report": "…full text report…"
}
```

Exit code `1` when `ok` is false (still prints JSON first). Thresholds reflect env knobs (`FORGE_DOOM_LOOP_THRESHOLD`, etc.).

**CI `ok` contract** (structured — never parse chalk `report` text):

- `ok === false` when `issues` is non-empty (auth missing, `bypassPermissions`/yolo, `sandbox=off`, `sandbox-missing=fallback`, `read-outside=allow`; prefer `--read-outside deny` in CI, Blocking Stop OFF, Node &lt; 20, …)
- `ok === false` when any `secureFiles.*.modeOk` is `false`
- `ok === false` when `blockingStop` is `false` or `authenticated` is `false`
- Prefer `issues[]` + structured fields over regex on `report`

## Auth

| Prefer | When |
|---|---|
| Env API key (`XAI_API_KEY`, …) | CI / ephemeral runners |
| `forge login` | **Native SuperGrok OIDC** (browser; default for xai) |
| `forge login --device` | SuperGrok device-code (SSH / headless) |
| `forge login --from-grok` | Import live Grok Build `~/.grok` session |
| `forge login --api-key` | API key (CI / multi-day unattended) |

- `auth.json`, `permissions.json`, and `preferences.json` must be mode `0600` (doctor flags otherwise)
- `preferences.json` may store sticky `provider` from `forge login -p` (env/CLI still override)
- Resume (`--session`/`--continue`) authenticates as the **session** provider (sticky login cannot hijack an old chat)
- Long sessions: OAuth refresh runs at start and once on mid-run `401`

## Safety defaults (do not weaken lightly)

- `blocking_stop_hooks = true`
- Headless / `forge run` → fail-closed permissions (`FORGE_HEADLESS=1`)
- Sandbox `workspace` + `fail-closed` missing backend
- Project `.forge/config.toml` cannot set YOLO / turn sandbox off / redirect credentials
- Bash hard-denies cloud IMDS fetches (`169.254.169.254`, GCE metadata host, AWS IPv6 IMDS)

## CI

CLI `--json` success and failure payloads always include `version` (via `emitOkJson` / `emitFailJson`) so matrices can pin behavior per release.
 headless

```bash
export XAI_API_KEY=…
export FORGE_LOG_JSON=1
forge run "fix tests and open a PR description" \
  --permission-mode acceptEdits  # aliases: accept, deny/dont-ask, yolo|dontAsk \
  --sandbox workspace \
  --sandbox-missing fail-closed \
  --read-outside deny \
  --json
# Resume a prior headless session (multi-step CI pipelines):
# forge run "continue from last failure" --session <id> --json
# session.lock: headless exits 1 if another live process holds the lock
# (set FORGE_FORCE_SESSION_LOCK=1 only when you intentionally share a session id)
# Exit codes: 0 ok · 1 error/empty/locked · 124 FORGE_MAX_RUN_MS · 130 abort (SIGINT)
# hitMaxTurns/releasedOnContinueCap stay ok:true (CI alerts via JSON flags; use --max-turns as a soft cap)
# Optional: FORGE_MAX_RUN_MS=30m  # wall-clock cap for CI (ms or 30m/1800s)
# Optional interactive: FORGE_PERMISSION_TIMEOUT_MS=120000  # auto-deny stalled Allow? prompts
# Optional tuning: FORGE_DOOM_LOOP_THRESHOLD=4 FORGE_ERROR_STREAK_THRESHOLD=8
# Optional ULW: FORGE_ULW_MAX_CONTINUES=300
```

### `forge run --json` / bare `forge "…" --json` success shape

Same payload for `forge run "…" --json` and bare `forge "…" --json` (parent `--json` forces headless even on a TTY). Early failures share `reason=empty_prompt · unknown_option|unauthenticated|session_not_found|locked|…`.
Success `ok` is `true` only when the run completed without abort/timeout **and** produced a turn or final text (empty/no-turn runs are `ok:false` with exit 1 — aligned for CI).

```json
{
  "ok": true,
  "version": "0.9.5",
  "node": "v22.0.0",
  "forgeHome": "/home/runner/.forge",
  "sessionId": "…",
  "sessionPath": "/home/runner/.forge/sessions/…",
  "title": "ci-pipeline-42",
  "pinned": false,
  "foreignLock": false,
  "provider": "xai",
  "stickyProvider": null,
  "authMethod": "api_key",
  "model": "grok-4.5",
  "reasoningEffort": "high",
  "cwd": "/path/to/project",
  "git": { "branch": "main", "dirty": false, "changedFiles": 0, "ahead": 0, "behind": 0 },
  "projectLabel": "org/repo",
  "projectHints": ["node", "typescript"],
  "packageName": "forge-agent",
  "packageVersion": "0.9.5",
  "packageEnginesNode": ">=20",
  "permissionMode": "acceptEdits",
  "sandbox": "workspace",
  "sandboxNetwork": "unrestricted",
  "sandboxMissingBackend": "fail-closed",
  "readOutsideWorkspace": "ask",
  "ultrawork": false,
  "ulwCycle": null,
  "ulwWave": null,
  "ulwBlocks": null,
  "ulwMandate": null,
  "ulwSoftPrompt": null,
  "ulwExpandedMandate": null,
  "goalActive": false,
  "goal": null,
  "goalStuckThreshold": 3,
  "goalBlocks": null,
  "goalStuckBlocks": null,
  "goalCriteria": null,
  "denyRules": 0,
  "allowRules": 0,
  "askRules": 0,
  "maxTurns": 0,
  "maxTurnsUnlimited": true,
  "productionWarnings": [],
  "blockingStop": true,
  "maxRunMs": null,
  "providerTimeoutMs": 300000,
  "bashTimeoutMs": 120000,
  "bashBackgroundTimeoutMs": 1800000,
  "permissionAskTimeoutMs": null,
  "doomLoopThreshold": 3,
  "errorStreakThreshold": 5,
  "ulwMaxContinues": 200,
  "finalText": "…",
  "turns": 12,
  "stopContinues": 2,
  "releasedOnContinueCap": false,
  "hitMaxTurns": false,
  "finishReason": "stop",
  "editCount": 4,
  "openTodos": 0,
  "messageCount": 24,
  "aborted": false,
  "timedOut": false,
  "promptTokens": 1000,
  "completionTokens": 500,
  "durationMs": 12345
}
```

`releasedOnContinueCap: true` means the shared stop-continue safety valve fired (length / content_filter / empty / Stop-block cap). `hitMaxTurns: true` means the loop exited on `max_turns` (not a clean Stop). Both stay `ok: true` unless aborted/timed out/empty-run, so CI can alert on caps without hard-failing. `finishReason` is the last provider `finish_reason` (e.g. `stop`, `length`, `content_filter`, `tool_calls`) or `null` if no model turn completed. Mid-run catch failures include `reason=error|timeout|aborted`.

Each headless/REPL turn also appends a counter-only line to `~/.forge/metrics.jsonl` (no prompts or secrets).

On thrown errors with `--json`, stdout is `{ "ok": false, "reason": "error"|"timeout"|"aborted", "error": "…", "timedOut", "aborted", "sessionId", "title", "editCount", "durationMs" }` and the process exits `1` (or `124` if `timedOut`).

Early failures (before the agent loop) also emit structured JSON when `--json` is set:

| `reason` | When |
|---|---|
| `empty_prompt` | Whitespace-only / missing prompt (`hint` recovery) |
| `unknown_option` | Bad CLI flag (`suggestion`/`hint` for typos) |
| `unauthenticated` | No API key / OAuth (`hint` recovery) |
| `session_not_found` | `--session` id/title miss (`suggestions[]` id/title/path) |
| `empty_run` | Run finished with no model turns/finalText (`ok:false`, exit 1, `error` message) |
| `continue_miss` | Explicit `--continue` with no same-cwd session (`suggestions[]` recent) |
| `continue_locked` | Explicit `--continue` but every same-cwd candidate is foreign-locked (`suggestions[]`) |
| `locked` | Foreign live `session.lock` (unless `FORGE_FORCE_SESSION_LOCK=1`; JSON includes `hint`) |
| `invalid_effort` | `--effort` / `--reasoning-effort` not `low|medium|high` |
| `invalid_permission_mode` | `--permission-mode` not in allowlist |
| `invalid_sandbox` / `invalid_sandbox_network` / `invalid_sandbox_missing` | sandbox CLI flags not in allowlist |
| `invalid_provider` | unknown provider (typos suggest e.g. `xai`) |
| `invalid_model` | empty `--model`, or close catalog typo (`grok-45` → `grok-4.5`) |
| `command_typo` | bare `forge sesions` (subcommand typo; suggestion included) |
| `excess_arguments` | nested command footgun e.g. `forge auth logout` / `doctor login` (suggestion+hint) |
| `unknown_session_action` | bad `sessions` verb; top-level names like `login` suggest `forge login` |
| `conflicting_flags` | `--continue --new` or `--session --new` (mutually exclusive) |
| `unknown_session_action` | `forge sessions prun` (action typo; suggestion included) |
| `invalid_base_url` | empty/non-http(s)/unparseable `--base-url` (e.g. `ftp://`, `not-a-url`) |
| `invalid_cwd` | empty/missing/non-directory `--cwd` |
| `invalid_title` | empty `--title` |
| `invalid_deny` / `invalid_allow` / `invalid_ask` | empty permission rule strings; empty `Tool()` invalid |
| `invalid_goal` | empty `--goal` |
| `invalid_query` | empty `sessions list -q` / `--query` |
| `missing_base_url` | `--provider custom` without `--base-url` / `FORGE_BASE_URL` |
| `error` / `timeout` / `aborted` | Mid-run catch (provider throw / `FORGE_MAX_RUN_MS` / signal) |

Label new runs with `forge run … --title <label>` (searchable via `forge sessions list -q`).

## Long ULW / goal runs

- Prefer `/cycle 0` when satisfied (last wave) rather than killing the process
- `forge sessions prune --keep 50` periodically (skips foreign live locks + pinned; reports `skippedLocked` / `skippedPinned`)
- `forge sessions delete <id>` refuses foreign live locks unless `--force`
- `/fork` or `forge sessions fork <id>` before risky experiments (keeps original; fork clears pin)
- `/title "incident-42"` or `forge sessions title <id> incident-42` to label long-running sessions; resume with `/resume incident-42` or `forge --session incident-42`
- `/pin` (or `forge sessions pin <id>`) to protect important sessions from prune; `/sessions pinned` to list them
- `/files` after resume to see paths the agent touched; `/last 3` for recent turns; `/path` (or `forge sessions path`) for the on-disk session dir
- `/bell on` (or `FORGE_BELL=1`) for a terminal BEL when long ULW/goal turns finish
- Bare `forge` resumes the newest same-cwd session (≤14d); skips sessions with a foreign live lock; use `--new` or `FORGE_NO_AUTO_RESUME=1` for a clean slate
- `/resume <id|title>` warns if the target has a foreign live lock (concurrent writers may race); shows last turn + files
- `forge sessions export <id> --format json` for incident artifacts (`--format` must be `md` or `json`; `--out` files mode `0600`)
- `forge sessions <query>` treats unknown first arg as title/id search (same as `-q`)
- `forge sessions import` rejects invalid message roles; on-disk load soft-drops corrupt roles/todos so a bad `session.json` cannot poison the agent loop
- `forge prune-tool-output` if `~/.forge/tool-output` grows large (also auto-pruned)
- Provider timeout: `FORGE_PROVIDER_TIMEOUT_MS` (default 5m; ms or `5m`/`300s`)
- Context overflow: harness force-compacts once and re-issues; if still too large, start `/new` or raise `context_window`

## Reliability contract

See [RELIABILITY.md](./RELIABILITY.md) for Retry-After, abort, JSON repair, doom-loop, orphan tool heal, etc.

## Non-negotiables

1. Blocking Stop defaults **on**
2. Goal stuck-wall can always release
3. Sensitive JSON under `~/.forge` mode **0600** (`auth.json`, `permissions.json`, `preferences.json`)

## Multi-day unattended (production)

Forge is built for long expert sessions. For **true multi-day unattended** runs:

| Auth | Use when |
|------|----------|
| **`XAI_API_KEY` / `forge login --api-key`** | **Recommended** — no expiry, no OIDC refresh dependency |
| SuperGrok OIDC (`forge login`) | Interactive or single jobs shorter than ~one access-token TTL; refresh is best-effort |

Operational checklist:

```bash
export XAI_API_KEY=…                    # preferred for multi-day
# do NOT set FORGE_MAX_RUN_MS unless you want a hard wall-clock kill (exit 124)
forge doctor --json                     # must show authenticated + refresh_token for OIDC
forge run "…" --continue --json \
  --permission-mode acceptEdits \
  --sandbox workspace
```

Reliability for multi-day single process:

- Session locks: live holders are **never** TTL-stolen; lock timestamp refreshed on every save
- REPL refuses concurrent write on live foreign lock (`FORGE_FORCE_SESSION_LOCK=1` override)
- OAuth: proactive refresh ~10m before expiry each model turn; up to `FORGE_AUTH_RECOVERY_MAX` (default 20) mid-run recoveries
- Prefer many `forge run --continue` steps over one multi-day process if using SuperGrok OIDC
