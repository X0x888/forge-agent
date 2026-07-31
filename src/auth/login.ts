import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import open from "open";
import {
  upsertApiKey,
  upsertOAuth,
  clearCredential,
  listCredentials,
  listAccountSummaries,
} from "./store.js";
import { formatAccountsTable } from "./accounts.js";
import type { ProviderId } from "../config/types.js";
import { log } from "../util/log.js";
import { nowEpoch } from "../util/fs.js";
import {
  XAI_AUTHORIZE_URL,
  XAI_DEFAULT_REDIRECT_URI,
  XAI_DEVICE_CODE_URL,
  XAI_PUBLIC_CLIENT_ID,
  XAI_SCOPES,
  XAI_TOKEN_URL,
  emailFromIdToken,
  xaiRedirectPortFromUri,
} from "./xai-oauth.js";
import {
  COPILOT_ACCESS_TOKEN_URL,
  COPILOT_DEVICE_CODE_URL,
  COPILOT_GITHUB_CLIENT_ID,
  COPILOT_GITHUB_SCOPES,
  COPILOT_PROVIDER_ID,
  storeCopilotFromGitHubToken,
} from "./copilot.js";

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Soft-validate OpenRouter API keys. Real keys look like sk-or-v1-… and are
 * typically 60+ chars. Short sk-… pastes (DeepSeek console, truncated keys)
 * will still store, but chat returns a confusing 401 "Missing Authentication header".
 */
export function openRouterKeyFormatWarning(key: string): string | null {
  const k = key.trim();
  if (!k) return "OpenRouter API key is empty.";
  if (k.startsWith("sk-or-")) return null;
  if (/^sk-[a-f0-9]{20,}$/i.test(k) && k.length < 50) {
    return (
      "This looks like a DeepSeek platform key (sk-…), not OpenRouter (sk-or-v1-…). " +
      "Use native DeepSeek instead:\n" +
      "  forge login -p deepseek --api-key 'sk-…'\n" +
      "  forge -p deepseek -m deepseek-v4-flash\n" +
      "Or create an OpenRouter key at https://openrouter.ai/keys"
    );
  }
  if (!k.startsWith("sk-or-")) {
    return (
      "OpenRouter keys usually start with sk-or-v1-. " +
      "If chat fails with 401, regenerate at https://openrouter.ai/keys and: " +
      "forge login -p openrouter --api-key 'sk-or-v1-…'"
    );
  }
  return null;
}

/**
 * Provider OAuth / subscription profiles.
 * - xAI SuperGrok: public Grok CLI OIDC client (PKCE + optional device code)
 * - OpenAI: device-code / ChatGPT where available
 * - Others: API key only
 */
const OAUTH_PROFILES: Record<
  string,
  {
    authorizeUrl: string;
    tokenUrl: string;
    deviceCodeUrl?: string;
    clientId: string;
    scopes: string[];
    label: string;
    /** Fixed redirect (must match registered URI for public clients). */
    redirectUri?: string;
  }
> = {
  xai: {
    authorizeUrl: XAI_AUTHORIZE_URL,
    tokenUrl: XAI_TOKEN_URL,
    deviceCodeUrl: XAI_DEVICE_CODE_URL,
    clientId: XAI_PUBLIC_CLIENT_ID,
    scopes: [...XAI_SCOPES],
    label: "xAI SuperGrok / Grok (subscription OIDC)",
    redirectUri: XAI_DEFAULT_REDIRECT_URI,
  },
  openai: {
    authorizeUrl: "https://auth.openai.com/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: process.env.FORGE_OPENAI_CLIENT_ID || "app_forge_cli",
    scopes: ["openid", "profile", "email", "offline_access"],
    label: "OpenAI / ChatGPT (subscription if allowed)",
  },
  /** Device-code only (no browser redirect). See deviceCodeLogin. */
  copilot: {
    authorizeUrl: COPILOT_DEVICE_CODE_URL,
    tokenUrl: COPILOT_ACCESS_TOKEN_URL,
    deviceCodeUrl: COPILOT_DEVICE_CODE_URL,
    clientId: COPILOT_GITHUB_CLIENT_ID,
    scopes: [COPILOT_GITHUB_SCOPES],
    label: "GitHub Copilot (device code / local CLI)",
  },
};

export type LoginMethod = "api_key" | "oauth" | "device";

