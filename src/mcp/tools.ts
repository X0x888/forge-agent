/**
 * Model-facing MCP tools: search_mcp + call_mcp (Grok-style search then use).
 */
import type { ToolContext, ToolResult } from "../agent/tools/types.js";
import type { McpManager } from "./manager.js";

export async function toolSearchMcp(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const mcp = ctx.mcp;
  if (!mcp) {
    return {
      output:
        "search_mcp error: MCP is not available in this context. " +
        "Configure servers in .forge/mcp.json or ~/.forge/mcp.json.",
      isError: true,
    };
  }
  if (!mcp.enabled) {
    return {
      output: "search_mcp: MCP disabled (FORGE_MCP=0).",
      isError: true,
    };
  }
  const query = String(args.query ?? args.q ?? "").trim();
  let limit = 8;
  if (args.limit != null && String(args.limit).trim() !== "") {
    const n = Number(args.limit);
    if (!Number.isFinite(n) || n < 1) {
      return {
        output:
          'search_mcp error: limit must be a positive integer (default 8, max 50).',
        isError: true,
      };
    }
    limit = Math.min(50, Math.floor(n));
  }
  try {
    const result = await mcp.search(query || "*", limit);
    if (!result.tools.length) {
      const errs = result.serverErrors.length
        ? `\nServer errors:\n${result.serverErrors.map((e) => `  - ${e}`).join("\n")}`
        : "";
      return {
        output:
          (query
            ? `No MCP tools matched "${query}".`
            : "No MCP tools registered.") +
          "\nConfigure .forge/mcp.json / ~/.forge/mcp.json (Claude/Cursor shape: { \"mcpServers\": { … } })." +
          "\nUse /mcp status in the REPL for connectivity." +
          errs,
        isError: false,
      };
    }
    const lines: string[] = [
      query
        ? `MCP tools matching "${query}" (${result.tools.length}):`
        : `MCP tools (${result.tools.length}):`,
    ];
    if (result.partial) {
      lines.push(
        "(Partial: some servers still connecting or failed — see server errors below.)",
      );
    }
    for (const t of result.tools) {
      lines.push(
        `- **${t.name}**${t.readOnly ? " [read-only]" : ""} — ${t.description || "(no description)"}`,
      );
      if (t.inputSchema && typeof t.inputSchema === "object") {
        const props =
          (t.inputSchema as { properties?: Record<string, unknown> })
            .properties || {};
        const required =
          (t.inputSchema as { required?: string[] }).required || [];
        const keys = Object.keys(props).slice(0, 12);
        if (keys.length) {
          lines.push(
            `  params: ${keys
              .map((k) => (required.includes(k) ? `${k}*` : k))
              .join(", ")}`,
          );
        }
      }
    }
    lines.push(
      "",
      "Call with call_mcp({ tool_name: \"server__tool\", arguments: { … } }).",
    );
    if (result.serverErrors.length) {
      lines.push("", "Server errors:");
      for (const e of result.serverErrors) lines.push(`  - ${e}`);
    }
    return { output: lines.join("\n") };
  } catch (err) {
    return {
      output: `search_mcp error: ${(err as Error).message}`,
      isError: true,
    };
  }
}

export async function toolCallMcp(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const mcp = ctx.mcp;
  if (!mcp) {
    return {
      output:
        "call_mcp error: MCP is not available in this context. " +
        "Configure servers in .forge/mcp.json or ~/.forge/mcp.json.",
      isError: true,
    };
  }
  if (!mcp.enabled) {
    return {
      output: "call_mcp: MCP disabled (FORGE_MCP=0).",
      isError: true,
    };
  }
  const toolName = String(
    args.tool_name ?? args.name ?? args.tool ?? "",
  ).trim();
  if (!toolName) {
    return {
      output:
        "call_mcp error: tool_name is required (qualified server__tool from search_mcp).",
      isError: true,
    };
  }
  let toolArgs: Record<string, unknown> = {};
  const rawArgs = args.arguments ?? args.args ?? args.input;
  if (rawArgs != null) {
    if (typeof rawArgs === "string") {
      try {
        const parsed = JSON.parse(rawArgs) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return {
            output:
              "call_mcp error: arguments must be a JSON object (got array/primitive).",
            isError: true,
          };
        }
        toolArgs = parsed as Record<string, unknown>;
      } catch {
        return {
          output:
            "call_mcp error: arguments string is not valid JSON object.",
          isError: true,
        };
      }
    } else if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      toolArgs = rawArgs as Record<string, unknown>;
    } else {
      return {
        output: "call_mcp error: arguments must be an object.",
        isError: true,
      };
    }
  }
  try {
    const result = await mcp.call(toolName, toolArgs);
    const header = result.qualifiedName
      ? `[mcp ${result.qualifiedName}]\n`
      : "";
    return {
      output: header + result.content,
      isError: result.isError,
    };
  } catch (err) {
    return {
      output: `call_mcp error: ${(err as Error).message}`,
      isError: true,
    };
  }
}

/** Whether call_mcp target looks read-only (for plan mode / parallel batches). */
export function mcpCallIsReadOnly(
  mcp: McpManager | undefined,
  args: Record<string, unknown>,
): boolean {
  if (!mcp) return false;
  const toolName = String(
    args.tool_name ?? args.name ?? args.tool ?? "",
  ).trim();
  if (!toolName) return false;
  return mcp.isReadOnlyTool(toolName);
}
