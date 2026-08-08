---
name: forge-inspect
description: >-
  Findings-first code review of local changes, a branch, or a PR. Use for
  /review, review requests, pre-merge checks, or post-implementation quality gates.
---

# Forge Inspect

Review as a harsh but fair reviewer. **Findings first.** Do not edit unless asked to fix.

## Scope

| Mode | Source |
|------|--------|
| Local (default) | staged + unstaged + untracked (respect ignore) |
| Branch | merge-base with main/master → tip |
| PR | `gh pr diff` / review comments when `gh` available |

## Priority order

1. **Bugs / correctness** — wrong logic, races, resource leaks  
2. **Security** — injection, authz, secrets, unsafe defaults (`forge-armor`)  
3. **Regressions** — callers, finish-the-class siblings  
4. **Tests** — missing coverage for new behavior; weak asserts  
5. **Design** — only when it blocks maintainability  
6. **Nits** — last; never drown real issues  

## Method

1. Collect the diff (size-gate huge dumps; ask before multi-MB)  
2. Read surrounding code for call sites/types — diff alone lies  
3. Check AGENTS.md / project rules for stated policy  
4. Emit structured findings  

## Finding format

```markdown
### Issue N — Severity: bug|risk|suggestion|nit
- File: path:line
- Description: what is wrong
- Why it matters: …
- Suggestion: concrete fix
```

Lead with a 2–4 sentence overall assessment.

## Discipline

- No invented issues to look thorough  
- No style-only FAIL if the project has no such rule  
- Separate **blocking** vs **optional**  
- If clean: say clean with what you checked  

## After review

User wants fixes → implement carefully → `forge-prove`.  
Receiving human review → `forge-absorb`.
