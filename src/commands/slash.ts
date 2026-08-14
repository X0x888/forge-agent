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
import { isLastVerificationStale } from "../session/session.js";
import {
  saveSession,
  listSessions,
  listSessionForks,
  deleteSessionDetailed,
  pruneSessions,
  sessionHasForeignLiveLock,
  compactMessages,
} from "../session/session.js";
import { DEFAULT_CHECKPOINT_KEEP_STEPS } from "../session/checkpoint.js";
import {
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
  resolveSessionId,
  resolveSessionJsonPath,
  sessionDir,
  clearConversation,
  createSession,
  loadSession,
  estimateTokens,
  enterSessionPlanMode,
  exitSessionPlanMode,
  persistSessionMode,
  maybeSetTitle,
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
  clampEffortForModel,
  defaultEffortForModel,
  effortLevelsForModel,
  modelSupportsReasoningEffort,
  parseReasoningEffort,
  resolveReasoningEffort,
  type ReasoningEffort,
} from "../config/reasoning.js";
import { isGrokLineageModel } from "../config/grok-model.js";
import {
  formatFallbackChain,
  nextFallbackModel,
  parseFallbackModels,
} from "../config/model-fallback.js";
import {
  lastModelForProvider,
  loadPreferences,
  savePreferences,
} from "../config/preferences.js";
import {
  buildModelCatalog,
  buildModelCatalogSync,
  providerAllowsFreeFormModels,
  readProviderModelsCache,
  trackRecentModel,
} from "../config/model-catalog.js";
import { describeSandbox, detectSandboxBackend } from "../agent/sandbox.js";
import {
  describeAuth,
  resolveAuth,
  resolveAuthFresh,
} from "../auth/resolve.js";
import type { ResolvedAuth } from "../auth/types.js";
import { printAuthStatus } from "../auth/login.js";
import {
  getActiveAccount,
  getCredential,
  isExpired,
  listAccounts,
} from "../auth/store.js";
import { normalizeProviderId, providerIdHelp } from "../util/provider-id.js";
import { providerMaxWallMs, providerTimeoutMs } from "../util/abort.js";
import { copyToClipboard } from "../util/clipboard.js";
import {
  defaultBashBackgroundTimeoutMs,
  defaultBashTimeoutMs,
  envPositiveInt, maxRunMsFromEnv,
  parseCliNonNegInt,
} from "../util/env.js";
import { isBellEnabled, isNotifyEnabled } from "../util/attention.js";
import {
  detectProjectFormatters,
  isFormatOnWriteEnabled,
} from "../agent/tools/format-on-write.js";
import { normalizePermissionMode, normalizeSandboxProfile } from "../util/mode-aliases.js";
import { isFalsy } from "../util/bool.js";
import { forgeHome, inspectSecureFile } from "../util/fs.js";
import { getForgeVersion } from "../util/version.js";
import { formatWhatsNew } from "../util/changelog.js";
import { formatExpertTips } from "../util/tips.js";
import { loadMcpConfig } from "../mcp/config.js";
import { buildEnsurePlan } from "../lsp/ensure.js";
import { helpFor } from "./help-text.js";
import {
  collectSetupAssessment,
  formatSetupCard,
  markProviderModelConfirmed,
  markSetupSeen,
  markSetupSkipped,
  parseSetupAction,
  setupJsonPayload,
} from "./setup.js";
import {
  detectProjectIntel,
  packageManagerLockfileMismatch,
} from "../util/project-intel.js";
import { parseDaysWindow, daysWindowHelp } from "../util/days-window.js";
import { parseNewsCount, newsCountHelp } from "../util/news-count.js";
import { parseLogsLines, logsLinesHelp } from "../util/logs-lines.js";
import { editDistance } from "../util/string-distance.js";
import {
  isAcceptableUnknownModelId,
  suggestName,
  suggestSessionAction,
} from "../util/suggest.js";
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
  costCapStatus,
  formatCostBudgetLine,
  parseCostUsd,
  resolveMaxCostUsd,
} from "../util/cost-budget.js";
import {
  estimateCostUsd,
  formatCost,
  formatTokens,
  formatRelativeTime,
} from "../util/format.js";
import {
  applyModelContextWindow,
  modelContextWindow,
  parseContextWindowArg,
  resolveEffectiveMaxTokens,
} from "../config/model-info.js";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { displayRelPath } from "../agent/tools/path-util.js";
import { execFileSync } from "node:child_process";
import {
  applySafetyCheckpoint,
  createSafetyCheckpoint,
} from "../util/git-checkpoint.js";
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
  saveUlwCycle,
  ulwKickoffMessage,
  formatUlwCounts,
  formatCappedWaveDoctrine,
  ULW_LIVE_CONTROLS_HINT,
} from "../harness/ulw-cycle.js";
import {
  appendMemoryRecord,
  formatMemoryStatus,
  isBroadMandate,
  seedMemoryFromMandate,
  todosFromMandate,
} from "../harness/decision-memory.js";
import {
  appendProjectMemory,
  archiveProjectMemory,
  clearProjectMemory,
  formatProjectMemoryStatus,
  listActiveProjectMemory,
  normalizeProjectMemoryKind,
} from "../harness/project-memory.js";
import { pushLiveNotice } from "../harness/live-notices.js";
import { clearSoftTodoGateOnWindDown } from "../harness/todo-gate.js";
import { applyTodos, openTodos } from "../agent/todos.js";
import {
  COMMAND_PARAMS,
  formatParamMenu,
  resolveParamChoice,
} from "../tui/complete.js";
import {
  findProjectCommand,
  expandProjectCommandTemplate,
  listProjectCommandSlashes,
  formatProjectCommandsHelp,
} from "./project-commands.js";

