# Forge tools (v0.9.5+)

Lessons applied from local open-source trees under `Documents/open source/` (Grok Build, OpenCode, Warp). Safety policy remains in `SAFETY.md`; this doc covers **tool quality**.

## Built-ins

| Tool | Notes |
|------|--------|
| `bash` | OS sandbox + **secret-name env scrub**. `background=true` → `task_id`. Large output: managed truncate under `~/.forge/tool-output/`. Default timeout **120s** fg / **30m** bg (`FORGE_BASH_TIMEOUT_MS` / `FORGE_BASH_BG_TIMEOUT_MS`). REPL exit + headless run end **force-kill** leftover bg shells. |
| `get_task_output` | Poll background task status + tail of stdout/stderr. Omit `task_id` to list active tasks. |
| `kill_task` | SIGTERM/SIGKILL a background task. Omit `task_id` to list active tasks (recover ids). |
| `read_file` | Default **2000 lines**, long-line clip, binary refuse, directory list, path-not-found hints; soft size hint ≥2 MiB. |
| `write_file` / `search_replace` | **realpath** containment; **atomic write** (tmp+rename, auto parent dirs); write notes when parents were created; refuse directory targets clearly; **BOM/CRLF**; exact → line-trimmed → **block-anchor** fuzzy; short diff. Successful ops append pre-images to session **`mutations.jsonl`** (mode `0600`, ~1.5 MiB/body) for file-aware `/undo`. |
| `apply_patch` | Multi-file add/update/delete/move (OpenAI/OpenCode `*** Begin Patch` grammar). Validates all hunks before write; atomic per file; missing update/delete targets get path typo hints; delete/update pre-images journaled for undo. |
| `grep` | Prefers system **ripgrep**; JS fallback if `rg` missing. Missing path → error + hints; single-file path works in both backends. Honors turn abort. Absolute paths outside workspace use the same **external_directory** gate as `read_file`. |
| `glob` / `list_dir` | Standard discovery; missing search root → error + path hints (not a false empty match). File path to `list_dir`/`glob` → **not a directory** (not "not found"). External absolute roots gated like `read_file`. |
| `todo_write` | Session todos. |
| `web_search` | DuckDuckGo Instant Answer (best-effort). Honors turn abort + 15s timeout; HTML scrape capped 2 MiB. |
| `web_fetch` | Public http(s) fetch with **SSRF** guards, redirect re-check, HTML→text (invalid numeric entities never throw), stream body cap **5 MiB**. Merged turn abort signal stays live through body read. |

## Layout

```
src/agent/tools/
  index.ts          # executeTool dispatch
  definitions.ts    # model-facing schemas + usage notes
  bash.ts read.ts write.ts edit.ts apply-patch.ts patch.ts …
  atomic-write.ts   # tmp+rename file writes
  path-util.ts      # realpath containment
  truncate.ts       # managed overflow to disk
  path-hints.ts     # “did you mean?” (substring + edit-distance typos)
  env-policy.ts     # shell env scrub
  edit-match.ts     # exact + line-trimmed
  text.ts           # BOM / CRLF
src/session/
  mutations.ts      # file-aware /undo journal (mutations.jsonl)
```

## Session / expert UX (related)

Not model tools, but production daily-driver surfaces experts use alongside tools:

| Surface | Notes |
|---------|--------|
| `/undo` · `/rewind [n]` · `/retry` | Rewind chat **and** restore journaled file pre-images (OpenCode-inspired) |
| `/init` · `/review` | Guided AGENTS.md bootstrap; scoped code review prompts (OpenCode) |
| `/compact-and` · `/fork-and-compact` | Compact-then-continue; fork then compact (Warp) — fork copies ULW/goal sidecars |
| `/logs` · `forge logs` | Tail sandbox/safety events (`~/.forge/logs/sandbox.jsonl`) — live-safe, no secrets |
| `/config [json]` | Effective config snapshot (timeouts, sandbox, permissions) — never dumps API keys |
| `/title` · `/rename` · `/pin` | Label / protect long-running sessions (live-safe) |
| `/bell [on\|off\|test]` | Optional terminal BEL when a REPL turn ends (`FORGE_BELL` overrides) |
| Bare `forge` | Auto-resumes newest same-cwd session (≤14d); `--new` / `FORGE_NO_AUTO_RESUME=1` for fresh |
| `forge run --session` · `--continue` | Headless multi-step CI resume |
| Session lock | REPL + `forge run` share `session.lock` (HUD `LOCK:<pid>` for foreign holders) |
| `forge doctor --json` | Includes `undoJournal`, `bashTimeoutMs`, `sessionsPinned`, `secureFiles` |

## Deferred (see plan / open-source comparison)

- MCP search+use, subagents, skills, LSP diagnostics, PTY handoff.

## Tests

`tests/tools-quality.test.ts` — edit match, path-hints (typo distance), env scrub, truncation, symlink escape, executeTool I/O.  
`tests/apply-patch.test.ts` — multi-file patch parse/apply, hard-deny paths, atomic write.  
`tests/tools-next.test.ts` — SSRF, web_fetch htmlToText, block-anchor, background tasks.  
`tests/mutations-undo.test.ts` — mutation journal, `/undo` disk restore, `/init` `/review` `/config` `/compact-and`.  
`tests/logs.test.ts` — sandbox log tail.
