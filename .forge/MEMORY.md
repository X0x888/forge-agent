# Project memory

> Auto-maintained by Forge. Edit carefully — agent loads this across sessions.
> key=d54ef9c78f11c027 · updated=2026-08-22T04:11:58.646Z

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
- Foreground bash / idle !cmd / background bash journal git porcelain deltas into mutations.jsonl so /undo restores shell writes. Background snapshots at start and applies on exit; /undo of the launch turn settles in-flight journals and SIGKILLs those writers. Concurrent tool writes after the snapshot stay that tool's entries. /verify sets journal:false. FORGE_BASH_MUTATION_JOURNAL=0 off. Not a repo / clean tree / no recordMutation / still running (until exit or settle) is designed empty.
- Safety checkpoints use a temp index (untracked in, secrets out), not git stash create. Restore is git restore --source=sha overwrite + mixed reset — never git stash apply. /checkpoint restore falls back to ulw.checkpointSha. Bare /checkpoint peeks; /checkpoint snap takes the snapshot.

## convention

- Preferred checks: npm run typecheck · npm test · npm run check · npm run smoke · npm run ci (cheapest first).
- isolation=worktree auto-lands into parent (FORGE_SUBAGENT_LAND=auto|keep|discard); kept on conflict. FORGE_SUBAGENT_KEEP_WORKTREE=1 forces keep.
- Sit-down Next at › is a slash key, never a CLI dump (`npm test`, `forge accounts switch`, `forge login`). lastErr map: 429/quota → /accounts, auth → /auth, overflow → /compact, max_cost → /budget, else /retry. Headless `forge run` keeps CLI verbs.
- Sit-down /budget is verdict-first (HIT / ok / none). HIT Next is /budget off. Raising or clearing the cap so it no longer hits clears lastError.code=max_cost. FORGE_MAX_COST_USD / config.toml stay off ›.
- Sit-down /doctor Next is slash keys only (/auth /permissions /setup /status). forge login and forge doctor --json stay on surface:cli (forge doctor). Default formatDoctorCloser surface is repl.
- Bash write dests (redirect / tee / cp|mv|ln) hard-deny isProtectedWritePath (.git/hooks, .git/config, .ssh, forge auth) — same list as write_file. Do not use checkWritePathHardDeny on redirects (`> /dev/null`). git commit/config stay allowed.

## fact

- Cross-session memory: memory_write scope=project → ~/.forge/project-memory + .forge/MEMORY.md; /memory project to list/add/clear.
