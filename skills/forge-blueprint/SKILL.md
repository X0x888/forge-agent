---
name: forge-blueprint
description: >-
  Write a decision-complete implementation plan before multi-step coding.
  Use after design is clear, or when the task is non-trivial, risky, or multi-file.
---

# Forge Blueprint

Produce a plan an enthusiastic junior with no repo memory could follow.
DRY · YAGNI · testable bites · exact paths.

## When

- Multi-file or multi-step work  
- After `forge-shape` / `/plan`  
- User asks for a plan, RFC steps, or "break it down"  
- Before ULW waves on large goals  

**Skip** for single obvious edits.

## Plan header (required)

```markdown
# <Feature> — Implementation Plan

**Goal:** one sentence  
**Architecture:** 2–3 sentences  
**Stack / constraints:** versions, forbidden deps, style rules  

## Global constraints
- (copy exact limits from the user/spec)
```

## File map first

List create/modify/test paths and each file's responsibility **before** tasks.
Prefer small focused files; follow existing layout when the repo already has patterns.

## Task shape

Each task:

- Exact **Files** (create/modify/test paths)  
- **Interfaces** consumed/produced (names + types when known)  
- Checkbox steps: write failing test → see fail → minimal impl → see pass → (optional commit)  
- Verification command with **expected** outcome  

Right-size: a task is the smallest unit with its own test/review gate.
Fold pure scaffolding into the task that needs it.

## Forbidden plan content

- TBD / TODO / "add appropriate error handling"  
- "Write tests for the above" without real test sketch  
- "Similar to Task N" without repeating enough context  
- Steps with no command or no concrete code for code work  

## Self-review before hand-off

1. Every requirement maps to a task  
2. No placeholders  
3. Names/types consistent across tasks  

## Save & hand-off

If the user wants a file: `docs/forge-plans/YYYY-MM-DD-<slug>.md` (or their preferred path).
Offer:

1. **March** — execute with `forge-march` (task gates, optional subagents)  
2. **Inline** — same session, checkpoint after each task  

Announce: "Using `forge-blueprint`."
