import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import {
  resolveReasoningEffort,
  bumpReasoningEffort,
  type ReasoningEffort,
} from "../config/reasoning.js";
import {
  applyModelContextWindow,
  resolveEffectiveMaxTokens,
  servedModelDiverged,
} from "../config/model-info.js";
import {
  isModelFallbackWorthy,
  nextFallbackModel,
} from "../config/model-fallback.js";
import type {
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
import { proofClaimReleaseTips } from "../harness/proof-claim-guard.js";
import { loadGoal, detectAutoGoal, armGoal } from "../harness/goal.js";
import {
  loadUlwCycle,
  armUlwCycle,
  adoptUlwMandate,
  maybeAdoptMandateFromUserTexts,
  reenableUlwCycle,
  isPlaceholderMandate,
  isArmableMandate,
  isResumeFollowUp,
  maybeFlipUlwToLastOnSafetyValve,
  formatUlwFuseLeftovers,
  notePlayLoopRan,
  providerFuseTripsContinueCap,
  stopBlockTripsContinueCap,
  ulwKickoffMessage,
  formatUlwCounts,
  formatUlwBadge,
  displayUlwMandate,
  ULW_LIVE_CONTROLS_HINT,
  maybeStampUlwWave,
  resolveUlwPhase,
  advanceUlwPhaseOnReading,
  countsTowardVerification,
  applyVerificationTrail,
  verificationPassedFromResult,
  isHelperOnlyTestCommand,
  isFullSuiteCommand,
  consumeMillHoldPrune,
} from "../harness/ulw-cycle.js";
import { isReasonedEmptyStop } from "./reasoned-stop.js";
import { applyMillHoldPrune } from "../session/hold-context.js";
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
} from "../session/explore-map.js";
import {
  storeNeedsCheckpoint,
  DEFAULT_CHECKPOINT_KEEP_STEPS,
} from "../session/checkpoint.js";
import { expandUserContentWithImages } from "../util/user-images.js";
import { expandUserMentions } from "../util/user-mentions.js";
import {
  maybeRecordUserConstraint,
  isEvaluateClassMandate,
} from "../harness/decision-memory.js";
import {
  createProofPokeState,
  noteFixUntilGreen,
  noteGreenVerification,
  noteRedVerification,
  noteUlwProofDemand,
  noteVerifyNudge,
  shouldEmitFixUntilGreen,
  shouldEmitVerifyNudge,
} from "../harness/proof-poke.js";
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
import { getGitSnapshot, type GitSnapshot } from "../util/git-context.js";
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
import { isExitPlanModeToolName } from "./tools/exit-plan-mode.js";
import { buildBaselineSystemPrompt } from "./system-prompt.js";
import { log } from "../util/log.js";
import { envPositiveInt } from "../util/env.js";
import {
  withRetry,
  isContextOverflowError,
  isContinueRecoverableProviderError,
  isDroppedConnectionError,
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
  isQuotaOrRateLimitError,
  maybeProactiveSwitch,
  switchOnAuthFailure,
  switchOnQuotaFailure,
} from "../auth/accounts.js";
import { isProviderApiError } from "../providers/errors.js";
import {
  costCapStatus,
  formatCostBudgetLine,
  resolveMaxCostUsd,
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
  defaultMaxSubagentDepth,
  runSubagentTracked,
  type SubagentRequest,
} from "./subagent.js";
import { mcpCallIsReadOnly } from "../mcp/tools.js";

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
  /** Skip goal/ULW auto-arm (subagents). */
  disableHarnessAutoArm?: boolean;
  /**
   * Explore children: end the map when two turns add no new paths
   * (information-gain stop, not a turn cap).
   */
  citeDeltaStop?: boolean;
  /**
   * Resume the existing transcript after a continue-recoverable provider drop.
   * Does not push a new user turn — same as the expert typing "continue"
   * without polluting history.
   */
  resumeWithoutUserMessage?: boolean;
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
   * True when ULW or /goal stuck-wall released the cycle (N no-progress Stops).
   * Metrics/JSON/notify must not look like a clean Stop (maze dogfood).
   */
  stuckReleased: boolean;
  /** True when ULW released on evidenced **Cycle complete.** after LAST. */
  lastCycleReleased: boolean;
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
  /** Unattended ULW auto-commit after **Cycle complete.** (never pushed). */
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
  /** Provider chat rounds this run (same as `turns`). */
  providerRounds?: number;
}

/**
 * Per-run harness signals shared between the loop and tool execution.
 * - verificationRuns: bash commands matching isVerificationCommand() executed
 *   since the last Stop evaluation — the structural "proof" signal for the
 *   ULW wave ledger (execution, not prose claims).
 * - effortBoostTurns: adaptive effort budget — hard-round signals (doom-loop,
 *   error-streak, missing wave proof) buy a temporary reasoning-effort bump
 *   instead of paying high effort on every turn (escalate on failure, not
 *   by default).
 */
