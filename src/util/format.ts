import chalk from "chalk";
import { grokCostRates } from "../config/grok-model.js";

/** Truncate long tool output keeping head + tail so errors at the end remain visible. */
export function truncateMiddle(text: string, max = 80_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.35);
  const omitted = text.length - head - tail;
  return (
    text.slice(0, head) +
    `\n\n… [${omitted} chars omitted] …\n\n` +
    text.slice(-tail)
  );
}

/** Keys whose value is the whole story — `path=src/a.ts` is noise on every ✓ row. */
const BARE_PRIMARY_KEYS = new Set([
  "path",
  "command",
  "pattern",
  "query",
  "url",
]);

/**
 * Daily transcript names. Internal ids stay on the wire; the ✓/✗ row
 * should scan like `edit src/a.ts`, not `search_replace path=src/a.ts`.
 * Specialized tools (spawn_subagent, todo_write, …) keep their names —
 * their summaries already carry the meaning.
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  search_replace: "edit",
  edit: "edit",
  Edit: "edit",
  write_file: "write",
  write: "write",
  Write: "write",
  read_file: "read",
  Read: "read",
  apply_patch: "patch",
  applypatch: "patch",
  ApplyPatch: "patch",
  run_terminal_command: "bash",
};

export function formatToolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] ?? name;
}

export function summarizeToolArgs(args: Record<string, unknown>, max = 90): string {
  // apply_patch: show file ops, not a wall of patch text
  const patchText = args.patchText ?? args.patch_text ?? args.patch;
  if (typeof patchText === "string" && patchText.trim()) {
    const summary = summarizePatchText(patchText, max);
    if (summary) return summary;
  }
  const sub = summarizeSubagentArgs(args, max);
  if (sub) return sub;
  const todos = summarizeTodoWriteArgs(args, max);
  if (todos) return todos;
  const ask = summarizeAskUserArgs(args, max);
  if (ask) return ask;
  const mem = summarizeMemoryWriteArgs(args, max);
  if (mem) return mem;
  const mcp = summarizeCallMcpArgs(args, max);
  if (mcp) return mcp;
  const prompt = summarizeMcpPromptArgs(args, max);
  if (prompt) return prompt;
  const prefer = [
    "pattern",
    "query",
    "command",
    "path",
    "old_string",
    "url",
    "question",
    "reason",
    "tool_name",
    "task_id",
    "uri",
    "plan",
    "name",
    "action",
  ];
  for (const k of prefer) {
    if (args[k] !== undefined) {
      const v = String(args[k]).replace(/\s+/g, " ").trim();
      // grep/glob: `foo src/tui` beats `pattern=foo` when a search root is set.
      const extra =
        k === "pattern" && typeof args.path === "string" && args.path.trim()
          ? ` ${args.path.replace(/\s+/g, " ").trim()}`
          : "";
      const s = BARE_PRIMARY_KEYS.has(k) ? `${v}${extra}` : `${k}=${v}`;
      return s.length > max ? s.slice(0, max - 1) + "…" : s;
    }
  }
  const s = JSON.stringify(args);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Human-readable permission / HUD preview for tool inputs.
 * Prefer structured summaries over raw JSON dumps (especially apply_patch).
 */
