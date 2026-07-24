import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import type { LLMProvider, ToolCall } from "../providers/types.js";
import type { SessionData, TodoItem } from "../session/session.js";
import {
  saveSession,
  estimateTokens,
  compactMessages,
  maybeSetTitle,
  markUserTurn,
} from "../session/session.js";
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
import { PermissionGate } from "./permissions.js";
import { hardSafetyCheck } from "./safety.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { log } from "../util/log.js";
import { withRetry } from "../util/retry.js";
import {
  formatToolStart,
  formatToolEnd,
  truncateMiddle,
  formatTokens,
  estimateCostUsd,
  formatCost,
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
    provider,
    session,
    hooks,
    permissions,
    userMessage,
    stream = true,
    signal,
  } = opts;
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
    (ulwArmed ? Number(process.env.FORGE_ULW_MAX_CONTINUES) || 200 : 50);
  const workspace = config.workspace || session.meta.cwd;
  const startPrompt = session.meta.totalPromptTokens;
  const startComp = session.meta.totalCompletionTokens;

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
  const system = buildSystemPrompt({
    config,
    workspace,
    goal,
    ultrawork: session.meta.ultrawork || Boolean(ulwCycle?.enabled),
    ulwCycle,
  });
  if (session.messages.length === 0 || session.messages[0]?.role !== "system") {
    session.messages.unshift({ role: "system", content: system });
  } else {
    session.messages[0] = { role: "system", content: system };
  }

  maybeSetTitle(session, userMessage);
  markUserTurn(session);
  session.messages.push({ role: "user", content: effectiveUserMessage });
  session.meta.turnCount += 1;
  saveSession(session);

  let turns = 0;
  let stopContinues = 0;
  let finalText = "";
  let aborted = false;
  const maxTurns = config.maxTurns > 0 ? config.maxTurns : 200;

  try {
    while (turns < maxTurns) {
      assertNotAborted(signal);
      turns += 1;

      const est = estimateTokens(session.messages);
      if (est > config.contextWindow * config.autoCompactThreshold) {
        events.onPhase?.("compacting");
        events.onStatus?.("Compacting conversation…");
        await hooks.run("PreCompact", baseHookCtx(session, config));
        session.messages = compactMessages(session.messages);
        await hooks.run("PostCompact", baseHookCtx(session, config));
        saveSession(session);
        log.dim("Compacted conversation history");
      }

      // Mid-run user controls (/cycle, /ulw-off, /goal pause, …) enqueue notices
      // so the model sees them on the next call without aborting the turn.
      const liveNotices = drainLiveNotices(session.meta.id);
      if (liveNotices.length) {
        session.messages.push({
          role: "user",
          content: formatLiveNoticesMessage(liveNotices),
        });
        saveSession(session);
        events.onStatus?.(
          `Applied mid-run control${liveNotices.length > 1 ? "s" : ""}`,
        );
      }

      events.onPhase?.("thinking");
      let response;
      try {
        response = await withRetry(
          async () => {
            assertNotAborted(signal);
            if (stream && events.onToken) {
              return provider.chatStream(
                {
                  model: config.model,
                  messages: session.messages,
                  tools: TOOL_DEFINITIONS,
                  temperature: config.temperature,
                  max_tokens: config.maxTokens,
                },
                (delta) => {
                  if (signal?.aborted) return;
                  if (delta.content) events.onToken?.(delta.content);
                },
              );
            }
            const r = await provider.chat({
              model: config.model,
              messages: session.messages,
              tools: TOOL_DEFINITIONS,
              temperature: config.temperature,
              max_tokens: config.maxTokens,
            });
            if (r.message.content && events.onToken) {
              events.onToken(r.message.content);
            }
            return r;
          },
          { retries: 3, label: `${config.provider} chat`, signal },
        );
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

      if (response.usage) {
        session.meta.totalPromptTokens += response.usage.prompt_tokens;
        session.meta.totalCompletionTokens += response.usage.completion_tokens;
      }

      const assistantMsg = response.message;
      session.messages.push(assistantMsg);
      finalText = assistantMsg.content || "";
      saveSession(session);

      const toolCalls = assistantMsg.tool_calls;
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
        } else {
          log.info(
            chalk.magenta(
              `↻ Stop blocked by harness (continue #${stopContinues})`,
            ),
          );
        }
        log.dim(inject.slice(0, 300));
        session.messages.push({ role: "user", content: inject });
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
      });
      events.onPhase?.("thinking");
    }
  } catch (err) {
    if ((err as Error).message === "Aborted" || signal?.aborted) {
      aborted = true;
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

async function runToolCalls(opts: {
  toolCalls: ToolCall[];
  session: SessionData;
  config: ForgeConfig;
  hooks: HookRunner;
  permissions: PermissionGate;
  workspace: string;
  signal?: AbortSignal;
  events?: LoopEvents;
}): Promise<void> {
  const { toolCalls, session, config, hooks, permissions, workspace, signal, events } =
    opts;

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
}): Promise<{ toolCallId: string; content: string }> {
  const { tc, session, config, hooks, permissions, workspace, signal, events } = opts;
  assertNotAborted(signal);

  const name = tc.function.name;
  let toolInput: Record<string, unknown> = {};
  try {
    toolInput = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    toolInput = { raw: tc.function.arguments };
  }

  // Announce tool phase BEFORE permission prompts so the REPL can pause
  // the working spinner and not clobber interactive Allow? lines.
  const toolDetail =
    typeof toolInput.command === "string"
      ? `${name} ${String(toolInput.command).slice(0, 40)}`
      : typeof toolInput.path === "string"
        ? `${name} ${String(toolInput.path).slice(0, 40)}`
        : name;
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

  const t0 = Date.now();
  let result;
  try {
    result = await executeTool(
      name,
      tc.function.arguments,
      {
        workspace,
        sandbox: config.sandbox,
        sandboxNetwork: config.sandboxNetwork,
        sandboxMissingBackend: config.sandboxMissingBackend,
        onEdit: () => {
          session.meta.editCount += 1;
        },
      },
      (todos, merge) => applyTodos(session, todos, merge),
    );
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

  return { toolCallId: tc.id, content: output };
}