export async function loginInteractive(opts: {
  provider: ProviderId | string;
  method?: LoginMethod;
  apiKey?: string;
  /**
   * When true, always create a new account slot even if the same provider
   * already has credentials (multi-account). Identity match still updates
   * the same email when known.
   */
  addAccount?: boolean;
  /** Optional display label for API-key accounts. */
  accountLabel?: string;
}): Promise<{ accountId?: string; created?: boolean }> {
  const provider = String(opts.provider);
  const forceNew = Boolean(opts.addAccount);
  // Copilot has no browser redirect OAuth — default to device code.
  const method =
    opts.method ??
    (provider === COPILOT_PROVIDER_ID || provider === "copilot"
      ? "device"
      : OAUTH_PROFILES[provider]
        ? "oauth"
        : "api_key");

  if (method === "api_key") {
    let key = opts.apiKey?.trim();
    if (!key) {
      const rl = readline.createInterface({ input, output });
      const prompt =
        provider === "copilot"
          ? "Enter GitHub OAuth token for Copilot (ghu_/gho_ from VS Code or `copilot` CLI): "
          : provider === "deepseek" || provider === "ds"
            ? "Enter DeepSeek API key (sk-… from platform.deepseek.com): "
            : provider === "openrouter" || provider === "or"
              ? "Enter OpenRouter API key (sk-or-v1-… from openrouter.ai/keys): "
              : `Enter API key for ${provider}: `;
      key = (await rl.question(prompt)).trim();
      rl.close();
    }
    if (!key) throw new Error("API key is required");
    if (provider === "copilot") {
      // GitHub OAuth tokens must be exchanged for a Copilot session token.
      const result = await storeCopilotFromGitHubToken(key, {
        label: opts.accountLabel || "api-key-paste",
        forceNew,
      });
      log.success(
        `Stored GitHub Copilot session` +
          (result.expiresAt
            ? ` (expires ${new Date(result.expiresAt * 1000).toISOString()})`
            : ""),
      );
      return { accountId: result.accountId, created: result.created };
    }
    // OpenRouter keys are sk-or-v1-… (long). Short sk-… keys are DeepSeek
    // platform keys — they belong on -p deepseek, not openrouter.
    if (provider === "openrouter" || provider === "or" || provider === "router") {
      const warn = openRouterKeyFormatWarning(key);
      if (warn) log.warn(warn);
    }
    if (provider === "deepseek" || provider === "ds") {
      if (key.startsWith("sk-or-")) {
        log.warn(
          "This looks like an OpenRouter key (sk-or-v1-…). Use: forge login -p openrouter --api-key …",
        );
      }
    }
    const label =
      opts.accountLabel?.trim() ||
      (forceNew ? `api-key-${Date.now().toString(36)}` : "api-key");
    const r = upsertApiKey(provider, key, label, { forceNew });
    log.success(
      r.created
        ? `Added API key account for ${provider} (${r.accountId})`
        : `Updated API key for ${provider} (${r.accountId})`,
    );
    return r;
  }

  if (method === "device") {
    return deviceCodeLogin(provider, { forceNew });
  }

  // Copilot: browser OAuth not registered — force device.
  if (provider === "copilot") {
    return deviceCodeLogin(provider, { forceNew });
  }

  return browserOAuthLogin(provider, { forceNew });
}

async function exchangeAuthorizationCode(opts: {
  provider: string;
  profile: (typeof OAUTH_PROFILES)[string];
  code: string;
  redirectUri: string;
  verifier: string;
  forceNew?: boolean;
}): Promise<{ accountId: string; created: boolean }> {
  const { provider, profile, code, redirectUri, verifier } = opts;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: profile.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  const resp = await fetch(profile.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "forge-cli",
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `OAuth token exchange failed (${resp.status}): ${text.slice(0, 300)}`,
    );
  }

  const json = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
    token_type?: string;
  };

  if (!json.access_token) {
    throw new Error("OAuth token response missing access_token");
  }

  const email = emailFromIdToken(json.id_token);
  const accountLabel = email
    ? `grok:${email}`
    : provider === "xai"
      ? "grok:supergrok-oidc"
      : profile.label;
  // forceNew with a known email still updates that identity (same subscription);
  // forceNew only matters when identity is unknown or differs.
  const r = upsertOAuth(provider, {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? nowEpoch() + json.expires_in : undefined,
    clientId: profile.clientId,
    method: "subscription",
    subscription: profile.label,
    accountLabel,
    forceNew: opts.forceNew && !email,
  });
  log.success(
    (r.created ? `Added account on ${provider}` : `Logged in to ${provider}`) +
      ` via SuperGrok/OIDC` +
      (email ? ` (${email})` : "") +
      ` [${r.accountId}]`,
  );
  if (json.expires_in) {
    const hours = json.expires_in / 3600;
    log.dim(
      `Access token ~${hours.toFixed(1)}h; refresh_token stored for long sessions. ` +
        `Multi-day unattended: forge login --api-key · multi-account: forge login --add`,
    );
  }
  return r;
}

