import type {
  SandboxMissingBackend,
  SandboxNetwork,
  SandboxProfile,
} from "../../config/types.js";

export interface ToolContext {
  workspace: string;
  onEdit?: () => void;
  /**
   * Journal a successful file mutation so /undo can restore disk (OpenCode-inspired).
   * Best-effort — tools must not fail if this throws.
   */
  recordMutation?: (input: {
    path: string;
    kind: "create" | "update" | "delete";
    before?: string;
    skipped?: boolean;
    reason?: string;
  }) => void;
  /** OS sandbox profile for bash */
  sandbox?: SandboxProfile;
  sandboxNetwork?: SandboxNetwork;
  sandboxMissingBackend?: SandboxMissingBackend;
  /** Propagated from agent loop so long tools can cooperatively cancel */
  signal?: AbortSignal;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export type TodoHandler = (todos: unknown, merge: boolean) => string;
