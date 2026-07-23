import type { PermissionMode } from "../config/types.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)/,
  /\brm\s+--recursive/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bdrop\s+table\b/i,
  /\bdrop\s+database\b/i,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\bchmod\s+-R\s+777\b/,
  /\bcurl\b.*\|\s*(ba)?sh\b/,
  /\bwget\b.*\|\s*(ba)?sh\b/,
];

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
      return DANGEROUS_PATTERNS.some((re) => re.test(cmd));
    }
    return false;
  }

  async request(req: PermissionRequest): Promise<PermissionDecision> {
    const { toolName, input: toolInput, mode } = req;

    if (mode === "bypassPermissions") return "allow";
    if (mode === "plan") {
      // Plan mode: deny writes
      if (WRITE_TOOLS.has(toolName) || toolName === "bash" || toolName === "run_terminal_command") {
        return "deny";
      }
      return "allow";
    }

    if (mode === "acceptEdits" && WRITE_TOOLS.has(toolName)) {
      return "allow";
    }

    const key = `${toolName}:${JSON.stringify(toolInput).slice(0, 200)}`;
    if (this.sessionAllows.has(toolName) || this.sessionAllows.has(key)) {
      return "allow";
    }

    // Auto-allow safe reads
    if (
      ["read_file", "grep", "glob", "list_dir", "web_search", "Read", "Grep", "Glob"].includes(
        toolName,
      )
    ) {
      return "allow";
    }

    // Dangerous always asks (unless bypass)
    const dangerous = this.isDangerous(toolName, toolInput);
    if (!dangerous && mode === "acceptEdits") return "allow";

    if (!this.interactive || !process.stdin.isTTY) {
      // Headless: allow non-dangerous, deny dangerous
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
