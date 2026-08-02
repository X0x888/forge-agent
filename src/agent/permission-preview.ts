/**
 * Colored diff previews for interactive permission asks on edit tools.
 * Computes before/after purely in memory (before = current file on disk) —
 * never writes. Best-effort: returns undefined whenever the real tool would
 * fail or the file cannot be read, so the caller falls back to the plain
 * text argument preview.
 */
import fs from "node:fs";
import path from "node:path";
import {
  applyMatch,
  locateEdit,
  shortDiff,
  stripReadFileLinePrefixes,
} from "./tools/edit-match.js";
import { normalizeNewlines } from "./tools/text.js";
import { applyUpdateChunks, parsePatch } from "./tools/patch.js";
import { resolvePath } from "./tools/path-util.js";
import { formatDiffBlock } from "../util/format.js";
import { isTruthy } from "../util/bool.js";

/** Don't diff huge files into a prompt that is meant to be glanceable. */
const MAX_PREVIEW_FILE_BYTES = 512_000;

function readPreviewFile(abs: string): string | undefined {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_PREVIEW_FILE_BYTES) return undefined;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Colored shortDiff block for search_replace / write_file / apply_patch,
 * or undefined to keep the existing text preview.
 */
export function editToolDiffPreview(
  toolName: string,
  toolInput: Record<string, unknown>,
  workspace?: string,
): string | undefined {
  const name = (toolName || "").toLowerCase();
  const ws = workspace || process.cwd();
  try {
    if (name === "search_replace" || name === "edit") {
      return searchReplacePreview(toolInput, ws);
    }
    if (name === "write_file" || name === "write") {
      return writePreview(toolInput, ws);
    }
    if (name === "apply_patch" || name === "applypatch") {
      return patchPreview(toolInput, ws);
    }
  } catch {
    /* preview is best-effort — fall back to the text summary */
  }
  return undefined;
}

function searchReplacePreview(
  input: Record<string, unknown>,
  ws: string,
): string | undefined {
  const raw = typeof input.path === "string" ? input.path.trim() : "";
  if (!raw) return undefined;
  if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
    return undefined;
  }
  const abs = resolvePath(ws, raw);
  const content = readPreviewFile(abs);
  if (content === undefined) return undefined;
  // Mirror toolEdit: strip pasted read_file line numbers, isTruthy replace_all,
  // LF-normalized retry for CRLF files when the model sent LF.
  const oldStr = stripReadFileLinePrefixes(input.old_string).text;
  const newStr = stripReadFileLinePrefixes(input.new_string).text;
  const replaceAll = isTruthy(input.replace_all);
  let base = content;
  let next: string | undefined;
  const located = locateEdit(content, oldStr, replaceAll);
  if (located.ok) {
    next = applyMatch(content, located.result, newStr, replaceAll);
  } else if (content.includes("\r\n")) {
    const lfContent = normalizeNewlines(content);
    base = lfContent;
    const lf = locateEdit(lfContent, normalizeNewlines(oldStr), replaceAll);
    if (lf.ok) {
      next = applyMatch(lfContent, lf.result, normalizeNewlines(newStr), replaceAll);
    }
  }
  if (next === undefined) return undefined;
  const rel = path.relative(ws, abs) || abs;
  return formatDiffBlock(shortDiff(rel, base, next, 30), {
    maxLines: 30,
    indent: "  ",
  });
}

function writePreview(
  input: Record<string, unknown>,
  ws: string,
): string | undefined {
  const raw = typeof input.path === "string" ? input.path.trim() : "";
  if (!raw || typeof input.content !== "string") return undefined;
  const abs = resolvePath(ws, raw);
  let before = "";
  if (fs.existsSync(abs)) {
    const current = readPreviewFile(abs);
    if (current === undefined) return undefined;
    before = current;
  }
  // Mirror toolWrite's pasted read_file line-number strip.
  const body = stripReadFileLinePrefixes(input.content).text;
  const rel = path.relative(ws, abs) || abs;
  return formatDiffBlock(shortDiff(rel, before, body, 30), {
    maxLines: 30,
    indent: "  ",
  });
}

function patchPreview(
  input: Record<string, unknown>,
  ws: string,
): string | undefined {
  const rawPatch = input.patchText ?? input.patch_text ?? input.patch;
  if (typeof rawPatch !== "string" || !rawPatch.trim()) return undefined;
  const parsed = parsePatch(rawPatch);
  if (!parsed.ok) return undefined;
  /** In-memory content chain so add→update of the same path previews correctly. */
  const virtual = new Map<string, string>();
  const blocks: string[] = [];
  for (const hunk of parsed.hunks) {
    const abs = resolvePath(ws, hunk.path);
    const rel = path.relative(ws, abs) || abs;
    if (hunk.type === "add") {
      let content = hunk.contents;
      if (content.length > 0 && !content.endsWith("\n")) content += "\n";
      blocks.push(shortDiff(rel, "", content, 20));
      virtual.set(abs, content);
      continue;
    }
    let before = virtual.get(abs);
    if (before === undefined) {
      if (!fs.existsSync(abs)) return undefined;
      before = readPreviewFile(abs);
      if (before === undefined) return undefined;
    }
    if (hunk.type === "delete") {
      blocks.push(shortDiff(rel, before, "", 20));
      virtual.set(abs, "");
      continue;
    }
    let next: string;
    try {
      next = applyUpdateChunks(before, hunk.path, hunk.chunks);
    } catch {
      // Patch will not apply — the raw text preview is more useful here.
      return undefined;
    }
    const moveRel = hunk.movePath
      ? path.relative(ws, resolvePath(ws, hunk.movePath)) || hunk.movePath
      : undefined;
    blocks.push(
      shortDiff(moveRel ? `${rel} → ${moveRel}` : rel, before, next, 20),
    );
    virtual.set(abs, next);
    if (hunk.movePath) virtual.set(resolvePath(ws, hunk.movePath), next);
  }
  if (!blocks.length) return undefined;
  return formatDiffBlock(blocks.join("\n"), { maxLines: 40, indent: "  " });
}
