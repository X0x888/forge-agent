# Ultrawork (ULW) relentless cycle

When a prompt starts with **`/ulw`** (or `forge --ulw` / `forge run --ulw`), Forge arms a **god-mode cycle driver**: deep thought + hard execution on whatever the hard work is — any domain, not just tests or housekeeping. Soft prompts like `improve the code` (or bare `/ulw`) authorize the agent to **invent the work** and ship it.

**Wave 1 is PLAN** — the same spine as `/plan` / `/build`, not a sibling. Writes and **general-purpose** spawn are hard-denied (even under yolo) until a written plan exists (`Reading:` / `memory_write` / `exit_plan_mode`). Explore/plan subagents and web/GitHub research are allowed. The driver then `/build`s itself (no confirm). User `/build` skips remaining research. User `/plan` mid-run is a human pause (does not auto-flip). Later waves are BUILD **until the reading is stale** — same-surface hold, named-ship exhaust, and `enter_plan_mode` re-arm PLAN (research → new `Reading:` → ship). Vague wishes use the product loop: what would better mean for THIS product → research → plan directions → one ship → review → commit → re-plan if stale.

## User control: cycle flag

| Value | Meaning |
|-------|---------|
| **`cycle=1`** | CONTINUE — after each wave, Stop is blocked and the agent must research → implement → serendipity → review → next wave |
| **`cycle=0` / `/cycle 0`** | Finish the open wave, ship **one more**, LAST-reflect at wave N+1, then **sit down**. ULW stays ON — type to continue. `/done` or `/ulw-off` ends. Not an abort. |

## Optional: max_waves

| Value | Meaning |
|-------|---------|
| **unset / off** (default) | Unlimited **duration** while `cycle=1` — not a mill budget. Sibling factories still hold. |
| **`N` (positive int)** | When the wave counter hits **N**, harness auto-flips to LAST (finish + attest `**Cycle complete.**`). Mid-loop edit bursts do **not** increment the wave. **Idle loop epochs never increment `w`** (capped or unlimited) — the counter is Stop-boundary / declared-ship work units, not ~20 tool rounds. Idle still updates open-wave facts (edits/proof) in place. |

