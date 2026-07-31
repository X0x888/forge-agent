/**
 * Premium REPL prompt editor with true multi-line paste.
 *
 * - Enables terminal bracketed paste (`CSI ?2004 h`) so Ghostty treats pastes as safe
 * - Newlines inside a paste never submit — only an explicit Enter does
 * - Ctrl+J / Alt+Enter / Shift+Enter (Kitty CSI u) insert a newline
 * - Burst fallback when the terminal omits paste brackets
 * - Multi-line history (escaped), Tab completion, mid-run preserve redraw
 */
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import chalk from "chalk";

const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Burst paste fallback window (ms). */
const BURST_MS = 48;
const BURST_MIN_CHARS = 6;

export type CompleterFn = (line: string) => [string[], string];

export interface PromptEditorOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  history?: string[];
  historySize?: number;
  completer?: CompleterFn;
  /** Force classic readline (tests / non-interactive). */
  forceReadline?: boolean;
}

export interface PromptEditor {
  setPrompt(prompt: string): void;
  prompt(preserveCursor?: boolean): void;
  close(): void;
  getLine(): string;
  setLine(text: string): void;
  on(event: "line", listener: (line: string) => void): this;
  on(event: "SIGINT", listener: () => void): this;
  on(event: "close", listener: () => void): this;
  once(event: "line", listener: (line: string) => void): this;
  once(event: "SIGINT", listener: () => void): this;
  once(event: "close", listener: () => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
}

/** Escape newlines for one-line history storage. */
export function encodeHistoryEntry(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Inverse of encodeHistoryEntry; plain historic lines stay unchanged. */
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

export function deleteBackward(
  buffer: string,
  cursor: number,
): { buffer: string; cursor: number } {
  if (cursor <= 0) return { buffer, cursor };
  return {
    buffer: buffer.slice(0, cursor - 1) + buffer.slice(cursor),
    cursor: cursor - 1,
  };
}

export function deleteForward(
  buffer: string,
  cursor: number,
): { buffer: string; cursor: number } {
  if (cursor >= buffer.length) return { buffer, cursor };
  return {
    buffer: buffer.slice(0, cursor) + buffer.slice(cursor + 1),
    cursor,
  };
}

export function deleteWordBackward(
  buffer: string,
  cursor: number,
): { buffer: string; cursor: number } {
  if (cursor <= 0) return { buffer, cursor };
  let i = cursor;
  while (i > 0 && /\s/.test(buffer[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(buffer[i - 1]!)) i--;
  return {
    buffer: buffer.slice(0, i) + buffer.slice(cursor),
    cursor: i,
  };
}

/**
 * Normalize pasted text: unify newlines; drop a single trailing newline so
 * clipboard copies from editors land ready to review (still no auto-submit).
 */
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

export function displayWidth(s: string): number {
  return [...s].length;
}

/**
 * Create the interactive editor. Falls back to Node readline when not a TTY.
 */
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

  const wrap: PromptEditor = {
    setPrompt: (p) => rl.setPrompt(p),
    prompt: (preserve) => rl.prompt(preserve),
    close: () => rl.close(),
    getLine: () => rl.line ?? "",
    setLine: (text) => {
      const anyRl = rl as unknown as { line: string; cursor: number };
      if (typeof anyRl.line === "string") {
        anyRl.line = text;
        anyRl.cursor = text.length;
      }
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
  private pasting = false;
  private pending = ""; // unparsed carry across chunks
  private lastRenderRows = 1;
  private shownPasteHint = false;

  private burstActive = false;
  private burstTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onData: (chunk: Buffer | string) => void;

  constructor(
    opts: PromptEditorOptions,
    input: NodeJS.ReadStream,
    output: NodeJS.WriteStream,
  ) {
    super();
    this.input = input;
    this.output = output;
    this.completer = opts.completer;
    this.historySize = opts.historySize ?? 300;
    this.history = [...(opts.history ?? [])].slice(-this.historySize);

    this.onData = (chunk) => {
      const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.feed(raw);
    };
    if (this.input.isTTY) {
      this.input.setRawMode(true);
    }
    this.input.resume();
    this.input.on("data", this.onData);
    this.output.write(BRACKETED_PASTE_ENABLE);
  }

  setPrompt(prompt: string): void {
    this.promptStr = prompt;
  }

  getLine(): string {
    return this.buffer;
  }

  setLine(text: string): void {
    this.buffer = text;
    this.cursor = text.length;
    this.redraw();
  }

  prompt(_preserveCursor = false): void {
    if (this.closed) return;
    this.redraw();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearBurst();
    try {
      this.output.write(BRACKETED_PASTE_DISABLE);
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

  // ── Feed / parse ─────────────────────────────────────────────────────

  /** Exposed for unit tests via feed path. */
  feedForTest(raw: string): void {
    this.feed(raw);
  }

  private feed(raw: string): void {
    if (this.closed) return;
    this.pending += raw;

    while (this.pending.length > 0) {
      if (this.pasting) {
        const end = this.pending.indexOf(PASTE_END);
        if (end === -1) {
          // Hold a short tail that might be a partial PASTE_END
          if (this.pending.length > 8) {
            const keep = 6;
            const body = this.pending.slice(0, this.pending.length - keep);
            this.pending = this.pending.slice(this.pending.length - keep);
            this.insert(body);
            this.redraw();
          }
          return;
        }
        const body = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + PASTE_END.length);
        if (body) this.insert(body);
        this.endBracketedPaste();
        continue;
      }

      // Bracketed paste start
      const ps = this.pending.indexOf(PASTE_START);
      if (ps === 0) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.pasting = true;
        this.shownPasteHint = false;
        continue;
      }
      if (ps > 0) {
        // process prefix then paste
        const prefix = this.pending.slice(0, ps);
        this.pending = this.pending.slice(ps);
        this.consumeNormal(prefix);
        continue;
      }
      // Partial paste start at end?
      if (isPrefixOf(this.pending, PASTE_START) || isPrefixOf(PASTE_START, this.pending)) {
        if (this.pending.length < PASTE_START.length) return;
      }

      // Unbracketed multi-line burst: whole remaining chunk has newlines and is sizable
      if (
        !this.burstActive &&
        this.pending.length >= BURST_MIN_CHARS &&
        /[\r\n]/.test(this.pending) &&
        !this.pending.startsWith("\x1b")
      ) {
        const text = normalizePaste(this.pending);
        this.pending = "";
        this.beginBurst();
        this.insert(text);
        this.redraw();
        this.scheduleBurstEnd();
        return;
      }

      // Incomplete ESC sequence at end — wait
      const esc = this.pending.indexOf("\x1b");
      if (esc === 0) {
        if (!this.escapeComplete(this.pending)) return;
        const used = this.consumeEscape(this.pending);
        this.pending = this.pending.slice(used);
        continue;
      }
      if (esc > 0) {
        this.consumeNormal(this.pending.slice(0, esc));
        this.pending = this.pending.slice(esc);
        continue;
      }

      // Pure normal text
      this.consumeNormal(this.pending);
      this.pending = "";
    }
  }

  private escapeComplete(s: string): boolean {
    if (s === "\x1b") return false;
    if (s.startsWith("\x1b[")) {
      if (s.length < 3) return false;
      return /[A-Za-z~u]$/.test(s) || s.length > 30;
    }
    // Alt+key: ESC + one byte
    return s.length >= 2;
  }

  /** @returns bytes consumed */
  private consumeEscape(s: string): number {
    if (s.startsWith(PASTE_START)) {
      this.pasting = true;
      this.shownPasteHint = false;
      return PASTE_START.length;
    }
    if (s.startsWith("\x1b[")) {
      const m = s.match(/^\x1b\[([0-9;]*)([A-Za-z~u])/);
      if (!m) {
        // discard one esc
        return 1;
      }
      const full = m[0]!;
      const params = m[1]!;
      const final = m[2]!;
      this.handleCsi(params, final);
      return full.length;
    }
    if (s.length >= 2 && s[0] === "\x1b") {
      const k = s[1]!;
      if (k === "\r" || k === "\n") {
        this.insert("\n");
        this.redraw();
      } else if (k >= " ") {
        this.insert(k);
        this.redraw();
      }
      return 2;
    }
    return 1;
  }

  private handleCsi(params: string, final: string): void {
    const body = params + final;
    if (final === "A") {
      this.historyUp();
      return;
    }
    if (final === "B") {
      this.historyDown();
      return;
    }
    if (final === "C") {
      if (this.cursor < this.buffer.length) this.cursor++;
      this.redraw();
      return;
    }
    if (final === "D") {
      if (this.cursor > 0) this.cursor--;
      this.redraw();
      return;
    }
    if (final === "H" || body === "1~") {
      this.cursor = 0;
      this.redraw();
      return;
    }
    if (final === "F" || body === "4~" || body === "8~") {
      this.cursor = this.buffer.length;
      this.redraw();
      return;
    }
    if (body === "3~") {
      const r = deleteForward(this.buffer, this.cursor);
      this.buffer = r.buffer;
      this.cursor = r.cursor;
      this.redraw();
      return;
    }
    // Kitty: 13;2u Shift+Enter, 13;3u Alt+Enter
    if (final === "u") {
      const parts = params.split(";").map(Number);
      if (parts[0] === 13 && (parts[1] ?? 0) >= 2) {
        this.insert("\n");
        this.redraw();
      }
      return;
    }
    // CSI 27;2;13~ style Shift+Enter
    if (final === "~" && /^27;\d+;13$/.test(params)) {
      this.insert("\n");
      this.redraw();
    }
  }

  private consumeNormal(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      // Ctrl+C
      if (ch === "\x03") {
        if (this.buffer.length > 0) {
          this.buffer = "";
          this.cursor = 0;
          this.historyIndex = -1;
          this.shownPasteHint = false;
          this.output.write("\n");
          this.redraw();
        } else {
          this.emit("SIGINT");
        }
        continue;
      }
      // Ctrl+D
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
      // Ctrl+U
      if (ch === "\x15") {
        this.buffer = "";
        this.cursor = 0;
        this.shownPasteHint = false;
        this.redraw();
        continue;
      }
      // Ctrl+W
      if (ch === "\x17") {
        const r = deleteWordBackward(this.buffer, this.cursor);
        this.buffer = r.buffer;
        this.cursor = r.cursor;
        this.redraw();
        continue;
      }
      // Ctrl+A / E
      if (ch === "\x01") {
        this.cursor = 0;
        this.redraw();
        continue;
      }
      if (ch === "\x05") {
        this.cursor = this.buffer.length;
        this.redraw();
        continue;
      }
      // Tab
      if (ch === "\t") {
        this.doComplete();
        continue;
      }
      // Backspace
      if (ch === "\x7f" || ch === "\b") {
        const r = deleteBackward(this.buffer, this.cursor);
        this.buffer = r.buffer;
        this.cursor = r.cursor;
        this.redraw();
        continue;
      }
      // Enter
      if (ch === "\r") {
        // \r\n → single submit
        if (text[i + 1] === "\n") i++;
        if (this.burstActive) {
          this.insert("\n");
          this.scheduleBurstEnd();
          this.redraw();
          continue;
        }
        this.submit();
        continue;
      }
      // Ctrl+J / \n → newline in draft (never submit outside burst end)
      if (ch === "\n") {
        this.insert("\n");
        this.scheduleBurstEnd();
        this.redraw();
        continue;
      }
      if (ch >= " " || ch === "\t") {
        this.insert(ch);
        this.redraw();
      }
    }
  }

  private endBracketedPaste(): void {
    this.pasting = false;
    // Strip a single trailing newline from insertion end
    if (
      this.cursor === this.buffer.length &&
      this.buffer.endsWith("\n") &&
      !this.buffer.endsWith("\n\n")
    ) {
      this.buffer = this.buffer.slice(0, -1);
      this.cursor = this.buffer.length;
    }
    this.redraw();
    this.maybePasteHint();
  }

  private maybePasteHint(): void {
    if (this.shownPasteHint) return;
    const lines = countLines(this.buffer);
    const chars = this.buffer.length;
    if (lines <= 1 && chars < 80) return;
    this.shownPasteHint = true;
    this.output.write(
      chalk.dim(
        `\n  📋 pasted ${lines} line${lines === 1 ? "" : "s"} · ${chars} chars · review, then ↵ send · ^J newline · ^U clear\n`,
      ),
    );
    this.redraw();
  }

  private beginBurst(): void {
    this.burstActive = true;
  }

  private scheduleBurstEnd(): void {
    this.burstActive = true;
    if (this.burstTimer) clearTimeout(this.burstTimer);
    this.burstTimer = setTimeout(() => {
      this.burstActive = false;
      this.burstTimer = null;
      this.maybePasteHint();
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

  private insert(text: string): void {
    if (!text) return;
    const r = insertText(this.buffer, this.cursor, text);
    this.buffer = r.buffer;
    this.cursor = r.cursor;
    this.historyIndex = -1;
  }

  private submit(): void {
    this.clearBurst();
    const line = this.buffer;
    this.output.write("\n");
    if (line.trim()) this.pushHistory(line);
    this.buffer = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.shownPasteHint = false;
    this.lastRenderRows = 1;
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
    const target = lines[newRow]!;
    const newCol = Math.min(col, target.length);
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
      this.output.write(
        "\n" + hits.map((h) => chalk.dim("  " + h)).join("\n") + "\n",
      );
      this.redraw();
    } catch {
      /* ignore */
    }
  }

  private redraw(): void {
    if (this.closed) return;

    const lines = this.buffer.length ? this.buffer.split("\n") : [""];
    const promptVisible = stripAnsi(this.promptStr);
    const promptW = displayWidth(promptVisible);
    const contLabel = "… ";
    const contPad = Math.max(0, promptW - displayWidth(contLabel));
    const contPrefix = chalk.dim(" ".repeat(contPad) + contLabel);

    const rendered: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      rendered.push((i === 0 ? this.promptStr : contPrefix) + lines[i]);
    }
    if (lines.length > 1) {
      rendered.push(
        chalk.dim(
          " ".repeat(Math.min(promptW, 40)) +
            `  ${lines.length} lines · ↵ send · ^J newline · ^U clear`,
        ),
      );
    }

    // Move to top of previous render block and clear downward
    if (this.lastRenderRows > 1) {
      this.output.write(`\x1b[${this.lastRenderRows - 1}A`);
    }
    this.output.write("\r\x1b[J");

    for (let i = 0; i < rendered.length; i++) {
      if (i > 0) this.output.write("\n");
      this.output.write("\r\x1b[2K" + rendered[i]);
    }
    this.lastRenderRows = rendered.length;

    // Cursor position within content lines (ignore footer)
    const { row, col } = cursorRowCol(this.buffer, this.cursor);
    const contentRows = lines.length;
    const footer = lines.length > 1 ? 1 : 0;
    const rowsFromBottom = contentRows + footer - 1 - row;
    if (rowsFromBottom > 0) {
      this.output.write(`\x1b[${rowsFromBottom}A`);
    }
    const prefixW =
      row === 0 ? promptW : displayWidth(stripAnsi(contPrefix));
    // Move to column (1-based); use CHA then CUD is already handled
    const absCol = prefixW + col + 1;
    this.output.write(`\r\x1b[${Math.max(1, absCol)}G`);
  }
}

function isPrefixOf(a: string, b: string): boolean {
  return b.startsWith(a) || a.startsWith(b);
}
