/**
 * Conservative edit matching: exact → line-trimmed → block-anchor
 * (OpenCode/Grok inspired). Block-anchor uses Levenshtein similarity on
 * middle lines when first/last anchors match.
 */

import { stringSimilarity } from "../../util/string-distance.js";

export type MatchKind = "exact" | "line_trimmed" | "block_anchor";

export interface MatchResult {
  kind: MatchKind;
  /** Exact substring in the file to replace (preserves original whitespace when fuzzy). */
  matched: string;
  index: number;
}

/**
 * Strip read_file line-number prefixes (`   12|code`) when the model pastes
 * tool output into old_string/new_string. Conservative: only when every
 * non-empty line matches the numbered format (or is blank).
 */
export function stripReadFileLinePrefixes(text: string): {
  text: string;
  stripped: boolean;
} {
  if (!text || !text.includes("|")) {
    return { text, stripped: false };
  }
  const lines = text.split("\n");
  // Need at least one numbered content line.
  let numbered = 0;
  let padded = 0; // leading spaces before digits (read_file padStart(6))
  const nums: number[] = [];
  const out: string[] = [];
  for (const line of lines) {
    if (line === "") {
      out.push("");
      continue;
    }
    // read_file format: padStart(6) + "|" + content  → "    12|foo"
    // Also accept unpadded multi-line "12|foo" pastes (models sometimes trim).
    const m = line.match(/^(\s*)(\d+)\|(.*)$/);
    if (!m) {
      // Not a pure numbered paste — leave original alone.
      return { text, stripped: false };
    }
    numbered += 1;
    if ((m[1] || "").length > 0) padded += 1;
    nums.push(Number(m[2]));
    out.push(m[3]!);
  }
  if (numbered < 1) return { text, stripped: false };
  // Avoid false positives on single-line "1|pipe" data / simple tables:
  // require either multi-line numbered paste or padStart-style leading spaces.
  if (numbered === 1 && padded === 0) {
    return { text, stripped: false };
  }
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1]! + 1) {
      return { text, stripped: false };
    }
  }
  return { text: out.join("\n"), stripped: true };
}

const BLOCK_SIMILARITY = 0.65;

function lineSim(a: string, b: string): number {
  return stringSimilarity(a.trim(), b.trim());
}

function findExactIndices(content: string, find: string): number[] {
  const indices: number[] = [];
  let from = 0;
  while (true) {
    const i = content.indexOf(find, from);
    if (i === -1) break;
    indices.push(i);
    from = i + Math.max(find.length, 1);
  }
  return indices;
}

function findExactAll(content: string, find: string): number {
  return findExactIndices(content, find).length;
}

/** 1-based line number for a character offset. */
function lineNumberAt(content: string, index: number): number {
  if (index <= 0) return 1;
  let line = 1;
  const end = Math.min(index, content.length);
  for (let i = 0; i < end; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Format multi-match locations for agent recovery (cap at 8). */
export function formatMultiMatchLocations(
  content: string,
  oldString: string,
  max = 8,
): string {
  const indices = findExactIndices(content, oldString);
  if (indices.length <= 1) return "";
  const lines: string[] = [
    `Found ${indices.length} exact matches at:`,
  ];
  const show = indices.slice(0, max);
  for (const idx of show) {
    const ln = lineNumberAt(content, idx);
    const lineStart = content.lastIndexOf("\n", Math.max(0, idx - 1)) + 1;
    const lineEndIdx = content.indexOf("\n", idx);
    const lineEnd = lineEndIdx === -1 ? content.length : lineEndIdx;
    let preview = content.slice(lineStart, lineEnd);
    if (preview.length > 100) preview = preview.slice(0, 97) + "…";
    lines.push(`  L${ln}: ${preview}`);
  }
  if (indices.length > max) {
    lines.push(`  … +${indices.length - max} more`);
  }
  lines.push(
    "Fix: set replace_all=true to change every match, or add surrounding context lines so old_string is unique.",
  );
  return lines.join("\n");
}

/**
 * Line-trimmed match: search block matches when each corresponding line's
 * trim() is equal. Returns the original file span.
 */
function findLineTrimmed(content: string, find: string): MatchResult | null {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines.length === 0) return null;
  if (searchLines[searchLines.length - 1] === "") searchLines.pop();
  if (searchLines.length === 0) return null;

  const hits: Array<{ start: number; end: number }> = [];

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    let start = 0;
    for (let k = 0; k < i; k++) start += originalLines[k].length + 1;
    let end = start;
    for (let k = 0; k < searchLines.length; k++) {
      end += originalLines[i + k].length;
      if (k < searchLines.length - 1) end += 1;
    }
    hits.push({ start, end });
  }

  if (hits.length !== 1) return null;
  const { start, end } = hits[0];
  return {
    kind: "line_trimmed",
    matched: content.slice(start, end),
    index: start,
  };
}

