/**
 * Multi-language LSP manager — lazy start per language, workspace-scoped.
 */
import path from "node:path";
import { isWithinRoot } from "../util/fs.js";
import { LspClient } from "./client.js";
import { loadLspConfig, type LoadedLspConfig } from "./config.js";
import { formatMissingServerTips } from "./install-guide.js";
import { commandOnPath } from "./path-util.js";
import {
  languageIdForPath,
  type LspDiagnostic,
  type LspServerConfig,
  type LspServerStatus,
} from "./types.js";

export interface LspManagerOptions {
  workspace: string;
  signal?: AbortSignal;
  config?: LoadedLspConfig;
}

export class LspManager {
  private readonly workspace: string;
  private readonly signal?: AbortSignal;
  private readonly config: LoadedLspConfig;
  private readonly clients = new Map<string, LspClient>();

  constructor(opts: LspManagerOptions) {
    this.workspace = path.resolve(opts.workspace);
    this.signal = opts.signal;
    this.config = opts.config ?? loadLspConfig(opts.workspace);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get sources(): string[] {
    return this.config.sources.slice();
  }

  get servers(): LspServerConfig[] {
    return this.config.servers.slice();
  }

  status(): LspServerStatus[] {
    const out: LspServerStatus[] = [];
    for (const s of this.config.servers) {
      const client = this.clients.get(s.languageId);
      if (client) {
        const st = client.getStatus();
        out.push({
          languageId: s.languageId,
          state: st.state,
          command: s.command,
          error: st.error,
          openDocuments: st.openDocuments,
        });
      } else {
        out.push({
          languageId: s.languageId,
          state: "idle",
          command: s.command,
        });
      }
    }
    return out;
  }

  async dispose(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((c) => c.dispose().catch(() => {})));
  }

  resolveLanguage(filePath: string): string | null {
    return languageIdForPath(filePath, this.config.servers);
  }

  private async clientFor(
    languageId: string,
  ): Promise<LspClient> {
    let client = this.clients.get(languageId);
    if (client) {
      await client.ensureReady();
      return client;
    }
    const cfg = this.config.servers.find((s) => s.languageId === languageId);
    if (!cfg) {
      throw new Error(`No LSP server configured for language: ${languageId}`);
    }
    client = new LspClient({
      config: cfg,
      workspace: this.workspace,
      signal: this.signal,
    });
    this.clients.set(languageId, client);
    try {
      await client.ensureReady();
    } catch (err) {
      // Keep client for status (missing/error); rethrow
      throw err;
    }
    return client;
  }

  private resolvePath(p: string): { abs: string; error?: string } {
    const raw = (p || "").trim();
    if (!raw) return { abs: "", error: "path is required" };
    const abs = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(this.workspace, raw);
    if (!isWithinRoot(this.workspace, abs)) {
      return {
        abs,
        error: `path outside workspace: ${raw} (LSP is workspace-scoped)`,
      };
    }
    return { abs };
  }

  async diagnostics(filePath: string): Promise<{
    diagnostics: LspDiagnostic[];
    languageId: string;
    error?: string;
  }> {
    const { abs, error } = this.resolvePath(filePath);
    if (error) return { diagnostics: [], languageId: "", error };
    const lang = this.resolveLanguage(abs);
    if (!lang) {
      return {
        diagnostics: [],
        languageId: "",
        error: `No LSP server for file type: ${path.extname(abs) || "(none)"}. Configure .forge/lsp.json or install a default server.`,
      };
    }
    try {
      const client = await this.clientFor(lang);
      const diags = await client.waitForDiagnostics(abs);
      return { diagnostics: diags, languageId: lang };
    } catch (err) {
      return {
        diagnostics: [],
        languageId: lang,
        error: (err as Error).message,
      };
    }
  }

  async hover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<string> {
    const { abs, error } = this.resolvePath(filePath);
    if (error) throw new Error(error);
    const lang = this.resolveLanguage(abs);
    if (!lang) throw new Error(`No LSP server for ${path.extname(abs)}`);
    const client = await this.clientFor(lang);
    return client.hover(abs, line, character);
  }

  async definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<string> {
    const { abs, error } = this.resolvePath(filePath);
    if (error) throw new Error(error);
    const lang = this.resolveLanguage(abs);
    if (!lang) throw new Error(`No LSP server for ${path.extname(abs)}`);
    const client = await this.clientFor(lang);
    return client.definition(abs, line, character);
  }

  async references(
    filePath: string,
    line: number,
    character: number,
  ): Promise<string> {
    const { abs, error } = this.resolvePath(filePath);
    if (error) throw new Error(error);
    const lang = this.resolveLanguage(abs);
    if (!lang) throw new Error(`No LSP server for ${path.extname(abs)}`);
    const client = await this.clientFor(lang);
    return client.references(abs, line, character);
  }

