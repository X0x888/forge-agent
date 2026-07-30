import type { ToolDefinition } from "../../providers/types.js";

/** Model-facing tool schemas with usage notes (OpenCode/Grok-inspired). */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command in the workspace (builds, tests, git, package managers). " +
        "Do NOT use for file reads/edits/search/list — prefer read_file, search_replace, grep, glob, list_dir. " +
        "Set background=true for long jobs (returns task_id; poll with get_task_output, stop with kill_task). " +
        "Empty/whitespace command fails closed with recovery examples. " +
        "Avoid interactive flags, force-push, and secret exfiltration. " +
        "Cloud IMDS (169.254.169.254 / metadata.google.internal) and file:// fetches are hard-denied. " +
        "Timeout default 120s foreground / 30m background (override FORGE_BASH_TIMEOUT_MS / FORGE_BASH_BG_TIMEOUT_MS).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          timeout_ms: {
            type: "number",
            description:
              "Timeout in milliseconds (default 120000 foreground / 30min background; env FORGE_BASH_TIMEOUT_MS / FORGE_BASH_BG_TIMEOUT_MS). Aliases: default|max|all (max/all → 30m ceiling); duration suffixes 30s/1m/2h/500ms.",
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
        "Poll until status is completed/failed/killed/timeout. " +
        "Omit task_id to list active tasks in this process. " +
        "Unknown ids list actives and suggest prefix/typo matches.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Background task id from bash background=true (omit to list)",
          },
          tail: {
            type: "number",
            description:
              "Max lines of each stream (default 200; 0/all/max/full = full captured output)",
          },
          stream: {
            type: "string",
            description: "stdout | stderr | both (default both). Explicit invalid fails closed.",
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
        "Omit task_id to list active tasks (parity with get_task_output). " +
        "Unknown ids list actives and suggest prefix/typo matches.",
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
        "Read a file (or list a directory). Returns content with line numbers as NNNNNN|line. " +
        "Default: up to 2000 lines from offset. For large files (≥2 MiB soft hint), pass offset/limit or use grep. " +
        "Binary files are refused. Missing paths include “did you mean?” typo hints. " +
        "Offset past end of file returns a clear past-EOF message (not empty-file). " +
        "Empty path fails closed with a recovery example. " +
        "Prefer absolute or workspace-relative paths.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative or absolute)" },
          offset: { type: "number", description: "1-based start line (default 1)" },
          limit: {
            type: "number",
            description:
              "Max lines to return (default 2000; 0 = all remaining from offset)",
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
        "Atomic write (tmp+rename); creates parent directories automatically. " +
        "Refuses directory targets (pass a file path). Writes must stay inside the workspace. " +
        "Empty path fails closed with a recovery example.",
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
        "Replace an exact string in a file (not a directory). Read the file first — line-number prefixes from read_file are NOT part of the file. " +
        "old_string must match exactly once unless replace_all is true. " +
        "Falls back to line-trimmed then block-anchor fuzzy matching. Preserves BOM and CRLF. " +
        "Empty path fails closed with a recovery example. " +
        "Multi-match errors list line numbers; content misses suggest closest lines (not path typos).",
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
        "Apply one multi-file patch (add/update/delete/move). Prefer for coordinated edits across several files. " +
        "Use OpenAI/OpenCode patch grammar with *** Begin Patch / *** End Patch markers. " +
        "All hunks are validated before any write; file writes are atomic. " +
        "Missing update/delete targets include path typo hints. " +
        "Empty patchText fails closed with a recovery example. " +
        "For a single small edit, search_replace is fine.",
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
        "Search file contents with a regex (uses ripgrep when available; JS fallback otherwise). " +
        "Prefer over bash rg/grep. path may be a file or directory. " +
        "Missing paths error with hints (not a false empty match). Results are capped. " +
        "Empty results include pattern/path context and recovery tips. " +
        "Empty/whitespace pattern fails closed with a recovery example. " +
        "Whitespace-only path fails closed (path is required); omit path to search the workspace.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "File or directory (default: workspace)" },
          glob: { type: "string", description: "Glob filter e.g. *.ts" },
          case_insensitive: { type: "boolean" },
          head_limit: {
            type: "number",
            description: "Max matches (default 50; 0/all/max/full = unlimited). Explicit invalid/negative fails closed.",
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
        "Missing search root is an error with path hints (not a false empty match). " +
        "If path points at a file, reports not a directory (not a false empty match). " +
        "Empty results include pattern/path context and recovery tips. " +
        "Empty/whitespace pattern fails closed with a recovery example. " +
        "Whitespace-only path fails closed (path is required); omit path for workspace root.",
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
        "Missing directories error with path-not-found hints. " +
        "File paths return “not a directory” (do not thrash on not-found recovery). " +
        "Whitespace-only path fails closed (path is required); omit path for workspace root.",
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
        "Update the session todo list. Use for multi-step tasks to track progress. " +
        "Each todo needs non-empty id + content and status pending|in_progress|completed|cancelled. " +
        "Empty id/content fails closed with a recovery example. " +
        "merge defaults true (upsert by id); merge:true with [] is a no-op warning; merge:false replaces the board.",
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
        "Prefer this over guessing destructive or irreversible choices. " +
        "Interactive TTY only — headless/CI fails closed (state assumptions instead). " +
        "Optional choices[] for multiple-choice. User may skip.",
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
            description:
              "Optional multiple-choice options (max 12). User may still type free text.",
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
        "Best-effort structured results; for a known URL use web_fetch instead of bash curl. " +
        "Empty query fails closed with a recovery example. " +
        "Honors turn abort (Ctrl+C / FORGE_MAX_RUN_MS) with a 15s per-request timeout.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          num_results: { type: "number", description: "Default 5, max 10 (all|max|full → 10). Explicit invalid/0 fails closed." },
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
        "Fetch a public http(s) URL and return text (HTML stripped by default). " +
        "SSRF-protected: private/loopback/link-local addresses are blocked unless allow_local=true " +
        "and the host is explicit localhost/127.0.0.1 (hex IPv4-mapped forms like ::ffff:7f00:1 are also blocked). " +
        "allow_local is not a free read-only tool — headless/dontAsk/plan need an allow rule, session-always, YOLO, or interactive approval. " +
        "Invalid HTML numeric entities never throw. " +
        "Honors turn abort through body read (Ctrl+C / FORGE_MAX_RUN_MS). " +
        "Empty URL fails closed with a recovery example. " +
        "Empty extracted bodies note the gap and suggest format=html or another URL. " +
        "Prefer this over bash curl for docs/pages.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          format: {
            type: "string",
            description: "text | markdown | html (default markdown → HTML stripped to text). Explicit invalid fails closed.",
          },
          timeout_ms: { type: "number", description: "Default 30000, max 120000; duration suffixes 30s/1m. Explicit invalid fails closed." },
          allow_local: {
            type: "boolean",
            description:
              "Allow explicit loopback hosts only (default false). Requires approval/allow-rule/YOLO in headless modes — not auto-allowed as read-only.",
          },
        },
        required: ["url"],
      },
    },
  },
];
