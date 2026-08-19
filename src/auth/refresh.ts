/**
 * OAuth refresh-token support (production long-session reliability).
 *
 * When a stored credential has refreshToken + expiresAt, proactively exchange
 * before the access token dies — experts leave Forge open for hours.
 */

import {
  accountToStored,
  getActiveAccount,
  getCredential,
  isExpired,
  patchAccount,
  upsertOAuth,
} from "./store.js";
import type { StoredCredential } from "./types.js";
import { nowEpoch } from "../util/fs.js";
import { log } from "../util/log.js";

import { XAI_PUBLIC_CLIENT_ID, XAI_TOKEN_URL } from "./xai-oauth.js";

/** Same profiles as login — kept local to avoid circular imports. */
const TOKEN_URLS: Record<string, { tokenUrl: string; clientId: string }> = {
  xai: {
    // SuperGrok / Grok CLI OIDC discovery token endpoint
    tokenUrl: XAI_TOKEN_URL,
    clientId: XAI_PUBLIC_CLIENT_ID,
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
  // Resolve the full account so the refresh can target THIS account id —
  // upsertOAuth without an id falls back to "exactly one same-method
  // account", which silently creates a duplicate on every refresh when 2+
  // label-less OAuth accounts exist for the provider.
  const account = getActiveAccount(provider);
  if (!account) return { ok: false, error: "no credential", refreshed: false };
  const cred = accountToStored(account);
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

  // Default skew 10 minutes — multi-hour SuperGrok tokens should refresh
  // before the provider rejects mid-turn (not only after 401).
  const skew = opts?.skewSec ?? 600;
  const needs =
    opts?.force || isExpired(cred, skew) || !cred.expiresAt;
  if (!needs) {
    return { ok: true, credential: cred, refreshed: false };
  }

  // Cursor: refreshToken is the loginDeepControl refresh token; "refresh"
  // POSTs it as Bearer to /auth/exchange_user_api_key.
  if (provider === "cursor") {
    try {
      const { refreshCursorSession } = await import("./cursor.js");
      const session = await refreshCursorSession(cred.refreshToken);
      upsertOAuth(provider, {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken || cred.refreshToken,
        expiresAt: session.expiresAt,
        clientId: cred.clientId || "cursor-cli",
        method: cred.method,
        subscription: cred.subscription || "Cursor",
        accountLabel: cred.accountLabel,
        accountId: account.id,
      });
      const updated = getCredential(provider);
      log.dim(`Refreshed Cursor session token`);
      return { ok: true, credential: updated, refreshed: true };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        refreshed: false,
      };
    }
  }

  // GitHub Copilot: refreshToken is a long-lived GitHub OAuth token; "refresh"
  // re-exchanges it at /copilot_internal/v2/token for a new session token.
  if (provider === "copilot") {
    try {
      const { refreshCopilotSession, COPILOT_GITHUB_CLIENT_ID } = await import(
        "./copilot.js"
      );
      const session = await refreshCopilotSession(cred.refreshToken);
      upsertOAuth(provider, {
        accessToken: session.accessToken,
        refreshToken: cred.refreshToken,
        expiresAt: session.expiresAt,
        clientId: cred.clientId || COPILOT_GITHUB_CLIENT_ID,
        method: cred.method,
        subscription: cred.subscription || "GitHub Copilot",
        accountLabel: cred.accountLabel,
        accountId: account.id,
      });
      const updated = getCredential(provider);
      log.dim(`Refreshed Copilot session token`);
      return { ok: true, credential: updated, refreshed: true };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        refreshed: false,
      };
    }
  }

  const profile = TOKEN_URLS[provider];
  // Prefer the client_id that issued the session (Grok CLI / SuperGrok OIDC).
  const clientId =
    cred.clientId?.trim() ||
    process.env.FORGE_XAI_CLIENT_ID?.trim() ||
    profile?.clientId;
  if (!profile || !clientId) {
    return {
      ok: false,
      error: `no refresh endpoint configured for ${provider}`,
      refreshed: false,
    };
  }

  try {
    const resp = await fetch(profile.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "forge-cli",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: cred.refreshToken,
        client_id: clientId,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      // Permanent grant death — drop refresh_token so doctor/auth can surface
      // "re-login required" instead of looking healthy with a dead RT.
      if (
        resp.status === 400 ||
        resp.status === 401 ||
        /invalid_grant|revoked|expired/i.test(text)
      ) {
        try {
          // Patch by account id — the clear must hit the account that was
          // actually refreshed, never an identity/active-account guess.
          patchAccount(account.id, { clearRefreshToken: true });
          log.warn(
            `OAuth refresh_token for ${provider} rejected — re-login required (forge login)`,
          );
        } catch {
          /* best-effort */
        }
      }
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
    // When the token endpoint omits expires_in, never keep a *past* expiresAt —
    // that left resolveAuth treating a freshly rotated bearer as expired, so
    // mid-run 401 recovery threw while the next user "continue" (proactive
    // path uses credential.accessToken directly) appeared to "just work".
    const DEFAULT_ACCESS_TTL_SEC = 3600;
    const now = nowEpoch();
    let nextExpires: number | undefined;
    if (
      typeof json.expires_in === "number" &&
      Number.isFinite(json.expires_in) &&
      json.expires_in > 0
    ) {
      nextExpires = now + Math.floor(json.expires_in);
    } else if (cred.expiresAt && cred.expiresAt > now) {
      nextExpires = cred.expiresAt;
    } else {
      nextExpires = now + DEFAULT_ACCESS_TTL_SEC;
    }
    upsertOAuth(provider, {
      accessToken: json.access_token,
      refreshToken: json.refresh_token || cred.refreshToken,
      expiresAt: nextExpires,
      clientId,
      method: cred.method,
      subscription: cred.subscription,
      accountLabel: cred.accountLabel,
      accountId: account.id,
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

/**
 * True when a message looks like an expired / invalid bearer token.
 * Includes SuperGrok's 403 phrasing: "OAuth2 access token could not be validated".
 */
export function isAuthFailureMessage(msg: string): boolean {
  return (
    /\b(401|403)\b/.test(msg) ||
    /invalid[_\s-]?api[_\s-]?key|invalid[_\s-]?token|expired[_\s-]?token|unauthorized|authentication|not authenticated|invalid_grant|could not be validated|oauth2 access token|auth_forbidden|token.*(invalid|expired|revoked|denied)/i.test(
      msg,
    )
  );
}

/**
 * True when a provider error should trigger mid-run OAuth refresh / multi-account
 * auth failover — not quota/rate-limit (those use switchOnQuotaFailure).
 *
 * Critical: xAI SuperGrok often returns **HTTP 403** (not 401) when the access
 * token is dead, with body "The OAuth2 access token could not be validated".
 * Treating only 401 as auth-fail made long ULW runs die mid-wave even when a
 * refresh_token (or second SuperGrok account) could have continued unattended.
 */
export function isTokenAuthFailure(err: unknown): boolean {
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status: unknown }).status)
      : 0;
  const body =
    err && typeof err === "object" && "body" in err
      ? String((err as { body: unknown }).body ?? "")
      : "";
  const msg =
    (err instanceof Error ? err.message : String(err ?? "")) +
    (body ? ` ${body}` : "");

  // Quota / billing 403s must stay on the multi-account quota path, not burn
  // auth recovery slots or force-refresh a healthy token.
  const quotaLike =
    /quota|rate.?limit|usage.?limit|credit|billing|payment|exceeded|capacity|resource.?exhausted|too many requests|plan.?limit|over.?limit|insufficient[_\s-]?quota/i.test(
      msg,
    ) &&
    !/token|oauth|invalid_grant|validated|unauthorized|not authenticated|auth_forbidden/i.test(
      msg,
    );
  if (status === 403 && quotaLike) return false;
  if (status === 402 && quotaLike) return false;

  if (status === 401) return true;

  // 403 + token/oauth rejection (SuperGrok mid-run token death)
  if (status === 403) {
    if (
      /oauth|access.?token|token.*(validat|expir|invalid|revok|denied)|could not be validated|auth_forbidden|unauthorized|not authenticated|invalid_grant|invalid[_\s-]?token|bearer|forbidden/i.test(
        msg,
      )
    ) {
      return true;
    }
  }

  return isAuthFailureMessage(msg) && !quotaLike;
}
