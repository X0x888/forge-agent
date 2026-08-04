import type { ForgeConfig, PermissionMode } from "../config/types.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import chalk from "chalk";
import { isSoftDangerousBash, checkBashHardDeny } from "./safety.js";
import { compileRules, evaluateRules, patternToRegExp, type RulesEvaluation } from "./rules.js";
import {
  commandCheckTargets,
  containsPipe,
  containsRedirection,
  extractCommandPaths,
  normalizeSegment,
} from "./shell-parse.js";
import { alwaysPatternFromCommand, isReadOnlyCommand } from "./shell-arity.js";
import { addSavedAllow, loadSavedAllows, savedAsAllowRules } from "./permission-saved.js";
import { logSandboxEvent } from "./sandbox-log.js";
import { isWithinRoot } from "../util/fs.js";
import { formatPermissionPreview } from "../util/format.js";
import { editToolDiffPreview } from "./permission-preview.js";
import { isTruthy } from "../util/bool.js";
import { parseDurationMs } from "../util/duration-ms.js";

const WRITE_TOOLS = new Set([
  "write_file",
  "search_replace",
  "apply_patch",
  "edit",
  "Write",
  "Edit",
  "ApplyPatch",
]);

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
  "mcp_search",
  "lsp",
  "LSP",
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "ListDir",
]);


export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  mode: PermissionMode;
  workspace?: string;
  config?: ForgeConfig;
}

/**
 * Serialize interactive permission prompts: parallel read-only tool batches
 * (Promise.all in loop.ts) can fire several asks at once, and concurrent
 * readline interfaces on the same stdin race and garble answers. One prompt
 * at a time, queued; non-interactive paths never touch this chain.
 * Exported for unit tests.
 */
let promptChain: Promise<unknown> = Promise.resolve();

export function enqueuePrompt<T>(fn: () => Promise<T>): Promise<T> {
  const run = promptChain.then(fn);
  // Keep the chain alive after rejections (stored link swallows; the caller
  // still receives the real rejection via `run`).
  promptChain = run.catch(() => {});
  return run;
}

/**
 * Display label for the [a]lways grant line — mirrors savedAsAllowRules
 * (Bash(...)/Write(...)/…) so the prompt shows exactly what gets persisted.
 * Exported for unit tests.
 */
export function alwaysGrantLabel(tool: string, pattern: string): string {
  const label =
    tool === "bash"
      ? "Bash"
      : tool === "write_file"
        ? "Write"
        : tool === "search_replace"
          ? "Edit"
          : tool === "read_file"
            ? "Read"
            : tool;
  return `${label}(${pattern})`;
}

/** Warp-inspired decision with explainable reason. */
export type PermissionResult = {
  decision: "allow" | "deny" | "allow_session";
  reason: string;
  rule?: string;
};

export class PermissionGate {
  /** Session-scoped always patterns: `tool:pattern` */
  private sessionPatterns = new Set<string>();
  private sessionTools = new Set<string>();
  private interactive: boolean;

  constructor(opts: { interactive?: boolean } = {}) {
    this.interactive = opts.interactive !== false;
  }

  isDangerous(toolName: string, toolInput: Record<string, unknown>): boolean {
    if (toolName === "bash" || toolName === "run_terminal_command") {
      const cmd = String(toolInput.command || "");
      if (!checkBashHardDeny(cmd).ok) return true;
      if (containsRedirection(cmd)) return true;
      if (containsPipe(cmd)) return true;
      return commandCheckTargets(cmd).some((s) => isSoftDangerousBash(s));
    }
    return false;
  }

  private isNonInteractive(): boolean {
    return !this.interactive || !process.stdin.isTTY;
  }

  /** acceptEdits: every segment must look read-only, no pipes/redirects. */
  private isReadOnlyShell(cmd: string): boolean {
    if (containsRedirection(cmd) || containsPipe(cmd)) return false;
    const segments = commandCheckTargets(cmd);
    const check = segments.length ? segments : [cmd];
    return check.every((s) => isReadOnlyCommand(normalizeSegment(s)));
  }

