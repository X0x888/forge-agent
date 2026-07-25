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
  deleteSessionDetailed,
  pruneSessions,
  sessionHasForeignLiveLock,
  compactMessages,
  rewindSession,
  exportSessionMarkdown,
  exportSessionJson,
  forkSession,
  setSessionTitle,
  lastAssistantText,
  clearConversation,
  createSession,
  loadSession,
  estimateTokens,
} from "../session/session.js";
// readSessionLock already imported below for /sessions list
import type { HookRunner } from "../harness/hooks.js";
import type { ForgeConfig } from "../config/types.js";
import { resolveSandboxNetwork } from "../config/types.js";
import {
  REASONING_EFFORT_DESCRIPTIONS,
  defaultEffortForModel,
  effortLevelsForModel,
  modelSupportsReasoningEffort,
  parseReasoningEffort,
  resolveReasoningEffort,
  type ReasoningEffort,
} from "../config/reasoning.js";
import { loadPreferences, savePreferences } from "../config/preferences.js";
import { describeSandbox, detectSandboxBackend } from "../agent/sandbox.js";
import { describeAuth, resolveAuth } from "../auth/resolve.js";
import { printAuthStatus } from "../auth/login.js";
import { getCredential, isExpired } from "../auth/store.js";
import { providerTimeoutMs } from "../util/abort.js";
import { copyToClipboard } from "../util/clipboard.js";
import { envPositiveInt } from "../util/env.js";
import { isBellEnabled } from "../util/attention.js";
import { inspectSecureFile } from "../util/fs.js";
import { getForgeVersion } from "../util/version.js";
import { toolOutputStats } from "../agent/tools/truncate.js";
import { listTasks } from "../agent/tools/background-tasks.js";
import { loadSavedAllows } from "../agent/permission-saved.js";
import { sandboxLogStats } from "../agent/sandbox-log.js";
import { metricsStats } from "../session/metrics.js";
import { readSessionLock, formatLockHolder } from "../session/lock.js";
import { permissionAskTimeoutMs } from "../agent/permissions.js";
import {
  estimateCostUsd,
  formatCost,
  formatTokens,
} from "../util/format.js";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tokenizeSimple } from "../agent/shell-parse.js";
import {
  armUlwCycle,
  disarmUlwCycle,
  setCycleFlag,
  parseCycleArg,
  formatUlwStatus,
  loadUlwCycle,
  ulwKickoffMessage,
  formatUlwCounts,
  ULW_LIVE_CONTROLS_HINT,
} from "../harness/ulw-cycle.js";
import { pushLiveNotice } from "../harness/live-notices.js";
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

/**
 * Mid-run slash policy.
 *
 * While the agent is busy, users must still steer the harness without aborting.
 * Only commands that (a) do not start a new agent turn and (b) do not mutate
 * the in-flight message list are live-safe. Control commands write harness
 * state that stop-guard reloads from disk; optional live-notices reach the
 * model on the next LLM call.
 */
export type LiveSlashKind = "control" | "readonly" | "quit" | "idle-only";

/** Read-only / status commands safe mid-turn. */
const LIVE_READONLY = new Set([
  "/help",
  "/?",
  "/hooks",
  "/status",
  "/statusline",
  "/hud",
  "/tasks",
  "/context",
  "/cost",
  "/metrics",
  "/todos",
  "/auth",
  "/doctor",
  "/diff",
  "/copy", // clipboard last assistant reply — no session mutation
  "/sessions", // list only — delete/prune classified below
]);

/** Harness control commands safe mid-turn (no forwardPrompt). */
const LIVE_CONTROL = new Set([
  "/cycle",
  "/ulw-off",
  "/effort",
  "/title",
  "/rename",
  "/bell",
]);

const LIVE_GOAL_VERBS = new Set([
  "",
  "status",
  "pause",
  "resume",
  "unpause",
  "clear",
  "done",
]);

export function parseSlashLine(line: string): { cmd: string; arg: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const space = trimmed.indexOf(" ");
  const cmd = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();
  return { cmd, arg };
}

/**
 * Classify whether a slash line may run while an agent turn is in progress.
 */
export function classifyLiveSlash(line: string): LiveSlashKind {
  const parsed = parseSlashLine(line);
  if (!parsed) return "idle-only";
  const { cmd, arg } = parsed;
  if (cmd === "/quit" || cmd === "/exit" || cmd === "/q") return "quit";
  if (cmd === "/sessions") {
    // list/search variants are readonly; delete/prune mutate disk — idle-only
    const verb = (arg.split(/\s+/)[0] || "").toLowerCase();
    if (
      !verb ||
      verb === "list" ||
      verb === "ls" ||
      verb === "all" ||
      verb === "global" ||
      verb === "-a" ||
      verb === "q" ||
      verb === "search" ||
      verb === "find"
    ) {
      return "readonly";
    }
    // bare title/id query is also readonly (no disk mutation)
    if (verb !== "delete" && verb !== "rm" && verb !== "remove" && verb !== "prune") {
      return "readonly";
    }
    return "idle-only";
  }
  if (cmd === "/permissions") {
    // bare menu / list are safe mid-run; mode changes + clear/revoke mutate prefs/disk
    const verb = (arg.split(/\s+/)[0] || "").toLowerCase();
    if (!verb || verb === "list" || verb === "status") return "readonly";
    return "idle-only";
  }
  if (LIVE_READONLY.has(cmd)) return "readonly";
  if (LIVE_CONTROL.has(cmd)) {
    // /cycle status (or bare menu) is read-only; flag flips are control
    if (cmd === "/cycle") {
      const a = arg.toLowerCase();
      if (!a || a === "status" || a === "3" /* menu status */) return "readonly";
    }
    // bare /effort shows the menu; setting a level is control
    if (cmd === "/effort" && !arg) return "readonly";
    // bare /title|/rename shows current title
    if ((cmd === "/title" || cmd === "/rename") && !arg) return "readonly";
    // bare /bell shows status
    if (cmd === "/bell" && !arg) return "readonly";
    return "control";
  }
  if (cmd === "/goal") {
    const verb = (arg.split(/\s+/)[0] || "").toLowerCase();
    // bare /goal or known control verbs — not arm/set (those start new drive intent)
    if (LIVE_GOAL_VERBS.has(verb)) return verb === "" || verb === "status" ? "readonly" : "control";
    // "/goal set …" or "/goal <objective>" arms a goal — idle only
    return "idle-only";
  }
  return "idle-only";
}

