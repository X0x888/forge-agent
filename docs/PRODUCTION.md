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
forge auth                   # refresh OAuth if needed
forge auth --json            # CI: {ok,authenticated,active,stored[]} — never tokens
forge login --api-key "$KEY" --json   # CI login (no interactive prompt)
forge logout --json          # CI clear stored creds
eval "$(forge completion bash)"   # optional shell completions
forge sessions prune --keep 50
forge sessions list --cwd .          # filter by workspace (native listSessions cwd)
forge sessions list -q incident      # id/title/last-prompt substring filter
forge sessions list --pinned         # only pin-protected sessions
forge run "fix" --title ci-pipeline-42 --json   # label headless session at create
# empty/whitespace prompts exit 1 before any API call
# REPL: /sessions (same-cwd) · all · pinned · search · /resume <id|title> · /new [title] · /pin
forge sessions show <id|title>       # relative age · files · path · last-turn peek
forge sessions path <id|title>       # print ~/.forge/sessions/<id> (and session.json)
forge sessions export <id> --format json --out ./session.json   # md|json only
forge sessions import ./session.json   # rejects invalid message roles; never inherits pin
forge sessions fork <id>             # fork clears pin (source stays protected)
forge sessions pin <id|title>        # protect from prune · /pin in REPL
forge sessions title <id> my label   # headless relabel (multi-word ok) · /title in REPL
forge prune-tool-output
forge prune-metrics --keep 500
forge stats                  # usage dashboard (runs/tokens/cost/projects)
forge stats --days 7 --json  # CI-friendly windowed counters
forge tips                   # expert cheat sheet
forge news                   # what's new from packaged CHANGELOG
forge news 2 --json          # last 2 releases as JSON
forge logs                   # tail sandbox/safety events (incident triage)
forge logs -n 50 --json      # machine-readable safety log
forge config --json          # effective config snapshot (no secrets)
forge run "next" --continue --json   # headless same-cwd resume (no session id)
forge "next" --continue              # bare headless same-cwd resume (parity)
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
  "provider": "xai",
  "model": "grok-4.5",
  "auth": "xai via …",
  "authenticated": true,
  "blockingStop": true,
  "permissionMode": "default",
  "sandbox": "workspace",
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
  "report": "…full text report…"
}
```

Exit code `1` when `ok` is false (still prints JSON first). Thresholds reflect env knobs (`FORGE_DOOM_LOOP_THRESHOLD`, etc.).

**CI `ok` contract** (structured — never parse chalk `report` text):

- `ok === false` when `issues` is non-empty (auth missing, insecure modes, Blocking Stop OFF, Node &lt; 20, …)
- `ok === false` when any `secureFiles.*.modeOk` is `false`
- `ok === false` when `blockingStop` is `false` or `authenticated` is `false`
- Prefer `issues[]` + structured fields over regex on `report`

## Auth

| Prefer | When |
|---|---|
| Env API key (`XAI_API_KEY`, …) | CI / ephemeral runners |
| `forge login --from-grok` | SuperGrok subscription reuse |
| `forge login --oauth` / `--device` | Interactive / headless OAuth |

- `auth.json`, `permissions.json`, and `preferences.json` must be mode `0600` (doctor flags otherwise)
- Long sessions: OAuth refresh runs at start and once on mid-run `401`

## Safety defaults (do not weaken lightly)

- `blocking_stop_hooks = true`
- Headless / `forge run` → fail-closed permissions (`FORGE_HEADLESS=1`)
- Sandbox `workspace` + `fail-closed` missing backend
- Project `.forge/config.toml` cannot set YOLO / turn sandbox off / redirect credentials

## CI headless

```bash
export XAI_API_KEY=…
export FORGE_LOG_JSON=1
forge run "fix tests and open a PR description" \
  --permission-mode acceptEdits \
  --sandbox workspace \
  --json
