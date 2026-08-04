/**
 * Nested subagents (Claude/OpenCode-style Task tool).
 *
 * - Isolated ephemeral session (cleaned up after run unless FORGE_SUBAGENT_KEEP=1)
 * - Capability modes: full | read-only (explore/plan force read-only)
 * - Depth limit (default 1): children cannot spawn further subagents
 * - SubagentStart / SubagentStop hooks (blocking Stop semantics apply)
 * - Token usage folded into parent session
 * - Shares parent MCP/LSP managers (no double server spawn)
 */
import fs from "node:fs";
import path from "node:path";
import type { ForgeConfig } from "../config/types.js";
import type { LLMProvider } from "../providers/types.js";
import type { ToolDefinition } from "../providers/types.js";
import type { HookRunner } from "../harness/hooks.js";
import type { McpManager } from "../mcp/manager.js";
import type { LspManager } from "../lsp/manager.js";
import { forgeHome } from "../util/fs.js";
import { envPositiveInt } from "../util/env.js";
import { log } from "../util/log.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import type { PermissionGate } from "./permissions.js";
import type { SessionData } from "../session/session.js";
import {
  createSession,
  deleteSessionDetailed,
  saveSession,
} from "../session/session.js";
import type { LoopEvents, LoopResult } from "./loop.js";
import {
  createSubagentWorktree,
  resolveIsolationMode,
  type SubagentWorktree,
} from "./worktree.js";

export type SubagentType = "general-purpose" | "explore" | "plan";
export type SubagentCapability = "full" | "read-only";
export type SubagentIsolation = "none" | "worktree";

export interface SubagentRequest {
  prompt: string;
  description?: string;
  subagentType?: SubagentType;
  capabilityMode?: SubagentCapability;
  maxTurns?: number;
  /**
   * Isolation mode:
   * - none (default): same workspace as parent
   * - worktree: detached git worktree under ~/.forge/worktrees/ (requires git repo)
   */
  isolation?: SubagentIsolation;
}

export interface SubagentRunContext {
  config: ForgeConfig;
  provider: LLMProvider;
  parentSession: SessionData;
  hooks: HookRunner;
  permissions: PermissionGate;
  workspace: string;
  signal?: AbortSignal;
  events?: LoopEvents;
  /** Current depth of the caller (0 = root agent). */
  depth: number;
  maxDepth?: number;
  mcp?: McpManager;
  lsp?: LspManager;
}

export interface SubagentResult {
  ok: boolean;
  text: string;
  turns: number;
  aborted: boolean;
  subagentType: SubagentType;
  capabilityMode: SubagentCapability;
  description: string;
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  editCount: number;
  error?: string;
  isolation?: SubagentIsolation;
  /** Worktree path when isolation=worktree. */
  worktreePath?: string;
}

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "list_dir",
  "web_search",
  "web_fetch",
  "todo_write",
  "get_task_output",
  "search_mcp",
  "mcp_resource",
  "mcp_prompt",
  "lsp",
  "ask_user",
]);

/** Tools never available inside a subagent (nesting + interactive edge cases). */
const SUBAGENT_DENY_ALWAYS = new Set([
  "spawn_subagent",
  "Task",
  "task",
  // Background kill is parent-process scoped; avoid surprise from children
  "kill_task",
]);

export function resolveSubagentType(raw: unknown): SubagentType {
  const s = String(raw || "general-purpose")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (s === "explore" || s === "research" || s === "readonly" || s === "read-only") {
    return "explore";
  }
  if (s === "plan" || s === "planner" || s === "design") return "plan";
  if (
    s === "general-purpose" ||
    s === "general" ||
    s === "default" ||
    s === "full" ||
    s === "coder" ||
    s === "implement"
  ) {
    return "general-purpose";
  }
  return "general-purpose";
}

export function resolveCapabilityMode(
  type: SubagentType,
  raw?: unknown,
): SubagentCapability {
  if (type === "explore" || type === "plan") return "read-only";
  const s = String(raw || "full")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (s === "read-only" || s === "readonly" || s === "read" || s === "ro") {
    return "read-only";
  }
  return "full";
}

export function filterToolsForSubagent(
  capability: SubagentCapability,
  opts?: { allowSpawn?: boolean },
): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((t) => {
    const name = t.function.name;
    if (SUBAGENT_DENY_ALWAYS.has(name) && !opts?.allowSpawn) return false;
    if (name === "spawn_subagent") return Boolean(opts?.allowSpawn);
    if (capability === "read-only") {
      return READ_ONLY_TOOLS.has(name);
    }
    return true;
  });
}

export function defaultMaxSubagentDepth(): number {
  return envPositiveInt("FORGE_SUBAGENT_MAX_DEPTH", 1);
}

