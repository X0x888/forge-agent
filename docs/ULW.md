# Ultrawork (ULW) relentless cycle

When a prompt starts with **`/ulw`** (or `forge --ulw` / `forge run --ulw`), Forge arms a **god-mode cycle driver**: deep thought + hard execution on whatever the hard work is — any domain, not just tests or housekeeping. Soft prompts like `improve the code` (or bare `/ulw`) authorize the agent to **invent the work** and ship it.

## User control: cycle flag

| Value | Meaning |
|-------|---------|
| **`cycle=1`** | CONTINUE — after each wave, Stop is blocked and the agent must research → implement → serendipity → review → next wave |
| **`cycle=0`** | LAST — finish the **current** wave only, independently review, attest `**Cycle complete.**`, then Stop is allowed |

## Optional: max_waves

| Value | Meaning |
|-------|---------|
| **unset / off** (default) | Unlimited waves while `cycle=1` |
| **`N` (positive int)** | When the wave counter hits **N**, harness auto-flips to LAST (finish + attest `**Cycle complete.**`). Mid-loop edit bursts do **not** increment the wave. **When a cap is set, idle loop epochs also do not increment** — `max_waves` counts Stop-boundary work units, not ~20 tool rounds. Unlimited ULW still stamps idle epochs for the quality bar. |

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

## Soft prompts → god-mode ownership

`improve the code`, `fix`, `polish`, bare imperatives, empty mandate, **and** general product asks like "comprehensively evaluate this tool and then improve the ui" expand into **ULW god-mode**: the user does **not** need a tighter spec. Never ask "what should I improve?"

Hard mandates keep a fixed objective but the same **smart + hard** execution style.

**Broad / evaluate-class mandates** (checklists, "comprehensively evaluate… then improve…" — **length-independent**): the harness seeds a **todo backlog** from mandate *verbs* (`evaluate …` / `improve …`) and durable **decision memory** first. Wave 1 cannot close until a written **reading** exists (`Reading:` or `memory_write`). That reading is the first verb — not "advice-only". Free invent without a board is blocked at wave 0 until ≥2 todos exist.

**Small `max_waves`:** spend the budget on the mandate's verbs in order. `max_waves=2` means Wave 1 = written reading + pick one ship; Wave 2 = finish that ship, prove, attest. Catalog chrome is not a substitute for "evaluate".

### Smart + hard (not thrash)

ULW is not “burn tokens until something ships.” Doctrine:

- Optimize **impact × confidence / cost**
- Insight before volume; cheapest proof that can fail
- **Philosophy, not a cage** — freestyle when freestyle is better; harness rails (Stop / proof / todos) stay

### Proactive subagents

Spawn `explore` / `plan` / `general-purpose` **whenever** that improves quality or efficiency (parallel map, design space, isolated implement, `isolation=worktree`). Skip when one tool call is enough. Converge and ship in the parent.

| Multiplier | Use |
|------------|-----|
| Subagents | Parallel research, design, isolated slices |
| MCP | Docs / browser / resources when they pay off |
| LSP | Diagnostics after language-aware edits |
| Skills | Optional project playbooks (`.forge/skills`) — not required |

### Not busywork theater

Proof still matters. Low-leverage churn while harder work remains fails the quality bar.

## Stop behavior

```
attempt Stop
    │
    ├─ cycle=1 and wave will hit max_waves → auto LAST re-anchor
    ├─ cycle=1 → re-anchor next wave (unless stuck-wall)
    ├─ cycle=0 without **Cycle complete.** → re-anchor finish last wave
    ├─ cycle=0 + **Cycle complete.** without evidence → bounce once, demand proof
    └─ cycle=0 + **Cycle complete.** + evidence → release
                                              └─ local git commit of the wave (never push)
                                                 FORGE_ULW_AUTO_COMMIT=0 off
```

Stuck-wall: N consecutive Stop attempts with **no file edits and no working-tree diff movement** (default same as goal stuck threshold / `FORGE_ULW_STUCK_THRESHOLD`). Progress is measured two ways: `editCount` delta **or** a changed `gitDiffFingerprint` — so work done via bash heredocs/`sed -i` (which never touches edit-tool counters) cannot false-trigger a stuck release. Outside a git repo the fingerprint is unavailable and the classic editCount-only rule applies.

`max_waves` is independent of the cycle flag: you can still `/cycle 0` early, or raise `/max-waves` / clear it mid-run.

## Quality bar (wave ledger)

Every wave boundary records **facts** in `ulw.json` — never invented scores:

- `editDelta` — file edits made during the wave
- `netDiff` — working-tree diff movement at the boundary: `new` (unseen state = real progress), `revisit` (a previously seen fingerprint = edit→revert churn), `none` (unchanged); absent outside git
- `proof` — whether verification **actually ran** (a foreground bash command matching tests/typecheck/lint/build executed during the wave; background spawns — `background`/`run_in_background` in any truthy form — never count, no exit code is observed) or was cited with a result
- `summary` — one-line clip of the wave's closing message

