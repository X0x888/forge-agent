/**
 * Line-local syntax color for markdown fenced code.
 *
 * Every decision is a function of (line, lang, inBlockComment). The renderer
 * carries those between lines — never between stream chunks — so the
 * markdown chunk-boundary invariant still holds.
 */
import type { Chalk } from "chalk";

export type HighlightState = { inBlockComment: boolean };

export type LangFamily = "js" | "py" | "sh" | "json" | "diff" | "generic";

const JS_KW = new Set([
  "abstract",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "of",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const PY_KW = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

const SH_KW = new Set([
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "export",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "local",
  "return",
  "select",
  "then",
  "until",
  "while",
]);

const JSON_KW = new Set(["true", "false", "null"]);

export function langFamily(lang: string): LangFamily {
  const l = lang.trim().toLowerCase();
  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "javascript",
      "typescript",
      "mts",
      "cts",
      "mjs",
      "cjs",
    ].includes(l)
  ) {
    return "js";
  }
  if (l === "py" || l === "python") return "py";
  if (l === "sh" || l === "bash" || l === "zsh" || l === "shell") return "sh";
  if (l === "json" || l === "jsonc") return "json";
  if (l === "diff" || l === "patch") return "diff";
  return "generic";
}

export function highlightFenceLine(
  line: string,
  lang: string,
  c: InstanceType<typeof Chalk>,
  state: HighlightState = { inBlockComment: false },
): { text: string; state: HighlightState } {
  const family = langFamily(lang);
  if (family === "diff") {
    return { text: highlightDiffLine(line, c), state: { inBlockComment: false } };
  }
  return highlightCode(line, family, c, state);
}

function highlightDiffLine(line: string, c: InstanceType<typeof Chalk>): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return c.green(line);
  if (line.startsWith("-") && !line.startsWith("---")) return c.red(line);
  if (line.startsWith("@@")) return c.cyan(line);
  return c.dim(line);
}

function keywordsFor(family: LangFamily): Set<string> {
  if (family === "js") return JS_KW;
  if (family === "py") return PY_KW;
  if (family === "sh") return SH_KW;
  if (family === "json") return JSON_KW;
  return new Set();
}

function hashComments(family: LangFamily): boolean {
  return family === "py" || family === "sh" || family === "generic";
}

function slashComments(family: LangFamily): boolean {
  return family === "js" || family === "json" || family === "generic";
}

function highlightCode(
  line: string,
  family: LangFamily,
  c: InstanceType<typeof Chalk>,
  state: HighlightState,
): { text: string; state: HighlightState } {
  const kw = keywordsFor(family);
  let i = 0;
  let out = "";
  let inBlock = state.inBlockComment;

  const paint = (token: string, style: (s: string) => string): void => {
    if (token) out += style(token);
  };

  while (i < line.length) {
    if (inBlock) {
      const end = line.indexOf("*/", i);
      if (end < 0) {
        paint(line.slice(i), c.dim.italic);
        i = line.length;
        break;
      }
      paint(line.slice(i, end + 2), c.dim.italic);
      i = end + 2;
      inBlock = false;
      continue;
    }

    const ch = line[i]!;
    const next = line[i + 1] ?? "";

    if (slashComments(family) && ch === "/" && next === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) {
        paint(line.slice(i), c.dim.italic);
        inBlock = true;
        break;
      }
      paint(line.slice(i, end + 2), c.dim.italic);
      i = end + 2;
      continue;
    }
    if (slashComments(family) && ch === "/" && next === "/") {
      paint(line.slice(i), c.dim.italic);
      break;
    }
    if (hashComments(family) && ch === "#") {
      // Python: `#` always comments. Shell/generic: only after start/whitespace
      // so CSS hex (`#fff`) and `owner#repo` stay literal.
      const hashOk =
        family === "py" || i === 0 || /\s/.test(line[i - 1] ?? "");
      if (hashOk) {
        paint(line.slice(i), c.dim.italic);
        break;
      }
    }
    if (ch === '"' || ch === "'" || (ch === "`" && family === "js")) {
      let j = i + 1;
      while (j < line.length) {
        const qch = line[j]!;
        if (qch === "\\" && ch !== "'") {
          j += 2;
          continue;
        }
        if (qch === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      paint(line.slice(i, j), c.green);
      i = j;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < line.length && /[\d_.]/.test(line[j]!)) j += 1;
      paint(line.slice(i, j), c.yellow);
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j]!)) j += 1;
      const ident = line.slice(i, j);
      if (kw.has(ident)) paint(ident, c.magenta);
      else out += ident;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }

  return { text: out, state: { inBlockComment: inBlock } };
}
