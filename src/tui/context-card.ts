/** `/context` + `/compact` peek — pressure + token delta. Lecture is `/context all`. */
import chalk from "chalk";
import { formatTokens } from "../util/format.js";
import { formatVerifyCloser } from "./verify-card.js";

export type ContextKind = "ok" | "elevated" | "compact" | "hard";

export type CompactKind = "ok" | "noop";

export function contextKindFromPct(
  pct: number,
  thresholdPct: number,
): ContextKind {
  const p = Number.isFinite(pct) ? pct : 0;
  const thr = Number.isFinite(thresholdPct) ? thresholdPct : 80;
  if (p >= 92) return "hard";
  if (p >= thr) return "compact";
  if (p >= Math.max(50, thr - 15)) return "elevated";
  return "ok";
}

export function formatContextVerdict(
  kind: ContextKind,
  opts?: { color?: boolean },
): string {
  const color = opts?.color !== false;
  const title = color ? chalk.bold("context") : "context";
  const bit = (text: string, paint: (s: string) => string) =>
    color ? paint(text) : text;
  if (kind === "hard") return `${title}  ·  ${bit("HARD", chalk.red)}`;
  if (kind === "compact") return `${title}  ·  ${bit("compact", chalk.yellow)}`;
  if (kind === "elevated") {
    return `${title}  ·  ${bit("elevated", chalk.yellow)}`;
  }
  return `${title}  ·  ${bit("ok", chalk.green)}`;
}

export function contextNextKeys(kind: ContextKind): string[] {
  if (kind === "ok") return [];
  return ["/compact"];
}

export function contextPressureNote(
  kind: ContextKind,
  pct: number,
  thresholdPct: number,
): string {
  if (kind === "hard") return `Pressure: HARD (~${pct}%)`;
  if (kind === "compact") {
    return `Pressure: above auto-compact threshold (${thresholdPct}%)`;
  }
  if (kind === "elevated") {
    return `Pressure: elevated (~${pct}%; auto-compact @${thresholdPct}%)`;
  }
  return "";
}

export function formatContextSpendLine(input: {
  used: number;
  window: number;
  pct: number;
  thresholdPct: number;
}): string {
  return (
    `  ~${formatTokens(input.used)} / ${formatTokens(input.window)}` +
    `  (${input.pct}%)  autoCompact@${input.thresholdPct}%`
  );
}

export function formatContextCard(input: {
  kind: ContextKind;
  used: number;
  window: number;
  pct: number;
  thresholdPct: number;
  detail?: string;
  note?: string;
  next?: string[];
  color?: boolean;
  columns?: number;
}): string {
  const color = input.color !== false;
  const lines = [formatContextVerdict(input.kind, { color })];
  const spend = formatContextSpendLine(input);
  lines.push(color ? chalk.dim(spend) : spend);
  const detail = input.detail?.replace(/^\n+/, "").trimEnd();
  if (detail) lines.push(detail);
  const note = (input.note ?? "").trim();
  if (note) {
    const paint =
      input.kind === "ok" ? chalk.dim : input.kind === "hard" ? chalk.red : chalk.yellow;
    lines.push(color ? paint(`  ${note}`) : `  ${note}`);
  }
  const next = input.next ?? contextNextKeys(input.kind);
  const closer = formatVerifyCloser(next, { columns: input.columns });
  if (closer) lines.push(closer);
  return lines.filter((l) => l.length > 0).join("\n");
}

export function formatCompactVerdict(
  kind: CompactKind,
  opts?: { color?: boolean },
): string {
  const color = opts?.color !== false;
  const title = color ? chalk.bold("compact") : "compact";
  const bit = (text: string, paint: (s: string) => string) =>
    color ? paint(text) : text;
  if (kind === "noop") return `${title}  ·  ${bit("noop", chalk.dim)}`;
  return `${title}  ·  ${bit("ok", chalk.green)}`;
}

export function compactKindFromDelta(
  beforeMsgs: number,
  afterMsgs: number,
  beforeTokens?: number,
  afterTokens?: number,
): CompactKind {
  if (afterMsgs < beforeMsgs) return "ok";
  if (
    beforeTokens != null &&
    afterTokens != null &&
    afterTokens < beforeTokens
  ) {
    return "ok";
  }
  return "noop";
}

export function formatCompactCard(input: {
  beforeMsgs: number;
  afterMsgs: number;
  beforeTokens?: number;
  afterTokens?: number;
  note?: string;
  next?: string[];
  color?: boolean;
  columns?: number;
}): string {
  const color = input.color !== false;
  const kind = compactKindFromDelta(
    input.beforeMsgs,
    input.afterMsgs,
    input.beforeTokens,
    input.afterTokens,
  );
  const lines = [formatCompactVerdict(kind, { color })];
  let body =
    `  Compacted ${input.beforeMsgs} → ${input.afterMsgs} messages`;
  if (input.beforeTokens != null && input.afterTokens != null) {
    body +=
      `  ·  ~${formatTokens(input.beforeTokens)} → ~${formatTokens(input.afterTokens)}`;
  }
  lines.push(color ? chalk.dim(body) : body);
  const note = input.note?.trim();
  if (note) {
    for (const row of note.split("\n")) {
      const t = row.trim();
      if (!t) continue;
      lines.push(color ? chalk.dim(`  ${t}`) : `  ${t}`);
    }
  }
  const next = input.next ?? (kind === "ok" ? ["/context"] : []);
  const closer = formatVerifyCloser(next, { columns: input.columns });
  if (closer) lines.push(closer);
  return lines.filter((l) => l.length > 0).join("\n");
}
