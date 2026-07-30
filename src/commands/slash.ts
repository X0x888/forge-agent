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
  rebuildUserTurnMarks,
  rewindSessionDetailed,
  exportSessionMarkdown,
  exportSessionJson,
  forkSession,
  setSessionTitle,
  MAX_SESSION_TITLE_CHARS,
  lastAssistantText,
  lastUserText,
  formatRecentTurns,
  formatResumePeek,
  formatResumeOrientation,
  formatSessionShareCard,
  formatSessionLookupMiss,
  formatSessionTouchedFiles,
  setSessionPinned,
  resolveSessionDir,
  resolveSessionJsonPath,
  sessionDir,
  clearConversation,
  createSession,
  loadSession,
  estimateTokens,
  enterSessionPlanMode,
  exitSessionPlanMode,
} from "../session/session.js";
import {
  formatRestoreResult,
  mutationsJournalStats,
} from "../session/mutations.js";
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
import {
  describeAuth,
  resolveAuth,
  resolveAuthFresh,
} from "../auth/resolve.js";
import { printAuthStatus } from "../auth/login.js";
import { getCredential, isExpired } from "../auth/store.js";
import { providerTimeoutMs } from "../util/abort.js";
import { copyToClipboard } from "../util/clipboard.js";
import {
  defaultBashBackgroundTimeoutMs,
  defaultBashTimeoutMs,
  envPositiveInt, maxRunMsFromEnv,
  parseCliNonNegInt,
} from "../util/env.js";
import { isBellEnabled } from "../util/attention.js";
import { forgeHome, inspectSecureFile } from "../util/fs.js";
import { getForgeVersion } from "../util/version.js";
import { formatWhatsNew } from "../util/changelog.js";
import { formatExpertTips } from "../util/tips.js";
import { parseDaysWindow, daysWindowHelp } from "../util/days-window.js";
import { parseNewsCount, newsCountHelp } from "../util/news-count.js";
import { parseLogsLines, logsLinesHelp } from "../util/logs-lines.js";
import { editDistance } from "../util/string-distance.js";
import { suggestName, suggestSessionAction } from "../util/suggest.js";
import { toolOutputStats } from "../agent/tools/truncate.js";
import { listTasks } from "../agent/tools/background-tasks.js";
import { loadSavedAllows } from "../agent/permission-saved.js";
import {
  formatSandboxLogTail,
  sandboxLogPath,
  sandboxLogStats,
} from "../agent/sandbox-log.js";
import {
  collectUsageStats,
  formatUsageStats,
  metricsStats,
} from "../session/metrics.js";
import { readSessionLock, formatLockHolder } from "../session/lock.js";
import { permissionAskTimeoutMs } from "../agent/permissions.js";
import { parseRuleString } from "../agent/rules.js";
import {
  estimateCostUsd,
  formatCost,
  formatTokens,
  formatRelativeTime,
} from "../util/format.js";
import { modelContextWindow } from "../config/model-info.js";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tokenizeSimple } from "../agent/shell-parse.js";
import {
  armUlwCycle,
  disarmUlwCycle,
  setCycleFlag,
  setMaxWaves,
  parseCycleArg,
  parseMaxWavesArg,
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
  /**
   * REPL must hot-swap provider credentials from the mutated `opts.auth`
   * (e.g. `/accounts switch`). Without this, live provider keeps the old token.
   */
  authUpdated?: boolean;
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
  "/stats",
  "/todos",
  "/auth",
  "/accounts",
  "/doctor",
  "/diff",
  "/copy", // clipboard last assistant reply — no session mutation
  "/share", // pasteable session card — optional clipboard
  "/last", // peek recent turns — read-only
  "/files", // paths touched by tools — read-only
  "/path", // session on-disk directory — read-only
  "/logs", // sandbox/safety event tail — read-only
  "/config", // effective config snapshot — read-only
  "/tips",
  "/news", // what's new from CHANGELOG
  "/changelog",
  "/sessions", // list only — delete/prune classified below
]);

/** Harness control commands safe mid-turn (no forwardPrompt). */
const LIVE_CONTROL = new Set([
  "/cycle",
  "/max-waves",
  "/max_waves",
  "/ulw-off",
  "/effort",
  "/plan",
  "/build",
  "/execute",
  "/title",
  "/rename",
  "/bell",
  "/pin",
  "/unpin",
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
      verb === "pinned" ||
      verb === "pins" ||
      verb === "pin" ||
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
    // plan/build aliases are live control (session-scoped; no sticky prefs)
    if (verb === "plan" || verb === "build" || verb === "execute" || verb === "implement") {
      return "control";
    }
    return "idle-only";
  }
  // OpenCode-style /plan /build — session-scoped; live mid-run
  if (cmd === "/plan" || cmd === "/build" || cmd === "/execute") {
    return "control";
  }
  // /tasks list|log is readonly; kill/stop mutates process tasks (control).
  if (cmd === "/tasks" || cmd === "/bg") {
    const verb = (arg.split(/\s+/)[0] || "").toLowerCase();
    if (
      !verb ||
      verb === "log" ||
      verb === "out" ||
      verb === "output" ||
      verb === "peek" ||
      verb === "show"
    ) {
      return "readonly";
    }
    if (verb === "kill" || verb === "stop" || verb === "rm") return "control";
    // unknown verb → readonly (suggestion only, no mutation)
    return "readonly";
  }
  if (LIVE_READONLY.has(cmd)) return "readonly";
  if (LIVE_CONTROL.has(cmd)) {
    // /cycle status (or bare menu) is read-only; flag flips are control
    if (cmd === "/cycle") {
      const a = arg.toLowerCase();
      if (!a || a === "status" || a === "3" /* menu status */) return "readonly";
    }
    // /max-waves status (or bare) is read-only; set/clear is control
    if (cmd === "/max-waves" || cmd === "/max_waves") {
      const a = arg.toLowerCase();
      if (!a || a === "status" || a === "show") return "readonly";
    }
    // bare /effort shows the menu; setting a level is control
    if (cmd === "/effort" && !arg) return "readonly";
    // bare /title|/rename shows current title
    if ((cmd === "/title" || cmd === "/rename") && !arg) return "readonly";
    // bare /bell shows status
    if (cmd === "/bell" && !arg) return "readonly";
    // /pin status is readonly; bare /pin pins (control). /unpin always mutates.
    if (cmd === "/pin") {
      const a = arg.toLowerCase();
      if (a === "status" || a === "show") return "readonly";
    }
    return "control";
  }
  if (cmd === "/goal") {
    const verb = (arg.split(/\s+/)[0] || "").toLowerCase();
    // bare /goal or known control verbs — not arm/set (those start new drive intent)
    if (LIVE_GOAL_VERBS.has(verb)) return verb === "" || verb === "status" ? "readonly" : "control";
    // "/goal set …" or "/goal <objective>" arms a goal — idle only
    return "idle-only";
  }
  // /done [note] — shorthand for /goal done (live control)
  if (cmd === "/done") return "control";
  // /pause — shorthand for /goal pause (live control)
  if (cmd === "/pause") return "control";
  // /unpause — shorthand for /goal resume (live control)
  if (cmd === "/unpause") return "control";
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
  `${ULW_LIVE_CONTROLS_HINT} · /plan · /build · free-text queues mid-run · /pause · /unpause · /done · /status  ·  Ctrl+C aborts the turn`;

export const SLASH_COMMANDS = [
  "/help",
  "/goal",
  "/done",
  "/pause",
  "/unpause",
  "/ulw",
  "/ulw-off",
  "/cycle",
  "/max-waves",
  "/hooks",
  "/status",
  "/statusline",
  "/hud",
  "/tasks",
  "/context",
  "/cost",
  "/metrics",
  "/stats",
  "/todos",
  "/model",
  "/effort",
  "/plan",
  "/build",
  "/execute",
  "/permissions",
  "/compact",
  "/compact-and",
  "/fork-and-compact",
  "/init",
  "/review",
  "/rewind",
  "/undo",
  "/retry",
  "/again",
  "/export",
  "/fork",
  "/title",
  "/rename",
  "/bell",
  "/pin",
  "/unpin",
  "/diff",
  "/copy",
  "/share",
  "/last",
  "/files",
  "/path",
  "/logs",
  "/config",
  "/tips",
  "/news",
  "/changelog",
  "/new",
  "/clear",
  "/resume",
  "/sessions",
  "/auth",
  "/accounts",
  "/account",
  "/doctor",
  "/quit",
] as const;

export function completeSlash(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith("/")) return [];
  if (t.includes(" ")) return [];
  return SLASH_COMMANDS.filter((c) => c.startsWith(t.toLowerCase()));
}


/**
 * Rank slash commands for typo recovery (unknown /cmd).
 * Prefer prefix/substring, then small Levenshtein distance on the bare name.
 */
