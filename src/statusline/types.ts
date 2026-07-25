/**
 * Provider-agnostic status snapshot for the Forge HUD.
 *
 * Segments are optional: renderers hide what's missing so the same
 * statusline works for API keys, Grok subscription, Codex, Copilot, etc.
 */

export type AuthMethod = "api_key" | "oauth" | "subscription" | "unknown";

export type Liveness = "live" | "working" | "idle" | "stale" | "unknown";

export interface GitInfo {
  branch: string;
  dirty: boolean;
  root?: string;
}

export interface ContextInfo {
  /** Estimated tokens currently in context */
  usedTokens: number;
  /** Configured / known context window */
  windowTokens: number;
  /** 0–100 */
  percent: number;
  source: "session_estimate" | "provider" | "unknown";
}

export interface TokenUsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Rough USD when rates known; omit when only subscription credits apply */
  estimatedUsd?: number;
  source: "session" | "provider";
}

/**
 * Quota / plan usage when a provider exposes it (subscription credits,
 * weekly rate limits, etc.). Always optional — never invent numbers.
 */
export interface PlanUsageInfo {
  /** 0–100 used, when known */
  percent?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  unit?: string; // "credits" | "requests" | "tokens"
  periodLabel?: string; // "week" | "month" | "day"
  resetsAt?: string; // ISO
  product?: string;
  /** Where this came from */
  source: string;
  /** Human note when partial */
  note?: string;
}

export interface GoalInfo {
  active: boolean;
  status?: string;
  objective?: string;
  blocks?: number;
}

/** What the agent is doing right now (in-process or last heartbeat). */
export interface ActivityInfo {
  busy: boolean;
  phase: string;
  detail?: string;
  /** Seconds into current agent turn */
  turnElapsedSec?: number;
  /** Running background shell tasks */
  bgRunning: number;
  bgTotal?: number;
  bgHint?: string;
}

export interface BackgroundTaskSummary {
  id: string;
  status: string;
  command: string;
  elapsedSec: number;
  exitCode?: number | null;
}

export interface StatusSnapshot {
  sessionId: string;
  title?: string;
  cwd: string;
  projectLabel: string;
  provider: string;
  model: string;
  authMethod: AuthMethod;
  authLabel?: string;
  createdAt: string;
  updatedAt: string;
  /** Session age in seconds */
  durationSec: number;
  /** Seconds since last update */
  idleSec: number;
  liveness: Liveness;
  turnCount: number;
  editCount: number;
  openTodos: number;
  ultrawork: boolean;
  permissionMode?: string;
  git?: GitInfo;
  context: ContextInfo;
  tokens: TokenUsageInfo;
  /** Subscription / plan quota when available for this auth path */
  plan?: PlanUsageInfo;
  goal?: GoalInfo;
  /** Live agent activity (thinking / tool / bg) when known */
  activity?: ActivityInfo;
  /** Background tasks for this process (when collect is local) */
  backgroundTasks?: BackgroundTaskSummary[];
  /**
   * Session file lock holder when present.
   * `mine` is true when this process owns the lock.
   */
  lock?: {
    pid: number;
    hostname: string;
    acquiredAt: string;
    mine: boolean;
    alive: boolean;
  };
  /** Extra free-form tags e.g. ["plan-mode"] */
  tags: string[];
  collectedAt: string;
}

export interface StatuslineRenderOptions {
  /** Terminal width for shedding (default: process.stdout.columns) */
  width?: number;
  plain?: boolean;
  tmux?: boolean;
  /** Single line (for tmux) */
  singleLine?: boolean;
  color?: boolean;
}

export interface CollectOptions {
  sessionId?: string;
  cwd?: string;
  /** Prefer most recently updated if no id */
  all?: boolean;
  /** Include plan/billing fetch (may hit network) */
  fetchPlan?: boolean;
  config?: import("../config/types.js").ForgeConfig;
}
