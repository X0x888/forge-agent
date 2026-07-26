/**
 * SuperGrok / xAI public OIDC (same public client used by Grok Build CLI
 * and many third-party tools: OpenCode plugins, Hermes, OpenClaw, pi, …).
 *
 * This is a public desktop client_id (PKCE, no secret). xAI may change
 * registration; override via FORGE_XAI_CLIENT_ID / FORGE_XAI_REDIRECT_URI.
 *
 * OIDC discovery: https://auth.x.ai/.well-known/openid-configuration
 */

/** Public Grok CLI OIDC client (not a secret). */
export const XAI_PUBLIC_CLIENT_ID =
  process.env.FORGE_XAI_CLIENT_ID?.trim() ||
  "b1a00492-073a-47ea-816f-4c329264a828";

/** Registered loopback callback used by Grok CLI / third-party clients. */
export const XAI_DEFAULT_REDIRECT_PORT = 56121;

export const XAI_DEFAULT_REDIRECT_URI =
  process.env.FORGE_XAI_REDIRECT_URI?.trim() ||
  `http://127.0.0.1:${XAI_DEFAULT_REDIRECT_PORT}/callback`;

export const XAI_AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";

/**
 * Scopes for SuperGrok subscription-backed CLI access.
 * offline_access → refresh_token; grok-cli:access / api:access → API use.
 */
export const XAI_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
] as const;

export function xaiRedirectPortFromUri(uri: string): number {
  try {
    const u = new URL(uri);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return XAI_DEFAULT_REDIRECT_PORT;
  }
}

/** Best-effort email from OIDC id_token payload (no verify — display only). */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken || typeof idToken !== "string") return undefined;
  try {
    const parts = idToken.split(".");
    if (parts.length < 2) return undefined;
    const json = Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const payload = JSON.parse(json) as { email?: string };
    const email = payload.email?.trim();
    return email || undefined;
  } catch {
    return undefined;
  }
}
