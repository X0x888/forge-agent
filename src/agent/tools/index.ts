import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import type { ToolDefinition } from "../../providers/types.js";
import { isWithinRoot } from "../../util/fs.js";

const execAsync = promisify(exec);

export interface ToolContext {
  workspace: string;
  onEdit?: () => void;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command in the workspace. Use for builds, tests, git, package managers. Prefer specialized tools for file reads/edits.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds (default 120000)",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file. Returns content with line numbers.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative or absolute)" },
          offset: { type: "number", description: "1-based start line" },
          limit: { type: "number", description: "Max lines to return" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_replace",
      description:
        "Replace an exact string in a file. old_string must match exactly once unless replace_all is true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regex pattern (ripgrep-like).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "File or directory (default: workspace)" },
          glob: { type: "string", description: "Glob filter e.g. *.ts" },
          case_insensitive: { type: "boolean" },
          head_limit: { type: "number" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description:
        "Update the session todo list. Use for multi-step tasks to track progress.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                },
              },
              required: ["id", "content", "status"],
            },
          },
          merge: { type: "boolean", description: "Merge by id (default true)" },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for up-to-date information. Returns titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          num_results: { type: "number", description: "Default 5, max 10" },
        },
        required: ["query"],
      },
    },
  },
];

function resolvePath(workspace: string, p: string): string {
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve(workspace, p);
}

function assertInWorkspace(workspace: string, target: string): void {
  // Allow reads outside with warning only for absolute paths explicitly outside —
  // writes must stay inside workspace for safety.
  if (!isWithinRoot(workspace, target)) {
    // Allow home/.forge for session tools
    if (target.includes(".forge")) return;
    throw new Error(
      `Path escapes workspace: ${target} (workspace: ${workspace}). Use a path under the project root.`,
    );
  }
}

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
  todoHandler?: (todos: unknown, merge: boolean) => string,
): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch {
    return { output: `Invalid JSON arguments: ${rawArgs}`, isError: true };
  }

  try {
    switch (name) {
      case "bash":
      case "run_terminal_command":
        return await toolBash(args, ctx);
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
      case "todo_write":
        if (!todoHandler) return { output: "todo_write not available", isError: true };
        return {
          output: todoHandler(args.todos, args.merge !== false),
        };
      case "web_search":
      case "WebSearch":
        return await toolWebSearch(args);
      default:
        return { output: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return { output: `Tool error: ${(err as Error).message}`, isError: true };
  }
}

async function toolBash(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const command = String(args.command || "");
  if (!command) return { output: "command is required", isError: true };
  const timeout = Number(args.timeout_ms) || 120_000;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: ctx.workspace,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    const out = [stdout, stderr].filter(Boolean).join("\n");
    return { output: out.slice(0, 100_000) || "(no output)" };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number;
    };
    const out = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
    return {
      output: out.slice(0, 100_000) || `Command failed (code ${e.code})`,
      isError: true,
    };
  }
}

async function toolRead(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const filePath = resolvePath(ctx.workspace, String(args.path || ""));
  const content = await fsp.readFile(filePath, "utf8");
  const lines = content.split("\n");
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Number(args.limit) || lines.length;
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice.map((l, i) => `${offset + i}|${l}`).join("\n");
  return { output: numbered || "(empty file)" };
}

async function toolWrite(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const filePath = resolvePath(ctx.workspace, String(args.path || ""));
  assertInWorkspace(ctx.workspace, filePath);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, String(args.content ?? ""), "utf8");
  ctx.onEdit?.();
  return { output: `Wrote ${filePath}` };
}

async function toolEdit(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const filePath = resolvePath(ctx.workspace, String(args.path || ""));
  assertInWorkspace(ctx.workspace, filePath);
  const oldStr = String(args.old_string ?? "");
  const newStr = String(args.new_string ?? "");
  const replaceAll = Boolean(args.replace_all);
  let content = await fsp.readFile(filePath, "utf8");
  if (!content.includes(oldStr)) {
    return { output: "old_string not found in file", isError: true };
  }
  if (!replaceAll) {
    const idx = content.indexOf(oldStr);
    const idx2 = content.indexOf(oldStr, idx + 1);
    if (idx2 !== -1) {
      return {
        output: "old_string matches multiple times; set replace_all or add context",
        isError: true,
      };
    }
    content = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
  } else {
    content = content.split(oldStr).join(newStr);
  }
  await fsp.writeFile(filePath, content, "utf8");
  ctx.onEdit?.();
  return { output: `Edited ${filePath}` };
}

async function toolGrep(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const pattern = String(args.pattern || "");
  const searchPath = args.path
    ? resolvePath(ctx.workspace, String(args.path))
    : ctx.workspace;
  const globPat = args.glob ? String(args.glob) : "**/*";
  const headLimit = Number(args.head_limit) || 50;
  const flags = args.case_insensitive ? "i" : "";
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return { output: `Invalid regex: ${pattern}`, isError: true };
  }

  const files = await glob(globPat, {
    cwd: searchPath,
    nodir: true,
    absolute: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    dot: false,
  });

  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= headLimit) break;
    let text: string;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const rel = path.relative(ctx.workspace, file);
        matches.push(`${rel}:${i + 1}:${lines[i]}`);
        if (matches.length >= headLimit) break;
      }
    }
  }
  return {
    output: matches.length ? matches.join("\n") : "No matches found",
  };
}

async function toolGlob(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const pattern = String(args.pattern || "");
  const cwd = args.path ? resolvePath(ctx.workspace, String(args.path)) : ctx.workspace;
  const files = await glob(pattern, {
    cwd,
    nodir: true,
    absolute: false,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  });
  files.sort();
  return {
    output: files.length ? files.slice(0, 200).join("\n") : "No files matched",
  };
}

async function toolWebSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query || "").trim();
  if (!query) return { output: "query is required", isError: true };
  const n = Math.min(10, Math.max(1, Number(args.num_results) || 5));

  // DuckDuckGo instant answer API (no key). Best-effort; not a full SERP.
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "ForgeAgent/0.1" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      return { output: `web_search HTTP ${resp.status}`, isError: true };
    }
    const data = (await resp.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: unknown[] }>;
      Results?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const lines: string[] = [];
    if (data.Heading || data.AbstractText) {
      lines.push(
        `## ${data.Heading || query}\n${data.AbstractText || ""}\n${data.AbstractURL || ""}`.trim(),
      );
    }
    const related = data.RelatedTopics || [];
    for (const item of related) {
      if (lines.length >= n + 1) break;
      if (item.Text && item.FirstURL) {
        lines.push(`- ${item.Text}\n  ${item.FirstURL}`);
      }
    }
    for (const item of data.Results || []) {
      if (lines.length >= n + 1) break;
      if (item.Text && item.FirstURL) {
        lines.push(`- ${item.Text}\n  ${item.FirstURL}`);
      }
    }
    if (!lines.length) {
      return {
        output: `No structured results for "${query}". Try a more specific query, or use bash with curl against a docs URL.`,
      };
    }
    return { output: lines.slice(0, n + 1).join("\n\n") };
  } catch (err) {
    return { output: `web_search failed: ${(err as Error).message}`, isError: true };
  }
}

// silence unused import warning for sync fs if any
void fs;
