---
description: Hostile review of the working tree / recent diff
---
Run a hostile independent review of the current changes$ARGUMENTS.

Focus on:
1. Regressions and weakened tests
2. Leftover stubs / TODOs that ship
3. Security / secrets / destructive commands
4. Missing verification (exact commands)
5. Docs/CHANGELOG drift

Use git diff and tests. Do not expand scope into a rewrite. Report findings with severity and file:line when possible.
