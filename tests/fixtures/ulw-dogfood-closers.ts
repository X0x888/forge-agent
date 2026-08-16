/**
 * Frozen closers from dogfood sessions 5dbf1e54 and 693c5fb1.
 * Text only — the sessions are not imported.
 */

export const DOGFOOD_5DBF_SHIPS = [
  '**Ship:** `createToolStartDelayer` holds `▸ tool args` for 700ms. Settle before the delay → no start line.',
  "Wave 2 is the transcript, not the dock: short tools stay one `✓` row; a real wait gets `▸`. **Ship:** `createToolStartDelayer` holds `▸` for 700ms.",
  "Wave 3 is turn openers — the closer (`──` + Δ) already existed. **Ship:** `formatUserTurnOpen` prints `you › fix the login bug`.",
  "Wave 4 is first-day `/setup`: keys live on the rows, not in a second keymap. **Ship:** The card now reads like the rest of the product.",
] as const;

export const DOGFOOD_5DBF_SURFACES = [
  "Wave 1 shipped: dock shows the running tool name and elapsed",
  "Wave 2 shipped: delayed ▸ start on the transcript",
  "Wave 3 shipped: you › user-turn landmarks",
  "Wave 4 shipped: setup-card keys live on the rows",
] as const;

export const DOGFOOD_693C_SHIPS = [
  "Ship landed: Ctrl+R / Ctrl+S incremental history search in the TTY prompt editor (Esc/^G cancel, Enter runs match) plus Ctrl/Alt+←/→ word motion.",
  "Ship landed: empty Tab includes /resume; /resume Tab offers 1/2/3; /last hint is Conversation card.",
  "Wave 2 ship: default spawn_subagent ✓ row now prints the first 8 lines of the child's report. Same glanceable-work class as edit diffs.",
  "Wave 3 ship: successful long bash (npm test / compilers) prints last 5 lines under the ✓ row. Same glanceable-work class.",
  "Wave shipped (consolidation). No new scope. - **1819 tests pass**",
  "Wave 5 ship: successful web_search prints up to 5 hit titles under the ✓ row (no URLs).",
  "Wave 6 ship: background-task completion interjection now includes the last 8 log lines so the agent can act on npm test.",
  "Wave 7 ship: idle you › bg-completion notice now includes the last log line (pass 36) and keeps (/tasks) when clipped.",
  "Wave 8 ship: live › shows last nonempty bash stdout/stderr line (200ms throttle) via sandbox onChunk.",
  "**Wave shipped.** `live ›` now shows the last nonempty bash line while a command runs (200ms throttle).",
  "Wave 9 ship: Δ closer prints missing/stale verify on its own yellow line; fresh verify stays one line.",
  "Wave 10 ship: lsp diagnostics preview under ✓ (count + first hits). Clean No diagnostics. stays one line.",
  "Wave ship: get_task_output default transcript shows last 8 log lines. Short still-running notes stay one line.",
  "Wave 11 ship: bang-shell !cmd streams last-line into live › via onProgress.",
  "Wave ship: web_fetch default transcript shows first heading + first prose lines. Tiny pages stay one line.",
  "Wave 13 ship: call_mcp default transcript shows first 4 result lines. Glanceable-work class exhausted for high-traffic tools.",
  "Wave 14 ship: extraDefaultPreview is the single dispatcher for default ✓ extras and the ×N coalescer.",
  "Wave 15 ship: search_mcp lists first 5 matched tool names under ✓ via extraDefaultPreview.",
  "**Wave shipped.** Successful `search_mcp` now lists the first 5 matched tool names under the ✓ row.",
] as const;
