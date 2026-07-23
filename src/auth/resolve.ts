import type { ForgeConfig, ProviderId } from "../config/types.js";
import { getCredential, isExpired } from "./store.js";
import type { ResolvedAuth } from "./types.js";

const ENV_KEYS: Record<string, string[]> = {
  xai: ["XAI_API_KEY", "GROK_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  custom: ["FORGE_API_KEY"],
};

/**
 * Resolve credentials with precedence:
 * 1. Environment API keys for the active provider
 * 2. Stored OAuth/subscription tokens (if not expired)
 * 3. Stored API keys
 *
 * Note: interactive OAuth/subscription tokens take precedence over stored
 * API keys only when no env key is set — matching Grok's "session first,
 * API key fallback" pattern, inverted here so CI env keys always win.
 */
export function resolveAuth(
  config: ForgeConfig,
  providerOverride?: string,
): ResolvedAuth | null {
  const provider = (providerOverride ?? config.provider) as ProviderId | string;
  const pcfg = config.providers[provider];
  const baseUrl = config.baseUrl ?? pcfg?.baseUrl;

  // 1. Environment
  const envNames = [
    ...(ENV_KEYS[provider] ?? []),
    ...(pcfg?.apiKeyEnv ? [pcfg.apiKeyEnv] : []),
    "FORGE_API_KEY",
  ];
  for (const name of envNames) {
    const v = process.env[name]?.trim();
    if (v) {
      return {
        provider,
        method: "api_key",
        token: v,
        baseUrl,
        accountLabel: `env:${name}`,
      };
    }
  }

  // 2. Stored credentials
  const cred = getCredential(provider);
  if (cred) {
    if (cred.method === "api_key") {
      return {
        provider,
        method: "api_key",
        token: cred.accessToken,
        baseUrl,
        accountLabel: cred.accountLabel,
      };
    }
    // OAuth / subscription
    if (!isExpired(cred)) {
      return {
        provider,
        method: cred.method,
        token: cred.accessToken,
        baseUrl,
        accountLabel: cred.accountLabel ?? cred.subscription,
      };
    }
    // Expired — try refresh is handled by login flow; treat as missing
  }

  // 3. Fallback: any other env key the user might have (auto-detect)
  for (const [pid, names] of Object.entries(ENV_KEYS)) {
    for (const name of names) {
      const v = process.env[name]?.trim();
      if (v) {
        return {
          provider: pid,
          method: "api_key",
          token: v,
          baseUrl: config.providers[pid]?.baseUrl ?? baseUrl,
          accountLabel: `env:${name}`,
        };
      }
    }
  }

  return null;
}

export function describeAuth(auth: ResolvedAuth | null): string {
  if (!auth) return "not authenticated";
  const label = auth.accountLabel ? ` (${auth.accountLabel})` : "";
  return `${auth.provider} via ${auth.method}${label}`;
}
