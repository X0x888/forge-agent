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
import { resolveSandboxNetwork } from "../config/types.js";
import { loadPreferences, savePreferences } from "../config/preferences.js";
import { describeSandbox, detectSandboxBackend } from "../agent/sandbox.js";
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
import {
  armUlwCycle,
  disarmUlwCycle,
  setCycleFlag,
  parseCycleArg,
  formatUlwStatus,
  loadUlwCycle,
  ulwKickoffMessage,
} from "../harness/ulw-cycle.js";
import {
  COMMAND_PARAMS,
  formatParamMenu,
  resolveParamChoice,
} from "../tui/complete.js";

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
  "/cycle",
  "/hooks",
  "/status",
  "/statusline",
  "/hud",
  "/tasks",
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
  "/quit",
] as const;

export function completeSlash(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith("/")) return [];
  if (t.includes(" ")) return [];
  return SLASH_COMMANDS.filter((c) => c.startsWith(t.toLowerCase()));
}

/** @deprecated use forgeCompleter — kept for tests */
export { forgeCompleter } from "../tui/complete.js";

export async function handleSlash(
  line: string,
  opts: {
    session: SessionData;
    config: ForgeConfig;
    hooks: HookRunner;
    auth?: import("../auth/types.js").ResolvedAuth;
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
      const mandate = arg || "improve the codebase";
      const state = armUlwCycle(opts.session.meta.id, mandate, { cycle: 1 });
      saveSession(opts.session);
      const banner = [
        chalk.magenta("⚡ ULW ON") +
          chalk.dim(`  cycle=${state.cycle} (CONTINUE)  soft=${state.softPrompt ? "yes" : "no"}`),
        chalk.dim(
          "Soft prompts still drive the harness: research → waves → serendipity → review → repeat.",
        ),
        chalk.dim("User stop: /cycle 0  (finish last wave) · /ulw-off  (disarm)"),
        formatUlwStatus(state),
      ].join("\n");
      // Always forward an expanded kickoff so even bare `/ulw` or soft text runs the cycle
      return {
        handled: true,
        forwardPrompt: ulwKickoffMessage(state),
        output: banner,
        session: opts.session,
      };
    }

    case "/ulw-off": {
      opts.session.meta.ultrawork = false;
      disarmUlwCycle(opts.session.meta.id);
      saveSession(opts.session);
      return {
        handled: true,
        output: "Ultrawork + cycle driver OFF",
        session: opts.session,
      };
    }

    case "/cycle": {
      if (!arg) {
        return {
          handled: true,
          output:
            formatParamMenu("/cycle", COMMAND_PARAMS.cycle) +
            "\n\n" +
            formatUlwStatus(loadUlwCycle(opts.session.meta.id)),
        };
      }
      if (arg === "status") {
        return {
          handled: true,
          output: formatUlwStatus(loadUlwCycle(opts.session.meta.id)),
        };
      }
      // number menu: 1/2/3 map via resolveParamChoice, or parseCycleArg
      const fromMenu = resolveParamChoice(arg, COMMAND_PARAMS.cycle);
      const flag =
        fromMenu === "status"
          ? null
          : fromMenu === "1" || fromMenu === "0"
            ? (Number(fromMenu) as 0 | 1)
            : parseCycleArg(arg);
      if (fromMenu === "status") {
        return {
          handled: true,
          output: formatUlwStatus(loadUlwCycle(opts.session.meta.id)),
        };
      }
      if (flag === null) {
        return {
          handled: true,
          output:
            chalk.yellow(`Unknown: ${arg}\n`) +
            formatParamMenu("/cycle", COMMAND_PARAMS.cycle),
        };
      }
      let state = setCycleFlag(opts.session.meta.id, flag);
      if (!state) {
        // Auto-arm ULW if user sets cycle without /ulw
        opts.session.meta.ultrawork = true;
        state = armUlwCycle(opts.session.meta.id, "continue prior mandate", {
          cycle: flag,
        });
        saveSession(opts.session);
      }
      const msg =
        flag === 1
          ? chalk.magenta("cycle=1 CONTINUE") +
            " — harness will keep blocking Stop and forcing the next wave."
          : chalk.yellow("cycle=0 LAST") +
            " — finish the current wave, review, attest **Cycle complete.** then Stop is allowed.";
      return {
        handled: true,
        output: `${msg}\n${formatUlwStatus(state)}`,
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
    case "/session-info":
    case "/statusline":
    case "/hud": {
      const auth = opts.auth || resolveAuth(opts.config);
      if (!auth) {
        return { handled: true, output: "Not authenticated." };
      }
      const { formatSessionDetails } = await import("../tui/status-bar.js");
      const { collectPlanUsage } = await import("../statusline/plan.js");
      const { sessionToSnapshot } = await import("../statusline/snapshot.js");
      const { renderHud } = await import("../statusline/render.js");

      // Full HUD with optional plan probe (same data as forge status)
      const snap = sessionToSnapshot(opts.session, {
        windowTokens: opts.config.contextWindow,
        authMethod: auth.method as import("../statusline/types.js").AuthMethod,
        authLabel: auth.accountLabel,
        permissionMode: opts.config.permissionMode,
      });
      try {
        snap.plan = await collectPlanUsage({
          provider: opts.session.meta.provider,
          authMethod: snap.authMethod,
        });
      } catch {
        /* plan optional */
      }
      const hud = renderHud([snap], { width: process.stdout.columns });
      const detail = formatSessionDetails({
        config: opts.config,
        session: opts.session,
        auth,
      });
      return {
        handled: true,
        output:
          hud +
          "\n" +
          detail +
          chalk.dim(
            "\n\nTip: status is always on the prompt line. Live external pane still available: forge status --watch",
          ),
      };
    }

    case "/tasks":
    case "/bg": {
      const { formatBackgroundTasksList } = await import("../tui/status-bar.js");
      const { listTasks } = await import("../agent/tools/background-tasks.js");
      const tasks = listTasks();
      const running = tasks.filter((t) => t.status === "running").length;
      const header =
        chalk.bold("Background tasks") +
        chalk.dim(
          `  (${running} running / ${tasks.length} tracked in this process)`,
        );
      return {
        handled: true,
        output: `${header}\n${formatBackgroundTasksList()}\n` +
          chalk.dim(
            "Agent starts these via bash { background: true }. Poll: get_task_output · kill: kill_task",
          ),
      };
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
      const pcfg = opts.config.providers[opts.config.provider];
      const models = pcfg?.models?.length
        ? pcfg.models
        : pcfg?.defaultModel
          ? [pcfg.defaultModel]
          : [];
      const choices = models.map((m) => ({
        value: m,
        description: m === opts.config.model ? "current" : "available",
      }));
      if (!arg) {
        return {
          handled: true,
          output:
            (choices.length
              ? formatParamMenu("/model", choices, opts.config.model)
              : `Current model: ${opts.config.model}\nUsage: /model <name>`) +
            chalk.dim("\nTip: Tab completes model names."),
        };
      }
      const resolved =
        resolveParamChoice(arg, choices) ||
        // allow free-form model ids not in the list
        arg;
      opts.config.model = resolved;
      opts.session.meta.model = resolved;
      saveSession(opts.session);
      try {
        savePreferences({ model: resolved });
      } catch {
        /* never fail slash on prefs I/O */
      }
      return {
        handled: true,
        output: `Model set to ${resolved} (saved for future sessions)`,
        session: opts.session,
      };
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
      const choices = COMMAND_PARAMS.permissions;
      const sub = arg.trim();
      if (sub === "list" || sub.startsWith("list ")) {
        const { loadSavedAllows } = await import("../agent/permission-saved.js");
        const ws = opts.config.workspace || process.cwd();
        const allows = loadSavedAllows(ws);
        if (!allows.length) {
          return { handled: true, output: "No saved allow rules for this workspace." };
        }
        return {
          handled: true,
          output: allows
            .map((a) => `${a.id}  ${a.tool}(${a.pattern})  ws=${a.workspaceKey}`)
            .join("\n"),
        };
      }
      if (sub === "clear") {
        const { clearSavedAllows } = await import("../agent/permission-saved.js");
        const n = clearSavedAllows(opts.config.workspace || process.cwd());
        return { handled: true, output: `Cleared ${n} saved allow rule(s) for this workspace.` };
      }
      if (sub.startsWith("revoke ")) {
        const id = sub.slice("revoke ".length).trim();
        const { removeSavedAllow } = await import("../agent/permission-saved.js");
        const ok = removeSavedAllow(id);
        return {
          handled: true,
          output: ok ? `Revoked ${id}` : `No saved rule with id ${id}`,
        };
      }
      if (!arg) {
        return {
          handled: true,
          output:
            formatParamMenu(
              "/permissions",
              choices,
              opts.config.permissionMode,
            ) +
            chalk.dim(
              "\nAlso: /permissions list | clear | revoke <id>",
            ),
        };
      }
      const resolved = resolveParamChoice(arg, choices);
      if (!resolved) {
        return {
          handled: true,
          output:
            chalk.yellow(`Unknown mode: ${arg}\n`) +
            formatParamMenu("/permissions", choices, opts.config.permissionMode),
        };
      }
      opts.config.permissionMode = resolved as ForgeConfig["permissionMode"];
      try {
        savePreferences({
          permissionMode: resolved as ForgeConfig["permissionMode"],
        });
      } catch {
        /* never fail slash on prefs I/O */
      }
      return {
        handled: true,
        output: `Permission mode: ${resolved}${resolved === "bypassPermissions" ? " (always approve)" : ""} (saved for future sessions)`,
      };
    }

    case "/doctor": {
      return { handled: true, output: runDoctor(opts.config) };
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
  lines.push(`Permission mode: ${config.permissionMode}`);
  {
    const prefs = loadPreferences();
    const bits = [
      prefs.model ? `model=${prefs.model}` : null,
      prefs.permissionMode ? `permission_mode=${prefs.permissionMode}` : null,
    ].filter(Boolean);
    lines.push(
      `Preferences: ${bits.length ? bits.join(" ") : "(none)"}  (~/.forge/preferences.json)`,
    );
  }
  {
    const net = resolveSandboxNetwork(config);
    const backend = detectSandboxBackend();
    lines.push(`Sandbox: ${describeSandbox(config.sandbox || "off", net)}`);
    lines.push(
      `Sandbox backend: ${backend.available ? backend.backend : "NONE"}` +
        (config.sandbox !== "off" && !backend.available
          ? config.sandboxMissingBackend === "fail-closed"
            ? chalk.red(" — FAIL-CLOSED (bash denied)")
            : chalk.yellow(" — fallback unsandboxed")
          : ""),
    );
    lines.push(`Missing backend policy: ${config.sandboxMissingBackend || "fail-closed"}`);
    lines.push(`Read outside workspace: ${config.readOutsideWorkspace || "ask"}`);
  }
  const denyN = config.permission?.deny?.length || 0;
  const allowN = config.permission?.allow?.length || 0;
  const askN = config.permission?.ask?.length || 0;
  lines.push(`Rules: deny=${denyN} allow=${allowN} ask=${askN} (deny wins under YOLO)`);
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
  /ulw [task]           Arm ULW + cycle=1 (soft prompts OK: "improve the code")
  /cycle 1|0|status     Continue waves (1) or last wave then stop (0)
  /ulw-off              Disarm ULW + cycle driver
  /hooks                List loaded hooks
  /status · /hud        Full inline HUD + session details (no second panel)
  /tasks                Background shell tasks (running / recent)
  /context              Context window usage bar
  /cost                 Token usage + rough cost
  /todos                Show agent todos
  /model <name>         Switch model (persists across sessions/folders)
  /permissions [mode]   Menu if empty; Tab / numbers / aliases (yolo, always…)
                        Mode persists across sessions/folders
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
  /quit                 Exit

Status (always on — no second panel)
────────────────────────────────────
  Prompt line     Context %, tokens, todos, bg:N, ULW/GOAL flags, liveness
  While working   Spinner + phase (thinking / tool / compact / harness)
  After each turn Compact footer (ctx · turn tokens · bg · goal)
  /status         Full two-line HUD + session detail
  forge status --watch   Optional external pane / tmux (still available)

Tips
────
  ↑ / ↓           Command history (persisted in ~/.forge/history)
  Tab             Autocomplete commands and parameters
  /permissions    Shows numbered modes — pick 1–4 or type name
  Ctrl+C          Abort run; twice at prompt to exit
`.trim();
