/**
 * Multi-account credential store (~/.forge/auth.json, mode 0600).
 *
 * v2: many accounts per provider + active pointer + auto-switch prefs.
 * v1 files migrate on load (one credential per provider → one account each).
 *
 * Legacy helpers (getCredential / setCredential / upsert*) keep working:
 * they operate on the *active* account for a provider.
 */
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { forgeHome, readJsonFile, writeJsonFile, nowIso, nowEpoch } from "../util/fs.js";
import { withFileLock } from "../util/file-lock.js";
import type {
  AccountCredential,
  AccountPlanSnapshot,
  AccountSummary,
  AuthMethod,
  AuthStore,
  AuthStoreV1,
  AuthStoreV2,
  StoredCredential,
} from "./types.js";
import type { ProviderId } from "../config/types.js";

const DEFAULT_SWITCH_THRESHOLD = 90;

function emptyAuthStore(): AuthStoreV2 {
  return {
    version: 2,
    active: {},
    accounts: {},
    autoSwitch: true,
    switchThresholdPercent: DEFAULT_SWITCH_THRESHOLD,
  };
}

export function authPath(): string {
  return path.join(forgeHome(), "auth.json");
}

/** Normalize raw disk JSON into AuthStoreV2 (migrates v1). */
export function normalizeAuthStore(raw: unknown): AuthStoreV2 {
  if (!raw || typeof raw !== "object") return emptyAuthStore();
  const obj = raw as Record<string, unknown>;

  // Already v2
  if (obj.version === 2 && obj.accounts && typeof obj.accounts === "object") {
    const accounts: Record<string, AccountCredential> = {};
    for (const [id, v] of Object.entries(
      obj.accounts as Record<string, Partial<AccountCredential>>,
    )) {
      if (!v || typeof v !== "object") continue;
      const provider = String(v.provider || id.split(":")[0] || "unknown");
      const method = normalizeMethod(v.method);
      const accessToken = typeof v.accessToken === "string" ? v.accessToken : "";
      if (!accessToken) continue;
      accounts[id] = {
        id: typeof v.id === "string" && v.id ? v.id : id,
        provider,
        method,
        accessToken,
        refreshToken:
          typeof v.refreshToken === "string" ? v.refreshToken : undefined,
        expiresAt:
          typeof v.expiresAt === "number" && Number.isFinite(v.expiresAt)
            ? v.expiresAt
            : undefined,
        clientId: typeof v.clientId === "string" ? v.clientId : undefined,
        accountLabel:
          typeof v.accountLabel === "string" ? v.accountLabel : undefined,
        subscription:
          typeof v.subscription === "string" ? v.subscription : undefined,
        createdAt:
          typeof v.createdAt === "string" ? v.createdAt : nowIso(),
        updatedAt:
          typeof v.updatedAt === "string" ? v.updatedAt : nowIso(),
        disabled: Boolean(v.disabled),
        cooldownUntil:
          typeof v.cooldownUntil === "number" && Number.isFinite(v.cooldownUntil)
            ? v.cooldownUntil
            : undefined,
        priority:
          typeof v.priority === "number" && Number.isFinite(v.priority)
            ? Math.trunc(v.priority)
            : 0,
        lastPlan: normalizePlanSnapshot(v.lastPlan),
      };
    }
    const active: Record<string, string> = {};
    if (obj.active && typeof obj.active === "object") {
      for (const [p, aid] of Object.entries(obj.active as Record<string, string>)) {
        if (typeof aid === "string" && accounts[aid]) active[p] = aid;
      }
    }
    // Ensure every provider with accounts has an active pointer
    for (const acc of Object.values(accounts)) {
      if (!active[acc.provider]) {
        const first = Object.values(accounts).find(
          (a) => a.provider === acc.provider && !a.disabled,
        );
        if (first) active[acc.provider] = first.id;
      }
    }
    let threshold = DEFAULT_SWITCH_THRESHOLD;
    if (
      typeof obj.switchThresholdPercent === "number" &&
      Number.isFinite(obj.switchThresholdPercent)
    ) {
      threshold = Math.min(100, Math.max(0, Math.round(obj.switchThresholdPercent)));
    }
    return {
      version: 2,
      active,
      accounts,
      autoSwitch: obj.autoSwitch === false ? false : true,
      switchThresholdPercent: threshold,
    };
  }

  // v1 → v2 migration
  const v1 = obj as Partial<AuthStoreV1>;
  const credentials =
    v1.credentials && typeof v1.credentials === "object" ? v1.credentials : {};
  const store = emptyAuthStore();
  for (const [provider, cred] of Object.entries(credentials)) {
    if (!cred || typeof cred !== "object") continue;
    const accessToken =
      typeof (cred as StoredCredential).accessToken === "string"
        ? (cred as StoredCredential).accessToken
        : "";
    if (!accessToken) continue;
    const id = makeAccountId(
      provider,
      (cred as StoredCredential).accountLabel ||
        (cred as StoredCredential).subscription ||
        "default",
    );
    const now = nowIso();
    store.accounts[id] = {
      id,
      provider: (cred as StoredCredential).provider || provider,
      method: normalizeMethod((cred as StoredCredential).method),
      accessToken,
      refreshToken: (cred as StoredCredential).refreshToken,
      expiresAt: (cred as StoredCredential).expiresAt,
      clientId: (cred as StoredCredential).clientId,
      accountLabel: (cred as StoredCredential).accountLabel,
      subscription: (cred as StoredCredential).subscription,
      createdAt: (cred as StoredCredential).updatedAt || now,
      updatedAt: (cred as StoredCredential).updatedAt || now,
      priority: 0,
      disabled: false,
    };
    store.active[provider] = id;
  }
  return store;
}

