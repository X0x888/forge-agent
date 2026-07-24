import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, assertWritablePath } from "./path-util.js";

export async function toolWrite(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const raw = String(args.path || "");
  if (!raw) return { output: "path is required", isError: true };
  const logical = resolvePath(ctx.workspace, raw);
  const filePath = await assertWritablePath(ctx.workspace, logical);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, String(args.content ?? ""), "utf8");
  ctx.onEdit?.();
  return { output: `Wrote ${path.relative(ctx.workspace, filePath) || filePath}` };
}