export function suggestSlashCommands(
  rawCmd: string,
  limit = 5,
): string[] {
  const q = rawCmd.trim().toLowerCase();
  if (!q.startsWith("/")) return [];
  const bare = q.slice(1);
  if (!bare) return [];

  const scored = SLASH_COMMANDS.map((c) => {
    const name = c.slice(1); // without leading /
    let score = 0;
    if (c === q || name === bare) score = 100;
    else if (c.startsWith(q) || name.startsWith(bare))
      score = 80 - Math.min(20, Math.abs(name.length - bare.length));
    else if (name.includes(bare) || bare.includes(name)) score = 55;
    else {
      const d = editDistance(bare, name);
      // Allow slightly more drift for longer command names
      const maxD = bare.length <= 4 ? 2 : bare.length <= 8 ? 3 : 4;
      if (d <= maxD) {
        score = 40 - d;
        // Prefer same length + same first letter (transpositions like hepl→help)
        if (name.length === bare.length) score += 3;
        if (name[0] === bare[0]) score += 2;
      }
    }
    return { c, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.localeCompare(b.c));

  const out: string[] = [];
  const seen = new Set<string>();
  for (const { c } of scored) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/** Format unknown-slash message with optional Did you mean? tips. */
export function formatUnknownSlash(cmd: string): string {
  const suggestions = suggestSlashCommands(cmd);
  if (!suggestions.length) {
    return `Unknown command: ${cmd}. Type /help for commands.`;
  }
  return (
    `Unknown command: ${cmd}. Did you mean: ${suggestions.join(", ")}?\n` +
    `Type /help for commands.`
  );
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

    case "/done": {
      // Shorthand for /goal done [note] — live-safe mid-run control.
      const note = arg.trim();
      return handleGoal(note ? `done ${note}` : "done", opts.session);
    }

    case "/pause": {
      // Shorthand for /goal pause — live-safe mid-run control.
      return handleGoal("pause", opts.session);
    }

    case "/unpause": {
      // Shorthand for /goal resume — live-safe mid-run control.
      // (Avoid bare /resume — that switches sessions.)
      return handleGoal("resume", opts.session);
    }

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
        const tip = suggestName(arg.trim().toLowerCase(), [
          "0",
          "1",
          "status",
          "off",
          "on",
          "last",
          "continue",
        ], { minLength: 1, minScore: 36, requirePrefix3: false });
        return {
          handled: true,
          output:
            chalk.yellow(
              tip
                ? `Unknown /cycle "${arg}". Did you mean: ${tip}?\n`
                : `Unknown /cycle "${arg}".\n`,
            ) + formatParamMenu("/cycle", COMMAND_PARAMS.cycle),
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
          "User set cycle=1 (CONTINUE) mid-run. Keep the research → implement → serendipity → review loop. Do not stop until the user sets cycle=0, max_waves is hit, or /ulw-off.",
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

    case "/max-waves":
    case "/max_waves": {
      const sid = opts.session.meta.id;
      if (!arg || arg.toLowerCase() === "status" || arg.toLowerCase() === "show") {
        return {
          handled: true,
          output:
            (!arg
              ? formatParamMenu("/max-waves", COMMAND_PARAMS["max-waves"]) + "\n\n"
              : "") + formatUlwStatus(loadUlwCycle(sid)),
        };
      }
      // Literal N first — do NOT use menu index (menu "1" would map to first choice "3").
      let parsed: number | null | undefined = parseMaxWavesArg(arg);
      if (parsed === undefined) {
        const fromMenu = resolveParamChoice(arg, COMMAND_PARAMS["max-waves"]);
        if (fromMenu === "status") {
          return {
            handled: true,
            output: formatUlwStatus(loadUlwCycle(sid)),
          };
        }
        if (fromMenu === "off") parsed = null;
        else if (fromMenu != null && /^\d+$/.test(fromMenu)) parsed = Number(fromMenu);
      }
      if (parsed === undefined) {
        const tip = suggestName(arg.trim().toLowerCase(), [
          "off",
          "status",
          "3",
          "5",
          "10",
          "clear",
          "unlimited",
        ], { minLength: 1, minScore: 36, requirePrefix3: false });
        return {
          handled: true,
          output:
            chalk.yellow(
              tip
                ? `Unknown /max-waves "${arg}". Did you mean: ${tip}?\n`
                : `Unknown /max-waves "${arg}". Pass a positive integer, or off.\n`,
            ) + formatParamMenu("/max-waves", COMMAND_PARAMS["max-waves"]),
        };
      }
      let state = setMaxWaves(sid, parsed);
      if (!state) {
        // Auto-arm ULW so the cap is stored for the coming work
        opts.session.meta.ultrawork = true;
        state = armUlwCycle(sid, "continue prior mandate", {
          cycle: 1,
          maxWaves: parsed,
        });
        saveSession(opts.session);
      }
      const capLabel =
        state.maxWaves != null ? String(state.maxWaves) : "off (unlimited)";
      if (state.maxWaves != null) {
        pushLiveNotice(
          sid,
          `User set max_waves=${state.maxWaves} mid-run. When the wave counter reaches ${state.maxWaves}, auto-flip to LAST: finish that wave, review, attest **Cycle complete.** Do not start a new ambitious wave after the cap.`,
        );
      } else {
        pushLiveNotice(
          sid,
          "User cleared max_waves mid-run (unlimited). Cycle flag still controls CONTINUE vs LAST.",
        );
      }
      return {
        handled: true,
        output:
          chalk.magenta(`max_waves=${capLabel}`) +
          "\n" +
          formatUlwStatus(state) +
          chalk.dim(
            "\n  (cap written now — stop-guard honors it on next Stop; agent notified on next model call)",
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
      let accountCount: number | undefined;
      try {
        const { listAccounts } = await import("../auth/store.js");
        accountCount = listAccounts(String(auth.provider)).length;
      } catch {
        /* */
      }
      const snap = sessionToSnapshot(opts.session, {
        windowTokens: opts.config.contextWindow,
        authMethod: auth.method as import("../statusline/types.js").AuthMethod,
        authLabel: auth.accountLabel,
        accountId: auth.accountId,
        accountCount,
        permissionMode: opts.config.permissionMode,
      });
      try {
        snap.plan = await collectPlanUsage({
          provider: opts.session.meta.provider,
          authMethod: snap.authMethod,
          accountId: auth.accountId,
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
      const {
        listTasks,
        killTask,
        getTask,
        readTaskOutput,
      } = await import("../agent/tools/background-tasks.js");
      const raw = (arg || "").trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const verb = (parts[0] || "").toLowerCase();
      // /tasks kill <id> · /tasks stop <id>
      if (verb === "kill" || verb === "stop" || verb === "rm") {
        const id = parts[1] || "";
        if (!id) {
          return {
            handled: true,
            output:
              `Usage: /tasks ${verb} <task_id>\n` +
              formatBackgroundTasksList(),
          };
        }
        const msg = killTask(id);
        if (/^Unknown task_id:/.test(msg)) {
          const { unknownTaskMessage } = await import(
            "../agent/tools/task-tools.js"
          );
          return { handled: true, output: unknownTaskMessage(id) };
        }
        return { handled: true, output: msg };
      }
      // /tasks log|out|peek <id> [tail]
      if (
        verb === "log" ||
        verb === "out" ||
        verb === "output" ||
        verb === "peek" ||
        verb === "show"
      ) {
        const id = parts[1] || "";
        if (!id) {
          return {
            handled: true,
            output:
              `Usage: /tasks ${verb} <task_id> [tail]\n` +
              formatBackgroundTasksList(),
          };
        }
        let tail: number | undefined = 40;
        if (parts[2]) {
          const rawTail = parts[2].toLowerCase();
          if (rawTail === "all" || rawTail === "max" || rawTail === "full") {
            tail = 0; // full captured output
          } else if (/^\d+$/.test(parts[2])) {
            tail = Math.min(500, Math.max(1, parseInt(parts[2], 10)));
          } else {
            const tip = suggestName(rawTail, ["20", "40", "80", "all", "max", "full"], {
              minLength: 1,
              minScore: 36,
              requirePrefix3: false,
            });
            return {
              handled: true,
              output:
                (tip
                  ? `Invalid /tasks tail "${parts[2]}". Did you mean: ${tip}?\n`
                  : `Invalid /tasks tail "${parts[2]}".\n`) +
                `Usage: /tasks ${verb} <task_id> [tail|all|max|full]`,
            };
          }
        }
        const out = await readTaskOutput(id, { tail, stream: "both" });
        if (/^Unknown task_id:/.test(out)) {
          const { unknownTaskMessage } = await import(
            "../agent/tools/task-tools.js"
          );
          return { handled: true, output: unknownTaskMessage(id) };
        }
        const task = getTask(id);
        const head = task
          ? `task ${id.slice(0, 8)}  ${task.status}  ${task.command.slice(0, 60)}`
          : `task ${id}`;
        return { handled: true, output: `${head}\n${out}` };
      }
      // Unknown verb (not a bare list): suggest
      if (verb && !/^\d+$/.test(verb)) {
        const tip = suggestName(verb, ["kill", "stop", "log", "out", "peek", "show"], {
          minLength: 2,
          minScore: 36,
          requirePrefix3: false,
        });
        if (tip) {
          return {
            handled: true,
            output:
              `Unknown /tasks verb "${verb}". Did you mean: ${tip}?\n` +
              `Usage: /tasks · /tasks kill <id> · /tasks log <id> [tail]`,
          };
        }
      }
      const tasks = listTasks();
      const running = tasks.filter((t) => t.status === "running").length;
      const header =
        chalk.bold("Background tasks") +
        chalk.dim(
          `  (${running} running / ${tasks.length} tracked in this process)`,
        );
      return {
        handled: true,
        output:
          `${header}\n${formatBackgroundTasksList()}\n` +
          chalk.dim(
            "Agent: bash { background: true } · /tasks kill <id> · /tasks log <id> [tail] · exit force-kills leftovers",
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
      // Project instruction sources (OpenCode-style multi-file rules)
      let rulesNote = "";
      try {
        const { listProjectRulePaths, loadProjectRules } = await import(
          "../agent/system-prompt.js"
        );
        const ws = opts.config.workspace || process.cwd();
        const paths = listProjectRulePaths(ws);
        const body = loadProjectRules(ws);
        if (paths.length) {
          const labels = paths.slice(0, 8).map((p) => {
            const rel = path.relative(ws, p);
            return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
              ? rel
              : p.replace(process.env.HOME || "", "~");
          });
          const more = paths.length > 8 ? ` (+${paths.length - 8} more)` : "";
          rulesNote =
            `\nProject rules (~${formatTokens(estimateTokens([{ role: "system", content: body }]))}):\n` +
            labels.map((l) => `  · ${l}`).join("\n") +
            more;
        } else {
          rulesNote = `\nProject rules: none  (tip: AGENTS.md · /init)`;
        }
      } catch {
        /* */
      }
      return {
        handled: true,
        output: `Context  [${bar}] ${pct}%\n  ~${formatTokens(est)} / ${formatTokens(opts.config.contextWindow)}\nBy role:\n${roleLines}${rulesNote}`,
      };
    }

    case "/cost": {
      const cost = estimateCostUsd(
        String(opts.config.provider),
        opts.session.meta.totalPromptTokens,
        opts.session.meta.totalCompletionTokens,
        opts.config.model,
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
        opts.config.model,
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
          chalk.dim(`Tip: /stats [days] or forge stats --days 7 for a full usage dashboard`),
        ].join("\n"),
      };
    }

        case "/stats": {
      // /stats · /stats 7 · /stats --days=30 · /stats week|month|today|all
      // Explicit invalid window fails closed (parity with forge stats --days).
      const raw = arg.trim();
      let days = 0;
      if (raw) {
        const parsed = parseDaysWindow(raw);
        if (!parsed.ok) {
          {
          const tip = suggestName(raw.toLowerCase().replace(/^--days=/, ""), [
            "0",
            "7",
            "14",
            "30",
            "all",
            "week",
            "month",
            "today",
            "7d",
          ], { minLength: 2, minScore: 36, requirePrefix3: false });
          return {
            handled: true,
            output:
              (tip
                ? `Invalid /stats window "${raw}". Did you mean: ${tip}?\n`
                : `Invalid /stats window "${raw}".\n`) +
              `Pass a ${daysWindowHelp()} (e.g. /stats 7, /stats week) or omit for all time.\n` +
              chalk.dim("CLI: forge stats [--days N|week|month|today|all] [--json]"),
          };
        }
        }
        days = parsed.days;
      }
const stats = collectUsageStats({
        days: Number.isFinite(days) && days > 0 ? days : 0,
      });
      const cost = estimateCostUsd(
        String(opts.config.provider),
        opts.session.meta.totalPromptTokens,
        opts.session.meta.totalCompletionTokens,
        opts.config.model,
      );
      return {
        handled: true,
        output: [
          formatUsageStats(stats),
          ``,
          `This session:`,
          `  tokens: in=${formatTokens(opts.session.meta.totalPromptTokens)} out=${formatTokens(opts.session.meta.totalCompletionTokens)} · est ${formatCost(cost)}`,
          `  turns:  ${opts.session.meta.turnCount}  edits=${opts.session.meta.editCount}  id=${opts.session.meta.id.slice(0, 8)}`,
          chalk.dim(`CLI: forge stats [--days N] [--json]`),
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

    case "/accounts":
    case "/account": {
      const {
        formatAccountsTable,
        formatMultiAccountReadiness,
        switchAccount,
        resolveAccountSelector,
        clearAccountCooldown,
      } = await import("../auth/accounts.js");
      const {
        removeAccount,
        setAccountLabel,
        setAccountPriority,
        setAccountDisabled,
        getAutoSwitchSettings,
        setAutoSwitchSettings,
      } = await import("../auth/store.js");
      const applyAuthHotSwap = (account: {
        accessToken?: string;
        accountLabel?: string;
        subscription?: string;
        id: string;
        method: import("../auth/types.js").AuthMethod;
        provider: string;
      }): boolean => {
        if (!opts.auth || !account.accessToken) return false;
        opts.auth.token = account.accessToken;
        opts.auth.accountLabel =
          account.accountLabel ?? account.subscription;
        opts.auth.accountId = account.id;
        opts.auth.method = account.method;
        opts.auth.provider = account.provider;
        return true;
      };
      const raw = (arg || "").trim();
      if (!raw || raw === "list" || raw === "ls") {
        return { handled: true, output: formatAccountsTable() };
      }
      const [verb, ...rest] = raw.split(/\s+/);
      const v = verb.toLowerCase();
      if (v === "status" || v === "ready" || v === "readiness") {
        return {
          handled: true,
          output:
            formatMultiAccountReadiness() +
            "\n\n" +
            formatAccountsTable(),
        };
      }
      if (v === "switch" || v === "use") {
        const sel = rest.join(" ").trim();
        if (!sel) {
          return {
            handled: true,
            output: "Usage: /accounts switch <id|label|provider:N>",
          };
        }
        const hit = resolveAccountSelector(sel);
        if (!hit.ok) {
          return { handled: true, output: hit.error };
        }
        const r = switchAccount(String(hit.account.provider), {
          toId: hit.account.id,
          reason: "slash",
        });
        if (!r.switched) {
          return { handled: true, output: r.reason || "switch failed" };
        }
        const authUpdated = r.account
          ? applyAuthHotSwap(r.account)
          : false;
        return {
          handled: true,
          authUpdated,
          output: `Active ${hit.account.provider} → ${r.toLabel || r.toId}`,
        };
      }
      if (v === "remove" || v === "rm" || v === "delete") {
        const sel = rest.join(" ").trim();
        if (!sel) {
          return { handled: true, output: "Usage: /accounts remove <id|label>" };
        }
        const hit = resolveAccountSelector(sel);
        if (!hit.ok) return { handled: true, output: hit.error };
        removeAccount(hit.account.id);
        return { handled: true, output: `Removed ${hit.account.id}` };
      }
      if (v === "rename") {
        const sel = rest[0];
        const label = rest.slice(1).join(" ").trim();
        if (!sel || !label) {
          return {
            handled: true,
            output: "Usage: /accounts rename <id|label> <new-label>",
          };
        }
        const hit = resolveAccountSelector(sel);
        if (!hit.ok) return { handled: true, output: hit.error };
        setAccountLabel(hit.account.id, label);
        return { handled: true, output: `Renamed ${hit.account.id} → ${label}` };
      }
      if (v === "priority" || v === "prio") {
        const sel = rest[0];
        const n = Number.parseInt(rest[1] || "", 10);
        if (!sel || !Number.isFinite(n)) {
          return {
            handled: true,
            output: "Usage: /accounts priority <id|label> <n>",
          };
        }
        const hit = resolveAccountSelector(sel);
        if (!hit.ok) return { handled: true, output: hit.error };
        setAccountPriority(hit.account.id, n);
        return {
          handled: true,
          output: `Priority ${hit.account.id} → ${n}`,
        };
      }
      if (v === "disable" || v === "enable") {
        const sel = rest.join(" ").trim();
        if (!sel) {
          return { handled: true, output: `Usage: /accounts ${v} <id|label>` };
        }
        const hit = resolveAccountSelector(sel);
        if (!hit.ok) return { handled: true, output: hit.error };
        setAccountDisabled(hit.account.id, v === "disable");
        return {
          handled: true,
          output: `${v === "disable" ? "Disabled" : "Enabled"} ${hit.account.id}`,
        };
      }
      if (
        v === "clear-cooldown" ||
        v === "clearcooldown" ||
        v === "cooldown-clear"
      ) {
        const sel = rest.join(" ").trim() || undefined;
        const r = clearAccountCooldown(sel);
        return {
          handled: true,
          output:
            r.cleared === 0
              ? sel
                ? `No cooldown on "${sel}"`
                : "No accounts in cooldown"
              : `Cleared cooldown on ${r.cleared} account(s)`,
        };
      }
      if (v === "auto-switch" || v === "autoswitch") {
        const mode = (rest[0] || "status").toLowerCase();
        if (mode === "on" || mode === "off") {
          setAutoSwitchSettings({ autoSwitch: mode === "on" });
        }
        const thrIdx = rest.findIndex((x) => x === "--threshold" || x === "threshold");
        if (thrIdx >= 0 && rest[thrIdx + 1]) {
          const t = Number(rest[thrIdx + 1]);
          if (Number.isFinite(t)) {
            setAutoSwitchSettings({ switchThresholdPercent: t });
          }
        }
        const s = getAutoSwitchSettings();
        return {
          handled: true,
          output: `Auto-switch: ${s.autoSwitch ? "on" : "off"}  threshold: ${s.switchThresholdPercent}%`,
        };
      }
      // Bare selector → try switch
      const hit = resolveAccountSelector(raw);
      if (hit.ok) {
        const r = switchAccount(String(hit.account.provider), {
          toId: hit.account.id,
          reason: "slash",
        });
        const authUpdated =
          r.switched && r.account ? applyAuthHotSwap(r.account) : false;
        return {
          handled: true,
          authUpdated,
          output: r.switched
            ? `Active ${hit.account.provider} → ${r.toLabel || r.toId}`
            : r.reason || "switch failed",
        };
      }
      return {
        handled: true,
        output:
          formatAccountsTable() +
          "\n\nUsage: /accounts [list|status|switch|remove|rename|priority|disable|enable|clear-cooldown|auto-switch]",
      };
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
      let resolved = resolveParamChoice(modelArg, choices);
      if (!resolved) {
        // Close catalog typos fail closed (grok-45 → grok-4.5) instead of
        // silently saving a broken free-form id. True free-form still allowed.
        const tip = choices.length
          ? suggestName(
              modelArg,
              choices.map((c) => c.value),
              { minLength: 3, minScore: 38, requirePrefix3: false },
            )
          : null;
        if (tip) {
          return {
            handled: true,
            output:
              `Unknown model "${modelArg}". Did you mean: ${tip}?\n` +
              chalk.dim("Tab completes catalog names · free-form ids still accepted when not a close typo."),
          };
        }
        resolved = modelArg;
      }
      opts.config.model = resolved;
      opts.session.meta.model = resolved;

      // Keep the context window in step with the model unless the user pinned
      // context_window — a stale 500k budget on a 131k/256k model overflows at
      // the provider long before auto-compact would fire.
      let windowNote = "";
      if (!opts.config.contextWindowExplicit) {
        const win = modelContextWindow(resolved);
        if (win && win !== opts.config.contextWindow) {
          opts.config.contextWindow = win;
          windowNote = ` · ctx ${formatTokens(win)}`;
        }
      }

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
        output: `Model set to ${resolved}${effortNote}${windowNote} (saved for future sessions)`,
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
        const tip = suggestName(arg, levels, {
          minLength: 2,
          minScore: 36,
          requirePrefix3: false,
        });
        return {
          handled: true,
          output:
            chalk.yellow(
              tip
                ? `Unknown effort: ${arg}. Did you mean: ${tip}?\n`
                : `Unknown effort: ${arg}\n`,
            ) + formatParamMenu("/effort", choices, current),
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
      rebuildUserTurnMarks(opts.session);
      saveSession(opts.session);
      return {
        handled: true,
        output: `Compacted ${before} → ${opts.session.messages.length} messages (structured harness summary)`,
        session: opts.session,
      };
    }

    case "/compact-and": {
      // Warp-inspired: compact then immediately continue with a follow-up prompt.
      const follow = (arg || "").trim();
      if (!follow) {
        return {
          handled: true,
          output:
            "Usage: /compact-and <follow-up prompt>\n" +
            "Compacts history (structured harness summary) then runs the follow-up in the same turn.",
          session: opts.session,
        };
      }
      const before = opts.session.messages.length;
      const ulw = loadUlwCycle(opts.session.meta.id);
      const goal = loadGoal(opts.session.meta.id);
      opts.session.messages = compactMessages(opts.session.messages, 12, {
        ulw,
        goal,
        todos: opts.session.todos,
        sessionId: opts.session.meta.id,
      });
      rebuildUserTurnMarks(opts.session);
      saveSession(opts.session);
      const preview =
        follow.length > 120 ? `${follow.slice(0, 117).trimEnd()}…` : follow;
      return {
        handled: true,
        output:
          `Compacted ${before} → ${opts.session.messages.length} messages, continuing…\n→ ${preview}`,
        forwardPrompt: follow,
        session: opts.session,
      };
    }

    case "/init": {
      // OpenCode-inspired guided AGENTS.md setup — forwards a high-signal prompt.
      const focus = (arg || "").trim();
      const prompt = buildInitAgentsPrompt(
        focus,
        opts.config.workspace || opts.session.meta.cwd || process.cwd(),
      );
      return {
        handled: true,
        output: focus
          ? `Initializing / improving AGENTS.md (focus: ${focus.slice(0, 80)})…`
          : "Initializing / improving AGENTS.md for this repository…",
        forwardPrompt: prompt,
        session: opts.session,
      };
    }

    case "/review": {
      // OpenCode-inspired code review — scoped target + high-signal prompt.
      const cwd =
        opts.session.meta.cwd || opts.config.workspace || process.cwd();
      const target = (arg || "").trim() || "uncommitted";
      // Reject obvious injection in the free-text target (prompt still quotes it).
      if (/[\0\r\n]/.test(target) || target.length > 200) {
        return {
          handled: true,
          output:
            "Invalid /review target. Use: (empty)|uncommitted|staged|<commit>|main|origin/main|<pr#|url>",
        };
      }
      // Near-misses of common scopes (uncommited/stageed) — not free-form branches/SHAs.
      if (target && !/\s/.test(target) && target.length <= 20) {
        const tip = suggestName(target.toLowerCase(), ["uncommitted", "staged"], {
          minLength: 4,
          minScore: 40,
          requirePrefix3: false,
        });
        if (tip && tip !== target.toLowerCase()) {
          return {
            handled: true,
            output:
              `Unknown /review target "${target}". Did you mean: ${tip}?\n` +
              `Use: (empty)|uncommitted|staged|<commit>|main|origin/main|<pr#|url>`,
          };
        }
      }
      const prompt = buildReviewPrompt(target, cwd);
      return {
        handled: true,
        output: `Reviewing ${target === "uncommitted" ? "uncommitted changes" : target}…`,
        forwardPrompt: prompt,
        session: opts.session,
      };
    }

    case "/rewind":
    case "/undo": {
      // Explicit invalid count fails closed (was `parseInt || 1` → silent default).
      let n = 1;
      const raw = (arg || "").trim();
      if (raw) {
        // Allow "/undo 2" or "/rewind 2 turns" style first token
        const tok = (raw.split(/\s+/)[0] || "").toLowerCase();
        if (tok === "last" || tok === "one" || tok === "once") {
          n = 1;
        } else if (tok === "all" || tok === "max" || tok === "full") {
          n = 100;
        } else if (!/^\d+$/.test(tok)) {
          const tip = suggestName(tok, ["1", "2", "3", "last", "all"], {
            minLength: 1,
            minScore: 36,
            requirePrefix3: false,
          });
          return {
            handled: true,
            output:
              (tip
                ? `Invalid ${cmd} count "${tok}". Did you mean: ${tip}?\n`
                : `Invalid ${cmd} count "${tok}".\n`) +
              `Pass a positive integer turns (e.g. ${cmd} 1, ${cmd} 3) or last|all.`,
          };
        } else {
          const parsed = parseInt(tok, 10);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
            return {
              handled: true,
              output:
                `Invalid ${cmd} count "${tok}". Pass a positive integer 1–100 ` +
                `(e.g. ${cmd} 1, ${cmd} 3).`,
            };
          }
          n = parsed;
        }
      }
const result = rewindSessionDetailed(opts.session, n);
      if (result.removed <= 0) {
        return {
          handled: true,
          output: "Nothing to rewind.",
          session: opts.session,
        };
      }
      const diskNote = result.disk ? formatRestoreResult(result.disk) : "";
      return {
        handled: true,
        output:
          `Rewound ${result.turns || n} user turn(s); removed ${result.removed} message(s).` +
          (diskNote ? `\n${diskNote}` : ""),
        session: opts.session,
      };
    }

    case "/retry":
    case "/again": {
      // Drop last user turn + re-run (optional rewritten prompt).
      // Idle-only: mutates history and starts a new agent turn via forwardPrompt.
      const prior = lastUserText(opts.session);
      if (!prior) {
        return {
          handled: true,
          output:
            "Nothing to retry — no prior user turn in this session. Send a prompt first.",
          session: opts.session,
        };
      }
      const rewritten = (arg || "").trim();
      const prompt = rewritten || prior;
      const result = rewindSessionDetailed(opts.session, 1);
      const preview =
        prompt.length > 120 ? `${prompt.slice(0, 117).trimEnd()}…` : prompt;
      const mode = rewritten ? "with rewritten prompt" : "same prompt";
      const diskNote = result.disk ? formatRestoreResult(result.disk) : "";
      return {
        handled: true,
        output:
          (result.removed > 0
            ? `Retrying last turn (${mode}; removed ${result.removed} msg(s))…\n→ ${preview}`
            : `Retrying last turn (${mode})…\n→ ${preview}`) +
          (diskNote ? `\n${diskNote}` : ""),
        forwardPrompt: prompt,
        session: opts.session,
      };
    }

    case "/export": {
      // /export [path] [--json] — files written mode 0600 (transcripts may hold secrets)
      const parts = arg ? arg.split(/\s+/).filter(Boolean) : [];
      const asJson = parts.some((p) => p === "--json" || p === "-j" || p === "json");
      const pathArg = parts.find((p) => !p.startsWith("-") && p !== "json");
      const body = asJson
        ? exportSessionJson(opts.session)
        : exportSessionMarkdown(opts.session);
      if (pathArg) {
        const p = path.resolve(pathArg);
        try {
          if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
            const hint = path.join(
              p,
              `session-${opts.session.meta.id.slice(0, 8)}.${asJson ? "json" : "md"}`,
            );
            return {
              handled: true,
              output:
                `Export path is a directory: ${p}\n` +
                `  Pass a file path, e.g. ${hint}`,
            };
          }
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, body, { encoding: "utf8", mode: 0o600 });
          try {
            fs.chmodSync(p, 0o600);
          } catch {
            /* windows */
          }
          return {
            handled: true,
            output: `Exported ${asJson ? "JSON" : "markdown"} to ${p} (mode 0600)`,
          };
        } catch (err) {
          return {
            handled: true,
            output: `Export write failed: ${(err as Error).message || String(err)}`,
          };
        }
      }
      return { handled: true, output: body };
    }

    case "/fork": {
      const title = arg || undefined;
      const srcId = opts.session.meta.id;
      const forked = forkSession(opts.session, title ? { title } : undefined);
      const peek = formatResumePeek(forked);
      const peekBlock = peek
        ? `\n\n${peek}\n${chalk.dim("(/last 3 for more · /retry to re-run)")}`
        : "";
      // Surface harness inheritance so experts know ULW/goal survived the branch.
      const harnessBits: string[] = [];
      try {
        const ulw = loadUlwCycle(forked.meta.id);
        if (ulw?.enabled) {
          harnessBits.push(`ULW ${formatUlwCounts(ulw)}`);
        }
      } catch {
        /* */
      }
      try {
        const g = loadGoal(forked.meta.id);
        if (g?.objective && g.status === "active" && !g.paused) {
          harnessBits.push(`goal active`);
        } else if (g?.objective && g.paused) {
          harnessBits.push(`goal paused`);
        }
      } catch {
        /* */
      }
      const harnessNote = harnessBits.length
        ? `\n  Harness copied: ${harnessBits.join(" · ")}`
        : "";
      return {
        handled: true,
        output:
          `Forked session → ${forked.meta.id}\n` +
          `  msgs=${forked.messages.length} todos=${forked.todos.length}\n` +
          `  Continuing in the fork. Original ${srcId.slice(0, 8)} unchanged.\n` +
          `  Resume original later: /resume ${srcId.slice(0, 8)}` +
          harnessNote +
          peekBlock,
        replaceSession: forked,
      };
    }

    case "/fork-and-compact": {
      // Warp-inspired: branch session, compact the fork, optional follow-up prompt.
      // Keeps the original history intact for later /resume.
      const follow = (arg || "").trim();
      const titleHint = follow
        ? `fork+compact: ${follow}`.slice(0, MAX_SESSION_TITLE_CHARS)
        : "fork+compact";
      const forked = forkSession(opts.session, { title: titleHint });
      const before = forked.messages.length;
      const ulw = loadUlwCycle(forked.meta.id);
      const goal = loadGoal(forked.meta.id);
      forked.messages = compactMessages(forked.messages, 12, {
        ulw,
        goal,
        todos: forked.todos,
        sessionId: forked.meta.id,
      });
      rebuildUserTurnMarks(forked);
      saveSession(forked);
      const harnessBits: string[] = [];
      if (ulw?.enabled) harnessBits.push(`ULW ${formatUlwCounts(ulw)}`);
      if (goal?.objective && goal.status === "active" && !goal.paused) {
        harnessBits.push("goal active");
      }
      const harnessNote = harnessBits.length
        ? `\n  Harness copied: ${harnessBits.join(" · ")}`
        : "";
      const base =
        `Forked → ${forked.meta.id.slice(0, 8)} then compacted ${before} → ${forked.messages.length} msgs.\n` +
        `  Original ${opts.session.meta.id.slice(0, 8)} unchanged (full history).\n` +
        `  Resume original: /resume ${opts.session.meta.id.slice(0, 8)}` +
        harnessNote;
      if (!follow) {
        return {
          handled: true,
          output:
            base +
            chalk.dim(
              "\n  Tip: /fork-and-compact <prompt> to continue immediately in the fork.",
            ),
          replaceSession: forked,
        };
      }
      const preview =
        follow.length > 120 ? `${follow.slice(0, 117).trimEnd()}…` : follow;
      return {
        handled: true,
        output: `${base}\n  Continuing in fork…\n→ ${preview}`,
        replaceSession: forked,
        forwardPrompt: follow,
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
      if (raw.length > MAX_SESSION_TITLE_CHARS) {
        return {
          handled: true,
          output:
            `Invalid /title (length ${raw.length}). Pass at most ${MAX_SESSION_TITLE_CHARS} characters.`,
        };
      }
      const t = setSessionTitle(opts.session, raw);
      return {
        handled: true,
        output: `Title set: ${t}`,
        session: opts.session,
      };
    }

    case "/pin": {
      // /pin · /pin on  → pin
      // /pin off|clear  → unpin
      // /pin status     → show
      // /pin toggle     → flip
      const raw = (arg || "").trim().toLowerCase();
      if (raw === "status" || raw === "show") {
        return {
          handled: true,
          output: opts.session.meta.pinned
            ? "Pinned — prune will keep this session. /unpin to allow cleanup."
            : "Not pinned. /pin to protect from prune.",
          session: opts.session,
        };
      }
      if (["off", "0", "false", "no", "clear", "unpin"].includes(raw)) {
        setSessionPinned(opts.session, false);
        return {
          handled: true,
          output: "Unpinned — prune may delete this session when old.",
          session: opts.session,
        };
      }
      if (raw === "toggle") {
        const next = !opts.session.meta.pinned;
        setSessionPinned(opts.session, next);
        return {
          handled: true,
          output: next
            ? "Pinned — protected from prune."
            : "Unpinned — prune may delete when old.",
          session: opts.session,
        };
      }
      // Unknown single-token args: suggest instead of silently pinning.
      if (raw && !["on", "1", "true", "yes", "pin"].includes(raw)) {
        const tip = suggestName(raw, [
          "on",
          "off",
          "status",
          "toggle",
          "clear",
          "unpin",
        ], { minLength: 2, minScore: 36, requirePrefix3: false });
        return {
          handled: true,
          output:
            (tip
              ? `Unknown /pin arg "${raw}". Did you mean: ${tip}?\n`
              : `Unknown /pin arg "${raw}".\n`) +
            `Usage: /pin [on|off|status|toggle]`,
          session: opts.session,
        };
      }
      // bare /pin or /pin on → pin
      setSessionPinned(opts.session, true);
      return {
        handled: true,
        output: "Pinned — this session is protected from prune. /unpin to reverse.",
        session: opts.session,
      };
    }

    case "/unpin": {
      setSessionPinned(opts.session, false);
      return {
        handled: true,
        output: "Unpinned — prune may delete this session when old.",
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
      {
        const tip = suggestName(raw, [
          "on",
          "off",
          "test",
          "status",
          "ring",
          "enable",
          "disable",
        ], { minLength: 2, minScore: 36, requirePrefix3: false });
        return {
          handled: true,
          output:
            (tip
              ? `Unknown /bell arg "${raw}". Did you mean: ${tip}?\n`
              : `Unknown /bell arg "${raw}".\n`) +
            `Usage: /bell [on|off|test|status]`,
        };
      }
    }

    case "/logs": {
      // Warp-inspired safety log tail — live-safe, no secrets by design.
      // Unknown tokens fail closed (parity with forge logs -n invalid).
      const parts = (arg || "").trim().split(/\s+/).filter(Boolean);
      let limit = 30;
      let wantPath = false;
      for (const p of parts) {
        if (p === "path" || p === "--path" || p === "-p") {
          wantPath = true;
          continue;
        }
        {
          const parsed = parseLogsLines(p);
          if (parsed.ok) {
            limit = parsed.lines;
            continue;
          }
        }
        {
          const tip = suggestName(p.toLowerCase(), [
            "path",
            "0",
            "all",
            "max",
            "full",
            "30",
            "50",
            "100",
          ], { minLength: 2, minScore: 36, requirePrefix3: false });
          return {
            handled: true,
            output:
              (tip
                ? `Invalid /logs arg "${p}". Did you mean: ${tip}?\n`
                : `Invalid /logs arg "${p}".\n`) +
              `Use: /logs [N|0|all|max|full] [path] (${logsLinesHelp()}).\n` +
              chalk.dim("CLI: forge logs [-n N|all|max] [--path] [--json]"),
          };
        }
      }
      if (wantPath) {
        return {
          handled: true,
          output: sandboxLogPath(),
        };
      }
      return {
        handled: true,
        output: formatSandboxLogTail(limit),
      };
    }

    case "/config": {
      // Live-safe effective config snapshot (no secrets — never dumps API keys).
      const wantJson =
        /\b(json|--json|-j)\b/i.test(arg || "") ||
        (arg || "").trim().toLowerCase() === "json";
      return {
        handled: true,
        output: formatEffectiveConfig(opts.config, {
          json: wantJson,
          session: opts.session,
        }),
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

    case "/last": {
      // /last · /last 3 · /last 5 400  (turns, optional max chars per bubble)
      // Non-numeric args fail closed (was silently defaulting to 1 turn).
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      let turns = 1;
      let maxChars = 320;
      if (parts[0]) {
        const tok = parts[0].toLowerCase();
        if (tok === "last" || tok === "one" || tok === "once") {
          turns = 1;
        } else if (tok === "all" || tok === "max" || tok === "full") {
          turns = 20;
        } else if (!/^\d+$/.test(parts[0])) {
          const tip = suggestName(tok, ["1", "2", "3", "last", "all"], {
            minLength: 1,
            minScore: 36,
            requirePrefix3: false,
          });
          return {
            handled: true,
            output:
              (tip
                ? `Invalid /last count "${parts[0]}". Did you mean: ${tip}?\n`
                : `Invalid /last count "${parts[0]}".\n`) +
              `Pass a positive integer turns (e.g. /last 3) and optional max chars (/last 3 400).`,
          };
        } else {
          const n = parseInt(parts[0], 10);
          if (n < 1 || n > 20) {
            return {
              handled: true,
              output: `Invalid /last count "${parts[0]}". Pass a positive integer (1–20).`,
            };
          }
          turns = n;
        }
      }
if (parts[1]) {
        if (!/^\d+$/.test(parts[1])) {
          return {
            handled: true,
            output:
              `Invalid /last max-chars "${parts[1]}". Pass a positive integer ` +
              `(e.g. /last 3 400).`,
          };
        }
        const mc = parseInt(parts[1], 10);
        if (!Number.isFinite(mc) || mc < 40 || mc > 2000) {
          return {
            handled: true,
            output:
              `Invalid /last max-chars "${parts[1]}". Pass an integer 40–2000 ` +
              `(e.g. /last 3 400).`,
          };
        }
        maxChars = mc;
      }
      if (parts.length > 2) {
        return {
          handled: true,
          output: `Invalid /last args. Usage: /last [turns] [maxChars]`,
        };
      }
      return {
        handled: true,
        output: formatRecentTurns(opts.session, { turns, maxChars }),
      };
    }

    case "/files": {
      // /files · /files writes · /files 20 · /files mutations 30
      // Unknown tokens / non-positive counts fail closed (were silently ignored).
      const parts = arg.trim().toLowerCase().split(/\s+/).filter(Boolean);
      let mutatedOnly = false;
      let limit = 40;
      for (const p of parts) {
        if (
          p === "writes" ||
          p === "write" ||
          p === "mutations" ||
          p === "mutated" ||
          p === "edits" ||
          p === "m"
        ) {
          mutatedOnly = true;
          continue;
        }
        if (p === "all" || p === "any" || p === "reads") {
          mutatedOnly = false;
          continue;
        }
        if (/^\d+$/.test(p)) {
          const n = parseInt(p, 10);
          if (n < 1 || n > 200) {
            return {
              handled: true,
              output:
                `Invalid /files limit "${p}". Pass a positive integer (1–200), ` +
                `or use writes|mutations|all.`,
            };
          }
          limit = n;
          continue;
        }
        {
          const tip = suggestName(p, [
            "writes",
            "mutations",
            "mutated",
            "edits",
            "all",
            "reads",
            "20",
            "40",
          ], { minLength: 2, minScore: 36, requirePrefix3: false });
          return {
            handled: true,
            output:
              (tip
                ? `Invalid /files arg "${p}". Did you mean: ${tip}?\n`
                : `Invalid /files arg "${p}".\n`) +
              `Use: /files [writes|mutations|all] [N] (N=1..200).`,
          };
        }
      }
      return {
        handled: true,
        output: formatSessionTouchedFiles(opts.session, { limit, mutatedOnly }),
      };
    }

    case "/path": {
      // /path · /path json · /path copy · /path <id|title>
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      const wantJson = parts.some(
        (p) => p === "json" || p === "--json" || p === "-j",
      );
      const wantCopy = parts.some(
        (p) => p === "copy" || p === "--copy" || p === "-c" || p === "clip",
      );
      const target = parts.find(
        (p) =>
          !["json", "--json", "-j", "copy", "--copy", "-c", "clip"].includes(p),
      );
      let dir: string;
      let jsonPath: string;
      if (!target) {
        dir = sessionDir(opts.session.meta.id);
        jsonPath = path.join(dir, "session.json");
      } else {
        const resolved = resolveSessionDir(target);
        if (!resolved) {
          return {
            handled: true,
            output: formatSessionLookupMiss(target, {
              cwd: opts.session.meta.cwd || opts.config.workspace,
            }),
          };
        }
        dir = resolved;
        jsonPath =
          resolveSessionJsonPath(target) || path.join(dir, "session.json");
      }
      const primary = wantJson ? jsonPath : dir;
      if (wantCopy) {
        const clip = copyToClipboard(primary);
        const body = wantJson
          ? primary
          : `Session dir:  ${dir}\n` +
            `session.json: ${jsonPath}\n` +
            chalk.dim(`CLI: forge sessions path ${target || opts.session.meta.id.slice(0, 8)}`);
        return {
          handled: true,
          output:
            body +
            (clip.ok
              ? chalk.dim(`\n✓ Copied ${wantJson ? "session.json" : "dir"} path via ${clip.backend}`)
              : chalk.dim(`\nClipboard unavailable (${clip.error || "no backend"})`)),
        };
      }
      return {
        handled: true,
        output: wantJson
          ? primary
          : `Session dir:  ${dir}\n` +
            `session.json: ${jsonPath}\n` +
            chalk.dim(
              `CLI: forge sessions path ${target || opts.session.meta.id.slice(0, 8)}  ·  /path copy`,
            ),
      };
    }

    case "/share": {
      // /share · /share nocopy · /share --no-clip
      const noClip = /\b(nocopy|no-?clip|--no-clip|--print-only)\b/i.test(arg);
      const card = formatSessionShareCard(opts.session);
      if (noClip) {
        return { handled: true, output: card };
      }
      const result = copyToClipboard(card);
      if (result.ok) {
        return {
          handled: true,
          output:
            card +
            chalk.dim(
              `\n\n✓ Copied share card (${card.length} chars via ${result.backend}).`,
            ),
        };
      }
      return {
        handled: true,
        output:
          card +
          chalk.dim(
            `\n\nClipboard unavailable (${result.error || "no backend"}). Card printed above.`,
          ),
      };
    }

    case "/tips": {
      return {
        handled: true,
        output: formatExpertTips(),
      };
    }

            case "/news":
    case "/changelog": {
      // /news · /news 2 · /news all|full|max|latest — parity with forge news.
      const nRaw = (arg.trim().split(/\s+/)[0] || "").replace(/^--count=/, "");
      let n = 1;
      if (nRaw) {
        const parsed = parseNewsCount(nRaw);
        if (!parsed.ok) {
          {
          const tip = suggestName(nRaw.toLowerCase(), [
            "1",
            "2",
            "all",
            "full",
            "max",
            "latest",
          ], { minLength: 2, minScore: 36, requirePrefix3: false });
          return {
            handled: true,
            output:
              (tip
                ? `Invalid /news count "${nRaw}". Did you mean: ${tip}?\n`
                : `Invalid /news count "${nRaw}".\n`) +
              `Pass a ${newsCountHelp()} (e.g. /news 2, /news all) or omit for the latest release.\n` +
              chalk.dim("CLI: forge news [count|all|full|max|latest] [--json]"),
          };
        }
        }
        n = parsed.count;
      }
      return {
        handled: true,
        output: formatWhatsNew({ count: n }),
      };
    }

case "/new":
    case "/clear": {
      if (cmd === "/clear" && arg !== "hard") {
        clearConversation(opts.session);
        return {
          handled: true,
          output:
            "Conversation cleared (same session id; counters + undo journal reset).\n" +
            chalk.dim("  ULW/goal sidecars kept but stuck baselines zeroed. /new for a fresh session id."),
          session: opts.session,
        };
      }
      // /new [title] or /clear hard — brand-new session id.
      // Do NOT inherit ultrawork flag without ulw.json (inconsistent Stop backstop).
      // Re-arm with /ulw or /goal if the driver is still wanted.
      const titleArg =
        cmd === "/new" && arg.trim() && arg.trim().toLowerCase() !== "hard"
          ? arg.trim()
          : undefined;
      const s = createSession({
        cwd: opts.session.meta.cwd,
        provider: opts.config.provider,
        model: opts.config.model,
        ultrawork: false,
        title: titleArg,
      });
      const titleNote = s.meta.title ? ` — ${s.meta.title}` : "";
      const wasUlw =
        opts.session.meta.ultrawork ||
        Boolean(loadUlwCycle(opts.session.meta.id)?.enabled);
      return {
        handled: true,
        output:
          `New session ${s.meta.id.slice(0, 8)}${titleNote}` +
          (wasUlw
            ? chalk.dim(
                "\n  ULW/goal not carried over — re-arm with /ulw or /goal if needed.",
              )
            : ""),
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
                ? "No sessions. Usage: /resume <id-prefix|title>"
                : `No sessions for this workspace. Try: /resume all`
              : `Usage: /resume <id-prefix|title>  ·  ${scope}\n\nRecent:\n${list
                  .map((s) => {
                    const lock = readSessionLock(s.id);
                    const lockNote =
                lock && sessionHasForeignLiveLock(s.id)
                  ? `  LOCK pid ${lock.pid}`
                  : "";
                    const cwdNote =
                      showAll && s.cwd ? `  ${path.basename(s.cwd)}` : "";
                    const age = formatRelativeTime(s.updatedAt).padStart(8);
                    const prev = (s.lastUserPreview || "").slice(0, 28);
                    const prevNote = prev
                      ? `  “${prev}${(s.lastUserPreview || "").length > 28 ? "…" : ""}”`
                      : "";
                    return `  ${s.id.slice(0, 8)}  ${age}  ${(s.title || "").slice(0, 28).padEnd(28)}  ${s.model}${prevNote}${lockNote}${cwdNote}`;
                  })
                  .join("\n")}${showAll ? "" : chalk.dim("\n\n/resume all — every workspace · /resume <title>")}`,
        };
      }
      const loaded = loadSession(arg);
      if (!loaded) {
        const ws = opts.session.meta.cwd || opts.config.workspace || process.cwd();
        return {
          handled: true,
          output: formatSessionLookupMiss(arg, { cwd: ws }),
        };
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
      const orient = formatResumeOrientation(loaded);
      const pinNote = loaded.meta.pinned ? " · PIN" : "";
      const peekBlock = orient
        ? `\n\n${orient}\n${chalk.dim("(/last 3 · /files · /retry to re-run)")}`
        : "";
      return {
        handled: true,
        output: `Resumed ${loaded.meta.id.slice(0, 8)} — ${loaded.meta.title || "untitled"} (${loaded.messages.length} msgs)${pinNote}${lockWarn}${peekBlock}`,
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
          output: formatSessionLookupMiss(target, {
            cwd: opts.session.meta.cwd || opts.config.workspace,
          }),
        };
      }
      if (sub === "prune") {
        // Accept --keep=N or --keep N (0 is valid — keep none except active/pinned/locked)
        let keepRaw: string | undefined;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i]!;
          if (p.startsWith("--keep=")) {
            keepRaw = p.slice("--keep=".length);
            break;
          }
          if (p === "--keep" && parts[i + 1] != null) {
            keepRaw = parts[i + 1];
            break;
          }
        }
        let keep = 50;
        if (keepRaw != null) {
          const parsed = parseCliNonNegInt(keepRaw);
          if (parsed === null) {
            return {
              handled: true,
              output:
                `Invalid --keep "${keepRaw}". Pass a non-negative integer (0 is allowed).`,
            };
          }
          keep = parsed ?? 50;
        }
        const result = pruneSessions({
          keep,
          protectIds: [opts.session.meta.id],
        });
        const lockNote = result.skippedLocked
          ? `; skipped ${result.skippedLocked} foreign-locked`
          : "";
        const pinNote = result.skippedPinned
          ? `; skipped ${result.skippedPinned} pinned`
          : "";
        return {
          handled: true,
          output: `Pruned ${result.deleted.length} session(s); kept ${result.kept} (active protected${lockNote}${pinNote}). CLI: forge sessions prune --keep ${keep}`,
        };
      }
      // Default: same-cwd sessions (multi-project experts). /sessions all|global for everything.
      // /sessions q <text> or /sessions search <text> filters by id/title substring.
      // /sessions pinned — only pin-protected sessions.
      const ws = opts.session.meta.cwd || opts.config.workspace || process.cwd();
      let listMode: "cwd" | "all" = "cwd";
      let query: string | undefined;
      let pinnedOnly = false;
      if (sub === "all" || sub === "global" || sub === "-a") {
        listMode = "all";
      } else if (sub === "pinned" || sub === "pins" || sub === "pin") {
        pinnedOnly = true;
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
        // Close typos of known actions fail closed (prun→prune, serach→search)
        // even with extra tokens — never treat "serach x" as a title query.
        const tip = suggestSessionAction(sub);
        if (tip) {
          return {
            handled: true,
            output:
              `Unknown /sessions action "${sub}". Did you mean: ${tip}?\n` +
              chalk.dim(
                "Actions: list · search · prune · delete · pinned · all  ·  CLI: forge sessions <action>",
              ),
          };
        }
        // bare query token: /sessions incident
        query = parts.join(" ").trim() || undefined;
        listMode = "all";
      }
      const list = listSessions({
        limit: 15,
        ...(listMode === "cwd" && !query && !pinnedOnly ? { cwd: ws } : {}),
        ...(query ? { query } : {}),
        ...(pinnedOnly ? { pinned: true } : {}),
      });
      if (!list.length) {
        if (pinnedOnly) {
          return {
            handled: true,
            output: "No pinned sessions. /pin on a session to protect it from prune.",
          };
        }
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
      const scopeNote = pinnedOnly
        ? "pinned only"
        : query
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
              const lockNote =
                lock && sessionHasForeignLiveLock(s.id)
                  ? `  LOCK pid ${lock.pid}`
                  : "";
              const active =
                s.id === opts.session.meta.id ||
                opts.session.meta.id.startsWith(s.id.slice(0, 8))
                  ? " *"
                  : "";
              const cwdNote =
                listMode === "all" && s.cwd
                  ? `  ${path.basename(s.cwd)}`
                  : "";
              const prev = (s.lastUserPreview || "").slice(0, 32);
              const prevNote = prev
                ? `  “${prev}${(s.lastUserPreview || "").length > 32 ? "…" : ""}”`
                : "";
              const age = formatRelativeTime(s.updatedAt).padStart(8);
              return `${s.id.slice(0, 8)}  ${age}  ${(s.title || "").slice(0, 28).padEnd(28)}  ${s.model}  t=${s.turnCount}${s.ultrawork ? " ULW" : ""}${s.pinned ? " PIN" : ""}${s.permissionMode === "plan" ? " PLAN" : ""}${active}${lockNote}${cwdNote}${prevNote}`;
            })
            .join("\n") +
          chalk.dim(
            `\n\n* = active  ·  ${scopeNote}  ·  /sessions [all|pinned|search <q>]  ·  delete <id|title> [--force]  ·  prune [--keep=50]  ·  /resume <id|title>  ·  /pin\nCLI: forge sessions list --cwd . [--pinned]  ·  show|export|import|fork|pin|delete <id|title>`,
          ),
      };
    }

    case "/plan": {
      // OpenCode-style: session-scoped plan mode (no sticky prefs footgun).
      const note = arg.trim();
      const { changed, previous } = enterSessionPlanMode(opts.config, opts.session);
      saveSession(opts.session);
      const sid = opts.session.meta.id;
      pushLiveNotice(
        sid,
        [
          "User entered PLAN MODE (session-scoped).",
          "Mutations (writes/bash/apply_patch/kill_task) are hard-denied.",
          "Research and produce a concrete plan: goal, steps, files, risks, verification.",
          "Do not implement until the user runs /build.",
          note ? `Plan focus: ${note}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      const lines = [
        chalk.blue("PLAN MODE") +
          chalk.dim(
            changed
              ? ` (was ${previous}; session-only — sticky prefs untouched)`
              : " (already in plan)",
          ),
        chalk.dim("  Reads/search/todo_write allowed · writes/bash denied"),
        chalk.dim("  Exit with /build (restores prior mode) · or /permissions <mode>"),
      ];
      if (note) lines.push(chalk.dim(`  Focus: ${note}`));
      return {
        handled: true,
        output: lines.join("\n"),
        session: opts.session,
      };
    }

    case "/build":
    case "/execute": {
      // Leave plan → restore prior session mode (OpenCode build-switch).
      const note = arg.trim();
      const { mode, wasPlan } = exitSessionPlanMode(opts.config, opts.session);
      saveSession(opts.session);
      const sid = opts.session.meta.id;
      if (wasPlan) {
        pushLiveNotice(
          sid,
          [
            `User left PLAN MODE → ${mode} (BUILD).`,
            "Implement the agreed plan now. Mutations are allowed under the restored permission mode.",
            "Do not re-plan from scratch unless the user asks — execute, verify, report.",
            note ? `Build note: ${note}` : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
      const lines = [
        chalk.green("BUILD MODE") +
          chalk.dim(
            wasPlan
              ? ` (left plan → ${mode}; session-scoped)`
              : ` (already building · permissionMode=${mode})`,
          ),
        chalk.dim(
          wasPlan
            ? "  Prior plan mode exited · implement the agreed plan"
            : "  Tip: /plan for read-only design first",
        ),
      ];
      if (note) lines.push(chalk.dim(`  Note: ${note}`));
      return {
        handled: true,
        output: lines.join("\n"),
        session: opts.session,
      };
    }

    case "/permissions": {
      const choices = COMMAND_PARAMS.permissions;
      const modeChoices = choices.filter((c) =>
        ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"].includes(c.value),
      );
      const sub = arg.trim();
      const verb = (sub.split(/\s+/)[0] || "").toLowerCase();
      // OpenCode aliases: /permissions plan|build
      if (verb === "plan") {
        return await handleSlash("/plan " + sub.slice(verb.length).trim(), opts);
      }
      if (verb === "build" || verb === "execute" || verb === "implement") {
        return await handleSlash("/build " + sub.slice(verb.length).trim(), opts);
      }
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
        const sessionNote =
          opts.session.meta.permissionMode === "plan"
            ? chalk.blue("\nSession: PLAN (use /build to leave — sticky prefs untouched)")
            : opts.session.meta.permissionMode
              ? chalk.dim(`\nSession override: ${opts.session.meta.permissionMode}`)
              : "";
        return {
          handled: true,
          output:
            formatParamMenu(
              "/permissions",
              modeChoices,
              opts.config.permissionMode,
            ) +
            chalk.dim(
              "\nAlso: /plan · /build  ·  /permissions list | clear | revoke <id>",
            ) +
            sessionNote,
        };
      }
      // Resolve against full choices so Tab numbers for list/clear still work,
      // but never assign management verbs as permissionMode.
      const resolved = resolveParamChoice(arg, choices);
      if (!resolved) {
        const tip = suggestName(
          arg,
          [
            ...modeChoices.map((c) => c.value),
            "build",
            "list",
            "clear",
            "revoke",
          ],
          { minLength: 3, minScore: 36, requirePrefix3: false },
        );
        return {
          handled: true,
          output:
            chalk.yellow(
              tip
                ? `Unknown mode: ${arg}. Did you mean: ${tip}?\n`
                : `Unknown mode: ${arg}\n`,
            ) +
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
      if (
        resolved === "build" ||
        resolved === "execute" ||
        resolved === "implement"
      ) {
        return await handleSlash("/build", opts);
      }
      // Sticky preference path (explicit /permissions <mode>).
      // Session plan bookkeeping is cleared unless entering sticky plan.
      if (resolved === "plan") {
        enterSessionPlanMode(opts.config, opts.session);
        // Sticky plan: prefs + session (experts who want plan on every resume).
      } else {
        opts.config.permissionMode = resolved as ForgeConfig["permissionMode"];
        // Leave any session-scoped plan; sticky prefs own non-plan modes.
        delete opts.session.meta.permissionMode;
        delete opts.session.meta.permissionModeBeforePlan;
      }
      saveSession(opts.session);
      try {
        savePreferences({
          permissionMode: resolved as ForgeConfig["permissionMode"],
        });
      } catch {
        /* never fail slash on prefs I/O */
      }
      const stickyNote =
        resolved === "plan"
          ? " (sticky prefs + session — prefer /plan for session-only)"
          : " (saved for future sessions)";
      return {
        handled: true,
        output: `Permission mode: ${resolved}${resolved === "bypassPermissions" ? " (always approve)" : ""}${stickyNote}`,
        session: opts.session,
      };
    }

    case "/doctor": {
      return { handled: true, output: await runDoctor(opts.config) };
    }

    default:
      return {
        handled: true,
        output: formatUnknownSlash(cmd),
      };
  }
}

const MAX_GOAL_CHARS = 4000;

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
      if (restText.length > MAX_GOAL_CHARS) {
        return {
          handled: true,
          output: `Invalid /goal objective (length ${restText.length}). Pass at most ${MAX_GOAL_CHARS} characters.`,
        };
      }
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
      // Single-token typos of verbs should not silently arm a nonsense goal.
      const token = arg.trim();
      if (token && !/\s/.test(token) && token.length <= 16) {
        const tip = suggestName(
          token.toLowerCase(),
          [
            "status",
            "set",
            "pause",
            "resume",
            "unpause",
            "clear",
            "done",
          ],
          { minLength: 3, minScore: 40, requirePrefix3: false },
        );
        if (tip) {
          return {
            handled: true,
            output:
              `Unknown /goal verb "${token}". Did you mean: ${tip}?` +
              `\nUsage: /goal [status|set <obj>|pause|resume|clear|done]  ·  or /goal <objective>`,
          };
        }
      }
      if (arg.length > MAX_GOAL_CHARS) {
        return {
          handled: true,
          output: `Invalid /goal objective (length ${arg.length}). Pass at most ${MAX_GOAL_CHARS} characters.`,
        };
      }
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
  /** False when model is set and not in the provider catalog (free-form still ok). */
  modelInCatalog: boolean | null;
  /** Multi-account readiness (never tokens); null when assess failed. */
  multiAccount?: {
    total: number;
    eligible: number;
    cooldown: number;
    disabled: number;
    expiredNoRefresh: number;
    withRefreshToken: number;
    apiKey: number;
    autoSwitch: boolean;
    switchThresholdPercent: number;
    multiAccountReady: boolean;
    summary: string;
    warnings: string[];
  } | null;
}

/**
 * Full doctor check with structured fields for `forge doctor --json`.
 * Text report remains human-oriented (chalk); `ok`/`issues` are the CI contract.
 */
export async function runDoctorCheck(
  config: ForgeConfig,
): Promise<DoctorResult> {
  const lines: string[] = [chalk.bold("Forge doctor"), ""];
  const issues: string[] = [];
  let modelInCatalog: boolean | null = null;
  lines.push(`Version: ${getForgeVersion()}`);
  // Prefer resolveAuthFresh so SuperGrok OIDC refresh / Grok re-import is tried
  // before CI flags "not authenticated" on a short-lived access token.
  let auth = await resolveAuthFresh(config);
  if (!auth) auth = resolveAuth(config);
  lines.push(`Auth: ${describeAuth(auth)}`);
  if (auth && auth.provider !== config.provider) {
    lines.push(
      chalk.dim(
        `  Active credentials are ${auth.provider} (config default was ${config.provider}) — doctor/report use active auth provider`,
      ),
    );
  }
  if (!auth) {
    issues.push("Not authenticated — run forge login or set an API key env var");
  } else if (auth.method !== "api_key") {
    // Surface expiry for OAuth/subscription without printing tokens
    const cred = getCredential(String(auth.provider));
    if (cred && !cred.refreshToken) {
      lines.push(
        chalk.yellow(
          "  No refresh_token — SuperGrok session cannot renew; multi-day unattended needs forge login --api-key",
        ),
      );
      issues.push(
        `OAuth/subscription for ${auth.provider} has no refresh_token — re-login (forge login) or use API key for multi-day`,
      );
    }
    if (cred?.expiresAt) {
      const exp = new Date(cred.expiresAt * 1000).toISOString();
      const expiresIn = cred.expiresAt - Math.floor(Date.now() / 1000);
      if (isExpired(cred, 0)) {
        lines.push(chalk.red(`  Token EXPIRED at ${exp}`));
        if (cred.refreshToken) {
          lines.push(
            chalk.yellow(
              "  refresh_token present — will try auto-refresh on next API call",
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
            `  Token expires ${exp} (~${Math.max(0, Math.round(expiresIn / 60))}m)` +
              `${cred.refreshToken ? " · refresh_token=yes" : " · refresh_token=NO"}`,
          ),
        );
      }
    }
  }
  // Multi-account unattended readiness (advisory; only blocks when zero eligible)
  try {
    const { assessMultiAccountReadiness, formatMultiAccountReadiness } =
      await import("../auth/accounts.js");
    const ma = assessMultiAccountReadiness(
      auth ? String(auth.provider) : undefined,
    );
    lines.push(formatMultiAccountReadiness(auth ? String(auth.provider) : undefined));
    // Hard issue only when authenticated but zero eligible same-provider accounts
    // (all cooling / disabled / expired) — unattended run will die on first failure.
    if (auth && ma.total > 0 && ma.eligible === 0) {
      issues.push(
        `No eligible ${auth.provider} accounts (disabled/cooldown/expired) — forge login --add or forge accounts clear-cooldown`,
      );
    } else if (auth && ma.total >= 2 && !ma.multiAccountReady) {
      lines.push(
        chalk.yellow(
          "  ⚠ Multiple accounts stored but only one eligible — failover limited",
        ),
      );
    } else if (auth && ma.total === 1) {
      lines.push(
        chalk.dim(
          "  Tip: forge login --add for quota failover on long unattended runs",
        ),
      );
    }
  } catch {
    /* multi-account doctor is best-effort */
  }
  {
    const reportProvider = (auth?.provider || config.provider) as typeof config.provider;
    const reportModel =
      auth && auth.provider !== config.provider
        ? config.providers[auth.provider]?.defaultModel || config.model
        : config.model;
    const effort = resolveReasoningEffort(reportModel, config.reasoningEffort);
    const effortSuffix = effort ? ` · effort=${effort}` : "";
    lines.push(`Provider/model: ${reportProvider} / ${reportModel}${effortSuffix}`);
    // Soft warning when model is not in the provider catalog (free-form still allowed).
    const pcfg = config.providers?.[reportProvider];
    const catalog = [
      ...(pcfg?.models || []),
      ...(pcfg?.defaultModel ? [pcfg.defaultModel] : []),
    ];
    if (catalog.length && reportModel) {
      modelInCatalog = catalog.some(
        (m) => m.toLowerCase() === String(reportModel).toLowerCase(),
      );
      if (!modelInCatalog) {
        lines.push(
          chalk.yellow(
            `  Model "${reportModel}" not in ${reportProvider} catalog ` +
              `(default ${pcfg?.defaultModel || "—"}; free-form ids still work)`,
          ),
        );
      }
    }
  }
  lines.push(`Permission mode: ${config.permissionMode}`);
  if (config.permissionMode === "plan") {
    lines.push(
      chalk.blue(
        "  PLAN — mutations denied; /build to implement (session /plan preferred over sticky plan)",
      ),
    );
  }
  if (config.permissionMode === "bypassPermissions") {
    lines.push(
      chalk.yellow(
        "  ⚠ bypassPermissions (yolo) — all tools auto-approved; prefer acceptEdits/plan/dontAsk in CI",
      ),
    );
    issues.push(
      "Permission mode is bypassPermissions (yolo) — all tools auto-approved; set acceptEdits/plan/dontAsk for production CI",
    );
  }
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
      prefs.provider ? `provider=${prefs.provider}` : null,
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
    if ((config.sandbox || "off") === "off") {
      lines.push(
        chalk.yellow(
          "  ⚠ Sandbox is off — bash runs unsandboxed; prefer workspace/read-only/strict for production",
        ),
      );
      issues.push(
        "Sandbox is off — bash runs unsandboxed; set workspace/read-only/strict for production hosts",
      );
    }
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
    if ((config.sandboxMissingBackend || "fail-closed") === "fallback") {
      lines.push(
        chalk.yellow(
          "  ⚠ sandbox-missing=fallback — bash may run unsandboxed when backend is absent",
        ),
      );
      issues.push(
        "Sandbox missing-backend policy is fallback — bash may run unsandboxed when bwrap/sandbox-exec is absent; prefer fail-closed for production",
      );
    }
    lines.push(`Read outside workspace: ${config.readOutsideWorkspace || "ask"}`);
    if ((config.readOutsideWorkspace || "ask") === "allow") {
      lines.push(
        chalk.yellow(
          "  ⚠ read-outside=allow — tools may read absolute paths outside the workspace without prompting",
        ),
      );
      issues.push(
        "Read-outside policy is allow — tools may read absolute paths outside the workspace without prompting; prefer ask or deny for production/CI",
      );
    }
  }
  const denyN = config.permission?.deny?.length || 0;
  const allowN = config.permission?.allow?.length || 0;
  const askN = config.permission?.ask?.length || 0;
  lines.push(`Rules: deny=${denyN} allow=${allowN} ask=${askN} (deny wins under YOLO)`);
  // Surface config rules that parse to null (e.g. Bash()) — they are silently dropped at runtime.
  {
    const bad: string[] = [];
    for (const [kind, list] of [
      ["deny", config.permission?.deny],
      ["allow", config.permission?.allow],
      ["ask", config.permission?.ask],
    ] as const) {
      // Must be a string[]; a bare string would iterate characters (Bash() → "(", ")").
      if (!Array.isArray(list)) {
        if (list != null) {
          bad.push(`${kind}: <non-array ${typeof list}>`);
        }
        continue;
      }
      for (const raw of list) {
        if (!parseRuleString(String(raw))) {
          bad.push(`${kind}: ${raw}`);
        }
      }
    }
    if (bad.length) {
      const preview = bad.slice(0, 5).join("; ");
      const more = bad.length > 5 ? ` (+${bad.length - 5} more)` : "";
      issues.push(
        `Invalid permission rule(s) ignored at runtime: ${preview}${more}. Use Tool or Tool(pattern) (empty Tool() is invalid).`,
      );
    }
  }
  lines.push(`Blocking Stop: ${config.blockingStopHooks ? "on" : "off"}`);
  if (config.blockingStopHooks) {
    lines.push(
      chalk.dim(
        "  Stop/SubagentStop hook timeout/error fails closed (agent keeps working)",
      ),
    );
  } else {
    lines.push(chalk.yellow("  ⚠ Blocking Stop is OFF — harness Stop hooks cannot force continue"));
    // Non-negotiable for production harness reliability (see AGENTS.md).
    issues.push(
      "Blocking Stop is OFF — enable blockingStopHooks (default true) so Stop hooks can force continue",
    );
  }
  lines.push(`Goal gate: ${config.goal.enabled ? "on" : "off"} (stuck=${config.goal.stuckThreshold})`);
  lines.push(`Workspace: ${config.workspace || process.cwd()}`);
  lines.push(
    `Context: window=${config.contextWindow} autoCompact@${Math.round((config.autoCompactThreshold || 0.8) * 100)}% maxTurns=${config.maxTurns > 0 ? config.maxTurns : "unlimited"}`,
  );
  {
    const maxRun = maxRunMsFromEnv();
    const maxRunNote =
      maxRun != null
        ? ` · max-run=${Math.round(maxRun / 1000)}s`
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
    const bashTo = defaultBashTimeoutMs();
    const bashBg = defaultBashBackgroundTimeoutMs();
    lines.push(
      `Reliability: Retry-After · abortable streams · empty-SSE retry · JSON repair · orphan tool heal · doom-loop@${doomN} · error-streak@${errN} · ulw-continues@${ulwCap} · apply_patch · file-aware undo · overflow→compact · session lock/tmp-recover · metrics.jsonl · OAuth refresh · provider timeout=${Math.round(providerTimeoutMs() / 1000)}s · bash timeout=${Math.round(bashTo / 1000)}s (bg ${Math.round(bashBg / 1000)}s)${maxRunNote}${permNote}${bellNote}${resumeNote}`,
    );
  }

  const node = process.version;
  lines.push(`Node: ${node}`);
  const major = parseInt(node.slice(1), 10);
  if (major < 20) {
    lines.push(chalk.red("  ⚠ Node 20+ required"));
    issues.push(`Node ${node} is below 20`);
  }
  // Best-effort package.json engines.node floor (e.g. ">=20", ">=20.0.0").
  try {
    const pkgPath = path.join(config.workspace || process.cwd(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        engines?: { node?: string };
      };
      const range = pkg.engines?.node?.trim() || "";
      const m = range.match(/>=\s*(\d+)/);
      if (m) {
        const floor = parseInt(m[1]!, 10);
        if (Number.isFinite(floor) && major < floor) {
          lines.push(
            chalk.red(
              `  ⚠ package.json engines.node is "${range}" but runtime is ${node}`,
            ),
          );
          issues.push(
            `Node ${node} is below package.json engines.node floor ${floor} (${range})`,
          );
        } else if (range) {
          lines.push(`  package engines.node: ${range}`);
        }
      } else if (range) {
        lines.push(`  package engines.node: ${range}`);
      }
    }
  } catch {
    /* */
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
    let pinnedN = 0;
    for (const s of sessions) {
      if (sessionHasForeignLiveLock(s.id)) lockedN += 1;
      if (s.pinned) pinnedN += 1;
    }
    lines.push(
      `  sessions: ${sessN}` +
        (pinnedN > 0 ? chalk.dim(` · ${pinnedN} pinned`) : "") +
        (lockedN > 0
          ? chalk.dim(` · ${lockedN} foreign-locked`)
          : "") +
        (sessN > 80
          ? chalk.yellow(
              pinnedN > 0
                ? " — consider: forge sessions prune --keep 50 (pinned kept)"
                : " — consider: forge sessions prune --keep 50",
            )
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
    const mj = mutationsJournalStats();
    if (mj.sessions > 0) {
      const kb = (mj.bytes / 1024).toFixed(1);
      lines.push(
        `  undo-journal: ${mj.sessions} session(s) · ~${mj.entries} entries · ${kb} KB` +
          chalk.dim("  (mutations.jsonl · /undo restores disk)"),
      );
      // Advisory only — large journals slow /undo scans and fill disk.
      // Thresholds: ~20 MiB or 2k entries across sessions.
      const LARGE_BYTES = 20 * 1024 * 1024;
      const LARGE_ENTRIES = 2_000;
      if (mj.bytes >= LARGE_BYTES || mj.entries >= LARGE_ENTRIES) {
        issues.push(
          `Undo journal is large (~${kb} KB, ${mj.entries} entries across ${mj.sessions} session(s)) — prune old sessions (forge sessions prune) or delete stale mutations.jsonl under ~/.forge/sessions/*/`,
        );
      }
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

  let multiAccount: DoctorResult["multiAccount"] = null;
  try {
    const { assessMultiAccountReadiness } = await import("../auth/accounts.js");
    const ma = assessMultiAccountReadiness(
      auth ? String(auth.provider) : undefined,
    );
    multiAccount = {
      total: ma.total,
      eligible: ma.eligible,
      cooldown: ma.cooldown,
      disabled: ma.disabled,
      expiredNoRefresh: ma.expiredNoRefresh,
      withRefreshToken: ma.withRefreshToken,
      apiKey: ma.apiKey,
      autoSwitch: ma.autoSwitch,
      switchThresholdPercent: ma.switchThresholdPercent,
      multiAccountReady: ma.multiAccountReady,
      summary: ma.summary,
      warnings: ma.warnings,
    };
  } catch {
    multiAccount = null;
  }

  return {
    report: lines.join("\n"),
    issues: [...issues],
    ok: issues.length === 0,
    authenticated: Boolean(auth),
    blockingStop: config.blockingStopHooks !== false,
    modelInCatalog,
    multiAccount,
  };
}

/** Human-readable doctor report (slash `/doctor` and plain `forge doctor`). */
export async function runDoctor(config: ForgeConfig): Promise<string> {
  return (await runDoctorCheck(config)).report;
}

export interface EffectiveConfigSnap {
  version: string;
  /** Absolute FORGE_HOME (sessions/auth root). */
  forgeHome: string;
  provider: string;
  model: string;
  reasoningEffort: string | null;
  permissionMode: string;
  sandbox: string;
  sandboxNetwork: string;
  sandboxMissingBackend: string;
  readOutsideWorkspace: string;
  stickyProvider: string | null;
  blockingStopHooks: boolean;
  promptProfile: string;
  contextWindow: number;
  autoCompactThreshold: number;
  maxTurns: number;
  /** True when maxTurns <= 0 (unlimited agent turns). */
  maxTurnsUnlimited: boolean;
  workspace: string;
  baseUrl: string | null;
  goalEnabled: boolean;
  goalStuckThreshold: number | null;
  rules: { deny: number; allow: number; ask: number };
  session: {
    id: string | null;
    title: string | null;
    ultrawork: boolean;
    pinned: boolean;
    turns: number;
    edits: number;
  } | null;
  env: {
    FORGE_HOME: string;
    FORGE_BASH_TIMEOUT_MS: number;
    FORGE_BASH_BG_TIMEOUT_MS: number;
    FORGE_PROVIDER_TIMEOUT_MS: number;
    FORGE_DOOM_LOOP_THRESHOLD: number;
    FORGE_ERROR_STREAK_THRESHOLD: number;
  };
}

/** Build effective config snapshot (never includes secrets). */
export function buildEffectiveConfigSnap(
  config: ForgeConfig,
  opts?: { session?: SessionData | null },
): EffectiveConfigSnap {
  const c = config;
  const net = resolveSandboxNetwork(c);
  const session = opts?.session;
  return {
    version: getForgeVersion(),
    forgeHome: forgeHome(),
    provider: c.provider,
    model: c.model,
    reasoningEffort: c.reasoningEffort ?? null,
    permissionMode: c.permissionMode,
    sandbox: c.sandbox,
    sandboxNetwork: net,
    sandboxMissingBackend: c.sandboxMissingBackend ?? "fail-closed",
    readOutsideWorkspace: c.readOutsideWorkspace ?? "ask",
    stickyProvider: (() => {
      try {
        return loadPreferences().provider ?? null;
      } catch {
        return null;
      }
    })(),
    blockingStopHooks: c.blockingStopHooks !== false,
    promptProfile: c.promptProfile ?? "default",
    contextWindow: c.contextWindow,
    autoCompactThreshold: c.autoCompactThreshold,
    maxTurns: c.maxTurns,
    maxTurnsUnlimited: !(typeof c.maxTurns === "number" && c.maxTurns > 0),
    workspace: c.workspace || session?.meta.cwd || process.cwd(),
    baseUrl: c.baseUrl || c.providers[c.provider]?.baseUrl || null,
    goalEnabled: c.goal?.enabled !== false,
    goalStuckThreshold: c.goal?.stuckThreshold ?? null,
    rules: {
      deny: c.permission?.deny?.length || 0,
      allow: c.permission?.allow?.length || 0,
      ask: c.permission?.ask?.length || 0,
    },
    session: session
      ? {
          id: session.meta.id,
          title: session.meta.title || null,
          ultrawork: Boolean(session.meta.ultrawork),
          pinned: Boolean(session.meta.pinned),
          turns: session.meta.turnCount,
          edits: session.meta.editCount,
        }
      : null,
    env: {
      FORGE_HOME:
        process.env.FORGE_HOME || path.join(process.env.HOME || "", ".forge"),
      FORGE_BASH_TIMEOUT_MS: defaultBashTimeoutMs(),
      FORGE_BASH_BG_TIMEOUT_MS: defaultBashBackgroundTimeoutMs(),
      FORGE_PROVIDER_TIMEOUT_MS: providerTimeoutMs(),
      FORGE_DOOM_LOOP_THRESHOLD: envPositiveInt("FORGE_DOOM_LOOP_THRESHOLD", 3),
      FORGE_ERROR_STREAK_THRESHOLD: envPositiveInt(
        "FORGE_ERROR_STREAK_THRESHOLD",
        5,
      ),
    },
  };
}

/**
 * Format effective config for `/config` and `forge config`.
 * Never dumps API keys or credential material.
 */
export function formatEffectiveConfig(
  config: ForgeConfig,
  opts?: { json?: boolean; session?: SessionData | null },
): string {
  const snap = buildEffectiveConfigSnap(config, { session: opts?.session });
  if (opts?.json) {
    const body = { ok: true, ...snap };
    const compact =
      process.env.FORGE_JSON_COMPACT === "1" ||
      process.env.FORGE_JSON_COMPACT === "true";
    return compact ? JSON.stringify(body) : JSON.stringify(body, null, 2);
  }
  const sess = snap.session;
  const lines = [
    `Effective config (live-safe · no secrets)`,
    `  version:         ${snap.version}`,
    `  forgeHome:       ${snap.forgeHome}`,
    `  provider/model:  ${snap.provider}/${snap.model}` +
      (snap.reasoningEffort ? `  effort=${snap.reasoningEffort}` : ""),
    `  permission:      ${snap.permissionMode}`,
    `  sandbox:         ${snap.sandbox}  network=${snap.sandboxNetwork}  missing=${snap.sandboxMissingBackend}`,
    `  read outside:    ${snap.readOutsideWorkspace}`,
    `  sticky provider: ${snap.stickyProvider ?? "(none)"}`,
    `  blocking Stop:   ${snap.blockingStopHooks ? "on" : "OFF"}`,
    `  profile:         ${snap.promptProfile}`,
    `  context:         window=${snap.contextWindow} autoCompact@${Math.round((snap.autoCompactThreshold || 0.8) * 100)}% maxTurns=${snap.maxTurns > 0 ? snap.maxTurns : "unlimited"}`,
    `  goal gate:       ${snap.goalEnabled ? "on" : "off"}` +
      (snap.goalStuckThreshold != null
        ? `  stuck=${snap.goalStuckThreshold}`
        : ""),
    `  rules:           deny=${snap.rules.deny} allow=${snap.rules.allow} ask=${snap.rules.ask}`,
    `  workspace:       ${snap.workspace}`,
    `  FORGE_HOME:      ${snap.env.FORGE_HOME}`,
    snap.baseUrl ? `  api base:        ${snap.baseUrl}` : null,
    sess
      ? `  session:         ${sess.id!.slice(0, 8)}` +
        (sess.title ? `  “${sess.title}”` : "") +
        (sess.ultrawork ? "  ULW" : "") +
        (sess.pinned ? "  PIN" : "") +
        `  t=${sess.turns} e=${sess.edits}`
      : null,
    `  timeouts:        provider=${Math.round(snap.env.FORGE_PROVIDER_TIMEOUT_MS / 1000)}s` +
      `  bash=${Math.round(snap.env.FORGE_BASH_TIMEOUT_MS / 1000)}s` +
      `  bash-bg=${Math.round(snap.env.FORGE_BASH_BG_TIMEOUT_MS / 1000)}s`,
    `  loop guards:     doom@${snap.env.FORGE_DOOM_LOOP_THRESHOLD}  error-streak@${snap.env.FORGE_ERROR_STREAK_THRESHOLD}`,
    chalk.dim(
      sess
        ? `  /config json · /doctor · /permissions · /model · /effort`
        : `  forge config --json · forge doctor · forge tips`,
    ),
  ].filter(Boolean) as string[];
  return lines.join("\n");
}

/** OpenCode-inspired code review prompt (scoped target). */
export function buildReviewPrompt(target: string, workspace: string): string {
  const t = (target || "uncommitted").trim() || "uncommitted";
  const lower = t.toLowerCase();
  let scopeBlock: string;
  if (
    !t ||
    lower === "uncommitted" ||
    lower === "dirty" ||
    lower === "working" ||
    lower === "."
  ) {
    scopeBlock = `## Scope: uncommitted working tree
1. \`git status --short\`
2. \`git diff\` (unstaged) and \`git diff --cached\` (staged)
3. For untracked files from status, read their full contents`;
  } else if (lower === "staged" || lower === "cached" || lower === "--cached") {
    scopeBlock = `## Scope: staged changes only
1. \`git status --short\`
2. \`git diff --cached\`
3. Read full files for any staged paths that need context`;
  } else if (/^#?\d+$/.test(t) || /github\.com\/.+\/pull\/\d+/i.test(t) || /^pr[#/]?\d+$/i.test(t)) {
    const pr = t.replace(/^pr[#/]?/i, "").replace(/^#/, "");
    scopeBlock = `## Scope: pull request ${pr}
1. Prefer \`gh pr view ${pr}\` and \`gh pr diff ${pr}\` when \`gh\` is available
2. Fallback: identify the base branch and \`git diff origin/main...HEAD\` (or the PR base)
3. Read full files for non-obvious hunks`;
  } else if (/^[0-9a-f]{7,40}$/i.test(t)) {
    scopeBlock = `## Scope: commit ${t}
1. \`git show ${t} --stat\`
2. \`git show ${t} --format=fuller --no-color\`
3. Read full files for non-obvious hunks`;
  } else {
    // Branch / ref — keep as a single token for the model; argv-safe when it shells.
    scopeBlock = `## Scope: compare \`${t}\`…HEAD
1. \`git status --short\`
2. \`git log --oneline ${t}..HEAD\` (if valid)
3. \`git diff ${t}...HEAD\` (three-dot when merge-base exists; else two-dot)
4. Read full files for non-obvious hunks`;
  }

  return `You are a code reviewer. Review the changes in workspace \`${workspace}\` and provide actionable feedback.

Target argument: \`${t}\`

${scopeBlock}

## Gathering context
Diffs alone are not enough. After the diff, read the entire file(s) being modified to understand surrounding logic. Check AGENTS.md / CONTRIBUTING / style configs when relevant. Prefer executable sources of truth over prose.

## What to look for (priority order)
1. **Bugs** — logic errors, missing guards, race conditions, broken error handling, security (injection, path escape, secret leak)
2. **Behavior changes** — unintentional API/CLI/contract shifts
3. **Structure** — fights existing patterns; missing shared helpers
4. **Performance** — only if obviously bad (unbounded O(n²), sync I/O on hot paths)

## Discipline
- Only review the changes — do not nitpick pre-existing code that was not modified
- Be certain before calling something a bug; investigate first
- Don't invent hypothetical problems; name the realistic scenario
- Don't be a style zealot unless it violates established project conventions
- No flattery. Matter-of-fact tone. Severity must match impact.

## Output format
1. Short summary (1–3 sentences)
2. Findings ordered by severity (\`critical\` / \`high\` / \`medium\` / \`low\` / \`note\`)
3. Each finding: file/symbol, why it matters, concrete fix suggestion
4. If clean: say so briefly and note residual risks (tests not run, etc.)
5. End with suggested verification commands (test/typecheck) when applicable

Start by gathering the diff with tools, then read the important files, then write the review.`;
}

/** OpenCode-inspired AGENTS.md bootstrap prompt. */
export function buildInitAgentsPrompt(focus: string, workspace: string): string {
  const focusBlock = focus
    ? `\nUser-provided focus or constraints (honor these):\n${focus}\n`
    : "";
  return `Create or update \`AGENTS.md\` for this repository at the workspace root (${workspace}).

The goal is a compact instruction file that helps future Forge sessions avoid mistakes and ramp up quickly. Every line should answer: "Would an agent likely miss this without help?" If not, leave it out.
${focusBlock}
## How to investigate

Read the highest-value sources first:
- \`README*\`, root manifests (\`package.json\`, \`Cargo.toml\`, \`pyproject.toml\`, …), lockfiles
- build, test, lint, formatter, typecheck, and codegen config
- CI workflows and pre-commit / task runner config
- existing instruction files (\`AGENTS.md\`, \`CLAUDE.md\`, \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\`)
- repo-local Forge config (\`.forge/config.toml\`) if present

If architecture is still unclear after reading config and docs, inspect a small number of representative code files to find the real entrypoints, package boundaries, and execution flow. Prefer reading the files that explain how the system is wired together over random leaf files.

Prefer executable sources of truth over prose. If docs conflict with config or scripts, trust the executable source and only keep what you can verify.

## What to extract

Look for the highest-signal facts for an agent working in this repo:
- exact developer commands, especially non-obvious ones (\`npm test\`, single-test invocation, typecheck)
- required command order when it matters
- monorepo or multi-package boundaries and real entrypoints
- framework or toolchain quirks: generated code, migrations, special env loading
- repo-specific style or workflow conventions that differ from defaults
- testing quirks: fixtures, integration prerequisites, flaky or expensive suites
- important constraints from existing instruction files worth preserving

## Writing rules

- Prefer short sections and bullets
- Exclude generic software advice, long tutorials, exhaustive file trees, speculative claims
- If \`AGENTS.md\` already exists, improve it in place rather than rewriting blindly
- Preserve verified useful guidance; delete fluff or stale claims
- After writing, briefly summarize what changed and why

Do the research with tools, then write or update \`AGENTS.md\` now.`;
}

const HELP_TEXT = `
Forge slash commands
────────────────────
  /help                 Show this help
  /goal <objective>     Arm relentless goal driver (Codex-style)
  /goal                 Show goal status  [live]
  /goal pause|resume|clear|done   [live]
  /done [note]          Shorthand for /goal done  [live]
  /pause                Shorthand for /goal pause  [live]
  /unpause              Shorthand for /goal resume  [live]
  /ulw [task]           Arm ULW + cycle=1 (soft prompts OK: "improve the code")
  /cycle 1|0|status     Continue waves (1) or last wave then stop (0)  [live]
  /max-waves N|off      Cap ULW waves (auto LAST at N); default unlimited  [live]
  /ulw-off              Disarm ULW + cycle driver  [live]
  /hooks                List loaded hooks  [live]
  /status · /hud        Full inline HUD + session details (no second panel)  [live]
  /tasks [kill|log id]  Background shell tasks · kill/log subcommands  [live]
  /context              Context window usage bar  [live]
  /cost                 Token usage + rough cost  [live]
  /metrics              Local metrics.jsonl + this session counters  [live]
  /stats [days|week]    Usage dashboard (runs/tokens/cost/projects)  [live]
  /todos                Show agent todos  [live]
  /model <name> [effort] Switch model; optional low|medium|high (persists)
  /effort [level]       Reasoning effort for current model (low|medium|high)  [live]
  /plan [focus]         Session-scoped PLAN mode (read-only design; no sticky prefs)  [live]
  /build [note]         Leave plan → restore prior mode and implement (/execute)  [live]
  /permissions [mode]   Menu if empty; Tab / numbers / aliases (yolo, always…)
                        Sticky prefs · plan|build aliases · list|clear|revoke always-allows
  /compact              Compact conversation
  /compact-and <prompt> Compact then continue with follow-up (Warp-style)
  /fork-and-compact [prompt]  Fork, compact the fork, optional continue (Warp-style)
  /init [focus]         Guided AGENTS.md setup / improve (OpenCode-style)
  /review [target]      Code review: uncommitted|staged|<commit>|<branch>|<pr#>
  /rewind [n]           Undo last n user turns + restore journaled files (/undo)
  /retry [prompt]       Rewind last turn (+ disk) + re-run (/again; optional rewrite)
  /export [path] [--json]  Export session as markdown or JSON (files mode 0600)
  /fork [title]         Branch session into a new id (keep original)
  /title [name|clear]   Show / set / clear session title (/rename)  [live]
  /bell [on|off|test]   Terminal BEL when a turn ends (long-run attention)  [live]
  /diff [path]          Git status + diff (argv-safe; pathspecs/refs only)  [live]
  /logs [n|0|all|path]  Tail sandbox/safety events (0/all = full window)  [live]
  /config [json]        Effective config snapshot (no secrets)  [live]
  /copy                 Copy last assistant reply (pbcopy/wl-copy/xclip/…)  [live]
  /share [nocopy]       Pasteable session card + resume/export cmds (clipboard)  [live]
  /last [n]             Peek last n user/assistant turns (after resume)  [live]
  /files [writes|n]     Paths touched by tools this session (newest first)  [live]
  /path [id|json]       On-disk session directory / session.json path  [live]
  /pin [on|off|toggle]  Protect session from prune (/unpin)  [live]
  /tips                 Expert keyboard / CI cheat sheet  [live]
  /news [n|all]         What's new from CHANGELOG (/changelog)  [live]
  /new [title]          Fresh session (optional searchable label; ULW not inherited)
  /clear                Clear messages same id (counters+journal reset)
  /clear hard           Brand-new session id (same as /new; ULW not inherited)
  /resume [id|title|all] Resume by id prefix or unique /title (same-cwd picker)
  /sessions [all|search|delete|prune]  List (cwd default) / search / delete [--force] / prune
  /auth                 Show stored credentials (+ multi-account)  [live]
  /accounts [status|switch|…]  Multi-account list/status/switch/clear-cooldown  [live]
  /doctor               Environment health check  [live]
  /quit                 Exit  [live — aborts run then exits]

Tips
────
  Unknown /cmd typos suggest closest commands (e.g. /exprot → /export).
  Catalog typos: /model grok-45 · /effort medum · /permissions aceptEdits · /sessions prun.

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
                  /cycle 0  ·  /cycle 1  ·  /max-waves N|off  ·  /ulw-off  ·  /goal pause  ·  /status
                  (no need to Ctrl+C first — harness updates apply at next Stop)
  Ctrl+C          Abort the current turn; twice at idle prompt to exit
`.trim();
