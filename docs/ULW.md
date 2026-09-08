# Ultrawork (ULW) — the plan-cycle driver

The [design audit](ULW-AUDIT.md) explains the improvement objective, the quality gates, and the remaining limits. Discovery weighs product-specific benefit and risk over its useful lifetime, including reliability, security, recovery, accessibility, performance, and maintainability. A cycle may resolve a consequential uncertainty without changing working code; unlimited duration does not require invented defects or edits.

`/ulw [mandate]` (or `forge --ulw`, `forge run --ulw`) arms a **plan-cycle** driver. The unit of work is a **cycle**, not a wave:

```
PLAN ──► EXECUTE ──► VERIFY ──► REVIEW ──► VERIFY ──► COMMIT ──► RELEASED
 ▲         │  ▲         │                     │                     ▲
 │         └──┘ (Stop)  └─ red ─► FIX ─┐      └─ red ─► FIX ─┐      │
 └──────────────── re-plan ◄───────────┴─────────────────────┴──────┘  (/cycle 0 · max_cycles · fulfilled)
```

- **PLAN** — a fresh-context **Planner** runs two turns on one kept session. Its scout exercises the product through a representative public interface, inspects relevant promises as `kept | broken | absent | unknown`, and compares credible improvements or consequential investigations with `leave it`. Discovery considers the whole product without requiring a candidate from every category. The plan turn then receives the record, user interjections, and spend, strikes completed work, and writes one coherent cycle.
- **EXECUTE** — the session model is the **executor**. The plan's items are its todo board. Every Stop is a wave boundary: open items → re-anchor; `Plan complete.` or an empty board → the cycle closes. As many waves as the plan needs.
- **VERIFY** — the **harness itself** runs a whole project check. A Planner's isolate is recorded as proof=ran and the stack's suite gates instead. New named failures are red relative to the command's eligible baseline; pre-existing failures are reported. Cycle 1 measures the user's tree. Later baseline refresh requires a committed prior cycle and a confirmed clean repository root. A red run without named failures remains red. Verification and review repairs share `fix_rounds` (default 3).
- **REVIEW** — on a tree that passes the gate, a fresh-context **Reviewer** first exercises the intended workflow or condition without the diff and writes `look.md`. It then reads the plan, cumulative cycle diff and prior record, revises in place, and writes `review.md`. It judges fulfillment, acceptance defects, architecture and evidenced benefit. An explicit `blocked` verdict or an unsuccessful, incomplete or unparseable review closes without a commit; the next Planner receives its findings. Repairable defects use `ship-with-revisions` with `Must-fix` and require same-cycle repair, as described below.
- **VERIFY again** — the check runs once more over the Reviewer's revisions; red invalidates review approval and goes back to the executor (same `fix_rounds` budget). After repair, the harness verifies, runs a fresh Reviewer, verifies again, and only then commits. A nominal shipping review with unresolved `Must-fix` or partial/missing items also enters this bounded repair sequence. Failed or incomplete role results cannot approve work, even if their text contains a shipping verdict. Prior reviews are retained as `review.before-fix.<round>.md`.
- **COMMIT** — one local commit per reviewed, green cycle (`ulw cycle N: <title>`; never pushed; `FORGE_ULW_AUTO_COMMIT=0` off). A later gate change may capture a fresh baseline only after a committed cycle with an independently confirmed clean repository root, including files outside a nested workspace. Otherwise the previous baseline remains and the changed command must pass; rejected or dirty work cannot become a new baseline. Cycle 1 still measures the user's initial tree, including existing edits.
- **Re-plan** — a fresh Planner reads the previous plans, reviews, the Reviewer's `Must-fix`, unfinished items and anything the user typed since the last plan. A **mandate** `Verdict: fulfilled` ends the run; `/cycle 0` or `max_cycles` ends it after the commit. On a **no-mandate** run the model does not get to stop itself: a `fulfilled` becomes deeper work (below), and a Planner that cannot produce a plan becomes a direct-execute cycle rather than a release.

## The run does not stop on the model's judgement

An unlimited `/ulw` with no mandate is meant to keep making the product better until the user stops it (`/cycle 0`, `/ulw-off`, `max_cycles`). Two ways the model used to escape that — and no longer can (`orchestrator.ts` `planNextCycle`):

