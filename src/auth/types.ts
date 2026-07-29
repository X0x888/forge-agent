import type { ProviderId } from "../config/types.js";

export type AuthMethod = "api_key" | "oauth" | "subscription";

/**
 * One stored login identity. Multiple accounts may share a provider
 * (e.g. two SuperGrok emails, or API key + OAuth for the same provider).
 */
export interface AccountCredential {
  /** Stable id: `${provider}:${slug}` (email slug, label, or short random) */
  id: string;
  provider: ProviderId | string;
  method: AuthMethod;
  /** API key or access token */
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch seconds
  /** OIDC client id used to obtain the token (needed for refresh_token grant) */
  clientId?: string;
  /** Display email / account label when known */
  accountLabel?: string;
  /** Subscription product name if method === subscription */
  subscription?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Soft-disable without deleting (user or auto-switch cooldown).
   * When true, never selected for resolve/auto-switch.
   */
  disabled?: boolean;
  /**
   * Epoch seconds until which this account is deprioritized after
   * rate-limit / quota exhaustion (auto-switch).
   */
  cooldownUntil?: number;
  /** Higher = preferred when auto-switching (default 0). */
  priority?: number;
  /**
   * Last known plan/quota probe (never invented). Used for proactive switch.
   */
  lastPlan?: AccountPlanSnapshot;
}

/** Cached plan usage for ranking / proactive switch. */
export interface AccountPlanSnapshot {
  percent?: number;
  used?: number;
  remaining?: number;
  limit?: number;
  unit?: string;
  fetchedAt: number; // epoch seconds
  source?: string;
}

/**
 * Legacy single-credential shape (auth store v1).
 * Kept for migration + as a flattened view of the active account.
 */
export interface StoredCredential {
  provider: ProviderId | string;
  method: AuthMethod;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  accountLabel?: string;
  subscription?: string;
  updatedAt: string;
}

/** auth.json v1 — one credential per provider */
export interface AuthStoreV1 {
  version: 1;
  credentials: Record<string, StoredCredential>;
}

/** auth.json v2 — multi-account per provider + active pointer */
export interface AuthStoreV2 {
  version: 2;
  /**
   * Active account id per provider. Missing key → first eligible account
   * for that provider (or none).
   */
  active: Record<string, string>;
  /** All accounts keyed by account id */
  accounts: Record<string, AccountCredential>;
  /**
   * When true (default), Forge may switch to another same-provider account
   * on low plan usage or rate-limit / quota errors.
   */
  autoSwitch: boolean;
  /**
   * Switch proactively when lastPlan.percent >= this (0–100). Default 90.
   * Only applies when a numeric percent is known.
   */
  switchThresholdPercent: number;
}

export type AuthStore = AuthStoreV2;

export interface ResolvedAuth {
  provider: ProviderId | string;
  method: AuthMethod;
  token: string;
  baseUrl?: string;
  accountLabel?: string;
  /** Active account id when resolved from the multi-account store */
  accountId?: string;
}

/** Public account summary (never includes tokens). */
export interface AccountSummary {
  id: string;
  provider: string;
  method: AuthMethod;
  accountLabel?: string;
  subscription?: string;
  active: boolean;
  disabled: boolean;
  expired: boolean;
  hasRefreshToken: boolean;
  expiresAt?: string; // ISO
  cooldownUntil?: string; // ISO
  priority: number;
  lastPlanPercent?: number;
  lastPlanRemaining?: number;
  updatedAt: string;
  createdAt: string;
}
