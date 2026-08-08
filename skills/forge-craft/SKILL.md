---
name: forge-craft
description: >-
  Author a new Forge project skill pack (SKILL.md). Use when creating playbooks
  under .forge/skills or ~/.forge/skills for repeatable workflows.
---

# Forge Craft

Skills are compressed expertise. Write for a future agent under pressure.

## Location

| Scope | Path |
|-------|------|
| Project | `.forge/skills/<name>/SKILL.md` |
| User global | `~/.forge/skills/<name>/SKILL.md` |
| Shared OpenCode-style | `.agents/skills/<name>/SKILL.md` |

Name: `lowercase-kebab`, stable, verb-y (`deploy-staging`, not `stuff`).

## Frontmatter

```yaml
---
name: my-skill
description: >-
  When to use this skill in one or two sentences. Include trigger phrases.
inject: body   # body | catalog | always — default body for project/user
---
```

**description** is the trigger — put "use when…" language here; the catalog is matched on it.

## Body quality bar

1. **When / when not** — stop wrong activation  
2. **Steps** — numbered, observable  
3. **Commands** — real project commands, not placeholders  
4. **Outputs** — what "done" looks like  
5. **Failure modes** — what to do when X fails  
6. **Forge hooks** — mention `/goal`, verify, worktrees only if relevant  

## Size

- Prefer under ~200 lines; split if longer  
- No copy-paste of entire frameworks  
- Link to repo docs instead of duplicating  

## Test the skill

1. List it: `/skills`  
2. Dry-run: give the agent a task that should activate it  
3. Confirm it doesn't activate on unrelated tasks  
4. Trim ambiguity that caused drift  

## Do not

- Name-collide with builtins (`forge-*`) unless intentionally overriding  
- Embed secrets  
- Write skills that fight non-negotiables (blocking Stop, proof-claim)  
