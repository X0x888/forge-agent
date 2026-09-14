/**
 * Group the top-level `forge --help` option dump into scan sections.
 * Commander 13 has no option helpGroup API — we replace the Options: block.
 */
import { Help, type Command, type Option } from "commander";

/** Trailing Examples/Docs block on `forge --help` / `forge help`. */
export const CLI_AFTER_HELP = `
Examples:
  forge login
  forge login --add
  forge login -p cursor --oauth --add
  forge doctor --json
  forge run "fix CI" --permission-mode acceptEdits --json
  forge run "continue" --session <id> --json
  forge run "next step" --continue --json
  forge "next step" --continue                 # bare headless same-cwd resume (fail-closed if none)
  forge "next step" --json                     # bare headless JSON (parity with run --json)
  forge setup --json · forge init --json · forge tips --json · forge completion bash --json
  forge sessions prune --keep 50
  forge sessions prune --journals --dry
  forge sessions export <id> --format json --out ./session.json
  forge stats --days 7
  forge news
  forge tips
  forge logs
  forge config --json
  forge prune-tool-output --keep 80
  forge prune-metrics --keep 500
  forge tmp prune
  forge sessions prune --orphans
  eval "$(forge completion bash)"

Docs: docs/GETTING-STARTED.md · docs/PRODUCTION.md · docs/RELIABILITY.md · docs/ULW.md · forge news
`;

/** `helpInformation()` plus the after-text `--help` prints via `addHelpText`. */
export function formatForgeHelp(program: Command): string {
  const body = program.helpInformation();
  const after = CLI_AFTER_HELP.replace(/^\n/, "");
  const joined = body.endsWith("\n") ? `${body}${after}` : `${body}\n${after}`;
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}

/**
 * Top-level subcommands Commander registers (plus `help`).
 * Typo recovery and shell completion share this list so Tab matches `--help`.
 */
export const TOP_LEVEL_COMMANDS = [
  "run",
  "login",
  "logout",
  "auth",
  "accounts",
  "sessions",
  "init",
  "setup",
  "permissions",
  "lsp",
  "models",
  "completion",
  "prune-tool-output",
  "prune-metrics",
  "tmp",
  "logs",
  "config",
  "stats",
  "tips",
  "news",
  "doctor",
  "status",
  "help",
] as const;

export type HelpFlag = { flags: string };

export const OPTION_HELP_GROUPS: ReadonlyArray<{
  title: string;
  test: RegExp;
}> = [
  {
    title: "Model",
    test: /--model\b|--provider\b|--base-url|--effort|--reasoning-effort|--fallback-models/,
  },
  {
    title: "Session",
    test: /--session\b|--continue\b|--new\b|--title\b|--cwd\b/,
  },
  {
    title: "Safety",
    test: /--permission-mode|--sandbox|--deny\b|--allow\b|--ask\b|--read-outside|--no-blocking-stop|--max-turns|--max-cost/,
  },
  {
    title: "Harness",
    test: /--ulw\b|--max-cycles|--max-waves|--goal\b/,
  },
  {
    title: "Output",
    test: /--json\b|--print-logs|-h,|--help\b|--version|-V,/,
  },
];

export function groupOptionsByHelpSection<T extends HelpFlag>(
  options: T[],
): { title: string; options: T[] }[] {
  const used = new Set<T>();
  const groups: { title: string; options: T[] }[] = [];
  for (const g of OPTION_HELP_GROUPS) {
    const hit = options.filter((o) => !used.has(o) && g.test.test(o.flags));
    if (!hit.length) continue;
    for (const o of hit) used.add(o);
    groups.push({ title: g.title, options: hit });
  }
  const rest = options.filter((o) => !used.has(o));
  if (rest.length) groups.push({ title: "More", options: rest });
  return groups;
}

function renderGroupedOptions(helper: Help, opts: Option[]): string {
  if (!opts.length) return "";
  const termWidth = Math.max(
    8,
    ...opts.map((o) => helper.displayWidth(helper.optionTerm(o))),
  );
  const lines: string[] = [];
  for (const g of groupOptionsByHelpSection(opts)) {
    lines.push(helper.styleTitle(`${g.title}:`));
    for (const option of g.options) {
      lines.push(
        helper.formatItem(
          helper.styleOptionTerm(helper.optionTerm(option)),
          termWidth,
          helper.styleOptionDescription(helper.optionDescription(option)),
          helper,
        ),
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Replace the flat Options: dump with grouped headings. Commands stay as-is. */
export function installGroupedHelp(program: Command): void {
  program.configureHelp({
    formatHelp(cmd, helper) {
      const opts = helper.visibleOptions(cmd);
      const blank = Object.assign(
        Object.create(Object.getPrototypeOf(helper)) as Help,
        helper,
        { visibleOptions: () => [] },
      );
      const body = Help.prototype.formatHelp.call(blank, cmd, blank);
      const grouped = renderGroupedOptions(helper, opts);
      if (!grouped) return body;
      const marker = helper.styleTitle("Commands:");
      const idx = body.indexOf(marker);
      if (idx >= 0) return body.slice(0, idx) + grouped + body.slice(idx);
      return body.endsWith("\n") ? body + grouped : `${body}\n${grouped}`;
    },
  });
}
