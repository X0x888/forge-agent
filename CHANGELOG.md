# Changelog

## Unreleased

### Fixed
- **Bash can no longer write `.git/hooks` when `write_file` cannot**: `hardSafetyCheck` only ran disaster regexes on bash, so `printf evil > .git/hooks/pre-commit` / `tee` / `cp` / `bash -c` installed a hook inside the workspace sandbox. Write dests (redirect / tee / touch / cp|mv|ln dest) now use the same `isProtectedWritePath` list as file tools (`.git/hooks`, `.git/config`, `.ssh`, forge auth). `> /dev/null`, project files, `cat` of a hook, and `git config` stay allowed. YOLO / `bypassPermissions` still deny.
- **`/doctor` at › no longer dumps `forge login`**: `formatDoctorCloser` shared one Next for slash `/doctor` and `forge doctor`, so an unauthenticated REPL card lectured `forge login` and leftover issues lectured `forge doctor --json` (same hole `/verify` closed for `npm test`). Default/`surface: "repl"` is slash keys only (`/auth` `/permissions` `/setup` `/status`); `surface: "cli"` keeps the CLI verbs. `/doctor` is repl; `forge doctor` is cli.
- **Tool schema JSON blew the 16k lean budget (16059)**: every model turn ships `TOOL_DEFINITIONS`; `npm test` was 2342 pass / 1 fail (`tests/tools-next.test.ts`). Slimmed bash timeout / memory_write / spawn_subagent / search_replace call-shaping prose — required phrases stay. Now 15244. Not a budget raise.
- **Dead-run stop line at › no longer dumps CLI**: `formatRunStopReason` shared one string for REPL and `forge run`, so abort / cost-cap / empty-run / continue-cap lectured `forge run --continue`, `forge doctor · forge auth`, and `FORGE_*` at the prompt (same hole `/verify` closed for `npm test`). Default/`surface: "repl"` is slash keys only (`/retry` `/budget` `/doctor` `/auth`); `surface: "run"` keeps the CLI verbs. Callers pass the surface; provider Next closers inherit it.
- **`/sessions errors` was empty while doctor counted 60**: `list --errors` / `--untitled` filtered *after* the newest-50 slice, so a stale lastError backlog (subagent `max_turns`, Cursor 400s, …) vanished from the recovery list doctor told you to open. `listSessions` now applies `errors` and `untitled` **before** the limit, same as cwd/query/pinned. Verdict uses the true total; a truncated picker says `showing N newest`.
- **Cursor Grok context is 256k, not xAI's 500k**: Forge treated `cursor-grok-4.6-*` like native grok-4.6, so HUD/compact used 500k and overflowed the host before auto-compact. Route-aware windows now default Cursor Grok 4.5+ to **256k** (Cursor docs; Max context = provider). xAI `grok-4.6` stays 500k. Posture / `/context` / `/context-window` / `/status` / dock show hosted vs native; a pin above the host warns (overflow) and requests Max Mode; a pin below the route default warns unused capacity. `/context-window auto` follows the route so you do not have to pin 256k yourself.
- **Thought-only / reasoning_wall Stop no longer auto-LAST**: a 16h dogfood hit `Reasoned Stop (reasoning_wall)` then `Stop-continue cap (200)` and flipped ULW to LAST (~$201, `harness×282`) without the user asking to stop. Thought-only Stops re-anchor with `tool_choice=required` but do **not** count toward `FORGE_ULW_MAX_CONTINUES`. A consecutive thought-only streak this turn caps at 8 (`FORGE_THOUGHT_ONLY_MAX`; `0`/`off` disables) and ends **the turn only** — ULW stays CONTINUE; `/retry`. Live › `think` elapsed is the current think phase, not the whole turn (so a 16h run is not `think 999m`).

- **Ctrl+C abort no longer hangs on `npm test`**: bash spawned in Forge's process group and waited on `child.on("close")`. Killing the `sh -c` wrapper orphaned `npm test` grandchildren, which kept stdout/stderr pipes open — timeout (3 min) and `Aborting…` never settled (dogfood wave 8, 20h). Foreground bash now gets its own process group; timeout/abort kill `-pid`; settle on `exit` plus a bounded wait. Second Ctrl+C while aborting SIGKILLs in-flight trees and quits. Numeric `timeout_ms` is capped at 30m like `"all"`. `npm test` has a 60s per-test timeout. `runStatusWatch` installs abort before the first tick and does not swallow SIGINT when a signal is passed.

- **ULW sit-down grind + full-suite proof**: same-surface now treats `/verify` `/commit` `/budget` `/checkpoint` `/undo` as one `sit-down-card` class (lexical overlap missed eight waves). Consolidation doctrine: never foreground `npm test` / `npm run ci`. Auto-commit subjects prefer the wave summary over the raw mandate; truncated named-ships (`/commit is ve`) are dropped. Idle heartbeat clears leftover `bash }` phaseDetail. Child sessions that report 0 tokens after N turns estimate from the transcript so the family ledger is not `$0.0000`.

### Changed
- **Doctor + `/sessions errors` glance lastError by class**: the 60-count is now `45 max_turns · 8 bad_request · …` on doctor, the errors card, and `doctor --json` / `sessions list --json` `sessionsLastErrorByCode`. Designed wraps (`ulw_cycle_complete`) stay out. Job: see the class (budget cap vs 429) before pruning or chasing a crash that is not there.
- **`/ulw` Wave 1 is PLAN, then BUILD**: `/plan` and `/build` are the same spine, not a side dish. Every new ULW (not only evaluate-class) starts read-only — writes/spawn denied even under yolo — until a written `Reading:` with a verify command or file path / `exit_plan_mode` / user `/build`. ULW-owned `exit_plan_mode` auto-builds (no `ask_user`, works headless). User `/plan` mid-run is a human pause (does not auto-flip). `/build` skips remaining Wave 1 research. HUD badge `PLAN` while Wave 1 is orient. A chrome catalog is not a plan.

- **`/budget` is the sit-down spend key**: sit-down already showed `budget HIT` + `Next  /budget`. Typing it dumped `FORGE_MAX_COST_USD` / `config.toml` (a lecture). Now opens `budget  ·  HIT` / `ok` / `none`. Designed empty: `none` + `Next  /budget 5`. HIT Next is `/budget off`. One healthy cap: `ok`, no Next. `/budget off` or a raise that leaves the cap not-hit clears `lastError.code=max_cost` so `/retry` can run (a still-HIT set does not). Invalid: `budget  ·  invalid` + `Next  /budget 5`. Live: peek readonly, set/off is control. CLI env/config dumps stay off ›. Job: type the key, unstick the cap.

- **`/checkpoint` is a rewind key**: bare `/checkpoint` opens the card (`checkpoint  ·  none` / `ok`). `/checkpoint snap` takes the snapshot. `/checkpoint restore` rewinds the tree. Designed empty: `none` + `Next  /checkpoint snap`. Error: not a repo / plan / missing sha. Live: peek is readonly, snap/restore are control. Job: type the key, get the tree back.

- **Model fallback is off by default**: a 429/5xx no longer hops grok-4.6 → grok-4.5 → grok-4 (or Cursor `auto` / Composer) in an unattended run. `/fallback on` (or `fallback_models` / `FORGE_FALLBACK_MODELS` / `--fallback-models`) opts in. Every hop must meet **grok-4.5 high**; weaker ids are rejected, not used. Cursor uses wire ids (`cursor-grok-4.5-high`), never Auto. A Cursor-saved chain is unwrapped on xAI/OpenRouter and rebound on `/provider` so a hop cannot send `cursor-grok-*` to the wrong API. Native providers only hop within their own family. Posture / doctor / ULW production warnings no longer treat off as a footgun.

### Added
- **Project memory auto-cleans leftover cycle notes**: this-cycle / this-wave readings and superseded facts (e.g. an old `git stash create` checkpoint note after the temp-index gotcha) auto-archive on session start and when the prompt injects memory. Session banner + doctor name the store and `Next  /memory project`. `/memory project prune` (and `prune dry`) lets you do it yourself. `memory_write scope=project` refuses cycle-scoped text and writes `scope=session` instead. `FORGE_MEMORY_SWEEP=0` disables auto-archive (explicit prune still works). User-written notes are never auto-archived.

- **`/commit` is the close-the-day key**: typing `/commit` used to start a model turn (same hole `/verify` closed for `npm test`). Now opens `commit  ·  N files` / `nothing to commit` with a typeable Next. `/commit do` creates the local commit (never push, no model). Designed empty: `commit  ·  nothing to commit` + `Next  /diff`. Error: `not a repo` / `plan` / hook fail. Stale verify Next is `/verify` · `/commit do`. `/commit draft` keeps the model escape hatch. Live: peek is readonly, `do` is control. After a green `/verify`, Next is `/commit`. Job: type the key, see the tree, ship it.
- **`/auth` is verdict-first**: lastErr auth Next used to `printAuthStatus()` (empty slash output + `forge login` dump). Now opens `auth  ·  none` / `ok` / `N issues` with the same rows as `/accounts`. Already on `/auth` — no circular `Next  /auth`. Alternate ready → `Next  /accounts switch <label>`. Designed empty: `auth  ·  none` (login is not a › key). Job: type the lastErr key, see the slot, switch it.
- **`/done` names the close-the-day Next**: wind-down still flips ULW LAST / goal done, and now opens `done  ·  ok` or `done  ·  N issues` with `Next  /verify` (stale/missing trail) and/or the lastErr sit-down key. Job: do not call it done while the proof is stale.
- **`/share` pasteable card includes a typeable Next**: lastErr no longer dumps `→ forge accounts switch`; missing/stale verify says `/verify`. Closer is `Next  /accounts` / `/verify`. Job: hand someone the session and the key.
- **Auto-verify nudge names `/verify`**: mid-loop edit-streak nudge tells the model to type `/verify`, not paste `npm test` as a prompt. Job: the proof key is one token.
- **`/retry` is verdict-first and refuses a 429 burn**: empty is `retry  ·  nothing to run` + `Next  /status`. lastErr that retry cannot fix (quota / auth / budget) opens `retry  ·  lastErr` + `Next  /accounts` (or `/auth` / `/budget`) and does not forward. Network/timeout still rewinds (`retry  ·  ok`) and clears lastErr. `/accounts switch` clears lastErr so the next `/retry` can run. Job: type the key that fixes the crash.
- **`/sessions errors` is verdict-first with a typeable Next**: empty is `sessions  ·  none` + `Next  /status` (not a lecture). A 429 backlog opens `sessions  ·  N errors` and `Next  /resume 1  ·  /accounts` — pick the broken job, then the sit-down key. Cycle-complete rows stay out. Job: recover the session that died.
- **`/last` names lastErr + a typeable Next**: a 429 session with no edits used to hide the crash behind the conversation. Trailer now opens on `lastErr  [code]` and `Next  /accounts` (or `/auth` / `/retry` / `/verify`) — same sit-down keys, not `forge accounts switch`. Compact peek unchanged. Designed empty: no lastErr → existing files/verify ↳. Job: type `/last`, see what broke, type the key.
- **`/accounts` is verdict-first**: typing the lastErr Next opens `accounts  ·  ok` / `N issues` / `none` (not an Auto-switch dump). REPL closer is `/accounts switch <label>` / `/accounts clear-cooldown` / `/auth` — never `forge accounts switch` at ›. Bare `/accounts switch` shows the card. CLI `forge accounts` keeps forge verbs. Designed empty: `accounts  ·  none` + `/auth`. Job: sit down, switch the other account.
- **lastErr Next is a slash key**: sit-down `/status` / `/resume` and the REPL run-failure closer no longer dump `forge accounts switch` (typing that at › is a model prompt — same hole `/verify` closed for `npm test`). 429/quota → `/accounts`, auth → `/auth`, overflow → `/compact`, unknown → `/retry`. Headless `forge run` keeps CLI verbs. Designed empty: no lastErr → no lastErr Next. Job: sit down, type the Next key.
- **`/verify` is the sit-down Next for the proof trail**: stale / red / missing last-verify now closer `/verify` (not a raw `npm test` that becomes a model prompt). `/verify` runs the last or project check through the same gate + trail stamp as `!cmd`, opens verdict-first (`verify  ·  ok` / `✗`), and refuses non-checks. Designed empty is `verify  ·  nothing to run`. `forge run /verify` exits 1 on red. `/last` and `/diff` name the key when the trail is wrong. Job: sit down, type the Next key, see proof.
- **Sit-down resume is verdict-first**: `forge` auto-resume and `/resume` open on the problem (`lastErr` / budget HIT / stale or missing verify) plus a `Next` closer — same grammar as `/status`. Nothing wrong → the peek (not `resume  ·  ok`). Banner skips the generic `↳ /last · /files · /retry` when Next already named the move. First-run empty stays “Type a task in English.” Job: sit down and see what’s wrong without typing `/status`.
- **Run-failure closer**: a dead run ends on a code-specific `Next` line (same grammar as `/status`), not a generic `Error?` lecture. REPL and `forge run` cards both get it; `formatRunStopReason` now speaks for `rate_limited` / auth / quota / overflow / network / doom-loop instead of going silent. `forge run --json` fail payloads include `next`. Clean Stop stays quiet. Job: a run died — see the next move.
- **Session picker is job-first**: `/sessions`, `/resume`, and `forge sessions list` open on the title (the job), not hex id + age. A `lastError` row opens on the problem (`rate_limited xai HTTP 429`) in red — you see what broke without decoding `ERR`. Untitled still leads with dim `(untitled)`. Empty lists unchanged. Job: pick the conversation you were in, or the one that broke.
- **`/status` is verdict-first**: the card opens on the problem (`lastErr` / budget HIT / ctx HARD / stale or missing verify / served-model drift) plus a `Next` closer, then the HUD + session dump. Nothing wrong → designed empty `status  ·  ok` (not another ✓-preview). Job: see what's wrong without scanning identity first.
- **`/help <word>` searches the catalog**: `/help budget` / `/help spend` / `/help undo` list matching commands instead of `Unknown /help topic`. No matches get a designed empty state (`Try a command word · /help · /help all`). Topic names still route; a close topic typo (`setings`) opens that topic. Not another ✓-preview.
- **First live › steer hint**: one dismissible line when the live prompt first appears (`type to queue · /status · /cycle 0  (no Ctrl+C)`). `/help` Keys names `live › type to queue`. Skipped when ULW already printed the long mid-run wall. Not another ✓-preview.
- **Cursor login + provider**: `forge login --from-cursor` / `forge login -p cursor` imports a local Cursor CLI (`agent login`) / Desktop / `CURSOR_API_KEY` session, then falls back to the same browser poll flow as `agent login`. Chat uses Cursor-hosted models (Composer, Grok, Claude, GPT, Gemini, Auto) against the user's native Cursor quota. Aliases: `cursor-ai` / `cursorai`.
- **Cursor provider completeness**: live `GetUsableModels` catalog (`forge models -p cursor --refresh`), reconnect replays tool turns (not only the open HTTP/2 stream), native-quota HUD cost is `$0`, `.cursor/commands` + `.cursor/skills` load alongside Forge packs, doctor refresh copy is provider-aware.
- **Cursor AgentService model knobs**: live ids **are** variant strings (`cursor-grok-4.6-xhigh-fast`). Bare `grok-4.6` is `not_found`. Unary GetUsableModels uses `application/proto` (Connect 415). Run omits partial `requested_model` (that proto was Connect `internal`). Consecutive user messages (harness context-admit) merge into the action — a user-only historical turn is Connect `internal`. One Connect reader for the life of the Run (tools **and** completed text turns) so the next user is a `conversation_action`; a dead stream rebases with typed `conversation_history`, not chat JSON in `root_prompt_messages_json`. Default **xhigh + Fast**. Aliases: `grok-4.6` / `fable`. An explicit `-high-fast` id stays High. RequestContext now sends `env.workspace_paths` / `process_working_directory` (without that, the model invented a stale Cursor cwd). Exec results send ACM `stream_close` so the server does not sit on heartbeats. Usage comes from `TurnEnded` (`input` / `output` / `cache_read`) so dock `cache N%` is real.
- **`/todos` work board**: grouped ▶/○/✓/× with a next-up header (`2/4 open · ▶ ship it`), designed empty (`Nothing on the board`) and all-done states. Agent ids stay on the model-facing `todo_write` summary, not the human card.
- **Permission ask names the subject**: `⚠ write  src/foo.ts` (path on the title) and bash keeps the command on the hint line so you decide from the header, not the preview dump. Patch asks extract the first `*** Add/Update File`.
- **`/last` recap trailer**: the conversation card now lists mutated files + last verify (stale/✗/✓) and `↳ /diff · /files · /undo`. Empty sessions get `type a task` instead of a bare “no turns”. Compact resume peek is unchanged.
- **`/diff` change-review card**: default `/diff` is a scannable Δ card (colored porcelain, +/−, verify/stale, designed empty state when clean) instead of a raw `status:`/`stat:` dump. `--full` reuses the transcript `formatDiffBlock` palette. `/last` · `/commit` · `/undo` stay one keystroke away.
- **Product quality bar (soul as quality, not persona)**: on user-facing product work (build/evaluate an app, game, or named surface — not generic “improve the ui” chrome, infra, or bugfix), a declared ship must name the hard user job and, after the first wave, include one finished edge (empty / error / first-run). At most one labeled `Serendipity:` per unit; leftover-chrome labeled as serendipity is refused. A preview-only reading is not a plan. Bounce once. Job/next-need/edge harvest onto `decisions.json` (existing `Reading:` notes count). `/cycle status` shows the bar. `/cycle 1`, re-enable, and fork reset the bounce so it cannot stick forever. Harvest never fails Stop.

### Fixed
- **Safety checkpoints rewind, they do not merge**: `/checkpoint` used `git stash create` (tracked dirty only — untracked vanished) and told you `git stash apply` (a 3-way merge, and a model prompt at ›). ULW arm stored the sha on `ulw.json` only, so sit-down `(/checkpoint restore)` said **No checkpoint sha**. Snapshots now use a temp index (`git add -A` + `commit-tree`: untracked in, secrets/fixtures out, worktree untouched). Restore is `git restore --source=<sha>` overwrite + mixed reset — not `stash apply`. Destructive-git auto-checkpoint Next is `/checkpoint restore`. Restore also reads `ulw.checkpointSha` and stamps `session.meta.lastCheckpoint` on ULW arm. Designed empty: clean tree / only secrets. Job: type `/checkpoint restore`, get the files back.

