/**
 * GitHub Copilot auth for Forge.
 *
 * Paths:
 * 1. Import a local Copilot session (GitHub Copilot CLI keychain / VS Code apps.json)
 * 2. GitHub device-code OAuth (public Copilot VS Code client) then exchange
 * 3. Paste a GitHub OAuth token (ghu_/gho_) via --api-key
 *
 * Flow: GitHub OAuth token → GET /copilot_internal/v2/token → short-lived
 * Copilot API token → chat against https://api.githubcopilot.com
 *
 * We store the GitHub token as refreshToken and the Copilot session token as
 * accessToken (with expiresAt). Re-exchange is the "refresh".
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertOAuth } from "./store.js";
import { nowEpoch } from "../util/fs.js";

/** Public GitHub App client used by VS Code / Copilot Chat (device flow). */
export const COPILOT_GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const COPILOT_GITHUB_SCOPES = "read:user";
export const COPILOT_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const COPILOT_ACCESS_TOKEN_URL =
  "https://github.com/login/oauth/access_token";
export const COPILOT_TOKEN_URL =
  process.env.GITHUB_COPILOT_API_KEY_URL?.trim() ||
  "https://api.github.com/copilot_internal/v2/token";
export const COPILOT_API_BASE =
  process.env.GITHUB_COPILOT_API_BASE?.trim() ||
  "https://api.githubcopilot.com";

export const COPILOT_VSCODE_VERSION = "1.104.3";
export const COPILOT_CHAT_VERSION = "0.26.7";
export const COPILOT_EDITOR_PLUGIN = `copilot-chat/${COPILOT_CHAT_VERSION}`;
export const COPILOT_USER_AGENT = `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`;
export const COPILOT_INTEGRATION_ID = "vscode-chat";
export const COPILOT_OPENAI_INTENT = "conversation-panel";
export const COPILOT_GITHUB_API_VERSION = "2025-04-01";

export const COPILOT_PROVIDER_ID = "copilot";

/** Headers required by the Copilot chat API (OpenAI-compatible). */
export function copilotApiHeaders(): Record<string, string> {
  return {
    "Editor-Version": `vscode/${COPILOT_VSCODE_VERSION}`,
    "Editor-Plugin-Version": COPILOT_EDITOR_PLUGIN,
    "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
    "OpenAI-Intent": COPILOT_OPENAI_INTENT,
    "X-Github-Api-Version": COPILOT_GITHUB_API_VERSION,
    "User-Agent": COPILOT_USER_AGENT,
  };
}

/** Headers for GitHub token exchange. */
export function copilotExchangeHeaders(githubToken: string): Record<string, string> {
  return {
    Authorization: `token ${githubToken}`,
    Accept: "application/json",
    "Editor-Version": `vscode/${COPILOT_VSCODE_VERSION}`,
    "Editor-Plugin-Version": COPILOT_EDITOR_PLUGIN,
    "User-Agent": COPILOT_USER_AGENT,
    "X-Github-Api-Version": COPILOT_GITHUB_API_VERSION,
  };
}

export interface CopilotTokenResult {
  token: string;
  expiresAt?: number; // epoch seconds
  refreshIn?: number;
}

export interface LocalCopilotGitHubToken {
  token: string;
  source: string;
  login?: string;
}

export interface CopilotImportResult {
  imported: boolean;
  login?: string;
  expiresAt?: number;
  reason?: string;
  source?: string;
  accountId?: string;
  created?: boolean;
}

/**
 * Exchange a long-lived GitHub OAuth token for a short-lived Copilot API token
 * (classic VS Code / Iv1 client path).
 */
