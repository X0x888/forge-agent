import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, displayRelPath } from "./path-util.js";
import { pathNotFoundHint } from "./path-hints.js";
import { boundToolOutput } from "./truncate.js";
import { isTruthy } from "../../util/bool.js";
import { numberFieldError } from "./arg-types.js";
import { killProcessTree } from "../../util/process-tree.js";

// Resolved once per process — PATH scanning is a dozen+ sync FS calls.
let rgPathCache: string | null | undefined;

// Parity with runRg's 4MB OUTPUT_CAP: the JS fallback must not read huge
// files (logs, dumps) whole into memory on machines without rg.
const JS_FALLBACK_MAX_FILE_BYTES = 4 * 1024 * 1024;

function findRg(): string | null {
  if (rgPathCache !== undefined) return rgPathCache;
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const p of paths) {
    for (const name of process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"]) {
      const full = path.join(p, name);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        rgPathCache = full;
        return full;
      } catch {
        /* */
      }
    }
  }
  rgPathCache = null;
  return null;
}

/**
 * head_limit: default 50; 0 = unlimited.
 * Explicit invalid/negative fails closed (null) so models see the mistake.
 */
function parseGrepHeadLimit(raw: unknown): number | null {
  if (raw == null || String(raw).trim() === "") return 50;
  const key = String(raw).trim().toLowerCase();
  // Parity with forge logs -n all|max|full → unlimited (0).
  if (key === "all" || key === "max" || key === "full" || key === "unlimited") {
    return 0;
  }
  if (!/^\d+$/.test(key)) return null;
  const n = Number(key);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}


async function assertSearchRoot(
  searchPath: string,
  label: string,
  workspace: string,
): Promise<ToolResult | null> {
  try {
    const st = await fsp.stat(searchPath);
    if (!st.isDirectory() && !st.isFile()) {
      return { output: `grep path is not a file or directory: ${label}`, isError: true };
    }
    return null;
  } catch {
    const hint = await pathNotFoundHint(searchPath, workspace);
    return {
      output: `Path not found for grep: ${label}\n${hint}`,
      isError: true,
    };
  }
}

function runRg(
  rg: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null; aborted?: boolean }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ stdout: "", stderr: "Aborted", code: 1, aborted: true });
      return;
    }
    const child = spawn(rg, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // head_limit:0 (unlimited) with a broad pattern must not stream the whole
    // match set into one JS string — cap and kill instead.
    const OUTPUT_CAP = 4 * 1024 * 1024;
    let outputCapped = false;
    const finish = (result: {
      stdout: string;
      stderr: string;
      code: number | null;
      aborted?: boolean;
    }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const killChild = () => {
      killProcessTree(child, "SIGTERM");
      setTimeout(() => {
        killProcessTree(child, "SIGKILL");
      }, 500).unref?.();
    };
    const onAbort = () => {
      killChild();
      finish({ stdout, stderr: "Aborted", code: 1, aborted: true });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d) => {
      if (outputCapped) return;
      stdout += d.toString();
      if (stdout.length > OUTPUT_CAP) {
        stdout = stdout.slice(0, OUTPUT_CAP);
        outputCapped = true;
        killChild();
      }
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString();
    });
    child.on("error", (err) => {
      finish({ stdout, stderr: err.message, code: 1 });
    });
    child.on("close", (code) => {
      if (outputCapped) {
        finish({
          stdout,
          stderr:
            (stderr ? stderr + "\n" : "") +
            `grep output exceeded ${OUTPUT_CAP} bytes — truncated; narrow the pattern/path or set a head_limit`,
          code: code ?? 1,
        });
        return;
      }
      finish({ stdout, stderr, code });
    });
  });
}

/** Identifier-like (CamelCase / snake / dotted) — LSP is a better next step than another regex. */
export function looksLikeSymbolPattern(pattern: string): boolean {
  const p = pattern.trim();
  if (!p || p.length > 80) return false;
  if (/[\\[\](){}|?*+]/.test(p)) return false;
  return /^[A-Za-z_][\w.]{1,78}$/.test(p);
}

function formatNoGrepMatches(opts: {
  pattern: string;
  pathLabel: string;
  glob?: string;
}): string {
  const bits = [`pattern=${JSON.stringify(opts.pattern)}`, `path=${opts.pathLabel}`];
  if (opts.glob) bits.push(`glob=${JSON.stringify(opts.glob)}`);
  const lspHint = looksLikeSymbolPattern(opts.pattern)
    ? ` For a known symbol, prefer lsp { action: "workspace_symbols"|"references"|"definition", query: ${JSON.stringify(opts.pattern)} }.`
    : "";
  return (
    `No matches found (${bits.join(", ")}).\n` +
    `Tips: broaden the pattern, drop path/glob filters, try case_insensitive, or search from workspace root.` +
    lspHint
  );
}


