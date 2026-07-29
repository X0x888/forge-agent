/**
 * Multi-account management + smart switching.
 *
 * Users may store several logins per provider (e.g. two SuperGrok emails).
 * When auto-switch is on, Forge picks another same-provider account when:
 *  - proactive: last known plan usage ≥ switchThresholdPercent
 *  - reactive: 429 / quota / rate-limit / insufficient credits mid-run
 *
 * Env keys still win (CI determinism) and never auto-switch away from env.
 *
 * Production / unattended notes:
 *  - Mid-run switches are capped (`FORGE_ACCOUNT_SWITCH_MAX`, default 3)
 *  - Stale plan probes are ignored for proactive ranking (see PLAN_STALE_SEC)
 *  - After a switch, callers should refresh OAuth on the new account before chat
 */
import { nowEpoch } from "../util/fs.js";
import { log } from "../util/log.js";
import {
  getActiveAccount,
  getAutoSwitchSettings,
  isAccountInCooldown,
  isExpired,
  listAccounts,
  listAccountSummaries,
  resolveAccountSelector,
  setAccountCooldown,
  setAccountPlan,
  setActiveAccount,
} from "./store.js";
import type {
  AccountCredential,
  AccountPlanSnapshot,
  AccountSummary,
  ResolvedAuth,
} from "./types.js";

export {
  listAccounts,
  listAccountSummaries,
  getActiveAccount,
  setActiveAccount,
  removeAccount,
  setAccountDisabled,
  setAccountPriority,
  setAccountLabel,
  setAutoSwitchSettings,
  getAutoSwitchSettings,
  resolveAccountSelector,
  accountSummary,
} from "./store.js";

/** Default cooldown after rate-limit / quota (15 min). */
export const DEFAULT_COOLDOWN_SEC = 15 * 60;

/** Shorter cooldown after auth/token failure switch (5 min) — token may recover via re-login. */
export const AUTH_FAILURE_COOLDOWN_SEC = 5 * 60;

/**
 * Ignore lastPlan older than this for proactive switch / ranking bias.
 * Prevents multi-day sessions from switching on hours-stale usage data.
 */
export const PLAN_STALE_SEC = 6 * 60 * 60;

/**
 * Env API keys win for CI determinism and must never participate in
 * multi-account auto-switch (same rule as resolveAuth).
 */
export function isEnvAuthActive(provider: string): boolean {
  const p = String(provider || "").toLowerCase();
  // Copilot env holds a GitHub OAuth token exchanged into a session — not a
  // static chat key; multi-account still applies to stored copilot slots.
  if (p === "copilot" || p === "github" || p === "github-copilot") {
    return false;
  }
  const names: string[] = ["FORGE_API_KEY"];
  if (p === "xai" || p === "grok") names.push("XAI_API_KEY", "GROK_API_KEY");
  else if (p === "anthropic") names.push("ANTHROPIC_API_KEY");
  else if (p === "openai" || p === "codex") names.push("OPENAI_API_KEY");
  else if (p === "openrouter") names.push("OPENROUTER_API_KEY");
  else if (p === "google") names.push("GOOGLE_API_KEY", "GEMINI_API_KEY");
  else if (p === "custom") names.push("FORGE_API_KEY");
  for (const name of names) {
    if (process.env[name]?.trim()) return true;
  }
  return false;
}

/** Detect provider errors that warrant trying another account. */
export function isQuotaOrRateLimitError(err: unknown): boolean {
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status: unknown }).status)
      : 0;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (status === 429) return true;
  // 403 often means quota/policy for subscription paths; 402 payment required
  if (status === 402) return true;
  if (
    status === 403 &&
    /quota|rate.?limit|usage|credit|billing|exceeded|capacity|resource.?exhausted|too many requests|limit/i.test(
      msg,
    )
  ) {
    return true;
  }
  return (
    /rate.?limit|too many requests|quota|insufficient[_\s-]?quota|resource.?exhausted|credits?.?(exhausted|exceeded|depleted)|usage.?limit|billing|plan.?limit|over.?limit|capacity/i.test(
      msg,
    ) && !/invalid[_\s-]?api[_\s-]?key|unauthorized|not authenticated|invalid_grant/i.test(msg)
  );
}

