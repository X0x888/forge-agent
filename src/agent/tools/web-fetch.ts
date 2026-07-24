/**
 * Fetch a URL with SSRF protection, size/timeout limits, HTML→text.
 */
import type { ToolResult } from "./types.js";
import { assertUrlSafe } from "./ssrf.js";
import { boundToolOutput, DEFAULT_MAX_BYTES } from "./truncate.js";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

function htmlToText(html: string): string {
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
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

async function fetchOnce(
  url: URL,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function toolWebFetch(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const raw = String(args.url || "").trim();
  if (!raw) return { output: "url is required", isError: true };

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

  try {
    let current = await assertUrlSafe(raw, allowLocal);
    const headers: Record<string, string> = {
      "User-Agent": "ForgeAgent/0.9 (+https://github.com/forge-agent; web_fetch)",
      Accept:
        format === "html"
          ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1"
          : "text/markdown,text/plain,text/html;q=0.8,*/*;q=0.1",
      "Accept-Language": "en-US,en;q=0.9",
    };

    let resp: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      resp = await fetchOnce(current, timeoutMs, headers);
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
      return {
        output: `Response too large (Content-Length ${cl} > ${MAX_RESPONSE_BYTES})`,
        isError: true,
      };
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES) {
      return {
        output: `Response too large (${buf.length} bytes > ${MAX_RESPONSE_BYTES})`,
        isError: true,
      };
    }

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
    return {
      output: `web_fetch failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
