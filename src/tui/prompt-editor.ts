/**
 * REPL prompt editor with multi-line paste that does not auto-submit.
 *
 * Rendering model (critical for correct arrows):
 * - We always know which screen row of the editor block the cursor sits on
 *   (`cursorViewRow`, 0 = top of block).
 * - Redraw = move to block top → clear downward → paint → place cursor →
 *   update `cursorViewRow`. Never assume the cursor is at the block bottom.
 * - Soft-wrap aware: long lines count as multiple terminal rows.
 *
 * Paste: bracketed paste (`CSI ?2004 h`) + burst fallback. Newlines in paste
 * never submit; only explicit Enter does.
 *
 * History: ↑/↓ walks entries; Ctrl+R / Ctrl+S is incremental search
 * (Esc / Ctrl+G cancel). Ctrl/Alt+←/→ and Alt+B/F jump words.
 */
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import chalk from "chalk";
import { formatSlashHitMenu } from "./complete.js";
import {
  stringWidth,
  columnsBefore,
  indexFromColumns,
  graphemes,
  sliceByColumns,
} from "../util/cell-width.js";
import {
  isMouseEnabled,
  parseSgrMouse,
  MOUSE_SGR_ENABLE,
  MOUSE_SGR_DISABLE,
  type MouseEvent,
} from "./mouse.js";

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const BURST_MS = 48;
const BURST_MIN_CHARS = 6;

export type CompleterFn = (line: string) => [string[], string];

export interface PromptEditorOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  history?: string[];
  historySize?: number;
  completer?: CompleterFn;
  forceReadline?: boolean;
  /** After a TTY redraw — restore the bottom dock (never CSI J the last row). */
  onPaint?: () => void;
  /**
   * Rows reserved below the editor (the sticky dock). Clicks map through
   * this so the caret does not jump when the last row is the HUD.
   */
  reservedBottomRows?: number;
  /** Clicks the editor did not consume (dock chips, etc.). */
  onMouse?: (ev: MouseEvent) => void;
}

/**
 * Erase `prevViewRows` of the editor block with EL, not ED.
 * `CSI J` (erase to end of display) wipes the DECSTBM dock row.
 */
export function eraseEditorBlockSeq(prevViewRows: number): string {
  const n = Math.max(0, prevViewRows);
  if (n <= 0) return "";
  let s = "";
  for (let i = 0; i < n; i++) {
    s += "\r\x1b[2K";
    if (i < n - 1) s += "\n";
  }
  if (n > 1) s += `\x1b[${n - 1}A\r`;
  return s;
}

export interface PromptEditor {
  setPrompt(prompt: string): void;
  prompt(preserveCursor?: boolean): void;
  close(): void;
  getLine(): string;
  setLine(text: string): void;
  /**
   * Release raw-mode stdin so a nested readline (permission ask, ask_user)
   * can own the TTY. Idempotent. Does not close the editor or drop the buffer.
   */
  suspend(): void;
  /** Reclaim stdin after a nested prompt. Idempotent. Does not redraw. */
  resume(): void;
  /** True while a nested prompt owns stdin. */
  isSuspended(): boolean;
  /**
   * Mid-run: Ctrl+C with a half-typed draft must abort, not just clear.
   * Idle: first Ctrl+C with a draft still clears the line.
   */
  setBusy(busy: boolean): void;
  /** Fire SIGINT (dock `stop` chip). */
  interrupt(): void;
  /**
   * Forget the last painted block without writing. After the token stream
   * overwrites `live ›`, the next `prompt()` must start on a fresh line
   * instead of CSI-up-erasing the reply.
   */
  abandonPaint(): void;
  on(event: "line", listener: (line: string) => void): this;
  on(event: "SIGINT", listener: () => void): this;
  on(event: "close", listener: () => void): this;
  once(event: "line", listener: (line: string) => void): this;
  once(event: "SIGINT", listener: () => void): this;
  once(event: "close", listener: () => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
}

// ── Pure helpers (tested) ──────────────────────────────────────────────

export function encodeHistoryEntry(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/**
 * Idle Ctrl+C: first press with a draft clears the line (no SIGINT).
 * Mid-run (`busy`) Ctrl+C always interrupts — a half-typed /cycle or
 * queued message must not trap the abort key.
 */
export function resolveCtrlC(
  buffer: string,
  busy: boolean,
): "clear" | "sigint" {
  if (busy) return "sigint";
  return buffer.length > 0 ? "clear" : "sigint";
}

export function decodeHistoryEntry(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === "n") {
        out += "\n";
        i++;
        continue;
      }
      if (n === "\\") {
        out += "\\";
        i++;
        continue;
      }
    }
    out += s[i];
  }
  return out;
}

export function insertText(
  buffer: string,
  cursor: number,
  text: string,
): { buffer: string; cursor: number } {
  const c = Math.max(0, Math.min(cursor, buffer.length));
  return {
    buffer: buffer.slice(0, c) + text + buffer.slice(c),
    cursor: c + text.length,
  };
}

/** UTF-16 offsets of grapheme boundaries, including 0 and buffer.length. */
export function graphemeOffsets(buffer: string): number[] {
  const offs = [0];
  let o = 0;
  for (const g of graphemes(buffer)) {
    o += g.length;
    offs.push(o);
  }
  return offs;
}

/** Move one grapheme cluster. Never lands inside a surrogate pair or 你. */
export function moveGrapheme(
  buffer: string,
  cursor: number,
  dir: -1 | 1,
): number {
  const c = Math.max(0, Math.min(cursor, buffer.length));
  const offs = graphemeOffsets(buffer);
  if (dir < 0) {
    for (let i = offs.length - 1; i >= 0; i--) {
      if (offs[i]! < c) return offs[i]!;
    }
    return 0;
  }
  for (const o of offs) {
    if (o > c) return o;
  }
  return buffer.length;
}