  /**
   * web_fetch with allow_local can reach loopback — not a free read-only tool.
   * Requires allow rule, interactive approval, pattern-always, or YOLO.
   * Session-tool alone is intentionally insufficient.
   */
  private isLocalWebFetch(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): boolean {
    if (toolName !== "web_fetch" && toolName !== "WebFetch") return false;
    // Shared isTruthy — Boolean("false") must not open loopback.
    return isTruthy(toolInput.allow_local);
  }

  async request(req: PermissionRequest): Promise<PermissionResult> {
    const { toolName, input: toolInput, mode } = req;
    const workspace = req.workspace || process.cwd();
    const config = req.config;

    // 1. Hard deny ALWAYS
    if (toolName === "bash" || toolName === "run_terminal_command") {
      const hard = checkBashHardDeny(String(toolInput.command || ""));
      if (!hard.ok) {
        console.error(chalk.red(`\n✖ HARD DENY [${hard.rule}]: ${hard.reason}\n`));
        logSandboxEvent({
          type: "hard_deny",
          rule: hard.rule,
          reason: hard.reason,
          command: String(toolInput.command || ""),
        });
        return { decision: "deny", reason: hard.reason, rule: hard.rule };
      }
    }

    // 2. External directory (OpenCode-inspired)
    const ext = this.checkExternalDirectory(toolName, toolInput, workspace, mode, config);
    if (ext) {
      if (ext.decision === "deny") {
        console.error(chalk.red(`\n✖ EXTERNAL DIR: ${ext.reason}\n`));
        logSandboxEvent({
          type: "external_dir",
          reason: ext.reason,
          path: String(toolInput.path || toolInput.command || ""),
        });
      }
      if (ext.decision !== "ask") return ext;
      if (this.isNonInteractive()) {
        return { decision: "deny", reason: "external_directory requires approval (non-interactive)" };
      }
      return this.promptUser(toolName, toolInput, true, {
        alwaysPattern: ext.rule || "external_directory",
        workspace,
        reasonHint: ext.reason,
      });
    }

    // 3. Config permission rules — deny always wins under YOLO
    let rulesEval: RulesEvaluation | undefined;
    if (config) {
      const saved = savedAsAllowRules(workspace);
      const rules = compileRules({
        deny: config.permission?.deny,
        allow: [...(config.permission?.allow || []), ...saved],
        ask: config.permission?.ask,
        rules: config.permission?.rules,
      });
      for (const key of this.sessionPatterns) {
        const [tool, ...rest] = key.split(":");
        const pat = rest.join(":");
        rules.push({ action: "allow", tool, pattern: pat, raw: `${tool}(${pat})` });
      }
      rulesEval = evaluateRules(rules, toolName, toolInput, workspace);
      if (rulesEval.decision === "deny" && rulesEval.deny) {
        const msg = `RULE DENY: ${rulesEval.deny.rule.raw || rulesEval.deny.rule.pattern}`;
        console.error(chalk.red(`\n✖ ${msg}\n`));
        logSandboxEvent({
          type: "rule_deny",
          reason: msg,
          rule: rulesEval.deny.rule.pattern,
          command: String(toolInput.command || ""),
        });
        return {
          decision: "deny",
          reason: msg,
          rule: rulesEval.deny.rule.pattern,
        };
      }
    }

    // 4. YOLO
    if (mode === "bypassPermissions") {
      if (
        rulesEval?.decision === "ask" &&
        (toolName === "bash" || toolName === "run_terminal_command") &&
        !this.isNonInteractive()
      ) {
        return this.promptUser(toolName, toolInput, true, { workspace });
      }
      return { decision: "allow", reason: "bypassPermissions" };
    }

    // 5. dontAsk
    if (mode === "dontAsk") {
      if (rulesEval?.decision === "allow") {
        return { decision: "allow", reason: "allow_rule" };
      }
      if (this.isLocalWebFetch(toolName, toolInput)) {
        return {
          decision: "deny",
          reason:
            "web_fetch_allow_local_dontAsk: allow_local requires an allow rule or interactive approval",
        };
      }
      if (READ_ONLY_TOOLS.has(toolName)) {
        if (toolName === "read_file" || toolName === "Read") {
          const p = String(toolInput.path || "");
          if (p) {
            const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspace, p);
            if (!isWithinRoot(workspace, abs) && config?.readOutsideWorkspace === "deny") {
              return { decision: "deny", reason: "readOutsideWorkspace=deny" };
            }
          }
        }
        return { decision: "allow", reason: "read_only_tool" };
      }
      console.error(chalk.yellow(`\n✖ dontAsk: denied ${toolName} (no allow rule)\n`));
      return { decision: "deny", reason: "dontAsk" };
    }

