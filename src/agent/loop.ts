import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import type { LLMProvider, ChatMessage, ToolCall } from "../providers/types.js";
import type { SessionData, TodoItem } from "../session/session.js";
import {
  saveSession,
  estimateTokens,
  compactMessages,
} from "../session/session.js";
import { HookRunner, type HookContext } from "../harness/hooks.js";
import { runStopGuard } from "../harness/stop-guard.js";
import { loadGoal, detectAutoGoal, armGoal } from "../harness/goal.js";
import { PermissionGate } from "./permissions.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { log } from "../util/log.js";

export interface LoopOptions {
  config: ForgeConfig;
  provider: LLMProvider;
  session: SessionData;
  hooks: HookRunner;
  permissions: PermissionGate;
  userMessage: string;
  stream?: boolean;
  onToken?: (token: string) => void;
  /** Max stop-continue cycles for goal/hooks (safety) */
  maxStopContinues?: number;
}

export interface LoopResult {
  finalText: string;
  turns: number;
  stopContinues: number;
  aborted: boolean;
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

export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult> {
  const {
    config,
    provider,
    session,
    hooks,
    permissions,
    userMessage,
    stream = true,
  } = opts;
  const maxStopContinues = opts.maxStopContinues ?? 50;
  const workspace = config.workspace || session.meta.cwd;

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

  // UserPromptSubmit hook
  await hooks.run("UserPromptSubmit", {
    ...baseHookCtx(session, config),
    prompt: userMessage,
  });

  // Ensure system message
  const goal = loadGoal(session.meta.id);
  const system = buildSystemPrompt({
    config,
    workspace,
    goal,
    ultrawork: session.meta.ultrawork,
  });
  if (session.messages.length === 0 || session.messages[0]?.role !== "system") {
    session.messages.unshift({ role: "system", content: system });
  } else {
    session.messages[0] = { role: "system", content: system };
  }

  session.messages.push({ role: "user", content: userMessage });
  session.meta.turnCount += 1;
  saveSession(session);

  let turns = 0;
  let stopContinues = 0;
  let finalText = "";
  const maxTurns = config.maxTurns > 0 ? config.maxTurns : 200;

  while (turns < maxTurns) {
    turns += 1;

    // Auto-compact
    const est = estimateTokens(session.messages);
    if (est > config.contextWindow * config.autoCompactThreshold) {
      await hooks.run("PreCompact", baseHookCtx(session, config));
      session.messages = compactMessages(session.messages);
      await hooks.run("PostCompact", baseHookCtx(session, config));
      saveSession(session);
      log.dim("Compacted conversation history");
    }

    // Call model
    let response;
    try {
      if (stream && opts.onToken) {
        process.stderr.write(chalk.dim("\n"));
        response = await provider.chatStream(
          {
            model: config.model,
            messages: session.messages,
            tools: TOOL_DEFINITIONS,
            temperature: config.temperature,
            max_tokens: config.maxTokens,
          },
          (delta) => {
            if (delta.content) {
              opts.onToken?.(delta.content);
            }
          },
        );
        process.stderr.write("\n");
      } else {
        response = await provider.chat({
          model: config.model,
          messages: session.messages,
          tools: TOOL_DEFINITIONS,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
        });
        if (response.message.content && opts.onToken) {
          opts.onToken(response.message.content);
        }
      }
    } catch (err) {
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
      // Attempt stop — may be blocked by harness
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
        if (stopResult.systemMessage) {
          log.dim(stopResult.systemMessage);
        }
        break;
      }

      // Blocked — inject re-anchor and continue
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
      log.info(chalk.magenta(`↻ Stop blocked by harness (continue #${stopContinues})`));
      log.dim(inject.slice(0, 300));
      session.messages.push({
        role: "user",
        content: inject,
      });
      saveSession(session);
      continue;
    }

    // Execute tool calls
    await runToolCalls({
      toolCalls,
      session,
      config,
      hooks,
      permissions,
      workspace,
    });
  }

  return {
    finalText,
    turns,
    stopContinues,
    aborted: false,
  };
}

async function runToolCalls(opts: {
  toolCalls: ToolCall[];
  session: SessionData;
  config: ForgeConfig;
  hooks: HookRunner;
  permissions: PermissionGate;
  workspace: string;
}): Promise<void> {
  const { toolCalls, session, config, hooks, permissions, workspace } = opts;

  for (const tc of toolCalls) {
    const name = tc.function.name;
    let toolInput: Record<string, unknown> = {};
    try {
      toolInput = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      toolInput = { raw: tc.function.arguments };
    }

    // PreToolUse
    const pre = await hooks.run("PreToolUse", {
      ...baseHookCtx(session, config),
      toolName: name,
      toolInput,
      toolUseId: tc.id,
    });

    if (pre.blocked || pre.decision === "deny") {
      session.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `Tool denied by hook: ${pre.reason || "denied"}`,
      });
      await hooks.run("PermissionDenied", {
        ...baseHookCtx(session, config),
        toolName: name,
        toolInput,
      });
      continue;
    }

    // Permission gate
    const perm = await permissions.request({
      toolName: name,
      input: toolInput,
      mode: config.permissionMode,
    });
    if (perm === "deny") {
      session.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: "Tool denied by permission gate",
      });
      await hooks.run("PermissionDenied", {
        ...baseHookCtx(session, config),
        toolName: name,
        toolInput,
      });
      continue;
    }

    log.dim(`→ ${name}(${summarizeArgs(toolInput)})`);

    const result = await executeTool(
      name,
      tc.function.arguments,
      {
        workspace,
        onEdit: () => {
          session.meta.editCount += 1;
        },
      },
      (todos, merge) => applyTodos(session, todos, merge),
    );

    if (result.isError) {
      await hooks.run("PostToolUseFailure", {
        ...baseHookCtx(session, config),
        toolName: name,
        toolInput,
        toolOutput: result.output,
        toolUseId: tc.id,
      });
    } else {
      await hooks.run("PostToolUse", {
        ...baseHookCtx(session, config),
        toolName: name,
        toolInput,
        toolOutput: result.output,
        toolUseId: tc.id,
      });
    }

    session.messages.push({
      role: "tool",
      tool_call_id: tc.id,
      content: result.output,
    });
    saveSession(session);
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}