async function toolGrepJs(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (args.pattern != null && typeof args.pattern !== "string") {
    const kind =
      args.pattern === null
        ? "null"
        : Array.isArray(args.pattern)
          ? "array"
          : typeof args.pattern;
    return {
      output: `grep error: pattern must be a string (got ${kind}).`,
      isError: true,
    };
  }
  if (args.path != null && typeof args.path !== "string") {
    const kind =
      args.path === null
        ? "null"
        : Array.isArray(args.path)
          ? "array"
          : typeof args.path;
    return {
      output: `grep error: path must be a string (got ${kind}).`,
      isError: true,
    };
  }
  if (ctx.signal?.aborted) return { output: "Aborted", isError: true };
  if (args.glob != null && typeof args.glob !== "string") {
    const kind =
      args.glob === null
        ? "null"
        : Array.isArray(args.glob)
          ? "array"
          : typeof args.glob;
    return {
      output: `grep error: glob must be a string (got ${kind}).`,
      isError: true,
    };
  }
  const pattern = String(args.pattern || "");
  if (!pattern.trim()) {
    return {
      output:
        "grep error: pattern is required (non-empty string).\n" +
        'Example: { "pattern": "TODO|FIXME", "path": "src", "head_limit": 50 }\n' +
        "Whitespace-only patterns fail closed. Prefer a concrete symbol/string; omit path to search the whole workspace.",
      isError: true,
    };
  }
  if (args.path != null && !String(args.path).trim()) {
    return {
      output:
        "grep error: path is required (non-empty string). Omit path to search the workspace.\n" +
        'Example: { "pattern": "TODO", "path": "src" }\n' +
        "Use a workspace-relative path, or omit path entirely to search the whole workspace.",
      isError: true,
    };
  }
  const pathArg = args.path != null ? String(args.path).trim() : "";
  const searchPath = pathArg
    ? resolvePath(ctx.workspace, pathArg)
    : ctx.workspace;
  const pathLabel = pathArg || ".";
  const badRoot = await assertSearchRoot(searchPath, pathLabel, ctx.workspace);
  if (badRoot) return badRoot;
  const globPat = args.glob ? String(args.glob) : "**/*";
  // head_limit: 0 = unlimited (not coerced to 50 via Number(x)||default)
  const headLimit = parseGrepHeadLimit(args.head_limit);
  if (headLimit === null) {
    return {
      output:
        numberFieldError(
          "grep",
          "head_limit",
          args.head_limit,
          "Pass a non-negative integer or all|max|full (0/all = unlimited, default 50).",
        ),
      isError: true,
    };
  }
  const flags = isTruthy(args.case_insensitive) ? "i" : "";
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      output:
        `Invalid regex: ${pattern}
` +
        `  ${detail}
` +
        `Hint: escape special chars (., *, +, ?, (, ), [, ], {, }, |, ^, $) or pass a plain substring.`,
      isError: true,
    };
  }

  // Single-file path: search that file only (glob cwd=file is invalid).
  let files: string[];
  const st = await fsp.stat(searchPath);
  if (st.isFile()) {
    files = [searchPath];
  } else {
    files = await glob(globPat, {
      cwd: searchPath,
      nodir: true,
      absolute: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
      dot: false,
    });
  }

  const matches: string[] = [];
  let skippedOversized = 0;
  for (const file of files) {
    if (ctx.signal?.aborted) return { output: "Aborted", isError: true };
    if (headLimit > 0 && matches.length >= headLimit) break;
    let text: string;
    try {
      const fst = await fsp.stat(file);
      if (fst.size > JS_FALLBACK_MAX_FILE_BYTES) {
        skippedOversized += 1;
        continue;
      }
      text = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        const rel = displayRelPath(ctx.workspace, file);
        matches.push(`${rel}:${i + 1}:${lines[i]}`);
        if (headLimit > 0 && matches.length >= headLimit) break;
      }
    }
  }
  const body = matches.length
    ? `[grep:js-fallback] ${matches.join("\n")}`
    : formatNoGrepMatches({
        pattern: String(args.pattern || ""),
        pathLabel,
        glob: args.glob != null ? String(args.glob) : undefined,
      });
  const skippedNote =
    skippedOversized > 0
      ? `\n[grep:js-fallback] skipped ${skippedOversized} file(s) over 4MB (size guard; install rg to search them)`
      : "";
  const managed = await boundToolOutput(body + skippedNote);
  return { output: managed.text };
}

