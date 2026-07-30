# AGENTS.md — Forge CLI

## What this is

Forge is a TypeScript (Node 20+) AI coding agent CLI. The product differentiator is the **harness**: blocking Stop hooks, Codex-style `/goal`, and ultrawork mode.

## Commands

```bash
npm install
npm run build
npm test
npm run typecheck
npm run dev
```

Binary entry: `src/cli.ts` → `dist/cli.js` (`bin: forge`).

## Layout

- `src/harness/` — hooks, goal, stop-guard (do not weaken blocking Stop defaults)
- `src/agent/` — loop, tools, permissions
- `src/providers/` — LLM clients
- `src/auth/` — multi-account credentials (never log tokens); `accounts.ts` smart switch; auth.json v2
- `src/statusline/` — provider-agnostic HUD (`forge status`); never invent plan metrics
- `src/harness/ulw-cycle.ts` — ULW cycle flag 1/0; optional `maxWaves` cap (auto LAST); soft prompts expand to god-scope; Stop blocks while cycle=1
- `src/harness/context-admit.ts` — mid-conversation harness admissions (stable system + live counters)
- `src/harness/interjection.ts` — free-text mid-run messages (Grok-style `<user_query>`)
- `src/harness/todo-gate.ts` — TodoNudge + TodoGate under ULW
- `src/session/compaction.ts` — structured compact preserving mandate/goal/todos
- `src/agent/sandbox.ts` + `rules.ts` + `shell-parse.ts` — OS sandbox, deny/allow/ask rules, segment-aware shell checks

## Conventions

- ESM only (`"type": "module"`, `.js` extensions in imports)
- Strict TypeScript
- Prefer small focused modules
- Tests: `node:test` via `tsx --test`

## Non-negotiables

1. `blockingStopHooks` defaults to **true** — this is the Grok gap we close. Stop/SubagentStop hook **timeout/error fails closed** (agent keeps working).
2. `/goal` stuck-wall must always be able to release (never infinite trap without progress).
3. Sensitive JSON under `~/.forge` written mode `0600` (`auth.json`, `permissions.json`, `preferences.json`).

## Production reliability (v0.9+)

See `docs/RELIABILITY.md` and `docs/PRODUCTION.md`. Highlights: Retry-After, abortable streams/bash,
stream-capped `web_fetch`/`web_search`, JSON arg repair, CLI `--json` always stamps `version`
(`emitOkJson`/`emitFailJson` include `node`; `FORGE_JSON_COMPACT=1` for single-line success; `forge run --json` includes `productionWarnings[]`), doctor flags yolo/`sandbox=off`, bash IMDS deny, sticky login provider (preferences.json), orphan tool_call heal (load/import +
**re-save** when healed and no foreign lock), doom-loop, error-streak circuit breaker, apply_patch
(path typo hints; directory-target errors), atomic file writes, OAuth refresh (start + mid-run 401),
session locks (headless fail-closed; `FORGE_FORCE_SESSION_LOCK=1` override; live+bad timestamp held),
atomic session tmp recovery, session fork/export/import (export `0600`), headless `forge run
--session`, metrics.jsonl, permission ask timeout, empty-SSE retry, `finish_reason=length` continue (+ content_filter/empty cap hygiene),
`releasedOnContinueCap` / `hitMaxTurns` / `finishReason` / `pinned` / `foreignLock` JSON/metrics + stats `continueCapReleases`/`maxTurnsHits`,
`--max-turns` / `FORGE_MAX_TURNS` / `max_turns=0` unlimited, `forge sessions title`, `forge models -p`, stream usage, `meta.json`
session sidecar, tunable loop guards (`FORGE_DOOM_LOOP_THRESHOLD`, `FORGE_ERROR_STREAK_THRESHOLD`),
interactive same-cwd auto-resume, `/title`, `--title` on `forge`/`forge run`, `/bell` turn-end
attention, background-task teardown on exit, JSON store isolation (`readJsonFile` clones
fallbacks; auth/permissions/preferences mode `0600`), `listSessions({ cwd, query, limit })` +
`forge sessions list --cwd`/`-q`, `/sessions` same-cwd default + search, `forge sessions prune`
(skips foreign locks) / `delete --force`, shell-safe `/diff` (argv + filter allowlist),
external_directory on grep/glob/list_dir, `forge completion`, `forge doctor` / `doctor --json`
(structured `runDoctorCheck` + `issues[]` / `secureFiles`; exit 1 on issues), path-not-found typo
hints, session import/load message-role sanitization, `forge stats` / `/stats`, `/share` handoff (git/goal/ULW), `sessionPath`/`forgeHome` on run/status/doctor JSON, `session_not_found` `suggestions[]`
card, shared `formatExpertTips` (`forge tips`/`/tips`), first-run welcome tip, unknown-slash Did you mean?, CLI `command_typo`/`conflicting_flags`/`invalid_base_url`, `/retry`/`/again`,
`/last [n]`, resume auto-peek, `forge news`/`/news`, `forge run --continue` (fail-closed `continue_miss`/`continue_locked`; empty CLI flags fail closed) / bare `forge --continue` / bare `forge "…" --json`, `forge auth|login|logout --json`, `/done`/`/pause`/
`/unpause`, session `lastUserPreview` list snippets, resume-by-title, relative session ages,
`/files`, `/path` (+ copy), `/pin` + `sessions pin` (fork clears pin; status PIN badge), resume
orientation + `--pinned` list, doctor `sessionsPinned`, session path helpers, sessions show file
snippet, file-aware `/undo` (`mutations.jsonl` pre-images), `/init`, `/review`, `/compact-and`,
`/fork-and-compact`, fork copies ULW/goal sidecars, `/clear`/`/clear hard`/`/new` hygiene, `/logs`
· `forge logs`, `/config` · `forge config`, `/export` mode `0600`, `--read-outside ask|allow|deny`, doctor flags `read-outside=allow` / `sandbox-missing=fallback`, `FORGE_BASH_TIMEOUT_MS` /
`FORGE_BASH_BG_TIMEOUT_MS`, doctor `undoJournal`, `npm run smoke`.
