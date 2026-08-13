import { DEFAULT_CONFIG, type ForgeConfig } from "./types.js";
import { staticModelsForProvider } from "./model-catalog.js";

/** Conservative same-provider fallbacks when the flagship is 429/5xx/unavailable. */
const DEFAULT_FALLBACKS: Record<string, readonly string[]> = {
  xai: ["grok-4.5", "grok-4"],
  anthropic: ["claude-sonnet-4-20250514", "claude-haiku-4-20250414"],
  openai: ["gpt-4.1", "gpt-4o"],
  openrouter: ["anthropic/claude-sonnet-4", "openai/gpt-4.1"],
  deepseek: ["deepseek-chat"],
  google: ["gemini-2.5-flash"],
  copilot: ["gpt-4.1"],
};

export function parseFallbackModels(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const out = raw
      .map((x) => String(x ?? "").trim())
      .filter(Boolean);
    return out.length ? [...new Set(out)] : [];
  }
  const s = String(raw).trim();
  if (!s) return undefined;
  if (s === "0" || /^(off|none|false|no)$/i.test(s)) return [];
  const parts = [...new Set(s.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean))];
  return parts.length ? parts : undefined;
}

/** Human-readable chain for /status, /share, doctor, run JSON. */
export function formatFallbackChain(
  config: Pick<ForgeConfig, "provider" | "model" | "fallbackModels">,
): string {
  if (config.fallbackModels === undefined) {
    const next = nextFallbackModel(config);
    return next ? `defaults → ${next}` : "defaults (none)";
  }
  if (config.fallbackModels.length === 0) return "off";
  return config.fallbackModels.join(" → ");
}

export function defaultFallbackModels(
  provider: string,
  currentModel: string,
): string[] {
  const chain = DEFAULT_FALLBACKS[String(provider)] ?? [];
  const cur = currentModel.trim();
  return chain.filter((m) => m && m !== cur);
}

/**
 * Next same-provider model after the current one has exhausted retries.
 * Prefers explicit `config.fallbackModels`; empty array means disabled.
 * Undefined config uses conservative catalog defaults (never the current model).
 */
export function nextFallbackModel(
  config: Pick<ForgeConfig, "provider" | "model" | "fallbackModels">,
  opts?: { tried?: Iterable<string> },
): string | undefined {
  const tried = new Set(
    [...(opts?.tried ?? []), config.model].map((m) => m.trim()).filter(Boolean),
  );
  const explicit = config.fallbackModels;
  const chain =
    explicit === undefined
      ? defaultFallbackModels(String(config.provider), config.model)
      : explicit;
  const known = new Set(
    staticModelsForProvider(DEFAULT_CONFIG, String(config.provider)),
  );
  const allowUnknown = known.size === 0 || explicit !== undefined;
  for (const raw of chain) {
    const id = String(raw ?? "").trim();
    if (!id || tried.has(id)) continue;
    if (!allowUnknown && !known.has(id)) continue;
    return id;
  }
  return undefined;
}

export function isModelFallbackWorthy(err: unknown): boolean {
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  if (status === 401 || status === 403) return false;
  if (status === 429 || status === 408 || status === 529) return true;
  if (status >= 500 && status < 600) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/oauth2 access token|invalid.?api.?key|unauthorized|insufficient.?quota|billing|credit/i.test(msg)) {
    return false;
  }
  return /overloaded|unavailable|capacity|high demand|try again later|temporarily|service.?unavailable|too many requests|rate.?limit/i.test(
    msg,
  );
}
