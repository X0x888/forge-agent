/**
 * Model-facing edit receipt + numbered AFTER window.
 * TUI diffs stay on ToolResult.diff (shortDiff) — never in the model string.
 */
import fs from "node:fs";
import { shortDiff } from "./edit-match.js";
import { splitBom } from "./text.js";

export const EDIT_RECEIPT_CONTEXT = 8;
export const EDIT_RECEIPT_MAX_LINES = 80;
export const EDIT_RECEIPT_MAX_BYTES = 4000;
export const EDIT_RECEIPT_MERGE_GAP = 16;
export const EDIT_RECEIPT_HEADER_RANGES = 3;
export const EDIT_RECEIPT_LINE_CLIP = 2000;
export const EDIT_RECEIPT_CLIP_SUFFIX = "... (line clipped to 2000 chars)";
export const EDIT_RECEIPT_MYERS_MAX_SUM = 20_000;
export const EDIT_RECEIPT_MYERS_MAX_D = 4000;

const MINUS = "\u2212";
const ENDASH = "\u2013";
const ELLIPSIS = "\u2026";

export function editReceiptMode(): "new" | "legacy" {
  const v = (process.env.FORGE_EDIT_RECEIPT || "").trim().toLowerCase();
  if (
    v === "legacy" ||
    v === "0" ||
    v === "false" ||
    v === "off" ||
    v === "no" ||
    v === "old"
  ) {
    return "legacy";
  }
  return "new";
}

export function editReceiptEnabled(): boolean {
  return editReceiptMode() === "new";
}

export type LineHunk = {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
};

export type AfterWindow = { start: number; end: number };

export type MergedRange = {
  start: number;
  end: number;
  coreStart: number;
  coreEnd: number;
};

export function splitFileLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

export function lineCount(text: string): number {
  return splitFileLines(text).length;
}

function abortHunk(a: string[], b: string[]): LineHunk[] {
  let x = 0;
  let y = 0;
  while (x < a.length && y < b.length && a[x] === b[y]) {
    x++;
    y++;
  }
  if (x === a.length && y === b.length) return [];
  return [{ aStart: x, aEnd: a.length, bStart: y, bEnd: b.length }];
}

export function lineHunks(before: string, after: string): LineHunk[] {
  const a = splitFileLines(before);
  const b = splitFileLines(after);
  const n = a.length;
  const m = b.length;
  if (n + m === 0) return [];
  if (n + m > EDIT_RECEIPT_MYERS_MAX_SUM) return abortHunk(a, b);

  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];
  let finishedD = -1;

  const maxD = Math.min(EDIT_RECEIPT_MYERS_MAX_D, max);
  for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        finishedD = d;
        break;
      }
    }
    trace.push(v.slice());
    if (finishedD >= 0) break;
  }
  if (finishedD < 0) return abortHunk(a, b);
  return hunksFromTrace(trace, a, b, finishedD);
}

function hunksFromTrace(
  trace: Int32Array[],
  a: string[],
  b: string[],
  dEnd: number,
): LineHunk[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  let x = n;
  let y = m;
  type Atom = { a0: number; a1: number; b0: number; b1: number };
  const atoms: Atom[] = [];

  for (let d = dEnd; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x > prevX) {
      atoms.push({ a0: prevX, a1: x, b0: prevY, b1: prevY });
    } else if (y > prevY) {
      atoms.push({ a0: prevX, a1: prevX, b0: prevY, b1: y });
    }
    x = prevX;
    y = prevY;
  }

  atoms.reverse();
  const hunks: LineHunk[] = [];
  for (const at of atoms) {
    const last = hunks[hunks.length - 1];
    if (last && last.aEnd === at.a0 && last.bEnd === at.b0) {
      last.aEnd = at.a1;
      last.bEnd = at.b1;
    } else {
      hunks.push({
        aStart: at.a0,
        aEnd: at.a1,
        bStart: at.b0,
        bEnd: at.b1,
      });
    }
  }
  return hunks.filter((h) => h.aEnd > h.aStart || h.bEnd > h.bStart);
}

