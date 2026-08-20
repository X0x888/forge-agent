/**
 * `/budget` — the sit-down key for the session spend cap.
 *
 * Sit-down already shows `budget HIT` + `Next  /budget`. Typing it used to
 * dump `FORGE_MAX_COST_USD` / `config.toml` (a lecture, not a card).
 * `/budget off` left `lastError.code=max_cost` in place, so `/retry`
 * still refused. Trust is the key you type: raise or clear the cap,
 * see `budget  ·  ok` / `none`, then `/retry` can run.
 *
 * Estimate only — not a bill. CLI env/config dumps stay off ›.
 */
import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import { pushLiveNotice } from "../harness/live-notices.js";
import {
  clearSessionLastError,
  saveSession,
  type SessionData,
} from "../session/session.js";
import {
  costCapStatus,
  parseCostUsd,
  type CostCapStatus,
} from "../util/cost-budget.js";
import { formatVerifyCloser } from "./verify-card.js";

export type BudgetKind = "none" | "ok" | "hit" | "invalid";

export type BudgetVerb = "peek" | "set" | "invalid";

export interface BudgetArg {
  verb: BudgetVerb;
  /** Present for set (0 = unlimited) or the raw invalid token. */
  amount?: number;
  raw?: string;
}

const PEEK_TOKS = new Set(["", "status", "show", "?"]);

export function parseBudgetArg(arg?: string): BudgetArg {
  const raw = String(arg || "").trim();
  const head = (raw.split(/\s+/)[0] || "").toLowerCase();
  if (!head || PEEK_TOKS.has(head)) return { verb: "peek" };
  const parsed = parseCostUsd(raw);
  if (parsed === null || parsed === undefined) {
    return { verb: "invalid", raw };
  }
  return { verb: "set", amount: parsed, raw };
}

export function budgetKindFromStatus(st: CostCapStatus): BudgetKind {
  if (st.cap == null) return "none";
  if (st.hit) return "hit";
  return "ok";
}

/** Next after you type `/budget`. HIT → `/budget off`. none → `/budget 5`. ok → none. */
export function budgetNextKeys(kind: BudgetKind): string[] {
  if (kind === "none" || kind === "invalid") return ["/budget 5"];
  if (kind === "hit") return ["/budget off"];
  return [];
}

export function shouldClearMaxCostLastError(
  err: { code?: string } | null | undefined,
  st: CostCapStatus,
): boolean {
  if (String(err?.code || "") !== "max_cost") return false;
  return !st.hit;
}

export function formatBudgetUsd(n: number): string {
  if (!Number.isFinite(n)) return "0.00";
  if (n === 0) return "0.00";
  return n.toFixed(n < 0.01 ? 4 : 2);
}

export function formatBudgetSpendLine(st: CostCapStatus): string {
  if (st.cap == null) {
    return `unlimited  ·  spent ~$${formatBudgetUsd(st.spent)}  (est, not a bill)`;
  }
  return `$${formatBudgetUsd(st.spent)} / $${formatBudgetUsd(st.cap)}  (est, not a bill)`;
}

export function formatBudgetVerdict(
  kind: BudgetKind,
  opts?: { color?: boolean },
): string {
  const color = opts?.color !== false;
  const title = color ? chalk.bold("budget") : "budget";
  const bit = (text: string, paint: (s: string) => string) =>
    color ? paint(text) : text;
  if (kind === "none") return `${title}  ·  ${bit("none", chalk.dim)}`;
  if (kind === "invalid") return `${title}  ·  ${bit("invalid", chalk.yellow)}`;
  if (kind === "hit") return `${title}  ·  ${bit("HIT", chalk.red)}`;
  return `${title}  ·  ${bit("ok", chalk.green)}`;
}

export function formatBudgetCard(input: {
  kind: BudgetKind;
  status?: CostCapStatus;
  note?: string;
  next?: string[];
  color?: boolean;
  columns?: number;
}): string {
  const color = input.color !== false;
  const lines = [formatBudgetVerdict(input.kind, { color })];
  if (input.status && input.kind !== "invalid") {
    const row = `  ${formatBudgetSpendLine(input.status)}`;
    lines.push(color ? chalk.dim(row) : row);
  }
  const note = input.note?.trim();
  if (note) {
    lines.push(color ? chalk.yellow(`  ${note}`) : `  ${note}`);
  }
  const next = input.next ?? budgetNextKeys(input.kind);
  const closer = formatVerifyCloser(next, { columns: input.columns });
  if (closer) lines.push(closer);
  return lines.filter((l) => l.length > 0).join("\n");
}

function cardForStatus(
  st: CostCapStatus,
  opts?: { note?: string; color?: boolean },
): string {
  const kind = budgetKindFromStatus(st);
  return formatBudgetCard({
    kind,
    status: st,
    note: opts?.note,
    next: budgetNextKeys(kind),
    color: opts?.color,
  });
}

export function applyBudgetOverride(opts: {
  session: SessionData;
  config: Pick<ForgeConfig, "maxCostUsd" | "provider" | "model">;
  amount: number;
  persist?: boolean;
  notify?: boolean;
}): CostCapStatus {
  opts.session.meta.maxCostUsd = opts.amount;
  if (opts.persist !== false) {
    try {
      saveSession(opts.session);
    } catch {
      /* best-effort */
    }
  }
  const st = costCapStatus(opts.config, opts.session.meta);
  if (shouldClearMaxCostLastError(opts.session.meta.lastError, st)) {
    clearSessionLastError(opts.session);
    if (opts.persist !== false) {
      try {
        saveSession(opts.session);
      } catch {
        /* */
      }
    }
  }
  if (opts.notify !== false) {
    try {
      pushLiveNotice(
        opts.session.meta.id,
        opts.amount === 0
          ? "User cleared the session spend cap (/budget off). Continue normally — no hitCostCap release."
          : `User set session spend cap to $${opts.amount} (/budget). Prefer finishing the current wave and verifying before the estimate hits the cap (hitCostCap releases cleanly). Estimate only — not a bill.`,
      );
    } catch {
      /* */
    }
  }
  return st;
}

export function runBudget(opts: {
  session: SessionData;
  config: Pick<ForgeConfig, "maxCostUsd" | "provider" | "model">;
  arg?: string;
  color?: boolean;
  persist?: boolean;
  notify?: boolean;
}): { output: string; failed?: boolean; session?: SessionData } {
  const color = opts.color !== false;
  const parsed = parseBudgetArg(opts.arg);
  if (parsed.verb === "peek") {
    const st = costCapStatus(opts.config, opts.session.meta);
    return { output: cardForStatus(st, { color }) };
  }
  if (parsed.verb === "invalid") {
    const raw = parsed.raw || "";
    return {
      output: formatBudgetCard({
        kind: "invalid",
        note: `"${raw}" is not a USD amount (e.g. 5, $2.50) or off.`,
        next: ["/budget 5", "/budget off"],
        color,
      }),
      failed: true,
    };
  }
  const amount = parsed.amount ?? 0;
  const st = applyBudgetOverride({
    session: opts.session,
    config: opts.config,
    amount,
    persist: opts.persist,
    notify: opts.notify,
  });
  const note =
    amount === 0
      ? "cleared for this session"
      : `set $${formatBudgetUsd(amount)} for this session`;
  return {
    output: cardForStatus(st, { note, color }),
    session: opts.session,
  };
}
