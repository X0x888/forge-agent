# Forge tools (v0.9.5+)

Lessons applied from local open-source trees under `Documents/open source/` (Grok Build, OpenCode, Warp). Safety policy remains in `SAFETY.md`; this doc covers **tool quality**.

## Built-ins

| Tool | Notes |
|------|--------|
| `bash` | OS sandbox + **secret-name env scrub** (`*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*`/`*CREDENTIAL*` **and** connection strings: `DATABASE_URL`, `*_URI`, `CONNECTION_STRING`, `MYSQL_PWD`, `PGPASSFILE`, …). Whitespace-only command fails closed; invalid `timeout_ms` fails closed. `background=true` → `task_id` (+ `timeout_ms`). Large output: managed truncate under `~/.forge/tool-output/`. Default timeout **120s** fg / **30m** bg (`FORGE_BASH_TIMEOUT_MS` / `FORGE_BASH_BG_TIMEOUT_MS`). Non-zero exits always include `[exit code N]`; timeouts use exit **124** + duration. REPL exit + headless run end **force-kill** leftover bg shells. On non-zero exit: wrong Node package manager tip (`pnpm` vs `npm`), missing-script tip (available `package.json` scripts), missing-binary tip (`tsc`/`eslint`/`turbo`/… → project check or `npx`/`pnpm dlx`), missing-`node_modules` tip (`Cannot find module` → `pnpm/npm install`), monorepo layout tip (workspace/importer errors → monorepo root), and next-check tip when a verification command fails. |
| `get_task_output` | Poll background task status + tail of stdout/stderr. Omit `task_id` to list active tasks. Unknown ids suggest prefix/typo matches. Invalid `tail`/`stream` fail closed. |
| `kill_task` | SIGTERM/SIGKILL a background task. Omit `task_id` to list active tasks (recover ids). Unknown ids suggest matches. |
| `read_file` | Default **2000 lines**, long-line clip, binary refuse, directory list, path-not-found hints; soft size hint ≥2 MiB; **past-EOF** offset is explicit (not empty-file). |
| `write_file` / `search_replace` | **realpath** containment; **atomic write** (tmp+rename, auto parent dirs); write notes when parents were created; refuse directory targets clearly; **BOM/CRLF**; exact → line-trimmed → **block-anchor** fuzzy; short diff; **multi-match line numbers** + content-miss closest-line hints. **Auto-strips** pasted `read_file` line prefixes (`   12|code`) from old/new_string. Successful ops append pre-images to session **`mutations.jsonl`** (mode `0600`, ~1.5 MiB/body) for file-aware `/undo`. **Agent loop:** require prior `read_file` + refuse stale mtime/size (`FORGE_FILE_READ_GUARD=0` off). |
| `apply_patch` | Multi-file add/update/delete/move (OpenAI/OpenCode `*** Begin Patch` grammar). Validates all hunks before write; atomic per file; missing update/delete targets get path typo hints; delete/update pre-images journaled for undo. Same unread/stale guard as edit/write in the agent loop. |
| `grep` | Prefers system **ripgrep**; JS fallback if `rg` missing. Missing path → error + hints; single-file path works in both backends. Empty results include pattern/path + tips. Invalid `head_limit` fails closed. Honors turn abort. Absolute paths outside workspace use the same **external_directory** gate as `read_file`. Whitespace-only `path` → `path is required`. Whitespace-only `pattern` → `pattern is required`.|
| `glob` / `list_dir` | Standard discovery; missing search root → error + path hints (not a false empty match). Empty glob includes pattern/path + tips; empty dirs name the path. File path to `list_dir`/`glob` → **not a directory** (not "not found"). Whitespace-only `path` → `path is required` (parity with read/write). External absolute roots gated like `read_file`. |
| `todo_write` | Session todos. Validates id/content/status; `merge:true` + `[]` is a no-op warning; failures are tool errors. |
| `web_search` | DuckDuckGo Instant Answer (best-effort). Honors turn abort + 15s timeout; HTML scrape capped 2 MiB. Invalid `num_results` fails closed. |
| `web_fetch` | Public http(s) fetch with **SSRF** guards (hex IPv4-mapped `::ffff:7f00:1`; weird IPv4 `2130706433`/`0x7f000001`/`127.1`; bracketed IPv6 hostnames peeled), redirect re-check, HTML→text (invalid numeric entities never throw), stream body cap **5 MiB**. Invalid `format`/`timeout_ms` fail closed. Merged turn abort signal stays live through body read. **`allow_local`** is not a free read-only tool (headless/dontAsk/plan need allow rule / pattern-always / YOLO / interactive approval; session-tool alone is not enough). |

## Name aliases

Models sometimes emit OpenCode/Claude-style names. Forge accepts common aliases and maps them to canonical tools:

| Alias | Canonical |
|-------|-----------|
| `Shell`, `Bash`, `shell`, `run_terminal_command` | `bash` |
| `Read`, `read` | `read_file` |
| `Write`, `write` | `write_file` |
| `Edit`, `edit`, `StrReplace` | `search_replace` |
| `Grep` / `Glob` / `ListDir` / `WebSearch` / `WebFetch` / `ApplyPatch` | same lowercase snake or existing cases |

Unknown tool names return **Did you mean?** plus the available list.

## Layout

```
src/agent/tools/
  index.ts          # executeTool dispatch
  definitions.ts    # model-facing schemas + usage notes
  bash.ts read.ts write.ts edit.ts apply-patch.ts patch.ts …
  atomic-write.ts   # tmp+rename file writes
  file-read-state.ts # session stale/unread edit guard
  path-util.ts      # realpath containment
  truncate.ts       # managed overflow to disk
  path-hints.ts     # “did you mean?” (substring + edit-distance typos)
  env-policy.ts     # shell env scrub
  edit-match.ts     # exact + line-trimmed + multi-match locs + miss hints
  text.ts           # BOM / CRLF
src/util/
  project-intel.ts  # package manager + preferred checks + monorepo walk-up
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
