<!-- proofread 2026-09-07T13:48Z · oh-my-claude -->

@AGENTS.md

Claude Code loads this file and never reads `AGENTS.md` on its own; the import above is how it reaches the project map. Forge (the product this repo builds) loads `AGENTS.md` natively, so the rules stay there and this file stays two lines.
