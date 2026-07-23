import {
  armGoal,
  pauseGoal,
  resumeGoal,
  clearGoal,
  markGoalDone,
  loadGoal,
  formatGoalStatus,
} from "../harness/goal.js";
import type { SessionData } from "../session/session.js";
import { saveSession, listSessions, compactMessages } from "../session/session.js";
import type { HookRunner } from "../harness/hooks.js";
import type { ForgeConfig } from "../config/types.js";
import { describeAuth, resolveAuth } from "../auth/resolve.js";
import { printAuthStatus } from "../auth/login.js";
import { estimateTokens } from "../session/session.js";
import chalk from "chalk";

export interface SlashResult {
  /** If true, do not send to the model */
  handled: boolean;
  /** Message to print to the user */
  output?: string;
  /** If set, quit the REPL */
  quit?: boolean;
  /** Replace user message with this before model (e.g. stripped /ulw) */
  forwardPrompt?: string;
  /** Session was mutated */
  session?: SessionData;
}

/**
 * Handle slash commands. Returns handled=false for unknown commands
 * so the agent can treat them as normal text if desired.
 */
export function handleSlash(
  line: string,
  opts: {
    session: SessionData;
    config: ForgeConfig;
    hooks: HookRunner;
  },
): SlashResult {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return { handled: false };

  const space = trimmed.indexOf(" ");
  const cmd = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();

  switch (cmd) {
    case "/help":
    case "/?":
      return { handled: true, output: HELP_TEXT };

    case "/quit":
    case "/exit":
    case "/q":
      return { handled: true, quit: true, output: "Bye." };

    case "/goal":
      return handleGoal(arg, opts.session);

    case "/ulw":
    case "/ultrawork":
    case "/autowork": {
      opts.session.meta.ultrawork = true;
      saveSession(opts.session);
      if (!arg) {
        return {
          handled: true,
          output: "Ultrawork mode ON. Send a task, or: /ulw <task>",
          session: opts.session,
        };
      }
      return {
        handled: true,
        forwardPrompt: arg,
        output: chalk.magenta("⚡ Ultrawork mode ON"),
        session: opts.session,
      };
    }

    case "/ulw-off": {
      opts.session.meta.ultrawork = false;
      saveSession(opts.session);
      return {
        handled: true,
        output: "Ultrawork mode OFF",
        session: opts.session,
      };
    }

    case "/hooks": {
      const list = opts.hooks.list();
      const lines = Object.entries(list).map(([k, v]) => `  ${k}: ${v} matcher(s)`);
      return {
        handled: true,
        output:
          lines.length > 0
            ? `Loaded hooks:\n${lines.join("\n")}\nBlocking Stop: ${opts.config.blockingStopHooks ? "ON" : "OFF"}`
            : `No hooks loaded.\nPlace JSON files in ~/.forge/hooks/ or .forge/hooks/\nBlocking Stop: ${opts.config.blockingStopHooks ? "ON" : "OFF"}`,
      };
    }

    case "/status":
    case "/session-info": {
      const g = loadGoal(opts.session.meta.id);
      const auth = resolveAuth(opts.config);
      const lines = [
        `Session: ${opts.session.meta.id}`,
        `Provider/model: ${opts.session.meta.provider} / ${opts.session.meta.model}`,
        `Auth: ${describeAuth(auth)}`,
        `Ultrawork: ${opts.session.meta.ultrawork ? "ON" : "OFF"}`,
        `Turns: ${opts.session.meta.turnCount}  Edits: ${opts.session.meta.editCount}`,
        `Messages: ${opts.session.messages.length}  ~tokens: ${estimateTokens(opts.session.messages)}`,
        `Todos open: ${opts.session.todos.filter((t) => t.status === "pending" || t.status === "in_progress").length}`,
        `Blocking Stop hooks: ${opts.config.blockingStopHooks ? "ON" : "OFF"}`,
        g?.objective
          ? `Goal: [${g.status}] ${g.objective.slice(0, 80)}`
          : "Goal: (none)",
      ];
      return { handled: true, output: lines.join("\n") };
    }

    case "/todos": {
      if (opts.session.todos.length === 0) {
        return { handled: true, output: "No todos." };
      }
      return {
        handled: true,
        output: opts.session.todos
          .map((t) => `- [${t.status}] ${t.id}: ${t.content}`)
          .join("\n"),
      };
    }

    case "/auth":
    case "/login-status": {
      printAuthStatus();
      return { handled: true, output: "" };
    }

    case "/model": {
      if (!arg) {
        return {
          handled: true,
          output: `Current model: ${opts.config.model}\nUsage: /model <name>`,
        };
      }
      opts.config.model = arg;
      opts.session.meta.model = arg;
      saveSession(opts.session);
      return { handled: true, output: `Model set to ${arg}`, session: opts.session };
    }

    case "/compact": {
      // lazy import avoided — compactMessages already available via session module
      return handleCompact(opts.session);
    }

    case "/new":
    case "/clear": {
      return {
        handled: true,
        output:
          "Start a fresh session with: forge --new\n(Or exit and re-run forge.) Mid-REPL wipe is intentionally avoided so harness state stays consistent.",
      };
    }

    case "/resume": {
      if (!arg) {
        const list = listSessions(10);
        return {
          handled: true,
          output:
            list.length === 0
              ? "No sessions. Usage: /resume <session-id>"
              : `Usage: /resume <session-id>\n\nRecent:\n${list
                  .map((s) => `  ${s.id}  ${s.updatedAt}  ${s.model}`)
                  .join("\n")}\n\nOr: forge --session <id>`,
        };
      }
      return {
        handled: true,
        output: `Resume from shell: forge --session ${arg}`,
      };
    }

    case "/sessions": {
      const list = listSessions(15);
      if (!list.length) return { handled: true, output: "No sessions yet." };
      return {
        handled: true,
        output: list
          .map(
            (s) =>
              `${s.id.slice(0, 8)}  ${s.updatedAt}  ${s.model}  turns=${s.turnCount}${s.ultrawork ? " ULW" : ""}`,
          )
          .join("\n"),
      };
    }

    case "/permissions": {
      if (!arg) {
        return {
          handled: true,
          output: `Mode: ${opts.config.permissionMode}\nUsage: /permissions default|acceptEdits|plan|bypassPermissions`,
        };
      }
      const modes = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
      if (!(modes as readonly string[]).includes(arg)) {
        return { handled: true, output: `Unknown mode: ${arg}` };
      }
      opts.config.permissionMode = arg as ForgeConfig["permissionMode"];
      return { handled: true, output: `Permission mode: ${arg}` };
    }

    default:
      return {
        handled: true,
        output: `Unknown command: ${cmd}. Type /help for commands.`,
      };
  }
}

