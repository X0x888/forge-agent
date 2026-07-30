import type { ReasoningEffort } from "./reasoning.js";

export type { ReasoningEffort } from "./reasoning.js";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk";

/**
 * System-prompt personality layer.
 * - default: balanced
 * - concise: short answers (OpenCode-style)
 * - autonomous: keep-going until done (used automatically under ULW)
 */
export type PromptProfile = "default" | "concise" | "autonomous";

/** OS sandbox profile for bash child processes */
export type SandboxProfile = "off" | "workspace" | "read-only" | "strict";

/**
 * Child-bash network policy.
 * Parent Node process (LLM API) is never sandboxed.
 */
export type SandboxNetwork = "unrestricted" | "blocked";

/**
 * When sandbox profile != off but OS backend is missing:
 * fail-closed — deny bash (default, Grok-style)
 * fallback — warn and run unsandboxed (legacy)
 */
export type SandboxMissingBackend = "fail-closed" | "fallback";

/** How to treat file reads outside the workspace */
export type ReadOutsideWorkspace = "ask" | "allow" | "deny";

export type PermissionAction = "deny" | "allow" | "ask";

export interface PermissionRule {
  action: PermissionAction;
  /** Tool name or * (Bash, bash, Edit, Write, Read, …) */
  tool: string;
  /** Glob/wildcard pattern for command or path */
  pattern: string;
  raw?: string;
}

export interface PermissionConfig {
  deny: string[];
  allow: string[];
  ask: string[];
  /** Structured rules (merged after string arrays) */
  rules: PermissionRule[];
}

export type ProviderId =
  | "xai"
  | "anthropic"
  | "openai"
  | "openrouter"
  | "google"
  | "copilot"
  | "custom";

export interface ProviderConfig {
  id: ProviderId | string;
  apiKeyEnv?: string;
  baseUrl?: string;
  /** OAuth / subscription login is available for this provider */
  supportsOAuth?: boolean;
  defaultModel?: string;
  models?: string[];
}

export interface GoalConfig {
  /** Master switch for the relentless /goal Stop driver */
  enabled: boolean;
  /** Consecutive no-progress blocks before stuck-wall release */
  stuckThreshold: number;
  /** Auto-arm goal from prose like "don't stop until …" */
  autoArm: boolean;
}

export interface HookFileRef {
  path: string;
}

export interface ForgeConfig {
  provider: ProviderId | string;
  model: string;
  /**
   * Reasoning effort for models that support it (e.g. grok-4.5: low|medium|high).
   * Omitted from API requests when the active model does not support effort.
   */
  reasoningEffort?: ReasoningEffort;
  baseUrl?: string;
  temperature: number;
  maxTokens: number;
  /** Max agent turns per user message (0 = unlimited) */
  maxTurns: number;
  permissionMode: PermissionMode;
  /**
   * OS sandbox for bash: off | workspace | read-only | strict
   * Default workspace — write confined to CWD + ~/.forge + temp.
   */
  sandbox: SandboxProfile;
  /**
   * Override child-bash network policy.
   * When unset: workspace/off → unrestricted; read-only/strict → blocked.
   */
  sandboxNetwork?: SandboxNetwork;
  /**
   * Missing sandbox-exec/bwrap behavior. Default fail-closed.
   */
  sandboxMissingBackend: SandboxMissingBackend;
  /**
   * File reads outside workspace. Default ask (interactive) / deny (headless dangerous).
   */
  readOutsideWorkspace: ReadOutsideWorkspace;
  /** Allow/deny/ask rules (deny always wins, including under YOLO) */
  permission: PermissionConfig;
  /** Workspace root (defaults to cwd) */
  workspace?: string;
  systemPromptExtra?: string;
  /**
   * Prompt personality. When unset, ULW sessions use `autonomous` and
   * normal sessions use `default`.
   */
  promptProfile?: PromptProfile;
  goal: GoalConfig;
  /** When true, Stop hooks can block the agent from finishing (Claude Code semantics) */
  blockingStopHooks: boolean;
  /** Load Claude-compatible settings.json hooks */
  compatClaudeHooks: boolean;
  /** Load Cursor-compatible hooks.json */
  compatCursorHooks: boolean;
  /** Auto-compact when estimated context exceeds this fraction (0-1) */
  autoCompactThreshold: number;
  contextWindow: number;
  /**
   * Runtime marker (never persisted): true when contextWindow came from an
   * explicit source (config file / project / CLI override). When false, the
   * window is re-derived from the active model on /model + provider switch
   * (see config/model-info.ts) so switching to a smaller-context model does
   * not keep a stale 500k budget.
   */
  contextWindowExplicit?: boolean;
  providers: Record<string, ProviderConfig>;
}

