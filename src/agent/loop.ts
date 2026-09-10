import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import {
  resolveReasoningEffort,
  bumpReasoningEffort,
  type ReasoningEffort,
} from "../config/reasoning.js";
import {
  resolveEffectiveMaxTokens,
  servedModelDiverged,
} from "../config/model-info.js";
import { isCursorProvider } from "../auth/cursor.js";
import {
  closeCursorLiveForChat,
  cursorHostNeedsRebase,
} from "../providers/cursor.js";
import {
  applyFallbackHop,
  isModelFallbackWorthy,
  nextFallbackModel,
  normalizeFallbackModelId,
} from "../config/model-fallback.js";
import type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  LLMProvider,
  OutboundChatMessage,
  StreamDelta,
  ToolCall,
} from "../providers/types.js";
import type { SessionData, TodoItem } from "../session/session.js";
import { applyTodos, openTodos } from "./todos.js";
import {
  saveSession,
  saveSessionMetaSidecar,
  estimateTokens,
  estimateRequestTokens,
  compactMessages,
  clearRequestPruneSticky,
  rebuildUserTurnMarks,
  maybeSetTitle,
  markUserTurn,
  pruneOversizedMessageBodies,
  setSessionLastError,
  clearSessionLastError,
  clearTransientProviderError,
  isLastVerificationStale,
} from "../session/session.js";
import { appendFileMutation } from "../session/mutations.js";
import { HookRunner, type HookContext } from "../harness/hooks.js";
import { runStopGuard } from "../harness/stop-guard.js";
import {
  finalizeGuidelineAudit,
  formatGuidelineAuditNotice,
  maybeGuidelineAuditBrief,
  noteGuidelineToolCall,
  type GuidelineFinalizeResult,
} from "../harness/guideline-audit.js";
import { buildRunReport, lastRealUserPrompt } from "../harness/run-report.js";
import { proofClaimReleaseTips } from "../harness/proof-claim-guard.js";
import { loadGoal, detectAutoGoal, armGoal } from "../harness/goal.js";
import {
  loadCycleState,
  loadActiveCycle,
  cycleActive,
  armCycle,
  mandateFromUserText,
  isResumeFollowUp,
  requestCycleZeroOnSafetyValve,
  providerFuseTripsContinueCap,
  stopBlockTripsContinueCap,
  ulwKickoffMessage,
  formatUlwCounts,
  formatUlwBadge,
  cyclePreferredCheckCommands,
  cycleKeepPaths,
  ensureCyclePlanned,
  runCheckCommand,
  type CycleRuntime,
  type CyclePlanItem,
} from "../harness/cycle/index.js";
import {
  countsTowardVerification,
  applyVerificationTrail,
  classifyVerificationRun,
  isFullSuiteCommand,
  type VerificationRunClass,
} from "../harness/verification.js";
import {
  getTask,
  onBackgroundTaskSettled,
  readTaskLogTailForVerification,
  type BackgroundTask,
} from "./tools/background-tasks.js";
import {
  isReasonedEmptyStop,
  REASONING_LOOP_FINISH,
  REASONING_WALL_FINISH,
  formatThoughtOnlyRecoverPoke,
  thoughtOnlyStopMax,
} from "./reasoned-stop.js";
import {
  clearStaleToolResults,
  toolClearEnvConfig,
} from "../session/tool-clearing.js";
import {
  prepareOutboundMessages,
  applyStickyPrune,
  countHarnessUserPokes,
  type RequestPruneSticky,
  type PruneKind,
} from "../session/request-prune.js";
import {
  appendProviderRoundMetrics,
  cacheHitRatio,
} from "../session/prompt-cache.js";
import {
  CITE_DELTA_POKE,
  citeDeltaShouldPoke,
  citeDeltaShouldStop,
  noteCiteDelta,
  parseExploreMap,
} from "../session/explore-map.js";
import {
  CITE_DELTA_PICK_POKE,
  formatCiteDeltaPickPoke,
  formatReportOnlySkip,
  formatSubagentLastTurnPoke,
  formatSubagentWrapPoke,
  isReportOnlyBlockedTool,
  SUBAGENT_LAST_TURN_POKE,
  SUBAGENT_WRAP_POKE,
  subagentWrapTurn,
} from "./subagent-policy.js";
import {
  storeNeedsCheckpoint,
  DEFAULT_CHECKPOINT_KEEP_STEPS,
} from "../session/checkpoint.js";
import {
  expandUserContentWithImages,
  stripOutboundImageParts,
} from "../util/user-images.js";
import { expandUserMentions } from "../util/user-mentions.js";
import { maybeRecordUserConstraint } from "../harness/decision-memory.js";
import {
  createProofPokeState,
  noteFixUntilGreen,
  noteGreenVerification,
  noteRedVerification,
  noteVerifyNudge,
  shouldEmitFixUntilGreen,
  shouldEmitVerifyNudge,
} from "../harness/proof-poke.js";
import path from "node:path";
import {
  drainLiveNotices,
  formatLiveNoticesMessage,
} from "../harness/live-notices.js";
import {
  drainInterjections,
  formatInterjectionsMessage,
} from "../harness/interjection.js";
import {
  snapshotHarness,
  admitHarnessIfChanged,
  markHarnessAdmitted,
} from "../harness/context-admit.js";
import {
  getGitSnapshot,
  gitDiffSinceHead,
  gitHeadSha,
  gitIsClean,
  gitLogSince,
  gitStatusShort,
  type GitSnapshot,
} from "../util/git-context.js";
import {
  autoCommitStamp,
  commitDirtyTree,
  formatLeftUnstagedAdmit,
} from "../util/git-auto-commit.js";
import { reapSessionBrowsers } from "./browser-lease.js";
import { cleanupAgentBrowserScratch } from "../util/look-cleanup.js";
import { detectProjectIntel } from "../util/project-intel.js";
import { appendProjectMemory } from "../harness/project-memory.js";
import {
  describeGuidelineFile,
  formatGuidelineStatusLine,
  surveyGuidelines,
} from "../harness/guideline-audit.js";
import {
  FileReadState,
  fileReadsForSession,
} from "./tools/file-read-state.js";
import {
  resetTodoNudgeForPrompt,
  noteTodoWrite,
  noteAssistantTurn,
  maybeTodoNudge,
} from "../harness/todo-gate.js";
import { PermissionGate } from "./permissions.js";
import { hardSafetyCheck } from "./safety.js";
import {
  TOOL_DEFINITIONS,
  executeTool,
  normalizeToolName,
} from "./tools/index.js";
import {
  isEnterPlanModeToolName,
  isExitPlanModeToolName,
} from "./tools/exit-plan-mode.js";
import { buildBaselineSystemPrompt } from "./system-prompt.js";
import { log } from "../util/log.js";
import { envPositiveInt } from "../util/env.js";
import {
  abortableSleep,
  withRetry,
  isContextOverflowError,
  isContinueRecoverableProviderError,
  isDroppedConnectionError,
  isReconnectWithoutAuthDrop,
  isRetryableError,
  noteFetchFailedRetry,
  retryEventReason,
} from "../util/retry.js";
import { parseToolArguments } from "../util/json-repair.js";
import { repairToolCallPairing } from "../session/message-repair.js";
import { DoomLoopTracker } from "./doom-loop.js";
import {
  ErrorStreakTracker,
  isCountableToolError,
  summarizeToolError,
} from "./error-streak.js";
import {
  refreshCredentialIfNeeded,
  isTokenAuthFailure,
} from "../auth/refresh.js";
import {
  formatQuotaFailoverExhausted,
  getActiveAccount,
  isQuotaOrRateLimitError,
  isTeamSpendCapError,
  maybeProactiveSwitch,
  pinSessionAccount,
  quotaFailoverBlockedByTeamCap,
  recordQuotaFailurePlan,
  recordSessionAccountSwitch,
  switchOnAuthFailure,
  switchOnQuotaFailure,
  waitAndRetryQuotaSwitch,
  type SwitchResult,
} from "../auth/accounts.js";
import {
  isImageDimensionError,
  isProviderApiError,
} from "../providers/errors.js";
import {
  costCapStatus,
  formatCostBudgetLine,
  resolveMaxCostUsd,
  type CostCapStatus,
} from "../util/cost-budget.js";
import {
  formatToolDisplayName,
  formatToolStart,
  truncateMiddle,
  formatTokens,
  formatRetryWait,
  summarizeToolArgs,
  extractDiffFromToolOutput,
} from "../util/format.js";
import {
  createToolStartDelayer,
  formatDefaultToolEndTranscript,
} from "../tui/tool-transcript.js";
import type { ToolDefinition } from "../providers/types.js";
import {
  McpManager,
  setActiveMcpManager,
  getActiveMcpManager,
} from "../mcp/manager.js";
import {
  LspManager,
  setActiveLspManager,
  getActiveLspManager,
} from "../lsp/manager.js";
import {
  cleanupSubagentSession,
  defaultMaxSubagentDepth,
  isSpawnParallelSafe,
  resolveSpawnSubagentType,
  runSubagentTracked,
  subagentTypeRawIsOmitted,
  toolSetCanEdit,
  type SubagentRequest,
} from "./subagent.js";
import { mcpCallIsReadOnly } from "../mcp/tools.js";
import { isLspToolName, lspActionInstalls } from "../lsp/tools.js";
import { createOrderGate, type OrderGate } from "./spawn-join.js";
import { isFalsy } from "../util/bool.js";

export type LoopPhase =
  | "thinking"
  | "tool"
  | "compacting"
  | "stop_guard"
  | "waiting";

export interface LoopEvents {
  onToken?: (token: string) => void;
  /**
   * Reasoning-model thought progress. Count only — never the thought
   * text (prefix-cache replay still stores reasoning_content on the
   * message). Used for the `think › 1.2k` first-token landmark.
   */
  onReasoning?: (progress: { chars: number }) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (
    name: string,
    result: {
      isError?: boolean;
      ms: number;
      bytes: number;
      diff?: string;
      stats?: { added: number; removed: number | null };
      output?: string;
      args?: Record<string, unknown>;
    },
  ) => void;
  /**
   * Fired once per tool attempt after onPhase("tool"), including hard-deny
   * and permission-deny paths (those now also emit onToolStart/onToolEnd).
   * Used by the REPL to keep the spinner paused across parallel batches.
   */
  onToolSettled?: (name: string) => void;
  onStatus?: (msg: string) => void;
  /** Rich phase updates for in-REPL working indicator / HUD */
  onPhase?: (phase: LoopPhase, detail?: string) => void;
}

/**
 * Forward a provider stream delta to UI events. Reasoning is count-only
 * so thought text never leaves the provider layer via this path.
 */
export function notifyStreamDelta(
  delta: StreamDelta,
  events: Pick<LoopEvents, "onToken" | "onReasoning">,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) return;
  const thought = delta.reasoning_content;
  if (typeof thought === "string" && thought.length > 0) {
    events.onReasoning?.({ chars: thought.length });
  }
  if (delta.content) events.onToken?.(delta.content);
}

export interface LoopOptions {
  config: ForgeConfig;
  provider: LLMProvider;
  session: SessionData;
  hooks: HookRunner;
  permissions: PermissionGate;
  userMessage: string;
  stream?: boolean;
  signal?: AbortSignal;
  events?: LoopEvents;
  /** @deprecated use events.onToken */
  onToken?: (token: string) => void;
  maxStopContinues?: number;
  /**
   * Nested subagent depth (0 = root agent). Children receive depth+1.
   * When depth >= maxSubagentDepth, spawn_subagent is denied.
   */
  subagentDepth?: number;
  maxSubagentDepth?: number;
  /** Override tool schemas sent to the model (subagent capability filter). */
  toolDefinitions?: ToolDefinition[];
  /** Shared MCP manager (parent owns lifecycle; children reuse). */
  mcp?: McpManager;
  /** Shared LSP manager (parent owns lifecycle; children reuse). */
  lsp?: LspManager;
  /** When false, do not construct/start MCP if `mcp` is unset. Default true. */
  mcpAutostart?: boolean;
  /** When false, do not construct LspManager if `lsp` is unset. Default true. */
  lspAutostart?: boolean;
  /** Skip goal/ULW auto-arm (subagents). */
  disableHarnessAutoArm?: boolean;
  /**
   * Explore children: end the map when two turns add no new paths
   * (information-gain stop, not a turn cap).
   */
  citeDeltaStop?: boolean;
  /**
   * Every turn is report-only: the run's job is to emit a document, not to
   * read/search/edit. The ULW Planner's plan turn uses this — the scouting is
   * already done, so a plan turn that keeps exploring only burns its budget
   * and dies with no plan (the HashPet cycle-3 failure).
   */
  documentOnly?: boolean;
  /**
   * Resume the existing transcript after a continue-recoverable provider drop.
   * Does not push a new user turn — same as the expert typing "continue"
   * without polluting history.
   */
  resumeWithoutUserMessage?: boolean;
  /**
   * Override spend-cap checks (child loops). Default is
   * `costCapStatus(config, session.meta)`. Family /budget passes a
   * live-fold resolver so siblings share remaining.
   */
  resolveCostCap?: () => CostCapStatus;
}

export interface LoopResult {
  finalText: string;
  turns: number;
  stopContinues: number;
  aborted: boolean;
  /**
   * True when the shared stop-continue cap forced release (length / content_filter /
   * empty / Stop-block). Headless JSON exposes this so CI can distinguish a clean
   * completion from a harness safety valve — without treating it as a hard failure.
   */
  releasedOnContinueCap: boolean;
  /**
   * True when the loop exited because `maxTurns` was reached (not a clean Stop).
   * Headless JSON/metrics surface this for CI; still `ok` unless aborted/timed out.
   */
  hitMaxTurns: boolean;
  /**
   * True when the loop released because the session spend estimate hit
   * maxCostUsd / FORGE_MAX_COST_USD / --max-cost / /budget (not a clean Stop).
   */
  hitCostCap: boolean;
  /**
   * True when the /goal stuck-wall released the run (N no-progress Stops).
   * Metrics/JSON/notify must not look like a clean Stop.
   */
  stuckReleased: boolean;
  /** True when the ULW cycle driver released this run (fulfilled / cycle 0 / cap / blocked). */
  lastCycleReleased: boolean;
  /** Why the ULW driver released, when it did. */
  ulwEndReason?: string;
  /** Structural checks this run: totals across every Stop boundary. */
  verification?: {
    ran: boolean;
    passed: boolean;
    fullSuite: boolean;
    lastCommand?: string;
  };
  /**
   * Last provider `finish_reason` observed on an assistant turn (e.g. stop, length,
   * content_filter, tool_calls). Null when no model turn completed (auth/abort early).
   * Headless JSON surfaces this for CI triage without scraping finalText notes.
   */
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  /** Provider-reported cached-input tokens for this run (0 when unreported). */
  cacheReadTokens: number;
  /** Distinct served models that diverged from the requested one this run. */
  servedModels?: string[];
  /** ULW cycle commit this run (never pushed). */
  autoCommit?: {
    committed: boolean;
    sha?: string;
    subject?: string;
    skipped?: string;
  };
  /**
   * Harness-as-second-user meters (this run). Admits, Stop re-anchors,
   * verify/fix/todo pokes, bg-task frames. Used to dogfood cost work.
   */
  harnessUserPokes?: number;
  admitCount?: number;
  proofPokes?: number;
  /**
   * Stop-guard blocks this run by guard id (`handoff`, `proofClaim`,
   * `report`, `todoGate`, `goal`, `ulw`, `hook`, `verify`, `fix`, …).
   * Non-zero keys only. The per-guard cost of the harness — what an
   * over-eager guard costs shows up here, not in a hunch.
   */
  guardBlocks?: Record<string, number>;
  /** Provider chat rounds this run (same as `turns`). */
  providerRounds?: number;
  /** Agent-guidelines audit outcome for this run (stamped / revised files). */
  guidelines?: GuidelineFinalizeResult;
}

/**
 * Per-run harness signals shared between the loop and tool execution.
 * - verificationRuns: bash commands matching isVerificationCommand() executed
 *   since the last Stop evaluation — the structural "proof" signal for the
 *   ULW cycle ledger (execution, not prose claims).
 * - effortBoostTurns: adaptive effort budget — hard-round signals (doom-loop,
 *   error-streak, missing wave proof) buy a temporary reasoning-effort bump
 *   instead of paying high effort on every turn (escalate on failure, not
 *   by default).
 */
export interface HarnessRunStats {
  /** Structural check bash executed (pass or fail) — ULW cycle ledger. */
  verificationRuns: number;
  /** Successful structural checks only — proof-claim / expert green trail. */
  verificationPassedRuns: number;
  /** Isolate `node --test tests/wN-*.mjs` ran — not wave proof. */
  verificationHelperOnlyRuns: number;
  /** Full project suite passed this wave — ULW proof=✓. */
  verificationFullSuiteRuns: number;
  /** Run-level totals (never reset at a Stop) — LoopResult.verification. */
  totalRuns: number;
  totalPassed: number;
  totalFullSuite: number;
  lastCommand?: string;
  effortBoostTurns: number;
  /**
   * Background task ids already credited (settle listener or a
   * get_task_output join) — one check run is one credit however many
   * channels observe it.
   */
  creditedBgTaskIds: Set<string>;
}

/** A background task started by THIS loop's bash tool (cwd = workspace). */
function taskBelongsToWorkspace(
  taskCwd: string | undefined,
  workspace: string,
): boolean {
  if (!taskCwd || !workspace) return true;
  try {
    return path.resolve(taskCwd) === path.resolve(workspace);
  } catch {
    return true;
  }
}

/**
 * One credit path for every channel that observes a check run: foreground
 * bash results, background tasks joined via get_task_output, and background
 * tasks that settle while the model keeps working. Counters feed the ULW
 * cycle ledger; the trail feeds /status /share and the proof-claim guard.
 */
function applyVerificationCredit(opts: {
  harnessStats: HarnessRunStats;
  meta: SessionData["meta"];
  proofPoke?: import("../harness/proof-poke.js").ProofPokeState;
  cls: VerificationRunClass;
  command: string;
  preferred?: string[];
}): void {
  const { harnessStats, meta, cls } = opts;
  if (!cls.ran) return;
  harnessStats.verificationRuns += 1;
  harnessStats.totalRuns += 1;
  harnessStats.lastCommand = opts.command;
  if (cls.isolate) {
    harnessStats.verificationHelperOnlyRuns += 1;
  } else if (cls.passed) {
    harnessStats.verificationPassedRuns += 1;
    harnessStats.totalPassed += 1;
    if (cls.fullSuite) {
      harnessStats.verificationFullSuiteRuns += 1;
      harnessStats.totalFullSuite += 1;
    }
  }
  try {
    applyVerificationTrail(meta, {
      command: opts.command,
      isError: !cls.passed,
      preferredCheckCommands: opts.preferred,
    });
    if (meta.lastVerificationOk === true) {
      if (opts.proofPoke) noteGreenVerification(opts.proofPoke);
    } else if (meta.lastVerificationOk === false) {
      if (opts.proofPoke) {
        noteRedVerification(opts.proofPoke, meta.editCount || 0);
      }
    }
  } catch {
    /* trail is best-effort */
  }
}

/**
 * Credit a settled background task once. `completed` (exit 0, no `fail N`)
 * is passed; `failed` / `timeout` / `killed` ran and did not pass — a hung
 * suite is proof=✗, exactly as the consolidation doctrine says.
 */
export function creditBackgroundTaskVerification(opts: {
  task: BackgroundTask;
  harnessStats: HarnessRunStats;
  meta: SessionData["meta"];
  proofPoke?: import("../harness/proof-poke.js").ProofPokeState;
  preferred?: string[];
}): VerificationRunClass | null {
  const { task, harnessStats } = opts;
  if (task.status === "running") return null;
  if (harnessStats.creditedBgTaskIds.has(task.id)) return null;
  harnessStats.creditedBgTaskIds.add(task.id);
  const exitCode =
    typeof task.exitCode === "number"
      ? task.exitCode
      : task.status === "completed"
        ? 0
        : 1;
  let cls = classifyVerificationRun({
    command: task.command,
    exitCode,
    isError: task.status !== "completed",
    output: readTaskLogTailForVerification(task),
    preferredCheckCommands: opts.preferred,
  });
  if (!cls.ran) return cls;
  if (task.status !== "completed") cls = { ...cls, passed: false, fullSuite: false };
  applyVerificationCredit({
    harnessStats,
    meta: opts.meta,
    proofPoke: opts.proofPoke,
    cls,
    command: task.command,
    preferred: opts.preferred,
  });
  return cls;
}

/** Task ids a get_task_output call addressed (args) or printed (output). */
export function bgTaskIdsFromToolCall(
  toolInput: Record<string, unknown>,
  output: unknown,
): string[] {
  const ids = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string") {
      for (const p of v.split(/[\s,]+/)) if (p.trim()) ids.add(p.trim());
    } else if (Array.isArray(v)) {
      for (const x of v) add(x);
    }
  };
  add(toolInput.task_id);
  add(toolInput.taskId);
  add(toolInput.task_ids);
  add(toolInput.taskIds);
  const text = typeof output === "string" ? output : "";
  for (const m of text.matchAll(/^task_id:\s*(\S+)/gm)) {
    if (m[1]) ids.add(m[1]);
  }
  return [...ids];
}

