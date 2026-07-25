/**
 * apply_patch tool — multi-file add/update/delete/move in one call.
 * OpenCode / Codex-compatible patch grammar.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, assertWritablePath } from "./path-util.js";
import { pathNotFoundHint } from "./path-hints.js";
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
        before: string;
      }
    | {
        kind: "update";
        rel: string;
        abs: string;
        content: string;
        before: string;
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
        let kind = "path";
        try {
          kind = fs.statSync(abs).isDirectory() ? "directory" : "file";
        } catch {
          /* keep generic */
        }
        return {
          output:
            kind === "directory"
              ? `apply_patch failed: cannot add ${hunk.path} — path is an existing directory (use a file path inside it)`
              : `apply_patch failed: cannot add existing file ${hunk.path}`,
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
        const hint = await pathNotFoundHint(logical, ctx.workspace);
        return {
          output: `apply_patch failed: delete target missing: ${hunk.path}${hint ? `\n${hint}` : ""}`,
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
      let before = "";
      try {
        before = await fsp.readFile(abs, "utf8");
      } catch (err) {
        return {
          output: `apply_patch failed: cannot read ${hunk.path} for delete: ${(err as Error).message}`,
          isError: true,
        };
      }
      planned.push({
        kind: "delete",
        rel: path.relative(ctx.workspace, abs) || abs,
        abs,
        before,
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
      const hint = await pathNotFoundHint(logical, ctx.workspace);
      return {
        output: `apply_patch failed: update target missing: ${hunk.path}${hint ? `\n${hint}` : ""}`,
        isError: true,
      };
    }
    try {
      if (fs.statSync(abs).isDirectory()) {
        return {
          output: `apply_patch failed: update target is a directory: ${hunk.path} (pass a file path)`,
          isError: true,
        };
      }
    } catch {
      /* fall through to read */
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
      before: original,
      moveAbs,
      moveRel,
    });
  }

  const journal = (
    input: {
      path: string;
      kind: "create" | "update" | "delete";
      before?: string;
      skipped?: boolean;
      reason?: string;
    },
  ) => {
    try {
      ctx.recordMutation?.(input);
    } catch {
      /* best-effort */
    }
  };

  const applied: string[] = [];
  try {
    for (const op of planned) {
      if (op.kind === "add") {
        await fsp.mkdir(path.dirname(op.abs), { recursive: true });
        await atomicWriteFile(op.abs, op.content);
        journal({ path: op.abs, kind: "create" });
        applied.push(`A ${op.rel}`);
        ctx.onEdit?.();
      } else if (op.kind === "delete") {
        await fsp.unlink(op.abs);
        const bytes = Buffer.byteLength(op.before, "utf8");
        if (bytes > 1_500_000) {
          journal({
            path: op.abs,
            kind: "delete",
            skipped: true,
            reason: `pre-image ${bytes} bytes exceeds journal cap`,
          });
        } else {
          journal({ path: op.abs, kind: "delete", before: op.before });
        }
        applied.push(`D ${op.rel}`);
        ctx.onEdit?.();
      } else {
        if (op.moveAbs && op.moveAbs !== op.abs) {
          // Move = create at dest + delete source (journal both for undo)
          await fsp.mkdir(path.dirname(op.moveAbs), { recursive: true });
          await atomicWriteFile(op.moveAbs, op.content);
          await fsp.unlink(op.abs);
          journal({ path: op.moveAbs, kind: "create" });
          const bytes = Buffer.byteLength(op.before, "utf8");
          if (bytes > 1_500_000) {
            journal({
              path: op.abs,
              kind: "delete",
              skipped: true,
              reason: `pre-image ${bytes} bytes exceeds journal cap`,
            });
          } else {
            journal({ path: op.abs, kind: "delete", before: op.before });
          }
          applied.push(`M ${op.rel} → ${op.moveRel}`);
        } else {
          await atomicWriteFile(op.abs, op.content);
          const bytes = Buffer.byteLength(op.before, "utf8");
          if (bytes > 1_500_000) {
            journal({
              path: op.abs,
              kind: "update",
              skipped: true,
              reason: `pre-image ${bytes} bytes exceeds journal cap`,
            });
          } else {
            journal({ path: op.abs, kind: "update", before: op.before });
          }
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
