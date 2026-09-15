/**
 * /setup + forge setup — first-day hub.
 */
import type { ForgeConfig } from "../config/types.js";
import type { SessionData } from "../session/session.js";
import type { ResolvedAuth } from "../auth/types.js";
import {
  loadPreferences,
  savePreferences,
} from "../config/preferences.js";
import { isBellEnabled, isNotifyEnabled } from "../util/attention.js";
import { parseCostUsd, resolveMaxCostUsd } from "../util/cost-budget.js";
import {
  assessSetupReadiness,
  formatSetupCard,
  formatSetupCompactLine,
  parseSetupAction,
  setupCliAction,
  SETUP_DEFAULT_BUDGET_USD,
  type SetupAssessment,
} from "../util/setup-readiness.js";

export interface SetupContext {
  config: ForgeConfig;
  session?: SessionData | null;
  auth?: ResolvedAuth | null;
  workspace?: string;
}

export function lspDisabled(): boolean {
  const v = (process.env.FORGE_LSP || "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

export async function collectSetupAssessment(
  ctx: SetupContext,
): Promise<SetupAssessment> {
  const workspace =
    ctx.workspace ||
    ctx.config.workspace ||
    ctx.session?.meta.cwd ||
    process.cwd();
  let projectRulesCount = 0;
  try {
    const { listProjectRulePaths } = await import("../agent/system-prompt.js");
    projectRulesCount = listProjectRulePaths(workspace).length;
  } catch {
    /* */
  }
  let lspMissing: string[] = [];
  const disabled = lspDisabled();
  if (!disabled) {
    try {
      const { buildEnsurePlan } = await import("../lsp/ensure.js");
      const plan = buildEnsurePlan(workspace);
      lspMissing = plan.items
        .filter(
          (i) =>
            (i.tier === "default" || i.tier === "project") && !i.onPath,
        )
        .map((i) => String(i.languageId));
    } catch {
      /* */
    }
  }
  let prefs: ReturnType<typeof loadPreferences> = { version: 1 };
  try {
    prefs = loadPreferences();
  } catch {
    /* */
  }
  return assessSetupReadiness({
    authenticated: Boolean(ctx.auth),
    provider: String(ctx.auth?.provider || ctx.config.provider || "xai"),
    model: String(ctx.config.model || ""),
    seenProviderModelConfirm: Boolean(prefs.seenProviderModelConfirm),
    effectiveMaxCostUsd: resolveMaxCostUsd(ctx.config, ctx.session?.meta),
    projectRulesCount,
    notifyOn: isNotifyEnabled(),
    bellOn: isBellEnabled(),
    lspMissing,
    lspDisabled: disabled,
  });
}

export const SETUP_CLI_USAGE =
  "Usage: forge setup [model|budget [N]|notify|lsp|init|scaffold|json]\n" +
  "  forge setup              first-day card\n" +
  "  forge setup model        confirm provider/model\n" +
  "  forge setup budget 5     persist spend cap (omit N → peek)\n" +
  "  forge setup notify       turn-end desktop notify\n" +
  "  forge setup --json\n" +
  "  Numbered 1–6 are /setup at ›, not forge setup 1";

export function setupJsonPayload(
  r: SetupAssessment,
  extra?: Record<string, unknown>,
  opts?: { surface?: "repl" | "cli" },
): Record<string, unknown> {
  const surface = opts?.surface ?? "repl";
  return {
    ok: true,
    ready: r.ready,
    total: r.total,
    blocking: r.blocking,
    recommendedOpen: r.recommendedOpen,
    items: r.items.map((i) => ({
      id: i.id,
      ready: i.ready,
      label: i.label,
      detail: i.detail,
      action:
        surface === "cli" ? (setupCliAction(i.id) ?? i.action) : i.action,
      severity: i.severity,
    })),
    ...extra,
  };
}

/** Parse `/setup budget` / `forge setup budget` amount. Empty → peek, do not write. */
export function resolveSetupBudgetAmount(
  raw?: string,
):
  | { ok: true; peek: true }
  | { ok: true; peek: false; amount: number }
  | { ok: false; raw: string } {
  const t = String(raw ?? "").trim();
  if (!t) return { ok: true, peek: true };
  const n = parseCostUsd(t);
  if (n == null) return { ok: false, raw: t };
  return { ok: true, peek: false, amount: n };
}

/** Sticky spend cap so `forge config --json` / the next `forge setup` see it. Throws if the write does not land. */
export function persistSetupBudget(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    savePreferences({ maxCostUsd: null, seenSetup: true });
    return;
  }
  savePreferences({ maxCostUsd: amount, budgetExplicit: true, seenSetup: true });
}

export {
  formatSetupCard,
  formatSetupCompactLine,
  parseSetupAction,
  setupCliAction,
  SETUP_DEFAULT_BUDGET_USD,
};

export function markSetupSeen(): void {
  savePreferences({ seenSetup: true, seenWelcomeTip: true });
}

export function markSetupSkipped(): void {
  savePreferences({
    setupSkipped: true,
    seenSetup: true,
    seenWelcomeTip: true,
  });
}

export function markProviderModelConfirmed(): void {
  savePreferences({ seenProviderModelConfirm: true, seenSetup: true });
}
