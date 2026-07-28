/**
 * Best-effort web search without an API key.
 * 1) DuckDuckGo Instant Answer JSON
 * 2) DuckDuckGo HTML lite scrape (titles + links) when IA is empty
 */
import type { ToolContext, ToolResult } from "./types.js";
import { boundToolOutput } from "./truncate.js";
import { mergeAbortSignals } from "../../util/abort.js";
import { readBodyCapped } from "./web-fetch.js";
import { numberFieldError } from "./arg-types.js";

const UA = "ForgeAgent/0.9 (+https://github.com/X0x888/forge-agent; web_search)";
const SEARCH_TIMEOUT_MS = 15_000;
/** Cap HTML scrape body so a hostile/huge page cannot OOM the process. */
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!err || typeof err !== "object") return false;
  const name = String((err as { name?: string }).name || "");
  const msg = err instanceof Error ? err.message : String(err);
  return (
    name === "AbortError" ||
    /aborted/i.test(msg) ||
    msg === "Aborted"
  );
}

export async function toolWebSearch(
  args: Record<string, unknown>,
  ctx: ToolContext = { workspace: process.cwd() },
): Promise<ToolResult> {
  if (args.query != null && typeof args.query !== "string") {
    const kind =
      args.query === null
        ? "null"
        : Array.isArray(args.query)
          ? "array"
          : typeof args.query;
    return {
      output: `web_search error: query must be a string (got ${kind}).`,
      isError: true,
    };
  }
  const query = String(args.query || "").trim();
  if (!query) {
    return {
      output:
        "web_search error: query is required (non-empty string).\n" +
        'Example: { "query": "forge cli session export json", "num_results": 5 }',
      isError: true,
    };
  }
  // Validate num_results before abort short-circuit so bad args are never masked.
  // num_results: default 5, clamp 1–10. Explicit invalid fails closed.
  // all|max|full → 10 (cap), parity with news count aliases.
  let n = 5;
  if (args.num_results != null && String(args.num_results).trim() !== "") {
    const key = String(args.num_results).trim().toLowerCase();
    if (key === "all" || key === "max" || key === "full") {
      n = 10;
    } else {
      const raw = Number(key);
      if (!Number.isFinite(raw) || raw < 1 || !/^\d+$/.test(key)) {
        return {
          output:
            numberFieldError(
              "web_search",
              "num_results",
              args.num_results,
              "Pass an integer 1–10 or all|max|full (default 5).",
            ),
          isError: true,
        };
      }
      n = Math.min(10, Math.floor(raw));
    }
  }
  if (ctx.signal?.aborted) return { output: "Aborted", isError: true };

  try {
    const ia = await duckDuckGoInstantAnswer(query, n, ctx.signal);
    if (ctx.signal?.aborted) return { output: "Aborted", isError: true };
    if (ia.length) {
      const managed = await boundToolOutput(ia.join("\n\n"));
      return { output: managed.text };
    }

    const html = await duckDuckGoHtmlLite(query, n, ctx.signal);
    if (ctx.signal?.aborted) return { output: "Aborted", isError: true };
    if (html.length) {
      const managed = await boundToolOutput(
        [
          `## Search results for ${query}`,
          ...html.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`),
          "",
          "_Source: DuckDuckGo HTML (no API key). Prefer web_fetch on promising URLs._",
        ].join("\n"),
      );
      return { output: managed.text };
    }

    return {
      output:
        `No structured results for "${query}". Try a more specific query, ` +
        `or open a known docs URL with web_fetch when network is allowed.`,
    };
  } catch (err) {
    if (isAbortLike(err, ctx.signal)) {
      return { output: "Aborted", isError: true };
    }
    return {
      output:
        `web_search failed: ${(err as Error).message}\n` +
        "Retry with a simpler query, check network, or open a known docs URL with web_fetch.",
      isError: true,
    };
  }
}

async function duckDuckGoInstantAnswer(
  query: string,
  n: number,
  external?: AbortSignal,
): Promise<string[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const { signal, dispose } = mergeAbortSignals(external, SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: Array<{
        Text?: string;
        FirstURL?: string;
        Topics?: Array<{ Text?: string; FirstURL?: string }>;
      }>;
      Results?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const lines: string[] = [];
    if (data.Heading || data.AbstractText) {
      lines.push(
        `## ${data.Heading || query}\n${data.AbstractText || ""}\n${data.AbstractURL || ""}`.trim(),
      );
    }
  const push = (text?: string, href?: string) => {
      if (lines.length >= n + 1) return;
      if (text && href) lines.push(`- ${text}\n  ${href}`);
    };
    for (const item of data.RelatedTopics || []) {
      push(item.Text, item.FirstURL);
      if (item.Topics) {
        for (const t of item.Topics) push(t.Text, t.FirstURL);
      }
    }
    for (const item of data.Results || []) push(item.Text, item.FirstURL);
    return lines;
  } finally {
    dispose();
  }
}

interface HtmlHit {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * Parse DuckDuckGo html.duckduckgo.com lite results.
 * Deliberately conservative — only extract result anchors we recognize.
 */
async function duckDuckGoHtmlLite(
  query: string,
  n: number,
  external?: AbortSignal,
): Promise<HtmlHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { signal, dispose } = mergeAbortSignals(external, SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html",
      },
      signal,
      redirect: "follow",
    });
    if (!resp.ok) return [];
    const body = await readBodyCapped(resp, MAX_HTML_BYTES, signal);
    if (body.tooLarge) return [];
    return parseDdgHtml(body.buf.toString("utf8"), n);
  } finally {
    dispose();
  }
}

/** Exported for unit tests. */
export function parseDdgHtml(html: string, n: number): HtmlHit[] {
  const hits: HtmlHit[] = [];
  // Classic DDG HTML: <a rel="nofollow" class="result__a" href="...">Title</a>
  const re =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < n) {
    const rawHref = decodeHtml(m[1]);
    const title = stripTags(decodeHtml(m[2])).trim();
    const href = unwrapDdgRedirect(rawHref);
    if (!title || !href || !/^https?:\/\//i.test(href)) continue;
    if (hits.some((h) => h.url === href)) continue;
    hits.push({ title, url: href });
  }

  // Snippets (best-effort, aligned by order)
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snips: string[] = [];
  while ((m = snipRe.exec(html)) && snips.length < n) {
    snips.push(stripTags(decodeHtml(m[1])).trim());
  }
  // alternate snippet class
  if (!snips.length) {
    const snipRe2 = /class="result__snippet"[^>]*>([\s\S]*?)<\//gi;
    while ((m = snipRe2.exec(html)) && snips.length < n) {
      snips.push(stripTags(decodeHtml(m[1])).trim());
    }
  }
  for (let i = 0; i < hits.length && i < snips.length; i++) {
    if (snips[i]) hits[i].snippet = snips[i].slice(0, 240);
  }
  return hits;
}

function unwrapDdgRedirect(href: string): string {
  try {
    // Relative paths are DDG chrome — not real results
    if (href.startsWith("/") && !href.startsWith("//")) return "";
    const u = new URL(href, "https://duckduckgo.com");
    // //duckduckgo.com/l/?uddg=<encoded>
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (u.hostname.includes("duckduckgo.com") && u.pathname === "/l/") {
      const q = u.searchParams.get("uddg");
      if (q) return decodeURIComponent(q);
    }
    // Drop leftover DDG host links (ads/chrome)
    if (u.hostname.includes("duckduckgo.com")) return "";
    return u.href;
  } catch {
    return href.startsWith("http") ? href : "";
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}