export function lineStats(hunks: LineHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    added += h.bEnd - h.bStart;
    removed += h.aEnd - h.aStart;
  }
  return { added, removed };
}

export function emittedLineCount(windows: AfterWindow[]): number {
  let n = 0;
  for (const w of windows) n += w.end - w.start + 1;
  return n;
}

function formatOneLine(lineNo: number, line: string): string {
  const body =
    line.length > EDIT_RECEIPT_LINE_CLIP
      ? line.slice(0, EDIT_RECEIPT_LINE_CLIP) + EDIT_RECEIPT_CLIP_SUFFIX
      : line;
  return `${String(lineNo).padStart(6)}|${body}`;
}

export function formatNumberedLines(
  afterLines: string[],
  windows: AfterWindow[],
): string {
  if (!windows.length) return "";
  const parts: string[] = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    if (i > 0) {
      const prev = windows[i - 1]!;
      const skipped = w.start - prev.end - 1;
      if (skipped > 0) {
        parts.push(`${ELLIPSIS} ${skipped} lines not shown ${ELLIPSIS}`);
      }
    }
    const last = Math.min(w.end, afterLines.length);
    for (let ln = w.start; ln <= last; ln++) {
      if (ln < 1) continue;
      parts.push(formatOneLine(ln, afterLines[ln - 1] ?? ""));
    }
  }
  return parts.join("\n");
}

export function numberedWindowBytes(
  afterLines: string[],
  windows: AfterWindow[],
): number {
  return Buffer.byteLength(formatNumberedLines(afterLines, windows), "utf8");
}

function toWindow(s: number, e: number): AfterWindow | null {
  if (e <= s) return null;
  return { start: s + 1, end: e };
}

function expandCore(
  coreStart: number,
  coreEnd: number,
  afterLineCount: number,
  ctx = EDIT_RECEIPT_CONTEXT,
): MergedRange {
  return {
    start: Math.max(0, coreStart - ctx),
    end: Math.min(afterLineCount, coreEnd + ctx),
    coreStart,
    coreEnd,
  };
}

function headTailWindows(
  m: MergedRange,
  leftover: number,
  afterLineCount: number,
): AfterWindow[] {
  const coreLen = m.coreEnd - m.coreStart;
  let ctxBefore = m.coreStart - m.start;
  let ctxAfter = m.end - m.coreEnd;
  let r = leftover - ctxBefore - ctxAfter;

  if (r < 0) {
    ctxBefore = 0;
    ctxAfter = 0;
    if (coreLen > 0) {
      const keep = Math.min(Math.max(leftover, 0), coreLen);
      if (keep <= 0) return [];
      const w = toWindow(m.coreStart, m.coreStart + keep);
      return w ? [w] : [];
    }
    const keep = Math.min(Math.max(leftover, 0), 2 * EDIT_RECEIPT_CONTEXT);
    if (keep <= 0) return [];
    const half = Math.floor(keep / 2);
    const hole = expandCore(m.coreStart, m.coreEnd, afterLineCount, half);
    const w = toWindow(hole.start, hole.end);
    return w ? [w] : [];
  }

  const headCore = Math.floor(r / 2);
  const tailCore = Math.ceil(r / 2);
  const head0 = m.coreStart - ctxBefore;
  const head1 = m.coreStart + headCore;
  const tail0 = m.coreEnd - tailCore;
  const tail1 = m.coreEnd + ctxAfter;
  if (head1 >= tail0) {
    const w = toWindow(head0, tail1);
    if (!w) return [];
    const span = w.end - w.start + 1;
    if (span > leftover && leftover > 0) {
      const trimmed = toWindow(head0, head0 + leftover);
      return trimmed ? [trimmed] : [w];
    }
    return [w];
  }
  const hw = toWindow(head0, head1);
  const tw = toWindow(tail0, tail1);
  const out: AfterWindow[] = [];
  if (hw) out.push(hw);
  if (tw) out.push(tw);
  return out;
}