const READ_ONLY = new Set([
  "read_file",
  "Read",
  "read",
  "grep",
  "Grep",
  "glob",
  "Glob",
  "list_dir",
  "ListDir",
  "web_search",
  "WebSearch",
  "web_fetch",
  "WebFetch",
  "github",
  "get_task_output",
  "task_output",
  "search_mcp",
  "mcp_search",
  "mcp_resource",
  "mcp_prompt",
  "lsp",
  "LSP",
  "enter_plan_mode",
  "EnterPlanMode",
  "enterPlanMode",
]);

/**
 * Permission / dontAsk / doom fingerprint: tools that do not mutate the
 * workspace. Parallel batching uses `isParallelSafeToolCall` (this set plus
 * spawn that cannot touch the parent tree mid-flight).
 */
export function isReadOnlyToolName(name: string): boolean {
  const n = normalizeToolName(name || "");
  return READ_ONLY.has(n) || READ_ONLY.has(name || "");
}

export function isSpawnToolName(name: string): boolean {
  const n = normalizeToolName(name || "");
  return n === "spawn_subagent" || n === "Task" || n === "task";
}

/** Unset = on. `isFalsy` includes `0` / `false` / `off` / `no` / `disabled`. */
export function subagentParallelEnabled(): boolean {
  return !isFalsy(process.env.FORGE_SUBAGENT_PARALLEL);
}

export interface ParallelSafeOpts {
  mcp?: McpManager;
  workspace: string;
  /** config.permissionMode === "plan" || ulw phase === "orient" */
  planOrOrient: boolean;
}

/**
 * Consecutive-batch predicate. spawn_subagent is NOT read-only; it is
 * parallel-safe only when the child cannot mutate the parent tree mid-flight.
 */
export function isParallelSafeToolCall(
  tc: ToolCall,
  opts: ParallelSafeOpts,
): boolean {
  const n = normalizeToolName(tc.function.name || "");
  if (
    isExitPlanModeToolName(n) ||
    isExitPlanModeToolName(tc.function.name || "") ||
    isEnterPlanModeToolName(n) ||
    isEnterPlanModeToolName(tc.function.name || "")
  ) {
    return false;
  }
  if (isLspToolName(n) || isLspToolName(tc.function.name || "")) {
    const parsed = parseToolArguments(tc.function.arguments);
    if (!parsed.ok) return false;
    return !lspActionInstalls(parsed.value);
  }
  if (isReadOnlyToolName(n) || isReadOnlyToolName(tc.function.name || "")) {
    return true;
  }
  if (n === "call_mcp" || n === "mcp_call" || n === "use_mcp") {
    const parsed = parseToolArguments(tc.function.arguments);
    if (!parsed.ok) return false;
    return mcpCallIsReadOnly(opts.mcp, parsed.value);
  }
  if (isSpawnToolName(n) || isSpawnToolName(tc.function.name || "")) {
    if (!subagentParallelEnabled()) return false;
    return isSpawnParallelSafe(tc, opts);
  }
  return false;
}

/** Consecutive groups, each length <= 8. Barriers (false) are singleton groups. */
export function partitionParallelBatches(
  calls: ToolCall[],
  opts: ParallelSafeOpts,
): ToolCall[][] {
  const groups: ToolCall[][] = [];
  let i = 0;
  while (i < calls.length) {
    const cur = calls[i];
    if (!cur) break;
    if (isParallelSafeToolCall(cur, opts)) {
      const batch: ToolCall[] = [];
      while (
        i < calls.length &&
        calls[i] &&
        isParallelSafeToolCall(calls[i]!, opts) &&
        batch.length < 8
      ) {
        batch.push(calls[i]!);
        i++;
      }
      groups.push(batch);
    } else {
      groups.push([cur]);
      i++;
    }
  }
  return groups;
}

function spawnDisplayArgs(
  name: string,
  toolInput: Record<string, unknown>,
  opts: { planOrOrient: boolean },
): Record<string, unknown> {
  if (!isSpawnToolName(name)) return toolInput;
  const raw =
    toolInput.subagent_type ?? toolInput.type ?? toolInput.agent_type;
  if (!subagentTypeRawIsOmitted(raw)) return toolInput;
  return {
    ...toolInput,
    subagent_type: resolveSpawnSubagentType(raw, {
      planMode: opts.planOrOrient,
    }),
  };
}

/** `/plan`: research + read-only spawn, no writes. */
const PLAN_MODE_TOOL_NAMES = new Set([
  "read_file",
  "Read",
  "read",
  "grep",
  "Grep",
  "glob",
  "Glob",
  "list_dir",
  "ListDir",
  "web_search",
  "WebSearch",
  "web_fetch",
  "WebFetch",
  "github",
  "todo_write",
  "memory_write",
  "ask_user",
  "AskUser",
  "exit_plan_mode",
  "ExitPlanMode",
  "exitPlanMode",
  "bash",
  "Bash",
  "shell",
  "Shell",
  "run_terminal_command",
  "get_task_output",
  "task_output",
  "search_mcp",
  "mcp_search",
  "call_mcp",
  "mcp_call",
  "use_mcp",
  "mcp_resource",
  "mcp_prompt",
  "lsp",
  "LSP",
  "spawn_subagent",
  "Task",
  "task",
]);

export function citedPathsFromToolCalls(msg: ChatMessage): string[] {
  const out: string[] = [];
  for (const tc of msg.tool_calls || []) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function?.arguments || "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const key of [
      "path",
      "file_path",
      "target_file",
      "directory",
      "target_directory",
      "glob",
      "pattern",
    ]) {
      const v = args[key];
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  }
  return out;
}

function assistantHasExplorePick(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (parseExploreMap(String(m.content || ""))) return true;
  }
  return false;
}

function lastAssistantWasToolsOnly(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const tools = m.tool_calls?.length ?? 0;
    return tools > 0 && !parseExploreMap(String(m.content || ""));
  }
  return false;
}

/** Hide write tools from the model while in /plan (Claude/Grok-style). */
export function filterToolsForPermissionMode(
  tools: ToolDefinition[],
  mode: string,
): ToolDefinition[] {
  if (mode !== "plan") return tools;
  return tools.filter(
    (t) =>
      PLAN_MODE_TOOL_NAMES.has(t.function.name) ||
      PLAN_MODE_TOOL_NAMES.has(normalizeToolName(t.function.name)),
  );
}

export interface BuildChatRequestOpts {
  conversationId?: string;
  estimatedTokens?: number;
  lastApiPromptTokens?: number;
  /** After a thought-only Stop, force the next call to emit a tool. */
  toolChoice?: "auto" | "required";
  /** Frozen omit set from a prior clip (session.meta.requestPruneSticky). */
  sticky?: RequestPruneSticky | null;
  /**
   * Cursor: next chat() should open a new AgentService Run with the slim
   * history instead of conversation_action on the fat live stream.
   */
  rebaseConversation?: boolean;
  /** Suffix mill-tool ids to omit without inventing a first clip. */
  holdOmitIds?: string[] | null;
  /** Wave-1 / named-ship / explore-map files — prune keeps these tools. */
  jobKeepPaths?: string[];
  /** After a fetch-failed storm, keep only the last N vision images. */
  maxVisionImages?: number;
  onPrune?: (info: {
    kind: PruneKind;
    sticky?: RequestPruneSticky;
    changed: boolean;
  }) => void;
}

/** Tool-result round — Cursor must resume the live Run, not rebase. */
export function lastTurnIsToolContinuation(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" || m.role === "system") return false;
    if (m.role === "tool") return true;
    if (m.role === "assistant") return Boolean(m.tool_calls?.length);
  }
  return false;
}

/** Build provider chat request including reasoning_effort when supported. */
export function buildChatRequest(
  config: ForgeConfig,
  messages: ChatMessage[],
  effortOverride?: ReasoningEffort,
  tools: ToolDefinition[] = TOOL_DEFINITIONS,
  opts?: BuildChatRequestOpts,
): ChatRequest {
  const effort =
    effortOverride ?? resolveReasoningEffort(config.model, config.reasoningEffort);
  const toolsJsonChars = JSON.stringify(tools).length;
  const estimated =
    opts?.estimatedTokens ??
    estimateRequestTokens(messages, { toolsJsonChars });
  // Append-only until the 180k cliff, then one clip + sticky omit set.
  // FORGE_REQUEST_PRUNE=1 restores every-round slim. session.messages stays full.
  const prep = prepareOutboundMessages(messages, {
    estimatedTokens: estimated,
    toolsJsonChars,
    sticky: opts?.sticky,
    lastApiPromptTokens: opts?.lastApiPromptTokens,
    contextWindow: config.contextWindow,
    spool: true,
    jobKeepPaths: opts?.jobKeepPaths,
  });
  opts?.onPrune?.({
    kind: prep.kind,
    sticky: prep.sticky,
    changed: prep.changed,
  });
  let wire = prep.messages;
  const holdIds = (opts?.holdOmitIds ?? []).filter(Boolean);
  if (holdIds.length) {
    const held = applyStickyPrune(wire, {
      omitted: holdIds,
      collapsed: [],
      softTrimmed: [],
      stubbedHarness: [],
      shelf: 0,
      clippedAt: "",
    });
    if (held.changed) wire = held.messages;
  }
  // Phase 6: expand [[image:path]] / @shot.png markers into multimodal parts
  // for vision-capable providers (inline data URLs). Stored session history
  // keeps the original string markers — only the outbound request expands.
  const outbound = expandMessagesForVision(wire, config.workspace, {
    maxImages: opts?.maxVisionImages,
  });
  return {
    model: config.model,
    messages: outbound,
    tools,
    ...(opts?.conversationId
      ? { conversationId: opts.conversationId }
      : {}),
    // Undefined temperature → omitted; provider/server default wins (grok-build
    // parity — server-tuned sampling beats a client-guessed 0.2 on reasoning
    // models; DeepSeek thinking ignores temperature outright).
    ...(config.temperature != null ? { temperature: config.temperature } : {}),
    // User pin wins; otherwise reasoning models get a larger output budget so
    // high-effort thinking is not truncated into length-continue re-sends.
    max_tokens: resolveEffectiveMaxTokens(config, Boolean(effort)),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(config.contextWindow
      ? { context_window: config.contextWindow }
      : {}),
    ...(config.workspace ? { workspace: config.workspace } : {}),
    ...(opts?.toolChoice === "required" && tools.length
      ? { tool_choice: "required" as const }
      : {}),
    ...(opts?.rebaseConversation ? { rebaseConversation: true } : {}),
  };
}

const IMAGE_MARK_RE = /\[\[image:/i;
const AT_IMAGE_RE = /@[^\s]+\.(png|jpe?g|gif|webp|bmp)\b/i;

function messageHasImageMarks(text: string): boolean {
  return IMAGE_MARK_RE.test(text) || AT_IMAGE_RE.test(text);
}

/**
 * Expand [[image:path]] / @shot.png into multimodal parts.
 * User messages expand in place. Tool results cannot carry image_url on
 * OpenAI-compat wires, so after a run of tool messages we append one user
 * vision turn with the images (session history stays string-only).
 */
export function expandMessagesForVision(
  messages: ChatMessage[],
  workspace?: string,
  opts?: { maxImages?: number },
): OutboundChatMessage[] {
  const cap =
    typeof opts?.maxImages === "number" &&
    Number.isFinite(opts.maxImages) &&
    opts.maxImages >= 0
      ? Math.floor(opts.maxImages)
      : 6;
  const out: OutboundChatMessage[] = [];
  const pending: ChatContentPart[] = [];
  const flushPending = () => {
    if (!pending.length) return;
    const parts = pending.splice(0, pending.length);
    const images = parts.filter((p) => p.type === "image_url").slice(-cap);
    if (!images.length) return;
    out.push({
      role: "user",
      content: [
        {
          type: "text",
          text: "Vision: images from the previous tool result(s). Describe what you see.",
        },
        ...images,
      ],
    });
  };
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") {
      flushPending();
      if (!messageHasImageMarks(m.content)) {
        out.push(m);
        continue;
      }
      const expanded = expandUserContentWithImages(m.content, workspace);
      out.push(typeof expanded === "string" ? m : { ...m, content: expanded });
      continue;
    }
    if (m.role === "tool" && typeof m.content === "string" && messageHasImageMarks(m.content)) {
      out.push(m);
      const expanded = expandUserContentWithImages(m.content, workspace);
      if (typeof expanded !== "string") {
        for (const p of expanded) {
          if (p.type === "image_url") pending.push(p);
        }
      }
      continue;
    }
    if (m.role !== "tool") flushPending();
    out.push(m);
  }
  flushPending();
  return typeof opts?.maxImages === "number"
    ? keepLastVisionImages(out, cap)
    : out;
}

/** Drop earlier image_url parts so a retry storm does not resend the whole look-loop. */
function keepLastVisionImages(
  messages: OutboundChatMessage[],
  maxImages: number,
): OutboundChatMessage[] {
  if (!(maxImages >= 0)) return messages;
  let keep = maxImages;
  const reversed: OutboundChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!Array.isArray(m.content)) {
      reversed.push(m);
      continue;
    }
    const parts: ChatContentPart[] = [];
    for (let j = m.content.length - 1; j >= 0; j--) {
      const p = m.content[j]!;
      if (p.type === "image_url") {
        if (keep > 0) {
          parts.push(p);
          keep -= 1;
        }
      } else {
        parts.push(p);
      }
    }
    parts.reverse();
    const hasImage = parts.some((p) => p.type === "image_url");
    const text = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (
      !hasImage &&
      /Vision: images from the previous tool result/i.test(text)
    ) {
      continue;
    }
    reversed.push(parts.length ? { ...m, content: parts } : m);
  }
  reversed.reverse();
  return reversed;
}

/**
 * Resolve agent-loop turn budget.
 * `max_turns <= 0` (config default) means unlimited — not a silent 200-cap.
 */
export function resolveMaxTurns(maxTurns: number | undefined | null): number {
  if (
    typeof maxTurns === "number" &&
    Number.isFinite(maxTurns) &&
    maxTurns > 0
  ) {
    return Math.floor(maxTurns);
  }
  return Number.POSITIVE_INFINITY;
}

function baseHookCtx(session: SessionData, config: ForgeConfig): HookContext {
  return {
    sessionId: session.meta.id,
    cwd: session.meta.cwd,
    workspaceRoot: config.workspace || session.meta.cwd,
    turnCount: session.meta.turnCount,
    editCount: session.meta.editCount,
    ultrawork: session.meta.ultrawork,
  };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Aborted");
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return abortableSleep(ms, signal);
}

