/**
 * apply_patch tool — multi-file add/update/delete/move in one call.
 * OpenCode / Codex-compatible patch grammar.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, assertWritablePath } from "./path-util.js";
import { applyUpdateChunks, parsePatch } from "./patch.js";
import { atomicWriteFile } from "./atomic-write.js";

export async function toolApplyPatch(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const patchText = String(
    args.patchText ?? args.patch_text ?? args.patch ?? "",
  );
  if (!patchText.trim()) {
    return { output: "patchText is required", isError: true };
  }

  const parsed = parsePatch(patchText);
  if (!parsed.ok) {
    return {
      output: `apply_patch verification failed: ${parsed.error}`,
      isError: true,
    };
  }

  type Planned =
    | {
        kind: "add";
        rel: string;
        abs: string;
        content: string;
      }
    | {
        kind: "delete";
        rel: string;
        abs: string;
      }
    | {
        kind: "update";
        rel: string;
        abs: string;
        content: string;
        moveRel?: string;
        moveAbs?: string;
      };

  const planned: Planned[] = [];

  // Validate + prepare all ops before mutating disk (fail closed on first bad hunk)
  for (const hunk of parsed.hunks) {
    if (hunk.type === "add") {
      const logical = resolvePath(ctx.workspace, hunk.path);
      let abs: string;
      try {
        abs = await assertWritablePath(ctx.workspace, logical);
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }
      if (fs.existsSync(abs)) {
        return {
          output: `apply_patch failed: cannot add existing file ${hunk.path}`,
          isError: true,
        };
      }
      let content = hunk.contents;
      if (content.length > 0 && !content.endsWith("\n")) content += "\n";
      planned.push({
        kind: "add",
        rel: path.relative(ctx.workspace, abs) || abs,
        abs,
        content,
      });
      continue;
    }

    if (hunk.type === "delete") {
      const logical = resolvePath(ctx.workspace, hunk.path);
      let abs: string;
      try {
        abs = await assertWritablePath(ctx.workspace, logical);
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }
      if (!fs.existsSync(abs)) {
        return {
          output: `apply_patch failed: delete target missing: ${hunk.path}`,
          isError: true,
        };
      }
      const st = await fsp.stat(abs);
      if (st.isDirectory()) {
        return {
          output: `apply_patch failed: refuse to delete directory ${hunk.path}`,
          isError: true,
        };
      }
      planned.push({
        kind: "delete",
        rel: path.relative(ctx.workspace, abs) || abs,
        abs,
      });
      continue;
    }

    // update
    const logical = resolvePath(ctx.workspace, hunk.path);
    let abs: string;
    try {
      abs = await assertWritablePath(ctx.workspace, logical);
    } catch (err) {
      return { output: (err as Error).message, isError: true };
    }
    if (!fs.existsSync(abs)) {
      return {
        output: `apply_patch failed: update target missing: ${hunk.path}`,
        isError: true,
      };
    }
    let original: string;
    try {
      original = await fsp.readFile(abs, "utf8");
    } catch (err) {
      return {
        output: `apply_patch failed: cannot read ${hunk.path}: ${(err as Error).message}`,
        isError: true,
      };
    }
    let next: string;
    try {
      next = applyUpdateChunks(original, hunk.path, hunk.chunks);
    } catch (err) {
      return {
        output: `apply_patch failed on ${hunk.path}: ${(err as Error).message}`,
        isError: true,
      };
    }
    let moveAbs: string | undefined;
    let moveRel: string | undefined;
    if (hunk.movePath) {
      const moveLogical = resolvePath(ctx.workspace, hunk.movePath);
      try {
        moveAbs = await assertWritablePath(ctx.workspace, moveLogical);
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }
      moveRel = path.relative(ctx.workspace, moveAbs) || moveAbs;
    }
    planned.push({
      kind: "update",
      rel: path.relative(ctx.workspace, abs) || abs,
      abs,
      content: next,
      moveAbs,
      moveRel,
    });
  }

  const applied: string[] = [];
  try {
    for (const op of planned) {
      if (op.kind === "add") {
        await fsp.mkdir(path.dirname(op.abs), { recursive: true });
        await atomicWriteFile(op.abs, op.content);
        applied.push(`A ${op.rel}`);
        ctx.onEdit?.();
      } else if (op.kind === "delete") {
        await fsp.unlink(op.abs);
        applied.push(`D ${op.rel}`);
        ctx.onEdit?.();
      } else {
        if (op.moveAbs && op.moveAbs !== op.abs) {
          await fsp.mkdir(path.dirname(op.moveAbs), { recursive: true });
          await atomicWriteFile(op.moveAbs, op.content);
          await fsp.unlink(op.abs);
          applied.push(`M ${op.rel} → ${op.moveRel}`);
        } else {
          await atomicWriteFile(op.abs, op.content);
          applied.push(`M ${op.rel}`);
        }
        ctx.onEdit?.();
      }
    }
  } catch (err) {
    return {
      output:
        `apply_patch partially applied (${applied.length} op(s)) then failed: ${(err as Error).message}\n` +
        (applied.length ? `Applied before failure:\n${applied.join("\n")}\n` : "") +
        `Earlier successful ops were NOT rolled back — inspect the workspace.`,
      isError: true,
    };
  }

  return {
    output: `Applied patch (${applied.length} op(s)):\n${applied.join("\n")}`,
  };
}
