---
name: forge-redgreen
description: >-
  Test-driven implementation: fail → pass → refactor. Use for new logic, bug
  fixes that need regression tests, and any change where behavior must be locked.
---

# Forge Redgreen

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

(Unless the user explicitly forbids tests, or the change is pure docs/config with no behavior.)

## Cycle

### RED

1. Write the **smallest** test that expresses desired behavior  
2. Run it — **must fail** for the right reason  
3. If it passes: test is wrong or behavior already exists — fix the test  

### GREEN

1. Write the **minimal** code to pass  
2. No gold-plating, no extra features  
3. Run tests — pass  

### REFACTOR

1. Clean structure only while green  
2. Re-run tests after each meaningful refactor  

## Bug fixes

1. Reproduce with a failing test (or minimal script)  
2. Confirm red  
3. Fix root cause (`forge-rootcause` if unclear)  
4. Confirm green  
5. Prefer keeping the regression test  

## Anti-patterns

| Bad | Good |
|-----|------|
| Code first, tests later | Test first |
| Test only happy path | Edge + error paths that matter |
| Assert "doesn't throw" only | Assert outcomes |
| Mock everything | Mock at real boundaries |
| Circular tests (mirroring impl) | Behavior from the outside |

## Project commands

Use project-intel preferred checks (`npm test`, `pytest`, etc.). Prefer the
narrowest command that covers the change; run broader suite before claiming done
(`forge-prove`).

## Announce

"Using `forge-redgreen` — RED for \<behavior\>."
