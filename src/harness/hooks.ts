/**
 * Claude Code–compatible hooks with one critical upgrade over Grok Build:
 * **Stop hooks can block** the agent from finishing (exit code 2 or decision:block).
 *
 * Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse,
 * PostToolUseFailure, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact,
 * PostCompact, Notification, PermissionDenied.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { forgeHome, readJsonFile, pathExists } from "../util/fs.js";
import { log } from "../util/log.js";
import type { ForgeConfig } from "../config/types.js";

export type HookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop"
  | "StopFailure"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  | "Notification"
  | "PermissionDenied";

export type HookDecision = "allow" | "deny" | "block" | "ask";

export interface HookCommand {
  type: "command" | "http";
  command?: string;
  url?: string;
  timeout?: number;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export interface HooksConfig {
  hooks: Partial<Record<HookEvent | string, HookMatcher[]>>;
}

export interface HookContext {
  sessionId: string;
  cwd: string;
  workspaceRoot: string;
  transcriptPath?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  toolUseId?: string;
  prompt?: string;
  stopReason?: string;
  /** Set when goal/ultrawork is active */
  goalObjective?: string;
  ultrawork?: boolean;
  turnCount?: number;
  editCount?: number;
  lastAssistantMessage?: string;
}

export interface HookResult {
  decision: HookDecision;
  reason?: string;
  /** Additional context injected into the next model turn */
  additionalContext?: string;
  systemMessage?: string;
  /** For Stop: true means force the agent to continue working */
  blocked: boolean;
  raw?: unknown;
}

const TOOL_ALIASES: Record<string, string[]> = {
  Bash: ["run_terminal_command", "bash", "shell"],
  run_terminal_command: ["Bash", "bash", "shell"],
  Read: ["read_file", "read"],
  read_file: ["Read", "read"],
  Edit: ["search_replace", "edit", "Write", "write_file"],
  Write: ["write_file", "search_replace", "Edit"],
  search_replace: ["Edit", "Write", "MultiEdit"],
  Grep: ["grep"],
  grep: ["Grep"],
  Glob: ["glob", "list_dir"],
  list_dir: ["Glob", "ListDir"],
  WebSearch: ["web_search"],
  web_search: ["WebSearch"],
  Task: ["spawn_subagent"],
  spawn_subagent: ["Task"],
};

const CURSOR_EVENT_MAP: Record<string, HookEvent> = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  beforeShellExecution: "PreToolUse",
  beforeMCPExecution: "PreToolUse",
  beforeReadFile: "PreToolUse",
  afterShellExecution: "PostToolUse",
  afterMCPExecution: "PostToolUse",
  afterFileEdit: "PostToolUse",
  afterAgentResponse: "PostToolUse",
  beforeSubmitPrompt: "UserPromptSubmit",
  subagentStart: "SubagentStart",
  subagentStop: "SubagentStop",
  preCompact: "PreCompact",
  stop: "Stop",
};

function normalizeEventName(name: string): HookEvent | string {
  if (CURSOR_EVENT_MAP[name]) return CURSOR_EVENT_MAP[name];
  // Claude/Grok style already PascalCase
  return name;
}

function matcherHits(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === "" || matcher === "*") return true;
  if (!toolName) return true;
  try {
    const re = new RegExp(matcher);
    if (re.test(toolName)) return true;
    const aliases = TOOL_ALIASES[toolName] || [];
    if (aliases.some((a) => re.test(a))) return true;
    // Also test if matcher is an alias of toolName
    for (const [canonical, list] of Object.entries(TOOL_ALIASES)) {
      if (re.test(canonical) && (toolName === canonical || list.includes(toolName))) {
        return true;
      }
    }
    return false;
  } catch {
    return matcher === toolName;
  }
}

function loadHookFile(file: string): HooksConfig | null {
  try {
    const data = readJsonFile<HooksConfig | { hooks?: HooksConfig["hooks"] }>(file, {});
    if (!data || typeof data !== "object") return null;
    if ("hooks" in data && data.hooks) return data as HooksConfig;
    // bare map of events
    return { hooks: data as HooksConfig["hooks"] };
  } catch {
    return null;
  }
}

function collectHookFiles(config: ForgeConfig, cwd: string): string[] {
  const files: string[] = [];
  const home = forgeHome();

  // Global forge hooks
  const globalDir = path.join(home, "hooks");
  if (pathExists(globalDir)) {
    for (const f of fs.readdirSync(globalDir)) {
      if (f.endsWith(".json")) files.push(path.join(globalDir, f));
    }
  }

  // Project forge hooks
  const projectDir = path.join(cwd, ".forge", "hooks");
  if (pathExists(projectDir)) {
    for (const f of fs.readdirSync(projectDir)) {
      if (f.endsWith(".json")) files.push(path.join(projectDir, f));
    }
  }

  // Claude compatibility
  if (config.compatClaudeHooks) {
    for (const p of [
      path.join(home, "..", ".claude", "settings.json"),
      path.join(process.env.HOME || "", ".claude", "settings.json"),
      path.join(cwd, ".claude", "settings.json"),
      path.join(cwd, ".claude", "settings.local.json"),
    ]) {
      if (pathExists(p)) files.push(p);
    }
  }

  // Cursor compatibility
  if (config.compatCursorHooks) {
    for (const p of [
      path.join(process.env.HOME || "", ".cursor", "hooks.json"),
      path.join(cwd, ".cursor", "hooks.json"),
    ]) {
      if (pathExists(p)) files.push(p);
    }
  }

  return [...new Set(files)];
}

