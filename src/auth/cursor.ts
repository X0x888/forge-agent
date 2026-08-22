/**
 * Cursor subscription auth for Forge.
 *
 * Paths:
 * 1. Import a local Cursor CLI / SDK / desktop session (`--from-cursor`)
 * 2. Browser login (same poll flow as `agent login` / loginDeepControl)
 * 3. Paste a dashboard API key (`crsr_…`) or access token via --api-key
 *
 * Tokens talk to api2.cursor.sh (Connect-RPC AgentService) so Forge can use
 * Cursor-hosted models against the user's native quota.
 *
 * Refresh: POST /auth/exchange_user_api_key with the refresh token as Bearer.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertApiKey, upsertOAuth } from "./store.js";
import { nowEpoch } from "../util/fs.js";

export const CURSOR_PROVIDER_ID = "cursor";
export const CURSOR_LOGIN_URL =
  process.env.FORGE_CURSOR_LOGIN_URL?.trim() ||
  "https://cursor.com/loginDeepControl";
export const CURSOR_POLL_URL =
  process.env.FORGE_CURSOR_POLL_URL?.trim() ||
  "https://api2.cursor.sh/auth/poll";
export const CURSOR_REFRESH_URL =
  process.env.FORGE_CURSOR_REFRESH_URL?.trim() ||
  "https://api2.cursor.sh/auth/exchange_user_api_key";
export const CURSOR_API_BASE =
  process.env.FORGE_CURSOR_API_BASE?.trim() || "https://api2.cursor.sh";
export const CURSOR_CLIENT_VERSION =
  process.env.FORGE_CURSOR_CLIENT_VERSION?.trim() ||
  process.env.CURSOR_CLIENT_VERSION?.trim() ||
  "cli-2026.02.13-41ac335";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF = 1.2;

export function isCursorProvider(provider: string): boolean {
  const p = provider.trim().toLowerCase();
  return (
    p === "cursor" ||
    p === "cursor-ai" ||
    p === "cursorai" ||
    p === "cursor-cli" ||
    p === "anysphere"
  );
}

export function cursorApiHeaders(): Record<string, string> {
  return {
    "x-ghost-mode": "true",
    "x-cursor-client-version": CURSOR_CLIENT_VERSION,
    "x-cursor-client-type": "cli",
    "User-Agent": `forge-cli cursor/${CURSOR_CLIENT_VERSION}`,
  };
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function cursorPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export interface CursorAuthParams {
  verifier: string;
  challenge: string;
  uuid: string;
  loginUrl: string;
}

export function generateCursorAuthParams(): CursorAuthParams {
  const { verifier, challenge } = cursorPkce();
  const uuid = randomUUID();
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  });
  return {
    verifier,
    challenge,
    uuid,
    loginUrl: `${CURSOR_LOGIN_URL}?${params.toString()}`,
  };
}

function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** JWT payload (unverified) — Cursor access tokens are JWTs with `exp`. */
export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Epoch seconds. JWT `exp` minus 5 minutes, else +1h fallback. */
export function cursorTokenExpiryEpoch(token: string): number {
  const payload = decodeJwtPayload(token);
  const exp = payload && typeof payload.exp === "number" ? payload.exp : 0;
  if (exp > 1e12) return Math.floor(exp / 1000) - 5 * 60;
  if (exp > 0) return Math.floor(exp) - 5 * 60;
  return nowEpoch() + 3600;
}

export function emailFromCursorToken(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  for (const key of ["email", "preferred_username", "upn"]) {
    const v = payload[key];
    if (typeof v === "string" && v.includes("@")) return v;
  }
  const sub = payload.sub;
  if (typeof sub === "string" && sub.includes("@")) return sub;
  return undefined;
}

export function looksLikeCursorApiKey(token: string): boolean {
  const t = token.trim();
  return t.startsWith("crsr_") || t.startsWith("key_");
}

export interface CursorTokenPair {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
}

