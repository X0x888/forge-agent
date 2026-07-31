import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, assertWritablePath } from "./path-util.js";
import { atomicWriteFile } from "./atomic-write.js";
import { snapshotForWrite } from "../../session/mutations.js";
import {
  formatNoteSuffix,
  maybeFormatAfterWrite,
} from "./format-on-write.js";
import { fileReadGuardEnabled } from "./file-read-state.js";
import { stripReadFileLinePrefixes } from "./edit-match.js";
import { verifyHintSuffix } from "../../util/project-intel.js";

export async function toolWrite(
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
      output: `write_file error: path must be a string (got ${kind}).`,
      isError: true,
    };
  }
  const raw = String(args.path || "").trim();
  if (!raw) {
    return {
      output:
        "write_file error: path is required (non-empty string).\n" +
        'Example: { "path": "src/notes.md", "content": "# hello\n" }\n' +
        "Use a workspace-relative path (not empty). Prefer list_dir/glob first if unsure.",
      isError: true,
    };
  }
  // Schema requires string content. Objects used to become "[object Object]" on disk.
  if (!Object.prototype.hasOwnProperty.call(args, "content")) {
    return {
      output:
        "write_file error: content is required (string). " +
        'Pass content: "" for an empty file, or JSON.stringify for structured data.',
      isError: true,
    };
  }
  if (typeof args.content !== "string") {
    const kind = args.content === null ? "null" : Array.isArray(args.content) ? "array" : typeof args.content;
    return {
      output:
        `write_file error: content must be a string (got ${kind}). ` +
        "Use JSON.stringify for objects/arrays.",
      isError: true,
    };
  }
  try {
    const logical = resolvePath(ctx.workspace, raw);
    const filePath = await assertWritablePath(ctx.workspace, logical);
    // Refuse directory targets early — EISDIR from rename is opaque to models.
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        const rel = path.relative(ctx.workspace, filePath) || filePath;
        return {
          output:
            `write_file failed: ${rel} is a directory. ` +
            `Pass a file path (e.g. ${rel.replace(/\/$/, "")}/filename.ext).`,
          isError: true,
        };
      }
    } catch {
      /* race / permission — fall through to atomic write */
    }
    // Overwriting an existing file requires a prior read (agent loop only).
    // Creates (path missing) are always allowed.
    if (ctx.fileReads && fileReadGuardEnabled()) {
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const rel = path.relative(ctx.workspace, filePath) || filePath;
          const blocked = await ctx.fileReads.checkBeforeMutate(filePath, {
            tool: "write_file",
            rel,
          });
          if (blocked) {
            return { output: blocked, isError: true };
          }
        }
      } catch {
        /* fall through */
      }
    }
    const snap = await snapshotForWrite(filePath);
    const dir = path.dirname(filePath);
    let createdParents = false;
    try {
      await fsp.access(dir);
    } catch {
      createdParents = true;
    }
    // Models sometimes paste read_file output into content — strip N| prefixes.
    const stripped = stripReadFileLinePrefixes(args.content);
    const body = stripped.text;
    await atomicWriteFile(filePath, body, {
      encoding: "utf8",
    });
    try {
      ctx.recordMutation?.({
        path: filePath,
        kind: snap.kind,
        before: snap.before,
        skipped: snap.skipped,
        reason: snap.reason,
      });
    } catch {
      /* journal best-effort */
    }
    ctx.onEdit?.();
    const fmt = maybeFormatAfterWrite(filePath, ctx.workspace);
    // Note AFTER format-on-write so chained edits see the final mtime/size.
    if (ctx.fileReads && fileReadGuardEnabled()) {
      await ctx.fileReads.noteFromDisk(filePath);
    }
    const rel = path.relative(ctx.workspace, filePath) || filePath;
    return {
      output:
        `Wrote ${rel}` +
        (createdParents ? " (created parent directories)" : "") +
        (stripped.stripped ? " (stripped read_file line-number prefixes)" : "") +
        formatNoteSuffix(fmt) +
        verifyHintSuffix(ctx.workspace, filePath),
    };
  } catch (err) {
    return {
      output: `write_file failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