export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult> {
  const {
    config,
    session,
    hooks,
    permissions,
    userMessage,
    stream = true,
    signal,
  } = opts;
  const capNow = () =>
    opts.resolveCostCap
      ? opts.resolveCostCap()
      : costCapStatus(config, session.meta);
  // Mutable so mid-run OAuth refresh can hot-swap the bearer token
  let provider = opts.provider;
  /** Generations of successful mid-run auth recovery (not a one-shot for multi-day). */
  let authRecoveryCount = 0;
  const maxAuthRecoveries = envPositiveInt("FORGE_AUTH_RECOVERY_MAX", 20);
  let accountSwitchCount = 0;
  const maxAccountSwitches = envPositiveInt("FORGE_ACCOUNT_SWITCH_MAX", 3);
  let teamSpendCapTried = false;
  /** Socket drops / generic provider_error that a typed "continue" would recover. */
  let dropRecoveryCount = 0;
  const maxDropRecoveries = envPositiveInt(
    "FORGE_PROVIDER_DROP_RECOVERY_MAX",
    5,
  );
  const defaultStarts = opts.events?.onToolStart
    ? null
    : createToolStartDelayer((line) => console.error(line));
  const events: LoopEvents = {
    onToken: opts.events?.onToken || opts.onToken,
    onReasoning: opts.events?.onReasoning,
    onToolStart:
      opts.events?.onToolStart ??
      ((name, args) => defaultStarts!.push(name, args)),
    onToolEnd: (name, result) => {
      defaultStarts?.settle(name);
      if (opts.events?.onToolEnd) opts.events.onToolEnd(name, result);
      else console.error(formatDefaultToolEndTranscript(name, result));
    },
    onToolSettled: opts.events?.onToolSettled,
    onStatus: opts.events?.onStatus,
    onPhase: opts.events?.onPhase,
  };
  // ULW cycle needs more stop-continues than a normal turn
  const ulwArmed = cycleActive(loadCycleState(session.meta.id));
  const maxStopContinues =
    opts.maxStopContinues ??
    (ulwArmed ? envPositiveInt("FORGE_ULW_MAX_CONTINUES", 200) : 50);
  const workspace = config.workspace || session.meta.cwd;
  /** Session-turn file read tracker — stale-edit protection (OpenCode-inspired). */
  const fileReads = fileReadsForSession(session.meta.id);
  // Inline @path mentions on the latest user turn so experts can point at
  // files without a follow-up "read this first" (also stamps FileReadState).
  try {
    // Newest-first: expand the latest @path turn, restamp older already-inlined
    // mentions so resume/compact still satisfy the edit-read guard.
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m?.role !== "user" || typeof m.content !== "string") continue;
      if (!m.content.includes("@")) continue;
      const expanded = expandUserMentions(m.content, workspace, fileReads);
      if (expanded !== m.content) m.content = expanded;
    }
  } catch {
    /* */
  }
  const citeSeen = opts.citeDeltaStop ? new Set<string>() : null;
  let citeStaleTurns = 0;
  const startPrompt = session.meta.totalPromptTokens;
  const startComp = session.meta.totalCompletionTokens;
  const startCache = session.meta.totalCacheReadTokens ?? 0;

  // ── MCP / LSP / subagent depth ──
  // Managers are process-scoped (like background bash tasks): create once,
  // reuse across REPL turns, dispose on process exit (installMcpLspExitHook).
  const subagentDepth = opts.subagentDepth ?? 0;
  const maxSubagentDepth = opts.maxSubagentDepth ?? defaultMaxSubagentDepth();
  const baseToolDefs = opts.toolDefinitions ?? TOOL_DEFINITIONS;
  const toolsForMode = (): typeof baseToolDefs =>
    filterToolsForPermissionMode(baseToolDefs, config.permissionMode);
  // A role that runs the product but cannot edit it (the ULW Planner:
  // capability=full, denyEdits) must never hear "fix until green" or "run the
  // check" — it owns no file to fix, and a HashPet Planner spent ~45 of its 60
  // turns chasing a red test it structurally could not touch, then died with
  // no plan. The signal is its own tool set: no edit tool ⇒ read-only intent.
  const canEditFiles = toolSetCanEdit(baseToolDefs);
  let mcp =
    opts.mcp ??
    (subagentDepth === 0 ? getActiveMcpManager() ?? undefined : undefined);
  let lsp =
    opts.lsp ??
    (subagentDepth === 0 ? getActiveLspManager() ?? undefined : undefined);
  const mcpAutostart = opts.mcpAutostart !== false;
  const lspAutostart = opts.lspAutostart !== false;
  if (!mcp && mcpAutostart) {
    mcp = new McpManager({ workspace, signal, sessionId: session.meta.id });
    mcp.start();
    if (subagentDepth === 0) setActiveMcpManager(mcp);
  }
  if (!lsp && lspAutostart) {
    lsp = new LspManager({ workspace, signal });
    if (subagentDepth === 0) setActiveLspManager(lsp);
  }
  if (subagentDepth === 0) {
    exitCleanupWorkspace = workspace;
    exitCleanupSessionId = session.meta.id;
  }
  installMcpLspExitHook();
  /** Distinct divergent served models seen this run (provider tier routing). */
  const runServedModels = new Set<string>();
  const doomLoop = new DoomLoopTracker({
    threshold: envPositiveInt("FORGE_DOOM_LOOP_THRESHOLD", 3),
  });
  const errorStreak = new ErrorStreakTracker({
    threshold: envPositiveInt("FORGE_ERROR_STREAK_THRESHOLD", 5),
  });
  const harnessStats: HarnessRunStats = {
    verificationRuns: 0,
    verificationPassedRuns: 0,
    verificationHelperOnlyRuns: 0,
    verificationFullSuiteRuns: 0,
    totalRuns: 0,
    totalPassed: 0,
    totalFullSuite: 0,
    effortBoostTurns: 0,
    creditedBgTaskIds: new Set<string>(),
  };
  /** Consecutive Stop blocks from handoff-guard (polite yield). Resets on allow. */
  let handoffBlocks = 0;
  /** Consecutive Stop blocks from proof-claim guard. Resets on allow. */
  let proofClaimBlocks = 0;
  /** Report-guard bounces this run (homework / last-round-only closer). */
  let reportBlocks = 0;
  // In-session tool-clear mutates history and busts the prompt-cache prefix.
  // Default off — request-time prune (buildChatRequest) is the wire path.
  // FORGE_TOOL_CLEAR=1 restores the old mutating microcompaction.
  const toolClearCfg = toolClearEnvConfig();
  const toolClearEveryTurns = envPositiveInt("FORGE_TOOL_CLEAR_EVERY_TURNS", 4);
  let lastToolClearTurn = 0;
  // Adaptive effort escalation (hard rounds think harder; easy rounds stay cheap)
  const adaptiveEffortOn = !(
    process.env.FORGE_ADAPTIVE_EFFORT === "0" ||
    process.env.FORGE_ADAPTIVE_EFFORT === "false"
  );

  // Auto-arm goal from prose (disabled for nested subagents)
  if (
    !opts.resumeWithoutUserMessage &&
    !opts.disableHarnessAutoArm &&
    config.goal.autoArm &&
    config.goal.enabled
  ) {
    const existing = loadGoal(session.meta.id);
    if (!existing?.objective || existing.status === "cleared") {
      const detected = detectAutoGoal(userMessage);
      if (detected) {
        armGoal(session.meta.id, detected, "auto");
        maybeSetTitle(session, detected);
        log.info(`Auto-armed /goal: ${detected.slice(0, 100)}`);
      }
    }
  }

  // Session flagged ultrawork (forge --ulw / `/ulw` before the first prompt)
  // with no armed cycle: this message is the mandate (or, for a bare follow-up,
  // case c — no mandate). An armed run treats user text as steering; the
  // Planner reads it at the next re-plan.
  let effectiveUserMessage = userMessage;
  if (
    !opts.resumeWithoutUserMessage &&
    !opts.disableHarnessAutoArm &&
    session.meta.ultrawork
  ) {
    const existing = loadCycleState(session.meta.id);
    if (!existing || !cycleActive(existing)) {
      const mandate = isResumeFollowUp(userMessage)
        ? null
        : mandateFromUserText(userMessage);
      const armed = armCycle({
        sessionId: session.meta.id,
        mandate,
        cwd: workspace,
        maxCycles: existing && !existing.legacy ? existing.maxCycles : null,
      });
      log.info(
        `ULW armed — plan-cycle mode${mandate ? "" : " (no mandate: the Planner derives the direction)"}`,
      );
      effectiveUserMessage = ulwKickoffMessage(armed);
    } else if (!effectiveUserMessage.trim()) {
      // `forge run "" --ulw` / `/ulw` with nothing after it: the driver was
      // armed before this turn; the kickoff is the turn's user row.
      const armed = loadActiveCycle(session.meta.id);
      if (armed) effectiveUserMessage = ulwKickoffMessage(armed);
    }
  }

  if (!opts.resumeWithoutUserMessage) {
    await hooks.run("UserPromptSubmit", {
      ...baseHookCtx(session, config),
      prompt: effectiveUserMessage,
    });
  }

  const goal = loadGoal(session.meta.id);
  const ulwCycle = loadCycleState(session.meta.id);
  const ulwOn = cycleActive(ulwCycle);
  const harnessActive =
    session.meta.ultrawork || ulwOn || Boolean(goal?.objective && goal.status === "active" && !goal.paused);

  // Baseline system only — live ULW/goal counters admitted mid-conversation.
  // Git snapshot is computed ONCE per prompt: the system message carries only
  // the stable subset (root/remote) so message[0] does not churn between
  // prompts and break the provider's server-side prompt cache; the volatile
  // branch line goes through the append-only harness admission instead.
  const gitSnap = getGitSnapshot(workspace);
  const system = buildBaselineSystemPrompt({
    config,
    workspace,
    ultrawork: session.meta.ultrawork || ulwOn,
    git: gitSnap,
    subagentDepth,
  });
  if (session.messages.length === 0 || session.messages[0]?.role !== "system") {
    session.messages.unshift({ role: "system", content: system });
  } else if (session.messages[0].content !== system) {
    // Update baseline only when content actually changed (profile/mode/rules)
    session.messages[0] = { role: "system", content: system };
  }

  if (!opts.resumeWithoutUserMessage) {
    maybeSetTitle(session, userMessage);
    markUserTurn(session);
    session.messages.push({ role: "user", content: effectiveUserMessage });
    session.meta.turnCount += 1;
    resetTodoNudgeForPrompt(session.meta.id);
    // New user turn (including typing "continue" after quota) must not keep
    // a stale ERR:quota_exhausted banner on the HUD for the whole next run.
    try {
      if (clearTransientProviderError(session)) saveSession(session);
    } catch {
      /* */
    }
  }

  // Kickoff already carries mandate/counts/memory — do not emit a second
  // "Obey this state" user turn. Still record the snapshot so the next
  // boundary does not re-admit the same ULW.
  // Baseline after the real user/kickoff row so this-run meters exclude
  // prior-session history but include this prompt's admits and pokes.
  const pokeBaseline = session.messages.length;
  if (effectiveUserMessage.startsWith("[Forge ULW cycle driver] armed") || ulwOn) {
    // ULW kickoff already carries state. Do not append a second 2k admit
    // (rewrites the prefix and kills xAI cache). Fingerprint only.
    markCurrentHarnessAdmitted(session, config, gitSnap);
  } else {
    admitHarnessState(session, config);
  }
  // Agent-guidelines audit: the first action of a session (deferred while
  // plan mode denies mutations — re-checked at each boundary).
  maybeAdmitGuidelineAudit(session, config);

  saveSession(session);

  /**
   * Stamp + registry + user notice once per run (Stop allow or run end).
   *
   * `repeat` is a later run of the same session reading the audit that an
   * earlier one already closed — nothing happened this turn, so it is neither
   * announced again nor hung on this run's result.
   */
  let guidelineResult: GuidelineFinalizeResult | undefined;
  const finalizeGuidelineAuditForRun = (): void => {
    if (guidelineResult) return;
    try {
      const r = finalizeGuidelineAudit({
        sessionId: session.meta.id,
        workspace,
        lastUserMessage: lastRealUserPrompt(session)?.text,
        autoApply: Boolean(config.guidelineAutoApply),
        turn: session.meta.turnCount,
      });
      if (r.skipped || r.repeat) return;
      guidelineResult = r;
      for (const line of formatGuidelineAuditNotice(r)) log.info(line);
    } catch {
      /* never fail a run on the audit */
    }
  };

  let turns = 0;
  // Per-run counter. Session leftover from the last successful loop must
  // not leak onto a crash run_end that dies before the first turns += 1.
  session.meta.providerRounds = 0;
  let finalText = "";
  let stopContinues = 0;
  /** Length / empty / content_filter only — never shared with Stop-blocks. */
  let providerContinues = 0;
  let lastCommittedSha = "";
  /** Cap mid-loop verify nudges per prompt (anti-spam). */
  let verifyNudges = 0;
  const proofPoke = createProofPokeState();
  // Background checks are proof when they settle: the spawn observed
  // nothing, the exit observes everything a foreground run does. Dogfood
  // ran 20/28 and 45/61 checks in the background (as the doctrine says)
  // and every one was proof=✗ — the harness contradicted itself.
  const offBgSettled = onBackgroundTaskSettled((task) => {
    if (task.status === "running") return;
    if (!taskBelongsToWorkspace(task.cwd, workspace)) return;
    if (harnessStats.creditedBgTaskIds.has(task.id)) return;
    void (async () => {
      let preferred: string[] | undefined;
      try {
        const { detectProjectIntel } = await import("../util/project-intel.js");
        preferred = detectProjectIntel(workspace).checkCommands;
      } catch {
        preferred = undefined;
      }
      preferred = cyclePreferredCheckCommands(session.meta.id, preferred);
      creditBackgroundTaskVerification({
        task,
        harnessStats,
        meta: session.meta,
        proofPoke,
        preferred,
      });
    })();
  });
  let aborted = false;
  let releasedOnContinueCap = false;
  let hitMaxTurns = false;
  let hitCostCap = false;
  let stuckReleased = false;
  let lastCycleReleased = false;
  let ulwEndReason: string | undefined;
  let lastFinishReason: string | null = null;
  let autoCommit: LoopResult["autoCommit"];
  let overflowCompactAttempted = false;
  /** Dimension 400 is bad_request; drop outbound image_url and re-issue once. */
  let visionImagesStripped = false;
  // max_turns <= 0 means unlimited (config default is 0). A silent 200-cap when
  // the file says 0 was a production footgun for long ULW/CI runs.
  const maxTurns = resolveMaxTurns(config.maxTurns);
  /** Last outbound request was prefix-breaking prune (for per-round metrics). */
  let lastOutboundPruned = false;
  let lastPruneKind: PruneKind = "off";
  let lastRoundCacheRatio = 0;
  /** Tool schemas are sent every turn but not stored in session history. */
  /** After thought-only Stop, the next chat must emit a tool — not another judge. */
  let forceToolNext = false;
  /** Consecutive thought-only Stops this turn (reasoning_wall / loop / thought+stop). */
  let thoughtOnlyStops = 0;
  /**
   * Cursor live Run still holds the pre-compact transcript. Next *user*
   * action must open a new Run; tool continuations still resume.
   */
  let cursorRebaseDue = false;
  /**
   * After two fetch-failed retries, cap outbound vision images and skip a
   * second reap. Cleared at the start of each for(;;) model turn; kept
   * across inner drop/auth/quota doChat re-entry in the same turn.
   */
  let visionImageCap: number | undefined;
  let dropRetries = 0;
  let browsersReapedThisChat = false;
  const makeChatRequest = (effortOverride?: ReasoningEffort) => {
    const tools = toolsForMode();
    const estimated = estimateRequestTokens(session.messages, {
      toolsJsonChars: JSON.stringify(tools).length,
    });
    const cursorRebase =
      isCursorProvider(config.provider) &&
      (cursorRebaseDue ||
        cursorHostNeedsRebase(
          session.meta.lastRoundPromptTokens,
          config.contextWindow,
        ));
    if (cursorRebase && !lastTurnIsToolContinuation(session.messages)) {
      cursorRebaseDue = false;
      const api = session.meta.lastRoundPromptTokens ?? 0;
      if (api > 0) {
        log.dim(
          `Cursor Run rebase — ${formatTokens(api)} / ${formatTokens(config.contextWindow)} onto a new stream`,
        );
      } else {
        log.dim("Cursor Run rebase — slim history onto a new stream");
      }
    }
    const req = buildChatRequest(config, session.messages, effortOverride, tools, {
      conversationId: session.meta.id,
      estimatedTokens: estimated,
      lastApiPromptTokens: session.meta.lastRoundPromptTokens,
      sticky: session.meta.requestPruneSticky,
      holdOmitIds: session.meta.holdOmitToolIds,
      jobKeepPaths: (() => {
        try {
          return cycleKeepPaths(session.meta.id);
        } catch {
          return undefined;
        }
      })(),
      rebaseConversation: cursorRebase,
      toolChoice: forceToolNext && tools.length ? "required" : undefined,
      maxVisionImages: visionImageCap,
      onPrune: (info) => {
        lastPruneKind = info.kind;
        lastOutboundPruned = info.kind !== "off";
        if (info.kind === "off") {
          delete session.meta.lastPruneKind;
        } else {
          session.meta.lastPruneKind = info.kind;
        }
        if (info.kind === "always") {
          clearRequestPruneSticky(session);
        } else if (info.sticky) {
          session.meta.requestPruneSticky = info.sticky;
        }
      },
    });
    if (!visionImagesStripped) return req;
    return { ...req, messages: stripOutboundImageParts(req.messages) };
  };

  const requestTokenEstimate = (): number => {
    const tools = toolsForMode();
    const extras = { toolsJsonChars: JSON.stringify(tools).length };
    const raw = estimateRequestTokens(session.messages, extras);
    const prep = prepareOutboundMessages(session.messages, {
      estimatedTokens: raw,
      toolsJsonChars: extras.toolsJsonChars,
      sticky: session.meta.requestPruneSticky,
      lastApiPromptTokens: session.meta.lastRoundPromptTokens,
      contextWindow: config.contextWindow,
      spool: false,
      jobKeepPaths: cycleKeepPaths(session.meta.id),
    });
    return estimateRequestTokens(prep.messages, {
      ...extras,
      includeReasoning: true,
    });
  };

  /**
   * Compact history. Returns true if message count or estimated tokens dropped.
   * Callers use this to avoid thrashing compact every turn when already minimal.
   */
  const forceCompact = async (
    reason: string,
    keepLast?: number,
  ): Promise<boolean> => {
    const beforeCount = session.messages.length;
    const beforeTok = estimateTokens(session.messages);
    events.onPhase?.("compacting");
    await hooks.run("PreCompact", baseHookCtx(session, config));
    const ulwNow = loadCycleState(session.meta.id);
    const goalNow = loadGoal(session.meta.id);
    const keep =
      keepLast ??
      (reason.startsWith("overflow") ? 2 : DEFAULT_CHECKPOINT_KEEP_STEPS);
    session.messages = compactMessages(session.messages, keep, {
      ulw: ulwNow,
      goal: goalNow,
      todos: session.todos,
      sessionId: session.meta.id,
      cwd: workspace,
      lastVerificationCommand: session.meta.lastVerificationCommand,
      lastVerificationAt: session.meta.lastVerificationAt,
      lastEditAt: session.meta.lastEditAt,
    });
    // Compact rewrites the prefix — drop the frozen omit set so the next
    // send first-clips against the new store instead of applying dead ids.
    clearRequestPruneSticky(session);
    const healed = repairToolCallPairing(session.messages);
    if (healed.changed) session.messages = healed.messages;
    // Compact rewrites history — resync undo marks so /undo never restores disk
    // against a no-op chat rewind.
    rebuildUserTurnMarks(session);
    await hooks.run("PostCompact", baseHookCtx(session, config));
    saveSession(session);
    const afterTok = estimateTokens(session.messages);
    const reduced =
      session.messages.length < beforeCount || afterTok < beforeTok * 0.98;
    if (reduced) {
      log.dim(
        `Compacted conversation history (${reason}; ~${beforeTok}→${afterTok} tok)`,
      );
      if (isCursorProvider(config.provider)) {
        cursorRebaseDue = true;
        if (!lastTurnIsToolContinuation(session.messages)) {
          closeCursorLiveForChat({
            model: config.model,
            messages: session.messages,
          });
        }
      }
    } else {
      log.dim(
        `Compact skipped/no-op (${reason}; history already near keep window)`,
      );
    }
    return reduced;
  };

  /** Shrink huge tool/assistant bodies without dropping turns. */
  const forcePruneBodies = (
    reason: string,
    limits: { maxToolChars: number; maxAssistantChars: number; maxToolArgChars: number },
  ): boolean => {
    const beforeTok = estimateTokens(session.messages);
    const result = pruneOversizedMessageBodies(session.messages, limits);
    if (result.pruned === 0) return false;
    session.messages = result.messages;
    const healed = repairToolCallPairing(session.messages);
    if (healed.changed) session.messages = healed.messages;
    saveSession(session);
    const afterTok = estimateTokens(session.messages);
    log.dim(
      `Pruned ${result.pruned} oversized body(ies) (${reason}; ~${beforeTok}→${afterTok} tok)`,
    );
    return afterTok < beforeTok * 0.98;
  };

  /**
   * Progressive overflow recovery: prune bodies → shrink keep window → nuclear.
   * Returns true if anything was reduced. Does not re-issue the chat itself.
   */
  const recoverContextOverflow = async (): Promise<boolean> => {
    events.onPhase?.("compacting");
    events.onStatus?.("Context overflow — progressive compact…");
    let any = false;
    const target = config.contextWindow * Math.min(config.autoCompactThreshold, 0.75);

    // 1) Soft prune of huge tool dumps still in the keep window
    if (
      forcePruneBodies("overflow-prune", {
        maxToolChars: 6_000,
        maxAssistantChars: 12_000,
        maxToolArgChars: 4_000,
      })
    ) {
      any = true;
    }
    if (requestTokenEstimate() < target) return any;

    // 2) Structured compact with shrinking keep windows
    for (const keep of [8, 4, 2]) {
      if (await forceCompact(`overflow-k${keep}`, keep)) any = true;
      if (requestTokenEstimate() < target) return any;
      if (
        forcePruneBodies(`overflow-prune-k${keep}`, {
          maxToolChars: keep <= 2 ? 1_500 : 3_000,
          maxAssistantChars: keep <= 2 ? 3_000 : 6_000,
          maxToolArgChars: keep <= 2 ? 1_000 : 2_000,
        })
      ) {
        any = true;
      }
      if (requestTokenEstimate() < target) return any;
    }
    return any;
  };

  /** After overflow / HTTP/2 rebase compact under ULW/goal: re-anchor without waiting for Stop. */
  const admitAfterHistoryShrink = (
    kind: "overflow" | "http2-rebase",
  ): void => {
    const ulwNow = loadCycleState(session.meta.id);
    const goalNow = loadGoal(session.meta.id);
    const lead =
      kind === "overflow"
        ? "[Forge] Context overflow recovered — history was compacted/pruned so the run can continue."
        : "[Forge] HTTP/2 stream dropped — history was compacted/pruned so a fresh Run can rebase.";
    const parts: string[] = [
      lead,
      "Do not re-scan the whole workspace from zero. Use the compact summary + recent tail, verify only what you still need, then continue the highest-impact remaining work.",
    ];
    if (ulwNow && cycleActive(ulwNow)) {
      const open = ulwNow.items.filter((i) => i.status === "open");
      parts.push(
        `ULW still ACTIVE: ${formatUlwCounts(ulwNow)}${ulwNow.planTitle ? ` — plan: ${ulwNow.planTitle}` : ""}.`,
        open.length
          ? `Open plan items: ${open.map((i) => `${i.id} ${i.title}`).slice(0, 6).join(" · ")}`
          : "",
        kind === "overflow"
          ? "Keep executing the plan; the harness re-anchors at the next clean Stop."
          : "The HTTP/2 Run dropped mid-turn. Continue the plan from the compact summary; do not restart the job.",
      );
    }
    if (goalNow?.objective && goalNow.status === "active" && !goalNow.paused) {
      parts.push(`Goal still ACTIVE: ${goalNow.objective}`);
    }
    session.messages.push({ role: "user", content: parts.join("\n") });
    admitHarnessState(session, config, { emit: false });
    saveSession(session);
  };

  const admitAfterOverflowRecovery = (): void => {
    admitAfterHistoryShrink("overflow");
  };

  /** After a no-op threshold compact, don't re-attempt until messages grow. */
  let skipThresholdCompactUntilCount = 0;
  /** One-shot expert warning when context first crosses pressure bands. */
  let warnedContextPressure: "threshold" | "hard" | null = null;
  /** Avoid rewriting message[0] unless plan/ULW/model actually flipped. */
  let lastSystemEpoch = "";

  /**
   * The cycle driver's hands: fresh-context Planner / Reviewer subagents, the
   * harness-run verify command, git, the todo board and the transcript admit.
   * Only a root loop with a provider can supply it; a subagent never drives.
   */
  const cycleRuntime: CycleRuntime | undefined =
    provider && subagentDepth === 0
      ? {
          workspace,
          runRole: async (role, brief, roleOpts) => {
            const roleModel =
              role === "planner" ? config.ulw?.plannerModel : config.ulw?.reviewerModel;
            const roleEffort =
              role === "planner" ? config.ulw?.plannerEffort : config.ulw?.reviewerEffort;
            const turn = roleOpts.resumeSessionId ? "turn 2" : roleOpts.keepSession ? "turn 1" : "fresh context";
            events.onPhase?.("tool", `cycle ${roleOpts.cycle} ${role}`);
            events.onStatus?.(`ULW cycle ${roleOpts.cycle}: ${role} (${turn})`);
            const res = await runSubagentTracked(
              {
                prompt: brief,
                description: `cycle ${roleOpts.cycle} ${role}`,
                role,
                model: roleModel,
                reasoningEffort: roleEffort,
                // forge-rootcause rides with both roles: the class of change
                // the record shows twice is a symptom, at the run level as at a bug.
                inlineSkills: [role === "planner" ? "forge-planner" : "forge-reviewer", "forge-veteran", "forge-rootcause"],
                ...(roleOpts.resumeSessionId ? { resumeSessionId: roleOpts.resumeSessionId } : {}),
                ...(roleOpts.keepSession ? { keepSession: true } : {}),
                ...(roleOpts.maxTurns ? { maxTurns: roleOpts.maxTurns } : {}),
                ...(roleOpts.documentOnly ? { documentOnly: true } : {}),
              },
              {
                config,
                provider,
                parentSession: session,
                hooks,
                permissions,
                workspace,
                signal,
                events,
                depth: subagentDepth,
                maxDepth: maxSubagentDepth,
                mcp,
                lsp,
              },
            );
            return {
              ok: res.ok,
              text: res.body ?? res.text,
              status: res.status ?? (res.ok ? "completed" : "error"),
              promptTokens: res.promptTokens,
              completionTokens: res.completionTokens,
              editCount: res.editCount,
              error: res.error,
              ...(res.sessionId ? { sessionId: res.sessionId } : {}),
            };
          },
          cleanupRoleSession: async (sessionId) => {
            await cleanupSubagentSession(sessionId);
          },
          runCheck: async (command) => {
            events.onPhase?.("tool", `verify ${command.slice(0, 40)}`);
            events.onStatus?.(`ULW verify: ${command}`);
            let preferred: string[] | undefined;
            try {
              const { detectProjectIntel } = await import("../util/project-intel.js");
              preferred = detectProjectIntel(workspace).checkCommands;
            } catch {
              preferred = undefined;
            }
            const run = await runCheckCommand({
              command,
              cwd: workspace,
              signal,
              preferredCheckCommands: cyclePreferredCheckCommands(session.meta.id, preferred),
            });
            return run;
          },
          creditCheck(run, passed) {
            // The harness's own check is a verification run like any other,
            // counted by the gate's verdict: green vs baseline is a pass.
            let preferred: string[] | undefined;
            try {
              preferred = detectProjectIntel(workspace).checkCommands;
            } catch {
              preferred = undefined;
            }
            applyVerificationCredit({
              harnessStats,
              meta: session.meta,
              proofPoke,
              cls: {
                ...run.cls,
                passed,
                fullSuite: passed && (run.cls.fullSuite || isFullSuiteCommand(run.command, preferred)),
              },
              command: run.command,
              preferred,
            });
            saveSession(session);
          },
          commit: ({ subject, body }) => {
            // Stamp the guideline audit first so the proofread mark rides the
            // cycle commit instead of dirtying the tree after it.
            finalizeGuidelineAuditForRun();
            const ac = commitDirtyTree({
              cwd: workspace,
              subject,
              body,
              permissionMode: config.permissionMode,
              sessionId: session.meta.id,
            });
            session.meta.lastAutoCommit = autoCommitStamp(ac);
            if (ac.initializedGit) {
              log.info("Initialized git repository for this project (local only, never pushed)");
            }
            if (ac.committed) {
              const sha = ac.sha || "HEAD";
              const line = `Committed ${sha} — ${ac.subject} (${ac.files ?? 0} file(s), not pushed)`;
              if (sha !== lastCommittedSha) {
                lastCommittedSha = sha;
                log.info(chalk.green(line));
                events.onStatus?.(line);
              }
              autoCommit = {
                committed: ac.committed,
                sha: ac.sha,
                subject: ac.subject,
                skipped: ac.skipped,
              };
            }
            const left = formatLeftUnstagedAdmit(ac, session.meta.id);
            if (left) session.messages.push({ role: "user", content: left });
            saveSession(session);
            return ac;
          },
          seedTodos: (items: CyclePlanItem[]) => {
            applyTodos(
              session,
              items.map((i) => ({
                id: i.id,
                content: i.title,
                status:
                  i.status === "done"
                    ? "completed"
                    : i.status === "cancelled"
                      ? "cancelled"
                      : "pending",
              })),
              false,
            );
            saveSession(session);
          },
          todos: () => session.todos,
          admit: (text) => {
            session.messages.push({ role: "user", content: text });
            saveSession(session);
          },
          gitHead: () => gitHeadSha(workspace),
          gitDiffSince: (head) => gitDiffSinceHead(workspace, head),
          gitLogSince: (head) => gitLogSince(workspace, head),
          gitStatus: () => gitStatusShort(workspace),
          gitIsClean: () => gitIsClean(workspace),
          userMessagesSince: (iso) => userMessagesSince(session, iso),
          guidelineSurvey: () => {
            const s = surveyGuidelines(workspace);
            const head = formatGuidelineStatusLine(s);
            const files = s.files.map((f) => `- ${describeGuidelineFile(f)}`);
            return [head, ...files].join("\n");
          },
          projectChecks: () => {
            try {
              return detectProjectIntel(workspace).checkCommands ?? [];
            } catch {
              return [];
            }
          },
          rememberIdentity: (text) => {
            try {
              appendProjectMemory(workspace, { text: `Identity: ${text}`, kind: "fact", source: "agent" });
            } catch {
              /* project memory is best-effort */
            }
          },
          rememberPromises: (promises) => {
            // One fact row per promise as last inspected; the store dedupes on
            // text, so a promise adds a row only when its state changes. Where
            // it was seen stays on ulw.json — it is rewritten every cycle and
            // would grow the tracked MEMORY.md mirror by a row per rewording.
            for (const p of promises.slice(0, 24)) {
              try {
                appendProjectMemory(workspace, {
                  text: `Promise: ${p.text} — ${p.state}`.slice(0, 400),
                  kind: "fact",
                  source: "agent",
                });
              } catch {
                /* project memory is best-effort */
              }
            }
          },
          log: (line) => log.info(chalk.magenta(line)),
        }
      : undefined;

  // Turn start under ULW with no plan on disk: the Planner writes cycle 1's
  // plan before the executor's first model call. A fulfilled / blocked
  // verdict ends the run here with the report.
  let earlyRelease = false;
  if (cycleRuntime) {
    try {
      const planned = await ensureCyclePlanned(session.meta.id, cycleRuntime);
      if (planned?.released) {
        lastCycleReleased = true;
        ulwEndReason = planned.endReason;
        session.meta.ultrawork = false;
        saveSession(session);
        log.info(chalk.magenta(planned.reason));
        finalText = planned.reason;
        earlyRelease = true;
      } else if (planned?.reanchor) {
        session.messages.push({ role: "user", content: planned.reanchor });
        markCurrentHarnessAdmitted(session, config);
        saveSession(session);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      log.warn(`ULW planner failed at turn start: ${(err as Error).message}`);
    }
  }

  try {
    // Check maxTurns / cost cap at the top so a clean Stop on the final allowed
    // turn is not mis-reported as hitMaxTurns/hitCostCap.
    for (;;) {
      if (earlyRelease) break;
      if (turns >= maxTurns) {
        hitMaxTurns = true;
        break;
      }
      {
        const cap = capNow();
        if (cap.hit) {
          hitCostCap = true;
          break;
        }
      }
      assertNotAborted(signal);
      turns += 1;
      session.meta.providerRounds = turns;
      visionImageCap = undefined;
      dropRetries = 0;
      browsersReapedThisChat = false;

      if (citeSeen && citeDeltaShouldPoke(citeStaleTurns)) {
        const already = session.messages.some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.startsWith(CITE_DELTA_POKE),
        );
        const hasPick = assistantHasExplorePick(session.messages);
        const lastWasToolsOnly = lastAssistantWasToolsOnly(session.messages);
        const pickDemanded = session.messages.some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.startsWith(CITE_DELTA_PICK_POKE),
        );
        if (
          citeDeltaShouldStop(citeStaleTurns, already, {
            hasPick,
            lastWasToolsOnly,
            pickDemanded,
          })
        ) {
          if (!(finalText || "").trim()) {
            finalText = hasPick
              ? "[Forge] Cite-delta stop — map stopped growing."
              : "[Forge] Cite-delta stop — no pick: after the map poke.";
          }
          break;
        }
        if (!already) {
          session.messages.push({
            role: "user",
            content:
              `${CITE_DELTA_POKE}.\n` +
              `The map stopped growing. Emit the structured map now:\n` +
              `pick: <one sentence naming the hole — required>\n` +
              `passed_on: <what you skipped>\n` +
              `files:\n` +
              `  <path>:<line>  <claim>\n` +
              `A file list without pick: is not a map. Do not start a new search.`,
          });
        } else if (lastWasToolsOnly && !hasPick && !pickDemanded) {
          session.messages.push({
            role: "user",
            content: formatCiteDeltaPickPoke(),
          });
        }
      }

      // Nested children never see their turn budget unless we say so.
      // ~80% wrap poke, then last-turn report-only. Skip last-turn when
      // cite-delta already asked for the map this turn.
      if (subagentDepth > 0 && Number.isFinite(maxTurns)) {
        const wrapAt = subagentWrapTurn(maxTurns);
        if (wrapAt && turns === wrapAt) {
          const already = session.messages.some(
            (m) =>
              m.role === "user" &&
              typeof m.content === "string" &&
              m.content.startsWith(SUBAGENT_WRAP_POKE),
          );
          if (!already) {
            session.messages.push({
              role: "user",
              content: formatSubagentWrapPoke(turns, maxTurns),
            });
          }
        }
        if (
          turns === maxTurns &&
          !(citeSeen && citeDeltaShouldPoke(citeStaleTurns))
        ) {
          const already = session.messages.some(
            (m) =>
              m.role === "user" &&
              typeof m.content === "string" &&
              m.content.startsWith(SUBAGENT_LAST_TURN_POKE),
          );
          if (!already) {
            session.messages.push({
              role: "user",
              content: formatSubagentLastTurnPoke(maxTurns),
            });
          }
        }
      }

      // Live /plan|/build can flip permission mode. Do not rebuild message[0]
      // every turn — that busts the xAI prefix cache on a 12-hour run.
      {
        const ulwLiveOn =
          Boolean(session.meta.ultrawork) || cycleActive(loadCycleState(session.meta.id));
        const systemEpoch = `${config.permissionMode}|${ulwLiveOn ? 1 : 0}|${subagentDepth}|${config.model}`;
        if (systemEpoch !== lastSystemEpoch) {
          lastSystemEpoch = systemEpoch;
          const liveSystem = buildBaselineSystemPrompt({
            config,
            workspace,
            ultrawork: ulwLiveOn,
            git: gitSnap,
            subagentDepth,
          });
          if (
            session.messages[0]?.role === "system" &&
            session.messages[0].content !== liveSystem
          ) {
            session.messages[0] = { role: "system", content: liveSystem };
          }
        }
      }

      // Outbound (pruned) vs store. Checkpoint the store when it is huge.
      // Do not FullReplace just because the wire is 80k — prune already
      // handles that. Headroom still uses outbound so we don't 400 the API.
      const storeTok = estimateTokens(session.messages);
      const est = requestTokenEstimate();
      const storeDue = storeNeedsCheckpoint(session.messages.length, storeTok);
      const nearHardLimit = est > config.contextWindow * 0.92;
      // Expert-visible one-shot pressure warning (OpenCode-style overflow hygiene)
      if (nearHardLimit && warnedContextPressure !== "hard") {
        warnedContextPressure = "hard";
        const pct = Math.min(99, Math.round((est / config.contextWindow) * 100));
        log.warn(
          `Context pressure ~${pct}% of window (${formatTokens(est)} / ${formatTokens(config.contextWindow)}) — compacting for headroom`,
        );
      } else if (storeDue && warnedContextPressure == null) {
        warnedContextPressure = "threshold";
        log.dim(
          `Store ~${formatTokens(storeTok)} / ${session.messages.length} msgs — checkpoint compact`,
        );
      }
      if (
        (storeDue || nearHardLimit) &&
        session.messages.length > skipThresholdCompactUntilCount
      ) {
        let reduced = await forceCompact(
          nearHardLimit && !storeDue ? "headroom" : "checkpoint",
        );
        if (!reduced && nearHardLimit) {
          reduced = forcePruneBodies("threshold-prune", {
            maxToolChars: 4_000,
            maxAssistantChars: 8_000,
            maxToolArgChars: 2_500,
          });
        }
        if (!reduced) {
          // Avoid compacting every turn when already minimal but still "over"
          skipThresholdCompactUntilCount = session.messages.length;
          // Expert recovery: still near hard limit after compact/prune failed
          if (nearHardLimit) {
            try {
              const pct = Math.min(
                99,
                Math.round((est / config.contextWindow) * 100),
              );
              setSessionLastError(session, {
                code: "context_pressure",
                message: `Context still ~${pct}% after compact/prune — provider may reject the next turn`,
                tips: [
                  "/compact  ·  /compact-and <next>  ·  /new",
                  "Raise context_window or drop large tool outputs",
                ],
              });
              saveSession(session);
            } catch {
              /* */
            }
          }
        } else {
          skipThresholdCompactUntilCount = 0;
          // Compact freed headroom — drop stale context_pressure banner
          if (session.meta.lastError?.code === "context_pressure") {
            try {
              clearSessionLastError(session);
              saveSession(session);
            } catch {
              /* */
            }
          }
        }
      }

      // Optional in-session stubbing (opt-in). Request-time prune already
      // slims the outbound payload without rewriting session.json.
      const ulwAggressive = cycleActive(loadCycleState(session.meta.id));
      const clearEvery = ulwAggressive
        ? Math.min(toolClearEveryTurns, 2)
        : toolClearEveryTurns;
      // ULW used to cap keepRecent at 6, which is smaller than a legal
      // parallel read-only batch (8 tools + assistant). Floor at 10 so the
      // advertised hot tail can actually hold the last batch.
      const keepRecent = ulwAggressive
        ? Math.max(toolClearCfg.keepRecent, 10)
        : toolClearCfg.keepRecent;
      const minStale = ulwAggressive
        ? Math.min(toolClearCfg.minStaleBytes, 8000)
        : toolClearCfg.minStaleBytes;
      if (
        toolClearCfg.enabled &&
        turns - lastToolClearTurn >= clearEvery &&
        session.messages.length > keepRecent + 4
      ) {
        const cleared = clearStaleToolResults(session.messages, {
          keepRecent,
          minChars: ulwAggressive
            ? Math.min(toolClearCfg.minChars, 800)
            : toolClearCfg.minChars,
        });
        if (cleared.cleared > 0 && cleared.freedChars >= minStale) {
          session.messages = cleared.messages;
          lastToolClearTurn = turns;
          saveSession(session);
          log.dim(
            `Cleared ${cleared.cleared} stale tool result(s), freed ~${Math.round(cleared.freedChars / 1000)}k chars — stubs point at saved output`,
          );
        }
      }

      // Heal illegal tool_call / tool_result sequences before every provider call
      // (abort mid-batch, crash recovery, compact edge cases → API 400 otherwise).
      {
        const healed = repairToolCallPairing(session.messages);
        if (healed.changed) {
          session.messages = healed.messages;
          saveSession(session);
          if (healed.filledOrphanToolCalls > 0) {
            log.dim(
              `Repaired ${healed.filledOrphanToolCalls} orphaned tool_call(s) before provider turn`,
            );
          }
        }
      }

      // Safe provider-turn boundary: admit harness deltas, live slash, free-text
      drainSafeBoundaryMessages(session, config, events, fileReads);
      maybeAdmitSelfHealReminder(session);

      // Soft todo nudge under ULW/goal (does not block)
      const lastUserForNudge = [...session.messages]
        .reverse()
        .find((m) => m.role === "user");
      const nudge = maybeTodoNudge({
        sessionId: session.meta.id,
        harnessActive,
        openTodoCount: openTodos(session.todos),
        lastUserMessage:
          typeof lastUserForNudge?.content === "string"
            ? lastUserForNudge.content
            : undefined,
      });
      if (nudge) {
        session.messages.push({ role: "user", content: nudge });
        saveSession(session);
      }

      events.onPhase?.("thinking");
      // Proactive multi-account + OAuth refresh before provider call.
      // Unattended multi-hour runs: switch exhausted accounts before chat,
      // then renew near-expiry tokens so we never wait for a mid-stream 401.
      try {
        const hadPin = Boolean(session.meta.accountId);
        const pin = pinSessionAccount(session, String(config.provider));
        if (!hadPin && session.meta.accountId) {
          saveSession(session);
        }
        if (pin.account?.accessToken && provider.updateCredentials) {
          provider.updateCredentials(pin.account.accessToken);
        }
      } catch {
        /* never block the turn on session pin */
      }
      try {
        if (accountSwitchCount < maxAccountSwitches) {
          const proactive = maybeProactiveSwitch(String(config.provider));
          if (proactive.switched && proactive.account?.accessToken) {
            accountSwitchCount += 1;
            recordSessionAccountSwitch(session, proactive);
            saveSession(session);
            if (provider.updateCredentials) {
              provider.updateCredentials(proactive.account.accessToken);
            }
            log.info(
              `Proactive account switch → ${proactive.toLabel || proactive.toId} (${proactive.reason})`,
            );
            events.onStatus?.(
              `Proactive account → ${proactive.toLabel || proactive.toId}`,
            );
          }
        }
      } catch {
        /* never block the turn on proactive switch */
      }
      try {
        const refreshed = await refreshCredentialIfNeeded(
          String(config.provider),
          { skewSec: 600 },
        );
        if (refreshed.refreshed && refreshed.credential?.accessToken) {
          if (provider.updateCredentials) {
            provider.updateCredentials(refreshed.credential.accessToken);
          }
          events.onStatus?.("OAuth token refreshed (proactive)");
        } else if (
          !refreshed.ok &&
          accountSwitchCount < maxAccountSwitches &&
          provider.updateCredentials
        ) {
          // Near-expiry / force refresh failed (dead RT, network) — fail over
          // before the chat call burns a hard 403 and kills a multi-hour ULW.
          accountSwitchCount += 1;
          events.onStatus?.(
            `OAuth refresh failed — trying another account (${accountSwitchCount}/${maxAccountSwitches})…`,
          );
          const switched = switchOnAuthFailure(String(config.provider));
          if (switched.switched && switched.account?.accessToken) {
            recordSessionAccountSwitch(session, switched);
            saveSession(session);
            try {
              const r = await refreshCredentialIfNeeded(
                String(config.provider),
                { force: true, skewSec: 600 },
              );
              if (r.ok && r.credential?.accessToken) {
                provider.updateCredentials(r.credential.accessToken);
              } else {
                provider.updateCredentials(switched.account.accessToken);
              }
            } catch {
              provider.updateCredentials(switched.account.accessToken);
            }
            log.info(
              `Proactive auth failover → ${switched.toLabel || switched.toId} (${switched.reason})`,
            );
            events.onStatus?.(
              `Switched account → ${switched.toLabel || switched.toId}`,
            );
          }
        }
      } catch {
        /* never block the turn on proactive refresh */
      }
      let response: Awaited<ReturnType<typeof provider.chat>> | undefined;
      let roundRetries: Array<{ attempt: number; reason: string; delayMs: number }> =
        [];
      const flushRoundRetries = (usage?: {
        promptTokens: number;
        cacheReadTokens: number;
        completionTokens: number;
        cacheDrop?: boolean;
      }) => {
        if (!roundRetries.length && !usage) return;
        try {
          appendProviderRoundMetrics({
            sessionId: session.meta.id,
            provider: String(config.provider),
            model: config.model,
            promptTokens: usage?.promptTokens ?? 0,
            cacheReadTokens: usage?.cacheReadTokens ?? 0,
            completionTokens: usage?.completionTokens ?? 0,
            pruned: lastOutboundPruned,
            pruneKind: lastPruneKind,
            cacheDrop: usage?.cacheDrop,
            turn: turns,
            accountId: session.meta.accountId,
            retries: roundRetries.length ? roundRetries : undefined,
          });
        } catch {
          /* metrics never fail the turn */
        }
        roundRetries = [];
      };
      const fallbackTried = new Set<string>([
        normalizeFallbackModelId(String(config.provider), config.model),
      ]);
      // Adaptive effort: hard-round signals (doom-loop / error-streak / missing
      // wave proof) buy a one-notch reasoning boost for this turn only —
      // escalate on failure, not by default, so easy rounds stay cheap.
      let effortOverride: ReasoningEffort | undefined;
      if (adaptiveEffortOn && harnessStats.effortBoostTurns > 0) {
        harnessStats.effortBoostTurns -= 1;
        const baseEffort = resolveReasoningEffort(
          config.model,
          config.reasoningEffort,
        );
        const bumped = bumpReasoningEffort(config.model, baseEffort);
        if (bumped && bumped !== baseEffort) {
          effortOverride = bumped;
          log.dim(
            `Adaptive effort: reasoning escalated to ${bumped} for this turn (hard-round signal)`,
          );
        }
      }
      try {
        const doChat = () =>
          withRetry(
            async () => {
              assertNotAborted(signal);
              if (stream && (events.onToken || events.onReasoning)) {
                return provider.chatStream(
                  makeChatRequest(effortOverride),
                  (delta) => notifyStreamDelta(delta, events, signal),
                  signal,
                );
              }
              const r = await provider.chat(
                makeChatRequest(effortOverride),
                signal,
              );
              if (r.message.reasoning_content && events.onReasoning) {
                events.onReasoning({
                  chars: r.message.reasoning_content.length,
                });
              }
              if (r.message.content && events.onToken) {
                events.onToken(r.message.content);
              }
              return r;
            },
            {
              retries: 3,
              label: `${config.provider} chat`,
              signal,
              shouldRetry: (e, attempt) => {
                // Same-payload HTTP/2 / Cursor `internal` retries once, then
                // drop recovery shrinks history before a new Run rebase.
                if (isReconnectWithoutAuthDrop(e) && attempt >= 1) return false;
                return isRetryableError(e);
              },
              onRetry: ({ delayMs, attempt, retries, error }) => {
                roundRetries.push({
                  attempt,
                  reason: retryEventReason(error),
                  delayMs: Math.round(delayMs),
                });
                const storm = noteFetchFailedRetry(error, dropRetries);
                dropRetries = storm.count;
                if (storm.visionImageCap != null) {
                  visionImageCap = storm.visionImageCap;
                }
                if (storm.reap && !browsersReapedThisChat) {
                  browsersReapedThisChat = true;
                  try {
                    // Isolation-none children share the parent workspace;
                    // never wipe chrome-look* mid-chat (Planner scout).
                    reapSessionBrowsers(session.meta.id, {
                      workspace,
                      chromeLooks: false,
                    });
                  } catch {
                    /* fail-open */
                  }
                }
                const why = isProviderApiError(error)
                  ? `HTTP ${error.status}${error.retryAfterMs != null ? " (Retry-After)" : ""}`
                  : error instanceof Error
                    ? error.message.slice(0, 80)
                    : "transient error";
                const wait = formatRetryWait(delayMs);
                events.onStatus?.(
                  `Retry ${attempt}/${retries} in ${wait} — ${why}`,
                );
                events.onPhase?.("waiting", `retry ${wait}: ${why}`);
              },
            },
          );

        try {
          response = await doChat();
        } catch (err) {
          // Context overflow: progressive compact then re-issue (never same payload)
          if (isContextOverflowError(err)) {
            if (overflowCompactAttempted) {
              const ulwDead = loadActiveCycle(session.meta.id);
              const ulwNote = ulwDead
                ? ` ULW remains armed (${formatUlwCounts(ulwDead)}) — after /compact or /new, re-arm with /ulw; the cycle does not auto-clear on provider death.`
                : "";
              throw new Error(
                `Context still overflows after progressive compact: ${(err as Error).message || err}. ` +
                  `Start a new session (/new) or raise context_window / lower history.${ulwNote}`,
              );
            }
            overflowCompactAttempted = true;
            log.warn(
              "Provider reported context overflow — progressive compact + one re-issue",
            );
            await recoverContextOverflow();
            admitAfterOverflowRecovery();
            events.onPhase?.("thinking");
            try {
              response = await doChat();
              // Success: allow another recovery later if context grows again
              overflowCompactAttempted = false;
              skipThresholdCompactUntilCount = 0;
            } catch (err2) {
              if (isContextOverflowError(err2)) {
                // Last-ditch nuclear prune + tiny keep, then one more try
                log.warn(
                  "Overflow persists after first recovery — nuclear prune + keep=2",
                );
                forcePruneBodies("overflow-nuclear", {
                  maxToolChars: 800,
                  maxAssistantChars: 1_500,
                  maxToolArgChars: 400,
                });
                await forceCompact("overflow-nuclear", 2);
                try {
                  response = await doChat();
                  overflowCompactAttempted = false;
                  skipThresholdCompactUntilCount = 0;
                } catch (err3) {
                  if (isContextOverflowError(err3)) {
                    const ulwDead = loadActiveCycle(session.meta.id);
                    const ulwNote = ulwDead
                      ? ` ULW remains armed (${formatUlwCounts(ulwDead)}) — session history was compacted; resume with a smaller request or /new.`
                      : "";
                    throw new Error(
                      `Context still overflows after progressive compact: ${(err3 as Error).message || err3}. ` +
                        `Start a new session (/new) or raise context_window / lower history.${ulwNote}`,
                    );
                  }
                  throw err3;
                }
              } else {
                throw err2;
              }
            }
          } else if (isImageDimensionError(err) && !visionImagesStripped) {
            visionImagesStripped = true;
            log.warn(
              "Provider rejected image dimensions — dropping vision parts and retrying once",
            );
            events.onStatus?.("Image too small for vision — retrying without images");
            events.onPhase?.("thinking");
            response = await doChat();
          } else {
            // OAuth recovery: true token failures (401 + SuperGrok 403
            // "access token could not be validated"). Generic quota 403 must
            // NOT burn a recovery slot — see isTokenAuthFailure.
            // Multi-account: 429/quota → switchOnQuotaFailure; dead token →
            // force refresh then switchOnAuthFailure.
            const msg = err instanceof Error ? err.message : String(err);
            const tokenAuthFail = isTokenAuthFailure(err);
            const quotaFail = !tokenAuthFail && isQuotaOrRateLimitError(err);

            const updateCreds = provider.updateCredentials?.bind(provider);

            /**
             * Apply a switched account: refresh OAuth on the new slot if needed,
             * then hot-swap the provider bearer. Returns false when unusable.
             */
            const forceRefreshLiveCreds = async (
              why: string,
            ): Promise<boolean> => {
              if (!updateCreds) return false;
              try {
                const r = await refreshCredentialIfNeeded(
                  String(config.provider),
                  { force: true, skewSec: 600 },
                );
                if (r.ok && r.credential?.accessToken) {
                  updateCreds(r.credential.accessToken);
                  log.info(`Refreshed credentials after ${why} — retrying`);
                  events.onStatus?.("Credentials refreshed — retrying");
                  return true;
                }
              } catch {
                /* fall through to grok re-import */
              }
              try {
                const { resolveAuthFresh } = await import("../auth/resolve.js");
                const fresh = await resolveAuthFresh(config, undefined, {
                  accountId: session.meta.accountId,
                });
                if (fresh?.token) {
                  updateCreds(fresh.token);
                  log.info(`Re-resolved credentials after ${why} — retrying`);
                  events.onStatus?.("Credentials re-resolved — retrying");
                  return true;
                }
              } catch {
                /* no live creds */
              }
              return false;
            };

            const applySwitchedAccount = async (
              switched: SwitchResult,
              why: string,
            ): Promise<boolean> => {
              if (!switched.switched || !updateCreds) return false;
              // Prefer a freshly refreshed token for the new active account
              // (force: the previous slot's bearer was already rejected).
              try {
                const r = await refreshCredentialIfNeeded(
                  String(config.provider),
                  { force: true, skewSec: 600 },
                );
                if (r.ok && r.credential?.accessToken) {
                  updateCreds(r.credential.accessToken);
                } else if (switched.account?.accessToken) {
                  updateCreds(switched.account.accessToken);
                } else {
                  return false;
                }
              } catch {
                if (switched.account?.accessToken) {
                  updateCreds(switched.account.accessToken);
                } else {
                  return false;
                }
              }
              log.info(
                `Switched to account ${switched.toLabel || switched.toId} after ${why} — retrying`,
              );
              events.onStatus?.(
                `Switched account → ${switched.toLabel || switched.toId} — retrying`,
              );
              recordSessionAccountSwitch(session, switched);
              saveSession(session);
              return true;
            };

            if (quotaFail) {
              try {
                recordQuotaFailurePlan(
                  session.meta.accountId ??
                    getActiveAccount(String(config.provider))?.id,
                );
              } catch {
                /* lastPlan refresh is best-effort */
              }
            }

            if (quotaFail && quotaFailoverBlockedByTeamCap(err, teamSpendCapTried)) {
              throw new Error(
                formatQuotaFailoverExhausted(msg, undefined, err, {
                  switchCount: accountSwitchCount,
                  switchMax: maxAccountSwitches,
                }),
              );
            }

            if (
              quotaFail &&
              accountSwitchCount < maxAccountSwitches &&
              updateCreds
            ) {
              if (isTeamSpendCapError(err)) teamSpendCapTried = true;
              accountSwitchCount += 1;
              events.onStatus?.(
                `Quota/rate-limit — trying another account (${accountSwitchCount}/${maxAccountSwitches})…`,
              );
              try {
                pinSessionAccount(session, String(config.provider));
              } catch {
                /* pin so we cooldown THIS session's slot */
              }
              let switched = switchOnQuotaFailure(String(config.provider));
              switched = await waitAndRetryQuotaSwitch(
                String(config.provider),
                switched,
                {
                  session,
                  sleep: (ms) => abortableDelay(ms, signal),
                  onWaiting: (waitSec) => {
                    events.onStatus?.(
                      `Waiting ${waitSec}s for account cooldown…`,
                    );
                    events.onPhase?.(
                      "waiting",
                      `account cooldown ${waitSec}s`,
                    );
                  },
                },
              );
              if (await applySwitchedAccount(switched, "quota/rate-limit")) {
                response = await doChat();
              } else {
                throw new Error(
                  formatQuotaFailoverExhausted(msg, switched, err, {
                    switchCount: accountSwitchCount,
                    switchMax: maxAccountSwitches,
                  }),
                );
              }
            } else if (tokenAuthFail && authRecoveryCount >= maxAuthRecoveries) {
              throw err;
            } else if (
              !tokenAuthFail &&
              isContinueRecoverableProviderError(err) &&
              dropRecoveryCount < maxDropRecoveries
            ) {
              // Screenshot case: Node `TypeError: terminated` (server RST /
              // dead token mid-stream) is not HTTP 401/403, so the auth path
              // never ran. Typing "continue" worked because the next loop
              // proactively refreshed OAuth. Do that in-loop.
              //
              // HTTP/2 RST / Cursor Connect `internal` is a dead Run, not a
              // dead token — reconnect without rotating creds, and shrink
              // history before stuffing conversation_history on a new Run.
              let lastDropErr: unknown = err;
              let dropRecovered = false;
              let http2RebaseCompactAttempted = false;
              let http2RebaseNuclearAttempted = false;
              while (dropRecoveryCount < maxDropRecoveries) {
                dropRecoveryCount += 1;
                const reconnectOnly = isReconnectWithoutAuthDrop(lastDropErr);
                const why = reconnectOnly
                  ? "HTTP/2 stream drop"
                  : isDroppedConnectionError(lastDropErr)
                    ? "dropped connection"
                    : "provider error";
                events.onPhase?.(
                  "waiting",
                  `provider drop ${dropRecoveryCount}/${maxDropRecoveries}`,
                );
                if (reconnectOnly) {
                  if (!http2RebaseCompactAttempted) {
                    http2RebaseCompactAttempted = true;
                    events.onStatus?.(
                      `Provider ${why} — compacting history before rebase (${dropRecoveryCount}/${maxDropRecoveries})…`,
                    );
                    const pruned = forcePruneBodies("http2-rebase-prune", {
                      maxToolChars: 6_000,
                      maxAssistantChars: 12_000,
                      maxToolArgChars: 4_000,
                    });
                    const compacted = await forceCompact("http2-rebase", 8);
                    if (pruned || compacted) {
                      admitAfterHistoryShrink("http2-rebase");
                    } else {
                      await abortableDelay(
                        Math.min(8_000, 400 * 2 ** (dropRecoveryCount - 1)),
                        signal,
                      );
                    }
                  } else if (!http2RebaseNuclearAttempted) {
                    http2RebaseNuclearAttempted = true;
                    events.onStatus?.(
                      `Provider ${why} — nuclear compact before rebase (${dropRecoveryCount}/${maxDropRecoveries})…`,
                    );
                    const pruned = forcePruneBodies("http2-rebase-nuclear", {
                      maxToolChars: 1_500,
                      maxAssistantChars: 3_000,
                      maxToolArgChars: 1_000,
                    });
                    const compacted = await forceCompact(
                      "http2-rebase-nuclear",
                      2,
                    );
                    if (pruned || compacted) {
                      admitAfterHistoryShrink("http2-rebase");
                    } else {
                      await abortableDelay(
                        Math.min(8_000, 400 * 2 ** (dropRecoveryCount - 1)),
                        signal,
                      );
                    }
                  } else {
                    const delay = Math.min(
                      8_000,
                      400 * 2 ** (dropRecoveryCount - 1),
                    );
                    events.onStatus?.(
                      `Provider ${why} — reconnecting in ${Math.round(delay)}ms (${dropRecoveryCount}/${maxDropRecoveries})…`,
                    );
                    await abortableDelay(delay, signal);
                  }
                } else {
                  events.onStatus?.(
                    `Provider ${why} — refreshing and retrying (${dropRecoveryCount}/${maxDropRecoveries})…`,
                  );
                  await forceRefreshLiveCreds(why);
                }
                try {
                  response = await doChat();
                  dropRecovered = true;
                  break;
                } catch (err2) {
                  lastDropErr = err2;
                  if (isContextOverflowError(err2)) throw err2;
                  if (
                    isTokenAuthFailure(err2) &&
                    authRecoveryCount < maxAuthRecoveries
                  ) {
                    // Became a real 401/403 — fall into the auth loop below
                    // by rethrowing into the outer doChat catch? Simpler to
                    // keep refreshing here (forceRefresh already ran).
                    continue;
                  }
                  if (!isContinueRecoverableProviderError(err2)) throw err2;
                  if (
                    !isReconnectWithoutAuthDrop(err2) &&
                    accountSwitchCount < maxAccountSwitches &&
                    updateCreds
                  ) {
                    accountSwitchCount += 1;
                    const switched = switchOnAuthFailure(
                      String(config.provider),
                    );
                    await applySwitchedAccount(switched, why);
                  }
                }
              }
              if (!dropRecovered) {
                throw lastDropErr instanceof Error
                  ? lastDropErr
                  : new Error(String(lastDropErr));
              }
            } else if (!tokenAuthFail || authRecoveryCount >= maxAuthRecoveries) {
              throw err;
            } else {
              // Mid-run token death recovery loop (unattended ULW).
              // Prefer the refreshed access token *directly* — do not re-run
              // resolveAuth(), which skips accounts still marked expired when
              // the token endpoint omits expires_in. That bug made recovery
              // throw; typing "continue" then worked via the proactive path
              // which already hot-swaps credential.accessToken.
              let lastAuthErr: unknown = err;
              let recovered = false;
              while (authRecoveryCount < maxAuthRecoveries) {
                authRecoveryCount += 1;
                events.onStatus?.(
                  `Auth failure — attempting token refresh (${authRecoveryCount}/${maxAuthRecoveries})…`,
                );

                let token: string | undefined;
                const refreshed = await refreshCredentialIfNeeded(
                  String(config.provider),
                  { force: true },
                );
                if (refreshed.ok && refreshed.credential?.accessToken) {
                  token = refreshed.credential.accessToken;
                }
                // SuperGrok refresh often fails (revoked/CF) — full
                // resolveAuthFresh re-imports live ~/.grok before giving up.
                if (!token) {
                  try {
                    const { resolveAuthFresh } = await import(
                      "../auth/resolve.js"
                    );
                    const fresh = await resolveAuthFresh(config, undefined, {
                      accountId: session.meta.accountId,
                    });
                    token = fresh?.token;
                  } catch {
                    /* fall through */
                  }
                }

                if (token && updateCreds) {
                  updateCreds(token);
                  log.info(
                    "Refreshed credentials after auth failure — retrying chat",
                  );
                  events.onStatus?.("Credentials refreshed — retrying");
                  try {
                    response = await doChat();
                    recovered = true;
                    break;
                  } catch (err2) {
                    lastAuthErr = err2;
                    if (
                      isTokenAuthFailure(err2) ||
                      isContinueRecoverableProviderError(err2)
                    ) {
                      // Still dead, or the socket dropped after refresh
                      // (xAI often RST instead of a clean 401). Keep looping.
                    } else {
                      throw err2;
                    }
                  }
                }

                // Token still bad or no refresh path — multi-account failover.
                if (
                  accountSwitchCount < maxAccountSwitches &&
                  updateCreds
                ) {
                  accountSwitchCount += 1;
                  const switched = switchOnAuthFailure(
                    String(config.provider),
                  );
                  if (await applySwitchedAccount(switched, "auth failure")) {
                    try {
                      response = await doChat();
                      recovered = true;
                      break;
                    } catch (err2) {
                      lastAuthErr = err2;
                      if (
                        isTokenAuthFailure(err2) ||
                        isContinueRecoverableProviderError(err2)
                      ) {
                        continue;
                      }
                      throw err2;
                    }
                  }
                  // Switch unavailable — keep looping while recoveries remain
                  // (another force-refresh may race-succeed).
                  if (!token) {
                    events.onStatus?.(
                      switched.reason
                        ? `Auth recovery: ${switched.reason}`
                        : "Auth recovery: no alternate account",
                    );
                  }
                  continue;
                }

                // No switch budget and no usable token — stop looping.
                if (!token || !updateCreds) break;
              }

              if (!recovered) {
                const detail =
                  lastAuthErr instanceof Error
                    ? lastAuthErr.message
                    : String(lastAuthErr ?? msg);
                throw new Error(
                  `${detail}. Auth recovery failed after ${authRecoveryCount} attempt(s). ` +
                    `Re-login: forge login  ·  or forge login --add`,
                );
              }
            }
          }
        }
      } catch (err) {
        flushRoundRetries();
        if ((err as Error).message === "Aborted" || signal?.aborted) {
          aborted = true;
          break;
        }
        if (isModelFallbackWorthy(err) && !signal?.aborted) {
          const next = nextFallbackModel(config, { tried: fallbackTried });
          if (next) {
            const prev = config.model;
            const provider = String(config.provider);
            const resolved = applyFallbackHop(config, next);
            fallbackTried.add(
              normalizeFallbackModelId(provider, resolved),
            );
            const same =
              normalizeFallbackModelId(provider, resolved) ===
              normalizeFallbackModelId(provider, prev);
            if (!same) {
              session.meta.model = resolved;
              session.meta.lastModelFallback = {
                from: prev,
                to: resolved,
                at: new Date().toISOString(),
              };
              saveSessionMetaSidecar(session);
              log.warn(
                `Model fallback: ${prev} unavailable (${
                  err instanceof Error ? err.message.slice(0, 80) : "error"
                }) → ${resolved}`,
              );
              events.onStatus?.(`Model fallback → ${resolved}`);
              continue;
            }
          }
        }
        await hooks.run("StopFailure", {
          ...baseHookCtx(session, config),
          stopReason: (err as Error).message,
        });
        throw err;
      }

      if (!response) {
        throw new Error("Provider returned no response");
      }

      // Served-model divergence: the API reports which model actually served.
      // Providers may silently route to a different tier (load, effort caps) —
      // a requested flash can be billed as pro. Surface it once per model.
      if (servedModelDiverged(config.model, response.model)) {
        const served = String(response.model);
        if (!(session.meta.servedModels ?? []).includes(served)) {
          session.meta.servedModels = [
            ...(session.meta.servedModels ?? []),
            served,
          ].slice(-8);
          events.onStatus?.(
            `⚠ Provider served "${served}" for requested "${config.model}" — check billing/routing`,
          );
        }
        if (!runServedModels.has(served)) runServedModels.add(served);
      }

      if (response.usage) {
        session.meta.totalPromptTokens += response.usage.prompt_tokens;
        session.meta.totalCompletionTokens += response.usage.completion_tokens;
        session.meta.totalCacheReadTokens =
          (session.meta.totalCacheReadTokens ?? 0) +
          (response.usage.cache_read_input_tokens ?? 0);
        session.meta.lastRoundPromptTokens = response.usage.prompt_tokens;
        session.meta.lastRoundCacheReadTokens =
          response.usage.cache_read_input_tokens ?? 0;
        try {
          const ratio = cacheHitRatio(
            response.usage.prompt_tokens,
            response.usage.cache_read_input_tokens ?? 0,
          );
          flushRoundRetries({
            promptTokens: response.usage.prompt_tokens,
            cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
            completionTokens: response.usage.completion_tokens,
            cacheDrop: lastRoundCacheRatio > 0.9 && ratio < 0.05,
          });
          lastRoundCacheRatio = ratio;
        } catch {
          /* metrics never fail the turn */
        }
      } else {
        flushRoundRetries();
      }

      const assistantMsg = response.message;
      session.messages.push(assistantMsg);
      finalText = assistantMsg.content || "";
      noteAssistantTurn(session.meta.id);
      if (citeSeen) {
        const cited = citedPathsFromToolCalls(assistantMsg);
        citeStaleTurns = noteCiteDelta(citeSeen, cited, citeStaleTurns).staleTurns;
      }
      saveSession(session);

      // Cost cap after usage lands — release before more tool work / continues.
      {
        const cap = capNow();
        if (cap.hit) {
          hitCostCap = true;
          log.warn(
            `maxCostUsd hit (${formatCostBudgetLine(cap)}) — releasing`,
          );
          events.onStatus?.(
            `Cost cap hit (~$${cap.spent.toFixed(3)} / $${(cap.cap ?? 0).toFixed(3)})`,
          );
          // Fall through: if there are tool_calls we still skip them by
          // breaking after the no-tool path would; break the outer loop now.
          break;
        }
      }

      const toolCalls = assistantMsg.tool_calls;
      if ((toolCalls && toolCalls.length > 0) || (finalText || "").trim()) {
        forceToolNext = false;
        thoughtOnlyStops = 0;
      }
      const finishReason = response.finish_reason || "";
      if (finishReason) lastFinishReason = finishReason;

      // Output truncated by max_tokens — continue generation instead of Stop
      if (
        (!toolCalls || toolCalls.length === 0) &&
        (finishReason === "length" || finishReason === "max_tokens")
      ) {
        providerContinues += 1;
        if (providerFuseTripsContinueCap(providerContinues, maxStopContinues)) {
          log.warn("max_tokens continuation cap reached — releasing");
          releasedOnContinueCap = true;
          // Headless JSON / CI: surface that we released on a truncated answer,
          // not a clean completion (parity with empty-response / content_filter).
          const capNote =
            "[Forge] Output stayed truncated until the continue cap; releasing. Raise max_tokens or continue in a follow-up.";
          if ((finalText || "").trim()) {
            if (!finalText.includes("[Forge] Output stayed truncated")) {
              finalText = `${finalText.replace(/\s+$/, "")}\n\n${capNote}`;
            }
          } else {
            finalText = capNote;
          }
          try {
            setSessionLastError(session, {
              code: "continue_cap_length",
              message: capNote.replace(/^\[Forge\]\s*/, ""),
              tips: [
                "Raise max_tokens or continue in a follow-up",
                "/retry  ·  /compact  ·  /model <other>",
              ],
            });
            saveSession(session);
          } catch {
            /* */
          }
          break;
        }
        log.info(
          chalk.yellow(
            `↻ Output truncated (finish_reason=${finishReason}) — continuing (#${providerContinues})`,
          ),
        );
        session.messages.push({
          role: "user",
          content:
            "[Forge] Your previous reply was cut off by the output token limit (finish_reason=length). " +
            "Continue exactly where you left off. Do not repeat completed work. " +
            "If you were about to call tools, call them now.",
        });
        saveSession(session);
        events.onPhase?.("thinking");
        continue;
      }

      // Content filter / safety refusal — surface clearly, don't spin forever
      if (
        (!toolCalls || toolCalls.length === 0) &&
        (finishReason === "content_filter" ||
          finishReason === "content_filtered" ||
          finishReason === "safety")
      ) {
        log.warn(
          `Model stopped for content filter (finish_reason=${finishReason})`,
        );
        finalText =
          finalText ||
          `[Forge] The provider blocked this response (finish_reason=${finishReason}). ` +
            `Rephrase, drop sensitive payloads, or try /model <other> · /compact · narrower scope.`;
        providerContinues += 1;
        // Cap check before injecting steerage — avoid orphan user msgs when releasing.
        if (providerFuseTripsContinueCap(providerContinues, maxStopContinues)) {
          log.warn("content-filter continue cap reached — releasing");
          releasedOnContinueCap = true;
          const capNote =
            "[Forge] Content-filter continues hit the cap; releasing. Rephrase, /model <other>, or narrow scope.";
          if (!finalText.includes("[Forge] Content-filter continues hit the cap")) {
            finalText = `${finalText.replace(/\s+$/, "")}\n\n${capNote}`;
          }
          try {
            setSessionLastError(session, {
              code: "content_filter",
              message: capNote.replace(/^\[Forge\]\s*/, ""),
              tips: [
                "Rephrase · drop secrets/PII · narrower scope",
                "/model <other>  ·  /compact  ·  /retry",
              ],
            });
            saveSession(session);
          } catch {
            /* */
          }
          break;
        }
        // Inject steerage and continue the loop (skip Stop) so ULW/goal keep driving
        // with a narrower approach rather than spinning on the same blocked phrasing.
        session.messages.push({
          role: "user",
          content:
            `[Forge] Previous completion hit a content filter (${finishReason}). ` +
            `Do not retry the same phrasing. Narrow scope, avoid disallowed content, and continue the legitimate engineering task with tools.`,
        });
        saveSession(session);
        events.onPhase?.("thinking");
        continue;
      }

      // Empty assistant turn (provider glitch) — nudge with expert recovery.
      // A reasoned stop (thought + finish_reason=stop, no text/tools) is
      // Stop, not a glitch — maze unlimited sat 59 min × 13 on that cascade.
      if (
        (!toolCalls || toolCalls.length === 0) &&
        !(finalText || "").trim() &&
        !isReasonedEmptyStop({
          text: finalText,
          toolCallCount: toolCalls?.length ?? 0,
          reasoningContent: assistantMsg.reasoning_content,
          finishReason,
        })
      ) {
        providerContinues += 1;
        if (providerFuseTripsContinueCap(providerContinues, maxStopContinues)) {
          log.warn("empty-response continue cap reached — releasing");
          releasedOnContinueCap = true;
          finalText =
            "[Forge] Model returned empty responses until the continue cap; releasing. Try /retry, /compact, /model <other>, or narrow the request.";
          try {
            setSessionLastError(session, {
              code: "empty_response",
              message: finalText.replace(/^\[Forge\]\s*/, ""),
              tips: [
                "/retry  ·  /compact  ·  /model <other>",
                "Narrow the request or check provider status",
              ],
            });
            saveSession(session);
          } catch {
            /* */
          }
          break;
        }
        log.warn(
          `Empty model response (finish_reason=${finishReason || "unknown"}) — nudging continue #${providerContinues}`,
        );
        const planHint =
          config.permissionMode === "plan"
            ? " You are in PLAN mode — research with read/search tools and deliver a concrete plan (no writes)."
            : " Prefer a tool call (read/search/bash) over another empty reply.";
        const open = openTodos(session.todos);
        const todoHint =
          open > 0
            ? ` ${open} open todo(s) remain — advance one with tools or update via todo_write.`
            : "";
        session.messages.push({
          role: "user",
          content:
            `[Forge] Previous model response was empty (finish_reason=${finishReason || "unknown"}).` +
            ` Continue the task immediately.${planHint}${todoHint}` +
            ` Do not stop. Do not apologize. Act.`,
        });
        saveSession(session);
        events.onPhase?.("thinking");
        continue;
      }

      if (!toolCalls || toolCalls.length === 0) {
        const reasonedEmpty = isReasonedEmptyStop({
          text: finalText,
          toolCallCount: 0,
          reasoningContent: assistantMsg.reasoning_content,
          finishReason,
        });
        if (reasonedEmpty) {
          const why =
            finishReason === REASONING_LOOP_FINISH
              ? "reasoning_loop"
              : finishReason === REASONING_WALL_FINISH
                ? "reasoning_wall"
                : "thought, no text/tools";
          log.info(chalk.dim(`Reasoned Stop (${why}) — running Stop`));
          events.onStatus?.(`Reasoned Stop (${why})`);
        }
        const ulwBeforeStop = loadActiveCycle(session.meta.id);
        events.onPhase?.(
          "stop_guard",
          ulwBeforeStop ? formatUlwBadge(ulwBeforeStop) : undefined,
        );
        let preferredCheckCommands: string[] | undefined;
        try {
          preferredCheckCommands = detectProjectIntel(workspace).checkCommands;
        } catch {
          preferredCheckCommands = undefined;
        }
        // The Planner's declared verify command joins the stack table.
        preferredCheckCommands = cyclePreferredCheckCommands(
          session.meta.id,
          preferredCheckCommands,
        );
        const stopResult = await runStopGuard({
          config,
          hooks,
          ctx: baseHookCtx(session, config),
          ultrawork: session.meta.ultrawork,
          cycleRuntime,
          openTodoCount: openTodos(session.todos),
          editCount: session.meta.editCount,
          lastUserMessage: (() => {
            const u = [...session.messages].reverse().find((m) => m.role === "user");
            return typeof u?.content === "string" ? u.content : undefined;
          })(),
          lastAssistantMessage: finalText,
          verificationRan: harnessStats.verificationRuns > 0,
          verificationPassed: harnessStats.verificationPassedRuns > 0,
          verificationHelperOnly: harnessStats.verificationHelperOnlyRuns > 0,
          verificationFullSuite: harnessStats.verificationFullSuiteRuns > 0,
          handoffBlocks,
          proofClaimBlocks,
          stopContinues,
          reportBlocks,
          runFactsProvider: () =>
            buildRunReport({
              session,
              workspace,
              result: { stopContinues, finalText },
            }).facts,
          preferredCheckCommands,
          lastVerificationCommand:
            session.meta.lastVerificationOk === false
              ? undefined
              : session.meta.lastVerificationCommand,
          lastVerificationStale: isLastVerificationStale(session.meta),
        });
        // Report-guard bounces (homework hand-back / last-round-only closer).
        if (stopResult.report?.block) {
          reportBlocks += 1;
          harnessStats.effortBoostTurns = Math.max(
            harnessStats.effortBoostTurns,
            1,
          );
        }
        // The cycle driver consumed this Stop's verification signals when it
        // stamped a wave or closed the cycle; hook / goal blocks return early
        // without consuming them.
        if (stopResult.ulw?.waveStamped || stopResult.ulw?.cycleClosed) {
          harnessStats.verificationRuns = 0;
          harnessStats.verificationPassedRuns = 0;
          harnessStats.verificationHelperOnlyRuns = 0;
          harnessStats.verificationFullSuiteRuns = 0;
        }
        // A red verify after review or a fresh plan is a hard round.
        if (stopResult.ulw?.phase === "fix" || stopResult.ulw?.planAdmitted) {
          harnessStats.effortBoostTurns = Math.max(
            harnessStats.effortBoostTurns,
            1,
          );
        }
        if (stopResult.ulw?.committed?.sha) {
          autoCommit = {
            committed: true,
            sha: stopResult.ulw.committed.sha,
            subject: stopResult.ulw.committed.subject,
          };
        }
        // Track polite-yield streak for handoff-guard release cap.
        // Polite yields are a hard-round signal — bump adaptive effort so the
        // next continue thinks harder instead of re-asking the user.
        if (stopResult.handoff?.block) {
          handoffBlocks += 1;
          harnessStats.effortBoostTurns = Math.max(
            harnessStats.effortBoostTurns,
            1,
          );
        } else if (stopResult.allowStop || stopResult.handoff?.released) {
          handoffBlocks = 0;
        }
        // Proof-claim streak: "tests pass" without running them.
        if (stopResult.proofClaim?.block) {
          proofClaimBlocks += 1;
          harnessStats.effortBoostTurns = Math.max(
            harnessStats.effortBoostTurns,
            1,
          );
        } else if (stopResult.allowStop || stopResult.proofClaim?.released) {
          proofClaimBlocks = 0;
        }
        // Open todos left unfinished — think harder on the continue (finish or cancel).
        if (stopResult.todoGate) {
          harnessStats.effortBoostTurns = Math.max(
            harnessStats.effortBoostTurns,
            1,
          );
        }

        if (stopResult.allowStop) {
          if (stopResult.systemMessage) log.dim(stopResult.systemMessage);
          finalizeGuidelineAuditForRun();
          if (
            !cycleActive(loadCycleState(session.meta.id)) &&
            session.meta.ultrawork
          ) {
            session.meta.ultrawork = false;
            saveSession(session);
          }
          if (stopResult.goal?.stuckReleased) stuckReleased = true;
          if (stopResult.ulw?.released) {
            lastCycleReleased = true;
            ulwEndReason = stopResult.ulw.endReason;
            if (stopResult.ulw.reason) {
              finalText = finalText.trim()
                ? `${finalText.replace(/\s+$/, "")}\n\n${stopResult.ulw.reason}`
                : stopResult.ulw.reason;
            }
          }
          // Stamp lastError when a polite-yield / proof-claim / stuck-wall
          // released so resume orientation surfaces why the agent stopped.
          try {
            if (stopResult.handoff?.released) {
              setSessionLastError(session, {
                code: "handoff_released",
                message: (
                  stopResult.handoff.reason ||
                  "Handoff-guard released after repeated polite-yield Stop attempts"
                ).slice(0, 500),
                tips: [
                  "Continue the mandate manually if work remains",
                  "/retry  ·  /goal status  ·  /cycle status",
                ],
              });
              saveSession(session);
            } else if (stopResult.proofClaim?.released) {
              setSessionLastError(session, {
                code: "proof_claim_released",
                message: (
                  stopResult.proofClaim.reason ||
                  "Proof-claim guard released after claim-without-run Stop attempts"
                ).slice(0, 500),
                tips: proofClaimReleaseTips(preferredCheckCommands),
              });
              saveSession(session);
            } else if (stopResult.goal?.stuckReleased) {
              setSessionLastError(session, {
                code: "goal_stuck_wall",
                message: (
                  stopResult.goal.reason ||
                  "Goal stuck-wall released after consecutive Stop attempts with no progress"
                ).slice(0, 500),
                tips: [
                  "/goal set  ·  /ulw  to resume",
                  "/goal status  ·  /retry",
                ],
              });
              saveSession(session);
            } else if (stopResult.ulw?.released) {
              const clean =
                stopResult.ulw.endReason === "fulfilled" ||
                stopResult.ulw.endReason === "cycle-zero" ||
                stopResult.ulw.endReason === "max-cycles";
              setSessionLastError(session, {
                code: clean ? "ulw_done" : "ulw_released",
                message: (
                  stopResult.ulw.reason ||
                  `ULW released (${stopResult.ulw.endReason ?? "unknown"})`
                ).slice(0, 500),
                tips: clean
                  ? ["/report  ·  /ulw [mandate] to run another"]
                  : ["/ulw [mandate]  to re-arm", "/cycle status  ·  /report"],
              });
              saveSession(session);
            }
          } catch {
            /* */
          }
          break;
        }

        if (reasonedEmpty) {
          thoughtOnlyStops += 1;
          if (thoughtOnlyStops >= 3) {
            harnessStats.effortBoostTurns = Math.max(
              harnessStats.effortBoostTurns,
              1,
            );
          }
          const thoughtMax = thoughtOnlyStopMax();
          if (thoughtMax > 0 && thoughtOnlyStops > thoughtMax) {
            log.warn(
              `Thought-only Stop cap (${thoughtMax}) — ending this turn; ULW stays CONTINUE`,
            );
            events.onStatus?.(`Thought-only cap (${thoughtMax})`);
            const why =
              finishReason === REASONING_LOOP_FINISH
                ? "reasoning_loop"
                : finishReason === REASONING_WALL_FINISH
                  ? "reasoning_wall"
                  : "thought-only";
            finalText =
              `[Forge] Model sat in thought ${thoughtOnlyStops} times with no text/tools (${why}). ` +
              `Ending this turn so you can steer — ULW stays armed. ` +
              `/retry or a follow-up keeps the cycle. Raise FORGE_THOUGHT_ONLY_MAX or FORGE_PROVIDER_REASONING_WALL_MS to wait longer.`;
            try {
              setSessionLastError(session, {
                code: "thought_only_cap",
                message: finalText.replace(/^\[Forge\]\s*/, "").slice(0, 500),
                tips: [
                  "/retry  ·  type a follow-up — ULW stays armed",
                  "FORGE_THOUGHT_ONLY_MAX  ·  FORGE_PROVIDER_REASONING_WALL_MS",
                ],
              });
              saveSession(session);
            } catch {
              /* */
            }
            break;
          }
        } else {
          thoughtOnlyStops = 0;
        }

        stopContinues += 1;
        const ulwForCap = loadCycleState(session.meta.id);
        // Thought-only / reasoning_wall is a keep-driving poke, not an
        // infinite-Stop fuse. Counting it toward FORGE_ULW_MAX_CONTINUES
        // ended a 16h dogfood the user did not ask to stop.
        if (
          !reasonedEmpty &&
          stopBlockTripsContinueCap(ulwForCap) &&
          stopContinues > maxStopContinues
        ) {
          log.warn(
            `Stop-continue cap (${maxStopContinues}) reached — releasing to prevent infinite loop`,
          );
          releasedOnContinueCap = true;
          // Avoid blank headless finalText when the last assistant turn was
          // tools-only or empty and the harness kept blocking until the cap.
          if (!(finalText || "").trim()) {
            finalText =
              `[Forge] Stop-continue cap (${maxStopContinues}) reached — releasing to prevent infinite loop. ` +
              `Use /cycle 0, /max-cycles N, /done, or /ulw-off if the harness is still blocking progress.`;
          }
          try {
            setSessionLastError(session, {
              code: "continue_cap_stop",
              message: (
                finalText ||
                `Stop-continue cap (${maxStopContinues}) reached`
              )
                .replace(/^\[Forge\]\s*/, "")
                .slice(0, 500),
              tips: [
                "/cycle 0  ·  /max-cycles N  ·  /done  ·  /ulw-off",
                "/retry  ·  narrow the mandate",
              ],
            });
            saveSession(session);
          } catch {
            /* */
          }
          break;
        }

        let inject =
          stopResult.additionalContext ||
          stopResult.reason ||
          "Stop was blocked. Continue working.";
        if (!/^\s*\[Forge\b/.test(inject)) {
          // A user Stop hook's reason carries no Forge tag; mark it so the
          // guardBlocks meter files it under `hook`, not the ULW driver.
          const viaHook = Boolean(stopResult.hook?.blocked);
          inject = `[Forge ULW cycle driver]${viaHook ? " [Stop hook]" : ""} ${inject}`;
        }
        if (reasonedEmpty) {
          forceToolNext = true;
          inject = [
            formatThoughtOnlyRecoverPoke(thoughtOnlyStops, { forceLook: false }),
            inject,
          ]
            .filter((s) => (s || "").trim())
            .join("\n");
        }
        const ulwAfter = loadActiveCycle(session.meta.id);
        if (ulwAfter && stopResult.ulw) {
          log.info(
            chalk.magenta(
              `↻ ULW ${formatUlwCounts(ulwAfter)} — ${stopResult.ulw.reason} (continue #${stopContinues})`,
            ),
          );
        } else if (stopResult.todoGate) {
          log.info(
            chalk.magenta(
              `↻ TodoGate blocked Stop (continue #${stopContinues})`,
            ),
          );
        } else if (stopResult.handoff?.block) {
          log.info(
            chalk.magenta(
              `↻ Handoff-guard blocked premature yield (continue #${stopContinues}` +
                (handoffBlocks > 0 ? `, handoff #${handoffBlocks}` : "") +
                `)`,
            ),
          );
        } else if (stopResult.proofClaim?.block) {
          log.info(
            chalk.magenta(
              `↻ Proof-claim blocked unverified success claim (continue #${stopContinues}` +
                (proofClaimBlocks > 0 ? `, claim #${proofClaimBlocks}` : "") +
                `)`,
            ),
          );
        } else {
          log.info(
            chalk.magenta(
              `↻ Stop blocked by harness (continue #${stopContinues})`,
            ),
          );
        }
        {
          // Leading newline so the poke is not glued onto the last
          // assistant token (log10: "pin-rot).Wave 160 is consolidation").
          const first = (inject.split("\n")[0] || "").trim();
          if (first) log.dim(`\n${first}`);
        }
        session.messages.push({ role: "user", content: inject });
        // Re-anchor already has mandate/counts. Snapshot memory *after*
        // the wave observation so the next boundary does not admit again
        // just because decisions.json grew a ship log.
        markCurrentHarnessAdmitted(session, config);
        saveSession(session);
        events.onPhase?.("thinking");
        continue;
      }

      const lastTurnReportOnly =
        Boolean(opts.documentOnly) ||
        (subagentDepth > 0 &&
          Number.isFinite(maxTurns) &&
          turns === maxTurns);
      const citeReportOnly =
        Boolean(citeSeen) &&
        session.messages.some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.startsWith(CITE_DELTA_PICK_POKE),
        ) &&
        !assistantHasExplorePick(session.messages);
      await runToolCalls({
        toolCalls,
        session,
        config,
        hooks,
        permissions,
        workspace,
        signal,
        events,
        turn: turns,
        doomLoop,
        errorStreak,
        harnessStats,
        fileReads,
        mcp,
        lsp,
        subagentDepth,
        maxSubagentDepth,
        provider,
        proofPoke,
        reportOnly: lastTurnReportOnly || citeReportOnly,
        reportOnlyKind: citeReportOnly
          ? "cite-delta"
          : lastTurnReportOnly
            ? "last-turn"
            : undefined,
        canEdit: canEditFiles,
      });
      // Tools that cooperatively return "Aborted" still leave signal.aborted set —
      // exit the loop immediately rather than starting another provider turn.
      assertNotAborted(signal);

      // Mid-loop auto-verify nudge: after an edit streak without a fresh green
      // check, inject a synthetic user message so the model runs the project
      // check without waiting for the user to steer. Max 2 per user prompt.
      if (verifyNudges < 2 && config.permissionMode !== "plan" && canEditFiles) {
        try {
          const lastUser = [...session.messages]
            .reverse()
            .find((m) => m.role === "user");
          const lastContent =
            typeof lastUser?.content === "string" ? lastUser.content : "";
          if (
            shouldEmitVerifyNudge(proofPoke, {
              lastUserContent: lastContent,
              editCount: session.meta.editCount || 0,
            })
          ) {
            const { midLoopVerifyNudge } = await import(
              "../util/project-intel.js"
            );
            const nudge = midLoopVerifyNudge(session.meta, workspace);
            if (nudge) {
              session.messages.push({ role: "user", content: nudge });
              verifyNudges += 1;
              noteVerifyNudge(proofPoke);
              saveSession(session);
              log.dim("verify-nudge: edits without fresh green check");
            }
          }
        } catch {
          /* */
        }
      }

      events.onPhase?.("thinking");
    }
  } catch (err) {
    if ((err as Error).message === "Aborted" || signal?.aborted) {
      aborted = true;
      // Fill any tool_calls left without results so the next turn doesn't 400
      const healed = repairToolCallPairing(session.messages);
      if (healed.changed) {
        session.messages = healed.messages;
        saveSession(session);
      }
    } else {
      try {
        const { formatProviderError } = await import("../providers/errors.js");
        const fmt = formatProviderError(err, {
          provider: String(config.provider),
          model: config.model,
        });
        setSessionLastError(session, {
          code: fmt.code,
          message: fmt.message,
          tips: fmt.tips,
        });
        saveSession(session);
      } catch {
        try {
          setSessionLastError(session, {
            code: "error",
            message: (err as Error).message || String(err),
          });
          saveSession(session);
        } catch {
          /* */
        }
      }
      // True fatals leave the TUI alive; skip blips the outer loop will auto-continue.
      if (!isContinueRecoverableProviderError(err)) {
        try {
          reapSessionBrowsers(session.meta.id, {
            workspace,
            chromeLooks: false,
          });
        } catch {
          /* fail-open */
        }
      }
      throw err;
    }
  }

  // Silent maxTurns exit is a production footgun for headless CI — surface it.
  if (!aborted && hitMaxTurns) {
    log.warn(`maxTurns (${maxTurns}) reached — releasing`);
    let ulwNote = "";
    try {
      if (requestCycleZeroOnSafetyValve(session.meta.id)) {
        ulwNote =
          ` ULW set to finish the open cycle (/cycle 0) so a resume reviews and commits instead of re-blocking after the turn cap. ` +
          `Raise max_turns and /cycle 1 to keep cycling, or /done · /ulw-off to wind down.`;
        log.info(chalk.magenta("ULW → /cycle 0 after maxTurns"));
      }
    } catch {
      /* */
    }
    const note =
      `[Forge] maxTurns (${maxTurns}) reached — releasing. ` +
      `Raise max_turns in config, narrow the task, or continue with forge run --continue.` +
      ulwNote;
    if ((finalText || "").trim()) {
      if (!finalText.includes("[Forge] maxTurns")) {
        finalText = `${finalText.replace(/\s+$/, "")}\n\n${note}`;
      }
    } else {
      finalText = note;
    }
    try {
      setSessionLastError(session, {
        code: "max_turns",
        message: note.replace(/^\[Forge\]\s*/, "").slice(0, 500),
        tips: [
          "Raise max_turns / FORGE_MAX_TURNS or max_turns=0 unlimited",
          "forge run --continue  ·  /retry  ·  narrow the task",
          "ULW was set to finish the open cycle — /cycle 1 to keep cycling",
        ],
      });
      saveSession(session);
    } catch {
      /* */
    }
  }

  // Cost-cap release — unattended ULW spend valve (estimate, not a bill).
  if (!aborted && hitCostCap) {
    const st = capNow();
    const capStr =
      st.cap != null ? `$${st.cap.toFixed(st.cap < 0.01 ? 4 : 3)}` : "?";
    const spentStr = `$${st.spent.toFixed(st.spent < 0.01 ? 4 : 3)}`;
    log.warn(`maxCostUsd (${capStr}) reached — releasing (spent ~${spentStr})`);
    // Under ULW cycle=1 the next continue would re-block forever after a spend
    // release — set /cycle 0 so resume/continue finishes the open cycle.
    let ulwNote = "";
    try {
      if (requestCycleZeroOnSafetyValve(session.meta.id)) {
        ulwNote =
          ` ULW set to finish the open cycle (/cycle 0) so a resume reviews and commits instead of re-blocking after the spend release. ` +
          `Raise the budget and /cycle 1 to keep cycling, or /done · /ulw-off to wind down.`;
        log.info(chalk.magenta("ULW → /cycle 0 after cost cap"));
      }
    } catch {
      /* */
    }
    const note =
      `[Forge] maxCostUsd (${capStr}) reached — releasing (session est. ~${spentStr}). ` +
      `Raise max_cost_usd / FORGE_MAX_COST_USD / --max-cost, or /budget off · /budget <usd>. ` +
      `Estimate only — not a bill.` +
      ulwNote;
    if ((finalText || "").trim()) {
      if (!finalText.includes("[Forge] maxCostUsd")) {
        finalText = `${finalText.replace(/\s+$/, "")}\n\n${note}`;
      }
    } else {
      finalText = note;
    }
    try {
      setSessionLastError(session, {
        code: "max_cost",
        message: note.replace(/^\[Forge\]\s*/, "").slice(0, 500),
        tips: [
          "Raise max_cost_usd / FORGE_MAX_COST_USD / --max-cost N",
          "/budget off  ·  /budget 10  ·  forge run --max-cost 5",
          "ULW was set to finish the open cycle — /cycle 1 to keep cycling",
          "Estimate only (estimateCostUsd) — not provider billing",
        ],
      });
      saveSession(session);
    } catch {
      /* */
    }
  }

  // Continue-cap release (length / content_filter / empty / Stop-block) under
  // ULW — same stuck risk as maxTurns/costCap. Skip when those already set it.
  if (
    !aborted &&
    releasedOnContinueCap &&
    !hitMaxTurns &&
    !hitCostCap
  ) {
    try {
      if (requestCycleZeroOnSafetyValve(session.meta.id)) {
        const note =
          `[Forge] ULW set to finish the open cycle (/cycle 0) after the stop-continue safety valve. ` +
          `Raise FORGE_ULW_MAX_CONTINUES / maxStopContinues or /cycle 1 to keep cycling · /done · /ulw-off.`;
        log.info(chalk.magenta("ULW → /cycle 0 after continue-cap"));
        if ((finalText || "").trim()) {
          if (!finalText.includes("ULW set to finish the open cycle")) {
            finalText = `${finalText.replace(/\s+$/, "")}\n\n${note}`;
          }
        } else {
          finalText = note;
        }
        // Preserve existing continue_cap_* lastError code; append tip if present.
        try {
          const prev = session.meta.lastError;
          if (prev?.code?.startsWith("continue_cap")) {
            const tips = [
              ...(prev.tips || []),
              "ULW was set to finish the open cycle — /cycle 1 to keep cycling",
            ];
            setSessionLastError(session, {
              code: prev.code,
              message: prev.message,
              tips: [...new Set(tips)].slice(0, 6),
            });
          }
          saveSession(session);
        } catch {
          /* */
        }
      }
    } catch {
      /* */
    }
  }

  const promptTokens = session.meta.totalPromptTokens - startPrompt;
  const completionTokens = session.meta.totalCompletionTokens - startComp;
  const cacheReadTokens =
    (session.meta.totalCacheReadTokens ?? 0) - startCache;
  // Token/cost already live on the dock + turn footer — no transcript dump.

  // Successful completion clears prior failure — but continue-cap / content-filter /
  // maxTurns / cost-cap / handoff-release / proof-claim-release stamp lastError
  // for expert recovery and must keep it.
  const lastErrCode = session.meta.lastError?.code || "";
  const keepLastError =
    releasedOnContinueCap ||
    hitMaxTurns ||
    hitCostCap ||
    lastErrCode === "handoff_released" ||
    lastErrCode === "proof_claim_released" ||
    lastErrCode === "ulw_released" ||
    lastErrCode === "ulw_done" ||
    lastErrCode === "goal_stuck_wall" ||
    lastErrCode === "max_cost" ||
    lastErrCode === "max_turns" ||
    lastErrCode === "doom_loop" ||
    lastErrCode === "error_streak" ||
    lastErrCode.startsWith("continue_cap") ||
    lastErrCode === "thought_only_cap";
  if (!aborted && !keepLastError) {
    try {
      clearSessionLastError(session);
      saveSession(session);
    } catch {
      /* */
    }
  }

  const pokeMeters = countHarnessPokesSince(session, pokeBaseline);
  const guardBlocks = Object.keys(pokeMeters.guardBlocks).length
    ? pokeMeters.guardBlocks
    : undefined;
  try {
    session.meta.harnessUserPokes = pokeMeters.harnessUserPokes;
    session.meta.admitCount = pokeMeters.admitCount;
    session.meta.proofPokes = pokeMeters.proofPokes;
    if (guardBlocks) session.meta.guardBlocks = guardBlocks;
    else delete session.meta.guardBlocks;
    session.meta.providerRounds = turns;
    saveSession(session);
  } catch {
    /* meters are best-effort */
  }

  defaultStarts?.flush();
  offBgSettled();
  finalizeGuidelineAuditForRun();

  return {
    finalText,
    turns,
    stopContinues,
    aborted,
    releasedOnContinueCap,
    hitMaxTurns,
    hitCostCap,
    stuckReleased,
    lastCycleReleased,
    ...(ulwEndReason ? { ulwEndReason } : {}),
    verification: {
      ran: harnessStats.totalRuns > 0,
      passed: harnessStats.totalPassed > 0,
      fullSuite: harnessStats.totalFullSuite > 0,
      ...(harnessStats.lastCommand ? { lastCommand: harnessStats.lastCommand } : {}),
    },
    finishReason: lastFinishReason,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    ...(runServedModels.size
      ? { servedModels: [...runServedModels] }
      : {}),
    ...(autoCommit ? { autoCommit } : {}),
    harnessUserPokes: pokeMeters.harnessUserPokes,
    admitCount: pokeMeters.admitCount,
    proofPokes: pokeMeters.proofPokes,
    ...(guardBlocks ? { guardBlocks } : {}),
    providerRounds: turns,
    ...(guidelineResult ? { guidelines: guidelineResult } : {}),
  };
}

