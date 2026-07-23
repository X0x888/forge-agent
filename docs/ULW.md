# Ultrawork (ULW) relentless cycle

When a prompt starts with **`/ulw`**, Forge arms a **cycle driver** that forces continuous quality work even for soft prompts like `improve the code`.

## User control: cycle flag

| Value | Meaning |
|-------|---------|
| **`cycle=1`** | CONTINUE — after each wave, Stop is blocked and the agent must research → implement → serendipity → review → next wave |
| **`cycle=0`** | LAST — finish the **current** wave only, independently review, attest `**Cycle complete.**`, then Stop is allowed |

```text
/ulw improve the code     # arms ULW + cycle=1 (default)
/cycle 0                  # "good enough — finish this wave"
/cycle 1                  # resume relentless loops
/cycle status             # show flag + wave + mandate
/ulw-off                  # disarm immediately
```

CLI:

```bash
forge --ulw "improve the code"
forge run "polish the CLI" --ulw
```

## Soft prompts

`improve the code`, `fix`, `polish`, bare imperatives, etc. are detected and expanded into a **god-scope** mandate:

1. Inventory repo / tests / gaps  
2. Prioritized wave plan  
3. Ship waves  
4. Serendipity (bounded adjacent fixes)  
5. Independent review  
6. Repeat while `cycle=1`

The agent must **not** ask “what should I improve?”

## Stop behavior

```
attempt Stop
    │
    ├─ cycle=1 → always re-anchor next wave (unless stuck-wall)
    ├─ cycle=0 without **Cycle complete.** → re-anchor finish last wave
    └─ cycle=0 + **Cycle complete.** → release
```

Stuck-wall: N consecutive Stop attempts with **no file edits** (default same as goal stuck threshold / `FORGE_ULW_STUCK_THRESHOLD`).

## State

`~/.forge/sessions/<id>/ulw.json` — independent of the model’s opinion of “done”.