- **The Planner could not produce a plan.** After one document retry, its findings become a **direct-execute cycle**. The executor selects an evidenced improvement or investigates a consequential uncertainty, instead of ending the run on a missing document.
- **The Planner declared a no-mandate product "done."** A no-mandate `fulfilled` continues: broken or absent promises prompt repair, and `unknown` promises prompt investigation before deciding whether repair is needed. Otherwise a **go-deeper** cycle investigates an untested core workflow or consequential risk through the appropriate app, CLI, library, or service interface. Finding no justified edit is a valid investigation result. An explicit mandate that is fulfilled still releases.

The only self-stops the harness honours are a mandate fulfilled, a Planner `blocked` (a secret / external service / decision only the user can settle, with an `Operator:` line), the user's controls, and the **no-progress wall**: when `directExecuteStreak` consecutive synthesized cycles land no commit (`FORGE_ULW_NO_PROGRESS_CAP`, default 3), the run releases `no-progress` — an honest floor, not an escape. Any committed cycle resets the streak, so a run that keeps shipping never trips it. This is non-negotiable 2 ("never an infinite trap *without progress*") read literally: no progress is the only floor, and declaring the product perfect is not the same as making progress.

**The waste that made the escape look reasonable is gone too.** A role that cannot edit (the Planner: `denyEdits`) no longer hears the "fix until green" or "run the check" nudges — the HashPet Planner ran the suite, went red, was told to "fix the root cause … until green," and burned ~45 of 60 turns chasing a failure it could not touch. The signal is the role's own tool set (`toolSetCanEdit`): no edit tool, no fix nudge. And the Planner's **plan turn is document-only** (`documentOnly`): the scouting is done on turn 1, so turn 2 emits the plan and cannot re-enter reading.

Whether the model notices a consequential gap remains a judgment. The role instructions require representative end-to-end use, including relevant failure and recovery conditions, and distinguish observed behavior from inference. Unobservable promises remain `unknown` in artifacts, state, status and reports; they are neither kept on faith nor presumed broken.

Nothing in the driver classifies prose. The Planner and Reviewer judge; the harness enforces the sequence and structural facts: no writes before a plan exists, no commit before a completed review and a green harness-run check, no Stop mid-cycle, what each role reads before what, every cycle leaves `scout.md`, `plan.md`, `look.md`, `review.md` and a commit (or a `blocked` review and no commit).

## Doctrine at the run level

The skills in `skills/forge-*` were written for a task and applied to a task. The 30-cycle HashPet run is what happens when nobody applies them to the cycle and the run: cycle 21's review named the root cause of nine renames ("three independent strings — same split Ate had; pre-existing, left alone") and filed it as a shape note, and eight more renames shipped. The roles now carry each doctrine at the unit it was missing from, and the harness enforces the part it can — sequence and presence:

| Doctrine | At the run level | Where |
|----------|------------------|-------|
| `forge-planner` exercise the real job | The scout sees the product before the run record; interfaces and conditions follow the project's domain | `roles.ts`, Planner brief builders |
| `forge-shape` alternatives with trade-offs | `Considered:` compares credible candidates and investigations; empty categories need no invented work | `plan.md` (required for `continue`) |
| `forge-veteran` "this is fine — leave it" | `leave it` is always in `Considered:`, with why it lost or won — the null hypothesis every cycle beats in writing | `plan.md` (required) |
| `forge-surface` every decision traceable to subject + audience + job; "would I make this for any similar page?" | `serves:` per item, in words; `Worth the cycle:` says why this is from *this* product | `plan.md` (required) |
| `forge-redgreen` meaningful proof | `red now:` names an observed gap or concrete regression risk; test-only protection demonstrates a plausible fault it catches | `plan.md` item contract |
| `forge-rootcause` investigate repeated defects | A recurring class prompts a search for a shared cause; evidence determines whether a shared correction is needed | Planner and Reviewer instructions |
| `forge-prove` run, read, then claim | The Reviewer's look turn comes before the diff; `Worth:` is judged from `Looked:` | `roles.ts`, `buildReviewerLookBrief`; `review.md` `Looked:` |
| `forge-assay` inspect current state | `Promises:` records `kept | broken | absent | unknown`; unknown requires evidence before repair | scout, state and project memory |
| `forge-swarm` parallel reads with different lenses | The Planner's explore children get lenses: first-minute user, month-three user, next year's maintainer, a competitor's PM | `forge-planner` §4 |
| `forge-absorb` push back with evidence | The executor's `Dispute:` line — a Reviewer revision it can show was wrong — reaches the next Planner | `forge-veteran`; `record.disputes` |
| `forge-planner` "the way a boss does" | The plan brief carries the run's spend; `Worth the cycle:` is the claim before the spend, the Reviewer's `Worth:` the finding after — side by side in the record, `/cycle status` and the report | `runSpend`, `cycleLine`, `cycleReportFacts` |
| `forge-planner` the user's words | The mandate is attention, not a spec and not a quality ceiling. The harness never rewrites it. `Direction:` is the Planner's sentence after using the product and knowing the category's bar (web_search or a shipped `forge-*` skill). A sloppy prompt does not license sloppy work; a specific request is still that request, done like a veteran. | `briefs.ts` `MANDATE_QUALITY_BAR`; `forge-planner`; `forge-veteran` |

