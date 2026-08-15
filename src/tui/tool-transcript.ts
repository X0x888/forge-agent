import chalk from "chalk";
import {
  clipAnsi,
  formatBytes,
  formatDiffBlock,
  formatFailedToolTail,
  formatToolEnd,
  formatToolOutputHead,
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

/**
 * Default (non-/verbose) tool-end transcript: one ✓/✗ row, plus a
 * last-lines tail when a failure has more than the inlined reason.
 * Shared by the REPL and the loop's headless default printer so
 * `forge run` does not hide why a tool failed.
 */
export function formatDefaultToolEndTranscript(
  name: string,
  r: ToolTranscriptEnd,
): string {
  const lines = [formatToolEnd(name, r)];
  if (r.isError && r.output) {
    const tail = formatFailedToolTail(r.output);
    if (tail) lines.push(tail);
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
  const line = chalk.dim(`  ${status} ${name} ×${count}${argBit}  ${timing}`);
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
      if (opts?.verbose || r.isError) {
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