export function deleteBackward(
  buffer: string,
  cursor: number,
): { buffer: string; cursor: number } {
  if (cursor <= 0) return { buffer, cursor };
  const start = moveGrapheme(buffer, cursor, -1);
  return {
    buffer: buffer.slice(0, start) + buffer.slice(cursor),
    cursor: start,
  };
}

export function deleteForward(
  buffer: string,
  cursor: number,
): { buffer: string; cursor: number } {
  if (cursor >= buffer.length) return { buffer, cursor };
  const end = moveGrapheme(buffer, cursor, 1);
  return {
    buffer: buffer.slice(0, cursor) + buffer.slice(end),
    cursor,
  };
}

export function deleteWordBackward(
  buffer: string,
  cursor: number,
): { buffer: string; cursor: number } {
  if (cursor <= 0) return { buffer, cursor };
  const i = moveWord(buffer, cursor, -1);
  return {
    buffer: buffer.slice(0, i) + buffer.slice(cursor),
    cursor: i,
  };
}

function wordSegmentAt(
  buffer: string,
  index: number,
): { start: number; end: number } {
  const n = buffer.length;
  const i = Math.max(0, Math.min(index, n));
  let off = 0;
  for (const { segment } of wordSegmenter.segment(buffer)) {
    const end = off + segment.length;
    if (i >= off && i < end) return { start: off, end };
    off = end;
  }
  return { start: n, end: n };
}

/**
 * Jump a word. ASCII stays whitespace-delimited; CJK uses Unicode words
 * so `hello世界` is two hops, not one.
 */
export function moveWord(
  buffer: string,
  cursor: number,
  dir: -1 | 1,
): number {
  const n = buffer.length;
  let i = Math.max(0, Math.min(cursor, n));
  if (dir < 0) {
    while (i > 0 && /\s/.test(buffer[i - 1]!)) i--;
    if (i > 0 && !/\s/.test(buffer[i - 1]!)) {
      i = wordSegmentAt(buffer, i - 1).start;
    }
    return i;
  }
  if (i < n && !/\s/.test(buffer[i]!)) {
    i = wordSegmentAt(buffer, i).end;
  }
  while (i < n && /\s/.test(buffer[i]!)) i++;
  return i;
}

/**
 * Ctrl/Alt + arrow: `CSI 1;5C` / `1;3D` (and `CSI 5C` on some terms).
 * 0 = ordinary left/right.
 */
export function csiIsWordMotion(params: string, final: string): -1 | 1 | 0 {
  if (final !== "C" && final !== "D") return 0;
  const mod = params.includes(";") ? (params.split(";")[1] ?? "") : params;
  if (mod !== "5" && mod !== "3") return 0;
  return final === "C" ? 1 : -1;
}

export type HistorySearchDir = -1 | 1;

export interface HistorySearch {
  query: string;
  /** Index into history, or -1 when the list is empty. */
  matchIndex: number;
  dir: HistorySearchDir;
  failed: boolean;
}

function historyEntryMatches(entry: string, query: string): boolean {
  if (!query) return true;
  return entry.toLowerCase().includes(query.toLowerCase());
}

/**
 * Walk history for a case-insensitive substring. `fromIndex` + `exclusive`
 * start at the next slot in `dir` (Ctrl+R again). Default: newest first.
 */
export function findHistoryMatch(
  history: readonly string[],
  query: string,
  opts?: {
    fromIndex?: number;
    exclusive?: boolean;
    dir?: HistorySearchDir;
  },
): number {
  if (!history.length) return -1;
  const dir = opts?.dir ?? -1;
  let i: number;
  if (opts?.fromIndex == null) {
    i = dir < 0 ? history.length - 1 : 0;
  } else if (opts.exclusive) {
    i = opts.fromIndex + dir;
  } else {
    i = opts.fromIndex;
  }
  while (i >= 0 && i < history.length) {
    if (historyEntryMatches(history[i]!, query)) return i;
    i += dir;
  }
  return -1;
}

export function startHistorySearch(
  history: readonly string[],
  dir: HistorySearchDir = -1,
): HistorySearch {
  const matchIndex = findHistoryMatch(history, "", { dir });
  return {
    query: "",
    matchIndex,
    dir,
    failed: matchIndex < 0,
  };
}

export type HistorySearchAction =
  | { type: "type"; text: string }
  | { type: "backspace" }
  | { type: "again" }
  | { type: "flip"; dir: HistorySearchDir };

/**
 * Refine the query (keep the current hit when it still matches) or step
 * to the next older/newer hit. A failed step keeps the last good index.
 */
export function stepHistorySearch(
  history: readonly string[],
  search: HistorySearch,
  action: HistorySearchAction,
): HistorySearch {
  let query = search.query;
  let dir = search.dir;
  let exclusive = false;
  let fromIndex: number | undefined = search.matchIndex;

  if (action.type === "type") {
    query += action.text;
    if (
      search.matchIndex >= 0 &&
      historyEntryMatches(history[search.matchIndex] ?? "", query)
    ) {
      return { query, matchIndex: search.matchIndex, dir, failed: false };
    }
    exclusive = search.matchIndex >= 0;
  } else if (action.type === "backspace") {
    if (!query) return { ...search, failed: false };
    query = query.slice(0, -1);
    if (
      search.matchIndex >= 0 &&
      historyEntryMatches(history[search.matchIndex] ?? "", query)
    ) {
      return { query, matchIndex: search.matchIndex, dir, failed: false };
    }
    fromIndex = undefined;
  } else if (action.type === "again") {
    exclusive = search.matchIndex >= 0;
  } else {
    dir = action.dir;
    exclusive = search.matchIndex >= 0;
  }

  const hit = findHistoryMatch(history, query, {
    fromIndex,
    exclusive,
    dir,
  });
  if (hit >= 0) return { query, matchIndex: hit, dir, failed: false };
  return {
    query,
    matchIndex: search.matchIndex,
    dir,
    failed: true,
  };
}

const HISTORY_QUERY_MAX_COLS = 32;

/**
 * Prompt prefix while Ctrl+R / Ctrl+S is live. The match itself is the
 * editor buffer; this only names the mode + typed query (so a failed
 * search still shows what you typed).
 */
