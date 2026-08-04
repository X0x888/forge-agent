/**
 * Model-facing `lsp` tool.
 */
import type { ToolContext, ToolResult } from "../agent/tools/types.js";
import { formatDiagnosticsReport, formatLspStatus } from "./manager.js";

const ACTIONS = new Set([
  "diagnostics",
  "hover",
  "definition",
  "references",
  "symbols",
  "workspace_symbols",
  "status",
]);

export async function toolLsp(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const lsp = ctx.lsp;
  if (!lsp) {
    return {
      output:
        "lsp error: LSP is not available in this context. " +
        "Install language servers on PATH (e.g. typescript-language-server) or set .forge/lsp.json.",
      isError: true,
    };
  }
  if (!lsp.enabled) {
    return {
      output: "lsp: disabled (FORGE_LSP=0).",
      isError: true,
    };
  }

  const action = String(args.action ?? args.method ?? "diagnostics")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");

  if (!ACTIONS.has(action)) {
    return {
      output:
        `lsp error: unknown action "${args.action}". ` +
        `Use: diagnostics | hover | definition | references | symbols | workspace_symbols | status`,
      isError: true,
    };
  }

  if (action === "status") {
    return { output: formatLspStatus(lsp) };
  }

  try {
    if (action === "workspace_symbols") {
      const query = String(args.query ?? args.q ?? "").trim();
      const language =
        args.language != null ? String(args.language).trim() : undefined;
      const text = await lsp.workspaceSymbols(query, language || undefined);
      return { output: text };
    }

    const filePath = String(args.path ?? args.file ?? "").trim();
    if (!filePath) {
      return {
        output: `lsp error: path is required for action "${action}".`,
        isError: true,
      };
    }

    if (action === "diagnostics") {
      const result = await lsp.diagnostics(filePath);
      if (result.error && !result.diagnostics.length) {
        return { output: `lsp diagnostics error: ${result.error}`, isError: true };
      }
      const report = formatDiagnosticsReport(result.diagnostics);
      const header = result.languageId
        ? `[lsp ${result.languageId}] ${filePath}\n`
        : "";
      const note = result.error ? `\n(note: ${result.error})` : "";
      return { output: header + report + note };
    }

    const line = parsePos(args.line ?? args.row, "line");
    if (!line.ok) return { output: line.error!, isError: true };
    const character = parsePos(
      args.character ?? args.column ?? args.col,
      "character",
    );
    if (
      (action === "hover" ||
        action === "definition" ||
        action === "references") &&
      !character.ok
    ) {
      // character defaults to 1 when omitted
      if (args.character == null && args.column == null && args.col == null) {
        character.ok = true;
        character.value = 1;
      } else {
        return { output: character.error!, isError: true };
      }
    }

    if (action === "symbols") {
      const text = await lsp.symbols(filePath);
      return { output: text };
    }

    if (line.value == null) {
      return {
        output: `lsp error: line is required for action "${action}" (1-based).`,
        isError: true,
      };
    }
    const col = character.value ?? 1;

    if (action === "hover") {
      const text = await lsp.hover(filePath, line.value, col);
      return { output: text };
    }
    if (action === "definition") {
      const text = await lsp.definition(filePath, line.value, col);
      return { output: text };
    }
    if (action === "references") {
      const text = await lsp.references(filePath, line.value, col);
      return { output: text };
    }

    return { output: `lsp error: unhandled action ${action}`, isError: true };
  } catch (err) {
    return {
      output: `lsp error: ${(err as Error).message}`,
      isError: true,
    };
  }
}

function parsePos(
  raw: unknown,
  label: string,
): { ok: boolean; value?: number; error?: string } {
  if (raw == null || String(raw).trim() === "") {
    return { ok: true, value: undefined };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return {
      ok: false,
      error: `lsp error: ${label} must be a 1-based positive integer (got ${raw}).`,
    };
  }
  return { ok: true, value: Math.floor(n) };
}
