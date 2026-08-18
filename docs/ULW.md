# Ultrawork (ULW) relentless cycle

When a prompt starts with **`/ulw`** (or `forge --ulw` / `forge run --ulw`), Forge arms a **god-mode cycle driver**: deep thought + hard execution on whatever the hard work is — any domain, not just tests or housekeeping. Soft prompts like `improve the code` (or bare `/ulw`) authorize the agent to **invent the work** and ship it.

## User control: cycle flag

| Value | Meaning |
|-------|---------|
| **`cycle=1`** | CONTINUE — after each wave, Stop is blocked and the agent must research → implement → serendipity → review → next wave |
| **`cycle=0` / `/cycle 0`** | Finish the open wave, ship **one more**, then LAST at wave N+1 and attest `**Cycle complete.**`. Not an abort (`/ulw-off` is). |

## Optional: max_waves

| Value | Meaning |
|-------|---------|
| **unset / off** (default) | Unlimited waves while `cycle=1` |
| **`N` (positive int)** | When the wave counter hits **N**, harness auto-flips to LAST (finish + attest `**Cycle complete.**`). Mid-loop edit bursts do **not** increment the wave. **Idle loop epochs never increment `w`** (capped or unlimited) — the counter is Stop-boundary / declared-ship work units, not ~20 tool rounds. Idle still updates open-wave facts (edits/proof) in place. |

```text
/ulw improve the code     # arms ULW + cycle=1 (default, unlimited waves)
/max-waves 3              # cap at 3 waves (live; works mid-run)
/max-waves off            # clear cap (unlimited again)
/max-waves status         # show cap + cycle/wave
/cycle 0                  # finish this wave + one more, then LAST
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

**Evaluate-class mandates** ("comprehensively evaluate… then improve…"): a **verb order**, not a backlog. Wave 1 cannot close until a written **reading** exists (`Reading:` or `memory_write`). That reading is the first verb — not "advice-only". Wave 1 starts in an **orient** phase (no spawn/edits) until the reading is written; later waves skip the scout (`w≥1` or a named next ship). Orient **hard-denies** writes/spawn/mutating bash even under yolo — hiding tools from the schema is not enough. TodoNudge does not poke evaluate-class boards.

**Broad checklists** (4+ bullets / multi-section): the harness still requires a **todo backlog** (`todo_write` ≥2) before Wave 1 free-invents.

**`max_waves=N` is a budget the user asked to spend.** Wave 1 writes the reading (evaluate-class) and ships the first item; waves 2..N ship the next highest-leverage items on different surfaces. Do not invent leftover chrome — do ship the next real item. `**Cycle complete.**` under `cycle=1` does **not** release. Cap auto-flips LAST when the wave counter hits N; then attest. `/cycle 0` at wave N sets the cap to **N+1** (finish this wave, ship one more) and stays CONTINUE until then. Cap / `/done` / safety-valve LAST wraps the open wave only. `/ulw-off` aborts.

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
    ├─ cycle=1 + **Cycle complete.** → stamp the unit, re-anchor next wave
    │    (does not release; remaining budget still owed)
    ├─ cycle=1 and wave will hit max_waves → auto LAST re-anchor
    ├─ cycle=1 → re-anchor next wave (unless stuck-wall)
    ├─ cycle=0 without **Cycle complete.** → re-anchor wrap (named plan if user LAST)
    ├─ cycle=0 + **Cycle complete.** + open named wrap → bounce once
    ├─ cycle=0 + **Cycle complete.** + user LAST + dirty/unverified wave → bounce once
    ├─ cycle=0 + **Cycle complete.** without evidence → bounce once, demand proof
    └─ cycle=0 + **Cycle complete.** + evidence → release
                                              └─ local git commit of the wave (never push)
                                                 FORGE_ULW_AUTO_COMMIT=0 off
```

Yield (“shall I continue?”) is still handoff-blocked. A red check is not evidence.

