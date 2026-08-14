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
import { resolveMaxCostUsd } from "../util/cost-budget.js";
import {
  assessSetupReadiness,
  formatSetupCard,
  formatSetupCompactLine,
  parseSetupAction,
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

export function setupJsonPayload(
  r: SetupAssessment,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
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
      action: i.action,
      severity: i.severity,
    })),
    ...extra,
  };
}

export { formatSetupCard, formatSetupCompactLine, parseSetupAction };

export function markSetupSeen(): void {
  try {
    savePreferences({ seenSetup: true, seenWelcomeTip: true });
  } catch {
    /* */
  }
}

export function markSetupSkipped(): void {
  try {
    savePreferences({
      setupSkipped: true,
      seenSetup: true,
      seenWelcomeTip: true,
    });
  } catch {
    /* */
  }
}

export function markProviderModelConfirmed(): void {
  try {
    savePreferences({ seenProviderModelConfirm: true, seenSetup: true });
  } catch {
    /* */
  }
}
