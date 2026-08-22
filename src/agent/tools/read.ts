import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { resolvePath, assertReadablePath, displayRelPath } from "./path-util.js";
import { pathNotFoundHint } from "./path-hints.js";
import { boundToolOutput, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.js";
import { numberFieldError } from "./arg-types.js";
import { fileReadGuardEnabled, FileReadState } from "./file-read-state.js";
import { isFalsy } from "../../util/bool.js";
import { REQUEST_PRUNE_OMITTED } from "../../session/request-prune.js";
import type { SessionData } from "../../session/session.js";
import type { ChatMessage } from "../../providers/types.js";
import {
  exploreMapWindow,
  formatExploreMapDeref,
  lookupExploreMapFile,
  readHasExplicitWindow,
} from "../../session/explore-map.js";

function noteRead(
  ctx: ToolContext,
  filePath: string,
  st: fs.Stats,
  extra?: { fullReadLines?: number },
): void {
  if (!ctx.fileReads || !fileReadGuardEnabled()) return;
  if (!st.isFile()) return;
  try {
    ctx.fileReads.note(filePath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      ...(typeof extra?.fullReadLines === "number"
        ? { fullReadLines: extra.fullReadLines }
        : {}),
    });
  } catch {
    /* best-effort */
  }
}

/** Prefix of the unchanged-read stub (also used to detect a prior stub). */
export const UNCHANGED_READ_STUB = "Unchanged since last read";

function unchangedReadStubEnabled(): boolean {
  const v = process.env.FORGE_UNCHANGED_READ_STUB;
  if (v === undefined || v === "") return true;
  return !isFalsy(v);
}

/**
 * True when this call is a full-file read (no offset/limit window).
 * limit=0 from line 1 is "all remaining" — still a full file.
 */
export function isFullFileReadArgs(args: Record<string, unknown>): boolean {
  const hasOffset =
    args.offset != null && String(args.offset).trim() !== "";
  const hasLimit = args.limit != null && String(args.limit).trim() !== "";
  if (!hasOffset && !hasLimit) return true;
  const offset = hasOffset ? Number(args.offset) : 1;
  const limit = hasLimit ? Number(args.limit) : -1;
  if (!Number.isFinite(offset) || offset > 1) return false;
  return hasLimit && limit === 0;
}

function pathMatchesReadArg(
  argPath: string,
  filePath: string,
  workspace: string,
): boolean {
  const a = argPath.trim();
  if (!a) return false;
  try {
    return FileReadState.key(path.resolve(workspace, a)) === FileReadState.key(filePath);
  } catch {
    return a === filePath;
  }
}

/**
 * True when the last read_file of this path is still a live (non-omitted,
 * non-stub) tool result in the session transcript.
 */
export function lastLiveFullReadPresent(
  session: Pick<SessionData, "messages"> | undefined,
  filePath: string,
  workspace: string,
): boolean {
  const messages: ChatMessage[] | undefined = session?.messages;
  if (!messages?.length) return false;

  const infoById = new Map<string, { path: string; full: boolean }>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const name = (tc.function?.name || "").toLowerCase();
      if (name !== "read_file" && name !== "read") continue;
      if (!tc.id) continue;
      try {
        const o = JSON.parse(tc.function.arguments || "{}") as Record<
          string,
          unknown
        >;
        const p =
          (typeof o.path === "string" && o.path) ||
          (typeof o.target_file === "string" && o.target_file) ||
          (typeof o.file === "string" && o.file) ||
          "";
        if (p.trim()) {
          infoById.set(tc.id, {
            path: p.trim(),
            full: isFullFileReadArgs(o),
          });
        }
      } catch {
        /* */
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    const info = m.tool_call_id ? infoById.get(m.tool_call_id) : undefined;
    if (!info || !pathMatchesReadArg(info.path, filePath, workspace)) {
      continue;
    }
    // Last read of this path was a window — do not stub a later full read.
    if (!info.full) return false;
    const body = m.content || "";
    if (
      body.startsWith(REQUEST_PRUNE_OMITTED) ||
      body.startsWith(UNCHANGED_READ_STUB)
    ) {
      return false;
    }
    return body.startsWith("File:");
  }
  return false;
}

