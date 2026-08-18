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

export const REASONING_WALL_FINISH = "reasoning_wall";
export { REASONING_LOOP_FINISH };

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
