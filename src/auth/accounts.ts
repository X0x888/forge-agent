/**
 * Multi-account management + smart switching.
 *
 * Users may store several logins per provider (e.g. two SuperGrok emails).
 * When auto-switch is on, Forge picks another same-provider account when:
 *  - proactive: last known plan usage ≥ switchThresholdPercent
 *  - reactive: 429 / quota / rate-limit / insufficient credits mid-run
 *
 * Env keys still win (CI determinism) and never auto-switch away from env.
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
  setAccountCooldown,
  setAccountPlan,
  setActiveAccount,
} from "./store.js";
import type {
  AccountCredential,
  AccountPlanSnapshot,
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

  // Prefer lower plan usage when known
  const plan = acc.lastPlan;
  if (plan && typeof plan.percent === "number") {
    // 0% used → +100k; 100% used → 0
    score += (100 - Math.min(100, Math.max(0, plan.percent))) * 1000;
  } else if (plan && typeof plan.remaining === "number") {
    score += Math.min(100_000, Math.max(0, plan.remaining));
  } else {
    // Unknown usage: neutral mid boost so labeled/priority still wins
    score += 50_000;
  }

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
 * No-op when autoSwitch is off, only one account, or usage unknown/below threshold.
 */
export function maybeProactiveSwitch(provider: string): SwitchResult {
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

  const percent = current.lastPlan?.percent;
  const remaining = current.lastPlan?.remaining;
  const threshold = settings.switchThresholdPercent;
  let should = false;
  let why = "";

  if (typeof percent === "number" && percent >= threshold) {
    should = true;
    why = `plan usage ${percent}% ≥ ${threshold}%`;
  } else if (
    typeof remaining === "number" &&
    remaining <= 0 &&
    current.lastPlan
  ) {
    should = true;
    why = "plan remaining ≤ 0";
  } else if (isAccountInCooldown(current)) {
    should = true;
    why = "active account in cooldown";
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
      reason: "no alternate account after quota failure",
    };
  }

  return switchAccount(provider, {
    reason: "quota/rate-limit",
    cooldownPrevSec: opts?.cooldownSec ?? DEFAULT_COOLDOWN_SEC,
  });
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
 */
export function formatAccountsTable(provider?: string): string {
  const settings = getAutoSwitchSettings();
  const rows = listAccountSummaries(provider);
  if (rows.length === 0) {
    return "No stored accounts. Run: forge login";
  }
  const lines: string[] = [];
  lines.push(
    `Auto-switch: ${settings.autoSwitch ? "on" : "off"}  threshold: ${settings.switchThresholdPercent}% used`,
  );
  lines.push("");
  for (const r of rows) {
    const mark = r.active ? "*" : " ";
    const flags: string[] = [];
    if (r.disabled) flags.push("disabled");
    if (r.expired) flags.push("EXPIRED");
    if (r.cooldownUntil && Date.parse(r.cooldownUntil) > Date.now()) {
      flags.push(`cooldown→${r.cooldownUntil}`);
    }
    if (r.priority) flags.push(`prio=${r.priority}`);
    if (typeof r.lastPlanPercent === "number") {
      flags.push(`usage=${r.lastPlanPercent}%`);
    }
    const flagStr = flags.length ? `  [${flags.join(", ")}]` : "";
    const label = r.accountLabel || r.subscription || "(no label)";
    lines.push(
      `${mark} ${r.id.padEnd(36)} ${r.provider.padEnd(10)} ${r.method.padEnd(12)} ${label}${flagStr}`,
    );
  }
  lines.push("");
  lines.push("  * = active  ·  forge accounts switch <id|label>  ·  forge login --add");
  return lines.join("\n");
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