/** Default network policy for a sandbox profile (Grok-aligned). */
export function defaultNetworkForProfile(profile: SandboxProfile): SandboxNetwork {
  if (profile === "read-only" || profile === "strict") return "blocked";
  return "unrestricted";
}

export function resolveSandboxNetwork(config: {
  sandbox: SandboxProfile;
  sandboxNetwork?: SandboxNetwork;
}): SandboxNetwork {
  if (config.sandboxNetwork) return config.sandboxNetwork;
  return defaultNetworkForProfile(config.sandbox);
}

export const DEFAULT_CONFIG: ForgeConfig = {
  provider: "xai",
  model: "grok-4.5",
  reasoningEffort: "high",
  temperature: 0.2,
  // 16k: reasoning tokens share the max_tokens budget on xAI — 8k under
  // high effort truncated mid-thought and paid extra length-continue turns.
  maxTokens: 16384,
  maxTurns: 0,
  permissionMode: "default",
  sandbox: "workspace",
  sandboxMissingBackend: "fail-closed",
  readOutsideWorkspace: "ask",
  permission: {
    deny: [
      "Bash(rm -rf /)",
      "Bash(rm -fr /)",
      "Bash(rm -rf ~)",
      "Bash(rm -rf $HOME)",
      "Bash(git push --force *main*)",
      "Bash(git push --force *master*)",
      "Bash(git push *main* --force*)",
      "Bash(git push *master* --force*)",
      "Write(/etc/**)",
      "Edit(/etc/**)",
    ],
    allow: [],
    ask: [],
    rules: [],
  },
  goal: {
    enabled: true,
    stuckThreshold: 3,
    autoArm: true,
  },
  blockingStopHooks: true,
  compatClaudeHooks: true,
  compatCursorHooks: true,
  autoCompactThreshold: 0.85,
  contextWindow: 500_000,
  providers: {
    xai: {
      id: "xai",
      apiKeyEnv: "XAI_API_KEY",
      baseUrl: "https://api.x.ai/v1",
      supportsOAuth: true,
      defaultModel: "grok-4.5",
      models: ["grok-4.5", "grok-4", "grok-3", "grok-3-mini", "grok-2-latest"],
    },
    anthropic: {
      id: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      baseUrl: "https://api.anthropic.com/v1",
      supportsOAuth: false,
      defaultModel: "claude-sonnet-4-20250514",
      models: [
        "claude-opus-4-20250514",
        "claude-sonnet-4-20250514",
        "claude-haiku-4-20250414",
      ],
    },
    openai: {
      id: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      supportsOAuth: true,
      defaultModel: "gpt-4.1",
      models: [
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4o",
        "gpt-4o-mini",
        "o3",
        "o3-mini",
        "o4-mini",
      ],
    },
    openrouter: {
      id: "openrouter",
      apiKeyEnv: "OPENROUTER_API_KEY",
      baseUrl: "https://openrouter.ai/api/v1",
      supportsOAuth: false,
      defaultModel: "anthropic/claude-sonnet-4",
      // Common aliases; OpenRouter accepts many more via free-form model ids
      models: [
        "anthropic/claude-sonnet-4",
        "anthropic/claude-opus-4",
        "openai/gpt-4.1",
        "openai/o3",
        "google/gemini-2.5-pro",
        "x-ai/grok-4.5",
        "x-ai/grok-4",
      ],
    },
    google: {
      id: "google",
      apiKeyEnv: "GOOGLE_API_KEY",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      supportsOAuth: false,
      defaultModel: "gemini-2.5-pro",
      models: [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash",
      ],
    },
    copilot: {
      id: "copilot",
      apiKeyEnv: "COPILOT_GITHUB_TOKEN",
      baseUrl: "https://api.githubcopilot.com",
      supportsOAuth: true,
      defaultModel: "gpt-4.1",
      models: [
        "gpt-4.1",
        "gpt-4o",
        "gpt-4o-mini",
        "claude-sonnet-4",
        "claude-haiku-4.5",
        "gemini-2.5-pro",
        "o3-mini",
      ],
    },
  },
};
