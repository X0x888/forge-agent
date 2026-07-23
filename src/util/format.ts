import chalk from "chalk";

/** Truncate long tool output keeping head + tail so errors at the end remain visible. */
export function truncateMiddle(text: string, max = 80_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.35);
  const omitted = text.length - head - tail;
  return (
    text.slice(0, head) +
    `\n\n… [${omitted} chars omitted] …\n\n` +
    text.slice(-tail)
  );
}

export function summarizeToolArgs(args: Record<string, unknown>, max = 90): string {
  const prefer = ["path", "command", "pattern", "query", "old_string"];
  for (const k of prefer) {
    if (args[k] !== undefined) {
      const v = String(args[k]).replace(/\s+/g, " ");
      const s = `${k}=${v}`;
      return s.length > max ? s.slice(0, max - 1) + "…" : s;
    }
  }
  const s = JSON.stringify(args);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function formatToolStart(name: string, args: Record<string, unknown>): string {
  return chalk.cyan(`  ▸ ${name}`) + chalk.dim(` ${summarizeToolArgs(args)}`);
}

export function formatToolEnd(
  name: string,
  opts: { isError?: boolean; ms: number; bytes: number },
): string {
  const status = opts.isError ? chalk.red("✗") : chalk.green("✓");
  return chalk.dim(
    `  ${status} ${name}  ${opts.ms}ms  ${formatBytes(opts.bytes)}`,
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Rough USD estimate — not billing-accurate; for status display only. */
export function estimateCostUsd(
  provider: string,
  promptTokens: number,
  completionTokens: number,
): number {
  // Very rough mid-tier averages ($/1M tokens)
  const rates: Record<string, { in: number; out: number }> = {
    xai: { in: 3, out: 15 },
    anthropic: { in: 3, out: 15 },
    openai: { in: 2.5, out: 10 },
    openrouter: { in: 3, out: 15 },
    google: { in: 1.25, out: 5 },
  };
  const r = rates[provider] || { in: 3, out: 12 };
  return (promptTokens * r.in + completionTokens * r.out) / 1_000_000;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}
