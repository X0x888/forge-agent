/**
 * OpenAI/OpenCode-style multi-file apply_patch.
 *
 * Format:
 *   *** Begin Patch
 *   *** Add File: path
 *   +line
 *   *** Delete File: path
 *   *** Update File: path
 *   *** Move to: newpath   (optional)
 *   @@ optional context
 *    context
 *   -old
 *   +new
 *   *** End Patch
 */

export type PatchHunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | {
      type: "update";
      path: string;
      movePath?: string;
      chunks: UpdateChunk[];
    };

export interface UpdateChunk {
  oldLines: string[];
  newLines: string[];
  changeContext?: string;
  endOfFile?: boolean;
}

export interface ParsePatchResult {
  ok: true;
  hunks: PatchHunk[];
}

export interface ParsePatchError {
  ok: false;
  error: string;
}

export function parsePatch(patchText: string): ParsePatchResult | ParsePatchError {
  try {
    const text = stripHeredoc(String(patchText || "").trim());
    if (!text) return { ok: false, error: "patchText is empty" };
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const begin = lines.findIndex((l) => l.trim() === "*** Begin Patch");
    const end = lines.findIndex((l) => l.trim() === "*** End Patch");
    if (begin === -1 || end === -1 || begin >= end) {
      let detail = "missing *** Begin Patch / *** End Patch markers";
      if (begin !== -1 && end === -1) {
        detail =
          "found *** Begin Patch but missing *** End Patch (close the patch with *** End Patch on its own line)";
      } else if (begin === -1 && end !== -1) {
        detail =
          "found *** End Patch but missing *** Begin Patch (open with *** Begin Patch on its own line)";
      } else if (begin !== -1 && end !== -1 && begin >= end) {
        detail = "*** End Patch must come after *** Begin Patch";
      }
      return {
        ok: false,
        error: `Invalid patch format: ${detail}`,
      };
    }
    const hunks: PatchHunk[] = [];
    let index = begin + 1;
    while (index < end) {
      const line = lines[index]!;
      if (!line.trim()) {
        index++;
        continue;
      }
      if (line.startsWith("*** Add File:")) {
        const p = line.slice("*** Add File:".length).trim();
        if (!p) return { ok: false, error: "Invalid add file path (empty). Use *** Add File: relative/path.ext" };
        const parsed = parseAdd(lines, index + 1, end);
        hunks.push({ type: "add", path: p, contents: parsed.content });
        index = parsed.next;
        continue;
      }
      if (line.startsWith("*** Delete File:")) {
        const p = line.slice("*** Delete File:".length).trim();
        if (!p) return { ok: false, error: "Invalid delete file path (empty). Use *** Delete File: relative/path.ext" };
        hunks.push({ type: "delete", path: p });
        index++;
        continue;
      }
      if (line.startsWith("*** Update File:")) {
        const p = line.slice("*** Update File:".length).trim();
        if (!p) return { ok: false, error: "Invalid update file path (empty). Use *** Update File: relative/path.ext" };
        let next = index + 1;
        let movePath: string | undefined;
        if (lines[next]?.startsWith("*** Move to:")) {
          movePath = lines[next]!.slice("*** Move to:".length).trim();
          if (!movePath) {
            return {
              ok: false,
              error:
                "Invalid move file path (empty). Use:\n" +
                "  *** Update File: old/path.ts\n" +
                "  *** Move to: new/path.ts",
            };
          }
          next++;
        }
        const parsed = parseUpdate(lines, next, end);
        if (parsed.chunks.length === 0) {
          return {
            ok: false,
            error: `Invalid update hunk for ${p}: expected at least one @@ chunk`,
          };
        }
        const noop =
          !movePath &&
          parsed.chunks.every((c) => {
            // Empty chunk, or context-only (old === new) with no edits.
            if (c.oldLines.length === 0 && c.newLines.length === 0) return true;
            if (c.oldLines.length !== c.newLines.length) return false;
            return c.oldLines.every((line, i) => line === c.newLines[i]);
          });
        if (noop) {
          return {
            ok: false,
            error:
              `Invalid update hunk for ${p}: empty/context-only @@ chunk is a no-op. ` +
              `Add -/+ lines, or use *** Move to: for renames.`,
          };
        }
        hunks.push({ type: "update", path: p, movePath, chunks: parsed.chunks });
        index = parsed.next;
        continue;
      }
      const trimmed = line.trim();
      if (/^\*\*\*\s*Move\s+File:/i.test(trimmed) || /^\*\*\*\s*Rename\s+File:/i.test(trimmed)) {
        return {
          ok: false,
          error:
            `Invalid patch line: ${line}
` +
            `Hint: renames use Update File + Move to, e.g.
` +
            `  *** Update File: old/path.ts
` +
            `  *** Move to: new/path.ts
` +
            `  @@
` +
            `  (optional -/+ lines)`,
        };
      }
      if (/^\*\*\*\s*Move\s+to:/i.test(trimmed)) {
        return {
          ok: false,
          error:
            `Invalid patch line: ${line}
` +
            `Hint: *** Move to: must follow *** Update File: path (not stand alone).`,
        };
      }
      return { ok: false, error: `Invalid patch line: ${line}` };
    }
    if (hunks.length === 0) {
      return {
        ok: false,
        error:
          "patch rejected: empty patch (no file ops). Include at least one *** Add/Update/Delete/Move File: path hunk between *** Begin Patch and *** End Patch",
      };
    }
    return { ok: true, hunks };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

/** Apply update chunks to original file text. Throws on seek failure. */
export function applyUpdateChunks(
  original: string,
  pathLabel: string,
  chunks: UpdateChunk[],
): string {
  const source = splitBom(original);
  const lines = source.text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const replacements = computeReplacements(lines, pathLabel, chunks);
  const updated = [...lines];
  for (const [start, remove, insert] of [...replacements].reverse()) {
    updated.splice(start, remove, ...insert);
  }
  if (updated.at(-1) !== "") updated.push("");
  const body = updated.join("\n");
  return source.bom ? `\uFEFF${body}` : body;
}

function parseAdd(
  lines: string[],
  start: number,
  end: number,
): { content: string; next: number } {
  const content: string[] = [];
  let index = start;
  while (index < end && !lines[index]!.startsWith("***")) {
    const line = lines[index]!;
    if (!line.startsWith("+")) {
      throw new Error(`Invalid add file line: ${line}`);
    }
    content.push(line.slice(1));
    index++;
  }
  // Match OpenCode: join without forcing trailing newline unless present in + lines
  let text = content.join("\n");
  if (content.length > 0 && !text.endsWith("\n")) {
    // keep as-is; writers may add final newline
  }
  return { content: text, next: index };
}

function parseUpdate(
  lines: string[],
  start: number,
  end: number,
): { chunks: UpdateChunk[]; next: number } {
  const chunks: UpdateChunk[] = [];
  let index = start;
  while (index < end && !lines[index]!.startsWith("***")) {
    if (!lines[index]!.startsWith("@@")) {
      throw new Error(`Invalid update file line: ${lines[index]}`);
    }
    const changeContext = lines[index]!.slice(2).trim() || undefined;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let endOfFile = false;
    index++;
    while (index < end && !lines[index]!.startsWith("@@")) {
      const line = lines[index]!;
      if (line === "*** End of File") {
        endOfFile = true;
        index++;
        break;
      }
      if (line.startsWith("***")) break;
      if (line.startsWith(" ")) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      } else if (line === "") {
        // blank line without prefix — treat as context empty line
        oldLines.push("");
        newLines.push("");
      } else {
        throw new Error(`Invalid update chunk line: ${line}`);
      }
      index++;
    }
    chunks.push({
      oldLines,
      newLines,
      changeContext,
      endOfFile: endOfFile || undefined,
    });
  }
  return { chunks, next: index };
}

function computeReplacements(
  lines: string[],
  pathLabel: string,
  chunks: UpdateChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const context = seek(lines, [chunk.changeContext], lineIndex);
      if (context === -1) {
        throw new Error(
          `Failed to find context '${chunk.changeContext}' in ${pathLabel}\n` +
            `Tip: re-read the file and copy an exact nearby line for @@ context.`,
        );
      }
      lineIndex = context + 1;
    }
    if (chunk.oldLines.length === 0) {
      // pure insert at EOF (or after context)
      replacements.push([lines.length, 0, [...chunk.newLines]]);
      continue;
    }
    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = seek(lines, oldLines, lineIndex, chunk.endOfFile);
    if (found === -1 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      found = seek(lines, oldLines, lineIndex, chunk.endOfFile);
    }
    if (found === -1) {
      throw new Error(
        `Failed to find expected lines in ${pathLabel}:\n${chunk.oldLines.join("\n")}\n` +
          `Tip: re-read ${pathLabel} and refresh the @@ hunk from current contents (or use search_replace for a small edit).`,
      );
    }
    replacements.push([found, oldLines.length, [...newLines]]);
    lineIndex = found + oldLines.length;
  }
  return replacements.sort((a, b) => a[0] - b[0]);
}