    // Plan mode: permission-enforced (not prompt-only). Mutating tools denied.
    if (mode === "plan") {
      if (
        WRITE_TOOLS.has(toolName) ||
        toolName === "bash" ||
        toolName === "run_terminal_command" ||
        toolName === "kill_task" ||
        toolName === "spawn_subagent" ||
        toolName === "Task" ||
        toolName === "task"
      ) {
        return {
          decision: "deny",
          reason:
            "plan_mode: mutations denied — read/search/todo_write/search_mcp/lsp only; run /build (or leave plan) to implement",
          rule: "plan_mode",
        };
      }
      // call_mcp: allow only when the target tool is annotated/heuristic read-only
      if (
        toolName === "call_mcp" ||
        toolName === "mcp_call" ||
        toolName === "use_mcp"
      ) {
        const q = String(
          toolInput.tool_name || toolInput.name || toolInput.tool || "",
        );
        // Without manager context, fail closed on MCP mutations in plan
        const looksRead =
          /__(get|list|search|find|read|fetch|query|describe|show|lookup|inspect)_/i.test(
            q,
          ) ||
          /__(get|list|search|find|read|fetch|query|describe|show|lookup|inspect)$/i.test(
            q,
          );
        if (!looksRead && rulesEval?.decision !== "allow") {
          return {
            decision: "deny",
            reason:
              "plan_mode: call_mcp denied for non-read-only tools — use search_mcp or /build",
            rule: "plan_mode",
          };
        }
      }
      if (this.isLocalWebFetch(toolName, toolInput)) {
        // Explicit allow still wins (operators who need loopback in plan).
        if (rulesEval?.decision === "allow") {
          return { decision: "allow", reason: "allow_rule" };
        }
        return {
          decision: "deny",
          reason:
            "plan_mode: web_fetch allow_local denied — exit plan mode or add an allow rule",
          rule: "plan_mode",
        };
      }
      // todo_write, reads, grep, public web_*, search_mcp, lsp allowed for research
      return { decision: "allow", reason: "plan_read" };
    }

    // 6. Explicit allow (segment-strict for bash)
    if (rulesEval?.decision === "allow") {
      return { decision: "allow", reason: "allow_rule" };
    }

    // 7. Explicit ask
    if (rulesEval?.decision === "ask") {
      if (this.isNonInteractive()) {
        return { decision: "deny", reason: "ask_rule_noninteractive" };
      }
      return this.promptUser(toolName, toolInput, true, { workspace });
    }

    if (mode === "acceptEdits" && WRITE_TOOLS.has(toolName)) {
      return { decision: "allow", reason: "acceptEdits" };
    }

    if (this.sessionTools.has(toolName)) {
      // Session-tool for web_fetch must NOT free-pass allow_local: operators often
      // approve "s" on a public URL, then a later loopback fetch would slip through.
      if (this.isLocalWebFetch(toolName, toolInput)) {
        if (this.isNonInteractive()) {
          logSandboxEvent({
            type: "rule_deny",
            reason: "web_fetch_allow_local_noninteractive",
            path: String(toolInput.url || ""),
          });
          return {
            decision: "deny",
            reason:
              "web_fetch_allow_local_noninteractive: headless allow_local requires an allow rule, pattern always, or bypassPermissions (session-tool alone is not enough)",
          };
        }
        return this.promptUser(toolName, toolInput, true, {
          workspace,
          reasonHint:
            "web_fetch allow_local can reach loopback services — approve only if intentional (session-tool does not cover allow_local)",
        });
      }
      return { decision: "allow", reason: "session_tool" };
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
      // allow_local reaches loopback — not free under headless/auto-allow.
      if (this.isLocalWebFetch(toolName, toolInput)) {
        if (this.isNonInteractive()) {
          logSandboxEvent({
            type: "rule_deny",
            reason: "web_fetch_allow_local_noninteractive",
            path: String(toolInput.url || ""),
          });
          return {
            decision: "deny",
            reason:
              "web_fetch_allow_local_noninteractive: headless allow_local requires an allow rule, pattern always, or bypassPermissions",
          };
        }
        return this.promptUser(toolName, toolInput, true, {
          workspace,
          reasonHint:
            "web_fetch allow_local can reach loopback services — approve only if intentional",
        });
      }
      return { decision: "allow", reason: "read_only_tool" };
    }