export interface SlashResult {
  handled: boolean;
  output?: string;
  quit?: boolean;
  forwardPrompt?: string;
  session?: SessionData;
  /** REPL should replace its session pointer */
  replaceSession?: SessionData;
  /**
   * Queue as a mid-run interjection instead of starting a new turn
   * (e.g. /paste while the agent is working).
   */
  queueInterjection?: string;
  /**
   * REPL must hot-swap provider credentials from the mutated `opts.auth`
   * (e.g. `/accounts switch`). Without this, live provider keeps the old token.
   */
  authUpdated?: boolean;
  /**
   * Provider and/or model client must be fully recreated (not just token).
   * Set by `/provider` when switching backends (e.g. xai → openrouter).
   */
  providerUpdated?: boolean;
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
  "/commands", // list project/user custom slash templates
  "/skills", // list builtin + project/user skill packs
  "/diff",
  "/copy", // clipboard last assistant reply — no session mutation
  "/paste", // clipboard image → queued interjection (no new turn)
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
  "/memory",
  "/decisions",
  "/ulw-off",
  "/improve",
  "/ralph",
  "/effort",
  "/model",
  "/provider",
  "/temperature",
  "/temp",
  "/max-tokens",
  "/maxtokens",
  "/max_tokens",
  "/context-window",
  "/ctx-window",
  "/context_window",
  "/plan",
  "/build",
  "/execute",
  "/title",
  "/rename",
  "/bell",
  "/notify",
  "/format",
  "/verbose",
  "/budget",
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
    // list/search variants are readonly; delete/prune/pin/unpin mutate disk — idle-only
    const tokens = arg.split(/\s+/).filter(Boolean);
    const verb = (tokens[0] || "").toLowerCase();
    // pin/unpin <id> load+save ANOTHER session with no lock check — never
    // mid-run. Bare `pin` (no target) is the pinned-list filter: readonly.
    if ((verb === "pin" || verb === "unpin") && tokens.length > 1) {
      return "idle-only";
    }
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
  // /budget status is readonly; set/clear is live control (session meta).
  if (cmd === "/budget") {
    const a = arg.trim().toLowerCase();
    if (!a || a === "status" || a === "show" || a === "?") return "readonly";
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
  // /mcp · /lsp status is readonly; connect/restart are control
  if (cmd === "/mcp" || cmd === "/lsp") {
    const a = (arg || "").trim().toLowerCase();
    if (
      !a ||
      a === "status" ||
      a === "list" ||
      a === "tools" ||
      a === "install" ||
      a === "setup" ||
      a === "help" ||
      a === "detect" ||
      a.startsWith("ensure dry") ||
      a === "ensure dry" ||
      a === "plan"
    ) {
      return "readonly";
    }
    // /lsp ensure (install) mutates global packages — control
    if (a === "ensure" || a.startsWith("ensure ") || a === "fix" || a === "auto") {
      return "control";
    }
    return "control";
  }
  if (cmd === "/checkpoint" || cmd === "/snap") {
    const rest = line.trim().slice(cmd.length).trim().toLowerCase();
    const verb = rest.split(/\s+/)[0] || "";
    if (verb === "status" || verb === "list" || verb === "ls") return "readonly";
    return "control";
  }
  if (cmd === "/hooks") {
    const rest = line.trim().slice(cmd.length).trim().toLowerCase();
    const verb = rest.split(/\s+/)[0] || "";
    if (!verb || verb === "list" || verb === "status" || verb === "ls") return "readonly";
    return "control";
  }
  if (cmd === "/setup") {
    const a = arg.trim().toLowerCase();
    const head = a.split(/\s+/)[0] || "";
    if (
      !head ||
      head === "status" ||
      head === "show" ||
      head === "card" ||
      head === "json" ||
      head === "help" ||
      head === "?"
    ) {
      return "readonly";
    }
    if (head === "3" || head === "init" || head === "agents") return "idle-only";
    if (
      head === "6" ||
      head === "scaffold" ||
      head === "files" ||
      head === "initfiles"
    ) {
      return "idle-only";
    }
    return "control";
  }
  if (cmd === "/memory" || cmd === "/decisions") {
    return "control";
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
    // bare /model shows catalog; setting a model is control (live mid-run)
    if (cmd === "/model" && !arg) return "readonly";
    // bare /provider lists providers; switch is control
    if (cmd === "/provider" && !arg) return "readonly";
    // bare /temperature · /max-tokens show current
    if (
      (cmd === "/temperature" || cmd === "/temp") &&
      !arg
    ) {
      return "readonly";
    }
    if (
      (cmd === "/max-tokens" || cmd === "/maxtokens" || cmd === "/max_tokens") &&
      !arg
    ) {
      return "readonly";
    }
    if (
      (cmd === "/context-window" ||
        cmd === "/ctx-window" ||
        cmd === "/context_window") &&
      !arg
    ) {
      return "readonly";
    }
    // bare /title|/rename shows current title
    if ((cmd === "/title" || cmd === "/rename") && !arg) return "readonly";
    // bare /bell shows status
    if (cmd === "/bell" && !arg) return "readonly";
    // bare /notify shows status
    if (cmd === "/notify") {
      const a = arg.toLowerCase();
      if (!a || a === "status" || a === "show") return "readonly";
    }
    if (cmd === "/format" && !arg) return "readonly";
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
  `${ULW_LIVE_CONTROLS_HINT} · /plan · /build · exit_plan_mode · /provider · /model · !cmd · @path · free-text queues mid-run · /pause · /unpause · /done · /status  ·  Ctrl+C aborts the turn`;

export const SLASH_COMMANDS = [
  "/help",
  "/goal",
  "/done",
  "/pause",
  "/unpause",
  "/ulw",
  "/improve",
  "/ralph",
  "/checkpoint",
  "/snap",
  "/memory",
  "/decisions",
  "/ulw-off",
  "/cycle",
  "/max-waves",
  "/hooks",
  "/status",
  "/statusline",
  "/hud",
  "/tasks",
  "/mcp",
  "/lsp",
  "/context",
  "/cost",
  "/budget",
  "/metrics",
  "/stats",
  "/todos",
  "/provider",
  "/model",
  "/fallback",
  "/effort",
  "/temperature",
  "/temp",
  "/max-tokens",
  "/context-window",
  "/ctx-window",
  "/plan",
  "/build",
  "/execute",
  "/setup",
  "/permissions",
  "/compact",
  "/compact-and",
  "/fork-and-compact",
  "/init",
  "/review",
  "/commit",
  "/rewind",
  "/undo",
  "/retry",
  "/again",
  "/export",
  "/fork",
  "/title",
  "/rename",
  "/bell",
  "/notify",
  "/format",
  "/pin",
  "/unpin",
  "/diff",
  "/copy",
  "/paste",
  "/attach",
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
  "/skills",
  "/commands",
  "/verbose",
  "/quit",
] as const;

export function completeSlash(
  line: string,
  opts?: { workspace?: string },
): string[] {
  const t = line.trimStart();
  if (!t.startsWith("/")) return [];
  // Argument completion: "/format o" → on|off
  const sp = t.indexOf(" ");
  if (sp !== -1) {
    const cmd = t.slice(0, sp).toLowerCase();
    const argPartial = t.slice(sp + 1).trimStart().toLowerCase();
    // Only complete first arg (no multi-word yet)
    if (argPartial.includes(" ")) return [];
    const ARG_TABLE: Record<string, string[]> = {
      "/format": ["on", "off", "status", "enable", "disable"],
      "/checkpoint": ["status", "list", "restore", "apply"],
      "/snap": ["status", "list", "restore", "apply"],
      "/memory": ["list", "project", "add", "seed", "clear"],
      "/hooks": ["init", "reload", "list", "scaffold"],
      "/improve": [],
      "/ralph": [],
      "/bell": ["on", "off", "test", "status"],
      "/notify": ["on", "off", "test", "status"],
      "/mcp": ["status", "connect", "tools", "reload", "list"],
      "/lsp": [
        "status",
        "ensure",
        "install",
        "detect",
        "restart",
        "reload",
        "setup",
      ],
      "/budget": ["status", "off", "1", "5", "10", "25"],
      "/provider": [
        "deepseek",
        "openrouter",
        "xai",
        "anthropic",
        "openai",
        "google",
        "copilot",
        "custom",
        "list",
        "status",
      ],
      "/temperature": ["0", "0.2", "0.7", "1"],
      "/temp": ["0", "0.2", "0.7", "1"],
      "/max-tokens": ["4096", "8192", "16384", "32768"],
      "/context-window": ["auto", "128k", "200k", "256k", "500k", "1m"],
      "/ctx-window": ["auto", "128k", "200k", "256k", "500k", "1m"],
      "/help": [
        "start",
        "all",
        "settings",
        "harness",
        "sessions",
        "safety",
      ],
      "/setup": [
        "skip",
        "json",
        "model",
        "budget",
        "init",
        "notify",
        "lsp",
        "scaffold",
        "help",
      ],
      "/plan": ["on", "off", "status", "show"],
      "/build": ["on", "off", "status", "execute"],
      "/execute": ["on", "off", "status"],
      "/cycle": ["0", "1", "on", "off", "status"],
      "/max-waves": ["off", "status", "4", "8", "12"],
      "/max_waves": ["off", "status", "4", "8", "12"],
      "/ulw": ["on", "status"],
      "/goal": [
        "status",
        "pause",
        "resume",
        "unpause",
        "clear",
        "done",
        "set",
      ],
      "/effort": ["low", "medium", "high", "xhigh", "status"],
      "/permissions": ["default", "acceptEdits", "plan", "bypassPermissions", "status"],
      "/permission": ["default", "acceptEdits", "plan", "bypassPermissions", "status"],
      "/sessions": [
        "list",
        "show",
        "path",
        "export",
        "import",
        "fork",
        "pin",
        "unpin",
        "title",
        "rename",
        "delete",
        "prune",
        "search",
        "find",
        "errors",
        "untitled", "tree", "forks", "lineage"],
      "/pin": [],
      "/unpin": [],
    };
    const args = ARG_TABLE[cmd];
    if (!args) return [];
    return args
      .filter((a) => !argPartial || a.startsWith(argPartial))
      .map((a) => `${cmd} ${a}`);
  }
  const q = t.toLowerCase();
  const out: string[] = SLASH_COMMANDS.filter((c) => c.startsWith(q));
  let custom: string[] = [];
  try {
    custom = listProjectCommandSlashes(
      opts?.workspace || process.cwd(),
    ).filter((c) => c.startsWith(q));
  } catch {
    /* */
  }
  const seen = new Set<string>(out);
  for (const c of custom) {
    if (!seen.has(c)) {
      out.push(c);
      seen.add(c);
    }
  }
  return out;
}


/**
 * Rank slash commands for typo recovery (unknown /cmd).
 * Prefer prefix/substring, then small Levenshtein distance on the bare name.
 */
export function suggestSlashCommands(
  rawCmd: string,
  limit = 5,
  opts?: { workspace?: string },
): string[] {
  const q = rawCmd.trim().toLowerCase();
  if (!q.startsWith("/")) return [];
  const bare = q.slice(1);
  if (!bare) return [];

  const catalog = new Set<string>(SLASH_COMMANDS);
  try {
    for (const c of listProjectCommandSlashes(
      opts?.workspace || process.cwd(),
    )) {
      catalog.add(c);
    }
  } catch {
    /* */
  }

  const scored = [...catalog].map((c) => {
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
export function formatUnknownSlash(
  cmd: string,
  opts?: { workspace?: string },
): string {
  const bare = cmd.trim().toLowerCase().replace(/^\//, "");
  if (bare === "ask_user" || bare === "ask-user" || bare === "askuser") {
    return (
      "ask_user is a model tool, not a slash command.\n" +
      "The agent asks clarifying questions mid-run. Type a task, or /help start."
    );
  }
  const suggestions = suggestSlashCommands(cmd, 5, opts);
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

type SlashOpts = {
  session: SessionData;
  config: ForgeConfig;
  hooks: HookRunner;
  auth?: ResolvedAuth;
};

const STOCK_PROVIDER_ORDER = [
  "xai",
  "deepseek",
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "copilot",
  "custom",
] as const;

function providerAuthSummary(provider: string): string {
  try {
    const envNames: string[] = [];
    if (provider === "xai") envNames.push("XAI_API_KEY", "GROK_API_KEY");
    else if (provider === "openrouter") envNames.push("OPENROUTER_API_KEY");
    else if (provider === "deepseek") envNames.push("DEEPSEEK_API_KEY");
    else if (provider === "anthropic") envNames.push("ANTHROPIC_API_KEY");
    else if (provider === "openai") envNames.push("OPENAI_API_KEY");
    else if (provider === "google") envNames.push("GOOGLE_API_KEY", "GEMINI_API_KEY");
    else if (provider === "copilot") envNames.push("COPILOT_GITHUB_TOKEN");
    else if (provider === "custom") envNames.push("FORGE_API_KEY");
    for (const n of envNames) {
      if (process.env[n]?.trim()) return `env:${n}`;
    }
    const active = getActiveAccount(provider);
    if (active) {
      const label = active.accountLabel || active.subscription || active.method;
      return `${active.method}${label ? ` (${label})` : ""}`;
    }
    const accounts = listAccounts(provider);
    const pick = accounts[0];
    if (pick) {
      const label = pick.accountLabel || pick.subscription || pick.method;
      return `${pick.method}${label ? ` (${label})` : ""}`;
    }
  } catch {
    /* */
  }
  return "not authenticated";
}

/** List providers + switch (e.g. `/provider openrouter`). */
export async function handleProviderSlash(
  arg: string,
  opts: SlashOpts,
): Promise<SlashResult> {
  const raw = (arg || "").trim();
  const providerIds = [
    ...STOCK_PROVIDER_ORDER.filter((id) => opts.config.providers[id]),
    ...Object.keys(opts.config.providers).filter(
      (id) => !(STOCK_PROVIDER_ORDER as readonly string[]).includes(id),
    ),
  ];

  if (!raw || raw === "list" || raw === "ls" || raw === "status") {
    const lines: string[] = [
      `Provider  (active: ${opts.config.provider})`,
      `  model: ${opts.config.model}` +
        (opts.config.reasoningEffort
          ? `  effort=${opts.config.reasoningEffort}`
          : ""),
      `  temp=${opts.config.temperature ?? "default"}  max_tokens=${effectiveMaxTokensForDisplay(opts.config)}${opts.config.maxTokensExplicit ? "" : " (auto)"}`,
      "",
    ];
    for (const id of providerIds) {
      const pcfg = opts.config.providers[id];
      const mark = id === opts.config.provider ? "*" : " ";
      const def = pcfg?.defaultModel || "—";
      const last = lastModelForProvider(id);
      const auth = providerAuthSummary(id);
      const free = providerAllowsFreeFormModels(id) ? " free-form" : "";
      lines.push(
        `${mark} ${id.padEnd(12)} default=${String(def).padEnd(28)} auth=${auth}${free}` +
          (last && last !== def ? `\n              last=${last}` : ""),
      );
    }
    lines.push("");
    lines.push(
      chalk.dim(
        "Usage: /provider <name>   ·  aliases: ds→deepseek, or→openrouter, claude→anthropic, gpt→openai",
      ),
    );
    lines.push(
      chalk.dim(
        "Then:  /model <id>  ·  /effort  ·  /temperature  ·  /max-tokens  ·  /config",
      ),
    );
    lines.push(
      chalk.dim(
        "Login: forge login -p deepseek --api-key $DEEPSEEK_API_KEY  ·  openrouter: OPENROUTER_API_KEY",
      ),
    );
    return { handled: true, output: lines.join("\n") };
  }

  const norm = normalizeProviderId(raw);
  if (!norm.ok) {
    const tip = suggestName(raw, providerIds, {
      minLength: 2,
      minScore: 36,
      requirePrefix3: false,
    });
    return {
      handled: true,
      output:
        chalk.yellow(
          tip
            ? `Unknown provider "${raw}". Did you mean: ${tip}?\n`
            : `Unknown provider "${raw}".\n`,
        ) +
        `Use: ${providerIdHelp()}\n` +
        chalk.dim("Bare /provider lists options."),
    };
  }

  const nextProvider = norm.provider;
  const prevProvider = String(opts.config.provider);
  if (nextProvider === prevProvider) {
    return {
      handled: true,
      output:
        `Already on provider ${nextProvider} · model ${opts.config.model}\n` +
        chalk.dim(
          `/model · /effort · /temperature · /max-tokens · /config · forge login -p ${nextProvider}`,
        ),
    };
  }

  // Remember last model on the provider we're leaving
  try {
    if (opts.config.model) {
      trackRecentModel(prevProvider, opts.config.model);
      savePreferences({
        model: opts.config.model,
        modelProvider: prevProvider,
      });
    }
  } catch {
    /* */
  }

  const pcfg = opts.config.providers[nextProvider];
  if (!pcfg && nextProvider !== "custom") {
    return {
      handled: true,
      output: `Provider "${nextProvider}" is not configured in this build.`,
    };
  }
  if (nextProvider === "custom") {
    const base =
      opts.config.baseUrl ||
      process.env.FORGE_BASE_URL?.trim() ||
      pcfg?.baseUrl;
    if (!base) {
      return {
        handled: true,
        output:
          `Provider "custom" requires a base URL.\n` +
          chalk.dim(
            "Set FORGE_BASE_URL or --base-url, then: /provider custom",
          ),
      };
    }
  }

  // Pick model: last used on target provider → default → keep only if free-form
  const last = lastModelForProvider(nextProvider);
  const def = pcfg?.defaultModel;
  let nextModel = last || def || opts.config.model;
  const catalog = pcfg?.models || [];
  if (
    !last &&
    def &&
    prevProvider !== nextProvider &&
    catalog.length &&
    !catalog.includes(opts.config.model) &&
    !providerAllowsFreeFormModels(nextProvider)
  ) {
    nextModel = def;
  } else if (last) {
    nextModel = last;
  } else if (def) {
    nextModel = def;
  }

  opts.config.provider = nextProvider;
  opts.config.model = nextModel;
  opts.session.meta.provider = nextProvider;
  opts.session.meta.model = nextModel;

  const ctxApply = applyModelContextWindow(opts.config, nextModel);

  // Resolve auth for the new provider
  let authNote = "";
  let authUpdated = false;
  try {
    const fresh = await resolveAuthFresh(opts.config, nextProvider);
    if (fresh) {
      if (opts.auth) {
        opts.auth.provider = fresh.provider;
        opts.auth.method = fresh.method;
        opts.auth.token = fresh.token;
        opts.auth.accountLabel = fresh.accountLabel;
        opts.auth.accountId = fresh.accountId;
        opts.auth.baseUrl = fresh.baseUrl;
      } else {
        opts.auth = fresh;
      }
      authUpdated = true;
      authNote = ` · ${describeAuth(fresh)}`;
    } else {
      authNote =
        chalk.yellow(
          `\nNo credentials for ${nextProvider}. ` +
            (nextProvider === "deepseek"
              ? "Run: forge login -p deepseek --api-key $DEEPSEEK_API_KEY"
              : nextProvider === "openrouter"
                ? "Run: forge login -p openrouter --api-key $OPENROUTER_API_KEY"
                : nextProvider === "xai"
                  ? "Run: forge login   or  export XAI_API_KEY=…"
                  : `Run: forge login -p ${nextProvider}`),
        );
    }
  } catch (err) {
    authNote = chalk.yellow(
      `\nAuth resolve failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    savePreferences({
      provider: nextProvider,
      model: nextModel,
      modelProvider: nextProvider,
    });
    trackRecentModel(nextProvider, nextModel);
  } catch {
    /* */
  }

  saveSession(opts.session);
  try {
    pushLiveNotice(
      opts.session.meta.id,
      `User switched provider ${prevProvider} → ${nextProvider} (model ${nextModel}). Continue with the new backend; do not restart from scratch.`,
    );
  } catch {
    /* */
  }

  const freeNote = providerAllowsFreeFormModels(nextProvider)
    ? chalk.dim(
        `\nFree-form models OK · /model deepseek/deepseek-v4-flash · forge models -p ${nextProvider}`,
      )
    : chalk.dim(`\n/model lists catalog · Tab completes`);
  const ctxNote = ctxApply.known
    ? ` · ctx ${formatTokens(ctxApply.window)}${ctxApply.source === "explicit" ? " (pinned)" : " (model max)"}`
    : chalk.dim(
        ` · ctx ${formatTokens(opts.config.contextWindow)} (unknown model max · /context-window auto after forge models -p openrouter --refresh)`,
      );

  return {
    handled: true,
    authUpdated,
    providerUpdated: true,
    session: opts.session,
    output:
      `Provider ${prevProvider} → ${nextProvider} · model ${nextModel}${ctxNote}${authNote}` +
      freeNote +
      chalk.dim(
        `\nNext: /model · /context-window · /temperature · /max-tokens · /config`,
      ),
  };
}

/** /model catalog + free-form set (OpenRouter-aware). */
export function persistSessionFallbackModels(
  config: ForgeConfig,
  session?: SessionData,
): void {
  if (!session) return;
  if (config.fallbackModels === undefined) {
    delete session.meta.fallbackModels;
  } else {
    session.meta.fallbackModels = [...config.fallbackModels];
  }
  saveSession(session);
}

export function handleFallbackSlash(
  arg: string,
  opts: { config: ForgeConfig; session?: SessionData },
): SlashResult {
  const raw = arg.trim();
  if (!raw || raw === "?" || raw === "show" || raw === "status") {
    const chain = opts.config.fallbackModels;
    const shown =
      chain === undefined
        ? "(defaults)"
        : chain.length === 0
          ? "off"
          : chain.join(", ");
    const next = nextFallbackModel(opts.config);
    return {
      handled: true,
      output:
        `fallback: ${shown}` +
        (next ? `\nnext: ${next}` : "\nnext: (none)") +
        "\nUsage: /fallback <model[,model…]|off|default>",
    };
  }
  if (/^(off|none|false|0|disable)$/i.test(raw)) {
    opts.config.fallbackModels = [];
    persistSessionFallbackModels(opts.config, opts.session);
    return { handled: true, output: "fallback: off (no automatic model switch)" };
  }
  if (/^(default|defaults|auto|on|true)$/i.test(raw)) {
    delete opts.config.fallbackModels;
    persistSessionFallbackModels(opts.config, opts.session);
    const next = nextFallbackModel(opts.config);
    return {
      handled: true,
      output: `fallback: defaults` + (next ? ` (next ${next})` : ""),
    };
  }
  const parsed = parseFallbackModels(raw);
  if (!parsed || parsed.length === 0) {
    return { handled: true, output: "Usage: /fallback <model[,model…]|off|default>" };
  }
  opts.config.fallbackModels = parsed;
  persistSessionFallbackModels(opts.config, opts.session);
  return { handled: true, output: `fallback: ${parsed.join(", ")}` };
}

export async function handleModelSlash(
  arg: string,
  opts: SlashOpts,
): Promise<SlashResult> {
  const provider = String(opts.config.provider);
  const freeForm = providerAllowsFreeFormModels(provider);

  // Best-effort remote catalog for OpenRouter / xAI when listing
  let apiKey: string | undefined;
  if (provider === "openrouter") {
    apiKey =
      process.env.OPENROUTER_API_KEY?.trim() ||
      opts.auth?.token ||
      getCredential("openrouter")?.accessToken;
  } else if (provider === "xai") {
    apiKey =
      process.env.XAI_API_KEY?.trim() ||
      opts.auth?.token ||
      getCredential("xai")?.accessToken;
  }

  const catalog = arg
    ? buildModelCatalogSync(opts.config, provider)
    : await buildModelCatalog(opts.config, provider, {
        refreshRemote: provider === "openrouter" || provider === "xai",
        apiKey,
        useCache: true,
      });

  // Interactive menu: prefer recent + static (+ a few remote popular), not hundreds
  const menuIds = catalog.models.map((m) => m.id);
  const choices = menuIds.map((m) => {
    const entry = catalog.models.find((e) => e.id === m);
    const effortHint = modelSupportsReasoningEffort(m)
      ? ` · effort ${defaultEffortForModel(m) ?? "—"}`
      : "";
    const src =
      entry?.source === "recent"
        ? "recent"
        : entry?.source === "remote"
          ? "remote"
          : m === opts.config.model
            ? "current"
            : "catalog";
    return {
      value: m,
      description: src + effortHint,
    };
  });

  if (!arg) {
    const curEffort = resolveReasoningEffort(
      opts.config.model,
      opts.config.reasoningEffort,
    );
    const knownWin = modelContextWindow(opts.config.model);
    const header = [
      `Provider: ${provider}  ·  model: ${opts.config.model}`,
      `  temp=${opts.config.temperature ?? "default"}  max_tokens=${effectiveMaxTokensForDisplay(opts.config)}` +
        (curEffort ? `  effort=${curEffort}` : "") +
        `  ctx=${formatTokens(opts.config.contextWindow)}` +
        (opts.config.contextWindowExplicit
          ? " (pinned)"
          : knownWin
            ? knownWin === opts.config.contextWindow
              ? " (model max)"
              : ` (model max ${formatTokens(knownWin)})`
            : " (default)"),
    ].join("\n");
    const effortLine = modelSupportsReasoningEffort(opts.config.model)
      ? chalk.dim(
          `\nEffort: ${curEffort ?? "—"}  ·  /effort low|medium|high|xhigh  or  /model <name> <effort>`,
        )
      : chalk.dim(
          "\nReasoning effort: not wired for this model (prefs kept for grok-4.6).",
        );
    const freeLine = freeForm
      ? chalk.dim(
          `\nFree-form: /model org/model-id  (e.g. deepseek/deepseek-v4-flash)` +
            (catalog.remoteCount
              ? `  ·  ${catalog.remoteCount} OpenRouter ids cached`
              : "  ·  forge models -p openrouter refreshes remote catalog"),
        )
      : chalk.dim("\nTip: Tab completes catalog names.");
    const note = catalog.note ? chalk.dim(`\n${catalog.note}`) : "";
    // Orient mid-run model switches with session verify trail + project checks.
    let orient = formatSlashVerifyOrient({
      workspace: opts.config.workspace,
      cwd: opts.session.meta.cwd,
      editCount: opts.session.meta.editCount,
      lastVerificationCommand: opts.session.meta.lastVerificationCommand,
      lastVerificationAt: opts.session.meta.lastVerificationAt,
      lastEditAt: opts.session.meta.lastEditAt,
    });
    if (orient) {
      orient = orient
        .split("\n")
        .map((line) => {
          if (!line) return line;
          return /No last-verify after/.test(line)
            ? chalk.yellow(line)
            : chalk.dim(line);
        })
        .join("\n");
    }
    return {
      handled: true,
      output:
        header +
        "\n" +
        (choices.length
          ? formatParamMenu("/model", choices, opts.config.model)
          : `Usage: /model <name> [effort]`) +
        effortLine +
        freeLine +
        note +
        orient +
        chalk.dim(
          `\nAlso: /provider · /context-window · /temperature · /max-tokens · /config`,
        ),
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

  // Full id list for resolve + typo check (includes remote cache)
  const allChoices = catalog.ids.map((m) => ({
    value: m,
    description: m === opts.config.model ? "current" : "available",
  }));
  let resolved = resolveParamChoice(modelArg, allChoices);
  if (!resolved) {
    // Close catalog typos fail closed for non-free-form; free-form still allowed
    // unless the typo is a near-miss of a known id.
    const tip = allChoices.length
      ? suggestName(
          modelArg,
          allChoices.map((c) => c.value),
          { minLength: 3, minScore: 38, requirePrefix3: false },
        )
      : null;
    const acceptUnknown =
      !tip ||
      isAcceptableUnknownModelId(modelArg, tip) ||
      (freeForm && modelArg.includes("/"));
    if (!acceptUnknown) {
      return {
        handled: true,
        output:
          `Unknown model "${modelArg}". Did you mean: ${tip}?\n` +
          chalk.dim(
            freeForm
              ? "Tab completes · free-form ids with org/name still accepted (e.g. deepseek/deepseek-v4-flash)."
              : "Tab completes catalog names. Newer grok-*.* version bumps are accepted.",
          ),
      };
    }
    resolved = modelArg;
  }

  opts.config.model = resolved;
  opts.session.meta.model = resolved;
  opts.session.meta.provider = provider;

  // Prefer OpenRouter remote context_length when static table misses
  if (
    provider === "openrouter" &&
    !opts.config.contextWindowExplicit &&
    modelContextWindow(resolved) == null
  ) {
    try {
      await buildModelCatalog(opts.config, "openrouter", {
        refreshRemote: true,
        apiKey,
        useCache: true,
      });
    } catch {
      /* offline ok */
    }
  }

  const ctxApply = applyModelContextWindow(opts.config, resolved);
  let windowNote = "";
  if (ctxApply.known) {
    windowNote =
      ` · ctx ${formatTokens(ctxApply.window)}` +
      (ctxApply.source === "explicit" ? " (pinned)" : " (model max)");
  } else if (!opts.config.contextWindowExplicit) {
    windowNote = chalk.dim(
      ` · ctx ${formatTokens(opts.config.contextWindow)} (unknown — /context-window 1m or refresh catalog)`,
    );
  }

  let effortNote = "";
  if (effortArg) {
    const e = parseReasoningEffort(effortArg);
    if (!e) {
      effortNote = chalk.yellow(
        `\nIgnored effort "${effortArg}" (use low|medium|high|max|xhigh)`,
      );
    } else if (!modelSupportsReasoningEffort(resolved)) {
      effortNote = chalk.yellow(
        `\n${resolved} does not support reasoning effort (value kept in prefs for other models)`,
      );
      opts.config.reasoningEffort = e;
      try {
        savePreferences({
          model: resolved,
          reasoningEffort: e,
          modelProvider: provider,
        });
      } catch {
        /* ignore */
      }
    } else {
      const clamped = clampEffortForModel(resolved, e) ?? defaultEffortForModel(resolved)!;
      opts.config.reasoningEffort = clamped;
      try {
        savePreferences({
          model: resolved,
          reasoningEffort: clamped,
          modelProvider: provider,
        });
      } catch {
        /* ignore */
      }
      effortNote =
        clamped !== e
          ? chalk.yellow(` · effort ${clamped} (clamped from ${e})`)
          : ` · effort ${clamped}`;
    }
  } else {
    try {
      savePreferences({ model: resolved, modelProvider: provider });
    } catch {
      /* never fail slash on prefs I/O */
    }
    if (modelSupportsReasoningEffort(resolved)) {
      // Fresh model pick without explicit effort → use model max (ignore stale prefs)
      const e = resolveReasoningEffort(resolved, undefined);
      opts.config.reasoningEffort = e;
      effortNote = e ? ` · effort ${e} (model max)` : "";
    }
  }

  trackRecentModel(provider, resolved);
  saveSession(opts.session);
  try {
    pushLiveNotice(
      opts.session.meta.id,
      `User switched model mid-run → ${provider}/${resolved}${effortNote.replace(/^ · /, " · ") || ""}${windowNote.replace(/^ · /, " · ") || ""}. Continue with the new model; do not restart from scratch.`,
    );
  } catch {
    /* */
  }
  return {
    handled: true,
    output:
      `Model set to ${provider}/${resolved}${effortNote}${windowNote}` +
      ` (saved · live mid-run)` +
      chalk.dim(
        `  ·  /context-window · /temperature · /max-tokens · /provider · /config`,
      ),
    session: opts.session,
  };
}

/** `/context-window [n|auto]` — pin or auto-follow model max. */
export function handleContextWindowSlash(
  arg: string,
  opts: SlashOpts,
): SlashResult {
  const raw = (arg || "").trim();
  const known = modelContextWindow(opts.config.model);
  if (!raw || raw === "status" || raw === "show") {
    const mode = opts.config.contextWindowExplicit
      ? "pinned"
      : known && known === opts.config.contextWindow
        ? "model max (auto)"
        : known
          ? `default (model max ${formatTokens(known)} available)`
          : "default (model max unknown)";
    return {
      handled: true,
      output:
        `context_window: ${opts.config.contextWindow} (${formatTokens(opts.config.contextWindow)})  ·  ${mode}\n` +
        `  model: ${opts.config.provider}/${opts.config.model}` +
        (known ? `  ·  known max ${formatTokens(known)}` : "") +
        "\n" +
        chalk.dim(
          "Usage: /context-window <n|200k|1m|auto>  ·  auto = follow model max  ·  pin persists for this session only (config.toml for permanent)",
        ),
    };
  }

  const parsed = parseContextWindowArg(raw);
  if (parsed === null) {
    return {
      handled: true,
      output:
        chalk.yellow(
          `Invalid context window "${raw}". Use e.g. 200000, 200k, 1m, or auto.\n`,
        ) +
        chalk.dim(
          `Current: ${formatTokens(opts.config.contextWindow)}` +
            (known ? ` · model max ${formatTokens(known)}` : ""),
        ),
    };
  }

  if (parsed === "auto") {
    opts.config.contextWindowExplicit = false;
    const applied = applyModelContextWindow(opts.config, opts.config.model);
    try {
      pushLiveNotice(
        opts.session.meta.id,
        `User set context_window to auto (model max${applied.known ? ` ${applied.window}` : " unknown"}).`,
      );
    } catch {
      /* */
    }
    return {
      handled: true,
      output: applied.known
        ? `context_window: auto → ${formatTokens(applied.window)} (model max for ${opts.config.model})`
        : `context_window: auto · model max unknown for ${opts.config.model} — keeping ${formatTokens(opts.config.contextWindow)}` +
          chalk.dim(
            "\nTip: forge models -p openrouter --refresh  then /context-window auto",
          ),
    };
  }

  opts.config.contextWindow = parsed;
  opts.config.contextWindowExplicit = true;
  try {
    pushLiveNotice(
      opts.session.meta.id,
      `User pinned context_window to ${parsed} tokens.`,
    );
  } catch {
    /* */
  }
  const warn =
    known && parsed > known
      ? chalk.yellow(
          `\n⚠ ${formatTokens(parsed)} exceeds known model max ${formatTokens(known)} — provider may reject long prompts`,
        )
      : known && parsed < known * 0.5
        ? chalk.dim(
            `\nNote: pinned below 50% of model max ${formatTokens(known)} — long runs compact early`,
          )
        : "";
  return {
    handled: true,
    output: `context_window: ${formatTokens(parsed)} (pinned for session)${warn}`,
  };
}

export function handleTemperatureSlash(
  arg: string,
  opts: SlashOpts,
): SlashResult {
  const raw = (arg || "").trim();
  if (!raw || raw === "status" || raw === "show") {
    return {
      handled: true,
      output:
        `Temperature: ${opts.config.temperature ?? "default (provider)"}  (${opts.config.provider}/${opts.config.model})\n` +
        chalk.dim(
          "Usage: /temperature <0–2>|default   ·  session-only (set temperature in ~/.forge/config.toml to persist)",
        ),
    };
  }
  if (/^(default|auto|unset|server)$/i.test(raw)) {
    opts.config.temperature = undefined;
    try {
      pushLiveNotice(
        opts.session.meta.id,
        "User reset temperature to provider default (applies to subsequent model calls).",
      );
    } catch {
      /* */
    }
    return {
      handled: true,
      output: `Temperature: default (provider · next model call)`,
    };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    return {
      handled: true,
      output:
        chalk.yellow(`Invalid temperature "${raw}". Use a number from 0 to 2, or "default".\n`) +
        chalk.dim(`Current: ${opts.config.temperature ?? "default (provider)"}`),
    };
  }
  const rounded = Math.round(n * 1000) / 1000;
  opts.config.temperature = rounded;
  try {
    pushLiveNotice(
      opts.session.meta.id,
      `User set temperature to ${rounded} (applies to subsequent model calls).`,
    );
  } catch {
    /* */
  }
  return {
    handled: true,
    output: `Temperature: ${rounded} (session · next model call)`,
  };
}

/** Effective max_tokens for status displays (auto per-model unless pinned). */
function effectiveMaxTokensForDisplay(config: ForgeConfig): number {
  const effort = resolveReasoningEffort(config.model, config.reasoningEffort);
  return resolveEffectiveMaxTokens(config, Boolean(effort));
}

export function handleMaxTokensSlash(
  arg: string,
  opts: SlashOpts,
): SlashResult {
  const raw = (arg || "").trim();
  if (!raw || raw === "status" || raw === "show") {
    const eff = effectiveMaxTokensForDisplay(opts.config);
    return {
      handled: true,
      output:
        `max_tokens: ${eff}  (${opts.config.provider}/${opts.config.model}${opts.config.maxTokensExplicit ? "" : " · auto"})\n` +
        chalk.dim(
          "Usage: /max-tokens <n>|auto   ·  session-only (set max_tokens in ~/.forge/config.toml to persist)",
        ),
    };
  }
  if (/^(auto|default|unset)$/i.test(raw)) {
    opts.config.maxTokensExplicit = false;
    try {
      pushLiveNotice(
        opts.session.meta.id,
        "User reset max_tokens to auto (applies to subsequent model calls).",
      );
    } catch {
      /* */
    }
    return {
      handled: true,
      output: `max_tokens: ${effectiveMaxTokensForDisplay(opts.config)} (auto · next model call)`,
    };
  }
  const n = Number(raw.replace(/[_ ,]/g, ""));
  if (!Number.isFinite(n) || n < 1 || n > 1_000_000) {
    return {
      handled: true,
      output:
        chalk.yellow(
          `Invalid max_tokens "${raw}". Use an integer 1–1000000.\n`,
        ) + chalk.dim(`Current: ${effectiveMaxTokensForDisplay(opts.config)}`),
    };
  }
  const v = Math.floor(n);
  opts.config.maxTokens = v;
  opts.config.maxTokensExplicit = true;
  try {
    pushLiveNotice(
      opts.session.meta.id,
      `User set max_tokens to ${v} (applies to subsequent model calls).`,
    );
  } catch {
    /* */
  }
  return {
    handled: true,
    output: `max_tokens: ${v} (session · next model call)`,
  };
}

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
    case "/?": {
      const h = helpFor(arg);
      return { handled: true, output: h.text };
    }

    case "/quit":
    case "/exit":
    case "/q":
      return { handled: true, quit: true, output: "Bye." };

    case "/goal":
      return handleGoal(arg, opts.session);

    case "/done": {
      // Expert wind-down: mark goal done AND flip ULW to last-wave (cycle=0)
      // so one command releases both drivers. Agents still need **Cycle complete.**
      // / **Goal achieved.** attestation on the next stop when required.
      const note = arg.trim();
      const sid = opts.session.meta.id;
      const parts: string[] = [];
      // Goal done (if any)
      const goalResult = handleGoal(
        note ? `done ${note}` : "done",
        opts.session,
      );
      if (goalResult.output) parts.push(goalResult.output);
      // ULW: cycle 0 last-wave so Stop can release after attestation
      try {
        const ulw = loadUlwCycle(sid);
        if (ulw?.enabled && ulw.cycle === 1) {
          const next = setCycleFlag(sid, 0);
          if (next) {
            pushLiveNotice(
              sid,
              "User sent /done mid-run — ULW flipped to cycle=0 (LAST wave). Finish this wave, attest **Cycle complete.**, then stop. Do not start a new research wave.",
            );
            parts.push(
              chalk.magenta("ULW → cycle=0 (LAST)") +
                chalk.dim(
                  `  ${formatUlwCounts(next)}  finish wave + **Cycle complete.**`,
                ),
            );
          }
        } else if (ulw?.enabled && ulw.cycle === 0) {
          parts.push(
            chalk.dim(
              "ULW already on cycle=0 (LAST) — finish wave + **Cycle complete.**",
            ),
          );
        }
      } catch {
        /* */
      }
      // Reset soft TodoGate fire count so the next Stop after /done is not
      // blocked once for leftover open todos the user is intentionally winding down.
      try {
        clearSoftTodoGateOnWindDown(sid);
      } catch {
        /* */
      }
      // Soft tip when neither driver was armed
      if (parts.length === 0 || (parts.length === 1 && /No active goal/i.test(parts[0] || ""))) {
        parts.push(
          chalk.dim(
            "No ULW cycle=1 to wind down. Tip: /ulw-off · /cycle 0 · /goal clear",
          ),
        );
      }
      // Orient wind-down with last verification + preferred checks.
      try {
        const last = opts.session.meta.lastVerificationCommand?.trim();
        if (last) {
          const when = opts.session.meta.lastVerificationAt
            ? ` @ ${opts.session.meta.lastVerificationAt.slice(0, 19).replace("T", " ")}`
            : "";
          if (isLastVerificationStale(opts.session.meta)) {
            parts.push(
              chalk.yellow(
                `Last verify: \`${last.slice(0, 100)}${last.length > 100 ? "…" : ""}\`${when}  ⚠ stale (edits after verify) — re-run before calling it done.`,
              ),
            );
          } else {
            parts.push(
              chalk.dim(
                `Last verify: \`${last.slice(0, 100)}${last.length > 100 ? "…" : ""}\`${when}`,
              ),
            );
          }
        } else if ((opts.session.meta.editCount || 0) > 0) {
          const cwd =
            opts.config.workspace || opts.session.meta.cwd || process.cwd();
          try {
            const intel = detectProjectIntel(cwd);
            const tip = intel.checkCommands[0] || "npm test / typecheck";
            parts.push(
              chalk.yellow(
                `Edits this session with no recorded verification — prefer \`${tip}\` before calling it done.`,
              ),
            );
          } catch {
            parts.push(
              chalk.yellow(
                "Edits this session with no recorded verification — run a cheap check before calling it done.",
              ),
            );
          }
        } else {
          const cwd =
            opts.config.workspace || opts.session.meta.cwd || process.cwd();
          try {
            const intel = detectProjectIntel(cwd);
            if (intel.checkCommands[0]) {
              parts.push(
                chalk.dim(
                  `Preferred check: \`${intel.checkCommands[0]}\`  ·  /export · /share`,
                ),
              );
            }
          } catch {
            /* */
          }
        }
      } catch {
        /* never break /done */
      }
      return {
        handled: true,
        output: parts.filter(Boolean).join("\n"),
        session: opts.session,
      };
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

    case "/improve":
    case "/ralph": {
      opts.session.meta.ultrawork = true;
      const focus = (arg || "").trim();
      const mandate = focus
        ? `Continuously improve this project with near-zero user steering. Focus: ${focus}. Prefer reliability and autonomy gaps a serious daily user would notice. Ship, prove, hostile-review, repeat while cycle=1.`
        : "Continuously improve this project with near-zero user steering. Prefer reliability, autonomy, UX, and expert convenience gaps. Ship highest-leverage work, prove with project checks, hostile-review, repeat while cycle=1. Do not ask what to improve.";
      const state = armUlwCycle(opts.session.meta.id, mandate, {
        cycle: 1,
        editCount: opts.session.meta.editCount,
        cwd: opts.config.workspace || opts.session.meta.cwd || process.cwd(),
      });
      try {
        clearSoftTodoGateOnWindDown(opts.session.meta.id);
      } catch {
        /* */
      }
      let todoSeedNote = "";
      try {
        if (openTodos(opts.session.todos || []) < 2) {
          const seeded = todosFromMandate(mandate, { max: 12 });
          applyTodos(opts.session, seeded, false);
          todoSeedNote = `Seeded ${seeded.length} backlog todo(s).`;
        }
      } catch {
        /* */
      }
      const kick = ulwKickoffMessage(state);
      const banner = [
        chalk.bold("Continuous improve armed") +
          chalk.dim("  (/improve · alias /ralph · ULW cycle=1)"),
        state.checkpointSha
          ? chalk.dim(
              `Safety checkpoint: ${state.checkpointSha.slice(0, 12)}…  · /checkpoint restore`,
            )
          : chalk.dim("Safety checkpoint: (clean tree or disabled)"),
        todoSeedNote ? chalk.dim(todoSeedNote) : null,
        chalk.dim(ULW_LIVE_CONTROLS_HINT),
      ]
        .filter(Boolean)
        .join("\n");
      return {
        handled: true,
        forwardPrompt: kick,
        output: banner,
        session: opts.session,
      };
    }

    case "/ulw":
    case "/ultrawork":
    case "/autowork": {
      opts.session.meta.ultrawork = true;
      const mandate = arg || "improve the codebase";
      const state = armUlwCycle(opts.session.meta.id, mandate, {
        cycle: 1,
        editCount: opts.session.meta.editCount,
        cwd: opts.config.workspace || opts.session.meta.cwd || process.cwd(),
      });
      // Fresh driver: drop leftover soft TodoGate once-blocks from prior work.
      try {
        clearSoftTodoGateOnWindDown(opts.session.meta.id);
      } catch {
        /* */
      }
      // Phase 4: seed backlog todos from mandate for broad/soft contracts.
      let todoSeedNote = "";
      try {
        if (
          (state.backlogRequired ||
            state.softPrompt ||
            isBroadMandate(mandate)) &&
          openTodos(opts.session.todos || []) < 2
        ) {
          const seeded = todosFromMandate(mandate, { max: 12 });
          applyTodos(opts.session, seeded, false);
          todoSeedNote = chalk.dim(
            `Backlog seeded: ${seeded.length} todo(s) from mandate (edit via todo_write)`,
          );
          // Clear backlog gate if we already have ≥2
          if (seeded.length >= 2 && state.backlogRequired) {
            state.backlogRequired = false;
            saveUlwCycle(state);
          }
        }
      } catch {
        /* */
      }
      // Auto-title untitled sessions from the mandate so /sessions and resume
      // pickers stay navigable during long unattended ULW runs.
      maybeSetTitle(opts.session, mandate);
      saveSession(opts.session);
      let ulwCheckTip = "";
      try {
        const cwd =
          opts.config.workspace ||
          opts.session.meta.cwd ||
          process.cwd();
        const intel = detectProjectIntel(cwd);
        if (intel.checkCommands[0]) {
          ulwCheckTip = chalk.dim(
            `Preferred checks: ${intel.checkCommands.slice(0, 3).join(" · ")}  ·  proof-demand requires green`,
          );
        }
      } catch {
        /* */
      }
      const capTip =
        state.maxWaves == null
          ? chalk.dim(
              "Tip: /max-waves N and /budget are spend valves — decision memory holds intent across waves.",
            )
          : "";
      const banner = [
        chalk.magenta("⚡ ULW ON") +
          chalk.dim(
            `  ${formatUlwCounts(state)} (CONTINUE)  soft=${state.softPrompt ? "yes" : "no"}` +
              (state.backlogRequired ? "  backlog-gate" : ""),
          ),
        chalk.dim(
          "Soft prompts still drive the harness: research → waves → serendipity → review → repeat.",
        ),
        chalk.cyan(ULW_LIVE_CONTROLS_HINT),
        ulwCheckTip,
        todoSeedNote,
        capTip,
        formatUlwStatus(state),
        chalk.dim(formatMemoryStatus(opts.session.meta.id).split("\n")[0]),
      ]
        .filter(Boolean)
        .join("\n");
      // Always forward an expanded kickoff so even bare `/ulw` or soft text runs the cycle
      return {
        handled: true,
        forwardPrompt: ulwKickoffMessage(state),
        output: banner,
        session: opts.session,
      };
    }

    case "/paste": {
      const { saveClipboardImage } = await import("../util/clipboard.js");
      const shot = saveClipboardImage();
      if (!shot.ok) {
        return {
          handled: true,
          output: `Clipboard paste failed: ${shot.error}`,
          session: opts.session,
        };
      }
      const prompt = `[[image:${shot.path}]] Please inspect the attached clipboard image and use it for the current task.`;
      return {
        handled: true,
        forwardPrompt: prompt,
        queueInterjection: prompt,
        output: chalk.dim(
          `Pasted clipboard image (${shot.backend}): [[image:${shot.path}]]`,
        ),
        session: opts.session,
      };
    }

    case "/attach": {
      const p = arg.trim().replace(/^["']|["']$/g, "");
      if (!p) {
        return {
          handled: true,
          output:
            "Usage: /attach path/to.png\n" +
            "Or put [[image:path]] or @path.png in your message for vision models.",
          session: opts.session,
        };
      }
      return {
        handled: true,
        forwardPrompt: `[[image:${p}]] Please inspect the attached image and use it for the current task.`,
        output: chalk.dim(`Attached image marker: [[image:${p}]]`),
        session: opts.session,
      };
    }

    case "/memory":
    case "/decisions": {
      const sid = opts.session.meta.id;
      const workspace =
        opts.config.workspace || opts.session.meta.cwd || process.cwd();
      const sub = arg.trim();
      if (
        sub === "project" ||
        sub.startsWith("project ") ||
        sub === "proj" ||
        sub.startsWith("proj ")
      ) {
        const rest = sub.replace(/^proj(ect)?\s*/i, "").trim();
        if (!rest || rest === "list" || rest === "status") {
          return {
            handled: true,
            output: formatProjectMemoryStatus(workspace),
            session: opts.session,
          };
        }
        if (rest === "clear" || rest === "reset") {
          const n = clearProjectMemory(workspace);
          return {
            handled: true,
            output: `Archived ${n} project memory record(s)\n${formatProjectMemoryStatus(workspace)}`,
            session: opts.session,
          };
        }
        const rm = rest.match(/^(?:rm|remove|archive)\s+([\s\S]+)$/i);
        if (rm) {
          const n = archiveProjectMemory(workspace, rm[1].trim());
          return {
            handled: true,
            output: n
              ? `Archived ${n} project record(s)\n${formatProjectMemoryStatus(workspace)}`
              : `No match: ${rm[1].trim()}`,
            session: opts.session,
          };
        }
        const add = rest.match(
          /^(?:add|note|constraint|priority|gotcha|convention|fact|decision)\s+([\s\S]+)$/i,
        );
        if (add) {
          const kindHint = rest.split(/\s+/)[0].toLowerCase();
          const kind = normalizeProjectMemoryKind(
            ["add", "note"].includes(kindHint) ? "fact" : kindHint,
          );
          const rec = appendProjectMemory(workspace, {
            kind,
            text: add[1].trim(),
            source: "user",
          });
          return {
            handled: true,
            output: rec
              ? `Project recorded [${rec.kind}] ${rec.text}\n${formatProjectMemoryStatus(workspace)}`
              : `No-op (duplicate)\n${formatProjectMemoryStatus(workspace)}`,
            session: opts.session,
          };
        }
        const rec = appendProjectMemory(workspace, {
          kind: "fact",
          text: rest,
          source: "user",
        });
        return {
          handled: true,
          output: rec
            ? `Project recorded [fact] ${rec.text}\n${formatProjectMemoryStatus(workspace)}`
            : `No-op (duplicate)\n${formatProjectMemoryStatus(workspace)}`,
          session: opts.session,
        };
      }
      if (!sub || sub === "list" || sub === "status") {
        return {
          handled: true,
          output: `${formatMemoryStatus(sid)}\n\n${formatProjectMemoryStatus(workspace)}`,
          session: opts.session,
        };
      }
      if (sub === "seed" || sub.startsWith("seed ")) {
        const ulw = loadUlwCycle(sid);
        const mandate =
          sub.slice(4).trim() || ulw?.mandate || "improve the codebase";
        const r = seedMemoryFromMandate(sid, mandate, {
          softPrompt: ulw?.softPrompt,
          force: true,
        });
        return {
          handled: true,
          output: `Seeded ${r.seeded} record(s)\n${formatMemoryStatus(sid)}`,
          session: opts.session,
        };
      }
      const addMatch = sub.match(
        /^(?:add|note|constraint|priority)\s+([\s\S]+)$/i,
      );
      if (addMatch) {
        const kindHint = sub.split(/\s+/)[0].toLowerCase();
        const kind =
          kindHint === "priority"
            ? "priority"
            : kindHint === "constraint"
              ? "constraint"
              : "decision";
        const rec = appendMemoryRecord(sid, {
          kind: kind as "priority" | "constraint" | "decision",
          text: addMatch[1].trim(),
          source: "user",
        });
        return {
          handled: true,
          output: rec
            ? `Recorded [${rec.kind}] ${rec.text}\n${formatMemoryStatus(sid)}`
            : `No-op (duplicate)\n${formatMemoryStatus(sid)}`,
          session: opts.session,
        };
      }
      const rec = appendMemoryRecord(sid, {
        kind: "decision",
        text: sub,
        source: "user",
      });
      return {
        handled: true,
        output: rec
          ? `Recorded [decision] ${rec.text}\n${formatMemoryStatus(sid)}`
          : `No-op (duplicate)\n${formatMemoryStatus(sid)}`,
        session: opts.session,
      };
    }


    case "/ulw-off": {
      const sid = opts.session.meta.id;
      opts.session.meta.ultrawork = false;
      disarmUlwCycle(sid);
      // Parity with /done: reset soft TodoGate so disarm is not followed by a
      // leftover once-block for open todos the user is intentionally ending.
      try {
        clearSoftTodoGateOnWindDown(sid);
      } catch {
        /* */
      }
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
          editCount: opts.session.meta.editCount,
        });
        saveSession(opts.session);
      }
      if (flag === 1) {
        pushLiveNotice(
          sid,
          "User set cycle=1 (CONTINUE) mid-run. Keep the research → implement → serendipity → review loop. Do not stop until the user sets cycle=0, max_waves is hit, or /ulw-off.",
        );
      } else {
        // LAST wind-down: reset soft TodoGate so leftover open-todo once-blocks
        // do not fight the intentional cycle=0 finish path (parity with /done).
        try {
          clearSoftTodoGateOnWindDown(sid);
        } catch {
          /* */
        }
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
      let cycleTip = "";
      if (flag === 0) {
        try {
          const cwd =
            opts.config.workspace ||
            opts.session.meta.cwd ||
            process.cwd();
          const intel = detectProjectIntel(cwd);
          if (intel.checkCommands[0]) {
            cycleTip =
              "\n" +
              chalk.dim(
                `Preferred checks before **Cycle complete.**: ${intel.checkCommands.slice(0, 3).join(" · ")}  ·  proof needs green`,
              );
          }
          const trail = formatSlashSessionTrail(opts.session.meta);
          if (trail) cycleTip += "\n" + chalk.dim(`  ${trail}`);
        } catch {
          /* */
        }
      }
      return {
        handled: true,
        output:
          `${msg}\n${formatUlwStatus(state)}` +
          chalk.dim(
            "\n  (flag written now — stop-guard honors it on next Stop; agent notified on next model call)",
          ) +
          cycleTip,
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
          editCount: opts.session.meta.editCount,
        });
        saveSession(opts.session);
      }
      const flippedToLast =
        state.cycle === 0 &&
        parsed != null &&
        state.wave >= (state.maxWaves ?? Infinity);
      // Live notice when setMaxWaves immediately flipped CONTINUE → LAST
      if (flippedToLast) {
        try {
          pushLiveNotice(
            sid,
            `User set /max-waves ${parsed} at/under current wave ${state.wave} — ULW flipped to cycle=0 (LAST). Finish this wave and attest **Cycle complete.**`,
          );
        } catch {
          /* */
        }
      }
      const capLabel =
        state.maxWaves != null ? String(state.maxWaves) : "off (unlimited)";
      if (state.maxWaves != null && !flippedToLast) {
        pushLiveNotice(
          sid,
          `User set max_waves=${state.maxWaves} mid-run. ${formatCappedWaveDoctrine(state.maxWaves, state.mandate)} When the wave counter reaches ${state.maxWaves}, auto-flip to LAST: finish that wave, review, attest **Cycle complete.** Do not start a new ambitious wave after the cap.`,
        );
      } else if (state.maxWaves == null) {
        pushLiveNotice(
          sid,
          "User cleared max_waves mid-run (unlimited). Cycle flag still controls CONTINUE vs LAST.",
        );
      }
      let maxWavesTip = "";
      if (flippedToLast) {
        try {
          const cwd =
            opts.config.workspace ||
            opts.session.meta.cwd ||
            process.cwd();
          const intel = detectProjectIntel(cwd);
          if (intel.checkCommands[0]) {
            maxWavesTip =
              "\n" +
              chalk.dim(
                `Preferred checks before **Cycle complete.**: ${intel.checkCommands.slice(0, 3).join(" · ")}  ·  proof needs green`,
              );
          }
          const trail = formatSlashSessionTrail(opts.session.meta);
          if (trail) maxWavesTip += "\n" + chalk.dim(`  ${trail}`);
        } catch {
          /* */
        }
      }
      return {
        handled: true,
        output:
          chalk.magenta(`max_waves=${capLabel}`) +
          (flippedToLast
            ? chalk.yellow(
                `  → cycle=0 (LAST) now (wave ${state.wave} ≥ cap ${state.maxWaves})`,
              )
            : "") +
          "\n" +
          formatUlwStatus(state) +
          chalk.dim(
            flippedToLast
              ? "\n  (cap written + LAST applied immediately; finish wave + **Cycle complete.**)"
              : "\n  (cap written now — stop-guard honors it on next Stop; agent notified on next model call)",
          ) +
          maxWavesTip,
        session: opts.session,
      };
    }

    case "/hooks": {
      const sub = (arg || "").trim().toLowerCase();
      const cwd =
        opts.config.workspace || opts.session.meta.cwd || process.cwd();
      if (sub === "init" || sub === "scaffold" || sub === "new") {
        const dir = path.join(cwd, ".forge", "hooks");
        const target = path.join(dir, "example-stop.json");
        try {
          fs.mkdirSync(dir, { recursive: true });
          if (fs.existsSync(target)) {
            return {
              handled: true,
              output: `Already exists: ${target}\nThen: /hooks reload`,
            };
          }
          const sample = {
            hooks: {
              Stop: [
                {
                  matcher: "*",
                  hooks: [
                    {
                      type: "command",
                      command: 'echo \'{"decision":"allow"}\'',
                      timeout: 10,
                    },
                  ],
                },
              ],
            },
          };
          fs.writeFileSync(target, JSON.stringify(sample, null, 2) + "\n", {
            encoding: "utf8",
            mode: 0o600,
          });
          opts.hooks.reload();
          return {
            handled: true,
            output: [
              `Wrote ${target}`,
              `Blocking Stop: ${isFalsy(opts.config.blockingStopHooks) ? "OFF" : "ON"}`,
            ].join("\n"),
          };
        } catch (err) {
          return {
            handled: true,
            output: `hooks init failed: ${String((err as Error)?.message || err).slice(0, 300)}`,
          };
        }
      }
      if (sub === "reload" || sub === "refresh") {
        opts.hooks.reload();
        const list = opts.hooks.list();
        const n = Object.values(list).reduce((a, b) => a + b, 0);
        const body = Object.entries(list)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");
        return {
          handled: true,
          output:
            `Reloaded hooks (${n} matcher(s)).\n` +
            (body || "(none)"),
        };
      }
      const list = opts.hooks.list();
      const lines = Object.entries(list).map(
        ([k, v]) => `  ${k}: ${v} matcher(s)`,
      );
      return {
        handled: true,
        output:
          (lines.length > 0
            ? `Loaded hooks:\n${lines.join("\n")}\n`
            : `No hooks loaded.\n`) +
          `Paths: .forge/hooks/*.json  ·  ~/.forge/hooks/*.json\n` +
          `Commands: /hooks init  ·  /hooks reload\n` +
          `Blocking Stop: ${isFalsy(opts.config.blockingStopHooks) ? "OFF" : "ON"}`,
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
        maxCostUsd: opts.config.maxCostUsd,
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
      // Surface plan on its own line so quota/reset is never lost in width-shed
      let planLine = "";
      if (snap.plan) {
        const { formatPlan } = await import("../statusline/render.js");
        const p = formatPlan(snap.plan, Boolean(process.stdout.isTTY));
        if (p) {
          planLine =
            chalk.dim("plan     ") +
            p +
            (snap.plan.product ? chalk.dim(`  · ${snap.plan.product}`) : "") +
            (snap.plan.source ? chalk.dim(`  (${snap.plan.source})`) : "") +
            "\n";
        } else if (snap.plan.note) {
          planLine = chalk.dim(`plan     ${snap.plan.note}\n`);
        }
      }
      const detail = formatSessionDetails({
        config: opts.config,
        session: opts.session,
        auth,
        plan: snap.plan,
      });
      let stackBits: string[] = [];
      try {
        const cwd =
          opts.config.workspace ||
          opts.session.meta.cwd ||
          process.cwd();
        const intel = detectProjectIntel(cwd);
        if (intel.checkCommands[0] || intel.packageManager) {
          stackBits.push(
            `stack: ${[
              intel.packageManager || null,
              intel.checkCommands.slice(0, 3).join(" · ") || null,
            ]
              .filter(Boolean)
              .join(" · ")}`,
          );
        }
        const last = opts.session.meta.lastVerificationCommand?.trim();
        if (last) {
          const stale = isLastVerificationStale(opts.session.meta)
            ? "  ⚠ stale (edits after verify)"
            : "";
          stackBits.push(
            `last-verify: ${last.slice(0, 80)}${last.length > 80 ? "…" : ""}${stale}`,
          );
        } else if ((opts.session.meta.editCount || 0) > 0) {
          const tip =
            intel.checkCommands[0] || "npm test / typecheck";
          stackBits.push(
            chalk.yellow(
              `no last-verify after ${opts.session.meta.editCount} edit(s) — prefer \`${tip}\``,
            ),
          );
        }
      } catch {
        /* */
      }
      return {
        handled: true,
        output:
          hud +
          "\n" +
          planLine +
          detail +
          (stackBits.length
            ? "\n" +
              stackBits
                .map((b) =>
                  // yellow no-verify line already chalked; dim the rest
                  b.includes("no last-verify")
                    ? `  ${b}`
                    : chalk.dim(`  ${b}`),
                )
                .join("\n")
            : "") +
          chalk.dim(
            "\n\nTip: status is always on the prompt line. Live external pane still available: forge status --watch",
          ),
      };
    }

    case "/mcp": {
      const workspace =
        opts.config.workspace || opts.session.meta.cwd || process.cwd();
      const {
        getActiveMcpManager,
        setActiveMcpManager,
        formatMcpStatus,
        McpManager,
      } = await import("../mcp/manager.js");
      let manager = getActiveMcpManager();
      if (!manager) {
        manager = new McpManager({ workspace });
        manager.start();
        setActiveMcpManager(manager);
      }
      const verb = (arg || "").trim().toLowerCase().split(/\s+/)[0] || "status";
      if (verb === "connect" || verb === "start" || verb === "reload") {
        if (verb === "reload") {
          await manager.dispose().catch(() => {});
          manager = new McpManager({ workspace });
          manager.start();
          setActiveMcpManager(manager);
        }
        const statuses = await manager.connectAll();
        const ready = statuses.filter((s) => s.state === "ready").length;
        const errN = statuses.filter((s) => s.state === "error").length;
        return {
          handled: true,
          output:
            `MCP connect: ${ready} ready, ${errN} error(s), ${statuses.length} configured.\n` +
            formatMcpStatus(manager),
        };
      }
      if (verb === "tools") {
        await manager.ensureRegistry().catch(() => {});
        return { handled: true, output: formatMcpStatus(manager) };
      }
      // status / list / default
      return { handled: true, output: formatMcpStatus(manager) };
    }

    case "/lsp": {
      const workspace =
        opts.config.workspace || opts.session.meta.cwd || process.cwd();
      const {
        getActiveLspManager,
        setActiveLspManager,
        formatLspStatus,
        LspManager,
      } = await import("../lsp/manager.js");
      let manager = getActiveLspManager();
      if (!manager) {
        manager = new LspManager({ workspace });
        setActiveLspManager(manager);
      }
      const verb = (arg || "").trim().toLowerCase().split(/\s+/)[0] || "status";
      if (verb === "restart" || verb === "reload") {
        await manager.dispose().catch(() => {});
        manager = new LspManager({ workspace });
        setActiveLspManager(manager);
        return {
          handled: true,
          output: "LSP managers restarted (servers start lazily on next use).\n" +
            formatLspStatus(manager),
        };
      }
      if (verb === "install" || verb === "setup" || verb === "help") {
        const { formatFullInstallGuide } = await import("../lsp/ensure.js");
        return {
          handled: true,
          output: formatFullInstallGuide(workspace),
        };
      }
      if (verb === "ensure" || verb === "fix" || verb === "auto") {
        const {
          ensureLspServers,
          formatEnsureResult,
          formatEnsurePlan,
          buildEnsurePlan,
        } = await import("../lsp/ensure.js");
        const rest = (arg || "").trim().toLowerCase();
        const dry =
          /\b(dry|dry-run|--dry-run|-n)\b/.test(rest) ||
          rest.split(/\s+/).includes("plan");
        if (dry) {
          return {
            handled: true,
            output: formatEnsurePlan(buildEnsurePlan(workspace)),
          };
        }
        const lines: string[] = [];
        const result = await ensureLspServers({
          workspace,
          forceInstall: true,
          onLog: (line) => lines.push(line),
        });
        return {
          handled: true,
          output:
            (lines.length ? lines.join("\n") + "\n\n" : "") +
            formatEnsureResult(result),
        };
      }
      if (verb === "detect") {
        const { detectProjectLanguages } = await import("../lsp/detect.js");
        const { buildEnsurePlan, formatEnsurePlan } = await import(
          "../lsp/ensure.js"
        );
        const detected = detectProjectLanguages(workspace);
        const detLines = detected.map(
          (d) =>
            `  ${d.languageId}  [${d.tier}]  ${d.reasons.slice(0, 2).join("; ")}`,
        );
        return {
          handled: true,
          output:
            "Detected languages:\n" +
            (detLines.length ? detLines.join("\n") : "  (none)") +
            "\n\n" +
            formatEnsurePlan(buildEnsurePlan(workspace)),
        };
      }
      return { handled: true, output: formatLspStatus(manager) };
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
      
      let subBlock = "";
      try {
        const { listActiveSubagents } = await import("../agent/subagent.js");
        const subs = listActiveSubagents();
        if (subs.length) {
          const lines = [
            "",
            chalk.bold("Active subagents") +
              chalk.dim(`  (${subs.length} in this process)`),
          ];
          for (const s of subs) {
            const age = Math.max(
              0,
              Math.round((Date.now() - s.startedAt) / 1000),
            );
            lines.push(
              `  · ${s.type}${s.isolation === "worktree" ? " [worktree]" : ""}  ${s.description}  ${chalk.dim(`${age}s`)}`,
            );
          }
          subBlock = lines.join("\n") + "\n";
        }
      } catch {
        /* */
      }
return {
        handled: true,
        output:
          `${header}\n${formatBackgroundTasksList()}\n` +
          subBlock +
          chalk.dim(
            "Agent: bash { background: true } · get_task_output wait= · /tasks kill <id> · /tasks log <id> [tail] · exit force-kills leftovers",
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
            const rel = displayRelPath(ws, p);
            return path.isAbsolute(rel)
              ? p.replace(process.env.HOME || "", "~")
              : rel;
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
      // Skill packs (builtin + project/user) — estimate matches prompt injection
      let skillsNote = "";
      try {
        const { loadProjectSkills, formatSkillsForPrompt } = await import(
          "../agent/project-skills.js"
        );
        const ws = opts.config.workspace || process.cwd();
        const skills = loadProjectSkills(ws);
        if (skills.length) {
          const labels = skills.slice(0, 8).map((s) => {
            const rel = displayRelPath(ws, s.filePath);
            const loc = path.isAbsolute(rel)
              ? s.filePath.replace(process.env.HOME || "", "~")
              : rel;
            return `${s.name} [${s.source}]${s.description ? ` — ${s.description.slice(0, 36)}` : ""} (${loc})`;
          });
          const more =
            skills.length > 8 ? ` (+${skills.length - 8} more)` : "";
          const injected = formatSkillsForPrompt(ws);
          skillsNote =
            `\nSkills (~${formatTokens(estimateTokens([{ role: "system", content: injected }]))} injected; /skills):\n` +
            labels.map((l) => `  · ${l}`).join("\n") +
            more;
        } else {
          skillsNote = `\nSkills: none  (tip: skills/forge-* · .forge/skills/<name>/SKILL.md · /skills)`;
        }
      } catch {
        /* */
      }
      // Project intelligence (package manager + preferred check commands)
      let projectNote = "";
      try {
        const { detectProjectIntel } = await import("../util/project-intel.js");
        const ws = opts.config.workspace || process.cwd();
        const intel = detectProjectIntel(ws);
        if (
          intel.packageManager ||
          intel.kinds.length ||
          intel.checkCommands.length ||
          intel.packageName ||
          intel.workspaces?.length
        ) {
          const head: string[] = [];
          if (intel.packageName) {
            head.push(
              intel.packageVersion
                ? `${intel.packageName}@${intel.packageVersion}`
                : intel.packageName,
            );
          }
          if (intel.packageManager) head.push(`pm=${intel.packageManager}`);
          if (intel.kinds.length) head.push(intel.kinds.join("+"));
          const cmds = intel.checkCommands.length
            ? `\n  checks: ${intel.checkCommands.slice(0, 6).join("  ·  ")}`
            : "";
          const ws = intel.workspaces?.length
            ? `\n  workspaces: ${intel.workspaces.slice(0, 6).join("  ·  ")}` +
              (intel.workspaces.length > 6
                ? ` (+${intel.workspaces.length - 6} more)`
                : "")
            : "";
          const mono = intel.monorepoRoot
            ? `\n  monorepo-root: ${intel.monorepoRoot}`
            : "";
          projectNote =
            `\nProject stack: ${head.join(" · ") || "(detected)"}${cmds}${ws}${mono}` +
            `\n  (injected into system prompt · agent prefers these for verification)`;
        } else {
          projectNote = `\nProject stack: none detected`;
        }
      } catch {
        /* */
      }
      const thresholdPct = Math.round(
        (opts.config.autoCompactThreshold || 0.8) * 100,
      );
      let pressureNote = "";
      if (pct >= 92) {
        pressureNote =
          chalk.yellow(
            `\nPressure: HARD (~${pct}%) — auto headroom compact may fire. Tip: /compact · /compact-and <next> · /new · raise context_window`,
          );
      } else if (pct >= thresholdPct) {
        pressureNote =
          chalk.yellow(
            `\nPressure: above auto-compact threshold (${thresholdPct}%). Tip: /compact · /compact-and <next> · /context after compact`,
          );
      } else if (pct >= Math.max(50, thresholdPct - 15)) {
        pressureNote = chalk.dim(
          `\nPressure: elevated (~${pct}%; auto-compact @${thresholdPct}%). Tip: /compact before a long ULW wave`,
        );
      }
      let memoryNote = "";
      try {
        const n = listActiveProjectMemory(
          opts.config.workspace || process.cwd(),
        ).length;
        memoryNote =
          n > 0
            ? `\nProject memory: ${n} active note${n === 1 ? "" : "s"}  · /memory project`
            : `\nProject memory: none  · /memory project add …`;
      } catch {
        /* */
      }
      return {
        handled: true,
        output: `Context  [${bar}] ${pct}%\n  ~${formatTokens(est)} / ${formatTokens(opts.config.contextWindow)}  autoCompact@${thresholdPct}%\nBy role:\n${roleLines}${projectNote}${rulesNote}${skillsNote}${memoryNote}${pressureNote}`,
      };
    }

    case "/cost": {
      const cost = estimateCostUsd(
        String(opts.config.provider),
        opts.session.meta.totalPromptTokens,
        opts.session.meta.totalCompletionTokens,
        opts.config.model,
        opts.session.meta.totalCacheReadTokens || 0,
      );
      const budget = costCapStatus(opts.config, opts.session.meta);
      const cacheRead = opts.session.meta.totalCacheReadTokens || 0;
      const prompt = opts.session.meta.totalPromptTokens || 0;
      const cacheLine =
        cacheRead > 0 && prompt > 0
          ? `  cached:      ${formatTokens(cacheRead)} (${Math.round((cacheRead / prompt) * 100)}% of prompt, cache rate)`
          : null;
      return {
        handled: true,
        output: [
          `Session usage (this session)`,
          `  prompt:      ${formatTokens(opts.session.meta.totalPromptTokens)}`,
          `  completion:  ${formatTokens(opts.session.meta.totalCompletionTokens)}`,
          cacheLine,
          `  est. cost:   ${formatCost(cost)}  (rough; not a bill)`,
          `  ${formatCostBudgetLine(budget)}`,
          `  set cap:     /budget <usd>  ·  /budget off  ·  --max-cost N  ·  FORGE_MAX_COST_USD`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    case "/budget": {
      const raw = (arg || "").trim();
      if (!raw || /^(status|show|\?)$/i.test(raw)) {
        const st = costCapStatus(opts.config, opts.session.meta);
        const sessionOverride =
          opts.session.meta.maxCostUsd !== undefined
            ? `session override=$${opts.session.meta.maxCostUsd}`
            : "session override=(none — using config/env)";
        const cfg =
          typeof opts.config.maxCostUsd === "number" && opts.config.maxCostUsd > 0
            ? `config max_cost_usd=$${opts.config.maxCostUsd}`
            : "config max_cost_usd=unlimited";
        // Orient spend decisions with session work + verify trail.
        const trail = formatSlashSessionTrail(opts.session.meta);
        const workLine = trail ? `  ${trail.replace("Session trail: ", "Session: ")}` : "";
        return {
          handled: true,
          output: [
            formatCostBudgetLine(st),
            `  ${sessionOverride}`,
            `  ${cfg}`,
            workLine,
            `  Usage: /budget <usd>  ·  /budget off  ·  /budget status`,
            `  Also:  --max-cost N  ·  FORGE_MAX_COST_USD  ·  max_cost_usd in config.toml`,
            `  Note:  estimateCostUsd only — not a bill. Cap releases the agent cleanly (hitCostCap).`,
          ]
            .filter(Boolean)
            .join("\n"),
        };
      }
      const parsed = parseCostUsd(raw);
      if (parsed === null || parsed === undefined) {
        return {
          handled: true,
          output:
            `Invalid budget "${raw}". Pass a USD amount (e.g. 5, $2.50) or off/0 for unlimited.`,
        };
      }
      if (parsed === 0) {
        // Explicit unlimited override for this session (shadows config cap).
        opts.session.meta.maxCostUsd = 0;
      } else {
        opts.session.meta.maxCostUsd = parsed;
      }
      try {
        saveSession(opts.session);
      } catch {
        /* best-effort */
      }
      // Live mid-run: tell the agent the spend valve changed so it can prioritize
      // verification / wind-down before the cap releases the loop.
      try {
        pushLiveNotice(
          opts.session.meta.id,
          parsed === 0
            ? "User cleared the session spend cap (/budget off). Continue normally — no hitCostCap release."
            : `User set session spend cap to $${parsed} (/budget). Prefer finishing the current wave and verifying before the estimate hits the cap (hitCostCap releases cleanly). Estimate only — not a bill.`,
        );
      } catch {
        /* */
      }
      const st = costCapStatus(opts.config, opts.session.meta);
      return {
        handled: true,
        output: [
          parsed === 0
            ? `Budget cleared for this session (unlimited).`
            : `Budget set to $${parsed} for this session.`,
          formatCostBudgetLine(st),
          st.hit
            ? `Already at/over cap — next turn will release with hitCostCap.`
            : `Agent releases cleanly when session est. reaches the cap.`,
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
        opts.session.meta.totalCacheReadTokens || 0,
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
        opts.session.meta.totalCacheReadTokens || 0,
      );
      let sessionExtra: string[] = [];
      try {
        const cwd =
          opts.config.workspace ||
          opts.session.meta.cwd ||
          process.cwd();
        const intel = detectProjectIntel(cwd);
        if (intel.checkCommands[0]) {
          sessionExtra.push(
            `  checks: ${intel.checkCommands.slice(0, 3).join(" · ")}` +
              (intel.packageManager ? `  (pm=${intel.packageManager})` : ""),
          );
        }
        const last = opts.session.meta.lastVerificationCommand?.trim();
        if (last) {
          const stale = isLastVerificationStale(opts.session.meta)
            ? "  ⚠ stale (edits after verify)"
            : "";
          sessionExtra.push(
            `  last-verify: ${last.slice(0, 80)}${last.length > 80 ? "…" : ""}${stale}`,
          );
        } else if ((opts.session.meta.editCount || 0) > 0) {
          const tip = intel.checkCommands[0] || "npm test / typecheck";
          sessionExtra.push(
            `  last-verify: (none after ${opts.session.meta.editCount} edit(s) — prefer \`${tip}\`)`,
          );
        }
      } catch {
        /* */
      }
      return {
        handled: true,
        output: [
          formatUsageStats(stats),
          ``,
          `This session:`,
          `  tokens: in=${formatTokens(opts.session.meta.totalPromptTokens)} out=${formatTokens(opts.session.meta.totalCompletionTokens)} · est ${formatCost(cost)}`,
          `  turns:  ${opts.session.meta.turnCount}  edits=${opts.session.meta.editCount}  id=${opts.session.meta.id.slice(0, 8)}`,
          ...sessionExtra,
          chalk.dim(`CLI: forge stats [--days N] [--json]`),
        ].join("\n"),
      };
    }

    case "/todos": {
      if (opts.session.todos.length === 0) {
        let tip = "";
        try {
          const cwd =
            opts.config.workspace ||
            opts.session.meta.cwd ||
            process.cwd();
          const intel = detectProjectIntel(cwd);
          if (intel.checkCommands[0]) {
            tip =
              `\nTip: agent uses todo_write for multi-step work. Preferred check: \`${intel.checkCommands[0]}\``;
          } else {
            tip =
              "\nTip: agent uses todo_write for multi-step work (id/content/status).";
          }
        } catch {
          tip =
            "\nTip: agent uses todo_write for multi-step work (id/content/status).";
        }
        return {
          handled: true,
          output: "No todos." + tip,
        };
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
        // Cross-provider switch: a token-only hot-swap would pair the new
        // bearer with the old provider's baseUrl (guaranteed 401s). Run the
        // /provider switch so config/session/sticky provider realign and the
        // REPL rebuilds the client (parity with `forge accounts switch`, which
        // saves the sticky provider at cli.ts).
        if (String(hit.account.provider) !== String(opts.config.provider)) {
          const note = `Active ${hit.account.provider} → ${r.toLabel || r.toId}`;
          const realigned = await handleProviderSlash(
            String(hit.account.provider),
            opts,
          );
          return {
            ...realigned,
            output: note + (realigned.output ? `\n${realigned.output}` : ""),
          };
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

    case "/provider": {
      return handleProviderSlash(arg, opts);
    }

    case "/model": {
      return handleModelSlash(arg, opts);
    }

    case "/fallback": {
      return handleFallbackSlash(arg, opts);
    }

    case "/temperature":
    case "/temp": {
      return handleTemperatureSlash(arg, opts);
    }

    case "/max-tokens":
    case "/maxtokens":
    case "/max_tokens": {
      return handleMaxTokensSlash(arg, opts);
    }

    case "/context-window":
    case "/ctx-window":
    case "/context_window": {
      return handleContextWindowSlash(arg, opts);
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
              "Effort is sent for models that expose thinking controls " +
                "(e.g. grok-4.6, grok-4.5, deepseek-v4-*, many OpenRouter reasoning models). " +
                "Default is each model’s maximum allowed level.",
            ),
        };
      }
      const levels = effortLevelsForModel(model);
      const maxLvl = defaultEffortForModel(model);
      const choices = levels.map((e) => ({
        value: e,
        description:
          REASONING_EFFORT_DESCRIPTIONS[e] +
          (e === maxLvl ? " ← model max (default)" : ""),
      }));
      const current =
        resolveReasoningEffort(model, opts.config.reasoningEffort) ??
        defaultEffortForModel(model);
      if (!arg) {
        let orient = formatSlashVerifyOrient({
          workspace: opts.config.workspace,
          cwd: opts.session.meta.cwd,
          editCount: opts.session.meta.editCount,
          lastVerificationCommand: opts.session.meta.lastVerificationCommand,
          lastVerificationAt: opts.session.meta.lastVerificationAt,
          lastEditAt: opts.session.meta.lastEditAt,
        });
        if (orient) {
          orient = orient
            .split("\n")
            .map((line) => {
              if (!line) return line;
              return /No last-verify after/.test(line)
                ? chalk.yellow(line)
                : chalk.dim(line);
            })
            .join("\n");
        }
        return {
          handled: true,
          output:
            formatParamMenu("/effort", choices, current) +
            orient +
            chalk.dim(
              `\nDefault: ${maxLvl} (max for this model)  ·  aliases: l/low m/med h/high max xhigh  ·  live`,
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
      opts.session.messages = compactMessages(opts.session.messages, DEFAULT_CHECKPOINT_KEEP_STEPS, {
        ulw,
        goal,
        todos: opts.session.todos,
        sessionId: opts.session.meta.id,
        cwd: opts.config.workspace || opts.session.meta.cwd,
        lastVerificationCommand: opts.session.meta.lastVerificationCommand,
        lastVerificationAt: opts.session.meta.lastVerificationAt,
        lastEditAt: opts.session.meta.lastEditAt,
      });
      rebuildUserTurnMarks(opts.session);
      saveSession(opts.session);
      let compactNote = "";
      try {
        const last = opts.session.meta.lastVerificationCommand?.trim();
        if (last) {
          compactNote = isLastVerificationStale(opts.session.meta)
            ? `\n  Last verify stale: \`${last.slice(0, 60)}\` — re-run after compact if you keep editing.`
            : `\n  Last verify: \`${last.slice(0, 60)}\` (preserved in summary)`;
        } else if ((opts.session.meta.editCount || 0) > 0) {
          const cwd =
            opts.config.workspace ||
            opts.session.meta.cwd ||
            process.cwd();
          const intel = detectProjectIntel(cwd);
          const tip = intel.checkCommands[0] || "npm test / typecheck";
          compactNote = `\n  No last-verify after ${opts.session.meta.editCount} edit(s) — prefer \`${tip}\``;
        }
      } catch {
        /* */
      }
      return {
        handled: true,
        output:
          `Compacted ${before} → ${opts.session.messages.length} messages (structured harness summary; project checks preserved)` +
          compactNote,
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
      opts.session.messages = compactMessages(opts.session.messages, DEFAULT_CHECKPOINT_KEEP_STEPS, {
        ulw,
        goal,
        todos: opts.session.todos,
        sessionId: opts.session.meta.id,
        cwd: opts.config.workspace || opts.session.meta.cwd,
        lastVerificationCommand: opts.session.meta.lastVerificationCommand,
        lastVerificationAt: opts.session.meta.lastVerificationAt,
        lastEditAt: opts.session.meta.lastEditAt,
      });
      rebuildUserTurnMarks(opts.session);
      saveSession(opts.session);
      const preview =
        follow.length > 120 ? `${follow.slice(0, 117).trimEnd()}…` : follow;
      let compactNote = "";
      try {
        const last = opts.session.meta.lastVerificationCommand?.trim();
        if (last) {
          compactNote = isLastVerificationStale(opts.session.meta)
            ? `\n  Last verify stale: \`${last.slice(0, 60)}\``
            : `\n  Last verify: \`${last.slice(0, 60)}\``;
        }
      } catch {
        /* */
      }
      return {
        handled: true,
        output:
          `Compacted ${before} → ${opts.session.messages.length} messages, continuing…\n→ ${preview}` +
          compactNote,
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

    case "/setup": {
      const action = parseSetupAction(arg);
      if (action.kind === "skip") {
        markSetupSkipped();
        return {
          handled: true,
          output: "Setup compact line hidden. /setup still works anytime.",
        };
      }
      if (action.kind === "help") {
        return {
          handled: true,
          output:
            "Usage: /setup [skip|json|model|budget N|init|notify|lsp|scaffold]\n" +
            "  Numbered: /setup 1 … 6   ·   forge setup --json",
        };
      }
      const assessed = await collectSetupAssessment({
        config: opts.config,
        session: opts.session,
        auth: opts.auth ?? null,
      });
      if (action.kind === "json") {
        markSetupSeen();
        return {
          handled: true,
          output: JSON.stringify(
            setupJsonPayload(assessed, {
              forgeHome: forgeHome(),
              provider: opts.config.provider,
              model: opts.config.model,
            }),
            null,
            2,
          ),
        };
      }
      if (action.kind === "card") {
        markSetupSeen();
        return { handled: true, output: formatSetupCard(assessed) };
      }
      if (action.kind === "model") {
        markProviderModelConfirmed();
        return {
          handled: true,
          output:
            `Provider/model confirmed: ${opts.config.provider}/${opts.config.model}\n` +
            `  Switch with /provider  ·  /model   ·   /setup to refresh the card`,
        };
      }
      if (action.kind === "budget") {
        if (!action.amount) {
          return {
            handled: true,
            output:
              "Spend cap USD [5 / 20 / off / custom]\n" +
              "  /setup budget 5\n" +
              "  /setup budget 20\n" +
              "  /setup budget off\n" +
              "  Session-only (same as /budget). Persist via max_cost_usd in ~/.forge/config.toml",
          };
        }
        const parsed = parseCostUsd(action.amount);
        if (parsed === null || parsed === undefined) {
          return {
            handled: true,
            output: `Invalid budget "${action.amount}". Pass a USD amount (e.g. 5) or off.`,
          };
        }
        opts.session.meta.maxCostUsd = parsed;
        try {
          saveSession(opts.session);
        } catch {
          /* */
        }
        return {
          handled: true,
          output:
            parsed === 0
              ? "Spend cap OFF for this session (unlimited)."
              : `Spend cap $${parsed} for this session. Persist in ~/.forge/config.toml (max_cost_usd).`,
          session: opts.session,
        };
      }
      if (action.kind === "init") {
        const focus = action.focus || "";
        const prompt = buildInitAgentsPrompt(
          focus,
          opts.config.workspace || opts.session.meta.cwd || process.cwd(),
        );
        markSetupSeen();
        return {
          handled: true,
          output: focus
            ? `Initializing / improving AGENTS.md (focus: ${focus.slice(0, 80)})…`
            : "Initializing / improving AGENTS.md for this repository…",
          forwardPrompt: prompt,
          session: opts.session,
        };
      }
      if (action.kind === "notify") {
        savePreferences({ notifyOnTurnEnd: true });
        return {
          handled: true,
          output:
            "Turn-end desktop notify ON (persisted). Also: /bell on  ·  FORGE_NOTIFY=0 overrides.",
        };
      }
      if (action.kind === "lsp") {
        const workspace =
          opts.config.workspace || opts.session.meta.cwd || process.cwd();
        const {
          ensureLspServers,
          formatEnsureResult,
        } = await import("../lsp/ensure.js");
        const lines: string[] = [];
        const result = await ensureLspServers({
          workspace,
          forceInstall: true,
          onLog: (line) => lines.push(line),
        });
        return {
          handled: true,
          output:
            (lines.length ? lines.join("\n") + "\n\n" : "") +
            formatEnsureResult(result),
        };
      }
      if (action.kind === "scaffold") {
        const { runForgeInit, formatInitScaffoldSummary } = await import(
          "./init-scaffold.js"
        );
        const result = await runForgeInit({
          cwd: opts.config.workspace || opts.session.meta.cwd || process.cwd(),
          quiet: true,
        });
        markSetupSeen();
        return {
          handled: true,
          output: formatInitScaffoldSummary(result),
        };
      }
      return { handled: true, output: formatSetupCard(assessed) };
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
      const prompt = buildReviewPrompt(target, cwd, {
        lastVerificationCommand: opts.session.meta.lastVerificationCommand,
      });
      return {
        handled: true,
        output: `Reviewing ${target === "uncommitted" ? "uncommitted changes" : target}…`,
        forwardPrompt: prompt,
        session: opts.session,
      };
    }

    case "/commit": {
      // Draft a commit message from the working tree / index. Never force-push.
      // Default is draft-only; "do" / "run" / "create" opts into creating the commit.
      // Prefer explicit workspace config (tests / multi-root) over session cwd.
      const cwd =
        opts.config.workspace || opts.session.meta.cwd || process.cwd();
      const raw = (arg || "").trim().toLowerCase();
      const tokens = raw ? raw.split(/\s+/).filter(Boolean) : [];
      const doCommit = tokens.some((t) =>
        ["do", "run", "create", "make", "yes", "commit"].includes(t),
      );
      const stagedOnly = tokens.some((t) =>
        ["staged", "index", "cached"].includes(t),
      );
      if (tokens.some((t) => t.startsWith("-"))) {
        return {
          handled: true,
          output:
            "Usage: /commit [staged] [do]\n" +
            "  (empty)  draft message from unstaged+staged diff (no git commit)\n" +
            "  staged   draft from index only\n" +
            "  do       after drafting, create the commit (no push)\n",
        };
      }
      // Plan mode hard-denies bash/git — refuse do, allow draft-only.
      if (doCommit && opts.config.permissionMode === "plan") {
        return {
          handled: true,
          output:
            "Plan mode cannot create commits (bash/git denied). " +
            "Run `/commit` to draft a message, then `exit_plan_mode` or `/build` (or leave plan) and `/commit do`.",
        };
      }
      // Fail closed outside a git work tree / clean tree (avoid a useless model turn).
      try {
        const { execFileSync } = await import("node:child_process");
        execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        });
        const porcelain = execFileSync(
          "git",
          stagedOnly
            ? ["diff", "--cached", "--name-only"]
            : ["status", "--porcelain"],
          {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 8_000,
          },
        ).trim();
        if (!porcelain) {
          return {
            handled: true,
            output: stagedOnly
              ? "Nothing staged. Stage files (`git add …`) or run `/commit` without `staged`."
              : "Working tree clean — nothing to commit. Make changes (or stage them) first.",
          };
        }
      } catch (err) {
        const msg = String((err as Error)?.message || err);
        if (/not a git repository/i.test(msg) || /Not a git repository/i.test(msg)) {
          return {
            handled: true,
            output:
              `Not a git repository: ${cwd}\n` +
              `Initialize with \`git init\` (or cd into a work tree) before /commit.`,
          };
        }
        // rev-parse failed without clear message — still treat as not-a-repo
        if (!/diff|status|porcelain/i.test(msg)) {
          return {
            handled: true,
            output:
              `Not a git repository: ${cwd}\n` +
              `Initialize with \`git init\` (or cd into a work tree) before /commit.`,
          };
        }
        // status/diff failed for other reasons — fall through to model with prompt
      }
      const prompt = buildCommitPrompt({
        workspace: cwd,
        stagedOnly,
        doCommit,
        lastVerificationCommand: opts.session.meta.lastVerificationCommand,
      });
      let banner = doCommit
        ? `Drafting commit message${stagedOnly ? " (staged)" : ""} and creating commit (no push)…`
        : `Drafting commit message${stagedOnly ? " (staged)" : ""} (no commit until you confirm /commit do)…`;
      // Nudge when committing after edits without a recorded structural check,
      // or when last-verify is stale (edits landed after the check).
      if (doCommit && (opts.session.meta.editCount || 0) > 0) {
        const last = opts.session.meta.lastVerificationCommand?.trim();
        if (!last) {
          try {
            const intel = detectProjectIntel(cwd);
            const tip = intel.checkCommands[0] || "npm test / typecheck";
            banner +=
              `\nNote: session has edits but no recorded verification — prefer \`${tip}\` before commit.`;
          } catch {
            banner +=
              `\nNote: session has edits but no recorded verification — run a cheap check before commit.`;
          }
        } else if (isLastVerificationStale(opts.session.meta)) {
          banner +=
            `\nNote: last verification (\`${last.slice(0, 80)}\`) is stale — edits landed after it; re-run before commit.`;
        }
      }
      return {
        handled: true,
        output: banner,
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
      let verifyTip = "";
      try {
        if (result.disk && result.disk.restored.length > 0) {
          const cwd =
            opts.config.workspace ||
            opts.session.meta.cwd ||
            process.cwd();
          const intel = detectProjectIntel(cwd);
          if (intel.checkCommands[0]) {
            verifyTip =
              `\nverify: ${intel.checkCommands.slice(0, 3).join(" · ")}`;
          }
        }
      } catch {
        /* */
      }
      // Orient experts: edit trail was recomputed from surviving mutations.
      let trailNote = "";
      try {
        const edits = opts.session.meta.editCount || 0;
        const last = opts.session.meta.lastVerificationCommand?.trim();
        if (result.disk && result.disk.restored.length > 0) {
          trailNote = `\nedits now: ${edits}`;
          if (last) {
            trailNote += isLastVerificationStale(opts.session.meta)
              ? ` · last-verify still stale (\`${last.slice(0, 40)}\`)`
              : ` · last-verify \`${last.slice(0, 40)}\``;
          }
        }
      } catch {
        /* */
      }
      return {
        handled: true,
        output:
          `Rewound ${result.turns || n} user turn(s); removed ${result.removed} message(s).` +
          (diskNote ? `\n${diskNote}` : "") +
          trailNote +
          verifyTip,
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
      let trailNote = "";
      try {
        if (result.disk && result.disk.restored.length > 0) {
          trailNote = `\nedits now: ${opts.session.meta.editCount || 0}`;
        }
      } catch {
        /* */
      }
      return {
        handled: true,
        output:
          (result.removed > 0
            ? `Retrying last turn (${mode}; removed ${result.removed} msg(s))…\n→ ${preview}`
            : `Retrying last turn (${mode})…\n→ ${preview}`) +
          (diskNote ? `\n${diskNote}` : "") +
          trailNote,
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

      const exportTrailNote = (() => {
        try {
          const last = opts.session.meta.lastVerificationCommand?.trim();
          if (last) {
            return isLastVerificationStale(opts.session.meta)
              ? `\n  last-verify stale: ${last.slice(0, 60)}`
              : `\n  last-verify: ${last.slice(0, 60)}`;
          }
          if ((opts.session.meta.editCount || 0) > 0) {
            return `\n  no last-verify after ${opts.session.meta.editCount} edit(s)`;
          }
        } catch {
          /* */
        }
        return "";
      })();
          return {
            handled: true,
            output:
              `Exported ${asJson ? "JSON" : "markdown"} to ${p} (mode 0600)` +
              exportTrailNote,
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
      // Orient fork with verify trail + preferred checks (fork preserves meta).
      let forkOrient = "";
      try {
        const last = forked.meta.lastVerificationCommand?.trim();
        if (last) {
          const stale = isLastVerificationStale(forked.meta)
            ? "  ⚠ stale"
            : "";
          forkOrient += `\n  Last verify: ${last.slice(0, 80)}${last.length > 80 ? "…" : ""}${stale}`;
        } else if ((forked.meta.editCount || 0) > 0) {
          forkOrient += `\n  No last-verify after ${forked.meta.editCount} edit(s)`;
        }
        const cwd =
          opts.config.workspace || forked.meta.cwd || process.cwd();
        const intel = detectProjectIntel(cwd);
        if (intel.checkCommands[0]) {
          forkOrient += chalk.dim(
            `\n  Preferred check: \`${intel.checkCommands[0]}\``,
          );
        }
      } catch {
        /* */
      }
      return {
        handled: true,
        output:
          `Forked session → ${forked.meta.id}\n` +
          `  msgs=${forked.messages.length} todos=${forked.todos.length}\n` +
          `  Continuing in the fork. Original ${srcId.slice(0, 8)} unchanged.\n` +
          `  Resume original later: /resume ${srcId.slice(0, 8)}` +
          harnessNote +
          forkOrient +
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
      forked.messages = compactMessages(forked.messages, DEFAULT_CHECKPOINT_KEEP_STEPS, {
        ulw,
        goal,
        todos: forked.todos,
        sessionId: forked.meta.id,
        cwd: opts.config.workspace || forked.meta.cwd,
        lastVerificationCommand: forked.meta.lastVerificationCommand,
        lastVerificationAt: forked.meta.lastVerificationAt,
        lastEditAt: forked.meta.lastEditAt,
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
      let forkOrient = "";
      try {
        const last = forked.meta.lastVerificationCommand?.trim();
        if (last) {
          const stale = isLastVerificationStale(forked.meta)
            ? "  ⚠ stale"
            : "";
          forkOrient += `\n  Last verify: ${last.slice(0, 80)}${last.length > 80 ? "…" : ""}${stale}`;
        } else if ((forked.meta.editCount || 0) > 0) {
          forkOrient += `\n  No last-verify after ${forked.meta.editCount} edit(s)`;
        }
        const cwd =
          opts.config.workspace || forked.meta.cwd || process.cwd();
        const intel = detectProjectIntel(cwd);
        if (intel.checkCommands[0]) {
          forkOrient += chalk.dim(
            `\n  Preferred check: \`${intel.checkCommands[0]}\``,
          );
        }
      } catch {
        /* */
      }
      const base =
        `Forked → ${forked.meta.id.slice(0, 8)} then compacted ${before} → ${forked.messages.length} msgs.\n` +
        `  Original ${opts.session.meta.id.slice(0, 8)} unchanged (full history).\n` +
        `  Resume original: /resume ${opts.session.meta.id.slice(0, 8)}` +
        harnessNote +
        forkOrient;
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
        const trailCore = formatSlashSessionTrail(opts.session.meta);
        const trail = trailCore
          ? `\n  ${trailCore}` +
            chalk.dim(
              "\n  Turn-end body appends no last-verify / last-verify stale / verified",
            )
          : "";
        return {
          handled: true,
          output:
            `Turn-end bell: ${on ? "on" : "off"}` +
            (env ? ` (FORGE_BELL=${env})` : " (preference / default off)") +
            `\n  /bell on|off   persist · /bell test   ring once · env FORGE_BELL=0|1 overrides` +
            trail,
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
        try {
          pushLiveNotice(
            opts.session.meta.id,
            "User enabled turn-end terminal BEL (/bell on). Continue working — the user will hear a bell when this turn finishes.",
          );
        } catch {
          /* */
        }
        return {
          handled: true,
          output:
            "Turn-end bell ON (persisted). Override with FORGE_BELL=0 if needed.",
        };
      }
      if (["off", "0", "false", "no", "disable"].includes(raw)) {
        savePreferences({ bellOnTurnEnd: false });
        try {
          pushLiveNotice(
            opts.session.meta.id,
            "User disabled turn-end terminal BEL (/bell off).",
          );
        } catch {
          /* */
        }
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

    case "/notify": {
      // /notify              → status
      // /notify on|off|1|0   → persist preference
      // /notify test         → fire once (best-effort desktop)
      const {
        isNotifyEnabled,
        maybeDesktopNotify,
      } = await import("../util/attention.js");
      const raw = (arg || "").trim().toLowerCase();
      if (!raw || raw === "status") {
        const on = isNotifyEnabled();
        const env = process.env.FORGE_NOTIFY?.trim();
        const trailCore = formatSlashSessionTrail(opts.session.meta);
        const trail = trailCore
          ? `\n  ${trailCore}` +
            chalk.dim(
              "\n  Turn-end notify body appends no last-verify / last-verify stale / verified",
            )
          : "";
        return {
          handled: true,
          output:
            `Turn-end desktop notify: ${on ? "on" : "off"}` +
            (env
              ? ` (FORGE_NOTIFY=${env})`
              : " (preference / default off)") +
            `\n  /notify on|off   persist · /notify test   fire once · env FORGE_NOTIFY=0|1 overrides` +
            `\n  macOS: osascript · Linux: notify-send · Windows: PowerShell balloon (best-effort)` +
            trail,
        };
      }
      if (raw === "test" || raw === "ping" || raw === "fire") {
        const fired = maybeDesktopNotify({
          force: true,
          title: "Forge",
          body: "Desktop notify test",
          subtitle: opts.session.meta.id.slice(0, 8),
        });
        return {
          handled: true,
          output: fired
            ? "Desktop notification fired (if your OS allows notifications for this terminal)."
            : "Desktop notify skipped (unsupported platform or spawn failed).",
        };
      }
      if (["on", "1", "true", "yes", "enable"].includes(raw)) {
        savePreferences({ notifyOnTurnEnd: true });
        try {
          pushLiveNotice(
            opts.session.meta.id,
            "User enabled turn-end desktop notify (/notify on). Continue working — the user will be alerted when this turn finishes.",
          );
        } catch {
          /* */
        }
        return {
          handled: true,
          output:
            "Turn-end desktop notify ON (persisted). Override with FORGE_NOTIFY=0 if needed.",
        };
      }
      if (["off", "0", "false", "no", "disable"].includes(raw)) {
        savePreferences({ notifyOnTurnEnd: false });
        try {
          pushLiveNotice(
            opts.session.meta.id,
            "User disabled turn-end desktop notify (/notify off).",
          );
        } catch {
          /* */
        }
        return {
          handled: true,
          output: "Turn-end desktop notify OFF (persisted).",
        };
      }
      {
        const tip = suggestName(
          raw,
          ["on", "off", "test", "status", "ping", "enable", "disable"],
          { minLength: 2, minScore: 36, requirePrefix3: false },
        );
        return {
          handled: true,
          output:
            (tip
              ? `Unknown /notify arg "${raw}". Did you mean: ${tip}?\n`
              : `Unknown /notify arg "${raw}".\n`) +
            `Usage: /notify [on|off|test|status]`,
        };
      }
    }

    case "/verbose": {
      // REPL-local toggle (src/tui/repl.ts). Headless has no transcript dock.
      return {
        handled: true,
        output:
          "Tool detail is a REPL toggle (session-local, not persisted).\n" +
          "  Interactive: type /verbose to show diffs + full tool output; again to minimize.\n" +
          "  Headless (`forge run`) already prints full tool output — nothing to toggle.",
      };
    }

    case "/format": {
      // /format              → status
      // /format on|off|1|0   → persist preference (OpenCode-inspired format-on-write)
      const raw = (arg || "").trim().toLowerCase();
      if (!raw || raw === "status") {
        const on = isFormatOnWriteEnabled();
        const env = process.env.FORGE_FORMAT_ON_WRITE?.trim();
        const cwd =
          opts.config.workspace || opts.session.meta.cwd || process.cwd();
        let detected = "";
        try {
          const fmts = detectProjectFormatters(cwd);
          detected = fmts.length
            ? `\n  Detected: ${fmts.join(", ")}` +
              (on ? "" : " — enable with /format on")
            : `\n  Detected: (none in this workspace)`;
        } catch {
          detected = "";
        }
        return {
          handled: true,
          output:
            `Format-on-write: ${on ? "on" : "off"}` +
            (env
              ? ` (FORGE_FORMAT_ON_WRITE=${env})`
              : " (preference / default off)") +
            detected +
            `\n  /format on|off   persist · env FORGE_FORMAT_ON_WRITE=0|1 overrides` +
            `\n  Runs project prettier/biome/ruff/gofmt/rustfmt after write_file · search_replace · apply_patch (best-effort)`,
        };
      }
      if (["on", "1", "true", "yes", "enable"].includes(raw)) {
        savePreferences({ formatOnWrite: true });
        return {
          handled: true,
          output:
            "Format-on-write ON (persisted). Override with FORGE_FORMAT_ON_WRITE=0 if needed.",
        };
      }
      if (["off", "0", "false", "no", "disable"].includes(raw)) {
        savePreferences({ formatOnWrite: false });
        return {
          handled: true,
          output: "Format-on-write OFF (persisted).",
        };
      }
      {
        const tip = suggestName(
          raw,
          ["on", "off", "status", "enable", "disable"],
          { minLength: 2, minScore: 36, requirePrefix3: false },
        );
        return {
          handled: true,
          output:
            (tip
              ? `Unknown /format arg "${raw}". Did you mean: ${tip}?\n`
              : `Unknown /format arg "${raw}".\n`) +
            `Usage: /format [on|off|status]`,
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

    case "/checkpoint":
    case "/snap": {
      const cwd =
        opts.config.workspace || opts.session.meta.cwd || process.cwd();
      const sub = (arg || "").trim();
      const tokens = sub ? sub.split(/\s+/).filter(Boolean) : [];
      const head = (tokens[0] || "").toLowerCase();
      if (head === "status" || head === "list" || head === "ls") {
        const lines: string[] = [
          "Safety checkpoints (git stash create — non-mutating):",
        ];
        const last = opts.session.meta.lastCheckpoint;
        if (last) {
          lines.push(`  last: ${last}`);
          lines.push(`  restore: git stash apply ${last}`);
        } else {
          lines.push("  (no checkpoint this session yet)");
        }
        lines.push(
          "  /checkpoint           create snapshot (working tree untouched)",
          "  /checkpoint restore   apply last session checkpoint",
        );
        return {
          handled: true,
          output: lines.join("\n"),
          session: opts.session,
        };
      }
      if (head === "restore" || head === "apply" || head === "pop") {
        if (opts.config.permissionMode === "plan") {
          return {
            handled: true,
            output: "Plan mode cannot restore checkpoints. `exit_plan_mode` or `/build` first.",
          };
        }
        const sha = tokens[1] || opts.session.meta.lastCheckpoint || "";
        if (!sha) {
          return {
            handled: true,
            output: "No checkpoint sha. Create one with `/checkpoint`.",
          };
        }
        const r = applySafetyCheckpoint(cwd, sha);
        if (!r.ok) {
          return {
            handled: true,
            output: `Checkpoint restore failed: ${r.detail || "unknown"}`,
          };
        }
        return {
          handled: true,
          output: `Applied checkpoint ${sha.slice(0, 12)}…\nReview with /diff.`,
          session: opts.session,
        };
      }
      const snap = createSafetyCheckpoint(cwd, {
        label: opts.session.meta.id.slice(0, 12),
      });
      if (!snap.ok) {
        return {
          handled: true,
          output: `Checkpoint failed: ${snap.detail || "unknown"}`,
        };
      }
      if (snap.clean || !snap.sha) {
        return {
          handled: true,
          output: snap.detail || "Working tree clean — nothing to checkpoint.",
        };
      }
      opts.session.meta.lastCheckpoint = snap.sha;
      opts.session.meta.lastCheckpointAt = new Date().toISOString();
      try {
        saveSession(opts.session);
      } catch {
        /* */
      }
      return {
        handled: true,
        output: [
          `Checkpoint created: ${snap.sha}`,
          `  files: ~${snap.dirtyPaths ?? "?"}  ·  working tree unchanged`,
          snap.ref ? `  ref:   ${snap.ref}` : "",
          `  restore: /checkpoint restore`,
        ]
          .filter(Boolean)
          .join("\n"),
        session: opts.session,
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
        let verifyTip = "";
        try {
          // Only nudge when there is something to verify.
          if (stat || body.trim()) {
            const intel = detectProjectIntel(cwd);
            if (intel.checkCommands[0]) {
              verifyTip = `\nverify: ${intel.checkCommands.slice(0, 3).join(" · ")}`;
            }
          }
        } catch {
          /* */
        }
        const out = [
          `cwd: ${cwd}`,
          stat ? `status:\n${stat}` : "status: clean",
          statDiff ? `\nstat:\n${statDiff}` : "",
          body.trim() ? `\ndiff:\n${body}` : "\n(no unstaged/HEAD diff)",
          filterArgs.length ? `\n(filter: ${filterArgs.join(" ")})` : "",
          verifyTip,
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
      let out = formatSessionTouchedFiles(opts.session, { limit, mutatedOnly });
      // When listing mutations, nudge preferred verification (less steering).
      if (mutatedOnly || /wrote|edited|mutation/i.test(out)) {
        try {
          const cwd =
            opts.config.workspace ||
            opts.session.meta.cwd ||
            process.cwd();
          const intel = detectProjectIntel(cwd);
          if (intel.checkCommands[0] && !/no (files|mutations)/i.test(out)) {
            out +=
              `\nverify: ${intel.checkCommands.slice(0, 3).join(" · ")}`;
          }
        } catch {
          /* */
        }
      }
      return {
        handled: true,
        output: out,
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
        // Soft TodoGate is process-local — reset so a cleared conversation is
        // not blocked once for pre-clear open-todo Stop attempts.
        try {
          clearSoftTodoGateOnWindDown(opts.session.meta.id);
        } catch {
          /* */
        }
        let clearTip = chalk.dim(
          "  ULW/goal sidecars kept but stuck baselines zeroed. /new for a fresh session id.",
        );
        try {
          const cwd =
            opts.config.workspace ||
            opts.session.meta.cwd ||
            process.cwd();
          const intel = detectProjectIntel(cwd);
          const check = intel.checkCommands[0]
            ? ` Prefer \`${intel.checkCommands[0]}\` after new edits.`
            : "";
          clearTip += chalk.dim(
            `\n  last-verify trail reset.${check}`,
          );
        } catch {
          clearTip += chalk.dim("\n  last-verify trail reset.");
        }
        return {
          handled: true,
          output:
            "Conversation cleared (same session id; counters + undo journal reset).\n" +
            clearTip,
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
      // Drop soft TodoGate state for the old session id (process-local map).
      try {
        clearSoftTodoGateOnWindDown(opts.session.meta.id);
      } catch {
        /* */
      }
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
      let newTip = wasUlw
        ? chalk.dim(
            "\n  ULW/goal not carried over — re-arm with /ulw or /goal if needed.",
          )
        : "";
      try {
        const cwd =
          opts.config.workspace || opts.session.meta.cwd || process.cwd();
        const intel = detectProjectIntel(cwd);
        if (intel.checkCommands[0]) {
          newTip += chalk.dim(
            `\n  Preferred check: \`${intel.checkCommands[0]}\`  ·  /context for full stack`,
          );
        }
      } catch {
        /* */
      }
      return {
        handled: true,
        output: `New session ${s.meta.id.slice(0, 8)}${titleNote}` + newTip,
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
                    const verifyNote = s.lastVerificationCommand?.trim()
                      ? isLastVerificationStale(s)
                        ? "  ✓~"
                        : "  ✓"
                      : "";
                    return `  ${s.id.slice(0, 8)}  ${age}  ${(s.title || "").slice(0, 28).padEnd(28)}  ${s.model}${verifyNote}${prevNote}${lockNote}${cwdNote}`;
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
        const forceLastError =
          parts.includes("--force-last-error") ||
          parts.includes("--force-errors") ||
          parts.includes("--include-errors");
        const result = pruneSessions({
          keep,
          protectIds: [opts.session.meta.id],
          forceLastError,
        });
        const lockNote = result.skippedLocked
          ? `; skipped ${result.skippedLocked} foreign-locked`
          : "";
        const pinNote = result.skippedPinned
          ? `; skipped ${result.skippedPinned} pinned`
          : "";
        const errNote = result.skippedLastError
          ? `; skipped ${result.skippedLastError} lastError (/sessions errors · prune --force-last-error)`
          : result.deletedWithLastError
            ? `; deleted ${result.deletedWithLastError} with lastError`
            : "";
        return {
          handled: true,
          output: `Pruned ${result.deleted.length} session(s); kept ${result.kept} (active protected${lockNote}${pinNote}${errNote}). CLI: forge sessions prune --keep ${keep}`,
        };
      }
      // Default: same-cwd sessions (multi-project experts). /sessions all|global for everything.
      // /sessions q <text> or /sessions search <text> filters by id/title substring.
      // /sessions pinned — only pin-protected sessions.
      // /sessions pin|unpin <id|title> — pin mutation (CLI parity); bare pin/pinned lists.
      // /sessions errors|failed|err — only sessions with meta.lastError (recovery backlog).
      const ws = opts.session.meta.cwd || opts.config.workspace || process.cwd();
      let listMode: "cwd" | "all" = "cwd";
      let query: string | undefined;
      let pinnedOnly = false;
      let errorsOnly = false;
      let untitledOnly = false;
      if (sub === "all" || sub === "global" || sub === "-a") {
        listMode = "all";
      } else if (sub === "unpin") {
        const target = parts.slice(1).join(" ").trim();
        if (!target) {
          return {
            handled: true,
            output:
              "Usage: /sessions unpin <id|title>  ·  bare /unpin unpins the active session",
          };
        }
        const loaded = loadSession(target);
        if (!loaded) {
          return {
            handled: true,
            output: formatSessionLookupMiss(target, { cwd: ws }),
          };
        }
        setSessionPinned(loaded, false);
        saveSession(loaded);
        // Keep REPL session meta in sync when unpinning the active session.
        if (loaded.meta.id === opts.session.meta.id) {
          opts.session.meta.pinned = false;
        }
        return {
          handled: true,
          output: `Unpinned ${loaded.meta.id.slice(0, 8)}${
            loaded.meta.title ? ` — ${loaded.meta.title}` : ""
          }. CLI: forge sessions unpin ${loaded.meta.id.slice(0, 8)}`,
        };
      } else if (sub === "pin" && parts[1]) {
        // /sessions pin <id|title> — pin a specific session (not list filter).
        const target = parts.slice(1).join(" ").trim();
        const loaded = loadSession(target);
        if (!loaded) {
          return {
            handled: true,
            output: formatSessionLookupMiss(target, { cwd: ws }),
          };
        }
        setSessionPinned(loaded, true);
        saveSession(loaded);
        if (loaded.meta.id === opts.session.meta.id) {
          opts.session.meta.pinned = true;
        }
        return {
          handled: true,
          output: `Pinned ${loaded.meta.id.slice(0, 8)}${
            loaded.meta.title ? ` — ${loaded.meta.title}` : ""
          } (protected from prune). CLI: forge sessions pin ${loaded.meta.id.slice(0, 8)}`,
        };
      } else if (sub === "pinned" || sub === "pins" || sub === "pin") {
        pinnedOnly = true;
        listMode = "all";
      } else if (
        sub === "errors" ||
        sub === "error" ||
        sub === "failed" ||
        sub === "fail" ||
        sub === "err"
      ) {
        errorsOnly = true;
        listMode = "all";
      } else if (
        sub === "untitled" ||
        sub === "notitle" ||
        sub === "no-title" ||
        sub === "nameless"
      ) {
        untitledOnly = true;
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
                "Actions: list · search · prune · delete · pin|unpin <id> · pinned · errors · untitled · all  ·  CLI: forge sessions <action>",
              ),
          };
        }
        // bare query token: /sessions incident
        query = parts.join(" ").trim() || undefined;
        listMode = "all";
      }
      if (sub === "tree" || sub === "forks" || sub === "lineage") {
        const target = parts[1] || opts.session.meta.id;
        const resolved = resolveSessionId(target);
        if (!resolved) {
          return {
            handled: true,
            output: formatSessionLookupMiss(target, {
              cwd: opts.session.meta.cwd || opts.config.workspace,
            }),
          };
        }
        try {
          const root = loadSession(resolved);
          if (!root) {
            return {
              handled: true,
              output: formatSessionLookupMiss(target, {
                cwd: opts.session.meta.cwd || opts.config.workspace,
              }),
            };
          }
          const kids = listSessionForks(resolved, { limit: 20 });
          const lines: string[] = [
            chalk.bold(`Session tree  ${resolved.slice(0, 8)}…`),
            `  ${root.meta.title || "(untitled)"}  ${root.meta.pinned ? "PIN " : ""}`,
          ];
          if (root.meta.parentSessionId) {
            const pl = (
              root.meta.parentSessionLabel ||
              root.meta.parentSessionId.slice(0, 8)
            ).slice(0, 40);
            lines.push(
              `  ↳ parent: ${pl} (${root.meta.parentSessionId.slice(0, 8)}…)`,
            );
          }
          if (!kids.length) lines.push("  (no forks)");
          else {
            lines.push(`  forks (${kids.length}):`);
            for (const k of kids) {
              const age = k.updatedAt
                ? k.updatedAt.slice(0, 19).replace("T", " ")
                : "";
              lines.push(
                `    · ${(k.title || "(untitled)").slice(0, 36)}  ${k.id.slice(0, 8)}…  ${age}`,
              );
            }
          }
          lines.push(
            chalk.dim(
              "  /fork [title] · forge sessions show <id> · /sessions tree <id>",
            ),
          );
          return {
            handled: true,
            output: lines.join("\n"),
            session: opts.session,
          };
        } catch (err) {
          return {
            handled: true,
            output: `tree failed: ${String((err as Error)?.message || err).slice(0, 200)}`,
          };
        }
      }
      let list = listSessions({
        limit: errorsOnly || untitledOnly ? 50 : 15,
        ...(listMode === "cwd" && !query && !pinnedOnly && !errorsOnly && !untitledOnly
          ? { cwd: ws }
          : {}),
        ...(query ? { query } : {}),
        ...(pinnedOnly ? { pinned: true } : {}),
      });
      if (errorsOnly) {
        list = list.filter((s) => Boolean(s.lastError?.message));
      }
      if (untitledOnly) {
        list = list.filter((s) => !String(s.title || "").trim());
      }
      if (!list.length) {
        if (errorsOnly) {
          return {
            handled: true,
            output:
              "No sessions with lastError. Provider failures stamp ERR on /sessions and forge status.",
          };
        }
        if (untitledOnly) {
          return {
            handled: true,
            output:
              "No untitled sessions. /title · --title · /goal set auto-titles new ones.",
          };
        }
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
      const scopeNote = errorsOnly
        ? "lastError only"
        : untitledOnly
          ? "untitled only"
          : pinnedOnly
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
              const errNote =
                errorsOnly && s.lastError
                  ? `  [${s.lastError.code}] ${s.lastError.message.slice(0, 40)}`
                  : "";
              const age = formatRelativeTime(s.updatedAt).padStart(8);
              let costNote = "";
              try {
                const tok =
                  (s.totalPromptTokens || 0) + (s.totalCompletionTokens || 0);
                if (tok > 0) {
                  const c = estimateCostUsd(
                    s.provider || "xai",
                    s.totalPromptTokens || 0,
                    s.totalCompletionTokens || 0,
                    s.model,
                    s.totalCacheReadTokens || 0,
                  );
                  costNote = ` ~${formatCost(c)}`;
                }
              } catch {
                /* */
              }
              return `${s.id.slice(0, 8)}  ${age}  ${(s.title || "").slice(0, 28).padEnd(28)}  ${s.model}  t=${s.turnCount}${costNote}${s.lastVerificationCommand?.trim() ? (isLastVerificationStale(s) ? " ✓~" : " ✓") : ""}${s.ultrawork ? " ULW" : ""}${s.pinned ? " PIN" : ""}${s.permissionMode === "plan" ? " PLAN" : ""}${s.lastError ? " ERR" : ""}${active}${lockNote}${cwdNote}${prevNote}${errNote}`;
            })
            .join("\n") +
          chalk.dim(
            `\n\n* = active  ·  ${scopeNote}  ·  /sessions [all|pinned|pin <id>|unpin <id>|errors|untitled|search <q>]  ·  delete <id|title> [--force]  ·  prune [--keep=50]  ·  /resume <id|title>  ·  /pin\nCLI: forge sessions list --cwd . [--pinned]  ·  show|export|import|fork|pin|delete <id|title>`,
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
          "Mutations (writes/mutating bash/apply_patch/kill_task) are hard-denied. Read-only bash and explore spawn are allowed.",
          "Research and produce a concrete plan: goal, steps, files, risks, verification.",
          "When the plan is ready, call exit_plan_mode (or type /build).",
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
        chalk.dim(
          "  Reads/search/todo_write/read-only bash/explore spawn allowed · writes/mutating bash denied",
        ),
        chalk.dim(
          "  Agent calls exit_plan_mode when ready · or type /build / /permissions <mode>",
        ),
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
      persistSessionMode(opts.session);
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
            ? chalk.blue("\nSession: PLAN (exit_plan_mode or /build to leave — sticky prefs untouched)")
            : opts.session.meta.permissionMode
              ? chalk.dim(`\nSession override: ${opts.session.meta.permissionMode}`)
              : "";
        let orient = formatSlashVerifyOrient({
          workspace: opts.config.workspace,
          cwd: opts.session.meta.cwd,
          editCount: opts.session.meta.editCount,
          lastVerificationCommand: opts.session.meta.lastVerificationCommand,
          lastVerificationAt: opts.session.meta.lastVerificationAt,
          lastEditAt: opts.session.meta.lastEditAt,
        });
        if (orient) {
          orient = orient
            .split("\n")
            .map((line) => {
              if (!line) return line;
              return /No last-verify after/.test(line)
                ? chalk.yellow(line)
                : chalk.dim(line);
            })
            .join("\n");
        }
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
            sessionNote +
            orient,
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

    case "/skills": {
      const ws = opts.config.workspace || process.cwd();
      const { loadProjectSkills } = await import("../agent/project-skills.js");
      const skills = loadProjectSkills(ws);
      if (!skills.length) {
        return {
          handled: true,
          output:
            "No skills loaded.\n" +
            "  Builtins: package skills/forge-*/SKILL.md (FORGE_BUILTIN_SKILLS=0 to disable)\n" +
            "  Project:  .forge/skills/<name>/SKILL.md · .agents/skills/**/SKILL.md\n" +
            "  User:     ~/.forge/skills/**/SKILL.md\n" +
            "  Optional frontmatter: name, description, inject (always|body|catalog)",
        };
      }
      const by = {
        builtin: skills.filter((s) => s.source === "builtin"),
        project: skills.filter((s) => s.source === "project"),
        user: skills.filter((s) => s.source === "user"),
      };
      const fmt = (s: (typeof skills)[0]) =>
        `  ${s.name.padEnd(18)} ${(s.description || "(no description)").slice(0, 56)}  [${s.inject}]`;
      const lines = [
        `Skills (${skills.length}) · project overrides user overrides builtin`,
      ];
      if (by.builtin.length) {
        lines.push(``, `Builtin (${by.builtin.length}) — ship-with-install forge-* playbooks:`);
        lines.push(...by.builtin.map(fmt));
      }
      if (by.project.length) {
        lines.push(``, `Project (${by.project.length}):`);
        lines.push(...by.project.map(fmt));
      }
      if (by.user.length) {
        lines.push(``, `User (${by.user.length}):`);
        lines.push(...by.user.map(fmt));
      }
      lines.push(
        "",
        "  Catalog always in system prompt; bodies for project/user (+ inject:always).",
        "  Builtins default catalog-only — agent read_file(path) when matching.",
        "  Paths: skills/forge-*/ · .forge/skills/** · .agents/skills/** · ~/.forge/skills/**",
        "  FORGE_BUILTIN_SKILLS=0 disables package builtins.",
      );
      return { handled: true, output: lines.join("\n") };
    }

    case "/commands": {
      const ws = opts.config.workspace || process.cwd();
      return {
        handled: true,
        output: formatProjectCommandsHelp(ws),
      };
    }

    default: {
      // OpenCode-style project / user custom commands (.forge/commands/*.md)
      const bare = cmd.replace(/^\//, "");
      try {
        const ws = opts.config.workspace || process.cwd();
        const custom = findProjectCommand(ws, bare);
        if (custom) {
          const expanded = expandProjectCommandTemplate(
            custom.template,
            arg,
          );
          if (!expanded) {
            return {
              handled: true,
              output: `Custom command /${custom.name} expanded to empty prompt.`,
            };
          }
          return {
            handled: true,
            forwardPrompt: expanded,
            output: chalk.dim(
              `→ /${custom.name}${arg ? ` ${arg}` : ""}  (${custom.source})`,
            ),
          };
        }
      } catch {
        /* fall through to unknown */
      }
      return {
        handled: true,
        output: formatUnknownSlash(cmd, {
          workspace: opts.config.workspace || process.cwd(),
        }),
      };
    }
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
      let resumeTip = "";
      if (g) {
        try {
          const cwd = session.meta.cwd || process.cwd();
          const intel = detectProjectIntel(cwd);
          if (intel.checkCommands[0]) {
            resumeTip =
              "\n" +
              chalk.dim(
                `Preferred checks: ${intel.checkCommands.slice(0, 3).join(" · ")}  ·  attestation needs green after edits`,
              );
          }
        } catch {
          /* */
        }
      }
      return {
        handled: true,
        output: g
          ? `Goal resumed.\n${formatGoalStatus(g)}` +
            chalk.dim("\n  (applies immediately to harness; agent notified on next model call)") +
            resumeTip
          : "No goal to resume.",
        session,
      };
    }
    case "clear": {
      clearGoal(sid);
      // Parity with /goal done / /done: reset soft TodoGate so clear is not
      // followed by a leftover once-block for open todos.
      try {
        clearSoftTodoGateOnWindDown(sid);
      } catch {
        /* */
      }
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
        // Parity with /done slash: reset soft TodoGate so goal release is not
        // followed by a leftover once-block for open todos.
        try {
          clearSoftTodoGateOnWindDown(sid);
        } catch {
          /* */
        }
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
      // Fresh driver: drop leftover soft TodoGate once-blocks from prior work.
      try {
        clearSoftTodoGateOnWindDown(sid);
      } catch {
        /* */
      }
      // Untitled sessions get a scannable title from the goal (experts scanning /sessions)
      maybeSetTitle(session, restText);
      saveSession(session);
      let goalCheckTip = "";
      try {
        const cwd = session.meta.cwd || process.cwd();
        const intel = detectProjectIntel(cwd);
        if (intel.checkCommands[0]) {
          goalCheckTip =
            `\n` +
            chalk.dim(
              `Preferred checks: ${intel.checkCommands.slice(0, 3).join(" · ")}  ·  attestation needs green after edits`,
            );
        }
      } catch {
        /* */
      }
      return {
        handled: true,
        output:
          `Goal ARMED (relentless driver engaged).\n${formatGoalStatus(g)}` +
          goalCheckTip,
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
      maybeSetTitle(session, arg);
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
  fallbackModels?: string[];
  fallbackChain: string;
  lastModelFallback?: { from: string; to: string; at: string };
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
  /** Count of project instruction sources (AGENTS.md, .cursor/rules, …). */
  projectRulesCount?: number;
  /** Count of project/user custom slash templates (.forge/commands). */
  projectCommandsCount?: number;
  /** OpenCode-style project skills (.forge/skills/.../SKILL.md). */
  projectSkillsCount?: number;
  /** Sessions with meta.lastError set (expert recovery backlog). */
  sessionsWithLastError?: number;
  /** Sessions without a title (harder to resume by name). */
  sessionsUntitled?: number;
  /** Total sessions scanned for inventory tips. */
  sessionsTotal?: number;
  /** Pin-protected sessions (prune-safe). */
  sessionsPinned?: number;
  /** First-day setup checklist (non-blocking — does not affect `ok`). */
  setupReady?: number;
  setupTotal?: number;
  setupItems?: Array<{
    id: string;
    ready: boolean;
    severity: string;
    action: string;
  }>;
  /** Effective format-on-write (env FORGE_FORMAT_ON_WRITE wins over preference). */
  formatOnWrite?: boolean;
  subagentLandMode?: "auto" | "keep" | "discard";
  projectMemoryCount?: number;
  /** Detected package manager (npm/pnpm/yarn/bun). */
  packageManager?: string | null;
  /** Ecosystem labels (node, typescript, rust, …). */
  projectKinds?: string[];
  /** Preferred verification commands (cheapest first). */
  checkCommands?: string[];
  /** Monorepo workspace package labels (when detected). */
  workspaces?: string[];
  /** Monorepo root path (walk-up when cwd is a nested package). */
  monorepoRoot?: string | null;
  /** Compact project-stack summary. */
  projectStackSummary?: string | null;
  /** Stale/unread edit guard effective (FORGE_FILE_READ_GUARD). */
  fileReadGuard?: boolean;
  /** Post-edit verify tip effective (FORGE_VERIFY_HINT). */
  verifyHint?: boolean;
  /** Whether workspace node_modules exists (null when no package.json). */
  nodeModulesPresent?: boolean | null;
  /** package.json packageManager field vs lockfile disagreement, if any. */
  packageManagerMismatch?: {
    field: string;
    lockfile: string;
    detail: string;
  } | null;
  /** Multiple lockfile basenames when ≥2 PM families are present. */
  multipleLockfiles?: string[];
  /** Known default context window for config.model (from model-info). */
  modelDefaultContextWindow?: number | null;
  /** config.contextWindow / modelDefault when known. */
  contextWindowRatio?: number | null;
  /** Linked git worktree (not main checkout). */
  gitIsWorktree?: boolean | null;
  gitBranch?: string | null;
  gitRoot?: string | null;
  gitChangedFiles?: number | null;
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
      const cachedRemote = readProviderModelsCache(reportProvider) || [];
      modelInCatalog =
        catalog.some(
          (m) => m.toLowerCase() === String(reportModel).toLowerCase(),
        ) ||
        cachedRemote.some(
          (m) => m.toLowerCase() === String(reportModel).toLowerCase(),
        ) ||
        isGrokLineageModel(reportModel);
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
  {
    const permissionMode =
      normalizePermissionMode(config.permissionMode) ?? config.permissionMode;
    lines.push(`Permission mode: ${config.permissionMode}`);
    if (permissionMode === "plan") {
      lines.push(
        chalk.blue(
          "  PLAN — mutations denied; exit_plan_mode or /build (session /plan preferred over sticky plan)",
        ),
      );
    }
    if (permissionMode === "bypassPermissions") {
      lines.push(
        chalk.yellow(
          "  ⚠ bypassPermissions (yolo) — all tools auto-approved; prefer acceptEdits/plan/dontAsk in CI",
        ),
      );
      issues.push(
        "Permission mode is bypassPermissions (yolo) — all tools auto-approved; set acceptEdits/plan/dontAsk for production CI",
      );
    }
    if (permissionMode === "dontAsk") {
      lines.push(
        chalk.yellow(
          "  ⚠ dontAsk — permission prompts auto-deny; ask_user also unavailable (state assumptions or use interactive default)",
        ),
      );
    }
  }
  {
    const dontAskEnv = process.env.FORGE_DONT_ASK?.trim();
    if (
      dontAskEnv &&
      ["1", "true", "on", "yes"].includes(dontAskEnv.toLowerCase())
    ) {
      lines.push(
        chalk.yellow(
          `  ⚠ FORGE_DONT_ASK=${dontAskEnv} — interactive asks disabled (permissions + ask_user)`,
        ),
      );
    }
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
      prefs.notifyOnTurnEnd ? "notify=on" : null,
      prefs.formatOnWrite ? "format=on" : null,
    ].filter(Boolean);
    lines.push(
      `Preferences: ${bits.length ? bits.join(" ") : "(none)"}  (~/.forge/preferences.json)`,
    );
    if (!prefs.notifyOnTurnEnd && !isNotifyEnabled()) {
      lines.push(
        chalk.dim(
          "  tip: /notify on · FORGE_NOTIFY=1 — desktop alert when long ULW/goal turns finish",
        ),
      );
    }
    if (
      !prefs.bellOnTurnEnd &&
      !isBellEnabled() &&
      !prefs.notifyOnTurnEnd &&
      !isNotifyEnabled()
    ) {
      lines.push(
        chalk.dim(
          "  tip: /bell on or /notify on — long ULW/goal runs are easy to miss without turn-end attention",
        ),
      );
    }

    try {
      const landRaw =
        process.env.FORGE_SUBAGENT_LAND?.trim() ||
        process.env.FORGE_WORKTREE_LAND?.trim() ||
        "";
      const land = (landRaw || "auto").toLowerCase();
      const landMode = ["0", "false", "off", "discard", "none"].includes(land)
        ? "discard"
        : ["keep", "manual", "review"].includes(land)
          ? "keep"
          : "auto";
      lines.push(
        `Subagent worktree land: ${landMode}` +
          (landRaw ? `  (env=${landRaw})` : "  (default auto)") +
          "  · FORGE_SUBAGENT_LAND=auto|keep|discard",
      );
      if (landMode === "discard") {
        lines.push(
          chalk.yellow(
            "  ⚠ land=discard — isolation=worktree edits are dropped on cleanup",
          ),
        );
      }
    } catch {
      /* */
    }
    try {
      const n = listActiveProjectMemory(
        config.workspace || process.cwd(),
      ).length;
      lines.push(
        `Project memory: ${n} active  · /memory project  · memory_write scope=project`,
      );
    } catch {
      /* */
    }
    lines.push(
      chalk.dim(
        "  harness: handoff-guard · proof-claim · soft TodoGate · /budget · safety valves flip ULW to LAST · /done winds ULW+goal",
      ),
    );
  }
  {
    const net = resolveSandboxNetwork(config);
    const backend = detectSandboxBackend();
    const sandbox =
      normalizeSandboxProfile(config.sandbox) ?? config.sandbox ?? "off";
    lines.push(`Sandbox: ${describeSandbox(sandbox || "off", net)}`);
    if ((sandbox || "off") === "off") {
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
        (sandbox !== "off" && !backend.available
          ? config.sandboxMissingBackend === "fail-closed"
            ? chalk.red(" — FAIL-CLOSED (bash denied)")
            : chalk.yellow(" — fallback unsandboxed")
          : ""),
    );
    if (sandbox !== "off" && !backend.available) {
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
    lines.push(`Fallback models: ${formatFallbackChain(config)}`);
    if (
      Array.isArray(config.fallbackModels) &&
      config.fallbackModels.length === 0
    ) {
      lines.push(
        chalk.yellow(
          "  ⚠ model fallback off — a 429/5xx on the flagship will abort the run; /fallback default",
        ),
      );
    }
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
  lines.push(
    `Blocking Stop: ${isFalsy(config.blockingStopHooks) ? "off" : "on"}`,
  );
  if (!isFalsy(config.blockingStopHooks)) {
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
  // Git worktree signal for multi-worktree expert workflows
  let gitIsWorktree: boolean | null = null;
  let gitBranch: string | null = null;
  let gitRoot: string | null = null;
  let gitChangedFiles: number | null = null;
  try {
    const { getGitSnapshot } = await import("../util/git-context.js");
    const g = getGitSnapshot(config.workspace || process.cwd());
    if (g.root) {
      gitRoot = g.root;
      gitBranch = g.branch || null;
      gitIsWorktree = Boolean(g.isWorktree);
      gitChangedFiles =
        typeof g.changedFiles === "number" ? g.changedFiles : null;
      const dirty = g.dirty ? "*" : "";
      const wt = g.isWorktree ? " · linked worktree" : "";
      const ch =
        typeof g.changedFiles === "number" && g.changedFiles > 0
          ? ` · Δ${g.changedFiles}`
          : "";
      lines.push(
        chalk.dim(
          `  git: ${g.branch || "?"}${dirty}${wt}${ch}  ·  ${g.root}`,
        ),
      );
      // Expert tip: huge dirty trees make ULW diffs noisy and raise blast radius
      if (typeof g.changedFiles === "number" && g.changedFiles >= 40) {
        lines.push(
          chalk.yellow(
            `  ⚠ dirty tree has ${g.changedFiles} changed files — commit/stash before a long ULW wave, or /plan first`,
          ),
        );
      }
    }
  } catch {
    /* */
  }
  // Project instruction hygiene (OpenCode-style) — tip only, not a blocking issue
  try {
    const { listProjectRulePaths } = await import("../agent/system-prompt.js");
    const ws = config.workspace || process.cwd();
    const rules = listProjectRulePaths(ws);
    if (rules.length === 0) {
      lines.push(
        chalk.dim(
          "  tip: no AGENTS.md / CLAUDE.md / .cursor/rules — run /init for project instructions",
        ),
      );
    } else {
      lines.push(
        chalk.dim(
          `  project rules: ${rules.length} source(s)  (/context for paths)`,
        ),
      );
    }
  } catch {
    /* */
  }
  {
    const budget =
      typeof config.maxCostUsd === "number" && config.maxCostUsd > 0
        ? `$${config.maxCostUsd}`
        : "unlimited";
    lines.push(
      `Context: window=${config.contextWindow} autoCompact@${Math.round((config.autoCompactThreshold || 0.8) * 100)}% maxTurns=${config.maxTurns > 0 ? config.maxTurns : "unlimited"} maxCost=${budget}`,
    );
    lines.push(
      chalk.dim(
        "  tip: /budget N · --max-cost N · FORGE_MAX_COST_USD  ·  /notify on for desktop turn-end  ·  /bell on",
      ),
    );
    if (!(typeof config.maxCostUsd === "number" && config.maxCostUsd > 0)) {
      lines.push(
        chalk.dim(
          "  tip: maxCost is unlimited — set a spend cap before long unattended ULW so hitCostCap can release cleanly",
        ),
      );
    }
  }
  // Expert tip: context_window far below the model's known default wastes headroom
  let modelDefaultContextWindow: number | null = null;
  let contextWindowRatio: number | null = null;
  try {
    const { modelContextWindow } = await import("../config/model-info.js");
    const known = modelContextWindow(config.model);
    if (known) {
      modelDefaultContextWindow = known;
      if (config.contextWindow > 0) {
        contextWindowRatio = Math.round((config.contextWindow / known) * 1000) / 1000;
      }
    }
    if (
      known &&
      config.contextWindow > 0 &&
      config.contextWindow < known * 0.5
    ) {
      lines.push(
        chalk.yellow(
          `  ⚠ context_window=${config.contextWindow} is <50% of ${config.model}'s known ${known} — long runs may compact early; raise context_window or use /model`,
        ),
      );
    } else if (known && config.contextWindowExplicit && config.contextWindow !== known) {
      lines.push(
        chalk.dim(
          `  model default window≈${known} (explicit context_window=${config.contextWindow})`,
        ),
      );
    } else if (known) {
      lines.push(chalk.dim(`  model default window≈${known}`));
    }
  } catch {
    /* */
  }
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
      `Reliability: Retry-After · abortable streams · empty-SSE retry · JSON repair · orphan tool heal · doom-loop@${doomN} · error-streak@${errN} · ulw-continues@${ulwCap} · apply_patch · file-aware undo · overflow→compact · session lock/tmp-recover · metrics.jsonl · OAuth refresh · provider stall=${Math.round(providerTimeoutMs() / 1000)}s${providerMaxWallMs() > 0 ? ` max=${Math.round(providerMaxWallMs() / 1000)}s` : ""} · bash timeout=${Math.round(bashTo / 1000)}s (bg ${Math.round(bashBg / 1000)}s)${maxRunNote}${permNote}${bellNote}${resumeNote}`,
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
  let nodeModulesPresent: boolean | null = null;
  let packageManagerMismatch: {
    field: string;
    lockfile: string;
    detail: string;
  } | null = null;
  let multipleLockfilesList: string[] = [];
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
        }
      } else if (range) {
        lines.push(`  package engines.node: ${range}`);
      }
      // Missing node_modules — experts hit this after clone; steer install with detected PM.
      // Monorepos often hoist node_modules to the workspace root only.
      try {
        const ws = config.workspace || process.cwd();
        const { detectPackageManager, hasNodeModules } = await import(
          "../util/project-intel.js"
        );
        const present = hasNodeModules(ws);
        nodeModulesPresent = present;
        if (present === false) {
          let install = "npm install";
          try {
            const pm = detectPackageManager(ws);
            if (pm === "pnpm") install = "pnpm install";
            else if (pm === "yarn") install = "yarn install";
            else if (pm === "bun") install = "bun install";
          } catch {
            /* */
          }
          lines.push(
            chalk.yellow(
              `  ⚠ node_modules missing — run \`${install}\` before typecheck/test`,
            ),
          );
          issues.push(`node_modules missing — run ${install}`);
        }
      } catch {
        /* */
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
  // MCP config (advisory — empty is fine)
  try {
    const { loadMcpConfig } = await import("../mcp/config.js");
    const { getActiveMcpManager } = await import("../mcp/manager.js");
    const ws = config.workspace || process.cwd();
    const mcpCfg = loadMcpConfig(ws);
    const names = Object.keys(mcpCfg.servers);
    const active = getActiveMcpManager();
    if (!mcpCfg.enabled) {
      lines.push(chalk.dim("MCP: disabled (FORGE_MCP=0)"));
    } else if (!names.length) {
      lines.push(
        chalk.dim(
          "MCP: no servers configured  (.forge/mcp.json · ~/.forge/mcp.json)",
        ),
      );
    } else {
      const errN = active
        ? active.status().filter((s) => s.state === "error").length
        : 0;
      lines.push(
        `MCP: ${names.length} server(s) configured` +
          (active ? ` · ${active.listRegisteredTools().length} tools loaded` : " · not connected yet (/mcp connect)") +
          (errN ? chalk.yellow(` · ${errN} error(s)`) : ""),
      );
      if (errN) {
        issues.push(
          `MCP: ${errN} server(s) in error state — /mcp status · check command on PATH`,
        );
      }
    }
  } catch {
    /* optional */
  }
  // LSP ensure plan (advisory — missing servers are not hard failures)
  try {
    const { loadLspConfig } = await import("../lsp/config.js");
    const { getActiveLspManager } = await import("../lsp/manager.js");
    const { buildEnsurePlan } = await import("../lsp/ensure.js");
    const ws = config.workspace || process.cwd();
    const lspCfg = loadLspConfig(ws);
    if (!lspCfg.enabled) {
      lines.push(chalk.dim("LSP: disabled (FORGE_LSP=0)"));
    } else {
      const plan = buildEnsurePlan(ws);
      const active = getActiveLspManager();
      const readyN = plan.ready.length;
      const missN = plan.toInstall.length;
      lines.push(
        `LSP: ${readyN} recommended on PATH` +
          (missN ? chalk.yellow(` · ${missN} missing`) : " · ensure pack OK") +
          (active
            ? ` · ${active.status().filter((s) => s.state === "ready").length} live`
            : "") +
          chalk.dim("  (default: TS + Python; project: Rust/Go)"),
      );
      if (missN) {
        const names = plan.toInstall.map((i) => i.languageId).join(", ");
        lines.push(
          chalk.yellow(
            `  missing: ${names} — run forge lsp ensure  (or /lsp ensure)`,
          ),
        );
        // Advisory only — missing LS must not fail doctor/CI (auth/sandbox are hard).
      }
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

  let projectRulesCount = 0;
  let projectCommandsCount = 0;
  let projectSkillsCount = 0;
  let sessionsWithLastError = 0;
  let sessionsUntitled = 0;
  let sessionsTotal = 0;
  let sessionsPinned = 0;
  try {
    const { listProjectRulePaths } = await import("../agent/system-prompt.js");
    projectRulesCount = listProjectRulePaths(
      config.workspace || process.cwd(),
    ).length;
  } catch {
    /* */
  }
  try {
    const { loadProjectCommands } = await import("./project-commands.js");
    projectCommandsCount = loadProjectCommands(
      config.workspace || process.cwd(),
    ).length;
  } catch {
    /* */
  }
  try {
    const { countProjectSkills } = await import("../agent/project-skills.js");
    projectSkillsCount = countProjectSkills(
      config.workspace || process.cwd(),
    );
  } catch {
    /* */
  }
  if (projectSkillsCount > 0) {
    let skillsTokNote = "";
    try {
      const { formatSkillsForPrompt, loadProjectSkills } = await import(
        "../agent/project-skills.js"
      );
      const ws = config.workspace || process.cwd();
      const skills = loadProjectSkills(ws);
      const nBuiltin = skills.filter((s) => s.source === "builtin").length;
      const nOverlay = skills.length - nBuiltin;
      const injected = formatSkillsForPrompt(ws);
      const tok = estimateTokens([{ role: "system", content: injected }]);
      const win = config.contextWindow || 0;
      const pct = win > 0 ? tok / win : 0;
      skillsTokNote = ` ~${formatTokens(tok)} injected`;
      const mix =
        nBuiltin > 0
          ? ` (${nBuiltin} builtin` +
            (nOverlay > 0 ? ` + ${nOverlay} project/user` : "") +
            `)`
          : "";
      if (pct >= 0.12) {
        lines.push(
          chalk.yellow(
            `  ⚠ skills: ${projectSkillsCount}${mix}${skillsTokNote} (~${Math.round(pct * 100)}% of context window) — trim SKILL.md bodies / inject:catalog · /skills · /context`,
          ),
        );
      } else {
        lines.push(
          chalk.dim(
            `  skills: ${projectSkillsCount}${mix}${skillsTokNote}  → /skills · skills/forge-* · .forge/skills/**`,
          ),
        );
      }
    } catch {
      lines.push(
        chalk.dim(
          `  skills: ${projectSkillsCount}  → /skills · skills/forge-* · .forge/skills/**`,
        ),
      );
    }
  } else {
    lines.push(
      chalk.dim(
        `  skills: none · builtins missing? check package skills/ · add .forge/skills/<name>/SKILL.md`,
      ),
    );
  }
  try {
    const { listSessions } = await import("../session/session.js");
    const all = listSessions({ limit: 10_000 });
    sessionsTotal = all.length;
    sessionsWithLastError = all.filter((s) => Boolean(s.lastError?.message)).length;
    sessionsUntitled = all.filter((s) => !String(s.title || "").trim()).length;
    sessionsPinned = all.filter((s) => Boolean(s.pinned)).length;
    if (sessionsWithLastError > 0) {
      const backlog =
        sessionsWithLastError >= 5
          ? `  ⚠ ${sessionsWithLastError} sessions with lastError — review /sessions errors before prune; backlog may hide real incidents`
          : `  sessions with lastError: ${sessionsWithLastError}  → /sessions errors · forge sessions list --errors · prune keeps them until --force-last-error`;
      lines.push(chalk.yellow(backlog));
    }
    if (sessionsUntitled >= 5) {
      lines.push(
        chalk.dim(
          `  untitled sessions: ${sessionsUntitled}/${sessionsTotal}  → /title · --title · /goal set auto-titles · /sessions untitled`,
        ),
      );
    }
    if (sessionsPinned >= 10) {
      lines.push(
        chalk.yellow(
          `  ⚠ ${sessionsPinned} pinned sessions (prune-protected) — /sessions pinned · /unpin stale keepers`,
        ),
      );
    } else if (sessionsPinned > 0) {
      lines.push(
        chalk.dim(
          `  pinned sessions: ${sessionsPinned}  → /sessions pinned · /pin protects from prune`,
        ),
      );
    }
    if (sessionsTotal >= 100) {
      lines.push(
        chalk.yellow(
          `  ⚠ ${sessionsTotal} sessions on disk — consider forge sessions prune --keep 50 (lastError sessions kept unless --force-last-error)`,
        ),
      );
    }
  } catch {
    /* */
  }

  // Format-on-write status (opt-in quality bar)
  try {
    const fmts = detectProjectFormatters(config.workspace || process.cwd());
    if (isFormatOnWriteEnabled()) {
      lines.push(
        chalk.dim(
          `  format-on-write: on` +
            (fmts.length ? ` (${fmts.join(", ")})` : "") +
            `  → after file tools · /format off to disable`,
        ),
      );
    } else if (fmts.length) {
      lines.push(
        chalk.yellow(
          `  format-on-write: off but ${fmts.join("/")} available — /format on · FORGE_FORMAT_ON_WRITE=1`,
        ),
      );
    } else {
      lines.push(
        chalk.dim(
          `  format-on-write: off · /format on · FORGE_FORMAT_ON_WRITE=1 (OpenCode-style)`,
        ),
      );
    }
  } catch {
    /* */
  }

  // Project intelligence + edit-guard knobs (less user steering)
  let packageManager: string | null = null;
  let projectKinds: string[] = [];
  let checkCommands: string[] = [];
  let workspaces: string[] = [];
  let monorepoRoot: string | null = null;
  let projectStackSummary: string | null = null;
  let fileReadGuard = true;
  let verifyHint = true;
  try {
    const { detectProjectIntel } = await import("../util/project-intel.js");
    const { fileReadGuardEnabled } = await import(
      "../agent/tools/file-read-state.js"
    );
    const ws = config.workspace || process.cwd();
    const intel = detectProjectIntel(ws);
    packageManager = intel.packageManager ?? null;
    projectKinds = [...intel.kinds];
    checkCommands = [...intel.checkCommands];
    workspaces = [...(intel.workspaces || [])];
    monorepoRoot = intel.monorepoRoot ?? null;
    projectStackSummary = intel.summary || null;
    if (intel.summary) {
      lines.push(chalk.dim(`  project-stack: ${intel.summary}`));
    } else {
      lines.push(chalk.dim("  project-stack: none detected"));
    }
    if (monorepoRoot) {
      lines.push(chalk.dim(`  monorepo-root: ${monorepoRoot}`));
    }
    if (workspaces.length) {
      lines.push(
        chalk.dim(
          `  workspaces: ${workspaces.slice(0, 6).join(" · ")}` +
            (workspaces.length > 6 ? ` (+${workspaces.length - 6})` : ""),
        ),
      );
    }
    try {
      const {
        packageManagerLockfileMismatch,
        multipleLockfiles,
      } = await import("../util/project-intel.js");
      const mismatch = packageManagerLockfileMismatch(ws);
      if (mismatch) {
        packageManagerMismatch = {
          field: mismatch.field,
          lockfile: mismatch.lockfile,
          detail: mismatch.detail,
        };
        lines.push(chalk.yellow(`  ⚠ ${mismatch.detail}`));
        issues.push(mismatch.detail);
      } else {
        const multi = multipleLockfiles(ws);
        if (multi.length >= 2) {
          multipleLockfilesList = multi;
          const detail =
            `Multiple lockfiles present (${multi.join(", ")}). ` +
            `Pick one package manager and remove the others to avoid install drift.`;
          lines.push(chalk.yellow(`  ⚠ ${detail}`));
          issues.push(detail);
        }
      }
    } catch {
      /* */
    }
    fileReadGuard = fileReadGuardEnabled();
    verifyHint = (() => {
      const v = (process.env.FORGE_VERIFY_HINT || "1").trim().toLowerCase();
      return !(v === "0" || v === "false" || v === "off" || v === "no");
    })();
    if (!fileReadGuard) {
      lines.push(
        chalk.yellow(
          "  ⚠ file-read edit guard OFF (FORGE_FILE_READ_GUARD=0) — blind overwrites allowed",
        ),
      );
      issues.push("file-read-guard-off");
    }
    if (!verifyHint) {
      lines.push(
        chalk.yellow(
          "  ⚠ post-edit verify tip OFF (FORGE_VERIFY_HINT=0) — agents won't be nudged to run project checks after edits",
        ),
      );
      issues.push("verify-hint-off");
    }
    lines.push(
      chalk.dim(
        `  edit-guard: file-read=${fileReadGuard ? "on" : "off"}` +
          ` · verify-hint=${verifyHint ? "on" : "off"}` +
          `  (FORGE_FILE_READ_GUARD · FORGE_VERIFY_HINT)`,
      ),
    );
  } catch {
    /* */
  }

  let setupReady: number | undefined;
  let setupTotal: number | undefined;
  let setupItems: DoctorResult["setupItems"];
  try {
    const assessed = await collectSetupAssessment({
      config,
      auth: auth ?? null,
    });
    setupReady = assessed.ready;
    setupTotal = assessed.total;
    setupItems = assessed.items.map((i) => ({
      id: i.id,
      ready: i.ready,
      severity: i.severity,
      action: i.action,
    }));
    lines.push("");
    lines.push(`Setup: ${assessed.ready}/${assessed.total}  ·  /setup`);
    for (const item of assessed.items.filter((i) => !i.ready)) {
      lines.push(
        chalk.dim(`  [ ] ${item.label}  ${item.detail}  →  ${item.action}`),
      );
    }
  } catch {
    /* setup card is advisory */
  }

  return {
    report: lines.join("\n"),
    issues: [...issues],
    ok: issues.length === 0,
    authenticated: Boolean(auth),
    setupReady,
    setupTotal,
    setupItems,
    blockingStop: !isFalsy(config.blockingStopHooks),
    modelInCatalog,
    fallbackModels: config.fallbackModels,
    fallbackChain: formatFallbackChain(config),
    multiAccount,
    projectRulesCount,
    projectCommandsCount,
    projectSkillsCount,
    sessionsWithLastError,
    sessionsUntitled,
    sessionsTotal,
    sessionsPinned,
    formatOnWrite: isFormatOnWriteEnabled(
      config.workspace || process.cwd(),
    ),
    subagentLandMode: (() => {
      const raw =
        process.env.FORGE_SUBAGENT_LAND ??
        process.env.FORGE_WORKTREE_LAND ??
        "auto";
      const s = String(raw).trim().toLowerCase();
      if (
        s === "0" ||
        s === "false" ||
        s === "off" ||
        s === "discard" ||
        s === "none"
      )
        return "discard" as const;
      if (s === "keep" || s === "manual" || s === "review") return "keep" as const;
      return "auto" as const;
    })(),
    projectMemoryCount: (() => {
      try {
        return listActiveProjectMemory(
          config.workspace || process.cwd(),
        ).length;
      } catch {
        return 0;
      }
    })(),
    packageManager,
    projectKinds,
    checkCommands,
    workspaces,
    monorepoRoot,
    projectStackSummary,
    fileReadGuard,
    verifyHint,
    nodeModulesPresent,
    packageManagerMismatch,
    multipleLockfiles: multipleLockfilesList,
    modelDefaultContextWindow,
    contextWindowRatio,
    gitIsWorktree,
    gitBranch,
    gitRoot,
    gitChangedFiles,
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
  fallbackModels?: string[];
  fallbackChain: string;
  reasoningEffort: string | null;
  /** Undefined = provider/server default (not sent on the wire). */
  temperature: number | undefined;
  /** Effective output cap actually sent (auto per-model unless pinned). */
  maxTokens: number;
  /** True when maxTokens came from an explicit user/config pin. */
  maxTokensExplicit: boolean;
  permissionMode: string;
  sandbox: string;
  sandboxNetwork: string;
  sandboxMissingBackend: string;
  readOutsideWorkspace: string;
  stickyProvider: string | null;
  blockingStopHooks: boolean;
  promptProfile: string;
  contextWindow: number;
  /** True when user pinned context_window (toml/CLI or /context-window). */
  contextWindowExplicit: boolean;
  autoCompactThreshold: number;
  maxTurns: number;
  /** True when maxTurns <= 0 (unlimited agent turns). */
  maxTurnsUnlimited: boolean;
  /** Session spend cap USD (0 = unlimited). */
  maxCostUsd: number;
  /** True when maxCostUsd <= 0 (unlimited spend estimate). */
  maxCostUnlimited: boolean;
  /**
   * Effective cap after session override (null = unlimited).
   * Prefer this for HUD/status over raw maxCostUsd.
   */
  effectiveMaxCostUsd: number | null;
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
  /** Effective format-on-write (env FORGE_FORMAT_ON_WRITE wins over preference). */
  formatOnWrite: boolean;
  subagentLandMode: "auto" | "keep" | "discard";
  projectMemoryCount: number;
  lastCheckpoint: string | null;
  /** Detected package manager when known. */
  packageManager: string | null;
  /** Preferred verification commands. */
  checkCommands: string[];
  /** Compact project-stack summary. */
  projectStackSummary: string | null;
  /** Monorepo root when detected. */
  monorepoRoot: string | null;
  /** Monorepo workspace package labels. */
  workspaces: string[];
  /** package.json packageManager vs lockfile disagreement, if any. */
  packageManagerMismatch: {
    field: string;
    lockfile: string;
    detail: string;
  } | null;
  env: {
    FORGE_HOME: string;
    FORGE_BASH_TIMEOUT_MS: number;
    FORGE_BASH_BG_TIMEOUT_MS: number;
    FORGE_PROVIDER_TIMEOUT_MS: number;
    FORGE_PROVIDER_MAX_MS: number;
    FORGE_DOOM_LOOP_THRESHOLD: number;
    FORGE_ERROR_STREAK_THRESHOLD: number;
    FORGE_FILE_READ_GUARD: boolean;
    FORGE_VERIFY_HINT: boolean;
  };
  /** Turn-end attention (no secrets). */
  attention: { notify: boolean; bell: boolean };
  mcp: { count: number; names: string[] };
  lsp: { missing: string[]; ready: string[] };
  /** Auth method only — never tokens. */
  authMethod: string | null;
}


/** Compact preferred-check + last-verify orientation for mid-run slash status. */
export function formatSlashVerifyOrient(opts: {
  workspace?: string;
  cwd?: string;
  editCount?: number;
  lastVerificationCommand?: string;
  lastVerificationAt?: string;
  lastEditAt?: string;
  /** Prefix each line (default "\n"). */
  linePrefix?: string;
}): string {
  const prefix = opts.linePrefix ?? "\n";
  const bits: string[] = [];
  try {
    const cwd = opts.workspace || opts.cwd || process.cwd();
    const intel = detectProjectIntel(cwd);
    if (intel.checkCommands[0]) {
      bits.push(
        `Preferred checks: ${intel.checkCommands.slice(0, 3).join(" · ")}`,
      );
    }
  } catch {
    /* */
  }
  try {
    const last = opts.lastVerificationCommand?.trim();
    if (last) {
      const stale = isLastVerificationStale({
        lastVerificationAt: opts.lastVerificationAt,
        lastEditAt: opts.lastEditAt,
      })
        ? "  ⚠ stale"
        : "";
      bits.push(
        `Last verify: ${last.slice(0, 80)}${last.length > 80 ? "…" : ""}${stale}`,
      );
    } else if ((opts.editCount || 0) > 0) {
      bits.push(`No last-verify after ${opts.editCount} edit(s)`);
    }
  } catch {
    /* */
  }
  return bits.map((b) => `${prefix}${b}`).join("");
}

/** Session trail line for /notify · /bell · /budget style status. */
export function formatSlashSessionTrail(meta: {
  editCount?: number;
  lastVerificationCommand?: string;
  lastVerificationAt?: string;
  lastEditAt?: string;
}): string {
  try {
    const edits = meta.editCount || 0;
    const last = meta.lastVerificationCommand?.trim();
    if (!(edits > 0 || last)) return "";
    if (last) {
      return isLastVerificationStale(meta)
        ? `Session trail: edits=${edits} · last-verify stale (${last.slice(0, 40)})`
        : `Session trail: edits=${edits} · last-verify ${last.slice(0, 40)}`;
    }
    return `Session trail: edits=${edits} · no last-verify`;
  } catch {
    return "";
  }
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
    fallbackModels: c.fallbackModels,
    fallbackChain: formatFallbackChain(c),
    reasoningEffort: c.reasoningEffort ?? null,
    temperature: c.temperature,
    maxTokens: effectiveMaxTokensForDisplay(c),
    maxTokensExplicit: Boolean(c.maxTokensExplicit),
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
    blockingStopHooks: !isFalsy(c.blockingStopHooks),
    promptProfile: c.promptProfile ?? "default",
    contextWindow: c.contextWindow,
    contextWindowExplicit: Boolean(c.contextWindowExplicit),
    autoCompactThreshold: c.autoCompactThreshold,
    maxTurns: c.maxTurns,
    maxTurnsUnlimited: !(typeof c.maxTurns === "number" && c.maxTurns > 0),
    maxCostUsd: typeof c.maxCostUsd === "number" ? c.maxCostUsd : 0,
    maxCostUnlimited: !(typeof c.maxCostUsd === "number" && c.maxCostUsd > 0),
    effectiveMaxCostUsd: resolveMaxCostUsd(c, session?.meta),
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
    formatOnWrite: isFormatOnWriteEnabled(
      c.workspace || session?.meta.cwd || process.cwd(),
    ),
    subagentLandMode: (() => {
      const raw =
        process.env.FORGE_SUBAGENT_LAND ??
        process.env.FORGE_WORKTREE_LAND ??
        "auto";
      const s = String(raw).trim().toLowerCase();
      if (
        s === "0" ||
        s === "false" ||
        s === "off" ||
        s === "discard" ||
        s === "none"
      )
        return "discard" as const;
      if (s === "keep" || s === "manual" || s === "review") return "keep" as const;
      return "auto" as const;
    })(),
    projectMemoryCount: (() => {
      try {
        return listActiveProjectMemory(
          c.workspace || session?.meta.cwd || process.cwd(),
        ).length;
      } catch {
        return 0;
      }
    })(),
    lastCheckpoint: session?.meta.lastCheckpoint ?? null,
    ...(() => {
      try {
        const cwd = c.workspace || session?.meta.cwd || process.cwd();
        const intel = detectProjectIntel(cwd);
        let packageManagerMismatch: {
          field: string;
          lockfile: string;
          detail: string;
        } | null = null;
        try {
          const mm = packageManagerLockfileMismatch(cwd);
          if (mm) {
            packageManagerMismatch = {
              field: mm.field,
              lockfile: mm.lockfile,
              detail: mm.detail,
            };
          }
        } catch {
          /* */
        }
        return {
          packageManager: intel.packageManager ?? null,
          checkCommands: [...intel.checkCommands],
          projectStackSummary: intel.summary || null,
          monorepoRoot: intel.monorepoRoot ?? null,
          workspaces: [...(intel.workspaces || [])],
          packageManagerMismatch,
        };
      } catch {
        return {
          packageManager: null as string | null,
          checkCommands: [] as string[],
          projectStackSummary: null as string | null,
          monorepoRoot: null as string | null,
          workspaces: [] as string[],
          packageManagerMismatch: null as {
            field: string;
            lockfile: string;
            detail: string;
          } | null,
        };
      }
    })(),
    env: {
      FORGE_HOME:
        process.env.FORGE_HOME || path.join(process.env.HOME || "", ".forge"),
      FORGE_BASH_TIMEOUT_MS: defaultBashTimeoutMs(),
      FORGE_BASH_BG_TIMEOUT_MS: defaultBashBackgroundTimeoutMs(),
      FORGE_PROVIDER_TIMEOUT_MS: providerTimeoutMs(),
      FORGE_PROVIDER_MAX_MS: providerMaxWallMs(),
      FORGE_DOOM_LOOP_THRESHOLD: envPositiveInt("FORGE_DOOM_LOOP_THRESHOLD", 3),
      FORGE_ERROR_STREAK_THRESHOLD: envPositiveInt(
        "FORGE_ERROR_STREAK_THRESHOLD",
        5,
      ),
      FORGE_FILE_READ_GUARD: (() => {
        try {
          // Lazy require-style import would be async; inline same logic as file-read-state.
          const v = (process.env.FORGE_FILE_READ_GUARD || "1")
            .trim()
            .toLowerCase();
          return v !== "0" && v !== "false" && v !== "off" && v !== "no";
        } catch {
          return true;
        }
      })(),
      FORGE_VERIFY_HINT: (() => {
        const v = (process.env.FORGE_VERIFY_HINT || "1").trim().toLowerCase();
        return !(v === "0" || v === "false" || v === "off" || v === "no");
      })(),
    },
    attention: {
      notify: isNotifyEnabled(),
      bell: isBellEnabled(),
    },
    mcp: (() => {
      try {
        const ws = c.workspace || session?.meta.cwd || process.cwd();
        const cfg = loadMcpConfig(ws);
        const names = Object.keys(cfg.servers || {}).filter(Boolean);
        return { count: names.length, names };
      } catch {
        return { count: 0, names: [] as string[] };
      }
    })(),
    lsp: (() => {
      try {
        const ws = c.workspace || session?.meta.cwd || process.cwd();
        const plan = buildEnsurePlan(ws);
        return {
          missing: plan.items
            .filter(
              (i) =>
                (i.tier === "default" || i.tier === "project") && !i.onPath,
            )
            .map((i) => String(i.languageId)),
          ready: plan.ready.map((i) => String(i.languageId)),
        };
      } catch {
        return { missing: [] as string[], ready: [] as string[] };
      }
    })(),
    authMethod: (() => {
      try {
        return resolveAuth(c)?.method ?? null;
      } catch {
        return null;
      }
    })(),
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
    `  fallback:        ${snap.fallbackChain}`,
    `  sampling:        temp=${snap.temperature ?? "default"}  max_tokens=${snap.maxTokens}${snap.maxTokensExplicit ? "" : " (auto)"}` +
      chalk.dim("  (/temperature · /max-tokens)"),
    `  permission:      ${snap.permissionMode}` +
      (snap.permissionMode === "plan"
        ? "  (read-only · exit_plan_mode or /build)"
        : ""),
    `  sandbox:         ${snap.sandbox}  network=${snap.sandboxNetwork}  missing=${snap.sandboxMissingBackend}`,
    `  read outside:    ${snap.readOutsideWorkspace}`,
    `  sticky provider: ${snap.stickyProvider ?? "(none)"}`,
    `  format-on-write: ${snap.formatOnWrite ? "on" : "off"}  (/format · FORGE_FORMAT_ON_WRITE)`,
    `  attention:        notify=${snap.attention.notify ? "on" : "off"}  bell=${snap.attention.bell ? "on" : "off"}` +
      chalk.dim("  (/notify · /bell)"),
    `  mcp:              ${
      snap.mcp.count
        ? `${snap.mcp.count} (${snap.mcp.names.slice(0, 4).join(", ")}${snap.mcp.names.length > 4 ? "…" : ""})`
        : "none"
    }` + chalk.dim("  ·  /mcp"),
    `  lsp:              ${
      snap.lsp.missing.length
        ? `missing ${snap.lsp.missing.join(", ")}`
        : snap.lsp.ready.length
          ? `ready ${snap.lsp.ready.join(", ")}`
          : "none"
    }` + chalk.dim("  ·  /lsp ensure"),
    snap.authMethod
      ? `  auth:             ${snap.authMethod}  ·  /auth`
      : `  auth:             (none)  ·  forge login`,
    `  subagent land:   ${snap.subagentLandMode}  (FORGE_SUBAGENT_LAND=auto|keep|discard)`,
    `  project memory:  ${snap.projectMemoryCount} active  · /memory project`,
    snap.lastCheckpoint
      ? `  checkpoint:      ${snap.lastCheckpoint.slice(0, 12)}…  · /checkpoint restore`
      : `  checkpoint:      (none)  · /checkpoint`,
    `  edit-guard:      file-read=${snap.env.FORGE_FILE_READ_GUARD ? "on" : "off"}` +
      `  verify-hint=${snap.env.FORGE_VERIFY_HINT ? "on" : "off"}` +
      `  (FORGE_FILE_READ_GUARD · FORGE_VERIFY_HINT)`,
    `  blocking Stop:   ${snap.blockingStopHooks ? "on" : "OFF"}`,
    `  profile:         ${snap.promptProfile}`,
    `  context:         window=${snap.contextWindow}` +
      (snap.contextWindowExplicit ? " (pinned)" : " (auto)") +
      ` autoCompact@${Math.round((snap.autoCompactThreshold || 0.8) * 100)}% maxTurns=${snap.maxTurns > 0 ? snap.maxTurns : "unlimited"}` +
      chalk.dim("  (/context-window)"),
    `  cost budget:     ${
      snap.effectiveMaxCostUsd != null
        ? `$${snap.effectiveMaxCostUsd}`
        : "unlimited"
    }  (/budget · --max-cost · FORGE_MAX_COST_USD)`,
    `  goal gate:       ${snap.goalEnabled ? "on" : "off"}` +
      (snap.goalStuckThreshold != null
        ? `  stuck=${snap.goalStuckThreshold}`
        : ""),
    `  rules:           deny=${snap.rules.deny} allow=${snap.rules.allow} ask=${snap.rules.ask}`,
    `  workspace:       ${snap.workspace}`,
    snap.projectStackSummary
      ? `  project-stack:   ${snap.projectStackSummary}`
      : snap.packageManager
        ? `  project-stack:   pm=${snap.packageManager}` +
          (snap.checkCommands[0] ? ` · ${snap.checkCommands[0]}` : "")
        : null,
    snap.monorepoRoot
      ? `  monorepo-root:   ${snap.monorepoRoot}`
      : null,
    snap.packageManagerMismatch
      ? `  pm-mismatch:     ${snap.packageManagerMismatch.detail}`
      : null,
    `  FORGE_HOME:      ${snap.env.FORGE_HOME}`,
    snap.baseUrl ? `  api base:        ${snap.baseUrl}` : null,
    sess
      ? `  session:         ${sess.id!.slice(0, 8)}` +
        (sess.title ? `  “${sess.title}”` : "") +
        (sess.ultrawork ? "  ULW" : "") +
        (sess.pinned ? "  PIN" : "") +
        `  t=${sess.turns} e=${sess.edits}`
      : null,
    `  timeouts:        provider-stall=${Math.round(snap.env.FORGE_PROVIDER_TIMEOUT_MS / 1000)}s` +
      (snap.env.FORGE_PROVIDER_MAX_MS > 0
        ? `  provider-max=${Math.round(snap.env.FORGE_PROVIDER_MAX_MS / 1000)}s`
        : "") +
      `  bash=${Math.round(snap.env.FORGE_BASH_TIMEOUT_MS / 1000)}s` +
      `  bash-bg=${Math.round(snap.env.FORGE_BASH_BG_TIMEOUT_MS / 1000)}s`,
    `  loop guards:     doom@${snap.env.FORGE_DOOM_LOOP_THRESHOLD}  error-streak@${snap.env.FORGE_ERROR_STREAK_THRESHOLD}`,
    chalk.dim(
      sess
        ? `  /config json · /provider · /model · /context-window · /temperature · /max-tokens · /doctor`
        : `  forge config --json · forge doctor · forge tips`,
    ),
  ].filter(Boolean) as string[];
  return lines.join("\n");
}

/** OpenCode-inspired code review prompt (scoped target). */
/**
 * Prompt for /commit — draft a high-quality commit message from the diff.
 * Default is draft-only; doCommit opts into `git commit` (never push).
 */
export function buildCommitPrompt(opts: {
  workspace: string;
  stagedOnly?: boolean;
  doCommit?: boolean;
  lastVerificationCommand?: string;
}): string {
  const workspace = opts.workspace;
  const stagedOnly = Boolean(opts.stagedOnly);
  const doCommit = Boolean(opts.doCommit);

  let checksBlock = "";
  try {
    const intel = detectProjectIntel(workspace);
    if (intel.checkCommands.length) {
      checksBlock =
        `\nPreferred project checks (run before committing if you touch code):\n` +
        intel.checkCommands.slice(0, 4).map((c) => `- \`${c}\``).join("\n") +
        "\n";
    }
  } catch {
    checksBlock = "";
  }
  const last = opts.lastVerificationCommand?.trim();
  if (last) {
    checksBlock +=
      `Last verification this session: \`${last.slice(0, 120)}\` ` +
      `(re-run if the diff changed code since).\n`;
  }

  const scope = stagedOnly
    ? "staged changes only (`git diff --cached`)"
    : "all uncommitted changes (`git status` + `git diff HEAD`)";

  if (doCommit) {
    return `Create a git commit for the ${scope} in \`${workspace}\`.

## Hard rules
- **Never** \`git push\`, \`--force\`, amend others' commits, or change git config
- Do **not** use \`git commit --no-verify\` unless the user explicitly asked
- If there is nothing to commit, say so and stop
- Prefer staging intentional paths (\`git add <paths>\`) over \`git add -A\` unless the whole tree is clearly the unit of work
- Run a cheap project check first when code changed${checksBlock ? " (see Preferred project checks)" : ""}

## Steps
1. Inspect \`git status\` and the relevant diff (${scope})
2. If checks are warranted and cheap, run the top preferred check
3. Stage the right files if needed
4. Commit with a concise message:
   - subject ≤72 chars, imperative mood ("Add…", "Fix…", "Refactor…")
   - optional body explaining *why*, not a file list
5. Show \`git log -1 --stat\` and stop (no push)

${checksBlock}
Start now.`;
  }

  return `Draft a git commit message for the ${scope} in \`${workspace}\`.

## Hard rules
- **Do not** run \`git commit\`, \`git add\`, or \`git push\` — draft only
- Read the real diff with tools; do not invent changes

## Deliverable
1. One recommended subject line (≤72 chars, imperative)
2. Optional 2–5 line body (why / risk / follow-ups)
3. Bullet list of paths that should be staged for this commit
4. One-line note if the tree looks like it should be split into multiple commits
${checksBlock}
When the user wants the commit created they can run \`/commit do\` (or \`/commit staged do\`).

Start by inspecting git status and the diff.`;
}

export function buildReviewPrompt(
  target: string,
  workspace: string,
  opts?: { lastVerificationCommand?: string },
): string {
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

  let checksBlock = "";
  try {
    const intel = detectProjectIntel(workspace);
    if (intel.checkCommands.length) {
      checksBlock =
        `\n## Preferred verification (detected)\n` +
        intel.checkCommands.map((c) => `- \`${c}\``).join("\n") +
        `\nUse these at the end of the review when applicable; do not invent a different package manager.\n`;
    }
  } catch {
    checksBlock = "";
  }
  const last = opts?.lastVerificationCommand?.trim();
  if (last) {
    checksBlock +=
      `\nLast verification this session: \`${last.slice(0, 120)}\` ` +
      `(note whether the diff still matches that proof).\n`;
  }

  return `You are a code reviewer. Review the changes in workspace \`${workspace}\` and provide actionable feedback.

Target argument: \`${t}\`

${scopeBlock}
${checksBlock}
## Gathering context
Diffs alone are not enough. After the diff, read the entire file(s) being modified to understand surrounding logic. Check AGENTS.md / CONTRIBUTING / style configs when relevant. Prefer executable sources of truth over prose.

## What to look for (priority order)
1. **Bugs** — logic errors, missing guards, race conditions, broken error handling, security (injection, path escape, secret leak)
2. **Siblings & dependents** — same defect class elsewhere; callers/tests/docs/config left inconsistent with the change
3. **Behavior changes** — unintentional API/CLI/contract shifts
4. **Structure** — fights existing patterns; missing shared helpers
5. **Performance** — only if obviously bad (unbounded O(n²), sync I/O on hot paths)

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
5. End with suggested verification commands from Preferred verification above (or test/typecheck) when applicable

Start by gathering the diff with tools, then read the important files, then write the review.`;
}

/** OpenCode-inspired AGENTS.md bootstrap prompt. */
export function buildInitAgentsPrompt(focus: string, workspace: string): string {
  const focusBlock = focus
    ? `\nUser-provided focus or constraints (honor these):\n${focus}\n`
    : "";
  // Pre-detected stack so /init does not rediscover package manager / checks.
  let detectedBlock = "";
  try {
    const intel = detectProjectIntel(workspace);
    const lines: string[] = [];
    if (intel.summary) lines.push(`- Summary: ${intel.summary}`);
    if (intel.packageManager) lines.push(`- Package manager: ${intel.packageManager}`);
    if (intel.checkCommands.length) {
      lines.push(`- Preferred checks (cheapest first): ${intel.checkCommands.join(" · ")}`);
    }
    if (intel.monorepoRoot) lines.push(`- Monorepo root: ${intel.monorepoRoot}`);
    if (intel.workspaces?.length) {
      lines.push(
        `- Workspaces: ${intel.workspaces.slice(0, 8).join(" · ")}` +
          (intel.workspaces.length > 8
            ? ` (+${intel.workspaces.length - 8} more)`
            : ""),
      );
    }
    if (lines.length) {
      detectedBlock =
        `\n## Already detected by Forge (verify, then put the real commands in AGENTS.md)\n\n` +
        lines.join("\n") +
        `\n\nDo not invent a different package manager when one is detected. Prefer these check commands unless investigation proves better ones.\n`;
    }
  } catch {
    detectedBlock = "";
  }
  return `Create or update \`AGENTS.md\` for this repository at the workspace root (${workspace}).

The goal is a compact instruction file that helps future Forge sessions avoid mistakes and ramp up quickly. Every line should answer: "Would an agent likely miss this without help?" If not, leave it out.

Forge also loads (nearest wins within the git root): \`FORGE.md\`, \`CLAUDE.md\`, \`.forge/rules.md\`, \`.github/copilot-instructions.md\`, \`.cursorrules\`, \`.cursor/rules/*.{md,mdc}\`, and optional \`~/.forge/AGENTS.md\`. Prefer a single high-signal \`AGENTS.md\` at the package or monorepo root rather than duplicating the same rules everywhere.
${focusBlock}${detectedBlock}
## How to investigate

Read the highest-value sources first:
- \`README*\`, root manifests (\`package.json\`, \`Cargo.toml\`, \`pyproject.toml\`, …), lockfiles
- build, test, lint, formatter, typecheck, and codegen config
- CI workflows and pre-commit / task runner config
- existing instruction files (\`AGENTS.md\`, \`CLAUDE.md\`, \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\`)
- repo-local Forge config (\`.forge/config.toml\`), custom slash templates (\`.forge/commands/*.md\`), and skill packs (\`.forge/skills/**/SKILL.md\`) if present

If architecture is still unclear after reading config and docs, inspect a small number of representative code files to find the real entrypoints, package boundaries, and execution flow. Prefer reading the files that explain how the system is wired together over random leaf files.

Prefer executable sources of truth over prose. If docs conflict with config or scripts, trust the executable source and only keep what you can verify.

## What to extract

Look for the highest-signal facts for an agent working in this repo:
- exact developer commands, especially non-obvious ones (\`npm test\`, single-test invocation, typecheck) — start from the detected checks above
- required command order when it matters
- monorepo or multi-package boundaries and real entrypoints
- framework or toolchain quirks: generated code, migrations, special env loading
- repo-specific style or workflow conventions that differ from defaults
- testing quirks: fixtures, integration prerequisites, flaky or expensive suites
- important constraints from existing instruction files worth preserving
- safety / blast-radius notes (migrations, prod credentials, force-push, data loss)
- optional: 1–2 high-value custom slash ideas for \`.forge/commands/<name>.md\` (\`$ARGUMENTS\` / \`$1..$9\`) if the repo has repeated expert workflows — mention them in AGENTS.md; only create the files if the user asked
- optional: 1 high-value skill pack idea for \`.forge/skills/<name>/SKILL.md\` (OpenCode-style playbook with optional frontmatter \`name\`/\`description\`) when the repo has a multi-step expert workflow that should always be followed the same way — mention it in AGENTS.md; only create the skill file if the user asked or the workflow is clearly non-obvious

## Writing rules

- Prefer short sections and bullets
- Exclude generic software advice, long tutorials, exhaustive file trees, speculative claims
- If \`AGENTS.md\` already exists, improve it in place rather than rewriting blindly
- Preserve verified useful guidance; delete fluff or stale claims
- After writing, briefly summarize what changed and why
- Tip for humans using Forge: \`/plan\` for read-only design, \`exit_plan_mode\` or \`/build\` to implement; \`!cmd\` / \`@path\` / \`/paste\`; \`/commands\` lists project slash templates; \`/skills\` lists skill packs; \`forge doctor\` / \`/context\` show loaded instruction sources, skill counts, and project stack

Do the research with tools, then write or update \`AGENTS.md\` now.`;
}

export { HELP_TEXT, HELP_ALL, helpFor } from "./help-text.js";

