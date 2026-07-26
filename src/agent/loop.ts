import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import { resolveReasoningEffort } from "../config/reasoning.js";
import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  ToolCall,
} from "../providers/types.js";
import type { SessionData, TodoItem } from "../session/session.js";
import {
  saveSession,
  estimateTokens,
  estimateRequestTokens,
  compactMessages,
  maybeSetTitle,
  markUserTurn,
  pruneOversizedMessageBodies,
} from "../session/session.js";
import { appendFileMutation } from "../session/mutations.js";
import { HookRunner, type HookContext } from "../harness/hooks.js";
import { runStopGuard } from "../harness/stop-guard.js";
import { loadGoal, detectAutoGoal, armGoal } from "../harness/goal.js";
import {
  loadUlwCycle,
  armUlwCycle,
  ulwKickoffMessage,
  isSoftPrompt,
  formatUlwCounts,
  formatUlwBadge,
  ULW_LIVE_CONTROLS_HINT,
} from "../harness/ulw-cycle.js";
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
import { refreshCredentialIfNeeded, isAuthFailureMessage } from "../auth/refresh.js";
import { resolveAuth } from "../auth/resolve.js";
import { isProviderApiError } from "../providers/errors.js";
import {
  formatToolStart,
  formatToolEnd,
  truncateMiddle,
  formatTokens,
  estimateCostUsd,
  formatCost,
  formatRetryWait,
  summarizeToolArgs,
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
    result: { isError?: boolean; ms: number; bytes: number },
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
  promptTokens: number;
  completionTokens: number;
}

