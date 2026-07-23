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
import {
  saveSession,
  listSessions,
  compactMessages,
  rewindSession,
  exportSessionMarkdown,
  lastAssistantText,
  clearConversation,
  createSession,
  loadSession,
  estimateTokens,
} from "../session/session.js";
import type { HookRunner } from "../harness/hooks.js";
import type { ForgeConfig } from "../config/types.js";
import { describeAuth, resolveAuth } from "../auth/resolve.js";
import { printAuthStatus } from "../auth/login.js";
import {
  estimateCostUsd,
  formatCost,
  formatTokens,
} from "../util/format.js";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface SlashResult {
  handled: boolean;
  output?: string;
  quit?: boolean;
  forwardPrompt?: string;
  session?: SessionData;
  /** REPL should replace its session pointer */
  replaceSession?: SessionData;
}

export const SLASH_COMMANDS = [
  "/help",
  "/goal",
  "/ulw",
  "/ulw-off",
  "/hooks",
  "/status",
  "/context",
  "/cost",
  "/todos",
  "/model",
  "/permissions",
  "/compact",
  "/rewind",
  "/undo",
  "/export",
  "/copy",
  "/new",
  "/clear",
  "/resume",
  "/sessions",
  "/auth",
  "/doctor",
  "/statusline",
  "/hud",
  "/quit",
] as const;

export function completeSlash(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith("/")) return [];
  if (t.includes(" ")) return [];
  return SLASH_COMMANDS.filter((c) => c.startsWith(t.toLowerCase()));
}

