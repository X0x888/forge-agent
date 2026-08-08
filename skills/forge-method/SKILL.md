---
name: forge-method
description: >-
  How to use Forge's built-in skills. Apply at session start for multi-step work,
  and whenever choosing which playbook to follow before coding, debugging, or claiming done.
inject: always
---

# Forge Method

You have a catalog of **forge-*** skills. They are methodology, not optional flavor.

## Rule

**Before non-trivial work, match the task to a skill and follow it.**
Read the skill file from the catalog path (`read_file`) when the body is not already inlined.
Do not invent a parallel process with the same name.

## Map task → skill

| Situation | Skill |
|-----------|--------|
| Ambiguous request / need a design | `forge-shape` |
| Spec ready, need implementation plan | `forge-blueprint` |
| Plan ready, execute task-by-task | `forge-march` |
| New logic / bug fix with tests | `forge-redgreen` |
| Unexpected failure / bug hunt | `forge-rootcause` |
| About to say "done" / "fixed" / "tests pass" | `forge-prove` |
| Review a diff, branch, or PR | `forge-inspect` |
| Self-verify the whole turn | `forge-assay` |
| Independent parallel investigations | `forge-swarm` |
| Isolate work on a branch/worktree | `forge-anvil` |
| Finish branch → PR / merge decision | `forge-ship` |
| Human left review comments | `forge-absorb` |
| Security-sensitive change | `forge-armor` |
| Author a new project skill | `forge-craft` |

## Forge harness (do not fight it)

- **Blocking Stop** — unfinished work, soft handoffs, and unproven claims may be blocked. Finish or prove.
- **`/goal`** — work until criteria; attest with evidence.
- **ULW** — own the outcome; prove waves; no fake progress.
- **Verification** — structural checks (`npm test`, project checks) beat prose.
- Prefer **project** skills over builtins when names clash.

## Operating defaults

1. **Evidence over claims** — run the command, read the output, then speak.
2. **Root cause over patches** — no shotgun fixes (`forge-rootcause`).
3. **Smallest correct change** — YAGNI; no drive-by refactors.
4. **Read before write** — AGENTS.md, siblings, callers.
5. **Announce the skill** — one line: "Using `forge-…`" so the human can steer.

Project/user skills under `.forge/skills` and `~/.forge/skills` override these on name clash.