export function defaultSubagentMaxTurns(): number {
  return envPositiveInt("FORGE_SUBAGENT_MAX_TURNS", 40);
}

/**
 * Run a nested agent loop and return a compact result for the parent tool.
 */
export async function runSubagent(
  req: SubagentRequest,
  ctx: SubagentRunContext,
): Promise<SubagentResult> {
  const subagentType = resolveSubagentType(req.subagentType);
  const capabilityMode = resolveCapabilityMode(
    subagentType,
    req.capabilityMode,
  );
  const description =
    (req.description || "").trim().slice(0, 120) ||
    (req.prompt || "").trim().slice(0, 80) ||
    "subagent";
  const maxDepth = ctx.maxDepth ?? defaultMaxSubagentDepth();
  const depth = ctx.depth;

  if (depth >= maxDepth) {
    return {
      ok: false,
      text: "",
      turns: 0,
      aborted: false,
      subagentType,
      capabilityMode,
      description,
      sessionId: "",
      promptTokens: 0,
      completionTokens: 0,
      editCount: 0,
      error: `Subagent depth limit reached (depth=${depth}, max=${maxDepth}). Do the work in this agent instead of nesting further.`,
    };
  }

  const prompt = (req.prompt || "").trim();
  if (!prompt) {
    return {
      ok: false,
      text: "",
      turns: 0,
      aborted: false,
      subagentType,
      capabilityMode,
      description,
      sessionId: "",
      promptTokens: 0,
      completionTokens: 0,
      editCount: 0,
      error: "spawn_subagent error: prompt is required.",
    };
  }

  const isolation = resolveIsolationMode(req.isolation);
  let worktree: SubagentWorktree | null = null;
  let childWorkspace = ctx.workspace;
  if (isolation === "worktree") {
    try {
      worktree = createSubagentWorktree({
        workspace: ctx.workspace,
        label: description,
      });
      childWorkspace = worktree.path;
      log.dim(`Subagent worktree: ${worktree.path}`);
      ctx.events?.onStatus?.(
        `subagent worktree: ${path.basename(worktree.path)}`,
      );
    } catch (err) {
      return {
        ok: false,
        text: "",
        turns: 0,
        aborted: false,
        subagentType,
        capabilityMode,
        description,
        sessionId: "",
        promptTokens: 0,
        completionTokens: 0,
        editCount: 0,
        isolation,
        error: (err as Error).message,
      };
    }
  }

  // Ephemeral child session
  const child = createSession({
    cwd: childWorkspace,
    provider: String(ctx.config.provider),
    model: ctx.config.model,
    ultrawork: false,
    title: `subagent: ${description}`.slice(0, 200),
  });

  // Plan-type subagents run under plan permission mode
  const childConfig: ForgeConfig = {
    ...ctx.config,
    workspace: childWorkspace,
    // Cap turns for nested work
    maxTurns:
      req.maxTurns && req.maxTurns > 0
        ? Math.floor(req.maxTurns)
        : defaultSubagentMaxTurns(),
    // Don't inherit ULW/goal auto-arm into child
    goal: { ...ctx.config.goal, autoArm: false },
    permissionMode:
      subagentType === "plan"
        ? "plan"
        : capabilityMode === "read-only"
          ? ctx.config.permissionMode === "bypassPermissions"
            ? "bypassPermissions"
            : ctx.config.permissionMode === "dontAsk"
              ? "dontAsk"
              : "default"
          : ctx.config.permissionMode,
  };

  const tools = filterToolsForSubagent(capabilityMode, {
    // Never allow children to nest further at max depth-1 boundary
    allowSpawn: depth + 1 < maxDepth,
  });

  const startHook = await ctx.hooks.run("SubagentStart", {
    sessionId: child.meta.id,
    cwd: childWorkspace,
    workspaceRoot: childWorkspace,
    prompt: prompt.slice(0, 2000),
    toolName: "spawn_subagent",
    toolInput: {
      description,
      subagent_type: subagentType,
      capability_mode: capabilityMode,
      isolation,
      worktree: worktree?.path,
    },
  });
  if (startHook.blocked || startHook.decision === "deny") {
    await cleanupChildSession(child.meta.id);
    if (worktree) await worktree.cleanup().catch(() => {});
    return {
      ok: false,
      text: "",
      turns: 0,
      aborted: false,
      subagentType,
      capabilityMode,
      description,
      sessionId: child.meta.id,
      promptTokens: 0,
      completionTokens: 0,
      editCount: 0,
      isolation,
      worktreePath: worktree?.path,
      error: `SubagentStart hook denied: ${startHook.reason || "denied"}`,
    };
  }

  const framedPrompt = buildSubagentPrompt({
    prompt,
    description,
    subagentType,
    capabilityMode,
    parentSessionId: ctx.parentSession.meta.id,
    isolation,
    worktreePath: worktree?.path,
  });

  let result: LoopResult | undefined;
  let runError: string | undefined;
  try {
    ctx.events?.onStatus?.(
      `subagent[${subagentType}${isolation === "worktree" ? "/wt" : ""}]: ${description.slice(0, 40)}`,
    );
    // Dynamic import avoids circular dependency (loop → tools → subagent → loop).
    const { runAgentLoop } = await import("./loop.js");
    // Worktree isolation: do not share parent MCP/LSP (different cwd roots).
    // Child gets its own managers scoped to the worktree workspace.
    result = await runAgentLoop({
      config: childConfig,
      provider: ctx.provider,
      session: child,
      hooks: ctx.hooks,
      permissions: ctx.permissions,
      userMessage: framedPrompt,
      stream: false,
      signal: ctx.signal,
      events: {
        onStatus: ctx.events?.onStatus,
        onPhase: ctx.events?.onPhase,
        // Suppress token streaming to parent TUI (avoid interleaving)
      },
      maxStopContinues: 20,
      subagentDepth: depth + 1,
      maxSubagentDepth: maxDepth,
      toolDefinitions: tools,
      mcp: isolation === "worktree" ? undefined : ctx.mcp,
      lsp: isolation === "worktree" ? undefined : ctx.lsp,
      disableHarnessAutoArm: true,
    });
  } catch (err) {
    runError = (err as Error).message;
  }

  // Fold usage into parent
  if (result) {
    ctx.parentSession.meta.totalPromptTokens += result.promptTokens || 0;
    ctx.parentSession.meta.totalCompletionTokens +=
      result.completionTokens || 0;
    if (result.cacheReadTokens) {
      ctx.parentSession.meta.totalCacheReadTokens =
        (ctx.parentSession.meta.totalCacheReadTokens || 0) +
        result.cacheReadTokens;
    }
    // Same-workspace child edits count toward parent edit trail.
    // Worktree isolation must NOT bump parent lastEditAt (files aren't in parent tree).
    if (isolation !== "worktree" && child.meta.editCount > 0) {
      ctx.parentSession.meta.editCount += child.meta.editCount;
      ctx.parentSession.meta.lastEditAt =
        child.meta.lastEditAt || new Date().toISOString();
    }
    try {
      saveSession(ctx.parentSession);
    } catch {
      /* */
    }
  }

  const stopHook = await ctx.hooks.run("SubagentStop", {
    sessionId: child.meta.id,
    cwd: childWorkspace,
    workspaceRoot: childWorkspace,
    prompt: prompt.slice(0, 2000),
    lastAssistantMessage: result?.finalText?.slice(0, 4000),
    stopReason: runError
      ? "error"
      : result?.aborted
        ? "aborted"
        : result?.hitMaxTurns
          ? "max_turns"
          : "completed",
    turnCount: result?.turns,
    editCount: child.meta.editCount,
    toolName: "spawn_subagent",
  });

  // If SubagentStop blocks (blocking hooks), append reason for parent visibility
  let text = result?.finalText?.trim() || "";
  if (runError) {
    text = text
      ? `${text}\n\n[subagent error: ${runError}]`
      : `[subagent error: ${runError}]`;
  }
  if (stopHook.blocked) {
    text += `\n\n[SubagentStop hook requested continue: ${stopHook.reason || "blocked"} — parent should re-spawn or finish remaining work]`;
  }

  const keepSession =
    process.env.FORGE_SUBAGENT_KEEP === "1" ||
    process.env.FORGE_SUBAGENT_KEEP === "true";
  if (!keepSession) {
    await cleanupChildSession(child.meta.id);
  } else {
    log.dim(`Subagent session kept: ${child.meta.id}`);
  }

  // Worktree cleanup: keep on FORGE_SUBAGENT_KEEP_WORKTREE=1 or when parent
  // may want to inspect (failed runs keep for diagnosis unless forced clean).
  const keepWorktree =
    process.env.FORGE_SUBAGENT_KEEP_WORKTREE === "1" ||
    process.env.FORGE_SUBAGENT_KEEP_WORKTREE === "true" ||
    process.env.FORGE_SUBAGENT_KEEP === "1" ||
    process.env.FORGE_SUBAGENT_KEEP === "true";
  if (worktree) {
    if (keepWorktree) {
      log.dim(`Subagent worktree kept: ${worktree.path}`);
      text += `\n\n[worktree kept: ${worktree.path} — review/merge, then: git worktree remove --force <path>]`;
    } else {
      await worktree.cleanup().catch(() => {});
    }
  }

  const summary = formatSubagentResult({
    text,
    description,
    subagentType,
    capabilityMode,
    turns: result?.turns ?? 0,
    editCount: child.meta.editCount,
    aborted: Boolean(result?.aborted),
    hitMaxTurns: Boolean(result?.hitMaxTurns),
    error: runError,
    isolation,
    worktreePath: worktree?.path,
    worktreeKept: Boolean(worktree && keepWorktree),
  });

  return {
    ok: !runError && !result?.aborted,
    text: summary,
    turns: result?.turns ?? 0,
    aborted: Boolean(result?.aborted),
    subagentType,
    capabilityMode,
    description,
    sessionId: child.meta.id,
    promptTokens: result?.promptTokens ?? 0,
    completionTokens: result?.completionTokens ?? 0,
    editCount: child.meta.editCount,
    error: runError,
    isolation,
    worktreePath: worktree?.path,
  };
}

