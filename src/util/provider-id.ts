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
  "cursor",
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
  "cursor-ai": "cursor",
  cursorai: "cursor",
  "cursor-cli": "cursor",
  anysphere: "cursor",
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
  return "xai|anthropic|openai|openrouter|deepseek|google|copilot|cursor|custom (aliases: claude|gpt|oai|ds|gemini|github-copilot|cursor-ai|…)";
}

/** Live `/provider <name>` result — not the bare catalog peek. */
export function formatProviderSwitchCard(input: {
  to: string;
  model: string;
  from?: string;
  already?: boolean;
  ctx?: string;
  note?: string;
  needsAuth?: boolean;
}): string {
  const lines = [`provider  ·  ${input.to}`];
  if (input.already) {
    lines.push(`  already on  ·  ${input.model}`);
  } else if (input.from && input.from !== input.to) {
    lines.push(`  ${input.from} → ${input.to}  ·  ${input.model}`);
  } else {
    lines.push(`  ${input.model}`);
  }
  const ctx = input.ctx?.trim();
  if (ctx) lines.push(`  ctx ${ctx}`);
  const note = input.note?.trim();
  if (note) lines.push(`  ${note}`);
  lines.push(`Next  ${input.needsAuth ? "/auth" : "/model"}`);
  return lines.join("\n");
}
