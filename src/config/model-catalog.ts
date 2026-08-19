/**
 * Provider model catalogs for /model, tab-complete, and `forge models`.
 *
 * OpenRouter (and custom) accept free-form ids; the static list is a starter
 * catalog. When authenticated, we best-effort fetch OpenRouter / xAI /models
 * and cache under ~/.forge/cache (never required for offline / CI).
 *
 * xAI also accepts well-formed newer `grok-*.*` ids (version-bump, not typo);
 * effort/context then follow `grok-model.ts` even before the remote list lands.
 */
import path from "node:path";
import type { ForgeConfig } from "./types.js";
import { forgeHome, readJsonFile, writeJsonFile, ensureDir } from "../util/fs.js";
import { loadPreferences, rememberRecentModel } from "./preferences.js";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const REMOTE_TIMEOUT_MS = 8_000;
const MAX_REMOTE_MODELS = 400;
const MAX_RECENT = 12;

function providerSupportsRemoteCatalog(provider: string): boolean {
  const p = String(provider || "").toLowerCase();
  return p === "openrouter" || p === "xai";
}

export interface ModelCatalogEntry {
  id: string;
  /** static | recent | remote */
  source: "static" | "recent" | "remote";
  description?: string;
}

export interface ModelCatalogResult {
  provider: string;
  models: ModelCatalogEntry[];
  /** Distinct ids in display order (recent → static → remote extras) */
  ids: string[];
  remoteFetched: boolean;
  remoteCount: number;
  freeForm: boolean;
  note?: string;
}

interface OpenRouterCache {
  fetchedAt: number;
  models: string[];
  /** OpenRouter context_length per model id (for auto context_window). */
  contextById?: Record<string, number>;
  /** OpenRouter reasoning.supported_efforts per model id. */
  effortsById?: Record<string, string[]>;
}

function cachePath(provider: string): string {
  return path.join(forgeHome(), "cache", `${provider}-models.json`);
}

/** Free-form model ids are first-class for these providers. */
export function providerAllowsFreeFormModels(provider: string): boolean {
  const p = String(provider || "").toLowerCase();
  return p === "openrouter" || p === "custom" || p === "copilot" || p === "cursor";
}

export function staticModelsForProvider(
  config: ForgeConfig,
  provider: string,
): string[] {
  const pcfg = config.providers[provider];
  if (!pcfg) return [];
  if (pcfg.models?.length) return [...pcfg.models];
  if (pcfg.defaultModel) return [pcfg.defaultModel];
  return [];
}

