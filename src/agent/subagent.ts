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
import type { ForgeConfig, PermissionMode } from "../config/types.js";
import type { LLMProvider } from "../providers/types.js";
import type { ToolDefinition } from "../providers/types.js";
import type { HookRunner } from "../harness/hooks.js";
import type { McpManager } from "../mcp/manager.js";
import type { LspManager } from "../lsp/manager.js";
import { ensureDir, forgeHome } from "../util/fs.js";
import { envPositiveInt } from "../util/env.js";
import { log } from "../util/log.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import type { PermissionGate } from "./permissions.js";
import type { SessionData } from "../session/session.js";
import type { ChatMessage } from "../providers/types.js";
import {
  createSession,
  deleteSessionDetailed,
  saveSession,
} from "../session/session.js";
import { loadDecisionMemory } from "../harness/decision-memory.js";
import type { LoopEvents, LoopResult } from "./loop.js";
import { normalizePermissionMode } from "../util/mode-aliases.js";
import {
  createSubagentWorktree,
  defaultIsolationForSpawn,
  formatWorktreeLandSummary,
  landSubagentWorktree,
  type SubagentWorktree,
  type WorktreeLandResult,
} from "./worktree.js";
import {
  buildSubagentUsageRecord,
  foldChildUsage,
  formatLiveChildSpend,
  formatSubagentTokensHeader,
  resolveChildUsage,
} from "../session/subagent-usage.js";
import {
  formatExploreMap,
  parseExploreMap,
  rememberExploreMap,
} from "../session/explore-map.js";
import { noteExploreChildCompleted } from "../harness/ulw-cycle.js";

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
   * - none: same workspace as parent (explore/plan default; explicit override)
   * - worktree: detached git worktree under ~/.forge/worktrees/ (requires git repo); auto-lands into parent on success
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
  cacheReadTokens?: number;
  editCount: number;
  error?: string;
  isolation?: SubagentIsolation;
  /** Worktree path when isolation=worktree. */
  worktreePath?: string;
  /** Land outcome when isolation=worktree (auto-apply into parent by default). */
  worktreeLand?: WorktreeLandResult;
  hitMaxTurns?: boolean;
  status?: SubagentHandoffStatus;
  artifactPath?: string;
}

export type SubagentHandoffStatus =
  | "completed"
  | "incomplete_max_turns"
  | "aborted"
  | "error"
  | "stop_hook_blocked";

export function resolveSubagentHandoffStatus(opts: {
  error?: string;
  aborted?: boolean;
  hitMaxTurns?: boolean;
  stopHookBlocked?: boolean;
}): SubagentHandoffStatus {
  if (opts.error) return "error";
  if (opts.aborted) return "aborted";
  if (opts.stopHookBlocked) return "stop_hook_blocked";
  if (opts.hitMaxTurns) return "incomplete_max_turns";
  return "completed";
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
  "call_mcp",
  "mcp_call",
  "use_mcp",
  "mcp_resource",
  "mcp_prompt",
  "lsp",
  "ask_user",
  "memory_write",
  // PermissionGate still hard-denies mutating bash / mutating MCP in plan.
  "bash",
]);

/** Tools never available inside a subagent (nesting + interactive edge cases). */
const SUBAGENT_DENY_ALWAYS = new Set([
  "spawn_subagent",
  "Task",
  "task",
  // Background kill is parent-process scoped; avoid surprise from children
  "kill_task",
  "enter_plan_mode",
  "EnterPlanMode",
  "enterPlanMode",
  "exit_plan_mode",
  "ExitPlanMode",
  "exitPlanMode",
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

/** Read-only children always run in plan mode so bash/MCP mutations stay denied. */
export function resolveChildPermissionMode(
  type: SubagentType,
  capability: SubagentCapability,
  parentMode: PermissionMode,
): PermissionMode {
  if (type === "plan" || capability === "read-only") return "plan";
  return normalizePermissionMode(parentMode) ?? parentMode;
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

const SYNTH_TOOLS = new Set([
  "read_file",
  "Read",
  "read",
  "grep",
  "Grep",
  "lsp",
  "LSP",
  "list_dir",
  "ListDir",
  "memory_write",
]);

/**
 * Build a parent-facing findings block from the child transcript when
 * finalText is empty or mid-thought (typical maxTurns last-turn).
 */
export function synthesizeSubagentFindings(
  messages: ChatMessage[],
  opts?: { maxAssistant?: number; maxTools?: number },
): string {
  const maxAsst = opts?.maxAssistant ?? 8;
  const maxTools = opts?.maxTools ?? 12;
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) nameById.set(tc.id, tc.function.name);
  }

  const assistant: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const t = (m.content || "").replace(/\s+/g, " ").trim();
    if (t) assistant.push(t);
  }
  const asstPick = assistant.slice(-maxAsst);

  const tools: string[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    const name = (m.tool_call_id && nameById.get(m.tool_call_id)) || "tool";
    if (!SYNTH_TOOLS.has(name)) continue;
    const body = (m.content || "").trim();
    if (!body || body.startsWith("[Stale tool output cleared")) continue;
    const excerpt = body.replace(/\s+/g, " ").slice(0, 220);
    if (excerpt) tools.push(`- ${name}: ${excerpt}`);
    if (tools.length >= maxTools) break;
  }

  const lines: string[] = [`## Synthesized findings`];
  if (asstPick.length) {
    lines.push(``, `### Recent assistant notes`);
    for (const a of asstPick) lines.push(`- ${a.slice(0, 280)}`);
  }
  if (tools.length) {
    lines.push(``, `### Tool excerpts`);
    lines.push(...tools);
  }
  if (asstPick.length === 0 && tools.length === 0) {
    lines.push(`- (no assistant notes or research excerpts in the child transcript)`);
  }
  return lines.join("\n");
}

