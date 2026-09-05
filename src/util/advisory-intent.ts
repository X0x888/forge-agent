/**
 * Detect advisory/Q&A user text vs work orders.
 * Used by compact handoff + mid-run interjections so ULW momentum
 * does not override pure questions (oh-my-claude compact-intent lesson).
 *
 * Also used by TodoGate / handoff-guard / proof-claim-guard so pure Q&A
 * answers under ULW are not trapped by open todos or soft closers.
 */

/**
 * Verbs that make a sentence a work order when they lead it — bare
 * ("add retry to the fetcher") or wrapped in a polite question ("can you
 * add retry to the fetcher?"). Explanatory verbs (explain, describe,
 * summarize, compare, review, walk me through) are deliberately absent:
 * those lead answers.
 */
const WORK_VERB =
  "add|make(?!\\s+sense)|remove|rename|move|create|delete|change|update|edit|wire|hook|set|convert|migrate|extract|split|merge|rewrite|replace|bump|upgrade|downgrade|install|uninstall|configure|write|generate|port|introduce|drop|turn|switch|enable|disable|clean|tidy|dedupe|deduplicate|optimi[sz]e|speed|reduce|increase|deploy|push|commit|revert|run|re-?run|kill|stop|start|restart|land|test|lint|format|document|annotate|wrap|guard|handle|cache|log|instrument|profile|benchmark|redesign|restructure|reorgani[sz]e|rework|tune|polish|finish|complete|continue|resume|pull|fetch|sync|rebase|squash|tag|release|publish|bundle|compile|scaffold|bootstrap|init|initiali[sz]e|set\s+up|wire\s+up|hook\s+up|expose|inline|hoist|flatten|parametri[sz]e|prune|trim|strip|normali[sz]e|saniti[sz]e|validate|escape|encode|decode|seriali[sz]e|parse|render|style|theme|translate|locali[sz]e|patch|fix|implement|build|refactor|ship";

const POLITE_WORK_RE = new RegExp(
  `^(?:hey,?\\s+|hi,?\\s+|ok,?\\s+|okay,?\\s+|so,?\\s+|now,?\\s+|next,?\\s+|also,?\\s+|then,?\\s+)?(?:can|could|would|will|may)\\s+you\\s+(?:please\\s+|also\\s+|just\\s+|quickly\\s+|maybe\\s+)?(?:${WORK_VERB})\\b`,
  "i",
);
const COORDINATED_WORK_RE = new RegExp(
  `\\b(?:and|then)\\s+(?:please\\s+|also\\s+|just\\s+)?(?:${WORK_VERB})\\b`,
  "i",
);
const IMPERATIVE_WORK_RE = new RegExp(
  `^(?:hey,?\\s+|hi,?\\s+|ok,?\\s+|okay,?\\s+|so,?\\s+|now,?\\s+|next,?\\s+|also,?\\s+|then,?\\s+|please\\s+|pls\\s+|plz\\s+|kindly\\s+|go\\s+ahead\\s+and\\s+|just\\s+|let'?s\\s+)?(?:${WORK_VERB})\\b`,
  "i",
);

/** True when the text looks like Q&A/advisory, not a work order. */
export function looksLikeAdvisoryUserMessage(text: string): boolean {
  const s = String(text || "").trim();
  if (!s) return false;
  // Explicit implement/fix language overrides advisory.
  // Keep this list tighter than "change/update" alone so "what should I change?"
  // stays Q&A, while "please change the timeout" is a work order.
  // (`build` is not in this list: "is the build green?" is a question. As a
  // verb it is caught by the imperative / polite leads below.)
  if (
    /\b(?:implement|fix|ship|refactor|write code|apply this|make the change|do it|please (?:edit|change|update|patch)|go ahead and|just do it)\b/i.test(
      s,
    )
  ) {
    return false;
  }
  // Soft ULW-style prompts are work orders under ULW expansion.
  if (
    /\b(?:improve|clean up|harden|production-ready|ultrawork|\/ulw)\b/i.test(s) &&
    s.length > 40
  ) {
    return false;
  }
  // A polite request is still a request: "can you add retry to the fetcher?"
  // ends in a question mark and used to read as Q&A — so a ULW run treated
  // the order as a question, skipped TodoGate and let a soft closer through.
  // Same for an imperative lead ("add retry to the fetcher", "please rename…").
  if (POLITE_WORK_RE.test(s) || IMPERATIVE_WORK_RE.test(s)) return false;
  // Trailing question mark is the strongest advisory signal.
  if (/\?\s*$/.test(s)) return true;
  // Leading interrogatives / modal openers.
  if (
    /^(?:what|why|how|when|where|who|which|should|could|would|is|are|do|does|did|can|may|thoughts)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  // A coordinated imperative is an order even when it opens with an
  // explanatory verb: "compare the two configs and merge them into one".
  // Checked after the interrogative lead so "does it add X and remove Y"
  // stays a question.
  if (COORDINATED_WORK_RE.test(s)) return false;
  // Common advisory / opinion / explain phrasings (with or without '?').
  // Intentionally broad on "review this" / "thoughts on" / "walk me through"
  // so mid-run Q&A under ULW does not trip TodoGate/handoff/proof-claim.
  if (
    /\b(?:what do you think|your (?:take|opinion|thoughts)|does this look|does this make sense|is this right|looks good|any ideas|please advise|advise(?:\s+me)?|thoughts on|lmk what you think|let me know what you think|wdyt|help me understand|tell me about|describe (?:the|how|what)|walk me through|compare\b|pros and cons|trade-?offs?|downsides?|concerns?(?:\s+with)?|risks?\b|quick question|just curious|curious about|i wonder(?:ing)?\b|take a look(?: at)?|can you (?:take a )?look|review (?:this|the|my)|explain|summarize|summarise|opinion on|feedback on|sanity check|spot check|gut check|second opinion|red flags?|am i missing|remind me|recap\b|clarify\b|tldr\b|tl;dr|eli5\b|in plain english|high level overview|give me the gist|gist of)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  return false;
}
