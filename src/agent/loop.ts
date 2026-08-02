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
import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  ToolCall,
} from "../providers/types.js";
import type { SessionData, TodoItem } from "../session/session.js";
import { applyTodos, openTodos } from "./todos.js";
import {
  saveSession,
  estimateTokens,
  estimateRequestTokens,
  compactMessages,
  rebuildUserTurnMarks,
  maybeSetTitle,
  markUserTurn,
  pruneOversizedMessageBodies,
  setSessionLastError,
  clearSessionLastError,
  isLastVerificationStale,
} from "../session/session.js";
import { appendFileMutation } from "../session/mutations.js";
import { HookRunner, type HookContext } from "../harness/hooks.js";
import { runStopGuard } from "../harness/stop-guard.js";
import { loadGoal, detectAutoGoal, armGoal } from "../harness/goal.js";
import {
  loadUlwCycle,
  armUlwCycle,
  maybeFlipUlwToLastOnSafetyValve,
  ulwKickoffMessage,
  isSoftPrompt,
  formatUlwCounts,
  formatUlwBadge,
  ULW_LIVE_CONTROLS_HINT,
  countsTowardVerification,
  shouldStampLastVerification,
  shouldClearLastVerification,
} from "../harness/ulw-cycle.js";
import {
  clearStaleToolResults,
  toolClearEnvConfig,
} from "../session/tool-clearing.js";
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
} from "../harness/context-admit.js";
import { getGitSnapshot, type GitSnapshot } from "../util/git-context.js";
import { FileReadState } from "./tools/file-read-state.js";
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
import { buildBaselineSystemPrompt } from "./system-prompt.js";
import { log } from "../util/log.js";
import { envPositiveInt } from "../util/env.js";
import { withRetry, isContextOverflowError } from "../util/retry.js";
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
import { resolveAuth } from "../auth/resolve.js";
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
  formatToolStart,
  formatToolEnd,
  truncateMiddle,
  formatTokens,
  estimateCostUsd,
  formatCost,
  formatRetryWait,
  summarizeToolArgs,
  extractDiffFromToolOutput,
} from "../util/format.js";

export type LoopPhase =
  | "thinking"
  | "tool"
  | "compacting"
  | "stop_guard"
  | "waiting";

export interface LoopEvents {
  onToken?: (token: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (
    name: string,
    result: {
      isError?: boolean;
      ms: number;
      bytes: number;
      diff?: string;
      output?: string;
    },
  ) => void;
  /**
   * Fired once per tool attempt after onPhase("tool"), including hard-deny
   * and permission-deny paths that never reach onToolStart/onToolEnd.
   * Used by the REPL to keep the spinner paused across parallel batches.
   */
  onToolSettled?: (name: string) => void;
  onStatus?: (msg: string) => void;
  /** Rich phase updates for in-REPL working indicator / HUD */
  onPhase?: (phase: LoopPhase, detail?: string) => void;
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
]);

/** True when the tool (after name normalize) is safe to run in parallel batches. */
export function isReadOnlyToolName(name: string): boolean {
  const n = normalizeToolName(name || "");
  return READ_ONLY.has(n) || READ_ONLY.has(name || "");
}

