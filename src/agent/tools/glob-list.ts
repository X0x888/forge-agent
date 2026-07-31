import fsp from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath } from "./path-util.js";
import { pathNotFoundHint } from "./path-hints.js";
import { boundToolOutput } from "./truncate.js";

export async function toolGlob(
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
      output: `glob error: pattern must be a string (got ${kind}).`,
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
      output: `glob error: path must be a string (got ${kind}).`,
      isError: true,
    };
  }
  const pattern = String(args.pattern || "").trim();
  if (!pattern) {
    return {
      output:
        "glob error: pattern is required (non-empty string).\n" +
        'Example: { "pattern": "**/*.{ts,tsx}", "path": "src" }\n' +
        "Whitespace-only patterns fail closed. Prefer a concrete glob; omit path for workspace root.",
      isError: true,
    };
  }
  // Optional path: omitted → workspace; explicit whitespace fails closed.
  if (args.path != null && !String(args.path).trim()) {
    return {
      output:
        "glob error: path is required (non-empty string). Omit path for workspace root.\n" +
        'Example: { "pattern": "**/*.ts", "path": "src" }\n' +
        "Use a workspace-relative path, or omit path entirely for the workspace root.",
      isError: true,
    };
  }
  const cwd = args.path
    ? resolvePath(ctx.workspace, String(args.path).trim())
    : ctx.workspace;

  // Distinguish missing search root from a real empty match (agent UX).
  try {
    const st = await fsp.stat(cwd);
    if (!st.isDirectory()) {
      return {
        output: `glob path is not a directory: ${args.path || "."}`,
        isError: true,
      };
    }
  } catch {
    const hint = await pathNotFoundHint(cwd, ctx.workspace);
    const label = args.path ? String(args.path) : ".";
    return {
      output: `Directory not found for glob: ${label}\n${hint}`,
      isError: true,
    };
  }

  try {
    const files = await glob(pattern, {
      cwd,
      nodir: true,
      absolute: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    });
    files.sort();
    const rootLabel = args.path ? String(args.path) : ".";
    const body = files.length
      ? files.slice(0, 200).join("\n")
      : (
          `No files matched (pattern=${JSON.stringify(pattern)}, path=${rootLabel}).\n` +
          `Tips: broaden the glob, check the search root, or try list_dir / grep.`
        );
    const managed = await boundToolOutput(body, { maxLines: 250 });
    return { output: managed.text };
  } catch (err) {
    return {
      output: `glob failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}

export async function toolListDir(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (args.path != null && typeof args.path !== "string") {
    const kind =
      args.path === null
        ? "null"
        : Array.isArray(args.path)
          ? "array"
          : typeof args.path;
    return {
      output: `list_dir error: path must be a string (got ${kind}).`,
      isError: true,
    };
  }
  // Omitted path → "."; explicit whitespace-only is invalid (parity with read/write).
  if (args.path != null && !String(args.path).trim()) {
    return {
      output:
        "list_dir error: path is required (non-empty string). Omit path for workspace root.\n" +
        'Example: { "path": "src" }\n' +
        "Use a workspace-relative path, or omit path entirely for the workspace root.",
      isError: true,
    };
  }
  const rel = args.path != null ? String(args.path).trim() : ".";
  const dir = resolvePath(ctx.workspace, rel);
  // Distinguish missing path vs file-not-dir (parity with glob) so the model
  // does not thrash on "not found" when it passed a file path by mistake.
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) {
      return {
        output:
          `list_dir path is not a directory: ${rel}
` +
          `Tips: pass a directory path, or use read_file/grep on this file path.`,
        isError: true,
      };
    }
  } catch {
    const hint = await pathNotFoundHint(dir, ctx.workspace);
    return { output: `Directory not found: ${rel}\n${hint}`, isError: true };
  }
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return {
      output: `list_dir failed: ${(err as Error).message}`,
      isError: true,
    };
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const lines = entries
    .filter((e) => e.name !== ".git" && e.name !== "node_modules")
    .slice(0, 500)
    .map((e) => {
      const kind = e.isDirectory()
        ? "dir "
        : e.isSymbolicLink()
          ? "link"
          : "file";
      return `${kind}  ${e.name}${e.isDirectory() ? "/" : ""}`;
    });
  const label = path.relative(ctx.workspace, dir) || ".";
  const body = lines.length
    ? `${label}\n${lines.join("\n")}`
    : `Directory is empty: ${label}\nTips: check the path, or use glob/grep from a parent directory.`;
  return { output: body };
}
