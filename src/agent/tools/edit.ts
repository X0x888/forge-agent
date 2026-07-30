import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, assertWritablePath } from "./path-util.js";
import { pathNotFoundHint } from "./path-hints.js";
import { applyMatch, editMissHint, locateEdit, shortDiff } from "./edit-match.js";
import {
  detectLineEnding,
  joinBom,
  normalizeNewlines,
  splitBom,
  toLineEnding,
} from "./text.js";
import { atomicWriteFile } from "./atomic-write.js";
import {
  formatNoteSuffix,
  maybeFormatAfterWrite,
} from "./format-on-write.js";
import { isTruthy } from "../../util/bool.js";

export async function toolEdit(
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
      output: `search_replace error: path must be a string (got ${kind}).`,
      isError: true,
    };
  }
  const raw = String(args.path || "").trim();
  if (!raw) {
    return {
      output:
        "search_replace error: path is required (non-empty string).\n" +
        'Example: { "path": "src/x.ts", "old_string": "foo", "new_string": "bar" }',
      isError: true,
    };
  }
  const logical = resolvePath(ctx.workspace, raw);
  let filePath: string;
  try {
    filePath = await assertWritablePath(ctx.workspace, logical);
  } catch (err) {
    return { output: (err as Error).message, isError: true };
  }

  // Schema requires strings. Objects used to become "[object Object]" in the file.
  if (!Object.prototype.hasOwnProperty.call(args, "old_string")) {
    return {
      output: "search_replace error: old_string is required (string).",
      isError: true,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(args, "new_string")) {
    return {
      output: "search_replace error: new_string is required (string).",
      isError: true,
    };
  }
  if (typeof args.old_string !== "string") {
    const kind =
      args.old_string === null
        ? "null"
        : Array.isArray(args.old_string)
          ? "array"
          : typeof args.old_string;
    return {
      output: `search_replace error: old_string must be a string (got ${kind}).`,
      isError: true,
    };
  }
  if (typeof args.new_string !== "string") {
    const kind =
      args.new_string === null
        ? "null"
        : Array.isArray(args.new_string)
          ? "array"
          : typeof args.new_string;
    return {
      output: `search_replace error: new_string must be a string (got ${kind}).`,
      isError: true,
    };
  }
  const oldStr = args.old_string;
  const newStr = args.new_string;
  // Models may emit replace_all:"false" — Boolean("false") is true in JS.
  const replaceAll = isTruthy(args.replace_all);

  // Whitespace-only old_string is almost always a model mistake (matches blank lines).
  if (typeof oldStr === "string" && oldStr.length > 0 && !oldStr.trim()) {
    return {
      output:
        "search_replace error: old_string is whitespace-only. " +
        "Match real file text (not blank lines), or use write_file to rewrite the file.",
      isError: true,
    };
  }

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

  const journalUpdate = () => {
    try {
      const bytes = Buffer.byteLength(rawContent, "utf8");
      if (bytes > 1_500_000) {
        ctx.recordMutation?.({
          path: filePath,
          kind: "update",
          skipped: true,
          reason: `pre-image ${bytes} bytes exceeds journal cap`,
        });
      } else {
        ctx.recordMutation?.({
          path: filePath,
          kind: "update",
          before: rawContent,
        });
      }
    } catch {
      /* journal best-effort */
    }
  };

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
        journalUpdate();
        ctx.onEdit?.();
        const fmt = maybeFormatAfterWrite(filePath, ctx.workspace);
        const rel = path.relative(ctx.workspace, filePath) || filePath;
        const note =
          alt.result.kind !== "exact"
            ? ` (matched via ${alt.result.kind} fallback)`
            : "";
        const diff = shortDiff(rel, content, toLineEnding(normalizeNewlines(nextLf), ending));
        return {
          output: `Edited ${rel}${note}${formatNoteSuffix(fmt)}\n\n${diff}`,
        };
      }
    }
    // File exists — path typo hints are misleading. Guide on content mismatch.
    // Multi-match already embeds line locations; skip closest-line tips (noise).
    const rel = path.relative(ctx.workspace, filePath) || filePath;
    const multi = /matches multiple times/i.test(located.reason);
    const contentHint = multi ? "" : editMissHint(content, oldNative);
    return {
      output:
        `${located.reason}\nFile: ${rel}` +
        (contentHint ? `\n${contentHint}` : ""),
      isError: true,
    };
  }

  const next = applyMatch(content, located.result, newNative, replaceAll);
  const final = joinBom(next, bom);
  await atomicWriteFile(filePath, final, { encoding: "utf8" });
  journalUpdate();
  ctx.onEdit?.();
  const fmt = maybeFormatAfterWrite(filePath, ctx.workspace);

  const rel = path.relative(ctx.workspace, filePath) || filePath;
  const note =
    located.result.kind !== "exact"
      ? ` (matched via ${located.result.kind} fallback)`
      : replaceAll
        ? ` (${located.count} occurrence${located.count === 1 ? "" : "s"})`
        : "";
  const diff = shortDiff(rel, content, next);
  return { output: `Edited ${rel}${note}${formatNoteSuffix(fmt)}\n\n${diff}` };
}