Stuck-wall: N consecutive Stop attempts with **no file edits and no working-tree diff movement** (default same as goal stuck threshold / `FORGE_ULW_STUCK_THRESHOLD`). Progress is measured two ways: `editCount` delta **or** a changed `gitDiffFingerprint` — so work done via bash heredocs/`sed -i` (which never touches edit-tool counters) cannot false-trigger a stuck release. Outside a git repo the fingerprint is unavailable and the classic editCount-only rule applies. **Unlimited named-ship exhaust is not stuck** — those Stops stay blocked until a new `Reading:` or `/cycle 0`. A stuck-wall or LAST **Cycle complete.** release is visible on `run_end` / `--json` / the dim stop line (`stuckReleased` / `lastCycleReleased`).

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
| **Bar anchoring** | Each CONTINUE re-anchor *names* the best wave so far (proven waves first, then largest edit delta). Prompt-only — Stop is not blocked if the next ship is smaller-leverage |
| **Same-surface hold** | 3 consecutive declared ships on the same theme (summary overlap, leftover-sibling language, **or** adjacent-share / factory / speak-once schema — rotating nouns on “beside you / far stays” **or** “first X speaks once”) → unlimited ULW holds until a different-**class** `Reading:` or `/cycle 0`. `Far stays` alone is not a schema. An explore-map pick is never mill. Stuck-wall does not increment. Capped and `/cycle 0` N+1 budgets are **not held** — they still **advise** at 2 siblings and strongly advise at 3 (pick a different surface or wrap remaining as LAST consolidation). A new noun is not a new surface. |
| **Tests-without-body** | Declared `Wave shipped` with `proof=✗` and only test / lockfile dirty (or an explicit red-green / “tests first, then the body” closer) does **not** increment `w`. Wire the production body, prove it, then close. Maze max20 wave 1 stamped a red test file and shoved the real ship into wave 2. |
| **Proof demand** | A wave with no verification triggers `⚠ … ran no verification — run its proof NOW`. Capped at 2 consecutive demands (a stated rationale is then accepted — some repos have no tests) |
| **Wave rules** | Every wave: smoke-check first (prior waves may have broken something), ONE objective, search-before-build (no re-implementing), 2-line plan (objective + the exact command that proves it) |
| **Consolidation cadence** | Every 4th wave is a CONSOLIDATION wave: no new scope — full check suite + hostile review of the cumulative `git diff` |
| **Thin-wave escalation** | 2+ consecutive waves with ≤1 edit, no tree movement, and no proof → re-anchor demands a substantially higher-impact wave. Churn waves (fingerprint `revisit`) count as thin regardless of edit-call count — edit→revert loops cannot dodge the bar |
| **Churn exclusion** | `revisit` waves are excluded from bestWave anchoring and marked `↺` in the ledger (`w3 +5e↺ ✗`) |
| **Diminishing-returns advisory** | 3+ thin waves → user-visible warning + `/cycle status` shows `⚠ Diminishing returns` — the user decides `/cycle 0`; the harness never quietly lowers the bar |
| **Evidence attestation** | `**Cycle complete.**` without ✅/❌ checklist or command results is bounced once with a proof demand, then released (never an infinite trap) |
| **Product quality** | User-facing product ships (build/evaluate an app or named surface) must name the hard user job, finish one edge (empty/error/first-run) after wave 1, and keep at most one labeled `Serendipity:`. Preview catalogs are not a job. Bounce once. `/cycle status` shows the bar. Infra, bugfix, and generic UI chrome never arm |
| **Adaptive effort** | Hard rounds (doom-loop / error-streak / missing proof / product-quality bounce) raise reasoning effort one notch for a turn — escalate on failure, not by default (`FORGE_ADAPTIVE_EFFORT=0` disables) |

Anti-gaming that is **structural**: proof demand (must run a check), leftover-chrome LAST@4, named-ship exhaust, same-surface hold. Bar anchoring is prompt-only. The ledger is visible in `/cycle status` (`Recent waves: w1 +12e ✓ · w2 +1e↺ ✗`, plus the best-wave bar and `Same surface: hold` when armed).

## Token discipline (ULW rounds)

