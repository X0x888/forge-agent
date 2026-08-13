/**
 * Expand `@path` / `@path/to/file` mentions in user text by inlining file
 * contents (Claude Code / Codex / OpenCode style). Images stay on the
 * multimodal path in user-images.ts.
 *
 * Safety:
 *  - workspace-relative only (no `..`, no absolute outside workspace)
 *  - skip binaries / oversize
 *  - optional FileReadState.note so the edit guard treats the mention as a read
 */
import fs from "node:fs";
import path from "node:path";
import { isImagePath } from "./user-images.js";
import type { FileReadState } from "../agent/tools/file-read-state.js";

const MENTION_RE =
  /(?<![A-Za-z0-9_/])@(?:((?:[\w.+-]+\/)*[\w.+-]+(?:\.\w+)?)|"((?:[^"\n]|\\"){1,240})"|'((?:[^'\n]|\\'){1,240})')/g;
const MAX_INLINE_BYTES = 64 * 1024;
const MAX_MENTIONS = 8;

export type MentionHit = {
  raw: string;
  rel: string;
  abs: string;
};

export function extractPathMentions(
  text: string,
  workspace: string,
): MentionHit[] {
  const hits: MentionHit[] = [];
  const seen = new Set<string>();
  const root = path.resolve(workspace);
  for (const m of text.matchAll(MENTION_RE)) {
    const raw = (m[1] || m[2] || m[3] || "").replace(/\\(["'])/g, "$1");
    if (!raw || isImagePath(raw)) continue;
    if (raw.includes("..") || path.isAbsolute(raw)) continue;
    const abs = path.resolve(root, raw);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const key = rel.split(path.sep).join("/");
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ raw, rel: key, abs });
    if (hits.length >= MAX_MENTIONS) break;
  }
  return hits;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Stamp FileReadState for @path hits (resume / already-expanded messages). */
export function stampMentionReads(
  text: string,
  workspace: string,
  fileReads?: FileReadState,
): void {
  if (!fileReads || !workspace || !text.includes("@")) return;
  for (const hit of extractPathMentions(text, workspace)) {
    try {
      const st = fs.statSync(hit.abs);
      if (!st.isFile() || st.size > MAX_INLINE_BYTES) continue;
      fileReads.note(hit.abs, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* */
    }
  }
}

export function expandUserMentions(
  text: string,
  workspace: string,
  fileReads?: FileReadState,
): string {
  if (!text.includes("@") || !workspace) return text;
  if (text.includes("[User @path mentions")) {
    stampMentionReads(text, workspace, fileReads);
    return text;
  }
  const hits = extractPathMentions(text, workspace);
  if (!hits.length) return text;

  const blocks: string[] = [];
  for (const hit of hits) {
    let st: fs.Stats;
    try {
      st = fs.statSync(hit.abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_INLINE_BYTES) {
      blocks.push(
        `--- @${hit.rel} (${st.size} bytes, too large to inline; use read_file) ---`,
      );
      continue;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(hit.abs);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const body = buf.toString("utf8");
    if (body.includes("\0")) continue;
    try {
      fileReads?.note(hit.abs, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* */
    }
    const numbered = body
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(6, " ")}|${line}`)
      .join("\n");
    blocks.push(`--- @${hit.rel} ---\n${numbered}`);
  }
  if (!blocks.length) return text;
  return `${text}\n\n[User @path mentions — treat as already-read]\n${blocks.join("\n\n")}`;
}
