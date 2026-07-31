/**
 * Production warnings for forge run --json / doctor what-if.
 * Pure-ish: may read git snapshot + session inventory (best-effort).
 */

import type { ForgeConfig } from "../config/types.js";
import { getGitSnapshot } from "./git-context.js";
import { listSessions } from "../session/session.js";

export interface ProductionWarningOpts {
  ultrawork?: boolean;
  sessionMaxCostUsd?: number;
  /** Post-run: agent released on spend cap. */
  hitCostCap?: boolean;
  /** Post-run: agent released on maxTurns. */
  hitMaxTurns?: boolean;
  /** Post-run: stop-continue safety valve. */
  releasedOnContinueCap?: boolean;
  /**
   * Test hooks — inject dirty-file count / session inventory so unit tests
   * do not depend on the real git tree or ~/.forge sessions.
   */
  _testDirtyFiles?: number;
  _testSessionCount?: number;
  _testPinnedCount?: number;
}

/**
 * Build productionWarnings[] for headless JSON / CI.
 * Never throws.
 */
export function productionWarningsForRun(
  config: ForgeConfig,
  opts?: ProductionWarningOpts,
): string[] {
  const warnings: string[] = [];
  try {
    if (config.sandbox === "off") {
      warnings.push("sandbox=off — bash runs unsandboxed");
    }
    if (config.permissionMode === "bypassPermissions") {
      warnings.push(
        "permissionMode=bypassPermissions (yolo) — tools auto-approved",
      );
    }
    if (config.permissionMode === "dontAsk") {
      warnings.push(
        "permissionMode=dontAsk — permission prompts auto-deny; ask_user unavailable (state assumptions)",
      );
    }
    {
      const dontAskEnv = process.env.FORGE_DONT_ASK?.trim();
      if (
        dontAskEnv &&
        ["1", "true", "on", "yes"].includes(dontAskEnv.toLowerCase())
      ) {
        warnings.push(
          `FORGE_DONT_ASK=${dontAskEnv} — interactive asks disabled (permissions + ask_user)`,
        );
      }
    }
    if (config.permissionMode === "plan") {
      warnings.push(
        "permissionMode=plan — mutations denied; use /build (or --permission-mode acceptEdits) to implement",
      );
    }
    if ((config.sandboxMissingBackend || "fail-closed") === "fallback") {
      warnings.push(
        "sandbox-missing=fallback — bash may run unsandboxed when backend is absent",
      );
    }
    if ((config.readOutsideWorkspace || "ask") === "allow") {
      warnings.push(
        "read-outside=allow — absolute paths outside workspace readable without prompt",
      );
    }
    if (config.blockingStopHooks === false) {
      warnings.push(
        "blockingStopHooks=false — Stop hooks will not re-anchor the agent",
      );
    }
    if (typeof config.maxCostUsd === "number" && config.maxCostUsd > 0) {
      warnings.push(
        `maxCostUsd=$${config.maxCostUsd} — session spend estimate will release the agent at the cap (estimateCostUsd, not a bill)`,
      );
    }
    // Unattended ULW without a spend cap is a common expert footgun.
    {
      const sessionCap =
        opts &&
        Object.prototype.hasOwnProperty.call(opts, "sessionMaxCostUsd") &&
        typeof opts.sessionMaxCostUsd === "number"
          ? opts.sessionMaxCostUsd
          : undefined;
      const effectiveCap =
        sessionCap !== undefined
          ? sessionCap > 0
            ? sessionCap
            : null
          : typeof config.maxCostUsd === "number" && config.maxCostUsd > 0
            ? config.maxCostUsd
            : null;
      if (opts?.ultrawork && effectiveCap == null) {
        warnings.push(
          "ULW armed without a spend cap — set --max-cost N, FORGE_MAX_COST_USD, max_cost_usd, or /budget N so unattended runs cannot runaway-spend",
        );
      }
    }
    // Dirty tree blast radius (best-effort; never block run on git failure).
    // Only surface when ULW is armed (unattended blast radius) or the tree is
    // extremely dirty (≥100) — a normal 40-file WIP should not spam every run.
    try {
      const n =
        typeof opts?._testDirtyFiles === "number"
          ? opts._testDirtyFiles
          : (() => {
              try {
                const g = getGitSnapshot(config.workspace || process.cwd());
                return typeof g.changedFiles === "number"
                  ? g.changedFiles
                  : null;
              } catch {
                return null;
              }
            })();
      if (typeof n === "number") {
        if (opts?.ultrawork && n >= 20) {
          warnings.push(
            `git dirty tree has ${n} changed files under ULW — commit/stash before long unattended runs or use /plan first`,
          );
        } else if (!opts?.ultrawork && n >= 100) {
          warnings.push(
            `git dirty tree has ${n} changed files — commit/stash before long ULW or use /plan first`,
          );
        }
      }
    } catch {
      /* */
    }
    // Large session inventory (best-effort; never block run on list failure)
    try {
      let total: number;
      let pinned: number;
      if (
        typeof opts?._testSessionCount === "number" ||
        typeof opts?._testPinnedCount === "number"
      ) {
        total = opts._testSessionCount ?? 0;
        pinned = opts._testPinnedCount ?? 0;
      } else {
        const all = listSessions({ limit: 10_000 });
        total = all.length;
        pinned = all.filter((s) => Boolean(s.pinned)).length;
      }
      if (total >= 100) {
        warnings.push(
          `${total} sessions on disk — consider forge sessions prune --keep 50 (lastError sessions kept unless --force-last-error)`,
        );
      }
      if (pinned >= 10) {
        warnings.push(
          `${pinned} pinned sessions (prune-protected) — forge sessions pinned · /sessions unpin <id> stale keepers`,
        );
      }
    } catch {
      /* */
    }
    // Post-run safety valves — CI can grep productionWarnings without special-casing
    // hitCostCap/hitMaxTurns/releasedOnContinueCap fields (those remain first-class too).
    if (opts?.hitCostCap) {
      warnings.push(
        "hitCostCap — session spend estimate reached max_cost_usd / FORGE_MAX_COST_USD / --max-cost / /budget (estimateCostUsd, not a bill). Raise the cap or /budget off to continue.",
      );
    }
    if (opts?.hitMaxTurns) {
      warnings.push(
        "hitMaxTurns — agent turn cap reached (max_turns / FORGE_MAX_TURNS / --max-turns). Raise the cap or continue with forge run --continue.",
      );
    }
    if (opts?.releasedOnContinueCap) {
      warnings.push(
        "releasedOnContinueCap — stop-continue safety valve fired (length / content_filter / empty / Stop-block cap). Narrow the task or raise FORGE_ULW_MAX_CONTINUES / maxStopContinues.",
      );
    }
  } catch {
    /* never throw from warnings */
  }
  return warnings;
}