/**
 * REPL / headless entry: if ULW is armed and the loop still throws a
 * continue-recoverable drop (the screenshot: `✖ terminated` / provider_error),
 * resume the same transcript without waiting for a typed "continue".
 *
 * Kill-switch: `FORGE_ULW_AUTO_CONTINUE=0`.
 */
export async function runAgentLoopThroughDrops(
  opts: LoopOptions,
): Promise<LoopResult> {
  const off =
    process.env.FORGE_ULW_AUTO_CONTINUE === "0" ||
    process.env.FORGE_ULW_AUTO_CONTINUE === "false";
  const max = envPositiveInt("FORGE_ULW_AUTO_CONTINUE_MAX", 3);
  let resume = Boolean(opts.resumeWithoutUserMessage);
  let n = 0;
  let priorRounds = 0;
  for (;;) {
    try {
      return await runAgentLoop({
        ...opts,
        resumeWithoutUserMessage: resume,
      });
    } catch (err) {
      priorRounds += Number(opts.session.meta.providerRounds) || 0;
      if (priorRounds > 0) opts.session.meta.providerRounds = priorRounds;
      if (off || opts.signal?.aborted) throw err;
      if (!isContinueRecoverableProviderError(err)) throw err;
      let ulwEnabled = Boolean(opts.session.meta.ultrawork);
      try {
        if (cycleActive(loadCycleState(opts.session.meta.id))) ulwEnabled = true;
      } catch {
        /* sidecar optional */
      }
      if (!ulwEnabled || n >= max) throw err;
      n += 1;
      resume = true;
      log.warn(
        `Provider drop during unattended ULW — auto-continuing (${n}/${max}) without a typed continue`,
      );
      opts.events?.onStatus?.(
        `Provider drop — auto-continuing ULW (${n}/${max})`,
      );
      opts.events?.onPhase?.("waiting", `ulw auto-continue ${n}/${max}`);
      if (!isReconnectWithoutAuthDrop(err)) {
        try {
          const r = await refreshCredentialIfNeeded(
            String(opts.config.provider),
            { force: true, skewSec: 600 },
          );
          if (r.ok && r.credential?.accessToken && opts.provider.updateCredentials) {
            opts.provider.updateCredentials(r.credential.accessToken);
          }
        } catch {
          /* next loop still does proactive refresh */
        }
      }
      const delay = Math.min(8_000, 400 * 2 ** (n - 1));
      await new Promise<void>((resolve, reject) => {
        if (opts.signal?.aborted) {
          reject(new Error("Aborted"));
          return;
        }
        const t = setTimeout(resolve, delay);
        const onAbort = () => {
          clearTimeout(t);
          reject(new Error("Aborted"));
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        t.unref?.();
      });
    }
  }
}

/** Dispose process-scoped MCP/LSP on exit (once). */
let mcpLspExitHookInstalled = false;
let exitCleanupWorkspace: string | undefined;
let exitCleanupSessionId: string | undefined;
export function installMcpLspExitHook(): void {
  if (mcpLspExitHookInstalled) return;
  mcpLspExitHookInstalled = true;
  const cleanup = () => {
    const m = getActiveMcpManager();
    const l = getActiveLspManager();
    setActiveMcpManager(null);
    setActiveLspManager(null);
    // Sync best-effort: process is exiting; fire-and-forget dispose.
    void m?.dispose().catch(() => {});
    void l?.dispose().catch(() => {});
    try {
      cleanupAgentBrowserScratch({
        workspace: exitCleanupWorkspace,
        sessionId: exitCleanupSessionId,
      });
    } catch {
      /* */
    }
  };
  process.once("exit", cleanup);
  process.once("beforeExit", cleanup);
}

/**
 * Real user messages (not harness admits / re-anchors / interjection frames
 * unwrapped) since an ISO timestamp — what the Planner reads as steering.
 * The transcript carries no per-message timestamps, so "since" is
 * approximated by the user-turn marks recorded after that time.
 */
function userMessagesSince(session: SessionData, _sinceIso: string): string[] {
  // No per-message timestamps: the last plan admission is the marker.
  let fromIdx = 0;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (
      m.role === "user" &&
      typeof m.content === "string" &&
      /^\[Forge ULW cycle driver\] (?:Cycle \d+ plan|armed)/.test(m.content)
    ) {
      fromIdx = i + 1;
      break;
    }
  }
  const out: string[] = [];
  for (const m of session.messages.slice(fromIdx)) {
    if (m.role !== "user" || typeof m.content !== "string") continue;
    const t = m.content.trim();
    if (!t || t.startsWith("[Forge")) continue;
    const ij = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
    out.push((ij ? ij[1] : t).trim());
  }
  return out.filter(Boolean).slice(-8);
}

