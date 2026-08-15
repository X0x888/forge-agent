/**
 * Group the top-level `forge --help` option dump into scan sections.
 * Commander 13 has no option helpGroup API — we replace the Options: block.
 */
import { Help, type Command, type Option } from "commander";

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
    test: /--ulw\b|--max-waves|--goal\b/,
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