/** True when lastPlan is fresh enough to trust for ranking / proactive switch. */
export function isPlanFresh(
  plan: AccountPlanSnapshot | undefined,
  now = nowEpoch(),
  maxAgeSec = PLAN_STALE_SEC,
): boolean {
  if (!plan || typeof plan.fetchedAt !== "number") return false;
  return now - plan.fetchedAt <= maxAgeSec;
}

/**
 * Rank candidate accounts for auto-switch (higher score = better).
 * Eligible: same provider, not disabled, not in cooldown, not expired without RT.
 */
export function rankAccount(acc: AccountCredential, now = nowEpoch()): number {
  if (acc.disabled) return -1e12;
  if (isAccountInCooldown(acc)) return -1e11;
  if (isExpired(acc, 60) && !acc.refreshToken) return -1e10;

  let score = (acc.priority ?? 0) * 1_000_000;

  // Prefer fresher tokens slightly
  if (acc.expiresAt && acc.expiresAt > now) {
    score += Math.min(10_000, acc.expiresAt - now) / 100;
  }

  // Prefer lower plan usage when known and fresh
  const plan = acc.lastPlan;
  if (isPlanFresh(plan, now) && plan) {
    if (typeof plan.percent === "number") {
      // 0% used → +100k; 100% used → 0
      score += (100 - Math.min(100, Math.max(0, plan.percent))) * 1000;
    } else if (typeof plan.remaining === "number") {
      score += Math.min(100_000, Math.max(0, plan.remaining));
    } else {
      score += 50_000;
    }
  } else {
    // Unknown or stale usage: neutral mid boost so labeled/priority still wins
    score += 50_000;
  }

  // Prefer accounts that can renew (refresh_token) for unattended runs
  if (acc.refreshToken) score += 25_000;
  else if (acc.method === "api_key") score += 20_000; // API keys don't expire mid-run

  // Slight preference for recently updated (kept warm)
  const updatedMs = Date.parse(acc.updatedAt);
  if (!Number.isNaN(updatedMs)) {
    score += Math.min(5_000, updatedMs / 1e10);
  }

  return score;
}

export function listEligibleAccounts(
  provider: string,
  opts?: { excludeId?: string; allowCooldown?: boolean },
): AccountCredential[] {
  return listAccounts(provider)
    .filter((a) => {
      if (opts?.excludeId && a.id === opts.excludeId) return false;
      if (a.disabled) return false;
      if (!opts?.allowCooldown && isAccountInCooldown(a)) return false;
      if (isExpired(a, 60) && !a.refreshToken) return false;
      return true;
    })
    .sort((a, b) => rankAccount(b) - rankAccount(a));
}

/**
 * Pick the best alternate account for a provider (or null if none).
 */
export function pickAlternateAccount(
  provider: string,
  excludeId?: string,
): AccountCredential | null {
  const list = listEligibleAccounts(provider, { excludeId });
  return list[0] ?? null;
}

export interface SwitchResult {
  switched: boolean;
  fromId?: string;
  toId?: string;
  toLabel?: string;
  reason?: string;
  account?: AccountCredential;
}

/**
 * Switch active account for provider to `toId` (or best alternate).
 */
export function switchAccount(
  provider: string,
  opts?: {
    toId?: string;
    reason?: string;
    /** Put the previous account in cooldown (seconds). */
    cooldownPrevSec?: number;
  },
): SwitchResult {
  const current = getActiveAccount(provider);
  const fromId = current?.id;
  let target: AccountCredential | undefined;

  if (opts?.toId) {
    const r = setActiveAccount(opts.toId);
    if (!r.ok || !r.account) {
      return { switched: false, fromId, reason: r.error || "switch failed" };
    }
    if (r.account.provider !== provider) {
      return {
        switched: false,
        fromId,
        reason: `Account ${opts.toId} belongs to ${r.account.provider}, not ${provider}`,
      };
    }
    target = r.account;
  } else {
    const alt = pickAlternateAccount(provider, fromId);
    if (!alt) {
      return {
        switched: false,
        fromId,
        reason: "no alternate account available",
      };
    }
    const r = setActiveAccount(alt.id);
    if (!r.ok || !r.account) {
      return { switched: false, fromId, reason: r.error || "switch failed" };
    }
    target = r.account;
  }

  if (fromId && opts?.cooldownPrevSec && opts.cooldownPrevSec > 0) {
    setAccountCooldown(fromId, nowEpoch() + opts.cooldownPrevSec);
  }

  const reason = opts?.reason || "manual";
  log.info(
    `Switched ${provider} account` +
      (fromId ? ` from ${shortAccount(fromId, current)}` : "") +
      ` → ${shortAccount(target.id, target)}` +
      ` (${reason})`,
  );

  return {
    switched: true,
    fromId,
    toId: target.id,
    toLabel: target.accountLabel || target.subscription,
    reason,
    account: target,
  };
}