export function isLiveSafeSlash(line: string): boolean {
  const k = classifyLiveSlash(line);
  return k === "control" || k === "readonly" || k === "quit";
}

/**
 * Allowlist for `/diff` filter tokens after shell-safe argv split.
 * Blocks write sinks (`--output`), external diff/exec, and unknown flags.
 * Exported for unit tests.
 */
export function isSafeDiffFilterArg(token: string): boolean {
  if (!token || token.includes("\0")) return false;
  // Pathspecs / refs / revisions (no leading dash, or single "-" for stdin pathspec rare)
  if (token === "-") return false;
  if (!token.startsWith("-")) return true;
  // Double-dash ends options; allow as separator before pathspecs
  if (token === "--") return true;
  // Read-only diff presentation flags experts commonly pass
  const allowedExact = new Set([
    "--cached",
    "--staged",
    "--name-only",
    "--name-status",
    "--stat",
    "--numstat",
    "--shortstat",
    "--compact-summary",
    "--no-color",
    "--color=never",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--full-index",
    "--find-renames",
    "--find-copies",
    "--break-rewrites",
    "--ignore-space-change",
    "--ignore-all-space",
    "--ignore-blank-lines",
    "--function-context",
    "-w",
    "-b",
    "-R",
    "-M",
    "-C",
    "-B",
  ]);
  if (allowedExact.has(token)) return true;
  // -U3 / --unified=3
  if (/^-U\d+$/.test(token)) return true;
  if (/^--unified=\d+$/.test(token)) return true;
  if (/^--stat=\d+$/.test(token)) return true;
  // Explicitly reject known write / exec / config mutators even if unknown-flag policy changes
  const denied =
    /^(--output(=|$)|-o$|--output-indicator|--ext-diff|--textconv|--exec-path(=|$)|--git-dir(=|$)|--work-tree(=|$)|--namespace(=|$)|-c$|--config(=|$)|--upload-pack(=|$)|--receive-pack(=|$))/;
  if (denied.test(token)) return false;
  // Any other dashed token is denied (fail closed)
  return false;
}

