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
        "Timeout default 120s fg (cap 30m) / 30m bg (cap 6h). " +
        "Do not foreground npm test / npm run ci / npm run check — background:true then get_task_output, or run the last targeted check.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          timeout_ms: {
            type: "number",
            description:
              "Timeout in ms (default 120s fg / 30m bg; fg cap 30m). Aliases: default|max|all; suffixes 30s/1m.",
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
        "Omit task_id to list active tasks. " +
        "Optional wait/timeout_ms blocks until the task finishes (or timeout) so you do not need a poll loop. " +
        "Pass task_ids + wait_mode=any|all to wait on several jobs (any = first done, all = every listed; " +
        "omit ids to wait on every running task).",
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
          wait: {
            type: "number",
            description:
              "Block until exit or this many ms (max 30m). Aliases: timeout_ms. Suffixes 30s/2m; true/wait = 120s.",
          },
          timeout_ms: {
            type: "number",
            description: "Alias of wait — ms to block for task completion (max 30m).",
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
        "Default up to 1000 lines from offset; for large files pass offset/limit or use grep. " +
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
        "Success returns a numbered AFTER window (N| prefixes are not file text). " +
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
        "Success returns a numbered AFTER window (N| prefixes are not file text).",
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
        "Success returns per-file numbered AFTER windows (N| prefixes are not file text). " +
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
        "For a known symbol in TS/Python/Rust/Go prefer lsp { action: references|definition|workspace_symbols } — grep is for strings/comments/unknown text. " +
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
      name: "memory_write",
      description:
        "Append a durable decision/constraint/fact. " +
        "Write the reading and real constraints — not every clip/sibling ship. " +
        "scope=session (default, survives compact) | project (conventions/gotchas in ~/.forge/project-memory + .forge/MEMORY.md). " +
        "Never write this-cycle/this-wave notes to project. " +
        "Kinds: constraint|decision|fact|out_of_scope|priority|blocker|observation|convention|gotcha.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Exact short wording to preserve (not a long dump)",
          },
          kind: {
            type: "string",
            description:
              "constraint | decision | fact | out_of_scope | priority | blocker | observation | convention | gotcha (default decision/fact)",
          },
          scope: {
            type: "string",
            description:
              "session (default) | project (cross-session; aliases: repo, workspace)",
            enum: ["session", "project"],
          },
        },
        required: ["text"],
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
      name: "enter_plan_mode",
      description:
        "Enter PLAN MODE (read-only research/design) without waiting for the user to type /plan. " +
        "Use when the request is ambiguous, multi-option, or architectural — then research and call exit_plan_mode. " +
        "No-op if already in plan. Subagents cannot call this.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Why you are pausing implementation (ambiguity, blast radius, missing design).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "exit_plan_mode",
      description:
        "Propose a concrete implementation plan and leave PLAN MODE after user approval. " +
        "Use when research is done and you are ready to implement — do not wait for the user to type /build. " +
        "Interactive sessions confirm; headless stays in plan unless the session entered plan from --yolo. " +
        "After approval, implement immediately.",
      parameters: {
        type: "object",
        properties: {
          plan: {
            type: "string",
            description:
              "The implementation plan to approve (steps, files, risks). Required.",
          },
        },
        required: ["plan"],
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
      name: "mcp_resource",
      description:
        "List or read MCP resources (documents/data beyond tools). " +
        "action=list to discover uris; action=read with uri (or server__uri). " +
        "Many servers are tools-only — empty list is normal.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "list | read (default list)",
          },
          uri: {
            type: "string",
            description: "Resource URI (required for read)",
          },
          server: {
            type: "string",
            description: "Optional server name when uri is ambiguous",
          },
          query: {
            type: "string",
            description: "Filter list by keyword",
          },
          limit: { type: "number", description: "Max list results (default 40)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mcp_prompt",
      description:
        "List or get MCP prompt templates (reusable prompt packs from servers). " +
        "action=list to discover; action=get with name (server__prompt) and optional arguments.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "list | get (default list)",
          },
          name: {
            type: "string",
            description: "Prompt name or server__name (required for get)",
          },
          arguments: {
            type: "object",
            description: "String arguments for the prompt template",
          },
          server: {
            type: "string",
            description: "Optional server when name is bare",
          },
          query: {
            type: "string",
            description: "Filter list by keyword",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description:
        "Delegate a bounded subtask to a nested agent and receive its summary plus an artifact_path. " +
        "status=incomplete_max_turns means the child hit its turn cap — read_file the artifact; do not re-spawn the same explore. " +
        "Types: general-purpose | explore (read-only) | plan (read-only design). " +
        "isolation=worktree (default for general-purpose in a git repo) lands the diff into the parent on success; explore/plan stay in-place. isolation=none writes the parent tree. Kept on conflict. " +
        "Do not nest when a single tool call suffices.",
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
          isolation: {
            type: "string",
            description:
              "none (same workspace) | worktree (detached git worktree). Default: worktree for general-purpose when git exists; none for explore/plan.",
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
        "Language Server Protocol: diagnostics, hover, definition, references, symbols. " +
        "Prefer diagnostics after TS/Python/Rust/Go edits when the server is on PATH. " +
        "Prefer references/definition/workspace_symbols over repo-wide grep once you know a symbol name. " +
        "Actions: diagnostics|hover|definition|references|symbols|workspace_symbols|status|install|ensure. " +
        "ensure auto-installs TS+Python (+ Rust/Go if project markers). line/character 1-based.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description:
              "diagnostics | hover | definition | references | symbols | workspace_symbols | status | install | ensure",
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
