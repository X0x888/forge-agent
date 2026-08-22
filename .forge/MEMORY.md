# Project memory

> Auto-maintained by Forge. Edit carefully — agent loads this across sessions.
> key=d54ef9c78f11c027 · updated=2026-08-22T05:46:48.091Z

## constraint

- blockingStopHooks defaults to true — never weaken Stop fail-closed (timeout/error keeps agent working).

## gotcha

- npm test sets TMPDIR=$PWD/.tmp — use that (or realpath outside repo) for sandboxed git/temp; bare os.tmpdir() points inside the git tree.
- Sandboxed git init often fails chmod on .git/config.lock — prefer the real project git root for tests instead of git init in temp dirs.
- git() in worktree.ts must not trimStart porcelain: unstaged-only is " M path". trim() made slice(3) drop first char (src→rc) and hide untracked. tests/__wt_land__/ is gitignored — worktree-land fixtures live under src/agent/__wt_land_*.
- parsePorcelainPath / unquotePorcelainPath are public. git() uses trimEnd only — never trimStart porcelain. Unit test: " M src/agent/worktree.ts" → src/agent/worktree.ts.
- git apply --3way stages files; land path prefers plain apply then 3way+unstage so parent index stays clean. Unstage must use git() (trimEnd only) + parsePorcelainPath — never execFileSync().trim() on porcelain.
- Never land src/agent/worktree.ts or AGENTS.md in worktree-land tests — a failed /undo restore deletes the file. Use disposable src/agent/__wt_land_* fixtures + journalLandedPreimages unit path.
- `/auth` empty is `auth  ·  none` with no Next — login is not a › key. `/accounts` empty still closer `/auth`. `formatAuthCard` hides Next `/auth` so the lastErr key is not circular. `printAuthStatus()` is CLI-only (`forge auth`).
- Foreground bash / idle !cmd journal git porcelain deltas into mutations.jsonl so /undo restores shell writes. /verify sets journal:false (checks must not become undo turns). FORGE_BASH_MUTATION_JOURNAL=0 off. Background tasks are not journaled. Not a repo / clean tree / no recordMutation is designed empty.
- Safety checkpoints use a temp index (untracked in, secrets out), not git stash create. Restore is git restore --source=sha overwrite + mixed reset — never git stash apply. /checkpoint restore falls back to ulw.checkpointSha. Bare /checkpoint peeks; /checkpoint snap takes the snapshot.
- /files and /last merge mutations.jsonl so bash / background / worktree-land writes appear (those tools have no path arg). Designed empty: no journal / FORGE_BASH_MUTATION_JOURNAL=0 / still-running bg until exit.
- Foreground bash / idle !cmd / background bash journal git porcelain deltas into mutations.jsonl so /undo restores shell writes. Snapshot at start; porcelain applies on exit. /verify sets journal:false. FORGE_BASH_MUTATION_JOURNAL=0 off. /undo of the launch turn settles in-flight bg journals and SIGKILLs those writers. Designed empty: not a repo / clean tree / no recordMutation / still running (until exit or settle).
- apply_patch is a transaction: mid-apply write failure rolls back earlier ops (add→unlink, update→before, delete→rewrite, move→restore src + drop dest). Journal and onEdit run only after the batch commits. Rollback restamps noted files (refreshNotedFromDisk) so a retry is not blocked as changed-on-disk. Designed leftover: empty parent dirs from a rolled-back add.
- MCP/LSP stdio createChildEnv(keepSecrets) keeps GITHUB_TOKEN / CONTEXT7_API_KEY but never inherits Forge provider keys (XAI_API_KEY, CURSOR_ACCESS_TOKEN, OPENAI_API_KEY, … / PROVIDER_API_KEY_ENV). mcp.json env overlay (set) can pass a key on purpose. Do not add keepSecrets names to the inherit path.
- Credential reads (auth.json, id_rsa / ~/.ssh private keys, Cursor auth.json) are hard-denied via isProtectedReadPath — YOLO and --read-outside allow cannot dump tokens into the model. Inspecting .git/hooks and workspace .env stays allowed. Seatbelt denies file-read of auth.json; bwrap binds /dev/null over it when the file exists.

## convention

- Preferred checks: npm run typecheck · npm test · npm run check · npm run smoke · npm run ci (cheapest first).
- Sit-down Next at › is a slash key, never a CLI dump (`npm test`, `forge accounts switch`, `forge login`). lastErr map: 429/quota → /accounts, auth → /auth, overflow → /compact, max_cost → /budget, else /retry. Headless `forge run` keeps CLI verbs.
- Sit-down /budget is verdict-first (HIT / ok / none). HIT Next is /budget off. Raising or clearing the cap so it no longer hits clears lastError.code=max_cost. FORGE_MAX_COST_USD / config.toml stay off ›.
- Sit-down /doctor Next is slash keys only (/auth /permissions /setup /status). forge login and forge doctor --json stay on surface:cli (forge doctor). Default formatDoctorCloser surface is repl.
- isolation=worktree auto-lands into parent only when status=completed (FORGE_SUBAGENT_LAND=auto|keep|discard); incomplete_max_turns / abort / error / stop-hook skip apply and keep the worktree. Kept on conflict. FORGE_SUBAGENT_KEEP_WORKTREE=1 forces keep.
- `/budget` is a family spend cap. spawn_subagent pins the child to remaining (not a fresh config.maxCostUsd). Parent HIT refuses spawn. Copy the pre-worktree pin onto child.meta — do not re-pin after createSession (a sibling live-fold can refuse and leave the child uncapped). Live-fold so parallel children share remaining. Cost-cap handoff is `incomplete_cost_cap` (does not land).
- lsp({ action: ensure }) is a mutation (npm install -g / rustup / go install). Plan / ULW PLAN / dontAsk / headless / session-tool on status do not auto-allow. diagnostics / status / install-guide / dry-run stay read-only. YOLO / allow rule still work. CLI forge lsp ensure is user-initiated.
- Forge-spawned children use createChildEnv, not raw process.env. Git helpers (checkpoint, journal, worktree, /commit, /diff, auto-commit) must not inherit host GIT_DIR / GIT_INDEX_FILE. Extra env is policy set after the scrub. MCP/LSP stdio: createChildEnv(env, { keepSecrets: true }).
- workspace/strict OS sandbox write allow is CWD + ~/.forge/{sessions,logs,tmp} + temp — never the ~/.forge root (auth.json). Seatbelt deny-after-allow blocks .git/hooks / .ssh / .gnupg / shell rc / id_rsa even for python/sed/node. git commit/config stay allowed (.git/config and HEAD stay writable). Background bash must use seatbeltProfile (no duplicate writer). Linux leftover: cannot ro-bind a missing .git/hooks dir.
- Forge-spawned children use createChildEnv, not raw process.env. Git helpers must not inherit host GIT_DIR / GIT_INDEX_FILE. Extra env is policy set after the scrub. MCP/LSP stdio: createChildEnv(env, { keepSecrets: true }) — keeps GITHUB_TOKEN; never inherit XAI_API_KEY / CURSOR_ACCESS_TOKEN / other PROVIDER_API_KEY_ENV names unless mcp.json env sets them.

## fact

- Cross-session memory: memory_write scope=project → ~/.forge/project-memory + .forge/MEMORY.md; /memory project to list/add/clear.
