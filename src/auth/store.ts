import path from "node:path";
import { forgeHome, readJsonFile, writeJsonFile, nowIso, nowEpoch } from "../util/fs.js";
import type { AuthStore, StoredCredential, AuthMethod } from "./types.js";
import type { ProviderId } from "../config/types.js";

const EMPTY: AuthStore = { version: 1, credentials: {} };

export function authPath(): string {
  return path.join(forgeHome(), "auth.json");
}

export function loadAuthStore(): AuthStore {
  return readJsonFile<AuthStore>(authPath(), EMPTY);
}

export function saveAuthStore(store: AuthStore): void {
  writeJsonFile(authPath(), store, 0o600);
}

export function getCredential(provider: string): StoredCredential | undefined {
  const store = loadAuthStore();
  return store.credentials[provider];
}

export function setCredential(cred: StoredCredential): void {
  const store = loadAuthStore();
  store.credentials[cred.provider] = {
    ...cred,
    updatedAt: nowIso(),
  };
  saveAuthStore(store);
}

export function clearCredential(provider: string): void {
  const store = loadAuthStore();
  delete store.credentials[provider];
  saveAuthStore(store);
}

export function clearAllCredentials(): void {
  saveAuthStore(EMPTY);
}

export function listCredentials(): StoredCredential[] {
  return Object.values(loadAuthStore().credentials);
}

export function isExpired(cred: StoredCredential, skewSec = 60): boolean {
  if (!cred.expiresAt) return false;
  return nowEpoch() >= cred.expiresAt - skewSec;
}

export function upsertApiKey(
  provider: ProviderId | string,
  apiKey: string,
  accountLabel?: string,
): void {
  setCredential({
    provider,
    method: "api_key",
    accessToken: apiKey,
    accountLabel,
    updatedAt: nowIso(),
  });
}

export function upsertOAuth(
  provider: ProviderId | string,
  opts: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    clientId?: string;
    accountLabel?: string;
    method?: AuthMethod;
    subscription?: string;
  },
): void {
  setCredential({
    provider,
    method: opts.method ?? "oauth",
    accessToken: opts.accessToken,
    refreshToken: opts.refreshToken,
    expiresAt: opts.expiresAt,
    clientId: opts.clientId,
    accountLabel: opts.accountLabel,
    subscription: opts.subscription,
    updatedAt: nowIso(),
  });
}