function trimPairToBudget(
  first: AfterWindow,
  last: AfterWindow,
  maxLines: number,
): AfterWindow[] {
  let a = { ...first };
  let b = { ...last };
  const size = () =>
    a.end - a.start + 1 + (a.start === b.start && a.end === b.end ? 0 : b.end - b.start + 1);
  while (size() > maxLines) {
    const aLen = a.end - a.start + 1;
    const bLen = b.end - b.start + 1;
    if (aLen <= 1 && bLen <= 1) break;
    if (aLen >= bLen && aLen > 1) {
      a.end -= 1;
    } else if (bLen > 1) {
      b.start += 1;
    } else if (aLen > 1) {
      a.end -= 1;
    } else {
      break;
    }
  }
  if (a.start === b.start && a.end === b.end) return [a];
  return [a, b];
}

function shrinkBytes(
  afterLines: string[],
  windows: AfterWindow[],
  maxBytes: number,
): AfterWindow[] {
  let cur = windows.map((w) => ({ ...w }));
  while (
    cur.length &&
    numberedWindowBytes(afterLines, cur) > maxBytes &&
    cur.some((w) => w.end > w.start)
  ) {
    let idx = 0;
    let best = -1;
    for (let i = 0; i < cur.length; i++) {
      const len = cur[i]!.end - cur[i]!.start + 1;
      if (len >= best) {
        best = len;
        idx = i;
      }
    }
    const w = cur[idx]!;
    if (w.end <= w.start) break;
    const only = cur.length === 1;
    const isFirstOfPair = idx === 0 && cur.length > 1;
    const isLastOfPair = idx === cur.length - 1 && cur.length > 1;
    if (only) {
      const mid = w.start + Math.floor((w.end - w.start) / 2);
      const left: AfterWindow = { start: w.start, end: mid - 1 };
      const right: AfterWindow = { start: mid + 1, end: w.end };
      const next: AfterWindow[] = [];
      if (left.end >= left.start) next.push(left);
      if (right.end >= right.start) next.push(right);
      if (!next.length) {
        cur = [{ start: w.start, end: w.start }];
        break;
      }
      cur = next;
    } else if (isFirstOfPair) {
      w.end -= 1;
    } else if (isLastOfPair) {
      w.start += 1;
    } else {
      w.end -= 1;
    }
    cur = cur.filter((x) => x.end >= x.start);
    if (!cur.length) {
      cur = [{ start: w.start, end: w.start }];
      break;
    }
  }
  return cur;
}