function countHarnessPokesSince(
  session: SessionData,
  baseline: number,
): ReturnType<typeof countHarnessUserPokes> {
  const from = Math.max(0, Math.min(baseline, session.messages.length));
  return countHarnessUserPokes(session.messages.slice(from));
}

/** Re-export for callers/tests that already import loop helpers. */
export { resolveMaxCostUsd, costCapStatus, formatCostBudgetLine };

function currentHarnessSnapshot(
  session: SessionData,
  config: ForgeConfig,
  git?: GitSnapshot | null,
): import("../harness/context-admit.js").HarnessSnapshot {
  return snapshotHarness({
    ulw: loadCycleState(session.meta.id),
    goal: loadGoal(session.meta.id),
    todos: session.todos,
    permissionMode: config.permissionMode,
    git:
      git !== undefined
        ? git
        : getGitSnapshot(config.workspace || session.meta.cwd || process.cwd()),
    sessionId: session.meta.id,
  });
}

function markCurrentHarnessAdmitted(
  session: SessionData,
  config: ForgeConfig,
  git?: GitSnapshot | null,
): void {
  markHarnessAdmitted(session.meta.id, currentHarnessSnapshot(session, config, git));
}

/** Admit harness snapshot if changed; push as user message. */
function admitHarnessState(
  session: SessionData,
  config: ForgeConfig,
  opts?: {
    suppressCounterOnly?: boolean;
    git?: GitSnapshot | null;
    emit?: boolean;
  },
): void {
  const git =
    opts && "git" in opts
      ? opts.git
      : getGitSnapshot(config.workspace || session.meta.cwd || process.cwd());
  const snap = currentHarnessSnapshot(session, config, git);
  const msg = admitHarnessIfChanged(session.meta.id, snap, {
    suppressCounterOnlyChanges: opts?.suppressCounterOnly,
    emit: opts?.emit,
  });
  if (msg) {
    session.messages.push({ role: "user", content: msg });
  }
}

