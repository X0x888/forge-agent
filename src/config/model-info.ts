/**
 * Per-model context window lookup.
 *
 * `context_window` config stays the explicit override; when the user has NOT
 * set it, the window is re-derived from the active model so /model grok-3
 * (131k) does not keep grok-4.5's 500k and die of provider overflow at 0.92
 * hard-headroom while auto-compact still thinks there is room.
 */

/** Strip provider prefix and xAI alias suffixes: x-ai/grok-4.5-latest → grok-4.5 */
export function normalizeModelKey(model: string): string {
  const base = model.includes("/") ? model.split("/").pop()! : model;
  return base
    .trim()
    .toLowerCase()
    .replace(/-latest$/, "")
    .replace(/-\d{8}$/, "") // dated snapshots: claude-sonnet-4-20250514
    .replace(/-\d{4}$/, ""); // short dated: grok-2-1212
}

/** Exact windows first, then family prefixes (tokens). */
const MODEL_WINDOWS: Record<string, number> = {
  "grok-4.5": 500_000,
  "grok-4": 256_000,
  "grok-3": 131_072,
  "grok-3-mini": 131_072,
  "grok-2": 131_072,
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1-nano": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  o3: 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.5-flash-lite": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
};

const FAMILY_WINDOWS: Array<[prefix: string, window: number]> = [
  ["claude-", 200_000],
  ["grok-4", 256_000], // grok-4.x variants other than 4.5 (exact hit above)
  ["grok-3", 131_072],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
];

/**
 * Context window for a model id, or undefined when unknown (caller keeps the
 * configured/default window rather than guessing).
 */
export function modelContextWindow(model: string): number | undefined {
  const key = normalizeModelKey(model);
  if (!key) return undefined;
  const exact = MODEL_WINDOWS[key];
  if (exact) return exact;
  for (const [prefix, win] of FAMILY_WINDOWS) {
    if (key.startsWith(prefix)) return win;
  }
  return undefined;
}