  async symbols(filePath: string): Promise<string> {
    const { abs, error } = this.resolvePath(filePath);
    if (error) throw new Error(error);
    const lang = this.resolveLanguage(abs);
    if (!lang) throw new Error(`No LSP server for ${path.extname(abs)}`);
    const client = await this.clientFor(lang);
    return client.documentSymbols(abs);
  }

  async workspaceSymbols(query: string, languageId?: string): Promise<string> {
    // Prefer an already-running client, else first matching server
    if (languageId) {
      const client = await this.clientFor(languageId);
      return client.workspaceSymbols(query);
    }
    for (const [id, client] of this.clients) {
      if (client.getStatus().state === "ready") {
        return client.workspaceSymbols(query);
      }
      void id;
    }
    // Start typescript as a reasonable default when present
    const prefer = ["typescript", "python", "rust", "go"];
    for (const id of prefer) {
      if (this.config.servers.some((s) => s.languageId === id)) {
        try {
          const client = await this.clientFor(id);
          return client.workspaceSymbols(query);
        } catch {
          continue;
        }
      }
    }
    throw new Error(
      "No LSP server running for workspace_symbols. Open a file first (diagnostics/hover) or pass language.",
    );
  }
}

let activeLsp: LspManager | null = null;

export function setActiveLspManager(m: LspManager | null): void {
  activeLsp = m;
}

export function getActiveLspManager(): LspManager | null {
  return activeLsp;
}

/**
 * Sit-down `/lsp` peek. Install recipes stay on `/lsp install`.
 */
export function formatLspStatus(
  manager: LspManager,
  opts?: { note?: string },
): string {
  if (!manager.enabled) {
    return ["lsp  ·  off", "  disabled  ·  FORGE_LSP=0"].join("\n");
  }
  const statuses = manager.status();
  let missing = 0;
  try {
    missing = formatMissingServerTips(manager.servers, commandOnPath).length;
  } catch {
    /* */
  }
  const errors = statuses.filter((s) => s.state === "error");
  const ready = statuses.filter((s) => s.state === "ready");
  let verdict = "lsp  ·  idle";
  if (!statuses.length) verdict = "lsp  ·  none";
  else if (errors.length) verdict = "lsp  ·  error";
  else if (missing) verdict = "lsp  ·  missing";
  else if (ready.length === statuses.length) verdict = "lsp  ·  ready";
  else if (ready.length)
    verdict = `lsp  ·  ${ready.length}/${statuses.length} ready`;
  const lines = [verdict];
  const note = opts?.note?.trim();
  if (note) lines.push(`  ${note}`);
  for (const s of statuses.slice(0, 6)) {
    const err = s.error ? `  ${s.error.slice(0, 60)}` : "";
    lines.push(`  ${s.languageId}  ${s.state}${err}`);
  }
  if (statuses.length > 6) {
    lines.push(`  … +${statuses.length - 6} more`);
  }
  if (missing || !statuses.length) lines.push("Next  /lsp ensure");
  else if (errors.length) lines.push("Next  /lsp restart");
  return lines.join("\n");
}

export function formatDiagnosticsReport(
  diags: LspDiagnostic[],
  opts?: { max?: number },
): string {
  const max = opts?.max ?? 50;
  const order = { error: 0, warning: 1, info: 2, hint: 3, unknown: 4 };
  const counts = { error: 0, warning: 0, info: 0, hint: 0, unknown: 0 };
  for (const d of diags) counts[d.severity] = (counts[d.severity] || 0) + 1;
  const bits: string[] = [];
  if (counts.error)
    bits.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`);
  if (counts.warning)
    bits.push(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`);
  const info = counts.info + counts.hint;
  if (info) bits.push(`${info} info`);
  if (!diags.length || !bits.length) return "diagnostics  ·  ok";
  const sorted = [...diags].sort(
    (a, b) =>
      (order[a.severity] ?? 9) - (order[b.severity] ?? 9) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
  const lines: string[] = [`diagnostics  ·  ${bits.join("  ·  ")}`];
  for (const d of sorted.slice(0, max)) {
    const code = d.code != null ? ` [${d.code}]` : "";
    const src = d.source ? ` (${d.source})` : "";
    lines.push(
      `  ${d.path}:${d.line}:${d.character} ${d.severity}${code}${src}: ${d.message}`,
    );
  }
  if (sorted.length > max) lines.push(`  … +${sorted.length - max} more`);
  return lines.join("\n");
}
