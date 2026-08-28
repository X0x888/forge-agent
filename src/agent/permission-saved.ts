/**
 * Persisted "always allow" permission rules (OpenCode PermissionSaved-inspired).
 * Scoped by workspace root; file mode 0600.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { forgeHome, readJsonFile, writeJsonFile, nowIso } from "../util/fs.js";

export interface SavedAllow {
  id: string;
  /** Workspace root hash or "*" for global */
  workspaceKey: string;
  /** bash | read_file | write_file | external_directory | … */
  tool: string;
  /** Pattern e.g. "git status *" */
  pattern: string;
  createdAt: string;
}

interface Store {
  version: 1;
  allows: SavedAllow[];
}

/** Fresh empty store (readJsonFile also clones object fallbacks). */
function emptyStore(): Store {
  return { version: 1, allows: [] };
}

function loadStore(): Store {
  const raw = readJsonFile<Store>(storePath(), emptyStore());
  // Defensive copy so callers never mutate a shared fallback or stale ref
  return scrubWildcardMcpAllows({
    version: 1,
    allows: Array.isArray(raw.allows) ? [...raw.allows] : [],
  });
}

function storePath(): string {
  return path.join(forgeHome(), "permissions.json");
}

export function workspaceKey(workspace: string): string {
  const abs = path.resolve(workspace);
  return createHash("sha256").update(abs).digest("hex").slice(0, 16);
}

export function loadSavedAllows(workspace?: string): SavedAllow[] {
  const store = loadStore();
  if (!workspace) return store.allows;
  const key = workspaceKey(workspace);
  return store.allows.filter((a) => a.workspaceKey === key || a.workspaceKey === "*");
}

function isMcpInvocationToolName(tool: string): boolean {
  const n = String(tool || "").toLowerCase();
  return n === "call_mcp" || n === "mcp_call" || n === "use_mcp";
}

function isWildcardMcpAllow(a: SavedAllow): boolean {
  if (!isMcpInvocationToolName(a.tool)) return false;
  const p = String(a.pattern || "").trim();
  return !p || p === "*" || p === "." || p.includes("*");
}

/** Drop leftover call_mcp(*) grants written before server__tool scoping. */
function scrubWildcardMcpAllows(store: Store): Store {
  const next = store.allows.filter((a) => !isWildcardMcpAllow(a));
  if (next.length === store.allows.length) return store;
  store.allows = next;
  try {
    writeJsonFile(storePath(), store, 0o600);
  } catch {
    /* best-effort — still hide the wildcard from this process */
  }
  return store;
}

export function addSavedAllow(opts: {
  workspace: string;
  tool: string;
  pattern: string;
  global?: boolean;
}): SavedAllow {
  const pattern = String(opts.pattern || "").trim();
  if (
    isMcpInvocationToolName(opts.tool) &&
    (!pattern || pattern === "*" || pattern === "." || pattern.includes("*"))
  ) {
    throw new Error(
      "call_mcp always-allow requires a server__tool target (refusing *)",
    );
  }
  const store = loadStore();
  const entry: SavedAllow = {
    id: `pa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    workspaceKey: opts.global ? "*" : workspaceKey(opts.workspace),
    tool: opts.tool,
    pattern,
    createdAt: nowIso(),
  };
  // dedupe
  const exists = store.allows.some(
    (a) =>
      a.workspaceKey === entry.workspaceKey &&
      a.tool === entry.tool &&
      a.pattern === entry.pattern,
  );
  if (!exists) {
    store.allows.push(entry);
    writeJsonFile(storePath(), store, 0o600);
  }
  return entry;
}

export function removeSavedAllow(id: string): boolean {
  const store = loadStore();
  const before = store.allows.length;
  store.allows = store.allows.filter((a) => a.id !== id);
  if (store.allows.length === before) return false;
  writeJsonFile(storePath(), store, 0o600);
  return true;
}

export function clearSavedAllows(workspace?: string): number {
  const store = loadStore();
  const before = store.allows.length;
  if (!workspace) {
    store.allows = [];
  } else {
    const key = workspaceKey(workspace);
    store.allows = store.allows.filter((a) => a.workspaceKey !== key);
  }
  writeJsonFile(storePath(), store, 0o600);
  return before - store.allows.length;
}

/** Convert saved allows into rule strings for compileRules. */
export function savedAsAllowRules(workspace: string): string[] {
  return loadSavedAllows(workspace).map((a) => {
    const tool =
      a.tool === "bash"
        ? "Bash"
        : a.tool === "write_file"
          ? "Write"
          : a.tool === "search_replace"
            ? "Edit"
            : a.tool === "read_file"
              ? "Read"
              : a.tool === "external_directory"
                ? "external_directory"
                : a.tool;
    return `${tool}(${a.pattern})`;
  });
}

/** Sit-down `/permissions` peek. Numbered modes stay on Tab. */
export function formatPermissionsCard(input: {
  mode: string;
  sessionMode?: string;
  allowCount?: number;
  emptyList?: boolean;
}): string {
  if (input.emptyList) {
    return [
      "permissions  ·  none",
      "  no saved allow rules",
      "Next  /permissions",
    ].join("\n");
  }
  const lines = [`permissions  ·  ${input.mode}`];
  const bits: string[] = [];
  const session = (input.sessionMode || "").trim();
  if (session && session !== input.mode) bits.push(`session ${session}`);
  if (input.allowCount && input.allowCount > 0) {
    bits.push(`${input.allowCount} saved`);
  }
  if (bits.length) lines.push(`  ${bits.join("  ·  ")}`);
  lines.push("Next  /permissions list");
  return lines.join("\n");
}
