/**
 * Web-search backends: optional API keys first, then key-free HTML engines.
 *
 * Order: Brave → Tavily → Exa → SearXNG (when configured), then DuckDuckGo
 * Instant Answer + DDG/Brave/Bing HTML in parallel. First provider that
 * fills the requested hit count wins; partial API results are topped up
 * from HTML. No Google scrape (ToS).
 */
import { mergeAbortSignals } from "../../util/abort.js";
import { readBodyCapped, decodeCodePoint } from "./web-fetch.js";
import { sliceUtf16Safe } from "../../util/json-utf8.js";

const UA = "ForgeAgent/0.9 (+https://github.com/X0x888/forge-agent; web_search)";
export const SEARCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchBundle {
  hits: SearchHit[];
  source: string;
}

function braveKey(): string | undefined {
  return (
    process.env.BRAVE_API_KEY?.trim() ||
    process.env.BRAVE_SEARCH_API_KEY?.trim() ||
    undefined
  );
}

function tavilyKey(): string | undefined {
  return process.env.TAVILY_API_KEY?.trim() || undefined;
}

function exaKey(): string | undefined {
  return process.env.EXA_API_KEY?.trim() || undefined;
}

function searxUrl(): string | undefined {
  const u = process.env.SEARXNG_URL?.trim() || process.env.SEARX_URL?.trim();
  if (!u) return undefined;
  return u.replace(/\/+$/, "");
}

export function configuredSearchProviders(): string[] {
  const out: string[] = [];
  if (braveKey()) out.push("brave");
  if (tavilyKey()) out.push("tavily");
  if (exaKey()) out.push("exa");
  if (searxUrl()) out.push("searxng");
  out.push("duckduckgo", "html");
  return out;
}

export function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (full, h: string) =>
      decodeCodePoint(parseInt(h, 16), full),
    )
    .replace(/&#(\d+);/g, (full, d: string) => decodeCodePoint(Number(d), full));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function unwrapDdgRedirect(href: string): string {
  try {
    if (href.startsWith("/") && !href.startsWith("//")) return "";
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (u.hostname.includes("duckduckgo.com") && u.pathname === "/l/") {
      const q = u.searchParams.get("uddg");
      if (q) return decodeURIComponent(q);
    }
    if (u.hostname.includes("duckduckgo.com")) return "";
    return u.href;
  } catch {
    return href.startsWith("http") ? href : "";
  }
}

/** Exported for unit tests. */
export function parseDdgHtml(html: string, n: number): SearchHit[] {
  const hits: SearchHit[] = [];
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

  const snips: string[] = [];
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = snipRe.exec(html)) && snips.length < n) {
    snips.push(stripTags(decodeHtml(m[1])).trim());
  }
  if (!snips.length) {
    const snipRe2 = /class="result__snippet"[^>]*>([\s\S]*?)<\//gi;
    while ((m = snipRe2.exec(html)) && snips.length < n) {
      snips.push(stripTags(decodeHtml(m[1])).trim());
    }
  }
  for (let i = 0; i < hits.length && i < snips.length; i++) {
    if (snips[i]) hits[i].snippet = sliceUtf16Safe(snips[i], 0, 240);
  }
  return hits;
}

/** Brave Search HTML. Conservative: result-header / heading-serpresult anchors. */
export function parseBraveHtml(html: string, n: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const re =
    /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="[^"]*(?:heading-serpresult|result-header|title)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < n) {
    const href = decodeHtml(m[1]);
    const title = stripTags(decodeHtml(m[2])).trim();
    if (!title || !/^https?:\/\//i.test(href)) continue;
    if (/brave\.com\//i.test(href)) continue;
    if (hits.some((h) => h.url === href)) continue;
    hits.push({ title, url: href });
  }
  if (hits.length) return hits;
  // Fallback: snippet cards with data-testid
  const re2 =
    /<a[^>]*data-testid="result-title"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = re2.exec(html)) && hits.length < n) {
    const href = decodeHtml(m[1]);
    const title = stripTags(decodeHtml(m[2])).trim();
    if (!title || /brave\.com\//i.test(href)) continue;
    if (hits.some((h) => h.url === href)) continue;
    hits.push({ title, url: href });
  }
  return hits;
}