```text
/ulw improve the code     # arms ULW + cycle=1 (default, unlimited waves)
/max-waves 3              # cap at 3 waves (live; works mid-run)
/max-waves off            # clear cap (unlimited again)
/max-waves status         # show cap + cycle/wave
/cycle 0                  # finish this wave + one more, LAST-reflect, sit down (ULW stays on)
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

**Every `/ulw` starts in PLAN** (not only evaluate-class). Writes/spawn/mutating bash are hard-denied even under yolo until a written plan exists. Later waves skip the scout (`w≥1` or a plan already on disk). `/plan` and `/build` are the same keys: `/plan` pauses into research; `/build` implements now.

**Evaluate-class mandates** ("comprehensively evaluate… then improve…"): a **verb order**, not a backlog. The Wave 1 plan *is* the evaluation reading — not "advice-only". Named ships are parsed from that reading. TodoNudge does not poke evaluate-class boards.

**Broad checklists** (4+ bullets / multi-section): the harness still requires a **todo backlog** (`todo_write` ≥2) before Wave 1 free-invents.

**`max_waves=N` is a budget the user asked to spend.** Wave 1 writes the plan and ships the first item; waves 2..N ship the next highest-leverage items on different surfaces. Do not invent leftover chrome — do ship the next real item. `**Cycle complete.**` under `cycle=1` does **not** release. Cap auto-flips LAST when the wave counter hits N; then attest (that **is** a kill). `/cycle 0` at wave N sets the cap to **N+1** (finish this wave, ship one more, LAST-reflect, sit down — ULW stays on). `/done` / user cap / safety-valve LAST wraps the open wave only and releases. `/ulw-off` aborts.

### Smart + hard (not thrash)

ULW is not “burn tokens until something ships.” Doctrine:

- Optimize **impact × confidence / cost**
- Insight before volume; cheapest proof that can fail
- **Philosophy, not a cage** — freestyle when freestyle is better; harness rails (Stop / proof / todos) stay

### Proactive subagents

Spawn `explore` / `plan` / `general-purpose` **whenever** that improves quality or efficiency (parallel map, design space, isolated implement, `isolation=worktree`). Same-round explore/plan and worktree GP overlap with `web_search` (cap 8; `isolation=none` GP is serial). Wave 1 PLAN omitted `subagent_type` is explore; explicit GP is denied with a Next to retry as explore. LAST still denies all spawn. Skip when one tool call is enough. Converge and ship in the parent.

| Multiplier | Use |
|------------|-----|
| Subagents | Parallel research, design, isolated slices |
| MCP | Docs / browser / resources when they pay off |
| LSP | Diagnostics after language-aware edits |
| Skills | Optional project playbooks (`.forge/skills`) — not required |

### Not busywork theater

Proof still matters. Low-leverage churn while harder work remains fails the quality bar.

## Bets (open mandates)

Soft prompts and improve-class asks with no deliverable (`improve the code`, `make this tool more useful`, "Improve the UI, UX, performance, reliability comprehensively", "be creative") are **open mandates**. Every other ULW mechanism is satisfiable by a proven hole-close, and the explore contract only produces holes (`pick:`) — 2,407 dogfood waves across 17 open-mandate runs stamped zero `new-module` ships. A **Bet** is the counterpart of a pick: one capability THIS product cannot do today that a demanding user would notice, named with the files it creates and its first provable slice.

```text
Reading: <the hard work, what you passed on, the ONE ship, the verify command>
Bet: <capability> — <path it lives in, e.g. src/export/csv.ts> — first slice: <what lands this wave + the command that proves it>
Bet: none — <why no capability is worth more than the open holes>      # decline once, with the why
```

| Mechanism | Behavior |
|-----------|----------|
| **Bet gate** | `/ulw` on an open mandate owes a `Bet:` (closer or `memory_write`). No blocking demand: the kickoff, the PLAN prompt, `forge-veteran` and every CONTINUE re-anchor ask for it (`⚠ Open mandate with no Bet on file`); the hold below is the structural backstop. Memory seeds the first bet (a `memory_write` Reading); once one is on file only the live closer can replace it. |
| **Bet slice = job move** | A declared ship whose production change lands on the bet's files or directory is `onBet` — the tree is the only slice test. A closer that merely names the bet's job (a "session ledger" hole-close on `src/session/ledger.ts` beside a "CSV export of the session ledger" bet) is off-bet work: a bet is only adopted with a path, so a term match could only ever credit ships that did not touch it. A slice counts as a job move, raises the bar, is **never** sibling mill, and **never counts toward the same-surface hold** — `src/plugins/host-1.ts` → `host-2.ts` → `host-3.ts` inside the bet's directory are slices, not a factory, and four slices in a row on `src/export/csv.ts` are the wave, not a same-surface grind. Test-only diffs and TTY/string-literal chrome are not slices. |
| **Bet hold** | Unlimited CONTINUE: the off-bet streak counts **credited job-moving** ships that touched no bet (named/pick/play or the reading's files — mill and chrome have their own holds), whether or not a bet is on file. 3 warn on the re-anchor; **6** hold ULW (`betHold`) until a slice lands, a new `Bet:` with a path is written, `Bet: none — why` declines, or `/cycle 0`. A restated bet does not reset the streak; replacing an unshipped bet is a swap and after **2** swaps only a slice (or decline / `/cycle 0`) releases. Consolidation closers do not count. `/cycle 0` and a `/cycle 1` continue clear the hold and the streak (the bet and its swap count stay), same as the same-surface hold. Capped runs never bet-hold (a cap is a budget). Hard mandates have no bet machinery. |
| **On the wire** | The open bet (slices shipped, ships since it moved) rides the job card — CONTINUE re-anchor, compact, `/cycle status` — and is remembered in decision memory as `Bet: …` so compaction cannot erase it. Explore children may answer `bet:` beside `pick:`; those are candidates the demand reprints. |

`Bet:` is a capability, not a hole. "No longer crashes on 401" is a pick; "one-command CSV export of the session ledger" is a bet. Holes stay welcome as smoke and `Serendipity:` — they are not the wave. Open *wishes* (`invent something`, `build what's missing`) are soft prompts; a build order with an object (`build a login page`, `design the onboarding flow`, `create a migration for the users table`) is a hard mandate and gets neither god-scope nor a Bet gate.

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

