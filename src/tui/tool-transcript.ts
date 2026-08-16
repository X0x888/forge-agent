import chalk from "chalk";
import {
  clipAnsi,
  formatBytes,
  formatDiffBlock,
  formatFailedToolTail,
  formatSuccessfulBashTail,
  formatToolDisplayName,
  isBashToolName,
  formatToolEnd,
  formatToolOutputHead,
  formatToolStart,
  summarizeToolArgs,
  visibleWidth,
} from "../util/format.js";

export type ToolTranscriptEnd = {
  isError?: boolean;
  ms: number;
  bytes: number;
  args?: Record<string, unknown>;
  output?: string;
  diff?: string;
  stats?: { added: number; removed: number | null };
  width?: number;
};

/** Glanceable edit preview under the default ✓ row. /verbose still dumps the full block. */
export const DEFAULT_EDIT_DIFF_LINES = 8;

/** Child-report lines under ✓ spawn_subagent. */
export const DEFAULT_SUBAGENT_PREVIEW_LINES = 8;

/** Hit titles under ✓ web_search. */
export const DEFAULT_WEB_SEARCH_PREVIEW_HITS = 5;

function isWebSearchTool(name: string): boolean {
  return /^(web_search|WebSearch)$/i.test(name);
}

function isLspTool(name: string): boolean {
  return /^lsp$/i.test(name);
}

function isGetTaskOutputTool(name: string): boolean {
  return /^(get_task_output|TaskOutput)$/i.test(name);
}

/** Last 8 log lines under ✓ get_task_output. Short "still running" notes stay one row. */
export function formatGetTaskOutputPreview(
  output: string,
  opts?: { maxLines?: number },
): string {
  const maxLines = opts?.maxLines ?? 8;
  const nonempty = output.split("\n").filter((l) => l.trim());
  if (nonempty.length < 3) return "";
  return formatToolOutputHead(output, { tail: true, maxLines });
}

/** Compact lsp report: count line + first hits. "No diagnostics." stays one ✓ row. */
export function formatLspTranscriptPreview(
  output: string,
  opts?: { maxLines?: number },
): string {
  const maxLines = opts?.maxLines ?? 6;
  const lines = output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/u, ""))
    .filter((l) => l.length);
  if (!lines.length) return "";
  if (lines.length === 1 && /no diagnostics/i.test(lines[0]!)) return "";
  const shown = lines.slice(0, maxLines);
  const extra = lines.length - shown.length;
  const painted = shown.map((l) => chalk.dim(`  ${l}`));
  if (extra > 0) painted.push(chalk.dim(`  … +${extra} more · /verbose`));
  return painted.join("\n");
}

/**
 * Title-only preview of a web_search report. Understands HTML-lite
 * `1. **title**` rows and Instant Answer `- text` bullets. Empty when
 * there are no structured hits (one-line "no results" stays one row).
 */
