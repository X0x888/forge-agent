# Project memory

> Auto-maintained by Forge. Edit carefully — agent loads this across sessions.
> key=d54ef9c78f11c027 · updated=2026-08-13T08:29:30.384Z

## constraint

- blockingStopHooks defaults to true — never weaken Stop fail-closed (timeout/error keeps agent working).

## gotcha

- npm test sets TMPDIR=$PWD/.tmp — use that (or realpath outside repo) for sandboxed git/temp; bare os.tmpdir() points inside the git tree.
- Sandboxed git init often fails chmod on .git/config.lock — prefer the real project git root for tests instead of git init in temp dirs.
- git apply --3way stages files; land path prefers plain apply then 3way+unstage so parent index stays clean.
- git() in worktree.ts must not trimStart porcelain: unstaged-only is " M path". trim() made slice(3) drop first char (src→rc) and hide untracked. tests/__wt_land__/ is gitignored — worktree-land fixtures live under src/agent/__wt_land_*.
- parsePorcelainPath / unquotePorcelainPath are public. git() uses trimEnd only — never trimStart porcelain. Unit test: " M src/agent/worktree.ts" → src/agent/worktree.ts.
- git apply --3way stages files; land path prefers plain apply then 3way+unstage so parent index stays clean. Unstage must use git() (trimEnd only) + parsePorcelainPath — never execFileSync().trim() on porcelain.
- Never land src/agent/worktree.ts or AGENTS.md in worktree-land tests — a failed /undo restore deletes the file. Use disposable src/agent/__wt_land_* fixtures + journalLandedPreimages unit path.

## convention

- Preferred checks: npm run typecheck · npm test · npm run check · npm run smoke · npm run ci (cheapest first).
- isolation=worktree auto-lands into parent (FORGE_SUBAGENT_LAND=auto|keep|discard); kept on conflict. FORGE_SUBAGENT_KEEP_WORKTREE=1 forces keep.

## fact

- Cross-session memory: memory_write scope=project → ~/.forge/project-memory + .forge/MEMORY.md; /memory project to list/add/clear.
- ULW arm auto-checkpoints dirty trees via git stash create (FORGE_ULW_CHECKPOINT=0 off). Restore: /checkpoint restore.