export async function exchangeCopilotToken(
  githubToken: string,
  signal?: AbortSignal,
): Promise<CopilotTokenResult> {
  const url =
    process.env.GITHUB_COPILOT_API_KEY_URL?.trim() || COPILOT_TOKEN_URL;
  const resp = await fetch(url, {
    method: "GET",
    headers: copilotExchangeHeaders(githubToken),
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Copilot token exchange failed (${resp.status}): ${text.slice(0, 280)}`,
    );
  }
  const json = (await resp.json()) as {
    token?: string;
    expires_at?: number;
    refresh_in?: number;
  };
  if (!json.token?.trim()) {
    throw new Error("Copilot token exchange response missing token");
  }
  let expiresAt: number | undefined;
  if (typeof json.expires_at === "number" && Number.isFinite(json.expires_at)) {
    // GitHub returns epoch seconds; tolerate ms if huge
    expiresAt =
      json.expires_at > 1e12
        ? Math.floor(json.expires_at / 1000)
        : Math.floor(json.expires_at);
  }
  return {
    token: json.token.trim(),
    expiresAt,
    refreshIn:
      typeof json.refresh_in === "number" ? json.refresh_in : undefined,
  };
}

/**
 * Modern GitHub Copilot CLI (OAuth app Ov23…) tokens work as Bearer against
 * api.githubcopilot.com without /copilot_internal/v2/token exchange.
 * Classic VS Code (Iv1…) tokens still need exchange for a tid_ session token.
 */
export async function probeCopilotBearerToken(
  token: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const base =
    process.env.GITHUB_COPILOT_API_BASE?.trim() || COPILOT_API_BASE;
  try {
    const resp = await fetch(`${base.replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...copilotApiHeaders(),
      },
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export type ResolveCopilotSessionMode = "exchanged" | "direct_github";

/**
 * Obtain a token usable against api.githubcopilot.com.
 * 1. Prefer classic v2/token exchange (VS Code style)
 * 2. Fall back to using the GitHub OAuth token directly (Copilot CLI style)
 */
export async function resolveCopilotSessionToken(
  githubToken: string,
  signal?: AbortSignal,
): Promise<CopilotTokenResult & { mode: ResolveCopilotSessionMode }> {
  try {
    const exchanged = await exchangeCopilotToken(githubToken, signal);
    return { ...exchanged, mode: "exchanged" };
  } catch (exchangeErr) {
    const ok = await probeCopilotBearerToken(githubToken, signal);
    if (ok) {
      // Direct GitHub OAuth token — long-lived; no short TTL from exchange.
      return {
        token: githubToken,
        // Soft re-check daily so resolveAuthFresh re-probes occasionally.
        expiresAt: nowEpoch() + 24 * 3600,
        mode: "direct_github",
      };
    }
    throw exchangeErr instanceof Error
      ? exchangeErr
      : new Error(String(exchangeErr));
  }
}

function readJsonSafe(file: string): unknown | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function pickOauthToken(obj: unknown): { token: string; login?: string } | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const token = String(
    rec.oauth_token || rec.token || rec.access_token || rec.key || "",
  ).trim();
  if (!token) return null;
  const login = typeof rec.user === "string"
    ? rec.user
    : typeof rec.login === "string"
      ? rec.login
      : undefined;
  return { token, login };
}

/**
 * Read VS Code / JetBrains / Neovim Copilot local stores:
 *   ~/.config/github-copilot/apps.json
 *   ~/.config/github-copilot/hosts.json
 */
export function readGithubCopilotConfigToken(): LocalCopilotGitHubToken | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".config", "github-copilot", "apps.json"),
    path.join(home, ".config", "github-copilot", "hosts.json"),
    // Windows-ish when XDG isn't set
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "github-copilot", "apps.json")
      : "",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "github-copilot", "apps.json")
      : "",
  ].filter(Boolean);

  for (const file of candidates) {
    const raw = readJsonSafe(file);
    if (!raw || typeof raw !== "object") continue;
    // apps.json: { "github.com:Iv1.…": { user, oauth_token } }
    // hosts.json: { "github.com": { user, oauth_token } }
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const picked = pickOauthToken(v);
      if (!picked) continue;
      if (
        k.includes("github.com") ||
        k.includes("github") ||
        picked.token.startsWith("ghu_") ||
        picked.token.startsWith("gho_")
      ) {
        return {
          token: picked.token,
          source: file,
          login: picked.login,
        };
      }
    }
  }
  return null;
}

