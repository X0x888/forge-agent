/**
 * Canonical provider ids + expert aliases (CLI -p and FORGE_PROVIDER).
 */
import type { ProviderId } from "../config/types.js";

export const PROVIDER_IDS = [
  "xai",
  "grok",
  "anthropic",
  "openai",
  "openrouter",
  "deepseek",
  "google",
  "copilot",
  "custom",
] as const;

export type ProviderIdToken = (typeof PROVIDER_IDS)[number];

/** Friendly aliases experts type at -p / FORGE_PROVIDER. */
export const PROVIDER_ALIASES: Record<string, ProviderIdToken> = {
  claude: "anthropic",
  sonnet: "anthropic",
  opus: "anthropic",
  haiku: "anthropic",
  gpt: "openai",
  chatgpt: "openai",
  oai: "openai",
  "openai-api": "openai",
  gemini: "google",
  palm: "google",
  bard: "google",
  or: "openrouter",
  router: "openrouter",
  ds: "deepseek",
  "deepseek-api": "deepseek",
  "github-copilot": "copilot",
  github_copilot: "copilot",
  "gh-copilot": "copilot",
  github: "copilot",
  gh: "copilot",
};

export type NormalizeProviderResult =
  | { ok: true; provider: ProviderId }
  | { ok: false; raw: string };

/**
 * Normalize a provider token to a canonical ProviderId.
 * Accepts stock ids + aliases; maps grok → xai.
 */
export function normalizeProviderId(raw: unknown): NormalizeProviderResult {
  if (raw == null) return { ok: false, raw: "" };
  const s = String(raw).trim().toLowerCase();
  if (!s) return { ok: false, raw: String(raw) };
  const mapped = PROVIDER_ALIASES[s] || (s as ProviderIdToken);
  if (!(PROVIDER_IDS as readonly string[]).includes(mapped)) {
    return { ok: false, raw: s };
  }
  const provider = (mapped === "grok" ? "xai" : mapped) as ProviderId;
  return { ok: true, provider };
}

export function providerIdHelp(): string {
  return "xai|anthropic|openai|openrouter|deepseek|google|copilot|custom (aliases: claude|gpt|oai|ds|gemini|github-copilot|…)";
}
