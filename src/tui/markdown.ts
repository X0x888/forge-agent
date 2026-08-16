/**
 * Incremental markdown renderer for streamed assistant output.
 *
 * Buffers until newline and styles one complete line at a time, so the final
 * output is byte-identical no matter where the token stream is split
 * (chunk-boundary invariance): every styling decision depends only on the
 * current line plus the fenced-code / open-table state carried between lines.
 *
 * GFM tables are held until the block ends (non-table line or end()) so
 * columns can align. The flushed table is still a pure function of the
 * held rows — chunk splits do not change the final bytes.
 *
 * Non-TTY (color:false) is a plain passthrough — input is echoed unchanged.
 * Dependency-free (chalk only).
 */
import chalk, { Chalk } from "chalk";
import { visibleWidth } from "../util/format.js";
import {
  highlightFenceLine,
  type HighlightState,
} from "./syntax.js";

export interface MarkdownRendererOptions {
  /**
   * Styled output on/off. Default: auto — on when stdout is a TTY.
   * Off = byte-identical passthrough.
   */
  color?: boolean;
}

export interface MarkdownRenderer {
  /** Feed a stream chunk; returns styled output ready to write. */
  push(chunk: string): string;
  /** End of stream — flush the buffered partial line (styled). */
  end(): string;
}

export function createMarkdownRenderer(
  opts: MarkdownRendererOptions = {},
): MarkdownRenderer {
  const color = opts.color ?? Boolean(process.stdout.isTTY);
  if (!color) {
    // Plain passthrough — graceful degradation for pipes / CI logs.
    return { push: (chunk) => chunk, end: () => "" };
  }
  return new LineMarkdownRenderer(
    new Chalk({ level: Math.max(chalk.level, 1) as 1 | 2 | 3 }),
  );
}

class LineMarkdownRenderer implements MarkdownRenderer {
  private buffer = "";
  private inFence = false;
  private fenceLang = "";
  private fenceHi: HighlightState = { inBlockComment: false };
  private tableRows: string[] = [];

  constructor(private readonly c: InstanceType<typeof Chalk>) {}

  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      out += this.consumeLine(line, true);
    }
    return out;
  }

  end(): string {
    const rest = this.buffer;
    this.buffer = "";
    if (rest) {
      // Last line with no trailing newline: hold it if it is a table row,
      // then flush without a final extra \n (source had none).
      if (!this.inFence && isTableRow(rest)) {
        this.tableRows.push(rest);
        const table = this.flushTable();
        return table.endsWith("\n") ? table.slice(0, -1) : table;
      }
      return this.consumeLine(rest, false);
    }
    return this.flushTable();
  }

  /**
   * Hold table rows; emit everything else. `eol` adds the trailing newline
   * a completed source line carries (push) vs. a final partial (end).
   */
  private consumeLine(line: string, eol: boolean): string {
    if (!this.inFence && isTableRow(line)) {
      this.tableRows.push(line);
      return "";
    }
    const table = this.flushTable();
    const styled = this.styleLine(line);
    return eol ? `${table}${styled}\n` : `${table}${styled}`;
  }

  private flushTable(): string {
    if (!this.tableRows.length) return "";
    const rows = this.tableRows;
    this.tableRows = [];
    return renderAlignedTable(rows, this.c, (cell) => this.inline(cell));
  }

  private styleLine(line: string): string {
    const c = this.c;
    // Fenced code blocks — fence marker toggles state, content gets a gutter.
    // Opening fence paints the language as a tag (`ts`), not ` ```ts `.
    const fence = /^( {0,3})(```|~~~)\s*([^\s`]*)(.*)$/.exec(line);
    if (fence) {
      const opening = !this.inFence;
      this.inFence = !this.inFence;
      const marker = `${fence[1] ?? ""}${fence[2] ?? "```"}`;
      const lang = (fence[3] ?? "").trim();
      if (opening) {
        this.fenceLang = lang;
        this.fenceHi = { inBlockComment: false };
        if (lang) return `${c.dim(marker)} ${c.cyan(lang)}`;
      } else {
        this.fenceLang = "";
        this.fenceHi = { inBlockComment: false };
      }
      return c.dim(marker);
    }
    if (this.inFence) {
      if (!line) return c.dim("│");
      const painted = highlightFenceLine(line, this.fenceLang, c, this.fenceHi);
      this.fenceHi = painted.state;
      return `${c.dim("│ ")}${painted.text}`;
    }
    // Headings: strip hashes. H1 stands out; H2 is a section; H3+ is quieter.
    const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      const body = this.inline(heading[2] ?? "");
      if (depth === 1) return c.bold.underline(body);
      if (depth === 2) return c.bold(body);
      return c.bold.dim(body);
    }
    // Horizontal rule.
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      return c.dim("─".repeat(24));
    }
    // Blockquote.
    const quote = /^ {0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      return `${c.dim("│")} ${c.dim.italic(quote[1] ?? "")}`;
    }
    // GFM task lists — line-local so chunk-boundary invariance holds.
    // Sibling of /todos glyphs: ○ open · ✓ done. `- [n]` stays a normal list.
    const task = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+\[([ xX])\](?:\s+(.*))?$/.exec(line);
    if (task) {
      const done = task[2] !== " ";
      const mark = done ? c.green("✓") : c.dim("○");
      const body = (task[3] ?? "").trimEnd();
      return body ? `${task[1]}${mark} ${this.inline(body)}` : `${task[1]}${mark}`;
    }
    // Lists: color the bullet / number, style the item text inline.
    const list = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (list) {
      return `${list[1]}${c.cyan(list[2]!)} ${this.inline(list[3] ?? "")}`;
    }
    return this.inline(line);
  }

  /** Inline code, bold, italic, strike, links — within a single line. */
  private inline(text: string): string {
    const c = this.c;
    // Split out `code` spans first so emphasis never touches their contents.
    const parts = text.split(/(`[^`]+`)/g);
    let out = "";
    for (const part of parts) {
      if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
        out += c.dim.yellow(part.slice(1, -1));
      } else {
        out += this.emphasisAndLinks(part);
      }
    }
    return out;
  }

  private emphasisAndLinks(text: string): string {
    const c = this.c;
    let s = text;
    // Bold before italic so ** is consumed first.
    s = s.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => c.bold(inner));
    s = s.replace(/\b__([^_]+)__\b/g, (_m, inner: string) => c.bold(inner));
    s = s.replace(/\*([^*\s][^*]*)\*/g, (_m, inner: string) => c.italic(inner));
    // _word_ only at word boundaries — snake_case stays literal.
    s = s.replace(
      /(^|[^\w])_([^_\s][^_]*)_(?=[^\w]|$)/g,
      (_m, pre: string, inner: string) => `${pre}${c.italic(inner)}`,
    );
    // GFM strikethrough — after emphasis so ~~**x**~~ / **~~x~~** both work.
    s = s.replace(/~~([^~]+)~~/g, (_m, inner: string) => c.strikethrough(inner));
    // Images before links so ![alt](url) is not `!alt (url)`.
    s = s.replace(
      /!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_m, alt: string, url: string) =>
        `${c.dim("image")} ${c.italic((alt || url).trim() || "untitled")}`,
    );
    // [text](url) → text (url)
    s = s.replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_m, label: string, url: string) =>
        `${c.cyan.underline(label)} ${c.dim(`(${url})`)}`,
    );
    // Bare autolinks after markdown links so `(url)` is not restyled.
    s = s.replace(/(?<!\()https?:\/\/[^\s<>"]+/g, (url) => {
      const trimmed = url.replace(/[.,;:!?]+$/, "");
      return `${c.cyan.underline(trimmed)}${url.slice(trimmed.length)}`;
    });
    return s;
  }
}

/** Split a GFM table line into cells, dropping the empty edge slots from `| a |`. */
function tableCells(line: string): string[] {
  const t = line.trim();
  return t.split("|").filter((cell, i, arr) => {
    if (i === 0 && cell.trim() === "") return false;
    if (i === arr.length - 1 && cell.trim() === "") return false;
    return true;
  });
}

/** `| a | b |` — at least two pipes, so `just | one` stays prose. */
function isTableRow(line: string): boolean {
  const t = line.trim();
  if ((t.match(/\|/g) ?? []).length < 2) return false;
  if (/^ {0,3}(```|~~~)/.test(line)) return false;
  return tableCells(line).length >= 2;
}

