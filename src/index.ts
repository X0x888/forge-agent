/** Public API for programmatic use of Forge. */
export { loadConfig, defaultConfigToml } from "./config/load.js";
export type { ForgeConfig, PermissionMode, ProviderId } from "./config/types.js";
export { DEFAULT_CONFIG } from "./config/types.js";
export { resolveAuth, describeAuth } from "./auth/resolve.js";
export { loginInteractive, logout, supportsOAuth } from "./auth/login.js";
export { createProvider } from "./providers/factory.js";
export { runAgentLoop } from "./agent/loop.js";
export { HookRunner } from "./harness/hooks.js";
export {
  armGoal,
  pauseGoal,
  resumeGoal,
  clearGoal,
  loadGoal,
  evaluateGoalAtStop,
  formatGoalStatus,
} from "./harness/goal.js";
export { runStopGuard } from "./harness/stop-guard.js";
export {
  createSession,
  loadSession,
  saveSession,
  listSessions,
} from "./session/session.js";
