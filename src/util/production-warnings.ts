/**
 * Production warnings for forge run --json / doctor what-if.
 * Pure-ish: may read git snapshot + session inventory (best-effort).
 */

import fs from "node:fs";
import path from "node:path";
import type { ForgeConfig } from "../config/types.js";
import { getGitSnapshot } from "./git-context.js";
import { listSessions } from "../session/session.js";
import {
  detectPackageManager,
  detectProjectIntel,
  hasNodeModules,
  packageManagerLockfileMismatch,
  multipleLockfiles,
} from "./project-intel.js";
import {
  normalizePermissionMode,
  normalizeSandboxProfile,
} from "./mode-aliases.js";
import { isFalsy } from "./bool.js";
import { isLastVerificationStale } from "../session/session.js";

export interface ProductionWarningOpts {
  ultrawork?: boolean;
  sessionMaxCostUsd?: number;
  /** Post-run: agent released on spend cap. */
  hitCostCap?: boolean;
  /** Post-run: agent released on maxTurns. */
  hitMaxTurns?: boolean;
  /** Post-run: stop-continue safety valve. */
  releasedOnContinueCap?: boolean;
  /** Post-run: session file-edit count (mutations). */
  editCount?: number;
  /** Post-run: last structural verification command, if any. */
  lastVerificationCommand?: string | null;
  /** Post-run: ISO timestamp of last successful verification. */
  lastVerificationAt?: string | null;
  /** Post-run: ISO timestamp of last file edit. */
  lastEditAt?: string | null;
  /**
   * Test hooks — inject dirty-file count / session inventory so unit tests
   * do not depend on the real git tree or ~/.forge sessions.
   */
  _testDirtyFiles?: number;
  _testSessionCount?: number;
  _testPinnedCount?: number;
  /** Test hook — force missing node_modules warning path. */
  _testMissingNodeModules?: boolean;
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
    // Post-edit verify tip disabled — experts lose cheap steering after edits.
    {
      const v = (process.env.FORGE_VERIFY_HINT || "1").trim().toLowerCase();
      if (v === "0" || v === "false" || v === "off" || v === "no") {
        warnings.push(
          "FORGE_VERIFY_HINT=0 — post-edit project-check tips suppressed. Unset or set to 1 for expert daily use.",
        );
      }
    }
  try {
    // Normalize aliases so late/partial configs still surface CI footguns:
    // sandbox none/false/0 → off; yolo/always/bypass → bypassPermissions.
    const sandbox =
      normalizeSandboxProfile(config.sandbox) ?? config.sandbox;
    if (sandbox === "off") {
      warnings.push("sandbox=off — bash runs unsandboxed");
    }
    const permissionMode =
      normalizePermissionMode(config.permissionMode) ?? config.permissionMode;
    if (permissionMode === "bypassPermissions") {
      warnings.push(
        "permissionMode=bypassPermissions (yolo) — tools auto-approved",
      );
    }
    if (permissionMode === "dontAsk") {
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
    if (permissionMode === "plan") {
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
    if (isFalsy(config.blockingStopHooks)) {
      warnings.push(
        "blockingStopHooks=false — Stop hooks will not re-anchor the agent",
      );
    }
    {
      const frg = (process.env.FORGE_FILE_READ_GUARD || "1").trim().toLowerCase();
      if (frg === "0" || frg === "false" || frg === "off" || frg === "no") {
        warnings.push(
          "FORGE_FILE_READ_GUARD=0 — stale/unread edit protection disabled (blind overwrites allowed)",
        );
      }
    }
    // Fresh clone / CI without install — typecheck/test will thrash.
    // Monorepos often hoist node_modules to the workspace root only.
    try {
      const cwd = config.workspace || process.cwd();
      const forceMissing = opts?._testMissingNodeModules === true;
      const hasPkg = forceMissing
        ? true
        : fs.existsSync(path.join(cwd, "package.json"));
      const hasNm = forceMissing ? false : hasNodeModules(cwd) === true;
      if (hasPkg && !hasNm && (forceMissing || hasNodeModules(cwd) === false)) {
        let install = "npm install";
        try {
          const pm = detectPackageManager(cwd);
          if (pm === "pnpm") install = "pnpm install";
          else if (pm === "yarn") install = "yarn install";
          else if (pm === "bun") install = "bun install";
        } catch {
          /* */
        }
        warnings.push(
          `node_modules missing — run \`${install}\` before typecheck/test`,
        );
      }
      if (!forceMissing) {
        try {
          const mismatch = packageManagerLockfileMismatch(cwd);
          if (mismatch) warnings.push(mismatch.detail);
          else {
            const multi = multipleLockfiles(cwd);
            if (multi.length >= 2) {
              warnings.push(
                `Multiple lockfiles present (${multi.join(", ")}). Pick one package manager and remove the others.`,
              );
            }
          }
        } catch {
          /* */
        }
      }
    } catch {
      /* */
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
    if (opts?.ultrawork && Array.isArray(config.fallbackModels) && config.fallbackModels.length === 0) {
      warnings.push(
        "ULW armed with model fallback off — a 429/5xx on the flagship will abort the run. /fallback default (or fallback_models) keeps unattended sessions alive",
      );
    }
    // isolation=worktree land=discard silently drops nested agent edits
    {
      const land = (
        process.env.FORGE_SUBAGENT_LAND ||
        process.env.FORGE_WORKTREE_LAND ||
        "auto"
      )
        .trim()
        .toLowerCase();
      if (
        land === "0" ||
        land === "false" ||
        land === "off" ||
        land === "discard" ||
        land === "none"
      ) {
        warnings.push(
          `FORGE_SUBAGENT_LAND=${land || "discard"} — isolation=worktree edits are discarded on cleanup (set auto to land into parent)`,
        );
      }
    }
    {
      const v = (process.env.FORGE_AUTO_VERIFY_NUDGE || "1").trim().toLowerCase();
      if (v === "0" || v === "false" || v === "off" || v === "no") {
        warnings.push(
          "FORGE_AUTO_VERIFY_NUDGE=0 — mid-loop verify nudges after edit streaks are off",
        );
      }
    }
    {
      const v = (process.env.FORGE_FIX_UNTIL_GREEN || "1").trim().toLowerCase();
      if (v === "0" || v === "false" || v === "off" || v === "no") {
        warnings.push(
          "FORGE_FIX_UNTIL_GREEN=0 — failed project checks will not auto-continue repair",
        );
      }
    }
    {
      const v = (process.env.FORGE_ULW_CHECKPOINT || "1").trim().toLowerCase();
      if (
        opts?.ultrawork &&
        (v === "0" || v === "false" || v === "off" || v === "no")
      ) {
        warnings.push(
          "FORGE_ULW_CHECKPOINT=0 — ULW arm will not create a safety checkpoint",
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
    // Post-run: edits without a recorded structural check — CI greppable.
    {
      const edits =
        typeof opts?.editCount === "number" && Number.isFinite(opts.editCount)
          ? opts.editCount
          : 0;
      const last = opts?.lastVerificationCommand?.trim() || "";
      if (edits > 0 && !last) {
        let tip = "npm test / typecheck";
        try {
          const intel = detectProjectIntel(config.workspace || process.cwd());
          if (intel.checkCommands[0]) tip = intel.checkCommands[0];
        } catch {
          /* */
        }
        warnings.push(
          `editsWithoutVerification — session has ${edits} edit(s) but no recorded structural check. Prefer \`${tip}\` before merge/ship (lastVerificationCommand stays empty until a preferred project check succeeds).`,
        );
      } else if (
        isLastVerificationStale({
          lastVerificationAt: opts?.lastVerificationAt ?? undefined,
          lastEditAt: opts?.lastEditAt ?? undefined,
        })
      ) {
        warnings.push(
          `staleLastVerification — last check (\`${last.slice(0, 80)}\`) is older than the latest file edit. Re-run before merge/ship.`,
        );
      }
    }
  } catch {
    /* never throw from warnings */
  }
  return warnings;
}
