/**
 * Reasoned empty Stop vs empty-glitch continue.
 *
 * Maze unlimited dogfood (`d3fe69aa`, `3eee1159`): grok-4.6 thought 45–55k
 * chars (~59 min, xAI generation ceiling) then `finish_reason=stop` with no
 * text and no tools. The loop treated that as a dropped-connection empty
 * and injected "Do not stop. Act." — 62% of a 20h wall sat in that cascade.
 *
 * A model that thought and chose stop is Stop. True empties (no thought)
 * stay on the glitch nudge. A reasoning-channel mantra loop is the same
 * Stop (`reasoning_loop`) — not 12 minutes of "thinking."
 */

import { REASONING_LOOP_FINISH } from "./reasoning-loop.js";
import { envPositiveInt } from "../util/env.js";

export const REASONING_WALL_FINISH = "reasoning_wall";
export { REASONING_LOOP_FINISH };

/**
 * Consecutive thought-only Stops (reasoning_wall / reasoning_loop / thought
 * + stop, no text/tools) before this *turn* yields. Does **not** flip ULW
 * to LAST — the user did not ask to stop. `0` / `off` disables.
 * Env: FORGE_THOUGHT_ONLY_MAX (default 8).
 */
export const DEFAULT_THOUGHT_ONLY_MAX = 8;

export function thoughtOnlyStopMax(): number {
  const raw = process.env.FORGE_THOUGHT_ONLY_MAX?.trim();
  if (raw === "0" || (raw && /^off$/i.test(raw))) return 0;
  return envPositiveInt("FORGE_THOUGHT_ONLY_MAX", DEFAULT_THOUGHT_ONLY_MAX);
}

/** Prefixed onto the next Stop re-anchor after a thought-only turn. */
export const THOUGHT_ONLY_ACTION_POKE =
  "[Forge] Previous model turn was thought-only (no text, no tools). That is not a ship. Your next output MUST be a tool call. Do not stop. Do not write the wave in thought.";

export function isReasonedEmptyStop(opts: {
  text?: string | null;
  toolCallCount?: number;
  reasoningContent?: string | null;
  finishReason?: string | null;
}): boolean {
  if ((opts.toolCallCount ?? 0) > 0) return false;
  if ((opts.text || "").trim()) return false;
  const reason = (opts.finishReason || "").trim().toLowerCase();
  if (reason === "length" || reason === "max_tokens") return false;
  if (
    reason === "content_filter" ||
    reason === "content_filtered" ||
    reason === "safety"
  ) {
    return false;
  }
  if (reason === REASONING_WALL_FINISH || reason === REASONING_LOOP_FINISH) {
    return true;
  }
  const thought = (opts.reasoningContent || "").trim();
  if (!thought) return false;
  if (reason && reason !== "stop" && reason !== "end_turn") return false;
  return true;
}
