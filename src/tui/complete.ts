/**
 * Tab-completion for slash commands and their parameters.
 * Returns [matches, sharedPrefix] for readline.completer.
 */
import type { ForgeConfig } from "../config/types.js";
import {
  REASONING_EFFORT_DESCRIPTIONS,
  effortLevelsForModel,
  modelSupportsReasoningEffort,
  resolveReasoningEffort,
} from "../config/reasoning.js";
import { buildModelCatalogSync } from "../config/model-catalog.js";
import { SLASH_COMMANDS } from "../commands/slash.js";
import { listProjectCommandSlashes } from "../commands/project-commands.js";
import { PROVIDER_IDS } from "../util/provider-id.js";

export interface ParamChoice {
  value: string;
  description: string;
  aliases?: string[];
}

/** Parameter catalogs per command (without leading slash). */
export const COMMAND_PARAMS: Record<string, ParamChoice[]> = {
  permissions: [
    {
      value: "default",
      description: "Ask for writes/shell; auto-allow reads",
    },
    {
      value: "acceptEdits",
      description: "Auto-approve file edits; may still ask on dangerous shell",
      aliases: ["accept", "edits"],
    },
    {
      value: "plan",
      description: "Read-only design (sticky via /permissions; prefer /plan session-only)",
    },
    {
      value: "bypassPermissions",
      description: "Always approve everything (full YOLO)",
      aliases: ["bypass", "yolo", "always", "auto"],
    },
    {
      value: "dontAsk",
      description: "Never prompt — deny anything without an allow rule (CI-safe)",
      aliases: ["dont-ask", "no-ask", "never-ask", "deny", "ask"],
    },
    {
      value: "list",
      description: "Show saved always-allow rules for this workspace",
    },
    {
      value: "clear",
      description: "Clear saved always-allows for this workspace",
    },
    {
      value: "revoke",
      description: "Revoke one saved rule: /permissions revoke <id>",
    },
    // After modes so Tab numbers 1–5 stay stable for experts
    {
      value: "build",
      description: "Leave plan → restore prior mode (alias of /build)",
      aliases: ["execute", "implement"],
    },
  ],
  plan: [
    {
      value: "focus on auth + tests",
      description: "Optional plan focus (session-scoped; no sticky prefs)",
    },
    {
      value: "design the migration",
      description: "Optional design focus before /build",
    },
  ],
  build: [
    {
      value: "implement the agreed plan",
      description: "Optional note when leaving plan mode",
    },
  ],
  execute: [
    {
      value: "implement the agreed plan",
      description: "Alias of /build",
    },
  ],
  cycle: [
    { value: "1", description: "CONTINUE — relentless waves (Stop blocked)" },
    { value: "0", description: "LAST — finish current wave then stop" },
    { value: "status", description: "Show cycle flag, wave, mandate" },
  ],
  "max-waves": [
    { value: "3", description: "Cap at 3 waves (auto LAST when wave hits 3)" },
    { value: "5", description: "Cap at 5 waves" },
    { value: "10", description: "Cap at 10 waves" },
    {
      value: "off",
      description: "Unlimited waves (clear cap)",
      aliases: ["none", "clear", "unlimited", "0"],
    },
    { value: "status", description: "Show max_waves + ULW status" },
  ],
  accounts: [
    { value: "list", description: "List all stored accounts" },
    {
      value: "status",
      description: "Unattended readiness (eligible/cooldown/auto-switch)",
    },
    { value: "switch", description: "Switch active: /accounts switch <id|label>" },
    { value: "remove", description: "Remove one account" },
    { value: "rename", description: "Rename: /accounts rename <id> <label>" },
    { value: "priority", description: "Set auto-switch priority" },
    { value: "disable", description: "Disable an account" },
    { value: "enable", description: "Re-enable an account" },
    {
      value: "clear-cooldown",
      description: "Clear rate-limit cooldown (id|provider|all)",
    },
    {
      value: "auto-switch",
      description: "on|off|status — smart switch on low usage",
    },
  ],
  provider: [
    { value: "openrouter", description: "OpenRouter (free-form model ids)", aliases: ["or", "router"] },
    { value: "xai", description: "xAI / Grok", aliases: ["grok"] },
    { value: "anthropic", description: "Anthropic Claude", aliases: ["claude"] },
    { value: "openai", description: "OpenAI", aliases: ["gpt", "oai"] },
    { value: "google", description: "Google Gemini", aliases: ["gemini"] },
    { value: "copilot", description: "GitHub Copilot", aliases: ["github"] },
    { value: "custom", description: "Custom OpenAI-compat base URL" },
    { value: "list", description: "List providers + auth" },
    { value: "status", description: "Same as list" },
  ],
  temperature: [
    { value: "0", description: "Deterministic" },
    { value: "0.2", description: "Default coding" },
    { value: "0.7", description: "More creative" },
    { value: "1", description: "High variance" },
  ],
  temp: [
    { value: "0", description: "Deterministic" },
    { value: "0.2", description: "Default coding" },
    { value: "0.7", description: "More creative" },
  ],
  "max-tokens": [
    { value: "4096", description: "Short replies" },
    { value: "8192", description: "Medium" },
    { value: "16384", description: "Default" },
    { value: "32768", description: "Long agent turns" },
    { value: "65536", description: "Very long" },
  ],
  maxtokens: [
    { value: "8192", description: "Medium" },
    { value: "16384", description: "Default" },
    { value: "32768", description: "Long" },
  ],
  "context-window": [
    { value: "auto", description: "Follow model max (default)" },
    { value: "128k", description: "128,000 tokens" },
    { value: "200k", description: "200,000 tokens" },
    { value: "256k", description: "256,000 tokens" },
    { value: "500k", description: "500,000 tokens" },
    { value: "1m", description: "1,000,000 tokens" },
  ],
  "ctx-window": [
    { value: "auto", description: "Follow model max" },
    { value: "1m", description: "1,000,000 tokens" },
    { value: "200k", description: "200,000 tokens" },
  ],
  account: [
    { value: "list", description: "List all stored accounts" },
    { value: "status", description: "Unattended readiness summary" },
    { value: "switch", description: "Switch active account" },
    { value: "clear-cooldown", description: "Clear rate-limit cooldown" },
    { value: "auto-switch", description: "on|off|status" },
  ],
  goal: [
    { value: "status", description: "Show current goal" },
    { value: "pause", description: "Pause goal driver" },
    { value: "resume", description: "Resume paused goal" },
    { value: "clear", description: "Clear goal" },
    { value: "done", description: "Mark goal achieved" },
    { value: "set", description: "Set goal: /goal set <objective>" },
  ],
  done: [
    {
      value: "shipped",
      description: "Optional note (alias of /goal done)",
    },
  ],
  pause: [],
  unpause: [],
  ulw: [
    {
      value: "improve the code",
      description: "Soft god-scope (example)",
    },
  ],
  compact: [],
  "compact-and": [
    {
      value: "continue with the next step",
      description: "Follow-up prompt after compact",
    },
  ],
  "fork-and-compact": [
    {
      value: "try the alternate approach",
      description: "Optional follow-up in the compacted fork",
    },
  ],
  init: [
    {
      value: "focus on test commands",
      description: "Optional focus for AGENTS.md bootstrap",
    },
  ],
  review: [
    { value: "uncommitted", description: "Working tree (default)" },
    { value: "staged", description: "Staged changes only" },
    { value: "main", description: "Diff main...HEAD" },
    { value: "origin/main", description: "Diff origin/main...HEAD" },
  ],
  rewind: [
    { value: "1", description: "Undo last user turn (+ restore journaled files)" },
    { value: "2", description: "Undo last 2 user turns (+ disk)" },
  ],
  undo: [
    { value: "1", description: "Undo last user turn (+ restore journaled files)" },
  ],
  retry: [
    {
      value: "try a different approach",
      description: "Optional rewritten prompt (default: same as last turn)",
    },
  ],
  again: [
    {
      value: "be more thorough",
      description: "Optional rewritten prompt (alias of /retry)",
    },
  ],
  export: [
    { value: "--json", description: "Export machine-readable JSON" },
  ],
  stats: [
    { value: "7", description: "Last 7 days of metrics" },
    { value: "30", description: "Last 30 days of metrics" },
    { value: "90", description: "Last 90 days of metrics" },
  ],
  share: [
    { value: "nocopy", description: "Print card only (skip clipboard)", aliases: ["--no-clip", "print"] },
  ],
  last: [
    { value: "1", description: "Show the most recent turn" },
    { value: "3", description: "Show last 3 turns" },
    { value: "5", description: "Show last 5 turns" },
  ],
  files: [
    { value: "writes", description: "Only mutations (write/edit/patch/delete)", aliases: ["mutations", "edits", "m"] },
    { value: "all", description: "Reads + writes (default)", aliases: ["reads"] },
    { value: "20", description: "Limit to 20 paths" },
  ],
  logs: [
    { value: "20", description: "Last 20 sandbox/safety events" },
    { value: "50", description: "Last 50 events" },
    { value: "0", description: "All events in the read window", aliases: ["all", "--all"] },
    { value: "path", description: "Print sandbox.jsonl path only", aliases: ["--path", "-p"] },
  ],
  config: [
    { value: "json", description: "Machine-readable JSON snapshot", aliases: ["--json", "-j"] },
  ],
  path: [
    { value: "json", description: "Print session.json path only", aliases: ["--json", "-j"] },
    { value: "copy", description: "Copy path to clipboard", aliases: ["--copy", "-c", "clip"] },
  ],
  news: [
    { value: "1", description: "Latest release highlights" },
    { value: "2", description: "Last 2 releases" },
    { value: "3", description: "Last 3 releases" },
  ],
  changelog: [
    { value: "1", description: "Latest release highlights" },
    { value: "2", description: "Last 2 releases" },
  ],
  fork: [
    { value: "experiment", description: "Optional title for the forked session" },
  ],
  new: [
    {
      value: "incident-label",
      description: "Optional title for the new session (searchable)",
    },
  ],
  clear: [
    {
      value: "hard",
      description: "Brand-new session id (drop history + ULW; same as /new)",
    },
  ],
  resume: [
    { value: "all", description: "List sessions from every workspace", aliases: ["global", "-a"] },
    {
      value: "my-feature",
      description: "Resume by unique /title (or id prefix ≥4)",
    },
  ],
  sessions: [
    { value: "all", description: "List every workspace (default is same-cwd)", aliases: ["global", "-a"] },
    { value: "pinned", description: "Only pin-protected sessions", aliases: ["pins", "pin"] },
    {
      value: "errors",
      description: "Only sessions with lastError (recovery backlog)",
      aliases: ["failed", "err", "error", "fail"],
    },
    {
      value: "untitled",
      description: "Only sessions without a title",
      aliases: ["notitle", "no-title", "nameless"],
    },
    { value: "search", description: "Filter by id/title/last-prompt: /sessions search <q>", aliases: ["q", "find"] },
    { value: "delete", description: "Delete session: /sessions delete <id|title> [--force]", aliases: ["rm", "remove"] },
    { value: "prune", description: "Prune old sessions (active protected)" },
  ],
  title: [
    { value: "clear", description: "Clear title (auto-fills from next user msg)" },
  ],
  rename: [
    { value: "clear", description: "Clear title (auto-fills from next user msg)" },
  ],
  bell: [
    { value: "on", description: "Ring terminal BEL when a turn ends", aliases: ["1", "enable"] },
    { value: "off", description: "Disable turn-end bell", aliases: ["0", "disable"] },
    { value: "test", description: "Ring once now", aliases: ["ring"] },
    { value: "status", description: "Show current bell setting" },
  ],
  pin: [
    { value: "on", description: "Protect this session from prune", aliases: ["1", "true"] },
    { value: "off", description: "Allow prune to delete this session", aliases: ["0", "false", "unpin"] },
    { value: "toggle", description: "Flip pin state" },
    { value: "status", description: "Show whether this session is pinned" },
  ],
  unpin: [
    { value: "", description: "Remove pin (allow prune)" },
  ],
  effort: [
    {
      value: "max",
      description: REASONING_EFFORT_DESCRIPTIONS.max,
      aliases: ["maximum", "full"],
    },
    {
      value: "xhigh",
      description: REASONING_EFFORT_DESCRIPTIONS.xhigh,
      aliases: ["x-high", "ultra", "extra"],
    },
    {
      value: "high",
      description: REASONING_EFFORT_DESCRIPTIONS.high,
      aliases: ["h", "hi", "deep"],
    },
    {
      value: "medium",
      description: REASONING_EFFORT_DESCRIPTIONS.medium,
      aliases: ["m", "med", "mid"],
    },
    {
      value: "low",
      description: REASONING_EFFORT_DESCRIPTIONS.low,
      aliases: ["l", "lo"],
    },
    {
      value: "minimal",
      description: REASONING_EFFORT_DESCRIPTIONS.minimal,
      aliases: ["min"],
    },
  ],
};

