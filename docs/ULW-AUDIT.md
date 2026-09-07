# ULW design audit

September 2026. Scope: autonomous improvement with no mandate, examined through
the role instructions, artifact contracts, state transitions, and verification.
Existing session artifacts supplied counterexamples; no new model runs were
needed to establish the defects below.

## Objective

ULW should supply the judgment a good prompt would otherwise supply: understand
the project, identify consequential gaps, choose a worthwhile intervention,
implement it, challenge it, and retain what the evidence supports. An unlimited
run extends the opportunity to do this. Duration, edits, commits, and a green
suite do not establish the quality of the chosen work.

Excellence is relative to a product's purpose, audience, constraints, and
alternatives. The harness can enforce necessary conditions for improvement; it
cannot prove a top-0.1% ranking from its own checks. Planner and Reviewer can
share a blind spot even with separate contexts. First-principles reasoning
helps expose those failure paths without requiring exhaustive dogfood.

## Findings addressed

| Defect | Consequence | Correction |
| --- | --- | --- |
| A nominal shipping review could contain Must-fix or partial/missing items | Known unfinished work could commit, including at the user's final cycle | Findings require executor repair and fresh review within the existing fix-round budget |
| Executor fixes after review reused the earlier approval | A passing suite could commit changes no Reviewer had examined | Repairs invalidate approval; verification and a fresh review precede commit |
| Failed or incomplete role output could contain a parseable shipping verdict | Document syntax stood in for completed review | Review acceptance also requires a successful, completed role result |
| A new gate captured a baseline from edits left by a blocked cycle | Introduced failures could become tolerated failures | Later baseline capture requires a previous committed cycle and a successful clean-root check; cycle 1 still includes the user's initial dirty tree |
| Worth focused on first-minute visibility; test-only work was forbidden | Recovery, security, accessibility, regression evidence, and maintainability could lose to cosmetic work | Judge product-specific benefit, risk reduction, evidence, and cost over the useful lifetime; meaningful tests need no manufactured production edit |
| The Planner could write UNKNOWN promises that the parser discarded | Unverified behavior disappeared from the inventory | Preserve unknown in artifacts, state, status, and reports; investigate before prescribing a repair |
| Instructions said promptless fulfilled stops, while mechanics continued | Roles reasoned from a false lifecycle contract | State the actual continuation behavior and allow investigation to conclude without inventing edits |

The existing plan-cycle separation remains useful: discovery precedes the run
record, independent review follows execution, and the harness owns the check
and commit sequence. The corrections strengthen those boundaries.

## Choosing work

Discovery should consider the whole product while the selected cycle stays
coherent. These are lenses to apply where relevant, not scores or a requirement
to manufacture one task in every category:

| Question | Evidence appropriate to the project |
| --- | --- |
| Can people complete its core job? | A real workflow, public API call, CLI command, or service request |
| Does it remain correct at boundaries? | Failure reproduction, compatibility contract, invariant, or regression test |
| Can users trust and recover it? | Permission boundary, data handling, restart, migration, or recovery exercise |
| Is it usable by its intended audience? | Navigation, accessibility, error recovery, and repeated-use behavior |
| Does it work at expected scale? | Representative latency, memory, throughput, or resource measurements |
| Can it keep improving affordably? | A demonstrated maintenance obstacle, duplicated decision, or costly change path |

For each chosen intervention, connect an observation to its consequence, the
proposed change, its cost and downside, and the evidence that would distinguish
improvement from merely changing the tree. Research and negative findings can
improve that decision. They do not require an implementation change as a receipt.
Repeated work is a reason to investigate a shared cause; the number of similar
edits alone cannot determine whether an abstraction is warranted.

## Remaining limits

- The normal-plan path still lacks the synthesized-cycle no-progress wall.
  Repeated accepted-but-empty cycles or blocked reviews can consume resources
  until a user control or another limit intervenes. A general progress policy
  must also recognize verified work with auto-commit disabled.
- Baseline comparison uses failing test names, not structured failure causes.
  A different defect under an already failing name can be missed. The new
  admission rule fixes provenance, not failure attribution or test coverage.
- Looked, Worth, and per-item proofs are role judgments. A green project gate
  does not independently establish every claim in those documents. The role's
  ability to edit through shell commands also means a read-only instruction is
  not a complete filesystem boundary.
- The fresh Planner still sees the full cycle record in its second turn;
  unlimited histories need a deliberate bounded retention policy that preserves
  constraints, unresolved findings, and rejected approaches without repeatedly
  loading every cycle.

Deterministic tests can establish transition ordering, rejection behavior,
bounded repair, evidence preservation, and baseline provenance. Representative
project evaluations remain useful for assessing the judgment those mechanisms
support, particularly work selection and correlated Planner/Reviewer errors.
They are complementary evidence, not an exhaustive proof requirement.