function normalizeMethod(m: unknown): AuthMethod {
  if (m === "oauth" || m === "subscription" || m === "api_key") return m;
  return "api_key";
}

function normalizePlanSnapshot(v: unknown): AccountPlanSnapshot | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as Record<string, unknown>;
  const fetchedAt =
    typeof p.fetchedAt === "number" && Number.isFinite(p.fetchedAt)
      ? p.fetchedAt
      : nowEpoch();
  const out: AccountPlanSnapshot = { fetchedAt };
  if (typeof p.percent === "number" && Number.isFinite(p.percent)) {
    out.percent = Math.min(100, Math.max(0, p.percent));
  }
  if (typeof p.used === "number" && Number.isFinite(p.used)) out.used = p.used;
  if (typeof p.remaining === "number" && Number.isFinite(p.remaining)) {
    out.remaining = p.remaining;
  }
  if (typeof p.limit === "number" && Number.isFinite(p.limit)) out.limit = p.limit;
  if (typeof p.unit === "string") out.unit = p.unit;
  if (typeof p.source === "string") out.source = p.source;
  return out;
}

export function loadAuthStore(): AuthStore {
  const raw = readJsonFile<unknown>(authPath(), emptyAuthStore());
  return normalizeAuthStore(raw);
}

export function saveAuthStore(store: AuthStore): void {
  // Always persist v2 shape
  const normalized = normalizeAuthStore(store);
  writeJsonFile(authPath(), normalized, 0o600);
}

// ── Account id helpers ─────────────────────────────────────────────────────

