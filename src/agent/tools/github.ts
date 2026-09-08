/**
 * Read GitHub repositories without scraping github.com HTML.
 *
 * Public repos work unauthenticated (low rate limit). GITHUB_TOKEN / GH_TOKEN
 * / GITHUB_PAT, or `gh auth token`, raise the limit and unlock code search.
 * Tokens never enter the tool output. Kill-switch: FORGE_GITHUB=0.
 */
import { execFileSync } from "node:child_process";
import type { ToolContext, ToolResult } from "./types.js";
import { boundToolOutput } from "./truncate.js";
import { mergeAbortSignals } from "../../util/abort.js";
import { numberFieldError, stringFieldError } from "./arg-types.js";
import { createChildEnv } from "./env-policy.js";
import { isFalsy } from "../../util/bool.js";

const UA = "ForgeAgent/0.9 (+https://github.com/X0x888/forge-agent; github)";
const API = "https://api.github.com";
const TIMEOUT_MS = 20_000;
const ACTIONS = new Set(["search", "repo", "contents", "readme", "tree"]);

export function githubEnabled(): boolean {
  return !isFalsy(process.env.FORGE_GITHUB ?? "1");
}

export interface ParsedGithubRepo {
  owner: string;
  repo: string;
  ref?: string;
  path?: string;
}

/** owner/repo, or a github.com blob/tree/repo URL. */
export function parseGithubRepo(input: string): ParsedGithubRepo | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  let owner = "";
  let repo = "";
  let ref: string | undefined;
  let filePath: string | undefined;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
      const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
      if (parts.length < 2) return null;
      owner = parts[0];
      repo = parts[1].replace(/\.git$/i, "");
      const kind = parts[2];
      if (kind === "blob" || kind === "tree" || kind === "raw") {
        ref = parts[3];
        filePath = parts.slice(4).join("/") || undefined;
      }
    } else {
      const cleaned = raw.replace(/^github\.com\//i, "");
      const parts = cleaned.replace(/^\/+|\/+$/g, "").split("/");
      if (parts.length < 2) return null;
      owner = parts[0];
      repo = parts[1].replace(/\.git$/i, "");
      if (parts.length > 2) filePath = parts.slice(2).join("/");
    }
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return null;
  }
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return { owner, repo, ref, path: filePath };
}

/**
 * github.com/.../blob/<ref>/<path> → raw.githubusercontent.com so web_fetch
 * returns source, not the repository HTML chrome.
 */
export function rewriteGithubBlobUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!/^(www\.)?github\.com$/i.test(u.hostname)) return url;
    const m = u.pathname.match(
      /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/,
    );
    if (!m) return url;
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
  } catch {
    return url;
  }
}

let tokenCache: { value: string | null; at: number } | null = null;
const TOKEN_TTL_MS = 60_000;

export function resolveGithubToken(): string | null {
  const env =
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.GITHUB_PAT?.trim();
  if (env) return env;
  const now = Date.now();
  if (tokenCache && now - tokenCache.at < TOKEN_TTL_MS) return tokenCache.value;
  let value: string | null = null;
  try {
    const t = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: createChildEnv(),
    }).trim();
    if (t && !/\s/.test(t) && t.length >= 8) value = t;
  } catch {
    value = null;
  }
  tokenCache = { value, at: now };
  return value;
}

/** Test helper. */
export function _resetGithubTokenCache(): void {
  tokenCache = null;
}

function redact(s: string): string {
  return s
    .replace(/ghp_[A-Za-z0-9]+/g, "ghp_***")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_***")
    .replace(/gho_[A-Za-z0-9]+/g, "gho_***");
}

function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!err || typeof err !== "object") return false;
  const name = String((err as { name?: string }).name || "");
  const msg = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || /aborted/i.test(msg) || msg === "Aborted";
}

async function githubGet(
  pathAndQuery: string,
  token: string | null,
  signal: AbortSignal,
  accept?: string,
): Promise<{ status: number; json: unknown; text: string; remaining?: string }> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: accept || "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${API}${pathAndQuery}`, { headers, signal });
  const remaining = resp.headers.get("x-ratelimit-remaining") || undefined;
  const text = await resp.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: resp.status, json, text, remaining };
}