function copilotCliConfigPath(): string {
  return path.join(os.homedir(), ".copilot", "config.json");
}

/** Logins known from GitHub Copilot CLI config (for keychain account lookup). */
export function readCopilotCliLogins(): string[] {
  const raw = readJsonSafe(copilotCliConfigPath());
  if (!raw || typeof raw !== "object") return [];
  const logins: string[] = [];
  const cfg = raw as {
    lastLoggedInUser?: { login?: string; host?: string };
    loggedInUsers?: Array<{ login?: string; host?: string }>;
  };
  if (cfg.lastLoggedInUser?.login) logins.push(cfg.lastLoggedInUser.login);
  for (const u of cfg.loggedInUsers || []) {
    if (u.login && !logins.includes(u.login)) logins.push(u.login);
  }
  return logins;
}

/**
 * GitHub Copilot CLI stores OAuth tokens in the OS keychain under service
 * `copilot-cli` (account `https://github.com:<login>`), or plaintext in
 * ~/.copilot/config.json when keychain is unavailable.
 */
export function readCopilotCliToken(): LocalCopilotGitHubToken | null {
  // Plaintext fallback in config (headless Linux without libsecret)
  const cfg = readJsonSafe(copilotCliConfigPath());
  if (cfg && typeof cfg === "object") {
    const rec = cfg as Record<string, unknown>;
    for (const key of [
      "oauth_token",
      "githubToken",
      "github_token",
      "token",
      "access_token",
    ]) {
      const t = typeof rec[key] === "string" ? String(rec[key]).trim() : "";
      if (t && (t.startsWith("ghu_") || t.startsWith("gho_") || t.length > 20)) {
        const logins = readCopilotCliLogins();
        return {
          token: t,
          source: copilotCliConfigPath(),
          login: logins[0],
        };
      }
    }
  }

  const logins = readCopilotCliLogins();
  const accounts = [
    ...logins.map((l) => `https://github.com:${l}`),
    "https://github.com",
  ];

  const loginFromAccount = (acct: string): string | undefined => {
    // Copilot CLI account form: "https://github.com:<login>"
    const m = acct.match(/github\.com:([^/:]+)$/i);
    return m?.[1] || logins[0];
  };

  if (process.platform === "darwin") {
    for (const acct of accounts) {
      try {
        const out = execFileSync(
          "security",
          ["find-generic-password", "-s", "copilot-cli", "-a", acct, "-w"],
          {
            encoding: "utf8",
            timeout: 5_000,
            stdio: ["ignore", "pipe", "pipe"],
          },
        ).trim();
        if (out) {
          return {
            token: out,
            source: `keychain:copilot-cli:${acct}`,
            login: loginFromAccount(acct),
          };
        }
      } catch {
        /* try next account */
      }
    }
    // Broad dump of service without account (may fail if multiple)
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", "copilot-cli", "-w"],
        {
          encoding: "utf8",
          timeout: 5_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
      if (out) {
        return {
          token: out,
          source: "keychain:copilot-cli",
          login: logins[0],
        };
      }
    } catch {
      /* no entry */
    }
  }

  if (process.platform === "linux") {
    for (const acct of accounts) {
      try {
        const out = execFileSync(
          "secret-tool",
          ["lookup", "service", "copilot-cli", "account", acct],
          {
            encoding: "utf8",
            timeout: 5_000,
            stdio: ["ignore", "pipe", "pipe"],
          },
        ).trim();
        if (out) {
          return {
            token: out,
            source: `libsecret:copilot-cli:${acct}`,
            login: loginFromAccount(acct),
          };
        }
      } catch {
        /* try next */
      }
    }
  }

  return null;
}

/**
 * Resolve a local GitHub OAuth token usable for Copilot exchange.
 * Precedence:
 * 1. COPILOT_GITHUB_TOKEN / GITHUB_COPILOT_TOKEN / GH_COPILOT_TOKEN env
 * 2. GitHub Copilot CLI keychain / config
 * 3. VS Code / JetBrains github-copilot apps.json / hosts.json
 */
