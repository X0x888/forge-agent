import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, resolveReadablePath } from "./path-util.js";
import { pathNotFoundHint } from "./path-hints.js";
import { boundToolOutput, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.js";

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
/** Soft size hint — still stream via offset/limit; avoid loading multi‑GB blobs blindly. */
const LARGE_FILE_BYTES = 2 * 1024 * 1024;

function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function toolRead(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const raw = String(args.path || "");
  if (!raw) return { output: "path is required", isError: true };

  const filePath = await resolveReadablePath(ctx.workspace, raw);

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    const hint = await pathNotFoundHint(resolvePath(ctx.workspace, raw), ctx.workspace);
    return {
      output: `File not found: ${raw}\n${hint}`,
      isError: true,
    };
  }

  if (stat.isDirectory()) {
    const entries = await fsp.readdir(filePath, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const lines = entries
      .filter((e) => e.name !== ".git" && e.name !== "node_modules")
      .slice(0, 500)
      .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`);
    const rel = path.relative(ctx.workspace, filePath) || ".";
    return {
      output: `Directory: ${rel}\n${lines.length ? lines.join("\n") : "(empty)"}`,
    };
  }

  const buf = await fsp.readFile(filePath);
  if (isProbablyBinary(buf)) {
    return {
      output: `Binary file (${stat.size} bytes): ${path.relative(ctx.workspace, filePath) || filePath}. Cannot display as text.`,
      isError: true,
    };
  }

  const content = buf.toString("utf8");
  const lines = content.split("\n");
  const offset = Math.max(1, Number(args.offset) || 1);
  // limit: 0 = all remaining lines from offset (not coerced to DEFAULT via ||)
  let limit = DEFAULT_READ_LIMIT;
  if (args.limit != null && String(args.limit).trim() !== "") {
    const n = Number(args.limit);
    if (Number.isFinite(n) && n >= 0) {
      limit = n === 0 ? Math.max(0, lines.length - (offset - 1)) : Math.floor(n);
    }
  }
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice
    .map((l, i) => {
      const line =
        l.length > MAX_LINE_LENGTH
          ? l.slice(0, MAX_LINE_LENGTH) + `... (line truncated to ${MAX_LINE_LENGTH} chars)`
          : l;
      return `${String(offset + i).padStart(6)}|${line}`;
    })
    .join("\n");

  const end = offset + slice.length - 1;
  const more = offset - 1 + slice.length < lines.length;
  const largeHint =
    stat.size >= LARGE_FILE_BYTES
      ? `; ${stat.size} bytes — prefer smaller limit/offset or grep for targeted reads`
      : "";
  const header =
    `File: ${path.relative(ctx.workspace, filePath) || filePath} (${lines.length} lines, showing ${offset}-${end}` +
    (more ? `; use offset=${end + 1} for more` : "") +
    `${largeHint})\n`;

  const body = header + (numbered || "(empty file)");
  const managed = await boundToolOutput(body, {
    maxLines: DEFAULT_MAX_LINES + 5,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  return { output: managed.text };
}
