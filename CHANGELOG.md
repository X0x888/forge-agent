# Changelog

## Unreleased

### Added
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
