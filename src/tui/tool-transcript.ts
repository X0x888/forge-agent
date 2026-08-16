import chalk from "chalk";
import {
  clipAnsi,
  formatBytes,
  formatDiffBlock,
  formatFailedToolTail,
  formatToolDisplayName,
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
      // Diffs must not join a `✓ edit ×N` burst — the compact preview is the point.
      if (opts?.verbose || r.isError || isUsefulDiff(r.diff)) {
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
