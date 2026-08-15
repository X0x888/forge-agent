import type {
  ForgeConfig,
  SandboxMissingBackend,
  SandboxNetwork,
  SandboxProfile,
} from "../../config/types.js";
import type { FileReadState } from "./file-read-state.js";
import type { McpManager } from "../../mcp/manager.js";
import type { LspManager } from "../../lsp/manager.js";
import type {
  SubagentRequest,
  SubagentResult,
} from "../subagent.js";
import type { SessionData } from "../../session/session.js";

export interface ToolContext {
  workspace: string;
  /** Session id for durable sidecars (decision memory, etc.). */
  sessionId?: string;
  onEdit?: () => void;
  /**
   * Journal a successful file mutation so /undo can restore disk (OpenCode-inspired).
   * Best-effort — tools must not fail if this throws.
   */
  recordMutation?: (input: {
    path: string;
    kind: "create" | "update" | "delete";
    before?: string;
    /** Pre-image permission bits (stat.mode & 0o777) when known. */
    mode?: number;
    skipped?: boolean;
    reason?: string;
  }) => void;
  /**
   * Session-scoped read tracker. When set (agent loop), mutations require a
   * prior read_file and refuse stale mtime/size. Absent in unit tests.
   */
  fileReads?: FileReadState;
  /** OS sandbox profile for bash */
  sandbox?: SandboxProfile;
  sandboxNetwork?: SandboxNetwork;
  sandboxMissingBackend?: SandboxMissingBackend;
  /** Propagated from agent loop so long tools can cooperatively cancel */
  signal?: AbortSignal;
  /** MCP multi-server manager (search_mcp / call_mcp). */
  mcp?: McpManager;
  /** LSP multi-language manager (lsp tool). */
  lsp?: LspManager;
  /**
   * Nested subagent runner. Absent when depth limit reached or unit tests.
   * Implemented by the agent loop (not by tools themselves).
   */
  runSubagent?: (req: SubagentRequest) => Promise<SubagentResult>;
  /** Current subagent nesting depth (0 = root). */
  subagentDepth?: number;
  /** Parent session — required for exit_plan_mode to flip permission mode. */
  session?: SessionData;
  config?: ForgeConfig;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  /**
   * Human/TUI unified-ish diff (`shortDiff`). Never sent to the model.
   * Live-only — not stored on ChatMessage.
   */
  diff?: string;
  /** Line stats for `formatToolEnd` (`+8 -6`). `removed` is null when unknown. */
  stats?: { added: number; removed: number | null };
}

export type TodoHandler = (todos: unknown, merge: boolean) => string;