export function readLocalCopilotGitHubToken(): LocalCopilotGitHubToken | null {
  for (const name of [
    "COPILOT_GITHUB_TOKEN",
    "GITHUB_COPILOT_TOKEN",
    "GH_COPILOT_TOKEN",
  ]) {
    const v = process.env[name]?.trim();
    if (v) return { token: v, source: `env:${name}` };
  }
  return readCopilotCliToken() || readGithubCopilotConfigToken();
}

/**
 * Import local Copilot credentials into ~/.forge/auth.json (provider copilot).
 */
export async function importLocalCopilotCredentials(): Promise<CopilotImportResult> {
  const local = readLocalCopilotGitHubToken();
  if (!local) {
    return {
      imported: false,
      reason:
        "No local Copilot credentials found. Sign in with GitHub Copilot CLI " +
        "(`copilot`), VS Code Copilot, or set COPILOT_GITHUB_TOKEN — then retry. " +
        "Or: forge login -p copilot --device",
    };
  }

  let session: CopilotTokenResult & { mode: ResolveCopilotSessionMode };
  try {
    session = await resolveCopilotSessionToken(local.token);
  } catch (err) {
    return {
      imported: false,
      reason: (err as Error).message,
      source: local.source,
      login: local.login,
    };
  }

  const accountLabel = local.login
    ? `copilot:${local.login}`
    : `copilot:${local.source}`;
  const r = upsertOAuth(COPILOT_PROVIDER_ID, {
    accessToken: session.token,
    // Keep the original GitHub OAuth token for re-resolve / re-exchange.
    refreshToken: local.token,
    expiresAt: session.expiresAt,
    clientId: COPILOT_GITHUB_CLIENT_ID,
    method: "subscription",
    subscription:
      session.mode === "direct_github"
        ? "GitHub Copilot (CLI token)"
        : "GitHub Copilot",
    accountLabel,
  });

  return {
    imported: true,
    login: local.login,
    expiresAt: session.expiresAt,
    source: local.source,
    accountId: r.accountId,
    created: r.created,
  };
}

/**
 * Persist after a successful device / paste login (GitHub token already obtained).
 */
export async function storeCopilotFromGitHubToken(
  githubToken: string,
  opts?: { login?: string; label?: string; forceNew?: boolean },
): Promise<CopilotImportResult> {
  const session = await resolveCopilotSessionToken(githubToken);
  const accountLabel = opts?.login
    ? `copilot:${opts.login}`
    : opts?.label || "copilot:subscription";
  const r = upsertOAuth(COPILOT_PROVIDER_ID, {
    accessToken: session.token,
    refreshToken: githubToken,
    expiresAt: session.expiresAt,
    clientId: COPILOT_GITHUB_CLIENT_ID,
    method: "subscription",
    subscription:
      session.mode === "direct_github"
        ? "GitHub Copilot (CLI token)"
        : "GitHub Copilot",
    accountLabel,
    forceNew: opts?.forceNew,
  });
  return {
    imported: true,
    login: opts?.login,
    expiresAt: session.expiresAt,
    source: opts?.label || "oauth",
    accountId: r.accountId,
    created: r.created,
  };
}

/**
 * Re-resolve a Copilot session from the stored GitHub OAuth token.
 * Used by refreshCredentialIfNeeded.
 */
export async function refreshCopilotSession(githubToken: string): Promise<{
  accessToken: string;
  expiresAt?: number;
}> {
  const session = await resolveCopilotSessionToken(githubToken);
  return {
    accessToken: session.token,
    expiresAt: session.expiresAt,
  };
}

/** True when provider id is Copilot (including aliases already normalized). */
export function isCopilotProvider(provider: string): boolean {
  const p = provider.trim().toLowerCase();
  return (
    p === "copilot" ||
    p === "github-copilot" ||
    p === "github_copilot" ||
    p === "gh-copilot" ||
    p === "github"
  );
}
