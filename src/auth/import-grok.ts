/**
 * Import credentials from Grok Build's ~/.grok/auth.json so Forge can
 * reuse an existing SuperGrok / xAI OIDC session (subscription login).
 *
 * Grok stores OIDC access tokens under keys like:
 *   "https://auth.x.ai::<client_id>" → { key, refresh_token, expires_at, email, … }
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertOAuth } from "./store.js";
import { nowEpoch } from "../util/fs.js";
import { XAI_PUBLIC_CLIENT_ID } from "./xai-oauth.js";

export interface GrokImportResult {
  imported: boolean;
  email?: string;
  expiresAt?: number;
  reason?: string;
  accessToken?: string;
  accountId?: string;
  created?: boolean;
}

function grokAuthPath(): string {
  const home = process.env.GROK_HOME?.trim() || path.join(os.homedir(), ".grok");
  return path.join(home, "auth.json");
}

function parseExpiresAt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    // already epoch? if huge ms, convert
    return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  }
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return undefined;
}

/**
 * Read the newest valid xAI entry from Grok's auth store.
 */
export function readGrokXaiSession(): {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  clientId?: string;
} | null {
  const file = grokAuthPath();
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  type Entry = {
    key?: string;
    access_token?: string;
    refresh_token?: string;
    expires_at?: string | number;
    email?: string;
    auth_mode?: string;
    oidc_client_id?: string;
    create_time?: string;
  };

  const candidates: Array<Entry & { score: number }> = [];
  for (const [k, v] of Object.entries(raw as Record<string, Entry>)) {
    if (!v || typeof v !== "object") continue;
    // Fallback xAI signal when the map key carries no auth.x.ai URL: the
    // entry's OIDC client id must BE xAI's public Grok CLI client. (The old
    // `String(v).length > 0` clause was always true — '[object Object]' —
    // and admitted ANY entry with an oidc_client_id as an xAI candidate.)
    const oidcClientId =
      typeof v.oidc_client_id === "string" ? v.oidc_client_id.trim() : "";
    const isXai =
      k.includes("auth.x.ai") ||
      k.includes("x.ai") ||
      (oidcClientId.length > 0 && oidcClientId === XAI_PUBLIC_CLIENT_ID);
    if (!isXai && !k.startsWith("https://auth.x.ai")) continue;
    const token = (v.key || v.access_token || "").trim();
    if (!token) continue;
    const exp = parseExpiresAt(v.expires_at);
    // Prefer non-expired, then newest create_time
    let score = 0;
    if (exp && exp > nowEpoch()) score += 1000;
    if (v.create_time) {
      const ct = Date.parse(v.create_time);
      if (!Number.isNaN(ct)) score += Math.floor(ct / 1000) % 1_000_000;
    }
    candidates.push({ ...v, key: token, score });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const token = (best.key || "").trim();
  if (!token) return null;
  return {
    accessToken: token,
    refreshToken: best.refresh_token,
    expiresAt: parseExpiresAt(best.expires_at),
    email: best.email,
    clientId: best.oidc_client_id,
  };
}

/** Copy Grok session into ~/.forge/auth.json for provider xai. */
export function importGrokCredentials(): GrokImportResult {
  const session = readGrokXaiSession();
  if (!session) {
    return {
      imported: false,
      reason:
        `No xAI session found in ${grokAuthPath()}. Run \`grok login\` first, then retry.`,
    };
  }
  if (session.expiresAt && session.expiresAt <= nowEpoch()) {
    return {
      imported: false,
      reason:
        "Grok session is expired. Run `grok login` to refresh, then: forge login --from-grok",
      email: session.email,
      expiresAt: session.expiresAt,
    };
  }

  const r = upsertOAuth("xai", {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
    clientId: session.clientId,
    method: "subscription",
    subscription: "Grok / SuperGrok (imported)",
    accountLabel: session.email
      ? `grok:${session.email}`
      : "grok:imported-session",
  });

  return {
    imported: true,
    email: session.email,
    expiresAt: session.expiresAt,
    accessToken: session.accessToken,
    accountId: r.accountId,
    created: r.created,
  };
}