export function selectAfterWindows(
  hunks: LineHunk[],
  afterLineCount: number,
  opts?: { maxLines?: number; maxBytes?: number; afterLines?: string[] },
): AfterWindow[] {
  const maxLines = opts?.maxLines ?? EDIT_RECEIPT_MAX_LINES;
  const maxBytes = opts?.maxBytes ?? EDIT_RECEIPT_MAX_BYTES;
  const afterLines = opts?.afterLines;

  if (afterLineCount === 0) return [];

  const ranges: MergedRange[] = [];
  for (const h of hunks) {
    const coreStart = h.bStart;
    const coreEnd = h.bEnd > h.bStart ? h.bEnd : h.bStart;
    ranges.push(expandCore(coreStart, coreEnd, afterLineCount));
  }
  ranges.sort((x, y) => x.start - y.start || x.coreStart - y.coreStart);

  const merged: MergedRange[] = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r.start <= prev.end + EDIT_RECEIPT_MERGE_GAP) {
      prev.end = Math.max(prev.end, r.end);
      prev.coreStart = Math.min(prev.coreStart, r.coreStart);
      prev.coreEnd = Math.max(prev.coreEnd, r.coreEnd);
    } else {
      merged.push({ ...r });
    }
  }

  type Group = { m: MergedRange; windows: AfterWindow[] };
  const groups: Group[] = [];
  for (const m of merged) {
    const w = toWindow(m.start, m.end);
    if (w) groups.push({ m, windows: [w] });
  }
  if (groups.length === 0) return [];

  const allWindows = () => groups.flatMap((g) => g.windows);
  const first = groups[0]!.windows[0]!;
  const lastGroup = groups[groups.length - 1]!;
  const last = lastGroup.windows[lastGroup.windows.length - 1]!;
  const spanLines = last.end - first.start + 1;
  const filled: AfterWindow[] = [{ start: first.start, end: last.end }];
  const spanFitsLines = spanLines <= maxLines;
  const spanFitsBytes =
    !afterLines || numberedWindowBytes(afterLines, filled) <= maxBytes;
  if (spanFitsLines && spanFitsBytes) {
    return filled;
  }

  const oversizedThreshold = maxLines - 2 * EDIT_RECEIPT_CONTEXT;
  const p1Order = groups
    .map((g, i) => ({
      i,
      coreLen: g.m.coreEnd - g.m.coreStart,
    }))
    .filter((x) => oversizedThreshold < 0 || x.coreLen > oversizedThreshold)
    .sort((a, b) => b.coreLen - a.coreLen);

  for (const { i } of p1Order) {
    const g = groups[i]!;
    const others = groups
      .filter((_, j) => j !== i)
      .flatMap((x) => x.windows);
    const leftover = maxLines - emittedLineCount(others);
    g.windows = headTailWindows(g.m, leftover, afterLineCount);
  }

  let windows = allWindows().sort((a, b) => a.start - b.start);

  if (emittedLineCount(windows) > maxLines && windows.length > 2) {
    windows = trimPairToBudget(windows[0]!, windows[windows.length - 1]!, maxLines);
  } else if (emittedLineCount(windows) > maxLines && windows.length === 2) {
    windows = trimPairToBudget(windows[0]!, windows[1]!, maxLines);
  } else if (emittedLineCount(windows) > maxLines && windows.length === 1) {
    const w = windows[0]!;
    windows = [
      {
        start: w.start,
        end: Math.min(afterLineCount, w.start + maxLines - 1),
      },
    ];
  }

  if (afterLines) {
    windows = shrinkBytes(afterLines, windows, maxBytes);
  }

  windows = windows
    .map((w) => ({
      start: Math.max(1, w.start),
      end: Math.min(afterLineCount, w.end),
    }))
    .filter((w) => w.end >= w.start);
  windows.sort((a, b) => a.start - b.start);
  if (
    windows.length === 0 &&
    afterLineCount > 0 &&
    hunks.length > 0
  ) {
    return [{ start: 1, end: 1 }];
  }
  return windows;
}

export type ReceiptKind =
  | "edit"
  | "write"
  | "patch-add"
  | "patch-delete"
  | "patch-update";

export type ReceiptHeaderInput = {
  kind: ReceiptKind;
  rel: string;
  moveRel?: string;
  lines: number;
  added: number;
  removed: number | null;
  windows: AfterWindow[];
  matchNote?: "line_trimmed" | "block_anchor";
  replaceAllCount?: number;
  createdParents?: boolean;
  formatted?: string;
  formatSkipped?: string;
  strippedPrefixes?: boolean;
  preimageSkipped?: boolean;
  deleted?: boolean;
};

function lineWord(n: number): string {
  return n === 1 ? "line" : "lines";
}

function formatSpan(windows: AfterWindow[], n: number): string {
  if (!windows.length) return "";
  const shown = windows.slice(0, EDIT_RECEIPT_HEADER_RANGES);
  const bits = shown.map((w) => `${w.start}${ENDASH}${w.end}`);
  const extra = windows.length - shown.length;
  const more = extra > 0 ? ` +${extra} more` : "";
  return `lines ${bits.join(", ")}${more} of ${n}`;
}

function leadFor(input: ReceiptHeaderInput): string {
  if (input.kind === "write") return `Wrote ${input.rel}`;
  if (input.kind === "patch-add") return `A ${input.rel}`;
  if (input.kind === "patch-delete") return `D ${input.rel}`;
  if (input.kind === "patch-update") {
    return input.moveRel
      ? `M ${input.rel} \u2192 ${input.moveRel}`
      : `M ${input.rel}`;
  }
  return `Edited ${input.rel}`;
}

