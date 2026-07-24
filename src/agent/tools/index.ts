import type { ToolContext, ToolResult, TodoHandler } from "./types.js";
import { TOOL_DEFINITIONS } from "./definitions.js";
import { toolBash } from "./bash.js";
import { toolRead } from "./read.js";
import { toolWrite } from "./write.js";
import { toolEdit } from "./edit.js";
import { toolGrep } from "./grep.js";
import { toolGlob, toolListDir } from "./glob-list.js";
import { toolWebSearch } from "./web-search.js";
import { toolWebFetch } from "./web-fetch.js";
import { toolGetTaskOutput, toolKillTask } from "./task-tools.js";

export type { ToolContext, ToolResult } from "./types.js";
export { TOOL_DEFINITIONS };

const AVAILABLE =
  "bash, get_task_output, kill_task, read_file, write_file, search_replace, grep, glob, list_dir, todo_write, web_search, web_fetch";

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
  todoHandler?: TodoHandler,
): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch {
    return {
      output: `Invalid JSON arguments for ${name}: ${rawArgs}\nPlease rewrite the input as valid JSON.`,
      isError: true,
    };
  }

  try {
    switch (name) {
      case "bash":
      case "run_terminal_command":
        return await toolBash(args, ctx);
      case "get_task_output":
      case "task_output":
        return await toolGetTaskOutput(args);
      case "kill_task":
        return await toolKillTask(args);
      case "read_file":
      case "Read":
        return await toolRead(args, ctx);
      case "write_file":
      case "Write":
        return await toolWrite(args, ctx);
      case "search_replace":
      case "Edit":
        return await toolEdit(args, ctx);
      case "grep":
      case "Grep":
        return await toolGrep(args, ctx);
      case "glob":
      case "Glob":
        return await toolGlob(args, ctx);
      case "list_dir":
      case "ListDir":
        return await toolListDir(args, ctx);
      case "todo_write":
        if (!todoHandler) return { output: "todo_write not available", isError: true };
        return {
          output: todoHandler(args.todos, args.merge !== false),
        };
      case "web_search":
      case "WebSearch":
        return await toolWebSearch(args);
      case "web_fetch":
      case "WebFetch":
        return await toolWebFetch(args);
      default:
        return {
          output: `Unknown tool: ${name}. Available: ${AVAILABLE}.`,
          isError: true,
        };
    }
  } catch (err) {
    return { output: `Tool error: ${(err as Error).message}`, isError: true };
  }
}