function shortAccount(id: string, acc?: AccountCredential | null): string {
  if (acc?.accountLabel) return acc.accountLabel;
  if (acc?.subscription) return acc.subscription;
  return id;
}

/**
 * Proactive switch when the active account looks exhausted.
 * No-op when autoSwitch is off, only one account, or usage unknown/stale/below threshold.
 */
export function maybeProactiveSwitch(provider: string): SwitchResult {
  if (isEnvAuthActive(provider)) {
    return { switched: false, reason: "env API key wins (no multi-account switch)" };
  }
  const settings = getAutoSwitchSettings();
  if (!settings.autoSwitch) {
    return { switched: false, reason: "auto-switch disabled" };
  }
  const current = getActiveAccount(provider);
  if (!current) return { switched: false, reason: "no active account" };

  const alts = listEligibleAccounts(provider, { excludeId: current.id });
  if (alts.length === 0) {
    return { switched: false, fromId: current.id, reason: "no alternate accounts" };
  }

  const plan = current.lastPlan;
  const planFresh = isPlanFresh(plan);
  const percent = planFresh ? plan?.percent : undefined;
  const remaining = planFresh ? plan?.remaining : undefined;
  const threshold = settings.switchThresholdPercent;
  let should = false;
  let why = "";

  if (typeof percent === "number" && percent >= threshold) {
    should = true;
    why = `plan usage ${percent}% ≥ ${threshold}%`;
  } else if (
    typeof remaining === "number" &&
    remaining <= 0 &&
    planFresh
  ) {
    should = true;
    why = "plan remaining ≤ 0";
  } else if (isAccountInCooldown(current)) {
    should = true;
    why = "active account in cooldown";
  } else if (isExpired(current, 60) && !current.refreshToken) {
    should = true;
    why = "active token expired without refresh_token";
  }

  if (!should) {
    return {
      switched: false,
      fromId: current.id,
      reason: "active account still healthy",
    };
  }

  return switchAccount(provider, {
    reason: `proactive: ${why}`,
    // Don't re-cooldown if already cooling — just leave
    cooldownPrevSec: isAccountInCooldown(current) ? 0 : DEFAULT_COOLDOWN_SEC,
  });
}

/**
 * Reactive switch after a rate-limit / quota error.
 * Marks current account in cooldown and activates the best alternate.
 */
export function switchOnQuotaFailure(
  provider: string,
  opts?: { cooldownSec?: number },
): SwitchResult {
  if (isEnvAuthActive(provider)) {
    return { switched: false, reason: "env API key wins (no multi-account switch)" };
  }
  const settings = getAutoSwitchSettings();
  if (!settings.autoSwitch) {
    return { switched: false, reason: "auto-switch disabled" };
  }
  const current = getActiveAccount(provider);
  if (!current) return { switched: false, reason: "no active account" };

  const alts = listEligibleAccounts(provider, { excludeId: current.id });
  if (alts.length === 0) {
    // Still mark cooldown so proactive won't keep picking it later
    setAccountCooldown(
      current.id,
      nowEpoch() + (opts?.cooldownSec ?? DEFAULT_COOLDOWN_SEC),
    );
    return {
      switched: false,
      fromId: current.id,
      reason:
        "no alternate account after quota failure — add another with forge login --add, or wait for cooldown",
    };
  }

  return switchAccount(provider, {
    reason: "quota/rate-limit",
    cooldownPrevSec: opts?.cooldownSec ?? DEFAULT_COOLDOWN_SEC,
  });
}