export function formatReceiptHeader(input: ReceiptHeaderInput): string {
  if (input.kind === "patch-delete" || input.deleted) {
    const rem = input.removed ?? 0;
    return `D ${input.rel} · deleted · ${MINUS}${rem} +0`;
  }
  const quals: string[] = [];
  if (input.createdParents) quals.push(" (created parent directories)");
  if (input.matchNote) {
    quals.push(` (matched via ${input.matchNote} fallback)`);
  } else if (input.replaceAllCount != null) {
    const n = input.replaceAllCount;
    quals.push(` (${n} occurrence${n === 1 ? "" : "s"})`);
  }
  if (input.preimageSkipped) quals.push(" (pre-image skipped)");

  const nNote = ` (${input.lines} ${lineWord(input.lines)})`;
  const rem =
    input.removed === null ? "?" : String(input.removed);
  const stats = `${MINUS}${rem} +${input.added}`;
  const span = formatSpan(input.windows, input.lines);
  let format = "";
  if (input.formatted) format = ` (formatted with ${input.formatted})`;
  else if (input.formatSkipped) {
    format = ` (format ${input.formatSkipped})`;
  }
  const strip = input.strippedPrefixes
    ? " (stripped read_file line-number prefixes)"
    : "";
  return (
    leadFor(input) +
    quals.join("") +
    nNote +
    ` · ${stats}` +
    (span ? ` · ${span}` : "") +
    format +
    strip
  );
}

export type BuiltReceipt = {
  output: string;
  diff: string;
  stats: { added: number; removed: number | null };
};

export function buildSuccessReceipt(opts: {
  header: ReceiptHeaderInput;
  after: string;
  before: string;
  relForDiff: string;
  verifyTip?: string;
  windows?: AfterWindow[];
  maxLines?: number;
  maxBytes?: number;
}): BuiltReceipt {
  const hunks = lineHunks(opts.before, opts.after);
  const afterLines = splitFileLines(opts.after);
  const windows =
    opts.windows ??
    selectAfterWindows(hunks, afterLines.length, {
      maxLines: opts.maxLines,
      maxBytes: opts.maxBytes,
      afterLines,
    });
  const header = formatReceiptHeader({
    ...opts.header,
    lines: opts.header.lines,
    added: opts.header.added,
    removed: opts.header.removed,
    windows,
  });
  const body = formatNumberedLines(afterLines, windows);
  const tip = opts.verifyTip ?? "";
  const output = body
    ? `${header}\n\n${body}${tip}`
    : `${header}${tip}`;
  const diff =
    opts.header.preimageSkipped && !opts.before
      ? ""
      : shortDiff(opts.relForDiff, opts.before, opts.after);
  return {
    output,
    diff,
    stats: {
      added: opts.header.added,
      removed: opts.header.removed,
    },
  };
}

export type PatchOpReceipt = {
  kind: "add" | "delete" | "update";
  rel: string;
  moveRel?: string;
  before: string;
  after: string;
  formatted?: string;
  formatSkipped?: string;
};

export function collapsePatchOps(ops: PatchOpReceipt[]): PatchOpReceipt[] {
  const byDest = new Map<string, PatchOpReceipt[]>();
  for (const op of ops) {
    const dest = op.moveRel || op.rel;
    const list = byDest.get(dest) ?? [];
    list.push(op);
    byDest.set(dest, list);
  }
  const out: PatchOpReceipt[] = [];
  const seen = new Set<string>();
  for (const op of ops) {
    const dest = op.moveRel || op.rel;
    if (seen.has(dest)) continue;
    seen.add(dest);
    const group = byDest.get(dest)!;
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const anyAdd = group.some((g) => g.kind === "add" && !g.before);
    let kind: PatchOpReceipt["kind"] = last.kind;
    if (last.kind === "delete") kind = "delete";
    else if (anyAdd && !first.before) kind = "add";
    else kind = "update";
    out.push({
      kind,
      rel: first.rel,
      moveRel: last.moveRel ?? (first.rel !== dest ? dest : undefined),
      before: first.before,
      after: last.after,
      formatted: last.formatted ?? first.formatted,
      formatSkipped: last.formatSkipped ?? first.formatSkipped,
    });
  }
  return out;
}