Presence and shape are parsed; content is judged by the next role and by whoever opens `cycles/<n>/`. A `continue` plan missing `Considered:` (with `leave it`) or an item's `serves:` / `red now:` comes back to the Planner once with what was missing, on the kept session without re-scouting. A second failure becomes a synthesized work cycle, subject to the no-progress wall. `FORGE_ULW_TWO_TURN=0` runs each role on one brief; a runtime that cannot keep a session, or a resume that fails, falls back to the same single brief with the scout inlined.

## Three cases, one procedure

The mandate only changes where the direction comes from.

| Case | Prompt | What happens |
|------|--------|--------------|
| **a — clear goal** | `/ulw add --version with a test` | Cycle 1 plans and ships it. At re-plan the Planner writes `Verdict: fulfilled` and the run stops. |
| **b — direction** | `/ulw polish the first-run experience` | The direction frames every plan; the run cycles until fulfilled or `/cycle 0`. |
| **c — no prompt** | `/ulw` | The Planner derives the direction from the product: identity (README, `--help`, manifests, tests as spec) + category research + the tree's gaps. |

Invention and repair are both legitimate in every case; the tree decides which the cycle needs. There is no Bet contract and no mandate classifier. The user's words are passed through verbatim — they are **attention**, not a spec and not a quality ceiling. A laundry-list `/ulw make it more interesting, attractive, addictive, ship-ready` does not license a laundry-list cycle, and `/ulw add --version with a test` does not become a product rewrite. The Planner translates after using the product and knowing the category's bar (a shipped `forge-*` skill, or `web_search` if it does not already know). `Direction:` is that sentence. The Reviewer judges a demanding user of this product, not whether the diff matches the mandate's adjectives.

## Controls

```text
/ulw [mandate]         arm (bare /ulw = case c)
/cycle 0               finish this cycle (execute → verify → review → verify → commit), then stop
/cycle 1               keep re-planning after each commit
/cycle status          cycle, phase, plan items, verify, last review, cycle ledger
/replan                close the open cycle now (verify, review, verify, commit) and re-plan
/max-cycles N|off      stop after cycle N is committed (deprecated alias: /max-waves)
/plan                  human pause: the harness Planner stands down until /build
/build                 hand planning back to the harness
/done                  /goal done + /cycle 0
/ulw-off               disarm immediately
```

Free text while the executor works is queued as an interjection; the next Planner reads it under *What the user said since the last plan*.

CLI: `forge --ulw [--max-cycles N] "…"` · `forge run "…" --ulw --max-cycles 2 --json` (`--max-cycles N>0` implies `--ulw`). Headless JSON carries `ulwCycle`, `ulwPhase`, `ulwMaxCycles`, `ulwMandate`, `ulwCycles[]` (per cycle: items, review verdict, verify, commit), `ulwEndReason`, `verification`.

## Artifacts

Under `~/.forge/sessions/<id>/`:

