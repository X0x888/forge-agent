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
  const pattern = String(args.pattern || "");
  if (!pattern) return { output: "pattern is required", isError: true };
  const cwd = args.path ? resolvePath(ctx.workspace, String(args.path)) : ctx.workspace;
  const files = await glob(pattern, {
    cwd,
    nodir: true,
    absolute: false,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  });
  files.sort();
  const body = files.length ? files.slice(0, 200).join("\n") : "No files matched";
  const managed = await boundToolOutput(body, { maxLines: 250 });
  return { output: managed.text };
}

export async function toolListDir(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const rel = String(args.path || ".");
  const dir = resolvePath(ctx.workspace, rel);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    const hint = await pathNotFoundHint(dir, ctx.workspace);
    return { output: `Directory not found: ${rel}\n${hint}`, isError: true };
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const lines = entries
    .filter((e) => e.name !== ".git" && e.name !== "node_modules")
    .slice(0, 500)
    .map((e) => {
      const kind = e.isDirectory() ? "dir " : e.isSymbolicLink() ? "link" : "file";
      return `${kind}  ${e.name}${e.isDirectory() ? "/" : ""}`;
    });
  const body = lines.length
    ? `${path.relative(ctx.workspace, dir) || "."}\n${lines.join("\n")}`
    : "(empty directory)";
  return { output: body };
}