interface HarnessRunStats {
  /** Structural check bash executed (pass or fail) — ULW wave ledger. */
  verificationRuns: number;
  /** Successful structural checks only — proof-claim / expert green trail. */
  verificationPassedRuns: number;
  /** Isolate `node --test tests/wN-*.mjs` ran — not wave proof. */
  verificationHelperOnlyRuns: number;
  effortBoostTurns: number;
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
 * True when the tool (after name normalize) is safe to run in parallel batches.
 * call_mcp is read-only only when the target tool has readOnlyHint (checked at
 * batch time via isReadOnlyToolCall).
 */
export function isReadOnlyToolName(name: string): boolean {
  const n = normalizeToolName(name || "");
  return READ_ONLY.has(n) || READ_ONLY.has(name || "");
}

/** evaluate-class orient: map, do not spawn or edit. */
const ORIENT_TOOL_NAMES = new Set([
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
  "todo_write",
  "memory_write",
  "ask_user",
  "AskUser",
  "bash",
  "Bash",
  "shell",
  "Shell",
  "run_terminal_command",
  "get_task_output",
  "task_output",
  "search_mcp",
  "mcp_search",
  "lsp",
  "LSP",
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

export function filterToolsForUlwPhase(
  tools: ToolDefinition[],
  phase: "orient" | "ship" | undefined,
): ToolDefinition[] {
  if (phase !== "orient") return tools;
  return tools.filter((t) => {
    const n = t.function.name;
    return ORIENT_TOOL_NAMES.has(n) || ORIENT_TOOL_NAMES.has(normalizeToolName(n));
  });
}

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
  "todo_write",
  "memory_write",
  "ask_user",
  "AskUser",
  // Read-only bash stays visible; PermissionGate still hard-denies mutations.
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
  "exit_plan_mode",
  "ExitPlanMode",
  "exitPlanMode",
  // Forced read-only by PermissionGate + toolSpawnSubagent when parent is plan.
  "spawn_subagent",
  "Task",
  "task",
]);

/** Hide write tools from the model while in /plan (Claude/Grok-style). */
export function filterToolsForPermissionMode(
  tools: ToolDefinition[],
  mode: string,
): ToolDefinition[] {
  if (mode !== "plan") return tools;
  return tools.filter((t) => PLAN_MODE_TOOL_NAMES.has(t.function.name));
}

export interface BuildChatRequestOpts {
  conversationId?: string;
  estimatedTokens?: number;
  lastApiPromptTokens?: number;
  /** Frozen omit set from a prior clip (session.meta.requestPruneSticky). */
  sticky?: RequestPruneSticky | null;
  /** Suffix mill-tool ids to omit without inventing a first clip. */
  holdOmitIds?: string[] | null;
  onPrune?: (info: {
    kind: PruneKind;
    sticky?: RequestPruneSticky;
    changed: boolean;
  }) => void;
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
    spool: true,
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
  const outbound = expandMessagesForVision(wire, config.workspace);
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
  };
}

