/**
 * Tab-completion for slash commands and their parameters.
 * Returns [matches, sharedPrefix] for readline.completer.
 */
import type { ForgeConfig } from "../config/types.js";
import { SLASH_COMMANDS } from "../commands/slash.js";

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
      description: "Read-only — no edits or shell mutations",
    },
    {
      value: "bypassPermissions",
      description: "Always approve everything (full YOLO)",
      aliases: ["bypass", "yolo", "always", "auto"],
    },
  ],
  cycle: [
    { value: "1", description: "CONTINUE — relentless waves (Stop blocked)" },
    { value: "0", description: "LAST — finish current wave then stop" },
    { value: "status", description: "Show cycle flag, wave, mandate" },
  ],
  goal: [
    { value: "status", description: "Show current goal" },
    { value: "pause", description: "Pause goal driver" },
    { value: "resume", description: "Resume paused goal" },
    { value: "clear", description: "Clear goal" },
    { value: "done", description: "Mark goal achieved" },
    { value: "set", description: "Set goal: /goal set <objective>" },
  ],
  ulw: [
    {
      value: "improve the code",
      description: "Soft god-scope (example)",
    },
  ],
  compact: [],
  rewind: [
    { value: "1", description: "Undo last user turn" },
    { value: "2", description: "Undo last 2 user turns" },
  ],
  undo: [
    { value: "1", description: "Undo last user turn" },
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
    const hits = SLASH_COMMANDS.filter((c) => c.startsWith(cmdToken));
    // Prefer returning full command paths for autofill
    if (hits.length === 0) {
      // fuzzy contains
      const fuzzy = SLASH_COMMANDS.filter((c) =>
        c.slice(1).includes(cmdToken.replace(/^\//, "")),
      );
      return [fuzzy.length ? fuzzy : [...SLASH_COMMANDS], raw];
    }
    return [hits, raw];
  }

  // Command + partial/complete args
  const cmd = cmdToken.replace(/^\//, "");
  let choices = COMMAND_PARAMS[cmd] ? [...COMMAND_PARAMS[cmd]] : [];

  // Dynamic model list
  if (cmd === "model" && config) {
    const pcfg = config.providers[config.provider];
    const models = pcfg?.models?.length
      ? pcfg.models
      : pcfg?.defaultModel
        ? [pcfg.defaultModel]
        : [];
    choices = models.map((m) => ({
      value: m,
      description: m === config.model ? "current" : "available",
    }));
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
