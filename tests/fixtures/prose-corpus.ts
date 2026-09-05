/**
 * Prose-classifier corpus.
 *
 * The harness reads natural language through regexes in three places:
 * `looksLikeAdvisoryUserMessage` (is this user text a question or a work
 * order?), `detectHomework` (does this closer hand work back?) and
 * `looksLikeRunReport` (is this closer a whole-run report?). Every one of
 * them gates a Stop block or a driver, so a false positive costs the user a
 * provider round and a false negative lets the defect through.
 *
 * This file is the fixed corpus those classifiers are measured against. Each
 * entry is a message shaped like the ones real sessions produce, with the
 * label a careful human would give it and a one-line reason. Add a case
 * here first when a classifier misfires in the wild; make the regex pass it
 * second. `tests/prose-classifiers.test.ts` runs the whole corpus and fails
 * on any disagreement, so a regex tweak that fixes one case and breaks four
 * is red before it ships.
 */

export interface UserMessageCase {
  text: string;
  /** True = the harness should treat this as Q&A/advisory (no work gates). */
  advisory: boolean;
  why: string;
}

export interface CloserCase {
  text: string;
  /** True = hands work back that the agent could have done. */
  homework: boolean;
  why: string;
}

export interface ReportCase {
  text: string;
  /** True = reads as a whole-run report (outcome sentence + sections). */
  report: boolean;
  why: string;
}

export const USER_MESSAGES: UserMessageCase[] = [
  // --- questions / advisory -----------------------------------------------
  { text: "what does this repo do?", advisory: true, why: "plain question" },
  { text: "How does the stop guard decide to block?", advisory: true, why: "how-question" },
  { text: "is the build green", advisory: true, why: "interrogative lead, no question mark" },
  { text: "thoughts on moving the cache to redis", advisory: true, why: "opinion ask" },
  { text: "walk me through the ULW wave ledger", advisory: true, why: "explain request" },
  { text: "explain why the proof-claim guard fired", advisory: true, why: "explain, no work verb" },
  { text: "compare the two retry strategies for me", advisory: true, why: "compare = analysis" },
  { text: "any risks with the current session lock?", advisory: true, why: "risk question" },
  { text: "does this look right to you?", advisory: true, why: "sanity check" },
  { text: "summarize what changed since yesterday", advisory: true, why: "summary ask" },
  { text: "should we split loop.ts?", advisory: true, why: "should-question about design" },
  { text: "make sense?", advisory: true, why: "'make sense' is not the work verb 'make'" },
  { text: "which model is cheapest for explores?", advisory: true, why: "which-question" },
  { text: "can you take a look at the diff and tell me if it's sane?", advisory: true, why: "review ask, no work verb" },

  // --- work orders --------------------------------------------------------
  { text: "add retry logic to the fetcher", advisory: false, why: "imperative lead" },
  { text: "can you add retry logic to the fetcher?", advisory: false, why: "polite question wrapping a work verb — the '?' used to win" },
  { text: "could you rename Foo to Bar across the repo?", advisory: false, why: "polite rename" },
  { text: "would you please wire the new flag into /config?", advisory: false, why: "polite + please + work verb" },
  { text: "please update the README to mention /guidelines", advisory: false, why: "explicit please update" },
  { text: "fix the flaky test in sessions.test.ts", advisory: false, why: "fix" },
  { text: "implement the proposal we discussed", advisory: false, why: "implement" },
  { text: "refactor the loader so a lone AGENTS.md gets the whole budget", advisory: false, why: "refactor" },
  { text: "compare the two configs and merge them into one", advisory: false, why: "'compare' is advisory wording but 'merge' makes it work — order of rules" },
  { text: "add risk scoring to the ranker", advisory: false, why: "'risk' inside a work order is not a risk question" },
  { text: "improve the error messages the provider layer prints on 429s", advisory: false, why: "soft improve prompt over 40 chars" },
  { text: "run the full suite and fix whatever is red", advisory: false, why: "run + fix" },
  { text: "ok, now migrate the sessions store to the new schema", advisory: false, why: "lead-in filler then imperative" },
  { text: "let's clean up the dead code in tui/", advisory: false, why: "let's + work verb" },
  { text: "go ahead and ship it", advisory: false, why: "go ahead" },
  { text: "Can you please install playwright and get the browser tests running?", advisory: false, why: "polite install" },
];

