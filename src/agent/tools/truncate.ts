/**
 * Managed tool-output truncation (OpenCode/Grok pattern):
 * when output exceeds line/byte limits, keep a head+tail preview and write the
 * full body under ~/.forge/tool-output/ so the model can re-read it.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ensureDirAsync, forgeHome } from "../../util/fs.js";
import { truncateMiddle } from "../../util/format.js";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const BASH_MAX_CHARS = 80_000;
/** Keep newest N full-output dumps (experts generate many during ULW). */
export const DEFAULT_TOOL_OUTPUT_KEEP = 80;
/** Also drop dumps older than this many days. */
export const DEFAULT_TOOL_OUTPUT_MAX_AGE_DAYS = 14;

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
  /** Soft char cap used for bash-style middle truncate before managed save */
  maxChars?: number;
  prefix?: string;
}

export interface ManagedOutput {
  text: string;
  truncated: boolean;
  outputPath?: string;
}

export function toolOutputDir(): string {
  return path.join(forgeHome(), "tool-output");
}

export async function saveFullOutput(text: string): Promise<string> {
  const dir = toolOutputDir();
  await ensureDirAsync(dir);
  // Best-effort prune so long ULW sessions don't fill the disk
  try {
    pruneToolOutputsSync();
  } catch {
    /* never block a tool on prune */
  }
  const name = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`;
  const file = path.join(dir, name);
  await fsp.writeFile(file, text, "utf8");
  return file;
}

export interface ToolOutputStats {
  dir: string;
  files: number;
  bytes: number;
}

/** Sync stats for doctor / CLI (best-effort). */
export function toolOutputStats(): ToolOutputStats {
  const dir = toolOutputDir();
  let files = 0;
  let bytes = 0;
  try {
    if (!fs.existsSync(dir)) return { dir, files: 0, bytes: 0 };
    for (const name of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, name));
        if (!st.isFile()) continue;
        files += 1;
        bytes += st.size;
      } catch {
        /* */
      }
    }
  } catch {
    /* */
  }
  return { dir, files, bytes };
}

export interface PruneToolOutputsResult {
  deleted: number;
  kept: number;
  freedBytes: number;
}

/**
 * Prune ~/.forge/tool-output dumps: keep newest `keep`, drop older than maxAgeDays.
 */
export function pruneToolOutputsSync(opts?: {
  keep?: number;
  maxAgeDays?: number;
}): PruneToolOutputsResult {
  // 0 is valid (delete all eligible dumps). NaN/negative → default.
  const keepRaw = opts?.keep;
  const keep =
    typeof keepRaw === "number" && Number.isFinite(keepRaw) && keepRaw >= 0
      ? Math.floor(keepRaw)
      : DEFAULT_TOOL_OUTPUT_KEEP;
  const maxAgeDays = opts?.maxAgeDays ?? DEFAULT_TOOL_OUTPUT_MAX_AGE_DAYS;
  const dir = toolOutputDir();
  if (!fs.existsSync(dir)) {
    return { deleted: 0, kept: 0, freedBytes: 0 };
  }
  const cutoff =
    maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : 0;
  type Entry = { name: string; path: string; mtime: number; size: number };
  const entries: Entry[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      entries.push({ name, path: p, mtime: st.mtimeMs, size: st.size });
    } catch {
      /* */
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  let deleted = 0;
  let freedBytes = 0;
  entries.forEach((e, i) => {
    const tooOld = cutoff > 0 && e.mtime < cutoff;
    const overKeep = i >= keep;
    if (tooOld || overKeep) {
      try {
        fs.unlinkSync(e.path);
        deleted += 1;
        freedBytes += e.size;
      } catch {
        /* */
      }
    }
  });
  return {
    deleted,
    kept: entries.length - deleted,
    freedBytes,
  };
}

/** Hard byte cap that survives multibyte text (middle-out, UTF-8 tolerant). */
function capToBytes(s: string, maxBytes: number): string {
  const byteLen = Buffer.byteLength(s, "utf8");
  if (byteLen <= maxBytes) return s;
  const buf = Buffer.from(s, "utf8");
  const headBytes = Math.floor(maxBytes * 0.6);
  const tailBytes = Math.max(0, maxBytes - headBytes - 64);
  const head = buf.subarray(0, headBytes).toString("utf8");
  const tail = tailBytes > 0 ? buf.subarray(buf.length - tailBytes).toString("utf8") : "";
  return `${head}\n… [middle omitted to fit ${maxBytes}-byte cap] …\n${tail}`;
}

/**
 * Bound model-facing output. If over limits, persist full text and return a
 * preview with a pointer. Always UTF-8 safe via string ops on JS strings.
 */
export async function boundToolOutput(
  text: string,
  opts: TruncateOptions = {},
): Promise<ManagedOutput> {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxChars = opts.maxChars;
  const prefix = opts.prefix ?? "";

  const body = prefix + text;
  const lines = body.split("\n");
  const byteLen = Buffer.byteLength(body, "utf8");
  const overLines = lines.length > maxLines;
  const overBytes = byteLen > maxBytes;
  const overChars = maxChars !== undefined && body.length > maxChars;

  if (!overLines && !overBytes && !overChars) {
    return { text: body, truncated: false };
  }

  const outputPath = await saveFullOutput(body);
  let preview: string;
  if (overChars && maxChars) {
    preview = truncateMiddle(body, maxChars);
    // maxChars is a *char* cap — multibyte output can still blow past
    // maxBytes (100k CJK chars ≈ 240KB > 50KB cap). Re-check bytes like the
    // line branch does.
    if (Buffer.byteLength(preview, "utf8") > maxBytes) {
      preview = truncateMiddle(preview, Math.floor(maxBytes * 0.9));
    }
  } else {
    const headLines = Math.min(Math.floor(maxLines * 0.7), lines.length);
    const tailLines = Math.min(Math.floor(maxLines * 0.25), lines.length - headLines);
    const head = lines.slice(0, headLines).join("\n");
    const tail = tailLines > 0 ? lines.slice(-tailLines).join("\n") : "";
    preview =
      head +
      (tail
        ? `\n\n… [${lines.length - headLines - tailLines} lines omitted] …\n\n` + tail
        : `\n\n… [truncated] …`);
    if (Buffer.byteLength(preview, "utf8") > maxBytes) {
      preview = truncateMiddle(preview, Math.floor(maxBytes * 0.9));
    }
  }
  // Final byte-level guarantee (truncateMiddle counts chars, not bytes).
  preview = capToBytes(preview, maxBytes);

  const footer =
    `\n\n[Output truncated — full ${byteLen} bytes / ${lines.length} lines saved to ${outputPath}. ` +
    `Use read_file on that path if you need more.]`;

  return {
    text: preview + footer,
    truncated: true,
    outputPath,
  };
}

/** Sync middle truncate for hot paths that cannot await (prefer boundToolOutput). */
export function truncateSync(text: string, max = BASH_MAX_CHARS): string {
  return truncateMiddle(text, max);
}