function buildSubagentPrompt(opts: {
  prompt: string;
  description: string;
  subagentType: SubagentType;
  capabilityMode: SubagentCapability;
  parentSessionId: string;
  isolation?: SubagentIsolation;
  worktreePath?: string;
}): string {
  const lines = [
    `[Forge subagent — ${opts.subagentType} / ${opts.capabilityMode}` +
      (opts.isolation === "worktree" ? " / worktree" : "") +
      `]`,
    `Task: ${opts.description}`,
    ``,
    opts.capabilityMode === "read-only"
      ? "You are read-only: research and report. Do not modify files or run mutating shell commands."
      : "Complete the task thoroughly. Prefer verification after edits.",
    opts.subagentType === "plan"
      ? "Deliver a concrete implementation plan (goal, steps, risks, verification). Do not implement."
      : opts.subagentType === "explore"
        ? "Explore the codebase and return structured findings with file:line citations."
        : "Implement or investigate as asked. Return a concise final summary of what you found/did and any remaining risks.",
  ];
  if (opts.isolation === "worktree" && opts.worktreePath) {
    lines.push(
      ``,
      `## Isolated worktree`,
      `Workspace: ${opts.worktreePath}`,
      `This is a detached git worktree — edits here do not touch the parent checkout.`,
      `Summarize files changed and any commits; the parent will merge/cherry-pick if needed.`,
    );
  }
  lines.push(
    ``,
    `## User task`,
    opts.prompt,
    ``,
    `When finished, respond with a clear final summary only (the parent agent will read it). Do not ask the user follow-up questions unless ask_user is essential.`,
  );
  return lines.join("\n");
}

