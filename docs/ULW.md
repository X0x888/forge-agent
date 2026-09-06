# Ultrawork (ULW) — the plan-cycle driver

`/ulw [mandate]` (or `forge --ulw`, `forge run --ulw`) arms a **plan-cycle** driver. The unit of work is a **cycle**, not a wave:

```
PLAN ──► EXECUTE ──► REVIEW ──► VERIFY ──► COMMIT ──► RELEASED
 ▲         │  ▲                    │                    ▲
 │         └──┘ (Stop = wave)      └─ red ─► FIX ─┐     │
 └──────────────── re-plan ◄──────────────────────┴─────┘  (/cycle 0 · max_cycles · fulfilled)
```

- **PLAN** — a fresh-context **Planner** subagent (empty transcript, its own model/effort) reads the product, researches its category online, surveys the whole tree, and writes `plan.md`.
- **EXECUTE** — the session model is the **executor**. The plan's items are its todo board. Every Stop is a wave boundary: open items → re-anchor; `Plan complete.` or an empty board → the cycle closes. As many waves as the plan needs.
- **REVIEW** — a fresh-context **Reviewer** subagent reads the plan and the cycle's cumulative diff (`git diff <cycle start>` + untracked files) as a reviewer and as an architect, **revises in place**, and writes `review.md`.
- **VERIFY** — the **harness itself** runs the declared verify command. Green commits; red sends the executor back with the tail (`fix_rounds`, default 3).
- **COMMIT** — one local commit per reviewed, green cycle (`ulw cycle N: <title>`; never pushed; `FORGE_ULW_AUTO_COMMIT=0` off).
- **Re-plan** — a fresh Planner reads the previous plans, reviews, the Reviewer's `Must-fix`, unfinished items and anything the user typed since the last plan. `Verdict: fulfilled` ends the run. `/cycle 0` or `max_cycles` ends it after the commit.

Nothing in the driver classifies prose. The Planner and Reviewer judge; the harness enforces the sequence and structural facts: no writes before a plan exists, no commit before a completed review and a green harness-run check, no Stop mid-cycle, every cycle leaves `plan.md`, `review.md` and a commit.

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
/cycle 0               finish this cycle (execute → review → verify → commit), then stop
/cycle 1               keep re-planning after each commit
/cycle status          cycle, phase, plan items, verify, last review, cycle ledger
/replan                close the open cycle now (review, verify, commit) and re-plan
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

- `ulw.json` (schema 2) — `cycle`, `phase`, `items[]`, `verifyCommand`, `cycles[]` (title, items done/total, waves, review verdict, verify result, commit sha, tokens per role), `ledger[]` (one row per Stop: edit delta, tree movement, proof ran), `identity`, `direction`, `lastReview`. A schema-1 sidecar from the retired wave engine loads as `legacy` and disabled; `/ulw` re-arms.
- `cycles/<n>/plan.md`, `review.md`, `verify.log` (`verify.<round>.log` after a red round), `plan.failed.md` when the Planner never produced a parseable plan.
- `decisions.json` gains a `Plan N: <title>` row per cycle; the product identity goes to project memory (`Identity: …`).

### plan.md contract

```text
# Cycle N plan — <title>
Verdict: continue | fulfilled — <why> | blocked — <what only the user can unblock>
Identity: <one paragraph: who uses this product, for what job>
Direction: <this cycle's theme>
Verify: `npm test` | none — <why>
Items:
1. <ship title> — files: <path>, <path> — proof: <command or observable>
Out of scope:
- <passed on, and why>
Guidelines: ok | fix: <what the AGENTS.md-class file needs>
Operator: <secret / irreversible action / external blocker / identity change — else omit>
```

`Verify:` goes through the strict check-command harvest (`looksLikeCheckCommand`): prose is refused, `none — why` falls back to the stack table so a wrong "none" cannot switch the gate off. `Guidelines: fix: …` becomes the plan's first item. A `continue` plan with no items does not parse; the Planner is retried once, then the run releases as `blocked` with the artifact on disk.

### review.md contract

```text
# Cycle N review
Verdict: ship | ship-with-revisions | blocked — <why>
Fulfillment:
- <item> — done | partial | missing — <note>
Revisions:
- <what changed and why>
Must-fix:
- <left for the next plan's first items>
Architecture:
- <duplication, wide signatures, dead flags, narrating comments>
Operator: <only what a human must decide>
```

Fulfilment from the fresh reader beats the executor's board: `missing` reopens the item for the next plan. `Must-fix` and `Operator` lines flow into the next Planner brief and the run report.

## Roles

Both roles run through `runSubagent` with a `role` (`src/agent/subagent.ts`):

| Role | Tools | Isolation | Skills inlined | Config |
|------|-------|-----------|----------------|--------|
| Planner | read-only + `web_search` / `web_fetch` / MCP + `spawn_subagent` explore | none | `forge-planner`, `forge-veteran` | `[ulw] planner_model`, `planner_effort`, `FORGE_ULW_PLANNER_MAX_TURNS` (60) |
| Reviewer | full write, no spawn | none (revises the live tree) | `forge-reviewer`, `forge-veteran` | `[ulw] reviewer_model`, `reviewer_effort`, `FORGE_ULW_REVIEWER_MAX_TURNS` (80) |

The executor's system prompt carries only the **ULW executor protocol**: ship the items, mark them with `todo_write`, close with `Plan complete.`, `enter_plan_mode` to request a re-plan (the cycle closes at the next Stop), `Operator:` for the four things only the user can do.

## Stop behaviour

`evaluateCycleAtStop` (`src/harness/cycle/orchestrator.ts`) is the ULW branch of the Stop guard. Per phase:

| Phase | Stop → |
|-------|--------|
| `plan` | run the Planner (or yield when the user holds `/plan`) |
| `execute` | stamp a wave; `Plan complete.` / empty board / `/replan` → close the cycle; `stuck_threshold` (default 4) no-progress Stops → close the cycle (the Reviewer takes over, never a release); else re-anchor with the open items |
| `fix` | re-run the verify command; green → commit; red → next fix round; past `fix_rounds` → release `fix-cap`, nothing committed, `Operator:` line |
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

Env: `FORGE_ULW=0` (driver off), `FORGE_ULW_AUTO_COMMIT=0`, `FORGE_ULW_VERIFY_TIMEOUT_MS` (20 min), `FORGE_ULW_FIX_ROUNDS`, `FORGE_ULW_STUCK_THRESHOLD`, `FORGE_ULW_PLANNER_MAX_TURNS`, `FORGE_ULW_REVIEWER_MAX_TURNS`, `FORGE_ULW_MAX_CONTINUES`.

## Why this shape

The retired wave engine measured stalling and accretion with meters — same-surface, idea-surface, tree-shape, Bet contract, capability drought — because there was no reviewer. HashPet (`~/.forge/sessions/23b2c2a5*`, 791 waves) satisfied every meter while its architecture went 74 → 36. A fresh reviewer reading `git diff <cycle start>` once per cycle sees in one look what the meters approximated one wave at a time. The classifier that decided which meters applied (`isSoftPrompt` / `isOpenMandate`) is gone with them: the Planner, with the whole tree and the category in front of it, decides whether a mandate is fulfilled.