function handleCompact(session: SessionData): SlashResult {
  const before = session.messages.length;
  session.messages = compactMessages(session.messages);
  saveSession(session);
  return {
    handled: true,
    output: `Compacted ${before} → ${session.messages.length} messages`,
    session,
  };
}

function handleGoal(arg: string, session: SessionData): SlashResult {
  const sid = session.meta.id;
  if (!arg || arg === "status") {
    return { handled: true, output: formatGoalStatus(loadGoal(sid)) };
  }
  const [verb, ...rest] = arg.split(/\s+/);
  const restText = rest.join(" ").trim();

  switch (verb.toLowerCase()) {
    case "pause": {
      const g = pauseGoal(sid);
      return {
        handled: true,
        output: g ? "Goal paused." : "No active goal.",
      };
    }
    case "resume":
    case "unpause": {
      const g = resumeGoal(sid);
      // Enable ultrawork when resuming so stop-guard is meaningful
      if (g) {
        session.meta.ultrawork = true;
        saveSession(session);
      }
      return {
        handled: true,
        output: g
          ? `Goal resumed.\n${formatGoalStatus(g)}`
          : "No goal to resume.",
        session,
      };
    }
    case "clear": {
      clearGoal(sid);
      return { handled: true, output: "Goal cleared." };
    }
    case "done": {
      const g = markGoalDone(sid, restText || undefined);
      return {
        handled: true,
        output: g
          ? `Goal marked achieved.${restText ? ` (${restText})` : ""}`
          : "No active goal.",
      };
    }
    case "set": {
      if (!restText) return { handled: true, output: "Usage: /goal set <objective>" };
      const g = armGoal(sid, restText, "manual");
      session.meta.ultrawork = true;
      saveSession(session);
      return {
        handled: true,
        output: `Goal ARMED (relentless driver engaged).\n${formatGoalStatus(g)}`,
        session,
      };
    }
    default: {
      // Entire arg is the objective
      const g = armGoal(sid, arg, "manual");
      session.meta.ultrawork = true;
      saveSession(session);
      return {
        handled: true,
        output: `Goal ARMED (relentless driver engaged).\n${formatGoalStatus(g)}\n\nSend your next message to start driving — Stop will be blocked until the goal is achieved.`,
        session,
      };
    }
  }
}

const HELP_TEXT = `
Forge slash commands
────────────────────
  /help                 Show this help
  /goal <objective>     Arm relentless goal driver (Codex-style)
  /goal                 Show goal status
  /goal pause|resume|clear|done
  /ulw [task]           Enable ultrawork (max autonomy)
  /ulw-off              Disable ultrawork
  /hooks                List loaded hooks
  /status               Session + auth + goal status
  /todos                Show agent todos
  /model <name>         Switch model
  /permissions <mode>   default|acceptEdits|plan|bypassPermissions
  /compact              Compact conversation
  /sessions             List recent sessions
  /auth                 Show stored credentials
  /quit                 Exit

Harness highlights
──────────────────
  • Blocking Stop hooks (Claude Code parity — Grok Build lacks this)
  • /goal relentless driver with stuck-wall escape
  • API key + OAuth/subscription auth (where providers allow)
`.trim();
