---
name: forge-prove
description: >-
  Evidence before completion claims. Use before saying done/fixed/tests pass,
  before commit/PR, and whenever Stop or proof-claim-guard would care.
---

# Forge Prove

```
NO COMPLETION CLAIM WITHOUT FRESH VERIFICATION EVIDENCE
```

Forge's harness blocks empty success claims after edits. This skill is the doctrine behind that.

## Gate (every time)

Before any status that implies success:

1. **IDENTIFY** — which command proves the claim?  
2. **RUN** — full command, fresh, this turn  
3. **READ** — exit code + failures, not vibes  
4. **VERIFY** — does output actually confirm the claim?  
5. **THEN** — claim with evidence (command + result)  

Skip a step = you are guessing, not proving.

## What counts

| Claim | Evidence |
|-------|----------|
| Tests pass | Test runner output, 0 failures |
| Build OK | Build/typecheck exit 0 |
| Bug fixed | Original symptom re-checked |
| Requirement done | Checklist vs diff, not "tests green" alone |
| Lint clean | Linter output |

**Not enough:** prior run, "should pass", agent self-report, partial suite when full was required.

## Pair with project intel

Prefer detected project checks (from AGENTS / package scripts). Record structural verification so session trail / `/status` stay honest.

## Red flags

- "Should work now" / "Looks good" / bare "Done."  
- Satisfaction prose before a command  
- Commit/PR without verification  
- Trusting a subagent "success" without reading the diff  

## Minimal closing shape

```
Verified: <command> → <result>
Changed: <paths>
Remaining: <none or list>
```

If verification failed: say so, fix or narrow, do not claim done.
