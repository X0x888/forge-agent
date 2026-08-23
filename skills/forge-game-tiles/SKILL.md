---
name: forge-game-tiles
description: >-
  Seamless tileable textures, terrain transitions, autotiles, platforms.
  Use when generating tilesets or repeating ground.
inject: catalog
---

# Tilesets

A tile's job is invisibility in repetition.

- Prompt uniform stochastic texture, even lighting, "pattern continues off every edge". No distinctive motif (it will checkerboard).
- **Mandatory:** composite a real 2×2 with a small script and `read_file` it. Seam lines, repeating clumps, or tone checkerboarding = retry.
- Transition sets: one continuous painted image that happens to be sliceable — not sticker cells with gaps.
- Neutral top-down lighting can rotate one edge + one corner. Side-view / gravity cues cannot; paint those orientations.