function rateTip(remaining: string | undefined, status: number): string {
  if (status === 403 || status === 429) {
    return " GitHub rate-limited this call. Set GITHUB_TOKEN or run `gh auth login`.";
  }
  if (remaining && Number(remaining) <= 8) {
    return ` (${remaining} unauthenticated GitHub API calls left this hour; set GITHUB_TOKEN or \`gh auth login\`).`;
  }
  return "";
}

export async function toolGithub(
  args: Record<string, unknown>,
  ctx: ToolContext = { workspace: process.cwd() },
): Promise<ToolResult> {
  if (!githubEnabled()) {
    return { output: "github is disabled (FORGE_GITHUB=0).", isError: true };
  }
  if (args.action != null && typeof args.action !== "string") {
    return {
      output: stringFieldError(
        "github",
        "action",
        args.action,
        "Use search | repo | contents | readme | tree.",
      ),
      isError: true,
    };
  }
  const action = String(args.action || "").trim().toLowerCase();
  if (!ACTIONS.has(action)) {
    return {
      output:
        `github error: action is required (search | repo | contents | readme | tree).\n` +
        `Example: { "action": "contents", "repo": "owner/repo", "path": "src/index.ts" }\n` +
        `Prefer this over web_search/web_fetch for GitHub source.`,
      isError: true,
    };
  }

  let n = 5;
  if (args.num_results != null && String(args.num_results).trim() !== "") {
    const raw = Number(args.num_results);
    if (!Number.isFinite(raw) || raw < 1) {
      return {
        output: numberFieldError(
          "github",
          "num_results",
          args.num_results,
          "Pass an integer 1–10 (default 5).",
        ),
        isError: true,
      };
    }
    n = Math.min(10, Math.floor(raw));
  }

  if (ctx.signal?.aborted) return { output: "Aborted", isError: true };
  const token = resolveGithubToken();
  const { signal, dispose } = mergeAbortSignals(ctx.signal, TIMEOUT_MS);
  try {
    if (action === "search") {
      return await runSearch(args, n, token, signal);
    }
    const repoRaw = String(args.repo || args.url || "").trim();
    const parsed = parseGithubRepo(repoRaw);
    if (!parsed) {
      return {
        output:
          "github error: repo is required (owner/repo or a github.com URL).\n" +
          'Example: { "action": "readme", "repo": "vercel/next.js" }',
        isError: true,
      };
    }
    const ref = String(args.ref || parsed.ref || "").trim();
    if (action === "repo") return await runRepo(parsed, token, signal);
    if (action === "readme") return await runReadme(parsed, ref, token, signal);
    if (action === "tree") return await runTree(parsed, ref, token, signal);
    const filePath = String(args.path || parsed.path || "").trim().replace(/^\/+/, "");
    if (!filePath) {
      return {
        output:
          "github error: path is required for action=contents.\n" +
          'Example: { "action": "contents", "repo": "owner/repo", "path": "README.md" }',
        isError: true,
      };
    }
    return await runContents(parsed, filePath, ref, token, signal);
  } catch (err) {
    if (isAbortLike(err, ctx.signal)) return { output: "Aborted", isError: true };
    return {
      output: redact(
        `github failed: ${(err as Error).message}\n` +
          "Retry, set GITHUB_TOKEN / `gh auth login`, or web_fetch a raw.githubusercontent.com URL.",
      ),
      isError: true,
    };
  } finally {
    dispose();
  }
}

