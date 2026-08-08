---
name: forge-swarm
description: >-
  Dispatch parallel subagents for independent work streams. Use when tasks do
  not share mutable state and fan-out beats serial exploration.
---

# Forge Swarm

Parallelism for **independent** slices. Shared mutable edits in parallel = merge pain.

## Good fan-out

- Research N libraries / APIs  
- Explore disconnected areas of a monorepo  
- Parallel reviews (security vs tests vs general)  
- Read-only recon while you plan  

## Bad fan-out

- Two agents editing the same files  
- Unknown shared state / flaky integration  
- Tiny tasks where spawn overhead dominates  

## Pattern

1. Split into independent briefs with explicit **non-overlap** (paths, scope)  
2. `spawn_subagent` with clear deliverable format  
   - `explore` / `plan` for read-only  
   - `general-purpose` for bounded edits (prefer `isolation: "worktree"`)  
3. Wait / collect results  
4. **You** merge: resolve conflicts, verify, single coherent outcome  

## Brief template

```
Goal: …
In scope: …
Out of scope: …
Read first: …
Deliverable: (file path or structured sections)
Do not: edit X / push / …
```

## Discipline

- Prefix descriptions with role tags when useful: `[explore]`, `[reviewer]`  
- Cap concurrency to what you can review  
- Never trust subagent "done" without reading artifacts/diff  
- Fold token/cost awareness under session budget  

## After swarm

Integrate → `forge-prove` → optional `forge-inspect`.