async function browserOAuthLogin(
  provider: string,
  opts?: { forceNew?: boolean },
): Promise<{ accountId?: string; created?: boolean }> {
  const profile = OAUTH_PROFILES[provider];
  if (!profile) {
    throw new Error(
      `Provider "${provider}" does not expose a public OAuth/subscription login. Use --api-key instead.`,
    );
  }

  const { verifier, challenge } = pkce();
  const state = base64url(randomBytes(16));
  const redirectUri =
    profile.redirectUri || `http://127.0.0.1:${8765 + Math.floor(Math.random() * 1000)}/callback`;
  const port = xaiRedirectPortFromUri(redirectUri);
  let redirectPath = "/callback";
  try {
    redirectPath = new URL(redirectUri).pathname || "/callback";
  } catch {
    redirectPath = "/callback";
  }
  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const url = new URL(profile.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", profile.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", profile.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  let activeServer: http.Server | undefined;
  let code: string;
  try {
    code = await new Promise<string>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        try {
          const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
          // Accept registered redirect path (and bare / for some providers)
          if (u.pathname !== redirectPath && u.pathname !== "/") {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
          const err = u.searchParams.get("error");
          if (err) {
            const desc = u.searchParams.get("error_description") || err;
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              `<h1>Login failed</h1><p>${escapeHtml(desc)}</p>`,
            );
            srv.close();
            reject(new Error(desc));
            return;
          }
          const gotState = u.searchParams.get("state");
          const gotCode = u.searchParams.get("code");
          if (gotState !== state || !gotCode) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<h1>Invalid callback</h1><p>Missing code or state.</p>");
            srv.close();
            reject(new Error("Invalid OAuth callback"));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<h1>Forge login complete</h1><p>You can close this tab and return to the terminal.</p>",
          );
          srv.close();
          resolve(gotCode);
        } catch (e) {
          reject(e);
        }
      });
      activeServer = srv;

      srv.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && provider === "xai") {
          reject(
            new Error(
              `Port ${port} is busy (needed for SuperGrok callback ${redirectUri}). ` +
                `Stop the other process or use: forge login --device`,
            ),
          );
          return;
        }
        reject(e);
      });

      srv.listen(port, "127.0.0.1", () => {
        log.info(`Opening browser for ${profile.label}…`);
        log.dim(`Callback: ${redirectUri}`);
        log.dim(`If the browser does not open, visit:\n${url.toString()}`);
        open(url.toString()).catch(() => {
          /* ignore */
        });
      });

      setTimeout(() => {
        srv.close();
        reject(new Error("OAuth login timed out (5 minutes)"));
      }, 5 * 60 * 1000);
    });
  } catch (err) {
    activeServer?.close();
    const msg = (err as Error).message || String(err);
    // Graceful degradation for misconfigured / blocked OAuth
    if (provider === "xai") {
      log.warn(`SuperGrok browser OIDC failed: ${msg}`);
      log.info(
        "Try: forge login --device   (headless) · forge login --from-grok   · forge login --api-key",
      );
    }
    throw err;
  }

  try {
    return await exchangeAuthorizationCode({
      provider,
      profile,
      code,
      redirectUri,
      verifier,
      forceNew: opts?.forceNew,
    });
  } catch (err) {
    log.warn((err as Error).message);
    if (provider === "xai") {
      log.info(
        "Falling back: forge login --from-grok (if Grok Build is logged in) or --api-key",
      );
      throw err;
    }
    log.info(`Falling back to API key paste for ${provider}.`);
    return loginInteractive({
      provider,
      method: "api_key",
      addAccount: opts?.forceNew,
    });
  }
}

/**
 * Device-code flow for headless / SSH (RFC 8628).
 * SuperGrok: https://auth.x.ai/oauth2/device/code
 * Copilot:   https://github.com/login/device/code (JSON body)
 */
