/**
 * MCP client: stdio (JSON-RPC) + simple HTTP streamable transport.
 * Spec-aligned initialize → tools/list → tools/call.
 */
import { JsonRpcStdioClient } from "../util/jsonrpc-stdio.js";
import { log } from "../util/log.js";
import { expandServerEnv } from "./config.js";
import type {
  McpCallResult,
  McpPromptDef,
  McpResourceDef,
  McpServerConfig,
  McpToolDef,
  McpTransport,
} from "./types.js";

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "forge", version: "0.9.99" };

export interface McpClientOptions {
  name: string;
  config: McpServerConfig;
  workspace: string;
  signal?: AbortSignal;
}

export class McpClient {
  readonly name: string;
  readonly transport: McpTransport;
  private readonly cfg: McpServerConfig;
  private readonly workspace: string;
  private readonly signal?: AbortSignal;
  private rpc: JsonRpcStdioClient | null = null;
  private tools: McpToolDef[] = [];
  private resources: McpResourceDef[] = [];
  private prompts: McpPromptDef[] = [];
  private serverCaps: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
  } = {};
  private state: "idle" | "connecting" | "ready" | "error" = "idle";
  private lastError?: string;
  private initPromise: Promise<void> | null = null;

  constructor(opts: McpClientOptions) {
    this.name = opts.name;
    this.cfg = opts.config;
    this.workspace = opts.workspace;
    this.signal = opts.signal;
    this.transport = opts.config.url ? "http" : "stdio";
  }

  getStatus(): {
    state: "idle" | "connecting" | "ready" | "error";
    toolCount: number;
    resourceCount: number;
    promptCount: number;
    error?: string;
  } {
    return {
      state: this.state,
      toolCount: this.tools.length,
      resourceCount: this.resources.length,
      promptCount: this.prompts.length,
      error: this.lastError,
    };
  }

  getTools(): McpToolDef[] {
    return this.tools.slice();
  }

  getResources(): McpResourceDef[] {
    return this.resources.slice();
  }

  getPrompts(): McpPromptDef[] {
    return this.prompts.slice();
  }

  async ensureReady(): Promise<void> {
    if (this.state === "ready") return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.connect().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  async listTools(force = false): Promise<McpToolDef[]> {
    await this.ensureReady();
    if (!force && this.tools.length) return this.tools;
    if (this.transport === "http") {
      this.tools = await this.httpListTools();
      return this.tools;
    }
    const result = (await this.rpc!.request(
      "tools/list",
      {},
      this.timeoutMs(),
    )) as { tools?: McpToolDef[] };
    this.tools = Array.isArray(result?.tools) ? result.tools : [];
    return this.tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    await this.ensureReady();
    try {
      if (this.transport === "http") {
        return await this.httpCallTool(toolName, args);
      }
      const result = (await this.rpc!.request(
        "tools/call",
        { name: toolName, arguments: args },
        this.timeoutMs(),
      )) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
        structuredContent?: unknown;
      };
      const text = formatMcpContent(result);
      return {
        content: text || "(empty MCP tool result)",
        isError: Boolean(result?.isError),
        structured: result?.structuredContent,
      };
    } catch (err) {
      return {
        content: `MCP call error (${this.name}/${toolName}): ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  async listResources(force = false): Promise<McpResourceDef[]> {
    await this.ensureReady();
    if (!force && this.resources.length) return this.resources;
    if (!this.serverCaps.resources && this.resources.length === 0) {
      // Still try once — some servers omit capability flags
    }
    try {
      if (this.transport === "http") {
        const result = (await this.httpRpc("resources/list", {})) as {
          resources?: McpResourceDef[];
        };
        this.resources = Array.isArray(result?.resources) ? result.resources : [];
        return this.resources;
      }
      const result = (await this.rpc!.request(
        "resources/list",
        {},
        this.timeoutMs(),
      )) as { resources?: McpResourceDef[] };
      this.resources = Array.isArray(result?.resources) ? result.resources : [];
      return this.resources;
    } catch (err) {
      // Method not found / unsupported — empty is fine
      const msg = (err as Error).message || "";
      if (/Method not found|-32601|not supported/i.test(msg)) {
        this.resources = [];
        return [];
      }
      throw err;
    }
  }

  async readResource(uri: string): Promise<McpCallResult> {
    await this.ensureReady();
    try {
      const result =
        this.transport === "http"
          ? await this.httpRpc("resources/read", { uri })
          : await this.rpc!.request(
              "resources/read",
              { uri },
              this.timeoutMs(),
            );
      const text = formatResourceContents(result);
      return { content: text || "(empty resource)", isError: false };
    } catch (err) {
      return {
        content: `MCP resource read error (${this.name}): ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  async listPrompts(force = false): Promise<McpPromptDef[]> {
    await this.ensureReady();
    if (!force && this.prompts.length) return this.prompts;
    try {
      if (this.transport === "http") {
        const result = (await this.httpRpc("prompts/list", {})) as {
          prompts?: McpPromptDef[];
        };
        this.prompts = Array.isArray(result?.prompts) ? result.prompts : [];
        return this.prompts;
      }
      const result = (await this.rpc!.request(
        "prompts/list",
        {},
        this.timeoutMs(),
      )) as { prompts?: McpPromptDef[] };
      this.prompts = Array.isArray(result?.prompts) ? result.prompts : [];
      return this.prompts;
    } catch (err) {
      const msg = (err as Error).message || "";
      if (/Method not found|-32601|not supported/i.test(msg)) {
        this.prompts = [];
        return [];
      }
      throw err;
    }
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<McpCallResult> {
    await this.ensureReady();
    try {
      const params = {
        name,
        ...(args && Object.keys(args).length ? { arguments: args } : {}),
      };
      const result =
        this.transport === "http"
          ? await this.httpRpc("prompts/get", params)
          : await this.rpc!.request("prompts/get", params, this.timeoutMs());
      const text = formatPromptResult(result);
      return { content: text || "(empty prompt)", isError: false };
    } catch (err) {
      return {
        content: `MCP prompt get error (${this.name}/${name}): ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  async dispose(): Promise<void> {
    this.state = "idle";
    if (this.rpc) {
      await this.rpc.dispose();
      this.rpc = null;
    }
  }

  private timeoutMs(): number {
    return this.cfg.timeoutMs ?? 60_000;
  }

  private async connect(): Promise<void> {
    this.state = "connecting";
    this.lastError = undefined;
    try {
      if (this.transport === "http") {
        await this.httpInitialize();
        this.tools = await this.httpListTools();
        this.state = "ready";
        return;
      }
      if (!this.cfg.command) {
        throw new Error("stdio MCP server requires command");
      }
      const env = expandServerEnv(this.cfg.env);
      this.rpc = new JsonRpcStdioClient({
        command: this.cfg.command,
        args: this.cfg.args || [],
        env: env as NodeJS.ProcessEnv | undefined,
        cwd: this.cfg.cwd
          ? this.cfg.cwd
          : this.workspace,
        label: `mcp:${this.name}`,
        signal: this.signal,
        onNotification: (method) => {
          if (method === "notifications/tools/list_changed") {
            // Refresh lazily on next listTools(force)
            this.tools = [];
          }
        },
        onServerRequest: async (method, _params) => {
          // Minimal client capabilities — reject unknown roots/sampling
          if (method === "ping") return {};
          if (method === "roots/list") {
            return { roots: [{ uri: pathToFileUri(this.workspace), name: "workspace" }] };
          }
          throw new Error(`Unsupported server request: ${method}`);
        },
      });
      this.rpc.start();
      const initResult = (await this.rpc.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            roots: { listChanged: false },
          },
          clientInfo: CLIENT_INFO,
        },
        30_000,
      )) as {
        capabilities?: {
          tools?: unknown;
          resources?: unknown;
          prompts?: unknown;
        };
      };
      this.serverCaps = {
        tools: Boolean(initResult?.capabilities?.tools),
        resources: Boolean(initResult?.capabilities?.resources),
        prompts: Boolean(initResult?.capabilities?.prompts),
      };
      this.rpc.notify("notifications/initialized", {});
      const listed = (await this.rpc.request(
        "tools/list",
        {},
        this.timeoutMs(),
      )) as { tools?: McpToolDef[] };
      this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
      // Best-effort discover resources/prompts (ignore unsupported)
      await this.listResources(true).catch(() => {
        this.resources = [];
      });
      await this.listPrompts(true).catch(() => {
        this.prompts = [];
      });
      this.state = "ready";
      log.dim(
        `MCP server ready: ${this.name} (${this.tools.length} tools` +
          (this.resources.length ? `, ${this.resources.length} resources` : "") +
          (this.prompts.length ? `, ${this.prompts.length} prompts` : "") +
          `)`,
      );
    } catch (err) {
      this.state = "error";
      this.lastError = (err as Error).message;
      if (this.rpc) {
        await this.rpc.dispose().catch(() => {});
        this.rpc = null;
      }
      throw err;
    }
  }

  private async httpInitialize(): Promise<void> {
    // Streamable HTTP: POST initialize, then tools/list. Best-effort for remote MCP.
    const url = this.cfg.url!;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.cfg.headers || {}),
    };
    const initBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    };
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify(initBody),
      signal: this.signal,
      timeoutMs: 30_000,
    });
    if (!res.ok) {
      throw new Error(`HTTP MCP initialize failed: HTTP ${res.status}`);
    }
    // Session id header if present (streamable HTTP)
    const session = res.headers.get("mcp-session-id");
    if (session) {
      this.cfg.headers = { ...this.cfg.headers, "mcp-session-id": session };
    }
  }

  private async httpListTools(): Promise<McpToolDef[]> {
    const result = await this.httpRpc("tools/list", {});
    const tools = (result as { tools?: McpToolDef[] })?.tools;
    return Array.isArray(tools) ? tools : [];
  }

  private async httpCallTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    try {
      const result = (await this.httpRpc("tools/call", {
        name: toolName,
        arguments: args,
      })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      return {
        content: formatMcpContent(result) || "(empty MCP tool result)",
        isError: Boolean(result?.isError),
      };
    } catch (err) {
      return {
        content: `MCP HTTP call error (${this.name}/${toolName}): ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  private async httpRpc(method: string, params: unknown): Promise<unknown> {
    const url = this.cfg.url!;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.cfg.headers || {}),
    };
    const id = Date.now();
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }),
      signal: this.signal,
      timeoutMs: this.timeoutMs(),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${method}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      const text = await res.text();
      return parseSseJsonRpcResult(text, id);
    }
    const json = (await res.json()) as {
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    if (json.error) {
      throw new Error(json.error.message || `RPC error ${json.error.code}`);
    }
    return json.result;
  }
}

function formatResourceContents(result: unknown): string {
  if (!result || typeof result !== "object") {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  const o = result as {
    contents?: Array<{
      uri?: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    }>;
  };
  if (!Array.isArray(o.contents) || !o.contents.length) {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  const parts: string[] = [];
  for (const c of o.contents) {
    const head = [c.uri, c.mimeType].filter(Boolean).join(" · ");
    if (head) parts.push(`--- ${head} ---`);
    if (typeof c.text === "string") parts.push(c.text);
    else if (typeof c.blob === "string") {
      parts.push(`[binary blob ${c.blob.length} chars base64 — truncated]`);
    }
  }
  return parts.join("\n");
}

function formatPromptResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  const o = result as {
    description?: string;
    messages?: Array<{
      role?: string;
      content?:
        | string
        | { type?: string; text?: string }
        | Array<{ type?: string; text?: string }>;
    }>;
  };
  const parts: string[] = [];
  if (o.description) parts.push(o.description, "");
  for (const m of o.messages || []) {
    const role = m.role || "message";
    let body = "";
    if (typeof m.content === "string") body = m.content;
    else if (Array.isArray(m.content)) {
      body = m.content
        .map((c) => (typeof c?.text === "string" ? c.text : JSON.stringify(c)))
        .join("\n");
    } else if (m.content && typeof m.content === "object") {
      body =
        typeof (m.content as { text?: string }).text === "string"
          ? (m.content as { text: string }).text
          : JSON.stringify(m.content);
    }
    parts.push(`### ${role}\n${body}`);
  }
  return parts.join("\n\n") || JSON.stringify(result, null, 2);
}

function formatMcpContent(result: {
  content?: Array<{ type?: string; text?: string; data?: unknown }>;
}): string {
  if (!result?.content || !Array.isArray(result.content)) {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  const parts: string[] = [];
  for (const c of result.content) {
    if (!c) continue;
    if (c.type === "text" && typeof c.text === "string") {
      parts.push(c.text);
    } else if (typeof c.text === "string") {
      parts.push(c.text);
    } else {
      try {
        parts.push(JSON.stringify(c));
      } catch {
        parts.push(String(c));
      }
    }
  }
  return parts.join("\n\n");
}

function pathToFileUri(p: string): string {
  const abs = p.replace(/\\/g, "/");
  if (abs.startsWith("/")) return `file://${abs}`;
  return `file:///${abs}`;
}

async function fetchWithTimeout(
  url: string,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  t.unref?.();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    return await fetch(url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Extract first JSON-RPC result from an SSE stream body. */
function parseSseJsonRpcResult(text: string, id: number): unknown {
  const lines = text.split(/\r?\n/);
  let data = "";
  for (const line of lines) {
    if (line.startsWith("data:")) {
      data += line.slice(5).trim();
    } else if (line === "" && data) {
      try {
        const msg = JSON.parse(data) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (msg.error) throw new Error(msg.error.message || "SSE RPC error");
        if (msg.id === id || msg.result !== undefined) return msg.result;
      } catch (err) {
        if (err instanceof SyntaxError) {
          data = "";
          continue;
        }
        throw err;
      }
      data = "";
    }
  }
  if (data) {
    const msg = JSON.parse(data) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (msg.error) throw new Error(msg.error.message || "SSE RPC error");
    return msg.result;
  }
  throw new Error("No JSON-RPC result in SSE stream");
}
