import type { ToolContext, ToolResult, TodoHandler } from "./types.js";
import { TOOL_DEFINITIONS } from "./definitions.js";
import { toolBash } from "./bash.js";
import { toolRead } from "./read.js";
import { toolWrite } from "./write.js";
import { toolEdit } from "./edit.js";
import { toolApplyPatch } from "./apply-patch.js";
import { toolGrep } from "./grep.js";
import { toolGlob, toolListDir } from "./glob-list.js";
import { toolWebSearch } from "./web-search.js";
import { toolWebFetch } from "./web-fetch.js";
import { toolGetTaskOutput, toolKillTask } from "./task-tools.js";
import { toolAskUser } from "./ask-user.js";
import { toolExitPlanMode } from "./exit-plan-mode.js";
import {
  toolSearchMcp,
  toolCallMcp,
  toolMcpResource,
  toolMcpPrompt,
} from "../../mcp/tools.js";
import { toolLsp } from "../../lsp/tools.js";
import { toolSpawnSubagent } from "./subagent-tool.js";
import { toolMemoryWrite } from "./memory-write.js";
import { parseToolArguments } from "../../util/json-repair.js";
import { suggestNames } from "../../util/suggest.js";

export type { ToolContext, ToolResult } from "./types.js";
export { TOOL_DEFINITIONS };

const AVAILABLE =
  "bash, get_task_output, kill_task, read_file, write_file, search_replace, apply_patch, grep, glob, list_dir, todo_write, memory_write, ask_user, exit_plan_mode, web_search, web_fetch, search_mcp, call_mcp, mcp_resource, mcp_prompt, spawn_subagent, lsp";

/** Canonical tool ids (used for doubled-name recovery). */
const CANONICAL_TOOLS = [
  "bash",
  "get_task_output",
  "task_output",
  "kill_task",
  "read_file",
  "write_file",
  "search_replace",
  "apply_patch",
  "grep",
  "glob",
  "list_dir",
  "todo_write",
  "memory_write",
  "ask_user",
  "AskUser",
  "exit_plan_mode",
  "ExitPlanMode",
  "exitPlanMode",
  "question",
  "web_search",
  "web_fetch",
  "search_mcp",
  "call_mcp",
  "mcp_search",
  "mcp_call",
  "use_mcp",
  "mcp_resource",
  "mcp_prompt",
  "spawn_subagent",
  "Task",
  "task",
  "lsp",
  "LSP",
  "run_terminal_command",
  "Shell",
  "Bash",
  "shell",
  "read",
  "write",
  "edit",
  "StrReplace",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "ListDir",
  "WebSearch",
  "WebFetch",
  "ApplyPatch",
] as const;

/**
 * Recover from stream bugs that concatenate the tool name with itself
 * (e.g. `bashbash`, `todo_writetodo_write`).
 */
