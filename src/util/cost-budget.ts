/**
 * Session spend cap helpers (estimateCostUsd — not a bill).
 *
 * Unattended ULW can burn real money; experts need a hard release valve
 * parallel to max_turns. Cap sources (highest wins for "set"):
 *   1. session.meta.maxCostUsd when defined (including 0 = unlimited)
 *   2. config.maxCostUsd / FORGE_MAX_COST_USD / --max-cost
 *
 * 0 / unset = unlimited.
 */

import type { ForgeConfig } from "../config/types.js";
import type { SessionMeta } from "../session/session.js";
import { estimateCostUsd } from "./format.js";

/** Max accepted USD cap (guards typos like 1e12). */
export const MAX_COST_USD_CEILING = 1_000_000;

/**
 * Parse a USD amount from CLI/env/slash input.
 * Accepts: "5", "5.00", "$5", "5usd", "0" (unlimited).
 * Returns null when present-but-invalid (caller fails closed).
 * Returns undefined when omitted/empty (caller keeps default).
 */
export function parseCostUsd(raw: unknown): number | null | undefined {
  if (raw == null) return undefined;
  let s = String(raw).trim();
  if (s === "") return null;
  // Bare keywords for unlimited
  if (/^(off|none|unlimited|inf(inity)?)$/i.test(s)) return 0;
  s = s.replace(/^\$/, "").replace(/\s*usd\s*$/i, "").trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > MAX_COST_USD_CEILING) return null;
  // Round to 4 decimal places (sub-cent HUD precision)
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Effective session spend cap in USD.
 * `null` means unlimited.
 */
export function resolveMaxCostUsd(
  config: Pick<ForgeConfig, "maxCostUsd"> | null | undefined,
  sessionMeta?: Pick<SessionMeta, "maxCostUsd"> | null,
): number | null {
  // Session override wins when the key is present (including explicit 0).
  if (
    sessionMeta &&
    Object.prototype.hasOwnProperty.call(sessionMeta, "maxCostUsd") &&
    sessionMeta.maxCostUsd !== undefined
  ) {
    const s = sessionMeta.maxCostUsd;
    if (typeof s === "number" && Number.isFinite(s) && s > 0) return s;
    return null; // 0 / NaN → unlimited
  }
  const c = config?.maxCostUsd;
  if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  return null;
}

/** Running session estimate (full session totals, not just this prompt). */
export function sessionCostUsd(
  provider: string,
  meta: Pick<
    SessionMeta,
    "totalPromptTokens" | "totalCompletionTokens" | "totalCacheReadTokens"
  >,
  model?: string,
): number {
  return estimateCostUsd(
    provider,
    meta.totalPromptTokens || 0,
    meta.totalCompletionTokens || 0,
    model,
    meta.totalCacheReadTokens || 0,
  );
}

export interface CostCapStatus {
  /** Effective cap, or null when unlimited. */
  cap: number | null;
  /** Current session estimate. */
  spent: number;
  /** spent >= cap when capped. */
  hit: boolean;
  /** Fraction of cap used (0–1+), null when unlimited. */
  ratio: number | null;
  /** Remaining USD before cap, null when unlimited. */
  remaining: number | null;
}

export type CostCapMeta = Pick<
  SessionMeta,
  | "maxCostUsd"
  | "totalPromptTokens"
  | "totalCompletionTokens"
  | "totalCacheReadTokens"
>;

export function costCapStatus(
  config: Pick<ForgeConfig, "maxCostUsd" | "provider" | "model">,
  meta: CostCapMeta,
): CostCapStatus {
  const cap = resolveMaxCostUsd(config, meta);
  const spent = sessionCostUsd(String(config.provider), meta, config.model);
  if (cap == null) {
    return { cap: null, spent, hit: false, ratio: null, remaining: null };
  }
  const remaining = Math.max(0, cap - spent);
  return {
    cap,
    spent,
    hit: spent >= cap,
    ratio: cap > 0 ? spent / cap : null,
    remaining,
  };
}

export interface PinChildCostCapResult {
  /** Parent already HIT — do not spawn. */
  refuse: boolean;
  /** Remaining USD pinned onto the child, or null when unlimited. */
  remaining: number | null;
  /** Family cap, or null when unlimited. */
  cap: number | null;
}

/**
 * Pin a child's session spend cap to the family's remaining budget.
 *
 * `/budget` is a family valve. Children used to inherit `config.maxCostUsd`
 * on a fresh session (spent $0), so each explore got a new full cap while
 * the parent was already near HIT. Session `0` means unlimited — never pin
 * remaining `0` (that would lift the cap). Refuse spawn instead.
 */
/** Slice of remaining family budget held for explore/play on re-PLAN. */
export const LOOK_BUDGET_RESERVE = 0.15;

export function pinChildCostCap(
  childMeta: { maxCostUsd?: number },
  parentConfig: Pick<ForgeConfig, "maxCostUsd" | "provider" | "model">,
  parentMeta: CostCapMeta,
  opts?: { role?: string; reserveLook?: boolean },
): PinChildCostCapResult {
  const st = costCapStatus(parentConfig, parentMeta);
  if (st.cap == null) {
    return { refuse: false, remaining: null, cap: null };
  }
  const remaining = Math.round((st.remaining ?? 0) * 10_000) / 10_000;
  if (st.hit || remaining <= 0) {
    return { refuse: true, remaining: 0, cap: st.cap };
  }
  const role = (opts?.role || "").toLowerCase();
  const look = role === "explore" || role === "plan";
  let pin = remaining;
  if (opts?.reserveLook && !look) {
    pin = Math.round(remaining * (1 - LOOK_BUDGET_RESERVE) * 10_000) / 10_000;
    if (pin <= 0) {
      return { refuse: true, remaining: 0, cap: st.cap };
    }
  }
  childMeta.maxCostUsd = pin;
  return { refuse: false, remaining: pin, cap: st.cap };
}

/** Human one-liner for /cost / /budget / HUD. */
export function formatCostBudgetLine(status: CostCapStatus): string {
  if (status.cap == null) {
    return `budget: unlimited  (spent ~$${status.spent.toFixed(status.spent < 0.01 ? 4 : 3)})`;
  }
  const pct = status.ratio != null ? Math.round(status.ratio * 100) : 0;
  const spent = status.spent.toFixed(status.spent < 0.01 ? 4 : 3);
  const cap = status.cap.toFixed(status.cap < 0.01 ? 4 : 3);
  const rem = (status.remaining ?? 0).toFixed(
    (status.remaining ?? 0) < 0.01 ? 4 : 3,
  );
  if (status.hit) {
    return `budget: HIT  spent ~$${spent} / $${cap} (${pct}%)`;
  }
  return `budget: ~$${spent} / $${cap} (${pct}%)  remaining ~$${rem}`;
}
