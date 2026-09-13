/**
 * Search-tool roots — glob/grep must not walk $HOME, /Users, or ~/Library.
 *
 * Dogfood: six Planners globbed forge-game skills under the user home and
 * sat in uv__fs_work on Chrome's 1.8 GB quarantined profile until Chrome
 * was killed. Permission-ask does not fire under YOLO; the tool fails closed.
 */
import os from "node:os";
import path from "node:path";
import { envPositiveInt } from "../../util/env.js";

function posix(p: string): string {
  let n = path.resolve(p).split("\\").join("/");
  while (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n || "/";
}

/** Ignore globs so a workspace walk cannot enter browser profiles or Library. */
export const SEARCH_SKIP_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/Library/**",
  "**/.Trash/**",
  "**/Application Support/Google/Chrome/**",
  "**/Application Support/Chromium/**",
  "**/Application Support/BraveSoftware/**",
  "**/Application Support/Microsoft Edge/**",
  "**/.forge/sessions/**/browsers/**",
] as const;

/** Stop walking after this many matches — printed lines stay a smaller slice. */
export const SEARCH_MAX_WALKED = 2_000;

export function globTimeoutMs(): number {
  return envPositiveInt("FORGE_GLOB_TIMEOUT_MS", 15_000);
}

/** Combine the turn abort with the search-tool timeout. */
export function withSearchTimeout(parent?: AbortSignal): {
  signal: AbortSignal;
  clear: () => void;
  timedOut: () => boolean;
} {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, globTimeoutMs());
  timer.unref?.();
  const onParent = () => ac.abort();
  parent?.addEventListener("abort", onParent, { once: true });
  if (parent?.aborted) ac.abort();
  return {
    signal: ac.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
    timedOut: () => timedOut,
  };
}

export function searchTimeoutRefusal(tool: "glob" | "grep", pathLabel: string): string {
  const secs = Math.round(globTimeoutMs() / 1000);
  return (
    tool +
    " error: timed out after " +
    String(secs) +
    "s (path=" +
    pathLabel +
    "). Narrow the path; do not search $HOME."
  );
}

/** $HOME, /, /Users, /home, or ~/Library — not a project tree. */
export function isBroadSearchRoot(abs: string): boolean {
  const n = posix(abs);
  if (n === "/" || n === "/Users" || n === "/home") return true;
  const home = posix(os.homedir() || "");
  if (home && (n === home || n === posix(path.dirname(home)))) return true;
  if (home && (n === home + "/Library" || n.startsWith(home + "/Library/"))) return true;
  return false;
}

export function searchRootRefusal(abs: string, tool: "glob" | "grep"): string {
  return (
    tool +
    " error: path " +
    abs +
    " is too broad (home, /Users, or Library). " +
    "Omit path to search the workspace, or pass a project directory. " +
    "Do not glob/grep $HOME for forge-* skills — the inlined category skill is the bar."
  );
}