export function normalizeToolName(name: string): string {
  const raw = (name || "").trim();
  if (!raw) return raw;
  for (const c of CANONICAL_TOOLS) {
    if (raw === c) return c;
  }
  for (const c of CANONICAL_TOOLS) {
    // exact double / triple: bashbash, bashbashbash
    if (c.length > 0 && raw.length % c.length === 0) {
      const n = raw.length / c.length;
      if (n >= 2 && raw === c.repeat(n)) return c;
    }
  }
  return raw;
}

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
  todoHandler?: TodoHandler,
): Promise<ToolResult> {
  name = normalizeToolName(name);
  const parsed = parseToolArguments(rawArgs);
  if (!parsed.ok) {
    return {
      output: `Invalid JSON arguments for ${name}: ${parsed.error}\nRaw: ${parsed.raw}\nPlease rewrite the input as valid JSON.`,
      isError: true,
    };
  }
  const args = parsed.value;
  const repairNote =
    parsed.repaired && parsed.note
      ? `[json_arg_repair] ${parsed.note}\n\n`
      : parsed.repaired
        ? `[json_arg_repair] Tool arguments were auto-repaired before execution.\n\n`
        : "";

  try {
    const result = await (async (): Promise<ToolResult> => {
    switch (name) {
      case "bash":
      case "Bash":
      case "Shell":
      case "shell":
      case "run_terminal_command":
        return await toolBash(args, ctx);
      case "get_task_output":
      case "task_output":
        return await toolGetTaskOutput(args);
      case "kill_task":
        return await toolKillTask(args);
      case "read_file":
      case "Read":
      case "read":
        return await toolRead(args, ctx);
      case "write_file":
      case "Write":
      case "write":
        return await toolWrite(args, ctx);
      case "search_replace":
      case "Edit":
      case "edit":
      case "StrReplace":
        return await toolEdit(args, ctx);
      case "apply_patch":
      case "ApplyPatch":
        return await toolApplyPatch(args, ctx);
      case "grep":
      case "Grep":
        return await toolGrep(args, ctx);
      case "glob":
      case "Glob":
        return await toolGlob(args, ctx);
      case "list_dir":
      case "ListDir":
        return await toolListDir(args, ctx);
      case "todo_write": {
        if (!todoHandler) {
          return {
            output:
              "todo_write error: not available in this context (no session board). " +
              "Use the interactive agent / headless run loop — unit tests should pass a todoHandler.",
            isError: true,
          };
        }
        const out = todoHandler(args.todos, args.merge !== false);
        const isErr = /^todo_write error:/i.test(out);
        return { output: out, ...(isErr ? { isError: true as const } : {}) };
      }
      case "memory_write":
      case "decision_write":
        return await toolMemoryWrite(args, ctx);
      case "ask_user":
      case "AskUser":
      case "question":
        return await toolAskUser({
          question: String(args.question || ""),
          choices: Array.isArray(args.choices)
            ? args.choices.map((c: unknown) => String(c))
            : undefined,
          context:
            args.context != null ? String(args.context) : undefined,
        });
      case "exit_plan_mode":
      case "ExitPlanMode":
      case "exitPlanMode":
        return await toolExitPlanMode(
          { plan: args.plan != null ? String(args.plan) : undefined },
          { session: ctx.session, config: ctx.config },
        );
      case "web_search":
      case "WebSearch":
        return await toolWebSearch(args, ctx);
      case "web_fetch":
      case "WebFetch":
        return await toolWebFetch(args, ctx);
      case "search_mcp":
      case "mcp_search":
        return await toolSearchMcp(args, ctx);
      case "call_mcp":
      case "mcp_call":
      case "use_mcp":
        return await toolCallMcp(args, ctx);
      case "mcp_resource":
        return await toolMcpResource(args, ctx);
      case "mcp_prompt":
        return await toolMcpPrompt(args, ctx);
      case "spawn_subagent":
      case "Task":
      case "task":
        return await toolSpawnSubagent(args, ctx);
      case "lsp":
      case "LSP":
        return await toolLsp(args, ctx);
      default: {
        const tips = suggestNames(
          name,
          AVAILABLE.split(", ").concat([
            "Bash",
            "Shell",
            "Read",
            "Write",
            "Edit",
            "StrReplace",
            "ApplyPatch",
            "WebSearch",
            "WebFetch",
            "Task",
          ]),
          {
            minLength: 2,
            minScore: 36,
            requirePrefix3: false,
            limit: 3,
          },
        );
        return {
          output:
            (tips.length
              ? `Unknown tool: ${name}. Did you mean: ${tips.join(", ")}?\n`
              : `Unknown tool: ${name}.\n`) +
            `Available: ${AVAILABLE}.`,
          isError: true,
        };
      }
    }
    })();
    let out = result;
    if (
      out.isError &&
      typeof out.output === "string" &&
      /^Aborted\.?$/i.test(out.output.trim())
    ) {
      out = {
        ...out,
        // Keep leading "Aborted" so error-streak / cancel classifiers still match.
        output: `Aborted: ${name} (turn cancel / timeout / Ctrl+C).`,
      };
    }
    if (repairNote && typeof out.output === "string") {
      out = { ...out, output: repairNote + out.output };
    }
    return out;
  } catch (err) {
    return { output: `Tool error: ${(err as Error).message}`, isError: true };
  }
}