export function formatHistorySearchPrompt(search: HistorySearch): string {
  const q = search.query.replace(/\n/g, " ");
  const shown =
    stringWidth(q) > HISTORY_QUERY_MAX_COLS
      ? `${sliceByColumns(q, HISTORY_QUERY_MAX_COLS - 1)}…`
      : q;
  const dir = search.dir > 0 ? "↓ " : "";
  const mark = search.failed ? "✗ ›" : "›";
  return `search ${dir}${mark} ${shown} · `;
}

export const HISTORY_SEARCH_FOOTER =
  "  ^R older · ^S newer · esc cancel · ↵ run";

/** Cursor offset of `query` inside a matched history entry (end if empty). */
export function historySearchCursor(match: string, query: string): number {
  if (!query) return match.length;
  const idx = match.toLowerCase().indexOf(query.toLowerCase());
  return idx >= 0 ? idx + query.length : match.length;
}

export function normalizePaste(text: string): string {
  let t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (t.endsWith("\n") && !t.endsWith("\n\n")) {
    t = t.slice(0, -1);
  }
  return t;
}

export function countLines(s: string): number {
  if (!s) return 1;
  return s.split("\n").length;
}

export function cursorRowCol(
  buffer: string,
  cursor: number,
): { row: number; col: number } {
  const before = buffer.slice(0, Math.max(0, Math.min(cursor, buffer.length)));
  const parts = before.split("\n");
  return { row: parts.length - 1, col: parts[parts.length - 1]!.length };
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Terminal display columns. Alias of `stringWidth` (CJK = 2). */
export function displayWidth(s: string): number {
  return stringWidth(s);
}

/** Screen rows used by a logical line of known prefix + content widths. */
export function softWrapRows(contentWidth: number, cols: number): number {
  const c = Math.max(1, cols);
  if (contentWidth <= 0) return 1;
  return Math.max(1, Math.ceil(contentWidth / c));
}

/**
 * Layout the editor block for paint + cursor placement.
 * Pure — unit tested.
 */
export function layoutEditor(opts: {
  buffer: string;
  cursor: number;
  promptPlain: string;
  cols: number;
  showFooter: boolean;
}): {
  /** Screen rows from top of block to the cursor row (0-based). */
  cursorViewRow: number;
  /** Column (0-based) of cursor within its screen row. */
  cursorViewCol: number;
  /** Total screen rows in the block (content + optional footer). */
  totalViewRows: number;
  /** Logical lines with prefix widths for painting. */
  logical: Array<{ prefixPlain: string; text: string; prefixWidth: number }>;
} {
  const cols = Math.max(8, opts.cols);
  const lines = opts.buffer.length ? opts.buffer.split("\n") : [""];
  const promptW = displayWidth(opts.promptPlain);
  const contLabel = "… ";
  const contPad = Math.max(0, promptW - displayWidth(contLabel));
  const contPlain = " ".repeat(contPad) + contLabel;
  const contW = displayWidth(contPlain);

  const logical = lines.map((text, i) => ({
    prefixPlain: i === 0 ? opts.promptPlain : contPlain,
    text,
    prefixWidth: i === 0 ? promptW : contW,
  }));

  const { row: logRow, col: logCol } = cursorRowCol(opts.buffer, opts.cursor);

  // Screen rows before the logical line that holds the cursor
  let rowsBefore = 0;
  for (let i = 0; i < logRow; i++) {
    const L = logical[i]!;
    rowsBefore += softWrapRows(L.prefixWidth + displayWidth(L.text), cols);
  }

  const curLine = logical[logRow] ?? logical[0]!;
  const absCol = curLine.prefixWidth + columnsBefore(curLine.text, logCol);
  // xenl: a filled row leaves the caret on that row at `cols`, not the next.
  let wrapRowInLine = Math.floor(absCol / cols);
  let cursorViewCol = absCol % cols;
  if (cursorViewCol === 0 && absCol > 0) {
    wrapRowInLine -= 1;
    cursorViewCol = cols;
  }
  const cursorViewRow = rowsBefore + wrapRowInLine;

  let totalViewRows = 0;
  for (const L of logical) {
    totalViewRows += softWrapRows(L.prefixWidth + displayWidth(L.text), cols);
  }
  if (opts.showFooter) totalViewRows += 1;
  totalViewRows = Math.max(1, totalViewRows, cursorViewRow + 1);

  return {
    cursorViewRow,
    cursorViewCol,
    totalViewRows,
    logical,
  };
}

/**
 * Inverse of layoutEditor: buffer index for a click at a view row/col
 * inside the editor block. Clicks on the prompt prefix snap to the line
 * start; clicks past the end snap to the line end.
 */
export function cursorIndexAt(
  opts: {
    buffer: string;
    promptPlain: string;
    cols: number;
    showFooter: boolean;
    viewRow: number;
    viewCol: number;
  },
): number {
  const layout = layoutEditor({
    buffer: opts.buffer,
    cursor: 0,
    promptPlain: opts.promptPlain,
    cols: opts.cols,
    showFooter: opts.showFooter,
  });
  const cols = Math.max(8, opts.cols);
  const lines = opts.buffer.length ? opts.buffer.split("\n") : [""];
  let row = 0;
  let off = 0;
  for (let i = 0; i < layout.logical.length; i++) {
    const L = layout.logical[i]!;
    const used = softWrapRows(L.prefixWidth + displayWidth(L.text), cols);
    const next = row + used;
    if (opts.viewRow < next || i === layout.logical.length - 1) {
      const wrapRow = Math.max(0, Math.min(used - 1, opts.viewRow - row));
      const absCol = wrapRow * cols + opts.viewCol;
      const contentCol = Math.max(0, absCol - L.prefixWidth);
      const colIndex = indexFromColumns(L.text, contentCol);
      return off + colIndex;
    }
    row = next;
    off += (lines[i] ?? "").length + (i < lines.length - 1 ? 1 : 0);
  }
  return opts.buffer.length;
}

// ── Factory ────────────────────────────────────────────────────────────

export function createPromptEditor(opts: PromptEditorOptions = {}): PromptEditor {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const isTty =
    !opts.forceReadline &&
    Boolean(
      (input as NodeJS.ReadStream).isTTY &&
        (output as NodeJS.WriteStream).isTTY,
    );

  if (!isTty) {
    return createReadlineFallback(opts, input, output);
  }
  return new TtyPromptEditor(
    opts,
    input as NodeJS.ReadStream,
    output as NodeJS.WriteStream,
  );
}

function createReadlineFallback(
  opts: PromptEditorOptions,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): PromptEditor {
  const ee = new EventEmitter();
  const history = [...(opts.history ?? [])];
  const rl = readline.createInterface({
    input,
    output,
    terminal: Boolean((input as NodeJS.ReadStream).isTTY),
    historySize: opts.historySize ?? 300,
    history: history.length ? history : undefined,
    completer: opts.completer
      ? (line: string) => opts.completer!(line)
      : undefined,
  }) as ReadlineInterface & { line?: string };

  let suspended = false;
  const wrap: PromptEditor = {
    setPrompt: (p) => rl.setPrompt(p),
    prompt: (preserve) => {
      if (suspended) return;
      rl.prompt(preserve);
    },
    close: () => rl.close(),
    getLine: () => rl.line ?? "",
    setLine: (text) => {
      const anyRl = rl as unknown as { line: string; cursor: number };
      if (typeof anyRl.line === "string") {
        anyRl.line = text;
        anyRl.cursor = text.length;
      }
    },
    suspend: () => {
      if (suspended) return;
      suspended = true;
      try {
        rl.pause();
      } catch {
        /* ignore */
      }
    },
    resume: () => {
      if (!suspended) return;
      suspended = false;
      try {
        rl.resume();
      } catch {
        /* ignore */
      }
    },
    isSuspended: () => suspended,
    setBusy: () => {
      /* classic readline always emits SIGINT on Ctrl+C */
    },
    interrupt: () => {
      ee.emit("SIGINT");
    },
    abandonPaint: () => {
      /* classic readline has no in-place paint to abandon */
    },
    on: (event, listener) => {
      ee.on(event, listener as (...args: unknown[]) => void);
      return wrap;
    },
    once: (event, listener) => {
      ee.once(event, listener as (...args: unknown[]) => void);
      return wrap;
    },
    removeListener: (event, listener) => {
      ee.removeListener(event, listener as (...args: unknown[]) => void);
      return wrap;
    },
    off: (event, listener) => {
      ee.off(event, listener as (...args: unknown[]) => void);
      return wrap;
    },
  };

  rl.on("line", (line) => ee.emit("line", line));
  rl.on("SIGINT", () => ee.emit("SIGINT"));
  rl.on("close", () => ee.emit("close"));
  return wrap;
}

// ── TTY editor ─────────────────────────────────────────────────────────

class TtyPromptEditor extends EventEmitter implements PromptEditor {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly completer?: CompleterFn;
  private readonly historySize: number;
  private history: string[];
  private historyIndex = -1;
  private historySnapshot = "";

  private promptStr = "";
  private buffer = "";
  private cursor = 0;
  private closed = false;
  private suspended = false;
  private busy = false;
  private pasting = false;
  private pending = "";
  /** Screen row of cursor within the editor block (0 = top). */
  private cursorViewRow = 0;
  private painted = false;
  private multiLineHint = false;

  private burstActive = false;
  private burstTimer: ReturnType<typeof setTimeout> | null = null;
  private escTimer: ReturnType<typeof setTimeout> | null = null;

  /** Ctrl+R / Ctrl+S incremental history search. */
  private search: HistorySearch | null = null;
  private searchSnapshot = "";
  private searchSnapshotCursor = 0;

  private readonly onData: (chunk: Buffer | string) => void;
  private readonly utf8: TextDecoder;
  private readonly onPaint?: () => void;
  private readonly onMouse?: (ev: MouseEvent) => void;
  private readonly reservedBottomRows: number;
  private readonly mouseOn: boolean;
  /** Last painted block height, for EL (not ED) erase. */
  private lastTotalViewRows = 0;

  constructor(
    opts: PromptEditorOptions,
    input: NodeJS.ReadStream,
    output: NodeJS.WriteStream,
  ) {
    super();
    this.input = input;
    this.output = output;
    this.completer = opts.completer;
    this.onPaint = opts.onPaint;
    this.onMouse = opts.onMouse;
    this.reservedBottomRows = Math.max(0, opts.reservedBottomRows ?? 0);
    this.mouseOn = isMouseEnabled();
    this.historySize = opts.historySize ?? 300;
    this.history = [...(opts.history ?? [])].slice(-this.historySize);

    this.utf8 = new TextDecoder("utf-8");
    this.onData = (chunk) => {
      if (typeof chunk === "string") {
        this.feed(chunk);
        return;
      }
      const raw = this.utf8.decode(chunk, { stream: true });
      if (raw) this.feed(raw);
    };
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.input.on("data", this.onData);
    this.output.write(BRACKETED_PASTE_ENABLE);
    if (this.mouseOn) this.output.write(MOUSE_SGR_ENABLE);
  }

  setPrompt(prompt: string): void {
    this.promptStr = prompt;
  }

  getLine(): string {
    return this.buffer;
  }

  setLine(text: string): void {
    this.search = null;
    this.buffer = text;
    this.cursor = text.length;
    this.redraw();
  }

  prompt(_preserve = false): void {
    if (this.closed || this.suspended) return;
    this.redraw();
  }

  suspend(): void {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    this.clearBurst();
    this.clearEscTimer();
    this.dropSearch(/* restore */ true);
    this.pasting = false;
    this.pending = "";
    try {
      this.output.write(BRACKETED_PASTE_DISABLE);
      if (this.mouseOn) this.output.write(MOUSE_SGR_DISABLE);
    } catch {
      /* ignore */
    }
    try {
      this.utf8.decode(new Uint8Array(), { stream: false });
    } catch {
      /* ignore */
    }
    this.input.removeListener("data", this.onData);
    if (this.input.isTTY) {
      try {
        this.input.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    this.painted = false;
    this.cursorViewRow = 0;
    this.lastTotalViewRows = 0;
  }

  resume(): void {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    this.input.on("data", this.onData);
    if (this.input.isTTY) {
      try {
        this.input.setRawMode(true);
      } catch {
        /* ignore */
      }
    }
    try {
      this.input.resume();
    } catch {
      /* ignore */
    }
    try {
      this.output.write(BRACKETED_PASTE_ENABLE);
      if (this.mouseOn) this.output.write(MOUSE_SGR_ENABLE);
    } catch {
      /* ignore */
    }
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  interrupt(): void {
    this.emit("SIGINT");
  }

  abandonPaint(): void {
    this.painted = false;
    this.cursorViewRow = 0;
    this.lastTotalViewRows = 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.suspended = false;
    this.clearBurst();
    this.clearEscTimer();
    this.search = null;
    try {
      this.output.write(BRACKETED_PASTE_DISABLE);
      if (this.mouseOn) this.output.write(MOUSE_SGR_DISABLE);
    } catch {
      /* ignore */
    }
    try {
      this.utf8.decode(new Uint8Array(), { stream: false });
    } catch {
      /* ignore */
    }
    this.input.removeListener("data", this.onData);
    if (this.input.isTTY) {
      try {
        this.input.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    this.emit("close");
  }

  // ── Parse ────────────────────────────────────────────────────────────

  private feed(raw: string): void {
    if (this.closed || this.suspended) return;
    this.clearEscTimer();
    this.pending += raw;

    while (this.pending.length > 0) {
      if (this.pasting) {
        const end = this.pending.indexOf(PASTE_END);
        if (end === -1) {
          if (this.pending.length > 8) {
            const keep = 6;
            const body = this.pending.slice(0, this.pending.length - keep);
            this.pending = this.pending.slice(this.pending.length - keep);
            if (body) {
              this.insert(body);
              this.redraw();
            }
          }
          return;
        }
        const body = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + PASTE_END.length);
        if (body) this.insert(body);
        this.endBracketedPaste();
        continue;
      }

      const ps = this.pending.indexOf(PASTE_START);
      if (ps === 0) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.acceptSearch();
        this.pasting = true;
        continue;
      }
      if (ps > 0) {
        this.consumeNormal(this.pending.slice(0, ps));
        this.pending = this.pending.slice(ps);
        continue;
      }
      if (
        PASTE_START.startsWith(this.pending) ||
        this.pending.startsWith("\x1b")
      ) {
        // May be incomplete ESC / paste start
        if (this.pending.startsWith("\x1b[")) {
          if (!this.escapeComplete(this.pending)) return;
          const used = this.consumeEscape(this.pending);
          this.pending = this.pending.slice(used);
          continue;
        }
        if (this.pending === "\x1b") {
          this.scheduleBareEsc();
          return;
        }
        if (this.pending.startsWith("\x1b") && this.pending.length < 2) return;
        if (
          this.pending.length < PASTE_START.length &&
          PASTE_START.startsWith(this.pending)
        ) {
          return;
        }
      }

      // Unbracketed multi-line burst (whole remaining chunk)
      if (
        !this.burstActive &&
        this.pending.length >= BURST_MIN_CHARS &&
        /[\r\n]/.test(this.pending) &&
        !this.pending.startsWith("\x1b")
      ) {
        const text = normalizePaste(this.pending);
        this.pending = "";
        this.burstActive = true;
        this.insert(text);
        this.multiLineHint = countLines(this.buffer) > 1;
        this.redraw();
        this.scheduleBurstEnd();
        return;
      }

      if (this.pending.startsWith("\x1b")) {
        if (!this.escapeComplete(this.pending)) return;
        const used = this.consumeEscape(this.pending);
        this.pending = this.pending.slice(used);
        continue;
      }

      this.consumeNormal(this.pending);
      this.pending = "";
    }
  }

  private escapeComplete(s: string): boolean {
    if (s === "\x1b") return false;
    if (s.startsWith("\x1b[<")) {
      return /[Mm]$/.test(s) || s.length > 40;
    }
    if (s.startsWith("\x1b[")) {
      if (s.length < 3) return false;
      return /[A-Za-z~u]$/.test(s) || s.length > 32;
    }
    return s.length >= 2;
  }

  private consumeEscape(s: string): number {
    if (s.startsWith(PASTE_START)) {
      this.pasting = true;
      return PASTE_START.length;
    }
    if (s.startsWith("\x1b[<")) {
      const m = s.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (!m) return 1;
      const ev = parseSgrMouse(m[0]!);
      if (ev) this.handleMouse(ev);
      return m[0]!.length;
    }
    if (s.startsWith("\x1b[")) {
      const m = s.match(/^\x1b\[([0-9;]*)([A-Za-z~u])/);
      if (!m) return 1;
      this.handleCsi(m[1]!, m[2]!);
      return m[0]!.length;
    }
    if (s.length >= 2 && s[0] === "\x1b") {
      const k = s[1]!;
      if (k === "\x1b") {
        if (this.search) this.cancelSearch();
        return 2;
      }
      if (k === "b" || k === "B") {
        this.acceptSearch();
        this.moveByWord(-1);
        return 2;
      }
      if (k === "f" || k === "F") {
        this.acceptSearch();
        this.moveByWord(1);
        return 2;
      }
      if (k === "\r" || k === "\n") {
        this.acceptSearch();
        this.insert("\n");
        this.multiLineHint = true;
        this.redraw();
      } else if (k >= " ") {
        if (this.search) {
          this.refineSearch({ type: "type", text: k });
        } else {
          this.insert(k);
          this.redraw();
        }
      }
      return 2;
    }
    return 1;
  }

  private handleCsi(params: string, final: string): void {
    const wordDir = csiIsWordMotion(params, final);
    if (wordDir) {
      this.acceptSearch();
      this.moveByWord(wordDir);
      return;
    }
    if (final === "A") {
      this.acceptSearch();
      this.historyUp();
      return;
    }
    if (final === "B") {
      this.acceptSearch();
      this.historyDown();
      return;
    }
    if (final === "C") {
      this.acceptSearch();
      this.cursor = moveGrapheme(this.buffer, this.cursor, 1);
      this.redraw();
      return;
    }
    if (final === "D") {
      this.acceptSearch();
      this.cursor = moveGrapheme(this.buffer, this.cursor, -1);
      this.redraw();
      return;
    }
    if (final === "H" || params + final === "1~") {
      this.acceptSearch();
      this.cursor = 0;
      this.redraw();
      return;
    }
    if (final === "F" || params + final === "4~" || params + final === "8~") {
      this.acceptSearch();
      this.cursor = this.buffer.length;
      this.redraw();
      return;
    }
    if (params + final === "3~") {
      this.acceptSearch();
      const r = deleteForward(this.buffer, this.cursor);
      this.buffer = r.buffer;
      this.cursor = r.cursor;
      this.redraw();
      return;
    }
    if (final === "u") {
      const parts = params.split(";").map(Number);
      if (parts[0] === 13 && (parts[1] ?? 0) >= 2) {
        this.insert("\n");
        this.multiLineHint = true;
        this.redraw();
      }
      return;
    }
    if (final === "~" && /^27;\d+;13$/.test(params)) {
      this.insert("\n");
      this.multiLineHint = true;
      this.redraw();
    }
  }

  private handleMouse(ev: MouseEvent): void {
    if (ev.release || ev.motion) return;
    if (ev.shift || ev.wheel) return;
    if (ev.btn === 0 && this.tryClickCaret(ev)) return;
    try {
      this.onMouse?.(ev);
    } catch {
      /* dock chips must not break input */
    }
  }

  /**
   * Left-click inside the painted editor block → caret. Assumes the block
   * sits just above the reserved dock rows (true after a redraw at
   * forge › / live ›). Ignored while a stream has abandoned the paint.
   */
  private tryClickCaret(ev: MouseEvent): boolean {
    if (!this.painted || this.search) return false;
    const termRows = Math.max(4, this.output.rows || 24);
    const origin = termRows - this.reservedBottomRows - this.lastTotalViewRows + 1;
    const viewRow = ev.y - origin;
    if (viewRow < 0 || viewRow >= this.lastTotalViewRows) return false;
    this.acceptSearch();
    this.cursor = cursorIndexAt({
      buffer: this.buffer,
      promptPlain: stripAnsi(this.activePrompt()),
      cols: this.cols(),
      showFooter:
        Boolean(this.search) ||
        this.multiLineHint ||
        countLines(this.buffer) > 1,
      viewRow,
      viewCol: ev.x - 1,
    });
    this.historyIndex = -1;
    this.redraw();
    return true;
  }

  private consumeNormal(text: string): void {
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      if (ch === "\x03") {
        // Ctrl+C — mid-run always aborts so a half-typed draft cannot trap it
        if (this.search) {
          this.cancelSearch();
          if (this.busy) this.emit("SIGINT");
          continue;
        }
        if (resolveCtrlC(this.buffer, this.busy) === "clear") {
          this.buffer = "";
          this.cursor = 0;
          this.historyIndex = -1;
          this.multiLineHint = false;
          this.finishClearLine();
        } else {
          if (this.buffer.length > 0) {
            this.buffer = "";
            this.cursor = 0;
            this.historyIndex = -1;
            this.multiLineHint = false;
            this.finishClearLine();
          }
          this.emit("SIGINT");
        }
        continue;
      }
      if (ch === "\x12") {
        // Ctrl+R — reverse incremental history search
        this.enterSearch(-1);
        continue;
      }
      if (ch === "\x13") {
        // Ctrl+S — forward incremental history search
        this.enterSearch(1);
        continue;
      }
      if (ch === "\x07") {
        // Ctrl+G — abort search (readline)
        if (this.search) this.cancelSearch();
        continue;
      }
      if (ch === "\x04") {
        if (this.buffer.length === 0) {
          this.close();
          return;
        }
        const r = deleteForward(this.buffer, this.cursor);
        this.buffer = r.buffer;
        this.cursor = r.cursor;
        this.redraw();
        continue;
      }
      if (ch === "\x15") {
        if (this.search) {
          this.setSearchQuery("");
          continue;
        }
        this.buffer = "";
        this.cursor = 0;
        this.multiLineHint = false;
        this.finishClearLine();
        continue;
      }
      if (ch === "\x17") {
        if (this.search) {
          const q = this.search.query.replace(/\s+$/u, "");
          const cut = q.lastIndexOf(" ");
          this.setSearchQuery(cut >= 0 ? q.slice(0, cut) : "");
          continue;
        }
        const r = deleteWordBackward(this.buffer, this.cursor);
        this.buffer = r.buffer;
        this.cursor = r.cursor;
        this.redraw();
        continue;
      }
      if (ch === "\x01") {
        this.acceptSearch();
        this.cursor = 0;
        this.redraw();
        continue;
      }
      if (ch === "\x05") {
        this.acceptSearch();
        this.cursor = this.buffer.length;
        this.redraw();
        continue;
      }
      if (ch === "\t") {
        if (this.search) {
          this.acceptSearch();
          this.redraw();
          continue;
        }
        this.doComplete();
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        if (this.search) {
          this.refineSearch({ type: "backspace" });
          continue;
        }
        const r = deleteBackward(this.buffer, this.cursor);
        this.buffer = r.buffer;
        this.cursor = r.cursor;
        if (!this.buffer.includes("\n")) this.multiLineHint = false;
        this.redraw();
        continue;
      }
      if (ch === "\r") {
        if (chars[i + 1] === "\n") i++;
        if (this.burstActive) {
          this.acceptSearch();
          this.insert("\n");
          this.multiLineHint = true;
          this.scheduleBurstEnd();
          this.redraw();
          continue;
        }
        if (this.search) {
          if (this.search.matchIndex < 0) {
            this.cancelSearch();
            continue;
          }
          this.acceptSearch();
        }
        this.submit();
        continue;
      }
      if (ch === "\n") {
        if (this.search) {
          this.refineSearch({ type: "type", text: " " });
          continue;
        }
        this.insert("\n");
        this.multiLineHint = true;
        this.scheduleBurstEnd();
        this.redraw();
        continue;
      }
      if (ch >= " " || ch === "\t") {
        if (this.search) {
          this.refineSearch({ type: "type", text: ch });
          continue;
        }
        this.insert(ch);
        this.redraw();
      }
    }
  }

  /** Clear draft and repaint a clean single prompt line. */
  private finishClearLine(): void {
    this.goToBlockTop();
    const wipe = eraseEditorBlockSeq(this.lastTotalViewRows || 1);
    if (wipe) this.output.write(wipe);
    this.painted = false;
    this.cursorViewRow = 0;
    this.lastTotalViewRows = 0;
    this.redraw();
  }

  private endBracketedPaste(): void {
    this.pasting = false;
    if (
      this.cursor === this.buffer.length &&
      this.buffer.endsWith("\n") &&
      !this.buffer.endsWith("\n\n")
    ) {
      this.buffer = this.buffer.slice(0, -1);
      this.cursor = this.buffer.length;
    }
    if (countLines(this.buffer) > 1 || this.buffer.length > 80) {
      this.multiLineHint = true;
    }
    this.redraw();
  }

  private scheduleBurstEnd(): void {
    this.burstActive = true;
    if (this.burstTimer) clearTimeout(this.burstTimer);
    this.burstTimer = setTimeout(() => {
      this.burstActive = false;
      this.burstTimer = null;
      if (countLines(this.buffer) > 1) {
        this.multiLineHint = true;
        this.redraw();
      }
    }, BURST_MS);
    this.burstTimer.unref?.();
  }

  private clearBurst(): void {
    this.burstActive = false;
    if (this.burstTimer) {
      clearTimeout(this.burstTimer);
      this.burstTimer = null;
    }
  }

  private clearEscTimer(): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }

  private scheduleBareEsc(): void {
    this.clearEscTimer();
    this.escTimer = setTimeout(() => {
      this.escTimer = null;
      if (this.pending !== "\x1b") return;
      this.pending = "";
      if (this.search) this.cancelSearch();
    }, 50);
    this.escTimer.unref?.();
  }

  private enterSearch(dir: HistorySearchDir): void {
    if (!this.search) {
      this.searchSnapshot = this.buffer;
      this.searchSnapshotCursor = this.cursor;
      this.search = startHistorySearch(this.history, dir);
      this.applySearchMatch();
      this.redraw();
      return;
    }
    this.refineSearch(
      this.search.dir === dir ? { type: "again" } : { type: "flip", dir },
    );
  }

  private refineSearch(action: HistorySearchAction): void {
    if (!this.search) return;
    this.search = stepHistorySearch(this.history, this.search, action);
    this.applySearchMatch();
    this.redraw();
  }

  private setSearchQuery(query: string): void {
    if (!this.search) return;
    const hit = findHistoryMatch(this.history, query, { dir: this.search.dir });
    this.search = {
      query,
      matchIndex: hit >= 0 ? hit : this.search.matchIndex,
      dir: this.search.dir,
      failed: hit < 0,
    };
    this.applySearchMatch();
    this.redraw();
  }

  private applySearchMatch(): void {
    if (!this.search || this.search.matchIndex < 0) return;
    const match = this.history[this.search.matchIndex];
    if (match == null) return;
    this.buffer = match;
    this.cursor = historySearchCursor(match, this.search.query);
    this.multiLineHint = match.includes("\n");
    this.historyIndex = -1;
  }

  /** Keep the current match in the buffer and leave search mode. */
  private acceptSearch(): void {
    if (!this.search) return;
    this.search = null;
    this.historyIndex = -1;
  }

  private cancelSearch(): void {
    if (!this.search) return;
    this.buffer = this.searchSnapshot;
    this.cursor = this.searchSnapshotCursor;
    this.search = null;
    this.multiLineHint = this.buffer.includes("\n");
    this.redraw();
  }

  private dropSearch(restore: boolean): void {
    if (!this.search) return;
    if (restore) {
      this.buffer = this.searchSnapshot;
      this.cursor = this.searchSnapshotCursor;
      this.multiLineHint = this.buffer.includes("\n");
    }
    this.search = null;
  }

  private moveByWord(dir: -1 | 1): void {
    this.cursor = moveWord(this.buffer, this.cursor, dir);
    this.redraw();
  }

  private activePrompt(): string {
    if (!this.search) return this.promptStr;
    return chalk.dim(formatHistorySearchPrompt(this.search));
  }

  private insert(text: string): void {
    if (!text) return;
    const r = insertText(this.buffer, this.cursor, text);
    this.buffer = r.buffer;
    this.cursor = r.cursor;
    this.historyIndex = -1;
  }

  private submit(): void {
    this.clearBurst();
    this.search = null;
    const line = this.buffer;
    // Move to end of block, then newline into scrollback as submitted input
    this.goToBlockEnd();
    this.output.write("\n");
    if (line.trim()) this.pushHistory(line);
    this.buffer = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.multiLineHint = false;
    this.painted = false;
    this.cursorViewRow = 0;
    this.emit("line", line);
  }

  private pushHistory(entry: string): void {
    if (this.history[this.history.length - 1] === entry) return;
    this.history.push(entry);
    if (this.history.length > this.historySize) {
      this.history = this.history.slice(-this.historySize);
    }
  }

  private historyUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1 && this.buffer.includes("\n")) {
      const before = this.buffer.slice(0, this.cursor);
      if (before.includes("\n")) {
        this.moveVertically(-1);
        return;
      }
    }
    if (this.historyIndex === -1) {
      this.historySnapshot = this.buffer;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return;
    }
    this.buffer = this.history[this.historyIndex]!;
    this.cursor = this.buffer.length;
    this.multiLineHint = this.buffer.includes("\n");
    this.redraw();
  }

  private historyDown(): void {
    if (this.historyIndex === -1) {
      if (this.buffer.includes("\n")) this.moveVertically(1);
      return;
    }
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.buffer = this.history[this.historyIndex]!;
      this.cursor = this.buffer.length;
    } else {
      this.historyIndex = -1;
      this.buffer = this.historySnapshot;
      this.cursor = this.buffer.length;
    }
    this.multiLineHint = this.buffer.includes("\n");
    this.redraw();
  }

  private moveVertically(dir: -1 | 1): void {
    const lines = this.buffer.split("\n");
    let off = 0;
    let row = 0;
    let col = 0;
    for (let r = 0; r < lines.length; r++) {
      const len = lines[r]!.length;
      if (this.cursor <= off + len) {
        row = r;
        col = this.cursor - off;
        break;
      }
      off += len + 1;
      if (r === lines.length - 1) {
        row = r;
        col = len;
      }
    }
    const newRow = row + dir;
    if (newRow < 0 || newRow >= lines.length) return;
    const visCol = columnsBefore(lines[row]!, col);
    const target = lines[newRow]!;
    const newCol = indexFromColumns(target, visCol);
    let newOff = 0;
    for (let r = 0; r < newRow; r++) newOff += lines[r]!.length + 1;
    this.cursor = newOff + newCol;
    this.redraw();
  }

  private doComplete(): void {
    if (!this.completer) return;
    try {
      const [hits] = this.completer(this.buffer);
      if (!hits.length) return;
      if (hits.length === 1) {
        this.buffer = hits[0]!;
        this.cursor = this.buffer.length;
        this.redraw();
        return;
      }
      let shared = hits[0]!;
      for (const h of hits) {
        let i = 0;
        while (i < shared.length && i < h.length && shared[i] === h[i]) i++;
        shared = shared.slice(0, i);
      }
      if (shared.length > this.buffer.length) {
        this.buffer = shared;
        this.cursor = this.buffer.length;
      }
      // Completions dump below the block — reset paint tracking
      this.goToBlockEnd();
      this.output.write(
        "\n" +
          chalk.dim(formatSlashHitMenu(hits, { cols: this.cols() })) +
          "\n",
      );
      this.painted = false;
      this.cursorViewRow = 0;
      this.redraw();
    } catch {
      /* ignore */
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────

  private cols(): number {
    return Math.max(8, this.output.columns || 80);
  }

  private goToBlockTop(): void {
    if (!this.painted) return;
    if (this.cursorViewRow > 0) {
      this.output.write(`\x1b[${this.cursorViewRow}A`);
    }
    this.output.write("\r");
  }

  private goToBlockEnd(): void {
    if (!this.painted) return;
    const layout = this.computeLayout();
    const down = layout.totalViewRows - 1 - this.cursorViewRow;
    if (down > 0) this.output.write(`\x1b[${down}B`);
    this.output.write("\r");
  }

  private computeLayout() {
    const showFooter =
      Boolean(this.search) ||
      this.multiLineHint ||
      countLines(this.buffer) > 1;
    return layoutEditor({
      buffer: this.buffer,
      cursor: this.cursor,
      promptPlain: stripAnsi(this.activePrompt()),
      cols: this.cols(),
      showFooter,
    });
  }

  private redraw(): void {
    if (this.closed || this.suspended) return;

    const cols = this.cols();
    const layout = this.computeLayout();
    const showFooter =
      Boolean(this.search) ||
      this.multiLineHint ||
      countLines(this.buffer) > 1;
    const promptPaint = this.activePrompt();

    // 1. Cursor → top of previous block, EL each row (never CSI J — that
    //    erases the DECSTBM dock).
    this.goToBlockTop();
    if (this.painted && this.lastTotalViewRows > 0) {
      this.output.write(eraseEditorBlockSeq(this.lastTotalViewRows));
    }

    // 2. Paint logical lines (terminal handles soft-wrap)
    const contStyled = chalk.dim(
      layout.logical[0]
        ? // rebuild cont prefix with same plain width
          (() => {
            const promptW = displayWidth(stripAnsi(promptPaint));
            const contLabel = "… ";
            const contPad = Math.max(0, promptW - displayWidth(contLabel));
            return " ".repeat(contPad) + contLabel;
          })()
        : "… ",
    );

    for (let i = 0; i < layout.logical.length; i++) {
      if (i > 0) this.output.write("\n");
      const L = layout.logical[i]!;
      const prefix = i === 0 ? promptPaint : contStyled;
      // Clear line then write — avoids leftover glyphs when shortening
      this.output.write("\r\x1b[2K" + prefix + L.text);
    }

    if (showFooter) {
      const footer = this.search
        ? HISTORY_SEARCH_FOOTER
        : (() => {
            const lines = countLines(this.buffer);
            const chars = this.buffer.length;
            return `  ${lines} line${lines === 1 ? "" : "s"} · ${chars} chars · ↵ send · ^J newline · ^U clear · ←→ edit`;
          })();
      this.output.write("\n\r\x1b[2K" + chalk.dim(footer));
    }

    // 3. After paint, physical cursor is at end of last painted row.
    //    Move to (cursorViewRow, cursorViewCol).
    const lastRow = layout.totalViewRows - 1;
    const up = lastRow - layout.cursorViewRow;
    if (up > 0) {
      this.output.write(`\x1b[${up}A`);
    }
    // CHA: absolute column (1-based)
    const col1 = Math.min(cols, Math.max(1, layout.cursorViewCol + 1));
    this.output.write(`\r\x1b[${col1}G`);

    this.cursorViewRow = layout.cursorViewRow;
    this.lastTotalViewRows = layout.totalViewRows;
    this.painted = true;
    try {
      this.onPaint?.();
    } catch {
      /* dock restore must not break input */
    }
  }
}
