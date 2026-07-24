import type { ForgeConfig, ProviderId } from "../config/types.js";
import { getCredential, isExpired } from "./store.js";
import type { ResolvedAuth } from "./types.js";
import { readGrokXaiSession } from "./import-grok.js";
import { nowEpoch } from "../util/fs.js";
import { refreshCredentialIfNeeded } from "./refresh.js";
import { log } from "../util/log.js";

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
 * 4. Live Grok Build session (~/.grok/auth.json) when provider is xai
 * 5. Any other provider env key (auto-detect)
 *
 * CI env keys always win so automation stays deterministic.
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
    // Expired — try live Grok session below for xai
  }

  // 3. Reuse Grok Build subscription session for xAI
  if (provider === "xai" || provider === "grok") {
    const grok = readGrokXaiSession();
    if (grok && (!grok.expiresAt || grok.expiresAt > nowEpoch())) {
      return {
        provider: "xai",
        method: "subscription",
        token: grok.accessToken,
        baseUrl: baseUrl ?? "https://api.x.ai/v1",
        accountLabel: grok.email
          ? `grok:${grok.email}`
          : "grok:~/.grok/auth.json",
      };
    }
  }

  // 4. Fallback: any other env key the user might have (auto-detect)
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

/**
 * Resolve auth, proactively refreshing OAuth/subscription tokens when expired.
 * Prefer this over resolveAuth() at session start and before long headless runs.
 *
 * Order when the stored session is stale:
 * 1. Env API keys (never expire in-process)
 * 2. OAuth refresh_token exchange (if network + client_id allow)
 * 3. Re-import a live Grok Build session from ~/.grok/auth.json (xAI)
 * 4. Fall through to resolveAuth (may still use non-expired Grok live read)
 */
export async function resolveAuthFresh(
  config: ForgeConfig,
  providerOverride?: string,
): Promise<ResolvedAuth | null> {
  const provider = (providerOverride ?? config.provider) as string;

  // Env keys never need refresh
  const envFirst = resolveAuth(config, providerOverride);
  if (envFirst?.method === "api_key" && envFirst.accountLabel?.startsWith("env:")) {
    return envFirst;
  }

  // Try refresh for the active provider's stored credential
  const refreshed = await refreshCredentialIfNeeded(provider);
  if (refreshed.refreshed) {
    log.info(`OAuth token refreshed for ${provider}`);
  } else if (!refreshed.ok && refreshed.error) {
    // SuperGrok refresh is often blocked (CF/client); try Grok file next.
    if (/expired|refresh failed|no refresh/i.test(refreshed.error)) {
      log.dim(`Auth refresh for ${provider}: ${refreshed.error}`);
    }
  }

  // If still expired/missing for xAI, pull the newest ~/.grok session (6h TTL,
  // but Grok Build keeps it warm while you use Grok — same as local sessions).
  if (provider === "xai" || provider === "grok") {
    const after = resolveAuth(config, providerOverride);
    const cred = getCredential("xai");
    const needGrok =
      !after ||
      (cred &&
        cred.method !== "api_key" &&
        isExpired(cred, 120) &&
        after.method !== "api_key");
    if (needGrok || !after) {
      try {
        const { importGrokCredentials } = await import("./import-grok.js");
        const imp = importGrokCredentials();
        if (imp.imported) {
          log.info(
            `Re-imported Grok session${imp.email ? ` (${imp.email})` : ""}${
              imp.expiresAt
                ? ` — expires ${new Date(imp.expiresAt * 1000).toISOString()}`
                : ""
            }`,
          );
        }
      } catch {
        /* import is best-effort */
      }
    }
  }

  return resolveAuth(config, providerOverride);
}