export class HookRunner {
  private matchers: Map<string, HookMatcher[]> = new Map();
  private config: ForgeConfig;
  private cwd: string;

  constructor(config: ForgeConfig, cwd: string) {
    this.config = config;
    this.cwd = cwd;
    this.reload();
  }

  reload(): void {
    this.matchers.clear();
    for (const file of collectHookFiles(this.config, this.cwd)) {
      const cfg = loadHookFile(file);
      if (!cfg?.hooks) continue;
      for (const [rawEvent, list] of Object.entries(cfg.hooks)) {
        if (!Array.isArray(list)) continue;
        const event = normalizeEventName(rawEvent);
        const existing = this.matchers.get(event) || [];
        // For Claude settings.json, hooks may live under settings.hooks
        existing.push(...list);
        this.matchers.set(event, existing);
      }
    }
    // Claude settings wrap hooks differently: { hooks: { Stop: [...] } }
    // Also support full settings files where hooks is nested.
    for (const file of collectHookFiles(this.config, this.cwd)) {
      try {
        const raw = readJsonFile<Record<string, unknown>>(file, {});
        if (raw.hooks && typeof raw.hooks === "object" && !Array.isArray(raw.hooks)) {
          // already handled
        }
      } catch {
        /* */
      }
    }
  }

  list(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.matchers) out[k] = v.length;
    return out;
  }

  async run(event: HookEvent, ctx: HookContext): Promise<HookResult> {
    const matchers = this.matchers.get(event) || [];
    const result: HookResult = { decision: "allow", blocked: false };
    const contexts: string[] = [];
    const messages: string[] = [];

    for (const m of matchers) {
      if (!matcherHits(m.matcher, ctx.toolName)) continue;
      for (const hook of m.hooks) {
        const r = await this.execOne(event, hook, ctx);
        if (r.additionalContext) contexts.push(r.additionalContext);
        if (r.systemMessage) messages.push(r.systemMessage);
        if (r.reason) result.reason = r.reason;
        if (r.decision === "deny" || r.decision === "block" || r.blocked) {
          result.decision = event === "Stop" || event === "SubagentStop" ? "block" : "deny";
          result.blocked = true;
          result.reason = r.reason || result.reason || "blocked by hook";
        }
      }
    }

    if (contexts.length) result.additionalContext = contexts.join("\n\n");
    if (messages.length) result.systemMessage = messages.join("\n");
    return result;
  }

  private async execOne(
    event: HookEvent,
    hook: HookCommand,
    ctx: HookContext,
  ): Promise<HookResult> {
    if (hook.type === "http" && hook.url) {
      return this.execHttp(event, hook, ctx);
    }
    if (hook.command) {
      return this.execCommand(event, hook, ctx);
    }
    return { decision: "allow", blocked: false };
  }

  private payload(event: HookEvent, ctx: HookContext): Record<string, unknown> {
    return {
      hookEventName: event,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      workspaceRoot: ctx.workspaceRoot,
      transcriptPath: ctx.transcriptPath,
      toolName: ctx.toolName,
      toolInput: ctx.toolInput,
      toolOutput: ctx.toolOutput,
      toolUseId: ctx.toolUseId,
      prompt: ctx.prompt,
      stopReason: ctx.stopReason,
      goalObjective: ctx.goalObjective,
      ultrawork: ctx.ultrawork,
      turnCount: ctx.turnCount,
      editCount: ctx.editCount,
      lastAssistantMessage: ctx.lastAssistantMessage,
      timestamp: new Date().toISOString(),
    };
  }

  private async execCommand(
    event: HookEvent,
    hook: HookCommand,
    ctx: HookContext,
  ): Promise<HookResult> {
    const rawTimeoutSec =
        typeof hook.timeout === "number" && Number.isFinite(hook.timeout)
          ? hook.timeout
          : 30;
      // Floor 1s — timeout:0 would fire immediately and fail-closed Stop forever.
      const timeoutMs = Math.max(1, rawTimeoutSec) * 1000;
    const payload = JSON.stringify(this.payload(event, ctx));

    return new Promise((resolve) => {
      const child = spawn(hook.command!, {
        shell: true,
        cwd: ctx.cwd,
        env: {
          ...process.env,
          FORGE_SESSION_ID: ctx.sessionId,
          FORGE_CWD: ctx.cwd,
          FORGE_HOOK_EVENT: event,
          CLAUDE_PROJECT_DIR: ctx.workspaceRoot,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (r: HookResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const isStopEvent = event === "Stop" || event === "SubagentStop";
      // Blocking Stop is the product differentiator — timeout/error must not
      // silently release the agent (Grok-style fail-open). Other events stay
      // fail-open so a flaky PreToolUse hook cannot freeze the session.
      const stopFailClosed =
        isStopEvent && this.config.blockingStopHooks !== false;

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        log.warn(`Hook timed out (${event}): ${hook.command}`);
        if (stopFailClosed) {
          const reason =
            `Stop hook timed out after ${Math.round(timeoutMs / 1000)}s — ` +
            `keeping agent working (blocking Stop fail-closed). ` +
            `Raise hook timeout or fix: ${hook.command}`;
          finish({
            decision: "block",
            blocked: true,
            reason,
            additionalContext: reason,
            systemMessage: reason,
          });
        } else {
          finish({ decision: "allow", blocked: false });
        }
      }, timeoutMs);

      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        log.warn(`Hook error (${event}): ${err.message}`);
        if (stopFailClosed) {
          const reason =
            `Stop hook error: ${err.message} — keeping agent working ` +
            `(blocking Stop fail-closed).`;
          finish({
            decision: "block",
            blocked: true,
            reason,
            additionalContext: reason,
            systemMessage: reason,
          });
        } else {
          finish({ decision: "allow", blocked: false });
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // Exit code 2 = explicit deny/block (Claude Code convention)
        if (code === 2) {
          const reason = stderr.trim() || stdout.trim() || "hook exit code 2";
          const isStop = event === "Stop" || event === "SubagentStop";
          finish({
            decision: isStop ? "block" : "deny",
            blocked: true,
            reason,
            additionalContext: isStop ? reason : undefined,
            systemMessage: reason,
          });
          return;
        }

        // Parse JSON stdout if present
        const trimmed = stdout.trim();
        if (trimmed) {
          try {
            // Take last JSON object if mixed with logs
            const jsonStart = trimmed.indexOf("{");
            if (jsonStart >= 0) {
              const obj = JSON.parse(trimmed.slice(jsonStart)) as {
                decision?: string;
                reason?: string;
                permissionDecision?: string;
                hookSpecificOutput?: {
                  permissionDecision?: string;
                  additionalContext?: string;
                };
                additionalContext?: string;
                systemMessage?: string;
                continue?: boolean;
              };
              const decision =
                obj.decision ||
                obj.permissionDecision ||
                obj.hookSpecificOutput?.permissionDecision ||
                "allow";
              const isBlock =
                decision === "deny" ||
                decision === "block" ||
                obj.continue === false;
              const reason = obj.reason;
              const additionalContext =
                obj.additionalContext ||
                obj.hookSpecificOutput?.additionalContext ||
                (isBlock && (event === "Stop" || event === "SubagentStop")
                  ? reason
                  : undefined);
              finish({
                decision: isBlock
                  ? event === "Stop" || event === "SubagentStop"
                    ? "block"
                    : "deny"
                  : "allow",
                blocked: Boolean(isBlock),
                reason,
                additionalContext,
                systemMessage: obj.systemMessage || reason,
                raw: obj,
              });
              return;
            }
          } catch {
            /* treat as plain text context for Stop */
            if (
              (event === "Stop" || event === "SubagentStop") &&
              this.config.blockingStopHooks &&
              code === 0 &&
              /block|continue|not done|incomplete/i.test(trimmed)
            ) {
              // only block on structured decision — plain text is systemMessage only
            }
          }
        }

        if (code !== 0 && code !== null) {
          log.debug(`Hook exited ${code} (${event}): ${stderr.slice(0, 200)}`);
        }
        finish({
          decision: "allow",
          blocked: false,
          systemMessage: stderr.trim() || undefined,
          additionalContext: undefined,
        });
      });

      child.stdin.write(payload);
      child.stdin.end();
    });
  }

  private async execHttp(
    event: HookEvent,
    hook: HookCommand,
    ctx: HookContext,
  ): Promise<HookResult> {
    try {
      const resp = await fetch(hook.url!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.payload(event, ctx)),
        signal: AbortSignal.timeout(Math.max(1, (typeof hook.timeout === "number" && Number.isFinite(hook.timeout) ? hook.timeout : 10)) * 1000),
      });
      if (!resp.ok) return { decision: "allow", blocked: false };
      const obj = (await resp.json()) as {
        decision?: string;
        reason?: string;
        additionalContext?: string;
      };
      const isBlock = obj.decision === "deny" || obj.decision === "block";
      return {
        decision: isBlock ? "block" : "allow",
        blocked: isBlock,
        reason: obj.reason,
        additionalContext: obj.additionalContext,
      };
    } catch (err) {
      log.debug(`HTTP hook failed: ${(err as Error).message}`);
      return { decision: "allow", blocked: false };
    }
  }
}