export function budgetPatchWindows(
  ops: PatchOpReceipt[],
  opts?: { maxLines?: number; maxBytes?: number },
): AfterWindow[][] {
  const capLines = opts?.maxLines ?? EDIT_RECEIPT_MAX_LINES;
  const capBytes = opts?.maxBytes ?? EDIT_RECEIPT_MAX_BYTES;
  let remainingLines = capLines;
  let remainingBytes = capBytes;
  const windows: AfterWindow[][] = ops.map(() => []);
  const phases: number[][] = [
    ops.map((op, i) => (op.kind === "update" ? i : -1)).filter((i) => i >= 0),
    ops.map((op, i) => (op.kind === "add" ? i : -1)).filter((i) => i >= 0),
  ];
  for (const phase of phases) {
    for (const i of phase) {
      if (remainingLines <= 0 || remainingBytes <= 0) continue;
      const op = ops[i]!;
      const hunks = lineHunks(op.before, op.after);
      const afterLines = splitFileLines(op.after);
      const w = selectAfterWindows(hunks, afterLines.length, {
        maxLines: Math.min(EDIT_RECEIPT_MAX_LINES, remainingLines),
        maxBytes: Math.min(EDIT_RECEIPT_MAX_BYTES, remainingBytes),
        afterLines,
      });
      windows[i] = w;
      remainingLines -= emittedLineCount(w);
      remainingBytes -= numberedWindowBytes(afterLines, w);
    }
  }
  return windows;
}

export function buildPatchReceipt(opts: {
  ops: PatchOpReceipt[];
  verifyTip?: string;
}): BuiltReceipt {
  const ops = collapsePatchOps(opts.ops);
  const windows = budgetPatchWindows(ops);
  let added = 0;
  let removed: number | null = 0;
  const headers: string[] = [];
  const blocks: string[] = [];
  const diffs: string[] = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const hunks = lineHunks(op.before, op.after);
    const st = lineStats(hunks);
    added += st.added;
    if (removed !== null) removed += st.removed;
    const w = windows[i] ?? [];
    const kind: ReceiptKind =
      op.kind === "add"
        ? "patch-add"
        : op.kind === "delete"
          ? "patch-delete"
          : "patch-update";
    const header = formatReceiptHeader({
      kind,
      rel: op.rel,
      moveRel: op.moveRel,
      lines: lineCount(op.after),
      added: st.added,
      removed: st.removed,
      windows: w,
      formatted: op.formatted,
      formatSkipped: op.formatSkipped,
      deleted: op.kind === "delete",
    });
    headers.push(header);
    if (op.kind !== "delete" && w.length) {
      const label = op.moveRel ? `${op.rel} \u2192 ${op.moveRel}` : op.rel;
      const body = formatNumberedLines(splitFileLines(op.after), w);
      blocks.push(`${label}\n${body}`);
    }
    const label = op.moveRel ? `${op.rel} \u2192 ${op.moveRel}` : op.rel;
    diffs.push(shortDiff(label, op.before, op.after, 30));
  }

  const wrapper = `Applied patch (${ops.length} op(s)):`;
  const tip = opts.verifyTip ?? "";
  const output =
    wrapper +
    "\n" +
    headers.join("\n") +
    (blocks.length ? `\n\n${blocks.join("\n\n")}` : "") +
    tip;
  return {
    output,
    diff: diffs.join("\n"),
    stats: { added, removed },
  };
}

export function readAfterFormat(abs: string): { text: string; bom: string } {
  const raw = fs.readFileSync(abs, "utf8");
  return splitBom(raw);
}

/** Post-write AFTER text + format clauses for the receipt header. */
export function afterWriteText(
  filePath: string,
  fallback: string,
  fmt: { formatter: string; ok: boolean; detail?: string } | null,
): { after: string; formatted?: string; formatSkipped?: string } {
  if (fmt?.ok) {
    try {
      const { text } = readAfterFormat(filePath);
      return { after: text, formatted: fmt.formatter };
    } catch {
      return {
        after: fallback,
        formatSkipped: `${fmt.formatter} skipped: re-read failed`,
      };
    }
  }
  if (fmt && !fmt.ok) {
    return {
      after: fallback,
      formatSkipped: `${fmt.formatter} skipped: ${fmt.detail || "failed"}`,
    };
  }
  return { after: fallback };
}
