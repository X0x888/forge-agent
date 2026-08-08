---
name: forge-ship
description: >-
  Finish a development branch: verify, summarize, and choose merge/PR/keep/discard.
  Use when tasks are complete and the user is ready to land work.
---

# Forge Ship

Landing checklist — not a surprise push.

## Pre-flight

1. `forge-prove` — tests/build that the project cares about  
2. Diff vs base — intended changes only  
3. No secrets in diff; lockfiles intentional  
4. CHANGELOG / version only if the project expects it  

## Present options (do not assume)

1. **PR** — push branch (if allowed) + open PR with good summary  
2. **Local merge** — into base branch when user wants  
3. **Keep branch** — leave as-is  
4. **Discard** — only with explicit OK; prefer safe delete  

## PR body shape

```markdown
## Summary
- …

## Test plan
- [ ] <commands run + results>

## Notes / risks
- …
```

## Rules

- **Never push** unless the user asked (or a skill/project rule explicitly allows)  
- **Never force-push** to shared mains  
- Clean worktrees after discard (`forge-anvil`)  
- If verification fails: stop shipping; fix first  

## After ship

Point to PR URL or merge commit; list follow-ups honestly.