- **Bash writes join the undo journal**: `echo >` / `python -c` / codegen via foreground `bash` (and idle `!cmd`) used to skip `mutations.jsonl`, so `/undo` restored `write_file` but left shell writes on disk. Git porcelain delta around the command journals create/update/delete (pre-bash body when already dirty, HEAD when clean). Designed empty: not a repo / clean tree / no `recordMutation` / background / `FORGE_BASH_MUTATION_JOURNAL=0`. Failed commands that still wrote are journaled. Idle bang is its own turn so `/undo` 1 undoes only that write. `/verify` sets `journal: false` so a check does not become an undo turn or journal test fixtures. Job: type `/undo`, get the tree back.
- **HTTP/2 RST is a dropped connection, not a fatal `provider_error`**: Cursor AgentService `RST_STREAM` (`ERR_HTTP2_STREAM_ERROR` / `Stream closed with error code NGHTTP2_INTERNAL_ERROR`) used to skip `withRetry`, skip drop-recovery backoff, and print `✖ ✖ … [provider_error]`. It is now retryable `network` (same family as undici `terminated`). Reconnect does **not** rotate OAuth (protocol, not a dead token). After same-payload retries fail, drop recovery prunes/compacts history before stuffing `conversation_history` on a new Run. Cursor Connect `internal` HTTP 400 is no longer a permanent halt. Formatted error cards no longer double-prefix `✖`.
- **Cursor dock plan %**: logged-in Cursor sessions probe `GetCurrentPeriodUsage` (included spend %) instead of claiming “no third-party % API”. Fail-open: missing fields stay off the dock; dashboard is still the source of truth if the probe is empty.
- **Cursor native Write is Forge write_file**: AgentService Write/Read/Grep/LS/ShellStream/Pi edit are Cursor Grok’s trained editors. Rejecting them (even with “call write_file, not search_mcp”) made log11 `search_mcp` for write/edit (30s ×2) then `python Path.write_text` — skipping receipts, the read-guard, format-on-write, and the mutation journal. Those execs now map onto Forge tools and return typed results. Native read_result strips `N|` prefixes so they cannot be echoed into files. xAI OpenAI-compat is unchanged.
- **ULW auto-commit skips worktree-land fixtures**: `src/agent/__wt_land_*` from `tests/worktree-land.test.ts` was committed as “Acting on the ULW re-anchor” during Cursor dogfood. Auto-commit drops them; the tests still write under `src/agent/` so `git status -uall` can see them.
- **Successful ULW wrap is not a crash**: `ulw_cycle_complete` stays on session JSON for metrics, but `/status`, `/sessions`, HUD `ERR:`, prune, and `/sessions errors` no longer treat Cycle complete as `lastErr`. Glance after a finished cycle → `status  ·  ok` and a title-first picker row. Stuck-wall / 429 still lead. Job: see that the work ended, not that it broke.
- **Cursor Grok ULW continue is Connect `internal`**: after Wave 1 `turn_ended`, Forge closed the Run and opened a new one with the whole chat stuffed into `ConversationState.root_prompt_messages_json` (system-blob slot) plus the ULW poke as the action — AgentService 400 `internal` (`cursor-grok-4.6-high-fast` dogfood). Completed turns now keep the HTTP/2 Run; the next user / Stop-block is a `conversation_action` on that stream. A dead stream rebases with typed `UserMessageAction.conversation_history` (user/assistant/tool), never chat JSON in field 1 and never invented AgentTurns.
- **Cursor Connect `internal` after a provider-drop retry**: `turn_ended` while MCP results were still pending closed the held-open Run. The next chat() opened a new Run with the dead `conversation_id` and a fake `"(continue)"` user turn — Connect `internal` (dogfood `d87a65f6`, Wave 1 after list_dir). Pending execs keep the stream; a dead stream rebases onto a fresh conversation with a real continue prompt. Tips no longer say “tools/vision” for `internal`.
- **Cursor execs that had no reply hung the Run**: AgentService `mcp_state` (#36), list/read MCP resources, Pi/subagent, unknown exec oneofs, and InteractionQuery (#7) were ignored — the same heartbeat-wait class as missing `stream_close`. Each now gets a typed result or a throw + close. History Runs seed JSON chat messages instead of invented AgentTurns. Parallel mcpArgs are coalesced 40ms so the second tool is not dropped.
- **Cursor harness admit after tools closed the live Run**: evaluate-class context-admit is a user message after MCP results. That folded trailing tools into history, so chat() closed the held-open stream without writing exec results and opened a new Run — Connect `internal` (dogfood `4d3ae067`, ~2m in). Pending execs now resume on the same stream; the admit is a mid-run `conversation_action`. closeLive is identity-checked so an old stream’s `internal` cannot delete the replacement session.
- **Cursor HUD effort matches the variant id**: a leftover global `/effort high` pin (from the previous High Fast default) sat on `cursor-grok-4.6-xhigh-fast`, so the dock showed `·high` while the wire overlaid High Fast. The suffix wins unless `--effort` / config is explicit; `/effort` rewrites the catalog id so they stay one string.
- **Reasoned Stop is Stop, not an empty-continue**: grok-4.6 judge turns that think (or hit the 12-minute no-output wall) and `finish_reason=stop` with no text/tools now run Stop. Unlimited maze dogfoods (`d3fe69aa`, `3eee1159`) spent **62% of a 20h wall** in 59-minute thought then “Do not stop. Act.” True 0-reasoning empties still nudge. `FORGE_PROVIDER_REASONING_WALL_MS` (default 12m, `0`/`off` disables) is independent of stall `touch()`. Thought-only Stop still re-anchors ULW and counts toward stuck-wall, but does **not** increment `w` or FIFO a named ship (no text + no edits is not a work unit).
- **Thought-only Stop forces the next tool call**: after a silent judge turn, the following provider request sets `tool_choice=required` (Anthropic `any`) and prepends a “must call a tool” poke. Maze-plus `d915621e` stacked ~27 parent turns in a 161-minute hole (`completion` ~120, no edits) — think → ULW re-anchor → think. Happy-path waves are unchanged (flag is off until a thought-only Stop).
- **Unlimited ULW does not self-release on stuck-wall**: `cycle=1` with no `max_waves` stays CONTINUE until `/cycle 0` / `/ulw-off` / `/done`. Maze `6a86c6d1` died at wave 150 after three thought-only Stops while two explore-map picks were still open — the game was not done; the model failed to emit tools. Capped ULW, LAST wrap, and `/goal` still release on no-edit Stops. Named-ship exhaust hold is unchanged.
- **Reasoning mantra is not thinking**: if hidden thought starts repeating a long closer (maze: “The fix is in place and verified” ×550) while there is still no text/tools, the stream ends as `reasoning_loop` immediately. Working waves on that run never repeated a 48-char window more than once. The 12-minute wall stays as a backstop, not the wait.
- **Explore pick-done matches the ship, not the bug title**: a closer that cites a claim token (`contributionToken`) or a mapped file plus a job word completes that pick. Flavor-only `carving`+`thanks` copy does not. Maze wave 20 was the empty-lives job; the pick stayed open through wave 146 and exhaust never armed.
- **An explore map without `pick:` is not a map**: file-only essays are rejected, do not occupy the 6-slot shelf, and do not clear `exploreRequired`. maze_plus stored four empty picks and never seeded a hold list.
- **Explore-map picks are the named-ship list**: unlimited ULW seeds `namedShips` from kickoff maps when the model never writes a list. A pick completes only on its job (distinctive terms / file claims), never FIFO and never via topic words (`online` / `joiner` / `toast`). Exhaust then holds for a different-class `Reading:` or `/cycle 0` — the rail `8e68638e` never armed after joiner Home. Caps still spend. Compact reprints open seeded picks.
- **Isolate `N/N` is not wave proof**: helper-only `wN` checks and closer-only `22/22` / `43/43 stay green` no longer stamp `proof=true`. A cited full-suite `fail N>0` stays unproven. Live REPL still owns `session.lock` after Cycle complete (releasing it mid-session would let another process steal the transcript).
- **Capped same-surface still advises**: maze max20 (`28cb4c94`) spent 18 “first X speaks once” siblings because hold is unlimited-only and token overlap is near zero. Speak-once is now a work schema (rotating nouns, one monologue-gate recipe). Capped / `/cycle 0` N+1 budgets still do **not** hold — they advise at 2 siblings and strongly advise at 3 (different surface or wrap remaining as LAST). The re-anchor no longer lies that leftovers “will not increment w” under a cap.
- **Tests-without-body does not stamp `w`**: the same run closed wave 1 on a red `carriedGifts.test.ts` (`proof=✗`, `forge-redgreen`) and dumped the real ship into wave 2 under “Wave 20 is LAST”. A declared ship that is only test / lockfile dirty and unproven (or an explicit tests-first closer) updates the open wave in place, admits, and does not auto-commit.
- **Production hygiene for log10 rails**: `/clear` and compact drop `holdOmitToolIds`; session load caps the list; continue-cap docs/warnings no longer call unlimited Stop-blocks a hidden wave cap. Each session keeps `rounds.jsonl` when global metrics prune.
- **Hold omit + Wave 1 job reprint**: mill/contract hold omits recent mill tool bodies even before the 180k sticky clip (suffix only — no first clip). Evaluate-class garnish after wave 3 bounces once with the Wave 1 pick/reading.
- **CHANGELOG prepend + honest receipt**: a colliding `## [Unreleased]` `search_replace` applies at the first heading instead of failing the wave. Huge prepends report `+3 −0`, not `+12000 −11997`. Repeating a red `npm test` gets an isolate tip (still not a silent skip).
- **Log10 TUI / meter / fuse leftovers**: Stop-block pokes start on a new line and unclassified injects get a `[Forge …]` prefix so `admitCount` includes ULW Stop-blocks. CHANGELOG `old_string` collisions hint `apply_patch`. A red suite re-anchor asks for isolate + new file, not another full-suite. A process-fuse LAST flip lists leftovers instead of pretending **Cycle complete.**
- **Mid-run explore is now a hold gate**: mill / contract hold requires one completed `explore` child before the next ship or pick Reading. Reprinting Wave-1 maps is not a look. Rest-card token-overlap holds do not force a child. Playwright / play-loop evidence is a different class.
- **Log10 leftovers that wasted the night**: `apply_patch` pin-taint; isolated `node --test` / `tsx --test` counts as ran-not-proof; `read_file` suggests the same basename in another folder (`systems/tea-sip.js` → `scenes/hearth/tea-sip.js`); mutation journal rotates the newest 8 MB instead of going blind; `Committed` prints once per sha; each session keeps `rounds.jsonl` so global metrics prune does not erase hour 1.
- **Log10 mill false-hold + continue-cap leak**: `Far stays` alone is game voice, not a schema — mill/schema classify the full closer (`classText`), and an explore-map pick is never mill (Memory Walk may quote the toast). Contract matching drops generic pick words (`same`/`copy`) so garnish cannot reset the 8-ship streak; `topology` / `memory walk` / `online hearth` still count. Hold admits no longer teach `Last ship was` / `what's still hard`. Length / empty / content_filter use their own fuse — 200 unlimited Stop-blocks no longer make the next truncated completion trip `continue_cap` without `/cycle 0`.
- **Adjacent-share / factory mill (log10)**: unlimited maze ULW stamped 190 “beside you / far stays” siblings because same-surface looked at nouns, named-ship adopt accepted a new one-ship `Reading:`, `npm test | grep` counted as proof, and `bestWave` crowned the thickest factory row. Schema + factory fingerprint now hold after 3 adjacent-share ships (or 5 factory closers in 8). Adopt refuses the next mill Mad-Lib. `Shipped:` names the commit; changelog-only dirty trees are not auto-committed. `ℹ fail 64` on a grepped suite is red. Wave ledger keeps 256 rows. Mutation journal skips CHANGELOG and caps pre-images at 256 KB. No wave/spend cap was added — duration stays unlimited. Stuck-wall still does not release the hold.
- **Log10 follow-through**: new raw `readFileSync` tests in a pin-budget repo taint that wave’s proof (warning on write/edit). Isolated `node --test tests/wN-*.mjs` is not wave proof. After 8 ships that ignore explore-map picks, unlimited ULW holds and reprints the picks + Wave 1 reading. Class/contract hold omits recent mill tool ids from an *existing* sticky prune set (never invents a first clip). Dock shows live `~$` from session spend.
- **Unlimited ULW no longer dies at continue #200**: every wave is a Stop-block + continue, so `FORGE_ULW_MAX_CONTINUES` (default 200) was a hidden wave cap (maze log10 `continue_cap_stop` without `/cycle 0`). Unlimited `cycle=1` Stop-blocks still increment the HUD counter but do **not** release or flip LAST. Length / empty / content_filter loops still fuse. Capped ULW and LAST wrap still fuse.
- **Same-surface hold (maze leverage collapse)**: unlimited ULW could stamp 20+ thick+proven waves on one theme (openings / rest-card / leftover-audio) because thin-wave and leftover-chrome never fired. After 3 declared ships on the same surface (summary overlap or leftover/fix-that-only language), Stop holds until a different-surface `Reading:` or `/cycle 0`. Same-surface leftovers do not increment `w`. Stuck-wall does not release that hold. Capped runs and a scheduled `/cycle 0` N+1 budget are not held. Bar anchoring stays prompt-only.
- **ULW auto-commit without git identity**: maze dogfood (`be4e324d`, 43 waves, $37) staged every wave close then skipped `git commit` with `Author identity unknown` (no `user.name`/`user.email`). Auto-commit now injects `Forge <forge@local>` for that command only, uses `--no-gpg-sign --no-verify`, and records stderr in `lastAutoCommit.skipped`.
- **`/cycle 0` at wave N now stops at N+1**: maze dogfood typed `/cycle 0` mid-wave 43 and the harness flipped LAST immediately (`You may stop after this wrap`). User `/cycle 0` now keeps CONTINUE, sets `maxWaves` to the in-progress wave + 1, and auto-LAST only at that cap. `/done` / cap / safety-valve LAST still wrap this wave. `/ulw-off` still aborts.
- **Unlimited ULW no longer self-releases after named-ship exhaust**: stuck-wall (default 3 no-edit Stops) used to disarm the cycle while the harness was asking for a new `Reading:` or `/cycle 0` (maze dogfood: 13 exhaust admits → Cycle complete ×3 → released without the user wrapping). Exhaust Stops do not increment stuck. Strong admit asks for a different-surface reading — it does not say the hard work is exhausted or invite **Cycle complete.** A declared `Wave shipped` with real edits still stamps `w` (waves 43–46 were invisible). Passed-on comma/`so` clauses and “next is a real play bug” are not named ships. A red test suite is a different surface, not leftover chrome.
- **Stuck-wall / Cycle complete are first-class stop reasons**: `run_end` + `forge run --json` + the dim stop line + notify now stamp `stuckReleased` / `lastCycleReleased` (and lastError `ulw_stuck_wall` / `ulw_cycle_complete` / `goal_stuck_wall`). Maze `ok: true` with no reason will not happen again. `/stats` counts them. Stuck-wall also auto-commits leftover dirty work. Compaction job cards name the unlimited named-ship hold. `/status` and session list show `rounds=` when provider rounds exceed user turns.
- **Δ closer after a red suite**: a failed `npm test` now stamps `verify: npm test ✗` instead of wiping the trail to `verify: none`. Stuck-wall / Cycle complete clear the dock `ULW` badge (`meta.ultrawork` follows `ulw.enabled`). Auto-commit prints once. CONTINUE re-anchors log the first line only — no 300-char mid-word clip glued onto the next reply.

### Changed
- **One ship grammar**: `Ship landed:` / `**Ship:**` / `Wave N ship:` / `Wave ship:` / `Wave shipped.` all stamp `w`, win the ledger over a reprinted `Reading:`, and name the auto-commit. Hint prefers a ship after the previous wave, then the ledger row — never an older wave-1 `Ship landed:` (5dbf mandate subjects; 693c Tab/resume freeze).
- **Leftover-chrome family**: `live › last nonempty … line`, bang-shell `!cmd` last-line, idle/bg last log line, and `lsp diagnostics` count with glanceable ✓ so a 693c-style cluster reaches polish-4 without a reset. 5dbf dock / delayed `▸` / landmarks / setup stay non-chrome. Δ-closer verify is not chrome.
- **HUD ctx follows the last API prompt**: dock/`/status` used tokens are `max(estimate, lastRoundPromptTokens)` so a 201k API / 173k estimate run is not shown as under the 180k cliff. Prune estimator still ignores HUD reasoning.
- **User LAST bounces a dirty/unverified wave once**: mid-wave `/cycle 0` with no named leftovers still has to wrap the open tree or note it is clean. Budget LAST does not. Same `wrapNudgeDone` cap as named leftovers.
- **Glanceable ✓ is leftover chrome**: `693c5fb1` shipped 16 sibling previews (`last N lines under the ✓ row`, `extraDefaultPreview`, `search_mcp` first 5 names) with `polishStreak=0` — consolidation waves reset the streak every 4th unit, and the classifier missed the ✓-preview family. Glanceable ships now count toward polish-4 auto LAST; a consolidation closer does not wipe the streak. Unlimited ULW refuses to adopt a new glanceable reading after the empty-list admit, and Stop stays blocked until a different-surface reading or `/cycle 0` (asking once then free-inventing was the $21 hole). Capped runs still spend remaining waves.
- **`/cycle 0` wraps, it does not abort**: user LAST freezes the already-named plan and bounces **Cycle complete.** once while those items are still open. Cap / polish / safety-valve LAST wraps the open wave only — leftover named ships past the budget are not wave N+1. `/ulw-off` remains the immediate disarm. `/cycle 1` after LAST clears the frozen wrap so CONTINUE can adopt again. Named leftovers can be cancelled with reason (`Cancelled: …`) instead of shipped. System / admit / `/help` copy says wrap, not “finish this wave then stop.”
- **Named-ship parser**: `ONE ship:` wins; `(later waves…)` is a gloss, not an item. Unlimited empty-list asks get a stronger “write a new Reading on a different surface” line after 3 admits or a glanceable-`✓` streak. Capped runs still skip that admit.
- **Sticky second shelf follows the API**: reclips only when the last provider `prompt_tokens` is back over 180k (stub inflation at 80k API no longer reshapes the prefix). First clip also fires if the last API prompt is already over the cliff.

### Changed
- **Idle epochs never increment `w`**: unlimited ULW used to stamp a fake wave every 20 tool rounds (an 80-turn ship became `w=4`). Idle now updates the open wave in place for capped **and** uncapped runs. `w` moves on Stop or a declared `Wave shipped` / `Ship landed`.
- **Sticky request-prune after 180k**: the first clip freezes omitted/collapsed/soft-trimmed/harness-stub ids on `session.meta.requestPruneSticky`. Later rounds apply that set instead of re-aging, so the xAI prefix can cache again (dogfood `aee45264` dropped from 99% to ~70% because every post-cliff turn reshaped the prefix). A second shelf reclips only if the last clip got under the cliff and the suffix grew back over — a first clip that is still ≥180k stays frozen (reclips every turn would kill the prefix again). Compact/`/clear` drop the set. `FORGE_REQUEST_PRUNE=1` stays sliding. HUD `ctx` counts `reasoning_content`; the prune threshold does not.
- **Wave ledger prefers the ship**: `summarizeWave` uses `Ship landed:` / `Wave N shipped:` (or a newer `memory_write` ship) before the Wave-1 `Reading:` clip.

### Added
- **Ctrl+R history search**: the REPL prompt does reverse incremental search over `~/.forge/history` (`(bck-i-search)\`foo': …`). Ctrl+R again steps older; Ctrl+S newer; Esc / Ctrl+G cancel; Enter runs the match. Ctrl/Alt+←/→ and Alt+B/F jump words. `/help` Keys and `/tips` list them.
- **Default edit diffs**: a successful `edit` / `write` / `patch` prints an 8-line colored preview under the ✓ row (path already on the status line — no `--- a/` headers). `/verbose` still dumps the full block. Grep/read bursts still coalesce; edits with a diff do not.
- **`/last` is a conversation card**: wrapped `you ›` / `forge ›` bubbles (default 900 chars, newlines kept) instead of one clipped TTY row. Resume banner peek stays compact.
- **Fenced-code syntax color**: assistant markdown paints keywords / strings / numbers / comments in `ts`/`js`/`py`/`sh`/`json`/`diff` fences (line-local; block comments carry between lines). Chunk-boundary invariance still holds.
- **`forge ›` reply opener**: each streamed assistant burst (REPL + `forge run`) starts with a dim `forge ›` so the live transcript matches `you ›` and `/last`.
- **`/resume 3`**: `/resume`, `/sessions`, and `forge sessions list` number rows. `/resume N` loads the Nth same-cwd session (1–99). Id/title still work. Empty Tab lists `/resume`; Tab after `/resume` offers `1`/`2`/`3`.
- **Default subagent preview**: a successful `spawn_subagent` prints the first 8 lines of the child's report under the ✓ row (header/metadata stripped). `/verbose` still dumps the full artifact. Parallel greps still coalesce; children with a report do not.
- **Successful bash tail**: a long `bash` (`npm test`, compilers) prints the last 5 lines under the ✓ row. Short `echo` stays one line. `/verbose` still dumps the full block.
- **web_search preview**: a successful search prints up to 5 hit titles under the ✓ row (no URLs). Empty "no results" stays one line. `/verbose` still dumps the full report.
- **Background-task completion tail**: when a bg bash finishes, the mid-run interjection includes the last 8 log lines so the agent can act without a follow-up `get_task_output`. The idle `you ›` notice also shows the last log line (`pass 36`).
- **Live › bash last-line**: foreground `bash` streams the last nonempty stdout/stderr line into `live ›` (200ms throttle) so a long `npm test` is not a frozen `tool bash`.
- **Δ closer verify callout**: missing or stale verification prints on its own yellow line under the file list so it cannot be clipped off the Δ row. Fresh `verify: … ✓` stays one line.
- **lsp diagnostics preview**: a successful `lsp` diagnostics report prints the count line + first hits under the ✓ row. Clean `No diagnostics.` stays one line.
- **get_task_output tail**: a successful poll prints the last 8 log lines under the ✓ row. Short "still running" notes stay one line.
- **Bang-shell live ›**: `!npm test` streams the last output line into `live ›` (same throttle as agent bash).
- **web_fetch preview**: a successful fetch prints the first heading + first prose lines under the ✓ row. Tiny pages stay one line.
- **call_mcp preview**: a successful MCP call prints the first 4 result lines under the ✓ row. One-line "ok" stays one line.
- **Preview coalescer is one function**: `extraDefaultPreview` feeds both the default ✓ printer and the ×N coalescer so a new preview cannot vanish into a burst.
- **search_mcp preview**: a successful catalog search prints the first 5 matched tool names under the ✓ row.
- **Unlimited named-ship backlog**: the Wave-1 reading's ONE ship + passed-on list is stored on `ulw.json`. When every item is done and `maxWaves` is unset, Stop asks **once** for a new `Reading:` or `/cycle 0`. Capped runs still spend remaining waves. `/cycle status` lists the ships.
- **`provider_round` `pruneKind` + `cacheDrop`**: metrics distinguish `first_clip` / `sticky` / `reclip` / `always`, and flag a round that fell below 5% cache after a prior round above 90%. `/cost` last-round line and `forge run --json` expose `lastPruneKind`.

### Fixed
- **Auto-commit clean-tree is not revisit**: after a landed ULW commit the clean fingerprint is a new baseline (dropped from `seenDiffFps`). Successful ships no longer look like edit→revert churn.
- **Empty-SSE / empty-choices retry keeps the cache shard**: those errors are retryable; `makeChatRequest` still sends `x-grok-conv-id` and `reasoning_content` on the retry.

### Changed
- **`max_waves=N` is a budget, not an early-exit**: evidenced **Cycle complete.** under `cycle=1` no longer releases (dogfood `d6b191ae` stopped at wave 1/4 after `/max-waves 4`). The harness stamps the unit and re-anchors the remaining waves. LAST + **Cycle complete.** still releases at the cap or after `/cycle 0`. Kickoff/admit/doctrine no longer say unused slots are work to skip.
- **First-run numbers work**: the `/setup` card’s `1–6` are typeable at the idle prompt (`1` = `/setup 1`). First paint no longer stamps `seenSetup`, so the card can return until you actually run a setup action. Login picker labels are in-app choices (not `forge login` CLI strings); unknown input retries instead of quitting; post-login says “type a task.”
- **Edit results are a receipt, not a truncated dump**: successful `search_replace` / `write_file` / `apply_patch` return `Edited path (N lines) · −X +Y · lines A–B of N` plus a numbered AFTER window (same `N|` grammar as `read_file`). The TUI still gets a colored `shortDiff` via `ToolResult.diff`; the model string no longer embeds `--- a/` or `… [diff truncated]`. Miss hints lead with a numbered ±8 window, not “re-read the file.” Kill switch: `FORGE_EDIT_RECEIPT=legacy`. Status line shows `+8 -6` when stats are present (`diff 1.3KB` was always human-only).
- **One HUD contract**: the bottom dock is the only identity strip (model · ctx · ULW). Per-turn live-run header is skipped when the dock is on; docked `live ›` is phase + elapsed + work (`tool bash`, `wait retry 2/3`) — not a second ctx/ULW reprint. Turn footer drops ctx/todos/ULW when they already live on the dock. Waiting labels stay honest (`wait retry…` / `wait hook`, never invented `waiting on bg`). Live ctx uses the same pruned outbound estimator as `/status`.
- **Daily-loop chrome**: live-run header is one identity line (not a boxed catalog). Empty-Tab and `/` + Tab starters drop `/ulw`/`/goal`/`/done` (type `/ul` then Tab — those start work). Compact setup residue ignores optional notify/LSP. Abort closer names `/retry` · type-to-continue · Ctrl+C again. REPL provider errors append the same recover line (`/retry` · `/model`).
- **Failed-tool tails**: default REPL transcript still prints one status line per successful tool, but a failed tool now also shows a 5-line error tail (last lines — test/compiler failures live at the end). `/verbose` still opts into diffs + full output.
- **Empty-Tab starters**: first Tab on a blank line — and `/` + Tab — offer a curated first-day set (`/help`, `/setup`, `/plan`, `/last`, …) instead of dumping the full slash catalog. Type `/ul` or `/per` then Tab for everything; unknown prefixes no longer dump the catalog.
- **Permission Enter = allow**: the Allow? prompt now advertises `↵/[y] once`. Empty Enter already allowed once; the prompt hid that.

### Added
- **Explore map dereference**: a child report that looks like `pick` / `passed_on` / `files:` is stored on the parent. Parent `read_file` of a mapped path without offset/limit returns the claim plus a ±40-line window around the cited line (not a second full-file dump; mapped reads beat the unchanged-stub). Explore children stop after two cite-stale turns (pathless greps count). Dock and `/cost` show **last-round** `cache N%`, not only the lifetime smear. ULW orient hard-denies writes/spawn/mutating bash even under yolo.
- **ULW orient phase**: evaluate-class Wave 1 hides `spawn_subagent` and edit tools until a written reading exists (same idea as `/plan`). Scout system prompt. `memory_write` of the reading flips `phase=ship` and rebuilds the system once (intentional cache break). Later waves never re-scout — `w≥1` or a named next ship skips orient. HUD-identity ships (dock/banner/overflow) count as polish-class. Explore children use a map prompt and stop when cite-delta is zero for two turns.
- **xAI prefix cache (99% path)**: Chat Completions send `x-grok-conv-id: <sessionId>`. Assistant `reasoning_content` is stored and replayed (xAI's #1 cache-miss cause). Per-round `provider_round` lines in `metrics.jsonl` record prompt/cache/ratio/pruned. Default outbound is **append-only** until ~180k tokens (`FORGE_REQUEST_PRUNE_AT`); `FORGE_REQUEST_PRUNE=1` restores every-round prune. HUD `ctx` matches the wire (no silent prune). Mid-run ULW admits no longer dump 2k into the user channel (fingerprint only; Stop re-anchors still append). `/status` and `forge run --json` expose last-round cache.
- **Family spend is visible**: parent `/cost` `/status` `/metrics` and `forge run --json` show parent vs each `spawn_subagent` (turns, tokens, est $). The spawn result header includes the same line. Completed children no longer fold as $0 (the useful explore in dogfood `d6b191ae` vanished from the HUD). Dock shows `sub N $x` when children ran. This is the bill — not a cap.
- **Unattended cost meters**: `forge run --json` and `metrics.jsonl` now include `harnessUserPokes`, `admitCount`, `proofPokes`, and `providerRounds` so the next dogfood is a number, not a vibe.
- **Headless daily-loop parity**: `forge run` prints the same default ✗ tool tail + Δ files/verify closer as the REPL (`formatDefaultToolEndTranscript`, `formatTurnChangeSummaryForSession`). Non-JSON runs also print why they stopped (`formatRunStopReason`: cost / turns / continue-cap / abort).
- **Dock pause during Allow?**: bottom-dock 2s DECSC/DECRC paint is refcounted and hooked to the stdin lease so permission / `ask_user` prompts are not clobbered.
- **Readable `/sessions` picker**: leftover row width goes to title + last-you (drop model/cost first); still one TTY row.
- **Stdin lease**: `PromptEditor.suspend()`/`resume()` so permission asks and `ask_user` do not fight the live raw-mode editor (first-write-of-the-day `y` landing in the buffer). Mid-run Ctrl+C with a draft aborts (`setBusy` + `resolveCtrlC`); idle first-C still clears.
- **Resume orientation on the banner**: same-cwd REPL resume prints last-turn peek + `/last` · `/files` · `/retry` on the banner (one card). Headless `--continue` still prints the CLI peek. Banner identity line includes git branch + project bits.
- **Turn-end verify names the check**: `verify: none — run npm run typecheck` (via project intel) instead of a bare "edits unverified".
- **Unattended ULW auto-commit**: local git commits of the dirty tree (minus secrets) at each **wave close** (Stop re-anchor or declared `Wave shipped` / `Ship landed`) **and** on **Cycle complete.** Never pushes. Long uncapped runs no longer pile one giant uncommitted chunk. `/status` and `forge run --json` show `autoCommit`. Kill-switch: `FORGE_ULW_AUTO_COMMIT=0`.
- **Dock is the HUD**: idle `forge ›` no longer reprints the model/ctx/plan strip when the bottom dock is on (`FORGE_BOTTOM_STATUS=0` / non-TTY still get a deduped strip). `/verbose` is catalogued (Tab, `/help`, reserved, live-safe, `forge run "/verbose"`); REPL still owns the session-local toggle and shows a `VERBOSE` prompt flag. `/skills` is catalogued next to `/commands`.
- **First-run UX**: TTY `forge` without credentials offers a login picker (headless/`--json` still fail closed). Slim banner + “Type a task in English.” Grouped `/help` (`start` default, `all` is the catalog, plus `settings`/`harness`/`sessions`/`safety`). `/setup` + `forge setup` first-day hub (model, budget, notify, `/init`, LSP, `forge init` scaffold). Compact `setup N/M` line until recommended items are done or `/setup skip`. Contextual once-hints after first edit / first spend / long turn. `/config` and doctor show attention, MCP, LSP, and a non-blocking setup section. Docs: `docs/GETTING-STARTED.md`. `FORGE_SETUP=0` disables the auto card.

### Fixed
- **`/diff` verify tip on a clean tree**: default `/diff` always names the project check (`verify: npm run typecheck`), not only when the working tree is dirty. CI after a commit no longer got a bare `status: clean`.
- **Unattended cost: Forge talking to Forge**: mid-conversation admits no longer fire when only ship-logs/readings change (`decisionsFp` is durable memory only). Stop re-anchors mark the snapshot admitted so the next boundary does not emit a second “Obey this state.” ULW kickoff skips the prompt-start admit. Request prune stubs older harness user pokes (keep the latest admit + Stop). Stop re-anchors (including the backlog-required gate) dropped the 2.5–3.5k decisions dump.
- **One proof speaker**: a red check emits at most one fix-until-green this prompt and suppresses verify-nudge until green (or 8 further edits). ULW Stop already demanding proof does not also verify-nudge. Background-task completion during LAST is desktop-notify only.
- **Evaluate-class TodoNudge off**: an evaluate/audit-then-improve mandate no longer gets TodoNudge even when a board exists. The board is optional; we do not poke.
- **Closing wave stamp**: a LAST / cap-hit Cycle complete still stamps the unit (`w=1/N`, not `w=0/N` on the auto-commit). A red check is not attestation evidence. Yield (“shall I continue?”) is still handoff-blocked.
- **Unchanged full-file reread stub**: a second `read_file` of the same path with the same mtime/size, no offset/limit, and the last body still in the live tail returns `Unchanged since last read (N lines, same mtime).` Windowed reads and post-write reads still return the body. `FORGE_UNCHANGED_READ_STUB=0` off. Mid-loop LAST-flip admits are marked admitted so the next boundary does not emit a second “Obey this state.”
- **Polish auto-LAST only ran on mid-loop stamps**: Stop-boundary wave closes never called `notePolishShip`, so a 4-wave evaluate run could grind last-verify / quieter / one-TTY-row siblings with `polishStreak=0`. Stop now counts polish class (including last-verify dumps, implementation-notes, quieter/lowercase copy) and LAST at 4. Wave summaries treat “close Wave 2” mid-thought as a Reading fallback. Session list preview clips `## ULW armed` kickoffs to the mandate.
- **`/cycle` / `/max-waves` / `forge --ulw` wiped the mandate**: auto-arm used a fake mandate, so the next real user turn was treated as steering. Auto-arm now takes the last real work-order (not acks, Q&A, or kickoff dumps); a placeholder is adopted on the first real work-order **and** on a mid-run interjection. `/ulw` / `improve the codebase` stays a real soft default so later steering cannot overwrite it. After stuck-wall / `/ulw-off`, `continue` re-enables the existing mandate instead of naming a new cycle "continue". `/cycle 1` / `/max-waves` on a disabled sidecar resume that cycle (wave + mandate intact) instead of re-arming from lastUserText. `/clear` now resets the work-order (pending) and wipes decision memory so the next typed sentence is a new mandate, not steering on leftover-chrome ships. Status/admits/kickoff/compact/`/status` show `(pending work-order)` instead of the placeholder string; placeholder arms no longer seed decision memory. Auto-commit runs on a real wave close or Cycle complete, not every judgment/backlog Stop block, and never on a pending mandate. Kickoff no longer reprints the 5k god-mode dump; compact job cards keep the user mandate only (no `expandedMandate` dump); slim `## ULW armed` kickoffs clip to the Mandate line after compact. Evaluate-class no longer seeds a durable "invent high-leverage work" decision (admits say reading-then-ship, not invent).
- **Decision memory split evaluate+improve into two priorities**: `extractMandateBullets` treated "evaluate X and then improve Y" as a 2-item backlog. Those priorities survived every compact and told the model to execute both sections. Verb-order sentences now stay one mandate; `/improve` also seeds a board only when `backlogRequired`.
- **`/ulw` still seeded a board on every soft prompt**: decoupling evaluate-class from `isBroadMandate` was not enough — slash and `forge --ulw` seeded `todosFromMandate` whenever `softPrompt` was set. The product sentence is soft, so it still got "evaluate" + "improve" todos and TodoGate kept the board alive. Seed only when `backlogRequired`. Declared-wave stamps now read a fresh `memory_write` closer (empty assistant prose used to miss "Wave shipped").
- **Evaluate-class is not a backlog**: "comprehensively evaluate then improve UX" was classified as broad, so Wave 1 required `todo_write ≥2` and TodoNudge every 3 turns (98 board rewrites). Evaluate-class is now a verb order (reading + one ship). TodoNudge does not create ceremony boards; a stale open board waits 16 turns. Verify-nudge default is 8 edits, not 3.
- **Leftover-chrome grinding**: after a real reading, ULW was finishing an infinite "clip every line to one TTY row" class (103 Wave-shipped decisions, 87 truncation panics). Compact re-injected the 5k god-mode dump + every sibling ship. HUD `ctx` counted the unpruned store (528k/500k) so the model thought the window was blown. Now: compact cards keep the user signal only; decision injection keeps the reading + last 3 ships; four polish-class ships auto-LAST; HUD ctx is the pruned outbound estimate; `search_replace` status says `diff 1.3KB`.
- **Harness wave vs invented Wave 3/4**: with `max_waves` set, only Stop incremented `w`, but cycle=1 blocks Stop — a 5h run stayed `w=1/4` while the model labeled Wave 4 LAST. Declared `Wave N shipped` / `Ship landed` / `Cycle complete` now increment the harness counter (and flip LAST at the cap). Compaction job cards + live admits say the harness `w=N/M` is the only counter. Store checkpoint fires at 1000 messages (was 2500) so a long ULW does not sit at 528k/500k after one compact.
- **search_replace "file was truncated"**: `Edited path` now includes `(N lines)` so a 1.3KB tool result is not mistaken for an eaten file.
- **HUD `todos:N` with no name**: chip falls back to the first pending title when nothing is in_progress.
- **ULW auto-commit first porcelain line**: `git()` in auto-commit `trim()`'d the whole `status --porcelain` dump, so an unstaged `" M src/…"` became `"M src/…"` and `slice(3)` staged `rc/…`. Cycle-complete then skipped the entire commit (`git add failed: … rc/agent/permissions.ts`). Auto-commit now `trimEnd()`s only, lists untracked files with `-uall` (not `?? src/`), recovers a trimmed unstaged line, and stages survivors one-by-one so one bad path cannot skip the ship.
- **Wave ledger summaries**: Stop often captured the last mid-thought ("LSP still reports the unused import — verifying…") as the wave summary. Summaries now prefer `Reading:` / `Ship landed:` / `Cycle complete.` in the closer, then a durable decision-memory reading, then the raw clip.
- **Capped `max_waves` counts Stop-boundary work, not loop turns**: with a cap set, idle mid-loop epochs no longer increment `w` (a cap of 4 was burning LAST after ~80 tool rounds mid-ship). Unlimited ULW still stamps idle epochs. Auto-commit subjects also match `Wave N … shipped` decisions, not only `Ship landed:`.
- **Live › during streams**: token streaming no longer abandons the `live ›` dock forever. The spinner stays latched (no markdown flicker), but a 10s heartbeat reprints `live ›` (phase + elapsed; identity/ctx stay on the bottom dock), and `waiting` / tool / hook phases redock immediately.
- **Live harness admits stay honest about the working tree**: mid-run admissions no longer reuse the prompt-start git snapshot, so a clean tree at kickoff cannot keep saying `Working tree: clean` after the agent has edited. Mid-loop wave stamps no longer advance `lastDiffFp` on every edit (that made Stop record wave 1 as `net=none`). Auto-commit matches journal paths by realpath/basename and prefers a `Ship landed` decision for the subject instead of the raw truncated mandate.
- **Honest turn-footer check tip**: after edits with no recorded last-verify, the footer no longer prints a dim `✓ npm test` (read as already-passed). It now says `next npm test` — a suggested check, not a green trail. Recorded `last✓` is unchanged.
- **Permission-ask timeout env**: tips and `docs/SAFETY.md` named `FORGE_PERMISSION_ASK_TIMEOUT_MS`, but the runtime only read `FORGE_PERMISSION_TIMEOUT_MS`. Both names now work (canonical wins if both are set); recovery copy prints the canonical name.
- **General ULW prompts are the product**: `isBroadMandate` no longer requires 80 characters before honoring “comprehensively evaluate… then improve…”. That sentence now seeds evaluate+improve todos, a Wave-1 **reading gate** (capped), and kickoff copy that treats the written evaluation as the first verb — not forbidden advice. Small `max_waves` injects a spend-the-budget-on-the-verbs doctrine. Follow-up user text no longer re-arms ULW or replaces the mandate (only `/ulw <new>` does). A new user turn clears sticky `ERR:quota_exhausted` / 429 / drop banners so the HUD does not lie for the whole next run.
- **ULW `max_waves` vs mid-loop stamps**: unattended edit bursts no longer increment the user-facing wave counter (so `w=7/2` cannot happen). HUD tags show `w=N/M` (current/cap) instead of `mw=M` only. Live hint is `last=/cycle 0` so it does not look like the current cycle. Resume words (`continue`, `keep going`) no longer re-arm ULW or replace the mandate with a 5k god-mode dump. First wave after edits is `net=new` when the first fingerprint is the baseline. When a cap is set, idle epochs also do not increment (see above).
- **Lossless tool-clear**: microcompaction spools the body to `~/.forge/tool-output/` before stubbing. Stubs say `read_file` the Full output path — never “re-run” `spawn_subagent` / bash. Dumps still referenced by a session are not pruned. ULW keep-recent floors at 10 so a legal 8-tool parallel batch fits the hot tail.
- **Subagent handoff**: children write an artifact, report `incomplete_max_turns` instead of pretending success, synthesize findings when `finalText` is empty/mid-thought, and get a last-turn “write the report now” reminder. The child session is deleted only after a completed run with an artifact on disk.
- **Self-heal visibility**: doom-loop / error-streak lastError is kept and re-admitted as a harness reminder (survives tool-clear). Decision memory is admitted mid-loop when `decisions.json` changes — not only at Stop/compact. Prompt and doom copy tell the model to change tool or write, not re-read the same window.
- **No-op compact**: FileReadState is no longer wiped when compact drops zero messages.

### Added
- **`enter_plan_mode`**: the agent can pause into read-only plan mode on ambiguous/architectural work without waiting for `/plan`, then `exit_plan_mode` to implement. Subagents cannot flip the parent session.
- **Same-provider model fallback**: after 429/5xx/overloaded retries exhaust, Forge switches to the next model in `fallback_models` / `FORGE_FALLBACK_MODELS` / `--fallback-models` / `/fallback` (defaults: grok-4.6 → grok-4.5 → grok-4; `off` disables). Quota/auth errors still take the account-switch path. `/fallback` and mid-run switches persist on the session (resume + `/status`). Last hop (`from → to`) is stamped on `session.meta.lastModelFallback` and shown on `/share`, `/status`, resume, export, and `forge run --json`. ULW with fallback off is a production warning.
- **`get_task_output` wait_any / wait_all**: pass `task_ids` + `wait_mode=any|all` to block on several background jobs in one call (omit ids to wait on every task that was running at start). Parallel test/build fans no longer need a poll loop or serial `wait=` calls. `wait: true` means 120s. Model aliases `wait_all` / `wait_any` / `wait_tasks` dispatch here (implied mode). `search_files` aliases `grep`.
- **LSP over grep**: system prompt + tool descriptions prefer `lsp` `references`/`definition`/`workspace_symbols` for known symbols. Empty grep on an identifier hints the same.
- **Desktop notify class**: `/notify` also pings on background-task complete, **Goal achieved**, goal stuck-wall, and ULW stuck-wall (not only turn end).
- **Posture**: startup warns when `fallback_models` is explicitly off (inferior-by-accident). Defaults stay quiet. `/tips` lists `/fallback`, `enter_plan_mode`, `wait_mode`, and LSP-over-grep.

### Fixed
- **Project memory mirror no-op writes**: `.forge/MEMORY.md` is not rewritten when only the `updated=` timestamp would change, so a tracked memory file no longer dirties `git status` after load/import.
- **Unattended ULW no longer dies on `terminated` / generic `provider_error`**: Node/undici `TypeError: terminated` (xAI often RST the socket when a token dies mid-stream instead of HTTP 401/403) was not retryable and skipped OAuth recovery, so the run dropped to `forge ›` even though typing `continue` refreshed the token and resumed. Drops are now retried, credentials force-refreshed in-loop, and ULW auto-continues the same transcript (`FORGE_ULW_AUTO_CONTINUE=0` off).
- **Config load alias/bool canonicalization**: global `~/.forge/config` values like `permission_mode = "yolo"`, `sandbox = "none"`, and `blocking_stop_hooks = "false"` now coerce to `bypassPermissions` / `off` / real `false` at load — PermissionGate, sandbox, and Stop fail-closed no longer disagree with doctor/CI warnings.
- **Blocking Stop stringy false**: doctor, production-warnings, hooks, stop-guard, and project overlay treat `"false"`/`"0"`/`off` as OFF for `blockingStopHooks` (JS truthiness trap); project still cannot disable the non-negotiable default.
- **Proof-claim release tips**: session `lastError` after proof-claim cap uses project-intel check commands instead of hardcoded `npm test`.
- **Status/subagent YOLO aliases**: statusline tags, prompt flags, and subagent permission inheritance normalize `yolo`/`always`/`bypass` so the YOLO badge and child permission mode stay accurate.
- **Project config safety · sandbox aliases**: project `sandbox = "none"`/`false`/`0` normalize to `off` and are ignored (same as explicit `off`); network aliases like `deny` still tighten to `blocked`.
- **Project config safety**: `applySafeProjectOverlay` normalizes permission aliases before the YOLO block — project `permission_mode = "yolo"`/`always`/`bypass` can no longer slip past the bypassPermissions deny.
- **Production warnings + doctor · mode aliases**: `yolo`/`always`/`bypass`, `deny`, and sandbox `none`/`false`/`0` normalize before CI footgun checks (`productionWarningsForRun` and `runDoctorCheck`) so partial configs still warn.
- **Tool-arg JSON repair**: recover common model glitches — bare `undefined`/`NaN` → `null`, empty values after colon (`{"a":1,"b":}`), unquoted keys (`{path:"x"}`), and `//` / `/* */` comments outside strings — so tool turns do not hard-fail on nearly-valid args.
- **Provider recovery tips**: classify quota/billing (incl. 403 + plain `insufficient_quota`), model-not-found, Anthropic 529/`overloaded_error`, DNS/`ENOTFOUND`, Anthropic “prompt is too long” context overflow, Azure/OpenAI content-management/`content_filter` (incl. HTTP 400 bodies), empty/no-choice responses, unsupported model features (`tools is not supported`), org verification, and deprecated-model with specific codes + expert tips instead of generic `provider_error` / `auth_forbidden` / `bad_request`. 529 is retryable.
- **Path-not-found hints**: when the immediate parent directory is missing, walk up one level and suggest similarly-named sibling dirs (`srcx/foo.ts` → `src/`).
- **Tool path display**: `displayRelPath` realpath-normalizes workspace/file pairs (macOS `/var` vs `/private/var`) so write/edit/read/grep/glob/apply_patch transcripts, permission-ask diffs, turn-end Δ summaries, /context rule labels, and LSP locations never leak `../../../../private/var/...` relatives (out-of-workspace paths stay absolute).
- **Advisory intent recall**: mid-run Q&A under ULW now recognizes common opinion/explain phrasings without a trailing `?` (`Thoughts on…`, `wdyt`, `walk me through`, `review the PR`, `help me understand…`, `pros and cons…`, `curious about…`, `TL;DR`/`ELI5`, `sanity check`, `remind me…`, `second opinion…`) so TodoGate / handoff-guard / proof-claim-guard do not trap pure questions. Explicit `please change/edit/update/patch` and `go ahead and…` remain work orders.
- **System prompt PE**: restore the canonical “State your reading first” phrasing (profile + operating principles) so multi-step work keeps the one-line reading doctrine.
- **Test portability**: mode-sensitive atomic-write / undo tests create files via `open(mode=…)` instead of `chmod(2)`; git fingerprint tests scaffold `.git` without `git init` — both survive sandboxes that deny chmod on locks/config.
- **Worktree porcelain**: `git()` no longer `trimStart()`s status output (`trimEnd()` only). Unstaged-only `" M path"` was losing the first path character (`src/…` → `rc/…`) and hiding untracked files. Quoted porcelain paths are unquoted. `--3way` unstage uses the same untrimmed porcelain parser so the parent index stays clean.
- **Worktree land is undoable**: isolation=worktree journals parent pre-images after a successful apply, so `/undo` reverts a bad auto-land. Failed `--3way` apply restores those pre-images before per-file fallback so the parent is not left half-applied. Landed paths drop FileReadState stamps so the parent re-reads before editing.
- **General-purpose spawn defaults to worktree** when the workspace is a git repo. Explore/plan stay in-place. Pass `isolation=none` or `FORGE_SUBAGENT_ISOLATION=none` to write the parent tree directly.
- **Compact clears file-read stamps**: after `/compact` (or auto-compact) the unread-edit guard forces a re-read. `/clear` / `/new` also drop stamps. Session delete forgets the registry entry.

### Added
- **`exit_plan_mode`**: agent-callable plan exit (Claude/Grok ExitPlanMode). Interactive confirm; headless stays in plan unless entered from `--yolo`. Subagents cannot flip the parent. `/build` remains the manual override.
- **`!cmd` bang-shell**: user-typed shell runs now (same PermissionGate; user-typed = approval; unsandboxed). Successful project checks stamp last-verify. Mid-run queues. `forge run "!cmd"` is headless-instant.
- **`@path` mentions**: inline file contents and stamp FileReadState. REPL tab-completes.
- **`/paste`**: attach clipboard image (pngpaste / osascript / wl-paste / xclip). Mid-run queues as an interjection.
- **Plan-mode Context7**: `call_mcp` read-only detection matches kebab-case (`query-docs`, `resolve-library-id`) and qualified `server__tool` names. `/plan` can read docs without `/build`; unknown verbs fail closed.
- **MCP always-allow is `server__tool`**: `[a]lways` / `[s]ession` on `call_mcp` persist the named tool, never `call_mcp(*)`. One Context7 approve cannot unlock Playwright or GitHub mutations. Plan mode ignores saved allows for mutating MCP. Legacy `call_mcp(*)` grants are scrubbed on load.
- **Plan-mode research bash**: `sed -n` / `sed -n -e` / `jq` / `git blame` / `git grep` / `git ls-files` / `git worktree list` / `stat` / `wc` / `file` / `diff` / `tree` / `realpath` are read-only. `sed -i` / `sed -e` (without `-n`) / `git stash` / `git worktree add` / `git cat-file -w` still fail closed.
- **Grok 4.6 + future flagship inherit** — default model is `grok-4.6` (500k, effort `low\|medium\|high\|xhigh`, max/`/effort` default `xhigh`). grok-4.5 stays `high`. Unknown newer Grok ids (`grok-4.7`, `grok-5`, …) inherit the latest known flagship effort/context/rates so a Forge release is not required for each xAI bump. `--model`/`/model` no longer treat a version bump as a typo of the previous catalog id (`grok-4.6` vs `grok-4.5`); `grok-45` still suggests `grok-4.5`. `forge models -p xai --refresh` and bare `/model` merge the live xAI `/v1/models` catalog when authenticated.
- **Session fork lineage** — forks record `parentSessionId`/`parentSessionLabel`; resume/`/share`/session summary show parent + children; sessions list marks `↳parent`.
- **Background task completion notify** — when bg bash exits, queues a mid-run harness interjection so the agent continues without polling (`FORGE_BG_NOTIFY=0` off). Pairs with `get_task_output wait=`.
- **/improve [focus…]** (alias `/ralph`) — zero-steering continuous-improve arm on ULW rails (cycle=1, auto-checkpoint, backlog seed, kickoff inject).
- **/hooks init|reload** — scaffold `.forge/hooks/example-stop.json`, reload matchers; list shows paths + blocking Stop; live-safe (`init`/`reload` = control).
- **Mid-run queue depth** — free-text mid-run feedback shows `q:N`; live prompt badges `q:` + `sub:` for queued messages and active subagents.
- **/done recovery tip** — wind-down surfaces last safety checkpoint sha for `/checkpoint restore`.
- **Plan-mode read-only bash** — `/plan` allows research shell (`git status/log`, `ls`, `rg`) while still hard-denying mutating bash/writes; system prompt updated.
- **Subagent worktree auto-land** — `isolation=worktree` captures the nested diff and `git apply`s it into the parent on success (`FORGE_SUBAGENT_LAND=auto|keep|discard`; kept on conflict; per-file copy fallback on partial conflict). Parent edit trail bumps on land. Docs: TOOLS/PRODUCTION/RELIABILITY.
- **Background task wait** — `get_task_output` accepts `wait`/`timeout_ms` (duration suffixes) so agents block until done instead of poll-loop thrash.
- **Write/edit always-grant path prefixes** — approving Write/Edit "always" scopes to `dir/**` (nested) instead of bare `*`; apply_patch matches paths inside the patch body.
- **Format-on-write auto** — enables when prettier/biome/ruff/gofmt/rustfmt are detectably configured; `FORGE_FORMAT_ON_WRITE=0/1` force; `/format` still sticky.
- **Cross-session project memory** — `memory_write scope=project`, `/memory project`, `~/.forge/project-memory/<key>.json` + `.forge/MEMORY.md`, auto-injected into system prompt + compact; `/init` seeds notes; status/share/doctor/config surfaces.
- **Fix-until-green** — after a preferred project check fails, injects `[Forge harness — fix until green]` so the model keeps repairing without waiting (`FORGE_FIX_UNTIL_GREEN=0` off).
- **Mid-loop auto-verify nudge** — after an edit streak without a fresh green check, injects a synthetic harness message (cap 2/prompt; `FORGE_AUTO_VERIFY_NUDGE=0` off; plan mode skipped).
- **Safety checkpoints** — `/checkpoint` (`/snap`) via non-mutating `git stash create`; ULW arm auto-checkpoints dirty trees (`FORGE_ULW_CHECKPOINT=0` off); destructive git (`reset --hard`, `clean -f`, force-push, …) auto-checkpoints (`FORGE_GIT_AUTO_CHECKPOINT=0` off).
- **Subagent live dashboard** — in-process active subagent list on `/status` and `/tasks`; `listActiveSubagents()` export.
- **Verification recognition** — broader `VERIFICATION_CMD_RE` (npx/bunx/forge check/format-check) + preferred bare script → `npm run <script>` matching; shell-arity grants for forge/tsx/bunx/eslint families.
- **Config/JSON surfaces** — `subagentLandMode`, `projectMemoryCount`, `lastCheckpoint` on effective config + run JSON; productionWarnings for land=discard / auto-verify off / ULW checkpoint off.

- **Native UI craft skills** — `forge-surface` (distinctive, subject-rooted, anti-AI-slop UI direction) and `forge-polish` (spacing/type/states/motion craft QA). Wired into `forge-method` task map; catalog-only progressive load.
- **Native forge-* skills (ship-with-install)** — package `skills/forge-*/SKILL.md` playbooks load as `source: builtin` (project > user > builtin). Progressive prompt injection: full catalog + paths; bodies for project/user and `forge-method` (`inject: always`); other builtins catalog-only (`read_file` when matching). `/skills` groups by source. `FORGE_BUILTIN_SKILLS=0` disables. Pack includes methodology (`forge-method` … `forge-craft`) plus UI (`forge-surface`, `forge-polish`).
- **ULW god-mode doctrine** — soft/empty `/ulw` = domain-agnostic ownership: **smart + hard** (leverage over thrash), **proactive subagents when they win**, philosophy-not-cage freestyle, research→ship→prove→repeat. Not product- or tests-only. See `docs/ULW.md`.
- **LSP ensure (smooth install)** — bottom-line default pack **TypeScript + Python**; **Rust/Go** when project markers present; Swift/shell tips only. `forge lsp ensure|status|detect`, `/lsp ensure`, `lsp({ action: "ensure" })`, `forge init` auto-ensure, once/day REPL tip. Env: `FORGE_LSP_AUTO=0`, `FORGE_LSP_AUTO_INSTALL=0`. See `docs/LSP.md`.
- **LSP install guide** — `docs/LSP.md`, `/lsp install`, `lsp({ action: "install" })`, and status/missing-on-PATH tips for typescript-language-server, pyright, rust-analyzer, gopls, and friends.
- **Subagent worktree isolation** — `spawn_subagent({ isolation: "worktree" })` creates a detached git worktree under `~/.forge/worktrees/`; on success Forge auto-lands into the parent (`FORGE_SUBAGENT_LAND`; `FORGE_SUBAGENT_KEEP_WORKTREE=1` forces keep).
- **MCP resources + prompts** — `mcp_resource` (list/read) and `mcp_prompt` (list/get) beyond tools; best-effort discovery at server connect.
- **Default MCP servers** — Forge ships **context7** (up-to-date library docs via `@upstash/context7-mcp`) and **playwright** (browser automation via `@playwright/mcp`) as built-in defaults (override/disable in mcp.json; `FORGE_MCP_DEFAULTS=0` off). `forge init` seeds `~/.forge/mcp.json`. Optional `CONTEXT7_API_KEY`.
- **MCP (Model Context Protocol)** — `search_mcp` + `call_mcp` tools (search-then-use). Config from `.forge/mcp.json`, `~/.forge/mcp.json`, `.mcp.json`, `.cursor/mcp.json` (Claude/Cursor shape). Lazy stdio/HTTP clients, qualified `server__tool` names, plan-mode read-only gating, `/mcp status|connect|tools|reload`, doctor status, `FORGE_MCP=0` off.
- **Subagents** — `spawn_subagent` (`Task` alias): nested agent loop with `general-purpose` / `explore` / `plan` types, capability modes, depth cap (`FORGE_SUBAGENT_MAX_DEPTH`), `SubagentStart`/`SubagentStop` hooks, ephemeral child sessions, token fold into parent. Headless: explore/plan free; full needs acceptEdits/allow/YOLO. Plan mode denies spawn.
- **LSP** — `lsp` tool (`diagnostics`/`hover`/`definition`/`references`/`symbols`/`workspace_symbols`/`status`). Defaults for typescript-language-server, pyright, rust-analyzer, gopls (on PATH). `.forge/lsp.json` overrides, workspace-scoped, lazy start, `/lsp status|restart`, `FORGE_LSP=0` off.
- **Public exports** — MCP/LSP managers + subagent helpers; also `looksLikeAdvisoryUserMessage`, `FileReadState`, `fileReadGuardEnabled`, and `FileReadStamp` from the package root.
- **Silent edits-without-verify Stop block (free triage)** — outside ULW/goal, stopping after file edits with no successful structural check now blocks once (same cap as proof-claim), even without "tests pass" prose. Reanchor names preferred project checks + the six-question self-audit. Skips advisory Q&A turns; ULW/goal keep their own proof/attestation paths (oh-my-kimi free-triage lesson).
- **Proof-claim self-audit checklist** — when Stop is blocked for a success claim without a successful structural check, the reanchor now includes a free six-question self-audit (completeness / evidence / framing / tests / fit / consequence), inspired by oh-my-kimi. Forces evidence-based closing instead of memory-based "all green" prose.

- **Session last-verification trail**: structural bash checks record `lastVerificationCommand` / `lastVerificationAt` on session meta (fork/export/import preserve). Surfaces on resume orientation, `/status`, `/stats`, `/share`, `/done`, compact summary, `forge sessions show`, `/export` markdown, status/run JSON + metrics, and a compact `✓` badge on `forge sessions list` / `/sessions`.
- **`/commit` verification awareness**: draft prompt includes last verification when present; `/commit do` warns when the session has edits but no recorded verification (names preferred project check).
- **`/done` wind-down verify tip**: shows last verify timestamp/command, or warns when edits lack recorded verification with preferred project check.
- **`/export` markdown project stack**: header includes cwd, turns/edits, detected project stack (pm + checks + monorepo), and last verify.
- **Finish-the-class doctrine**: system prompt (default + autonomous) requires grepping siblings/dependents before done; `/review` checklist includes the same class.
- **Q&A framing**: pure questions are not work orders — answer first, optional one-line follow-ups; explicit implement/fix/ship (and ULW soft-prompt expansion) overrides.
- **`/format` detected formatters**: status lists project prettier/biome/ruff/… and nudges `/format on` when available but disabled.
- **`editsWithoutVerification` production warning**: `forge run --json` warns when the session has edits but no recorded structural check (names preferred project command).
- **Last-verify trail is success-only**: failed structural checks still count as `verificationRan` for harness quality, but do not stamp `lastVerificationCommand`; a failed re-run also clears any prior green trail (no stale last✓).
- **Proof-claim done/fixed closers**: after edits, bare “Done.” / “Fixed.” / “Ready to merge.” without `verificationRan` blocks Stop once (same cap as “tests pass” claims).
- **`/status` no-verify tip**: when the session has edits but no `lastVerificationCommand`, status shows a yellow tip naming the preferred project check.
- **Share + session details no-verify**: `/share` and `/status` detail show `last-verify: (none after N edits — prefer \`check\`)` when edits lack a recorded structural check.
- **Resume orientation no-verify**: resume peek shows `Last verify: (none after N edits — prefer \`check\`)` so experts see the gap before continuing.
- **Stale last-verify**: `lastEditAt` stamps on each file edit; when edits land after a successful check, resume/`/status`/`/share`/export/footer show `⚠ stale (edits after verify)` (prompt flag `✓~`) so experts never trust a green trail after later mutations. Status/run JSON + metrics include `lastEditAt` + `lastVerificationStale`. `/commit do` warns when last-verify is stale. `forge run --json` adds `staleLastVerification` productionWarning. System prompt prefers `ask_user` for ambiguous/destructive choices. `/done` yellow-warns when last-verify is stale. Compact summary marks stale last-verify when `lastEditAt` > `lastVerificationAt`. Prompt strip shows `WT` for linked git worktrees (parallel agent sessions). System git context adds a linked-worktree scope tip (prefer this tree; no sibling checkout mutations). Proof-claim requires a *successful* structural check (`verificationPassed`); failed runs still count for ULW wave ledger execution only. ULW `**Cycle complete.**` attestation evidence also prefers `verificationPassed`. Compact summary re-asserts Q&A framing under ULW (advisory survives compact). Handoff-guard treats mid-investigation starters (“I'll start by…”, “Let me investigate…”) as incomplete yields under ULW/edits. `/undo`·`/retry` recompute `editCount`/`lastEditAt` from the surviving mutations journal so last-verify stale state stays honest after disk restore; `/undo` prints `edits now: N`.
- **Turn footer / prompt `✓`**: prompt strip shows `✓` when last-verify is recorded; turn footer prefers `last✓ <cmd>` over preferred-check tip.
- **`/review` last-verify**: review prompt includes last verification when present so reviewers can judge stale proof.
- **`/model` status orientation**: bare `/model` shows preferred project checks + last-verify (with stale marker) for mid-run model switches.
- **`/effort` status orientation**: bare `/effort` shows the same preferred checks + last-verify orientation.
- **Empty bash recovery uses project checks**: whitespace-only `bash` errors show preferred project check examples from project-intel (not a generic `npm test`).
- **`/permissions` status orientation**: bare `/permissions` shows preferred checks + last-verify (parity with `/model` · `/effort`).
- **Empty path recovery**: whitespace-only `read_file`/`write_file`/`search_replace` errors remind agents to use workspace-relative paths and list_dir/glob first.
- **Empty pattern recovery**: whitespace-only `grep`/`glob` patterns fail closed with concrete examples and “omit path” guidance.
- **`/budget` status orientation**: bare `/budget` shows session edits + last-verify (stale marker) so spend decisions account for unfinished proof.
- **Empty web/patch recovery**: whitespace-only `web_search`/`web_fetch`/`apply_patch` fail closed with concrete examples and fail-closed tips.
- **Empty ask_user recovery**: whitespace-only `ask_user` questions fail closed with a concrete example (prefer clarifying over guessing).
- **Empty todo_write recovery**: missing/null `todos` fails closed with merge tip + status enum (empty id/content already fail closed).
- **`/todos` empty tip**: empty board points at `todo_write` + preferred project check.
- **`/clear` last-verify reset tip**: soft clear notes last-verify trail reset and preferred project check for the next edits.
- **`/new` preferred check tip**: fresh session banner includes preferred project check + `/context` pointer.
- **`/fork` orientation**: fork banner shows last-verify (stale marker) + preferred project check.
- **`/fork-and-compact` orientation**: same last-verify + preferred check after compacting the fork.
- **Compact stale trail**: `/compact` · `/compact-and` · `/fork-and-compact` pass `lastEditAt`/`lastVerificationAt` so compact summaries mark stale last-verify correctly.
- **`/compact` last-verify note**: compact banner surfaces last-verify (stale marker) or no-verify tip after edits.
- **`/compact-and` last-verify note**: continuing after compact also surfaces last-verify trail.
- **Hostile self-review doctrine**: system prompt (default + autonomous) requires re-reading the diff after substantive edits before claiming done.
- **`/export` trail note**: writing an export file notes last-verify (stale marker) or no-verify after edits.
- **Session import trail**: `importSessionJson` preserves `lastEditAt`/`lastVerification*`; `forge sessions import --json` includes `lastVerificationStale`.
- **Turn-end notify verify trail**: desktop notify/BEL outcome labels append `no last-verify` / `last-verify stale` / `verified` after edits so background ULW experts see unfinished proof.
- **`/notify` trail orientation**: bare `/notify` shows session edits + last-verify trail and explains turn-end body suffixes.
- **Headless turn-end attention**: `forge run` fires the same opt-in BEL/notify with verify-trail outcome labels as the interactive REPL.
- **`/bell` trail orientation**: bare `/bell` shows session edits + last-verify trail (parity with `/notify`).
- **Slash verify orientation helpers**: shared `formatSlashVerifyOrient` / `formatSlashSessionTrail` keep `/model`·`/effort`·`/permissions`·`/notify`·`/bell` trail copy consistent.
- **ULW proof-demand preferred checks**: wave proof prefers `verificationPassed`; proof-demand reanchor names preferred project checks.
- **ULW proof-demand failed vs missing**: reanchor distinguishes a red check from never running one.
- **Doctor `verify-hint-off`**: `FORGE_VERIFY_HINT=0` is a yellow doctor issue + productionWarning (parity with file-read-guard-off).
- **`/ulw` preferred checks tip**: arm banner lists preferred project checks and notes proof-demand requires green.
- **`/goal set` preferred checks tip**: arm banner lists preferred project checks and notes attestation needs green after edits.
- **`/goal resume` preferred checks tip**: resume banner lists preferred project checks (parity with `/goal set`).
- **Slash orient chalk fix**: only the no-verify line is yellow; preferred-checks stay dim.
- **`/cycle 0` LAST tip**: wind-down lists preferred checks + session last-verify trail before **Cycle complete.**
- **`/max-waves` LAST tip**: auto-flip to LAST lists preferred checks + session trail (parity with `/cycle 0`).
- **Compact advisory intent**: when the last dropped user message looks like Q&A/opinion, compact handoff marks `ADVISORY/Q&A` and forbids implement/edit/commit unless explicitly asked (oh-my-claude compact-intent lesson).
- **Mid-run advisory interjections**: under ULW/goal, free-text that looks like Q&A is framed `ADVISORY/Q&A` so momentum does not override a question.
- **Shared advisory-intent util**: `looksLikeAdvisoryUserMessage` lives in `src/util/advisory-intent.ts` (compact + interjection).
- **Advisory ULW discoverability**: AGENTS.md · PRODUCTION.md · `forge tips` document ADVISORY/Q&A framing under ULW.
- **Compact last meta-request**: advisory compact handoff inlines the last user Q&A snippet so post-compact turns keep the original question.
- **Compact intent-first**: ADVISORY/Q&A intent is placed at the top of the harness section (before ULW soft-prompt expansion) so momentum language cannot bury the question.
- **Compact soft-prompt suspend**: when Intent is ADVISORY/Q&A, the ULW “soft prompt expanded to god-scope” line is annotated suspended so it cannot contradict the question.
- **Compact expanded-mandate suspend**: under ADVISORY/Q&A, the expanded mandate line is labeled suspended so god-scope text cannot override the question.
- **Compact goal suspend under ADVISORY**: active `/goal` is labeled paused for ADVISORY/Q&A so relentless-driver language cannot override a question.
- **Compact todos suspend under ADVISORY**: open todos are labeled context-only so TodoGate momentum cannot override a question.
- **TodoGate advisory release**: under ULW, open todos do not block Stop when the last user (or assistant) message is pure Q&A/advisory.
- **TodoNudge advisory skip**: mid-turn todo nudges are suppressed when the latest user message is pure Q&A.
- **TodoGate advisory clears soft fires**: advisory Q&A release resets soft TodoGate fire count so the next work stop can soft-block once again.
- **Handoff advisory release**: under ULW, soft continue-asks after pure Q&A (“let me know if you want me to implement”) are allowed; incomplete mid-implementation with edits still blocks.
- **Proof-claim advisory Done.**: bare “Done.”/“Fixed.” after a pure Q&A user turn is not treated as an unverified work claim (even if the session has prior edits).
- **Success-only proof + attestation**: proof-claim and goal/ULW attestations require `verificationPassed` (failed checks still count as ULW `verificationRan` execution only). Goal attestation bounce names preferred checks. Proof-claim reanchor cites stale last-verify.
- **`/undo`·`/retry` edit trail**: recompute `editCount`/`lastEditAt` from surviving mutations journal; print `edits now: N`.
- **Worktree + mid-investigation**: prompt strip `WT` + git scope tip; handoff-guard blocks “I'll start by reading…” under ULW (not pure explanation Q&A). Compact re-asserts Q&A framing.

- **Project intelligence in system prompt**: detect package manager (npm/pnpm/yarn/bun via lockfile + `packageManager` field) and preferred check commands from `package.json` scripts / Cargo / go.mod / pytest / etc. Injected into the baseline Workspace block so the agent verifies with the right commands without rediscovering the stack. Session `/status` and REPL banner show `pm` + top checks. (`src/util/project-intel.ts`)
- **Stale/unread edit guard** (OpenCode-inspired): agent-loop `search_replace` / `write_file` (overwrite) / `apply_patch` (update/delete) require a prior `read_file` and refuse when mtime/size changed since last read/write. Prevents blind clobbers and concurrent-edit races. Kill-switch: `FORGE_FILE_READ_GUARD=0`. (`src/agent/tools/file-read-state.ts`)
- **`/context` project stack** + **bash wrong-PM tip**: `/context` shows detected package manager and preferred check commands; failed bash that used the wrong Node package manager appends a concrete rewrite tip (also parses Corepack “configured to use yarn/pnpm” stderr).
- **Post-edit verify hint**: successful `search_replace` / `write_file` / `apply_patch` append `Tip: verify with \`<cheapest project check>\`` (kill-switch `FORGE_VERIFY_HINT=0`). Skipped for pure docs (`.md`/`.txt`/…).
- **Doctor / config discoverability**: `forge doctor` and `/config` surface project-stack summary plus `FORGE_FILE_READ_GUARD` / `FORGE_VERIFY_HINT` effective state. `/config` and `forge config --json` include `packageManager`, `checkCommands`, `projectStackSummary`, `monorepoRoot`, `workspaces`. Project intel is TTL-cached (~5s, marker-mtime invalidated) so post-edit tips stay cheap.
- **Proof-claim + handoff reanchors use project checks**: when Stop is blocked for “tests pass” without a run, or for premature “shall I continue?”, the bounce names this workspace’s preferred commands (from project-intel).
- **Doom-loop / error-streak verify hints**: circuit-breaker messages name the cheapest project check (`npm run typecheck`, …) so thrash recovery steers toward real verification.
- **Structural verification matches project checks**: `isVerificationCommand()` counts preferred project-intel commands (e.g. custom `npm run unit`) and expands the regex for `smoke` / `mix test` / `composer test`.
- **`forge doctor --json` / run·status JSON project stack**: structured `packageManager`, `projectKinds`, `checkCommands`, `projectStackSummary`, `fileReadGuard`, `verifyHint` on doctor; run/status JSON also emit `packageManager` + `checkCommands` + `projectStackSummary`. Doctor flags `file-read-guard-off` (exit 1) when `FORGE_FILE_READ_GUARD=0`.
- **`productionWarnings`**: `forge run --json` warns when `FORGE_FILE_READ_GUARD=0` (blind overwrites).
- **Statusline project label**: HUD/`forge status` project path appends `pm` + cheapest check (e.g. `CLI · npm · npm run typecheck`). Structured `packageManager` / `checkCommands` / `projectStackSummary` on each status snapshot (JSON).
- **Bash missing-script tip**: when npm/pnpm/yarn reports a missing script, append available project scripts (priority: typecheck/test/lint/…) and **Did you mean** for near-typos (edit distance ≤ 2).
- **Bash missing-binary tip**: when `tsc`/`eslint`/`turbo`/… is not on PATH, suggest the project check command or pm-native runner (`npx` / `pnpm dlx` / `yarn dlx` / `bunx`).
- **Bash next-check tip**: when a verification command fails, suggest the next preferred project check (`Next try: npm test`).
- **Bash monorepo layout tip**: workspace/importer errors (`ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`, turbo/nx workspace miss) point at monorepo root + preferred root check.
- **Doctor / productionWarnings / bash / status missing `node_modules`**: when `package.json` exists but `node_modules` does not, doctor + `forge run --json` warn with a pm-native install tip; bash `Cannot find module` errors also tip install. Doctor + status JSON include `nodeModulesPresent`. Monorepo **hoisted** root `node_modules` counts as present for nested package cwds.
- **Doctor packageManager vs lockfile mismatch**: when `package.json#packageManager` disagrees with a present lockfile (e.g. `pnpm@9` + `package-lock.json`), doctor flags a yellow issue with cleanup guidance. Structured as `packageManagerMismatch` on `forge doctor --json`. Multiple lockfiles without a field also warn (install drift) — doctor/status/run JSON `multipleLockfiles[]`; bash install failures tip when ≥2 lockfiles.
- **`/init` + `/review` + plan-mode + `/diff` + `/files` + `/undo` + resume + turn-footer project intel**: preferred checks surface in init/review/plan prompts, `/diff`/`/files`/`/undo` verify tips, resume orientation (`Checks: …`), and post-turn footer (`✓ npm run typecheck`) after edits.
- **`/commit [staged] [do]`**: draft a commit message from the git diff (default draft-only). `/commit do` creates the commit with hard rules (no push, no force, prefer project checks).
- **First-run welcome tip**: includes `/commit`, `/context`, and detected project stack (`pm` + cheapest check) when available.
- **Bash permission-denied tip**: EACCES / “Permission denied” failures get a recovery tip (ownership/mode, workspace bounds, `/build` if plan mode); sandbox/IMDS policy denies are left alone.
- **Last verification command**: when bash runs a structural check, session meta records `lastVerificationCommand` + timestamp; resume orientation shows `Last verify: …` (cleared on `/clear hard`). Compact summaries include preferred project checks + last verify so post-compact turns stay oriented.
- **Tool schemas**: `search_replace` / `write_file` / `apply_patch` descriptions document the session read-before-edit + stale-mtime guard so models avoid blind overwrites without rediscovering the rule.
- **search_replace / write_file line-prefix strip**: when old_string/new_string/content look like pasted `read_file` output (`   12|code`), strip the line-number prefixes automatically and note it in the result. Partial/mixed numbered pastes get an edit-miss tip.
- **Monorepo workspaces**: project-intel detects `package.json` workspaces / `pnpm-workspace.yaml`, tags `monorepo`, and injects a Workspaces line into the system prompt (package-scoped check guidance).
- **Turbo / Nx**: when `turbo.json` / `nx.json` is present, preferred checks include `turbo run typecheck|test|…` / `nx run-many -t …` and kinds gain `turbo`/`nx`.
- **Nested package walk-up**: when cwd is inside a monorepo package, project-intel walks up to the workspace root (bounded by **git root** so unrelated parent monorepos never leak), merges root checks/workspaces, and surfaces `Monorepo root:` in the system prompt. Doctor/status/`/context`/`/config` expose `monorepoRoot`. Nested packages without a local lockfile inherit the root package manager (pnpm/yarn/bun).
## 0.9.99 — prompt editor cursor redraw fix

### Fixed

- **Arrow/edit redraw corruption**: the multi-line prompt editor now tracks the cursor’s **view row inside the editor block** and always redraws from the block top (never assumed “cursor is at the bottom”). Soft-wrap–aware layout math; no extra toast lines that desync paint. Left/right arrows, backspace, and mid-line edits stay visually stable.

## 0.9.98 — multi-line paste editor (no auto-run)

### Added

- **Premium REPL multi-line paste**: bracketed paste mode (`CSI ?2004 h`) so Ghostty/iTerm treat pastes as safe; pasted newlines **never** submit. Explicit **Enter** sends the full draft; **Ctrl+J** / **Alt+Enter** / **Shift+Enter** (Kitty CSI u) insert a newline. Burst fallback when a terminal omits paste brackets. Multi-line draft chrome (`N lines · ↵ send`), paste toast, multi-line history encoding, Tab completion preserved. Non-TTY falls back to classic readline.

### Changed

- Banner tip documents paste-safe multi-line input.

## 0.9.97 — mid-run SuperGrok 403 token recovery (unattended ULW)

### Fixed

- **Mid-run auth death on SuperGrok 403**: xAI often rejects a dead access token with HTTP **403** `"The OAuth2 access token could not be validated"` (not 401). Recovery previously only treated 401 / narrow message patterns as token failures, so long ULW runs aborted mid-wave even when `refresh_token` or a second SuperGrok account could continue. `isTokenAuthFailure` now classifies that 403, forces refresh, then multi-account auth failover; proactive refresh failure also switches accounts before the next chat call. Quota/billing 403s still take the quota switch path.

## 0.9.96 — goal achieve clears soft TodoGate

### Changed

- **`markGoalDone`** and **goal attestation** (`**Goal achieved.**`) reset soft TodoGate fire count so Stop is not once-blocked for leftover open todos after the goal is released.

## 0.9.95 — goal stuck-wall soft TodoGate + /max-waves LAST UX

### Changed

- **Goal stuck-wall release** clears soft TodoGate (parity with ULW stuck-wall).
- **`/max-waves`** output highlights immediate LAST when the cap is already at/under the current wave.

## 0.9.94 — setMaxWaves immediate LAST

### Changed

- **`setMaxWaves(N)`** when ULW is CONTINUE and `wave >= N` flips to LAST immediately (no wait for next Stop) and clears soft TodoGate; live notice when applied via `/max-waves`.

## 0.9.93 — max_waves LAST + stuck-wall clear soft TodoGate

### Changed

- **max_waves auto LAST** and **ULW stuck-wall release** reset soft TodoGate fire count (parity with `/cycle 0` / safety valves).

## 0.9.92 — /goal set soft TodoGate coverage

### Changed

- Tests cover `/goal set` clearing soft TodoGate; AGENTS.md documents fresh-driver arm paths.

## 0.9.91 — fresh driver clears soft TodoGate

### Changed

- **`/ulw`** and **`/goal set`** reset soft TodoGate fire count so a newly armed driver is not blocked once for leftover open-todo Stop attempts from prior work.

## 0.9.90 — clearSoftTodoGateOnWindDown helper

### Changed

- **`clearSoftTodoGateOnWindDown(sessionId)`** named helper (exported) used by all wind-down paths; AGENTS.md documents the full clear matrix.

## 0.9.89 — /goal clear soft TodoGate + HARNESS docs

### Changed

- **`/goal clear`** resets soft TodoGate fire count (parity with `/goal done` / `/done`).
- HARNESS.md documents all soft TodoGate wind-down clear paths.

## 0.9.88 — safety valve + /goal done clear soft TodoGate

### Changed

- **`maybeFlipUlwToLastOnSafetyValve`** and **`/goal done`** reset soft TodoGate fire count (parity with `/done` / `/cycle 0` / `/ulw-off`) so wind-down paths are not blocked once for leftover open todos.

## 0.9.87 — /cycle 0 clears soft TodoGate

### Changed

- **`/cycle 0` (LAST)** resets soft TodoGate fire count (parity with `/done` / `/ulw-off`) so wind-down is not blocked once for leftover open todos.

## 0.9.86 — /clear and /new clear soft TodoGate

### Changed

- **`/clear`** and **`/new`** / **`/clear hard`** reset soft TodoGate fire count for the session so a fresh conversation is not blocked once for pre-clear open-todo Stop attempts.

## 0.9.85 — /ulw-off clears soft TodoGate

### Changed

- **`/ulw-off`** resets soft TodoGate fire count (parity with `/done`) so disarm is not followed by a leftover once-block for open todos.

## 0.9.84 — /done clears soft TodoGate

### Changed

- **`/done`** resets soft TodoGate fire count for the session so wind-down is not blocked once for leftover open todos the user is intentionally ending.

## 0.9.83 — run --json lastError docs

### Changed

- **`forge run --json` help** lists `lastError` on success payloads; PRODUCTION.md documents recovery codes (`max_cost`, `max_turns`, `continue_cap_*`, `handoff_released`, `proof_claim_released`, …).

## 0.9.82 — doctor unlimited-budget tip

### Changed

- **Doctor**: when `maxCost` is unlimited, tip to set a spend cap before long unattended ULW; smoke asserts harness + unlimited-budget doctor tips.

## 0.9.81 — doctor less-steering harness tips

### Changed

- **Doctor preferences**: tip when both BEL and desktop notify are off; always lists less-steering harness features (handoff-guard, proof-claim, soft TodoGate, `/budget`, safety-valve ULW flip, `/done`).

## 0.9.80 — proof-claim pattern expansion

### Changed

- **Proof-claim detector** also matches `typechecks cleanly`, `all checks are green`, and `verified with/via npm test` (still ignores bare “the bug is fixed” / “I verified the fix works” without a named check).
- AGENTS.md documents `turnEndOutcomeLabel`.

## 0.9.79 — turnEndOutcomeLabel

### Changed

- **`turnEndOutcomeLabel`** pure helper (exported) drives turn-end notify/BEL bodies; unit-tested for safety valves, handoff/proof release, and flag precedence.
- Package keywords: `budget`, `handoff`, `notify`, `proof-claim`, `cost-cap`.

## 0.9.78 — notify outcome labels

### Changed

- **Turn-end desktop notify / BEL body** labels safety-valve outcomes: cost cap, max turns, continue cap, handoff/proof-claim released, and other `lastError` codes — not only cost/maxTurns/aborted.

## 0.9.77 — soft TodoGate stop-guard coverage

### Changed

- Stop-guard + system-prompt tests cover soft TodoGate outside ULW (`todoGate: true`, once-per-prompt) and harness docs for Handoff/Proof-claim/TodoGate.

## 0.9.76 — TodoGate adaptive effort

### Changed

- **TodoGate Stop blocks** bump adaptive effort (parity with handoff/proof-claim) so the continue thinks harder about finishing or cancelling open todos.
- System prompt harness section documents soft TodoGate outside ULW.

## 0.9.75 — safety-valve tip smoke + ULW docs

### Changed

- Smoke asserts the “safety valves flip ULW” expert tip stays present.
- ULW.md documents CONTINUE→LAST auto-flip on spend/turn/continue-cap safety valves.

## 0.9.74 — keepLastError hardening + tips

### Fixed

- **`keepLastError`** also preserves `max_turns` and any `continue_cap_*` codes by string (not only boolean flags), so resume orientation never loses the recovery tip after a clean-looking Stop path.

### Changed

- AGENTS.md + expert tips mention safety-valve ULW CONTINUE→LAST flip.

## 0.9.73 — continue-cap flips ULW to LAST

### Fixed

- **`releasedOnContinueCap` under ULW CONTINUE** also auto-flips to `cycle=0` (LAST) — covers length / content_filter / empty / Stop-block caps so the session is not stuck re-blocking after the safety valve.

## 0.9.72 — safety valves flip ULW to LAST

### Fixed

- **maxTurns under ULW CONTINUE** also auto-flips to `cycle=0` (LAST), same as spend cap — shared helper `maybeFlipUlwToLastOnSafetyValve` (alias `maybeFlipUlwToLastOnCostCap`).

## 0.9.71 — cost-cap flips ULW to LAST

### Fixed

- **Spend-cap under ULW CONTINUE**: when `hitCostCap` fires with ULW `cycle=1`, auto-flip to `cycle=0` (LAST) so resume/continue is not stuck re-blocking forever. Note + `lastError` tips explain how to raise the budget and `/cycle 1` to resume waves. Helper: `maybeFlipUlwToLastOnCostCap`.

## 0.9.70 — live-run header controls

### Changed

- **Live-run header** control legend includes `/budget`, `/done`, and `/notify` (parity with ULW live-controls hint) so experts discover spend/wind-down/attention mid-turn without leaving the busy chrome.

## 0.9.69 — status budget JSON + docs

### Added

- Status JSON (`forge status --json` / `snapshotsToJson`) includes `budget` + `BUDGET:*` tags when a spend cap is armed (verified by unit test).
- AGENTS.md lists `cost-budget` + `production-warnings` modules; STATUSLINE.md documents budget segment and tags.

## 0.9.68 — production-warnings module + unit tests

### Changed

- **`productionWarningsForRun`** extracted to `src/util/production-warnings.ts` (exported) with unit tests for safety valves, ULW-without-budget, and dirty-tree thresholds. PRODUCTION.md documents post-run warning strings.

## 0.9.67 — productionWarnings safety valves

### Added

- **`run --json productionWarnings`**: post-run entries for `hitCostCap`, `hitMaxTurns`, and `releasedOnContinueCap` so CI can alert on safety valves via one array (fields remain first-class too).

## 0.9.66 — /bell live notice + tips smoke

### Changed

- **`/bell on|off`** pushes a live mid-run notice (parity with `/notify` and `/budget`).
- Smoke covers `forge tips` / `tips --json` / headless `/tips` for the Less steering line.

## 0.9.65 — tests must be able to fail

### Changed

- **System prompt** (oh-my-kimi): “Tests must be able to fail” — never weaken assertions or rewrite tests solely to go green; fix the code or name a real external blocker.
- Tips coverage asserts Less steering / handoff / proof-claim / budget / notify lines stay present.

## 0.9.64 — /notify live notice + less-steering tips

### Changed

- **`/notify on|off`** pushes a live mid-run notice (parity with `/budget`).
- Expert tips add a “Less steering” line (handoff-guard, proof-claim, soft TodoGate, `/done`, intent restatement) and list `/notify` in live mid-run controls.
- RELIABILITY.md documents handoff-guard, proof-claim-guard, soft TodoGate, desktop notify, and interjection harness context.

## 0.9.63 — /status budget + export cost

### Fixed

- **`/status` HUD** now passes `maxCostUsd` into the snapshot so budget % / BUDGET tag appear (parity with the live turn footer).

### Added

- **Session markdown export** includes est. cost and budget line when a session spend cap is set.

## 0.9.62 — preserve guard-release lastError

### Fixed

- Clean Stop no longer clears `lastError` stamped by handoff/proof-claim release (`handoff_released` / `proof_claim_released`) or `max_cost`, so resume orientation keeps the recovery tip.

## 0.9.61 — guard-release lastError + doctor notify

### Added

- **Handoff / proof-claim release stamps `lastError`** (`handoff_released` / `proof_claim_released`) so resume orientation explains why the agent stopped short after the guard cap.
- Doctor preferences show `notify=on` and tip `/notify on` when desktop notify is off; `doctor --json` includes `notifyOnTurnEnd`.

### Changed

- Stop-guard header documents proof-claim as composition step 7.

## 0.9.60 — live controls + intent restatement

### Changed

- **ULW live-controls hint** includes `/budget`, `/notify`, and `/done` so experts discover spend/attention/wind-down mid-run.
- **System prompt**: oh-my-kimi-style “state your reading first” on multi-step work (one line, then proceed) — reduces wrong-fork re-steering.
- Package description lists handoff-guard, proof-claim-guard, `/budget`, `/notify`, and `/done` wind-down.

## 0.9.59 — /budget live notice + ULW docs

### Changed

- **`/budget` set/clear** pushes a live mid-run notice so the agent can prioritize verification/wind-down before `hitCostCap`.
- ULW + AGENTS docs list handoff-guard, proof-claim-guard, soft TodoGate, and spend cap.

## 0.9.58 — run JSON effective budget

### Added

- **`forge run --json`**: `effectiveMaxCostUsd` (session `/budget` override wins; `null` = unlimited) and `sessionCostUsd` (running estimate) so CI can alert on spend without scraping `/cost`.

## 0.9.57 — interjection harness context

### Changed

- **Mid-run free-text framing**: when ULW/goal/open todos/plan mode are active, drained interjections include a short `[Forge harness still active: …]` line so free-text steering does not silently drop the mandate. Empty when no driver is armed (Q&A unchanged).

## 0.9.56 — /done winds ULW+goal

### Changed

- **`/done`**: marks goal achieved *and* flips ULW `cycle=1 → 0` (LAST wave) in one live control so experts wind down both drivers without juggling `/goal done` + `/cycle 0`. Live notice tells the agent to finish the wave and attest **Cycle complete.**
- Welcome tip mentions `/budget`, `/notify`, and `/done` wind-down.
- Statusline tags include `BUDGET:N%` / `BUDGET:HIT` when a spend cap is armed.

## 0.9.55 — smoke + doctor cost budget coverage

### Added

- Smoke fail-closed checks for `--max-cost` (invalid/empty), `doctor`/`config` JSON `maxCostUsd`/`maxCostUnlimited`, and headless `/budget` + `/cost`.
- Dirty-tree production warning only under ULW (≥20 files) or extreme dirt (≥100) so normal WIP does not spam every `forge run --json`.

## 0.9.54 — soft TodoGate outside ULW + sessions cost

### Added

- **Soft TodoGate outside ULW**: open todos block Stop once per prompt (then release) so half-finished checklists are finished or cancelled without requiring ULW. Disable with `FORGE_TODO_SOFT_OUTSIDE_ULW=0`.
- **Sessions list cost**: `forge sessions list` and `/sessions` show estimated spend (`~$x`); JSON list includes `estCostUsd`, token totals, and `maxCostUsd` when set.

## 0.9.53 — proof-claim guard (don't claim, prove)

### Added

- **Proof-claim guard** (`src/harness/proof-claim-guard.ts`): Stop blocks once when the assistant claims verification success (“tests pass”, “all green”, “typecheck clean”, …) without a structural `verificationRan` signal, and work is in flight (edits / goal / ULW / open todos). Cap via `FORGE_PROOF_CLAIM_BLOCK_CAP` (default 1). Complements ULW proof-demand for non-ULW implementation turns so experts are not forced to ask “did you actually run the tests?”

## 0.9.52 — ULW auto-title + handoff effort + budget on cards

### Added

- **`/ulw` auto-title**: untitled sessions take a smart title from the mandate so `/sessions` and resume pickers stay navigable during long unattended runs (never overwrites an explicit `/title`).
- **Handoff → adaptive effort**: polite-yield Stop blocks bump `effortBoostTurns` so the next continue thinks harder instead of re-asking the user.
- **Budget on resume/share**: `formatResumeOrientation` and `formatSessionShareCard` surface session spend cap + token estimate when armed.

## 0.9.51 — budget HUD + desktop notify

### Added

- **Budget in HUD**: turn footer, compact strip, and `forge status` show `budget N% $spent/$cap` (yellow ≥80%, red HIT) when a spend cap is armed.
- **Desktop notify** (`/notify on|off|test`, `FORGE_NOTIFY=0|1`, preference `notifyOnTurnEnd`): opt-in OS notification on turn end (macOS osascript, Linux notify-send, Windows balloon). Combined with BEL via `maybeTurnEndAttention`.
- **ULW without spend cap** production warning on `forge run --json` when ultrawork is armed and no effective budget is set.

## 0.9.50 — session cost budget

### Added

- **Session spend cap** (`max_cost_usd` / `FORGE_MAX_COST_USD` / `--max-cost` / `/budget`): releases the agent cleanly when the running `estimateCostUsd` hits the cap (`hitCostCap` on loop/JSON/metrics; `lastError.code=max_cost`). Default unlimited (`0`). Session override via `/budget <usd>|off` (live mid-run; status readonly). Soft Q&A: estimate only — not a bill.
- `/cost` shows the budget line; `/config` and doctor/run JSON expose `maxCostUsd` / `maxCostUnlimited`; stats track `costCapHits`.

### Changed

- Agent loop checks the cost cap at turn start and after each usage update (before more tool work).
- `clearConversation` drops per-session budget override so the next conversation inherits config again.

## 0.9.49 — handoff guard (finish, don't hand off)

### Added

- **Handoff guard** (`src/harness/handoff-guard.ts`): Stop blocks premature polite yields — “let me know if…”, “shall I continue?”, “want me to…?”, “stopping here” — under ULW/goal/open todos, and hard continue-asks even without a driver. Soft Q&A closers (“let me know if you have questions”) still allow Stop outside a driver. Incomplete mid-implementation closers block after edits. Cap via `FORGE_HANDOFF_BLOCK_CAP` (default 3) releases a stuck polite model.
- System prompt finish doctrine (oh-my-kimi-inspired): autonomous + default profiles and harness section tell the model to finish instead of re-steering the user.

### Changed

- `runStopGuard` composition step 6 evaluates handoff after TodoGate/ultrawork backstop; loop tracks `handoffBlocks` and logs `Handoff-guard blocked premature yield`.

## 0.9.48 — doctor skills context pressure

### Added

- **Doctor skills context pressure**: warn when project skill packs consume ≥12% of the configured context window


## 0.9.47 — share card skills + README examples

### Added

- **Share card skills count**: `/share` project line includes `skills=N` when skill packs are loaded
- **README skills examples**: documents `examples/forge-skills/` and headless `/skills`


## 0.9.46 — /context project skills + headless /skills smoke

### Added

- **`/context` project skills**: show loaded skill packs + token estimate (parity with project rules); headless `/skills` smoke


## 0.9.45 — /init skills guidance

### Changed

- **`/init` skills guidance**: bootstrap prompt covers `.forge/skills/**/SKILL.md` playbooks and `/skills` listing

## 0.9.44 — project skills (OpenCode-inspired)

### Added

- **Project skills (OpenCode-inspired)**: load `.forge/skills/**/SKILL.md` (also `.agents/skills`, `~/.forge/skills`) into the system prompt as playbooks. `/skills` lists them; doctor exposes `projectSkillsCount`.


## 0.9.43 — many pinned productionWarnings + smoke

### Added

- **`run --json productionWarnings` many pinned**: warn when ≥10 pin-protected sessions accumulate
- **Smoke `sessions pinned --json`**: CI asserts `pinnedOnly` on the list filter action


## 0.9.42 — /sessions pin|unpin <id> mutation

### Fixed

- **`/sessions pin|unpin <id>`**: pin/unpin a specific session (CLI parity); bare `/sessions pin`/`pinned` still lists pin-protected keepers


## 0.9.41 — forge sessions pinned action fix

### Fixed

- **`forge sessions pinned` action**: list pin-protected sessions (parity with `/sessions pinned` and `--pinned`); was treated as a title query


## 0.9.40 — doctor sessionsPinned inventory

### Added

- **Doctor sessionsPinned inventory**: report/JSON count pin-protected sessions; tip at ≥10 to review `/sessions pinned`


## 0.9.39 — dontAsk / FORGE_DONT_ASK visibility

### Added

- **dontAsk / FORGE_DONT_ASK visibility**: doctor + `run --json productionWarnings` surface when interactive asks (permissions + `ask_user`) are disabled


## 0.9.38 — ask_user clarifying questions

### Added

- **`ask_user` tool (OpenCode-inspired)**: interactive clarifying questions with optional multiple-choice; headless fails closed so agents state assumptions instead of blocking CI. Timeout via `FORGE_ASK_USER_TIMEOUT_MS` (default 5m).


## 0.9.37 — richer slash arg completion for expert control

### Added

- **Richer slash arg completion**: `/cycle` `/goal` `/effort` `/permissions` `/sessions` `/max-waves` `/ulw` first-arg completion for expert mid-run control


## 0.9.36 — slash arg completion + sessions completion hygiene

### Fixed

- **Completion hygiene**: dedupe `--untitled` in shell completion; add `errors`/`untitled` session action aliases

### Added

- **Slash arg completion**: `completeSlash` offers `/format on|off|status` (and `/bell`/`/plan`/`/build` args)


## 0.9.35 — run --json formatOnWrite + formatter-available doctor tip

### Added

- **`run --json formatOnWrite`**: headless success/error payloads include effective format-on-write
- **Doctor formatter-available tip**: when prettier/biome/ruff/… is present but format-on-write is off, doctor highlights the gap


## 0.9.34 — status --json formatOnWrite + smoke

### Added

- **status/config/doctor smoke for formatOnWrite**: `forge status --json` envelope includes `formatOnWrite`; smoke covers doctor/status/config


## 0.9.33 — formatOnWrite on /config + doctor

### Added

- **format-on-write on `/config` + doctor**: effective config snap + doctor report/JSON expose `formatOnWrite` (env wins)


## 0.9.32 — Format-on-write (opt-in)

### Added

- **Format-on-write (opt-in, OpenCode-inspired)**: after `write_file` / `search_replace` / `apply_patch`, optionally run project prettier/biome/ruff/gofmt/rustfmt. Enable with `/format on` or `FORGE_FORMAT_ON_WRITE=1` (env wins). Best-effort — never fails the tool.


## 0.9.31 — sessions list --json inventory summary

### Added

- **`forge sessions list --json` inventory summary**: `sessionsTotal` / `sessionsUntitled` / `sessionsWithLastError` / `sessionsPinned` (global, unfiltered) for CI prune hygiene; human list footer when inventory is large

## 0.9.30 — run --json productionWarnings large inventory

### Added

- **`run --json productionWarnings` large inventory**: warn when ≥100 sessions on disk (parity with doctor; prune guidance)

## 0.9.29 — Doctor large inventory tip + empty_run expert tip

### Added

- **Doctor large inventory tip**: warn when ≥100 sessions on disk with prune guidance (lastError protect noted)
- **Expert tip for empty_run**: forge tips cover empty headless run recovery

## 0.9.28 — CLI sessions list --untitled

### Added

- **`forge sessions list --untitled`**: CLI parity with `/sessions untitled` for title hygiene (aliases notitle|nameless)

## 0.9.27 — Doctor sessionsUntitled/sessionsTotal inventory hygiene

### Added

- **Doctor `sessionsUntitled` / `sessionsTotal`**: inventory hygiene for resume-by-title; tip when ≥5 untitled sessions
- **`/sessions untitled` · `forge sessions list --untitled`**: filter sessions without titles (aliases notitle|nameless)

## 0.9.26 — empty_run lastError + dirty-tree expert tip

### Added

- **empty_run lastError**: headless empty runs stamp `meta.lastError` code `empty_run` with doctor/auth/logs tips
- **Dirty-tree expert tip**: forge tips cover ≥40 changed files hygiene before long ULW

## 0.9.25 — FORGE_MAX_RUN_MS lastError + stronger lastError backlog tip

### Added

- **FORGE_MAX_RUN_MS lastError**: wall-clock timeout stamps `meta.lastError` code `max_run_ms` with raise-limit / `--continue` tips
- **Doctor lastError backlog severity**: ≥5 failed sessions get a stronger yellow warning

## 0.9.24 — Doctor dirty-tree tip + gitChangedFiles

### Added

- **Doctor dirty-tree tip + `gitChangedFiles`**: warn when ≥40 changed files before long ULW; JSON exposes the count
- **`productionWarnings` dirty tree**: `forge run --json` flags ≥40 changed files for CI blast-radius hygiene

## 0.9.23 — Worktree on share/summary + run JSON isWorktree/root

### Added

- **`forge run --json` git.isWorktree / git.root**: extend existing git snapshot for multi-worktree CI
- **Share/summary git worktree marker**: session show/share cards append `worktree` when linked

## 0.9.22 — /status + doctor git worktree line

### Added

- **`/status` + doctor git worktree line**: show branch/dirty/WORKTREE and root for multi-worktree expert sessions
- **Doctor JSON `gitIsWorktree` / `gitBranch` / `gitRoot`**: CI can detect linked worktree checkouts

## 0.9.21 — maxTurns lastError stamp

### Added

- **maxTurns lastError**: when the turn budget is exhausted, stamp `meta.lastError` code `max_turns` with raise-budget / `--continue` tips (kept on release)
- **Git linked worktree detection**: `GitSnapshot.isWorktree` + branch/HUD/status tags for multi-worktree expert workflows

## 0.9.20 — Doctor contextWindow JSON + stronger lastError backlog tip

### Added

- **Doctor JSON `contextWindow` / `autoCompactThreshold` / `contextWindowExplicit`**: CI can assert effective window config alongside model defaults
- **Doctor lastError tip**: yellow recovery backlog line points at `/sessions errors` and prune protect
- **`forge run --json` context window fields**: success and fail payloads include `contextWindow`, `autoCompactThreshold`, `contextWindowExplicit`

## 0.9.19 — Error-streak lastError + richer circuit-breaker tips

### Changed

- **Error-streak recovery tips**: circuit-breaker message covers plan-mode denials and path/context fixes; stamps `meta.lastError` code `error_streak` for /status and sessions errors
- **Doom-loop lastError**: identical tool thrash stamps `meta.lastError` code `doom_loop` with change-approach tips

## 0.9.18 — Permission-timeout + doom-loop recovery tips

### Changed

- **Permission-ask timeout recovery**: timeout deny reason + console tip point at `FORGE_PERMISSION_ASK_TIMEOUT_MS`, `/permissions acceptEdits`, and `--permission-mode dontAsk` for CI
- **Doom-loop message**: steers away from retrying the same denied mutation / missing path

## 0.9.17 — Parallel read-only tool batch name normalize

### Fixed

- **Parallel read-only tool batching**: normalize tool names (aliases + doubled stream-bug names) before the read-only check so `Read`/`read_file` batches actually run in parallel; export `isReadOnlyToolName`

## 0.9.16 — Doctor window JSON + /status context pressure line

### Added

- **Doctor JSON `modelDefaultContextWindow` / `contextWindowRatio`**: CI can assert window hygiene vs model-info defaults
- **Clear `context_pressure` lastError after successful compact**: headroom recovery drops the stale banner
- **`/status` context pressure line**: shows % of window, autoCompact threshold, and HARD/elevated tips

## 0.9.15 — Context-pressure lastError when compact cannot free headroom

### Added

- **Context-pressure lastError**: when compact/prune cannot free enough headroom near the hard limit, stamp `meta.lastError` code `context_pressure` with `/compact` · `/new` tips
- **Doctor model window tip**: warns when `context_window` is &lt;50% of the model's known default (early compact risk)

## 0.9.14 — /context pressure tips

### Added

- **`/context` pressure tips**: shows autoCompact threshold and HARD/elevated pressure guidance when usage is high

## 0.9.13 — Context-pressure warnings for experts

### Added

- **Context-pressure warnings**: one-shot expert log when auto-compact threshold or 92% hard headroom is crossed (`/context` · `/compact` tips)

## 0.9.12 — Continue-cap metrics/JSON lastError on success paths

### Added

- **Continue-cap metrics/JSON**: headless + REPL run_end metrics include `lastErrorCode` when continue-cap stamps lastError; `forge run --json` success payloads include `lastError` when present

## 0.9.11 — Continue-cap lastError + /news empty Unreleased fix

### Added

- **Continue-cap lastError stamps**: length / content_filter / empty-response / stop-continue caps set `meta.lastError` with recovery tips (not cleared on release)

### Fixed

- **`/news` skips empty Unreleased shells**: blank Unreleased headers no longer open the what's-new block ahead of the latest tagged release

## 0.9.10 — Metrics/stats failure breakdown for expert post-mortems

### Added

- **Metrics `lastErrorCode`**: failed run_end events stamp the recovery code (never bodies) for CI post-mortems
- **Markdown export lastError**: `exportSessionMarkdown` includes last error + tip for incident handoff
- **`/stats` · `forge stats` failure breakdown**: `failedRuns`, `byLastErrorCode`, and `sessions.withLastError` for expert recovery dashboards
- **Content-filter recovery tips**: empty/blocked turns and `formatProviderError` point at rephrase · `/model` · `/compact`

## 0.9.9 — Prune protects lastError recovery backlog

### Changed

- **Prune protects lastError sessions**: `pruneSessions` skips failed sessions by default so experts can inspect `/sessions errors` first; override with `--force-last-error` / `/sessions prune --force-last-error`. Reports `skippedLastError` / `deletedWithLastError`. Documented in PRODUCTION/RELIABILITY; `forge sessions list --json` includes explicit `lastError` objects.

## 0.9.8 — Recovery backlog filters + goal auto-title

### Added

- **Doctor `sessionsWithLastError`**: count of sessions with `meta.lastError` (report tip + `doctor --json`) for CI recovery backlog hygiene
- **/sessions errors** · **`forge sessions list --errors`**: filter recovery backlog (lastError only; aliases failed|err); Tab + bash/zsh/fish completion
- **`/goal` auto-titles untitled sessions**: arming a goal (slash, `--goal`, auto-detect) derives a scannable title via `maybeSetTitle` without overwriting an existing title

## 0.9.7 — Session lastError recovery surface

Expert recovery after provider failures: stamp, surface, and clear `meta.lastError` across status/resume/share/list/HUD/JSON.

### Added

- **Session `lastError`**: provider/run failures stamp `meta.lastError` with code/message/tips; `/status`, resume orientation, `/share`, `sessions show`/`list` (ERR badge), and `forge status` HUD/tmux/compact + `--json` surface recovery (`lastError` + `ERR:<code>` badge); `forge run --json` fail payloads include `lastError`; cleared on the next successful turn, `/clear`, and `/fork`. `/config` tips plan → `/build`

### Changed

- **First-run tip** mentions `/plan` · `/build` · live `/model` · `/commands` (v0.9.6 expert surface)

## 0.9.6 — Expert production UX (/plan·/build, project commands, recovery tips)

Learned from OpenCode (plan/build, custom commands, instruction walk-up) and production expert workflows. Session-scoped design mode, headless CI slash probes, multi-source project rules, provider recovery tips, smarter titles, and doctor hygiene counts.


### Added

- **`/plan` · `/build` · `/execute`** (OpenCode-style): session-scoped PLAN mode without sticky-prefs footgun. `/plan [focus]` hard-denies mutations (writes/bash/apply_patch); `/build` restores the prior mode and notifies the agent mid-run. Live controls; resume restores session plan unless `--permission-mode` is explicit. System prompt PLAN block lists goal/steps/risks/verification; deny reasons point at `/build`. `/permissions plan|build` aliases; sessions list/share/status show PLAN badge
- **Smarter auto session titles**: `deriveSessionTitle` prefers `User mandate:` / Goal lines, strips ULW harness boilerplate, drops pure slash controls, trims polite filler, capitalizes, and word-boundary truncates — session lists stay scannable without `--title`
- **Richer project instructions** (OpenCode-style): walk-up discovery for `AGENTS.md` / `FORGE.md` / `CLAUDE.md` / `.forge/rules.md` / `.github/copilot-instructions.md` / `.cursorrules` / `.cursor/rules/*.{md,mdc}` + optional `~/.forge/AGENTS.md`; nested AGENTS shadows parent; total budget 28k; `/context` lists loaded sources
- **Project custom slash commands** (OpenCode-style): `.forge/commands/<name>.md` + `~/.forge/commands/` with optional `description:` frontmatter and `$ARGUMENTS` / `$1..$9` placeholders; `/name args` expands and starts a turn; `/commands` lists them; Tab + unknown-slash Did-you-mean include customs; reserved built-ins cannot be shadowed
- **Provider error recovery tips**: `formatProviderError` maps HTTP/auth/rate-limit/quota/overflow/network failures to expert next steps; REPL + headless human path print tips; `forge run --json` fail payload includes `recovery: { code, tips }` and structured `reason`
- **Headless slash prompts**: `forge run "/plan"` · `"/commands"` · custom `.forge/commands` work without a model call when pure control; templates with `$ARGUMENTS` expand then run the agent. JSON success uses `reason: "slash"`. Pure-control slashes run **before auth** so CI can probe without credentials. Ephemeral only for **readonly** probes (`/help`, `/commands`, …) — mutating `/plan`/`/build` still persist the session
- **Richer `/init`**: guided AGENTS.md prompt covers multi-source instruction loading, `.forge/commands` templates, safety/blast-radius notes, and `/plan`·`/build` tips
- **Doctor JSON `projectRulesCount` / `projectCommandsCount`**: CI can assert instruction + custom-command hygiene without parsing report text
- **`suggestNames` multi-tip**: unknown tools return up to 3 Did-you-mean candidates (agent self-recovery)
- **Smarter empty-response nudge**: empty model turns mention plan mode / open todos and finish_reason; continue-cap release points at `/retry` · `/compact` · `/model`
- **`/news` includes Unreleased**: in-flight CHANGELOG notes surface before the next tag so experts see `/plan`, headless slash, recovery tips without waiting for a release
- **`productionWarnings` for plan mode**: `forge run --json` flags `permissionMode=plan` so CI does not silently stay read-only
- **`/news` pairs Unreleased + latest tag**: default count still shows the last shipped release under in-flight notes
- **Sample project commands**: `examples/forge-commands/{review,shipcheck}.md` — copy into `.forge/commands/`
- **ULW `max_waves`**: optional wave cap (default unlimited). `/max-waves N|off|status` live mid-run; CLI `--max-waves N` (0 = unlimited; N&gt;0 implies ULW). When the wave counter hits N, harness auto-flips to LAST (`**Cycle complete.**`). Counts show as `wave=2/5`; JSON `ulwMaxWaves`; compact/admission/status/HUD aware
- **Multi-account auth**: store many logins per provider (e.g. two SuperGrok emails + API keys) in `~/.forge/auth.json` v2
- **`forge accounts`**: `list` · `status` · `switch` · `remove` · `rename` · `priority` · `disable`/`enable` · `clear-cooldown` · `auto-switch on|off [--threshold N]`
- **`forge login --add`**: add another account without replacing existing ones; `--label` for API-key display names
- **Smart auto-switch**: on 429/quota (and proactive when plan usage ≥ threshold or active in cooldown/expired) Forge switches to another same-provider account (cooldown on exhausted); `FORGE_ACCOUNT_SWITCH_MAX` caps mid-run switches; post-switch OAuth refresh; auth-failure uses shorter cooldown (`switchOnAuthFailure`)
- **Unattended readiness**: `forge accounts status` / `/accounts status`; doctor reports multi-account eligible/cooldown; stale plan probes (>6h) ignored for proactive switch
- **REPL**: `/accounts` list/status/switch/clear-cooldown/auto-switch; `/accounts switch` hot-swaps live provider token; `/auth` shows multi-account table; statusline shows account label + `×N` when multi
- **`forge auth --json`**: includes `accounts[]`, `autoSwitch`, `switchThresholdPercent`, `active.accountId` (never tokens); `forge doctor --json` includes `multiAccount`
- **GitHub Copilot provider**: `forge login --from-copilot` / `forge login -p copilot` reuses a local Copilot CLI keychain or VS Code `~/.config/github-copilot` session; falls back to GitHub device-code OAuth; auto re-exchanges short-lived Copilot session tokens; OpenAI-compat chat via `https://api.githubcopilot.com`
- **Provider aliases**: `github` / `github-copilot` / `gh-copilot` → `copilot`
- **Env**: `COPILOT_GITHUB_TOKEN` / `GITHUB_COPILOT_TOKEN` / `GH_COPILOT_TOKEN` for CI-style GitHub OAuth tokens (exchanged on resolve)

### Changed

- **`/model` is live mid-run**: switch model (and optional effort) while a turn is running; bare `/model` stays readonly catalog. Live notice + session meta update; next provider call picks up the new model. Doctor tips when no project instruction files are present (`/init`)
- **`/status` plan tip**: `perms plan (read-only · /build to implement)`; expert tips list `/plan` · `/build` · `/model` as live mid-run controls

### Fixed

- **`/build` clears session plan override**: leaving plan restores prior live mode and drops `meta.permissionMode` so resume falls back to sticky prefs/CLI (plan is temporary, not sticky-by-accident). Sticky `/permissions <mode>` no longer writes non-plan session overrides
- **Custom-command reserved-name drift guard**: test asserts every built-in `SLASH_COMMANDS` entry is reserved so project templates cannot shadow `/plan`, `/build`, etc.

## 0.9.5 — File-aware undo, /init, /review, /compact-and + SuperGrok OIDC

### Added

Production recovery, review, and onboarding learned from OpenCode (snapshot/revert, guided AGENTS.md, `/review`) and Warp (`/compact-and`). Native SuperGrok OIDC login for subscription auth without Grok Build import.

### Loop hygiene
- **Structured CLI errors**: `failInvalidFlag` / usage / session-miss / Commander `--json` errors include `version`
- **`emitFailJson` / `emitOkJson`**: all common `--json` success/failure payloads include `version` for CI matrices (sessions, auth, tips, completion, init, stats, status, export/import, typos, locks)
- **Bare command aliases**: `forge cfg|log|session|whoami|hud|whatsnew|tip|…` recover with `command_typo` + suggestion before auth (expert muscle-memory)
- **Sessions action suggestions**: include `rename`/`clone`/`dir`/`location` aliases so `renam`/`clonee` get Did you mean?
- **Provider aliases**: `-p oai|haiku|bard|router` map to openai/anthropic/google/openrouter (with existing claude/gpt/gemini)
- **Permission alias**: `--permission-mode ask` maps to `dontAsk` (with deny/dont-ask)
- **Effort aliases**: `--effort hi|lo` map to high/low (with existing h/l/med/max)
- **Shell completion**: provider/permission/effort/sandbox completions include expert aliases (`oai`, `yolo`, `hi`/`lo`, `readonly`/`ro`, …)
- **`forge news all|full|max`**: alias for count 10 (cap); `latest` → 1
- **`stats --days` / `logs -n` aliases**: week|month|today|7d|all · logs all|max|full → entire window
- **Slash parity**: `/stats week|month|today|all` and `/news all|full|max|latest` match CLI aliases
- **`/logs max|full`**: parity with `forge logs -n all|max|full`
- **`parseDaysWindow`**: shared CLI `/stats` day-window parser (anti-drift)
- **`parseNewsCount`**: shared CLI `/news` count parser (anti-drift)
- **`parseLogsLines`**: shared CLI `/logs` line-count parser (anti-drift)
- **Shared mode normalizers**: `normalizeProviderId` / permission / sandbox aliases apply to CLI flags **and** `FORGE_*` env vars
- **`login`/`logout -p` aliases**: same provider normalizer (`claude`→anthropic, suggestions on typos)
- **`/permissions ask`**: alias for `dontAsk` (parity with CLI `--permission-mode ask`)
- **Preferences aliases**: `preferences.json` `permissionMode` accepts yolo/ask/accept (normalized on load/save)
- **Nested-command footguns**: `forge auth logout` / `doctor login` / `config auth` excess-args hints; `forge sessions login` fails closed (not silent search)
- **Doctor yolo**: `permissionMode=bypassPermissions` is a blocking issue (CI should not ship YOLO)
- **Doctor sandbox off**: `sandbox=off` is a blocking issue on production hosts
- **`sessions list --limit all|max|unlimited`**: alias for unlimited (0)
- **Completion**: `sessions --limit` values include `0|all|max|unlimited`
- **Bash IMDS deny**: hard-deny `curl`/`wget` to `169.254.169.254` / GCE metadata host (cloud SSRF footgun)
- **Bash `file://` deny**: hard-deny `curl`/`wget` local file fetches (use `read_file`)
- **Sticky login provider** (not silent cross-provider auth): `forge login -p claude` saves provider preference; explicit `-p xai` will not use anthropic keys
- **Doctor/run provider align**: when stored auth is a different provider than config default, doctor report/JSON and `forge run` follow active credentials
- **Sticky login provider**: `forge login -p …` saves `provider` to preferences.json; switches default model to that provider’s catalog default when no model pref is set
- **`forge login` without `-p`**: uses sticky provider preference (not always xai)
- **`sessions prune --max-age-days all|none|off`**: alias for 0 (no age filter)
- **`prune-tool-output --max-age-days all|none`**: same no-age-filter aliases
- **Completion**: `--max-age-days` values include `0|all|none|off|7|14|30|90`
- **`--keep all|max|unlimited`**: prune commands keep everything (sessions/metrics/tool-output)
- **`sessions prune --json`**: includes resolved `keep` + `maxAgeDays` for CI audit
- **Logout clears sticky provider**: full logout or logout of the sticky provider drops preferences.provider
- **Resume auth follows session provider**: `forge run --continue/--session` resolves credentials for the session’s provider (sticky login cannot silently switch a resumed chat)
- **Statusline PIN badge**: pinned sessions show `PIN` in HUD tags and tmux status-right (parity with session list)
- **`FORGE_JSON_COMPACT=1`**: single-line `--json` success payloads for CI log aggregation
- **`forge run --json`**: includes `pinned` + `foreignLock` for CI/ops session audit
- **`forge run --json` error path**: includes `reasoningEffort`, `sandboxNetwork`, `goalActive`, `maxTurns` (parity with success)
- **`forge run --json`**: includes `stickyProvider` from preferences (null when unset) for CI audit
- **`forge run --json`**: includes `sandboxMissingBackend`; doctor flags `sandbox-missing=fallback` as production risk
- **`forge run --read-outside ask|allow|deny`**: CI-controllable outside-workspace reads; run JSON includes `readOutsideWorkspace`
- **`forge doctor`**: flags `read-outside=allow` as production risk (prefer ask|deny)
- **`forge logs -n ''` / `forge news ''`**: fail-closed `invalid_lines` / `invalid_count` (omit still defaults)
- **`forge prune-tool-output --max-age-days ''`**: fail-closed `invalid_max_age_days` (omit still defaults to 14)
- **`forge run --json`**: includes truncated `goal` text + `denyRules`/`allowRules`/`askRules` counts for CI audit
- **`forge doctor --json`**: includes `sandboxNetwork`, `sandboxMissingBackend`, `readOutsideWorkspace`, `stickyProvider`, rule counts
- **`sessions export --format` typos**: `jsn` → Did you mean: json (JSON `suggestion`)
- **Typo suggestions**: `completion bas`→bash, `logs -n al`→all, `news al`→all, `stats --days wek`→week
- **`--json` payloads**: include `node` (process.version) via `emitOkJson`/`emitFailJson` for CI support bundles
- **`forge config --json` / `/config`**: includes `stickyProvider` from preferences
- **`forge run --session` + `--continue`**: fail-closed `conflicting_flags` (pick one resume mode)
- **`get_task_output` stream typos**: `stdot`/`err`/`all` → Did you mean stdout|stderr|both
- **`web_fetch` format typos**: `txt`/`md`/`htm` → Did you mean text|markdown|html
- **`forge run --help` CI tips**: include `--sandbox-missing fail-closed` and `--read-outside deny`
- **`forge status --interval ''`**: fail-closed `invalid_interval` (omit still defaults to 1000ms)
- **`todo_write` status typos**: `doing`/`done`/`canceled` → Did you mean in_progress|completed|cancelled
- **`forge tips --json`**: structured `lines` + `sections` (plus full `tips` string)
- **`forge run --json`**: includes `authMethod` (api_key|oauth|…) for support bundles
- **`list_dir` file path**: clearer recovery tip (use read_file/grep)
- **Shell completion**: bare `forge` top-flags include `--read-outside`/`--sandbox-missing`/`--effort` (parity with `run`)
- **`forge run --json`**: includes `maxTurnsUnlimited` (parity with doctor/config)
- **`forge run --json`**: includes `productionWarnings[]` for sandbox=off / yolo / read-outside=allow / sandbox-missing=fallback / blockingStop off
- **`forge run --json`**: includes `blockingStop`; `forge run --no-blocking-stop` available (warns via productionWarnings)
- **`mergeRunOpts`**: carries `blockingStop`/`readOutside` so `forge run --no-blocking-stop` / `--read-outside` are not clobbered by subcommand defaults
- **`web_fetch` non-http schemes**: `ftp`/`file`/`ws` errors include Did you mean https://…?
- **`--base-url` non-http schemes**: `ftp`/`ws` errors include Did you mean https://…?
- **`forge run --json`**: includes `ulwCycle`/`ulwWave` when ultrawork is armed (null otherwise)
- **`forge sessions show --json`**: includes `ulw` {cycle,wave,blocks} and truncated `goal` when present
- **`forge sessions list --json`**: includes `ulwCycle`/`ulwWave`/`goalActive` per session
- **`forge status --json` / HUD**: session snapshots include `ulwCycle`/`ulwWave`; plain tags show `ULW c=N`
- **Statusline**: colored compact strip ULW badge shows cycle; remove duplicate plain GOAL tag
- **`forge run --json`**: includes truncated `ulwMandate` when ultrawork is armed
- **`forge run --json`**: includes `ulwSoftPrompt`; sessions show `ulw` includes softPrompt + mandate
- **`apply_patch`**: `*** Move File:` mistakes hint correct `Update File` + `Move to` grammar
- **`apply_patch`**: empty Add/Delete File paths include recovery example
- **`forge run --json`**: includes `openTodos` and `messageCount` for CI session health
- **`grep` head_limit**: accepts `all|max|full|unlimited` as unlimited (parity with logs -n)
- **`web_search` num_results**: accepts `all|max|full` as 10 (cap)
- **`get_task_output` tail**: accepts `all|max|full` as full output; typos get Did you mean
- **`bash` timeout_ms**: accepts `default|max|all` (max/all → 30m ceiling); typos get Did you mean; duration suffixes `30s`/`1m`/`2h`/`500ms`
- **`web_fetch` timeout_ms**: duration suffixes via shared `parseDurationMs` (parity with bash)
- **`FORGE_BASH_TIMEOUT_MS` / `FORGE_BASH_BG_TIMEOUT_MS`**: accept duration suffixes (`90s`, `2m`)
- **`FORGE_MAX_RUN_MS` / `FORGE_PROVIDER_TIMEOUT_MS`**: accept duration suffixes (`10m`, `5m`)
- **`FORGE_PERMISSION_TIMEOUT_MS`**: accept duration suffixes (`30s`, `2m`)
- **Tool schemas + system prompt**: document timeout/head_limit/tail/num_results aliases for the model
- **`sessions export --json` without `--out`**: structured envelope `{ id, format, body }` (no raw markdown on stdout)
- **`sessions fork --json`**: includes copied `ulw`/`goal` sidecars
- **`sessions import`**: accepts `export --json` envelope files (unwraps `body`)
- **`forge doctor`**: what-if flags `--sandbox`/`--read-outside`/`--permission-mode`/`--no-blocking-stop`/`--sandbox-missing`
- **`forge config`**: same what-if safety flags as doctor for effective snapshot previews
- **`apply_patch`**: empty/context-only `@@` update hunks without `Move to` rejected as no-ops
- **`forge run --json`**: includes `goalStuckThreshold` from config
- **`forge run --json` / sessions show|fork**: include `goalBlocks`/`goalStuckBlocks` when a goal is armed
- **`forge run --json`**: includes truncated `goalCriteria[]` when a goal is armed
- **`sessions show|fork --json`**: goal object includes `criteria[]`
- **`forge run --json`**: includes `maxRunMs` from `FORGE_MAX_RUN_MS` (null when unset)
- **`forge run --json`**: includes `providerTimeoutMs`/`bashTimeoutMs`/`bashBackgroundTimeoutMs` (parity with doctor)
- **`forge run --json`**: includes `permissionAskTimeoutMs`/`doomLoopThreshold`/`errorStreakThreshold` (parity with doctor)
- **`forge run --json`**: includes `ulwMaxContinues` (parity with doctor)
- **`forge run --json`**: includes compact `git` snapshot (branch/dirty/changedFiles/ahead/behind)
- **`forge run --json`**: includes `projectLabel` + `projectHints` (node/rust/python/…)
- **`forge run --json`**: includes `packageName` from nearest package.json (monorepo CI) + `packageVersion`
- **`forge run --json`**: includes `packageEnginesNode`; doctor flags runtime below engines.node floor
- **`forge doctor --json`**: includes `packageEnginesNode` from workspace package.json
- **`sessions show --json`**: includes `git`, `projectHints`, `packageName`/`packageVersion`/`packageEnginesNode`
- **`/share` card**: includes git branch/dirty and project/package identity for handoff
- **`/share` card**: ULW cycle/wave flags + active goal one-liner for handoff
- **`forge run --json`**: includes `sessionPath` (absolute session dir) for ops/support bundles
- **`sessions list --json`**: includes `path` (absolute session dir) per row
- **`forge status --json`**: session snapshots include `sessionPath`
- **`session_not_found --json`**: includes structured `suggestions[]` (id/title/path/relativeAge)
- **Session lookup anti-drift**: shared `collectSessionLookupHits` powers human miss text + JSON `suggestions[]` (title edit-distance + id-prefix recovery)
- **`apply_patch` empty Move to path**: recovery example (Update File + Move to)
- **`forge tips` CI line**: documents `suggestions[]` + `sessionPath`/`forgeHome` support-bundle fields
- **`unauthenticated --json`**: includes `forgeHome` for support bundles
- **`sessions title --json`**: includes `forgeHome`
- **Tool schemas**: document empty-arg fail-closed + recovery examples (bash/read/write/edit/grep/glob/web_*)
- **`emitOkJson`/`emitFailJson`**: always stamp `forgeHome` (support-bundle parity on every JSON path)
- **`list_dir` empty path**: correct recovery example (was wrongly showing glob pattern)
- **`stringifyJsonResult`**: stamps `version`/`node`/`forgeHome` defaults (doctor/run JSON anti-drift)
- **System prompt**: never call tools with empty required args — errors include recovery examples
- **`/goal` verb typos**: `stauts`/`resum`/`cler` → Did you mean status|resume|clear (not silent arm)
- **`/cycle` unknown args**: Did you mean 0|1|status|off|on|last?
- **`todo_write` empty id/content**: recovery example item JSON
- **`sessions show` summary**: includes path + git branch/dirty + project/package identity
- **`sessions show` summary**: ULW cycle/wave + active goal one-liner (parity with `/share`)
- **`sessions list` human**: ULW c=N + GOAL badges (parity with statusline/JSON)
- **`forge run --json` `ok`**: false on empty/no-turn runs (aligned with exit 1; was ok:true + exit 1 CI footgun)
- **`forge run --json`**: sets `reason=empty_run|timeout|aborted` when `ok:false` on completed payload path
- **`isEmptyRunResult`**: shared empty/no-turn check keeps exit 1 + `ok:false` + `reason=empty_run` in lockstep (defensive turns coerce)
- **`forge run --json`**: `ok:false` completed payloads include `error` for empty_run|timeout|aborted (CI parsers)
- **`isEmptyRunResult`**: whitespace-only `finalText` counts as empty
- **Docs**: `FORGE_MAX_TURNS`/`--max-turns` clarified as soft cap (`hitMaxTurns`), not exit 124
- **`grep` empty path / `apply_patch` empty patchText**: recovery examples with tool prefixes
- **`sessions fork` human**: ULW c=N + GOAL badges when sidecars copied
- **`/status`/`/hud` details**: include on-disk session path
- **`/tasks`**: `kill|stop <id>` + `log|peek <id> [tail]` subcommands (live: kill=control, log=readonly)
- **`/tasks` unknown id**: uses same Did-you-mean task list as agent `kill_task`/`get_task_output`
- **`/tasks log` tail**: accepts `all|max|full` (full output) + Did you mean
- **Tool `Aborted` results**: annotated as `Aborted: <tool> (turn cancel / timeout / Ctrl+C)` (keeps cancel classifiers)
- **`web_fetch` no response**: recovery tip (network/abort/redirect)
- **JSON arg repair**: successful auto-repairs prefix tool output with `[json_arg_repair]` note for the model
- **System prompt**: note `[json_arg_repair]` prefix so the model emits valid JSON next time
- **`sessions show|list --json`**: `sessionPath` alias of `path` (parity with `forge run --json`)
- **`sessions path --json`**: includes `path`/`sessionPath` aliases of `dir`
- **`sessions import|export --json`**: include `sessionPath` (and import `path`) for ops handoff
- **`sessions fork|title|pin --json`**: include `path`/`sessionPath`
- **`sessions delete --json`**: include `sessionPath` for audit (even after delete)
- **`/undo`/`/rewind`**: `last|all|max|full` aliases + Did you mean on bad counts
- **`/last`**: `last|all|max|full` aliases + Did you mean on bad counts
- **Provider empty choices**: clearer retry/switch-model error
- **Provider empty stream**: retry/switch-model hint on dropped connections (OpenAI-compat + Anthropic)
- **Protected-path writes**: clearer recovery (forge CLI / git / ssh-keygen; agent-writable ~/.forge dirs)
- **Outside-workspace writes**: clearer recovery (project root / agent-writable ~/.forge dirs)
- **Outside-workspace reads**: permission deny/ask reasons include --read-outside recovery tip
- **Sandbox fail-closed**: recovery tip (install backend or explicit fallback)
- **SSRF blocks**: clearer recovery (public URL vs allow_local loopback-only)
- **DNS / web_search failures**: recovery tips (hostname/network / simpler query / web_fetch)
- **`locked --json`**: structured `hint` for concurrent-session recovery (parity with continue_miss)
- **`unauthenticated`/`empty_prompt --json`**: structured `hint` recovery commands
- **`unknown_option --json`**: structured `suggestion`/`hint` for flag typos (`--josn`→`--json`)
- **`apply_patch` verification failures**: grammar recovery hint when missing
- **`forge tips` live line**: includes `/tasks kill|log`
- **`forge tips` CI line**: documents empty run → `ok:false reason=empty_run`
- **`glob`/`list_dir` type errors**: prefixed tool name for clearer attribution
- **`/files` unknown args**: Did you mean writes|mutations|all?
- **`suggestName` tie-break**: prefer lower edit distance so `writs`→`writes` (not `edits`)
- **`/bell` unknown args**: Did you mean on|off|test|status?
- **`/logs`/`/stats`/`/news` invalid args**: Did you mean recovery (parity with CLI typos)
- **`/review` target typos**: `uncommited`/`stageed` → Did you mean uncommitted|staged
- **`grep`/`write_file`/`search_replace` type errors**: prefixed tool name for clearer attribution
- **`read_file`/`get_task_output`/`kill_task` type errors**: prefixed tool name
- **`/pin` unknown args**: Did you mean on|off|status|toggle? (not silent pin)
- **`glob` empty path**: prefixed `glob error:` for clearer tool attribution
- **`continue_miss`/`continue_locked --json`**: includes recent same-cwd `suggestions[]` for `--session` recovery
- **Library**: export `listSessionLookupSuggestions`
- **`forge doctor --json`**: includes `forgeHome` + `node` for support bundles
- **`forge config --json` / `/config`**: includes `forgeHome`
- **`forge status --json`**: includes `forgeHome` + `node`
- **`forge stats --json`**: includes `forgeHome`
- **`forge auth --json` / `tips --json`**: include `forgeHome`
- **JSON support-bundle parity**: `sessions list`, `completion`, `news`, `logs`, `models` include `forgeHome`
- **`forge run --json`**: includes `forgeHome` (parity with doctor/status/config)
- **`grep` invalid regex**: includes engine detail + escape hint (not bare pattern dump)
- **`sessions show` / `login` / `logout --json`**: include `forgeHome`
- **`sessions fork|export --json`**: include `forgeHome`
- **`sessions import|path --json`**: include `forgeHome`
- **`web_search`/`web_fetch` empty args**: error includes recovery example JSON
- **`bash` empty command**: error includes recovery examples (timeout + background)
- **`read_file`/`write_file`/`search_replace`/`glob` empty path**: recovery examples
- **`grep`/`glob` empty pattern**: recovery examples
- **`sessions prune` / `prune-tool-output` / `prune-metrics --json`**: include `forgeHome`
- **`sessions pin|unpin|delete --json`**: include `forgeHome`
- **`/share` card**: export line includes `--json` envelope tip
- **`sessions import`**: markdown export files get a clear re-export-with-json hint
- **`sessions import`**: rejects markdown `export --json` envelopes with a clear re-export hint
- **`search_replace`**: whitespace-only `old_string` fails closed (no blank-line matches)
- **`forge doctor`/`config`**: `--sandbox-network` what-if flag
- **`forge run --json`**: includes `ulwBlocks` when ultrawork is armed
- **`forge run --json`**: includes truncated `ulwExpandedMandate` when soft-prompt ULW is armed
- **`apply_patch`**: clearer missing Begin/End Patch marker diagnostics
- **`forge run --json` unauthenticated**: includes `authMethod: null` for field parity
- **`apply_patch` empty patch**: clearer recovery hint (Add/Update/Delete/Move File hunks required)
- **`sessions list --json`**: includes `relativeAge` per row (parity with human list ages)
- **`forge run --json`**: includes `baseUrl` when overridden (custom/provider base)
- **`--max-turns` / `FORGE_MAX_TURNS`**: cap agent turns from CLI/env (0 = unlimited); empty/invalid fail closed (`invalid_max_turns`)
- **`forge config --json` / `/config`**: includes `version`; hook `timeout` floored to ≥1s (avoids instant Stop fail-closed)
- **`forge run --json` success**: includes `version`, `reasoningEffort`, `cwd`, `permissionMode`, `sandbox`, `sandboxNetwork`, `ultrawork`, `goalActive`, `maxTurns` for CI audit
- **Unauthenticated `--json`**: error text points at `forge login --api-key $KEY --json` for CI
- **`forge run --json` success**: includes `provider` + `model` for CI audit trails
- **Blocking Stop timeout**: Stop/SubagentStop hooks that time out or error **fail closed** (keep agent working) when `blockingStopHooks` is on — was fail-open like Grok
- **Doctor model catalog**: warns when `model` is not in the active provider's known list (free-form still allowed)
- **Provider switch model default**: `-p anthropic` / `FORGE_PROVIDER` without `-m` uses that provider's `defaultModel` (no longer sticks on `grok-4.5`)
- **`--sandbox-network` aliases**: `none`/`off`/`block`→`blocked`, `open`/`full`→`unrestricted`
- **`--sandbox` aliases**: `readonly`/`ro`→`read-only`, `ws`→`workspace`, `none`→`off`, `full`→`strict`
- **`--provider` aliases**: `claude`→`anthropic`, `gpt`→`openai`, `gemini`→`google` (plus existing `grok`→`xai`)
- **`--sandbox-missing` aliases**: `fail_closed`/`failclosed`→`fail-closed`
- **Shell completion**: enum values for `--permission-mode`/`--effort`/`--sandbox`/`--sandbox-network`/`--sandbox-missing`
- **`--permission-mode` aliases**: `deny`/`dont-ask`→`dontAsk`, `yolo`/`always`→`bypassPermissions`, `accept`→`acceptEdits`
- **`/permissions dontAsk`**: mode listed in tab-complete and mode menu (CI-safe deny-without-allow; was missing from interactive choices)
- **CLI `--json` parse errors**: unknown options/args emit `{ ok:false, reason:unknown_option|… }` on stdout (no stderr scrape)
- **Shell env injection scrub**: always drop `LD_PRELOAD`/`NODE_OPTIONS`/`DYLD_*`/`PYTHONSTARTUP`/`BASH_ENV`/`GIT_SSH_COMMAND`/`GIT_CONFIG_*`/… from inherited env (policy `set` can still opt in); also scrub `SSLKEYLOGFILE`
- **Numeric tool-arg errors**: object `timeout_ms`/`offset`/`head_limit`/`num_results` report `must be a number (got object)` instead of `invalid … "[object Object]"`
- **`get_task_output` stream type**: non-string `stream` fails closed (clearer than invalid stream "[object Object]")
- **`web_fetch` format type**: non-string `format` fails closed (clearer than invalid format "[object Object]")
- **Background task ids**: non-string `task_id` on get/kill fails closed (no `[object Object]` lookup)
- **`todo_write` field types**: non-string `id`/`content`/`status` fail closed (no `[object Object]` todos)
- **Tool path/pattern types**: non-string `path`/`pattern` on read/write/edit/list/grep/glob fail closed
- **Tool string args**: non-string `bash.command` / `web_search.query` / `web_fetch.url` / `apply_patch.patchText` fail closed (no `[object Object]` shell/search)
- **`search_replace` string args**: non-string `old_string`/`new_string` fail closed (no `[object Object]` edits)
- **`write_file` content type**: missing/non-string `content` fails closed (objects no longer become `[object Object]` on disk)
- **`get_task_output` arg order**: invalid `tail`/`stream` reported even when `task_id` is omitted (was masked by task_id required)
- **Slash count bounds**: `/undo` 1–100, `/files` 1–200, `/last` turns 1–20 and max-chars 40–2000 fail closed (no silent clamp)
- **`forge status --watch --json`**: single-shot snapshot (no infinite NDJSON hang in CI); human `--watch` still loops
- **`forge logs -n` / `/logs`**: values above 200 fail closed (`invalid_lines`) instead of silent clamp
- **`forge news` count**: values above 10 fail closed (`invalid_count`) instead of silent clamp
- **Whitespace-only grep patterns**: `"   "` fails closed as `pattern is required` (was a useless full-tree search)
- **Session title length**: storage cap raised to 200 (was silent 72 truncate); `/title` and `sessions title` fail closed above 200 (parity with `--title`)
- **Shell env scrub connection strings**: bash child env drops `DATABASE_URL` / `*_URI` / `CONNECTION_STRING` / `MYSQL_PWD` / `PGPASSFILE` (and peers) — previously only `*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*`/`*CREDENTIAL*` matched, so postgres/redis URLs with embedded passwords leaked into sandboxed shells
- **`forge models -p|--provider`**: filter model list to one provider (parent `forge -p xai models` works). Empty/invalid provider fail closed with `invalid_provider` (JSON)
- **SSRF weird IPv4 literals**: `web_fetch` blocks decimal/hex/octal/short forms (`2130706433`, `0x7f000001`, `127.1`, `0177.0.0.1`) that expand to loopback/RFC1918 — classic inet_aton bypasses
- **Library exports**: `PermissionGate`, hard-safety helpers (`checkBashHardDeny` / `hardSafetyCheck`), `isReadOnlyCommand`, SSRF guards (`assertUrlSafe` / `normalizeIpHost` / `expandWeirdIpv4Literal` / …), and `createShellEnv` / `ShellEnvPolicy` available from `forge-agent` for embedders/tests
- **`web_fetch allow_local` permission gate**: headless/dontAsk/plan no longer auto-allow loopback fetches as a free read-only tool — requires allow rule, interactive approval, pattern always, or YOLO (public URLs still auto-allow)
- **`web_fetch allow_local` + session-tool**: approving `[s]ession` on a public `web_fetch` no longer free-passes later `allow_local` loopback fetches (session-tool alone is not enough)
- **Doom-loop fingerprint**: also ignores `run_in_background` (alias of `background`) so transport-only retries still trip
- **SSRF IPv4-mapped hex**: `web_fetch` blocks `::ffff:7f00:1` / `::ffff:a0a:a0a` (and expanded forms) — previously only dotted-quad `::ffff:127.0.0.1` was peeled, so hex-mapped loopback/RFC1918 could bypass
- **SSRF bracketed IPv6 hostnames**: Node keeps brackets on `URL.hostname` for IPv6 (`[::ffff:7f00:1]`). `assertUrlSafe` / `isNonPublicIp` peel brackets via `normalizeIpHost` before `net.isIP` so mapped private literals are blocked (and explicit loopback + `allow_local` works)
- **acceptEdits read-only shell**: `find`/`git branch`/`git remote` no longer auto-allow mutations via bare prefix match — `find -delete|-exec|-ok|-fprint*`, `git branch -d|-D|-m|-c|-f|create`, and `git remote add|remove|set-url|prune` require approval (or allow rule / YOLO). Listing forms (`find -name`, `git branch -a|--contains`, `git remote -v`) still pass.
- **acceptEdits version probes**: `node --version` / `npm -v` / `python -V` / `git --version` (and peers) auto-allow again — flag-stripping had dropped `--version` so the RO prefix never matched
- **acceptEdits git `--output`**: `git log|show|diff|branch --output=path` is not read-only (file write) even though the subcommand prefix is
- **`--goal` / `/goal` length**: objectives longer than 4000 chars fail closed (`invalid_goal` / clear slash error)
- **Missing `--cwd`**: non-existent / non-directory paths fail closed (`invalid_cwd`); `--title` capped at 200 chars
- **First-run tip**: mentions doctor --json + unknown-slash Did you mean?
- **Doctor permission rules**: invalid `Bash()` entries flagged; non-array deny/allow/ask not character-iterated
- **Empty permission rules**: `--deny 'Bash()'` fails closed (`invalid_deny`); use `Bash` or `Bash(*)`
- **Tool name aliases + tips**: `Shell`/`read`/`write`/`edit`/`StrReplace` map to canonical tools; unknown names get Did you mean?
- **`todo_write` without session**: clearer `todo_write error: not available in this context` (was bare "not available")
- **`forge sessions search <q>`**: first-class query (parity with `/sessions search` and `-q`); empty query is usage error
- **System prompt**: documents tool-arg fail-closed so models fix invalid timeout_ms/offset/head_limit/format instead of retrying
- **Tool arg fail-closed**: invalid `bash`/`web_fetch` `timeout_ms`, `web_fetch` `format`, `get_task_output` `tail`/`stream` error clearly (were silent defaults)
- **`grep` `head_limit` / `web_search` `num_results`**: explicit invalid values fail closed (were silent defaults)
- **`--base-url` empty host**: `https://` fails closed (hostname required)
- **`--base-url` validation**: non-http(s) / unparseable URLs fail closed (`invalid_base_url`) before API retries
- **`read_file` offset/limit**: explicit non-numeric/negative values fail closed (were silent defaults)
- **Conflicting session flags**: `--continue --new` / `--session --new` fail closed (`conflicting_flags`) instead of silently preferring `--new`
- **`forge --version --json`**: structured `{ ok, version, name, node }` for CI
- **Doctor large undo-journal**: warns when mutations journals exceed ~20 MiB or 2k entries (prune tip)
- **Enum/flag typos**: `--sandbox workspac` → `workspace`; `--permission-mode aceptEdits` → `acceptEdits`; `--effort medum` → `medium`; `--sandbox-network blokced` → `blocked`; `/model grok-45` + `/effort medum` suggest instead of saving; `/permissions aceptEdits` suggests
- **Provider/model typos**: `--provider xaai` → `xai`; `--model grok-45` → `grok-4.5` (free-form unknown ids still pass preflight)
- **Session title typos**: `/resume alpa-project` → Did you mean `alpha-project` (edit-distance on recent titles)
- **Sessions action typos**: `forge sessions prun` / `/sessions serach x` → `unknown_session_action` + suggestion (was empty title search)
- **Bare CLI subcommand typos**: `forge sesions --json` → `command_typo` + suggestion `sessions` (was treated as a free-form prompt)
- **Whitespace-only paths**: `read_file`/`write_file`/`search_replace`/`list_dir`/`grep`/`glob` reject `"   "` as `path is required` (was opaque not-found / Directory not found)
- **`bash` whitespace-only command**: fails with `command is required` (was silent success no-op)
- **Slash count args fail-closed**: `/last abc`, `/news 0`, `/stats abc`, `/logs abc`, `/files abc`, `/rewind abc` error clearly (were silent defaults)
- **Unknown slash typos**: `/exprot` → `Did you mean: /export?` (edit-distance + prefix; gibberish stays clean)
- **`/sessions prune --keep`**: invalid values error clearly (parity with CLI `invalid_keep`)
- **`apply_patch` context miss**: tips to re-read the file / refresh @@ hunks (or fall back to search_replace)
- **`bash` background start**: includes `timeout_ms` so operators know the wall-clock cap
- **`status --interval` / `news <count>`**: invalid values fail closed (`invalid_interval`/`invalid_count`) even without `--watch` (shared scripts)
- **Invalid `stats --days` / `logs -n`**: empty/NaN fail closed (`invalid_days`/`invalid_lines`) instead of silent default
- **Invalid CLI counts**: explicit `--keep`/`--limit`/`--max-age-days` that are empty/NaN/negative fail closed (`invalid_keep`/`invalid_limit`/`invalid_max_age_days`) instead of silently falling back to defaults
- **`bash` timeout**: wall-clock timeout reports `Command timed out after Nms` with exit code **124** (was an opaque killed-process code)
- **Error-streak hygiene**: `kill_task` on already-finished tasks does not count toward the circuit breaker; `get_task_output` notes when a task is final
- **`todo_write` validation**: requires id/content/valid status; `merge:true` + `[]` is a no-op warning; validation failures are `isError` (`todo_write error:`)
- **`web_fetch` empty body**: notes empty extraction and suggests `format=html` / another URL
- **`list_dir` empty**: names the path + tips (not bare “(empty directory)”)
- **`kill_task` already finished**: isError + command snippet + get_task_output hint (was a soft success)
- **`grep`/`glob` empty results**: include pattern/path context + recovery tips (not a bare “No matches found”)
- **`bash` non-zero exit**: always appends `[exit code N]` even when stdout/stderr is non-empty (models no longer miss the code in noisy output)
- **`forge status --cwd ''`**: fail closed with `invalid_cwd` (was treated as no filter → listed all)
- **`forge logout -p ''`**: fail closed with `invalid_provider` (was treated as omit → cleared **all** credentials)
- **`sessions list -q ''`**: fail closed with `invalid_query` (was treated as no filter)
- **Tool schemas / docs**: `search_replace` multi-match + miss guidance, `read_file` past-EOF, and unknown `task_id` suggestions documented in model-facing descriptions + `docs/TOOLS.md`
- **Empty `--goal`**: fail closed with `invalid_goal` (was silently ignored as falsy)
- **Empty `--deny`/`--allow`/`--ask`**: fail closed with `invalid_deny`/`invalid_allow`/`invalid_ask` (was silently ignored via `parseRuleString` null)
- **`sessions list|import --cwd ''`**: fail closed with `invalid_cwd` (was treated as “no filter” via truthy check)
- **Bare `--continue`/`--session` preflight**: does not apply `--title` before auth (failed login can no longer leave a half-renamed session)
- **`/logs` tab-complete**: offers `0`/`all` (full window) alongside 20/50/path
- **`forge config` empty flags**: `--provider`/`--model`/`--cwd` `''` fail closed (`invalid_*`); parent flag merge parity with doctor; shell completion offers `--json` for tips/init/completion
- **Empty-file `search_replace`**: miss hint says the file is empty and points at `write_file` (not generic closest-line tips)
- **`forge news` newest-first**: when a release section exceeds the display budget, take bullets from the **top** of the active `###` section (prepend convention) — tail-slice was hiding recent work and could surface stale duplicates
- **`/share` card**: `--continue` annotated fail-closed; CI line includes `forge tips --json`
- **`read_file` past-EOF**: offset beyond last line reports a clear past-end message (not “empty file” / inverted showing range)
- **`search_replace` multi-match**: lists line numbers + previews for each hit (cap 8) so the model can disambiguate without re-grepping blindly
- **`search_replace` miss guidance**: content-oriented closest-line hints + block-drift notes (no longer dumps path “did you mean?” when the file exists)
- **`get_task_output` / `kill_task` unknown id**: lists active tasks and suggests prefix/typo matches instead of a bare “Unknown task_id”
- **Empty `--cwd` / `--title` fail-closed**: structured `invalid_cwd` / `invalid_title` (no silent `path.resolve('')` → `.` or dropped title)
- **`forge logs -n 0`**: all events in the read window (was coerced to 30 via `Number(x)||30`); status `--interval 0` floors to 250ms
- **`--continue` fail-closed**: `forge run "…" --continue` and bare `forge "…" --continue` no longer silently start a fresh session when nothing is resumable — structured `{ ok:false, reason:continue_miss|continue_locked }` + exit 1 (CI-safe; omit `--continue` for fresh). Interactive same-cwd auto-resume (no flag) still soft-starts.
- **`forge tips --json` / `forge init --json` / `forge completion --json`**: structured envelopes for CI/onboarding; unknown completion shell → `reason:invalid_shell` (exit 1) instead of dumping bash script
- **content_filter / empty-response continues**: check stop-continue cap **before** injecting steerage user messages (avoids orphan prompts when releasing at cap; parity with `finish_reason=length`); empty-at-cap sets a clear `finalText` for headless JSON
- **length / stop-continue / content_filter cap release notes**: truncated-at-cap and content-filter-at-cap append Forge notes to `finalText`; stop-cap with blank assistant text no longer returns empty headless JSON
- **`list_dir` file-path error**: reports "not a directory" instead of "Directory not found" (parity with `glob`)
- **`forge tips` / `/tips` single source**: shared `formatExpertTips()` so CLI and REPL cheat sheets cannot drift (`/clear hard` included)
- **`releasedOnContinueCap` / `hitMaxTurns`**: headless JSON + metrics when stop-continue cap or `max_turns` releases (not a clean Stop) — CI can alert without hard-failing; stats aggregates `continueCapReleases` + `maxTurnsHits`; `forge run --help` documents JSON fields; library exports `LoopResult`
- **`max_turns = 0` is unlimited**: no longer silently capped at 200 (matches default config.toml comment); `/config` + doctor show `unlimited`; `forge config --json` includes `maxTurnsUnlimited`
- **`forge sessions title <id> <name|clear>`**: headless relabel (parity with `/title`; multi-word labels joined; searchable via list `-q`)
- **Doom-loop fingerprint**: ignore `background` / `stream` / `tail` / `allow_local` (plus existing timeout fields) so transport-only retries still trip; RELIABILITY docs updated
- **`forge sessions pin|title|fork` foreign-lock warn**: headless pin/title/fork warn (JSON: `foreignLock` / `sourceForeignLock`) when another live process holds `session.lock`
- **Tool schemas**: `glob` / `list_dir` descriptions note file-path → not-a-directory (parity with runtime)
- **`forge doctor --json`**: includes `maxTurns` + `maxTurnsUnlimited` (parity with `/config`)
- **`forge sessions show|export` lock hygiene**: show JSON includes `foreignLock`; export warns when source is foreign-locked
- **`/share` card**: includes `forge sessions title` headless relabel command
- **Anthropic `refusal` → `content_filter`**: maps stop_reason so loop content-filter steerage/cap applies (parity with OpenAI-compat); exported as `mapAnthropicStopReason`
- **`forge sessions path|list --json`**: includes `foreignLock` (list per-session); plain list + `/sessions`/`/resume` LOCK badge only for **foreign** live holders (own-pid locks are noise)
- **`forge sessions delete|import --json`**: structured failure payloads (`ok:false`, `reason`, …) for CI (still exit 1)
- **`forge run --json` early failures**: empty prompt / unauthenticated / session-not-found / foreign lock emit structured `{ ok:false, reason, … }` on stdout (still non-zero exit); `forge run` merges parent `optsWithGlobals` so `--session`/`--new`/`--title` bind correctly (was silently starting fresh)
- **`forge sessions * --json` lookup misses**: show/path/export/pin/title/fork emit `{ ok:false, reason:session_not_found, … }` (shared `failSessionLookup`); export invalid `--format` → `reason:invalid_format`
- **Bare `forge --continue`**: parent flag resumes newest same-cwd session for headless bare `forge "…"` (parity with `forge run --continue`; overrides `FORGE_NO_AUTO_RESUME`; `--title` relabels)
- **`forge sessions * --json` usage misses**: missing args emit `{ ok:false, reason:usage, error }` (shared `failUsage`) instead of stderr-only text
- **`finishReason` on headless JSON / `LoopResult`**: last provider `finish_reason` (or null); mid-run catch path adds `reason=error|timeout|aborted`
- **`invalid_effort` JSON**: `forge run --json --effort nope` emits `{ ok:false, reason:invalid_effort, … }` instead of stderr-only
- **CLI flag validation**: `--permission-mode` / `--sandbox` / `--sandbox-network` / `--sandbox-missing` reject unknown values (JSON reasons `invalid_permission_mode` · `invalid_sandbox` · …) instead of silently accepting typos; `mergeRunOpts` prefers CLI-sourced parent flags over run subcommand defaults (fixes parent `--permission-mode` being clobbered by run’s `acceptEdits` default) and unions parent/local `--deny`/`--allow`/`--ask` (empty run defaults no longer wipe parent rules)
- **`forge news` / `/news`**: prefer **newest** bullets when a release section exceeds the display budget (long 0.9.x bodies no longer hide recent work behind “+N more”)
- **`invalid_provider` JSON**: `--provider bogus` fails fast with structured reason (alias `grok` → `xai`) instead of a confusing unauthenticated/API error
- **Env enum hygiene**: invalid `FORGE_PROVIDER` / `FORGE_PERMISSION_MODE` / `FORGE_SANDBOX*` / `FORGE_READ_OUTSIDE` are ignored (keep defaults) instead of poisoning runtime config — parity with `FORGE_EFFORT`
- **`custom` provider requires base URL**: `--provider custom` without `--base-url` / `FORGE_BASE_URL` fails with `reason:missing_base_url` (no silent OpenAI fallback)
- **`--keep 0` is valid**: `sessions prune` / `prune-tool-output` / `prune-metrics` no longer treat `0` as missing via `Number(x)||default` (shared `parseKeepCount`; negative/NaN still fall back); `/sessions prune --keep=0` (and `--keep N`) parity; `--max-age-days 0` means no age filter (not coerced to 14)
- **`sessions list --limit 0`**: unlimited list (was coerced to default 30/20); `listSessions({ limit: 0 })` library parity
- **`sessions list|show --json`**: success payloads include `ok:true` (+ list `count`/`limit`) for CI parity with other session commands
- **`FORGE_ULW_STUCK_THRESHOLD`**: parsed via `envPositiveInt` (invalid/0 no longer poison stuck-wall)
- **`FORGE_GOAL_STUCK_THRESHOLD`**: ignore invalid/0 (0 would disable stuck-wall release forever)
- **`get_task_output` `tail: 0`**: full captured output (was coerced to 200 via `Number(x)||200`)
- **`forge stats --json`**: includes `ok:true` for CI parity
- **`read_file` `limit: 0` / `grep` `head_limit: 0`**: unlimited (was coerced to defaults via `Number(x)||n`); `forge news|models --json` and `/config json` include `ok:true`
- **`forge logs|prune-*|sessions prune --json`**: structured `{ ok:true, … }` envelopes; `web_fetch`/`web_search` ignore 0/invalid timeout/num_results (keep defaults)
- **`forge status --json`**: includes `ok`/`count`; `--session` miss → `{ ok:false, reason:session_not_found }` (exit 1) instead of empty HUD/array
- **`forge auth --json`**: structured auth status (`ok`, `authenticated`, `active`, `stored[]`) — **never** dumps tokens; exit 1 when unauthenticated
- **`forge logout --json`**: `{ ok, cleared, removed[], count }` (no tokens); `status --watch --session` miss fails fast (no empty watch loop)
- **`forge login --json`**: structured success/failure for `--from-grok` and `--api-key <key>` (never echoes keys; interactive OAuth/device rejected with `interactive_required`); tips CI line includes `forge auth --json`
- **`forge login -p/--provider`**: parent CLI provider no longer clobbered by login’s default `xai`; unknown providers → `invalid_provider` (JSON or stderr)
- **`forge login --api-key '' --json`**: empty key → `api_key_required` (no silent Grok import fallthrough)
- **Bare `forge "…" --json`**: parent `--json` forces headless and emits the same success/failure payload as `forge run --json` (empty prompt / unauthenticated / session-not-found structured); completion top-flags include `--json`/`--continue`; share card CI line + tips
- **Parent `--json` + subcommands**: `auth`/`doctor`/`models`/`stats`/`news`/`logs`/`config`/`prune-*` honor parent-attached `--json` via shared `flagJson` (Commander was binding the flag to the parent only, so `forge auth --json` printed human text); smoke covers bare `forge --json`; help example + AGENTS
- **`sessions export --out <dir>`**: structured `{ ok:false, reason:is_directory, hint }` (and plain error) instead of uncaught `EISDIR`; creates parent dirs for file targets; write failures → `reason:write_failed`
- **`sessions import <dir>` / `/export <dir>`**: directory targets fail closed with clear errors (`reason:is_directory` for import JSON; `/export` file-path hint) instead of `EISDIR`
- **`apply_patch` Move to existing path**: refuse when destination file/dir already exists (was silent clobber; undo journaled create could not restore prior dest body)
- **Shell hard-deny peels `bash -c` / `sh -c` and `$(…)` / `` `…` ``**: `bash -c "rm -rf /"` and `echo $(rm -rf /)` no longer bypass catastrophic deny (peelWrappers + commandCheckTargets)
- **`env`/`timeout` + `bash -c`**: re-join peeled tokens with shell quoting so multi-word `-c` bodies stay intact (`/usr/bin/env bash -c "rm -rf /"` no longer peels to bare `rm`)
- **`eval` / `xargs … bash -c` peels + runtime `system`/`execSync` rm-root**: hard-deny catches `eval "rm -rf /"`, `xargs bash -c "rm -rf /"`, and language-runtime shell deletes of `/` or `$HOME`
- **Heredoc-aware shell split + strip**: `git commit` / `cat <<EOF` payloads mentioning catastrophic commands no longer false-positive hard-deny; `bash <<EOF` bodies still scanned
- **`apply_patch` same-batch path tracking**: move/add refuse destinations created earlier in the same patch (was silent clobber across hunks)
- **`sessions export --out ''`**: structured `reason:usage` instead of treating empty as “no --out” and dumping the body on stdout
- **Shell peels**: `nohup`/`setsid`/`watch`, `busybox sh -c`, `su -c`, and `script -c` unwrap for hard-deny; RELIABILITY docs the peel matrix
- **Empty enum CLI flags**: `--permission-mode ''` / `--sandbox ''` / `--effort ''` (and sandbox-network/missing) fail with structured `invalid_*` instead of skipping validation and hitting the API
- **Empty `--provider` / `--model` / `--base-url`**: structured `invalid_provider` · `invalid_model` · `invalid_base_url` (was truthy-skip → silent default / API error)
- **Empty `--session` / export `--format ''`**: `session_not_found` (no silent fresh session) · `invalid_format` (no coerce to md via `|| "md"`)
- **`status --session ''`**: structured `session_not_found` (was silent empty HUD/`ok:true` list-all)
- **`doctor -p` parent merge**: parent/local `-p`/`--provider` honored (including empty → `invalid_provider`); was ignoring parent `-p` and doctor `-p bogus`
- **`forge auth --json` when unauthenticated**: `ok:false` + `reason:unauthenticated` (still exit 1; was `ok:true` with only `authenticated:false`)

### Recovery (disk + chat)
- **File mutation journal**: successful `write_file` / `search_replace` / `apply_patch` ops append pre-images to `~/.forge/sessions/<id>/mutations.jsonl` (mode `0600`, ~1.5 MiB cap per body)
- **`/undo` / `/rewind [n]`**: rewinds chat **and** restores journaled files for those turns (create→unlink, update/delete→pre-image)
- **`/retry` / `/again`**: same disk restore before re-running the prompt
- **Fork copies journal + ULW/goal harness sidecars** (`ulw.json` / `goal.json`) so `/fork` mid-ULW keeps the relentless driver; `/fork` output reports `Harness copied: …` when applicable
- **`/clear` resets timeline cleanly**: drops mutation journal, `editCount` / token counters, **and** ULW/goal `lastBlockEditCount` / `stuckBlocks` (stuck-wall must not treat pre-clear edits as progress)
- **`/new` does not inherit `ultrawork`**: fresh session id starts clean; re-arm with `/ulw` or `/goal` (avoids Stop backstop without `ulw.json`)
- **`/clear hard`**: brand-new session id (documented + Tab-complete); same clean-start rules as `/new`
- Large / unreadable pre-images are skipped with an explicit note (never silent data loss claims)

### Expert UX
- **`/init [focus]`**: OpenCode-style guided `AGENTS.md` bootstrap / improve (forwards a high-signal research+write prompt)
- **`/review [target]`**: OpenCode-style code review — `uncommitted` (default) · `staged` · `<commit>` · `<branch>` · `<pr#|url>`
- **`/compact-and <prompt>`**: Warp-style compact then continue with a follow-up in one step
- **`/fork-and-compact [prompt]`**: fork → compact the fork → optional continue (original history preserved)
- **`/config [json]`** · **`forge config [--json]`**: live-safe effective config snapshot (provider/model/sandbox/permissions/timeouts/FORGE_HOME — **never** dumps API keys)
- **`/export` path writes mode `0600`** (parity with `forge sessions export --out`)
- Help, tips, tab-complete updated

### Operator knobs
- **`FORGE_BASH_TIMEOUT_MS`** (default 120s, min 5s, max 30m) and **`FORGE_BASH_BG_TIMEOUT_MS`** (default 30m) for CI/long builds
- **`forge doctor --json`**: `bashTimeoutMs` · `bashBackgroundTimeoutMs`; plain doctor reliability line includes bash timeouts + file-aware undo

### Incident triage
- **`/logs [n|path]`** (live-safe) + **`forge logs`**: tail sandbox/safety events from `~/.forge/logs/sandbox.jsonl` (no secrets; Warp-inspired)
- Shell completion + smoke cover `logs`
- **Doctor** surfaces `undo-journal:` aggregate (`mutations.jsonl` session/entry/byte counts) when present; **`forge doctor --json`** includes `undoJournal: { sessions, bytes, entries }`

### Production polish (post-merge review)
- **Smoke**: replace fragile shell-empty-arg chain with `scripts/smoke.mjs` (isolated FORGE_HOME/GROK_HOME, explicit argv, timeouts)
- **Hard-deny**: `git push origin +main` / `+master` refspec force; `rm -rf ~/`, `~/*`, `$HOME/`, `$HOME/*`
- **File-aware undo**: restore-before-truncate journal (failed undos keep pre-images); never restore disk when chat rewind is a no-op; rebuild `userTurnMarks` after compact
- **Auth**: mid-run 401 tries `resolveAuthFresh` (Grok re-import) after refresh failure; doctor uses `resolveAuthFresh` so SuperGrok TTL does not false-fail CI
- **OIDC callback**: honor `FORGE_XAI_REDIRECT_URI` path; HTML-escape error_description on local callback page
- **CI**: `npm run check` builds before tests (dist-dependent CLI tests run); smoke asserts `empty_prompt` + `invalid_provider`
- **Multi-day unattended**: proactive OAuth refresh each model turn (~10m skew); multi-recovery mid-run (`FORGE_AUTH_RECOVERY_MAX`); 401-only recovery (quota 403 no longer burns slot); clear dead refresh_token on `invalid_grant`; session locks never TTL-steal **live** pids + touch on save; REPL fail-closed on foreign live lock (`FORGE_FORCE_SESSION_LOCK=1` override); doctor flags missing refresh_token

### SuperGrok OIDC
- **`forge login` (xai default)**: browser SuperGrok / xAI OIDC with the public Grok CLI client (`b1a00492-…`), PKCE, callback `http://127.0.0.1:56121/callback`
- Correct OIDC endpoints: `oauth2/authorize`, `oauth2/token`, `oauth2/device/code` (replaces broken `/oauth/token` + fake `forge-cli` client)
- Scopes: `openid profile email offline_access grok-cli:access api:access` → subscription-backed API + refresh tokens
- **`forge login --device`**: SuperGrok device-code for SSH / headless
- **`forge login --from-grok`**: still imports `~/.grok/auth.json` when Grok Build is already logged in
- Refresh uses the same public client + token URL; stores `clientId` on login for long sessions
- CI: `login --json` still requires `--api-key` (interactive OAuth/device → `interactive_required`)

### Docs / tests
- RELIABILITY + PRODUCTION + README note file-aware undo and new slash commands
- Tests: `mutations-undo.test.ts`, `logs.test.ts` (journal, restore, `/logs`, bash timeout env)
- `.gitignore` covers `.tmp-*/` compile caches
- Tests: SuperGrok OIDC profile + id_token email decode (`tests/xai-oauth.test.ts`)

## 0.9.4 — Expert UX (retry, pin, stats, resume-by-title)

Daily-driver session operations and orientation for long-running experts. Builds on 0.9.3 reliability.

### Sessions & resume
- **`forge run --continue`**: headless same-cwd resume (≤14d, skips foreign locks) — multi-step CI without copying session ids (OpenCode-style)
- **Resume by title**: `/resume <title>` · `forge --session <title>` · `sessions show|export|fork|delete|path|pin` resolve unique exact/substring titles (and last-prompt); ambiguous matches list candidates
- **`lastUserPreview`**: session meta sidecar stores last user prompt (80 chars) for `/sessions` · `forge sessions list` · `-q` search · `sessions show`
- **Relative ages** in session lists: `just now` / `5m` / `3h` / `2d` instead of raw ISO timestamps
- **Resume orientation**: auto-resume / `/resume` / `forge run --session` show last turn + mutated files
- **`/last [n]`**: peek last N user/assistant turns (live-safe)
- **`/files [writes|n]`**: paths touched by tools this session (R/A/M/P/D tags; live-safe)
- **`/path [id|json|copy]`** · **`forge sessions path <id|title>`**: on-disk session dir / `session.json` (live-safe; optional clipboard)
- **`sessions show`**: relative age, path line, files snippet, last-turn peek; JSON includes `path`

### Pin / prune hygiene
- **`/pin` / `/unpin`** (live-safe) + **`forge sessions pin|unpin`**: protect sessions from prune (`meta.pinned`; lists show `PIN`)
- **Fork clears pin**; import never inherits pin; status/prompt show `PIN` badge
- **`/sessions pinned`** · **`forge sessions list --pinned`**
- **Prune** reports `skippedPinned`; doctor plain + `--json` **`sessionsPinned`**

### Recovery & handoff
- **`/retry` / `/again` [prompt]**: rewind last user turn and re-run (optional rewritten prompt)
- **`/share`**: pasteable session card (resume/export cmds + optional clipboard)
- **`/done` / `/pause` / `/unpause`**: live-safe shorthands for `/goal done|pause|resume`

### Usage & discovery
- **`forge stats` / `/stats [days]`**: usage dashboard from metrics.jsonl (runs, tokens, est. cost, providers, projects) + session inventory (incl. pinned)
- **`forge news` / `/news` [n]**: in-app what's-new from packaged CHANGELOG (`forge changelog` alias; `--json`)
- **`forge tips` / `/tips`**: expert cheat sheet
- **First-run welcome tip** in REPL banner (once; `preferences.seenWelcomeTip`)
- **Install / banner / help**: surface `/news` · `/retry` · `/last` · `forge tips` · `--continue` · `stats`

### Docs / tests
- README, PRODUCTION, AGENTS, shell completion updated for the expert surface
- Tests: changelog, retry/last/files/pin/path, resume-by-title, continue, stats, live-controls, session-format

## 0.9.3 — Production lock & fetch hardening

Professional production polish on the 0.9.2 reliability surface after VM self-improvement review.

### Reliability / safety
- **`web_fetch` stream body cap**: reads via `ReadableStream` with a hard 5 MiB limit — missing/lying Content-Length cannot OOM the process; cancels body when oversize
- **`web_search` HTML scrape** capped at 2 MiB via the same reader
- **Headless session lock fail-closed**: `forge run` exits `1` when another live process holds `session.lock` (override `FORGE_FORCE_SESSION_LOCK=1`); REPL still warns and continues
- **Live lock + bad `acquiredAt`**: no longer treated as stale/stealable — only dead pids or parseable age past TTL
- **Heal re-save**: `loadSession` skips disk re-save when a foreign live lock is present (in-memory heal only)
- **External directory gate** covers `grep` / `glob` absolute paths (same as `read_file`) so models cannot bypass with search tools
- **`grep` abort**: honors turn `AbortSignal` (kills `rg`, cooperative JS fallback)
- **Session export `--out`**: writes mode `0600` (transcripts may contain secrets)
- **`forge sessions <query>`**: unknown first arg is title/id search (same as `-q`)
- **`install.sh`**: executable mode restored (`100755`)

### Docs / tests
- `docs/RELIABILITY.md`, `docs/PRODUCTION.md`, `.env.example` document lock fail-closed + body caps
- Tests: `readBodyCapped`, grep/glob external deny, live pid + invalid `acquiredAt` hold

## 0.9.2 — Error-streak, session ops, apply_patch

Learned from Grok Build (consecutive-failure circuit breaker) and OpenCode (session branch/export, apply_patch).

### Reliability / smartness
- **Error-streak circuit breaker**: 5 consecutive tool errors (different args OK) inject a hard strategy-change nudge; permission/hard denies excluded
- **Tunable loop guards**: `FORGE_DOOM_LOOP_THRESHOLD`, `FORGE_ERROR_STREAK_THRESHOLD`, `FORGE_ULW_MAX_CONTINUES` (invalid values fall back safely)
- **Background task teardown**: REPL exit + headless run end force-kill in-process `background=true` shells; `beforeExit`/`exit` safety net; SessionEnd runs before kill so hooks can observe tasks
- **Doctor** surfaces in-process background task counts + saved always-allow count; flags `auth.json` / `permissions.json` / `preferences.json` mode `0600`; `--json` includes structured `secureFiles` + `issues[]`; **Blocking Stop OFF** is a doctor issue; CI `ok` from `runDoctorCheck()` (never chalk/report regex); plain `forge doctor` also exits `1` on issues
- **`web_fetch` htmlToText**: invalid / out-of-range numeric entities no longer throw `RangeError` (keeps original token)
- **path-not-found hints**: typo tolerance via edit distance (e.g. `readmi.md` → `readme.md`), not substring-only
- **Shared `editDistance` / `stringSimilarity`** (`util/string-distance`) used by path-hints + block-anchor edit-match; stale “Levenshtein deferred” comment fixed
- **`glob` missing search root**: reports `Directory not found` + path hints instead of a false “No files matched”
- **`forge run`**: sandbox / network / missing-backend flags + `--deny`/`--allow`/`--ask`/`--base-url` (parity with top-level CLI); help documents exit codes 0/1/124/130
- **`grep` missing path**: errors with path hints instead of a false “No matches found”; JS fallback searches a single-file `path` correctly
- **Shell completion**: richer fish/zsh/bash for `run` (sandbox/deny/allow/ask) and `sessions export|import|prune` (`--format md|json`, `--out`, `--keep`, …)
- **`read_file`**: soft large-file size hint (≥2 MiB) steers agents toward offset/limit or grep
- **`write_file`**: structured errors (no throw-through); notes when parent directories were created
- **`/copy`**: multi-backend clipboard (`pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip` / `clip.exe`) with clear fallback preview; **live-safe** mid-run
- **`forge sessions export`**: rejects unknown `--format` (md|json only; validated before session lookup)
- **Tool schemas**: model-facing descriptions for read/write/grep/glob/list_dir document path hints, parent-dir creates, large-file guidance
- **Session import/load**: import rejects invalid message roles; `loadSession` soft-drops corrupt roles/todos, heals orphan tool_call pairs, and **re-saves** when healed so disk stays clean; `listSessions` / `loadSessionMeta` skip corrupt dirs; prune age filter ignores invalid timestamps
- **Session lock**: corrupt lock JSON / invalid pid treated as absent; dead pid or parseable age past TTL → stale steal; lock files mode `0600` (see 0.9.3 for headless fail-closed + live/bad-timestamp hold)
- **`apply_patch` path hints**: missing update/delete targets suggest nearby typos (parity with read/edit/grep)
- **Task tool schemas**: `kill_task` / `get_task_output` omit `task_id` from required (empty call lists actives; no empty `required: []`)
- **write_file / search_replace**: refuse directory targets with a clear message (no opaque `EISDIR`)
- **`apply_patch` add/update**: clear errors when path is a directory (no opaque `EISDIR`); add distinguishes dir vs file
- **`/diff` shell-safe**: filter args via `execFileSync` argv (no shell interpolation); deny write/exec git options (`--output`, `--ext-diff`, `--git-dir`, …); `git-context` also argv-based
- **sessions prune/delete**: never deletes sessions held by another live process (foreign `session.lock`); prune reports `skippedLocked`; delete refuses locked sessions unless `--force` (bash/zsh/fish completion includes `--force`)
- **Doctor sessions**: text line + `doctor --json` `sessionsLocked` count foreign live locks
- **`/diff` help**: documents argv-safe pathspecs/refs-only filters
- **`/resume`**: warns when target session has a foreign live lock; recent list shows LOCK tags
- **`forge sessions` list footer**: documents `delete [--force]`
- **`forge sessions list --cwd`**: filter sessions by workspace path (multi-project experts)
- **`listSessions({ cwd, query, limit })`**: native filter before limit; `/sessions` defaults to same-cwd, supports `all` / `search <q>`
- **`forge sessions list -q/--query`**: CLI title/id search; `/resume` picker defaults to same-cwd (`/resume all` for global)
- **`forge status --cwd`**: uses native `listSessions({ cwd })` so multi-project HUD is not starved by other workspaces
- **`forge` / `forge run --title`**: label sessions at create (CI-friendly; searchable via `-q` / `/sessions search`)
- **`web_fetch` / `web_search`**: honor turn abort signal (Ctrl+C / `FORGE_MAX_RUN_MS`); fetch signal stays live through body read; headless JSON includes `title`
- **Abort ≠ error-streak**: cooperative `Aborted` tool results excluded from circuit breaker; loop fail-fast after aborted tool batch
- **`forge sessions list`**: shows project basename when not filtered by `--cwd` (multi-project scan)
- **`/new [title]`**: optional searchable label on fresh REPL sessions; Tab completes `/sessions` / `/resume` verbs
- **`forge run`**: rejects empty/whitespace prompts before auth/session create (no orphan sessions, no API spend); help documents empty-prompt + `--title`
- **`kill_task` without id**: lists active tasks (parity with `get_task_output`) so agents can recover the id
- **permission-saved + auth store**: never mutate shared empty JSON fallbacks (always-allow / credential corruption fix)
- **`readJsonFile`**: clones object/array fallbacks so shared `EMPTY` constants cannot be corrupted
- **`/permissions list`** live-safe mid-run; menu numbers never assign `list`/`clear` as a permission mode
- **Richer retry HUD**: status shows human wait (`1.2s`) + HTTP reason / Retry-After
- **Session crash recovery**: load promotes newest leftover atomic-write tmp when `session.json` is missing/corrupt
- **`apply_patch` tool**: multi-file add/update/delete/move (OpenAI/OpenCode patch grammar); validate-then-apply; hard-deny path scan
- **Atomic file writes**: `write_file` / `search_replace` / `apply_patch` use tmp+rename (no truncated files on crash)
- **Permission ask timeout**: `FORGE_PERMISSION_TIMEOUT_MS` auto-denies stalled interactive Allow? prompts
- **metrics.jsonl**: counter-only run telemetry (`~/.forge/metrics.jsonl`); headless JSON includes `durationMs`; auto-prune ~2000 events / 2 MiB; `forge prune-metrics`

### Expert UX
- **`forge sessions show|export|import|fork|delete [--force]|list --cwd`** — inspect, markdown/JSON export/import, branch; lock-safe delete/prune; multi-project list filter
- **`/title` / `/rename`** — show/set/clear session title (live-safe mid-run)
- **`/bell [on|off|test]`** — optional terminal BEL on turn end (pref + `FORGE_BELL`); long-run attention
- **Interactive auto-resume** — bare `forge` continues newest same-cwd session (≤14d); skips foreign live locks (with skip count in resume log); `--new` / `FORGE_NO_AUTO_RESUME=1` for fresh
- **Richer model catalogs** for OpenAI / OpenRouter / Google (`forge models`)
- **`forge doctor --json`** exposes doom-loop / error-streak / ULW continue thresholds, perm-ask timeout, bell, auto-resume, **`sessionsLocked`** (see 0.9.4 for `sessionsPinned`)
- **`/fork`**, **`/export [--json]`**, **`/diff`** (shell-safe), **`/metrics`** in the REPL (diff/metrics live-safe)
- Richer bash completion for sessions show/export/import/fork/delete (`--force`)
- Doctor surfaces metrics + perm-ask-timeout + foreign-locked session count
- **Readable permission previews** for `apply_patch` (A/M/D ops list instead of raw patch dump)
- **Stream resilience**: OpenAI-compat + Anthropic SSE `error` events + fully empty streams throw as retryable (dropped connection)
- **Soft-dangerous** `git commit/push --no-verify` (and `commit -n`, not dry-run `-n` on other verbs) so acceptEdits still prompts
- **`forge run --session <id>`** resume prior headless/REPL session for multi-step CI pipelines
- **Headless session lock** — `forge run` takes the same `session.lock` as the REPL (warn on conflict; steal stale)
- **`forge sessions` / `/sessions` / `/status` / `forge status`** surface lock holders (HUD tags `LOCK:<pid>` for foreign live locks)

### Tests / docs
- Coverage for error-streak, fork/export JSON, tmp recovery, apply_patch, atomic write, metrics, perm timeout, env parsers, bell, title, same-cwd auto-resume, bg kill-all, lock-skip resume, permission-saved, readJsonFile isolation, inspectSecureFile / doctor secureFiles
- `docs/RELIABILITY.md` + `docs/PRODUCTION.md` + `docs/TOOLS.md` + `docs/HARNESS.md` + `.env.example` + `AGENTS.md` updated

## 0.9.1 — Context overflow + ULW survival

- **xAI overflow detect**: match `maximum prompt length is N but the request contains M tokens` (was missed → run died raw 400)
- **Conservative token estimate** (~3.2 chars/tok + framing + tool schemas) so HUD/auto-compact no longer lag ~15% behind the API
- **Progressive overflow recovery**: prune oversized tool/assistant bodies → keep 8→4→2 → nuclear; then re-issue
- **ULW re-admit after overflow**: long tool-only waves never hit Stop (`wave=0 blocks=0 cycle=1`); recovery now re-anchors mandate instead of hard death
- **92% headroom compact** before riding the absolute model max

## 0.9.0 — Production reliability

Learned from OpenCode / peer agent loops; aimed at expert daily-driver and CI use.

### Reliability
- **Retry-After** honored on provider `429`/`5xx` (`ProviderApiError` + structured headers)
- **Abortable** chat streams and sandboxed bash (Ctrl+C cancels in-flight work)
- **JSON tool-arg repair** for truncated / fenced / trailing-comma / unescaped-quote args
- **Orphan tool_call healing** after abort or compact (prevents next-turn API 400)
- **Compact keep-boundary** never cuts mid tool batch
- **`finish_reason=length`** continues generation instead of stopping mid-answer
- **Empty model response** nudge instead of silent stop
- **Doom-loop detection** — identical tool+args ×3 injects strategy-change nudge
- **Stream usage** via `stream_options.include_usage` for accurate `/cost`
- **Provider wall-clock timeout** (default 5m, `FORGE_PROVIDER_TIMEOUT_MS`) — timeout retryable, user abort not
- **Mid-run OAuth refresh** on 401/403 (hot-swaps bearer on the live provider)
- **Headless CI exit codes** — abort → 130; structured JSON errors on failure

### Auth & sessions
- `resolveAuthFresh` proactively refreshes OAuth before REPL/headless start
- Session **file lock** (`session.lock`) with stale-pid steal + multi-REPL warning
- `/doctor` reports token expiry, auth.json mode bits, sandbox fail-closed, reliability features

### Docs
- `docs/RELIABILITY.md` — operator-facing production contract

### Tests
- Expanded suite (**251+** tests) covering reliability, sessions, doctor, completion, tool-output, sandbox log
- **Context overflow recovery**: detect prompt-too-long, skip blind retries, force compact + one re-issue
- **Compact thrash guard**: no-op threshold compacts are not repeated every turn
- **`forge prune-tool-output`** + auto-prune of `~/.forge/tool-output` (keep 80 / 14d); doctor surfaces size
- **sandbox.jsonl rotation** at 2 MiB (one backup); doctor surfaces log size
- Doctor shows **session count** / tool-output / sandbox-log; `--json` includes `sessionCount`, `toolOutput`, `sandboxLog` + exit 1 when unhealthy
- `npm run smoke` / `npm run ci` for CI (tolerates unauthenticated doctor; includes prune-tool-output)
- **`FORGE_MAX_RUN_MS`** optional headless wall-clock deadline (exit 124 / `timedOut`)
- Legacy sessions **backfill meta.json** on first list
- **Session `meta.json` sidecar** — fast `listSessions` / prune without parsing multi-MB histories
- **`forge completion bash|zsh|fish`** shell completions for experts
- CLI help epilogue with production examples + docs pointers
- Version read from `package.json` (no more dual hardcodes in cli/repl)
- **`FORGE_LOG_JSON=1`** structured stderr logs for CI
- **`forge doctor --json`** machine-readable health summary
- **web_search** DuckDuckGo HTML fallback when Instant Answer is empty
- Richer **git context** (ahead/behind, changed file count, more project fingerprints)
- **`forge models --json`** / **`forge doctor --json`** exit code 1 on unhealthy
- **`forge sessions delete|prune`** disk hygiene for long-running expert machines
- GitHub Actions **CI** (Node 20/22 · typecheck · test · build · CLI smoke)
- Expert **docs/PRODUCTION.md** checklist
- System prompt **Reliability (runtime self-heal)** section (doom-loop, JSON repair, length continue)
- `forge doctor` prints **Version**; install.sh runs doctor after link
- `SECURITY.md` + `CONTRIBUTING.md`

## 0.8.0 — Bar A daily-driver safety

Fail-closed headless shell/writes, segment-strict allow rules, protected paths, project config cannot YOLO / redirect credentials / turn sandbox off.

## 0.7.x — Tool quality

Edit match fallbacks, managed truncation, env scrubbing, path hints.

## 0.6.x — Safety stack + harness

Blocking Stop, `/goal`, ULW cycle, sandbox profiles.