const READ_ONLY = new Set([
  "read_file",
  "Read",
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

/** Build provider chat request including reasoning_effort when supported. */
export function buildChatRequest(
  config: ForgeConfig,
  messages: ChatMessage[],
): ChatRequest {
  const effort = resolveReasoningEffort(config.model, config.reasoningEffort);
  return {
    model: config.model,
    messages,
    tools: TOOL_DEFINITIONS,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    ...(effort ? { reasoning_effort: effort } : {}),
  };
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

function openTodos(todos: TodoItem[]): number {
  return todos.filter((t) => t.status === "pending" || t.status === "in_progress").length;
}

function applyTodos(
  session: SessionData,
  todos: unknown,
  merge: boolean,
): string {
  const incoming = (Array.isArray(todos) ? todos : []) as TodoItem[];
  if (!merge) {
    session.todos = incoming;
  } else {
    const map = new Map(session.todos.map((t) => [t.id, t]));
    for (const t of incoming) {
      const prev = map.get(t.id);
      map.set(t.id, { ...prev, ...t });
    }
    session.todos = [...map.values()];
  }
  saveSession(session);
  return `Todos updated (${session.todos.length} items, ${openTodos(session.todos)} open):\n${session.todos
    .map((t) => `- [${t.status}] ${t.id}: ${t.content}`)
    .join("\n")}`;
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
  let authRefreshAttempted = false;
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
  const startPrompt = session.meta.totalPromptTokens;
  const startComp = session.meta.totalCompletionTokens;
  const doomLoop = new DoomLoopTracker({
    threshold: envPositiveInt("FORGE_DOOM_LOOP_THRESHOLD", 3),
  });
  const errorStreak = new ErrorStreakTracker({
    threshold: envPositiveInt("FORGE_ERROR_STREAK_THRESHOLD", 5),
  });

  // Auto-arm goal from prose
  if (config.goal.autoArm && config.goal.enabled) {
    const existing = loadGoal(session.meta.id);
    if (!existing?.objective || existing.status === "cleared") {
      const detected = detectAutoGoal(userMessage);
      if (detected) {
        armGoal(session.meta.id, detected, "auto");
        log.info(`Auto-armed /goal: ${detected.slice(0, 100)}`);
      }
    }
  }

  // If session is already in ULW but cycle state missing, (re)arm from this message
  let effectiveUserMessage = userMessage;
  if (session.meta.ultrawork) {
    let ulw = loadUlwCycle(session.meta.id);
    if (!ulw?.enabled) {
      ulw = armUlwCycle(session.meta.id, userMessage, { cycle: 1 });
      log.info(
        `ULW cycle armed (cycle=1)${ulw.softPrompt ? " — soft prompt expanded to god-scope" : ""}`,
      );
      effectiveUserMessage = ulwKickoffMessage(ulw);
    } else if (isSoftPrompt(userMessage) && !userMessage.includes("ULW runtime controls")) {
      // Soft follow-ups under ULW still get cycle framing without resetting wave hard
      const refreshed = armUlwCycle(session.meta.id, userMessage, {
        cycle: ulw.cycle,
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

  // Baseline system only — live ULW/goal counters admitted mid-conversation
  const system = buildBaselineSystemPrompt({
    config,
    workspace,
    ultrawork: session.meta.ultrawork || Boolean(ulwCycle?.enabled),
    ulwCycle,
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

  // Admit initial harness snapshot (ULW/goal/todos) once at prompt start
  admitHarnessState(session, config);

  saveSession(session);

  let turns = 0;
  let stopContinues = 0;
  let finalText = "";
  let aborted = false;
  let overflowCompactAttempted = false;
  const maxTurns = config.maxTurns > 0 ? config.maxTurns : 200;
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
    });
    const healed = repairToolCallPairing(session.messages);
    if (healed.changed) session.messages = healed.messages;
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
    admitHarnessState(session, config);
    saveSession(session);
  };

  /** After a no-op threshold compact, don't re-attempt until messages grow. */
  let skipThresholdCompactUntilCount = 0;

  try {
    while (turns < maxTurns) {
      assertNotAborted(signal);
      turns += 1;

      // Include tool-schema overhead; chars/3.2 estimate (see estimateTokens).
      const est = requestTokenEstimate();
      const overThreshold =
        est > config.contextWindow * config.autoCompactThreshold;
      // Hard headroom: even if under auto_compact_threshold, don't ride the
      // provider's absolute max (xAI rejects at model max prompt length).
      const nearHardLimit = est > config.contextWindow * 0.92;
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
        } else {
          skipThresholdCompactUntilCount = 0;
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
      drainSafeBoundaryMessages(session, config, events);

      // Soft todo nudge under ULW/goal (does not block)
      const nudge = maybeTodoNudge({
        sessionId: session.meta.id,
        harnessActive,
        openTodoCount: openTodos(session.todos),
      });
      if (nudge) {
        session.messages.push({ role: "user", content: nudge });
        saveSession(session);
        events.onStatus?.("Todo nudge");
      }

      events.onPhase?.("thinking");
      let response: Awaited<ReturnType<typeof provider.chat>> | undefined;
      try {
        const doChat = () =>
          withRetry(
            async () => {
              assertNotAborted(signal);
              if (stream && events.onToken) {
                return provider.chatStream(
                  buildChatRequest(config, session.messages),
                  (delta) => {
                    if (signal?.aborted) return;
                    if (delta.content) events.onToken?.(delta.content);
                  },
                  signal,
                );
              }
              const r = await provider.chat(
                buildChatRequest(config, session.messages),
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
            // One-shot OAuth recovery: 401/expired bearer mid-session
            const msg = err instanceof Error ? err.message : String(err);
            const authFail =
              isAuthFailureMessage(msg) ||
              (isProviderApiError(err) &&
                (err.status === 401 || err.status === 403));
            if (!authFail || authRefreshAttempted) throw err;
            authRefreshAttempted = true;
            events.onStatus?.("Auth failure — attempting token refresh…");
            const refreshed = await refreshCredentialIfNeeded(
              String(config.provider),
              { force: true },
            );
            if (!refreshed.ok || !refreshed.credential) {
              throw err;
            }
            const auth = resolveAuth(config);
            if (!auth?.token || !provider.updateCredentials) {
              throw err;
            }
            provider.updateCredentials(auth.token);
            log.info(
              "Refreshed credentials after auth failure — retrying chat",
            );
            events.onStatus?.("Credentials refreshed — retrying");
            response = await doChat();
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

      if (response.usage) {
        session.meta.totalPromptTokens += response.usage.prompt_tokens;
        session.meta.totalCompletionTokens += response.usage.completion_tokens;
      }

      const assistantMsg = response.message;
      session.messages.push(assistantMsg);
      finalText = assistantMsg.content || "";
      noteAssistantTurn(session.meta.id);
      saveSession(session);

      const toolCalls = assistantMsg.tool_calls;
      const finishReason = response.finish_reason || "";

      // Output truncated by max_tokens — continue generation instead of Stop
      if (
        (!toolCalls || toolCalls.length === 0) &&
        (finishReason === "length" || finishReason === "max_tokens")
      ) {
        stopContinues += 1;
        if (stopContinues > maxStopContinues) {
          log.warn("max_tokens continuation cap reached — releasing");
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
          `[Forge] The provider blocked this response (finish_reason=${finishReason}). Rephrase the request or continue with a narrower scope.`;
        stopContinues += 1;
        // Cap check before injecting steerage — avoid orphan user msgs when releasing.
        if (stopContinues > maxStopContinues) {
          log.warn("content-filter continue cap reached — releasing");
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

      // Empty assistant turn (provider glitch) — nudge once
      if (
        (!toolCalls || toolCalls.length === 0) &&
        !(finalText || "").trim()
      ) {
        stopContinues += 1;
        if (stopContinues > maxStopContinues) {
          log.warn("empty-response continue cap reached — releasing");
          break;
        }
        log.warn(
          `Empty model response (finish_reason=${finishReason || "unknown"}) — nudging continue #${stopContinues}`,
        );
        session.messages.push({
          role: "user",
          content:
            "[Forge] Previous model response was empty. Continue the task: think briefly, then act with tools or a concrete reply. Do not stop.",
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
        const stopResult = await runStopGuard({
          config,
          hooks,
          ctx: baseHookCtx(session, config),
          ultrawork: session.meta.ultrawork,
          openTodoCount: openTodos(session.todos),
          editCount: session.meta.editCount,
          lastAssistantMessage: finalText,
        });

        if (stopResult.allowStop) {
          if (stopResult.systemMessage) log.dim(stopResult.systemMessage);
          break;
        }

        stopContinues += 1;
        if (stopContinues > maxStopContinues) {
          log.warn(
            `Stop-continue cap (${maxStopContinues}) reached — releasing to prevent infinite loop`,
          );
          break;
        }

        const inject =
          stopResult.additionalContext ||
          stopResult.reason ||
          "Stop was blocked. Continue working.";
        const ulwAfter = loadUlwCycle(session.meta.id);
        if (ulwAfter?.enabled) {
          log.info(
            chalk.magenta(
              `↻ ULW ${formatUlwCounts(ulwAfter)} — Stop blocked (continue #${stopContinues})`,
            ),
          );
          log.dim(ULW_LIVE_CONTROLS_HINT);
        } else if (stopResult.todoGate) {
          log.info(
            chalk.magenta(
              `↻ TodoGate blocked Stop (continue #${stopContinues})`,
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
        // Re-admit harness after stop re-anchor (wave/blocks may have changed)
        admitHarnessState(session, config);
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
      throw err;
    }
  }

  const promptTokens = session.meta.totalPromptTokens - startPrompt;
  const completionTokens = session.meta.totalCompletionTokens - startComp;
  if (promptTokens + completionTokens > 0) {
    const cost = estimateCostUsd(
      String(config.provider),
      promptTokens,
      completionTokens,
    );
    events.onStatus?.(
      `tokens in=${formatTokens(promptTokens)} out=${formatTokens(completionTokens)} · est ${formatCost(cost)}`,
    );
  }

  return {
    finalText,
    turns,
    stopContinues,
    aborted,
    promptTokens,
    completionTokens,
  };
}

/** Admit harness snapshot if changed; push as user message. */
function admitHarnessState(
  session: SessionData,
  config: ForgeConfig,
): void {
  const snap = snapshotHarness({
    ulw: loadUlwCycle(session.meta.id),
    goal: loadGoal(session.meta.id),
    todos: session.todos,
    permissionMode: config.permissionMode,
  });
  const msg = admitHarnessIfChanged(session.meta.id, snap);
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
    session.messages.push({
      role: "user",
      content: formatInterjectionsMessage(interjections),
    });
    events?.onStatus?.(
      `Queued mid-run message${interjections.length > 1 ? "s" : ""} from user`,
    );
  }

  // Harness may have changed via live /cycle etc.
  admitHarnessState(session, config);
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
  } = opts;

  // Sequential by default; batch consecutive read-only tools in parallel
  // but append results in original order (providers are picky about this).
  let i = 0;
  while (i < toolCalls.length) {
    assertNotAborted(signal);
    if (READ_ONLY.has(toolCalls[i].function.name)) {
      const batch: ToolCall[] = [];
      while (
        i < toolCalls.length &&
        READ_ONLY.has(toolCalls[i].function.name) &&
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
        content = `${content}\n\n${hit.message}`;
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
        onEdit: () => {
          session.meta.editCount += 1;
        },
        recordMutation: (input) => {
          appendFileMutation(session.meta.id, {
            path: input.path,
            kind: input.kind,
            before: input.before,
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
  const ms = Date.now() - t0;
  const output = truncateMiddle(result.output);
  const bytes = Buffer.byteLength(output, "utf8");

  if (events?.onToolEnd) {
    events.onToolEnd(name, { isError: result.isError, ms, bytes });
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
  }

  // Error-streak circuit breaker (different tools failing in a row)
  if (errorStreak) {
    if (isCountableToolError(content, result.isError)) {
      const hit = errorStreak.observeError(name, summarizeToolError(content));
      if (hit) {
        log.warn(hit.message.split("\n")[0] || "error-streak");
        events?.onStatus?.(`error-streak: ${hit.count} consecutive tool errors`);
        content = `${content}\n\n${hit.message}`;
      }
    } else if (!result.isError) {
      errorStreak.observeSuccess();
    }
  }

  return { toolCallId: tc.id, content };
}
