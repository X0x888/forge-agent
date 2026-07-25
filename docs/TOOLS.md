# Forge tools (v0.7+)

Lessons applied from local open-source trees under `Documents/open source/` (Grok Build, OpenCode, Warp). Safety policy remains in `SAFETY.md`; this doc covers **tool quality**.

## Built-ins

| Tool | Notes |
|------|--------|
| `bash` | OS sandbox + **secret-name env scrub**. `background=true` → `task_id`. Large output: managed truncate under `~/.forge/tool-output/`. |
| `get_task_output` | Poll background task status + tail of stdout/stderr. |
| `kill_task` | SIGTERM/SIGKILL a background task. |
| `read_file` | Default **2000 lines**, long-line clip, binary refuse, directory list, path-not-found hints. |
| `write_file` / `search_replace` | **realpath** containment; **atomic write** (tmp+rename); **BOM/CRLF**; exact → line-trimmed → **block-anchor** fuzzy; short diff. |
| `apply_patch` | Multi-file add/update/delete/move (OpenAI/OpenCode `*** Begin Patch` grammar). Validates all hunks before write; atomic per file. |
| `grep` | Prefers system **ripgrep**; JS fallback if `rg` missing. |
| `glob` / `list_dir` | Standard discovery; list_dir hints on miss. |
| `todo_write` | Session todos. |
| `web_search` | DuckDuckGo Instant Answer (best-effort). |
| `web_fetch` | Public http(s) fetch with **SSRF** guards, redirect re-check, HTML→text, size/timeout caps. |

## Layout

```
src/agent/tools/
  index.ts          # executeTool dispatch
  definitions.ts    # model-facing schemas + usage notes
  bash.ts read.ts write.ts edit.ts apply-patch.ts patch.ts …
  atomic-write.ts   # tmp+rename file writes
  path-util.ts      # realpath containment
  truncate.ts       # managed overflow to disk
  path-hints.ts     # “did you mean?”
  env-policy.ts     # shell env scrub
  edit-match.ts     # exact + line-trimmed
  text.ts           # BOM / CRLF
```

## Session / expert UX (related)

Not model tools, but production daily-driver surfaces experts use alongside tools:

| Surface | Notes |
|---------|--------|
| `/title` · `/rename` | Label long-running sessions in `/sessions` lists (live-safe) |
| `/bell [on\|off\|test]` | Optional terminal BEL when a REPL turn ends (`FORGE_BELL` overrides) |
| Bare `forge` | Auto-resumes newest same-cwd session (≤14d); `--new` / `FORGE_NO_AUTO_RESUME=1` for fresh |
| `forge run --session` | Headless multi-step CI resume (fresh by default) |
| Session lock | REPL + `forge run` share `session.lock` (HUD `LOCK:<pid>` for foreign holders) |

## Deferred (see plan / open-source comparison)

- MCP search+use, subagents, skills, LSP diagnostics, PTY handoff.

## Tests

`tests/tools-quality.test.ts` — edit match, env scrub, truncation, symlink escape, executeTool I/O.  
`tests/apply-patch.test.ts` — multi-file patch parse/apply, hard-deny paths, atomic write.
