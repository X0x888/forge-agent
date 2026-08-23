---
name: forge-imagine
description: >-
  How to use Forge image_gen, image_edit, image_to_video, and reference_to_video.
  Load whenever generating or editing an image or animating a still.
inject: catalog
---

# Imagine

Tools: `image_gen` · `image_edit` · `image_to_video` · `reference_to_video`.

Files land under `images/` and come back as `[[image:path]]`. `read_file` on png/jpg/webp attaches vision next turn. **Look at the result** before shipping it into the product.

## When to generate vs code

Image models garble exact text, numbers, and diagrams. Charts, labeled UI copy, and comic grids: **build in HTML/CSS or canvas**. Photos, illustrations, sprites, mood: Imagine.

## Prompt

2–5 sentences. Subject → action → setting → style → lighting. Positive phrasing. No keyword soup.

- New subject, no source: `image_gen`
- Change / restyle / keep likeness: `image_edit` from the file
- Recurring character: one base `image_gen`, every reappearance `image_edit` from that base
- Motion / walk cycle: still → `image_to_video` → `ffmpeg -i clip.mp4 -vf fps=12 images/f%03d.png` (see `forge-game-animation`)

## Verify

Describe the image **before** re-reading the spec. Every stated property is pass/fail. Hedge = fail. Retry once with a more concrete prompt; then compose in code (PIL / canvas) or keep the best and flag the defect.

Moderation block: stop. Do not paraphrase to evade.

`FORGE_IMAGE_GEN=0` / `FORGE_VIDEO_GEN=0` disables. Needs xAI credentials (`forge login` or `XAI_API_KEY`).
