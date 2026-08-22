/**
 * Bind ULW Wave-1 PLAN to session plan mode (`/plan` / `/build`).
 *
 * ULW-owned plan auto-exits when the cycle flips to ship (written reading or
 * `/build`). User-typed `/plan` clears `ulwOwnsPlan` so auto-build does not
 * steal the human gate.
 */
import type { ForgeConfig, PermissionMode } from "../config/types.js";
import type { SessionData } from "../session/session.js";
import {
  enterSessionPlanMode,
  exitSessionPlanMode,
  persistSessionMode,
} from "../session/session.js";
import {
  loadUlwCycle,
  resolveUlwPhase,
} from "./ulw-cycle.js";

/** After `/ulw` / `--ulw` / auto-arm: enter PLAN and claim auto-build. */
export function armUlwPlanMode(
  session: SessionData,
  config: Pick<ForgeConfig, "permissionMode"> & {
    permissionMode: PermissionMode;
  },
): void {
  syncUlwPlanMode(session, config);
  const s = loadUlwCycle(session.meta.id);
  if (s?.enabled && resolveUlwPhase(s) === "orient") {
    session.meta.ulwOwnsPlan = true;
    persistSessionMode(session);
  }
}

export function syncUlwPlanMode(
  session: SessionData,
  config: Pick<ForgeConfig, "permissionMode"> & { permissionMode: PermissionMode },
): void {
  const s = loadUlwCycle(session.meta.id);
  if (!s?.enabled) {
    if (session.meta.ulwOwnsPlan) {
      if (config.permissionMode === "plan") {
        exitSessionPlanMode(config, session);
      }
      delete session.meta.ulwOwnsPlan;
      persistSessionMode(session);
    }
    return;
  }
  const phase = resolveUlwPhase(s);
  if (phase === "orient") {
    if (config.permissionMode !== "plan") {
      enterSessionPlanMode(config, session);
      session.meta.ulwOwnsPlan = true;
      persistSessionMode(session);
    }
    return;
  }
  if (session.meta.ulwOwnsPlan && config.permissionMode === "plan") {
    exitSessionPlanMode(config, session);
    delete session.meta.ulwOwnsPlan;
    persistSessionMode(session);
  }
}