function maybeUnchangedReadStub(
  args: Record<string, unknown>,
  ctx: ToolContext,
  filePath: string,
  st: fs.Stats,
): { output: string } | null {
  if (!unchangedReadStubEnabled()) return null;
  if (!ctx.fileReads || !isFullFileReadArgs(args)) return null;
  const stamp = ctx.fileReads.get(filePath);
  if (!stamp || typeof stamp.fullReadLines !== "number") return null;
  const drift = Math.abs(st.mtimeMs - stamp.mtimeMs);
  if (st.size !== stamp.size || drift > 1.5) return null;
  if (!lastLiveFullReadPresent(ctx.session, filePath, ctx.workspace)) {
    return null;
  }
  return {
    output: `${UNCHANGED_READ_STUB} (${stamp.fullReadLines} lines, same mtime).`,
  };
}

const DEFAULT_READ_LIMIT = 1000;
const MAX_LINE_LENGTH = 2000;
/** Soft size hint — still stream via offset/limit; avoid loading multi‑GB blobs blindly. */
const LARGE_FILE_BYTES = 2 * 1024 * 1024;
/**
 * Cap on chars collected from the streaming path (huge files). Keeps a
 * `limit=0` read of a 2 GB log from building a multi-GB string — the managed
 * output layer would only truncate it afterwards anyway.
 */
const STREAM_COLLECT_CAP = 1_000_000;

function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Binary sniff on the first 8KB without loading the file. */
async function sniffBinary(filePath: string): Promise<boolean> {
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    return isProbablyBinary(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

export interface StreamedLines {
  /** Collected lines (already capped to MAX_LINE_LENGTH with markers). */
  slice: string[];
  /** True when the stream reached EOF (totalLines is then exact). */
  complete: boolean;
  /** Lines seen before the stream stopped (exact total when complete). */
  seen: number;
  /** Stopped early because the collect cap was hit. */
  hitCap: boolean;
}

/**
 * Memory-safe line reader for huge files: chunk-split manually so a single
 * 1 GB line cannot balloon the heap (readline would buffer it whole).
 * Stops as soon as the requested window is filled unless `limit === 0`.
 */
export async function streamLines(
  filePath: string,
  offset: number,
  limit: number,
): Promise<StreamedLines> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const slice: string[] = [];
  let seen = 0;
  let buf = "";
  let skippingLongLine = false;
  let collectedChars = 0;
  let hitCap = false;
  let stopped = false;

  const pushLine = (rawLine: string): void => {
    seen += 1;
    if (seen < offset) return;
    if (limit > 0 && slice.length >= limit) return;
    if (collectedChars >= STREAM_COLLECT_CAP) {
      hitCap = true;
      return;
    }
    const line = rawLine.length > MAX_LINE_LENGTH
      ? rawLine.slice(0, MAX_LINE_LENGTH) + `... (line truncated to ${MAX_LINE_LENGTH} chars)`
      : rawLine;
    collectedChars += line.length;
    slice.push(line);
  };

  try {
    for await (const chunk of stream) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const piece = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (skippingLongLine) {
          skippingLongLine = false;
          continue; // discard remainder of an over-long line
        }
        // pushLine caps to MAX_LINE_LENGTH with a marker; pieces stay small
        // because the no-newline flush guard below bounds buf growth.
        pushLine(piece);
        if (hitCap || (limit > 0 && seen >= offset && slice.length >= limit)) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
      // Guard: no newline yet and the carried partial line is huge — flush a
      // capped preview once, then discard until that line finally ends.
      if (buf.length > MAX_LINE_LENGTH * 4) {
        if (!skippingLongLine) pushLine(buf.slice(0, MAX_LINE_LENGTH * 4));
        buf = "";
        skippingLongLine = true;
        if (hitCap || (limit > 0 && seen >= offset && slice.length >= limit)) {
          stopped = true;
          break;
        }
      }
    }
    if (!stopped && buf.length > 0 && !skippingLongLine) {
      pushLine(buf); // final line without trailing newline
    }
  } finally {
    stream.destroy();
  }
  return { slice, complete: !stopped, seen, hitCap };
}

/**
 * Validate offset/limit args. Returns an error message on invalid input
 * (fail closed), else `{ offset, limit }` where limit 0 = all remaining.
 */