/**
 * Reactive switch after a hard auth/token failure (401 / invalid_grant).
 * Shorter cooldown than quota — the user may re-login the old account soon.
 * Still requires autoSwitch (multi-account recovery is opt-out via auto-switch off).
 */
export function switchOnAuthFailure(
  provider: string,
  opts?: { cooldownSec?: number },
): SwitchResult {
  if (isEnvAuthActive(provider)) {
    return { switched: false, reason: "env API key wins (no multi-account switch)" };
  }
  const settings = getAutoSwitchSettings();
  if (!settings.autoSwitch) {
    return { switched: false, reason: "auto-switch disabled" };
  }
  const current = getActiveAccount(provider);
  if (!current) return { switched: false, reason: "no active account" };

  const alts = listEligibleAccounts(provider, { excludeId: current.id });
  if (alts.length === 0) {
    setAccountCooldown(
      current.id,
      nowEpoch() + (opts?.cooldownSec ?? AUTH_FAILURE_COOLDOWN_SEC),
    );
    return {
      switched: false,
      fromId: current.id,
      reason:
        "no alternate account after auth failure — re-login (forge login) or forge login --add",
    };
  }

  return switchAccount(provider, {
    reason: "auth-failure",
    cooldownPrevSec: opts?.cooldownSec ?? AUTH_FAILURE_COOLDOWN_SEC,
  });
}

/** Clear cooldown on one account (or all for a provider / all accounts). */
export function clearAccountCooldown(
  selectorOrProvider?: string,
): { cleared: number; ids: string[] } {
  const ids: string[] = [];
  if (!selectorOrProvider) {
    for (const a of listAccounts()) {
      if (a.cooldownUntil) {
        setAccountCooldown(a.id, undefined);
        ids.push(a.id);
      }
    }
    return { cleared: ids.length, ids };
  }
  // Exact id first
  const all = listAccounts();
  const byId = all.find((a) => a.id === selectorOrProvider);
  if (byId) {
    if (byId.cooldownUntil) {
      setAccountCooldown(byId.id, undefined);
      return { cleared: 1, ids: [byId.id] };
    }
    return { cleared: 0, ids: [] };
  }
  // Provider name → clear all for that provider
  const forProvider = all.filter(
    (a) => String(a.provider) === selectorOrProvider && a.cooldownUntil,
  );
  if (forProvider.length > 0) {
    for (const a of forProvider) {
      setAccountCooldown(a.id, undefined);
      ids.push(a.id);
    }
    return { cleared: ids.length, ids };
  }
  // Label / selector
  const hit = resolveAccountSelector(selectorOrProvider);
  if (hit.ok && hit.account.cooldownUntil) {
    setAccountCooldown(hit.account.id, undefined);
    return { cleared: 1, ids: [hit.account.id] };
  }
  return { cleared: 0, ids: [] };
}

/** Unattended multi-account readiness for a provider (or all). */
export interface MultiAccountReadiness {
  provider?: string;
  total: number;
  eligible: number;
  disabled: number;
  cooldown: number;
  expiredNoRefresh: number;
  withRefreshToken: number;
  apiKey: number;
  autoSwitch: boolean;
  switchThresholdPercent: number;
  /** True when ≥2 eligible same-provider accounts exist (or across providers when no filter). */
  multiAccountReady: boolean;
  /** Human one-liner for doctor / status. */
  summary: string;
  warnings: string[];
}