export function formatParamMenu(
  cmd: string,
  choices: ParamChoice[],
  current?: string,
): string {
  const lines = [
    `${cmd} — pick a value (Tab completes; or type number / name):`,
    ...choices.map((c, i) => {
      const n = String(i + 1).padStart(2);
      const cur = current && c.value === current ? "  ← current" : "";
      return `  ${n}. ${c.value.padEnd(20)} ${c.description}${cur}`;
    }),
  ];
  return lines.join("\n");
}

/** Resolve "2" or partial name / alias to a param value. */
export function resolveParamChoice(
  arg: string,
  choices: ParamChoice[],
): string | null {
  const t = arg.trim();
  if (!t) return null;
  // number
  if (/^\d+$/.test(t)) {
    const idx = parseInt(t, 10) - 1;
    if (idx >= 0 && idx < choices.length) return choices[idx].value;
    return null;
  }
  const lower = t.toLowerCase();
  // exact
  const exact = choices.find((c) => c.value.toLowerCase() === lower);
  if (exact) return exact.value;
  // alias exact
  for (const c of choices) {
    if (c.aliases?.some((a) => a.toLowerCase() === lower)) return c.value;
  }
  // unique prefix
  const prefix = choices.filter(
    (c) =>
      c.value.toLowerCase().startsWith(lower) ||
      c.aliases?.some((a) => a.toLowerCase().startsWith(lower)),
  );
  if (prefix.length === 1) return prefix[0].value;
  return null;
}

