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
  clampEffortForModel,
  maxEffortOf,
  bumpReasoningEffort,
  REASONING_EFFORTS,
  EFFORT_RANK,
} from "./config/reasoning.js";
export {
  modelContextWindow,
  normalizeModelKey,
  applyModelContextWindow,
  parseContextWindowArg,
  openRouterCachedContextWindow,
} from "./config/model-info.js";
export {
  parseFallbackModels,
  nextFallbackModel,
  isModelFallbackWorthy,
  defaultFallbackModels,
  formatFallbackChain,
} from "./config/model-fallback.js";
export { buildChatRequest } from "./agent/loop.js";
export { compileRules, evaluateRules, extractPatchPaths, parseRuleString } from "./agent/rules.js";
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
  isTokenAuthFailure,
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
export {
  runAgentLoop,
  runAgentLoopThroughDrops,
  resolveMaxTurns,
  isReadOnlyToolName,
  filterToolsForPermissionMode,
  installMcpLspExitHook,
} from "./agent/loop.js";
export type {
  LoopResult,
  LoopOptions,
  LoopEvents,
  LoopPhase,
} from "./agent/loop.js";
export {
  McpManager,
  getActiveMcpManager,
  setActiveMcpManager,
  formatMcpStatus,
} from "./mcp/manager.js";
export {
  loadMcpConfig,
  mcpConfigPaths,
  defaultUserMcpJson,
} from "./mcp/config.js";
export {
  defaultMcpServers,
  defaultMcpServersEnabled,
  DEFAULT_MCP_SERVER_IDS,
  formatDefaultMcpBlurb,
} from "./mcp/defaults.js";
export type {
  McpServerConfig,
  McpRegisteredTool,
  McpServerStatus,
} from "./mcp/types.js";
export {
  isMcpInvocationTool,
  isMcpToolReadOnly,
  mcpAlwaysAllowPattern,
  mcpToolNameLooksReadOnly,
  parseQualifiedMcpTool,
  qualifyMcpTool,
} from "./mcp/types.js";
export {
  LspManager,
  getActiveLspManager,
  setActiveLspManager,
  formatLspStatus,
  formatDiagnosticsReport,
} from "./lsp/manager.js";
export { loadLspConfig } from "./lsp/config.js";
export type { LspAction, LspDiagnostic, LspServerConfig } from "./lsp/types.js";
export {
  runSubagent,
  runSubagentTracked,
  filterToolsForSubagent,
  resolveSubagentType,
  resolveCapabilityMode,
  resolveChildPermissionMode,
  defaultMaxSubagentDepth,
  getActiveSubagentCount,
  listActiveSubagents,
  synthesizeSubagentFindings,
  resolveSubagentHandoffStatus,
  writeSubagentArtifact,
  formatSubagentResult,
} from "./agent/subagent.js";
export type {
  ActiveSubagentInfo,
  SubagentType,
  SubagentCapability,
  SubagentIsolation,
  SubagentRequest,
  SubagentResult,
  SubagentRunContext,
  SubagentHandoffStatus,
} from "./agent/subagent.js";
export {
  applyWorktreePatch,
  captureWorktreePatch,
  createSubagentWorktree,
  findGitRoot,
  formatWorktreeLandSummary,
  landSubagentWorktree,
  listWorktreeChangedFiles,
  parsePorcelainPath,
  snapshotParentPreimages,
  journalLandedPreimages,
  restoreParentPreimages,
  unquotePorcelainPath,
  defaultIsolationForSpawn,
  resolveIsolationMode,
  resolveWorktreeLandMode,
  worktreeBaseDir,
  worktreeDiffStat,
  type SubagentWorktree,
  type WorktreeLandResult,
  type WorktreeLandStatus,
} from "./agent/worktree.js";
export {
  formatLspInstallGuide,
  LSP_INSTALL_RECIPES,
  recipeForLanguage,
} from "./lsp/install-guide.js";
export {
  detectProjectLanguages,
  languagesToEnsure,
} from "./lsp/detect.js";
export {
  buildEnsurePlan,
  ensureLspServers,
  ensureLspOnInit,
  formatEnsurePlan,
  formatEnsureResult,
  maybeLspEnsureTip,
  lspAutoEnsureEnabled,
} from "./lsp/ensure.js";
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
  detectPrematureHandoff,
  evaluateHandoffAtStop,
} from "./harness/handoff-guard.js";
export type {
  HandoffDetection,
  HandoffStopDecision,
  HandoffStopInput,
} from "./harness/handoff-guard.js";
export {
  detectProofClaim,
  evaluateProofClaimAtStop,
} from "./harness/proof-claim-guard.js";
export type {
  ProofClaimDetection,
  ProofClaimStopDecision,
  ProofClaimStopInput,
} from "./harness/proof-claim-guard.js";
export {
  parseCostUsd,
  resolveMaxCostUsd,
  sessionCostUsd,
  costCapStatus,
  formatCostBudgetLine,
  MAX_COST_USD_CEILING,
} from "./util/cost-budget.js";
export type { CostCapStatus } from "./util/cost-budget.js";
export { productionWarningsForRun } from "./util/production-warnings.js";
export type { ProductionWarningOpts } from "./util/production-warnings.js";
export {
  armUlwCycle,
  setCycleFlag,
  maybeFlipUlwToLastOnSafetyValve,
  maybeFlipUlwToLastOnCostCap,
  setMaxWaves,
  loadUlwCycle,
  copyUlwCycle,
  disarmUlwCycle,
  evaluateUlwAtStop,
  maybeStampUlwWave,
  isSoftPrompt,
  isResumeFollowUp,
  expandUlwMandate,
  formatUlwStatus,
  formatUlwCounts,
  formatUlwBadge,
  formatCappedWaveDoctrine,
  parseMaxWavesArg,
  normalizeMaxWaves,
  ULW_LIVE_CONTROLS_HINT,
  VERIFICATION_CMD_RE,
  isVerificationCommand,
} from "./harness/ulw-cycle.js";
export {
  loadDecisionMemory,
  saveDecisionMemory,
  seedMemoryFromMandate,
  appendMemoryRecord,
  formatMemoryForPrompt,
  formatMemoryStatus,
  copyDecisionMemory,
  extractMandateBullets,
  isBroadMandate,
  isEvaluateClassMandate,
  hasMandateJudgment,
  todosFromMandate,
  maybeRecordUserConstraint,
  recordWaveObservation,
  activeMemoryRecords,
  decisionMemoryPath,
} from "./harness/decision-memory.js";
export {
  appendProjectMemory,
  archiveProjectMemory,
  clearProjectMemory,
  formatProjectMemoryForPrompt,
  formatProjectMemoryStatus,
  listActiveProjectMemory,
  loadProjectMemory,
  normalizeProjectMemoryKind,
  projectMemoryKey,
  resolveProjectMemoryRoot,
} from "./harness/project-memory.js";
export type {
  MemoryRecord,
  MemoryKind,
  DecisionMemoryStore,
} from "./harness/decision-memory.js";
export {
  expandUserContentWithImages,
  loadImageDataUrl,
  isImagePath,
  contentHasImages,
} from "./util/user-images.js";
export {
  expandUserMentions,
  extractPathMentions,
  stampMentionReads,
} from "./util/user-mentions.js";
export {
  createSession,
  loadSession,
  loadSessionMeta,
  saveSession,
  sessionDir,
  resolveSessionDir,
  resolveSessionJsonPath,
  listSessions,
  listSessionForks,
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
  persistSessionMode,
  setSessionLastError,
  clearSessionLastError,
  clearTransientProviderError,
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
  isSyntheticUserMessage,
  isValidSessionId,
  saveSessionMetaSidecar,
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
export { copyToClipboard, saveClipboardImage } from "./util/clipboard.js";
export type { ClipboardResult, ClipboardImageResult } from "./util/clipboard.js";
export {
  isBellEnabled,
  maybeRingBell,
  isNotifyEnabled,
  maybeDesktopNotify,
  maybeTurnEndAttention,
  turnEndOutcomeLabel,
  setBellEnabled,
  setNotifyEnabled,
} from "./util/attention.js";
export type { TurnEndOutcomeInput } from "./util/attention.js";
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
  isDroppedConnectionError,
  isContinueRecoverableProviderError,
  isPermanentProviderHalt,
  computeRetryDelayMs,
} from "./util/retry.js";
export {
  mergeAbortSignals,
  providerTimeoutMs,
  providerMaxWallMs,
  isTimeoutError,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_PROVIDER_MAX_MS,
} from "./util/abort.js";
export type { MergeAbortHandle } from "./util/abort.js";
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
export {
  assessSetupReadiness,
  formatSetupCard,
  parseSetupAction,
} from "./util/setup-readiness.js";
export { helpFor, HELP_START, HELP_ALL } from "./commands/help-text.js";
export { formatBanner } from "./tui/banner.js";
export { pickTurnEndHint } from "./tui/hints.js";
export {
  shouldOfferLoginPicker,
  parseLoginOfferChoice,
} from "./tui/login-offer.js";
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
  buildCommitPrompt,
  buildReviewPrompt,
  buildInitAgentsPrompt,
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
  formatInterjectionContext,
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
  clearTodoGateState,
  clearSoftTodoGateOnWindDown,
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
export {
  alwaysPatternFromPath,
  permissionAskTimeoutMs,
  PermissionGate,
} from "./agent/permissions.js";
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
  extractSavedOutputPath,
  formatClearedToolStub,
  ensureToolOutputSpool,
  isIdempotentRestoreTool,
} from "./session/tool-clearing.js";
export {
  pruneMessagesForRequest,
  requestPruneEnvConfig,
  assistantStepAges,
  REQUEST_PRUNE_OMITTED,
} from "./session/request-prune.js";
export {
  storeNeedsCheckpoint,
  splitInFlightTail,
  loadCheckpointSidecar,
} from "./session/checkpoint.js";
export {
  saveFullOutputSync,
  collectPinnedToolOutputPaths,
} from "./agent/tools/truncate.js";
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
  detectPackageManager,
  detectProjectIntel,
  detectWorkspaces,
  findMonorepoRoot,
  formatProjectIntelForPrompt,
  verifyHintSuffix,
  midLoopVerifyNudge,
  wrongPackageManagerTip,
  missingScriptTip,
  missingBinaryTip,
  nextCheckTip,
  monorepoLayoutTip,
  missingNodeModulesTip,
  hasNodeModules,
  packageManagerLockfileMismatch,
  multipleLockfiles,
  multipleLockfilesTip,
  permissionDeniedTip,
} from "./util/project-intel.js";
export type { PackageManager, ProjectIntel } from "./util/project-intel.js";
export { looksLikeAdvisoryUserMessage } from "./util/advisory-intent.js";
export {
  FileReadState,
  fileReadGuardEnabled,
  fileReadsForSession,
  clearFileReadsForSession,
} from "./agent/tools/file-read-state.js";
export type { FileReadStamp } from "./agent/tools/file-read-state.js";
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

export { editMissHint, formatMultiMatchLocations, locateEdit, stripReadFileLinePrefixes } from "./agent/tools/edit-match.js";
export { executeTool, normalizeToolName, TOOL_DEFINITIONS } from "./agent/tools/index.js";
export { applyTodos, openTodos } from "./agent/todos.js";

export {
  applySafetyCheckpoint,
  createSafetyCheckpoint,
  type SafetyCheckpointResult,
} from "./util/git-checkpoint.js";

export {
  isDestructiveGitCommand,
} from "./agent/tools/bash.js";
