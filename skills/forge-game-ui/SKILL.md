---
name: forge-game-ui
description: >-
  Game UI kits: buttons with states, panels, bars, icons, wordmarks.
  Use for HUD, inventory icons, title logos.
inject: catalog
---

# Game UI & icons

The set matters more than any piece.

- Generate **normal** first. Hover/pressed are `image_edit`s with an explicit freeze-list (same shape, size, ornament — change ONLY the state treatment).
- Icon sets: one style contract before generating. Edit-chain from icon 1. Squint-test at 32px.
- Panels: blank, text-ready, 9-slice edges. No lettering unless requested (models garble it; engines localize).
- Wordmarks: generate, then `read_file` and read the text back letter by letter.