/**
 * Agent-guidelines audit brief — once per session, as the first harness
 * message after the prompt. Deferred while mutations are denied (plan mode /
 * ULW orient), and on a pure question, and re-tried at every safe boundary.
 * Subagents never audit.
 *
 * `lastRealUserPrompt` and not the last user-role row: by the time a safe
 * boundary comes round the last user-role message is a harness admit, and
 * the advisory carve-out has to read what the *user* typed.
 */
function maybeAdmitGuidelineAudit(
  session: SessionData,
  config: ForgeConfig,
): void {
  try {
    const readOnly = config.permissionMode === "plan";
    const brief = maybeGuidelineAuditBrief({
      sessionId: session.meta.id,
      workspace: config.workspace || session.meta.cwd || process.cwd(),
      subagent: Boolean(session.meta.subagent),
      readOnly,
      lastUserMessage: lastRealUserPrompt(session)?.text,
      autoApply: Boolean(config.guidelineAutoApply),
    });
    if (brief) session.messages.push({ role: "user", content: brief });
  } catch {
    /* audit is best-effort */
  }
}

/** Doom/error-streak warnings live in tool bodies that microcompaction deletes. */
function maybeAdmitSelfHealReminder(session: SessionData): void {
  const code = session.meta.lastError?.code;
  if (code !== "doom_loop" && code !== "error_streak") return;
  const tag =
    code === "doom_loop"
      ? "[Forge system-reminder — doom-loop]"
      : "[Forge system-reminder — error-streak]";
  const recent = session.messages.slice(-16);
  if (
    recent.some(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.startsWith(tag),
    )
  ) {
    return;
  }
  const detail = (session.meta.lastError?.message || code).slice(0, 400);
  session.messages.push({
    role: "user",
    content:
      `${tag}\n${detail}\n` +
      `Do not repeat the same tool+args. Change tool or write. ` +
      `If a result was cleared, read_file the Full output path — do not re-run the original tool.`,
  });
}