function seek(
  lines: string[],
  pattern: string[],
  start: number,
  eof = false,
): number {
  if (pattern.length === 0) return -1;
  for (const compare of [exact, rstrip, trim, normalized]) {
    if (eof) {
      const offset = lines.length - pattern.length;
      if (offset >= start && matches(lines, pattern, offset, compare)) {
        return offset;
      }
    }
    for (let offset = start; offset <= lines.length - pattern.length; offset++) {
      if (matches(lines, pattern, offset, compare)) return offset;
    }
  }
  return -1;
}

function matches(
  lines: string[],
  pattern: string[],
  offset: number,
  compare: (a: string, b: string) => boolean,
): boolean {
  return pattern.every((line, i) => compare(lines[offset + i]!, line));
}

const exact = (a: string, b: string) => a === b;
const rstrip = (a: string, b: string) => a.trimEnd() === b.trimEnd();
const trim = (a: string, b: string) => a.trim() === b.trim();
const normalized = (a: string, b: string) =>
  normalize(a.trim()) === normalize(b.trim());
const normalize = (value: string) =>
  value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");

function splitBom(text: string): { bom: boolean; text: string } {
  return text.startsWith("\uFEFF")
    ? { bom: true, text: text.slice(1) }
    : { bom: false, text };
}

function stripHeredoc(input: string): string {
  const m = input.match(
    /^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
  );
  return m?.[2] ?? input;
}
