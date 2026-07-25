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
  const raw = String(args.path || "");
  if (!raw) return { output: "path is required", isError: true };
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
    await atomicWriteFile(filePath, String(args.content ?? ""), {
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
