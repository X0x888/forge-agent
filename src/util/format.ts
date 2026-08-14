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

export function summarizeToolArgs(args: Record<string, unknown>, max = 90): string {
  // apply_patch: show file ops, not a wall of patch text
  const patchText = args.patchText ?? args.patch_text ?? args.patch;
  if (typeof patchText === "string" && patchText.trim()) {
    const summary = summarizePatchText(patchText, max);
    if (summary) return summary;
  }
  const prefer = ["path", "command", "pattern", "query", "old_string", "url"];
  for (const k of prefer) {
    if (args[k] !== undefined) {
      const v = String(args[k]).replace(/\s+/g, " ");
      const s = `${k}=${v}`;
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
  return chalk.cyan(`  ▸ ${name}`) + chalk.dim(` ${summarizeToolArgs(args)}`);
}

export function formatToolEnd(
  name: string,
  opts: { isError?: boolean; ms: number; bytes: number },
): string {
  const status = opts.isError ? chalk.red("✗") : chalk.green("✓");
  return chalk.dim(
    `  ${status} ${name}  ${opts.ms}ms  ${formatBytes(opts.bytes)}`,
  );
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
  opts: { maxLines?: number; indent?: string } = {},
): string {
  const maxLines = opts.maxLines ?? 60;
  const indent = opts.indent ?? "    ";
  const lines = diff.split("\n");
  const shown = lines.slice(0, maxLines);
  const out = shown.map((line) => {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      return indent + chalk.dim.bold(line);
    }
    if (line.startsWith("@@")) return indent + chalk.dim(line);
    if (line.startsWith("+")) return indent + chalk.green(line);
    if (line.startsWith("-")) return indent + chalk.red(line);
    return indent + chalk.dim(line);
  });
  if (lines.length > maxLines) {
    out.push(indent + chalk.dim(`… (${lines.length - maxLines} more diff lines)`));
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