- `ulw.json` (schema 2) — `cycle`, `phase`, `items[]` (each with `serves` and `redNow`), `verifyCommand`, `promises[]` (the product's own claims as last inspected: `text`, `kept | broken | absent | unknown`, `seen`), `cycles[]` (title, items done/total, waves, review verdict, verify result, commit sha, tokens per role, `considered[]`, `worthClaim`, `worth`, `reviewerLooked`, `scoutPath` / `lookPath`), `ledger[]` (one row per Stop: edit delta, tree movement, proof ran), `identity`, `direction`, `lastReview`. A schema-1 sidecar from the retired wave engine loads as `legacy` and disabled; `/ulw` re-arms.
- `cycles/<n>/scout.md` (the Planner's turn 1, written before it saw the record), `plan.md`, `look.md` (the Reviewer's turn 1, before the diff), `review.md`, `verify.baseline.log` (cycle 1: the untouched tree; a later cycle whose gate command changed: the tree as the last commit left it), `verify.pre-review.log` / `verify.post-review.log` (`.<round>` after a red round), `plan.failed.md` when the Planner never produced a parseable plan. The cycle record also keeps the Reviewer's `revisions`, the items it `disputed` (partial / missing against the executor's board), and the executor's `serendipity` and `disputes` lines.
- `decisions.json` gains a `Plan N: <title>` row per cycle; the product identity and its promises go to project memory (`Identity: …`, `Promise: … — kept|broken|absent`).

### scout.md contract (Planner, turn 1)

```text
# Cycle N scout
Identity: <one paragraph: who uses this product, for what job>
Looked: <what the Planner ran or opened as the product's user, and saw — or: could not run — <why>>
Promises:
- <what the product promises: README, --help, tests as spec, the identity> — kept | broken | absent | unknown — <where seen, or what remains unverified and why>
Considered:
- <evidenced candidate or consequential investigation> — <benefit, risk and cost>
- <another credible alternative, if any> — <trade-off>
- leave it — <why leaving this area unchanged may be better>
```

### plan.md contract (Planner, turn 2)

```text
# Cycle N plan — <title>
Verdict: continue | fulfilled — <why the explicit mandate is met; no-mandate runs continue investigating> | blocked — <what prevents progress without the user>
Identity: <reaffirmed, or an Operator: line>
Looked: <carried from the scout>
Considered:
- <the scout's candidates, struck or kept after the record; leave it always present, with why it lost or won>
Direction: <this cycle's intended benefit or consequential question, in your words after using the product — never a paraphrase of the mandate's adjectives>
Worth the cycle: <benefit to this product's user, operator or maintainer; why the evidence justifies the cost and risk over leave it>
Verify: `npm test` | none — <why>
Items:
1. <item title> — files: <path>, <path> — serves: <the job in Identity this serves> — red now: <observed defect, limitation, regression risk or evidence gap; or unchecked — why> — proof: <command or observable distinguishing improvement or resolving the question>
Out of scope:
- <passed on, and why>
Guidelines: ok | fix: <what the AGENTS.md-class file needs>
Operator: <secret / irreversible action / external blocker / identity change — else omit>
```

`Verify:` goes through the strict check-command harvest (`looksLikeCheckCommand`): prose is refused, `none — why` falls back to the stack table so a wrong "none" cannot switch the gate off. `Guidelines: fix: …` becomes the plan's first item. A `continue` plan with no items, without `Considered:` carrying a `leave it` entry, or with an item lacking `serves:` or `red now:` does not parse; the Planner is retried once with what was missing named (`explainPlanParseFailure`), then a synthesized work cycle continues from the available evidence, subject to the no-progress wall. `Looked:` is the Planner's own record of having used the product before judging it — read the cycles' `Looked:` lines in a row to see whether a run planned from the product or from `grep`; read `Considered:` in a row to see whether `leave it` was ever weighed. In single-brief mode the plan carries a `Promises:` section too, since there is no scout.

