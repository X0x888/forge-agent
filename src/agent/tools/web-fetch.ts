/**
 * Fetch a URL with SSRF protection, size/timeout limits, HTML→text.
 * Honors ToolContext.signal so Ctrl+C / FORGE_MAX_RUN_MS cancel in-flight fetches.
 */
import type { ToolContext, ToolResult } from "./types.js";
import { assertUrlSafe } from "./ssrf.js";
import { boundToolOutput, DEFAULT_MAX_BYTES } from "./truncate.js";
import { mergeAbortSignals } from "../../util/abort.js";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!err || typeof err !== "object") return false;
  const name = String((err as { name?: string }).name || "");
  const msg = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || /aborted/i.test(msg) || msg === "Aborted";
}

/** Safe code point → string; invalid / out-of-range entities keep original text. */
function decodeCodePoint(n: number, original: string): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return original;
  // Surrogate halves are not valid Unicode scalar values
  if (n >= 0xd800 && n <= 0xdfff) return original;
  try {
    return String.fromCodePoint(n);
  } catch {
    return original;
  }
}

/**
 * Strip tags + decode common entities for web_fetch text/markdown mode.
 * Exported for unit tests (malformed entities must never throw).
 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|hr)[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (full, h: string) =>
      decodeCodePoint(parseInt(h, 16), full),
    )
    .replace(/&#(\d+);/g, (full, d: string) =>
      decodeCodePoint(Number(d), full),
    );
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

async function fetchOnce(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers,
    redirect: "manual",
    signal,
  });
}

/**
 * Read response body with a hard byte cap. Stops as soon as maxBytes is exceeded
 * so a missing/lying Content-Length cannot OOM the process.
 */
export async function readBodyCapped(
  resp: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ buf: Buffer; tooLarge: boolean }> {
  if (!resp.body) {
    const ab = await resp.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length > maxBytes) return { buf: Buffer.alloc(0), tooLarge: true };
    return { buf, tooLarge: false };
  }
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) {
        try {
          await reader.cancel();
        } catch {
          /* */
        }
        const abortErr = new Error("Aborted");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* */
        }
        return { buf: Buffer.alloc(0), tooLarge: true };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* */
    }
  }
  return { buf: Buffer.concat(chunks, total), tooLarge: false };
}

export async function toolWebFetch(
  args: Record<string, unknown>,
  ctx: ToolContext = { workspace: process.cwd() },
): Promise<ToolResult> {
  const raw = String(args.url || "").trim();
  if (!raw) return { output: "url is required", isError: true };
  if (ctx.signal?.aborted) return { output: "Aborted", isError: true };

  const format = String(args.format || "markdown").toLowerCase();
  const allowLocal = Boolean(args.allow_local);
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(
      1000,
      Number(args.timeout_ms) ||
        (args.timeout ? Number(args.timeout) * 1000 : DEFAULT_TIMEOUT_MS),
    ),
  );

  // Keep merged signal alive through body read (not just headers).
  const { signal, dispose } = mergeAbortSignals(ctx.signal, timeoutMs);
  try {
    let current = await assertUrlSafe(raw, allowLocal);
    const headers: Record<string, string> = {
      "User-Agent": "ForgeAgent/0.9 (+https://github.com/X0x888/forge-agent; web_fetch)",
      Accept:
        format === "html"
          ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1"
          : "text/markdown,text/plain,text/html;q=0.8,*/*;q=0.1",
      "Accept-Language": "en-US,en;q=0.9",
    };

    let resp: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (signal.aborted) return { output: "Aborted", isError: true };
      resp = await fetchOnce(current, headers, signal);
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (!loc) {
          return {
            output: `web_fetch redirect ${resp.status} without Location from ${current.href}`,
            isError: true,
          };
        }
        const next = new URL(loc, current);
        current = await assertUrlSafe(next.href, allowLocal);
        continue;
      }
      break;
    }
    if (!resp) return { output: "web_fetch failed: no response", isError: true };

    if (!resp.ok) {
      return {
        output: `web_fetch HTTP ${resp.status} for ${current.href}`,
        isError: true,
      };
    }

    const cl = resp.headers.get("content-length");
    if (cl && Number(cl) > MAX_RESPONSE_BYTES) {
      // Cancel body so the connection is not held open
      try {
        await resp.body?.cancel();
      } catch {
        /* */
      }
      return {
        output: `Response too large (Content-Length ${cl} > ${MAX_RESPONSE_BYTES})`,
        isError: true,
      };
    }

    // Stream with a hard byte cap — never trust Content-Length alone (missing/lying).
    const body = await readBodyCapped(resp, MAX_RESPONSE_BYTES, signal);
    if (signal.aborted) return { output: "Aborted", isError: true };
    if (body.tooLarge) {
      return {
        output: `Response too large (> ${MAX_RESPONSE_BYTES} bytes)`,
        isError: true,
      };
    }
    const buf = body.buf;

    const ctype = (resp.headers.get("content-type") || "").toLowerCase();
    if (
      ctype.includes("image/") ||
      ctype.includes("audio/") ||
      ctype.includes("video/") ||
      ctype.includes("application/octet-stream") ||
      ctype.includes("application/pdf") ||
      ctype.includes("application/zip")
    ) {
      return {
        output: `Unsupported content-type for text extraction: ${ctype || "unknown"} (${buf.length} bytes)`,
        isError: true,
      };
    }

    let text = buf.toString("utf8");
    const isHtml =
      ctype.includes("html") ||
      /^\s*<(!doctype\s+html|html[\s>])/i.test(text.slice(0, 256));

    if (format === "html") {
      /* keep raw */
    } else if (isHtml || format === "markdown" || format === "text") {
      text = htmlToText(text);
    }

    const header =
      `URL: ${current.href}\n` +
      `Status: ${resp.status}\n` +
      `Content-Type: ${ctype || "unknown"}\n` +
      `Bytes: ${buf.length}\n\n`;

    const managed = await boundToolOutput(header + text, {
      maxBytes: Math.max(DEFAULT_MAX_BYTES, 80 * 1024),
      maxLines: 3000,
    });
    return { output: managed.text };
  } catch (err) {
    if (isAbortLike(err, signal) || isAbortLike(err, ctx.signal)) {
      return { output: "Aborted", isError: true };
    }
    return {
      output: `web_fetch failed: ${(err as Error).message}`,
      isError: true,
    };
  } finally {
    dispose();
  }
}