async function deviceCodeLogin(
  provider: string,
  opts?: { forceNew?: boolean },
): Promise<{ accountId?: string; created?: boolean }> {
  const profile = OAUTH_PROFILES[provider];
  if (!profile) {
    throw new Error(`No device-code profile for ${provider}. Use --api-key.`);
  }

  const isCopilot = provider === "copilot";
  const deviceUrl =
    process.env.FORGE_DEVICE_AUTH_URL?.trim() ||
    process.env.GITHUB_COPILOT_DEVICE_CODE_URL?.trim() ||
    profile.deviceCodeUrl ||
    profile.authorizeUrl.replace("/authorize", "/device/code");
  const tokenUrl =
    (isCopilot && process.env.GITHUB_COPILOT_ACCESS_TOKEN_URL?.trim()) ||
    profile.tokenUrl;

  // GitHub device endpoint expects JSON; SuperGrok/OIDC use form-urlencoded.
  const start = await fetch(deviceUrl, {
    method: "POST",
    headers: isCopilot
      ? {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "forge-cli",
        }
      : {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "forge-cli",
        },
    body: isCopilot
      ? JSON.stringify({
          client_id: profile.clientId,
          scope: profile.scopes.join(" "),
        })
      : new URLSearchParams({
          client_id: profile.clientId,
          scope: profile.scopes.join(" "),
        }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!start.ok) {
    const text = await start.text().catch(() => "");
    log.warn(
      `Device-code start failed (${start.status}): ${text.slice(0, 200)}`,
    );
    if (provider === "xai") {
      throw new Error(
        "SuperGrok device login unavailable. Use forge login (browser) or --api-key / --from-grok.",
      );
    }
    if (isCopilot) {
      throw new Error(
        "GitHub Copilot device login unavailable. Try: forge login --from-copilot · forge login -p copilot --api-key",
      );
    }
    log.warn("Falling back to API key.");
    return loginInteractive({
      provider,
      method: "api_key",
      addAccount: opts?.forceNew,
    });
  }

  const dc = (await start.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };

  log.info(`Open ${dc.verification_uri_complete || dc.verification_uri}`);
  log.info(`Enter code: ${dc.user_code}`);
  if (dc.verification_uri_complete || dc.verification_uri) {
    await open(dc.verification_uri_complete || dc.verification_uri).catch(
      () => undefined,
    );
  }

  const interval = Math.max(3, dc.interval ?? 5) * 1000;
  const deadline = Date.now() + (dc.expires_in ?? 600) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const poll = await fetch(tokenUrl, {
      method: "POST",
      headers: isCopilot
        ? {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "forge-cli",
          }
        : {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": "forge-cli",
          },
      body: isCopilot
        ? JSON.stringify({
            client_id: profile.clientId,
            device_code: dc.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          })
        : new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: dc.device_code,
            client_id: profile.clientId,
          }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await poll.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      id_token?: string;
      error?: string;
      error_description?: string;
    };
    if (json.access_token) {
      if (isCopilot) {
        const result = await storeCopilotFromGitHubToken(json.access_token, {
          label: "device-oauth",
          forceNew: opts?.forceNew,
        });
        log.success(
          `Device login complete for GitHub Copilot` +
            (result.expiresAt
              ? ` (session expires ${new Date(result.expiresAt * 1000).toISOString()})`
              : ""),
        );
        return { accountId: result.accountId, created: result.created };
      }
      const email = emailFromIdToken(json.id_token);
      const accountLabel = email
        ? `grok:${email}`
        : provider === "xai"
          ? "grok:supergrok-device"
          : profile.label;
      const r = upsertOAuth(provider, {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: json.expires_in ? nowEpoch() + json.expires_in : undefined,
        clientId: profile.clientId,
        method: "subscription",
        subscription: profile.label,
        accountLabel,
        forceNew: opts?.forceNew && !email,
      });
      log.success(
        `Device login complete for ${provider}` +
          (email ? ` (${email})` : "") +
          ` [${r.accountId}]`,
      );
      return r;
    }
    if (json.error === "authorization_pending" || json.error === "slow_down") {
      continue;
    }
    if (json.error) {
      throw new Error(
        `Device login failed: ${json.error_description || json.error}`,
      );
    }
  }
  throw new Error("Device login timed out");
}

export function logout(provider?: string): void {
  if (provider) {
    clearCredential(provider);
    log.success(`Cleared credentials for ${provider}`);
  } else {
    for (const c of listCredentials()) clearCredential(c.provider);
    log.success("Cleared all stored credentials");
  }
}

export function printAuthStatus(): void {
  // One consistent multi-account table with readiness (same as forge accounts).
  const accounts = listAccountSummaries();
  if (accounts.length === 0) {
    log.info("No stored credentials. Run: forge login");
    return;
  }
  console.log(formatAccountsTable());
}

export function supportsOAuth(provider: string): boolean {
  return Boolean(OAUTH_PROFILES[provider]);
}

/** Exported for tests / diagnostics. */
export function getOAuthProfile(provider: string) {
  return OAUTH_PROFILES[provider] ?? null;
}
