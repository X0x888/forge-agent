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
  /**
   * Recently selected model ids per provider (for /model tab-complete and
   * bare /model menus — especially free-form OpenRouter ids).
   */
  recentModels?: Record<string, string[]>;
  /**
   * Last model used per provider so /provider openrouter restores the
   * previous OpenRouter model instead of a stale grok-* id.
   */
  lastModelByProvider?: Record<string, string>;
  /** Ring terminal BEL when a REPL turn finishes (long-run attention). */
  bellOnTurnEnd?: boolean;
  /**
   * Fire a desktop notification when a REPL turn finishes (osascript /
   * notify-send). Opt-in; FORGE_NOTIFY=0|1 overrides.
   */
  notifyOnTurnEnd?: boolean;
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
  if (typeof raw.notifyOnTurnEnd === "boolean") {
    out.notifyOnTurnEnd = raw.notifyOnTurnEnd;
  }
  if (typeof raw.seenWelcomeTip === "boolean") {
    out.seenWelcomeTip = raw.seenWelcomeTip;
  }
  if (typeof raw.formatOnWrite === "boolean") {
    out.formatOnWrite = raw.formatOnWrite;
  }
  if (raw.recentModels && typeof raw.recentModels === "object") {
    const rm: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(raw.recentModels as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const list = v.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 20);
      if (list.length) rm[String(k)] = list;
    }
    if (Object.keys(rm).length) out.recentModels = rm;
  }
  if (raw.lastModelByProvider && typeof raw.lastModelByProvider === "object") {
    const lm: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      raw.lastModelByProvider as Record<string, unknown>,
    )) {
      if (typeof v === "string" && v.trim()) lm[String(k)] = v.trim();
    }
    if (Object.keys(lm).length) out.lastModelByProvider = lm;
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
  notifyOnTurnEnd?: boolean;
  seenWelcomeTip?: boolean;
  formatOnWrite?: boolean;
  /** When setting model, also record lastModelByProvider[provider]. */
  modelProvider?: string;
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
      // Provider switch without an explicit model in this patch: prefer the
      // last model used on that provider, else drop stale cross-provider id.
      if (providerChanged && patch.model === undefined) {
        const last = cur.lastModelByProvider?.[p.provider];
        if (last) cur.model = last;
        else delete cur.model;
      }
    }
  }
  if (patch.model !== undefined) {
    if (patch.model === null || patch.model === "") {
      delete cur.model;
    } else {
      const m = String(patch.model).trim();
      if (m) {
        cur.model = m;
        const prov =
          patch.modelProvider ||
          cur.provider ||
          (typeof patch.provider === "string" ? patch.provider : undefined);
        if (prov) {
          if (!cur.lastModelByProvider) cur.lastModelByProvider = {};
          cur.lastModelByProvider[String(prov)] = m;
        }
      }
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
  if (patch.notifyOnTurnEnd !== undefined) {
    cur.notifyOnTurnEnd = Boolean(patch.notifyOnTurnEnd);
  }
  if (patch.formatOnWrite !== undefined) {
    cur.formatOnWrite = Boolean(patch.formatOnWrite);
  }
  cur.version = 1;
  cur.updatedAt = nowIso();
  writeJsonFile(preferencesPath(), cur, 0o600);
  return cur;
}

/**
 * Push a model id to the front of recentModels[provider] (deduped, capped).
 */
export function rememberRecentModel(
  provider: string,
  model: string,
  max = 12,
): UserPreferences {
  const p = String(provider || "").trim();
  const m = String(model || "").trim();
  const cur = loadPreferences();
  if (!p || !m) return cur;
  if (!cur.recentModels) cur.recentModels = {};
  const prev = cur.recentModels[p] || [];
  const next = [m, ...prev.filter((x) => x !== m)].slice(0, Math.max(1, max));
  cur.recentModels[p] = next;
  if (!cur.lastModelByProvider) cur.lastModelByProvider = {};
  cur.lastModelByProvider[p] = m;
  cur.version = 1;
  cur.updatedAt = nowIso();
  writeJsonFile(preferencesPath(), cur, 0o600);
  return cur;
}

/** Last model used for a provider (sticky restore on /provider switch). */
export function lastModelForProvider(provider: string): string | undefined {
  try {
    const p = String(provider || "").trim();
    if (!p) return undefined;
    const prefs = loadPreferences();
    const m = prefs.lastModelByProvider?.[p];
    return m?.trim() || undefined;
  } catch {
    return undefined;
  }
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