function formatSubagentResult(opts: {
  text: string;
  description: string;
  subagentType: SubagentType;
  capabilityMode: SubagentCapability;
  turns: number;
  editCount: number;
  aborted: boolean;
  hitMaxTurns: boolean;
  error?: string;
  isolation?: SubagentIsolation;
  worktreePath?: string;
  worktreeKept?: boolean;
}): string {
  const header = [
    `### Subagent result: ${opts.description}`,
    `- type: ${opts.subagentType} · mode: ${opts.capabilityMode} · turns: ${opts.turns} · edits: ${opts.editCount}` +
      (opts.isolation === "worktree" ? " · isolation: worktree" : ""),
    opts.worktreePath
      ? `- worktree: ${opts.worktreePath}${opts.worktreeKept ? " (kept)" : " (removed)"}`
      : "",
    opts.aborted ? `- aborted: true` : "",
    opts.hitMaxTurns ? `- hit max turns` : "",
    opts.error ? `- error: ${opts.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = (opts.text || "(no output)").trim();
  // Cap returned body so parent context stays healthy
  const cap = 24_000;
  const clipped =
    body.length > cap
      ? body.slice(0, cap) +
        `\n… [subagent output truncated to ${cap} chars]`
      : body;
  return `${header}\n\n${clipped}`;
}

async function cleanupChildSession(id: string): Promise<void> {
  try {
    deleteSessionDetailed(id, { force: true });
  } catch {
    // Best-effort: remove session dir if delete helper is picky
    try {
      const dir = path.join(forgeHome(), "sessions", id);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

/** Active run count (debug / status). */
let activeSubagents = 0;
export function getActiveSubagentCount(): number {
  return activeSubagents;
}

export async function runSubagentTracked(
  req: SubagentRequest,
  ctx: SubagentRunContext,
): Promise<SubagentResult> {
  activeSubagents += 1;
  try {
    return await runSubagent(req, ctx);
  } finally {
    activeSubagents = Math.max(0, activeSubagents - 1);
  }
}