/** Bing HTML: li.b_algo h2 a. */
export function parseBingHtml(html: string, n: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const re =
    /<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < n) {
    const href = decodeHtml(m[1]);
    const title = stripTags(decodeHtml(m[2])).trim();
    if (!title || !/^https?:\/\//i.test(href)) continue;
    if (/bing\.com\//i.test(href) || /microsoft\.com\/bing/i.test(href)) continue;
    if (hits.some((h) => h.url === href)) continue;
    hits.push({ title, url: href });
  }
  const snips: string[] = [];
  const snipRe = /<div class="b_caption"[\s\S]*?<p>([\s\S]*?)<\/p>/gi;
  while ((m = snipRe.exec(html)) && snips.length < n) {
    snips.push(stripTags(decodeHtml(m[1])).trim());
  }
  for (let i = 0; i < hits.length && i < snips.length; i++) {
    if (snips[i]) hits[i].snippet = sliceUtf16Safe(snips[i], 0, 240);
  }
  return hits;
}

export function mergeHits(groups: SearchHit[][], n: number): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const maxRound = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < maxRound && out.length < n; i++) {
    for (const g of groups) {
      const h = g[i];
      if (!h) continue;
      const key = h.url.replace(/\/+$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(h);
      if (out.length >= n) return out;
    }
  }
  return out;
}

async function fetchHtml(
  url: string,
  external: AbortSignal | undefined,
): Promise<string> {
  const { signal, dispose } = mergeAbortSignals(external, SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal,
      redirect: "follow",
    });
    if (!resp.ok) return "";
    const body = await readBodyCapped(resp, MAX_HTML_BYTES, signal);
    if (body.tooLarge) return "";
    return body.buf.toString("utf8");
  } finally {
    dispose();
  }
}

async function braveApi(
  query: string,
  n: number,
  external?: AbortSignal,
): Promise<SearchHit[]> {
  const key = braveKey();
  if (!key) return [];
  const { signal, dispose } = mergeAbortSignals(external, SEARCH_TIMEOUT_MS);
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": key,
        "User-Agent": UA,
      },
      signal,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const hits: SearchHit[] = [];
    for (const r of data.web?.results || []) {
      if (!r.title || !r.url) continue;
      hits.push({ title: r.title, url: r.url, snippet: r.description });
      if (hits.length >= n) break;
    }
    return hits;
  } catch {
    return [];
  } finally {
    dispose();
  }
}

async function tavilyApi(
  query: string,
  n: number,
  external?: AbortSignal,
): Promise<SearchHit[]> {
  const key = tavilyKey();
  if (!key) return [];
  const { signal, dispose } = mergeAbortSignals(external, SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ api_key: key, query, max_results: n }),
      signal,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const hits: SearchHit[] = [];
    for (const r of data.results || []) {
      if (!r.title || !r.url) continue;
      hits.push({ title: r.title, url: r.url, snippet: r.content });
      if (hits.length >= n) break;
    }
    return hits;
  } catch {
    return [];
  } finally {
    dispose();
  }
}

async function exaApi(
  query: string,
  n: number,
  external?: AbortSignal,
): Promise<SearchHit[]> {
  const key = exaKey();
  if (!key) return [];
  const { signal, dispose } = mergeAbortSignals(external, SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "User-Agent": UA,
      },
      body: JSON.stringify({ query, numResults: n, contents: { text: { maxCharacters: 400 } } }),
      signal,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      results?: Array<{ title?: string; url?: string; text?: string }>;
    };
    const hits: SearchHit[] = [];
    for (const r of data.results || []) {
      if (!r.title || !r.url) continue;
      hits.push({ title: r.title, url: r.url, snippet: r.text });
      if (hits.length >= n) break;
    }
    return hits;
  } catch {
    return [];
  } finally {
    dispose();
  }
}

