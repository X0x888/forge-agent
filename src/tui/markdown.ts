/**
 * Incremental markdown renderer for streamed assistant output.
 *
 * Buffers until newline and styles one complete line at a time, so the final
 * output is byte-identical no matter where the token stream is split
 * (chunk-boundary invariance): every styling decision depends only on the
 * current line plus the fenced-code state carried between lines.
 *
 * Non-TTY (color:false) is a plain passthrough — input is echoed unchanged.
 * Dependency-free (chalk only).
 */
import chalk, { Chalk } from "chalk";

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

  constructor(private readonly c: InstanceType<typeof Chalk>) {}

  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      out += this.styleLine(line) + "\n";
    }
    return out;
  }

  end(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest ? this.styleLine(rest) : "";
  }

  private styleLine(line: string): string {
    const c = this.c;
    // Fenced code blocks — fence marker toggles state, content gets a gutter.
    if (/^ {0,3}(```|~~~)/.test(line)) {
      this.inFence = !this.inFence;
      return c.dim(line);
    }
    if (this.inFence) {
      return line ? `${c.dim("│ ")}${line}` : c.dim("│");
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
    // GFM tables — line-local so chunk-boundary invariance holds.
    const table = styleTableLine(line, c, (cell) => this.inline(cell));
    if (table !== null) return table;
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

function styleTableLine(
  line: string,
  c: InstanceType<typeof Chalk>,
  styleCell: (cell: string) => string,
): string | null {
  if (!isTableRow(line)) return null;
  if (isTableSeparator(line)) {
    return c.dim("─".repeat(Math.max(24, Math.min(line.trim().length, 72))));
  }
  const leading = line.match(/^\s*/)?.[0] ?? "";
  const t = line.trim();
  const starts = t.startsWith("|");
  const ends = t.endsWith("|");
  const raw = t.split("|");
  const cells: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (i === 0 && raw[i]!.trim() === "" && starts) continue;
    if (i === raw.length - 1 && raw[i]!.trim() === "" && ends) continue;
    cells.push(raw[i]!);
  }
  const pipe = c.dim("│");
  const body = cells
    .map((cell) => ` ${styleCell(cell.trim())} `)
    .join(pipe);
  return `${leading}${starts ? `${pipe} ` : ""}${body}${ends ? ` ${pipe}` : ""}`.replace(
    /  +/g,
    " ",
  );
}
