/**
 * Durable user preferences for interactive selections that should stick
 * across sessions and folders (e.g. /model, /permissions).
 *
 * Stored at ~/.forge/preferences.json (mode 0600).
 * Applied after static config (global + project), before env / CLI overrides.
 */
import path from "node:path";
import { forgeHome, readJsonFile, writeJsonFile, nowIso } from "../util/fs.js";
import type { PermissionMode } from "./types.js";

export interface UserPreferences {
  version: 1;
  model?: string;
  permissionMode?: PermissionMode;
  updatedAt?: string;
}

const EMPTY: UserPreferences = { version: 1 };

const PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
]);

export function preferencesPath(): string {
  return path.join(forgeHome(), "preferences.json");
}

export function loadPreferences(): UserPreferences {
  const raw = readJsonFile<Partial<UserPreferences>>(preferencesPath(), EMPTY);
  const out: UserPreferences = { version: 1 };
  if (typeof raw.model === "string" && raw.model.trim()) {
    out.model = raw.model.trim();
  }
  if (
    typeof raw.permissionMode === "string" &&
    PERMISSION_MODES.has(raw.permissionMode as PermissionMode)
  ) {
    out.permissionMode = raw.permissionMode as PermissionMode;
  }
  if (typeof raw.updatedAt === "string") out.updatedAt = raw.updatedAt;
  return out;
}

/**
 * Merge partial updates into preferences and persist.
 * Returns the full preferences after write.
 */
export function savePreferences(patch: {
  model?: string;
  permissionMode?: PermissionMode;
}): UserPreferences {
  const cur = loadPreferences();
  if (patch.model !== undefined) {
    const m = patch.model.trim();
    if (m) cur.model = m;
  }
  if (patch.permissionMode !== undefined) {
    if (!PERMISSION_MODES.has(patch.permissionMode)) {
      throw new Error(`Invalid permission mode: ${patch.permissionMode}`);
    }
    cur.permissionMode = patch.permissionMode;
  }
  cur.version = 1;
  cur.updatedAt = nowIso();
  writeJsonFile(preferencesPath(), cur, 0o600);
  return cur;
}

/** Apply loaded preferences onto a config object (mutates and returns it). */
export function applyPreferences<T extends { model: string; permissionMode: PermissionMode }>(
  cfg: T,
  prefs: UserPreferences = loadPreferences(),
): T {
  if (prefs.model) cfg.model = prefs.model;
  if (prefs.permissionMode) cfg.permissionMode = prefs.permissionMode;
  return cfg;
}
