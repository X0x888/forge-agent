---
name: release-checklist
description: Use when cutting a forge release or packaging a version bump
---
# Release checklist

1. Ensure CHANGELOG Unreleased notes are complete and accurate.
2. Bump package.json + package-lock.json version together.
3. Move Unreleased notes under a dated `## x.y.z` header.
4. Update README version badge/string if present.
5. Run `npm run build && npm test && npm run smoke`.
6. Commit as `release: vX.Y.Z …` with a concise body.
7. Do not force-push; leave push to the human.
