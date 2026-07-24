/**
 * Managed tool-output truncation (OpenCode/Grok pattern):
 * when output exceeds line/byte limits, keep a head+tail preview and write the
 * full body under ~/.forge/tool-output/ so the model can re-read it.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { ensureDirAsync, forgeHome } from "../../util/fs.js";
import { truncateMiddle } from "../../util/format.js";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const BASH_MAX_CHARS = 80_000;

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

function toolOutputDir(): string {
  return path.join(forgeHome(), "tool-output");
}

export async function saveFullOutput(text: string): Promise<string> {
  const dir = toolOutputDir();
  await ensureDirAsync(dir);
  const name = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`;
  const file = path.join(dir, name);
  await fsp.writeFile(file, text, "utf8");
  return file;
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
