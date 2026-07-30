# Ultrawork (ULW) relentless cycle

When a prompt starts with **`/ulw`**, Forge arms a **cycle driver** that forces continuous quality work even for soft prompts like `improve the code`.

## User control: cycle flag

| Value | Meaning |
|-------|---------|
| **`cycle=1`** | CONTINUE — after each wave, Stop is blocked and the agent must research → implement → serendipity → review → next wave |
| **`cycle=0`** | LAST — finish the **current** wave only, independently review, attest `**Cycle complete.**`, then Stop is allowed |

## Optional: max_waves

| Value | Meaning |
|-------|---------|
| **unset / off** (default) | Unlimited waves while `cycle=1` |
| **`N` (positive int)** | When the wave counter hits **N**, harness auto-flips to LAST (finish + attest `**Cycle complete.**`) |

```text
/ulw improve the code     # arms ULW + cycle=1 (default, unlimited waves)
/max-waves 3              # cap at 3 waves (live; works mid-run)
/max-waves off            # clear cap (unlimited again)
/max-waves status         # show cap + cycle/wave
/cycle 0                  # "good enough — finish this wave"
/cycle 1                  # resume relentless loops
/cycle status             # show flag + wave + mandate
/ulw-off                  # disarm immediately
```

CLI:

```bash
forge --ulw "improve the code"
forge --ulw --max-waves 5 "harden the CLI"
forge run "polish the CLI" --ulw --max-waves 3
# --max-waves N>0 implies ULW when --ulw omitted
forge run "ship it" --max-waves 2
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
    ├─ cycle=1 and wave will hit max_waves → auto LAST re-anchor
    ├─ cycle=1 → re-anchor next wave (unless stuck-wall)
    ├─ cycle=0 without **Cycle complete.** → re-anchor finish last wave
    └─ cycle=0 + **Cycle complete.** → release
```

Stuck-wall: N consecutive Stop attempts with **no file edits** (default same as goal stuck threshold / `FORGE_ULW_STUCK_THRESHOLD`).

`max_waves` is independent of the cycle flag: you can still `/cycle 0` early, or raise `/max-waves` / clear it mid-run.

## State

`~/.forge/sessions/<id>/ulw.json` — independent of the model’s opinion of “done”.

## Prompt engineering (runtime)

Forge ports several runtime PE patterns from Grok Build / OpenCode:

| Mechanism | Behavior |
|-----------|----------|
| **Soft → god-scope** | Weak prompts expand at arm time (`expandUlwMandate`) |
| **Baseline system** | Stable protocol (cache-friendly); no live wave counters in system |
| **Harness admission** | `[Forge harness — mid-conversation update]` when cycle/wave/goal/todos change |
| **Free-text interjection** | Mid-run non-slash text: `The user sent a message while you were working:` + `<user_query>` |
| **Structured compact** | `/compact` and auto-compact preserve mandate, goal, todos, user messages |
| **TodoNudge / TodoGate** | Soft reminder + Stop block while open todos remain under ULW |
| **Prompt profile** | ULW defaults to `autonomous` (keep-going); config `prompt_profile` overrides |
| **Fork mid-ULW** | `/fork` / `/fork-and-compact` copy `ulw.json` + `goal.json` so the branch keeps the driver |
| **File-aware undo** | `/undo` / `/retry` restore journaled disk mutations from the undone turns |

Live mid-run (no Ctrl+C):

```text
/cycle 0                  # harness control
/max-waves 3              # set wave cap live
finish the auth tests first   # free-text interjection (queued)
```
