/**
 * Microcompaction — the local equivalent of Anthropic's `clear_tool_uses`
 * (Claude Code's "clear tool results"): proactively drop STALE tool bodies
 * from conversation history to cut token usage on long agent runs, replacing
 * them with a one-line restorable stub. File system as external memory: drop
 * the body, keep the pointer (tool name, original size, saved-output path).
 *
 * Bodies without an existing `saved to` footer are spooled first so clearing
 * is lossless. Restore is `read_file` on that path — never "re-run" a
 * non-idempotent tool (spawn_subagent, bash, MCP).
 */
import type { ChatMessage } from "../providers/types.js";
import { envPositiveInt } from "../util/env.js";
import { saveFullOutputSync } from "../agent/tools/truncate.js";

export const TOOL_CLEAR_DEFAULT_KEEP_RECENT = 10;
export const TOOL_CLEAR_DEFAULT_MIN_CHARS = 1200;
export const TOOL_CLEAR_DEFAULT_MIN_STALE_BYTES = 12000;

/** Marker inside a replacement stub — used to skip already-cleared bodies. */
export const TOOL_CLEARED_MARKER = "[Stale tool output cleared";

/**
 * Pointer written by boundToolOutput() when oversized output was saved to disk:
 * `... saved to /path/tool_123.txt. Use read_file on that path if you need more.]`
 * The trailing `.` belongs to the footer sentence, not the path.
 */
const SAVED_TO_RE = /saved to ([^\s"'\\]+?)\.(?:\s|$)/;
const FULL_OUTPUT_RE = /Full output: ([^\s"'\\]+)/;

/** Workspace-refreshable tools — re-read the tree is valid; still keep the spool. */
const IDEMPOTENT_RESTORE_TOOLS = new Set([
  "read_file",
  "Read",
  "read",
  "grep",
  "Grep",
  "glob",
  "Glob",
  "list_dir",
  "ListDir",
]);

export function isIdempotentRestoreTool(name: string): boolean {
  return IDEMPOTENT_RESTORE_TOOLS.has(name);
}

/** Extract an existing spool path from a tool body or stub. */
export function extractSavedOutputPath(body: string): string | undefined {
  const full = FULL_OUTPUT_RE.exec(body);
  if (full?.[1]) return full[1].replace(/[.,;"']+$/, "");
  const saved = SAVED_TO_RE.exec(body);
  if (saved?.[1]) return saved[1];
  return undefined;
}

export function formatClearedToolStub(opts: {
  name: string;
  chars: number;
  outputPath: string;
  idempotent: boolean;
}): string {
  const head = `${TOOL_CLEARED_MARKER} (${opts.name}, ${opts.chars} chars). Full output: ${opts.outputPath} — use read_file on that path.`;
  if (opts.idempotent) {
    return `${head} Re-read the workspace path if the working tree may have changed.]`;
  }
  return `${head} Do not re-run ${opts.name} to restore this result.]`;
}

/**
 * Ensure `body` lives on disk and return the path. Reuses an existing
 * boundToolOutput / prior-clear pointer when present.
 */
export function ensureToolOutputSpool(body: string): string {
  const existing = extractSavedOutputPath(body);
  if (existing) return existing;
  return saveFullOutputSync(body);
}

export interface ToolClearOptions {
  /** The N most recent non-system messages are always left untouched. */
  keepRecent?: number;
  /** Only tool messages with content longer than this are cleared. */
  minChars?: number;
}

export interface ToolClearResult {
  messages: ChatMessage[];
  cleared: number;
  /** Net chars removed (bodies minus stubs). */
  freedChars: number;
}

/**
 * Index where the protected hot tail begins: the last `keepRecent`
 * non-system messages. Everything before it is stale-eligible.
 */
function hotTailStart(messages: ChatMessage[], keepRecent: number): number {
  if (keepRecent < 1) return messages.length; // no hot tail — all stale-eligible
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "system") continue;
    seen += 1;
    if (seen >= keepRecent) return i;
  }
  return 0; // history shorter than the hot tail — everything is protected
}

/** tool_call id → tool name, from every assistant message in the history. */
function toolNameMap(messages: ChatMessage[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) byId.set(tc.id, tc.function.name);
  }
  return byId;
}

/**
 * Replace stale oversized tool results with one-line stubs.
 *
 * NON-MUTATING: returns a new array when anything was cleared; when nothing
 * qualifies it returns the ORIGINAL array reference with `cleared: 0` so
 * callers can skip re-saving the session. System/user/assistant messages are
 * never touched, and cleared tool messages keep role + tool_call_id so
 * provider tool-call pairing stays intact.
 *
 * Each cleared body is spooled under ~/.forge/tool-output/ first (or reuses
 * an existing saved-to pointer) so the stub is always restorable.
 */
export function clearStaleToolResults(
  messages: ChatMessage[],
  opts: ToolClearOptions = {},
): ToolClearResult {
  const keepRecent = opts.keepRecent ?? TOOL_CLEAR_DEFAULT_KEEP_RECENT;
  const minChars = opts.minChars ?? TOOL_CLEAR_DEFAULT_MIN_CHARS;
  const hotStart = hotTailStart(messages, keepRecent);
  const nameById = toolNameMap(messages);

  let out: ChatMessage[] | null = null;
  let cleared = 0;
  let freedChars = 0;

  for (let i = 0; i < hotStart; i++) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const body = m.content ?? "";
    if (body.length < minChars) continue;
    if (body.includes(TOOL_CLEARED_MARKER)) continue;

    const name = (m.tool_call_id && nameById.get(m.tool_call_id)) || "tool";
    let outputPath: string;
    try {
      outputPath = ensureToolOutputSpool(body);
    } catch {
      // Fail open: keep the body rather than delete unique work.
      continue;
    }
    const stub = formatClearedToolStub({
      name,
      chars: body.length,
      outputPath,
      idempotent: isIdempotentRestoreTool(name),
    });

    if (!out) out = messages.slice();
    out[i] = { ...m, content: stub };
    cleared += 1;
    freedChars += body.length - stub.length;
  }

  if (!out) return { messages, cleared: 0, freedChars: 0 };
  return { messages: out, cleared, freedChars };
}

/**
 * Env knobs for the agent loop: FORGE_TOOL_CLEAR (default on; 0/false off),
 * FORGE_TOOL_CLEAR_KEEP_RECENT / _MIN_CHARS tune clearStaleToolResults,
 * FORGE_TOOL_CLEAR_MIN_STALE_BYTES is the caller-side trigger threshold
 * (only bother clearing once stale tool bodies exceed this many bytes).
 */
export function toolClearEnvConfig(): {
  enabled: boolean;
  keepRecent: number;
  minChars: number;
  minStaleBytes: number;
} {
  const raw = process.env.FORGE_TOOL_CLEAR;
  const enabled = raw !== "0" && raw !== "false";
  return {
    enabled,
    keepRecent: envPositiveInt(
      "FORGE_TOOL_CLEAR_KEEP_RECENT",
      TOOL_CLEAR_DEFAULT_KEEP_RECENT,
    ),
    minChars: envPositiveInt(
      "FORGE_TOOL_CLEAR_MIN_CHARS",
      TOOL_CLEAR_DEFAULT_MIN_CHARS,
    ),
    minStaleBytes: envPositiveInt(
      "FORGE_TOOL_CLEAR_MIN_STALE_BYTES",
      TOOL_CLEAR_DEFAULT_MIN_STALE_BYTES,
    ),
  };
}