- Slim re-anchors: the cycle protocol lives once in the stable system prompt; per-wave messages carry only counts, the bar, and wave-specific demands
- Counter-only harness changes (wave/blocks/todo counts) no longer emit a full mid-conversation admission — the re-anchor already carries them
- Outbound is append-only until ~180k tokens so xAI can cache the prefix; the first clip freezes a sticky omit set (later rounds do not re-age). `FORGE_REQUEST_PRUNE=1` restores every-round slim — that kills cache. In-session stubbing is opt-in (`FORGE_TOOL_CLEAR=1`).
- Idle mid-loop epochs never increment `w` (capped or unlimited). `w` moves on Stop or a declared `Wave shipped` / `Ship landed`.
- After auto-commit the clean tree is a new fingerprint baseline — not a `revisit` of the arm-time clean state.
- Unlimited evaluate-class: when every named ship from the reading is done, Stop asks for a new `Reading:` or `/cycle 0` and **stays blocked** until a different-surface reading is adopted. Stuck-wall does not release that hold. A glanceable ✓ / leftover-chrome sibling list is refused. A declared ship with real edits still stamps `w`. A cap still spends remaining waves.
- **Same-surface hold**: 3 declared ships on the same theme (token overlap after ritual-strip, leftover/fix-that-only language, adjacent-share / factory schema, or speak-once / first-X-noticed) block unlimited ULW until a different-class reading or `/cycle 0`. Same-surface leftovers do not increment `w`. Consolidation closers do not increment or reset the streak. Capped runs and a scheduled `/cycle 0` N+1 budget are not held — they still advise at 2 and strongly advise at 3 (`w` still increments). `maybeAdoptNamedShips` refuses a one-ship mill reading after exhaust. A pick reading/ship is never mill, even if it quotes `Far stays`. `bestWave` ignores factory-fingerprint, `millClass`, and changelog-only rows.
- **Tests-without-body stamp refuse**: `Wave shipped` on a red-only test file (or `forge-redgreen` / “tests first, then wiring”) does not move `w` and does not auto-commit. The later body + green check is the wave.
- **Explore-map contract**: when kickoff explores left `meta.exploreMaps` picks, 8 consecutive ships that do not touch a pick hold unlimited ULW and reprint the picks + Wave 1 reading. Match pick **bigrams** (`memory walk`, `online hearth`) and distinctive tokens (`topology`) — not generics (`same`, `copy`, `find`). On-contract ships reset the streak. Stuck-wall does not increment.
- **Picks are the named-ship list**: unlimited ULW seeds `namedShips` from explore-map picks when the model never writes a list. A pick completes on its job: claim tokens / mapped files + a job word, or two distinctive terms with at least one from a file claim — not pick-title flavor (`carving`+`thanks`) and never topic words (`online`, `joiner`, `toast`) or FIFO. A file-only explore essay is not a map (`pick:` required). When every seeded pick is done, exhaust holds for a different-class `Reading:` or `/cycle 0`. Caps still spend. Compact reprints open seeded picks.
- **Reasoned Stop is Stop**: thought + `finish_reason=stop` with no text/tools (or the 12-minute no-output reasoning wall) runs Stop. Empty-continue is only for 0-reasoning glitches. `FORGE_PROVIDER_REASONING_WALL_MS=0` disables the wall.
- **Isolate green is not wave proof**: helper-only `node --test tests/wN-*.mjs` and closer-only `22/22` / `43/43 stay green` are ran, not proof. A cited full-suite `fail N>0` keeps `proof=false`. Tests-without-body still refuses to increment `w`.
- **Mid-run explore**: mill or contract hold latches `exploreRequired`. Stop refuses adopt/stamp until one `spawn_subagent` explore child **completes with a parseable `pick:`**. A file list without a pick does not clear the hold. Then a pick Reading may adopt. Not a wall-clock quota and not armed on leftover-sibling token holds. Play-loop (Playwright / played-the-game) is a different class and can release a mill sibling.
- **Honest proof**: `ℹ fail N` on a grepped suite is red. Isolated `node --test tests/wN-*.mjs` is not wave proof. A new raw `readFileSync` in a pin-budget repo taints that wave’s proof.
- **Hold context**: class/contract hold omits recent mill tool-call ids from the suffix (into sticky when it exists; otherwise `holdOmitToolIds` — never invents a first clip) and admits Wave 1 + picks at the tail. Evaluate-class garnish after wave 3 bounces once with the Wave 1 pick.
- Leftover-chrome class (clip **or** glanceable ✓ / live › last-line / bang-shell / idle bg tail) auto-LAST at 4. Consolidation closers do not reset that streak. Δ-closer verify is not chrome.
- User-facing product ships have a quality bar (not a persona): name the hard user job, finish one edge (empty/error/first-run) after wave 1, at most one labeled `Serendipity:`. Arms on build/evaluate of an app or named surface — not generic UI chrome, infra, or bugfix. Preview catalogs are not a reading. Existing `Reading:` notes count as the job.
- Ship close grammar is one matcher: `Ship landed:` · `**Ship:**` · `Wave N ship:` · `Wave ship:` · `Wave shipped.` Auto-commit subjects use that ship, not an older wave-1 note.
- Dock/`/status` ctx follows last provider `prompt_tokens` when it is higher than the local estimate.
- Cheapest-proof guidance: affected tests per wave, full suite on consolidation waves. A failed full suite stamps `verify: npm test ✗` (not `none`). A red suite is a different surface, not leftover chrome.

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
| **Safety-valve → LAST** | `hitCostCap` / `hitMaxTurns` / `releasedOnContinueCap` under `cycle=1` auto-flip to `cycle=0` (LAST) via `maybeFlipUlwToLastOnSafetyValve` so resume is not stuck re-blocking. **Unlimited CONTINUE Stop-blocks do not trip** `FORGE_ULW_MAX_CONTINUES` (every wave is a Stop-block — log10 died at #201 without `/cycle 0`). Length / empty / content_filter use a **separate** fuse (200 Stop-blocks do not make the next truncated completion trip the cap). Capped ULW and LAST wrap still fuse Stop-blocks. |
| **setMaxWaves immediate LAST** | `/max-waves N` when `wave >= N` under CONTINUE flips to LAST immediately (no wait for next Stop) and clears soft TodoGate |
| **Wave ledger + quality bar** | Factual per-wave edits/proof in `ulw.json`; bar anchoring, proof demands, consolidation cadence, evidence attestation (see above) |
| **Counter-only admission suppression** | Wave/blocks/todo churn updates the admitted fingerprint without a redundant harness message |
| **Prompt profile** | ULW defaults to `autonomous` (keep-going); config `prompt_profile` overrides |
| **Fork mid-ULW** | `/fork` / `/fork-and-compact` copy `ulw.json` + `goal.json` so the branch keeps the driver |
| **File-aware undo** | `/undo` / `/retry` restore journaled disk mutations from the undone turns |

Live mid-run (no Ctrl+C):

```text
/cycle 0                  # finish this wave + one more, then LAST
/max-waves 3              # set wave cap live
finish the auth tests first   # free-text interjection (queued)
```