/**
 * Block-anchor: first/last lines must trim-match; middle lines average
 * Levenshtein similarity ≥ threshold. Requires ≥3 search lines.
 */
function findBlockAnchor(content: string, find: string): MatchResult | null {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines[searchLines.length - 1] === "") searchLines.pop();
  if (searchLines.length < 3) return null;

  const first = searchLines[0].trim();
  const last = searchLines[searchLines.length - 1].trim();
  const searchSize = searchLines.length;
  const maxDelta = Math.max(1, Math.floor(searchSize * 0.25));

  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== first) continue;
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === last) {
        const size = j - i + 1;
        if (Math.abs(size - searchSize) <= maxDelta) {
          candidates.push({ startLine: i, endLine: j });
        }
        break;
      }
    }
  }
  if (!candidates.length) return null;

  const scored: Array<{ startLine: number; endLine: number; sim: number }> = [];
  for (const c of candidates) {
    const actualSize = c.endLine - c.startLine + 1;
    const midSearch = searchSize - 2;
    const midActual = actualSize - 2;
    if (midSearch <= 0) {
      scored.push({ ...c, sim: 1 });
      continue;
    }
    let sim = 0;
    const n = Math.min(midSearch, midActual);
    for (let k = 0; k < n; k++) {
      sim += lineSim(
        originalLines[c.startLine + 1 + k],
        searchLines[1 + k],
      );
    }
    sim /= n;
    if (sim >= BLOCK_SIMILARITY) scored.push({ ...c, sim });
  }
  if (scored.length !== 1) return null;

  const { startLine, endLine } = scored[0];
  let start = 0;
  for (let k = 0; k < startLine; k++) start += originalLines[k].length + 1;
  let end = start;
  for (let k = startLine; k <= endLine; k++) {
    end += originalLines[k].length;
    if (k < endLine) end += 1;
  }
  return {
    kind: "block_anchor",
    matched: content.slice(start, end),
    index: start,
  };
}

export function locateEdit(
  content: string,
  oldString: string,
  replaceAll: boolean,
):
  | { ok: true; result: MatchResult; count: number }
  | { ok: false; reason: string } {
  if (oldString === "") {
    return { ok: false, reason: "old_string cannot be empty for edit; use write_file for new files" };
  }

  if (replaceAll) {
    const count = findExactAll(content, oldString);
    if (count === 0) {
      // try line-trimmed single occurrence only for replace_all safety — skip fuzzy replace_all
      return {
        ok: false,
        reason: "old_string not found in file (replace_all requires exact matches)",
      };
    }
    return {
      ok: true,
      result: { kind: "exact", matched: oldString, index: content.indexOf(oldString) },
      count,
    };
  }

  const exactMulti = findExactAll(content, oldString);
  if (exactMulti === 1) {
    return {
      ok: true,
      result: { kind: "exact", matched: oldString, index: content.indexOf(oldString) },
      count: 1,
    };
  }
  if (exactMulti > 1) {
    const locs = formatMultiMatchLocations(content, oldString);
    return {
      ok: false,
      reason:
        "old_string matches multiple times; set replace_all or add context" +
        (locs ? `\n${locs}` : ""),
    };
  }

  const trimmed = findLineTrimmed(content, oldString);
  if (trimmed) {
    return { ok: true, result: trimmed, count: 1 };
  }

  const block = findBlockAnchor(content, oldString);
  if (block) {
    return { ok: true, result: block, count: 1 };
  }

  return { ok: false, reason: "old_string not found in file" };
}

/**
 * Content-oriented guidance when search_replace cannot locate old_string.
 * (Path typo hints are wrong here — the file already exists.)
 */
function numberedPasteGapNote(oldString: string): string | undefined {
  if (
    /\u2026 \d+ lines not shown \u2026/.test(oldString) ||
    /\.\.\. \d+ lines not shown \.\.\./.test(oldString)
  ) {
    return "copied lines are not a contiguous run (gap marker); copy one window only.";
  }
  const nums: number[] = [];
  for (const line of oldString.split("\n")) {
    if (line === "") continue;
    const m = line.match(/^(\s*)(\d+)\|(.*)$/);
    if (!m) return undefined;
    nums.push(Number(m[2]));
  }
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1]! + 1) {
      return `copied lines are not a contiguous run (gap at L${nums[i - 1]}→L${nums[i]}); copy one window only.`;
    }
  }
  return undefined;
}