/** Build provider chat request including reasoning_effort when supported. */
export function buildChatRequest(
  config: ForgeConfig,
  messages: ChatMessage[],
  effortOverride?: ReasoningEffort,
): ChatRequest {
  const effort =
    effortOverride ?? resolveReasoningEffort(config.model, config.reasoningEffort);
  return {
    model: config.model,
    messages,
    tools: TOOL_DEFINITIONS,
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
  const events: LoopEvents = {
    onToken: opts.events?.onToken || opts.onToken,
    onToolStart: opts.events?.onToolStart,
    onToolEnd: opts.events?.onToolEnd,
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
  const fileReads = new FileReadState();
  const startPrompt = session.meta.totalPromptTokens;
  const startComp = session.meta.totalCompletionTokens;
  const startCache = session.meta.totalCacheReadTokens ?? 0;
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
    effortBoostTurns: 0,
  };
  /** Consecutive Stop blocks from handoff-guard (polite yield). Resets on allow. */
  let handoffBlocks = 0;
  /** Consecutive Stop blocks from proof-claim guard. Resets on allow. */
  let proofClaimBlocks = 0;
  // Proactive stale tool-result clearing (microcompaction). Cadence + size
  // thresholds bound prompt-cache disruption; clearing itself is age-based.
  const toolClearCfg = toolClearEnvConfig();
  const toolClearEveryTurns = envPositiveInt("FORGE_TOOL_CLEAR_EVERY_TURNS", 4);
  let lastToolClearTurn = 0;
  // Adaptive effort escalation (hard rounds think harder; easy rounds stay cheap)
  const adaptiveEffortOn = !(
    process.env.FORGE_ADAPTIVE_EFFORT === "0" ||
    process.env.FORGE_ADAPTIVE_EFFORT === "false"
  );

  // Auto-arm goal from prose
  if (config.goal.autoArm && config.goal.enabled) {
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
  if (session.meta.ultrawork) {
    let ulw = loadUlwCycle(session.meta.id);
    if (!ulw?.enabled) {
      ulw = armUlwCycle(session.meta.id, userMessage, {
        cycle: 1,
        editCount: session.meta.editCount,
      });
      log.info(
        `ULW cycle armed (cycle=1)${ulw.softPrompt ? " — soft prompt expanded to god-scope" : ""}`,
      );
      effectiveUserMessage = ulwKickoffMessage(ulw);
    } else if (isSoftPrompt(userMessage) && !userMessage.includes("ULW runtime controls")) {
      // Soft follow-ups under ULW still get cycle framing without resetting wave hard
      const refreshed = armUlwCycle(session.meta.id, userMessage, {
        cycle: ulw.cycle,
        editCount: session.meta.editCount,
      });
      effectiveUserMessage = ulwKickoffMessage(refreshed);
      log.info("ULW soft follow-up — re-expanded mandate, cycle preserved");
    }
  }

  await hooks.run("UserPromptSubmit", {
    ...baseHookCtx(session, config),
    prompt: effectiveUserMessage,
  });

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
  });
  if (session.messages.length === 0 || session.messages[0]?.role !== "system") {
    session.messages.unshift({ role: "system", content: system });
  } else if (session.messages[0].content !== system) {
    // Update baseline only when content actually changed (profile/mode/rules)
    session.messages[0] = { role: "system", content: system };
  }

  maybeSetTitle(session, userMessage);
  markUserTurn(session);
  session.messages.push({ role: "user", content: effectiveUserMessage });
  session.meta.turnCount += 1;
  resetTodoNudgeForPrompt(session.meta.id);

  // Admit initial harness snapshot (ULW/goal/todos/git) once at prompt start
  admitHarnessState(session, config, { git: gitSnap });

  saveSession(session);

  let turns = 0;
  let finalText = "";
  let stopContinues = 0;
  let aborted = false;
  let releasedOnContinueCap = false;
  let hitMaxTurns = false;
  let hitCostCap = false;
  let lastFinishReason: string | null = null;
  let overflowCompactAttempted = false;
  // max_turns <= 0 means unlimited (config default is 0). A silent 200-cap when
  // the file says 0 was a production footgun for long ULW/CI runs.
  const maxTurns = resolveMaxTurns(config.maxTurns);
  /** Tool schemas are sent every turn but not stored in session history. */
  const toolsJsonChars = JSON.stringify(TOOL_DEFINITIONS).length;

  const requestTokenEstimate = (): number =>
    estimateRequestTokens(session.messages, { toolsJsonChars });

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
    events.onStatus?.(`Compacting conversation (${reason})…`);
    await hooks.run("PreCompact", baseHookCtx(session, config));
    const ulwNow = loadUlwCycle(session.meta.id);
    const goalNow = loadGoal(session.meta.id);
    const keep =
      keepLast ??
      (reason.startsWith("overflow") ? 8 : 12);
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
        `ULW still ACTIVE: ${formatUlwCounts(ulwNow)} ${ulwNow.cycle === 1 ? "(CONTINUE)" : "(LAST)"}. Mandate: ${ulwNow.mandate}`,
        "Stop never fired before the overflow (common on long tool-only waves) — that is why wave/blocks may still be low. Keep executing the cycle; the harness will re-anchor on the next clean Stop.",
        ULW_LIVE_CONTROLS_HINT,
      );
    }
    if (goalNow?.objective && goalNow.status === "active" && !goalNow.paused) {
      parts.push(`Goal still ACTIVE: ${goalNow.objective}`);
    }
    session.messages.push({ role: "user", content: parts.join("\n") });
    admitHarnessState(session, config, { git: gitSnap });
    saveSession(session);
  };

  /** After a no-op threshold compact, don't re-attempt until messages grow. */
  let skipThresholdCompactUntilCount = 0;
  /** One-shot expert warning when context first crosses pressure bands. */
  let warnedContextPressure: "threshold" | "hard" | null = null;

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

      // Live /plan|/build|/permissions can flip config.permissionMode mid-run.
      // Refresh message[0] so the next model call sees PLAN MODE rules without
      // waiting for a new user prompt (OpenCode-style plan↔build switch).
      {
        const liveSystem = buildBaselineSystemPrompt({
          config,
          workspace,
          ultrawork: session.meta.ultrawork || Boolean(loadUlwCycle(session.meta.id)?.enabled),
          ulwCycle: loadUlwCycle(session.meta.id),
          git: gitSnap,
        });
        if (
          session.messages[0]?.role === "system" &&
          session.messages[0].content !== liveSystem
        ) {
          session.messages[0] = { role: "system", content: liveSystem };
        }
      }

      // Include tool-schema overhead; chars/3.2 estimate (see estimateTokens).
      const est = requestTokenEstimate();
      const overThreshold =
        est > config.contextWindow * config.autoCompactThreshold;
      // Hard headroom: even if under auto_compact_threshold, don't ride the
      // provider's absolute max (xAI rejects at model max prompt length).
      const nearHardLimit = est > config.contextWindow * 0.92;
      // Expert-visible one-shot pressure warning (OpenCode-style overflow hygiene)
      if (nearHardLimit && warnedContextPressure !== "hard") {
        warnedContextPressure = "hard";
        const pct = Math.min(99, Math.round((est / config.contextWindow) * 100));
        log.warn(
          `Context pressure ~${pct}% of window (${formatTokens(est)} / ${formatTokens(config.contextWindow)}) — compacting for headroom. Tip: /compact · /new · raise context_window`,
        );
      } else if (
        overThreshold &&
        warnedContextPressure == null
      ) {
        warnedContextPressure = "threshold";
        const pct = Math.min(99, Math.round((est / config.contextWindow) * 100));
        log.dim(
          `Context ~${pct}% — auto-compact threshold. Tip: /context · /compact · /compact-and <next>`,
        );
      }
      if (
        (overThreshold || nearHardLimit) &&
        session.messages.length > skipThresholdCompactUntilCount
      ) {
        let reduced = await forceCompact(
          nearHardLimit && !overThreshold ? "headroom" : "threshold",
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

      // Proactive stale tool-result clearing (microcompaction): old bulky tool
      // bodies are replaced by restorable stubs before they pile up into
      // overflow territory. Anthropic calls tool-result clearing "one of the
      // safest lightest touch forms of compaction".
      if (
        toolClearCfg.enabled &&
        turns - lastToolClearTurn >= toolClearEveryTurns &&
        session.messages.length > toolClearCfg.keepRecent + 4
      ) {
        const cleared = clearStaleToolResults(session.messages, {
          keepRecent: toolClearCfg.keepRecent,
          minChars: toolClearCfg.minChars,
        });
        if (cleared.cleared > 0 && cleared.freedChars >= toolClearCfg.minStaleBytes) {
          session.messages = cleared.messages;
          lastToolClearTurn = turns;
          saveSession(session);
          log.dim(
            `Cleared ${cleared.cleared} stale tool result(s), freed ~${Math.round(cleared.freedChars / 1000)}k chars — stubs point back to re-run`,
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
      drainSafeBoundaryMessages(session, config, events, gitSnap);

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
        events.onStatus?.("Todo nudge");
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
          events.onStatus?.(`Adaptive effort → ${bumped}`);
        }
      }
      try {
        const doChat = () =>
          withRetry(
            async () => {
              assertNotAborted(signal);
              if (stream && events.onToken) {
                return provider.chatStream(
                  buildChatRequest(config, session.messages, effortOverride),
                  (delta) => {
                    if (signal?.aborted) return;
                    if (delta.content) events.onToken?.(delta.content);
                  },
                  signal,
                );
              }
              const r = await provider.chat(
                buildChatRequest(config, session.messages, effortOverride),
                signal,
              );
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
            } else if (!tokenAuthFail || authRecoveryCount >= maxAuthRecoveries) {
              throw err;
            } else {
              authRecoveryCount += 1;
              events.onStatus?.(
                `Auth failure — attempting token refresh (${authRecoveryCount}/${maxAuthRecoveries})…`,
              );
              const refreshed = await refreshCredentialIfNeeded(
                String(config.provider),
                { force: true },
              );
              // SuperGrok refresh often fails (revoked/CF) — try full resolveAuthFresh
              // (re-import live ~/.grok session) before giving up.
              let auth = refreshed.ok && refreshed.credential
                ? resolveAuth(config)
                : null;
              if (!auth?.token) {
                try {
                  const { resolveAuthFresh } = await import("../auth/resolve.js");
                  auth = await resolveAuthFresh(config);
                } catch {
                  /* fall through */
                }
              }
              // Token still bad — try another multi-account slot (auth-failure cooldown).
              if (
                (!auth?.token || !updateCreds) &&
                accountSwitchCount < maxAccountSwitches &&
                updateCreds
              ) {
                accountSwitchCount += 1;
                const switched = switchOnAuthFailure(String(config.provider));
                if (await applySwitchedAccount(switched, "auth failure")) {
                  response = await doChat();
                } else if (!auth?.token || !updateCreds) {
                  throw new Error(
                    `${msg}. Auth recovery failed` +
                      (switched.reason ? ` (${switched.reason})` : "") +
                      ". Re-login: forge login  ·  or forge login --add",
                  );
                } else {
                  updateCreds(auth.token);
                  log.info(
                    "Refreshed credentials after auth failure — retrying chat",
                  );
                  events.onStatus?.("Credentials refreshed — retrying");
                  response = await doChat();
                }
              } else {
                if (!auth?.token || !updateCreds) {
                  throw err;
                }
                updateCreds(auth.token);
                log.info(
                  "Refreshed credentials after auth failure — retrying chat",
                );
                events.onStatus?.("Credentials refreshed — retrying");
                response = await doChat();
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).message === "Aborted" || signal?.aborted) {
          aborted = true;
          break;
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
      }

      const assistantMsg = response.message;
      session.messages.push(assistantMsg);
      finalText = assistantMsg.content || "";
      noteAssistantTurn(session.meta.id);
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
        stopContinues += 1;
        if (stopContinues > maxStopContinues) {
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
            `↻ Output truncated (finish_reason=${finishReason}) — continuing (#${stopContinues})`,
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
        stopContinues += 1;
        // Cap check before injecting steerage — avoid orphan user msgs when releasing.
        if (stopContinues > maxStopContinues) {
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

      // Empty assistant turn (provider glitch) — nudge with expert recovery
      if (
        (!toolCalls || toolCalls.length === 0) &&
        !(finalText || "").trim()
      ) {
        stopContinues += 1;
        if (stopContinues > maxStopContinues) {
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
          `Empty model response (finish_reason=${finishReason || "unknown"}) — nudging continue #${stopContinues}`,
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
          handoffBlocks,
          proofClaimBlocks,
          preferredCheckCommands,
          lastVerificationCommand: session.meta.lastVerificationCommand,
          lastVerificationStale: isLastVerificationStale(session.meta),
        });
        // Reset only when the ULW driver actually evaluated this Stop — hook /
        // goal blocks return early without consuming the signal, and the runs
        // still belong to the wave in progress.
        if (stopResult.ulw) {
          harnessStats.verificationRuns = 0;
          harnessStats.verificationPassedRuns = 0;
        }
        // Missing wave proof / weak attestation = hard-round signal → think harder.
        if (stopResult.ulw?.proofDemanded || stopResult.ulw?.evidenceDemanded) {
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
          events.onStatus?.("ULW waves thinning — consider /cycle 0");
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
          // Stamp lastError when a polite-yield / proof-claim guard released
          // after its cap so resume orientation surfaces why the agent stopped
          // short (expert friction: "why did it yield?").
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
                tips: [
                  "Run the verification command, then continue",
                  "npm test  ·  npm run typecheck  ·  /retry",
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
        if (stopContinues > maxStopContinues) {
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

        const inject =
          stopResult.additionalContext ||
          stopResult.reason ||
          "Stop was blocked. Continue working.";
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
          log.dim(ULW_LIVE_CONTROLS_HINT);
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
        log.dim(inject.slice(0, 300));
        session.messages.push({ role: "user", content: inject });
        // The re-anchor already carries wave/blocks/todo counts — mark them
        // admitted without emitting a second redundant harness message.
        admitHarnessState(session, config, {
          suppressCounterOnly: true,
          git: gitSnap,
        });
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
      });
      // Tools that cooperatively return "Aborted" still leave signal.aborted set —
      // exit the loop immediately rather than starting another provider turn.
      assertNotAborted(signal);
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
        const note =
          `[Forge] ULW flipped cycle=1 → 0 (LAST) after stop-continue safety valve. ` +
          `Raise FORGE_ULW_MAX_CONTINUES / maxStopContinues or /cycle 1 to resume waves · /done · /ulw-off.`;
        log.info(chalk.magenta("ULW → cycle=0 (LAST) after continue-cap"));
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
  if (promptTokens + completionTokens > 0) {
    const cost = estimateCostUsd(
      String(config.provider),
      promptTokens,
      completionTokens,
      config.model,
      cacheReadTokens,
    );
    events.onStatus?.(
      `tokens in=${formatTokens(promptTokens)} out=${formatTokens(completionTokens)} · est ${formatCost(cost)}`,
    );
  }

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
    lastErrCode === "max_cost" ||
    lastErrCode === "max_turns" ||
    lastErrCode.startsWith("continue_cap");
  if (!aborted && !keepLastError) {
    try {
      clearSessionLastError(session);
      saveSession(session);
    } catch {
      /* */
    }
  }

  return {
    finalText,
    turns,
    stopContinues,
    aborted,
    releasedOnContinueCap,
    hitMaxTurns,
    hitCostCap,
    finishReason: lastFinishReason,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    ...(runServedModels.size
      ? { servedModels: [...runServedModels] }
      : {}),
  };
}

/** Re-export for callers/tests that already import loop helpers. */
export { resolveMaxCostUsd, costCapStatus, formatCostBudgetLine };

/** Admit harness snapshot if changed; push as user message. */
function admitHarnessState(
  session: SessionData,
  config: ForgeConfig,
  opts?: { suppressCounterOnly?: boolean; git?: GitSnapshot | null },
): void {
  const snap = snapshotHarness({
    ulw: loadUlwCycle(session.meta.id),
    goal: loadGoal(session.meta.id),
    todos: session.todos,
    permissionMode: config.permissionMode,
    git: opts?.git,
  });
  const msg = admitHarnessIfChanged(session.meta.id, snap, {
    suppressCounterOnlyChanges: opts?.suppressCounterOnly,
  });
  if (msg) {
    session.messages.push({ role: "user", content: msg });
  }
}

/**
 * Safe provider-turn boundary: live slash notices + free-text interjections
 * + harness admissions (OpenCode-style admit at boundary, not async push).
 */
function drainSafeBoundaryMessages(
  session: SessionData,
  config: ForgeConfig,
  events?: LoopEvents,
  git?: GitSnapshot | null,
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
    try {
      const ulwNow = loadUlwCycle(session.meta.id);
      const goalNow = loadGoal(session.meta.id);
      const open = openTodos(session.todos);
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
    session.messages.push({
      role: "user",
      content: formatInterjectionsMessage(interjections, ijCtx),
    });
    events?.onStatus?.(
      `Queued mid-run message${interjections.length > 1 ? "s" : ""} from user`,
    );
  }

  // Harness may have changed via live /cycle etc. Counter-only churn (wave,
  // blocks, todo counts) is already visible to the model via re-anchors and
  // its own todo_write calls — only real changes (cycle/mandate/goal/mode)
  // earn a fresh admission message.
  admitHarnessState(session, config, { suppressCounterOnly: true, git });
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
  } = opts;

  // Sequential by default; batch consecutive read-only tools in parallel
  // but append results in original order (providers are picky about this).
  // Normalize names before the read-only check so aliases (Read/read_file)
  // and doubled stream-bug names still batch.
  let i = 0;
  while (i < toolCalls.length) {
    assertNotAborted(signal);
    if (isReadOnlyToolName(toolCalls[i].function.name)) {
      const batch: ToolCall[] = [];
      while (
        i < toolCalls.length &&
        isReadOnlyToolName(toolCalls[i].function.name) &&
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
  const toolDetail = argSummary ? `${name} ${argSummary}` : name;
  events?.onPhase?.("tool", toolDetail);

  const settle = () => {
    events?.onToolSettled?.(name);
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
    settle();
    return {
      toolCallId: tc.id,
      content: `HARD DENY [${hard.rule}]: ${hard.reason}`,
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
    settle();
    return {
      toolCallId: tc.id,
      content: `Tool denied by hook: ${pre.reason || "denied"}`,
    };
  }

  const perm = await permissions.request({
    toolName: name,
    input: toolInput,
    mode: config.permissionMode,
    workspace,
    config,
  });
  if (perm.decision === "deny") {
    await hooks.run("PermissionDenied", {
      ...baseHookCtx(session, config),
      toolName: name,
      toolInput,
    });
    settle();
    return {
      toolCallId: tc.id,
      content: `Tool denied by permission gate: ${perm.reason}${perm.rule ? ` [${perm.rule}]` : ""}`,
    };
  }

  if (events?.onToolStart) {
    events.onToolStart(name, toolInput);
  } else {
    console.error(formatToolStart(name, toolInput));
  }

  if (argsRepairNote && !parsedArgs.ok) {
    settle();
    if (events?.onToolEnd) {
      events.onToolEnd(name, { isError: true, ms: 0, bytes: 0 });
    }
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
        sandbox: config.sandbox,
        sandboxNetwork: config.sandboxNetwork,
        sandboxMissingBackend: config.sandboxMissingBackend,
        signal,
        fileReads,
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
  // Structural verification signal for the ULW wave ledger: a check command
  // actually executed this wave (pass or fail — running it is the behavior
  // the quality bar rewards; prose claims are not trusted on their own).
  // Background starts observe no exit code (fire-and-forget) — excluded by
  // countsTowardVerification; run the check in the foreground for it to count.
  // Session last-verify trail is success-only so experts don't trust a red run.
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
      if (!result.isError) {
        harnessStats.verificationPassedRuns += 1;
      }
      try {
        if (
          shouldStampLastVerification({
            command: cmd,
            isError: result.isError,
            preferredCheckCommands: preferred,
          })
        ) {
          session.meta.lastVerificationCommand = cmd.trim().slice(0, 240);
          session.meta.lastVerificationAt = new Date().toISOString();
        } else if (
          shouldClearLastVerification({
            command: cmd,
            isError: result.isError,
            preferredCheckCommands: preferred,
          })
        ) {
          // Red check invalidates any prior green trail so experts never
          // trust a stale last✓ after a failed re-run.
          delete session.meta.lastVerificationCommand;
          delete session.meta.lastVerificationAt;
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
        : extractDiffFromToolOutput(name, output),
      output,
    });
  } else {
    console.error(formatToolEnd(name, { isError: result.isError, ms, bytes }));
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
          "Change tool/args · re-read the file",
          "Do not retry the same denied mutation",
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
              "Re-read the real error · change tool/scope",
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
    }
  }

  return { toolCallId: tc.id, content };
}
