---
name: forge-shape
description: >-
  Shape ambiguous work into a clear design before coding. Use when the request
  is vague, multi-option, architectural, or "build X" without a solid spec.
---

# Forge Shape

Turn fuzzy intent into a design the human can approve in chunks.

## When

- New feature without a spec
- Multiple plausible approaches
- Cross-cutting or irreversible choices
- User says design / architecture / think first / `/plan`

**Skip** for trivial one-file fixes with an obvious approach.

## Process

### 1. Purpose (1–3 questions max)

Ask only what blocks design. Prefer one focused question over interrogation.
Capture: goal, non-goals, constraints (time, deps, compat), success signal.

### 2. Explore alternatives

Sketch 2–3 approaches with trade-offs (complexity, risk, fit to existing code).
Recommend one with a one-line why.

### 3. Present design in sections

Short sections the human can actually read:

1. Goal & non-goals  
2. Approach  
3. Interfaces / data  
4. File touch list (paths)  
5. Risks & open questions  
6. Out of scope  

Do **not** dump a wall of text. Pause after major sections if choices remain open.

### 4. Lock decisions

Write agreed decisions down (or into a short design note if the user wants a file).
No coding until the approach is clear — unless the user explicitly says "just implement".

## Anti-patterns

- Jumping to code mid-shape  
- Fake consensus ("we'll figure it out later") as a plan  
- Over-designing for hypothetical scale  

## Hand-off

Approved design → `forge-blueprint` (implementation plan) → `forge-march` (execute).
For Forge session modes: `/plan` for read-only design, `/build` to implement.
