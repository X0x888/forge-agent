---
name: forge-veteran
description: >-
  Adaptive veteran loop for vague, soft, open mandates (improve this, make it
  better / more interesting / addictive / attractive) with near-zero steering.
  Use under /ulw (and its /improve alias) when the user did not specify
  the next ship.
inject: catalog
---

# Veteran product loop

The user is not a spec. **You** decide what better means for THIS product.

```
vague wish
   │
   ▼
what would “better” mean here, for THIS product?
what would a veteran actually chase?
   │
   ▼
research / explore  ← codebase, web_search, GitHub, skills, examples
   │
   ▼
plan                ← directions, not a random todo
   │
   ▼
implement one piece
review it
commit
   │
   ├── plan still good?  → next piece
   └── plan stale / we learned something? → enter_plan_mode (back to research)
```

Announce: `Using forge-veteran.`

## 1. Name better (do this in PLAN, before edits)

Write a `Reading:` that includes:

- **Product** — what a demanding user of this repo actually uses it for
- **Better** — 2–4 directions a veteran would chase (not a chrome catalog)
- **Passed on** — siblings you will not ship this wave, with a one-line why
- **ONE ship** — file paths + the command that can fail
- **Feel vs proof** — if this is a game or UI, name the play/look check (Playwright + `read_file` the png)

A leftover list of HUD chips is not a reading. A job a player/user notices is.

## 2. Research like a veteran of this domain

Match the product, then load the matching skill:

| Product | Chase | Skills |
|---------|--------|--------|
| Game | First-hour verb, juice, look, plant content on floor 1 | `forge-imagine`, `forge-game-assets`, `forge-game-animation` |
| Web / UI | Distinctive look, empty/error/first-run | `forge-surface`, `forge-polish` |
| CLI / TUI | Sit-down keys, verdict-first cards | `forge-shape` then ship |
| Library / harness | Proof, no mill, kernel not file N+1 | `forge-prove`, `forge-rootcause` |

Then actually look:

- Codebase: `spawn_subagent` `explore` (PLAN allows explore/plan only). Emit several explores **in the same round** as `web_search`.
- Web: `web_search` current practice; `site:github.com` for examples
- Screen: Playwright screenshot → `read_file` the png (vision)

Do not skip research because tests are red unless the red is the user's job.

## 3. Ship one piece

One objective. Prove it. Hostile-review the diff. Commit (ULW auto-commits waves).

If you generated art, `read_file` it and say what is still wrong.

## 4. Continue or re-PLAN

The plan is stale when: the last three ships were the same surface, you learned the architecture cannot hold another sibling, the reading's ships are done, or play showed a different hole.

Then **enter_plan_mode** (or write that the reading is stale). Do not mint `src/systems/foo-n.js` because the harness wants a wave.

Decline-with-WHY is a valid ship: "this is a gold wash of a verb that already exists."