/**
 * Safe provider-turn boundary: live slash notices + free-text interjections
 * + harness admissions (OpenCode-style admit at boundary, not async push).
 */
function drainSafeBoundaryMessages(
  session: SessionData,
  config: ForgeConfig,
  events?: LoopEvents,
  fileReads?: FileReadState,
): void {
  const liveNotices = drainLiveNotices(session.meta.id);
  if (liveNotices.length) {
    session.messages.push({
      role: "user",
      content: formatLiveNoticesMessage(liveNotices),
    });
    events?.onStatus?.(
      `Applied mid-run control${liveNotices.length > 1 ? "s" : ""}`,
    );
  }
  // Deferred guideline brief (plan mode / ULW orient ended).
  maybeAdmitGuidelineAudit(session, config);

  const interjections = drainInterjections(session.meta.id);
  if (interjections.length) {
    // Attach active harness context so free-text steering does not drop the
    // mandate/goal/todos mid-wave (expert friction: "I said X and it forgot ULW").
    let ijCtx: import("../harness/interjection.js").InterjectionContext | undefined;
    let waveForMem: number | undefined;
    try {
      const ulwNow = loadActiveCycle(session.meta.id);
      const goalNow = loadGoal(session.meta.id);
      const open = openTodos(session.todos);
      waveForMem = ulwNow ? ulwNow.totalWaves : undefined;
      ijCtx = {};
      if (ulwNow) {
        ijCtx.ulwLine = `${formatUlwCounts(ulwNow)} — the Planner reads this at the next re-plan`;
      }
      if (
        goalNow?.objective &&
        goalNow.status === "active" &&
        !goalNow.paused
      ) {
        ijCtx.goalLine = goalNow.objective.slice(0, 120);
      }
      if (open > 0) ijCtx.openTodos = open;
      if (config.permissionMode && config.permissionMode !== "default") {
        ijCtx.permissionMode = config.permissionMode;
      }
      if (
        !ijCtx.ulwLine &&
        !ijCtx.goalLine &&
        !ijCtx.openTodos &&
        !ijCtx.permissionMode
      ) {
        ijCtx = undefined;
      }
    } catch {
      ijCtx = undefined;
    }
    // Phase 1: promote hard constraints from mid-run free-text into durable memory.
    try {
      for (const t of interjections) {
        maybeRecordUserConstraint(session.meta.id, t, waveForMem);
      }
    } catch {
      /* */
    }
    const ijText = formatInterjectionsMessage(interjections, ijCtx);
    session.messages.push({
      role: "user",
      content: expandUserMentions(
        ijText,
        config.workspace || session.meta.cwd,
        fileReads,
      ),
    });
    events?.onStatus?.(
      `Queued mid-run message${interjections.length > 1 ? "s" : ""} from user`,
    );
  }

  // Harness may have changed via live /cycle etc. Counter-only churn (wave,
  // blocks, todo counts) is already visible to the model via re-anchors and
  // its own todo_write calls — only real changes (cycle/mandate/goal/mode)
  // earn a fresh admission message.
  admitHarnessState(session, config, {
    suppressCounterOnly: true,
    emit: false,
  });
  saveSession(session);
}

