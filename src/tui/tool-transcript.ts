import {
  formatDiffBlock,
  formatFailedToolTail,
  formatToolEnd,
  formatToolOutputHead,
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