export async function pollCursorAuth(
  uuid: string,
  verifier: string,
  opts?: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> },
): Promise<CursorTokenPair> {
  const sleep =
    opts?.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let delay = POLL_BASE_DELAY_MS;
  let consecutiveErrors = 0;
  const pollUrl =
    process.env.FORGE_CURSOR_POLL_URL?.trim() || CURSOR_POLL_URL;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    if (opts?.signal?.aborted) {
      throw new Error("Cursor login aborted");
    }
    await sleep(delay);
    let resp: Response;
    try {
      const url = `${pollUrl}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
      resp = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "forge-cli",
        },
        signal: opts?.signal ?? AbortSignal.timeout(20_000),
      });
    } catch (err) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) {
        throw new Error(
          `Cursor auth poll unreachable (${(err as Error).message || err})`,
        );
      }
      continue;
    }
    if (resp.status === 404) {
      consecutiveErrors = 0;
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS);
      continue;
    }
    if (!resp.ok) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `Cursor auth poll failed (${resp.status}): ${text.slice(0, 200)}`,
        );
      }
      continue;
    }
    const data = (await resp.json().catch(() => null)) as {
      accessToken?: string;
      access_token?: string;
      refreshToken?: string;
      refresh_token?: string;
    } | null;
    const access = String(data?.accessToken || data?.access_token || "").trim();
    if (!access) {
      throw new Error("Cursor auth poll returned no access token");
    }
    const refresh = String(
      data?.refreshToken || data?.refresh_token || "",
    ).trim();
    return {
      accessToken: access,
      refreshToken: refresh || undefined,
      expiresAt: cursorTokenExpiryEpoch(access),
      email: emailFromCursorToken(access),
    };
  }
  throw new Error("Cursor authentication timed out — try forge login -p cursor again");
}

export async function refreshCursorToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<CursorTokenPair> {
  const url =
    process.env.FORGE_CURSOR_REFRESH_URL?.trim() || CURSOR_REFRESH_URL;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "forge-cli",
    },
    body: "{}",
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Cursor token refresh failed (${resp.status}): ${text.slice(0, 280)}`,
    );
  }
  const data = (await resp.json()) as {
    accessToken?: string;
    access_token?: string;
    refreshToken?: string;
    refresh_token?: string;
  };
  const access = String(data.accessToken || data.access_token || "").trim();
  if (!access) {
    throw new Error("Cursor token refresh response missing accessToken");
  }
  const nextRefresh = String(
    data.refreshToken || data.refresh_token || refreshToken,
  ).trim();
  return {
    accessToken: access,
    refreshToken: nextRefresh || refreshToken,
    expiresAt: cursorTokenExpiryEpoch(access),
    email: emailFromCursorToken(access),
  };
}

function readJsonSafe(file: string): unknown | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function pickTokenFields(obj: unknown): {
  access?: string;
  refresh?: string;
  email?: string;
} {
  if (!obj || typeof obj !== "object") return {};
  const rec = obj as Record<string, unknown>;
  const access = String(
    rec.accessToken ||
      rec.access_token ||
      rec.token ||
      rec.apiKey ||
      rec.api_key ||
      rec.key ||
      "",
  ).trim();
  const refresh = String(
    rec.refreshToken || rec.refresh_token || rec.refresh || "",
  ).trim();
  const nested =
    rec.auth && typeof rec.auth === "object"
      ? pickTokenFields(rec.auth)
      : rec.tokens && typeof rec.tokens === "object"
        ? pickTokenFields(rec.tokens)
        : {};
  const emailRaw = rec.email || rec.userEmail || rec.accountEmail;
  const email =
    typeof emailRaw === "string" && emailRaw.includes("@")
      ? emailRaw
      : nested.email;
  return {
    access: access || nested.access,
    refresh: refresh || nested.refresh,
    email,
  };
}

export interface LocalCursorToken {
  accessToken: string;
  refreshToken?: string;
  email?: string;
  source: string;
}

function cursorHome(): string {
  return os.homedir();
}

function candidateAuthFiles(): string[] {
  const home = cursorHome();
  const xdg =
    process.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return [
    path.join(home, ".cursor", "auth.json"),
    path.join(xdg, "cursor", "auth.json"),
    path.join(home, ".cursor", "sdk", "auth.json"),
    path.join(home, ".cursor-agent", "auth.json"),
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "Cursor", "auth.json")
      : "",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Cursor", "auth.json")
      : "",
  ].filter(Boolean);
}

export function readCursorCliConfigEmail(): string | undefined {
  const home = cursorHome();
  for (const file of [
    path.join(home, ".cursor", "cli-config.json"),
    path.join(home, ".cursor", "argv.json"),
  ]) {
    const raw = readJsonSafe(file);
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const info =
      rec.authInfo && typeof rec.authInfo === "object"
        ? (rec.authInfo as Record<string, unknown>)
        : rec;
    const email = info.email;
    if (typeof email === "string" && email.includes("@")) return email;
  }
  return undefined;
}

export function readCursorAuthFileToken(): LocalCursorToken | null {
  for (const file of candidateAuthFiles()) {
    const raw = readJsonSafe(file);
    const picked = pickTokenFields(raw);
    if (picked.access && picked.access.length > 12) {
      return {
        accessToken: picked.access,
        refreshToken: picked.refresh || undefined,
        email: picked.email || readCursorCliConfigEmail(),
        source: file,
      };
    }
  }
  return null;
}

