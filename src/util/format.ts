import chalk from "chalk";

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
): number {
  // Very rough mid-tier averages ($/1M tokens) — HUD/cost estimates only
  const rates: Record<string, { in: number; out: number }> = {
    xai: { in: 3, out: 15 },
    anthropic: { in: 3, out: 15 },
    openai: { in: 2.5, out: 10 },
    openrouter: { in: 3, out: 15 },
    google: { in: 1.25, out: 10 },
  };
  const r = rates[provider] || { in: 3, out: 12 };
  return (promptTokens * r.in + completionTokens * r.out) / 1_000_000;
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
