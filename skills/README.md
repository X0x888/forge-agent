# Forge built-in skills

Ship-with-install playbooks loaded by `src/agent/project-skills.ts` as
`source: builtin`. Names are Forge-native (`forge-*`).

| Directory | Role |
|-----------|------|
| `forge-method` | How to use the pack (always inlined) |
| `forge-shape` | Design / brainstorm before code |
| `forge-blueprint` | Implementation plans |
| `forge-march` | Execute plans with gates |
| `forge-redgreen` | TDD |
| `forge-rootcause` | Systematic debugging |
| `forge-prove` | Evidence before completion claims |
| `forge-inspect` | Code review |
| `forge-assay` | Self-verification |
| `forge-swarm` | Parallel subagents |
| `forge-anvil` | Worktrees / isolation |
| `forge-ship` | Land the branch |
| `forge-armor` | Security review discipline |
| `forge-absorb` | Absorb review feedback |
| `forge-surface` | Distinctive, non-AI-slop UI direction |
| `forge-polish` | Visual craft QA / UI polish pass |
| `forge-veteran` | Vague-mandate product loop (better → research → plan → ship → re-plan) |
| `forge-imagine` | image_gen / image_edit / video |
| `forge-game-assets` | Engine-ready game art defaults |
| `forge-game-animation` | Video-first animation frames |
| `forge-game-characters` | Same-character multi-image sets |
| `forge-game-tiles` | Seamless tilesets |
| `forge-game-ui` | HUD / icons / panels |
| `forge-craft` | Write project skills |

**Priority:** project (`.forge/skills`, `.agents/skills`) > user (`~/.forge/skills`) > builtin.

**Prompt:** catalog of all skills + paths; full bodies for project/user and
`inject: always|body`. Builtins default to `catalog` (agent reads the file when
matching). Opt out: `FORGE_BUILTIN_SKILLS=0`.
