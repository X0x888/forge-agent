import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import type { ToolDefinition } from "../../providers/types.js";
import { isWithinRoot } from "../../util/fs.js";
import { truncateMiddle } from "../../util/format.js";

const execAsync = promisify(exec);

export interface ToolContext {
  workspace: string;
  onEdit?: () => void;
  /** OS sandbox profile for bash */
  sandbox?: import("../../config/types.js").SandboxProfile;
  sandboxNetwork?: import("../../config/types.js").SandboxNetwork;
  sandboxMissingBackend?: import("../../config/types.js").SandboxMissingBackend;
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
      name: "list_dir",
      description: "List entries in a directory (names + type). Prefer over bash ls.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to workspace (default: .)",
          },
        },
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
  // Writes must stay inside workspace (or the real ~/.forge home for session files).
  if (!isWithinRoot(workspace, target)) {
    const forgeHome =
      process.env.FORGE_HOME?.trim() ||
      path.join(process.env.HOME || "", ".forge");
    if (forgeHome && isWithinRoot(path.resolve(forgeHome), target)) return;
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
  const profile = ctx.sandbox ?? "workspace";
  const missingBackend = ctx.sandboxMissingBackend ?? "fail-closed";

  try {
    const { execCommandSandboxed } = await import("./sandbox-exec.js");
    const result = await execCommandSandboxed({
      command,
      cwd: ctx.workspace,
      timeoutMs: timeout,
      profile,
      network: ctx.sandboxNetwork,
      missingBackend,
      env: process.env,
    });
    if (result.failClosed) {
      return {
        output: truncateMiddle(
          result.stderr ||
            "Sandbox backend unavailable (fail-closed). Install bwrap / Xcode CLT, or set sandbox=off.",
        ),
        isError: true,
      };
    }
    const out = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const net = result.network ? ` net=${result.network}` : "";
    const meta = result.sandboxed
      ? `[sandbox:${result.backend}${net}] `
      : result.warning
        ? `[sandbox:off — ${result.warning}] `
        : "";
    if (result.code && result.code !== 0) {
      return {
        output: truncateMiddle(
          meta + (out || `Command failed (code ${result.code})`),
        ),
        isError: true,
      };
    }
    return { output: truncateMiddle(meta + (out || "(no output)")) };
  } catch (err) {
    // Only fall back to plain exec when sandbox is explicitly off or fallback mode
    if (profile !== "off" && missingBackend === "fail-closed") {
      return {
        output: truncateMiddle(
          `Sandbox error (fail-closed): ${(err as Error).message}`,
        ),
        isError: true,
      };
    }
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: ctx.workspace,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      });
      const out = [stdout, stderr].filter(Boolean).join("\n");
      return {
        output: truncateMiddle(
          `[sandbox:fallback] ${out || "(no output)"}`,
        ),
      };
    } catch (err2) {
      const e = err2 as {
        stdout?: string;
        stderr?: string;
        message?: string;
        code?: number;
      };
      const out = [e.stdout, e.stderr, e.message, (err as Error).message]
        .filter(Boolean)
        .join("\n");
      return {
        output: truncateMiddle(out || `Command failed (code ${e.code})`),
        isError: true,
      };
    }
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
  const numbered = slice.map((l, i) => `${String(offset + i).padStart(6)}|${l}`).join("\n");
  const header =
    lines.length > slice.length
      ? `File: ${path.relative(ctx.workspace, filePath) || filePath} (${lines.length} lines, showing ${offset}-${offset + slice.length - 1})\n`
      : `File: ${path.relative(ctx.workspace, filePath) || filePath} (${lines.length} lines)\n`;
  return { output: truncateMiddle(header + (numbered || "(empty file)"), 120_000) };
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

async function toolListDir(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const rel = String(args.path || ".");
  const dir = resolvePath(ctx.workspace, rel);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const lines = entries
    .filter((e) => e.name !== ".git" && e.name !== "node_modules")
    .slice(0, 500)
    .map((e) => {
      const kind = e.isDirectory() ? "dir " : e.isSymbolicLink() ? "link" : "file";
      return `${kind}  ${e.name}${e.isDirectory() ? "/" : ""}`;
    });
  return {
    output: lines.length
      ? `${path.relative(ctx.workspace, dir) || "."}\n${lines.join("\n")}`
      : "(empty directory)",
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
