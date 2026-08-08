---
name: forge-absorb
description: >-
  Respond to human or bot code review feedback productively. Use when addressing
  PR comments, review threads, or critique of your recent changes.
---

# Forge Absorb

Review feedback is data. Absorb it without ego or cargo-cult compliance.

## Process

1. **Inventory** every comment (resolved vs open)  
2. **Classify** each:  
   - correct bug → fix  
   - correct style per project rules → fix  
   - optional taste → fix if cheap, else reply why not  
   - wrong / harmful → push back with evidence  
   - needs product decision → ask user  
3. **Batch fixes** logically; don't drive-by unrelated files  
4. **Reply** on threads when a change isn't made (brief why)  
5. **Re-verify** (`forge-prove`) after addressing  

## Push-back template

```
Disagree with <change> because <technical reason + evidence>.
Alternative: <option>. Happy to take your call if product overrides.
```

## Anti-patterns

- Blindly applying every nit and wrecking consistency  
- Silent ignore of valid bugs  
- Relitigating settled project conventions  
- "Fixed" without running checks  

## Done

All threads addressed (code or reply) + verification green + short summary of what changed vs deferred.
