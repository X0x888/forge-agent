/** Public API for programmatic use of Forge. */
export { loadConfig, defaultConfigToml } from "./config/load.js";
export type {
  ForgeConfig,
  PermissionMode,
  PromptProfile,
  ProviderId,
  SandboxProfile,
  SandboxNetwork,
  SandboxMissingBackend,
  PermissionRule,
  ReasoningEffort,
} from "./config/types.js";
export {
  DEFAULT_CONFIG,
  resolveSandboxNetwork,
  defaultNetworkForProfile,
} from "./config/types.js";
export {
  parseReasoningEffort,
  resolveReasoningEffort,
  modelSupportsReasoningEffort,
  effortLevelsForModel,
  defaultEffortForModel,
  REASONING_EFFORTS,
} from "./config/reasoning.js";
export { modelContextWindow, normalizeModelKey } from "./config/model-info.js";
export { buildChatRequest } from "./agent/loop.js";
export { compileRules, evaluateRules, parseRuleString } from "./agent/rules.js";
export {
  splitShellSegments,
  commandCheckTargets,
  containsRedirection,
  extractCommandPaths,
} from "./agent/shell-parse.js";
export {
  describeSandbox,
  detectSandboxBackend,
  execCommandSandboxed,
} from "./agent/sandbox.js";
export { resolveAuth, resolveAuthFresh, describeAuth } from "./auth/resolve.js";
export {
  loginInteractive,
  logout,
  supportsOAuth,
  getOAuthProfile,
  printAuthStatus,
} from "./auth/login.js";
export { importGrokCredentials, readGrokXaiSession } from "./auth/import-grok.js";
export {
  importLocalCopilotCredentials,
  readLocalCopilotGitHubToken,
  exchangeCopilotToken,
  copilotApiHeaders,
  COPILOT_API_BASE,
  COPILOT_PROVIDER_ID,
  COPILOT_GITHUB_CLIENT_ID,
  isCopilotProvider,
} from "./auth/copilot.js";
export {
  refreshCredentialIfNeeded,
  isAuthFailureMessage,
} from "./auth/refresh.js";
export {
  listAccounts,
  listAccountSummaries,
  getActiveAccount,
  setActiveAccount,
  removeAccount,
  upsertAccount,
  upsertApiKey,
  upsertOAuth,
  getAutoSwitchSettings,
  setAutoSwitchSettings,
  resolveAccountSelector,
  loadAuthStore,
  saveAuthStore,
  normalizeAuthStore,
} from "./auth/store.js";
export {
  switchAccount,
  switchOnQuotaFailure,
  switchOnAuthFailure,
  maybeProactiveSwitch,
  isQuotaOrRateLimitError,
  formatAccountsTable,
  formatMultiAccountReadiness,
  assessMultiAccountReadiness,
  clearAccountCooldown,
  pickAlternateAccount,
  rankAccount,
  recordAccountPlan,
  isPlanFresh,
  isEnvAuthActive,
  DEFAULT_COOLDOWN_SEC,
  AUTH_FAILURE_COOLDOWN_SEC,
  PLAN_STALE_SEC,
} from "./auth/accounts.js";
export type {
  AccountCredential,
  AccountSummary,
  AccountPlanSnapshot,
  AuthStore,
  AuthStoreV2,
  ResolvedAuth,
  StoredCredential,
  AuthMethod,
} from "./auth/types.js";
export { createProvider } from "./providers/factory.js";
export { mapAnthropicStopReason } from "./providers/anthropic.js";
export { runAgentLoop, resolveMaxTurns } from "./agent/loop.js";
export type {
  LoopResult,
  LoopOptions,
  LoopEvents,
  LoopPhase,
} from "./agent/loop.js";
export { HookRunner } from "./harness/hooks.js";
export {
  armGoal,
  pauseGoal,
  resumeGoal,
  clearGoal,
  loadGoal,
  copyGoal,
  evaluateGoalAtStop,
  formatGoalStatus,
} from "./harness/goal.js";
export { runStopGuard } from "./harness/stop-guard.js";
export {
  armUlwCycle,
  setCycleFlag,
  setMaxWaves,
  loadUlwCycle,
  copyUlwCycle,
  disarmUlwCycle,
  evaluateUlwAtStop,
  isSoftPrompt,
  expandUlwMandate,
  formatUlwStatus,
  formatUlwCounts,
  formatUlwBadge,
  parseMaxWavesArg,
  normalizeMaxWaves,
  ULW_LIVE_CONTROLS_HINT,
} from "./harness/ulw-cycle.js";
export {
  createSession,
  loadSession,
  loadSessionMeta,
  saveSession,
  sessionDir,
  resolveSessionDir,
  resolveSessionJsonPath,
  listSessions,
  resolveSessionId,
  suggestSessions,
  formatSessionLookupMiss,
  listSessionLookupSuggestions,
  deleteSession,
  deleteSessionDetailed,
  sessionHasForeignLiveLock,
  pruneSessions,
  type DeleteSessionResult,
  type ListSessionsOpts,
  type PruneSessionsResult,
  rewindSession,
  rewindSessionDetailed,
  exportSessionMarkdown,
  exportSessionJson,
  importSessionJson,
  forkSession,
  setSessionTitle,
  deriveSessionTitle,
  MAX_SESSION_TITLE_CHARS,
  setSessionPinned,
  isSessionPinned,
  applySessionPermissionMode,
  enterSessionPlanMode,
  exitSessionPlanMode,
  setSessionLastError,
  clearSessionLastError,
  findRecentSessionForCwd,
  type RecentSessionHit,
  formatSessionSummary,
  formatSessionShareCard,
  lastAssistantText,
  lastUserText,
  listSessionTouchedFiles,
  formatSessionTouchedFiles,
  type TouchedFile,
  type TouchedFileOp,
  formatRecentTurns,
  formatResumePeek,
  formatResumeOrientation,
  recoverSessionFromTmp,
  compactMessages,
  rebuildUserTurnMarks,
  estimateTokens,
  estimateRequestTokens,
  pruneOversizedMessageBodies,
} from "./session/session.js";
export {
  envPositiveInt,
  envNonNegInt,
  parseKeepCount,
  parseCliNonNegInt,
  defaultBashTimeoutMs,
  defaultBashBackgroundTimeoutMs,
} from "./util/env.js";
export { editDistance, stringSimilarity } from "./util/string-distance.js";
export {
  suggestName,
  suggestNames,
  suggestSessionAction,
  SESSION_ACTIONS,
} from "./util/suggest.js";
export { copyToClipboard } from "./util/clipboard.js";
export type { ClipboardResult } from "./util/clipboard.js";
export { isBellEnabled, maybeRingBell } from "./util/attention.js";
export {
  forgeHome,
  readJsonFile,
  writeJsonFile,
  ensureDir,
  inspectSecureFile,
} from "./util/fs.js";
export {
  loadSavedAllows,
  addSavedAllow,
  removeSavedAllow,
  clearSavedAllows,
  savedAsAllowRules,
  workspaceKey,
} from "./agent/permission-saved.js";
export {
  withRetry,
  isRetryableError,
  isContextOverflowError,
  computeRetryDelayMs,
} from "./util/retry.js";
export {
  mergeAbortSignals,
  providerTimeoutMs,
  isTimeoutError,
  DEFAULT_PROVIDER_TIMEOUT_MS,
} from "./util/abort.js";
export { getForgeVersion } from "./util/version.js";
export {
  XAI_PUBLIC_CLIENT_ID,
  XAI_TOKEN_URL,
  XAI_AUTHORIZE_URL,
  XAI_SCOPES,
  emailFromIdToken,
} from "./auth/xai-oauth.js";
export {
  formatWhatsNew,
  loadChangelogReleases,
  parseChangelog,
  findChangelogPath,
} from "./util/changelog.js";
export { parseDaysWindow, daysWindowHelp } from "./util/days-window.js";
export { parseNewsCount, newsCountHelp } from "./util/news-count.js";
export { parseLogsLines, logsLinesHelp } from "./util/logs-lines.js";
export {
  normalizeProviderId,
  PROVIDER_IDS,
  PROVIDER_ALIASES,
  providerIdHelp,
} from "./util/provider-id.js";
export {
  normalizePermissionMode,
  normalizeSandboxProfile,
  normalizeSandboxNetwork,
} from "./util/mode-aliases.js";
export type { ChangelogRelease } from "./util/changelog.js";
export { formatExpertTips } from "./util/tips.js";
export { log, setLogLevel, getLogLevel } from "./util/log.js";
export { shellCompletionScript } from "./util/completion-script.js";
export {
  summarizeToolArgs,
  formatPermissionPreview,
  formatRetryWait,
  formatRelativeTime,
  estimateCostUsd,
  formatCost,
  formatTokens,
} from "./util/format.js";
export {
  toolOutputStats,
  pruneToolOutputsSync,
  boundToolOutput,
} from "./agent/tools/truncate.js";
export {
  listTasks,
  killTask,
  killAllRunningTasks,
  getTask,
  readTaskOutput,
  installBackgroundTaskExitHook,
} from "./agent/tools/background-tasks.js";
export {
  logSandboxEvent,
  sandboxLogStats,
  sandboxLogPath,
  readSandboxLogTail,
  formatSandboxLogTail,
} from "./agent/sandbox-log.js";
export {
  appendFileMutation,
  readFileMutations,
  mutationsJournalStats,
  mutationsJournalPath,
  restoreMutationsAfterTurn,
  formatRestoreResult,
  MAX_MUTATION_BYTES,
} from "./session/mutations.js";
export type {
  FileMutation,
  MutationsJournalStats,
  RestoreMutationsResult,
} from "./session/mutations.js";
export {
  parseToolArguments,
  closeIncompleteJson,
} from "./util/json-repair.js";
export {
  repairToolCallPairing,
  alignKeepBoundary,
} from "./session/message-repair.js";
export {
  ProviderApiError,
  isProviderApiError,
  formatProviderError,
  formatProviderErrorText,
  parseRetryAfterMs,
} from "./providers/errors.js";
export {
  completeSlash,
  suggestSlashCommands,
  formatUnknownSlash,
  handleSlash,
  runDoctor,
  runDoctorCheck,
  buildEffectiveConfigSnap,
  formatEffectiveConfig,
  classifyLiveSlash,
  isLiveSafeSlash,
  isSafeDiffFilterArg,
  LIVE_CONTROLS_HINT,
  SLASH_COMMANDS,
} from "./commands/slash.js";
export type { DoctorResult, EffectiveConfigSnap } from "./commands/slash.js";
export {
  loadProjectCommands,
  findProjectCommand,
  expandProjectCommandTemplate,
  listProjectCommandSlashes,
  formatProjectCommandsHelp,
  isReservedSlashName,
} from "./commands/project-commands.js";
export type { ProjectCommand } from "./commands/project-commands.js";
export {
  resolveHeadlessSlashPrompt,
  stripAnsi,
} from "./commands/headless-slash.js";
export type { HeadlessSlashResolution } from "./commands/headless-slash.js";
export {
  pushLiveNotice,
  drainLiveNotices,
  formatLiveNoticesMessage,
} from "./harness/live-notices.js";
export {
  pushInterjection,
  drainInterjections,
  formatInterjection,
  formatInterjectionsMessage,
  formatUserQuery,
} from "./harness/interjection.js";
export {
  snapshotHarness,
  admitHarnessIfChanged,
  renderHarnessAdmission,
  fingerprintSnapshot,
} from "./harness/context-admit.js";
export {
  evaluateTodoGateAtStop,
  maybeTodoNudge,
  noteTodoWrite,
  resetTodoNudgeForPrompt,
} from "./harness/todo-gate.js";
export {
  compactMessagesStructured,
  buildStructuredSummary,
  pruneOversizedMessageBodies as pruneMessageBodies,
} from "./session/compaction.js";
export {
  acquireSessionLock,
  touchSessionLock,
  releaseSessionLock,
  readSessionLock,
  formatLockHolder,
} from "./session/lock.js";
export {
  appendSessionMetrics,
  buildRunEndMetrics,
  metricsStats,
  metricsPath,
  pruneMetrics,
  readMetricsEvents,
  collectUsageStats,
  formatUsageStats,
  METRICS_AUTO_PRUNE_KEEP,
  type UsageStats,
  type SessionMetricsEvent,
} from "./session/metrics.js";
export { permissionAskTimeoutMs, PermissionGate } from "./agent/permissions.js";
export type { PermissionRequest, PermissionResult } from "./agent/permissions.js";
export {
  checkBashHardDeny,
  hardSafetyCheck,
  checkWritePathHardDeny,
  isSoftDangerousBash,
} from "./agent/safety.js";
export type { SafetyVerdict } from "./agent/safety.js";
export {
  isReadOnlyCommand,
  commandPrefix,
  alwaysPatternFromTokens,
  alwaysPatternFromCommand,
} from "./agent/shell-arity.js";
export {
  assertUrlSafe,
  isNonPublicIp,
  isBlockedForHost,
  isExplicitLocalHost,
  normalizeIpHost,
  expandWeirdIpv4Literal,
  embeddedIpv4FromIpv6,
} from "./agent/tools/ssrf.js";
export {
  nonStringKind,
  stringFieldError,
  numberFieldError,
} from "./agent/tools/arg-types.js";
export {
  createShellEnv,
  SHELL_INJECTION_ENV,
  type ShellEnvPolicy,
  type InheritMode,
} from "./agent/tools/env-policy.js";
export {
  DoomLoopTracker,
  toolFingerprint,
} from "./agent/doom-loop.js";
export {
  ErrorStreakTracker,
  isCountableToolError,
  summarizeToolError,
} from "./agent/error-streak.js";
export {
  buildBaselineSystemPrompt,
  loadProjectRules,
  listProjectRulePaths,
  buildSystemPrompt,
  resolvePromptProfile,
} from "./agent/system-prompt.js";
export {
  collectSnapshots,
  renderHud,
  renderTmux,
  renderCompactStrip,
  runStatusWatch,
  heartbeatSession,
  releaseSession,
  getActivity,
  beginTurn,
  endTurn,
  setPhase,
} from "./statusline/index.js";
export type {
  StatusSnapshot,
  PlanUsageInfo,
  ActivityInfo,
  Liveness,
} from "./statusline/types.js";

export { editMissHint, formatMultiMatchLocations, locateEdit } from "./agent/tools/edit-match.js";
export { executeTool, normalizeToolName, TOOL_DEFINITIONS } from "./agent/tools/index.js";
export { applyTodos, openTodos } from "./agent/todos.js";