export const LIVE_CONTROLS_HINT =
  `${ULW_LIVE_CONTROLS_HINT} · free-text queues mid-run · /goal pause · /status  ·  Ctrl+C aborts the turn`;

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
  "/metrics",
  "/todos",
  "/model",
  "/effort",
  "/permissions",
  "/compact",
  "/rewind",
  "/undo",
  "/export",
  "/fork",
  "/title",
  "/rename",
  "/bell",
  "/diff",
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
          chalk.dim(
            `  ${formatUlwCounts(state)} (CONTINUE)  soft=${state.softPrompt ? "yes" : "no"}`,
          ),
        chalk.dim(
          "Soft prompts still drive the harness: research → waves → serendipity → review → repeat.",
        ),
        chalk.cyan(ULW_LIVE_CONTROLS_HINT),
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
      const sid = opts.session.meta.id;
      opts.session.meta.ultrawork = false;
      disarmUlwCycle(sid);
      saveSession(opts.session);
      pushLiveNotice(
        sid,
        "User disarmed ULW mid-run (/ulw-off). The cycle driver will no longer block Stop. Wrap up cleanly; do not start a new ULW wave.",
      );
      return {
        handled: true,
        output:
          "Ultrawork + cycle driver OFF" +
          chalk.dim("\n  (applies immediately to harness; agent notified on next model call)"),
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
      const sid = opts.session.meta.id;
      let state = setCycleFlag(sid, flag);
      if (!state) {
        // Auto-arm ULW if user sets cycle without /ulw
        opts.session.meta.ultrawork = true;
        state = armUlwCycle(sid, "continue prior mandate", {
          cycle: flag,
        });
        saveSession(opts.session);
      }
      if (flag === 1) {
        pushLiveNotice(
          sid,
          "User set cycle=1 (CONTINUE) mid-run. Keep the research → implement → serendipity → review loop. Do not stop until the user sets cycle=0 or /ulw-off.",
        );
      } else {
        pushLiveNotice(
          sid,
          "User set cycle=0 (LAST) mid-run. Finish the *current* wave only: complete open work, review the diff, attest **Cycle complete.** Do NOT start a new ambitious wave.",
        );
      }
      const msg =
        flag === 1
          ? chalk.magenta("cycle=1 CONTINUE") +
            " — harness will keep blocking Stop and forcing the next wave."
          : chalk.yellow("cycle=0 LAST") +
            " — finish the current wave, review, attest **Cycle complete.** then Stop is allowed.";
      return {
        handled: true,
        output:
          `${msg}\n${formatUlwStatus(state)}` +
          chalk.dim(
            "\n  (flag written now — stop-guard honors it on next Stop; agent notified on next model call)",
          ),
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
            "Agent starts these via bash { background: true }. Poll: get_task_output · kill: kill_task · exit force-kills leftovers",
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

    case "/metrics": {
      const st = metricsStats();
      const cost = estimateCostUsd(
        String(opts.config.provider),
        opts.session.meta.totalPromptTokens,
        opts.session.meta.totalCompletionTokens,
      );
      return {
        handled: true,
        output: [
          `Local metrics (counter-only, no prompts/secrets)`,
          `  file:     ${st.path}`,
          `  events:   ${st.events} · ${(st.bytes / 1024).toFixed(1)} KB`,
          `This session:`,
          `  tokens:   in=${formatTokens(opts.session.meta.totalPromptTokens)} out=${formatTokens(opts.session.meta.totalCompletionTokens)} · est ${formatCost(cost)}`,
          `  turns:    ${opts.session.meta.turnCount}  edits=${opts.session.meta.editCount}`,
          `  id:       ${opts.session.meta.id}`,
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
      const choices = models.map((m) => {
        const effortHint = modelSupportsReasoningEffort(m)
          ? ` · effort ${defaultEffortForModel(m) ?? "—"}`
          : "";
        return {
          value: m,
          description:
            (m === opts.config.model ? "current" : "available") + effortHint,
        };
      });
      if (!arg) {
        const curEffort = resolveReasoningEffort(
          opts.config.model,
          opts.config.reasoningEffort,
        );
        const effortLine = modelSupportsReasoningEffort(opts.config.model)
          ? chalk.dim(
              `\nCurrent effort: ${curEffort ?? "—"}  (change with /effort or /model <name> <low|medium|high>)`,
            )
          : chalk.dim("\nCurrent model does not support reasoning effort.");
        return {
          handled: true,
          output:
            (choices.length
              ? formatParamMenu("/model", choices, opts.config.model)
              : `Current model: ${opts.config.model}\nUsage: /model <name> [effort]`) +
            effortLine +
            chalk.dim("\nTip: Tab completes model names."),
        };
      }
      // /model <name> [effort] — last token may be an effort level
      const tokens = arg.split(/\s+/).filter(Boolean);
      let modelArg = arg;
      let effortArg: string | undefined;
      if (tokens.length >= 2) {
        const maybeEffort = parseReasoningEffort(tokens[tokens.length - 1]!);
        if (maybeEffort) {
          effortArg = tokens[tokens.length - 1];
          modelArg = tokens.slice(0, -1).join(" ");
        }
      }
      const resolved =
        resolveParamChoice(modelArg, choices) ||
        // allow free-form model ids not in the list
        modelArg;
      opts.config.model = resolved;
      opts.session.meta.model = resolved;

      let effortNote = "";
      if (effortArg) {
        const e = parseReasoningEffort(effortArg);
        if (!e) {
          effortNote = chalk.yellow(
            `\nIgnored effort "${effortArg}" (use low|medium|high)`,
          );
        } else if (!modelSupportsReasoningEffort(resolved)) {
          effortNote = chalk.yellow(
            `\n${resolved} does not support reasoning effort (value kept in prefs for other models)`,
          );
          opts.config.reasoningEffort = e;
          try {
            savePreferences({ model: resolved, reasoningEffort: e });
          } catch {
            /* ignore */
          }
        } else if (!effortLevelsForModel(resolved).includes(e)) {
          effortNote = chalk.yellow(
            `\n${e} not valid for ${resolved}; using ${defaultEffortForModel(resolved)}`,
          );
          const d = defaultEffortForModel(resolved)!;
          opts.config.reasoningEffort = d;
          try {
            savePreferences({ model: resolved, reasoningEffort: d });
          } catch {
            /* ignore */
          }
        } else {
          opts.config.reasoningEffort = e;
          try {
            savePreferences({ model: resolved, reasoningEffort: e });
          } catch {
            /* ignore */
          }
          effortNote = ` · effort ${e}`;
        }
      } else {
        try {
          savePreferences({ model: resolved });
        } catch {
          /* never fail slash on prefs I/O */
        }
        if (modelSupportsReasoningEffort(resolved)) {
          const e = resolveReasoningEffort(resolved, opts.config.reasoningEffort);
          effortNote = ` · effort ${e}`;
        }
      }

      saveSession(opts.session);
      return {
        handled: true,
        output: `Model set to ${resolved}${effortNote} (saved for future sessions)`,
        session: opts.session,
      };
    }

    case "/effort": {
      const model = opts.config.model;
      if (!modelSupportsReasoningEffort(model)) {
        return {
          handled: true,
          output:
            chalk.yellow(
              `${model} does not support reasoning effort.\n`,
            ) +
            chalk.dim(
              "Supported today: grok-4.5 (low|medium|high). Switch with /model grok-4.5",
            ),
        };
      }
      const levels = effortLevelsForModel(model);
      const choices = levels.map((e) => ({
        value: e,
        description: REASONING_EFFORT_DESCRIPTIONS[e],
      }));
      const current =
        resolveReasoningEffort(model, opts.config.reasoningEffort) ??
        defaultEffortForModel(model);
      if (!arg) {
        return {
          handled: true,
          output:
            formatParamMenu("/effort", choices, current) +
            chalk.dim(
              "\nAliases: l/low, m/medium/med, h/high  ·  applies on next model call  [live]",
            ),
        };
      }
      const resolved =
        resolveParamChoice(arg, choices) || parseReasoningEffort(arg);
      if (!resolved || !levels.includes(resolved as ReasoningEffort)) {
        return {
          handled: true,
          output:
            chalk.yellow(`Unknown effort: ${arg}\n`) +
            formatParamMenu("/effort", choices, current),
        };
      }
      const level = resolved as ReasoningEffort;
      opts.config.reasoningEffort = level;
      try {
        savePreferences({ reasoningEffort: level });
      } catch {
        /* never fail slash on prefs I/O */
      }
      // Mid-run: notice so the agent is aware on the next LLM call
      try {
        pushLiveNotice(
          opts.session.meta.id,
          `User set reasoning effort to ${level} (applies to subsequent model calls).`,
        );
      } catch {
        /* optional */
      }
      return {
        handled: true,
        output: `Reasoning effort: ${level} for ${model} (saved for future sessions)`,
      };
    }

    case "/compact": {
      const before = opts.session.messages.length;
      const ulw = loadUlwCycle(opts.session.meta.id);
      const goal = loadGoal(opts.session.meta.id);
      opts.session.messages = compactMessages(opts.session.messages, 12, {
        ulw,
        goal,
        todos: opts.session.todos,
        sessionId: opts.session.meta.id,
      });
      saveSession(opts.session);
      return {
        handled: true,
        output: `Compacted ${before} → ${opts.session.messages.length} messages (structured harness summary)`,
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
      // /export [path] [--json]
      const parts = arg ? arg.split(/\s+/).filter(Boolean) : [];
      const asJson = parts.some((p) => p === "--json" || p === "-j" || p === "json");
      const pathArg = parts.find((p) => !p.startsWith("-") && p !== "json");
      const body = asJson
        ? exportSessionJson(opts.session)
        : exportSessionMarkdown(opts.session);
      if (pathArg) {
        const p = path.resolve(pathArg);
        fs.writeFileSync(p, body, "utf8");
        return {
          handled: true,
          output: `Exported ${asJson ? "JSON" : "markdown"} to ${p}`,
        };
      }
      return { handled: true, output: body };
    }

    case "/fork": {
      const title = arg || undefined;
      const forked = forkSession(opts.session, title ? { title } : undefined);
      return {
        handled: true,
        output:
          `Forked session → ${forked.meta.id}\n` +
          `  msgs=${forked.messages.length} todos=${forked.todos.length}\n` +
          `  Continuing in the fork. Original ${opts.session.meta.id.slice(0, 8)} unchanged.\n` +
          `  Resume original later: /resume ${opts.session.meta.id.slice(0, 8)}`,
        replaceSession: forked,
      };
    }

    case "/title":
    case "/rename": {
      // /title                 → show
      // /title <name>          → set
      // /title clear|none|-    → clear (auto-title may refill on next user msg)
      const raw = (arg || "").trim();
      if (!raw) {
        return {
          handled: true,
          output: `Title: ${opts.session.meta.title || "(untitled)"}`,
        };
      }
      const lower = raw.toLowerCase();
      if (lower === "clear" || lower === "none" || lower === "-") {
        setSessionTitle(opts.session, "");
        return {
          handled: true,
          output: "Title cleared (will auto-set from next user message).",
          session: opts.session,
        };
      }
      const t = setSessionTitle(opts.session, raw);
      return {
        handled: true,
        output: `Title set: ${t}`,
        session: opts.session,
      };
    }

    case "/bell": {
      // /bell              → status
      // /bell on|off|1|0   → persist preference
      // /bell test         → ring once (if TTY)
      const { isBellEnabled, maybeRingBell } = await import(
        "../util/attention.js"
      );
      const raw = (arg || "").trim().toLowerCase();
      if (!raw || raw === "status") {
        const on = isBellEnabled();
        const env = process.env.FORGE_BELL?.trim();
        return {
          handled: true,
          output:
            `Turn-end bell: ${on ? "on" : "off"}` +
            (env ? ` (FORGE_BELL=${env})` : " (preference / default off)") +
            `\n  /bell on|off   persist · /bell test   ring once · env FORGE_BELL=0|1 overrides`,
        };
      }
      if (raw === "test" || raw === "ring") {
        const rang = maybeRingBell({ force: true });
        return {
          handled: true,
          output: rang
            ? "Bell rang (if your terminal is muted you may not hear it)."
            : "Bell skipped (stdout is not a TTY).",
        };
      }
      if (["on", "1", "true", "yes", "enable"].includes(raw)) {
        savePreferences({ bellOnTurnEnd: true });
        return {
          handled: true,
          output:
            "Turn-end bell ON (persisted). Override with FORGE_BELL=0 if needed.",
        };
      }
      if (["off", "0", "false", "no", "disable"].includes(raw)) {
        savePreferences({ bellOnTurnEnd: false });
        return {
          handled: true,
          output: "Turn-end bell OFF (persisted).",
        };
      }
      return {
        handled: true,
        output: "Usage: /bell [on|off|test|status]",
      };
    }

    case "/diff": {
      const cwd = opts.session.meta.cwd || opts.config.workspace || process.cwd();
      const extra = arg || "";
      // Argv-based git only — never interpolate user text into a shell string
      // (prevents `/diff '; rm -rf /'` style injection).
      const filterArgs = extra ? tokenizeSimple(extra) : [];
      if (filterArgs.some((t) => t.includes("\0"))) {
        return {
          handled: true,
          output: "Invalid /diff filter (nul byte).",
        };
      }
      // Deny git options that write files or change git context (read-only view).
      const bad = filterArgs.find((t) => !isSafeDiffFilterArg(t));
      if (bad) {
        return {
          handled: true,
          output:
            `Rejected /diff filter token: ${bad}\n` +
            `Allowed: pathspecs, refs (HEAD, main, abc123), and read-only flags ` +
            `(--cached, --staged, --name-only, --name-status, --stat, -U<n>).`,
        };
      }
      const git = (
        args: string[],
        timeoutMs: number,
        maxBuffer = 1024 * 1024,
      ): string =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: timeoutMs,
          maxBuffer,
        });
      try {
        // Safe read-only git view for experts reviewing agent work
        const stat = git(["status", "--short"], 8000).trim();
        let statDiff = "";
        try {
          statDiff = git(
            filterArgs.length
              ? ["--no-pager", "diff", "--stat", ...filterArgs]
              : ["--no-pager", "diff", "--stat", "HEAD"],
            12_000,
          ).trim();
        } catch {
          statDiff = git(["--no-pager", "diff", "--stat"], 12_000).trim();
        }
        let patch = "";
        try {
          patch = git(
            filterArgs.length
              ? ["--no-pager", "diff", "--no-color", ...filterArgs]
              : ["--no-pager", "diff", "--no-color", "HEAD"],
            15_000,
            2 * 1024 * 1024,
          );
        } catch {
          patch = git(
            ["--no-pager", "diff", "--no-color"],
            15_000,
            2 * 1024 * 1024,
          );
        }
        const max = 12_000;
        const body =
          patch.length > max
            ? patch.slice(0, max) +
              `\n\n… [${patch.length - max} chars truncated — use git diff in a terminal for full output]`
            : patch;
        const out = [
          `cwd: ${cwd}`,
          stat ? `status:\n${stat}` : "status: clean",
          statDiff ? `\nstat:\n${statDiff}` : "",
          body.trim() ? `\ndiff:\n${body}` : "\n(no unstaged/HEAD diff)",
          filterArgs.length ? `\n(filter: ${filterArgs.join(" ")})` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return { handled: true, output: out };
      } catch (err) {
        return {
          handled: true,
          output: `git diff unavailable: ${(err as Error).message?.slice(0, 200) || err}`,
        };
      }
    }

    case "/copy": {
      const text = lastAssistantText(opts.session);
      if (!text) return { handled: true, output: "No assistant message to copy." };
      const result = copyToClipboard(text);
      if (result.ok) {
        return {
          handled: true,
          output: `Copied last assistant reply (${text.length} chars via ${result.backend}).`,
        };
      }
      const preview = text.slice(0, 2000) + (text.length > 2000 ? "\n…" : "");
      return {
        handled: true,
        output: `Clipboard unavailable (${result.error}). Last reply:\n\n${preview}`,
      };
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
      // /new [title] — optional label (parity with forge --title / createSession title)
      const titleArg =
        cmd === "/new" && arg.trim() ? arg.trim() : undefined;
      const s = createSession({
        cwd: opts.session.meta.cwd,
        provider: opts.config.provider,
        model: opts.config.model,
        ultrawork: opts.session.meta.ultrawork,
        title: titleArg,
      });
      const titleNote = s.meta.title ? ` — ${s.meta.title}` : "";
      return {
        handled: true,
        output: `New session ${s.meta.id.slice(0, 8)}${titleNote}`,
        replaceSession: s,
      };
    }

    case "/resume": {
      if (!arg || arg === "all" || arg === "global" || arg === "-a") {
        const ws = opts.session.meta.cwd || opts.config.workspace || process.cwd();
        const showAll = arg === "all" || arg === "global" || arg === "-a";
        const list = listSessions({
          limit: 10,
          ...(showAll ? {} : { cwd: ws }),
        });
        const scope = showAll ? "all workspaces" : `cwd=${ws}`;
        return {
          handled: true,
          output:
            list.length === 0
              ? showAll
                ? "No sessions. Usage: /resume <session-id-prefix>"
                : `No sessions for this workspace. Try: /resume all`
              : `Usage: /resume <session-id-prefix>  ·  ${scope}\n\nRecent:\n${list
                  .map((s) => {
                    const lock = readSessionLock(s.id);
                    const lockNote = lock ? `  LOCK pid ${lock.pid}` : "";
                    const cwdNote =
                      showAll && s.cwd ? `  ${path.basename(s.cwd)}` : "";
                    return `  ${s.id.slice(0, 8)}  ${(s.title || "").slice(0, 40).padEnd(40)}  ${s.model}${lockNote}${cwdNote}`;
                  })
                  .join("\n")}${showAll ? "" : chalk.dim("\n\n/resume all — every workspace")}`,
        };
      }
      const loaded = loadSession(arg);
      if (!loaded) {
        return { handled: true, output: `Session not found: ${arg}` };
      }
      opts.config.model = loaded.meta.model;
      let lockWarn = "";
      if (sessionHasForeignLiveLock(loaded.meta.id)) {
        const lock = readSessionLock(loaded.meta.id);
        lockWarn =
          `\n⚠ Session is locked by another live process` +
          (lock ? ` (${formatLockHolder(lock)})` : "") +
          `. Concurrent writes may race — prefer one writer, or wait until the other REPL exits.`;
      }
      return {
        handled: true,
        output: `Resumed ${loaded.meta.id.slice(0, 8)} — ${loaded.meta.title || "untitled"} (${loaded.messages.length} msgs)${lockWarn}`,
        replaceSession: loaded,
      };
    }

    case "/sessions": {
      const parts = arg.split(/\s+/).filter(Boolean);
      const sub = (parts[0] || "").toLowerCase();
      if (sub === "delete" || sub === "rm" || sub === "remove") {
        const target = parts[1] || "";
        if (!target) {
          return {
            handled: true,
            output: "Usage: /sessions delete <id-prefix> [--force]",
          };
        }
        if (target === opts.session.meta.id || opts.session.meta.id.startsWith(target)) {
          return {
            handled: true,
            output: "Cannot delete the active session. /new first, then delete.",
          };
        }
        const force = parts.some((p) => p === "--force" || p === "-f");
        const result = deleteSessionDetailed(target, { force });
        if (result.ok) {
          return { handled: true, output: `Deleted session ${result.id}` };
        }
        if (result.reason === "locked") {
          return {
            handled: true,
            output:
              `Session locked by another live process` +
              (result.id ? ` (${result.id.slice(0, 8)})` : "") +
              `. Use /sessions delete ${target} --force to override.`,
          };
        }
        return {
          handled: true,
          output: `Session not found: ${target}`,
        };
      }
      if (sub === "prune") {
        const keepArg = parts.find((p) => p.startsWith("--keep="));
        const keep = keepArg ? Number(keepArg.split("=")[1]) : 50;
        const result = pruneSessions({
          keep: Number.isFinite(keep) && keep > 0 ? keep : 50,
          protectIds: [opts.session.meta.id],
        });
        const lockNote = result.skippedLocked
          ? `; skipped ${result.skippedLocked} foreign-locked`
          : "";
        return {
          handled: true,
          output: `Pruned ${result.deleted.length} session(s); kept ${result.kept} (active protected${lockNote}). CLI: forge sessions prune --keep 50`,
        };
      }
      // Default: same-cwd sessions (multi-project experts). /sessions all|global for everything.
      // /sessions q <text> or /sessions search <text> filters by id/title substring.
      const ws = opts.session.meta.cwd || opts.config.workspace || process.cwd();
      let listMode: "cwd" | "all" = "cwd";
      let query: string | undefined;
      if (sub === "all" || sub === "global" || sub === "-a") {
        listMode = "all";
      } else if (sub === "q" || sub === "search" || sub === "find") {
        query = parts.slice(1).join(" ").trim() || undefined;
        if (!query) {
          return {
            handled: true,
            output: "Usage: /sessions search <id-or-title-substring>",
          };
        }
        listMode = "all";
      } else if (sub && !["list", "ls"].includes(sub)) {
        // bare query token: /sessions incident
        query = parts.join(" ").trim() || undefined;
        listMode = "all";
      }
      const list = listSessions({
        limit: 15,
        ...(listMode === "cwd" && !query ? { cwd: ws } : {}),
        ...(query ? { query } : {}),
      });
      if (!list.length) {
        if (query) {
          return {
            handled: true,
            output: `No sessions matching ${JSON.stringify(query)}.`,
          };
        }
        if (listMode === "cwd") {
          return {
            handled: true,
            output: `No sessions for this workspace.\nTry: /sessions all  ·  CLI: forge sessions list --cwd .`,
          };
        }
        return { handled: true, output: "No sessions yet." };
      }
      const scopeNote =
        query
          ? `search=${JSON.stringify(query)}`
          : listMode === "cwd"
            ? `cwd=${ws}`
            : "all workspaces";
      return {
        handled: true,
        output:
          list
            .map((s) => {
              const lock = readSessionLock(s.id);
              const lockNote = lock ? `  LOCK pid ${lock.pid}` : "";
              const active =
                s.id === opts.session.meta.id ||
                opts.session.meta.id.startsWith(s.id.slice(0, 8))
                  ? " *"
                  : "";
              const cwdNote =
                listMode === "all" && s.cwd
                  ? `  ${path.basename(s.cwd)}`
                  : "";
              return `${s.id.slice(0, 8)}  ${s.updatedAt.slice(0, 19)}  ${(s.title || "").slice(0, 36).padEnd(36)}  ${s.model}  t=${s.turnCount}${s.ultrawork ? " ULW" : ""}${active}${lockNote}${cwdNote}`;
            })
            .join("\n") +
          chalk.dim(
            `\n\n* = active  ·  ${scopeNote}  ·  /sessions [all|search <q>]  ·  delete <id> [--force]  ·  prune [--keep=50]  ·  /resume <id>\nCLI: forge sessions list --cwd .  ·  show|export|import|fork|delete <id>`,
          ),
      };
    }

    case "/permissions": {
      const choices = COMMAND_PARAMS.permissions;
      const modeChoices = choices.filter((c) =>
        ["default", "acceptEdits", "plan", "bypassPermissions"].includes(c.value),
      );
      const sub = arg.trim();
      const verb = (sub.split(/\s+/)[0] || "").toLowerCase();
      // Management verbs (also via menu numbers after modes)
      if (verb === "list" || sub.startsWith("list ")) {
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
      if (verb === "clear") {
        const { clearSavedAllows } = await import("../agent/permission-saved.js");
        const n = clearSavedAllows(opts.config.workspace || process.cwd());
        return { handled: true, output: `Cleared ${n} saved allow rule(s) for this workspace.` };
      }
      if (verb === "revoke") {
        const id = sub.slice(verb.length).trim();
        if (!id) {
          return {
            handled: true,
            output: "Usage: /permissions revoke <id>  (see /permissions list)",
          };
        }
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
              modeChoices,
              opts.config.permissionMode,
            ) +
            chalk.dim(
              "\nAlso: /permissions list | clear | revoke <id>",
            ),
        };
      }
      // Resolve against full choices so Tab numbers for list/clear still work,
      // but never assign management verbs as permissionMode.
      const resolved = resolveParamChoice(arg, choices);
      if (!resolved) {
        return {
          handled: true,
          output:
            chalk.yellow(`Unknown mode: ${arg}\n`) +
            formatParamMenu("/permissions", modeChoices, opts.config.permissionMode),
        };
      }
      if (resolved === "list") {
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
      if (resolved === "clear") {
        const { clearSavedAllows } = await import("../agent/permission-saved.js");
        const n = clearSavedAllows(opts.config.workspace || process.cwd());
        return {
          handled: true,
          output: `Cleared ${n} saved allow rule(s) for this workspace.`,
        };
      }
      if (resolved === "revoke") {
        return {
          handled: true,
          output: "Usage: /permissions revoke <id>  (see /permissions list)",
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
      if (g) {
        pushLiveNotice(
          sid,
          "User paused /goal mid-run. Stop is no longer forced by the goal driver until /goal resume.",
        );
      }
      return {
        handled: true,
        output: g
          ? "Goal paused." +
            chalk.dim("\n  (applies immediately to harness; agent notified on next model call)")
          : "No active goal.",
      };
    }
    case "resume":
    case "unpause": {
      const g = resumeGoal(sid);
      if (g) {
        session.meta.ultrawork = true;
        saveSession(session);
        pushLiveNotice(
          sid,
          `User resumed /goal mid-run. Objective remains active: ${g.objective.slice(0, 200)}. Continue until **Goal achieved.** or the user pauses/clears.`,
        );
      }
      return {
        handled: true,
        output: g
          ? `Goal resumed.\n${formatGoalStatus(g)}` +
            chalk.dim("\n  (applies immediately to harness; agent notified on next model call)")
          : "No goal to resume.",
        session,
      };
    }
    case "clear": {
      clearGoal(sid);
      pushLiveNotice(
        sid,
        "User cleared /goal mid-run. The goal driver will no longer block Stop.",
      );
      return {
        handled: true,
        output:
          "Goal cleared." +
          chalk.dim("\n  (applies immediately to harness; agent notified on next model call)"),
      };
    }
    case "done": {
      const g = markGoalDone(sid, restText || undefined);
      if (g) {
        pushLiveNotice(
          sid,
          "User marked /goal done mid-run. Treat the objective as released; wrap up without further goal-driven waves.",
        );
      }
      return {
        handled: true,
        output: g
          ? `Goal marked achieved.${restText ? ` (${restText})` : ""}` +
            chalk.dim("\n  (applies immediately to harness; agent notified on next model call)")
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

/**
 * Report presence + mode bits for sensitive JSON under FORGE_HOME.
 * Owner-only (0600) is required; group/world bits become doctor issues.
 * Uses inspectSecureFile so text + --json share one mode check.
 */
function pushSecureFileStatus(
  lines: string[],
  issues: string[],
  filePath: string,
  label: string,
  opts?: { required?: boolean; missingLabel?: string },
): void {
  const name = label.padEnd(16);
  const info = inspectSecureFile(filePath);
  if (!info.exists) {
    if (opts?.required || opts?.missingLabel !== undefined) {
      lines.push(`  ${name} ${opts?.missingLabel ?? "no"}`);
    }
    return;
  }
  if (info.mode != null) {
    const modeOk = info.modeOk !== false;
    lines.push(
      `  ${name} yes (mode ${info.mode}${modeOk ? "" : chalk.red(" — should be 600")})`,
    );
    if (!modeOk) {
      issues.push(`${label} is group/world-readable — expected mode 0600`);
    }
    return;
  }
  lines.push(`  ${name} yes`);
}

/** Structured doctor result — CI should prefer `ok`/`issues` over report-text regex. */
export interface DoctorResult {
  report: string;
  issues: string[];
  /** True when no blocking issues (auth missing, insecure modes, Blocking Stop OFF, …). */
  ok: boolean;
  authenticated: boolean;
  blockingStop: boolean;
}

/**
 * Full doctor check with structured fields for `forge doctor --json`.
 * Text report remains human-oriented (chalk); `ok`/`issues` are the CI contract.
 */
export function runDoctorCheck(config: ForgeConfig): DoctorResult {
  const lines: string[] = [chalk.bold("Forge doctor"), ""];
  const issues: string[] = [];
  lines.push(`Version: ${getForgeVersion()}`);
  const auth = resolveAuth(config);
  lines.push(`Auth: ${describeAuth(auth)}`);
  if (!auth) {
    issues.push("Not authenticated — run forge login or set an API key env var");
  } else if (auth.method !== "api_key") {
    // Surface expiry for OAuth/subscription without printing tokens
    const cred = getCredential(String(auth.provider));
    if (cred?.expiresAt) {
      const exp = new Date(cred.expiresAt * 1000).toISOString();
      if (isExpired(cred, 0)) {
        lines.push(chalk.red(`  Token EXPIRED at ${exp}`));
        if (cred.refreshToken) {
          lines.push(
            chalk.yellow(
              "  refresh_token present — will try auto-refresh on next start",
            ),
          );
        } else {
          issues.push(
            `OAuth token expired for ${auth.provider} and no refresh_token — re-login`,
          );
        }
      } else {
        lines.push(
          chalk.dim(
            `  Token expires ${exp}${cred.refreshToken ? " · refresh_token=yes" : ""}`,
          ),
        );
      }
    }
  }
  {
    const effort = resolveReasoningEffort(config.model, config.reasoningEffort);
    const effortSuffix = effort ? ` · effort=${effort}` : "";
    lines.push(`Provider/model: ${config.provider} / ${config.model}${effortSuffix}`);
  }
  lines.push(`Permission mode: ${config.permissionMode}`);
  {
    try {
      const ws = config.workspace || process.cwd();
      const allows = loadSavedAllows(ws);
      if (allows.length > 0) {
        lines.push(
          `Saved always-allows: ${allows.length} for this workspace (/permissions list · clear)`,
        );
      }
    } catch {
      /* optional */
    }
  }
  {
    const prefs = loadPreferences();
    const bits = [
      prefs.model ? `model=${prefs.model}` : null,
      prefs.reasoningEffort ? `effort=${prefs.reasoningEffort}` : null,
      prefs.permissionMode ? `permission_mode=${prefs.permissionMode}` : null,
      prefs.bellOnTurnEnd ? "bell=on" : null,
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
    if (config.sandbox !== "off" && !backend.available) {
      if (config.sandboxMissingBackend === "fail-closed") {
        issues.push(
          "Sandbox backend missing under fail-closed — bash tools will be denied (install bwrap/Xcode CLT or set sandbox=off)",
        );
      }
    }
    lines.push(`Missing backend policy: ${config.sandboxMissingBackend || "fail-closed"}`);
    lines.push(`Read outside workspace: ${config.readOutsideWorkspace || "ask"}`);
  }
  const denyN = config.permission?.deny?.length || 0;
  const allowN = config.permission?.allow?.length || 0;
  const askN = config.permission?.ask?.length || 0;
  lines.push(`Rules: deny=${denyN} allow=${allowN} ask=${askN} (deny wins under YOLO)`);
  lines.push(`Blocking Stop: ${config.blockingStopHooks ? "on" : "off"}`);
  if (!config.blockingStopHooks) {
    lines.push(chalk.yellow("  ⚠ Blocking Stop is OFF — harness Stop hooks cannot force continue"));
    // Non-negotiable for production harness reliability (see AGENTS.md).
    issues.push(
      "Blocking Stop is OFF — enable blockingStopHooks (default true) so Stop hooks can force continue",
    );
  }
  lines.push(`Goal gate: ${config.goal.enabled ? "on" : "off"} (stuck=${config.goal.stuckThreshold})`);
  lines.push(`Workspace: ${config.workspace || process.cwd()}`);
  lines.push(
    `Context: window=${config.contextWindow} autoCompact@${Math.round((config.autoCompactThreshold || 0.8) * 100)}% maxTurns=${config.maxTurns}`,
  );
  {
    const maxRun = process.env.FORGE_MAX_RUN_MS?.trim();
    const maxRunNote =
      maxRun && /^\d+$/.test(maxRun) && Number(maxRun) >= 5_000
        ? ` · max-run=${Math.round(Number(maxRun) / 1000)}s`
        : "";
    const permTo = permissionAskTimeoutMs();
    const permNote =
      permTo > 0 ? ` · perm-ask-timeout=${Math.round(permTo / 1000)}s` : "";
    const doomN = envPositiveInt("FORGE_DOOM_LOOP_THRESHOLD", 3);
    const errN = envPositiveInt("FORGE_ERROR_STREAK_THRESHOLD", 5);
    const ulwCap = envPositiveInt("FORGE_ULW_MAX_CONTINUES", 200);
    const bellNote = isBellEnabled() ? " · bell=on" : "";
    const autoResumeOff =
      process.env.FORGE_NO_AUTO_RESUME === "1" ||
      process.env.FORGE_NO_AUTO_RESUME === "true";
    const resumeNote = autoResumeOff
      ? " · auto-resume=off"
      : " · auto-resume=same-cwd";
    lines.push(
      `Reliability: Retry-After · abortable streams · empty-SSE retry · JSON repair · orphan tool heal · doom-loop@${doomN} · error-streak@${errN} · ulw-continues@${ulwCap} · apply_patch · overflow→compact · session lock/tmp-recover · metrics.jsonl · OAuth refresh · provider timeout=${Math.round(providerTimeoutMs() / 1000)}s${maxRunNote}${permNote}${bellNote}${resumeNote}`,
    );
  }

  const node = process.version;
  lines.push(`Node: ${node}`);
  const major = parseInt(node.slice(1), 10);
  if (major < 20) {
    lines.push(chalk.red("  ⚠ Node 20+ required"));
    issues.push(`Node ${node} is below 20`);
  }

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
  // Sensitive JSON stores must be owner-only (0600)
  pushSecureFileStatus(lines, issues, path.join(home, "auth.json"), "auth", {
    required: false,
    missingLabel: "no",
  });
  pushSecureFileStatus(
    lines,
    issues,
    path.join(home, "permissions.json"),
    "permissions.json",
  );
  pushSecureFileStatus(
    lines,
    issues,
    path.join(home, "preferences.json"),
    "preferences.json",
  );
  try {
    const sessions = listSessions(10_000);
    const sessN = sessions.length;
    let lockedN = 0;
    for (const s of sessions) {
      if (sessionHasForeignLiveLock(s.id)) lockedN += 1;
    }
    lines.push(
      `  sessions: ${sessN}` +
        (lockedN > 0
          ? chalk.dim(` · ${lockedN} foreign-locked`)
          : "") +
        (sessN > 80
          ? chalk.yellow(" — consider: forge sessions prune --keep 50")
          : ""),
    );
  } catch {
    /* */
  }
  try {
    const st = toolOutputStats();
    if (st.files > 0) {
      const mb = (st.bytes / (1024 * 1024)).toFixed(1);
      lines.push(
        `  tool-output: ${st.files} files · ${mb} MB` +
          (st.files > 100
            ? chalk.yellow(" — auto-pruned on next large tool result")
            : ""),
      );
    } else {
      lines.push(`  tool-output: empty`);
    }
  } catch {
    /* optional */
  }
  try {
    const sl = sandboxLogStats();
    if (sl.exists || sl.backupBytes > 0) {
      const kb = (sl.bytes / 1024).toFixed(0);
      const bak =
        sl.backupBytes > 0
          ? ` + ${(sl.backupBytes / 1024).toFixed(0)} KB backup`
          : "";
      lines.push(`  sandbox-log: ${kb} KB${bak}`);
    }
  } catch {
    /* optional */
  }
  try {
    const m = metricsStats();
    if (m.events > 0) {
      lines.push(
        `  metrics: ${m.events} events · ${(m.bytes / 1024).toFixed(1)} KB (~/.forge/metrics.jsonl)`,
      );
    } else {
      lines.push(`  metrics: empty`);
    }
  } catch {
    /* optional */
  }
  try {
    // In-process only — useful when /doctor runs mid-REPL with bg shells alive
    const tasks = listTasks();
    const running = tasks.filter((t) => t.status === "running").length;
    if (tasks.length > 0) {
      lines.push(
        `  background-tasks: ${running} running · ${tasks.length} total (this process)`,
      );
    }
  } catch {
    /* optional */
  }

  lines.push("");
  if (issues.length === 0) {
    lines.push(chalk.green("✓ No blocking issues detected"));
  } else {
    lines.push(chalk.yellow(`⚠ ${issues.length} issue(s):`));
    for (const i of issues) lines.push(chalk.yellow(`  • ${i}`));
  }

  return {
    report: lines.join("\n"),
    issues: [...issues],
    ok: issues.length === 0,
    authenticated: Boolean(auth),
    blockingStop: config.blockingStopHooks !== false,
  };
}

/** Human-readable doctor report (slash `/doctor` and plain `forge doctor`). */
export function runDoctor(config: ForgeConfig): string {
  return runDoctorCheck(config).report;
}

const HELP_TEXT = `
Forge slash commands
────────────────────
  /help                 Show this help
  /goal <objective>     Arm relentless goal driver (Codex-style)
  /goal                 Show goal status  [live]
  /goal pause|resume|clear|done   [live]
  /ulw [task]           Arm ULW + cycle=1 (soft prompts OK: "improve the code")
  /cycle 1|0|status     Continue waves (1) or last wave then stop (0)  [live]
  /ulw-off              Disarm ULW + cycle driver  [live]
  /hooks                List loaded hooks  [live]
  /status · /hud        Full inline HUD + session details (no second panel)  [live]
  /tasks                Background shell tasks (running / recent)  [live]
  /context              Context window usage bar  [live]
  /cost                 Token usage + rough cost  [live]
  /metrics              Local metrics.jsonl + this session counters  [live]
  /todos                Show agent todos  [live]
  /model <name> [effort] Switch model; optional low|medium|high (persists)
  /effort [level]       Reasoning effort for current model (low|medium|high)  [live]
  /permissions [mode]   Menu if empty; Tab / numbers / aliases (yolo, always…)
                        Mode persists · list|clear|revoke for saved always-allows
  /compact              Compact conversation
  /rewind [n]           Undo last n user turns (/undo)
  /export [path] [--json]  Export session as markdown or JSON
  /fork [title]         Branch session into a new id (keep original)
  /title [name|clear]   Show / set / clear session title (/rename)  [live]
  /bell [on|off|test]   Terminal BEL when a turn ends (long-run attention)  [live]
  /diff [path]          Git status + diff (argv-safe; pathspecs/refs only)  [live]
  /copy                 Copy last assistant reply (pbcopy/wl-copy/xclip/…)  [live]
  /new [title]          Fresh session (optional searchable label)
  /clear                Clear messages (same session)
  /resume [id|all]      Resume a prior session (picker defaults to same-cwd)
  /sessions [all|search|delete|prune]  List (cwd default) / search / delete [--force] / prune
  /auth                 Show stored credentials  [live]
  /doctor               Environment health check  [live]
  /quit                 Exit  [live — aborts run then exits]

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
  /permissions    Modes 1–4 · list|clear|revoke for saved always-allows
  Live controls   While the agent is working you can still type:
                  /cycle 0  ·  /cycle 1  ·  /ulw-off  ·  /goal pause  ·  /status
                  (no need to Ctrl+C first — harness updates apply at next Stop)
  Ctrl+C          Abort the current turn; twice at idle prompt to exit
`.trim();