/**
 * Full completer for the REPL.
 * - `/pe` → `/permissions`
 * - `/permissions a` → `/permissions acceptEdits`
 * - `/permissions ` → all modes
 * - bare line may complete common commands starting with /
 */
export function forgeCompleter(
  line: string,
  config?: ForgeConfig,
): [string[], string] {
  const raw = line;
  // Only complete from last segment for space-separated slash cmds
  if (!raw.trimStart().startsWith("/") && !raw.startsWith("/")) {
    // offer slash commands when user typed nothing useful? empty → show all /
    if (raw.trim() === "") {
      return [[...SLASH_COMMANDS], raw];
    }
    return [[], raw];
  }

  const trimmedStart = raw; // keep spaces for readline
  const parts = raw.trimStart().split(/\s+/);
  const cmdToken = parts[0].toLowerCase();

  // Command name only (no space yet, or incomplete command)
  if (parts.length === 1 && !raw.endsWith(" ") && !raw.match(/^\/\S+\s/)) {
    const ws = config?.workspace || process.cwd();
    let custom: string[] = [];
    try {
      custom = listProjectCommandSlashes(ws);
    } catch {
      /* */
    }
    const catalog = [...new Set([...SLASH_COMMANDS, ...custom])];
    const hits = catalog.filter((c) => c.startsWith(cmdToken));
    // Prefer returning full command paths for autofill
    if (hits.length === 0) {
      // fuzzy contains (built-in + project custom)
      const bare = cmdToken.replace(/^\//, "");
      const fuzzy = catalog.filter((c) => c.slice(1).includes(bare));
      return [fuzzy.length ? fuzzy : catalog, raw];
    }
    return [hits, raw];
  }

  // Command + partial/complete args
  const cmd = cmdToken.replace(/^\//, "");
  let choices = COMMAND_PARAMS[cmd] ? [...COMMAND_PARAMS[cmd]] : [];

  // Dynamic model list (static + recent + cached OpenRouter remote)
  if (cmd === "model" && config) {
    const catalog = buildModelCatalogSync(config, config.provider);
    choices = catalog.ids.slice(0, 120).map((m) => ({
      value: m,
      description: m === config.model ? "current" : "available",
    }));
  }

  // /provider completions
  if (cmd === "provider") {
    const ids = [
      ...PROVIDER_IDS.filter((id) => id !== "grok"),
      "list",
      "status",
    ];
    choices = ids.map((id) => ({
      value: id,
      description:
        config && id === config.provider
          ? "current"
          : id === "openrouter"
            ? "OpenRouter (free-form models)"
            : id === "list" || id === "status"
              ? "show providers"
              : "provider",
    }));
  }

  // Effort levels for the active model (when supported)
  if (cmd === "effort" && config) {
    if (modelSupportsReasoningEffort(config.model)) {
      const levels = effortLevelsForModel(config.model);
      const current = resolveReasoningEffort(
        config.model,
        config.reasoningEffort,
      );
      choices = levels.map((e) => ({
        value: e,
        description:
          REASONING_EFFORT_DESCRIPTIONS[e] +
          (e === current ? " ← current" : ""),
        aliases: COMMAND_PARAMS.effort?.find((c) => c.value === e)?.aliases,
      }));
    } else {
      choices = [];
    }
  }

  if (!choices.length) {
    // no known params — just complete command name if still typing it
    return [[], raw];
  }

  const argSoFar = raw.endsWith(" ")
    ? ""
    : (parts.slice(1).join(" ") || "");
  const argLower = argSoFar.toLowerCase();

  const matched = choices.filter((c) => {
    if (!argLower) return true;
    if (c.value.toLowerCase().startsWith(argLower)) return true;
    if (c.aliases?.some((a) => a.toLowerCase().startsWith(argLower))) return true;
    // number shortcut: show all when typing digit prefix of index
    if (/^\d+$/.test(argLower)) return true;
    return c.value.toLowerCase().includes(argLower);
  });

  // Completions should replace the whole line for reliability
  const prefix = `/${cmd} `;
  const hits = matched.map((c) => prefix + c.value);
  if (hits.length === 0) {
    return [choices.map((c) => prefix + c.value), raw];
  }
  return [hits, raw];
}

/** Sync completer wrapper for readline (Node expects this shape). */
export function makeCompleter(config: () => ForgeConfig) {
  return (line: string): [string[], string] => forgeCompleter(line, config());
}
