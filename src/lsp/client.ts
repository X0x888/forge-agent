/**
 * Single language-server process (LSP over stdio JSON-RPC).
 */
import fs from "node:fs";
import path from "node:path";
import { displayRelPath } from "../agent/tools/path-util.js";
import { JsonRpcStdioClient } from "../util/jsonrpc-stdio.js";
import { log } from "../util/log.js";
import {
  severityLabel,
  type LspDiagnostic,
  type LspServerConfig,
} from "./types.js";

export class LspClient {
  readonly languageId: string;
  readonly config: LspServerConfig;
  private rpc: JsonRpcStdioClient | null = null;
  private state: "idle" | "starting" | "ready" | "error" | "missing" = "idle";
  private lastError?: string;
  private readonly workspace: string;
  private readonly signal?: AbortSignal;
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly openDocs = new Map<
    string,
    { version: number; text: string }
  >();
  private initPromise: Promise<void> | null = null;
  private serverCapabilities: Record<string, unknown> = {};

  constructor(opts: {
    config: LspServerConfig;
    workspace: string;
    signal?: AbortSignal;
  }) {
    this.config = opts.config;
    this.languageId = opts.config.languageId;
    this.workspace = opts.workspace;
    this.signal = opts.signal;
  }

  getStatus(): {
    state: "idle" | "starting" | "ready" | "error" | "missing";
    error?: string;
    openDocuments: number;
  } {
    return {
      state: this.state,
      error: this.lastError,
      openDocuments: this.openDocs.size,
    };
  }

  async ensureReady(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "missing") {
      throw new Error(
        this.lastError ||
          `LSP ${this.languageId}: command not found: ${this.config.command}`,
      );
    }
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.start().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  async dispose(): Promise<void> {
    try {
      if (this.rpc && this.state === "ready") {
        this.rpc.notify("exit");
        await this.rpc.request("shutdown", null, 3000).catch(() => {});
      }
    } catch {
      /* */
    }
    if (this.rpc) await this.rpc.dispose().catch(() => {});
    this.rpc = null;
    this.state = "idle";
    this.openDocs.clear();
    this.diagnostics.clear();
  }