export async function toolGrep(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (args.pattern != null && typeof args.pattern !== "string") {
    const kind =
      args.pattern === null
        ? "null"
        : Array.isArray(args.pattern)
          ? "array"
          : typeof args.pattern;
    return {
      output: `grep error: pattern must be a string (got ${kind}).`,
      isError: true,
    };
  }
  if (args.path != null && typeof args.path !== "string") {
    const kind =
      args.path === null
        ? "null"
        : Array.isArray(args.path)
          ? "array"
          : typeof args.path;
    return {
      output: `grep error: path must be a string (got ${kind}).`,
      isError: true,
    };
  }
  if (args.glob != null && typeof args.glob !== "string") {
    const kind =
      args.glob === null
        ? "null"
        : Array.isArray(args.glob)
          ? "array"
          : typeof args.glob;
    return {
      output: `grep error: glob must be a string (got ${kind}).`,
      isError: true,
    };
  }
  const pattern = String(args.pattern || "");
  // Whitespace-only patterns are almost always model mistakes (not a useful search).
  if (!pattern.trim()) {
    return {
      output:
        "grep error: pattern is required (non-empty string).\n" +
        'Example: { "pattern": "TODO|FIXME", "path": "src", "head_limit": 50 }\n' +
        "Whitespace-only patterns fail closed. Prefer a concrete symbol/string; omit path to search the whole workspace.",
      isError: true,
    };
  }
  if (ctx.signal?.aborted) return { output: "Aborted", isError: true };
  // Optional path: omitted → workspace; explicit whitespace fails closed.
  if (args.path != null && !String(args.path).trim()) {
    return {
      output:
        "grep error: path is required (non-empty string). Omit path to search the workspace.\n" +
        'Example: { "pattern": "TODO", "path": "src" }',
      isError: true,
    };
  }

  const rg = findRg();
  if (!rg) {
    return toolGrepJs(args, ctx);
  }

  const pathArg = args.path != null ? String(args.path).trim() : "";
  const searchPath = pathArg
    ? resolvePath(ctx.workspace, pathArg)
    : ctx.workspace;
  const pathLabel = pathArg || ".";
  const badRoot = await assertSearchRoot(searchPath, pathLabel, ctx.workspace);
  if (badRoot) return badRoot;
  // head_limit: 0 = unlimited (omit --max-count; rg treats 0 as no matches)
  const headLimit = parseGrepHeadLimit(args.head_limit);
  if (headLimit === null) {
    return {
      output:
        numberFieldError(
          "grep",
          "head_limit",
          args.head_limit,
          "Pass a non-negative integer or all|max|full (0/all = unlimited, default 50).",
        ),
      isError: true,
    };
  }
  const rgArgs = ["--line-number", "--no-heading", "--color", "never"];
  if (headLimit > 0) {
    rgArgs.push("--max-count", String(headLimit));
  }
  if (args.case_insensitive) rgArgs.push("-i");
  if (args.glob) {
    rgArgs.push("--glob", String(args.glob));
  }
  rgArgs.push("--glob", "!**/node_modules/**", "--glob", "!**/.git/**", "--glob", "!**/dist/**");
  rgArgs.push("--", pattern, searchPath);

  const result = await runRg(rg, rgArgs, ctx.workspace, ctx.signal);
  if (result.aborted || ctx.signal?.aborted) {
    return { output: "Aborted", isError: true };
  }
  // rg exit 1 = no matches
  if (result.code === 1 || (!result.stdout.trim() && !result.stderr.trim())) {
    return {
      output: formatNoGrepMatches({
        pattern,
        pathLabel,
        glob: args.glob != null ? String(args.glob) : undefined,
      }),
    };
  }
  if (result.code !== 0 && result.code !== 1) {
    // fall back if rg failed for other reasons
    if (result.stderr) {
      const fb = await toolGrepJs(args, ctx);
      return {
        output: `[rg error: ${result.stderr.trim()}]\n${fb.output}`,
        isError: fb.isError,
      };
    }
  }

  // Rewrite absolute paths to workspace-relative when possible
  let outLines = result.stdout.split("\n").filter(Boolean);
  if (headLimit > 0) outLines = outLines.slice(0, headLimit);
  const lines = outLines
    .map((line) => {
      if (line.startsWith(ctx.workspace + path.sep)) {
        return displayRelPath(ctx.workspace, line.split(":")[0]) + line.slice(line.indexOf(":"));
      }
      // searchPath may be absolute prefix
      try {
        const colon = line.indexOf(":");
        if (colon > 0) {
          const fp = line.slice(0, colon);
          if (path.isAbsolute(fp)) {
            return displayRelPath(ctx.workspace, fp) + line.slice(colon);
          }
        }
      } catch {
        /* */
      }
      return line;
    });

  const managed = await boundToolOutput(
    lines.join("\n") ||
      formatNoGrepMatches({
        pattern,
        pathLabel,
        glob: args.glob != null ? String(args.glob) : undefined,
      }),
  );
  return { output: managed.text };
}
