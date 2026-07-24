/**
 * OAuth refresh-token support (production long-session reliability).
 *
 * When a stored credential has refreshToken + expiresAt, proactively exchange
 * before the access token dies — experts leave Forge open for hours.
 */

import {
  getCredential,
  isExpired,
  upsertOAuth,
} from "./store.js";
import type { StoredCredential } from "./types.js";
import { nowEpoch } from "../util/fs.js";
import { log } from "../util/log.js";

/** Same profiles as login — kept local to avoid circular imports. */
const TOKEN_URLS: Record<string, { tokenUrl: string; clientId: string }> = {
  xai: {
    tokenUrl: "https://auth.x.ai/oauth/token",
    clientId: process.env.FORGE_XAI_CLIENT_ID || "forge-cli",
  },
  openai: {
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: process.env.FORGE_OPENAI_CLIENT_ID || "app_forge_cli",
  },
};

export interface RefreshResult {
  ok: boolean;
  credential?: StoredCredential;
  error?: string;
  /** true when a network refresh was performed */
  refreshed: boolean;
}

/**
 * If credential is OAuth/subscription with a refresh token and is expired
 * (or within skew), exchange refresh_token for a new access token.
 */
export async function refreshCredentialIfNeeded(
  provider: string,
  opts?: { force?: boolean; skewSec?: number },
): Promise<RefreshResult> {
  const cred = getCredential(provider);
  if (!cred) return { ok: false, error: "no credential", refreshed: false };
  if (cred.method === "api_key") {
    return { ok: true, credential: cred, refreshed: false };
  }
  if (!cred.refreshToken) {
    if (isExpired(cred, opts?.skewSec ?? 120)) {
      return {
        ok: false,
        error: "token expired and no refresh_token stored — run forge login",
        refreshed: false,
      };
    }
    return { ok: true, credential: cred, refreshed: false };
  }

  const needs =
    opts?.force || isExpired(cred, opts?.skewSec ?? 120) || !cred.expiresAt;
  if (!needs) {
    return { ok: true, credential: cred, refreshed: false };
  }

  const profile = TOKEN_URLS[provider];
  if (!profile) {
    return {
      ok: false,
      error: `no refresh endpoint configured for ${provider}`,
      refreshed: false,
    };
  }

  try {
    const resp = await fetch(profile.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: cred.refreshToken,
        client_id: profile.clientId,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        error: `refresh failed ${resp.status}: ${text.slice(0, 200)}`,
        refreshed: false,
      };
    }
    const json = (await resp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      return { ok: false, error: "refresh response missing access_token", refreshed: false };
    }
    upsertOAuth(provider, {
      accessToken: json.access_token,
      refreshToken: json.refresh_token || cred.refreshToken,
      expiresAt: json.expires_in
        ? nowEpoch() + json.expires_in
        : cred.expiresAt,
      method: cred.method,
      subscription: cred.subscription,
      accountLabel: cred.accountLabel,
    });
    const updated = getCredential(provider);
    log.dim(`Refreshed OAuth token for ${provider}`);
    return { ok: true, credential: updated, refreshed: true };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      refreshed: false,
    };
  }
}

/** True when error looks like an expired / invalid bearer token. */
export function isAuthFailureMessage(msg: string): boolean {
  return /\b(401|403)\b/.test(msg) ||
    /invalid[_\s-]?api[_\s-]?key|invalid[_\s-]?token|expired[_\s-]?token|unauthorized|authentication|not authenticated|invalid_grant/i.test(
      msg,
    );
}
