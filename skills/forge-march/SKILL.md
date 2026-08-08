---
name: forge-march
description: >-
  Execute an approved plan task-by-task with verification gates. Use when a
  blueprint exists, or for multi-step work that must not skip tests between slices.
---

# Forge March

Execute the plan. Do not freestyle scope. Prove each task before the next.

## Modes

### A. Inline (default)

1. Pick next unchecked task  
2. Implement only that task  
3. Run that task's verification  
4. Mark done only with evidence  
5. Brief status → next task  

### B. Subagent per task (when isolation helps)

For each task:

1. `spawn_subagent` with the full task text + constraints + file paths  
2. On return: read the diff yourself  
3. Spec gate: matches task?  
4. Quality gate: bugs, missing tests, YAGNI violations?  
5. Fix or re-dispatch before advancing  

Use `isolation: "worktree"` when the task should not touch the parent tree
(see `forge-anvil`). Prefer `explore`/`plan` types for read-only recon.

## Rules

- **One task at a time** — no bundling "while I'm here"  
- **TDD when the plan says so** — follow `forge-redgreen`  
- **Stop on red** — do not pile commits on failing verification  
- **Scope lock** — if work expands, note it; don't silently widen  
- **Harness** — under `/goal` or ULW, keep criteria/wave proof honest  

## Checkpoints

After each task (or small batch if user asked for batching):

- What changed (paths)  
- Verification command + result  
- Residual risks  

## When stuck

After 2 failed attempts on the same task: switch to `forge-rootcause`,
narrow the task, or ask one blocking question. Do not thrash.

## Done

All tasks verified → `forge-prove` → optional `forge-inspect` / `forge-ship`.
