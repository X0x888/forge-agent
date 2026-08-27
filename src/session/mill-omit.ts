/**
 * Mill-edit class for outbound prune. Edit/write tools that are not the
 * Wave-1 job files — not only numbered foo-n.js.
 */
import type { ChatMessage, ToolCall } from "../providers/types.js";
import { isChromeOnlyPath } from "../harness/job-delta.js";

const MILL_TOOL_RE = /write_file|search_replace|^edit$|apply_patch/i;
const KEEP_READ_RE = /read_file|^grep$|^glob$|list_dir/i;
const PLAY_TOOL_RE = /playwright|browser_take_screenshot|browser_snapshot|browser_navigate/i;
const IMAGE_PATH_RE = /\.(png|jpe?g|webp|gif)$/i;
const FULL_SUITE_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|typecheck|lint|check)\b|\bcargo test\b|\bpytest\b|\bgo test\b/i;
const ISOLATE_RE =
  /--test\s+\S+|python(?:3)?\s+-m\s+unittest\s+\S+TestCase|tests\/w\d+|npm test -- |pnpm test -- |yarn test /i;
const MILL_PATH_RE =
  /CHANGELOG|tests\/w\d+|systems\/[\w-]*(share|overflow|taste|hush|kindle|groove)|[\w./-]*[-_.](?:v|w)?\d+\.(?:js|ts|mjs|cjs|jsx|tsx|py)\b/i;

function norm(p: string): string {
  return (p || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export function extractToolPaths(args: string): string[] {
  const raw = args || "";
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    const n = (p || "").replace(/\\/g, "/").trim();
    if (!n || n.length > 240 || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o && typeof o === "object") {
      for (const k of ["path", "target_file", "file", "file_path"]) {
        if (typeof o[k] === "string") push(o[k] as string);
      }
      if (Array.isArray(o.paths)) {
        for (const p of o.paths) if (typeof p === "string") push(p);
      }
    }
  } catch {
    /* */
  }
  for (const m of raw.matchAll(
    /"(?:path|file|target_file|file_path)"\s*:\s*"([^"]{1,240})"/g,
  )) {
    push(m[1]!);
  }
  return out;
}

export function pathOnJobKeep(rel: string, jobKeepPaths?: string[]): boolean {
  const a = norm(rel);
  if (!a) return false;
  for (const k of jobKeepPaths || []) {
    const b = norm(k);
    if (!b) continue;
    if (a === b || a.endsWith("/" + b) || b.endsWith("/" + a)) return true;
    const ba = a.split("/").pop();
    const bb = b.split("/").pop();
    if (ba && bb && ba === bb && ba.length >= 8) return true;
  }
  return false;
}

export function isMillPath(rel: string): boolean {
  const n = (rel || "").replace(/\\/g, "/");
  if (!n) return false;
  if (MILL_PATH_RE.test(n)) return true;
  if (isChromeOnlyPath(n)) return true;
  return false;
}

export function isPlayLookToolCall(tc: ToolCall | undefined): boolean {
  if (!tc?.function) return false;
  const name = tc.function.name || "";
  const args = tc.function.arguments || "";
  if (PLAY_TOOL_RE.test(`${name} ${args}`)) return true;
  if (KEEP_READ_RE.test(name) && IMAGE_PATH_RE.test(args)) return true;
  return false;
}

export function isJobKeepToolCall(
  tc: ToolCall | undefined,
  jobKeepPaths?: string[],
): boolean {
  if (!tc?.function) return false;
  if (isPlayLookToolCall(tc)) return true;
  const name = tc.function.name || "";
  const args = tc.function.arguments || "";
  if (/spawn_subagent/i.test(name) && /explore|plan/i.test(args)) return true;
  if ((name === "bash" || name === "Shell") && FULL_SUITE_RE.test(args) && !ISOLATE_RE.test(args)) {
    return true;
  }
  const paths = extractToolPaths(args);
  if (KEEP_READ_RE.test(name) && paths.some((p) => pathOnJobKeep(p, jobKeepPaths))) {
    return true;
  }
  return false;
}

export function isMillEditClass(
  tc: ToolCall | undefined,
  jobKeepPaths?: string[],
): boolean {
  if (!tc?.function) return false;
  if (!MILL_TOOL_RE.test(tc.function.name || "")) return false;
  if (isJobKeepToolCall(tc, jobKeepPaths)) return false;
  const paths = extractToolPaths(tc.function.arguments || "");
  if (!paths.length) return false;
  if (paths.some((p) => pathOnJobKeep(p, jobKeepPaths))) return false;
  if ((jobKeepPaths || []).length > 0) return true;
  return paths.some(isMillPath);
}

export function collectRecentMillToolIds(
  messages: ChatMessage[],
  limit = 48,
  jobKeepPaths?: string[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | undefined) => {
    const t = (id || "").trim();
    if (!t || seen.has(t) || ids.length >= limit) return;
    seen.add(t);
    ids.push(t);
  };
  for (let i = messages.length - 1; i >= 0 && ids.length < limit; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (isMillEditClass(tc, jobKeepPaths)) push(tc.id);
      }
    }
  }
  return ids;
}

export function collectJobKeepToolIds(
  messages: ChatMessage[],
  jobKeepPaths?: string[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (!isJobKeepToolCall(tc, jobKeepPaths)) continue;
      const id = (tc.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
