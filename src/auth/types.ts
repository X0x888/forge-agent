import type { ProviderId } from "../config/types.js";

export type AuthMethod = "api_key" | "oauth" | "subscription";

export interface StoredCredential {
  provider: ProviderId | string;
  method: AuthMethod;
  /** API key or access token */
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch seconds
  /** Display email / account label when known */
  accountLabel?: string;
  /** Subscription product name if method === subscription */
  subscription?: string;
  updatedAt: string;
}

export interface AuthStore {
  version: 1;
  credentials: Record<string, StoredCredential>;
}

export interface ResolvedAuth {
  provider: ProviderId | string;
  method: AuthMethod;
  token: string;
  baseUrl?: string;
  accountLabel?: string;
}
