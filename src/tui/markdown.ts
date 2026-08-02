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
    // Headings: strip the # markers, bold + underline the text.
    const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      return c.bold.underline(heading[2] ?? "");
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
    // Lists: color the bullet / number, style the item text inline.
    const list = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (list) {
      return `${list[1]}${c.cyan(list[2]!)} ${this.inline(list[3] ?? "")}`;
    }
    return this.inline(line);
  }

  /** Inline code, bold, italic, links — within a single line. */
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
    // [text](url) → text (url)
    s = s.replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_m, label: string, url: string) =>
        `${c.cyan.underline(label)} ${c.dim(`(${url})`)}`,
    );
    return s;
  }
}