  /**
   * Open (or update) a document so the server has content for requests.
   */
  async syncDocument(absPath: string, text?: string): Promise<void> {
    await this.ensureReady();
    const uri = pathToUri(absPath);
    let content = text;
    if (content == null) {
      content = await fs.promises.readFile(absPath, "utf8");
    }
    const existing = this.openDocs.get(uri);
    if (!existing) {
      this.openDocs.set(uri, { version: 1, text: content });
      this.rpc!.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.languageId,
          version: 1,
          text: content,
        },
      });
    } else if (existing.text !== content) {
      const version = existing.version + 1;
      this.openDocs.set(uri, { version, text: content });
      this.rpc!.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }
  }

  getDiagnostics(absPath?: string): LspDiagnostic[] {
    if (absPath) {
      return this.diagnostics.get(pathToUri(absPath))?.slice() || [];
    }
    const all: LspDiagnostic[] = [];
    for (const diags of this.diagnostics.values()) all.push(...diags);
    return all;
  }

  async hover(
    absPath: string,
    line: number,
    character: number,
  ): Promise<string> {
    await this.syncDocument(absPath);
    const result = (await this.rpc!.request(
      "textDocument/hover",
      {
        textDocument: { uri: pathToUri(absPath) },
        position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
      },
      15_000,
    )) as { contents?: unknown } | null;
    if (!result) return "(no hover info)";
    return formatHover(result.contents);
  }

  async definition(
    absPath: string,
    line: number,
    character: number,
  ): Promise<string> {
    await this.syncDocument(absPath);
    const result = await this.rpc!.request(
      "textDocument/definition",
      {
        textDocument: { uri: pathToUri(absPath) },
        position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
      },
      15_000,
    );
    return formatLocations(result, this.workspace);
  }

  async references(
    absPath: string,
    line: number,
    character: number,
  ): Promise<string> {
    await this.syncDocument(absPath);
    const result = await this.rpc!.request(
      "textDocument/references",
      {
        textDocument: { uri: pathToUri(absPath) },
        position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
        context: { includeDeclaration: true },
      },
      20_000,
    );
    return formatLocations(result, this.workspace);
  }

  async documentSymbols(absPath: string): Promise<string> {
    await this.syncDocument(absPath);
    const result = await this.rpc!.request(
      "textDocument/documentSymbol",
      { textDocument: { uri: pathToUri(absPath) } },
      20_000,
    );
    return formatSymbols(result);
  }

  async workspaceSymbols(query: string): Promise<string> {
    await this.ensureReady();
    const result = await this.rpc!.request(
      "workspace/symbol",
      { query: query || "" },
      20_000,
    );
    return formatSymbols(result);
  }

  /**
   * Wait briefly for publishDiagnostics after open/change.
   */
  async waitForDiagnostics(
    absPath: string,
    timeoutMs = 2500,
  ): Promise<LspDiagnostic[]> {
    await this.syncDocument(absPath);
    const uri = pathToUri(absPath);
    const start = Date.now();
    // If server already published, return immediately
    if (this.diagnostics.has(uri)) {
      // Give a short settle window for updates after didChange
      await sleep(150);
      return this.getDiagnostics(absPath);
    }
    while (Date.now() - start < timeoutMs) {
      if (this.diagnostics.has(uri)) {
        await sleep(100);
        return this.getDiagnostics(absPath);
      }
      await sleep(80);
    }
    return this.getDiagnostics(absPath);
  }

  private async start(): Promise<void> {
    this.state = "starting";
    this.lastError = undefined;
    if (!commandExists(this.config.command)) {
      this.state = "missing";
      this.lastError = `command not found on PATH: ${this.config.command}`;
      throw new Error(
        `LSP ${this.languageId}: ${this.lastError}. Install the language server or set .forge/lsp.json.`,
      );
    }
    try {
      this.rpc = new JsonRpcStdioClient({
        command: this.config.command,
        args: this.config.args || [],
        cwd: this.workspace,
        label: `lsp:${this.languageId}`,
        signal: this.signal,
        onNotification: (method, params) => {
          if (method === "textDocument/publishDiagnostics") {
            this.onPublishDiagnostics(params);
          }
        },
        onServerRequest: async (method, params) => {
          if (method === "window/workDoneProgress/create") return null;
          if (method === "workspace/configuration") {
            return Array.isArray(params)
              ? (params as unknown[]).map(() => ({}))
              : {};
          }
          if (method === "client/registerCapability") return null;
          if (method === "workspace/workspaceFolders") {
            return [
              {
                uri: pathToUri(this.workspace),
                name: path.basename(this.workspace) || "workspace",
              },
            ];
          }
          // Default empty success for unknown server requests
          return null;
        },
      });
      this.rpc.start();
      const initResult = (await this.rpc.request(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "forge", version: "0.9.99" },
          rootUri: pathToUri(this.workspace),
          rootPath: this.workspace,
          workspaceFolders: [
            {
              uri: pathToUri(this.workspace),
              name: path.basename(this.workspace) || "workspace",
            },
          ],
          capabilities: {
            workspace: {
              configuration: true,
              workspaceFolders: true,
              didChangeConfiguration: { dynamicRegistration: false },
            },
            textDocument: {
              synchronization: {
                dynamicRegistration: false,
                willSave: false,
                didSave: true,
                willSaveWaitUntil: false,
              },
              hover: {
                contentFormat: ["markdown", "plaintext"],
              },
              definition: { linkSupport: true },
              references: {},
              documentSymbol: {
                hierarchicalDocumentSymbolSupport: true,
              },
              publishDiagnostics: {
                relatedInformation: true,
              },
            },
          },
          initializationOptions: this.config.initializationOptions ?? {},
          trace: "off",
        },
        30_000,
      )) as { capabilities?: Record<string, unknown> };
      this.serverCapabilities = initResult?.capabilities || {};
      this.rpc.notify("initialized", {});
      this.state = "ready";
      log.dim(`LSP ready: ${this.languageId} (${this.config.command})`);
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

  private onPublishDiagnostics(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const p = params as {
      uri?: string;
      diagnostics?: Array<{
        range?: {
          start?: { line?: number; character?: number };
          end?: { line?: number; character?: number };
        };
        severity?: number;
        message?: string;
        source?: string;
        code?: string | number;
      }>;
    };
    if (!p.uri) return;
    const filePath = uriToPath(p.uri);
    const diags: LspDiagnostic[] = [];
    for (const d of p.diagnostics || []) {
      diags.push({
        path: filePath,
        line: (d.range?.start?.line ?? 0) + 1,
        character: (d.range?.start?.character ?? 0) + 1,
        endLine: (d.range?.end?.line ?? 0) + 1,
        endCharacter: (d.range?.end?.character ?? 0) + 1,
        severity: severityLabel(d.severity),
        message: d.message || "",
        source: d.source,
        code: d.code,
      });
    }
    this.diagnostics.set(p.uri, diags);
  }
}

