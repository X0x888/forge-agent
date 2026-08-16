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
  /** Linked git worktree (not the main checkout). */
  isWorktree?: boolean;
}

export interface ContextInfo {
  /** Estimated tokens currently in context */
  usedTokens: number;
  /** Configured / known context window */
  windowTokens: number;
  /** 0–100 */
  percent: number;
  source: "session_estimate" | "session_api" | "provider" | "unknown";
}

export interface TokenUsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Rough USD when rates known; omit when only subscription credits apply */
  estimatedUsd?: number;
  /** Subagent slice of estimatedUsd when children were recorded. */
  subagentUsd?: number;
  subagentCount?: number;
  /** Live last-round cache_read / prompt (0–1); falls back to session smear. */
  cacheRatio?: number;
  /** Prompt tokens used to compute cacheRatio (last-round when live). */
  cacheRatioPromptTokens?: number;
  /** True when cacheRatio is the last provider round, not the lifetime smear. */
  cacheRatioLive?: boolean;
  source: "session" | "provider";
}

/**
 * Session spend budget (estimateCostUsd — not a bill).
 * Present when a cap is armed (config / env / --max-cost / /budget).
 */
export interface BudgetInfo {
  /** Effective cap USD (always > 0 when present). */
  capUsd: number;
  /** Running session estimate USD. */
  spentUsd: number;
  /** 0–100+ (can exceed 100 when over cap). */
  percent: number;
  /** Remaining USD before release (0 when hit). */
  remainingUsd: number;
  /** True when spent >= cap. */
  hit: boolean;
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
  /** Absolute session directory under FORGE_HOME */
  sessionPath?: string;
  title?: string;
  cwd: string;
  projectLabel: string;
  /** Detected package manager when known (npm/pnpm/yarn/bun). */
  packageManager?: string | null;
  /** Preferred verification commands (cheapest first). */
  checkCommands?: string[];
  /** Compact project-stack summary. */
  projectStackSummary?: string | null;
  /** Monorepo root when cwd is nested or is a workspace root. */
  monorepoRoot?: string | null;
  /** Monorepo workspace package labels. */
  workspaces?: string[];
  provider: string;
  model: string;
  authMethod: AuthMethod;
  authLabel?: string;
  /** Active multi-account id when known */
  accountId?: string;
  /** How many stored accounts exist for this provider */
  accountCount?: number;
  createdAt: string;
  updatedAt: string;
  /** Session age in seconds */
  durationSec: number;
  /** Seconds since last update */
  idleSec: number;
  liveness: Liveness;
  turnCount: number;
  editCount: number;
  /** Last structural verification bash command, if any. */
  lastVerificationCommand?: string | null;
  lastVerificationAt?: string | null;
  lastEditAt?: string | null;
  lastVerificationStale?: boolean | null;
  openTodos: number;
  /** First in-progress todo title, when any. */
  activeTodo?: string | null;
  ultrawork: boolean;
  /** ULW cycle flag when armed (0|1); omit/null when not */
  ulwCycle?: number | null;
  /** ULW wave counter when armed */
  ulwWave?: number | null;
  /** Prune-protected session */
  pinned?: boolean;
  permissionMode?: string;
  git?: GitInfo;
  context: ContextInfo;
  tokens: TokenUsageInfo;
  /** Session spend cap when armed (estimateCostUsd). */
  budget?: BudgetInfo;
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
  /**
   * Last provider/run failure for this session (expert recovery).
   * Never invent — only when session.meta.lastError is set.
   */
  lastError?: {
    at: string;
    code: string;
    message: string;
    tips?: string[];
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