function keychainPassword(service: string, account?: string): string | null {
  if (process.platform !== "darwin") return null;
  const args = ["find-generic-password", "-s", service, "-w"];
  if (account) args.splice(3, 0, "-a", account);
  try {
    const out = execFileSync("security", args, {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function readCursorKeychainToken(): LocalCursorToken | null {
  if (process.platform !== "darwin") return null;
  const services = [
    ["cursor-access-token", "cursor-user"],
    ["cursor-access-token", ""],
    ["Cursor", "cursor-user"],
    ["cursor-cli", "cursor-user"],
  ] as const;
  for (const [service, account] of services) {
    const access = keychainPassword(service, account || undefined);
    if (!access || access.length < 12) continue;
    const refresh =
      keychainPassword("cursor-refresh-token", account || "cursor-user") ||
      keychainPassword("cursor-refresh-token") ||
      undefined;
    return {
      accessToken: access,
      refreshToken: refresh,
      email: readCursorCliConfigEmail(),
      source: `keychain:${service}${account ? `:${account}` : ""}`,
    };
  }
  return null;
}

/**
 * Resolve a local Cursor token. Precedence:
 * 1. CURSOR_ACCESS_TOKEN / CURSOR_API_KEY env
 * 2. ~/.cursor/auth.json (and XDG / SDK / Windows siblings)
 * 3. macOS keychain (cursor-access-token)
 */
export function readLocalCursorToken(): LocalCursorToken | null {
  for (const name of ["CURSOR_ACCESS_TOKEN", "CURSOR_API_KEY"]) {
    const v = process.env[name]?.trim();
    if (v) {
      return {
        accessToken: v,
        source: `env:${name}`,
        email: emailFromCursorToken(v) || readCursorCliConfigEmail(),
      };
    }
  }
  return readCursorAuthFileToken() || readCursorKeychainToken();
}

export interface CursorImportResult {
  imported: boolean;
  email?: string;
  expiresAt?: number;
  reason?: string;
  source?: string;
  accountId?: string;
  created?: boolean;
}

function accountLabelFor(email?: string, source?: string): string {
  if (email) return `cursor:${email}`;
  if (source) return `cursor:${source}`;
  return "cursor:subscription";
}

export function storeCursorTokens(
  tokens: CursorTokenPair,
  opts?: { label?: string; forceNew?: boolean; source?: string },
): { accountId: string; created: boolean } {
  const email = tokens.email || emailFromCursorToken(tokens.accessToken);
  const label =
    opts?.label?.trim() || accountLabelFor(email, opts?.source);
  const isKey = looksLikeCursorApiKey(tokens.accessToken) && !tokens.refreshToken;
  if (isKey) {
    return upsertApiKey(CURSOR_PROVIDER_ID, tokens.accessToken, label, {
      forceNew: Boolean(opts?.forceNew),
    });
  }
  return upsertOAuth(CURSOR_PROVIDER_ID, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt ?? cursorTokenExpiryEpoch(tokens.accessToken),
    clientId: "cursor-cli",
    method: "subscription",
    subscription: "Cursor",
    accountLabel: label,
    forceNew: Boolean(opts?.forceNew),
  });
}

export async function importLocalCursorCredentials(): Promise<CursorImportResult> {
  const local = readLocalCursorToken();
  if (!local) {
    return {
      imported: false,
      reason:
        "No local Cursor credentials found. Sign in with Cursor CLI (`agent login`), " +
        "Cursor Desktop, or set CURSOR_API_KEY — then retry. " +
        "Or: forge login -p cursor",
    };
  }
  const r = storeCursorTokens(
    {
      accessToken: local.accessToken,
      refreshToken: local.refreshToken,
      expiresAt: cursorTokenExpiryEpoch(local.accessToken),
      email: local.email,
    },
    { source: local.source, label: accountLabelFor(local.email, local.source) },
  );
  return {
    imported: true,
    email: local.email,
    expiresAt: cursorTokenExpiryEpoch(local.accessToken),
    source: local.source,
    accountId: r.accountId,
    created: r.created,
  };
}

export async function storeCursorFromAccessToken(
  accessToken: string,
  opts?: { refreshToken?: string; label?: string; forceNew?: boolean },
): Promise<CursorImportResult> {
  const token = accessToken.trim();
  if (!token) {
    return { imported: false, reason: "Cursor token is empty" };
  }
  const email = emailFromCursorToken(token);
  const r = storeCursorTokens(
    {
      accessToken: token,
      refreshToken: opts?.refreshToken,
      expiresAt: cursorTokenExpiryEpoch(token),
      email,
    },
    {
      label: opts?.label,
      forceNew: opts?.forceNew,
      source: opts?.label,
    },
  );
  return {
    imported: true,
    email,
    expiresAt: cursorTokenExpiryEpoch(token),
    source: opts?.label || "oauth",
    accountId: r.accountId,
    created: r.created,
  };
}

export async function refreshCursorSession(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}> {
  const session = await refreshCursorToken(refreshToken);
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
  };
}
