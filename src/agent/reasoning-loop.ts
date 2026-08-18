/**
 * Detect a reasoning-channel mantra loop.
 *
 * Maze `d3fe69aa` late waves: grok-4.6 wrote the next ship (and fake
 * tool calls) into reasoning_content, then repeated a closer
 * ("The fix is in place and verified" ×550) until xAI's ~59 min cap.
 * Working waves on that run had thought p50=113 / max=2496 and never
 * repeated a 48-char window more than once. This is not "thinking
 * hard" — it is a stuck generator. The 12-minute no-output wall is
 * only a backstop.
 */

export const REASONING_LOOP_FINISH = "reasoning_loop";

/** Ignore short / normal CoT. Working-wave max thought on the maze run was 2496. */
export const REASONING_MANTRA_MIN_CHARS = 3000;
export const REASONING_MANTRA_WINDOW = 48;
export const REASONING_MANTRA_REPEATS = 8;
/** Re-scan at most this often while the thought grows. */
export const REASONING_MANTRA_CHECK_EVERY = 256;

export function countSubstr(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while (true) {
    const j = hay.indexOf(needle, i);
    if (j < 0) return n;
    n += 1;
    i = j + needle.length;
  }
}

/**
 * True when hidden thought has started repeating a long window.
 * Conservative: 3k+ chars and the same 48-char span ≥8 times.
 */
export function isReasoningMantra(text: string): boolean {
  const t = text || "";
  if (t.length < REASONING_MANTRA_MIN_CHARS) return false;
  const win = REASONING_MANTRA_WINDOW;
  const need = REASONING_MANTRA_REPEATS;
  const tail = Math.min(8000, Math.floor(t.length * 0.3));
  const start = Math.max(0, t.length - tail);
  const last = t.length - win;
  for (let i = start; i <= last; i += 24) {
    const w = t.slice(i, i + win);
    let alnum = 0;
    for (let k = 0; k < w.length; k++) {
      const c = w.charCodeAt(k);
      if (
        (c >= 48 && c <= 57) ||
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122)
      ) {
        alnum += 1;
      }
    }
    if (alnum < 16) continue;
    if (countSubstr(t, w) >= need) return true;
  }
  return false;
}

/** Throttle live scans so every reasoning token is not an O(n) pass. */
export function shouldScanReasoningMantra(
  totalChars: number,
  lastScanChars: number,
): boolean {
  if (totalChars < REASONING_MANTRA_MIN_CHARS) return false;
  if (lastScanChars <= 0) return true;
  return totalChars - lastScanChars >= REASONING_MANTRA_CHECK_EVERY;
}