async function searxngApi(
  query: string,
  n: number,
  external?: AbortSignal,
): Promise<SearchHit[]> {
  const base = searxUrl();
  if (!base) return [];
  const { signal, dispose } = mergeAbortSignals(external, SEARCH_TIMEOUT_MS);
  try {
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const hits: SearchHit[] = [];
    for (const r of data.results || []) {
      if (!r.title || !r.url) continue;
      hits.push({ title: r.title, url: r.url, snippet: r.content });
      if (hits.length >= n) break;
    }
    return hits;
  } catch {
    return [];
  } finally {
    dispose();
  }
}

export async function duckDuckGoInstantAnswer(
  query: string,
  n: number,
  external?: AbortSignal,
): Promise<SearchHit[]> {
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
    const hits: SearchHit[] = [];
    const push = (text?: string, href?: string) => {
      if (hits.length >= n) return;
      if (text && href && /^https?:\/\//i.test(href)) {
        if (hits.some((h) => h.url === href)) return;
        hits.push({ title: text, url: href });
      }
    };
    if (data.Heading && data.AbstractURL) {
      push(
        data.AbstractText ? `${data.Heading} — ${data.AbstractText}` : data.Heading,
        data.AbstractURL,
      );
    }
    for (const item of data.RelatedTopics || []) {
      push(item.Text, item.FirstURL);
      if (item.Topics) {
        for (const t of item.Topics) push(t.Text, t.FirstURL);
      }
    }
    for (const item of data.Results || []) push(item.Text, item.FirstURL);
    return hits;
  } catch {
    return [];
  } finally {
    dispose();
  }
}

async function htmlEngine(
  name: "ddg" | "brave" | "bing",
  query: string,
  n: number,
  external?: AbortSignal,
): Promise<SearchHit[]> {
  const urls: Record<typeof name, string> = {
    ddg: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    brave: `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
    bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  };
  const html = await fetchHtml(urls[name], external);
  if (!html) return [];
  if (name === "ddg") return parseDdgHtml(html, n);
  if (name === "brave") return parseBraveHtml(html, n);
  return parseBingHtml(html, n);
}

/**
 * Run the provider chain. API keys first; HTML engines in parallel as
 * fallback. Returns whatever it could collect (possibly empty).
 */
export async function searchWeb(
  query: string,
  n: number,
  external?: AbortSignal,
): Promise<SearchBundle> {
  const apis: Array<{ name: string; run: () => Promise<SearchHit[]> }> = [];
  if (braveKey()) apis.push({ name: "brave", run: () => braveApi(query, n, external) });
  if (tavilyKey()) apis.push({ name: "tavily", run: () => tavilyApi(query, n, external) });
  if (exaKey()) apis.push({ name: "exa", run: () => exaApi(query, n, external) });
  if (searxUrl()) apis.push({ name: "searxng", run: () => searxngApi(query, n, external) });

  for (const api of apis) {
    if (external?.aborted) break;
    const hits = await api.run();
    if (hits.length >= n) return { hits: hits.slice(0, n), source: api.name };
    if (hits.length) {
      const html = await htmlFallback(query, n, external);
      const merged = mergeHits([hits, html.hits], n);
      if (merged.length) {
        return { hits: merged, source: `${api.name}+${html.source}` };
      }
      return { hits, source: api.name };
    }
  }

  const ia = await duckDuckGoInstantAnswer(query, n, external);
  const html = await htmlFallback(query, n, external);
  const merged = mergeHits([ia, html.hits], n);
  const source = [ia.length ? "ddg-ia" : "", html.source].filter(Boolean).join("+") || "none";
  return { hits: merged, source };
}

async function htmlFallback(
  query: string,
  n: number,
  external?: AbortSignal,
): Promise<SearchBundle> {
  const engines = await Promise.allSettled([
    htmlEngine("ddg", query, n, external),
    htmlEngine("brave", query, n, external),
    htmlEngine("bing", query, n, external),
  ]);
  const groups: SearchHit[][] = [];
  const names: string[] = [];
  const labels = ["ddg-html", "brave-html", "bing-html"];
  engines.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.length) {
      groups.push(r.value);
      names.push(labels[i]);
    }
  });
  return { hits: mergeHits(groups, n), source: names.join("+") || "html" };
}
