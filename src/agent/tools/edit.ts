import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, assertWritablePath, displayRelPath } from "./path-util.js";
import { pathNotFoundHint } from "./path-hints.js";
import {
  applyMatch,
  editMissHint,
  locateEdit,
  shortDiff,
  stripReadFileLinePrefixes,
} from "./edit-match.js";
import {
  afterWriteText,
  buildSuccessReceipt,
  editReceiptEnabled,
  lineCount,
  lineHunks,
  lineStats,
} from "./edit-receipt.js";
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
import { fileReadGuardEnabled } from "./file-read-state.js";
import { verifyHintSuffix } from "../../util/project-intel.js";
import { applyRawPinSideEffects } from "../../util/pin-budget.js";
import { isTruthy } from "../../util/bool.js";

/** So a 1.3KB tool result is not mistaken for a truncated file. */
export function lineCountNote(text: string): string {
  const n = text.length === 0 ? 0 : text.split(/\r?\n/).length;
  return ` (${n} line${n === 1 ? "" : "s"})`;
}

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
        'Example: { "path": "src/x.ts", "old_string": "foo", "new_string": "bar" }\n' +
        "Use a workspace-relative path (not empty). Prefer list_dir/glob first if unsure.",
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
  // Models often paste read_file output ( "    12|code" ) into old/new_string.
  const strippedOld = stripReadFileLinePrefixes(String(args.old_string));
  const strippedNew = stripReadFileLinePrefixes(String(args.new_string));
  const oldStr = strippedOld.text;
  const newStr = strippedNew.text;
  const strippedNote =
    strippedOld.stripped || strippedNew.stripped
      ? " (stripped read_file line-number prefixes)"
      : "";
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
      const rel = displayRelPath(ctx.workspace, filePath);
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

  // Session-scoped stale/unread guard (agent loop only).
  if (ctx.fileReads && fileReadGuardEnabled()) {
    const rel = displayRelPath(ctx.workspace, filePath);
    const blocked = await ctx.fileReads.checkBeforeMutate(filePath, {
      tool: "search_replace",
      rel,
    });
    if (blocked) {
      return { output: blocked, isError: true };
    }
  }

  let rawContent: string;
  try {
    rawContent = await fsp.readFile(filePath, "utf8");
  } catch {
    const hint = await pathNotFoundHint(logical, ctx.workspace);
    return { output: `File not found: ${raw}\n${hint}`, isError: true };
  }

  // Pre-image permission bits for the undo journal (restore re-applies them).
  let preMode: number | undefined;
  try {
    preMode = fs.statSync(filePath).mode & 0o777;
  } catch {
    preMode = undefined;
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
          mode: preMode,
          skipped: true,
          reason: `pre-image ${bytes} bytes exceeds journal cap`,
        });
      } else {
        ctx.recordMutation?.({
          path: filePath,
          kind: "update",
          before: rawContent,
          mode: preMode,
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
        // Note AFTER format-on-write so chained edits see the final mtime/size.
        if (ctx.fileReads && fileReadGuardEnabled()) {
          await ctx.fileReads.noteFromDisk(filePath);
        }
        const rel = displayRelPath(ctx.workspace, filePath);
        const nextText = toLineEnding(normalizeNewlines(nextLf), ending);
        return finishEditSuccess({
          rel,
          filePath,
          workspace: ctx.workspace,
          before: content,
          next: nextText,
          fmt,
          matchKind: alt.result.kind,
          replaceAllCount: replaceAll ? alt.count : undefined,
          strippedNote: Boolean(strippedNote),
          ctx,
        });
      }
    }
    // File exists — path typo hints are misleading. Guide on content mismatch.
    // Multi-match already embeds line locations; skip closest-line tips (noise).
    const rel = displayRelPath(ctx.workspace, filePath);
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
  // Note AFTER format-on-write so chained edits see the final mtime/size.
  if (ctx.fileReads && fileReadGuardEnabled()) {
    await ctx.fileReads.noteFromDisk(filePath);
  }

  const rel = displayRelPath(ctx.workspace, filePath);
  return finishEditSuccess({
    rel,
    filePath,
    workspace: ctx.workspace,
    before: content,
    next,
    fmt,
    matchKind: located.result.kind,
    replaceAllCount: replaceAll ? located.count : undefined,
    strippedNote: Boolean(strippedNote),
    ctx,
  });
}

function finishEditSuccess(opts: {
  rel: string;
  filePath: string;
  workspace: string;
  before: string;
  next: string;
  fmt: ReturnType<typeof maybeFormatAfterWrite>;
  matchKind: "exact" | "line_trimmed" | "block_anchor";
  replaceAllCount?: number;
  strippedNote: boolean;
  ctx?: import("./types.js").ToolContext;
}): ToolResult {
  const pinWarn = applyRawPinSideEffects({
    cwd: opts.workspace,
    absPath: opts.filePath,
    before: opts.before,
    after: opts.next,
    sessionId: opts.ctx?.sessionId,
    session: opts.ctx?.session,
  });
  const verifyTip =
    verifyHintSuffix(opts.workspace, opts.filePath) +
    (pinWarn ? `\n\n${pinWarn}` : "");
  const note =
    opts.matchKind !== "exact"
      ? ` (matched via ${opts.matchKind} fallback)`
      : opts.replaceAllCount != null
        ? ` (${opts.replaceAllCount} occurrence${opts.replaceAllCount === 1 ? "" : "s"})`
        : "";
  if (!editReceiptEnabled()) {
    const diff = shortDiff(opts.rel, opts.before, opts.next);
    const st = lineStats(lineHunks(opts.before, opts.next));
    return {
      output:
        `Edited ${opts.rel}${note}${lineCountNote(opts.next)}${opts.strippedNote ? " (stripped read_file line-number prefixes)" : ""}${formatNoteSuffix(opts.fmt)}\n\n${diff}` +
        verifyTip,
      diff,
      stats: { added: st.added, removed: st.removed },
    };
  }
  const resolved = afterWriteText(opts.filePath, opts.next, opts.fmt);
  const st = lineStats(lineHunks(opts.before, resolved.after));
  return buildSuccessReceipt({
    header: {
      kind: "edit",
      rel: opts.rel,
      lines: lineCount(resolved.after),
      added: st.added,
      removed: st.removed,
      windows: [],
      matchNote:
        opts.matchKind === "line_trimmed" || opts.matchKind === "block_anchor"
          ? opts.matchKind
          : undefined,
      replaceAllCount:
        opts.matchKind === "exact" ? opts.replaceAllCount : undefined,
      formatted: resolved.formatted,
      formatSkipped: resolved.formatSkipped,
      strippedPrefixes: opts.strippedNote,
    },
    before: opts.before,
    after: resolved.after,
    relForDiff: opts.rel,
    verifyTip,
  });
}
