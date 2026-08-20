# Project memory

> Auto-maintained by Forge. Edit carefully — agent loads this across sessions.
> key=d54ef9c78f11c027 · updated=2026-08-20T22:52:35.198Z

## constraint

- blockingStopHooks defaults to true — never weaken Stop fail-closed (timeout/error keeps agent working).

## decision

- Daily-loop reading (this cycle): job + what's wrong + the next key you type at ›. Ships: /verify, lastErr slash keys, /accounts, /last, /sessions errors, /retry refuse-429, /done, /share, auto-verify nudge → /verify, /auth card. Do not re-derive.

## gotcha

- npm test sets TMPDIR=$PWD/.tmp — use that (or realpath outside repo) for sandboxed git/temp; bare os.tmpdir() points inside the git tree.
- Sandboxed git init often fails chmod on .git/config.lock — prefer the real project git root for tests instead of git init in temp dirs.
- git apply --3way stages files; land path prefers plain apply then 3way+unstage so parent index stays clean.
- git() in worktree.ts must not trimStart porcelain: unstaged-only is " M path". trim() made slice(3) drop first char (src→rc) and hide untracked. tests/__wt_land__/ is gitignored — worktree-land fixtures live under src/agent/__wt_land_*.
- parsePorcelainPath / unquotePorcelainPath are public. git() uses trimEnd only — never trimStart porcelain. Unit test: " M src/agent/worktree.ts" → src/agent/worktree.ts.
- git apply --3way stages files; land path prefers plain apply then 3way+unstage so parent index stays clean. Unstage must use git() (trimEnd only) + parsePorcelainPath — never execFileSync().trim() on porcelain.
- Never land src/agent/worktree.ts or AGENTS.md in worktree-land tests — a failed /undo restore deletes the file. Use disposable src/agent/__wt_land_* fixtures + journalLandedPreimages unit path.
- `/auth` empty is `auth  ·  none` with no Next — login is not a › key. `/accounts` empty still closer `/auth`. `formatAuthCard` hides Next `/auth` so the lastErr key is not circular. `printAuthStatus()` is CLI-only (`forge auth`).
- Foreground bash / idle !cmd journal git porcelain deltas into mutations.jsonl so /undo restores shell writes. /verify sets journal:false (checks must not become undo turns). FORGE_BASH_MUTATION_JOURNAL=0 off. Background tasks are not journaled. Not a repo / clean tree / no recordMutation is designed empty.

## convention

- Preferred checks: npm run typecheck · npm test · npm run check · npm run smoke · npm run ci (cheapest first).
- isolation=worktree auto-lands into parent (FORGE_SUBAGENT_LAND=auto|keep|discard); kept on conflict. FORGE_SUBAGENT_KEEP_WORKTREE=1 forces keep.
- Sit-down Next at › is a slash key, never a CLI dump (`npm test`, `forge accounts switch`, `forge login`). lastErr map: 429/quota → /accounts, auth → /auth, overflow → /compact, max_cost → /budget, else /retry. Headless `forge run` keeps CLI verbs.

## fact

- Cross-session memory: memory_write scope=project → ~/.forge/project-memory + .forge/MEMORY.md; /memory project to list/add/clear.
- ULW arm auto-checkpoints dirty trees via git stash create (FORGE_ULW_CHECKPOINT=0 off). Restore: /checkpoint restore.
