---
name: forge-game-animation
description: >-
  Video-first animation frames: walk/run, attacks, idles, FX. Animate a base
  with image_to_video, then harvest frames. Complements forge-game-assets.
inject: catalog
---

# Animation frames — video-first

The image model draws poses; the video model understands motion. Do not ask image_gen for mid-stride.

1. **Base** — `image_gen` the subject in a neutral pose, flat keyable background, game-appropriate view (`forge-game-assets` defaults).
2. **Animate** — `image_to_video` from that file: one motion, in place, camera locked ("the knight walks in place, side view", 6s).
3. **Harvest** — `ffmpeg -i images/clip.mp4 -vf fps=12 images/f%03d.png`
4. **Select** — frames that capture distinct phases **and** loop (last flows into first). Count is yours.
5. **Clean** — `image_edit` selected frames if background/palette drifted.
6. **Package** — zero-padded names and/or a sheet (uniform cells, no dividers). State intended fps.

Verify in order; narrate the motion; check last→first. Hedge = failed frame.
