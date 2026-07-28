import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, assertWritablePath } from "./path-util.js";
import { atomicWriteFile } from "./atomic-write.js";
import { snapshotForWrite } from "../../session/mutations.js";

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
        'Example: { "path": "notes.md", "content": "# hello\n" }',
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
    const snap = await snapshotForWrite(filePath);
    const dir = path.dirname(filePath);
    let createdParents = false;
    try {
      await fsp.access(dir);
    } catch {
      createdParents = true;
    }
    await atomicWriteFile(filePath, args.content, {
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
    const rel = path.relative(ctx.workspace, filePath) || filePath;
    return {
      output:
        `Wrote ${rel}` +
        (createdParents ? " (created parent directories)" : ""),
    };
  } catch (err) {
    return {
      output: `write_file failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
