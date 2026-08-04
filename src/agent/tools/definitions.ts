import type { ToolDefinition } from "../../providers/types.js";

/**
 * Model-facing tool schemas (OpenCode/Grok-inspired).
 * Descriptions carry only what changes how the model calls the tool —
 * failure-mode recovery lives in the error messages themselves, not here.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command in the workspace (builds, tests, git, package managers). " +
        "Do NOT use for file reads/edits/search/list — prefer read_file, search_replace, grep, glob, list_dir. " +
        "Set background=true for long jobs (returns task_id; poll with get_task_output, stop with kill_task). " +
        "Cloud metadata endpoints (IMDS) and file:// fetches are hard-denied. " +
        "Timeout default 120s foreground / 30m background.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          timeout_ms: {
            type: "number",
            description:
              "Timeout in ms (default 120000 foreground / 30m background). Aliases: default|max|all; duration suffixes 30s/1m/2h.",
          },
          background: {
            type: "boolean",
            description: "If true, start in background and return task_id immediately",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_task_output",
      description:
        "Read status and recent stdout/stderr of a background bash task by task_id. " +
        "Omit task_id to list active tasks.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Background task id from bash background=true (omit to list)",
          },
          tail: {
            type: "number",
            description: "Max lines of each stream (default 200; 0/all = full output)",
          },
          stream: {
            type: "string",
            description: "stdout | stderr | both (default both)",
          },
        },
        // No required: task_id optional — empty call lists active tasks
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_task",
      description:
        "Terminate a background bash task by task_id (SIGTERM then SIGKILL). " +
        "Omit task_id to list active tasks.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Background task id (omit to list active tasks)",
          },
        },
        // No required: omit task_id to list actives (provider-friendly vs required: [])
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file (or list a directory). Returns content with line numbers as NNNNNN|line — these prefixes are NOT part of the file. " +
        "Default up to 2000 lines from offset; for large files pass offset/limit or use grep. " +
        "Binary files are refused. Prefer absolute or workspace-relative paths.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative or absolute)" },
          offset: { type: "number", description: "1-based start line (default 1)" },
          limit: {
            type: "number",
            description: "Max lines to return (default 2000; 0 = all remaining)",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file with the given content. Prefer search_replace for existing files. " +
        "Atomic write; creates parent directories. Must stay inside the workspace. " +
        "Overwriting requires a prior read_file this session (refuses unread/stale files — re-read, then retry).",
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
        "Replace an exact string in a file. Read the file first — line-number prefixes from read_file are NOT part of the file. " +
        "Requires a prior read_file this session; refuses files changed on disk since (re-read, then retry). " +
        "old_string must match exactly once unless replace_all is true. " +
        "Tolerates whitespace-only mismatches via fuzzy fallback. Preserves BOM and CRLF.",
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
      name: "apply_patch",
      description:
        "Apply one multi-file patch (add/update/delete/move) with *** Begin Patch … *** End Patch grammar. " +
        "Prefer for coordinated edits across several files. All hunks validated before any write. " +
        "Update/delete requires a prior read_file this session. For a single small edit, search_replace is fine.",
      parameters: {
        type: "object",
        properties: {
          patchText: {
            type: "string",
            description:
              "Full patch text: *** Begin Patch … *** Add/Update/Delete File … *** End Patch",
          },
        },
        required: ["patchText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents with a regex (ripgrep when available). Prefer over bash rg/grep. " +
        "path may be a file or directory (default: workspace). Results are capped.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "File or directory (default: workspace)" },
          glob: { type: "string", description: "Glob filter e.g. *.ts" },
          case_insensitive: { type: "boolean" },
          head_limit: {
            type: "number",
            description: "Max matches (default 50; 0/all = unlimited)",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files matching a glob pattern. Prefer over bash find. " +
        "Omit path to search from the workspace root.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: {
            type: "string",
            description: "Directory to search under (default: workspace root)",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List entries in a directory (names + type). Prefer over bash ls. " +
        "Omit path for the workspace root.",
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
        "Update the session todo list. Use for any task with 3+ steps; skip for trivial single-step work. " +
        "Each todo needs id + content + status. merge defaults true (upsert by id); merge:false replaces the board.",
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
      name: "ask_user",
      description:
        "Ask the human a clarifying question when requirements are ambiguous. " +
        "Prefer over guessing destructive or irreversible choices. " +
        "Interactive only — fails closed headless (state assumptions instead).",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Clear, specific question for the human (required).",
          },
          choices: {
            type: "array",
            items: { type: "string" },
            description: "Optional multiple-choice options (max 12).",
          },
          context: {
            type: "string",
            description: "Optional short context (why you are asking).",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for up-to-date information. Returns titles, URLs, and snippets. " +
        "For a known URL use web_fetch instead.",
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
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch a public http(s) URL and return text (HTML stripped by default). Prefer over bash curl. " +
        "Private/loopback/link-local addresses are blocked unless allow_local=true (requires approval).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          format: {
            type: "string",
            description: "text | markdown | html (default markdown → HTML stripped to text)",
          },
          timeout_ms: { type: "number", description: "Default 30000, max 120000; suffixes 30s/1m" },
          allow_local: {
            type: "boolean",
            description: "Allow explicit loopback hosts only (default false; requires approval)",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_mcp",
      description:
        "Search configured MCP (Model Context Protocol) server tools by keyword. " +
        "Returns qualified names (server__tool) + schemas. Call matched tools with call_mcp. " +
        "Configure servers in .forge/mcp.json or ~/.forge/mcp.json (Claude/Cursor compatible).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keywords to match tool names/descriptions (omit or * to list). Include server name when known.",
          },
          limit: {
            type: "number",
            description: "Max results (default 8, max 50)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "call_mcp",
      description:
        "Invoke an MCP tool by qualified name from search_mcp (server__tool). " +
        "Pass arguments as a JSON object matching the tool schema. " +
        "Destructive MCP tools require approval like shell/writes.",
      parameters: {
        type: "object",
        properties: {
          tool_name: {
            type: "string",
            description: "Qualified MCP tool id, e.g. github__list_issues",
          },
          arguments: {
            type: "object",
            description: "Arguments object for the MCP tool (default {})",
          },
        },
        required: ["tool_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description:
        "Delegate a bounded subtask to a nested agent and receive its final summary. " +
        "Use for parallelizable research, large explorations, or isolated implementation slices. " +
        "Types: general-purpose (full tools), explore (read-only research), plan (read-only design). " +
        "Do not nest when a single tool call suffices. Children cannot spawn further subagents by default.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Full task instructions for the subagent (required).",
          },
          description: {
            type: "string",
            description: "Short 3–8 word label shown in status (recommended).",
          },
          subagent_type: {
            type: "string",
            description:
              "general-purpose | explore | plan (default general-purpose)",
          },
          capability_mode: {
            type: "string",
            description:
              "full | read-only (explore/plan force read-only; default full for general-purpose)",
          },
          max_turns: {
            type: "number",
            description: "Cap nested agent turns (default 40, max 200)",
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lsp",
      description:
        "Language Server Protocol: diagnostics, hover, go-to-definition, references, symbols. " +
        "Prefer diagnostics after TypeScript/Python/Rust/Go edits when the server is installed. " +
        "Actions: diagnostics | hover | definition | references | symbols | workspace_symbols | status. " +
        "line/character are 1-based. Servers: typescript-language-server, pyright, rust-analyzer, gopls (on PATH).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description:
              "diagnostics | hover | definition | references | symbols | workspace_symbols | status",
          },
          path: {
            type: "string",
            description: "File path (required except status / workspace_symbols)",
          },
          line: {
            type: "number",
            description: "1-based line (hover/definition/references)",
          },
          character: {
            type: "number",
            description: "1-based column (default 1)",
          },
          query: {
            type: "string",
            description: "Symbol query for workspace_symbols",
          },
        },
        required: ["action"],
      },
    },
  },
];