export function recentModelsForProvider(provider: string): string[] {
  try {
    const prefs = loadPreferences();
    const list = prefs.recentModels?.[provider];
    if (!Array.isArray(list)) return [];
    return list
      .map((m) => String(m || "").trim())
      .filter(Boolean)
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Record a successful model selection for tab-complete / bare /model. */
export function trackRecentModel(provider: string, model: string): void {
  const m = String(model || "").trim();
  const p = String(provider || "").trim();
  if (!m || !p) return;
  try {
    rememberRecentModel(p, m, MAX_RECENT);
  } catch {
    /* prefs I/O never blocks slash */
  }
}

export function readProviderModelsCache(provider: string): string[] | null {
  try {
    const raw = readJsonFile<OpenRouterCache | null>(
      cachePath(provider),
      null,
    );
    if (!raw || !Array.isArray(raw.models) || !raw.models.length) return null;
    if (
      typeof raw.fetchedAt !== "number" ||
      Date.now() - raw.fetchedAt > CACHE_TTL_MS
    ) {
      // Stale: still return for offline display, caller may refresh
      return raw.models.map(String).filter(Boolean);
    }
    return raw.models.map(String).filter(Boolean);
  } catch {
    return null;
  }
}

export function readOpenRouterModelsCache(): string[] | null {
  return readProviderModelsCache("openrouter");
}

function writeProviderModelsCache(
  provider: string,
  models: string[],
  contextById?: Record<string, number>,
  effortsById?: Record<string, string[]>,
): void {
  try {
    ensureDir(path.join(forgeHome(), "cache"));
    writeJsonFile(
      cachePath(provider),
      {
        fetchedAt: Date.now(),
        models,
        ...(contextById && Object.keys(contextById).length
          ? { contextById }
          : {}),
        ...(effortsById && Object.keys(effortsById).length
          ? { effortsById }
          : {}),
      } satisfies OpenRouterCache,
      0o600,
    );
  } catch {
    /* cache is best-effort */
  }
}

function writeOpenRouterModelsCache(
  models: string[],
  contextById?: Record<string, number>,
  effortsById?: Record<string, string[]>,
): void {
  writeProviderModelsCache("openrouter", models, contextById, effortsById);
}

/**
 * Fetch OpenRouter model ids + context_length (best-effort).
 * Uses API key when provided; list also works unauthenticated.
 */
export async function fetchOpenRouterModels(
  apiKey?: string,
): Promise<string[]> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "forge-cli/model-catalog",
  };
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REMOTE_TIMEOUT_MS);
  try {
    const resp = await fetch(OPENROUTER_MODELS_URL, {
      headers,
      signal: ac.signal,
    });
    if (!resp.ok) {
      throw new Error(`OpenRouter models HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as {
      data?: Array<{
        id?: string;
        context_length?: number;
        top_provider?: { context_length?: number };
        reasoning?: {
          supported_efforts?: string[];
          default_effort?: string;
        };
        supported_parameters?: string[];
      }>;
    };
    const contextById: Record<string, number> = {};
    const effortsById: Record<string, string[]> = {};
    const ids: string[] = [];
    for (const m of json.data || []) {
      const id = String(m.id || "").trim();
      if (!id) continue;
      ids.push(id);
      const ctx =
        (typeof m.context_length === "number" && m.context_length > 0
          ? m.context_length
          : undefined) ??
        (typeof m.top_provider?.context_length === "number" &&
        m.top_provider.context_length > 0
          ? m.top_provider.context_length
          : undefined);
      if (ctx) {
        contextById[id.toLowerCase()] = Math.floor(ctx);
      }
      const efforts = m.reasoning?.supported_efforts;
      if (Array.isArray(efforts) && efforts.length) {
        effortsById[id.toLowerCase()] = efforts.map(String);
      } else if (
        Array.isArray(m.supported_parameters) &&
        m.supported_parameters.includes("reasoning_effort")
      ) {
        // Generic OpenAI-compat effort when catalog omits supported_efforts
        effortsById[id.toLowerCase()] = ["low", "medium", "high", "max"];
      }
    }
    // Prefer stable sort; cap size for UX
    const unique = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    const capped = unique.slice(0, MAX_REMOTE_MODELS);
    if (capped.length) {
      writeOpenRouterModelsCache(capped, contextById, effortsById);
    }
    return capped;
  } finally {
    clearTimeout(timer);
  }
}

function isXaiChatModelId(id: string): boolean {
  const k = id.toLowerCase();
  if (!k.startsWith("grok-")) return true;
  return !/imagine|voice|tts|\bimage\b|\bvideo\b/.test(k);
}

/**
 * Fetch xAI /v1/models (best-effort; typically needs a key).
 * New flagship ids (grok-4.7, …) then show up in /model without a Forge bump.
 */
export async function fetchXaiModels(
  apiKey?: string,
  baseUrl = "https://api.x.ai/v1",
): Promise<string[]> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "forge-cli/model-catalog",
  };
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  const url = `${String(baseUrl || "https://api.x.ai/v1").replace(/\/$/, "")}/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REMOTE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers,
      signal: ac.signal,
    });
    if (!resp.ok) {
      throw new Error(`xAI models HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as {
      data?: Array<{ id?: string } | string>;
      models?: Array<{ id?: string } | string>;
    };
    const rows = json.data || json.models || [];
    const ids: string[] = [];
    for (const row of rows) {
      const id =
        typeof row === "string"
          ? row.trim()
          : String(row?.id || "").trim();
      if (!id || !isXaiChatModelId(id)) continue;
      ids.push(id);
    }
    const unique = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    const capped = unique.slice(0, MAX_REMOTE_MODELS);
    if (capped.length) {
      writeProviderModelsCache("xai", capped);
    }
    return capped;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRemoteModels(
  provider: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<string[]> {
  if (provider === "openrouter") return fetchOpenRouterModels(apiKey);
  if (provider === "xai") {
    return fetchXaiModels(apiKey, baseUrl || "https://api.x.ai/v1");
  }
  return [];
}

export interface BuildCatalogOptions {
  /** Attempt remote OpenRouter refresh (default true for openrouter). */
  refreshRemote?: boolean;
  apiKey?: string;
  /** Include stale cache even without refresh. */
  useCache?: boolean;
}

/**
 * Build a merged model catalog for a provider.
 * Order: recent → static → remote (extras not already listed).
 */
export async function buildModelCatalog(
  config: ForgeConfig,
  provider: string,
  opts: BuildCatalogOptions = {},
): Promise<ModelCatalogResult> {
  const p = String(provider || config.provider || "xai");
  const staticIds = staticModelsForProvider(config, p);
  const recent = recentModelsForProvider(p).filter(
    (m) => !staticIds.includes(m),
  );
  const freeForm = providerAllowsFreeFormModels(p);

  let remote: string[] = [];
  let remoteFetched = false;
  const wantRemote =
    opts.refreshRemote !== false && providerSupportsRemoteCatalog(p);
  const xaiBase = config.providers.xai?.baseUrl;

  if (wantRemote && !(p === "xai" && !opts.apiKey?.trim())) {
    try {
      remote = await fetchRemoteModels(p, opts.apiKey, xaiBase);
      remoteFetched = remote.length > 0;
    } catch {
      // Fall back to cache
      if (opts.useCache !== false) {
        remote = readProviderModelsCache(p) || [];
      }
    }
  } else if (providerSupportsRemoteCatalog(p) && opts.useCache !== false) {
    remote = readProviderModelsCache(p) || [];
  }

  const seen = new Set<string>();
  const models: ModelCatalogEntry[] = [];

  const push = (id: string, source: ModelCatalogEntry["source"], description?: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    models.push({ id, source, description });
  };

  for (const id of recentModelsForProvider(p)) {
    push(id, "recent", "recent");
  }
  for (const id of staticIds) {
    push(id, "static", "catalog");
  }
  // Remote extras only (avoid flooding the menu with hundreds of lines in bare /model)
  // Full remote list still available via forge models -p openrouter --refresh
  const remoteExtras = remote.filter((id) => !seen.has(id));
  // For interactive menu, only add a small slice of popular remote prefixes
  // unless caller asked for full remote via refresh with no cap — we still
  // expose all ids for tab-complete through `ids` when remoteFetched.
  const POPULAR_PREFIXES = [
    "deepseek/",
    "anthropic/",
    "openai/",
    "google/",
    "x-ai/",
    "meta-llama/",
    "qwen/",
    "mistralai/",
    "moonshotai/",
  ];
  let popularAdded = 0;
  for (const id of remoteExtras) {
    if (popularAdded >= 40) break;
    if (POPULAR_PREFIXES.some((pre) => id.startsWith(pre))) {
      push(id, "remote", "openrouter");
      popularAdded++;
    }
  }

  const allIds = [
    ...recentModelsForProvider(p),
    ...staticIds,
    ...remoteExtras,
  ];
  const ids = [...new Set(allIds.map((s) => s.trim()).filter(Boolean))];

  let note: string | undefined;
  if (freeForm) {
    note =
      p === "openrouter"
        ? "OpenRouter accepts any openrouter.ai model id (free-form). Tab completes catalog + recent + cached remote."
        : "Free-form model ids accepted for this provider.";
  }
  if (p === "xai") {
    note =
      "Newer grok-*.* ids are accepted; effort/context follow the latest known flagship " +
      "(grok-4.6 → xhigh / 500k). forge models -p xai --refresh merges the live xAI catalog.";
  }
  if (p === "openrouter" && remoteFetched) {
    note = (note ? note + " " : "") + `Remote catalog: ${remote.length} models (cached).`;
  } else if (p === "openrouter" && remote.length) {
    note = (note ? note + " " : "") + `Using cached OpenRouter catalog (${remote.length}).`;
  } else if (p === "xai" && remoteFetched) {
    note = (note ? note + " " : "") + `Remote catalog: ${remote.length} models (cached).`;
  } else if (p === "xai" && remote.length) {
    note = (note ? note + " " : "") + `Using cached xAI catalog (${remote.length}).`;
  }

  return {
    provider: p,
    models,
    ids,
    remoteFetched,
    remoteCount: remote.length,
    freeForm,
    note,
  };
}

/** Sync catalog for tab-complete (no network). */
export function buildModelCatalogSync(
  config: ForgeConfig,
  provider?: string,
): ModelCatalogResult {
  const p = String(provider || config.provider || "xai");
  const staticIds = staticModelsForProvider(config, p);
  const recent = recentModelsForProvider(p);
  const remote = providerSupportsRemoteCatalog(p)
    ? readProviderModelsCache(p) || []
    : [];
  const seen = new Set<string>();
  const models: ModelCatalogEntry[] = [];
  for (const id of recent) {
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, source: "recent", description: "recent" });
  }
  for (const id of staticIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, source: "static", description: "catalog" });
  }
  for (const id of remote.slice(0, 80)) {
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, source: "remote", description: "cached" });
  }
  return {
    provider: p,
    models,
    ids: models.map((m) => m.id),
    remoteFetched: false,
    remoteCount: remote.length,
    freeForm: providerAllowsFreeFormModels(p),
    note: providerAllowsFreeFormModels(p)
      ? "Free-form model ids accepted."
      : undefined,
  };
}