async function runToolCalls(opts: {
  toolCalls: ToolCall[];
  session: SessionData;
  config: ForgeConfig;
  hooks: HookRunner;
  permissions: PermissionGate;
  workspace: string;
  signal?: AbortSignal;
  events?: LoopEvents;
  turn?: number;
  doomLoop?: DoomLoopTracker;
  errorStreak?: ErrorStreakTracker;
  harnessStats?: HarnessRunStats;
  fileReads?: FileReadState;
  mcp?: McpManager;
  lsp?: LspManager;
  subagentDepth?: number;
  maxSubagentDepth?: number;
  provider?: LLMProvider;
  proofPoke?: import("../harness/proof-poke.js").ProofPokeState;
  reportOnly?: boolean;
  reportOnlyKind?: "last-turn" | "cite-delta";
  canEdit?: boolean;
}): Promise<void> {
  const {
    toolCalls,
    session,
    config,
    hooks,
    permissions,
    workspace,
    signal,
    events,
    turn = 0,
    doomLoop,
    errorStreak,
    harnessStats,
    fileReads,
    mcp,
    lsp,
    subagentDepth = 0,
    maxSubagentDepth = defaultMaxSubagentDepth(),
    provider,
    proofPoke,
    reportOnly,
    reportOnlyKind,
    canEdit = true,
  } = opts;

  // Sequential by default; batch consecutive parallel-safe tools (read-only
  // plus spawn that cannot mutate the parent tree mid-flight). Results stay
  // in original tool-call order. exit_plan_mode runs first so same-turn
  // writes see the restored mode. Re-partition after each group so a live
  // mode/phase flip (exit_plan_mode, Wave-1 Reading) cannot leave omitted
  // isolation=none GP in an explore-sized Promise.all.
  const exitIdx = toolCalls.findIndex((tc) =>
    isExitPlanModeToolName(normalizeToolName(tc.function.name || "")),
  );
  if (exitIdx > 0) {
    const [exitCall] = toolCalls.splice(exitIdx, 1);
    toolCalls.unshift(exitCall);
  }
  const livePlanOrOrient = (): boolean => config.permissionMode === "plan";
  let rest = toolCalls;
  while (rest.length > 0) {
    assertNotAborted(signal);
    const planOrOrient = livePlanOrOrient();
    const parallelOpts: ParallelSafeOpts = {
      mcp,
      workspace,
      planOrOrient,
    };
    const batch = partitionParallelBatches(rest, parallelOpts)[0] ?? [];
    rest = rest.slice(batch.length);
    const basePrep = {
      session,
      config,
      hooks,
      permissions,
      workspace,
      signal,
      events,
      turn,
      doomLoop,
      errorStreak,
      harnessStats,
      fileReads,
      mcp,
      lsp,
      subagentDepth,
      maxSubagentDepth,
      provider,
      proofPoke,
      reportOnly,
      reportOnlyKind,
      planOrOrient,
      canEdit,
    };
    if (batch.length === 0) break;
    const parallel = batch.every((tc) =>
      isParallelSafeToolCall(tc, parallelOpts),
    );
    if (parallel) {
      let spawnSeq = 0;
      const spawnTickets = batch.map((tc) =>
        isSpawnToolName(tc.function.name) ? spawnSeq++ : undefined,
      );
      const landGate: OrderGate | undefined =
        spawnSeq > 0 ? createOrderGate(signal) : undefined;
      if (spawnSeq > 1) {
        log.dim(`subagent parallel batch: ${spawnSeq}`);
      }
      const results = await Promise.all(
        batch.map((tc, idx) =>
          prepareToolResult({
            ...basePrep,
            tc,
            landGate,
            landTicket: spawnTickets[idx],
          }).catch((err) => ({
            toolCallId: tc.id,
            content: `${normalizeToolName(tc.function.name)} error: ${(err as Error).message}`,
          })),
        ),
      );
      for (const r of results) {
        session.messages.push({
          role: "tool",
          tool_call_id: r.toolCallId,
          content: r.content,
        });
      }
      saveSession(session);
    } else {
      const r = await prepareToolResult({
        ...basePrep,
        tc: batch[0]!,
      });
      session.messages.push({
        role: "tool",
        tool_call_id: r.toolCallId,
        content: r.content,
      });
      saveSession(session);
    }
  }
}

type PrepareToolResultOpts = {
  tc: ToolCall;
  session: SessionData;
  config: ForgeConfig;
  hooks: HookRunner;
  permissions: PermissionGate;
  workspace: string;
  signal?: AbortSignal;
  events?: LoopEvents;
  turn?: number;
  doomLoop?: DoomLoopTracker;
  errorStreak?: ErrorStreakTracker;
  harnessStats?: HarnessRunStats;
  fileReads?: FileReadState;
  mcp?: McpManager;
  lsp?: LspManager;
  subagentDepth?: number;
  maxSubagentDepth?: number;
  provider?: LLMProvider;
  proofPoke?: import("../harness/proof-poke.js").ProofPokeState;
  reportOnly?: boolean;
  reportOnlyKind?: "last-turn" | "cite-delta";
  planOrOrient?: boolean;
  /** False for a read-only role (denyEdits): withhold fix-until-green. */
  canEdit?: boolean;
  landGate?: OrderGate;
  landTicket?: number;
};

async function prepareToolResult(
  opts: PrepareToolResultOpts,
): Promise<{ toolCallId: string; content: string }> {
  try {
    return await prepareToolResultInner(opts);
  } finally {
    if (opts.landGate != null && opts.landTicket != null) {
      await opts.landGate.finish(opts.landTicket);
    }
  }
}

async function prepareToolResultInner(
  opts: PrepareToolResultOpts,
): Promise<{ toolCallId: string; content: string }> {
  const {
    tc,
    session,
    config,
    hooks,
    permissions,
    workspace,
    signal,
    events,
    turn = 0,
    doomLoop,
    errorStreak,
    harnessStats,
    fileReads,
    mcp,
    lsp,
    subagentDepth = 0,
    maxSubagentDepth = defaultMaxSubagentDepth(),
    provider,
    proofPoke,
    reportOnly,
    reportOnlyKind,
    planOrOrient = false,
    canEdit = true,
    landGate,
    landTicket,
  } = opts;
  assertNotAborted(signal);

  const name = normalizeToolName(tc.function.name);
  // Keep the call object consistent for any downstream logging
  tc.function.name = name;
  if (!name) {
    // Match normal tool lifecycle so REPL pendingTools accounting stays balanced
    events?.onPhase?.("tool", "(unnamed)");
    events?.onToolSettled?.("(unnamed)");
    return {
      toolCallId: tc.id,
      content:
        "Tool call missing function name (stream glitch). Re-issue the tool call with a valid name.",
    };
  }
  const parsedArgs = parseToolArguments(tc.function.arguments);
  let toolInput: Record<string, unknown>;
  let argsRepairNote: string | undefined;
  if (parsedArgs.ok) {
    toolInput = parsedArgs.value;
    if (parsedArgs.repaired) {
      argsRepairNote = parsedArgs.note || "repaired truncated JSON";
      // Persist repaired args so retries / logs see valid JSON
      try {
        tc.function.arguments = JSON.stringify(toolInput);
      } catch {
        /* keep original */
      }
    }
  } else {
    toolInput = { raw: tc.function.arguments };
    argsRepairNote = parsedArgs.error;
  }

  const displayArgs = spawnDisplayArgs(name, toolInput, { planOrOrient });

  // Announce tool phase BEFORE permission prompts so the REPL can pause
  // the working spinner and not clobber interactive Allow? lines.
  const argSummary = summarizeToolArgs(displayArgs, 48);
  const shown = formatToolDisplayName(name);
  const toolDetail = argSummary ? `${shown} ${argSummary}` : shown;
  events?.onPhase?.("tool", toolDetail);

  if (reportOnly && isReportOnlyBlockedTool(name)) {
    const content = formatReportOnlySkip(
      name,
      reportOnlyKind === "cite-delta" ? "cite-delta" : "last-turn",
    );
    if (events?.onToolStart) {
      events.onToolStart(name, displayArgs);
    } else {
      console.error(formatToolStart(name, displayArgs));
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (events?.onToolEnd) {
      events.onToolEnd(name, {
        isError: false,
        ms: 0,
        bytes,
        output: content,
        args: displayArgs,
      });
    } else {
      console.error(
        formatDefaultToolEndTranscript(name, {
          isError: false,
          ms: 0,
          bytes,
          output: content,
          args: displayArgs,
        }),
      );
    }
    events?.onToolSettled?.(name);
    return { toolCallId: tc.id, content };
  }

  // Doom-loop: identical tool+args streak → warn (still execute once more)
  const doomHit = doomLoop?.observe(name, toolInput) ?? null;
  if (doomHit) {
    log.warn(doomHit.message.slice(0, 200));
    events?.onStatus?.(
      doomHit.kind === "doom"
        ? `doom-loop: ${name} ×${doomHit.count}`
        : `${doomHit.kind}: ${name} ×${doomHit.count}`,
    );
    if (doomHit.kind === "doom" || doomHit.kind === "poll") {
      if (harnessStats) {
        harnessStats.effortBoostTurns = Math.max(
          harnessStats.effortBoostTurns,
          2,
        );
      }
    }
  }

  const settle = () => {
    events?.onToolSettled?.(name);
  };
  const noteDoom = (content: string, isError?: boolean) => {
    doomLoop?.noteResult(name, toolInput, content, isError);
  };

  /** Permission/plan denials skip executeTool — still pair start/end so the REPL shows ✗. */
  const emitDeniedTool = (output: string) => {
    if (events?.onToolStart) {
      events.onToolStart(name, displayArgs);
    } else {
      console.error(formatToolStart(name, displayArgs));
    }
    const bytes = Buffer.byteLength(output, "utf8");
    if (events?.onToolEnd) {
      events.onToolEnd(name, { isError: true, ms: 0, bytes, output, args: displayArgs });
    } else {
      console.error(
        formatDefaultToolEndTranscript(name, {
          isError: true,
          ms: 0,
          bytes,
          output,
          args: displayArgs,
        }),
      );
    }
    settle();
  };

  // Hard safety — never skipped by YOLO / bypassPermissions
  const hard = hardSafetyCheck(name, toolInput, workspace);
  if (!hard.ok) {
    log.error(`HARD DENY [${hard.rule}]: ${hard.reason}`);
    await hooks.run("PermissionDenied", {
      ...baseHookCtx(session, config),
      toolName: name,
      toolInput,
    });
    const content = `HARD DENY [${hard.rule}]: ${hard.reason}`;
    emitDeniedTool(content);
    noteDoom(content, true);
    return {
      toolCallId: tc.id,
      content,
    };
  }

  const pre = await hooks.run("PreToolUse", {
    ...baseHookCtx(session, config),
    toolName: name,
    toolInput,
    toolUseId: tc.id,
  });

  if (pre.blocked || pre.decision === "deny") {
    await hooks.run("PermissionDenied", {
      ...baseHookCtx(session, config),
      toolName: name,
      toolInput,
    });
    const content = `Tool denied by hook: ${pre.reason || "denied"}`;
    emitDeniedTool(content);
    noteDoom(content, true);
    return {
      toolCallId: tc.id,
      content,
    };
  }

  const perm = await permissions.request({
    toolName: name,
    input: toolInput,
    mode: config.permissionMode,
    workspace,
    config,
    mcp,
  });
  if (perm.decision === "deny") {
    await hooks.run("PermissionDenied", {
      ...baseHookCtx(session, config),
      toolName: name,
      toolInput,
    });
    const content = `Tool denied by permission gate: ${perm.reason}${perm.rule ? ` [${perm.rule}]` : ""}`;
    emitDeniedTool(content);
    noteDoom(content, true);
    return {
      toolCallId: tc.id,
      content,
    };
  }

  if (events?.onToolStart) {
    events.onToolStart(name, displayArgs);
  } else {
    console.error(formatToolStart(name, displayArgs));
  }

  if (argsRepairNote && !parsedArgs.ok) {
    let content =
      `Invalid JSON arguments for ${name}: ${argsRepairNote}\nRaw (truncated): ${String(tc.function.arguments || "").slice(0, 400)}\nPlease rewrite the input as valid JSON.`;
    if (errorStreak) {
      const hit = errorStreak.observeError(name, summarizeToolError(content));
      if (hit) {
        log.warn(hit.message.split("\n")[0] || "error-streak");
        events?.onStatus?.(`error-streak: ${hit.count} consecutive tool errors`);
        if (harnessStats) {
          harnessStats.effortBoostTurns = Math.max(
            harnessStats.effortBoostTurns,
            2,
          );
        }
        content = `${content}\n\n${hit.message}`;
        try {
          setSessionLastError(session, {
            code: "error_streak",
            message: hit.message.split("\n")[0] || "error-streak",
            tips: [
              "Fix JSON args · re-read the tool schema",
              "/retry  ·  change approach",
            ],
          });
          saveSession(session);
        } catch {
          /* */
        }
      }
    }
    noteDoom(content, true);
    const bytes = Buffer.byteLength(content, "utf8");
    if (events?.onToolEnd) {
      events.onToolEnd(name, { isError: true, ms: 0, bytes, output: content, args: displayArgs });
    } else {
      console.error(
        formatDefaultToolEndTranscript(name, {
          isError: true,
          ms: 0,
          bytes,
          output: content,
          args: displayArgs,
        }),
      );
    }
    settle();
    return {
      toolCallId: tc.id,
      content,
    };
  }

  const t0 = Date.now();
  let result;
  try {
    // Pass already-parsed object when repair succeeded to avoid double-parse drift
    const rawForExec = parsedArgs.ok
      ? JSON.stringify(toolInput)
      : tc.function.arguments;
    result = await executeTool(
      name,
      rawForExec,
      {
        workspace,
        sessionId: session.meta.id,
        sandbox: config.sandbox,
        sandboxNetwork: config.sandboxNetwork,
        sandboxMissingBackend: config.sandboxMissingBackend,
        signal,
        fileReads,
        mcp,
        lsp,
        subagentDepth,
        session,
        config,
        landGate,
        landTicket,
        runSubagent:
          provider && subagentDepth < maxSubagentDepth
            ? (req: SubagentRequest) =>
                runSubagentTracked(req, {
                  config,
                  provider,
                  parentSession: session,
                  hooks,
                  permissions,
                  workspace,
                  signal,
                  events,
                  depth: subagentDepth,
                  maxDepth: maxSubagentDepth,
                  mcp,
                  lsp,
                  landGate,
                  landTicket,
                })
            : undefined,
        onProgress: (detail) => {
          const line = detail.replace(/\s+/g, " ").trim().slice(0, 40);
          if (!line) return;
          events?.onPhase?.("tool", `${shown} ${line}`);
        },
        onEdit: () => {
          session.meta.editCount += 1;
          session.meta.lastEditAt = new Date().toISOString();
        },
        recordMutation: (input) => {
          appendFileMutation(session.meta.id, {
            path: input.path,
            kind: input.kind,
            before: input.before,
            mode: input.mode,
            turn: session.meta.turnCount,
            skipped: input.skipped,
            reason: input.reason,
          });
        },
      },
      (todos, merge) => {
        const out = applyTodos(session, todos, merge);
        if (name === "todo_write" || name === "TodoWrite") {
          noteTodoWrite(session.meta.id, turn);
        }
        return out;
      },
    );
    if (
      !result.isError &&
      (name === "todo_write" || name === "TodoWrite")
    ) {
      noteTodoWrite(session.meta.id, turn);
    }
  } catch (err) {
    settle();
    throw err;
  }
  // Structural verification signal for the ULW cycle ledger: a check command
  // actually executed this wave (pass or fail — running it is the behavior
  // the quality bar rewards; prose claims are not trusted on their own).
  // Background starts observe no exit code (fire-and-forget) — excluded by
  // countsTowardVerification; run the check in the foreground for it to count.
  // Session last-verify trail records the last check (green or red) so Δ
  // never says "verify: none" after a failed npm test.
  if (harnessStats && name === "get_task_output") {
    // Joining a background check observes its exit code — that is proof,
    // whichever channel (this join or the settle listener) sees it first.
    let preferred: string[] | undefined;
    try {
      const { detectProjectIntel } = await import("../util/project-intel.js");
      preferred = detectProjectIntel(workspace).checkCommands;
    } catch {
      preferred = undefined;
    }
    preferred = cyclePreferredCheckCommands(session.meta.id, preferred);
    for (const id of bgTaskIdsFromToolCall(toolInput, result.output)) {
      const task = getTask(id);
      if (!task || task.status === "running") continue;
      if (!taskBelongsToWorkspace(task.cwd, workspace)) continue;
      creditBackgroundTaskVerification({
        task,
        harnessStats,
        meta: session.meta,
        proofPoke,
        preferred,
      });
    }
  }
  if (harnessStats && name === "bash") {
    const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
    let preferred: string[] | undefined;
    try {
      const { detectProjectIntel } = await import("../util/project-intel.js");
      preferred = detectProjectIntel(workspace).checkCommands;
    } catch {
      preferred = undefined;
    }
    // The Planner's declared verify command (`Verify: ./build.sh --self-test`)
    // joins the stack table so any project's check is recognised.
    preferred = cyclePreferredCheckCommands(session.meta.id, preferred);
    if (countsTowardVerification(toolInput, preferred)) {
      const rawOut = typeof result.output === "string" ? result.output : "";
      const cls = classifyVerificationRun({
        command: cmd,
        isError: result.isError,
        output: rawOut,
        preferredCheckCommands: preferred,
      });
      const passed = cls.passed;
      const prevOk = session.meta.lastVerificationOk;
      const prevCmd = session.meta.lastVerificationCommand || "";
      applyVerificationCredit({
        harnessStats,
        meta: session.meta,
        proofPoke,
        cls,
        command: cmd,
        preferred,
      });
      try {
        if (
          !passed &&
          isFullSuiteCommand(cmd) &&
          prevOk === false &&
          isFullSuiteCommand(prevCmd)
        ) {
          const tip =
            "\n\nSuite is still red. Isolates are proof=ran; the cycle gate is the full suite the harness runs after review (timeout = proof=✗ — do not skip).";
          result.output = `${String(result.output || "").replace(/\s+$/, "")}${tip}`;
        }
        if (session.meta.lastVerificationOk === false) {
          // Fix-until-green: tell the model immediately — don't wait for the
          // user to say "tests failed, fix them". One proof speaker per prompt.
          try {
            const off = (
              process.env.FORGE_FIX_UNTIL_GREEN || "1"
            )
              .trim()
              .toLowerCase();
            if (
              off !== "0" &&
              off !== "false" &&
              off !== "off" &&
              off !== "no" &&
              config.permissionMode !== "plan" &&
              canEdit
            ) {
              const lastUser = [...session.messages]
                .reverse()
                .find((m) => m.role === "user");
              const lastContent =
                typeof lastUser?.content === "string" ? lastUser.content : "";
              if (
                proofPoke &&
                shouldEmitFixUntilGreen(proofPoke, {
                  lastUserContent: lastContent,
                })
              ) {
                const tip = (preferred && preferred[0]) || cmd.slice(0, 120);
                session.messages.push({
                  role: "user",
                  content:
                    "[Forge harness — fix until green]\n" +
                    "Verification failed: `" +
                    cmd.slice(0, 160) +
                    "`. Read the failure, fix the root cause, re-run `" +
                    tip +
                    "` until green. " +
                    "Do not ask the user what to do — continue until the check passes or you hit a real external blocker.",
                });
                noteFixUntilGreen(proofPoke);
                saveSession(session);
              }
            }
          } catch {
            /* */
          }
        }
      } catch {
        /* best-effort */
      }
    }
  }
  const ms = Date.now() - t0;
  const output = truncateMiddle(result.output);
  const bytes = Buffer.byteLength(output, "utf8");
  if (!result.isError) {
    try {
      noteGuidelineToolCall(session.meta.id, name, toolInput);
    } catch {
      /* */
    }
  }

  if (events?.onToolEnd) {
    events.onToolEnd(name, {
      isError: result.isError,
      ms,
      bytes,
      diff: result.isError
        ? undefined
        : (result.diff ?? extractDiffFromToolOutput(name, output)),
      stats: result.isError ? undefined : result.stats,
      output,
      args: displayArgs,
    });
  } else {
    console.error(
      formatDefaultToolEndTranscript(name, {
        isError: result.isError,
        ms,
        bytes,
        args: displayArgs,
        output,
        diff: result.isError
          ? undefined
          : (result.diff ?? extractDiffFromToolOutput(name, output)),
        stats: result.isError ? undefined : result.stats,
      }),
    );
  }
  settle();

  if (result.isError) {
    await hooks.run("PostToolUseFailure", {
      ...baseHookCtx(session, config),
      toolName: name,
      toolInput,
      toolOutput: output,
      toolUseId: tc.id,
    });
  } else {
    await hooks.run("PostToolUse", {
      ...baseHookCtx(session, config),
      toolName: name,
      toolInput,
      toolOutput: output,
      toolUseId: tc.id,
    });
  }

  let content = output;
  if (argsRepairNote && parsedArgs.ok) {
    content = `[note: tool arguments were auto-repaired (${argsRepairNote})]\n${content}`;
  }
  noteDoom(output, result.isError);
  if (doomHit) {
    content = `${content}\n\n${doomHit.message}`;
    if (doomHit.kind === "doom") {
      try {
        setSessionLastError(session, {
          code: "doom_loop",
          message: doomHit.message.split("\n")[0] || "doom-loop",
          tips: [
            "Change tool/args · write, or read_file the saved output path",
            "Do not retry the same denied mutation or the same read window",
          ],
        });
        saveSession(session);
      } catch {
        /* */
      }
    }
  }

  // Error-streak circuit breaker (different tools failing in a row)
  if (errorStreak) {
    if (isCountableToolError(content, result.isError)) {
      const hit = errorStreak.observeError(name, summarizeToolError(content));
      if (hit) {
        log.warn(hit.message.split("\n")[0] || "error-streak");
        events?.onStatus?.(`error-streak: ${hit.count} consecutive tool errors`);
        if (harnessStats) {
          harnessStats.effortBoostTurns = Math.max(
            harnessStats.effortBoostTurns,
            2,
          );
        }
        content = `${content}\n\n${hit.message}`;
        try {
          setSessionLastError(session, {
            code: "error_streak",
            message: hit.message.split("\n")[0] || "error-streak",
            tips: [
              "Read the real error or saved output path · change tool/scope",
              "/compact  ·  /retry  ·  /sessions errors",
            ],
          });
          saveSession(session);
        } catch {
          /* */
        }
      }
    } else if (!result.isError) {
      errorStreak.observeSuccess();
      const errCode = session.meta.lastError?.code;
      if (errCode === "doom_loop" || errCode === "error_streak") {
        try {
          clearSessionLastError(session);
        } catch {
          /* */
        }
      }
    }
  }

  return { toolCallId: tc.id, content };
}
