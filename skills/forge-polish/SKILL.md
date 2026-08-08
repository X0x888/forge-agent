---
name: forge-polish
description: >-
  Visual craft QA and UI polish pass. Use after a UI exists — tighten spacing,
  type, states, motion, and anti-slop details until the interface feels finished
  and distinctive rather than “almost there.”
---

# Forge Polish

A polish pass is **craft**, not feature creep. Make what exists feel inevitable.

## When

- After `forge-surface` / first implementation of a page or component  
- “Make it look better / premium / finished”  
- Pre-ship UI review  
- Screenshots look flat, uneven, or AI-generic  

## Polish checklist (run top → bottom)

### 1. Rhythm & space

- Consistent spacing scale (4/8 or project tokens) — no random 13px / 27px  
- Section padding balances; adjacent sections don’t double-gap or collide  
- Alignment: shared edges, column rhythms, optical centering for display type  

### 2. Type

- Clear hierarchy (display → title → body → meta); no three “almost same” sizes  
- Line-length ~45–75ch for body; avoid full-bleed walls of text  
- Tracking/leading intentional on display; no clipped descenders or awkward wraps  
- Numbers/data tabular or deliberately styled — not default mono by accident  

### 3. Color & surfaces

- Palette still subject-rooted (see `forge-surface`); no orphan accent used once  
- Borders/shadows: one system (elevation or hairline), not mixed muddy depths  
- Dark/light: check contrast for text, icons, placeholders, disabled  

### 4. Components & states

Every interactive control needs: default · hover · active/focus · disabled · loading/error if applicable  
Empty, error, and success states designed — not browser defaults  
Icons consistent stroke/optical size; no mixed icon libraries without reason  

### 5. Motion

- One orchestration story (enter, focus, success) — cut redundant transitions  
- Durations short (150–300ms UI; longer only for narrative)  
- `prefers-reduced-motion: reduce` respected  

### 6. Anti-slop pass

Kill or replace:

- Gradient mesh heroes with no subject link  
- Identical feature cards (icon + title + 2 lines) × 6  
- “Unlock the power of…” marketing sludge  
- Decorative blur orbs that fight content  
- Over-rounded everything (or zero-radius everything) without intent  

### 7. Evidence

Prefer screenshot or live browser check when available (Playwright / devtools).  
List concrete before→after fixes (paths), not vibes.

## Out of scope

- New product features or IA rewrites (go to `forge-shape` / `forge-surface`)  
- Drive-by refactors of unrelated files  
- Claiming “looks great” without looking  

## Done bar

- Spacing and type feel intentional on mobile + desktop  
- Signature from `forge-surface` still readable (not buried in decoration)  
- States work; no obvious generic AI tell remaining  
- Brief note: what was tightened + residual risk  

Announce: `Using forge-polish.`