export async function handleSlash(
  line: string,
  opts: {
    session: SessionData;
    config: ForgeConfig;
    hooks: HookRunner;
  },
): Promise<SlashResult> {
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
      const est = estimateTokens(opts.session.messages);
      const cost = estimateCostUsd(
        String(opts.config.provider),
        opts.session.meta.totalPromptTokens,
        opts.session.meta.totalCompletionTokens,
      );
      const lines = [
        `Session: ${opts.session.meta.id}`,
        `Title: ${opts.session.meta.title || "(untitled)"}`,
        `Provider/model: ${opts.session.meta.provider} / ${opts.session.meta.model}`,
        `Auth: ${describeAuth(auth)}`,
        `Ultrawork: ${opts.session.meta.ultrawork ? "ON" : "OFF"}`,
        `Turns: ${opts.session.meta.turnCount}  Edits: ${opts.session.meta.editCount}`,
        `Messages: ${opts.session.messages.length}  ~ctx tokens: ${formatTokens(est)} / ${formatTokens(opts.config.contextWindow)}`,
        `Usage: in=${formatTokens(opts.session.meta.totalPromptTokens)} out=${formatTokens(opts.session.meta.totalCompletionTokens)}  est ${formatCost(cost)}`,
        `Todos open: ${opts.session.todos.filter((t) => t.status === "pending" || t.status === "in_progress").length}`,
        `Blocking Stop hooks: ${opts.config.blockingStopHooks ? "ON" : "OFF"}`,
        g?.objective
          ? `Goal: [${g.status}] ${g.objective.slice(0, 80)}`
          : "Goal: (none)",
      ];
      return { handled: true, output: lines.join("\n") };
    }

    case "/context": {
      const est = estimateTokens(opts.session.messages);
      const pct = Math.min(100, Math.round((est / opts.config.contextWindow) * 100));
      const barLen = 24;
      const filled = Math.round((pct / 100) * barLen);
      const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
      const byRole: Record<string, number> = {};
      for (const m of opts.session.messages) {
        const n = estimateTokens([m]);
        byRole[m.role] = (byRole[m.role] || 0) + n;
      }
      const roleLines = Object.entries(byRole)
        .map(([r, n]) => `  ${r.padEnd(10)} ${formatTokens(n)}`)
        .join("\n");
      return {
        handled: true,
        output: `Context  [${bar}] ${pct}%\n  ~${formatTokens(est)} / ${formatTokens(opts.config.contextWindow)}\nBy role:\n${roleLines}`,
      };
    }

    case "/cost": {
      const cost = estimateCostUsd(
        String(opts.config.provider),
        opts.session.meta.totalPromptTokens,
        opts.session.meta.totalCompletionTokens,
      );
      return {
        handled: true,
        output: [
          `Session usage (this session)`,
          `  prompt:      ${formatTokens(opts.session.meta.totalPromptTokens)}`,
          `  completion:  ${formatTokens(opts.session.meta.totalCompletionTokens)}`,
          `  est. cost:   ${formatCost(cost)}  (rough; not a bill)`,
        ].join("\n"),
      };
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
        const pcfg = opts.config.providers[opts.config.provider];
        const models = pcfg?.models?.length
          ? pcfg.models.join(", ")
          : pcfg?.defaultModel || "(any)";
        return {
          handled: true,
          output: `Current model: ${opts.config.model}\nKnown: ${models}\nUsage: /model <name>`,
        };
      }
      opts.config.model = arg;
      opts.session.meta.model = arg;
      saveSession(opts.session);
      return { handled: true, output: `Model set to ${arg}`, session: opts.session };
    }

    case "/compact": {
      const before = opts.session.messages.length;
      opts.session.messages = compactMessages(opts.session.messages);
      saveSession(opts.session);
      return {
        handled: true,
        output: `Compacted ${before} → ${opts.session.messages.length} messages`,
        session: opts.session,
      };
    }

    case "/rewind":
    case "/undo": {
      const n = arg ? Math.max(1, parseInt(arg, 10) || 1) : 1;
      const removed = rewindSession(opts.session, n);
      return {
        handled: true,
        output:
          removed > 0
            ? `Rewound ${n} user turn(s); removed ${removed} message(s).`
            : "Nothing to rewind.",
        session: opts.session,
      };
    }

    case "/export": {
      const md = exportSessionMarkdown(opts.session);
      if (arg) {
        const p = path.resolve(arg);
        fs.writeFileSync(p, md, "utf8");
        return { handled: true, output: `Exported to ${p}` };
      }
      return { handled: true, output: md };
    }

    case "/copy": {
      const text = lastAssistantText(opts.session);
      if (!text) return { handled: true, output: "No assistant message to copy." };
      try {
        if (process.platform === "darwin") {
          execSync("pbcopy", { input: text });
        } else if (process.platform === "linux") {
          execSync("xclip -selection clipboard", { input: text });
        } else {
          return {
            handled: true,
            output: text.slice(0, 2000) + (text.length > 2000 ? "\n…" : ""),
          };
        }
        return { handled: true, output: `Copied last assistant reply (${text.length} chars).` };
      } catch {
        return {
          handled: true,
          output: "Clipboard unavailable. Last reply:\n\n" + text.slice(0, 2000),
        };
      }
    }

    case "/new":
    case "/clear": {
      if (cmd === "/clear" && arg !== "hard") {
        clearConversation(opts.session);
        return {
          handled: true,
          output: "Conversation cleared (same session id). Use /new for a fresh session.",
          session: opts.session,
        };
      }
      const s = createSession({
        cwd: opts.session.meta.cwd,
        provider: opts.config.provider,
        model: opts.config.model,
        ultrawork: opts.session.meta.ultrawork,
      });
      return {
        handled: true,
        output: `New session ${s.meta.id.slice(0, 8)}`,
        replaceSession: s,
      };
    }

    case "/resume": {
      if (!arg) {
        const list = listSessions(10);
        return {
          handled: true,
          output:
            list.length === 0
              ? "No sessions. Usage: /resume <session-id-prefix>"
              : `Usage: /resume <session-id-prefix>\n\nRecent:\n${list
                  .map(
                    (s) =>
                      `  ${s.id.slice(0, 8)}  ${(s.title || "").slice(0, 40).padEnd(40)}  ${s.model}`,
                  )
                  .join("\n")}`,
        };
      }
      const loaded = loadSession(arg);
      if (!loaded) {
        return { handled: true, output: `Session not found: ${arg}` };
      }
      opts.config.model = loaded.meta.model;
      return {
        handled: true,
        output: `Resumed ${loaded.meta.id.slice(0, 8)} — ${loaded.meta.title || "untitled"} (${loaded.messages.length} msgs)`,
        replaceSession: loaded,
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
              `${s.id.slice(0, 8)}  ${s.updatedAt.slice(0, 19)}  ${(s.title || "").slice(0, 36).padEnd(36)}  ${s.model}  t=${s.turnCount}${s.ultrawork ? " ULW" : ""}`,
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

    case "/doctor": {
      return { handled: true, output: runDoctor(opts.config) };
    }

    case "/statusline":
    case "/hud": {
      const { collectSnapshots, renderHud } = await import("../statusline/index.js");
      const snaps = await collectSnapshots({
        sessionId: opts.session.meta.id,
        fetchPlan: true,
        config: opts.config,
      });
      const hud = renderHud(snaps, { width: process.stdout.columns });
      return {
        handled: true,
        output:
          hud +
          chalk.dim(
            "\n\nLive pane: forge status --watch   ·   tmux: #(forge status --tmux --plain)",
          ),
      };
    }

    default:
      return {
        handled: true,
        output: `Unknown command: ${cmd}. Type /help for commands.`,
      };
  }
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
      return { handled: true, output: g ? "Goal paused." : "No active goal." };
    }
    case "resume":
    case "unpause": {
      const g = resumeGoal(sid);
      if (g) {
        session.meta.ultrawork = true;
        saveSession(session);
      }
      return {
        handled: true,
        output: g ? `Goal resumed.\n${formatGoalStatus(g)}` : "No goal to resume.",
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

export function runDoctor(config: ForgeConfig): string {
  const lines: string[] = [chalk.bold("Forge doctor"), ""];
  const auth = resolveAuth(config);
  lines.push(`Auth: ${describeAuth(auth)}`);
  lines.push(`Provider/model: ${config.provider} / ${config.model}`);
  lines.push(`Blocking Stop: ${config.blockingStopHooks ? "on" : "off"}`);
  lines.push(`Goal gate: ${config.goal.enabled ? "on" : "off"} (stuck=${config.goal.stuckThreshold})`);
  lines.push(`Workspace: ${config.workspace || process.cwd()}`);

  const node = process.version;
  lines.push(`Node: ${node}`);
  const major = parseInt(node.slice(1), 10);
  if (major < 20) lines.push(chalk.red("  ⚠ Node 20+ required"));

  // Quick network check to base URL host (HEAD not always allowed)
  const pcfg = config.providers[config.provider];
  const base = config.baseUrl || pcfg?.baseUrl;
  if (base && auth) {
    lines.push(`API base: ${base}`);
  } else if (!auth) {
    lines.push(chalk.yellow("  ⚠ Not authenticated — forge login or set an API key env var"));
  }

  const home = process.env.FORGE_HOME || path.join(process.env.HOME || "", ".forge");
  lines.push(`FORGE_HOME: ${home}`);
  lines.push(`  config: ${fs.existsSync(path.join(home, "config.toml")) ? "yes" : "no"}`);
  lines.push(`  auth:   ${fs.existsSync(path.join(home, "auth.json")) ? "yes" : "no"}`);

  return lines.join("\n");
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
  /context              Context window usage bar
  /cost                 Token usage + rough cost
  /todos                Show agent todos
  /model <name>         Switch model
  /permissions <mode>   default|acceptEdits|plan|bypassPermissions
  /compact              Compact conversation
  /rewind [n]           Undo last n user turns (/undo)
  /export [path]        Export session as markdown
  /copy                 Copy last assistant reply
  /new                  Fresh session
  /clear                Clear messages (same session)
  /resume [id]          Resume a prior session
  /sessions             List recent sessions
  /auth                 Show stored credentials
  /doctor               Environment health check
  /statusline · /hud    Native statusline snapshot
  /quit                 Exit

Tips
────
  Tab completes slash commands · Ctrl+C aborts the current run
  Live HUD pane: forge status --watch
  Blocking Stop hooks + /goal are the harness differentiators
`.trim();