function pathToUri(absPath: string): string {
  const resolved = path.resolve(absPath);
  let normalized = resolved.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) normalized = "/" + normalized;
  // Encode spaces etc. but keep path separators
  return "file://" + encodeURI(normalized).replace(/#/g, "%23");
}

function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    let p = uri.slice("file://".length);
    // Windows file:///C:/...
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  }
  return uri;
}

function commandExists(cmd: string): boolean {
  if (cmd.includes("/") || cmd.includes("\\")) {
    return fs.existsSync(cmd);
  }
  const pathEnv = process.env.PATH || "";
  const parts = pathEnv.split(path.delimiter);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const dir of parts) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(candidate)) return true;
      } catch {
        /* */
      }
    }
  }
  return false;
}

function formatHover(contents: unknown): string {
  if (contents == null) return "(no hover info)";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((c) => formatHover(c)).filter(Boolean).join("\n\n");
  }
  if (typeof contents === "object") {
    const o = contents as { kind?: string; value?: string; language?: string };
    if (typeof o.value === "string") {
      if (o.language) return "```" + o.language + "\n" + o.value + "\n```";
      return o.value;
    }
  }
  try {
    return JSON.stringify(contents, null, 2);
  } catch {
    return String(contents);
  }
}

function formatLocations(result: unknown, workspace: string): string {
  if (result == null) return "(no locations)";
  const locs = Array.isArray(result) ? result : [result];
  if (!locs.length) return "(no locations)";
  const lines: string[] = [];
  for (const loc of locs.slice(0, 50)) {
    if (!loc || typeof loc !== "object") continue;
    const o = loc as {
      uri?: string;
      targetUri?: string;
      range?: { start?: { line?: number; character?: number } };
      targetRange?: { start?: { line?: number; character?: number } };
      targetSelectionRange?: { start?: { line?: number; character?: number } };
    };
    const uri = o.uri || o.targetUri || "";
    const range =
      o.range || o.targetSelectionRange || o.targetRange || {};
    const line = (range.start?.line ?? 0) + 1;
    const col = (range.start?.character ?? 0) + 1;
    let filePath = uriToPath(uri);
    try {
      const rel = displayRelPath(workspace, filePath);
      if (rel && !path.isAbsolute(rel)) filePath = rel;
    } catch {
      /* */
    }
    lines.push(`${filePath}:${line}:${col}`);
  }
  if (locs.length > 50) lines.push(`… +${locs.length - 50} more`);
  return lines.join("\n") || "(no locations)";
}

function formatSymbols(result: unknown): string {
  if (result == null) return "(no symbols)";
  if (!Array.isArray(result) || !result.length) return "(no symbols)";
  const lines: string[] = [];
  const walk = (items: unknown[], indent: number) => {
    for (const item of items.slice(0, 80)) {
      if (!item || typeof item !== "object") continue;
      const o = item as {
        name?: string;
        kind?: number;
        detail?: string;
        range?: { start?: { line?: number } };
        location?: {
          uri?: string;
          range?: { start?: { line?: number } };
        };
        children?: unknown[];
      };
      const line =
        (o.range?.start?.line ?? o.location?.range?.start?.line ?? 0) + 1;
      const kind = symbolKindName(o.kind);
      const pad = "  ".repeat(indent);
      lines.push(
        `${pad}${o.name || "?"}${kind ? ` (${kind})` : ""}${line ? ` L${line}` : ""}${o.detail ? ` — ${o.detail}` : ""}`,
      );
      if (Array.isArray(o.children) && o.children.length) {
        walk(o.children, indent + 1);
      }
      if (lines.length >= 100) return;
    }
  };
  walk(result, 0);
  if (result.length > 80) lines.push("… truncated");
  return lines.join("\n");
}

function symbolKindName(kind: number | undefined): string {
  const map: Record<number, string> = {
    1: "file",
    2: "module",
    3: "namespace",
    4: "package",
    5: "class",
    6: "method",
    7: "property",
    8: "field",
    9: "constructor",
    10: "enum",
    11: "interface",
    12: "function",
    13: "variable",
    14: "constant",
    15: "string",
    16: "number",
    17: "boolean",
    18: "array",
    19: "object",
    20: "key",
    21: "null",
    22: "enumMember",
    23: "struct",
    24: "event",
    25: "operator",
    26: "typeParameter",
  };
  return kind != null ? map[kind] || String(kind) : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
