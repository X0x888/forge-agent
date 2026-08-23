---
name: forge-game-assets
description: >-
  Engine-ready defaults for game art with Imagine: sprites, sheets, tiles, UI.
  Use whenever generating any game art — then also load forge-game-animation,
  forge-game-tiles, forge-game-characters, or forge-game-ui as needed.
inject: catalog
---

# Game asset core

The user asks for WHAT. Engine-ready HOW is your job.

| Asked for | Deliver without being told |
|---|---|
| Character / prop sprite | Isolated subject, flat single-color keyable background, clean silhouette, no baked shadow |
| Anything that moves | Frame sequence that loops (`forge-game-animation` — video-first) |
| Sprite sheet | Uniform cells, no divider lines, subject registered in the same place per cell |
| Ground / tiles | Seamless (verify with a real 2×2 composite), no landmark motifs |
| UI panels / buttons | 9-slice-safe, no text (games localize), state variants geometry-identical |
| Same character again | `image_edit` from the base, never a fresh `image_gen` |
| Icons | One style contract, uniform padding, legible at 32px |

Write files with exact names; if counts are yours, pick them and put a one-line manifest next to the files.

## Discipline

1. Private spec: stated properties + applicable defaults above.
2. Prompt in visual language (clock positions, pie wedges), not abstractions.
3. Blind describe, then pass/fail every item.
4. Retry once more concretely; then compose (parts + rotate/mirror) or flag.
5. Report unfixed defects. Load `forge-imagine` for tool use.