export function assessMultiAccountReadiness(
  provider?: string,
): MultiAccountReadiness {
  const settings = getAutoSwitchSettings();
  const rows = listAccounts(provider);
  let eligible = 0;
  let disabled = 0;
  let cooldown = 0;
  let expiredNoRefresh = 0;
  let withRefreshToken = 0;
  let apiKey = 0;
  const warnings: string[] = [];

  // Per-provider eligible counts for multi readiness
  const eligibleByProvider = new Map<string, number>();

  for (const a of rows) {
    if (a.disabled) {
      disabled += 1;
      continue;
    }
    if (isAccountInCooldown(a)) {
      cooldown += 1;
      continue;
    }
    if (isExpired(a, 60) && !a.refreshToken) {
      expiredNoRefresh += 1;
      continue;
    }
    eligible += 1;
    const p = String(a.provider);
    eligibleByProvider.set(p, (eligibleByProvider.get(p) || 0) + 1);
    if (a.refreshToken) withRefreshToken += 1;
    if (a.method === "api_key") apiKey += 1;
  }

  let multiAccountReady = false;
  if (provider) {
    multiAccountReady = eligible >= 2;
  } else {
    multiAccountReady = [...eligibleByProvider.values()].some((n) => n >= 2);
  }

  if (rows.length === 0) {
    warnings.push("No stored accounts — forge login");
  } else if (eligible === 0) {
    warnings.push(
      "No eligible accounts (all disabled, in cooldown, or expired without refresh) — forge login --add or clear-cooldown",
    );
  } else if (!multiAccountReady && rows.length >= 1) {
    warnings.push(
      "Only one eligible account per provider — unattended failover needs forge login --add",
    );
  }
  if (expiredNoRefresh > 0) {
    warnings.push(
      `${expiredNoRefresh} account(s) expired without refresh_token — re-login or use API keys for multi-day`,
    );
  }
  if (cooldown > 0) {
    warnings.push(
      `${cooldown} account(s) in cooldown — forge accounts clear-cooldown`,
    );
  }
  if (!settings.autoSwitch && multiAccountReady) {
    warnings.push("auto-switch is off — quota/429 will not fail over");
  }

  // OAuth-only stacks: warn if no RT and no API key for long unattended
  if (
    eligible > 0 &&
    withRefreshToken === 0 &&
    apiKey === 0 &&
    rows.some((a) => a.method !== "api_key")
  ) {
    warnings.push(
      "No refresh_token or API key among eligible accounts — multi-hour OAuth may die mid-run",
    );
  }

  const summary =
    rows.length === 0
      ? "no accounts"
      : `${eligible}/${rows.length} eligible` +
        (multiAccountReady ? " · multi-account ready" : " · single-account") +
        (settings.autoSwitch ? " · auto-switch on" : " · auto-switch off") +
        (cooldown ? ` · ${cooldown} cooling` : "");

  return {
    provider,
    total: rows.length,
    eligible,
    disabled,
    cooldown,
    expiredNoRefresh,
    withRefreshToken,
    apiKey,
    autoSwitch: settings.autoSwitch,
    switchThresholdPercent: settings.switchThresholdPercent,
    multiAccountReady,
    summary,
    warnings,
  };
}

function formatRelativeSec(untilEpochSec: number, now = nowEpoch()): string {
  const left = Math.max(0, untilEpochSec - now);
  if (left < 60) return `${left}s`;
  if (left < 3600) return `${Math.round(left / 60)}m`;
  if (left < 86400) return `${(left / 3600).toFixed(1)}h`;
  return `${(left / 86400).toFixed(1)}d`;
}

function shortId(id: string): string {
  // xai:alice-x-com-ab12cd → keep full if short; else trim middle of slug
  if (id.length <= 28) return id;
  const colon = id.indexOf(":");
  if (colon > 0 && id.length - colon > 20) {
    const p = id.slice(0, colon + 1);
    const slug = id.slice(colon + 1);
    return `${p}${slug.slice(0, 10)}…${slug.slice(-6)}`;
  }
  return `${id.slice(0, 14)}…${id.slice(-8)}`;
}

/** Record a plan probe against an account id. */
export function recordAccountPlan(
  accountId: string,
  plan: {
    percent?: number;
    used?: number;
    remaining?: number;
    limit?: number;
    unit?: string;
    source?: string;
  },
): void {
  const snap: AccountPlanSnapshot = {
    fetchedAt: nowEpoch(),
    percent: plan.percent,
    used: plan.used,
    remaining: plan.remaining,
    limit: plan.limit,
    unit: plan.unit,
    source: plan.source,
  };
  setAccountPlan(accountId, snap);
}

/**
 * Format multi-account status for CLI / slash (no tokens).
 * Includes unattended readiness summary for heavy users.
 */
