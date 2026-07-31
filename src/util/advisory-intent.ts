/**
 * Detect advisory/Q&A user text vs work orders.
 * Used by compact handoff + mid-run interjections so ULW momentum
 * does not override pure questions (oh-my-claude compact-intent lesson).
 */

/** True when the text looks like Q&A/advisory, not a work order. */
export function looksLikeAdvisoryUserMessage(text: string): boolean {
  const s = String(text || "").trim();
  if (!s) return false;
  // Explicit implement/fix language overrides advisory.
  if (
    /\b(?:implement|fix|ship|build|refactor|write code|apply this|make the change|do it|please (?:edit|change|update|patch))\b/i.test(
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
  if (/\?\s*$/.test(s)) return true;
  if (
    /^(?:what|why|how|when|where|who|which|should|could|would|is|are|do|does|did|can|may)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (
    /\b(?:what do you think|your (?:take|opinion|thoughts)|does this look|review this|explain|summarize|advise)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  return false;
}