/** Build a stable, filesystem-safe account id from provider + identity hint. */
export function makeAccountId(provider: string, identityHint?: string): string {
  const p = String(provider || "unknown").toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const raw = (identityHint || "").trim().toLowerCase();
  let slug: string;
  if (raw) {
    // email → local-part + short hash for uniqueness across domains
    const cleaned = raw
      .replace(/^env:/, "env-")
      .replace(/^grok:/, "")
      .replace(/^copilot:/, "")
      .replace(/^cursor:/, "")
      .replace(/[^a-z0-9@._+-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    if (cleaned) {
      const hash = createHash("sha256").update(raw).digest("hex").slice(0, 6);
      slug = `${cleaned.replace(/[@]/g, "-")}-${hash}`;
    } else {
      slug = randomBytes(4).toString("hex");
    }
  } else {
    slug = randomBytes(4).toString("hex");
  }
  return `${p}:${slug}`;
}

/** Find an existing account that matches provider + identity (label/email). */
export function findAccountByIdentity(
  provider: string,
  identityHint?: string,
  store?: AuthStore,
): AccountCredential | undefined {
  const s = store ?? loadAuthStore();
  const hint = (identityHint || "").trim().toLowerCase();
  if (!hint) return undefined;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/^grok:/, "")
      .replace(/^copilot:/, "")
      .replace(/^cursor:/, "")
      .replace(/^env:/, "")
      .trim();
  const target = norm(hint);
  return Object.values(s.accounts).find((a) => {
    if (a.provider !== provider) return false;
    const label = a.accountLabel ? norm(a.accountLabel) : "";
    // An empty stored label must never satisfy a non-empty query — "" is a
    // suffix of every string, which would match the first label-less account
    // and let token rotation / refresh-token clears hit the wrong account.
    if (!label) return false;
    return label === target || label.endsWith(target) || target.endsWith(label);
  });
}

// ── Active account (legacy-compatible) ─────────────────────────────────────

export function accountToStored(acc: AccountCredential): StoredCredential {
  return {
    provider: acc.provider,
    method: acc.method,
    accessToken: acc.accessToken,
    refreshToken: acc.refreshToken,
    expiresAt: acc.expiresAt,
    clientId: acc.clientId,
    accountLabel: acc.accountLabel,
    subscription: acc.subscription,
    updatedAt: acc.updatedAt,
  };
}

export function getActiveAccountId(provider: string): string | undefined {
  const store = loadAuthStore();
  const id = store.active[provider];
  if (id && store.accounts[id]) return id;
  // Fall back to first non-disabled account for provider
  const first = Object.values(store.accounts).find(
    (a) => a.provider === provider && !a.disabled,
  );
  return first?.id;
}

export function getAccount(accountId: string): AccountCredential | undefined {
  return loadAuthStore().accounts[accountId];
}

export function getActiveAccount(provider: string): AccountCredential | undefined {
  const store = loadAuthStore();
  const id = store.active[provider];
  if (id && store.accounts[id] && !store.accounts[id].disabled) {
    return store.accounts[id];
  }
  return Object.values(store.accounts).find(
    (a) => a.provider === provider && !a.disabled,
  );
}

/**
 * Legacy: return the active account for a provider as StoredCredential.
 */
export function getCredential(provider: string): StoredCredential | undefined {
  const acc = getActiveAccount(provider);
  return acc ? accountToStored(acc) : undefined;
}

/**
 * Update or create the active account for a provider (legacy setCredential).
 * Prefer upsertAccount / addOrUpdateAccount for multi-account flows.
 */
export function setCredential(cred: StoredCredential): void {
  // Cross-process lock: see withFileLock — two forge processes must not
  // interleave load→mutate→save and lose each other's rotated tokens.
  withFileLock(authPath(), () => {
    const store = loadAuthStore();
    const provider = String(cred.provider);
    const activeId = store.active[provider];
    const existing = activeId ? store.accounts[activeId] : undefined;

    // Prefer identity match when updating so we don't clobber the wrong account
    const byIdentity = cred.accountLabel
      ? findAccountByIdentity(provider, cred.accountLabel, store)
      : undefined;
    const target = byIdentity || existing;

    if (target) {
      const updated: AccountCredential = {
        ...target,
        method: cred.method,
        accessToken: cred.accessToken,
        expiresAt: cred.expiresAt,
        clientId: cred.clientId,
        accountLabel: cred.accountLabel ?? target.accountLabel,
        subscription: cred.subscription ?? target.subscription,
        updatedAt: nowIso(),
      };
      // Full replace of refreshToken: undefined clears it (refresh revoke path).
      if (cred.refreshToken !== undefined) {
        updated.refreshToken = cred.refreshToken;
      } else {
        delete updated.refreshToken;
      }
      store.accounts[target.id] = updated;
      store.active[provider] = target.id;
    } else {
      const id = makeAccountId(provider, cred.accountLabel || cred.subscription);
      const now = nowIso();
      store.accounts[id] = {
        id,
        provider,
        method: cred.method,
        accessToken: cred.accessToken,
        refreshToken: cred.refreshToken,
        expiresAt: cred.expiresAt,
        clientId: cred.clientId,
        accountLabel: cred.accountLabel,
        subscription: cred.subscription,
        createdAt: now,
        updatedAt: cred.updatedAt || now,
        priority: 0,
        disabled: false,
      };
      store.active[provider] = id;
    }
    saveAuthStore(store);
  });
}

/**
 * Upsert an account by identity (or by id if provided).
 * Returns the account id. Makes it active for the provider.
 */
export function upsertAccount(
  opts: {
    provider: string;
    method: AuthMethod;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    clientId?: string;
    accountLabel?: string;
    subscription?: string;
    /** Force a specific account id (update that row). */
    accountId?: string;
    /**
     * When true (default), set as active for the provider after write.
     */
    makeActive?: boolean;
    /**
     * When true, always create a new account even if identity matches.
     */
    forceNew?: boolean;
  },
): { accountId: string; created: boolean } {
  return withFileLock(authPath(), () => {
    const store = loadAuthStore();
    const provider = String(opts.provider);
    const makeActive = opts.makeActive !== false;
    const now = nowIso();

    let target: AccountCredential | undefined;
    if (opts.accountId && store.accounts[opts.accountId]) {
      target = store.accounts[opts.accountId];
    } else if (!opts.forceNew && opts.accountLabel) {
      target = findAccountByIdentity(provider, opts.accountLabel, store);
    } else if (!opts.forceNew) {
      // No label: update active account of same method if exactly one exists
      const sameMethod = Object.values(store.accounts).filter(
        (a) => a.provider === provider && a.method === opts.method,
      );
      if (sameMethod.length === 1 && !opts.accountLabel) {
        target = sameMethod[0];
      }
    }

    if (target) {
      const updated: AccountCredential = {
        ...target,
        method: opts.method,
        accessToken: opts.accessToken,
        refreshToken:
          opts.refreshToken !== undefined ? opts.refreshToken : target.refreshToken,
        expiresAt: opts.expiresAt !== undefined ? opts.expiresAt : target.expiresAt,
        clientId: opts.clientId !== undefined ? opts.clientId : target.clientId,
        accountLabel:
          opts.accountLabel !== undefined ? opts.accountLabel : target.accountLabel,
        subscription:
          opts.subscription !== undefined ? opts.subscription : target.subscription,
        updatedAt: now,
      };
      // Explicit undefined refreshToken via force-clear is rare; refresh uses setCredential
      store.accounts[target.id] = updated;
      if (makeActive) store.active[provider] = target.id;
      saveAuthStore(store);
      return { accountId: target.id, created: false };
    }

    const id =
      opts.accountId && !store.accounts[opts.accountId]
        ? opts.accountId
        : makeAccountId(provider, opts.accountLabel || opts.subscription);
    store.accounts[id] = {
      id,
      provider,
      method: opts.method,
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      expiresAt: opts.expiresAt,
      clientId: opts.clientId,
      accountLabel: opts.accountLabel,
      subscription: opts.subscription,
      createdAt: now,
      updatedAt: now,
      priority: 0,
      disabled: false,
    };
    if (makeActive) store.active[provider] = id;
    saveAuthStore(store);
    return { accountId: id, created: true };
  });
}

export function clearCredential(provider: string): void {
  withFileLock(authPath(), () => {
    const store = loadAuthStore();
    for (const [id, acc] of Object.entries(store.accounts)) {
      if (acc.provider === provider) delete store.accounts[id];
    }
    delete store.active[provider];
    saveAuthStore(store);
  });
}

export function clearAllCredentials(): void {
  withFileLock(authPath(), () => {
    saveAuthStore(emptyAuthStore());
  });
}

/** Remove a single account by id. Returns false if not found. */
export function removeAccount(accountId: string): boolean {
  return withFileLock(authPath(), () => {
    const store = loadAuthStore();
    const acc = store.accounts[accountId];
    if (!acc) return false;
    delete store.accounts[accountId];
    if (store.active[acc.provider] === accountId) {
      const next = Object.values(store.accounts).find(
        (a) => a.provider === acc.provider && !a.disabled,
      );
      if (next) store.active[acc.provider] = next.id;
      else delete store.active[acc.provider];
    }
    saveAuthStore(store);
    return true;
  });
}

/**
 * Set the active account for a provider. Validates provider ownership.
 */
export function setActiveAccount(accountId: string): {
  ok: boolean;
  error?: string;
  account?: AccountCredential;
} {
  return withFileLock(authPath(), () => {
    const store = loadAuthStore();
    const acc = store.accounts[accountId];
    if (!acc) return { ok: false, error: `No account with id ${accountId}` };
    if (acc.disabled) {
      return { ok: false, error: `Account ${accountId} is disabled` };
    }
    store.active[acc.provider] = accountId;
    saveAuthStore(store);
    return { ok: true, account: acc };
  });
}

export function setAccountDisabled(
  accountId: string,
  disabled: boolean,
): boolean {
  return withFileLock(authPath(), () => {
    const store = loadAuthStore();
    const acc = store.accounts[accountId];
    if (!acc) return false;
    acc.disabled = disabled;
    acc.updatedAt = nowIso();
    if (disabled && store.active[acc.provider] === accountId) {
      const next = Object.values(store.accounts).find(
        (a) => a.provider === acc.provider && a.id !== accountId && !a.disabled,
      );
      if (next) store.active[acc.provider] = next.id;
    }
    saveAuthStore(store);
    return true;
  });
}

export function setAccountPriority(accountId: string, priority: number): boolean {
  return withFileLock(authPath(), () => {
    const store = loadAuthStore();
    const acc = store.accounts[accountId];
    if (!acc) return false;
    acc.priority = Math.trunc(priority);
    acc.updatedAt = nowIso();
    saveAuthStore(store);
    return true;
  });
}

export function setAccountLabel(accountId: string, label: string): boolean {
  return withFileLock(authPath(), () => {
    const store = loadAuthStore();
    const acc = store.accounts[accountId];
    if (!acc) return false;
    acc.accountLabel = label.trim() || undefined;
    acc.updatedAt = nowIso();
    saveAuthStore(store);
    return true;
  });
}

export function setAccountCooldown(
  accountId: string,
  cooldownUntil: number | undefined,
): boolean {
  return withFileLock(authPath(), () => {
    const store = loadAuthStore();
    const acc = store.accounts[accountId];
    if (!acc) return false;
    if (cooldownUntil == null) delete acc.cooldownUntil;
    else acc.cooldownUntil = cooldownUntil;
    acc.updatedAt = nowIso();
    saveAuthStore(store);
    return true;
  });
}

export function setAccountPlan(
  accountId: string,
  plan: AccountPlanSnapshot | undefined,
): boolean {
  return withFileLock(authPath(), () => {
    const store = loadAuthStore();
    const acc = store.accounts[accountId];
    if (!acc) return false;
    if (plan) acc.lastPlan = plan;
    else delete acc.lastPlan;
    acc.updatedAt = nowIso();
    saveAuthStore(store);
    return true;
  });
}

export function getAutoSwitchSettings(): {
  autoSwitch: boolean;
  switchThresholdPercent: number;
} {
  const store = loadAuthStore();
  return {
    autoSwitch: store.autoSwitch !== false,
    switchThresholdPercent:
      store.switchThresholdPercent ?? DEFAULT_SWITCH_THRESHOLD,
  };
}

export function setAutoSwitchSettings(opts: {
  autoSwitch?: boolean;
  switchThresholdPercent?: number;
}): void {
  withFileLock(authPath(), () => {
    const store = loadAuthStore();
    if (opts.autoSwitch !== undefined) store.autoSwitch = Boolean(opts.autoSwitch);
    if (opts.switchThresholdPercent !== undefined) {
      store.switchThresholdPercent = Math.min(
        100,
        Math.max(0, Math.round(opts.switchThresholdPercent)),
      );
    }
    saveAuthStore(store);
  });
}

/** List accounts as StoredCredential (legacy — one entry per active provider). */
export function listCredentials(): StoredCredential[] {
  const store = loadAuthStore();
  const seen = new Set<string>();
  const out: StoredCredential[] = [];
  // Prefer active accounts first
  for (const [provider, id] of Object.entries(store.active)) {
    const acc = store.accounts[id];
    if (acc && !seen.has(provider)) {
      out.push(accountToStored(acc));
      seen.add(provider);
    }
  }
  // Include other providers that only have non-active entries
  for (const acc of Object.values(store.accounts)) {
    if (!seen.has(String(acc.provider))) {
      out.push(accountToStored(acc));
      seen.add(String(acc.provider));
    }
  }
  return out;
}

/** All accounts (full multi-account view). */
export function listAccounts(provider?: string): AccountCredential[] {
  const store = loadAuthStore();
  return Object.values(store.accounts)
    .filter((a) => !provider || a.provider === provider)
    .sort((a, b) => {
      if (a.provider !== b.provider) {
        return String(a.provider).localeCompare(String(b.provider));
      }
      return (b.priority ?? 0) - (a.priority ?? 0) ||
        a.updatedAt.localeCompare(b.updatedAt);
    });
}

export function isExpired(cred: StoredCredential | AccountCredential, skewSec = 60): boolean {
  if (!cred.expiresAt) return false;
  return nowEpoch() >= cred.expiresAt - skewSec;
}

export function isAccountInCooldown(acc: AccountCredential): boolean {
  if (!acc.cooldownUntil) return false;
  return nowEpoch() < acc.cooldownUntil;
}

export function accountSummary(
  acc: AccountCredential,
  activeId?: string,
): AccountSummary {
  const expired = isExpired(acc);
  return {
    id: acc.id,
    provider: String(acc.provider),
    method: acc.method,
    accountLabel: acc.accountLabel,
    subscription: acc.subscription,
    active: activeId ? acc.id === activeId : getActiveAccountId(String(acc.provider)) === acc.id,
    disabled: Boolean(acc.disabled),
    expired,
    hasRefreshToken: Boolean(acc.refreshToken),
    expiresAt: acc.expiresAt
      ? new Date(acc.expiresAt * 1000).toISOString()
      : undefined,
    cooldownUntil: acc.cooldownUntil
      ? new Date(acc.cooldownUntil * 1000).toISOString()
      : undefined,
    priority: acc.priority ?? 0,
    lastPlanPercent: acc.lastPlan?.percent,
    lastPlanRemaining: acc.lastPlan?.remaining,
    updatedAt: acc.updatedAt,
    createdAt: acc.createdAt,
  };
}

export function listAccountSummaries(provider?: string): AccountSummary[] {
  const store = loadAuthStore();
  return listAccounts(provider).map((a) =>
    accountSummary(a, store.active[a.provider]),
  );
}

/**
 * Resolve a user-facing selector (id, label fragment, email, provider:index)
 * to an account id within an optional provider filter.
 */
export function resolveAccountSelector(
  selector: string,
  provider?: string,
): { ok: true; account: AccountCredential } | { ok: false; error: string; matches?: AccountSummary[] } {
  const sel = selector.trim();
  if (!sel) return { ok: false, error: "Empty account selector" };
  const store = loadAuthStore();
  const candidates = Object.values(store.accounts).filter(
    (a) => !provider || a.provider === provider,
  );
  // Exact id
  if (store.accounts[sel] && (!provider || store.accounts[sel].provider === provider)) {
    return { ok: true, account: store.accounts[sel] };
  }
  // provider:n index (1-based among provider accounts)
  const idxMatch = /^([a-z0-9_-]+):(\d+)$/i.exec(sel);
  if (idxMatch) {
    const p = idxMatch[1].toLowerCase();
    const n = Number(idxMatch[2]);
    const list = listAccounts(p);
    if (n >= 1 && n <= list.length) {
      return { ok: true, account: list[n - 1] };
    }
  }
  // Label / email substring (case-insensitive)
  const lower = sel.toLowerCase();
  const byLabel = candidates.filter((a) => {
    const label = (a.accountLabel || a.subscription || "").toLowerCase();
    return label === lower || label.includes(lower) || a.id.toLowerCase().includes(lower);
  });
  if (byLabel.length === 1) return { ok: true, account: byLabel[0] };
  if (byLabel.length > 1) {
    return {
      ok: false,
      error: `Ambiguous account selector "${sel}" — ${byLabel.length} matches`,
      matches: byLabel.map((a) => accountSummary(a, store.active[a.provider])),
    };
  }
  return { ok: false, error: `No account matching "${sel}"` };
}

export function upsertApiKey(
  provider: ProviderId | string,
  apiKey: string,
  accountLabel?: string,
  opts?: { forceNew?: boolean; makeActive?: boolean },
): { accountId: string; created: boolean } {
  return upsertAccount({
    provider: String(provider),
    method: "api_key",
    accessToken: apiKey,
    accountLabel: accountLabel ?? `api-key`,
    forceNew: opts?.forceNew,
    makeActive: opts?.makeActive,
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
    forceNew?: boolean;
    makeActive?: boolean;
    accountId?: string;
  },
): { accountId: string; created: boolean } {
  return upsertAccount({
    provider: String(provider),
    method: opts.method ?? "oauth",
    accessToken: opts.accessToken,
    refreshToken: opts.refreshToken,
    expiresAt: opts.expiresAt,
    clientId: opts.clientId,
    accountLabel: opts.accountLabel,
    subscription: opts.subscription,
    forceNew: opts.forceNew,
    makeActive: opts.makeActive,
    accountId: opts.accountId,
  });
}

/**
 * Patch the active account (or a specific accountId) while preserving fields.
 * Used by refresh when dropping a dead refresh_token.
 */
export function patchAccount(
  providerOrId: string,
  patch: Partial<
    Pick<
      AccountCredential,
      | "accessToken"
      | "refreshToken"
      | "expiresAt"
      | "clientId"
      | "accountLabel"
      | "subscription"
      | "method"
      | "disabled"
      | "cooldownUntil"
      | "priority"
      | "lastPlan"
    >
  > & { clearRefreshToken?: boolean },
): AccountCredential | undefined {
  return withFileLock(authPath(), () => {
    const store = loadAuthStore();
    let acc: AccountCredential | undefined = store.accounts[providerOrId];
    if (!acc) {
      // treat as provider
      const id = store.active[providerOrId];
      acc = (id ? store.accounts[id] : undefined) ?? getActiveAccount(providerOrId);
    }
    if (!acc) return undefined;
    const next: AccountCredential = {
      ...acc,
      ...patch,
      updatedAt: nowIso(),
    };
    if (patch.clearRefreshToken) delete next.refreshToken;
    // Don't copy control flags into credential
    delete (next as { clearRefreshToken?: boolean }).clearRefreshToken;
    store.accounts[acc.id] = next;
    saveAuthStore(store);
    return next;
  });
}