export function formatWebSearchTranscriptPreview(
  output: string,
  opts?: { maxHits?: number },
): string {
  const maxHits = opts?.maxHits ?? DEFAULT_WEB_SEARCH_PREVIEW_HITS;
  const hits: string[] = [];
  for (const raw of output.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const numbered = line.match(/^\d+\.\s+\*{0,2}(.+?)\*{0,2}$/u);
    if (numbered?.[1]) {
      hits.push(numbered[1].trim());
      continue;
    }
    const dash = line.match(/^-\s+(.+)/u);
    if (dash?.[1] && !/^https?:\/\//i.test(dash[1])) {
      hits.push(dash[1].trim());
    }
  }
  if (!hits.length) {
    const heading = output
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("## "));
    if (heading && !/^##\s+Search results for\b/i.test(heading)) {
      hits.push(heading.replace(/^##\s+/u, "").trim());
    }
  }
  if (!hits.length) return "";
  const shown = hits.slice(0, maxHits);
  const extra = hits.length - shown.length;
  const painted = shown.map((h, i) => chalk.dim(`  ${i + 1}. ${clipAnsi(h, 72)}`));
  if (extra > 0) painted.push(chalk.dim(`  \u2026 +${extra} more \u00b7 /verbose`));
  return painted.join("\n");
}

function isSubagentTool(name: string): boolean {
  return name === "spawn_subagent" || name === "Task";
}

/**
 * Drop the `### Subagent result` metadata header so the TTY preview
 * starts at the child's actual report (pick / summary / files).
 */
export function stripSubagentHeader(output: string): string {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  if (lines[i]?.startsWith("### ")) i += 1;
  while (i < lines.length && /^-\s/.test(lines[i]!)) i += 1;
  if (lines[i] === "") i += 1;
  return lines.slice(i).join("\n");
}

/** First N body lines of a subagent report, dim-indented. */
export function formatSubagentTranscriptPreview(
  output: string,
  opts?: { maxLines?: number },
): string {
  const maxLines = opts?.maxLines ?? DEFAULT_SUBAGENT_PREVIEW_LINES;
  const body = stripSubagentHeader(output);
  const lines = body.split("\n").map((l) => l.replace(/\s+$/u, ""));
  while (lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return "";
  const shown = lines.slice(0, maxLines);
  const extra = lines.length - shown.length;
  const painted = shown.map((l) => chalk.dim(`  ${l}`));
  if (extra > 0) painted.push(chalk.dim(`  \u2026 +${extra} more \u00b7 /verbose`));
  return painted.join("\n");
}

function isUsefulDiff(diff: string | undefined): diff is string {
  const t = (diff ?? "").trim();
  return Boolean(t) && t !== "(no line-level diff)";
}

/**
 * Default (non-/verbose) tool-end transcript: one ✓/✗ row, plus a
 * last-lines tail when a failure has more than the inlined reason,
 * and a short colored diff when an edit tool succeeded.
 * Shared by the REPL and the loop's headless default printer so
 * `forge run` does not hide why a tool failed — or what an edit did.
 */
export function formatDefaultToolEndTranscript(
  name: string,
  r: ToolTranscriptEnd,
): string {
  const lines = [formatToolEnd(name, r)];
  if (r.isError && r.output) {
    const tail = formatFailedToolTail(r.output);
    if (tail) lines.push(tail);
  } else if (!r.isError && isUsefulDiff(r.diff)) {
    const block = formatDiffBlock(r.diff, {
      maxLines: DEFAULT_EDIT_DIFF_LINES,
      omitHeaders: true,
    });
    if (block) lines.push(block);
  } else if (!r.isError && isSubagentTool(name) && r.output) {
    const preview = formatSubagentTranscriptPreview(r.output);
    if (preview) lines.push(preview);
  } else if (!r.isError && isBashToolName(name) && r.output) {
    const tail = formatSuccessfulBashTail(r.output);
    if (tail) lines.push(tail);
  } else if (!r.isError && isWebSearchTool(name) && r.output) {
    const preview = formatWebSearchTranscriptPreview(r.output);
    if (preview) lines.push(preview);
  } else if (!r.isError && isLspTool(name) && r.output) {
    const preview = formatLspTranscriptPreview(r.output);
    if (preview) lines.push(preview);
  } else if (!r.isError && isGetTaskOutputTool(name) && r.output) {
    const preview = formatGetTaskOutputPreview(r.output);
    if (preview) lines.push(preview);
  }
  return lines.join("\n");
}

/**
 * /verbose tool-end transcript: status row + colored diff or full output.
 */
export function formatVerboseToolEndTranscript(
  name: string,
  r: ToolTranscriptEnd,
): string {
  const lines = [formatToolEnd(name, r)];
  if (r.diff) {
    const block = formatDiffBlock(r.diff);
    if (block) lines.push(block);
  } else if (r.output) {
    const head = formatToolOutputHead(r.output, { verbose: true });
    if (head) lines.push(head);
  }
  return lines.join("\n");
}

/**
 * Consecutive same-tool successes collapse to `✓ grep ×4` so a read/grep
 * burst is one row. Failures and /verbose never join the group.
 */
export function formatCoalescedToolEnd(
  name: string,
  count: number,
  opts: {
    ms: number;
    bytes: number;
    args?: Record<string, unknown>;
    width?: number;
  },
): string {
  if (count <= 1) {
    return formatToolEnd(name, { ...opts, isError: false });
  }
  const status = chalk.green("✓");
  const timing = `${opts.ms}ms  ${formatBytes(opts.bytes)}`;
  const hasArgs = Boolean(opts.args && Object.keys(opts.args).length);
  const argBit = hasArgs ? ` ${summarizeToolArgs(opts.args!)}` : "";
  const line = chalk.dim(
    `  ${status} ${formatToolDisplayName(name)} ×${count}${argBit}  ${timing}`,
  );
  const cols = Math.max(
    8,
    opts.width ?? (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  return visibleWidth(line) <= cols ? line : clipAnsi(line, cols);
}

export function createToolEndCoalescer(print: (line: string) => void) {
  let pending: {
    name: string;
    count: number;
    ms: number;
    bytes: number;
    args?: Record<string, unknown>;
  } | null = null;

  const flush = (): void => {
    if (!pending) return;
    print(
      formatCoalescedToolEnd(pending.name, pending.count, {
        ms: pending.ms,
        bytes: pending.bytes,
        args: pending.args,
      }),
    );
    pending = null;
  };

  return {
    push(name: string, r: ToolTranscriptEnd, opts?: { verbose?: boolean }): void {
      // Diffs / subagent reports must not join a `✓ edit ×N` burst —
      // the compact preview is the point.
      if (
        opts?.verbose ||
        r.isError ||
        isUsefulDiff(r.diff) ||
        (isSubagentTool(name) && Boolean(r.output?.trim())) ||
        (isBashToolName(name) && Boolean(formatSuccessfulBashTail(r.output ?? ""))) ||
        (isWebSearchTool(name) && Boolean(formatWebSearchTranscriptPreview(r.output ?? ""))) ||
        (isLspTool(name) && Boolean(formatLspTranscriptPreview(r.output ?? ""))) ||
        (isGetTaskOutputTool(name) && Boolean(formatGetTaskOutputPreview(r.output ?? "")))
      ) {
        flush();
        print(
          opts?.verbose
            ? formatVerboseToolEndTranscript(name, r)
            : formatDefaultToolEndTranscript(name, r),
        );
        return;
      }
      if (pending && pending.name === name) {
        pending.count += 1;
        pending.ms += r.ms;
        pending.bytes += r.bytes;
        pending.args = r.args;
        return;
      }
      flush();
      pending = {
        name,
        count: 1,
        ms: r.ms,
        bytes: r.bytes,
        args: r.args,
      };
    },
    /** Keep a same-name burst held; print it before a different tool (Allow?). */
    flushUnless(name: string): void {
      if (pending && pending.name !== name) flush();
    },
    flush,
  };
}

/** Short tools stay a single ✓ row; ▸ only appears once a wait is real. */
export const TOOL_START_DELAY_MS = 700;

export type ToolStartDelayerOpts = {
  /** Override delay (tests). Default 700ms. `0` prints immediately. */
  delayMs?: number;
  /** Print ▸ on every start (REPL `/verbose`). */
  immediate?: boolean;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
};

type PendingStart = {
  name: string;
  args: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout> | null;
  printed: boolean;
};

/**
 * Hold `▸ tool args` until the tool has been running ~700ms.
 * Fast grep/read stay one ✓ row. A 2-min `npm test` gets a start line
 * so the transcript is not silent while `live ›` is frozen (toolHold).
 * Headless `forge run` uses the same delayer — no more ▸+✓ on every 12ms tool.
 *
 * Pairing is FIFO per tool name (parallel same-name batches that all finish
 * under the delay cancel correctly; mixed long/short same-name is rare).
 */
export function createToolStartDelayer(
  print: (line: string) => void,
  opts: ToolStartDelayerOpts = {},
) {
  const delayMs = Math.max(0, opts.delayMs ?? TOOL_START_DELAY_MS);
  const schedule = opts.setTimeout ?? setTimeout;
  const cancel = opts.clearTimeout ?? clearTimeout;
  const queues = new Map<string, PendingStart[]>();

  const fire = (item: PendingStart): void => {
    if (item.printed) return;
    print(formatToolStart(item.name, item.args));
    item.printed = true;
  };

  return {
    push(
      name: string,
      args: Record<string, unknown>,
      startOpts?: { immediate?: boolean },
    ): void {
      const item: PendingStart = {
        name,
        args,
        timer: null,
        printed: false,
      };
      const q = queues.get(name) ?? [];
      q.push(item);
      queues.set(name, q);
      const immediate =
        startOpts?.immediate === true || opts.immediate === true || delayMs === 0;
      if (immediate) {
        fire(item);
        return;
      }
      item.timer = schedule(() => {
        item.timer = null;
        fire(item);
      }, delayMs);
      item.timer?.unref?.();
    },
    /** Cancel or keep a matching start when the tool settles. FIFO per name. */
    settle(name: string): void {
      const q = queues.get(name);
      if (!q?.length) return;
      const item = q.shift()!;
      if (item.timer) {
        cancel(item.timer);
        item.timer = null;
      }
      if (q.length === 0) queues.delete(name);
    },
    /** Drop unfired timers (turn end / abort). Does not print leftover ▸. */
    flush(): void {
      for (const q of queues.values()) {
        for (const item of q) {
          if (item.timer) cancel(item.timer);
        }
      }
      queues.clear();
    },
  };
}
