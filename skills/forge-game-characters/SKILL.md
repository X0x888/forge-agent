---
name: forge-game-characters
description: >-
  Same character across images: turnarounds, damage, palette, equipment.
  Use for character sheets and any same-subject multi-image set.
inject: catalog
---

# Character consistency

The product is the IDENTITY.

- One **base** `image_gen`. Every view/variant is `image_edit` from the base (or nearest neighbor): "Keep this exact character — same face, colors, proportions, outfit, scale, background — change only \<X\>."
- Before turnarounds, write a side-map (sleeved arm, staff hand) in **viewer-relative** words. Verify against the table.
- Held items are GRIPPED. Same hand across views (mirror on back).
- Keep style words in every edit prompt or it drifts toward photorealism.
- Damage states are states (worn, cracked), not action frames.
