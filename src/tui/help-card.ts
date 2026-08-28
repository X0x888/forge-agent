/** Empty `/help` is a numbered 1–6 start card. Catalog is `/help all`. */
import { formatVerifyCloser } from "./verify-card.js";

export interface HelpStartItem {
  n: number;
  next: string;
  blurb: string;
}

export const HELP_START_ITEMS: readonly HelpStartItem[] = [
  {
    n: 1,
    next: "/setup",
    blurb: "Account, model, budget, notify, AGENTS.md",
  },
  { n: 2, next: "/plan", blurb: "Read-only design, then /build" },
  { n: 3, next: "/init", blurb: "Write AGENTS.md for this repo" },
  { n: 4, next: "/doctor", blurb: "Health (auth, sandbox, Stop)" },
  { n: 5, next: "/model", blurb: "Switch model (sticky)" },
  { n: 6, next: "/help all", blurb: "Full command list" },
];

export function parseHelpStartKey(arg?: string): number | null {
  const t = String(arg || "").trim();
  if (!/^[1-6]$/.test(t)) return null;
  return Number(t);
}

export function helpStartItem(n: number): HelpStartItem | undefined {
  return HELP_START_ITEMS.find((i) => i.n === n);
}

export function formatHelpStartCard(opts?: { columns?: number }): string {
  const cmdW = Math.max(...HELP_START_ITEMS.map((i) => i.next.length));
  const lines = [
    "help  ·  start",
    "  Type a task in English.",
  ];
  for (const it of HELP_START_ITEMS) {
    lines.push(`  ${it.n}  ${it.next.padEnd(cmdW)}  ${it.blurb}`);
  }
  lines.push(
    "  Find a command: /help <word>  ·  Keys  ↵ send  ·  Tab  ·  Allow? ↵/y · a · s · n",
  );
  const closer = formatVerifyCloser(["/setup", "/help all"], {
    columns: opts?.columns,
  });
  if (closer) lines.push(closer);
  return lines.join("\n");
}

export function formatHelpStartItem(
  n: number,
  opts?: { columns?: number },
): string | null {
  const it = helpStartItem(n);
  if (!it) return null;
  const lines = [`help  ·  ${it.n}`, `  ${it.next}  ${it.blurb}`];
  const closer = formatVerifyCloser([it.next], { columns: opts?.columns });
  if (closer) lines.push(closer);
  return lines.join("\n");
}