export function writeSubagentArtifact(opts: {
  childId: string;
  header: string;
  body: string;
}): string {
  const dir = path.join(forgeHome(), "tool-output");
  ensureDir(dir);
  const file = path.join(dir, `subagent_${opts.childId}.md`);
  const text = `${opts.header}\n\n${opts.body}\n`;
  fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
  return file;
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

  const isolation = defaultIsolationForSpawn({
    type: req.subagentType,
    isolation: req.isolation,
    workspace: ctx.workspace,
  });
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

  const childMaxTurns =
    req.maxTurns && req.maxTurns > 0
      ? Math.floor(req.maxTurns)
      : defaultSubagentMaxTurns();

  // Plan-type subagents run under plan permission mode
  const childConfig: ForgeConfig = {
    ...ctx.config,
    workspace: childWorkspace,
    // Cap turns for nested work
    maxTurns: childMaxTurns,
    // Don't inherit ULW/goal auto-arm into child
    goal: { ...ctx.config.goal, autoArm: false },
    permissionMode: resolveChildPermissionMode(
      subagentType,
      capabilityMode,
      ctx.config.permissionMode,
    ),
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
    maxTurns: childMaxTurns,
  });

  let result: LoopResult | undefined;
  let runError: string | undefined;
  try {
    const liveSpend = () => formatLiveChildSpend(child.meta);
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
        onStatus: (msg) => {
          const spend = liveSpend();
          ctx.events?.onStatus?.(spend && !msg.includes(spend) ? `${msg}${spend}` : msg);
        },
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
      citeDeltaStop: subagentType === "explore",
    });
  } catch (err) {
    runError = (err as Error).message;
  }

  if (result) {
    // Same-workspace child edits count toward parent edit trail.
    // Worktree isolation defers the bump until a successful land (below).
    if (isolation !== "worktree" && child.meta.editCount > 0) {
      ctx.parentSession.meta.editCount += child.meta.editCount;
      ctx.parentSession.meta.lastEditAt =
        child.meta.lastEditAt || new Date().toISOString();
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

  const status = resolveSubagentHandoffStatus({
    error: runError,
    aborted: result?.aborted,
    hitMaxTurns: result?.hitMaxTurns,
    stopHookBlocked: stopHook.blocked,
  });
  const incomplete = status !== "completed";
  const usage = resolveChildUsage(child.meta, result);
  const usageRecord = buildSubagentUsageRecord({
    sessionId: child.meta.id,
    description,
    subagentType,
    status,
    turns: result?.turns ?? child.meta.providerRounds ?? 0,
    maxTurns: childMaxTurns,
    usage,
    provider: String(ctx.config.provider || child.meta.provider),
    model: ctx.config.model || child.meta.model,
  });
  foldChildUsage(ctx.parentSession.meta, usageRecord);
  try {
    saveSession(ctx.parentSession);
  } catch {
    /* */
  }

  if (incomplete) {
    const synthesized = synthesizeSubagentFindings(child.messages);
    try {
      const mem = loadDecisionMemory(child.meta.id);
      const recs = mem.records.filter((r) => r.status === "active").slice(-12);
      if (recs.length) {
        text +=
          `\n\n## Child decisions\n` +
          recs.map((r) => `- [${r.kind}] ${r.text}`).join("\n");
      }
    } catch {
      /* */
    }
    text = text
      ? `${text}\n\n${synthesized}`
      : synthesized;
    const last = (result?.finalText || "").trim();
    if (last) {
      text += `\n\n## last_assistant_excerpt\n${last.slice(0, 2000)}`;
    }
  }

  const keepSession =
    process.env.FORGE_SUBAGENT_KEEP === "1" ||
    process.env.FORGE_SUBAGENT_KEEP === "true";

  // Collapse the essay to a map before land is appended so the land
  // summary is not thrown away.
  const map = parseExploreMap(text);
  if (map) {
    rememberExploreMap(ctx.parentSession.meta, {
      ...map,
      childSessionId: child.meta.id,
    });
    text = formatExploreMap(map);
    try {
      saveSession(ctx.parentSession);
    } catch {
      /* */
    }
  }
  if (subagentType === "explore" && status === "completed") {
    try {
      noteExploreChildCompleted(ctx.parentSession.meta.id);
    } catch {
      /* parent ULW sidecar optional */
    }
  }

  // Worktree land: capture diff and apply into the parent workspace by default
  // so isolation=worktree is not a dead-end. Keep on conflict / KEEP_WORKTREE /
  // aborted runs (skip apply but preserve the worktree for recovery).
  const forceKeepWorktree =
    process.env.FORGE_SUBAGENT_KEEP_WORKTREE === "1" ||
    process.env.FORGE_SUBAGENT_KEEP_WORKTREE === "true" ||
    process.env.FORGE_SUBAGENT_KEEP === "1" ||
    process.env.FORGE_SUBAGENT_KEEP === "true";
  let worktreeLand: WorktreeLandResult | undefined;
  let worktreeKept = false;
  if (worktree) {
    const skipApply = Boolean(
      runError || result?.aborted || (result?.hitMaxTurns && child.meta.editCount === 0),
    );
    worktreeLand = await landSubagentWorktree({
      worktree,
      parentWorkspace: ctx.workspace,
      forceKeep: forceKeepWorktree,
      skipApply,
      sessionId: ctx.parentSession.meta.id,
      turn: ctx.parentSession.meta.turnCount,
    });
    worktreeKept = worktreeLand.kept;
    const landBlock = formatWorktreeLandSummary(worktreeLand);
    text = text ? `${text}\n\n${landBlock}` : landBlock;
    if (worktreeLand.status === "applied") {
      log.dim(
        `Subagent worktree landed (${worktreeLand.changedFiles.length} file(s)) into ${worktreeLand.parentPath}`,
      );
      // Landed files now live in the parent tree — count toward edit trail so
      // proof-claim / verify-hint rails fire the same as a same-workspace subagent.
      const landed = Math.max(
        1,
        worktreeLand.changedFiles.length || child.meta.editCount || 0,
      );
      ctx.parentSession.meta.editCount =
        (ctx.parentSession.meta.editCount || 0) + landed;
      ctx.parentSession.meta.lastEditAt = new Date().toISOString();
      try {
        saveSession(ctx.parentSession);
      } catch {
        /* */
      }
    } else if (worktreeKept) {
      log.dim(
        `Subagent worktree kept (${worktreeLand.status}): ${worktree.path}`,
      );
    }
  }

  const header = formatSubagentHeader({
    description,
    subagentType,
    capabilityMode,
    turns: result?.turns ?? 0,
    maxTurns: childMaxTurns,
    editCount: child.meta.editCount,
    status,
    sessionId: child.meta.id,
    aborted: Boolean(result?.aborted),
    hitMaxTurns: Boolean(result?.hitMaxTurns),
    error: runError,
    isolation,
    worktreePath: worktree?.path,
    worktreeKept,
    worktreeLandStatus: worktreeLand?.status,
    usage,
    estCostUsd: usageRecord.estCostUsd,
  });

  let artifactPath: string | undefined;
  try {
    artifactPath = writeSubagentArtifact({
      childId: child.meta.id,
      header,
      body: text || "(no output)",
    });
  } catch (err) {
    log.warn(
      `Failed to write subagent artifact: ${(err as Error).message}`.slice(0, 200),
    );
  }

  const summary = formatSubagentResult({
    text,
    header,
    artifactPath,
  });

  // Delete only after the artifact exists, and only on a clean Stop.
  // Incomplete runs keep the child session so the parent can recover.
  if (!keepSession && status === "completed" && artifactPath) {
    await cleanupChildSession(child.meta.id);
  } else if (keepSession || incomplete) {
    log.dim(
      `Subagent session kept (${status}): ${child.meta.id}` +
        (artifactPath ? ` · ${artifactPath}` : ""),
    );
  }

  return {
    ok: status === "completed",
    text: summary,
    turns: result?.turns ?? 0,
    aborted: Boolean(result?.aborted),
    subagentType,
    capabilityMode,
    description,
    sessionId: child.meta.id,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheReadTokens: usage.cacheReadTokens,
    editCount: child.meta.editCount,
    error: runError,
    isolation,
    worktreePath: worktree?.path,
    worktreeLand,
    hitMaxTurns: Boolean(result?.hitMaxTurns),
    status,
    artifactPath,
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
  maxTurns?: number;
}): string {
  const lines = [
    `[Forge subagent — ${opts.subagentType} / ${opts.capabilityMode}` +
      (opts.isolation === "worktree" ? " / worktree" : "") +
      `]`,
    `Task: ${opts.description}`,
    opts.maxTurns
      ? `Turn budget: ${opts.maxTurns} (reserve the last turn for the structured report).`
      : "",
    ``,
    opts.capabilityMode === "read-only"
      ? "You are read-only: research and report. Do not modify files or run mutating shell commands."
      : "Complete the task thoroughly. Prefer verification after edits.",
    opts.subagentType === "plan"
      ? "Deliver a concrete implementation plan (goal, steps, risks, verification). Do not implement."
      : opts.subagentType === "explore"
        ? [
            "You are a file-search specialist. Grep/glob/read only.",
            "Return a short map, not an essay:",
            "pick: <one sentence>",
            "passed_on: <what you skipped>",
            "files:",
            "  <path>:<line>  <claim>",
            "Stop when new searches cite no new paths.",
          ].join("\n")
        : "Implement or investigate as asked. Return a concise final summary of what you found/did and any remaining risks.",
  ];
  if (opts.isolation === "worktree" && opts.worktreePath) {
    lines.push(
      ``,
      `## Isolated worktree`,
      `Workspace: ${opts.worktreePath}`,
      `This is a detached git worktree — edit freely here; the parent checkout stays clean until you finish.`,
      `On success, Forge captures your diff and lands it into the parent workspace automatically.`,
      `Summarize files changed and residual risks; do not ask the parent to manually merge unless land conflicts.`,
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

function formatSubagentHeader(opts: {
  description: string;
  subagentType: SubagentType;
  capabilityMode: SubagentCapability;
  turns: number;
  maxTurns: number;
  editCount: number;
  status: SubagentHandoffStatus;
  sessionId: string;
  aborted: boolean;
  hitMaxTurns: boolean;
  error?: string;
  isolation?: SubagentIsolation;
  worktreePath?: string;
  worktreeKept?: boolean;
  worktreeLandStatus?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
  };
  estCostUsd?: number;
}): string {
  const landBit = opts.worktreeLandStatus
    ? ` · land: ${opts.worktreeLandStatus}`
    : "";
  const tokensLine =
    opts.usage && opts.estCostUsd != null
      ? formatSubagentTokensHeader(opts.usage, opts.estCostUsd)
      : "";
  return [
    `### Subagent result: ${opts.description}`,
    `- status: ${opts.status}`,
    `- type: ${opts.subagentType} · mode: ${opts.capabilityMode} · turns: ${opts.turns}/${opts.maxTurns} · edits: ${opts.editCount}` +
      (opts.isolation === "worktree" ? " · isolation: worktree" : "") +
      landBit,
    `- session_id: ${opts.sessionId}`,
    tokensLine,
    opts.worktreePath
      ? `- worktree: ${opts.worktreePath}${opts.worktreeKept ? " (kept)" : " (removed)"}`
      : "",
    opts.aborted ? `- aborted: true` : "",
    opts.hitMaxTurns ? `- hit max turns` : "",
    opts.error ? `- error: ${opts.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatSubagentResult(opts: {
  text: string;
  header: string;
  artifactPath?: string;
}): string {
  const header = opts.artifactPath
    ? `${opts.header}\n- artifact_path: ${opts.artifactPath}`
    : opts.header;
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

/** Live subagent dashboard entries (in-process). */
export interface ActiveSubagentInfo {
  id: string;
  description: string;
  type: string;
  isolation: string;
  startedAt: number;
}
const activeSubagentInfo = new Map<string, ActiveSubagentInfo>();

export function listActiveSubagents(): ActiveSubagentInfo[] {
  return [...activeSubagentInfo.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export async function runSubagentTracked(
  req: SubagentRequest,
  ctx: SubagentRunContext,
): Promise<SubagentResult> {
  activeSubagents += 1;
  const trackId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  activeSubagentInfo.set(trackId, {
    id: trackId,
    description: String(req.description || "subagent").slice(0, 80),
    type: String(req.subagentType || "general-purpose"),
    isolation: defaultIsolationForSpawn({
      type: req.subagentType,
      isolation: req.isolation,
      workspace: ctx.workspace,
    }),
    startedAt: Date.now(),
  });
  try {
    return await runSubagent(req, ctx);
  } finally {
    activeSubagentInfo.delete(trackId);
    activeSubagents = Math.max(0, activeSubagents - 1);
  }
}
