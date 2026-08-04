/**
 * Detect advisory/Q&A user text vs work orders.
 * Used by compact handoff + mid-run interjections so ULW momentum
 * does not override pure questions (oh-my-claude compact-intent lesson).
 *
 * Also used by TodoGate / handoff-guard / proof-claim-guard so pure Q&A
 * answers under ULW are not trapped by open todos or soft closers.
 */

/** True when the text looks like Q&A/advisory, not a work order. */
export function looksLikeAdvisoryUserMessage(text: string): boolean {
  const s = String(text || "").trim();
  if (!s) return false;
  // Explicit implement/fix language overrides advisory.
  // Keep this list tighter than "change/update" alone so "what should I change?"
  // stays Q&A, while "please change the timeout" is a work order.
  if (
    /\b(?:implement|fix|ship|build|refactor|write code|apply this|make the change|do it|please (?:edit|change|update|patch)|go ahead and|just do it)\b/i.test(
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