    // acceptEdits + read-only shell (Warp-inspired) — every segment
    if (
      mode === "acceptEdits" &&
      (toolName === "bash" || toolName === "run_terminal_command")
    ) {
      const cmd = String(toolInput.command || "");
      if (this.isReadOnlyShell(cmd)) {
        return { decision: "allow", reason: "read_only_command" };
      }
    }

    const dangerous = this.isDangerous(toolName, toolInput);
    if (
      !dangerous &&
      mode === "acceptEdits" &&
      toolName !== "bash" &&
      toolName !== "run_terminal_command"
    ) {
      return { decision: "allow", reason: "acceptEdits_safe" };
    }

    // ── Fail-closed non-interactive (Bar A daily-driver) ──────────────
    // Headless default used to allow "safe-looking" shell (e.g. npm publish).
    // Now: shell/writes require allow-rules, YOLO, or acceptEdits+read-only/writes.
    if (this.isNonInteractive()) {
      if (toolName === "bash" || toolName === "run_terminal_command") {
        logSandboxEvent({
          type: "rule_deny",
          reason: "shell_noninteractive_deny",
          command: String(toolInput.command || ""),
        });
        return {
          decision: "deny",
          reason:
            "shell_noninteractive_deny: headless shell requires an allow rule, acceptEdits+read-only, or bypassPermissions",
        };
      }
      if (WRITE_TOOLS.has(toolName)) {
        return {
          decision: "deny",
          reason:
            "write_noninteractive_deny: headless writes require acceptEdits, allow rule, or bypassPermissions",
        };
      }
      if (toolName === "kill_task") {
        return { decision: "allow", reason: "kill_task_noninteractive" };
      }
      // Headless: explore/plan subagents are read-only — allow without YOLO.
      // Full general-purpose spawn still requires acceptEdits / allow / YOLO.
      if (
        toolName === "spawn_subagent" ||
        toolName === "Task" ||
        toolName === "task"
      ) {
        const t = String(
          toolInput.subagent_type || toolInput.type || toolInput.agent_type || "",
        )
          .toLowerCase()
          .replace(/_/g, "-");
        const modeRaw = String(
          toolInput.capability_mode || toolInput.mode || "",
        )
          .toLowerCase()
          .replace(/_/g, "-");
        if (
          t === "explore" ||
          t === "plan" ||
          t === "research" ||
          modeRaw === "read-only" ||
          modeRaw === "readonly"
        ) {
          return { decision: "allow", reason: "subagent_readonly_headless" };
        }
        if (mode === "acceptEdits") {
          return { decision: "allow", reason: "acceptEdits_subagent" };
        }
        return {
          decision: "deny",
          reason:
            "subagent_noninteractive_deny: full subagents require acceptEdits, allow rule, or bypassPermissions (explore/plan are free)",
        };
      }
      // call_mcp: allow heuristic read-only; otherwise need allow/YOLO
      if (
        toolName === "call_mcp" ||
        toolName === "mcp_call" ||
        toolName === "use_mcp"
      ) {
        const q = String(
          toolInput.tool_name || toolInput.name || toolInput.tool || "",
        );
        if (
          /__(get|list|search|find|read|fetch|query|describe|show|lookup|inspect)/i.test(
            q,
          )
        ) {
          return { decision: "allow", reason: "mcp_readonly_headless" };
        }
        if (mode === "acceptEdits") {
          return { decision: "allow", reason: "acceptEdits_mcp" };
        }
        return {
          decision: "deny",
          reason:
            "mcp_noninteractive_deny: non-read-only MCP calls require acceptEdits, allow rule, or bypassPermissions",
        };
      }
      return {
        decision: "deny",
        reason: dangerous
          ? "dangerous_noninteractive"
          : "noninteractive_require_approval",
      };
    }

