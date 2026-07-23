import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import open from "open";
import { upsertApiKey, upsertOAuth, clearCredential, listCredentials } from "./store.js";
import type { ProviderId } from "../config/types.js";
import { log } from "../util/log.js";
import { nowEpoch } from "../util/fs.js";

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
 * Provider OAuth / subscription profiles.
 * - xAI: browser OAuth at auth.x.ai (subscription-style session token)
 * - OpenAI: device-code / ChatGPT subscription where available
 * - Others: API key only (subscription not exposed via public OAuth)
 */
const OAUTH_PROFILES: Record<
  string,
  {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes: string[];
    label: string;
  }
> = {
  xai: {
    authorizeUrl: "https://auth.x.ai/authorize",
    tokenUrl: "https://auth.x.ai/oauth/token",
    clientId: process.env.FORGE_XAI_CLIENT_ID || "forge-cli",
    scopes: ["openid", "profile", "email", "offline_access"],
    label: "xAI / Grok (subscription or account)",
  },
  openai: {
    authorizeUrl: "https://auth.openai.com/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: process.env.FORGE_OPENAI_CLIENT_ID || "app_forge_cli",
    scopes: ["openid", "profile", "email", "offline_access"],
    label: "OpenAI / ChatGPT (subscription if allowed)",
  },
};

export type LoginMethod = "api_key" | "oauth" | "device";

export async function loginInteractive(opts: {
  provider: ProviderId | string;
  method?: LoginMethod;
  apiKey?: string;
}): Promise<void> {
  const method = opts.method ?? (OAUTH_PROFILES[opts.provider] ? "oauth" : "api_key");

  if (method === "api_key") {
    let key = opts.apiKey?.trim();
    if (!key) {
      const rl = readline.createInterface({ input, output });
      key = (await rl.question(`Enter API key for ${opts.provider}: `)).trim();
      rl.close();
    }
    if (!key) throw new Error("API key is required");
    upsertApiKey(opts.provider, key);
    log.success(`Stored API key for ${opts.provider} in ~/.forge/auth.json`);
    return;
  }

  if (method === "device") {
    await deviceCodeLogin(opts.provider);
    return;
  }

  await browserOAuthLogin(opts.provider);
}

async function browserOAuthLogin(provider: string): Promise<void> {
  const profile = OAUTH_PROFILES[provider];
  if (!profile) {
    throw new Error(
      `Provider "${provider}" does not expose a public OAuth/subscription login. Use --api-key instead.`,
    );
  }

  const { verifier, challenge } = pkce();
  const state = base64url(randomBytes(16));
  const port = 8765 + Math.floor(Math.random() * 1000);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const url = new URL(profile.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", profile.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", profile.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        if (u.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const err = u.searchParams.get("error");
        if (err) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Login failed</h1><p>${err}</p>`);
          server.close();
          reject(new Error(err));
          return;
        }
        const gotState = u.searchParams.get("state");
        const gotCode = u.searchParams.get("code");
        if (gotState !== state || !gotCode) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Invalid callback</h1>");
          server.close();
          reject(new Error("Invalid OAuth callback"));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Forge login complete</h1><p>You can close this tab.</p>");
        server.close();
        resolve(gotCode);
      } catch (e) {
        reject(e);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      log.info(`Opening browser for ${profile.label}…`);
      log.dim(`If the browser does not open, visit:\n${url.toString()}`);
      open(url.toString()).catch(() => {
        /* ignore */
      });
    });
    server.on("error", reject);
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth login timed out (5 minutes)"));
    }, 5 * 60 * 1000);
  });

  // Exchange code for tokens
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: profile.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  const resp = await fetch(profile.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    // Graceful degradation: many providers require registered client IDs.
    // Fall back to instructing the user to paste a token / use API key.
    log.warn(
      `OAuth token exchange failed (${resp.status}). Provider may require a registered client ID.`,
    );
    log.dim(text.slice(0, 400));
    log.info(
      `Falling back to API key / personal access token paste for ${provider}.`,
    );
    await loginInteractive({ provider, method: "api_key" });
    return;
  }

  const json = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  upsertOAuth(provider, {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? nowEpoch() + json.expires_in : undefined,
    method: "subscription",
    subscription: profile.label,
    accountLabel: profile.label,
  });
  log.success(`Logged in to ${provider} via OAuth/subscription`);
}

/**
 * Device-code flow for headless environments.
 * Generic OAuth 2.0 device authorization (RFC 8628).
 */
async function deviceCodeLogin(provider: string): Promise<void> {
  const profile = OAUTH_PROFILES[provider];
  if (!profile) {
    throw new Error(`No device-code profile for ${provider}. Use --api-key.`);
  }

  // Device endpoints are often adjacent; allow override.
  const deviceUrl =
    process.env.FORGE_DEVICE_AUTH_URL ||
    profile.authorizeUrl.replace("/authorize", "/device/code");
  const tokenUrl = profile.tokenUrl;

  const start = await fetch(deviceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: profile.clientId,
      scope: profile.scopes.join(" "),
    }),
  });

  if (!start.ok) {
    log.warn(`Device-code start failed (${start.status}). Falling back to API key.`);
    await loginInteractive({ provider, method: "api_key" });
    return;
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
  if (dc.verification_uri_complete) {
    await open(dc.verification_uri_complete).catch(() => undefined);
  }

  const interval = (dc.interval ?? 5) * 1000;
  const deadline = Date.now() + (dc.expires_in ?? 600) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const poll = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: dc.device_code,
        client_id: profile.clientId,
      }),
    });
    const json = (await poll.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (json.access_token) {
      upsertOAuth(provider, {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: json.expires_in ? nowEpoch() + json.expires_in : undefined,
        method: "subscription",
        subscription: profile.label,
      });
      log.success(`Device login complete for ${provider}`);
      return;
    }
    if (json.error === "authorization_pending" || json.error === "slow_down") {
      continue;
    }
    if (json.error) {
      throw new Error(`Device login failed: ${json.error}`);
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
  const creds = listCredentials();
  if (creds.length === 0) {
    log.info("No stored credentials. Run: forge login");
    return;
  }
  for (const c of creds) {
    const exp = c.expiresAt
      ? c.expiresAt < nowEpoch()
        ? " (EXPIRED)"
        : ` (expires ${new Date(c.expiresAt * 1000).toISOString()})`
      : "";
    console.log(
      `  ${c.provider.padEnd(12)} ${c.method.padEnd(12)} ${c.accountLabel || c.subscription || ""}${exp}`,
    );
  }
}

export function supportsOAuth(provider: string): boolean {
  return Boolean(OAUTH_PROFILES[provider]);
}