async function runSearch(
  args: Record<string, unknown>,
  n: number,
  token: string | null,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (args.query != null && typeof args.query !== "string") {
    return {
      output: stringFieldError("github", "query", args.query, "Pass a search string."),
      isError: true,
    };
  }
  const query = String(args.query || "").trim();
  if (!query) {
    return {
      output:
        "github error: query is required for action=search.\n" +
        'Example: { "action": "search", "query": "playwright mcp isolated", "num_results": 5 }',
      isError: true,
    };
  }
  const typeRaw = String(args.type || "repositories").trim().toLowerCase();
  const code =
    typeRaw === "code" ||
    /\b(language|filename|extension|path|repo):/i.test(query);
  if (code && !token) {
    return {
      output:
        "github code search needs auth (GITHUB_TOKEN or `gh auth login`). " +
        "Search repositories without a token, or add a token and retry with type=code.",
      isError: true,
    };
  }
  const endpoint = code ? "/search/code" : "/search/repositories";
  const q = `${endpoint}?q=${encodeURIComponent(query)}&per_page=${n}`;
  const { status, json, remaining } = await githubGet(q, token, signal);
  if (status === 401 || status === 403 || status === 429) {
    return {
      output: redact(
        `github search HTTP ${status}.${rateTip(remaining, status)}`,
      ),
      isError: true,
    };
  }
  if (status < 200 || status >= 300) {
    return {
      output: `github search HTTP ${status}.${rateTip(remaining, status)}`,
      isError: true,
    };
  }
  const data = json as {
    total_count?: number;
    items?: Array<{
      full_name?: string;
      html_url?: string;
      description?: string | null;
      stargazers_count?: number;
      language?: string | null;
      name?: string;
      path?: string;
      repository?: { full_name?: string; html_url?: string };
    }>;
  };
  const items = data.items || [];
  if (!items.length) {
    return { output: `No GitHub ${code ? "code" : "repository"} hits for "${query}".` };
  }
  const lines = [
    `## GitHub ${code ? "code" : "repository"} search: ${query}`,
    `Hits: ${data.total_count ?? items.length}${rateTip(remaining, status)}`,
  ];
  if (code) {
    for (const it of items.slice(0, n)) {
      const repo = it.repository?.full_name || "";
      const p = it.path || it.name || "";
      const url = it.html_url || (repo ? `https://github.com/${repo}/blob/HEAD/${p}` : "");
      lines.push(`- **${repo}:${p}**\n  ${url}`);
    }
    lines.push("", "Follow up with action=contents on a promising path.");
  } else {
    for (const it of items.slice(0, n)) {
      const name = it.full_name || "";
      const stars = it.stargazers_count != null ? ` ★${it.stargazers_count}` : "";
      const lang = it.language ? ` · ${it.language}` : "";
      const desc = it.description ? `\n  ${it.description}` : "";
      lines.push(`- **${name}**${stars}${lang}\n  ${it.html_url || ""}${desc}`);
    }
    lines.push("", "Follow up with action=readme or action=contents — do not scrape github.com HTML.");
  }
  const managed = await boundToolOutput(lines.join("\n"));
  return { output: managed.text };
}

async function runRepo(
  parsed: ParsedGithubRepo,
  token: string | null,
  signal: AbortSignal,
): Promise<ToolResult> {
  const { status, json, remaining } = await githubGet(
    `/repos/${parsed.owner}/${parsed.repo}`,
    token,
    signal,
  );
  if (status === 404) {
    return { output: `github: ${parsed.owner}/${parsed.repo} not found (or private).`, isError: true };
  }
  if (status < 200 || status >= 300) {
    return {
      output: `github repo HTTP ${status}.${rateTip(remaining, status)}`,
      isError: true,
    };
  }
  const r = json as {
    full_name?: string;
    description?: string | null;
    html_url?: string;
    default_branch?: string;
    language?: string | null;
    stargazers_count?: number;
    forks_count?: number;
    license?: { spdx_id?: string } | null;
    topics?: string[];
    homepage?: string | null;
    archived?: boolean;
  };
  const lines = [
    `## ${r.full_name || `${parsed.owner}/${parsed.repo}`}`,
    r.description || "",
    `URL: ${r.html_url || ""}`,
    `Default branch: ${r.default_branch || "unknown"} · Language: ${r.language || "n/a"} · ★${r.stargazers_count ?? 0} · forks ${r.forks_count ?? 0}`,
    r.license?.spdx_id ? `License: ${r.license.spdx_id}` : "",
    r.homepage ? `Homepage: ${r.homepage}` : "",
    r.archived ? "Archived: yes" : "",
    r.topics?.length ? `Topics: ${r.topics.slice(0, 12).join(", ")}` : "",
    rateTip(remaining, status).trim(),
    "",
    "Next: action=readme, action=tree, or action=contents with a path.",
  ].filter((l) => l !== "");
  const managed = await boundToolOutput(lines.join("\n"));
  return { output: managed.text };
}