    return this.promptUser(toolName, toolInput, dangerous, { workspace });
  }

  /**
   * Returns null if not external, or a result if decided, or decision ask.
   */
  private checkExternalDirectory(
    toolName: string,
    toolInput: Record<string, unknown>,
    workspace: string,
    mode: PermissionMode,
    config?: ForgeConfig,
  ): PermissionResult | { decision: "ask"; reason: string; rule?: string } | null {
    const policy = config?.readOutsideWorkspace ?? "ask";
    if (policy === "allow") return null;

    const outside: string[] = [];

    if (
      toolName === "read_file" ||
      toolName === "Read" ||
      toolName === "write_file" ||
      toolName === "Write" ||
      toolName === "search_replace" ||
      toolName === "Edit" ||
      toolName === "list_dir" ||
      toolName === "ListDir" ||
      // Search tools can read outside workspace via absolute `path` — gate them
      // the same as read_file so models cannot bypass with grep/glob of /etc, ~/.ssh, …
      toolName === "grep" ||
      toolName === "Grep" ||
      toolName === "glob" ||
      toolName === "Glob"
    ) {
      const p = String(toolInput.path || "");
      if (p) {
        const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspace, p);
        if (!isWithinRoot(workspace, abs)) outside.push(abs);
      }
    }

    if (toolName === "bash" || toolName === "run_terminal_command") {
      const cmd = String(toolInput.command || "");
      for (const raw of extractCommandPaths(cmd)) {
        const abs = raw.startsWith("~")
          ? path.join(process.env.HOME || "", raw.slice(1).replace(/^\//, "") || "")
          : path.isAbsolute(raw)
            ? path.resolve(raw)
            : path.resolve(workspace, raw);
        if (raw.includes("*") && !raw.includes("/")) continue;
        // Containment on the resolved path: `sub/../../etc/hosts` escapes the
        // workspace without starting with "..". Plain relatives only escape
        // via embedded ".." segments, so this adds no false positives.
        if (!isWithinRoot(workspace, abs)) {
          outside.push(abs);
        }
      }
    }

    if (outside.length === 0) return null;

    for (const p of outside) {
      const key = `external_directory:${path.dirname(p)}/*`;
      if (this.sessionPatterns.has(key) || this.sessionPatterns.has("external_directory:*")) {
        return null;
      }
    }

    // Persisted [a]lways grants: this gate runs before rule evaluation, so
    // consult the saved store directly (same bypass as session patterns).
    // An explicit readOutsideWorkspace:"deny" policy still wins.
    if (policy !== "deny") {
      for (const saved of loadSavedAllows(workspace)) {
        if (saved.tool !== "external_directory") continue;
        if (outside.some((p) => patternToRegExp(saved.pattern || "*").test(p))) {
          return null;
        }
      }
    }

    if (policy === "deny" || mode === "dontAsk" || mode === "plan") {
      return {
        decision: "deny",
        reason:
          `Path outside workspace: ${outside[0]}. ` +
          "Prefer workspace-relative paths, or set --read-outside ask|allow (writes stay sandboxed).",
        rule: "external_directory",
      };
    }

    if (mode === "bypassPermissions") {
      return null;
    }

    return {
      decision: "ask",
      reason:
        `Path outside workspace: ${outside[0]}. ` +
        "Allow once for this read, or use a workspace-relative path.",
      rule: `${path.dirname(outside[0])}/*`,
    };
  }

  private async promptUser(
    toolName: string,
    toolInput: Record<string, unknown>,
    dangerous: boolean,
    opts: { workspace?: string; alwaysPattern?: string; reasonHint?: string } = {},
  ): Promise<PermissionResult> {
    // One prompt at a time: parallel read-only batches (Promise.all in
    // loop.ts) otherwise open concurrent readlines on the same stdin.
    return enqueuePrompt(() =>
      this.promptUserExclusive(toolName, toolInput, dangerous, opts),
    );
  }

  private async promptUserExclusive(
    toolName: string,
    toolInput: Record<string, unknown>,
    dangerous: boolean,
    opts: { workspace?: string; alwaysPattern?: string; reasonHint?: string } = {},
  ): Promise<PermissionResult> {
    // Edit tools get a colored in-memory diff preview; everything else keeps
    // the plain text argument summary. Answer UX / timeout unchanged.
    const diffPreview = editToolDiffPreview(toolName, toolInput, opts.workspace);
    const preview =
      diffPreview ?? formatPermissionPreview(toolName, toolInput, 500);
    const timeoutMs = permissionAskTimeoutMs();
    const timeoutNote =
      timeoutMs > 0
        ? ` (auto-deny in ${Math.round(timeoutMs / 1000)}s)`
        : "";

    // Compute the [a]lways rule up front so the prompt shows the exact
    // pattern being granted — answering "a" on `rm -rf /tmp/x` persists a
    // blind `rm *` arity-1 rule, which must never be invisible.
    let alwaysTool =
      toolName === "run_terminal_command"
        ? "bash"
        : toolName === "Write"
          ? "write_file"
          : toolName === "Edit"
            ? "search_replace"
            : toolName === "ApplyPatch"
              ? "apply_patch"
              : toolName === "Read"
                ? "read_file"
                : toolName;
    // External-directory asks must persist under the key the checker
    // consults (external_directory:<dir>/*), not the real tool name —
    // only that call site passes alwaysPattern.
    if (opts.alwaysPattern) alwaysTool = "external_directory";
    const alwaysPattern =
      opts.alwaysPattern ||
      (alwaysTool === "bash"
        ? alwaysPatternFromCommand(String(toolInput.command || ""))
        : "*");

    console.error(
      chalk.yellow(
        `\n⚠ Permission: ${toolName}${dangerous ? " [DANGEROUS]" : ""}${opts.reasonHint ? `\n  ${opts.reasonHint}` : ""}\n`,
      ) + (diffPreview ? `${preview}\n` : chalk.yellow(`${preview}\n`)),
    );
    const rl = readline.createInterface({ input, output });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const question = rl.question(
        `Allow? [y]es once / [a]lways allow: ${alwaysGrantLabel(alwaysTool, alwaysPattern)} in this workspace / [s]ession tool / [n]o:${timeoutNote} `,
      );
      const ans = (
        await (timeoutMs > 0
          ? Promise.race([
              question,
              new Promise<string>((resolve) => {
                timer = setTimeout(() => resolve("__timeout__"), timeoutMs);
                timer.unref?.();
              }),
            ])
          : question)
      )
        .trim()
        .toLowerCase();

      if (ans === "__timeout__") {
        const secs = Math.round(timeoutMs / 1000);
        console.error(
          chalk.red(
            `\n✖ Permission timed out after ${secs}s — denying ${toolName}\n` +
              chalk.dim(
                `  Tip: answer sooner, raise FORGE_PERMISSION_ASK_TIMEOUT_MS, use /permissions acceptEdits, or --permission-mode dontAsk in CI\n`,
              ),
          ),
        );
        logSandboxEvent({
          type: "rule_deny",
          reason: `permission_ask_timeout:${toolName}`,
          command: toolName,
        });
        return {
          decision: "deny",
          reason:
            `permission_ask_timeout after ${secs}s — user did not answer. ` +
            `Raise FORGE_PERMISSION_ASK_TIMEOUT_MS, use /permissions acceptEdits, or --permission-mode dontAsk for unattended runs.`,
        };
      }
      if (ans === "n" || ans === "no") {
        return { decision: "deny", reason: "user_reject" };
      }
      if (ans === "s" || ans === "session") {
        this.sessionTools.add(toolName);
        return { decision: "allow_session", reason: "session_tool" };
      }
      if (ans === "a" || ans === "always") {
        this.sessionPatterns.add(`${alwaysTool}:${alwaysPattern}`);
        if (opts.workspace) {
          try {
            addSavedAllow({
              workspace: opts.workspace,
              tool: alwaysTool,
              pattern: alwaysPattern,
            });
          } catch {
            /* */
          }
        }
        return { decision: "allow", reason: `always:${alwaysPattern}` };
      }
      return { decision: "allow", reason: "user_once" };
    } finally {
      if (timer) clearTimeout(timer);
      rl.close();
    }
  }
}

/**
 * Interactive permission prompt timeout.
 * FORGE_PERMISSION_TIMEOUT_MS — 0/unset = wait forever; min 5s when set.
 */
export function permissionAskTimeoutMs(): number {
  const raw = process.env.FORGE_PERMISSION_TIMEOUT_MS?.trim();
  if (!raw) return 0;
  const parsed = parseDurationMs(raw);
  if (!parsed.ok || parsed.ms <= 0) return 0;
  return Math.max(5_000, parsed.ms);
}