export function formatAccountsTable(provider?: string): string {
  const settings = getAutoSwitchSettings();
  const rows = listAccountSummaries(provider);
  if (rows.length === 0) {
    return "No stored accounts. Run: forge login";
  }
  const readiness = assessMultiAccountReadiness(provider);
  const lines: string[] = [];
  lines.push(
    `Auto-switch: ${settings.autoSwitch ? "on" : "off"}  threshold: ${settings.switchThresholdPercent}% used  ·  ${readiness.summary}`,
  );
  lines.push("");
  for (const r of rows) {
    const mark = r.active ? "*" : " ";
    const flags: string[] = [];
    if (r.disabled) flags.push("disabled");
    if (r.expired) flags.push("EXPIRED");
    if (!r.hasRefreshToken && r.method !== "api_key") flags.push("no-refresh");
    if (r.cooldownUntil && Date.parse(r.cooldownUntil) > Date.now()) {
      const untilSec = Math.floor(Date.parse(r.cooldownUntil) / 1000);
      flags.push(`cooldown ${formatRelativeSec(untilSec)} left`);
    }
    if (r.priority) flags.push(`prio=${r.priority}`);
    if (typeof r.lastPlanPercent === "number") {
      flags.push(`usage=${r.lastPlanPercent}%`);
    }
    const flagStr = flags.length ? `  [${flags.join(", ")}]` : "";
    const label = r.accountLabel || r.subscription || "(no label)";
    const idCol = shortId(r.id).padEnd(28);
    lines.push(
      `${mark} ${idCol} ${r.provider.padEnd(10)} ${r.method.padEnd(12)} ${label}${flagStr}`,
    );
  }
  lines.push("");
  if (readiness.warnings.length) {
    for (const w of readiness.warnings.slice(0, 3)) {
      lines.push(`  ⚠ ${w}`);
    }
  }
  lines.push(
    "  * = active  ·  forge accounts switch <id|label>  ·  forge accounts status  ·  forge login --add",
  );
  return lines.join("\n");
}

/** Format readiness-only block (forge accounts status / doctor). */
export function formatMultiAccountReadiness(provider?: string): string {
  const r = assessMultiAccountReadiness(provider);
  const lines: string[] = [
    `Multi-account: ${r.summary}`,
    `  total=${r.total} eligible=${r.eligible} cooldown=${r.cooldown} disabled=${r.disabled} expired-no-rt=${r.expiredNoRefresh}`,
    `  refresh_token=${r.withRefreshToken} api_key=${r.apiKey} auto-switch=${r.autoSwitch ? "on" : "off"} threshold=${r.switchThresholdPercent}%`,
  ];
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  if (r.multiAccountReady && r.autoSwitch) {
    lines.push(
      "  ✓ Ready for unattended failover on quota/429 (same-provider alternates)",
    );
  }
  return lines.join("\n");
}

/** Public summaries for doctor --json (never tokens). */
export function multiAccountDoctorFields(provider?: string): {
  multiAccount: MultiAccountReadiness;
  accounts: AccountSummary[];
} {
  return {
    multiAccount: assessMultiAccountReadiness(provider),
    accounts: listAccountSummaries(provider),
  };
}

/** Build ResolvedAuth from an account (caller fills baseUrl). */
export function resolvedFromAccount(
  acc: AccountCredential,
  baseUrl?: string,
): ResolvedAuth {
  return {
    provider: acc.provider,
    method: acc.method,
    token: acc.accessToken,
    baseUrl,
    accountLabel: acc.accountLabel ?? acc.subscription,
    accountId: acc.id,
  };
}

/** Count accounts per provider (for UI badges). */
export function accountCountByProvider(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of listAccounts()) {
    const p = String(a.provider);
    out[p] = (out[p] || 0) + 1;
  }
  return out;
}

export function formatAccountBadge(auth: ResolvedAuth | null): string {
  if (!auth) return "";
  const n = listAccounts(String(auth.provider)).length;
  const label = auth.accountLabel || auth.accountId || auth.method;
  if (n <= 1) return label;
  return `${label} · ${n} accounts`;
}
