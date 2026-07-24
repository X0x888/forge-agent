import type {
  SandboxMissingBackend,
  SandboxNetwork,
  SandboxProfile,
} from "../../config/types.js";

export interface ToolContext {
  workspace: string;
  onEdit?: () => void;
  /** OS sandbox profile for bash */
  sandbox?: SandboxProfile;
  sandboxNetwork?: SandboxNetwork;
  sandboxMissingBackend?: SandboxMissingBackend;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export type TodoHandler = (todos: unknown, merge: boolean) => string;
