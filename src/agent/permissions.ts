import type { ForgeConfig, PermissionMode } from "../config/types.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import chalk from "chalk";
import { isSoftDangerousBash, checkBashHardDeny } from "./safety.js";
import { compileRules, evaluateRules, type RulesEvaluation } from "./rules.js";
import {
  commandCheckTargets,
  containsPipe,
  containsRedirection,
  extractCommandPaths,
  normalizeSegment,
  tokenizeSimple,
} from "./shell-parse.js";
import { alwaysPatternFromTokens, isReadOnlyCommand } from "./shell-arity.js";
import { addSavedAllow, savedAsAllowRules } from "./permission-saved.js";
import { logSandboxEvent } from "./sandbox-log.js";
import { isWithinRoot } from "../util/fs.js";

const WRITE_TOOLS = new Set([
  "write_file",
  "search_replace",
  "edit",
  "Write",
  "Edit",
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
        toolName === "kill_task"
      ) {
        return {
          decision: "deny",
          reason:
            "plan_mode: mutations denied — read/search/todo_write only; exit plan mode to implement",
          rule: "plan_mode",
        };
      }
      // todo_write, reads, grep, web_* allowed for research + plan structure
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
      return { decision: "allow", reason: "session_tool" };
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
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
      toolName === "ListDir"
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
        if (
          !isWithinRoot(workspace, abs) &&
          (path.isAbsolute(raw) || raw.startsWith("~") || raw.startsWith(".."))
        ) {
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

    if (policy === "deny" || mode === "dontAsk" || mode === "plan") {
      return {
        decision: "deny",
        reason: `Path outside workspace: ${outside[0]}`,
        rule: "external_directory",
      };
    }

    if (mode === "bypassPermissions") {
      return null;
    }

    return {
      decision: "ask",
      reason: `Path outside workspace: ${outside[0]}`,
      rule: `${path.dirname(outside[0])}/*`,
    };
  }

  private async promptUser(
    toolName: string,
    toolInput: Record<string, unknown>,
    dangerous: boolean,
    opts: { workspace?: string; alwaysPattern?: string; reasonHint?: string } = {},
  ): Promise<PermissionResult> {
    const preview = JSON.stringify(toolInput, null, 2).slice(0, 400);
    const alwaysPat =
      opts.alwaysPattern ||
      (toolName === "bash" || toolName === "run_terminal_command"
        ? alwaysPatternFromCommandTokens(String(toolInput.command || ""))
        : `${toolName} *`);

    console.error(
      chalk.yellow(
        `\n⚠ Permission: ${toolName}${dangerous ? " [DANGEROUS]" : ""}${opts.reasonHint ? `\n  ${opts.reasonHint}` : ""}\n${preview}\n`,
      ),
    );
    const rl = readline.createInterface({ input, output });
    try {
      const ans = (
        await rl.question(
          "Allow? [y]es once / [a]lways this pattern / [s]ession tool / [n]o: ",
        )
      )
        .trim()
        .toLowerCase();
      if (ans === "n" || ans === "no") {
        return { decision: "deny", reason: "user_reject" };
      }
      if (ans === "s" || ans === "session") {
        this.sessionTools.add(toolName);
        return { decision: "allow_session", reason: "session_tool" };
      }
      if (ans === "a" || ans === "always") {
        const tool =
          toolName === "run_terminal_command"
            ? "bash"
            : toolName === "Write"
              ? "write_file"
              : toolName === "Edit"
                ? "search_replace"
                : toolName === "Read"
                  ? "read_file"
                  : toolName;
        const pattern =
          opts.alwaysPattern ||
          (tool === "bash"
            ? alwaysPatternFromCommandTokens(String(toolInput.command || ""))
            : "*");
        this.sessionPatterns.add(`${tool}:${pattern}`);
        if (opts.workspace) {
          try {
            addSavedAllow({ workspace: opts.workspace, tool, pattern });
          } catch {
            /* */
          }
        }
        return { decision: "allow", reason: `always:${pattern}` };
      }
      return { decision: "allow", reason: "user_once" };
    } finally {
      rl.close();
    }
  }
}

function alwaysPatternFromCommandTokens(command: string): string {
  const segs = commandCheckTargets(command);
  const seg = segs[0] || command;
  const toks = tokenizeSimple(normalizeSegment(seg));
  const words: string[] = [];
  for (const t of toks) {
    if (t.startsWith("-") && words.length > 0) continue;
    words.push(t);
  }
  return alwaysPatternFromTokens(words.length ? words : toks);
}