/** Expand user string messages that reference image paths into multimodal content. */
export function expandMessagesForVision(
  messages: ChatMessage[],
  workspace?: string,
): OutboundChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "user" || typeof m.content !== "string") return m;
    if (
      !/\[\[image:/i.test(m.content) &&
      !/@[^\s]+\.(png|jpe?g|gif|webp|bmp)\b/i.test(m.content)
    ) {
      return m;
    }
    const expanded = expandUserContentWithImages(m.content, workspace);
    if (typeof expanded === "string") return m;
    return { ...m, content: expanded };
  });
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
  // Mutable so mid-run OAuth refresh can hot-swap the bearer token
  let provider = opts.provider;
  /** Generations of successful mid-run auth recovery (not a one-shot for multi-day). */
  let authRecoveryCount = 0;
  const maxAuthRecoveries = envPositiveInt("FORGE_AUTH_RECOVERY_MAX", 20);
  let accountSwitchCount = 0;
  const maxAccountSwitches = envPositiveInt("FORGE_ACCOUNT_SWITCH_MAX", 3);
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
  const ulwArmed = Boolean(loadUlwCycle(session.meta.id)?.enabled);
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
  const toolsForMode = (): typeof baseToolDefs => {
    const planned = filterToolsForPermissionMode(
      baseToolDefs,
      config.permissionMode,
    );
    const ulwNow = loadUlwCycle(session.meta.id);
    return filterToolsForUlwPhase(planned, resolveUlwPhase(ulwNow));
  };
  let mcp =
    opts.mcp ??
    (subagentDepth === 0 ? getActiveMcpManager() ?? undefined : undefined);
  let lsp =
    opts.lsp ??
    (subagentDepth === 0 ? getActiveLspManager() ?? undefined : undefined);
  if (!mcp) {
    mcp = new McpManager({ workspace, signal });
    mcp.start();
    if (subagentDepth === 0) setActiveMcpManager(mcp);
  }
  if (!lsp) {
    lsp = new LspManager({ workspace, signal });
    if (subagentDepth === 0) setActiveLspManager(lsp);
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
    effortBoostTurns: 0,
  };
  /** Consecutive Stop blocks from handoff-guard (polite yield). Resets on allow. */
  let handoffBlocks = 0;
  /** Consecutive Stop blocks from proof-claim guard. Resets on allow. */
  let proofClaimBlocks = 0;
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

  // If session is already in ULW but cycle state missing, (re)arm from this message
  let effectiveUserMessage = userMessage;
  if (
    !opts.resumeWithoutUserMessage &&
    !opts.disableHarnessAutoArm &&
    session.meta.ultrawork
  ) {
    let ulw = loadUlwCycle(session.meta.id);
    if (!ulw?.enabled) {
      if (isResumeFollowUp(userMessage)) {
        const revived = reenableUlwCycle(session.meta.id);
        if (revived) {
          ulw = revived;
          log.info("ULW cycle re-enabled on resume follow-up");
        }
      } else if (isArmableMandate(userMessage)) {
        ulw = armUlwCycle(session.meta.id, userMessage, {
          cycle: 1,
          editCount: session.meta.editCount,
          cwd: workspace,
        });
        log.info(
          `ULW cycle armed (cycle=1)${ulw.softPrompt ? " — soft prompt expanded to god-scope" : ""}`,
        );
        effectiveUserMessage = ulwKickoffMessage(ulw);
      }
    } else if (
      isPlaceholderMandate(ulw.mandate) &&
      isArmableMandate(userMessage)
    ) {
      // /cycle or /max-waves armed first with a placeholder. This message
      // is the real work — do not treat it as steering.
      ulw =
        adoptUlwMandate(session.meta.id, userMessage, { cwd: workspace }) ||
        ulw;
      effectiveUserMessage = ulwKickoffMessage(ulw);
      log.info(`ULW mandate adopted from first real user turn`);
    }
    // Already armed with a real mandate: user text is steering.
    // Explicit /ulw <new> still re-arms.
  }

  if (!opts.resumeWithoutUserMessage) {
    await hooks.run("UserPromptSubmit", {
      ...baseHookCtx(session, config),
      prompt: effectiveUserMessage,
    });
  }

  const goal = loadGoal(session.meta.id);
  const ulwCycle = loadUlwCycle(session.meta.id);
  const harnessActive =
    session.meta.ultrawork || Boolean(ulwCycle?.enabled) || Boolean(goal?.objective && goal.status === "active" && !goal.paused);

  // Baseline system only — live ULW/goal counters admitted mid-conversation.
  // Git snapshot is computed ONCE per prompt: the system message carries only
  // the stable subset (root/remote) so message[0] does not churn between
  // prompts and break the provider's server-side prompt cache; the volatile
  // branch line goes through the append-only harness admission instead.
  const gitSnap = getGitSnapshot(workspace);
  const system = buildBaselineSystemPrompt({
    config,
    workspace,
    ultrawork: session.meta.ultrawork || Boolean(ulwCycle?.enabled),
    ulwCycle,
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
  if (effectiveUserMessage.startsWith("## ULW armed") || ulwCycle?.enabled) {
    // ULW kickoff already carries state. Do not append a second 2k admit
    // (rewrites the prefix and kills xAI cache). Fingerprint only.
    markCurrentHarnessAdmitted(session, config, gitSnap);
  } else {
    admitHarnessState(session, config);
  }

  saveSession(session);

  let turns = 0;
  let finalText = "";
  let stopContinues = 0;
  /** Length / empty / content_filter only — never shared with Stop-blocks. */
  let providerContinues = 0;
  let lastCommittedSha = "";
  /** Cap mid-loop verify nudges per prompt (anti-spam). */
  let verifyNudges = 0;
  const proofPoke = createProofPokeState();
  let aborted = false;
  let releasedOnContinueCap = false;
  let hitMaxTurns = false;
  let hitCostCap = false;
  let stuckReleased = false;
  let lastCycleReleased = false;
  let lastFinishReason: string | null = null;
  let autoCommit: LoopResult["autoCommit"];
  let overflowCompactAttempted = false;
  // max_turns <= 0 means unlimited (config default is 0). A silent 200-cap when
  // the file says 0 was a production footgun for long ULW/CI runs.
  const maxTurns = resolveMaxTurns(config.maxTurns);
  /** Last outbound request was prefix-breaking prune (for per-round metrics). */
  let lastOutboundPruned = false;
  let lastPruneKind: PruneKind = "off";
  let lastRoundCacheRatio = 0;
  /** Tool schemas are sent every turn but not stored in session history. */
  const makeChatRequest = (effortOverride?: ReasoningEffort) => {
    const tools = toolsForMode();
    const estimated = estimateRequestTokens(session.messages, {
      toolsJsonChars: JSON.stringify(tools).length,
    });
    return buildChatRequest(config, session.messages, effortOverride, tools, {
      conversationId: session.meta.id,
      estimatedTokens: estimated,
      lastApiPromptTokens: session.meta.lastRoundPromptTokens,
      sticky: session.meta.requestPruneSticky,
      holdOmitIds: session.meta.holdOmitToolIds,
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
      spool: false,
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
    const ulwNow = loadUlwCycle(session.meta.id);
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

  /** After overflow recovery under ULW/goal: re-anchor without waiting for Stop. */
  const admitAfterOverflowRecovery = (): void => {
    const ulwNow = loadUlwCycle(session.meta.id);
    const goalNow = loadGoal(session.meta.id);
    const parts: string[] = [
      "[Forge] Context overflow recovered — history was compacted/pruned so the run can continue.",
      "Do not re-scan the whole workspace from zero. Use the compact summary + recent tail, verify only what you still need, then continue the highest-impact remaining work.",
    ];
    if (ulwNow?.enabled) {
      parts.push(
        `ULW still ACTIVE: ${formatUlwCounts(ulwNow)} ${ulwNow.cycle === 1 ? "(CONTINUE)" : "(LAST)"}. Mandate: ${displayUlwMandate(ulwNow.mandate)}`,
        "Stop never fired before the overflow (common on long tool-only waves) — that is why wave/blocks may still be low. Keep executing the cycle; the harness will re-anchor on the next clean Stop.",
        ULW_LIVE_CONTROLS_HINT,
      );
    }
    if (goalNow?.objective && goalNow.status === "active" && !goalNow.paused) {
      parts.push(`Goal still ACTIVE: ${goalNow.objective}`);
    }
    session.messages.push({ role: "user", content: parts.join("\n") });
    admitHarnessState(session, config, { emit: false });
    saveSession(session);
  };

  /** After a no-op threshold compact, don't re-attempt until messages grow. */
  let skipThresholdCompactUntilCount = 0;
  /** One-shot expert warning when context first crosses pressure bands. */
  let warnedContextPressure: "threshold" | "hard" | null = null;
  /** Avoid rewriting message[0] unless plan/ULW/model actually flipped. */
  let lastSystemEpoch = "";
  let lastWaveStampTurn = 0;

  try {
    // Check maxTurns / cost cap at the top so a clean Stop on the final allowed
    // turn is not mis-reported as hitMaxTurns/hitCostCap.
    for (;;) {
      if (turns >= maxTurns) {
        hitMaxTurns = true;
        break;
      }
      {
        const cap = costCapStatus(config, session.meta);
        if (cap.hit) {
          hitCostCap = true;
          break;
        }
      }
      assertNotAborted(signal);
      turns += 1;

      if (citeSeen && citeDeltaShouldPoke(citeStaleTurns)) {
        const already = session.messages.some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.startsWith(CITE_DELTA_POKE),
        );
        if (citeDeltaShouldStop(citeStaleTurns, already)) {
          if (!(finalText || "").trim()) {
            finalText =
              "[Forge] Cite-delta stop — map stopped growing.";
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
        }
      }

      // Nested children never see their turn budget unless we say so. On the
      // last allowed turn, demand the report instead of another search.
      // Skip when cite-delta already asked for the map this turn.
      if (
        subagentDepth > 0 &&
        Number.isFinite(maxTurns) &&
        turns === maxTurns &&
        !(citeSeen && citeDeltaShouldPoke(citeStaleTurns))
      ) {
        const already = session.messages.some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.startsWith("[Forge system-reminder — last turn]"),
        );
        if (!already) {
          session.messages.push({
            role: "user",
            content:
              `[Forge system-reminder — last turn]\n` +
              `Turn budget exhausted next iteration (${maxTurns}/${maxTurns}). ` +
              `Emit the structured findings now (citations, ranked gaps, what you did not cover). ` +
              `Do not start a new search unless one citation is missing.`,
          });
        }
      }

      // Live /plan|/build can flip permission mode. Do not rebuild message[0]
      // every turn — that busts the xAI prefix cache on a 12-hour run.
      {
        const ulwNow = loadUlwCycle(session.meta.id);
        const ulwOn = Boolean(session.meta.ultrawork || ulwNow?.enabled);
        const systemEpoch = `${config.permissionMode}|${ulwOn ? 1 : 0}|${subagentDepth}|${config.model}|${resolveUlwPhase(ulwNow)}`;
        if (systemEpoch !== lastSystemEpoch) {
          lastSystemEpoch = systemEpoch;
          const liveSystem = buildBaselineSystemPrompt({
            config,
            workspace,
            ultrawork: ulwOn,
            ulwCycle: ulwNow,
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

      // ULW quality bar must run on tool-only unattended waves (Stop never fires).
      {
        const ulwLive = loadUlwCycle(session.meta.id);
        if (ulwLive?.enabled) {
          const lastAsst = [...session.messages]
            .reverse()
            .find((m) => m.role === "assistant");
          const stamp = maybeStampUlwWave({
            sessionId: session.meta.id,
            editCount: session.meta.editCount,
            openTodoCount: openTodos(session.todos),
            stepsSinceStamp: turns - lastWaveStampTurn,
            lastAssistantMessage:
              typeof lastAsst?.content === "string" ? lastAsst.content : "",
            verificationRan: harnessStats.verificationRuns > 0,
            verificationPassed: harnessStats.verificationPassedRuns > 0,
            verificationHelperOnly: harnessStats.verificationHelperOnlyRuns > 0,
            cwd: workspace,
          });
          if (stamp.stamped || stamp.admit) {
            try {
              const ulwNow = loadUlwCycle(session.meta.id);
              if (ulwNow && consumeMillHoldPrune(ulwNow)) {
                applyMillHoldPrune(session);
              }
            } catch {
              /* suffix omit is best-effort */
            }
          }
          if (stamp.stamped) {
            lastWaveStampTurn = turns;
            try {
              const { maybeAutoCommitOnUlwDone, autoCommitStamp } =
                await import("../util/git-auto-commit.js");
              const ac = maybeAutoCommitOnUlwDone({
                cwd: workspace,
                sessionId: session.meta.id,
                permissionMode: config.permissionMode,
              });
              session.meta.lastAutoCommit = autoCommitStamp(ac);
              if (ac.committed) {
                const sha = ac.sha || "HEAD";
                const line = `Committed ${sha} — ${ac.subject} (${ac.files ?? 0} file(s), not pushed)`;
                if (sha !== lastCommittedSha) {
                  lastCommittedSha = sha;
                  log.info(chalk.green(line));
                }
                autoCommit = {
                  committed: ac.committed,
                  sha: ac.sha,
                  subject: ac.subject,
                  skipped: ac.skipped,
                };
              } else if (ac.skipped && ac.skipped !== "working tree clean") {
                log.dim(`Auto-commit skipped: ${ac.skipped}`);
              }
            } catch {
              /* never fail a wave stamp on commit */
            }
          }
          if (stamp.admit) {
            session.messages.push({ role: "user", content: stamp.admit });
            // Cycle/LAST already lives in this admit — do not let the
            // next boundary emit a second full "Obey this state."
            markCurrentHarnessAdmitted(session, config);
            saveSession(session);
          }
        }
      }

      // Optional in-session stubbing (opt-in). Request-time prune already
      // slims the outbound payload without rewriting session.json.
      const ulwForClear = loadUlwCycle(session.meta.id);
      const ulwAggressive = Boolean(ulwForClear?.enabled);
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
      const ulwForNudge = loadUlwCycle(session.meta.id);
      const evaluateClass = Boolean(
        ulwForNudge?.enabled &&
          (isEvaluateClassMandate(ulwForNudge.mandate) ||
            ulwForNudge.judgmentRequired),
      );
      const nudge = maybeTodoNudge({
        sessionId: session.meta.id,
        harnessActive,
        openTodoCount: openTodos(session.todos),
        lastUserMessage:
          typeof lastUserForNudge?.content === "string"
            ? lastUserForNudge.content
            : undefined,
        evaluateClass,
        mandate: ulwForNudge?.mandate,
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
        if (accountSwitchCount < maxAccountSwitches) {
          const proactive = maybeProactiveSwitch(String(config.provider));
          if (proactive.switched && proactive.account?.accessToken) {
            accountSwitchCount += 1;
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
      const fallbackTried = new Set<string>([config.model]);
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
              onRetry: ({ delayMs, attempt, retries, error }) => {
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
              const ulwDead = loadUlwCycle(session.meta.id);
              const ulwNote =
                ulwDead?.enabled && ulwDead.cycle === 1
                  ? ` ULW remains armed (${formatUlwCounts(ulwDead)}) — after /compact or /new, re-issue the mandate; cycle does not auto-clear on provider death.`
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
                    const ulwDead = loadUlwCycle(session.meta.id);
                    const ulwNote =
                      ulwDead?.enabled && ulwDead.cycle === 1
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
                const fresh = await resolveAuthFresh(config);
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
              switched: {
                switched: boolean;
                account?: { accessToken?: string; id?: string };
                toLabel?: string;
                toId?: string;
                reason?: string;
              },
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
              return true;
            };

            if (
              quotaFail &&
              accountSwitchCount < maxAccountSwitches &&
              updateCreds
            ) {
              accountSwitchCount += 1;
              events.onStatus?.(
                `Quota/rate-limit — trying another account (${accountSwitchCount}/${maxAccountSwitches})…`,
              );
              const switched = switchOnQuotaFailure(String(config.provider));
              if (await applySwitchedAccount(switched, "quota/rate-limit")) {
                response = await doChat();
              } else {
                // Always surface switch reason or a recovery tip (do not drop the
                // fallback when reason is empty — startsWith(" (") would hide it).
                const hint = switched.reason
                  ? ` (${switched.reason})`
                  : " — add another account: forge login --add";
                throw new Error(
                  `${msg}${hint}. Multi-account failover exhausted${
                    accountSwitchCount >= maxAccountSwitches
                      ? ` (FORGE_ACCOUNT_SWITCH_MAX=${maxAccountSwitches})`
                      : ""
                  }.`,
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
              let lastDropErr: unknown = err;
              let dropRecovered = false;
              while (dropRecoveryCount < maxDropRecoveries) {
                dropRecoveryCount += 1;
                const why = isDroppedConnectionError(lastDropErr)
                  ? "dropped connection"
                  : "provider error";
                events.onStatus?.(
                  `Provider ${why} — refreshing and retrying (${dropRecoveryCount}/${maxDropRecoveries})…`,
                );
                events.onPhase?.(
                  "waiting",
                  `provider drop ${dropRecoveryCount}/${maxDropRecoveries}`,
                );
                await forceRefreshLiveCreds(why);
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
                    const fresh = await resolveAuthFresh(config);
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
        if ((err as Error).message === "Aborted" || signal?.aborted) {
          aborted = true;
          break;
        }
        if (isModelFallbackWorthy(err) && !signal?.aborted) {
          const next = nextFallbackModel(config, { tried: fallbackTried });
          if (next) {
            fallbackTried.add(next);
            const prev = config.model;
            config.model = next;
            applyModelContextWindow(config, next);
            session.meta.model = next;
            session.meta.lastModelFallback = {
              from: prev,
              to: next,
              at: new Date().toISOString(),
            };
            saveSessionMetaSidecar(session);
            log.warn(
              `Model fallback: ${prev} unavailable (${
                err instanceof Error ? err.message.slice(0, 80) : "error"
              }) → ${next}`,
            );
            events.onStatus?.(`Model fallback → ${next}`);
            continue;
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
          appendProviderRoundMetrics({
            sessionId: session.meta.id,
            provider: String(config.provider),
            model: config.model,
            promptTokens: response.usage.prompt_tokens,
            cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
            completionTokens: response.usage.completion_tokens,
            pruned: lastOutboundPruned,
            pruneKind: lastPruneKind,
            cacheDrop: lastRoundCacheRatio > 0.9 && ratio < 0.05,
            turn: turns,
          });
          lastRoundCacheRatio = ratio;
        } catch {
          /* metrics never fail the turn */
        }
      }

      const assistantMsg = response.message;
      session.messages.push(assistantMsg);
      finalText = assistantMsg.content || "";
      noteAssistantTurn(session.meta.id);
      try {
        advanceUlwPhaseOnReading(session.meta.id, assistantMsg.content || "");
      } catch {
        /* */
      }
      if (citeSeen) {
        const cited = citedPathsFromToolCalls(assistantMsg);
        citeStaleTurns = noteCiteDelta(citeSeen, cited, citeStaleTurns).staleTurns;
      }
      saveSession(session);

      // Cost cap after usage lands — release before more tool work / continues.
      {
        const cap = costCapStatus(config, session.meta);
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
        const ulwBeforeStop = loadUlwCycle(session.meta.id);
        events.onPhase?.(
          "stop_guard",
          ulwBeforeStop?.enabled
            ? formatUlwBadge(ulwBeforeStop)
            : undefined,
        );
        let preferredCheckCommands: string[] | undefined;
        try {
          const { detectProjectIntel } = await import(
            "../util/project-intel.js"
          );
          preferredCheckCommands = detectProjectIntel(workspace).checkCommands;
        } catch {
          preferredCheckCommands = undefined;
        }
        const stopResult = await runStopGuard({
          config,
          hooks,
          ctx: baseHookCtx(session, config),
          ultrawork: session.meta.ultrawork,
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
          handoffBlocks,
          proofClaimBlocks,
          preferredCheckCommands,
          lastVerificationCommand:
            session.meta.lastVerificationOk === false
              ? undefined
              : session.meta.lastVerificationCommand,
          lastVerificationStale: isLastVerificationStale(session.meta),
        });
        // Reset only when the ULW driver actually evaluated this Stop — hook /
        // goal blocks return early without consuming the signal, and the runs
        // still belong to the wave in progress.
        if (stopResult.ulw) {
          harnessStats.verificationRuns = 0;
          harnessStats.verificationPassedRuns = 0;
          harnessStats.verificationHelperOnlyRuns = 0;
        }
        // Missing wave proof / weak attestation = hard-round signal → think harder.
        if (stopResult.ulw?.proofDemanded || stopResult.ulw?.evidenceDemanded) {
          harnessStats.effortBoostTurns = Math.max(
            harnessStats.effortBoostTurns,
            1,
          );
          noteUlwProofDemand(proofPoke);
        }
        if (stopResult.ulw?.soulDemanded) {
          harnessStats.effortBoostTurns = Math.max(
            harnessStats.effortBoostTurns,
            1,
          );
        }
        // Diminishing returns is user-visible: never let waves quietly thin out.
        if (stopResult.ulw?.thinStreakAdvisory) {
          log.info(
            chalk.yellow(
              "ULW diminishing returns — waves are thinning. /cycle 0 to wind down, /max-waves N to cap, or let a consolidation wave harden what's shipped.",
            ),
          );
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

        if (stopResult.ulw?.block && !stopResult.allowStop) {
          try {
            const ulwNow = loadUlwCycle(session.meta.id);
            if (ulwNow && consumeMillHoldPrune(ulwNow)) {
              applyMillHoldPrune(session);
            }
          } catch {
            /* suffix omit is best-effort */
          }
        }
        if (
          stopResult.ulw?.block &&
          !stopResult.allowStop &&
          stopResult.ulw.waveClosed
        ) {
          try {
            const { maybeAutoCommitOnUlwDone, autoCommitStamp } =
              await import("../util/git-auto-commit.js");
            const ac = maybeAutoCommitOnUlwDone({
              cwd: workspace,
              sessionId: session.meta.id,
              permissionMode: config.permissionMode,
            });
            session.meta.lastAutoCommit = autoCommitStamp(ac);
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
            } else if (ac.skipped && ac.skipped !== "working tree clean") {
              log.dim(`Auto-commit skipped: ${ac.skipped}`);
            }
            saveSession(session);
          } catch {
            /* never fail a Stop re-anchor on commit */
          }
        }
        if (stopResult.allowStop) {
          if (stopResult.systemMessage) log.dim(stopResult.systemMessage);
          if (
            !loadUlwCycle(session.meta.id)?.enabled &&
            session.meta.ultrawork
          ) {
            session.meta.ultrawork = false;
            saveSession(session);
          }
          if (stopResult.ulw?.stuckReleased) stuckReleased = true;
          if (stopResult.goal?.stuckReleased) stuckReleased = true;
          if (stopResult.ulw?.lastCycleReleased) lastCycleReleased = true;
          if (stopResult.ulw?.lastCycleReleased || stopResult.ulw?.stuckReleased) {
            try {
              const { maybeAutoCommitOnUlwDone, autoCommitStamp } =
                await import("../util/git-auto-commit.js");
              const cwd =
                config.workspace || session.meta.cwd || process.cwd();
              const ac = maybeAutoCommitOnUlwDone({
                cwd,
                sessionId: session.meta.id,
                permissionMode: config.permissionMode,
              });
              autoCommit = {
                committed: ac.committed,
                sha: ac.sha,
                subject: ac.subject,
                skipped: ac.skipped,
              };
              session.meta.lastAutoCommit = autoCommitStamp(ac);
              saveSession(session);
              if (ac.committed) {
                const sha = ac.sha || "HEAD";
                const line = `Committed ${sha} — ${ac.subject} (${ac.files ?? 0} file(s), not pushed)`;
                if (sha !== lastCommittedSha) {
                  lastCommittedSha = sha;
                  log.info(chalk.green(line));
                }
                if (finalText.trim()) finalText = `${finalText.replace(/\s+$/, "")}\n\n${line}`;
                else finalText = line;
              } else if (ac.skipped && ac.skipped !== "working tree clean") {
                log.dim(`Auto-commit skipped: ${ac.skipped}`);
              }
            } catch {
              /* never fail a finished cycle on commit */
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
            } else if (stopResult.ulw?.stuckReleased) {
              setSessionLastError(session, {
                code: "ulw_stuck_wall",
                message: (
                  stopResult.ulw.reason ||
                  "ULW stuck-wall released after consecutive Stop attempts with no progress"
                ).slice(0, 500),
                tips: [
                  "/cycle 1  ·  /ulw  to resume the mandate",
                  "/cycle status  ·  /retry",
                ],
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
            } else if (stopResult.ulw?.lastCycleReleased) {
              setSessionLastError(session, {
                code: "ulw_cycle_complete",
                message: (
                  stopResult.ulw.reason ||
                  "ULW last cycle attested complete — released"
                ).slice(0, 500),
                tips: [
                  "/cycle 1  ·  /ulw  if more work remains",
                  "/cycle status",
                ],
              });
              saveSession(session);
            }
          } catch {
            /* */
          }
          break;
        }

        stopContinues += 1;
        const ulwForCap = loadUlwCycle(session.meta.id);
        if (
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
              `Use /cycle 0, /max-waves N, /done, or /ulw-off if the harness is still blocking progress.`;
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
                "/cycle 0  ·  /max-waves N  ·  /done  ·  /ulw-off",
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
          inject = `[Forge ULW cycle driver] ${inject}`;
        }
        const ulwAfter = loadUlwCycle(session.meta.id);
        if (ulwAfter?.enabled || stopResult.ulw?.maxWavesHit) {
          const counts = ulwAfter
            ? formatUlwCounts(ulwAfter)
            : stopResult.ulw?.maxWavesHit
              ? "max_waves hit"
              : "ULW";
          const why = stopResult.ulw?.maxWavesHit
            ? "max_waves LAST"
            : ulwAfter?.cycle === 0
              ? "LAST"
              : "CONTINUE";
          log.info(
            chalk.magenta(
              `↻ ULW ${counts} (${why}) — Stop blocked (continue #${stopContinues})`,
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
      });
      try {
        advanceUlwPhaseOnReading(session.meta.id);
      } catch {
        /* */
      }
      // Tools that cooperatively return "Aborted" still leave signal.aborted set —
      // exit the loop immediately rather than starting another provider turn.
      assertNotAborted(signal);

      // Mid-loop auto-verify nudge: after an edit streak without a fresh green
      // check, inject a synthetic user message so the model runs the project
      // check without waiting for the user to steer. Max 2 per user prompt.
      if (verifyNudges < 2 && config.permissionMode !== "plan") {
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
      throw err;
    }
  }

  // Silent maxTurns exit is a production footgun for headless CI — surface it.
  if (!aborted && hitMaxTurns) {
    log.warn(`maxTurns (${maxTurns}) reached — releasing`);
    let ulwNote = "";
    try {
      const flipped = maybeFlipUlwToLastOnSafetyValve(session.meta.id);
      if (flipped) {
        ulwNote =
          ` ULW flipped cycle=1 → 0 (LAST) so the session is not stuck under CONTINUE after the turn cap. ` +
          `Raise max_turns and /cycle 1 to resume waves, or /done · /ulw-off to wind down.`;
        log.info(chalk.magenta("ULW → cycle=0 (LAST) after maxTurns"));
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
          "ULW was flipped to cycle=0 (LAST) if it was CONTINUE — /cycle 1 to resume waves",
        ],
      });
      saveSession(session);
    } catch {
      /* */
    }
  }

  // Cost-cap release — unattended ULW spend valve (estimate, not a bill).
  if (!aborted && hitCostCap) {
    const st = costCapStatus(config, session.meta);
    const capStr =
      st.cap != null ? `$${st.cap.toFixed(st.cap < 0.01 ? 4 : 3)}` : "?";
    const spentStr = `$${st.spent.toFixed(st.spent < 0.01 ? 4 : 3)}`;
    log.warn(`maxCostUsd (${capStr}) reached — releasing (spent ~${spentStr})`);
    // Under ULW cycle=1 the next continue would re-block forever after a spend
    // release — flip to LAST so resume/continue can finish or stop cleanly.
    let ulwNote = "";
    try {
      const flipped = maybeFlipUlwToLastOnSafetyValve(session.meta.id);
      if (flipped) {
        ulwNote =
          ` ULW flipped cycle=1 → 0 (LAST) so the session is not stuck under CONTINUE after the spend release. ` +
          `Raise the budget and /cycle 1 to resume waves, or /done · /ulw-off to wind down.`;
        log.info(chalk.magenta("ULW → cycle=0 (LAST) after cost cap"));
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
          "ULW was flipped to cycle=0 (LAST) if it was CONTINUE — /cycle 1 to resume waves",
          "Estimate only (estimateCostUsd) — not provider billing",
        ],
      });
      saveSession(session);
    } catch {
      /* */
    }
  }

  // Continue-cap release (length / content_filter / empty / Stop-block) under ULW
  // CONTINUE — same stuck risk as maxTurns/costCap. Skip when those already flipped.
  if (
    !aborted &&
    releasedOnContinueCap &&
    !hitMaxTurns &&
    !hitCostCap
  ) {
    try {
      const flipped = maybeFlipUlwToLastOnSafetyValve(session.meta.id);
      if (flipped) {
        const leftovers = formatUlwFuseLeftovers(flipped);
        const note =
          `[Forge] ULW flipped cycle=1 → 0 (LAST) after stop-continue safety valve. ` +
          `Raise FORGE_ULW_MAX_CONTINUES / maxStopContinues or /cycle 1 to resume waves · /done · /ulw-off.` +
          (leftovers ? ` ${leftovers}` : "");
        log.info(chalk.magenta("ULW → cycle=0 (LAST) after continue-cap"));
        if (leftovers) log.dim(leftovers);
        if ((finalText || "").trim()) {
          if (!finalText.includes("ULW flipped cycle=1")) {
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
              "ULW was flipped to cycle=0 (LAST) if it was CONTINUE — /cycle 1 to resume waves",
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
    lastErrCode === "ulw_stuck_wall" ||
    lastErrCode === "ulw_cycle_complete" ||
    lastErrCode === "goal_stuck_wall" ||
    lastErrCode === "max_cost" ||
    lastErrCode === "max_turns" ||
    lastErrCode === "doom_loop" ||
    lastErrCode === "error_streak" ||
    lastErrCode.startsWith("continue_cap");
  if (!aborted && !keepLastError) {
    try {
      clearSessionLastError(session);
      saveSession(session);
    } catch {
      /* */
    }
  }

  const pokeMeters = countHarnessPokesSince(session, pokeBaseline);
  try {
    session.meta.harnessUserPokes = pokeMeters.harnessUserPokes;
    session.meta.admitCount = pokeMeters.admitCount;
    session.meta.proofPokes = pokeMeters.proofPokes;
    session.meta.providerRounds = turns;
    saveSession(session);
  } catch {
    /* meters are best-effort */
  }

  defaultStarts?.flush();

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
    providerRounds: turns,
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
  for (;;) {
    try {
      return await runAgentLoop({
        ...opts,
        resumeWithoutUserMessage: resume,
      });
    } catch (err) {
      if (off || opts.signal?.aborted) throw err;
      if (!isContinueRecoverableProviderError(err)) throw err;
      let ulwEnabled = Boolean(opts.session.meta.ultrawork);
      try {
        const ulw = loadUlwCycle(opts.session.meta.id);
        if (ulw?.enabled) ulwEnabled = true;
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
  };
  process.once("exit", cleanup);
  process.once("beforeExit", cleanup);
}

function countHarnessPokesSince(
  session: SessionData,
  baseline: number,
): { harnessUserPokes: number; admitCount: number; proofPokes: number } {
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
    ulw: loadUlwCycle(session.meta.id),
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

  const interjections = drainInterjections(session.meta.id);
  if (interjections.length) {
    // Attach active harness context so free-text steering does not drop the
    // mandate/goal/todos mid-wave (expert friction: "I said X and it forgot ULW").
    let ijCtx: import("../harness/interjection.js").InterjectionContext | undefined;
    let waveForMem: number | undefined;
    try {
      const ulwNow = loadUlwCycle(session.meta.id);
      const goalNow = loadGoal(session.meta.id);
      const open = openTodos(session.todos);
      waveForMem = ulwNow?.enabled ? ulwNow.wave : undefined;
      ijCtx = {};
      if (ulwNow?.enabled) {
        ijCtx.ulwLine = `${formatUlwCounts(ulwNow)} ${
          ulwNow.cycle === 1 ? "(CONTINUE)" : "(LAST)"
        }`;
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
      maybeAdoptMandateFromUserTexts(session.meta.id, interjections, {
        cwd: config.workspace || session.meta.cwd,
      });
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
  } = opts;

  const isParallelSafe = (tc: ToolCall): boolean => {
    const n = normalizeToolName(tc.function.name || "");
    // Mode-flip must run sequentially so later writes see the restored mode.
    if (isExitPlanModeToolName(n) || isExitPlanModeToolName(tc.function.name || "")) {
      return false;
    }
    if (isReadOnlyToolName(n) || isReadOnlyToolName(tc.function.name || "")) {
      return true;
    }
    // call_mcp is parallel-safe only when the target is annotated read-only
    if (n === "call_mcp" || n === "mcp_call" || n === "use_mcp") {
      const parsed = parseToolArguments(tc.function.arguments);
      if (!parsed.ok) return false;
      return mcpCallIsReadOnly(mcp, parsed.value);
    }
    return false;
  };

  // Sequential by default; batch consecutive read-only tools in parallel
  // but append results in original order (providers are picky about this).
  // Normalize names before the read-only check so aliases (Read/read_file)
  // and doubled stream-bug names still batch.
  // Run exit_plan_mode first so same-turn writes see the restored mode.
  const exitIdx = toolCalls.findIndex((tc) =>
    isExitPlanModeToolName(normalizeToolName(tc.function.name || "")),
  );
  if (exitIdx > 0) {
    const [exitCall] = toolCalls.splice(exitIdx, 1);
    toolCalls.unshift(exitCall);
  }
  let i = 0;
  while (i < toolCalls.length) {
    assertNotAborted(signal);
    if (isParallelSafe(toolCalls[i])) {
      const batch: ToolCall[] = [];
      while (
        i < toolCalls.length &&
        isParallelSafe(toolCalls[i]) &&
        batch.length < 8
      ) {
        batch.push(toolCalls[i]);
        i++;
      }
      const results = await Promise.all(
        batch.map((tc) =>
          prepareToolResult({
            tc,
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
          }),
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
        tc: toolCalls[i],
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
      });
      session.messages.push({
        role: "tool",
        tool_call_id: r.toolCallId,
        content: r.content,
      });
      saveSession(session);
      i++;
    }
  }
}

async function prepareToolResult(opts: {
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
}): Promise<{ toolCallId: string; content: string }> {
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

  // Doom-loop: identical tool+args streak → warn (still execute once more)
  const doomHit = doomLoop?.observe(name, toolInput) ?? null;
  if (doomHit) {
    log.warn(doomHit.message.slice(0, 200));
    events?.onStatus?.(`doom-loop: ${name} ×${doomHit.count}`);
    // Hard-round signal: next turn thinks one notch harder
    if (harnessStats) {
      harnessStats.effortBoostTurns = Math.max(harnessStats.effortBoostTurns, 2);
    }
  }

  // Announce tool phase BEFORE permission prompts so the REPL can pause
  // the working spinner and not clobber interactive Allow? lines.
  const argSummary = summarizeToolArgs(toolInput, 48);
  const shown = formatToolDisplayName(name);
  const toolDetail = argSummary ? `${shown} ${argSummary}` : shown;
  events?.onPhase?.("tool", toolDetail);

  const settle = () => {
    events?.onToolSettled?.(name);
  };

  /** Permission/plan denials skip executeTool — still pair start/end so the REPL shows ✗. */
  const emitDeniedTool = (output: string) => {
    if (events?.onToolStart) {
      events.onToolStart(name, toolInput);
    } else {
      console.error(formatToolStart(name, toolInput));
    }
    const bytes = Buffer.byteLength(output, "utf8");
    if (events?.onToolEnd) {
      events.onToolEnd(name, { isError: true, ms: 0, bytes, output, args: toolInput });
    } else {
      console.error(
        formatDefaultToolEndTranscript(name, {
          isError: true,
          ms: 0,
          bytes,
          output,
          args: toolInput,
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
    ulwPhase: resolveUlwPhase(loadUlwCycle(session.meta.id)),
  });
  if (perm.decision === "deny") {
    await hooks.run("PermissionDenied", {
      ...baseHookCtx(session, config),
      toolName: name,
      toolInput,
    });
    const content = `Tool denied by permission gate: ${perm.reason}${perm.rule ? ` [${perm.rule}]` : ""}`;
    emitDeniedTool(content);
    return {
      toolCallId: tc.id,
      content,
    };
  }

  if (events?.onToolStart) {
    events.onToolStart(name, toolInput);
  } else {
    console.error(formatToolStart(name, toolInput));
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
    const bytes = Buffer.byteLength(content, "utf8");
    if (events?.onToolEnd) {
      events.onToolEnd(name, { isError: true, ms: 0, bytes, output: content, args: toolInput });
    } else {
      console.error(
        formatDefaultToolEndTranscript(name, {
          isError: true,
          ms: 0,
          bytes,
          output: content,
          args: toolInput,
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
    if (
      !result.isError &&
      /call_mcp|playwright|browser/i.test(name) &&
      /playwright|browser_navigate|browser_snapshot/i.test(
        `${name} ${JSON.stringify(toolInput).slice(0, 400)}`,
      )
    ) {
      try {
        notePlayLoopRan(session.meta.id);
      } catch {
        /* */
      }
    }
  } catch (err) {
    settle();
    throw err;
  }
  // Structural verification signal for the ULW wave ledger: a check command
  // actually executed this wave (pass or fail — running it is the behavior
  // the quality bar rewards; prose claims are not trusted on their own).
  // Background starts observe no exit code (fire-and-forget) — excluded by
  // countsTowardVerification; run the check in the foreground for it to count.
  // Session last-verify trail records the last check (green or red) so Δ
  // never says "verify: none" after a failed npm test.
  if (harnessStats && name === "bash") {
    const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
    let preferred: string[] | undefined;
    try {
      const { detectProjectIntel } = await import("../util/project-intel.js");
      preferred = detectProjectIntel(workspace).checkCommands;
    } catch {
      preferred = undefined;
    }
    if (countsTowardVerification(toolInput, preferred)) {
      harnessStats.verificationRuns += 1;
      const rawOut = typeof result.output === "string" ? result.output : "";
      const passed = verificationPassedFromResult({
        command: cmd,
        isError: result.isError,
        output: rawOut,
      });
      if (passed) {
        harnessStats.verificationPassedRuns += 1;
      } else if (isHelperOnlyTestCommand(cmd)) {
        harnessStats.verificationHelperOnlyRuns += 1;
      }
      const prevOk = session.meta.lastVerificationOk;
      const prevCmd = session.meta.lastVerificationCommand || "";
      try {
        applyVerificationTrail(session.meta, {
          command: cmd,
          isError: !passed,
          preferredCheckCommands: preferred,
        });
        if (
          !passed &&
          isFullSuiteCommand(cmd) &&
          prevOk === false &&
          isFullSuiteCommand(prevCmd)
        ) {
          const tip =
            "\n\nSuite is still red. Prefer `node --test tests/<this-wave>.mjs` this wave; full suite at consolidation / LAST.";
          result.output = `${String(result.output || "").replace(/\s+$/, "")}${tip}`;
        }
        if (session.meta.lastVerificationOk === true) {
          if (proofPoke) noteGreenVerification(proofPoke);
        } else if (session.meta.lastVerificationOk === false) {
          if (proofPoke) {
            noteRedVerification(proofPoke, session.meta.editCount || 0);
          }
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
              config.permissionMode !== "plan"
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
      args: toolInput,
    });
  } else {
    console.error(
      formatDefaultToolEndTranscript(name, {
        isError: result.isError,
        ms,
        bytes,
        args: toolInput,
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
  if (doomHit) {
    content = `${content}\n\n${doomHit.message}`;
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
