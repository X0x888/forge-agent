---
name: forge-assay
description: >-
  Self-verify session work with an independent checklist and commands. Use for
  check-work, verify, "did we finish?", or before declaring a multi-step task complete.
---

# Forge Assay

Assay = independent verification of what was actually done — not a victory lap.

## When

- User: check work / verify / self-review  
- End of a large task or ULW wave before attestation  
- After a long edit spree  

## Phase A — Trace

1. Restate user requirements as a **checklist** (all asks, not just the first)  
2. Reconstruct actions vs checklist — what was never attempted?  
3. Inspect **current state** (files, git, services) — do not trust chat memory  

## Phase B — Code (when code changed)

1. Collect full diff (unstaged + staged + recent commits if relevant)  
2. Evaluate: correctness, adequacy, excess, edge cases  
3. Run build + tests + typecheck per project intel  
4. Optional: spawn a read-only or general subagent as a second pair of eyes  

## Verdict

End with exactly one of:

```
VERDICT: PASS
```
or
```
VERDICT: FAIL
```

On FAIL: precise issues, evidence, and what to change (paths/lines).
On PASS: what was checked and the commands that passed.

## Rules

- Failing build/tests ⇒ FAIL  
- Missing a requested deliverable ⇒ FAIL  
- Style nits alone do not FAIL unless project rules require them  
- Temporary probe files are OK; clean up if they would confuse the user  
- After FAIL: fix and re-assay (cap reasonable loops; then report blockers)  

## Harness

Pairs with proof-claim-guard and silent edits-without-verify. Prefer real
project check commands so verification trails update.
