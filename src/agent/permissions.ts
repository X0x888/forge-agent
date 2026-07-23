import type { ForgeConfig, PermissionMode } from "../config/types.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { isSoftDangerousBash, checkBashHardDeny } from "./safety.js";
import { compileRules, evaluateRules, type RulesEvaluation } from "./rules.js";
import { commandCheckTargets } from "./shell-parse.js";

const WRITE_TOOLS = new Set([
  "write_file",
  "search_replace",
  "edit",
  "Write",
  "Edit",
]);

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  mode: PermissionMode;
  workspace?: string;
  config?: ForgeConfig;
}

export type PermissionDecision = "allow" | "deny" | "allow_session";

export class PermissionGate {
  private sessionAllows = new Set<string>();
  private interactive: boolean;

  constructor(opts: { interactive?: boolean } = {}) {
    this.interactive = opts.interactive !== false;
  }

  isDangerous(toolName: string, toolInput: Record<string, unknown>): boolean {
    if (toolName === "bash" || toolName === "run_terminal_command") {
      const cmd = String(toolInput.command || "");
      if (!checkBashHardDeny(cmd).ok) return true;
      // any segment soft-dangerous?
      return commandCheckTargets(cmd).some((s) => isSoftDangerousBash(s));
    }
    return false;
  }

  async request(req: PermissionRequest): Promise<PermissionDecision> {
    const { toolName, input: toolInput, mode } = req;
    const workspace = req.workspace || process.cwd();
    const config = req.config;

    // 1. Hard deny ALWAYS (segment-aware) — even YOLO
    if (toolName === "bash" || toolName === "run_terminal_command") {
      const hard = checkBashHardDeny(String(toolInput.command || ""));
      if (!hard.ok) {
        console.error(chalk.red(`\n✖ HARD DENY [${hard.rule}]: ${hard.reason}\n`));
        return "deny";
      }
    }

    // 2. Config permission rules — deny always wins under YOLO
    let rulesEval: RulesEvaluation | undefined;
    if (config?.permission) {
      const rules = compileRules(config.permission);
      rulesEval = evaluateRules(rules, toolName, toolInput, workspace);
      if (rulesEval.decision === "deny" && rulesEval.deny) {
        console.error(
          chalk.red(
            `\n✖ RULE DENY: ${rulesEval.deny.rule.raw || rulesEval.deny.rule.pattern} (matched: ${rulesEval.deny.matched.slice(0, 60)})\n`,
          ),
        );
        return "deny";
      }
    }

    // 3. YOLO: auto-allow except ask rules on bash (Grok parity)
    if (mode === "bypassPermissions") {
      if (
        rulesEval?.decision === "ask" &&
        (toolName === "bash" || toolName === "run_terminal_command") &&
        this.interactive &&
        process.stdin.isTTY
      ) {
        return this.promptUser(toolName, toolInput, true);
      }
      return "allow";
    }

    // 4. dontAsk: deny anything not explicitly allowed / read-only
    if (mode === "dontAsk") {
      if (rulesEval?.decision === "allow") return "allow";
      if (
        ["read_file", "grep", "glob", "list_dir", "web_search", "todo_write", "Read", "Grep", "Glob"].includes(
          toolName,
        )
      ) {
        return "allow";
      }
      // read-only shell segments only? keep simple: deny writes/shell
      console.error(chalk.yellow(`\n✖ dontAsk: denied ${toolName} (no allow rule)\n`));
      return "deny";
    }

    if (mode === "plan") {
      if (WRITE_TOOLS.has(toolName) || toolName === "bash" || toolName === "run_terminal_command") {
        return "deny";
      }
      return "allow";
    }

    // 5. Explicit allow rule short-circuits prompt
    if (rulesEval?.decision === "allow") return "allow";

    // 6. Explicit ask rule always prompts
    if (rulesEval?.decision === "ask") {
      if (!this.interactive || !process.stdin.isTTY) return "deny";
      return this.promptUser(toolName, toolInput, true);
    }

    if (mode === "acceptEdits" && WRITE_TOOLS.has(toolName)) {
      return "allow";
    }

    const key = `${toolName}:${JSON.stringify(toolInput).slice(0, 200)}`;
    if (this.sessionAllows.has(toolName) || this.sessionAllows.has(key)) {
      return "allow";
    }

    if (
      ["read_file", "grep", "glob", "list_dir", "web_search", "Read", "Grep", "Glob"].includes(
        toolName,
      )
    ) {
      return "allow";
    }

    const dangerous = this.isDangerous(toolName, toolInput);
    if (!dangerous && mode === "acceptEdits") return "allow";

    if (!this.interactive || !process.stdin.isTTY) {
      return dangerous ? "deny" : "allow";
    }

    return this.promptUser(toolName, toolInput, dangerous);
  }

  private async promptUser(
    toolName: string,
    toolInput: Record<string, unknown>,
    dangerous: boolean,
  ): Promise<PermissionDecision> {
    const preview = JSON.stringify(toolInput, null, 2).slice(0, 400);
    console.error(
      chalk.yellow(
        `\n⚠ Permission: ${toolName}${dangerous ? " [DANGEROUS]" : ""}\n${preview}\n`,
      ),
    );
    const rl = readline.createInterface({ input, output });
    try {
      const ans = (
        await rl.question("Allow? [y]es / [n]o / [s]ession-always for this tool: ")
      )
        .trim()
        .toLowerCase();
      if (ans === "s" || ans === "session") {
        this.sessionAllows.add(toolName);
        return "allow_session";
      }
      if (ans === "y" || ans === "yes" || ans === "") return "allow";
      return "deny";
    } finally {
      rl.close();
    }
  }
}