Stuck-wall: N consecutive Stop attempts with **no file edits and no working-tree diff movement** (default same as goal stuck threshold / `FORGE_ULW_STUCK_THRESHOLD`). Progress is measured two ways: `editCount` delta **or** a changed `gitDiffFingerprint` — so work done via bash heredocs/`sed -i` (which never touches edit-tool counters) cannot false-trigger a stuck release. Outside a git repo the fingerprint is unavailable and the classic editCount-only rule applies. **Unlimited named-ship exhaust is not stuck** — those Stops stay blocked until a new `Reading:` or `/cycle 0`. A stuck-wall or LAST **Cycle complete.** kill is visible on `run_end` / `--json` / the dim stop line (`stuckReleased` / `lastCycleReleased`). `/cycle 0` wrap sit-down is `lastCycleSatDown` (ULW stays on).

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
| **Bar anchoring** | Each CONTINUE re-anchor *names* the best **job-moving** wave so far (named/pick/play, or edits on the Wave-1 reading's files). A full-suite pass or any control-flow `net=new` is not a job move. Sibling new-modules, chrome, isolate-only, and factory mill do not raise the bar. |
| **Same-surface hold** | 3 consecutive declared ships on the same **tree surface** (same 1–3 production files + chrome/TTY kind; closer overlap and maze schemas are extra hints) → ULW holds until a different-class `Reading:`, explore/play-loop, or `/cycle 0`. Cap is a budget for **distinct surfaces**, not mill units — capped runs hold too. `/cycle 0` N+1 still finishes. Stuck-wall does not increment. An explore-map pick is never mill. A new noun is not a new surface. |
| **Tests-without-body** | Declared `Wave shipped` with `proof=✗` and only test / lockfile dirty (or an explicit red-green / “tests first, then the body” closer) does **not** increment `w`. Wire the production body, prove it, then close. Maze max20 wave 1 stamped a red test file and shoved the real ship into wave 2. |
| **Proof demand** | A wave with no verification triggers `⚠ … ran no verification — run its proof NOW`. Capped at 2 consecutive demands (a stated rationale is then accepted — some repos have no tests) |
| **Wave rules** | Every wave: smoke-check first (prior waves may have broken something), ONE objective, search-before-build (no re-implementing), 2-line plan (objective + the exact command that proves it) |
| **Consolidation cadence** | Every 4th wave is a CONSOLIDATION wave: no new scope — hostile cumulative `git diff` + the project's **full** check suite via `background:true` then `get_task_output` wait. Isolates (`node --test tests/foo.test.ts`, `python -m unittest …TestCase.test_*`) are proof=ran, not proof=✓. Skip/hang/targeted-only is proof=✗. Timeout the suite; do not skip it. Ledger Must-fix is filled; holes + no job-move re-arm PLAN. |
| **Thin-wave escalation** | 2+ consecutive waves with ≤1 edit, no tree movement, and no proof → re-anchor demands a substantially higher-impact wave. Churn waves (fingerprint `revisit`) count as thin regardless of edit-call count — edit→revert loops cannot dodge the bar |
| **Churn exclusion** | `revisit` waves are excluded from bestWave anchoring and marked `↺` in the ledger (`w3 +5e↺ ✗`) |
| **Diminishing-returns advisory** | 3+ thin waves → user-visible warning + `/cycle status` shows `⚠ Diminishing returns` — the user decides `/cycle 0`; the harness never quietly lowers the bar |
| **Evidence attestation** | `**Cycle complete.**` without ✅/❌ checklist or command results is bounced once with a proof demand, then released (never an infinite trap) |
| **Product quality** | User-facing product ships (build/evaluate an app or named surface, or a Wave-1 reading that names a product) must name the hard user job, finish one edge (empty/error/first-run) after wave 1, and keep at most one labeled `Serendipity:`. Preview catalogs are not a job. Re-checked every consolidation. `/cycle status` shows the bar. Infra, bugfix, and generic UI chrome never arm |
| **Adaptive effort** | Hard rounds (doom-loop / error-streak / missing proof / product-quality bounce / re-PLAN / consolidation) raise reasoning effort one notch for a turn (`FORGE_ADAPTIVE_EFFORT=0` disables) |

Anti-gaming that is **structural**: proof demand (must run a check), leftover-chrome LAST@4, named-ship exhaust, same-surface hold. Bar anchoring is prompt-only. The ledger is visible in `/cycle status` (`Recent waves: w1 +12e ✓ · w2 +1e↺ ✗`, plus the best-wave bar and `Same surface: hold` when armed).

## Token discipline (ULW rounds)

- Slim re-anchors: the cycle protocol lives once in the stable system prompt; per-wave messages carry the **job card** (Wave-1 reading, open named ships, last job-moving ship, last play/look) plus counts. Compact/prune keep that card — mill suffix does not replace Wave 1.
- Unlimited duration is not a mill budget. Three numbered `foo-n.js` / same-dir new-module siblings hold and demand explore/play + a new Reading, even with `max_waves` off. Stuck-wall does not release. User can still run 125 waves when each ship is a different-surface job move.
- Counter-only harness changes (wave/blocks/todo counts) no longer emit a full mid-conversation admission — the re-anchor already carries them
- Outbound is append-only until ~180k tokens so xAI can cache the prefix; the first clip freezes a sticky omit set (later rounds do not re-age). `FORGE_REQUEST_PRUNE=1` restores every-round slim — that kills cache. In-session stubbing is opt-in (`FORGE_TOOL_CLEAR=1`).
- Idle mid-loop epochs never increment `w` (capped or unlimited). `w` moves on Stop or a declared `Wave shipped` / `Ship landed`.
- After auto-commit the clean tree is a new fingerprint baseline — not a `revisit` of the arm-time clean state.
- Unlimited evaluate-class: when every named ship from the reading is done, Stop asks for a new `Reading:` or `/cycle 0` and **stays blocked** until a different-surface reading is adopted. Stuck-wall does not release that hold. A glanceable ✓ / leftover-chrome sibling list is refused. A declared ship with real edits still stamps `w`. A cap still spends remaining waves.
- **Same-surface hold**: 3 declared ships on the same tree surface (same 1–3 production files + chrome/TTY kind; closer overlap / leftover-sibling / maze schemas are extra hints) block ULW until a different-class reading or `/cycle 0`. Same-surface leftovers do not increment `w`. Consolidation closers do not increment or reset the streak. **Capped runs hold** — `max_waves` is a budget for distinct surfaces. A scheduled `/cycle 0` N+1 budget still finishes. `maybeAdoptNamedShips` refuses a one-ship mill reading after exhaust. A pick reading/ship is never mill, even if it quotes mill flavor. `bestWave` ignores factory-fingerprint, `millClass`, sibling new-modules, chrome, and changelog-only rows. A job-moving ship is the bar.
- **Tests-without-body stamp refuse**: `Wave shipped` on a red-only test file (or `forge-redgreen` / “tests first, then wiring”) does not move `w` and does not auto-commit. The later body + green check is the wave.
- **Explore-map contract**: when kickoff explores left `meta.exploreMaps` picks, 8 consecutive ships that do not touch a pick hold unlimited ULW and reprint the picks + Wave 1 reading. Match pick **bigrams** (`memory walk`, `online hearth`) and distinctive tokens (`topology`) — not generics (`same`, `copy`, `find`). On-contract ships reset the streak. Stuck-wall does not increment.
- **Picks are the named-ship list**: unlimited ULW seeds `namedShips` from explore-map picks when the model never writes a list. A pick completes on its job: claim tokens / mapped files + a job word, or two distinctive terms with at least one from a file claim — not pick-title flavor (`carving`+`thanks`) and never topic words (`online`, `joiner`, `toast`) or FIFO. A file-only explore essay is not a map (`pick:` required). When every seeded pick is done, exhaust holds for a different-class `Reading:` or `/cycle 0`. Caps still spend. Compact reprints open seeded picks.
- **Reasoned Stop is Stop**: thought + `finish_reason=stop` with no text/tools (or the 12-minute no-output reasoning wall) runs Stop. Empty-continue is only for 0-reasoning glitches. `FORGE_PROVIDER_REASONING_WALL_MS=0` disables the wall. Thought-only Stop re-anchors; it does not increment `w` or FIFO a named ship, and it does **not** count toward `FORGE_ULW_MAX_CONTINUES` (a 16h dogfood auto-LAST'd at continue-cap 200 from reasoning_wall pokes the user did not ask to stop). Consecutive thought-only Stops this turn cap at `FORGE_THOUGHT_ONLY_MAX` (default 8) and **end the turn only** — ULW stays CONTINUE; `/retry`. After 3 thought-only Stops **in the cycle**, PLAN re-arms and the next poke demands explore/play (not another mill grep) — still no auto-LAST. A repeating hidden closer (`reasoning_loop`) is the same Stop. Unlimited CONTINUE does not stuck-release those Stops (`/cycle 0` is the wrap). The **next** provider call after a thought-only Stop is `tool_choice=required` so it cannot stack another silent judge.
- **Isolate green is not wave proof**: `node --test tests/foo.test.ts`, `python -m unittest …TestCase.test_*`, helper-only `wN-*.mjs`, and closer-only `22/22` / `43/43 stay green` are proof=ran, not proof=✓. Proof=✓ requires the project's full suite (AGENTS.md / preferred checks). A cited full-suite `fail N>0` or hung suite keeps `proof=false`. Tests-without-body still refuses to increment `w`. LAST reflect fills Must-fix from the ledger; `Must-fix: none` is illegal when isolates never became a full-suite pass.
- **Mid-run explore**: mill or contract hold latches `exploreRequired`. Stop refuses adopt/stamp until one `spawn_subagent` explore child **completes with a parseable `pick:`**. A file list without a pick does not clear the hold. Then a pick Reading may adopt. Not a wall-clock quota and not armed on leftover-sibling token holds. Play-loop (Playwright / played-the-game) is a different class and can release a mill sibling.
- **Honest proof**: `ℹ fail N` on a grepped suite is red. Isolated `node --test tests/wN-*.mjs` is not wave proof. A new raw `readFileSync` in a pin-budget repo taints that wave’s proof.
- **Hold context**: class/contract hold omits recent mill tool-call ids from the suffix (into sticky when it exists; otherwise `holdOmitToolIds` — never invents a first clip) and admits Wave 1 + picks at the tail. Evaluate-class garnish after wave 3 bounces once with the Wave 1 pick.
- Leftover-chrome class (clip **or** glanceable ✓ / live › last-line / bang-shell / idle bg tail) auto-LAST at 4 **only on a user `/max-waves` cap**. Unlimited duration holds and demands a different surface — it does not kill the run. Consolidation closers do not reset that streak. Δ-closer verify is not chrome.
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
/cycle 0                  # finish this wave + one more, LAST-reflect, sit down (ULW stays on)
/max-waves 3              # set wave cap live
finish the auth tests first   # free-text interjection (queued)
```