Mechanisms built on the ledger:

| Mechanism | Behavior |
|-----------|----------|
| **Bar anchoring** | Each CONTINUE re-anchor names the best wave so far (proven waves first, then largest edit delta) and requires matching or beating it — no filler waves (renames, comment churn, edit/revert loops) |
| **Proof demand** | A wave with no verification triggers `⚠ … ran no verification — run its proof NOW`. Capped at 2 consecutive demands (a stated rationale is then accepted — some repos have no tests) |
| **Wave rules** | Every wave: smoke-check first (prior waves may have broken something), ONE objective, search-before-build (no re-implementing), 2-line plan (objective + the exact command that proves it) |
| **Consolidation cadence** | Every 4th wave is a CONSOLIDATION wave: no new scope — full check suite + hostile review of the cumulative `git diff` |
| **Thin-wave escalation** | 2+ consecutive waves with ≤1 edit, no tree movement, and no proof → re-anchor demands a substantially higher-impact wave. Churn waves (fingerprint `revisit`) count as thin regardless of edit-call count — edit→revert loops cannot dodge the bar |
| **Churn exclusion** | `revisit` waves are excluded from bestWave anchoring and marked `↺` in the ledger (`w3 +5e↺ ✗`) |
| **Diminishing-returns advisory** | 3+ thin waves → user-visible warning + `/cycle status` shows `⚠ Diminishing returns` — the user decides `/cycle 0`; the harness never quietly lowers the bar |
| **Evidence attestation** | `**Cycle complete.**` without ✅/❌ checklist or command results is bounced once with a proof demand, then released (never an infinite trap) |
| **Adaptive effort** | Hard rounds (doom-loop / error-streak / missing proof) raise reasoning effort one notch for a turn — escalate on failure, not by default (`FORGE_ADAPTIVE_EFFORT=0` disables) |

Anti-gaming is **structural, not prompt-based**: the only way to satisfy a proof demand is to actually run a check — which is the desired behavior. The ledger is visible in `/cycle status` (`Recent waves: w1 +5e ✓ · w2 +1e ✗`, plus the best-wave bar).

## Token discipline (ULW rounds)

- Slim re-anchors: the cycle protocol lives once in the stable system prompt; per-wave messages carry only counts, the bar, and wave-specific demands
- Counter-only harness changes (wave/blocks/todo counts) no longer emit a full mid-conversation admission — the re-anchor already carries them
- Outbound prune (`FORGE_REQUEST_PRUNE*`) slims old tool results/`tool_calls` on the wire without rewriting session.json. In-session stubbing is opt-in (`FORGE_TOOL_CLEAR=1`). Restore a spool with `read_file` on the Full output path — do not re-spawn a child to recover a report.
- Cheapest-proof guidance: affected tests per wave, full suite on consolidation waves

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
| **TodoNudge / TodoGate** | Soft reminder + Stop block while open todos remain under ULW; outside ULW soft-blocks once per prompt |
| **Handoff guard** | Blocks premature “let me know if…” / “shall I continue?” yields (finish doctrine) |
| **Proof-claim guard** | Blocks “tests pass” / “all green” without structural `verificationRan` (don't claim, prove) |
| **Spend cap** | `--max-cost` / `/budget` / `FORGE_MAX_COST_USD` releases cleanly (`hitCostCap`) so unattended ULW cannot runaway-spend |
| **Safety-valve → LAST** | `hitCostCap` / `hitMaxTurns` / `releasedOnContinueCap` under `cycle=1` auto-flip to `cycle=0` (LAST) via `maybeFlipUlwToLastOnSafetyValve` so resume is not stuck re-blocking |
| **setMaxWaves immediate LAST** | `/max-waves N` when `wave >= N` under CONTINUE flips to LAST immediately (no wait for next Stop) and clears soft TodoGate |
| **Wave ledger + quality bar** | Factual per-wave edits/proof in `ulw.json`; bar anchoring, proof demands, consolidation cadence, evidence attestation (see above) |
| **Counter-only admission suppression** | Wave/blocks/todo churn updates the admitted fingerprint without a redundant harness message |
| **Prompt profile** | ULW defaults to `autonomous` (keep-going); config `prompt_profile` overrides |
| **Fork mid-ULW** | `/fork` / `/fork-and-compact` copy `ulw.json` + `goal.json` so the branch keeps the driver |
| **File-aware undo** | `/undo` / `/retry` restore journaled disk mutations from the undone turns |

Live mid-run (no Ctrl+C):

```text
/cycle 0                  # harness control
/max-waves 3              # set wave cap live
finish the auth tests first   # free-text interjection (queued)
```