async function runReadme(
  parsed: ParsedGithubRepo,
  ref: string,
  token: string | null,
  signal: AbortSignal,
): Promise<ToolResult> {
  const q = ref
    ? `/repos/${parsed.owner}/${parsed.repo}/readme?ref=${encodeURIComponent(ref)}`
    : `/repos/${parsed.owner}/${parsed.repo}/readme`;
  const { status, json, remaining } = await githubGet(q, token, signal);
  if (status === 404) {
    return { output: `github: no README in ${parsed.owner}/${parsed.repo}.`, isError: true };
  }
  if (status < 200 || status >= 300) {
    return {
      output: `github readme HTTP ${status}.${rateTip(remaining, status)}`,
      isError: true,
    };
  }
  const body = decodeContentsBody(json);
  const managed = await boundToolOutput(
    `## ${parsed.owner}/${parsed.repo} README${ref ? ` @ ${ref}` : ""}\n\n${body}`,
  );
  return { output: managed.text };
}

async function runContents(
  parsed: ParsedGithubRepo,
  filePath: string,
  ref: string,
  token: string | null,
  signal: AbortSignal,
): Promise<ToolResult> {
  const q =
    `/repos/${parsed.owner}/${parsed.repo}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}` +
    (ref ? `?ref=${encodeURIComponent(ref)}` : "");
  const { status, json, remaining } = await githubGet(q, token, signal);
  if (status === 404) {
    return {
      output: `github: ${parsed.owner}/${parsed.repo}:${filePath} not found.`,
      isError: true,
    };
  }
  if (status < 200 || status >= 300) {
    return {
      output: `github contents HTTP ${status}.${rateTip(remaining, status)}`,
      isError: true,
    };
  }
  if (Array.isArray(json)) {
    const entries = json as Array<{ name?: string; type?: string; path?: string }>;
    const lines = [
      `## ${parsed.owner}/${parsed.repo}/${filePath}${ref ? ` @ ${ref}` : ""} (directory)`,
      ...entries.slice(0, 200).map((e) => `- ${e.type === "dir" ? "dir " : "    "}${e.path || e.name}`),
      entries.length > 200 ? `… +${entries.length - 200} more` : "",
    ].filter(Boolean);
    const managed = await boundToolOutput(lines.join("\n"));
    return { output: managed.text };
  }
  const body = decodeContentsBody(json);
  const managed = await boundToolOutput(
    `## ${parsed.owner}/${parsed.repo}/${filePath}${ref ? ` @ ${ref}` : ""}\n\n${body}`,
  );
  return { output: managed.text };
}

async function runTree(
  parsed: ParsedGithubRepo,
  ref: string,
  token: string | null,
  signal: AbortSignal,
): Promise<ToolResult> {
  let sha = ref;
  if (!sha) {
    const repo = await githubGet(`/repos/${parsed.owner}/${parsed.repo}`, token, signal);
    sha = (repo.json as { default_branch?: string })?.default_branch || "HEAD";
  }
  const { status, json, remaining } = await githubGet(
    `/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
    token,
    signal,
  );
  if (status === 404) {
    return { output: `github: tree ${parsed.owner}/${parsed.repo}@${sha} not found.`, isError: true };
  }
  if (status < 200 || status >= 300) {
    return {
      output: `github tree HTTP ${status}.${rateTip(remaining, status)}`,
      isError: true,
    };
  }
  const data = json as {
    truncated?: boolean;
    tree?: Array<{ path?: string; type?: string }>;
  };
  const files = (data.tree || [])
    .filter((t) => t.type === "blob" && t.path)
    .map((t) => t.path!)
    .slice(0, 400);
  const lines = [
    `## ${parsed.owner}/${parsed.repo} tree @ ${sha}`,
    `${files.length} files shown${data.truncated ? " (truncated by GitHub)" : ""}${rateTip(remaining, status)}`,
    ...files.map((p) => p),
    "",
    "Read a file with action=contents and path=…",
  ];
  const managed = await boundToolOutput(lines.join("\n"));
  return { output: managed.text };
}

function decodeContentsBody(json: unknown): string {
  const o = json as { encoding?: string; content?: string; name?: string; size?: number };
  if (!o || typeof o !== "object") return "(empty)";
  if (o.encoding === "base64" && typeof o.content === "string") {
    try {
      return Buffer.from(o.content.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return "(binary — could not decode)";
    }
  }
  if (typeof o.content === "string") return o.content;
  return `(no text content${o.name ? `: ${o.name}` : ""})`;
}
