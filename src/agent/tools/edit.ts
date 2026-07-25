import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, assertWritablePath } from "./path-util.js";
import { pathNotFoundHint } from "./path-hints.js";
import { applyMatch, locateEdit, shortDiff } from "./edit-match.js";
import {
  detectLineEnding,
  joinBom,
  normalizeNewlines,
  splitBom,
  toLineEnding,
} from "./text.js";
import { atomicWriteFile } from "./atomic-write.js";

export async function toolEdit(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const raw = String(args.path || "");
  if (!raw) return { output: "path is required", isError: true };
  const logical = resolvePath(ctx.workspace, raw);
  let filePath: string;
  try {
    filePath = await assertWritablePath(ctx.workspace, logical);
  } catch (err) {
    return { output: (err as Error).message, isError: true };
  }

  const oldStr = String(args.old_string ?? "");
  const newStr = String(args.new_string ?? "");
  const replaceAll = Boolean(args.replace_all);

  if (oldStr === newStr) {
    return {
      output: "No changes to apply: old_string and new_string are identical.",
      isError: true,
    };
  }

  // Refuse directory targets — readFile EISDIR is opaque to models.
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      const rel = path.relative(ctx.workspace, filePath) || filePath;
      return {
        output:
          `search_replace failed: ${rel} is a directory. ` +
          `Pass a file path inside it.`,
        isError: true,
      };
    }
  } catch {
    /* fall through */
  }

  let rawContent: string;
  try {
    rawContent = await fsp.readFile(filePath, "utf8");
  } catch {
    const hint = await pathNotFoundHint(logical, ctx.workspace);
    return { output: `File not found: ${raw}\n${hint}`, isError: true };
  }

  const { bom, text: withoutBom } = splitBom(rawContent);
  const ending = detectLineEnding(withoutBom);
  const content = withoutBom;

  // Match on content with native endings; normalize search strings to file ending
  const oldNative = toLineEnding(normalizeNewlines(oldStr), ending);
  const newNative = toLineEnding(normalizeNewlines(newStr), ending);

  const located = locateEdit(content, oldNative, replaceAll);
  if (!located.ok) {
    // Also try LF-normalized search against LF content if file is CRLF and model sent LF
    if (ending === "\r\n") {
      const lfContent = normalizeNewlines(content);
      const lfOld = normalizeNewlines(oldStr);
      const alt = locateEdit(lfContent, lfOld, replaceAll);
      if (alt.ok) {
        const lfNew = normalizeNewlines(newStr);
        let nextLf = applyMatch(lfContent, alt.result, lfNew, replaceAll);
        nextLf = toLineEnding(nextLf, ending);
        const final = joinBom(nextLf, bom);
        await atomicWriteFile(filePath, final, { encoding: "utf8" });
        ctx.onEdit?.();
        const rel = path.relative(ctx.workspace, filePath) || filePath;
        const note =
          alt.result.kind !== "exact"
            ? ` (matched via ${alt.result.kind} fallback)`
            : "";
        const diff = shortDiff(rel, content, toLineEnding(normalizeNewlines(nextLf), ending));
        return {
          output: `Edited ${rel}${note}\n\n${diff}`,
        };
      }
    }
    const hint = await pathNotFoundHint(logical, ctx.workspace);
    return {
      output: `${located.reason}\nFile: ${path.relative(ctx.workspace, filePath) || filePath}\n${hint}`,
      isError: true,
    };
  }

  const next = applyMatch(content, located.result, newNative, replaceAll);
  const final = joinBom(next, bom);
  await atomicWriteFile(filePath, final, { encoding: "utf8" });
  ctx.onEdit?.();

  const rel = path.relative(ctx.workspace, filePath) || filePath;
  const note =
    located.result.kind !== "exact"
      ? ` (matched via ${located.result.kind} fallback)`
      : replaceAll
        ? ` (${located.count} occurrence${located.count === 1 ? "" : "s"})`
        : "";
  const diff = shortDiff(rel, content, next);
  return { output: `Edited ${rel}${note}\n\n${diff}` };
}
