import type { ToolResult } from "./types.js";
import { boundToolOutput } from "./truncate.js";

export async function toolWebSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query || "").trim();
  if (!query) return { output: "query is required", isError: true };
  const n = Math.min(10, Math.max(1, Number(args.num_results) || 5));

  // DuckDuckGo instant answer API (no key). Best-effort; not a full SERP.
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "ForgeAgent/0.6" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      return { output: `web_search HTTP ${resp.status}`, isError: true };
    }
    const data = (await resp.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: unknown[] }>;
      Results?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const lines: string[] = [];
    if (data.Heading || data.AbstractText) {
      lines.push(
        `## ${data.Heading || query}\n${data.AbstractText || ""}\n${data.AbstractURL || ""}`.trim(),
      );
    }
    const related = data.RelatedTopics || [];
    for (const item of related) {
      if (lines.length >= n + 1) break;
      if (item.Text && item.FirstURL) {
        lines.push(`- ${item.Text}\n  ${item.FirstURL}`);
      }
    }
    for (const item of data.Results || []) {
      if (lines.length >= n + 1) break;
      if (item.Text && item.FirstURL) {
        lines.push(`- ${item.Text}\n  ${item.FirstURL}`);
      }
    }
    if (!lines.length) {
      return {
        output: `No structured results for "${query}". Try a more specific query, or fetch a docs URL with bash curl when network is allowed.`,
      };
    }
    const managed = await boundToolOutput(lines.slice(0, n + 1).join("\n\n"));
    return { output: managed.text };
  } catch (err) {
    return { output: `web_search failed: ${(err as Error).message}`, isError: true };
  }
}
