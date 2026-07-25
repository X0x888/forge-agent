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
import { parseToolArguments } from "../../util/json-repair.js";

export type { ToolContext, ToolResult } from "./types.js";
export { TOOL_DEFINITIONS };

const AVAILABLE =
  "bash, get_task_output, kill_task, read_file, write_file, search_replace, apply_patch, grep, glob, list_dir, todo_write, web_search, web_fetch";

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
  "web_search",
  "web_fetch",
  "run_terminal_command",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "ListDir",
  "WebSearch",
  "WebFetch",
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