export const CLOSERS: CloserCase[] = [
  // --- homework -----------------------------------------------------------
  { text: "You'll need to configure the webhook URL in the dashboard.", homework: true, why: "need-to directive" },
  { text: "Next steps for you: add the env var and re-run the migration.", homework: true, why: "next steps for you" },
  { text: "Please run the test suite to confirm.", homework: true, why: "please run" },
  { text: "I'm leaving the integration test to you.", homework: true, why: "leaving to you" },
  { text: "I didn't run the full suite; you could run it before merging.", homework: true, why: "didn't run + you could" },
  { text: "You should add a test for the empty-input case before this goes in.", homework: true, why: "you should add" },
  { text: "You might want to update the changelog as well.", homework: true, why: "soft handoff: might want to" },
  { text: "The remaining work on your side: wire the new flag into the CLI.", homework: true, why: "remaining work on your side" },
  { text: "Left for you to run: the e2e suite.", homework: true, why: "left for you" },
  { text: "- please regenerate the lockfile after pulling", homework: true, why: "bulleted please + verb" },
  { text: "You can now run the migration against staging when you are ready.", homework: true, why: "'when you are ready' parks the action on the user — a deferral, not an affordance" },
  { text: "You can now run `npm run deploy` whenever you like.", homework: true, why: "deferral phrasing" },
  { text: "Done. You can now run `npm run lint` and fix anything it reports.", homework: true, why: "the coordinated 'and fix' is the work handed over" },

  // --- not homework -------------------------------------------------------
  { text: "You can now run `forge status` to see the new HUD row.", homework: false, why: "affordance, not a directive — what the user has now" },
  { text: "You can run `npm test` yourself if you like — I ran it and it passed.", homework: false, why: "offer, verification already done" },
  { text: "Operator: you need to add the STRIPE_SECRET_KEY to .env — I cannot read it.", homework: false, why: "Operator line" },
  { text: "You will need to log in to the vendor portal; the API key is not in the repo.", homework: false, why: "secret / login" },
  { text: "You should force-push only if you accept losing the remote history (irreversible).", homework: false, why: "irreversible" },
  { text: "The external service is down; you can re-run once the network is back.", homework: false, why: "external blocker" },
  { text: "I did not run the e2e suite — it needs Docker, which is not installed here; you can run `npm run e2e` where it is.", homework: false, why: "environment blocker (docker / not installed)" },
  { text: "Whether the retry window should be 5s or 30s is your call — I left it at 5s; you may want to change it.", homework: false, why: "user decision, flagged as such" },
  { text: "Not done: the Windows path handling — you'll need to decide whether we support it at all.", homework: false, why: "decision that is theirs" },
  { text: "```\n# you can now run npm test\n```\nDone.", homework: false, why: "code fence is not an instruction" },
  { text: "Added the flag; `forge run --json` now carries `productionWarnings[]`. Verified with `npm test` (1,412 pass).", homework: false, why: "plain report, no hand-back" },
  { text: "If you prefer the old behaviour you can set FORGE_REQUEST_PRUNE=1.", homework: false, why: "preference switch, not a task" },
];

const OUTCOME_FIRST_STANDARD = `Done — the login flow now rejects expired tokens and 3 files changed.

**What shipped**
- Token expiry check in the session middleware.
- A regression test that calls it with an expired token.

**Verified**
- \`npm test\` passed (212 tests).

**Not done**
- Nothing left open.

**Needs you**
- Nothing.`;

const OUTCOME_FIRST_OWN_HEADINGS = `The importer streams now and memory stays flat on a 2 GB file.

## Changes
- \`src/import/stream.ts\` — chunked reader, 64 KB windows.
- \`src/cli.ts\` — \`--stream\` flag.

## Testing
- \`npm test\` — 1,412 pass.
- Manual: imported the 2 GB fixture, RSS peaked at 180 MB.

## Caveats
- Windows line endings are normalised on the way in.`;

const ATTESTATION_REPORT = `**Cycle complete.** Twelve waves shipped the streaming importer and the HUD row; all green.

**What shipped**
- Streaming importer (waves 1–7).
- HUD \`stream\` row (wave 8).

**Verified**
- \`npm test\` 1,412 pass · \`npm run typecheck\` clean.

**Not done**
- Nothing.

**Needs you**
- Nothing.`;

export const REPORTS: ReportCase[] = [
  { text: OUTCOME_FIRST_STANDARD, report: true, why: "canonical shape" },
  { text: OUTCOME_FIRST_OWN_HEADINGS, report: true, why: "outcome sentence + sections under the writer's own headings — not the four harness words" },
  { text: ATTESTATION_REPORT, report: true, why: "attestation token on the outcome line, then sections" },
  { text: "## Summary\nThe run finished and everything is green.\n## Verified\n- npm test", report: true, why: "title first, outcome sentence second" },
  { text: "Fixed the reviewer's nit.", report: false, why: "last-round nit, no sections" },
  { text: "**What shipped**\n- x\n**Verified**\n- y", report: false, why: "labels with no outcome sentence" },
  { text: "**Cycle complete.**\n\n12 waves, all green.", report: false, why: "bare attestation, one section at most" },
  { text: "Done.\n\n**Verified**\n- npm test", report: false, why: "one section and a one-word outcome" },
];