function parseOffsetLimit(
  args: Record<string, unknown>,
): { offset: number; limit: number } | string {
  let offset = 1;
  if (args.offset != null && String(args.offset).trim() !== "") {
    const n = Number(args.offset);
    if (!Number.isFinite(n) || n < 1) {
      return numberFieldError(
        "read_file",
        "offset",
        args.offset,
        "Pass a positive 1-based line number (or omit for 1).",
      );
    }
    offset = Math.floor(n);
  }
  // limit: 0 = all remaining lines from offset (not coerced to DEFAULT via ||)
  let limit = DEFAULT_READ_LIMIT;
  if (args.limit != null && String(args.limit).trim() !== "") {
    const n = Number(args.limit);
    if (!Number.isFinite(n) || n < 0) {
      return numberFieldError(
        "read_file",
        "limit",
        args.limit,
        "Pass a non-negative integer (0 = all remaining from offset).",
      );
    }
    limit = Math.floor(n);
  }
  return { offset, limit };
}

export async function toolRead(
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
      output: `read_file error: path must be a string (got ${kind}).`,
      isError: true,
    };
  }
  const raw = String(args.path || "").trim();
  if (!raw) {
    return {
      output:
        "read_file error: path is required (non-empty string).\n" +
        'Example: { "path": "src/cli.ts", "offset": 1, "limit": 80 }\n' +
        "Use a workspace-relative path (not empty). Prefer list_dir/glob first if unsure.",
      isError: true,
    };
  }

  let filePath: string;
  try {
    filePath = await assertReadablePath(ctx.workspace, raw);
  } catch (err) {
    return {
      output: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    const hint = await pathNotFoundHint(resolvePath(ctx.workspace, raw), ctx.workspace);
    return {
      output: `File not found: ${raw}\n${hint}`,
      isError: true,
    };
  }

  if (stat.isDirectory()) {
    const entries = await fsp.readdir(filePath, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const lines = entries
      .filter((e) => e.name !== ".git" && e.name !== "node_modules")
      .slice(0, 500)
      .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`);
    const rel = displayRelPath(ctx.workspace, filePath);
    return {
      output: `Directory: ${rel}\n${lines.length ? lines.join("\n") : "(empty)"}`,
    };
  }

  // Mapped paths win over the unchanged-full-read stub — the parent
  // should get the claim + cited window, not "Unchanged since last read".
  let derefPrefix = "";
  let readArgs = args;
  if (ctx.session && !readHasExplicitWindow(args)) {
    const rel = displayRelPath(ctx.workspace, filePath);
    const hit =
      lookupExploreMapFile(ctx.session.meta, rel) ||
      lookupExploreMapFile(ctx.session.meta, filePath);
    if (hit) {
      if (hit.file.line == null) {
        return { output: formatExploreMapDeref(hit) };
      }
      const win = exploreMapWindow(hit.file.line);
      derefPrefix = formatExploreMapDeref(hit, { autoWindow: true }) + "\n\n";
      readArgs = { ...args, offset: win.offset, limit: win.limit };
    }
  }

  const unchanged = maybeUnchangedReadStub(readArgs, ctx, filePath, stat);
  if (unchanged) return unchanged;

  // Huge files: stream only the requested window — never materialize a
  // multi-GB buffer+string (OOM kills the whole CLI mid-session).
  if (stat.size > LARGE_FILE_BYTES) {
    if (await sniffBinary(filePath)) {
      return {
        output: `Binary file (${stat.size} bytes): ${displayRelPath(ctx.workspace, filePath)}. Cannot display as text.`,
        isError: true,
      };
    }
    const parsed = parseOffsetLimit(readArgs);
    if (typeof parsed === "string") {
      return { output: parsed, isError: true };
    }
    const rel = displayRelPath(ctx.workspace, filePath);
    const largeHint = `; ${stat.size} bytes — prefer smaller limit/offset or grep for targeted reads`;
    const { slice, complete, seen, hitCap } = await streamLines(
      filePath,
      parsed.offset,
      parsed.limit,
    );
    if (slice.length === 0) {
      if (complete && seen === 0) {
        return {
          output: derefPrefix + `File: ${rel} (empty file — 0 lines${largeHint})`,
        };
      }
      return {
        output:
          derefPrefix +
          `File: ${rel}${complete ? ` (${seen} lines)` : ""}\n` +
          `Offset ${parsed.offset} is past end of file${complete ? ` (last line ${seen})` : ""}. ` +
          `Use offset=1${largeHint}.`,
      };
    }
    const end = parsed.offset + slice.length - 1;
    const more = !complete || hitCap;
    const numbered = slice
      .map((l, i) => `${String(parsed.offset + i).padStart(6)}|${l}`)
      .join("\n");
    const header =
      `File: ${rel} (${complete ? `${seen} lines, ` : ""}showing ${parsed.offset}-${end}` +
      (more ? `; use offset=${end + 1} for more` : "") +
      `${hitCap ? "; collect cap hit" : ""}${largeHint}` +
      `${more ? ". If you already have the lines you will change, search_replace now — do not page in tiny slices" : ""})\n`;
    const managed = await boundToolOutput(header + numbered, {
      maxLines: DEFAULT_MAX_LINES + 5,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    noteRead(
      ctx,
      filePath,
      stat,
      isFullFileReadArgs(readArgs) && complete
        ? { fullReadLines: seen }
        : undefined,
    );
    return { output: derefPrefix + managed.text };
  }

  const buf = await fsp.readFile(filePath);
  if (isProbablyBinary(buf)) {
    return {
      output: `Binary file (${stat.size} bytes): ${displayRelPath(ctx.workspace, filePath)}. Cannot display as text.`,
      isError: true,
    };
  }

  const content = buf.toString("utf8");
  // "" and files that are only a trailing feel empty to experts; keep a single
  // "" split as one blank line when content is non-empty ("\n" → 2 lines).
  const lines = content === "" ? [] : content.split("\n");
  const parsed = parseOffsetLimit(readArgs);
  if (typeof parsed === "string") {
    return { output: parsed, isError: true };
  }
  const offset = parsed.offset;
  const limit =
    parsed.limit === 0
      ? Math.max(0, lines.length - (offset - 1))
      : parsed.limit;
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice
    .map((l, i) => {
      const line =
        l.length > MAX_LINE_LENGTH
          ? l.slice(0, MAX_LINE_LENGTH) + `... (line truncated to ${MAX_LINE_LENGTH} chars)`
          : l;
      return `${String(offset + i).padStart(6)}|${line}`;
    })
    .join("\n");

  const rel = displayRelPath(ctx.workspace, filePath);
  const largeHint =
    stat.size >= LARGE_FILE_BYTES
      ? `; ${stat.size} bytes — prefer smaller limit/offset or grep for targeted reads`
      : "";

  // Past-EOF / empty-slice: do not claim "showing 100-99" or "(empty file)" for non-empty files.
  // Still note the read — the agent observed the file exists (and its size/mtime).
  if (slice.length === 0) {
    noteRead(
      ctx,
      filePath,
      stat,
      isFullFileReadArgs(readArgs) && lines.length === 0
        ? { fullReadLines: 0 }
        : undefined,
    );
    if (lines.length === 0) {
      return {
        output: derefPrefix + `File: ${rel} (empty file — 0 lines${largeHint})`,
      };
    }
    return {
      output:
        derefPrefix +
        `File: ${rel} (${lines.length} lines)\n` +
        `Offset ${offset} is past end of file (last line ${lines.length}). ` +
        `Use offset=1 or offset<=${lines.length}${largeHint}.`,
    };
  }

  const end = offset + slice.length - 1;
  const more = offset - 1 + slice.length < lines.length;
  const header =
    `File: ${rel} (${lines.length} lines, showing ${offset}-${end}` +
    (more ? `; use offset=${end + 1} for more` : "") +
    `${largeHint}` +
    `${more ? ". If you already have the lines you will change, search_replace now — do not page in tiny slices" : ""})\n`;

  const body = header + numbered;
  const managed = await boundToolOutput(body, {
    maxLines: DEFAULT_MAX_LINES + 5,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  noteRead(
    ctx,
    filePath,
    stat,
    isFullFileReadArgs(readArgs) ? { fullReadLines: lines.length } : undefined,
  );
  return { output: derefPrefix + managed.text };
}
