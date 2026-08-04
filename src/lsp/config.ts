/**
 * Load LSP server config from project + user + defaults.
 *
 * Paths:
 *   ~/.forge/lsp.json
 *   <workspace>/.forge/lsp.json
 *
 * Env: FORGE_LSP=0 disables. FORGE_LSP_CONFIG=path extra file.
 */
import fs from "node:fs";
import path from "node:path";
import { forgeHome, readJsonFile } from "../util/fs.js";
import {
  DEFAULT_LSP_SERVERS,
  type LspConfigFile,
  type LspServerConfig,
} from "./types.js";

export interface LoadedLspConfig {
  enabled: boolean;
  servers: LspServerConfig[];
  sources: string[];
}

function isDisabledByEnv(): boolean {
  const v = process.env.FORGE_LSP?.trim().toLowerCase();
  if (!v) return false;
  return v === "0" || v === "false" || v === "off" || v === "no";
}

function mergeServer(
  base: LspServerConfig,
  overlay: Partial<LspServerConfig> & { command?: string },
): LspServerConfig {
  return {
    languageId: overlay.languageId || base.languageId,
    extensions: overlay.extensions?.length
      ? overlay.extensions
      : base.extensions,
    command: overlay.command || base.command,
    args: overlay.args ?? base.args,
    initializationOptions:
      overlay.initializationOptions ?? base.initializationOptions,
    disabled: overlay.disabled ?? base.disabled,
  };
}

function parseFile(file: string): LspConfigFile {
  if (!fs.existsSync(file)) return {};
  return readJsonFile<LspConfigFile>(file, {});
}

export function loadLspConfig(workspace: string): LoadedLspConfig {
  if (isDisabledByEnv()) {
    return { enabled: false, servers: [], sources: [] };
  }
  const sources: string[] = [];
  const homeFile = path.join(forgeHome(), "lsp.json");
  const projectFile = path.join(
    path.resolve(workspace || process.cwd()),
    ".forge",
    "lsp.json",
  );
  const files = [homeFile, projectFile];
  const extra = process.env.FORGE_LSP_CONFIG?.trim();
  if (extra) files.push(path.resolve(extra));

  let noDefaults = false;
  let enabled = true;
  const overlays: Record<string, Partial<LspServerConfig> & { command?: string }> =
    {};

  for (const f of files) {
    try {
      if (!fs.existsSync(f)) continue;
      sources.push(f);
      const raw = parseFile(f);
      if (raw.enabled === false) enabled = false;
      if (raw.enabled === true) enabled = true;
      if (raw.noDefaults) noDefaults = true;
      if (raw.servers && typeof raw.servers === "object") {
        for (const [id, cfg] of Object.entries(raw.servers)) {
          if (!cfg || typeof cfg !== "object") continue;
          overlays[id] = { ...overlays[id], ...cfg, languageId: id };
        }
      }
    } catch {
      /* */
    }
  }

  const servers: LspServerConfig[] = [];
  const seen = new Set<string>();

  if (!noDefaults) {
    for (const d of DEFAULT_LSP_SERVERS) {
      const o = overlays[d.languageId];
      const merged = o ? mergeServer(d, o) : { ...d };
      servers.push(merged);
      seen.add(d.languageId);
    }
  }

  for (const [id, o] of Object.entries(overlays)) {
    if (seen.has(id)) continue;
    if (!o.command) continue;
    servers.push({
      languageId: id,
      extensions: o.extensions || [],
      command: o.command,
      args: o.args || [],
      initializationOptions: o.initializationOptions,
      disabled: o.disabled,
    });
  }

  return {
    enabled,
    servers: servers.filter((s) => !s.disabled),
    sources,
  };
}
