/**
 * Best-effort web search. Optional API keys (Brave / Tavily / Exa / SearXNG)
 * first; DuckDuckGo Instant Answer plus DDG/Brave/Bing HTML in parallel as
 * the key-free fallback. A short in-process cache avoids repeating the same
 * query in one run. FORGE_WEB_SEARCH_CACHE=0 disables the cache.
 */
import type { ToolContext, ToolResult } from "./types.js";
import { boundToolOutput } from "./truncate.js";
import { numberFieldError } from "./arg-types.js";
import { isFalsy } from "../../util/bool.js";
import {
  configuredSearchProviders,
  decodeHtml,
  parseDdgHtml,
  searchWeb,
} from "./web-search-providers.js";
import {
  githubEnabled,
  githubReposFromUrls,
  queryLooksLikeGithubLookup,
  toolGithub,
} from "./github.js";

export { decodeHtml, parseDdgHtml };

const CACHE_TTL_MS = 120_000;
const CACHE_MAX = 32;
const cache = new Map<string, { at: number; text: string }>();

function cacheEnabled(): boolean {
  return !isFalsy(process.env.FORGE_WEB_SEARCH_CACHE);
}

function cacheGet(key: string): string | undefined {
  if (!cacheEnabled()) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.text;
}

function cacheSet(key: string, text: string): void {
  if (!cacheEnabled()) return;
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { at: Date.now(), text });
}

/** Test helper. */
export function _resetWebSearchCache(): void {
  cache.clear();
}

function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!err || typeof err !== "object") return false;
  const name = String((err as { name?: string }).name || "");
  const msg = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || /aborted/i.test(msg) || msg === "Aborted";
}

function githubFollowUp(urls: string[]): string {
  const repos = githubReposFromUrls(urls);
  if (!repos.length) return "";
  const shown = repos.slice(0, 5).join(", ");
  const more = repos.length > 5 ? ` (+${repos.length - 5} more)` : "";
  return (
    `\n\nGitHub repos in these hits: ${shown}${more}. ` +
    `Read them with the github tool (action=readme|contents|tree) — do not scrape github.com.`
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
        'Example: { "query": "forge cli session export json", "num_results": 5 }\n' +
        "Whitespace-only queries fail closed. Prefer a concrete search phrase (docs/API/error text).",
      isError: true,
    };
  }
  let n = 5;
  if (args.num_results != null && String(args.num_results).trim() !== "") {
    const key = String(args.num_results).trim().toLowerCase();
    if (key === "all" || key === "max" || key === "full") {
      n = 10;
    } else {
      const raw = Number(key);
      if (!Number.isFinite(raw) || raw < 1 || !/^\d+$/.test(key)) {
        return {
          output: numberFieldError(
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

  const cacheKey = `${n}\n${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { output: cached };

  try {
    const wantGithub =
      githubEnabled() && queryLooksLikeGithubLookup(query);
    const [web, gh] = await Promise.all([
      searchWeb(query, n, ctx.signal),
      wantGithub
        ? toolGithub({ action: "search", query, num_results: n }, ctx)
        : Promise.resolve(null),
    ]);
    if (ctx.signal?.aborted) return { output: "Aborted", isError: true };
    const { hits, source } = web;
    if (!hits.length && !(gh && !gh.isError && gh.output.trim())) {
      const tip = wantGithub
        ? " For a GitHub repository use the github tool (action=search|contents|readme)."
        : "";
      return {
        output:
          `No structured results for "${query}". Try a more specific query, ` +
          `or open a known docs URL with web_fetch when network is allowed.` +
          tip,
      };
    }

    const lines = [
      `## Search results for ${query}`,
      ...hits.map(
        (r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
      ),
    ];
    if (gh && !gh.isError && gh.output.trim()) {
      lines.push("", gh.output.trim());
    }
    lines.push(
      "",
      `_Source: ${source}. Prefer web_fetch on promising URLs; github tool for github.com source. Providers: ${configuredSearchProviders().join(", ")}.`,
    );
    const follow = githubFollowUp(hits.map((h) => h.url));
    const text = lines.join("\n") + follow;
    const managed = await boundToolOutput(text);
    cacheSet(cacheKey, managed.text);
    return { output: managed.text };
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
