import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, resolveReadablePath } from "./path-util.js";
import { pathNotFoundHint } from "./path-hints.js";
import { boundToolOutput, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.js";
import { numberFieldError } from "./arg-types.js";

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
  if (args.path != null && typeof args.path !== "string") {
    const kind =
      args.path === null
        ? "null"
        : Array.isArray(args.path)
          ? "array"
          : typeof args.path;
    return {
      output: `read_file error: path must be a string (got ${kind}).`,
      isError: true,
    };
  }
  const raw = String(args.path || "").trim();
  if (!raw) {
    return {
      output:
        "read_file error: path is required (non-empty string).\n" +
        'Example: { "path": "src/cli.ts", "offset": 1, "limit": 80 }',
      isError: true,
    };
  }

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
  // "" and files that are only a trailing feel empty to experts; keep a single
  // "" split as one blank line when content is non-empty ("\n" → 2 lines).
  const lines = content === "" ? [] : content.split("\n");
  // Explicit invalid offset/limit fail closed (was silent default).
  let offset = 1;
  if (args.offset != null && String(args.offset).trim() !== "") {
    const n = Number(args.offset);
    if (!Number.isFinite(n) || n < 1) {
      return {
        output:
          numberFieldError(
            "read_file",
            "offset",
            args.offset,
            "Pass a positive 1-based line number (or omit for 1).",
          ),
        isError: true,
      };
    }
    offset = Math.floor(n);
  }
  // limit: 0 = all remaining lines from offset (not coerced to DEFAULT via ||)
  let limit = DEFAULT_READ_LIMIT;
  if (args.limit != null && String(args.limit).trim() !== "") {
    const n = Number(args.limit);
    if (!Number.isFinite(n) || n < 0) {
      return {
        output:
          numberFieldError(
            "read_file",
            "limit",
            args.limit,
            "Pass a non-negative integer (0 = all remaining from offset).",
          ),
        isError: true,
      };
    }
    limit = n === 0 ? Math.max(0, lines.length - (offset - 1)) : Math.floor(n);
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

  const rel = path.relative(ctx.workspace, filePath) || filePath;
  const largeHint =
    stat.size >= LARGE_FILE_BYTES
      ? `; ${stat.size} bytes — prefer smaller limit/offset or grep for targeted reads`
      : "";

  // Past-EOF / empty-slice: do not claim "showing 100-99" or "(empty file)" for non-empty files.
  if (slice.length === 0) {
    if (lines.length === 0) {
      return {
        output: `File: ${rel} (empty file — 0 lines${largeHint})`,
      };
    }
    return {
      output:
        `File: ${rel} (${lines.length} lines)\n` +
        `Offset ${offset} is past end of file (last line ${lines.length}). ` +
        `Use offset=1 or offset<=${lines.length}${largeHint}.`,
    };
  }

  const end = offset + slice.length - 1;
  const more = offset - 1 + slice.length < lines.length;
  const header =
    `File: ${rel} (${lines.length} lines, showing ${offset}-${end}` +
    (more ? `; use offset=${end + 1} for more` : "") +
    `${largeHint})\n`;

  const body = header + numbered;
  const managed = await boundToolOutput(body, {
    maxLines: DEFAULT_MAX_LINES + 5,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  return { output: managed.text };
}
