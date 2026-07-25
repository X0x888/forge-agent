/**
 * Lightweight terminal attention (OpenCode-inspired, minimal).
 *
 * Experts often leave long ULW/goal runs in a background pane. A single BEL
 * on turn end is enough to notice completion without a sound pack.
 *
 * Enable via:
 *   - preference `bellOnTurnEnd` (`/bell on`)
 *   - env `FORGE_BELL=1` (or `true` / `yes` / `on`)
 *
 * Env `FORGE_BELL=0` forces off even if preference is on.
 */

import { loadPreferences } from "../config/preferences.js";

function parseEnvBell(): boolean | null {
  const raw = process.env.FORGE_BELL?.trim().toLowerCase();
  if (!raw) return null;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return null;
}

/** Whether turn-end BEL should fire for this process. */
export function isBellEnabled(
  prefs: { bellOnTurnEnd?: boolean } = loadPreferences(),
): boolean {
  const env = parseEnvBell();
  if (env !== null) return env;
  return Boolean(prefs.bellOnTurnEnd);
}

/**
 * Ring the terminal bell if enabled and stdout is a TTY.
 * Never throws; safe in headless / piped contexts.
 */
export function maybeRingBell(opts?: {
  force?: boolean;
  prefs?: { bellOnTurnEnd?: boolean };
}): boolean {
  try {
    if (!opts?.force && !isBellEnabled(opts?.prefs)) return false;
    if (!process.stdout.isTTY) return false;
    process.stdout.write("\u0007");
    return true;
  } catch {
    return false;
  }
}