export function formatPermissionPreview(
  toolName: string,
  toolInput: Record<string, unknown>,
  max = 500,
): string {
  const name = (toolName || "").toLowerCase();
  if (name === "apply_patch" || name === "applypatch") {
    const patchText = String(
      toolInput.patchText ?? toolInput.patch_text ?? toolInput.patch ?? "",
    );
    const lines = extractPatchOpLines(patchText);
    if (lines.length) {
      const body = lines.slice(0, 20).join("\n");
      const more =
        lines.length > 20 ? `\n… +${lines.length - 20} more op(s)` : "";
      const out = `ops (${lines.length}):\n${body}${more}`;
      return out.length > max ? out.slice(0, max - 1) + "…" : out;
    }
  }
  if (name === "bash" || name === "run_terminal_command") {
    const cmd = String(toolInput.command || "");
    if (cmd) {
      const s = cmd.length > max ? cmd.slice(0, max - 1) + "…" : cmd;
      return `command: ${s}`;
    }
  }
  if (name === "spawn_subagent" || name === "task" || name === "subagent") {
    const sub = summarizeSubagentArgs(toolInput, max);
    if (sub) return sub;
  }
  if (name === "todo_write" || name === "todowrite") {
    const todos = summarizeTodoWriteArgs(toolInput, max);
    if (todos) return todos;
  }
  if (name === "ask_user" || name === "askuser") {
    const ask = summarizeAskUserArgs(toolInput, max);
    if (ask) return ask;
  }
  if (name === "memory_write" || name === "memorywrite") {
    const mem = summarizeMemoryWriteArgs(toolInput, max);
    if (mem) return mem;
  }
  if (name === "call_mcp" || name === "callmcp") {
    const mcp = summarizeCallMcpArgs(toolInput, max);
    if (mcp) return mcp;
  }
  if (name === "mcp_prompt" || name === "mcpprompt") {
    const prompt = summarizeMcpPromptArgs(toolInput, max);
    if (prompt) return prompt;
  }
  if (
    name === "write_file" ||
    name === "write" ||
    name === "search_replace" ||
    name === "edit"
  ) {
    const p = String(toolInput.path || "");
    if (p) {
      const extra =
        name.includes("search") || name === "edit"
          ? `\nold_string: ${String(toolInput.old_string || "").slice(0, 120)}`
          : toolInput.content != null
            ? `\ncontent: ${String(toolInput.content).length} chars`
            : "";
      return `path: ${p}${extra}`.slice(0, max);
    }
  }
  const summary = summarizeToolArgs(toolInput, max);
  if (summary && !summary.startsWith("{") && !summary.startsWith("[")) {
    return summary;
  }
  try {
    const raw = JSON.stringify(toolInput, null, 2);
    return raw.length > max ? raw.slice(0, max - 1) + "…" : raw;
  } catch {
    return String(toolInput).slice(0, max);
  }
}

function extractPatchOpLines(patchText: string): string[] {
  const out: string[] = [];
  for (const line of String(patchText || "").split(/\r?\n/)) {
    if (line.startsWith("*** Add File:")) {
      out.push(`A ${line.slice("*** Add File:".length).trim()}`);
    } else if (line.startsWith("*** Delete File:")) {
      out.push(`D ${line.slice("*** Delete File:".length).trim()}`);
    } else if (line.startsWith("*** Update File:")) {
      out.push(`M ${line.slice("*** Update File:".length).trim()}`);
    } else if (line.startsWith("*** Move to:")) {
      out.push(`→ ${line.slice("*** Move to:".length).trim()}`);
    }
  }
  return out;
}

