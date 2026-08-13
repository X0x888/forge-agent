import type { ForgeConfig } from "../config/types.js";
import {
  defaultMaxOutputTokens,
  modelContextWindow,
  resolveEffectiveMaxTokens,
} from "../config/model-info.js";
import {
  clampEffortForModel,
  resolveReasoningEffort,
} from "../config/reasoning.js";
import { formatTokens } from "../util/format.js";

/**
 * Startup posture (pure): one-line sampling/context summary + warnings ONLY
 * for settings that silently degrade results (the "inferior by accident"
 * class). Everything else stays quiet — minimal informed, not noisy.
 */

export function postureHead(config: ForgeConfig): string {
  const effort = resolveReasoningEffort(config.model, config.reasoningEffort);
  const maxTok = resolveEffectiveMaxTokens(config, Boolean(effort));
  return (
    `posture: effort ${effort ?? "—"}${effort && !config.reasoningEffort ? " (model max)" : ""}` +
    ` · ctx ${formatTokens(config.contextWindow)}${config.contextWindowExplicit ? " (pinned)" : ""}` +
    ` · temp ${config.temperature ?? "default"}` +
    ` · max_tokens ${formatTokens(maxTok)}${config.maxTokensExplicit ? " (pinned)" : " (auto)"}` +
    (config.permissionMode === "plan"
      ? " · PLAN"
      : config.permissionMode === "bypassPermissions"
        ? " · YOLO"
        : "")
  );
}

export function postureWarnings(config: ForgeConfig): string[] {
  const warns: string[] = [];
  const effort = resolveReasoningEffort(config.model, config.reasoningEffort);
  const effortActive = Boolean(effort);

  if (config.temperature != null && effortActive) {
    warns.push(
      `temperature pinned to ${config.temperature} — reasoning models are tuned for the server default (/temperature default)`,
    );
  }
  if (config.maxTokensExplicit) {
    const auto = defaultMaxOutputTokens(config.model, effortActive);
    if (config.maxTokens < auto) {
      warns.push(
        `max_tokens ${config.maxTokens} is below the auto reasoning budget ${auto} — thinking may truncate mid-thought (/max-tokens auto)`,
      );
    }
  }
  const modelWin = modelContextWindow(config.model);
  if (
    config.contextWindowExplicit &&
    modelWin &&
    config.contextWindow < modelWin
  ) {
    warns.push(
      `context_window ${config.contextWindow} is below ${config.model}'s ${modelWin} — paid capacity unused (/context-window auto)`,
    );
  }
  if (config.reasoningEffort) {
    const clamped = clampEffortForModel(config.model, config.reasoningEffort);
    if (clamped && clamped !== config.reasoningEffort) {
      warns.push(
        `effort "${config.reasoningEffort}" is not a ${config.model} level — silently clamped to "${clamped}" (/effort ${clamped})`,
      );
    }
  }
  if (Array.isArray(config.fallbackModels) && config.fallbackModels.length === 0) {
    warns.push(
      `model fallback off — a 429/5xx on ${config.model} will abort the run (/fallback default)`,
    );
  }
  return warns;
}