**What the Planner is handed** (`briefs.ts`). Turn 1: workspace, mandate, identity, the promises as last recorded (to re-inspect, never copy), the tree, the stack table, steps 1–6 and the scout contract — **none of the record**. Turn 2: its scout, then the record — a one-line-per-cycle ledger of what this run has shipped (title · direction · review verdict · worth claimed · worth found · commit), the last review's `Must-fix` and `Architecture` notes, its `Worth: no` if it gave one, unfinished items, the executor's `Serendipity:` lines (what it noticed inside the work and left alone, newest cycle first, harvested from its closers at every Stop — evidence to weigh, not orders) and `Dispute:` lines (a Reviewer revision it can show was wrong, with the evidence), what the user typed since the last plan, the run's commits, the spend so far, the guideline survey, steps 7–11 and the plan contract. **Not** the previous plan's body or its `Out of scope` list — a 30-cycle HashPet run continued the last plan's theme and its out-of-scope backlog for nine cycles of one-string renames. The record tells the Planner what is done; every cycle starts from the product, and now it has to: the scout is written before the record exists in its transcript.

### review.md contract

```text
# Cycle N review
Verdict: ship | ship-with-revisions | blocked — <why>
Looked: <what the Reviewer ran or opened as the product's user before the diff, and saw — or: could not run — <why>>
Fulfillment:
- <item> — done | partial | missing — <note>
Revisions:
- <what changed and why>
Must-fix:
- <unresolved acceptance defect; the executor must repair it before fresh review>
Architecture:
- <nonblocking observations and future improvements for the next Planner to weigh>
Worth: yes — <evidenced benefit or consequential uncertainty resolved> | no — <why benefit did not justify cost or risk>
Operator: <only what a human must decide>
```

Fulfilment from the fresh reader beats the executor's board: both `partial` and `missing` reopen an item, and either withholds commit. `Must-fix` identifies acceptance defects for repair within the current cycle. Nonblocking future improvements belong under `Architecture`. `Worth:` judges evidenced benefit, risk reduction or consequential uncertainty resolved against cost and complexity; immediate visibility is not required. These findings remain available to the executor, next Planner and run report.

**The executor hears the review.** The review had two readers — the next Planner and the run report — and not its author. The plan admission after a reviewed cycle now carries *The Reviewer's notes on cycle N — standing for this run*: the verdict and `Worth:`, `Revisions` (what changed in the executor's work and why), the items the Reviewer judged partial or missing against the executor's board, and the `Architecture` notes, closed with the standing instruction that the Reviewer should not have to make the same revision twice. A review that changed nothing says so in one line. Without this the executor repeated the same craft defects every cycle and the Reviewer re-fixed them at up to 80 turns a cycle; with it the run improves inside itself.

## Roles

Both roles run through `runSubagent` with a `role` (`src/agent/subagent.ts`):

| Role | Tools | Isolation | Skills inlined | Turns | Config |
|------|-------|-----------|----------------|-------|--------|
| Planner | runs, never edits: full `bash` + `web_search` / `web_fetch` / MCP (browser via playwright) + `spawn_subagent` explore; the file-editing tools are removed (`denyEdits`) | none | `forge-planner`, `forge-veteran`, `forge-rootcause` | scout (`FORGE_ULW_PLANNER_MAX_TURNS`, 60) then plan (`FORGE_ULW_PLANNER_PLAN_TURNS`, 12) on the same kept session | `[ulw] planner_model`, `planner_effort` |
| Reviewer | full write, no spawn | none (revises the live tree) | `forge-reviewer`, `forge-veteran`, `forge-rootcause` | look (`FORGE_ULW_REVIEWER_LOOK_TURNS`, 15) then review (`FORGE_ULW_REVIEWER_MAX_TURNS`, 80) on the same kept session | `[ulw] reviewer_model`, `reviewer_effort` |

Both roles run through `runRoleTwoTurn` (`src/harness/cycle/roles.ts`): turn 1 with `keepSession`, turn 2 resuming the child (`resumeSessionId`), the session removed when the document is in hand. The role that used the product is the one that writes the document. A parse retry re-enters turn 2 only.