/** spawn_subagent: type + label — never dump the prompt JSON onto the ✓/✗ row. */
function summarizeSubagentArgs(
  args: Record<string, unknown>,
  max: number,
): string {
  // Don't match a generic `type` field — only real subagent payloads.
  const kindRaw = args.subagent_type ?? args.agent_type;
  const hasPrompt = typeof args.prompt === "string" && Boolean(args.prompt.trim());
  const hasLabel =
    (typeof args.description === "string" && Boolean(args.description.trim())) ||
    (typeof args.summary === "string" && Boolean(args.summary.trim()));
  if (kindRaw == null && !(hasPrompt && hasLabel)) return "";
  const kind =
    String(kindRaw ?? args.type ?? "general-purpose")
      .replace(/\s+/g, " ")
      .trim() || "general-purpose";
  const label = String(args.description ?? args.summary ?? args.prompt ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const s = label ? `${kind}: ${label}` : kind;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** todo_write: N items + current title — never dump the board JSON. */
function summarizeTodoWriteArgs(
  args: Record<string, unknown>,
  max: number,
): string {
  const raw = args.todos;
  if (!Array.isArray(raw) || raw.length === 0) return "";
  const items = raw.filter((t): t is Record<string, unknown> =>
    Boolean(t && typeof t === "object"),
  );
  if (!items.length) return "";
  const current =
    items.find((t) => t.status === "in_progress") ??
    items.find((t) => t.status === "pending") ??
    items[0];
  const title = String(current?.content ?? current?.id ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const mark =
    current?.status === "in_progress"
      ? "▶"
      : current?.status === "completed"
        ? "✓"
        : current?.status === "cancelled"
          ? "×"
          : "○";
  const more = items.length > 1 ? ` +${items.length - 1}` : "";
  const s = title ? `${items.length} · ${mark} ${title}${more}` : `${items.length} todos`;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** ask_user: the question only — never dump choices JSON. */
function summarizeAskUserArgs(
  args: Record<string, unknown>,
  max: number,
): string {
  const q = typeof args.question === "string" ? args.question.trim() : "";
  if (!q) return "";
  const n = Array.isArray(args.choices) ? args.choices.length : 0;
  const s = n > 0 ? `${q} (${n})` : q;
  return s.replace(/\s+/g, " ").length > max
    ? s.replace(/\s+/g, " ").slice(0, max - 1) + "…"
    : s.replace(/\s+/g, " ");
}

/** call_mcp: qualified tool name — never dump the arguments object. */
function summarizeCallMcpArgs(
  args: Record<string, unknown>,
  max: number,
): string {
  const name = typeof args.tool_name === "string" ? args.tool_name.trim() : "";
  if (!name) return "";
  const payload = args.arguments;
  const keys =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload as Record<string, unknown>)
      : [];
  const s = keys.length ? `${name} · ${keys.length} arg${keys.length === 1 ? "" : "s"}` : name;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** mcp_prompt: template name — never dump the arguments object. */
function summarizeMcpPromptArgs(
  args: Record<string, unknown>,
  max: number,
): string {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const payload = args.arguments;
  const hasPayload =
    payload && typeof payload === "object" && !Array.isArray(payload);
  // Don't match a generic `name` field — only real mcp_prompt payloads.
  if (action !== "list" && !(name && (action === "get" || hasPayload || name.includes("__")))) {
    return "";
  }
  const keys =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload as Record<string, unknown>)
      : [];
  const verb = action && action !== "get" ? action : "";
  const label = name || "list";
  const bits = [verb, label].filter(Boolean);
  if (keys.length) bits.push(`${keys.length} arg${keys.length === 1 ? "" : "s"}`);
  const s = bits.join(" · ");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** memory_write: kind + text — never dump the full payload JSON. */
function summarizeMemoryWriteArgs(
  args: Record<string, unknown>,
  max: number,
): string {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return "";
  const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : "";
  const scope = typeof args.scope === "string" && args.scope.trim() ? args.scope.trim() : "";
  const prefix = [scope && scope !== "session" ? scope : "", kind].filter(Boolean).join(" · ");
  const s = prefix ? `${prefix}: ${text}` : text;
  return s.replace(/\s+/g, " ").length > max
    ? s.replace(/\s+/g, " ").slice(0, max - 1) + "…"
    : s.replace(/\s+/g, " ");
}

function summarizePatchText(patchText: string, max: number): string {
  const ops = extractPatchOpLines(patchText);
  if (!ops.length) {
    const s = `patch=${patchText.replace(/\s+/g, " ").trim()}`;
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }
  const head = ops.slice(0, 4).join(", ");
  const more = ops.length > 4 ? ` +${ops.length - 4} more` : "";
  const s = `patch(${ops.length}): ${head}${more}`;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function formatToolStart(name: string, args: Record<string, unknown>): string {
  return chalk.cyan(`  ▸ ${formatToolDisplayName(name)}`) + chalk.dim(` ${summarizeToolArgs(args)}`);
}

/** Default last-lines shown under a failed tool (test/compiler failures live at the end). */
export const FAILED_TOOL_TAIL_LINES = 5;

const ERROR_LINE_RE =
  /\b(error|fail(?:ed|ure)?|denied|fatal|exception|assert(?:ion)?|unable|cannot|can't|refused|timeout|ENOENT|EACCES|EPERM|not ok|TS\d{3,5})\b/i;
const STACK_OR_NOISE_RE = /^(?:at |# |ℹ |ok \d|✔ |✗ |▶ | {2,}at )/;
const EXCEPTION_CLASS_RE = /^\w+Error\b/;

function clipErrorLine(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * One-line reason for the ✗ status row. Prefer a real failure (errors
 * live at the end of test/compiler output) over the first header line
 * (`npm test`, a TAP plan, …).
 */
export function firstToolErrorLine(output: string, max = 72): string {
  const text = output.replace(/\s+$/, "");
  if (!text) return "";
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !STACK_OR_NOISE_RE.test(l));
  if (lines.length === 0) {
    const fallback = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    return clipErrorLine(fallback, max);
  }
  // Prefer a named failure (`not ok`, `error TS2345`, `Permission denied`)
  // over a trailing `AssertionError:` restatement. Fall back to the last
  // error-ish line, then the last remaining line.
  let lastError: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!ERROR_LINE_RE.test(line)) continue;
    lastError ??= line;
    if (!EXCEPTION_CLASS_RE.test(line)) return clipErrorLine(line, max);
  }
  return clipErrorLine(lastError ?? lines[lines.length - 1]!, max);
}

export function formatToolEnd(
  name: string,
  opts: {
    isError?: boolean;
    ms: number;
    bytes: number;
    /** When set, default transcript can stay one line (status + args). */
    args?: Record<string, unknown>;
    /** Failed-tool output — failure reason is inlined on the ✗ row. */
    output?: string;
    /** Line stats for edit-class tools (`+8 -6`). */
    stats?: { added: number; removed: number | null };
    /** Clip to one TTY row. Default: stdout.columns (80 when not a TTY). */
    width?: number;
  },
): string {
  const status = opts.isError ? chalk.red("✗") : chalk.green("✓");
  const editClass =
    /^(search_replace|edit|write_file|write|apply_patch|applypatch)$/i.test(name);
  const size = editClass
    ? opts.stats
      ? opts.stats.removed === null
        ? `+${opts.stats.added} -?`
        : `+${opts.stats.added} -${opts.stats.removed}`
      : `diff ${formatBytes(opts.bytes)}`
    : formatBytes(opts.bytes);
  const timing = `${opts.ms}ms  ${size}`;
  const cols = Math.max(
    8,
    opts.width ?? (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  const hasArgs = Boolean(opts.args && Object.keys(opts.args).length);
  const reasonRaw =
    opts.isError && opts.output ? firstToolErrorLine(opts.output) : "";

  const label = formatToolDisplayName(name);
  const paint = (argBit: string, reasonBit: string): string =>
    chalk.dim(`  ${status} ${label}${argBit}${reasonBit}  ${timing}`);

  let argBit = hasArgs ? ` ${summarizeToolArgs(opts.args!)}` : "";
  let reasonBit = reasonRaw ? `  ${reasonRaw}` : "";
  let line = paint(argBit, reasonBit);
  if (visibleWidth(line) <= cols) return line;

  // Failures: shrink long args first so the reason is not clipped off the right.
  // Keep short paths (`src/a.ts`) intact — only cap args that actually overflow.
  const FAIL_ARG_MAX = 28;
  if (reasonRaw && hasArgs && summarizeToolArgs(opts.args!).length > FAIL_ARG_MAX) {
    argBit = ` ${summarizeToolArgs(opts.args!, FAIL_ARG_MAX)}`;
    line = paint(argBit, reasonBit);
    if (visibleWidth(line) <= cols) return line;
  }

  if (reasonRaw) {
    const reserved = visibleWidth(paint(argBit, "  "));
    const reasonMax = Math.max(12, cols - reserved);
    const clipped = firstToolErrorLine(opts.output!, reasonMax);
    reasonBit = clipped ? `  ${clipped}` : "";
    line = paint(argBit, reasonBit);
    if (visibleWidth(line) <= cols) return line;
  }

  return clipAnsi(line, cols);
}

/**
 * Extra transcript under a failed tool. Last `maxLines` (default 5) so
 * test/compiler failures stay visible. Drops the line already inlined
 * on the ✗ row (full or clipped). Empty when there is nothing extra.
 */
export function formatFailedToolTail(
  output: string,
  maxLines = FAILED_TOOL_TAIL_LINES,
): string {
  const text = output.replace(/\s+$/, "");
  if (!text) return "";
  const reason = firstToolErrorLine(text);
  const reasonBare = reason.replace(/…$/, "");
  const extra = text.split("\n").filter((raw) => {
    const line = raw.trim();
    if (!line) return false;
    if (!reason) return true;
    if (line === reason) return false;
    if (reason.endsWith("…") && line.startsWith(reasonBare)) return false;
    return true;
  });
  if (extra.length === 0) return "";
  return formatToolOutputHead(extra.join("\n"), {
    tail: true,
    maxLines,
  });
}

/** Tool names whose successful output may embed a shortDiff block. */
const DIFF_OUTPUT_TOOLS = new Set([
  "search_replace",
  "edit",
  "write_file",
  "write",
  "apply_patch",
  "applypatch",
]);

/**
 * Extract the embedded shortDiff block from an edit-tool result string.
 * Tools emit `Edited <path>…\n\n<diff>` / `Wrote <path>…\n\n<diff>`; a
 * `Tip: verify with …` line may follow the diff. Pure string slicing —
 * no diff recomputation. Undefined when the output carries no diff.
 */
export function extractDiffFromToolOutput(
  toolName: string,
  output: string,
): string | undefined {
  if (!DIFF_OUTPUT_TOOLS.has((toolName || "").toLowerCase())) return undefined;
  const start = output.indexOf("\n\n--- a/");
  if (start < 0) return undefined;
  let diff = output.slice(start + 2);
  const tip = diff.indexOf("\nTip: verify with");
  if (tip >= 0) diff = diff.slice(0, tip);
  diff = diff.replace(/\s+$/, "");
  return diff || undefined;
}

/**
 * Colorize a shortDiff block for the transcript: green `+`, red `-`,
 * dim file headers / hunk markers / context. Indented under the tool line.
 */
export function formatDiffBlock(
  diff: string,
  opts: {
    maxLines?: number;
    indent?: string;
    /** Compact transcript: path already lives on the ✓ row. */
    omitHeaders?: boolean;
  } = {},
): string {
  const maxLines = opts.maxLines ?? 60;
  const indent = opts.indent ?? "    ";
  const raw = diff.split("\n").filter((line) => {
    if (!opts.omitHeaders) return true;
    return !line.startsWith("--- ") && !line.startsWith("+++ ");
  });
  const shown = raw.slice(0, maxLines);
  const out = shown.map((line) => {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      return indent + chalk.dim.bold(line);
    }
    if (line.startsWith("@@")) return indent + chalk.dim(line);
    if (line.startsWith("+")) return indent + chalk.green(line);
    if (line.startsWith("-")) return indent + chalk.red(line);
    return indent + chalk.dim(line);
  });
  if (raw.length > maxLines) {
    const extra = raw.length - maxLines;
    out.push(
      indent +
        chalk.dim(
          opts.omitHeaders
            ? `… (${extra} more · /verbose)`
            : `… (${extra} more diff lines)`,
        ),
    );
  }
  return out.join("\n");
}

/**
 * Dimmed tool-output preview for the transcript. Head mode: first `maxLines`
 * lines (overlong lines clipped) + a count of what is hidden. Tail mode:
 * last `maxLines` (failures live at the end of test/compiler output).
 * Verbose mode: the whole (already session-capped) output, one dim indented
 * line per line.
 */
export function formatToolOutputHead(
  output: string,
  opts: {
    maxLines?: number;
    verbose?: boolean;
    indent?: string;
    tail?: boolean;
  } = {},
): string {
  const indent = opts.indent ?? "    ";
  const text = output.replace(/\s+$/, "");
  if (!text) return "";
  const lines = text.split("\n");
  if (opts.verbose) {
    return lines.map((l) => indent + chalk.dim(l)).join("\n");
  }
  const maxLines = opts.maxLines ?? 5;
  const hidden = Math.max(0, lines.length - maxLines);
  const more = indent + chalk.dim(`… (${hidden} more lines · /verbose to show all)`);
  if (opts.tail) {
    const shown = lines.slice(-maxLines).map((l) => indent + chalk.dim(clipAnsi(l, 160)));
    return hidden > 0 ? [more, ...shown].join("\n") : shown.join("\n");
  }
  const out = lines
    .slice(0, maxLines)
    .map((l) => indent + chalk.dim(clipAnsi(l, 160)));
  if (hidden > 0) out.push(more);
  return out.join("\n");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Rough USD estimate — not billing-accurate; for status display only. */
export function estimateCostUsd(
  provider: string,
  promptTokens: number,
  completionTokens: number,
  model?: string,
  /** Cached-input tokens (provider-reported). Priced at cacheIn when known. */
  cacheReadTokens?: number,
): number {
  // Provider mid-tier averages ($/1M tokens) — HUD/cost estimates only.
  const rates: Record<string, { in: number; out: number; cacheIn?: number }> = {
    xai: { in: 2, out: 6, cacheIn: 0.5 }, // grok-4.6 (daily default); cached input ~$0.50/M
    anthropic: { in: 3, out: 15, cacheIn: 0.3 }, // cache read = 0.1× input
    openai: { in: 2.5, out: 10 },
    openrouter: { in: 3, out: 15 },
    deepseek: { in: 0.14, out: 0.28, cacheIn: 0.0028 }, // V4 Flash ballpark (HUD only)
    google: { in: 1.25, out: 10 },
  };
  // Per-model overrides where they differ from the provider average.
  // Models without cacheIn price cached input at full rate — the safe
  // (overestimating) direction for a HUD + spend cap.
  const modelRates: Record<string, { in: number; out: number; cacheIn?: number }> = {
    // Grok flagship rates: grok-model.ts (4.6+ inherit $2/$6 cache $0.50).
    "grok-4": { in: 3, out: 15 },
    "grok-3": { in: 3, out: 15 },
    "grok-3-mini": { in: 0.3, out: 0.5 },
    "deepseek-v4-flash": { in: 0.14, out: 0.28, cacheIn: 0.0028 },
    // Official DeepSeek rate card (api-docs.deepseek.com/quick_start/pricing,
    // verified 2026-08-02): flash 0.0028/0.14/0.28, pro 0.003625/0.435/0.87
    // (cache-hit/miss/output per 1M). The in/50 vs in/120 cache ratios are
    // DeepSeek's own. NOTE: peak/off-peak 2× pricing (Beijing daytime) was
    // announced on that page — estimates may skew low during peak once live.
    "deepseek-v4-pro": { in: 0.435, out: 0.87, cacheIn: 0.003625 },
  };
  const mk = model
    ? (model.includes("/") ? model.split("/").pop()! : model)
        .trim()
        .toLowerCase()
        .replace(/-latest$/, "")
    : "";
  const grok = model ? grokCostRates(model) : undefined;
  const r =
    grok ||
    (mk ? modelRates[mk] : undefined) ||
    rates[provider] || { in: 3, out: 12 };
  const cached = Math.min(Math.max(0, cacheReadTokens ?? 0), promptTokens);
  const uncached = promptTokens - cached;
  return (
    (uncached * r.in + cached * (r.cacheIn ?? r.in) + completionTokens * r.out) /
    1_000_000
  );
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

/** Human-friendly retry wait for status/HUD (e.g. "1.2s", "450ms"). */
export function formatRetryWait(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Compact relative age for session pickers (e.g. "just now", "5m", "3h", "2d").
 * Falls back to a short ISO date when older than ~60 days or unparseable.
 */
export function formatRelativeTime(
  isoOrDate: string | number | Date | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (isoOrDate == null || isoOrDate === "") return "—";
  let t: number;
  if (isoOrDate instanceof Date) t = isoOrDate.getTime();
  else if (typeof isoOrDate === "number") t = isoOrDate;
  else t = Date.parse(String(isoOrDate));
  if (!Number.isFinite(t)) {
    const s = String(isoOrDate);
    return s.length >= 10 ? s.slice(0, 10) : s.slice(0, 16) || "—";
  }
  const delta = nowMs - t;
  // Future clock skew — show absolute-ish short form
  if (delta < -60_000) {
    return new Date(t).toISOString().slice(0, 10);
  }
  const sec = Math.max(0, Math.floor(delta / 1000));
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 60) return `${day}d`;
  return new Date(t).toISOString().slice(0, 10);
}

/** Visible character length ignoring ANSI CSI sequences. */
export function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Clip a chalk-colored string to `max` visible columns without mid-SGR cuts. */
export function clipAnsi(text: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(text) <= max) return text;
  let out = "";
  let vis = 0;
  // eslint-disable-next-line no-control-regex
  const re = /(\x1b\[[0-9;]*m)|./g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) {
      out += m[1];
      continue;
    }
    if (vis >= max) break;
    out += m[0];
    vis += 1;
  }
  return out + "\x1b[0m";
}
