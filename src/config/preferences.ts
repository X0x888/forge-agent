/**
 * Durable user preferences for interactive selections that should stick
 * across sessions and folders (e.g. /model, /permissions, /effort).
 *
 * Stored at ~/.forge/preferences.json (mode 0600).
 * Applied after static config (global + project), before env / CLI overrides.
 */
import path from "node:path";
import { forgeHome, readJsonFile, writeJsonFile, nowIso } from "../util/fs.js";
import type { PermissionMode, ProviderId } from "./types.js";
import {
  parseReasoningEffort,
  type ReasoningEffort,
} from "./reasoning.js";
import { normalizePermissionMode } from "../util/mode-aliases.js";
import { normalizeProviderId } from "../util/provider-id.js";

export interface UserPreferences {
  version: 1;
  /** Last explicit login/provider choice — applied before env/CLI. */
  provider?: ProviderId;
  model?: string | null;
  permissionMode?: PermissionMode;
  reasoningEffort?: ReasoningEffort;
  /** Ring terminal BEL when a REPL turn finishes (long-run attention). */
  bellOnTurnEnd?: boolean;
  /**
   * When true, first-run expert tip was already shown (or suppressed).
   * Missing/false → show once on next interactive REPL start.
   */
  seenWelcomeTip?: boolean;
  /** Opt-in format-on-write after file tools (OpenCode-inspired). */
  formatOnWrite?: boolean;
  updatedAt?: string;
}

const EMPTY: UserPreferences = { version: 1 };

export function preferencesPath(): string {
  return path.join(forgeHome(), "preferences.json");
}

export function loadPreferences(): UserPreferences {
  const raw = readJsonFile<Partial<UserPreferences>>(preferencesPath(), EMPTY);
  const out: UserPreferences = { version: 1 };
  if (typeof raw.provider === "string") {
    const p = normalizeProviderId(raw.provider);
    if (p.ok) out.provider = p.provider;
  }
  if (typeof raw.model === "string" && raw.model.trim()) {
    out.model = raw.model.trim();
  }
  if (typeof raw.permissionMode === "string") {
    const mode = normalizePermissionMode(raw.permissionMode);
    if (mode) out.permissionMode = mode;
  }
  if (typeof raw.reasoningEffort === "string") {
    const e = parseReasoningEffort(raw.reasoningEffort);
    if (e) out.reasoningEffort = e;
  }
  if (typeof raw.bellOnTurnEnd === "boolean") {
    out.bellOnTurnEnd = raw.bellOnTurnEnd;
  }
  if (typeof raw.seenWelcomeTip === "boolean") {
    out.seenWelcomeTip = raw.seenWelcomeTip;
  }
  if (typeof raw.formatOnWrite === "boolean") {
    out.formatOnWrite = raw.formatOnWrite;
  }
  if (typeof raw.updatedAt === "string") out.updatedAt = raw.updatedAt;
  return out;
}

/**
 * Merge partial updates into preferences and persist.
 * Returns the full preferences after write.
 */
export function savePreferences(patch: {
  provider?: ProviderId | string | null;
  model?: string | null;
  permissionMode?: PermissionMode;
  reasoningEffort?: ReasoningEffort;
  bellOnTurnEnd?: boolean;
  seenWelcomeTip?: boolean;
  formatOnWrite?: boolean;
}): UserPreferences {
  const cur = loadPreferences();
  if (patch.provider !== undefined) {
    if (patch.provider === null || patch.provider === "") {
      delete cur.provider;
    } else {
      const p = normalizeProviderId(patch.provider);
      if (!p.ok) {
        throw new Error(`Invalid provider preference: ${patch.provider}`);
      }
      const providerChanged = cur.provider !== p.provider;
      cur.provider = p.provider;
      // Provider switch without an explicit model in this patch: drop stale
      // model pref (e.g. grok-* left over after login -p claude).
      if (providerChanged && patch.model === undefined) {
        delete cur.model;
      }
    }
  }
  if (patch.model !== undefined) {
    if (patch.model === null || patch.model === "") {
      delete cur.model;
    } else {
      const m = String(patch.model).trim();
      if (m) cur.model = m;
    }
  }
  if (patch.seenWelcomeTip !== undefined) {
    cur.seenWelcomeTip = patch.seenWelcomeTip;
  }
  if (patch.permissionMode !== undefined) {
    const mode = normalizePermissionMode(patch.permissionMode);
    if (!mode) {
      throw new Error(`Invalid permission mode: ${patch.permissionMode}`);
    }
    cur.permissionMode = mode;
  }
  if (patch.reasoningEffort !== undefined) {
    cur.reasoningEffort = patch.reasoningEffort;
  }
  if (patch.bellOnTurnEnd !== undefined) {
    cur.bellOnTurnEnd = Boolean(patch.bellOnTurnEnd);
  }
  if (patch.formatOnWrite !== undefined) {
    cur.formatOnWrite = Boolean(patch.formatOnWrite);
  }
  cur.version = 1;
  cur.updatedAt = nowIso();
  writeJsonFile(preferencesPath(), cur, 0o600);
  return cur;
}

/** Apply loaded preferences onto a config object (mutates and returns it). */
export function applyPreferences<
  T extends {
    provider: string;
    model: string;
    permissionMode: PermissionMode;
    reasoningEffort?: ReasoningEffort;
    providers?: Record<string, { defaultModel?: string } | undefined>;
  },
>(cfg: T, prefs: UserPreferences = loadPreferences()): T {
  if (prefs.provider) {
    const prev = cfg.provider;
    cfg.provider = prefs.provider as T["provider"];
    // When only provider is sticky (no model pref), switch to that provider's
    // default model so we do not keep grok-* under anthropic/openai/etc.
    if (!prefs.model && prefs.provider !== prev) {
      const def = cfg.providers?.[prefs.provider]?.defaultModel;
      if (def) cfg.model = def;
    }
  }
  if (prefs.model) cfg.model = prefs.model;
  if (prefs.permissionMode) cfg.permissionMode = prefs.permissionMode;
  if (prefs.reasoningEffort) cfg.reasoningEffort = prefs.reasoningEffort;
  return cfg;
}