export function editMissHint(content: string, oldString: string): string {
  if (content.length === 0) {
    return [
      "File is empty — search_replace needs existing text to match.",
      "Use write_file to create content, or confirm the path.",
    ].join("\n");
  }
  const parts: string[] = [
    "Closest current lines (N| prefixes are not file text — copy a contiguous numbered run):",
  ];
  const gapNote = numberedPasteGapNote(oldString);
  if (gapNote) parts.push(gapNote);
  // Mixed/partial read_file paste (not fully stripped) is a common miss cause.
  if (
    oldString.includes("|") &&
    /^\s*\d+\|/m.test(oldString) &&
    !stripReadFileLinePrefixes(oldString).stripped
  ) {
    parts.push(
      "Note: old_string looks like it may include read_file line-number prefixes (`12|…`). " +
        "Copy file text without the `N|` column (or paste a pure numbered block so Forge can strip it).",
    );
  }
  const fileLines = content.split("\n");
  const searchLines = oldString.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
  if (!searchLines.length || !fileLines.length) {
    parts.push("Add surrounding context so old_string is unique, or set replace_all.");
    return parts.join("\n");
  }

  // Prefer first non-empty search line as anchor for nearby suggestions
  const anchor =
    searchLines.find((l) => l.trim().length >= 3)?.trim() ||
    searchLines[0]?.trim() ||
    "";
  if (anchor.length >= 3) {
    const scored: Array<{ line: number; text: string; score: number }> = [];
    for (let i = 0; i < fileLines.length; i++) {
      const text = fileLines[i] ?? "";
      const trimmed = text.trim();
      if (!trimmed) continue;
      let score = stringSimilarity(anchor, trimmed);
      // Boost substring containment (model often drops indent or a token)
      const a = anchor.toLowerCase();
      const b = trimmed.toLowerCase();
      if (b.includes(a) || a.includes(b)) score = Math.max(score, 0.72);
      if (score >= 0.55) scored.push({ line: i + 1, text, score });
    }
    scored.sort((x, y) => y.score - x.score || x.line - y.line);
    const best = scored[0];
    if (best) {
      const start = Math.max(1, best.line - 8);
      const end = Math.min(fileLines.length, best.line + 8);
      for (let ln = start; ln <= end; ln++) {
        parts.push(`${String(ln).padStart(6)}|${fileLines[ln - 1] ?? ""}`);
      }
    }
  }
  parts.push("Add surrounding context so old_string is unique, or set replace_all.");

  // Multi-line: note first/last anchors if present alone
  if (searchLines.length >= 2) {
    const first = searchLines[0]!.trim();
    const last = searchLines[searchLines.length - 1]!.trim();
    const hasFirst = first && content.includes(first);
    const hasLast = last && content.includes(last);
    if (hasFirst && !hasLast) {
      parts.push(
        "Note: first line of old_string appears in the file, but the last line does not — the block may have drifted.",
      );
    } else if (!hasFirst && hasLast) {
      parts.push(
        "Note: last line of old_string appears in the file, but the first line does not — the block may have drifted.",
      );
    } else if (hasFirst && hasLast) {
      parts.push(
        "Note: first and last lines both appear, but the middle block did not match (whitespace or intervening edits).",
      );
    }
  }

  return parts.join("\n");
}

export function applyMatch(
  content: string,
  result: MatchResult,
  newString: string,
  replaceAll: boolean,
): string {
  if (replaceAll && result.kind === "exact") {
    return content.split(result.matched).join(newString);
  }
  return (
    content.slice(0, result.index) +
    newString +
    content.slice(result.index + result.matched.length)
  );
}

export function shortDiff(
  fileLabel: string,
  before: string,
  after: string,
  maxLines = 40,
): string {
  const a = before.split("\n");
  const b = after.split("\n");
  // Simple line-level unified-ish snippet
  const lines: string[] = [`--- a/${fileLabel}`, `+++ b/${fileLabel}`];
  let i = 0;
  let j = 0;
  let emitted = 0;
  while ((i < a.length || j < b.length) && emitted < maxLines) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    // skip equal prefix already handled; emit a window of changes
    while (i < a.length && (j >= b.length || a[i] !== b[j]) && emitted < maxLines) {
      lines.push(`-${a[i]}`);
      i++;
      emitted++;
    }
    while (j < b.length && (i >= a.length || a[i] !== b[j]) && emitted < maxLines) {
      lines.push(`+${b[j]}`);
      j++;
      emitted++;
    }
  }
  if (emitted >= maxLines) lines.push("… [diff truncated]");
  if (lines.length <= 2) return "(no line-level diff)";
  return lines.join("\n");
}
