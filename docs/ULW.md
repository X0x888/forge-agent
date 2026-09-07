# Ultrawork (ULW) — the plan-cycle driver

`/ulw [mandate]` (or `forge --ulw`, `forge run --ulw`) arms a **plan-cycle** driver. The unit of work is a **cycle**, not a wave:

```
PLAN ──► EXECUTE ──► VERIFY ──► REVIEW ──► VERIFY ──► COMMIT ──► RELEASED
 ▲         │  ▲         │                     │                     ▲
 │         └──┘ (Stop)  └─ red ─► FIX ─┐      └─ red ─► FIX ─┐      │
 └──────────────── re-plan ◄───────────┴─────────────────────┴──────┘  (/cycle 0 · max_cycles · fulfilled)
```

- **PLAN** — a fresh-context **Planner** subagent (empty transcript, its own model/effort) runs in **two turns of one kept session**. Turn 1, the **scout**: it is handed the product and the tree and nothing of the record — it uses the product, lists the product's own **promises** (README, `--help`, tests as spec, identity) as `kept | broken | absent`, researches the category, surveys the tree and writes `Considered:` — one candidate per gap bin plus `leave it` — into `scout.md`. Turn 2, the **plan**: the record arrives (what shipped, the last review, the executor's lines, the user's words, the spend); it strikes what is done, names a repeated class of change as one decision, and writes `plan.md`. The order is the doctrine enforced by sequence: a Planner that read the record first planned the record's next line.
- **EXECUTE** — the session model is the **executor**. The plan's items are its todo board. Every Stop is a wave boundary: open items → re-anchor; `Plan complete.` or an empty board → the cycle closes. As many waves as the plan needs.
- **VERIFY** — the **harness itself** runs the verify command (the Planner's `Verify:` when it is a whole check; an isolate — one test file, a typecheck — is proof=ran, and the stack table's suite gates instead). The gate is judged against a **baseline**: the failures the suite already had before the cycle touched anything (run at cycle 1's admission on the user's tree, then the accepted set after each commit; and run again at any later admission whose gate command differs from the baseline's — a Planner that declares `npm run check` after cycles gated by `npm test`, or the first cycle to declare one at all — on the tree as the last commit left it, because a baseline keyed to another command matches nothing and every old failure would be red again). New failures are red and send the executor back with their names (`fix_rounds`, default 3); pre-existing ones are reported, not the executor's job. A red run that names no failing test (a crash, a timeout, an unknown runner) is red whatever the baseline says.
- **REVIEW** — on a tree that passes the gate, a fresh-context **Reviewer** subagent runs in two turns too. Turn 1, the **look**: the product on the tree as the cycle left it, no diff — it uses it and writes `look.md` (`Looked:`). Turn 2, the **review**: it reads the plan (its `Considered:` included) and the cycle's cumulative diff (`git diff <cycle start>` + untracked files) as a reviewer and as an architect, **revises in place**, names the same class of change as a previous cycle a symptom (root cause under `Must-fix`), judges worth from what it saw as the user, and writes `review.md`. Because it runs after the gate, what the executor changed to get green is reviewed too. `Verdict: blocked` (or a review that does not parse) closes the cycle **without a commit**; the work stays in the tree and the next Planner starts from the `Must-fix`.
- **VERIFY again** — the check runs once more over the Reviewer's revisions; red goes back to the executor (same `fix_rounds` budget), then commits without a second review.
- **COMMIT** — one local commit per reviewed, green cycle (`ulw cycle N: <title>`; never pushed; `FORGE_ULW_AUTO_COMMIT=0` off).
- **Re-plan** — a fresh Planner reads the previous plans, reviews, the Reviewer's `Must-fix`, unfinished items and anything the user typed since the last plan. `Verdict: fulfilled` ends the run. `/cycle 0` or `max_cycles` ends it after the commit.

Nothing in the driver classifies prose. The Planner and Reviewer judge; the harness enforces the sequence and structural facts: no writes before a plan exists, no commit before a completed review and a green harness-run check, no Stop mid-cycle, what each role reads before what, every cycle leaves `scout.md`, `plan.md`, `look.md`, `review.md` and a commit (or a `blocked` review and no commit).

## Doctrine at the run level

The skills in `skills/forge-*` were written for a task and applied to a task. The 30-cycle HashPet run is what happens when nobody applies them to the cycle and the run: cycle 21's review named the root cause of nine renames ("three independent strings — same split Ate had; pre-existing, left alone") and filed it as a shape note, and eight more renames shipped. The roles now carry each doctrine at the unit it was missing from, and the harness enforces the part it can — sequence and presence:

| Doctrine | At the run level | Where |
|----------|------------------|-------|
| `forge-planner` §2 use it first · §6 every cycle starts from the product | The scout turn has no record; the plan turn does | `roles.ts`, `buildPlannerScoutBrief` / `buildPlannerPlanBrief` |
| `forge-shape` alternatives with trade-offs; fake consensus is not a plan | `Considered:` — one candidate per gap bin, one line each | `plan.md` (required for `continue`) |
| `forge-veteran` "this is fine — leave it" | `leave it` is always in `Considered:`, with why it lost or won — the null hypothesis every cycle beats in writing | `plan.md` (required) |
| `forge-surface` every decision traceable to subject + audience + job; "would I make this for any similar page?" | `serves:` per item, in words; `Worth the cycle:` says why this is from *this* product | `plan.md` (required) |
| `forge-redgreen` a test that already passes means the behaviour exists; behaviour from the outside, never the implementation mirrored | `red now:` per item — what the Planner ran or saw; proofs are observables or commands | `plan.md` (required) |
| `forge-rootcause` no fix without root cause; three attempts → question the architecture | The same class of change twice is a symptom: the Planner plans the one decision or leaves it; the Reviewer puts the root cause under `Must-fix`, or `blocked` at three | both skills; `forge-rootcause` inlined into both roles |
| `forge-prove` run, read, then claim | The Reviewer's look turn comes before the diff; `Worth:` is judged from `Looked:` | `roles.ts`, `buildReviewerLookBrief`; `review.md` `Looked:` |
| `forge-assay` a checklist against current state, never memory | `Promises:` — the product's own claims, `kept | broken | absent` as inspected each cycle; the run's checklist; `fulfilled` means kept | `scout.md`, `ulw.json` `promises[]`, project memory `Promise:` rows |
| `forge-swarm` parallel reads with different lenses | The Planner's explore children get lenses: first-minute user, month-three user, next year's maintainer, a competitor's PM | `forge-planner` §4 |
| `forge-absorb` push back with evidence | The executor's `Dispute:` line — a Reviewer revision it can show was wrong — reaches the next Planner | `forge-veteran`; `record.disputes` |
| `forge-planner` "the way a boss does" | The plan brief carries the run's spend; `Worth the cycle:` is the claim before the spend, the Reviewer's `Worth:` the finding after — side by side in the record, `/cycle status` and the report | `runSpend`, `cycleLine`, `cycleReportFacts` |

Presence and shape are parsed; content is judged by the next role and by whoever opens `cycles/<n>/`. A `continue` plan missing `Considered:` (with `leave it`) or an item's `serves:` / `red now:` comes back to the Planner once with what was missing — on the kept session, as one more short turn, so the scouting is not redone — then releases as `blocked` as before. `FORGE_ULW_TWO_TURN=0` runs each role on one brief (the old shape, the new contracts); a runtime that cannot keep a session, or a resume that fails, falls back to the same single brief with the scout inlined. Nothing in the mechanism releases a run.

## Three cases, one procedure

The mandate only changes where the direction comes from.

| Case | Prompt | What happens |
|------|--------|--------------|
| **a — clear goal** | `/ulw add --version with a test` | Cycle 1 plans and ships it. At re-plan the Planner writes `Verdict: fulfilled` and the run stops. |
| **b — direction** | `/ulw polish the first-run experience` | The direction frames every plan; the run cycles until fulfilled or `/cycle 0`. |
| **c — no prompt** | `/ulw` | The Planner derives the direction from the product: identity (README, `--help`, manifests, tests as spec) + category research + the tree's gaps. |

Invention and repair are both legitimate in every case; the tree decides which the cycle needs. There is no Bet contract and no mandate classifier.

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

- `ulw.json` (schema 2) — `cycle`, `phase`, `items[]` (each with `serves` and `redNow`), `verifyCommand`, `promises[]` (the product's own claims as last inspected: `text`, `kept | broken | absent`, `seen`), `cycles[]` (title, items done/total, waves, review verdict, verify result, commit sha, tokens per role, `considered[]`, `worthClaim`, `worth`, `reviewerLooked`, `scoutPath` / `lookPath`), `ledger[]` (one row per Stop: edit delta, tree movement, proof ran), `identity`, `direction`, `lastReview`. A schema-1 sidecar from the retired wave engine loads as `legacy` and disabled; `/ulw` re-arms.
- `cycles/<n>/scout.md` (the Planner's turn 1, written before it saw the record), `plan.md`, `look.md` (the Reviewer's turn 1, before the diff), `review.md`, `verify.baseline.log` (cycle 1: the untouched tree; a later cycle whose gate command changed: the tree as the last commit left it), `verify.pre-review.log` / `verify.post-review.log` (`.<round>` after a red round), `plan.failed.md` when the Planner never produced a parseable plan. The cycle record also keeps the Reviewer's `revisions`, the items it `disputed` (partial / missing against the executor's board), and the executor's `serendipity` and `disputes` lines.
- `decisions.json` gains a `Plan N: <title>` row per cycle; the product identity and its promises go to project memory (`Identity: …`, `Promise: … — kept|broken|absent`).

### scout.md contract (Planner, turn 1)

```text
# Cycle N scout
Identity: <one paragraph: who uses this product, for what job>
Looked: <what the Planner ran or opened as the product's user, and saw — or: could not run — <why>>
Promises:
- <what the product promises: README, --help, tests as spec, the identity> — kept | broken | absent — <where seen>
Considered:
- missing capability: <candidate> — <trade-off>
- broken promise: <candidate> — <trade-off>
- rough edge: <candidate> — <trade-off>
- debt: <candidate> — <trade-off>
- leave it — <why the product may be fine as it stands>
```

### plan.md contract (Planner, turn 2)

```text
# Cycle N plan — <title>
Verdict: continue | fulfilled — <why; with no mandate: the product is in good shape> | blocked — <what only the user can unblock>
Identity: <reaffirmed, or an Operator: line>
Looked: <carried from the scout>
Considered:
- <the scout's candidates, struck or kept after the record; leave it always present, with why it lost or won>
Direction: <this cycle's theme — what a user will notice>
Worth the cycle: <why this beats leave it for the user in Identity, and why it is from this product and not any product of its kind>
Verify: `npm test` | none — <why>
Items:
1. <ship title> — files: <path>, <path> — serves: <the job in Identity this serves> — red now: <what showed it is not yet so, or: unchecked — why> — proof: <command or observable, behaviour from the outside>
Out of scope:
- <passed on, and why>
Guidelines: ok | fix: <what the AGENTS.md-class file needs>
Operator: <secret / irreversible action / external blocker / identity change — else omit>
```

`Verify:` goes through the strict check-command harvest (`looksLikeCheckCommand`): prose is refused, `none — why` falls back to the stack table so a wrong "none" cannot switch the gate off. `Guidelines: fix: …` becomes the plan's first item. A `continue` plan with no items, without `Considered:` carrying a `leave it` entry, or with an item lacking `serves:` or `red now:` does not parse; the Planner is retried once with what was missing named (`explainPlanParseFailure`), then the run releases as `blocked` with the artifact on disk. `Looked:` is the Planner's own record of having used the product before judging it — read the cycles' `Looked:` lines in a row to see whether a run planned from the product or from `grep`; read `Considered:` in a row to see whether `leave it` was ever weighed. In single-brief mode the plan carries a `Promises:` section too, since there is no scout.

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
- <left for the next plan's first items>
Architecture:
- <duplication, wide signatures, dead flags, narrating comments>
Worth: yes — <what a user would notice> | no — <why this was not worth a cycle>
Operator: <only what a human must decide>
```

Fulfilment from the fresh reader beats the executor's board: `missing` reopens the item for the next plan. `Must-fix` and `Operator` lines flow into the next Planner brief and the run report. `Worth:` is the Reviewer judging the cycle, not only the diff, and from its own `Looked:` rather than the diff's effort: a correct cycle no user would notice still ships, its `Worth: no` reaches the next Planner ("find user-visible work or write `Verdict: fulfilled`"), and the Reviewer's brief carries the last four cycles' `Worth:` so a third invisible cycle in a row becomes a `Must-fix`. The Reviewer's brief also carries the run's record (so the same class of change as an earlier cycle is visible and named as a symptom under `Must-fix`), the plan's `Considered:` (so a better alternative left on the table is part of `Worth: no`), and the previous review's `Architecture` notes ("is any of it back?") so a recurrence is named as a `Must-fix` rather than re-discovered as a shape note. `Looked:` is optional in the review — a Reviewer that could not run the product still reviews — and is recorded on the cycle (`reviewerLooked`) from the look turn when the review omits it. No meter counts these; the roles read the record.

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
| `fix` | re-run the verify command; green → the Reviewer (if it has not run) or the commit; red → next fix round; past `fix_rounds` → release `fix-cap`, nothing committed, `Operator:` line |
| `review` / `verify` / `commit` | resume the interrupted transition |

Releases: `fulfilled`, `blocked` (Planner), `cycle-zero`, `max-cycles`, `fix-cap`, `runtime-unavailable` (no provider / subagent depth > 0), `disarmed`. A clean end stamps `lastError.code = ulw_done` (a designed outcome, not a problem); the others stamp `ulw_released`.

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

Env: `FORGE_ULW=0` (driver off), `FORGE_ULW_AUTO_COMMIT=0`, `FORGE_ULW_VERIFY_TIMEOUT_MS` (20 min), `FORGE_ULW_FIX_ROUNDS`, `FORGE_ULW_STUCK_THRESHOLD`, `FORGE_ULW_PLANNER_MAX_TURNS`, `FORGE_ULW_PLANNER_PLAN_TURNS` (12), `FORGE_ULW_REVIEWER_LOOK_TURNS` (15), `FORGE_ULW_REVIEWER_MAX_TURNS`, `FORGE_ULW_TWO_TURN=0` (one brief per role), `FORGE_ULW_MAX_CONTINUES`.

## Why this shape

The retired wave engine measured stalling and accretion with meters — same-surface, idea-surface, tree-shape, Bet contract, capability drought — because there was no reviewer. HashPet (`~/.forge/sessions/23b2c2a5*`, 791 waves) satisfied every meter while its architecture went 74 → 36. A fresh reviewer reading `git diff <cycle start>` once per cycle sees in one look what the meters approximated one wave at a time. The classifier that decided which meters applied (`isSoftPrompt` / `isOpenMandate`) is gone with them: the Planner, with the whole tree and the category in front of it, decides whether a mandate is fulfilled.

The second HashPet run (`7e705c79`, 30 cycles, 29 commits, nine one-string renames with the root cause written in cycle 21's review) is why the roles now run in two turns and carry the doctrine at the run level. Every fact was green thirty times; what was missing was not a meter but the order things were read in and the doctrine in the room. A walk-diff or a benchmark score would have been another meter to satisfy — a rename moves bytes too, and a hidden "what a user would notice" list is a human defining better one layer down. What replaced them is the record read by the role that needs it, in the order the doctrine already prescribed.
