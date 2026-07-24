# Forge production checklist (experts)

Use this before putting Forge on a critical path (CI, shared machines, long ULW runs).

## Install & health

```bash
./install.sh                 # Node 20+, build, npm link
npm run check                # typecheck + full test suite
npm run smoke                # build + CLI binary smoke
npm run ci                   # check + smoke (GitHub Actions)
forge doctor                 # human report
forge doctor --json          # CI: exit 1 if unhealthy
forge auth                   # refresh OAuth if needed
eval "$(forge completion bash)"   # optional shell completions
forge sessions prune --keep 50
forge prune-tool-output
```

CI (GitHub Actions) runs `npm run check` + `npm run smoke` on Node 20 and 22.

### `forge doctor --json` shape

```json
{
  "ok": true,
  "version": "0.9.0",
  "provider": "xai",
  "model": "grok-4.5",
  "auth": "xai via …",
  "authenticated": true,
  "blockingStop": true,
  "permissionMode": "default",
  "sandbox": "workspace",
  "sessionCount": 3,
  "toolOutput": { "files": 2, "bytes": 12345 },
  "sandboxLog": { "bytes": 4096, "backupBytes": 0 },
  "node": "v22.x.x",
  "report": "…full text report…"
}
```

Exit code `1` when `ok` is false (still prints JSON first).

## Auth

| Prefer | When |
|---|---|
| Env API key (`XAI_API_KEY`, …) | CI / ephemeral runners |
| `forge login --from-grok` | SuperGrok subscription reuse |
| `forge login --oauth` / `--device` | Interactive / headless OAuth |

- `auth.json` must be mode `0600` (doctor flags otherwise)
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
  --json
# Exit codes: 0 ok · 1 error/empty · 124 FORGE_MAX_RUN_MS · 130 abort (SIGINT)
# Optional: FORGE_MAX_RUN_MS=1800000  # 30m wall-clock cap for CI
```

### `forge run --json` success shape

```json
{
  "ok": true,
  "sessionId": "…",
  "finalText": "…",
  "turns": 12,
  "stopContinues": 2,
  "editCount": 4,
  "aborted": false,
  "timedOut": false,
  "promptTokens": 1000,
  "completionTokens": 500,
  "model": "grok-4.5",
  "provider": "xai"
}
```

On thrown errors with `--json`, stdout is `{ "ok": false, "error": "…", "timedOut": false, "sessionId": "…", "editCount": N }` and the process exits `1` (or `124` if `timedOut`).

## Long ULW / goal runs

- Prefer `/cycle 0` when satisfied (last wave) rather than killing the process
- `forge sessions prune --keep 50` periodically
- `forge prune-tool-output` if `~/.forge/tool-output` grows large (also auto-pruned)
- Provider timeout: `FORGE_PROVIDER_TIMEOUT_MS` (default 300000)
- Context overflow: harness force-compacts once and re-issues; if still too large, start `/new` or raise `context_window`

## Reliability contract

See [RELIABILITY.md](./RELIABILITY.md) for Retry-After, abort, JSON repair, doom-loop, orphan tool heal, etc.

## Non-negotiables

1. Blocking Stop defaults **on**
2. Goal stuck-wall can always release
3. Auth files mode **0600**