/** `---` / `:---` / `---:` / `:---:` cells only. */
function isTableSeparator(line: string): boolean {
  if (!isTableRow(line)) return false;
  return tableCells(line).every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function colAlign(cell: string): "left" | "right" | "center" {
  const t = cell.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

function padVisible(
  text: string,
  width: number,
  align: "left" | "right" | "center",
): string {
  const pad = Math.max(0, width - visibleWidth(text));
  if (align === "right") return " ".repeat(pad) + text;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + text + " ".repeat(pad - left);
  }
  return text + " ".repeat(pad);
}

/** Flush a held GFM table as aligned columns. Always ends with `\n`. */
function renderAlignedTable(
  rows: string[],
  c: InstanceType<typeof Chalk>,
  styleCell: (cell: string) => string,
): string {
  const parsed = rows.map((line) => ({
    leading: line.match(/^\s*/)?.[0] ?? "",
    sep: isTableSeparator(line),
    cells: tableCells(line).map((x) => x.trim()),
  }));
  const colCount = Math.max(0, ...parsed.map((r) => r.cells.length));
  const aligns: Array<"left" | "right" | "center"> = Array.from(
    { length: colCount },
    () => "left",
  );
  const sepRow = parsed.find((r) => r.sep);
  if (sepRow) {
    sepRow.cells.forEach((cell, i) => {
      aligns[i] = colAlign(cell);
    });
  }
  const widths = Array.from({ length: colCount }, () => 3);
  for (const r of parsed) {
    if (r.sep) continue;
    r.cells.forEach((cell, i) => {
      widths[i] = Math.max(widths[i]!, cell.length);
    });
  }
  const pipe = c.dim("│");
  const headerIdx = parsed.findIndex((r) => !r.sep);
  const out: string[] = [];
  for (let ri = 0; ri < parsed.length; ri++) {
    const r = parsed[ri]!;
    const bits: string[] = [];
    for (let i = 0; i < colCount; i++) {
      if (r.sep) {
        bits.push(c.dim("─".repeat(widths[i]!)));
      } else {
        const raw = r.cells[i] ?? "";
        let styled = styleCell(raw);
        if (ri === headerIdx) styled = c.bold(styled);
        bits.push(padVisible(styled, widths[i]!, aligns[i]!));
      }
    }
    out.push(`${r.leading}${pipe} ${bits.join(` ${pipe} `)} ${pipe}`);
  }
  return out.join("\n") + "\n";
}