The executor's system prompt carries only the **ULW executor protocol**: ship the items, mark them with `todo_write`, close with `Plan complete.`, `enter_plan_mode` to request a re-plan (the cycle closes at the next Stop), `Operator:` for the four things only the user can do, one `Serendipity:` line for what it noticed and left alone, and the Reviewer's notes from the last cycle as standing rules. `ask_user` fails closed while the driver is armed — on the executor and on every session under the armed one, the Reviewer and the Planner's explore children included (the gate follows `subagent.parentId` to the root) — with the protocol's instruction (decide, record the assumption, or write an `Operator:` line): an unattended run in a TTY would otherwise wait five minutes per question for nobody. Under a human `/plan` the user holds the keyboard until `/build`, so the tool works as usual there.

## Stop behaviour

`evaluateCycleAtStop` (`src/harness/cycle/orchestrator.ts`) is the ULW branch of the Stop guard. Per phase:

| Phase | Stop → |
|-------|--------|
| `plan` | run the Planner (or yield when the user holds `/plan`) |
| `execute` | stamp a wave; `Plan complete.` / empty board / `/replan` → close the cycle; `stuck_threshold` (default 4) no-progress Stops → close the cycle (the Reviewer takes over, never a release); else re-anchor with the open items |
| `fix` | re-run the verify command; green → fresh Reviewer → verify → commit; unresolved review findings or red verification consume the shared fix budget; past `fix_rounds` → release `fix-cap`, nothing committed, `Operator:` line |
| `review` / `verify` / `commit` | resume the interrupted transition |

Releases: `fulfilled` (mandate only), `blocked` (Planner needs the user), `cycle-zero`, `max-cycles`, `fix-cap`, `no-progress` (the synthesized-cycle wall), `runtime-unavailable` (no provider / subagent depth > 0), `disarmed`. A no-mandate `fulfilled` and a plan-less Planner do **not** release — they become work. A clean end stamps `lastError.code = ulw_done` (a designed outcome, not a problem); the others stamp `ulw_released`.

Safety valves (cost cap, max turns, continue cap) set `/cycle 0` so a resume finishes the open cycle instead of re-blocking. Unlimited cycling's Stop-blocks never trip the process continue cap; a capped run or `/cycle 0` still fuses.

## Config

```toml
[ulw]
planner_model = "grok-4.6"     # unset = session model
planner_effort = "xhigh"
reviewer_model = "grok-4.6"
reviewer_effort = "xhigh"
max_cycles = 0                 # 0 / unset = until fulfilled or /cycle 0
fix_rounds = 3
stuck_threshold = 4
```

Env: `FORGE_ULW=0` (driver off), `FORGE_ULW_AUTO_COMMIT=0`, `FORGE_ULW_VERIFY_TIMEOUT_MS` (20 min), `FORGE_ULW_FIX_ROUNDS`, `FORGE_ULW_STUCK_THRESHOLD`, `FORGE_ULW_NO_PROGRESS_CAP` (3 — the synthesized-cycle wall), `FORGE_ULW_PLANNER_MAX_TURNS`, `FORGE_ULW_PLANNER_PLAN_TURNS` (12), `FORGE_ULW_REVIEWER_LOOK_TURNS` (15), `FORGE_ULW_REVIEWER_MAX_TURNS`, `FORGE_ULW_TWO_TURN=0` (one brief per role), `FORGE_ULW_MAX_CONTINUES`.

## Why this shape

The retired wave engine measured stalling and accretion with meters — same-surface, idea-surface, tree-shape, Bet contract, capability drought — because there was no reviewer. HashPet (`~/.forge/sessions/23b2c2a5*`, 791 waves) satisfied every meter while its architecture went 74 → 36. A fresh reviewer reading `git diff <cycle start>` once per cycle sees in one look what the meters approximated one wave at a time. The classifier that decided which meters applied (`isSoftPrompt` / `isOpenMandate`) is gone with them: the Planner, with the whole tree and the category in front of it, decides whether a mandate is fulfilled.

The second HashPet run (`7e705c79`, 30 cycles, 29 commits, nine one-string renames with the root cause written in cycle 21's review) is why the roles now run in two turns and carry the doctrine at the run level. Every fact was green thirty times; what was missing was not a meter but the order things were read in and the doctrine in the room. A walk-diff or a benchmark score would have been another meter to satisfy — a rename moves bytes too, and a hidden "what a user would notice" list is a human defining better one layer down. What replaced them is the record read by the role that needs it, in the order the doctrine already prescribed.
