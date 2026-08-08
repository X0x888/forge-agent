---
name: forge-anvil
description: >-
  Isolate risky or parallel work in a git worktree/branch. Use before large
  refactors, experiments, or subagent edits that must not dirty the main checkout.
---

# Forge Anvil

Strike metal on the anvil — not on production HEAD.

## When

- Experimental or high-churn work  
- Parallel feature vs hotfixes on main  
- Subagent implementation that should stay isolated  
- User asks for a branch/worktree  

## Prefer Forge primitives

- `spawn_subagent({ isolation: "worktree" })` — detached worktree under `~/.forge/worktrees/`  
- Keep with `FORGE_SUBAGENT_KEEP_WORKTREE=1` when the user will continue there  
- Manual: `git worktree add` / feature branch when the user wants a durable branch  

## Checklist before work

1. Clean or known dirty state on primary tree (warn if surprise dirt)  
2. Create branch/worktree from up-to-date base  
3. Install/setup if the project needs it; note baseline test status  
4. Do the work only in the isolated tree  

## During work

- Don't "quick fix" back on the primary checkout  
- Commits stay local unless user asks to push  
- Use `forge-redgreen` / `forge-prove` inside the anvil  

## After

- Verify in the worktree  
- Offer: merge locally, open PR (`forge-ship`), keep, or discard  
- Remove stale worktrees when discarded  

## Safety

- Never force-push shared branches  
- Never delete unmerged work without explicit user OK  
- Confirm before destructive cleanup  