# Resume a prior headless session (multi-step CI pipelines):
# forge run "continue from last failure" --session <id> --json
# session.lock: headless exits 1 if another live process holds the lock
# (set FORGE_FORCE_SESSION_LOCK=1 only when you intentionally share a session id)
# Exit codes: 0 ok · 1 error/empty/locked · 124 FORGE_MAX_RUN_MS · 130 abort (SIGINT)
# Optional: FORGE_MAX_RUN_MS=1800000  # 30m wall-clock cap for CI
# Optional interactive: FORGE_PERMISSION_TIMEOUT_MS=120000  # auto-deny stalled Allow? prompts
# Optional tuning: FORGE_DOOM_LOOP_THRESHOLD=4 FORGE_ERROR_STREAK_THRESHOLD=8
# Optional ULW: FORGE_ULW_MAX_CONTINUES=300
```

### `forge run --json` / bare `forge "…" --json` success shape

Same payload for `forge run "…" --json` and bare `forge "…" --json` (parent `--json` forces headless even on a TTY). Early failures share `reason=empty_prompt|unauthenticated|session_not_found|locked|…`.

```json
{
  "ok": true,
  "sessionId": "…",
  "title": "ci-pipeline-42",
  "finalText": "…",
  "turns": 12,
  "stopContinues": 2,
  "releasedOnContinueCap": false,
  "hitMaxTurns": false,
  "finishReason": "stop",
  "editCount": 4,
  "aborted": false,
  "timedOut": false,
  "promptTokens": 1000,
  "completionTokens": 500,
  "durationMs": 12345,
  "model": "grok-4.5",
  "provider": "xai"
}
```

`releasedOnContinueCap: true` means the shared stop-continue safety valve fired (length / content_filter / empty / Stop-block cap). `hitMaxTurns: true` means the loop exited on `max_turns` (not a clean Stop). Both stay `ok: true` unless aborted/timed out, so CI can alert without hard-failing. `finishReason` is the last provider `finish_reason` (e.g. `stop`, `length`, `content_filter`, `tool_calls`) or `null` if no model turn completed. Mid-run catch failures include `reason=error|timeout|aborted`.

Each headless/REPL turn also appends a counter-only line to `~/.forge/metrics.jsonl` (no prompts or secrets).

On thrown errors with `--json`, stdout is `{ "ok": false, "reason": "error"|"timeout"|"aborted", "error": "…", "timedOut", "aborted", "sessionId", "title", "editCount", "durationMs" }` and the process exits `1` (or `124` if `timedOut`).

Early failures (before the agent loop) also emit structured JSON when `--json` is set:

| `reason` | When |
|---|---|
| `empty_prompt` | Whitespace-only / missing prompt |
| `unauthenticated` | No API key / OAuth |
| `session_not_found` | `--session` id/title miss |
| `locked` | Foreign live `session.lock` (unless `FORGE_FORCE_SESSION_LOCK=1`) |
| `invalid_effort` | `--effort` / `--reasoning-effort` not `low|medium|high` |
| `invalid_permission_mode` | `--permission-mode` not in allowlist |
| `invalid_sandbox` / `invalid_sandbox_network` / `invalid_sandbox_missing` | sandbox CLI flags not in allowlist |
| `invalid_provider` | `--provider` not `xai|anthropic|openai|openrouter|google|custom` (`grok` → `xai`) |
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
- Provider timeout: `FORGE_PROVIDER_TIMEOUT_MS` (default 300000)
- Context overflow: harness force-compacts once and re-issues; if still too large, start `/new` or raise `context_window`

## Reliability contract

See [RELIABILITY.md](./RELIABILITY.md) for Retry-After, abort, JSON repair, doom-loop, orphan tool heal, etc.

## Non-negotiables

1. Blocking Stop defaults **on**
2. Goal stuck-wall can always release
3. Sensitive JSON under `~/.forge` mode **0600** (`auth.json`, `permissions.json`, `preferences.json`)
