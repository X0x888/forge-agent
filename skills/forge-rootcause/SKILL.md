---
name: forge-rootcause
description: >-
  Systematic debugging before patches. Use on any bug, test failure, build break,
  or unexpected behavior — especially after a failed fix or under time pressure.
---

# Forge Rootcause

```
NO FIX WITHOUT ROOT CAUSE
```

Symptom patches are failure. Thrashing is slower than investigation.

## Phase 1 — Investigate

1. **Read the full error** — stack, codes, paths; do not skim  
2. **Reproduce** — exact steps; if flaky, gather data, don't guess  
3. **Recent changes** — diff, deps, config, env  
4. **Multi-layer systems** — log/probe at each boundary until the failing layer is known  
5. **Trace backward** — where did the bad value originate? Fix at source  

## Phase 2 — Pattern

- Find a **working** similar path in the same repo  
- Diff working vs broken; list differences without dismissing "small" ones  
- Read reference implementations completely when following a pattern  

## Phase 3 — Hypothesis

- One hypothesis: "X because Y"  
- Smallest experiment to test it  
- If wrong: new hypothesis — do not stack fixes  

## Phase 4 — Fix

1. Prefer a failing test (`forge-redgreen`)  
2. Single root-cause fix  
3. Verify the original symptom + nearby suite  
4. `forge-prove` before "fixed"  

### Circuit breaker

If **≥3** distinct fix attempts fail: stop. Question architecture/coupling.
Discuss with the human before attempt #4.

## Red flags — return to Phase 1

- "Quick fix now, investigate later"  
- Changing multiple things at once  
- "It's probably X" without evidence  
- Each fix reveals a new unrelated breakage  

## Output when reporting

State: what failed, root cause, evidence, fix, how verified.
No "should be fine" without a command output.
