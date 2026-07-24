import fs from "node:fs";
import path from "node:path";
import toml from "toml";
import { forgeHome, readJsonFile } from "../util/fs.js";
import {
  DEFAULT_CONFIG,
  type ForgeConfig,
  type PermissionConfig,
  type ProviderId,
  type SandboxMissingBackend,
  type SandboxNetwork,
  type ReadOutsideWorkspace,
} from "./types.js";

function deepMerge<T extends Record<string, unknown>>(base: T, overlay: Partial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) continue;
    const prev = out[k];
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      prev &&
      typeof prev === "object" &&
      !Array.isArray(prev)
    ) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** Map snake_case TOML keys onto camelCase ForgeConfig fields. */
function normalizeConfigShape(raw: Record<string, unknown>): Partial<ForgeConfig> {
  const out: Record<string, unknown> = { ...raw };
  const map: Record<string, string> = {
    max_tokens: "maxTokens",
    max_turns: "maxTurns",
    permission_mode: "permissionMode",
    blocking_stop_hooks: "blockingStopHooks",
    compat_claude_hooks: "compatClaudeHooks",
    compat_cursor_hooks: "compatCursorHooks",
    auto_compact_threshold: "autoCompactThreshold",
    context_window: "contextWindow",
    base_url: "baseUrl",
    system_prompt_extra: "systemPromptExtra",
    sandbox_network: "sandboxNetwork",
    sandbox_missing_backend: "sandboxMissingBackend",
    read_outside_workspace: "readOutsideWorkspace",
  };
  for (const [snake, camel] of Object.entries(map)) {
    if (snake in out && !(camel in out)) {
      out[camel] = out[snake];
      delete out[snake];
    }
  }
  if (out.goal && typeof out.goal === "object") {
    const g = { ...(out.goal as Record<string, unknown>) };
    if ("stuck_threshold" in g && !("stuckThreshold" in g)) {
      g.stuckThreshold = g.stuck_threshold;
      delete g.stuck_threshold;
    }
    if ("auto_arm" in g && !("autoArm" in g)) {
      g.autoArm = g.auto_arm;
      delete g.auto_arm;
    }
    out.goal = g;
  }
  if (out.permission && typeof out.permission === "object") {
    const p = { ...(out.permission as Record<string, unknown>) };
    for (const k of ["deny", "allow", "ask", "rules"] as const) {
      if (p[k] === undefined) p[k] = k === "rules" ? [] : [];
    }
    out.permission = p;
  }
  return out as Partial<ForgeConfig>;
}

function loadToml(file: string): Partial<ForgeConfig> {
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, "utf8");
    return normalizeConfigShape(toml.parse(raw) as Record<string, unknown>);
  } catch (err) {
    console.error(`forge: failed to parse ${file}:`, err);
    return {};
  }
}

function loadJson(file: string): Partial<ForgeConfig> {
  return normalizeConfigShape(
    readJsonFile<Record<string, unknown>>(file, {}),
  );
}

/**
 * Grok-style trust: project configs may only *add* deny rules, never remove
 * global denials. Allow/ask from project still merge normally.
 */
export function mergePermissionTrust(
  globalPerm: PermissionConfig | undefined,
  projectPerm: PermissionConfig | undefined,
  base: PermissionConfig,
): PermissionConfig {
  const gDeny = new Set([...(base.deny || []), ...(globalPerm?.deny || [])]);
  const pDeny = projectPerm?.deny || [];
  const deny = [...gDeny];
  for (const d of pDeny) {
    if (!gDeny.has(d)) deny.push(d);
  }
  return {
    deny,
    allow: [
      ...(base.allow || []),
      ...(globalPerm?.allow || []),
      ...(projectPerm?.allow || []),
    ],
    ask: [
      ...(base.ask || []),
      ...(globalPerm?.ask || []),
      ...(projectPerm?.ask || []),
    ],
    rules: [
      ...(base.rules || []),
      ...(globalPerm?.rules || []),
      ...(projectPerm?.rules || []),
    ],
  };
}

/**
 * Load config with precedence (later wins, with deny-trust exception):
 * 1. DEFAULT_CONFIG
 * 2. ~/.forge/config.toml | config.json  (global)
 * 3. <cwd>/.forge/config.toml | config.json  (project — cannot drop global denies)
 * 4. environment variables
 * 5. explicit CLI overrides
 */
export function loadConfig(overrides: Partial<ForgeConfig> = {}, cwd = process.cwd()): ForgeConfig {
  const home = forgeHome();
  const globalToml = loadToml(path.join(home, "config.toml"));
  const globalJson = loadJson(path.join(home, "config.json"));
  const projectToml = loadToml(path.join(cwd, ".forge", "config.toml"));
  const projectJson = loadJson(path.join(cwd, ".forge", "config.json"));

  // Merge without project first
  let globalMerged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    globalToml as never,
  ) as unknown as ForgeConfig;
  globalMerged = deepMerge(
    globalMerged as unknown as Record<string, unknown>,
    globalJson as never,
  ) as unknown as ForgeConfig;

  const globalPermission = {
    deny: globalMerged.permission?.deny ?? DEFAULT_CONFIG.permission.deny,
    allow: globalMerged.permission?.allow ?? [],
    ask: globalMerged.permission?.ask ?? [],
    rules: globalMerged.permission?.rules ?? [],
  };

  // Project overlay for non-permission fields
  let cfg = deepMerge(
    globalMerged as unknown as Record<string, unknown>,
    projectToml as never,
  ) as unknown as ForgeConfig;
  cfg = deepMerge(cfg as unknown as Record<string, unknown>, projectJson as never) as unknown as ForgeConfig;

  // Trusted permission merge
  const projectPermission = {
    deny: [
      ...((projectToml.permission as PermissionConfig | undefined)?.deny || []),
      ...((projectJson.permission as PermissionConfig | undefined)?.deny || []),
    ],
    allow: [
      ...((projectToml.permission as PermissionConfig | undefined)?.allow || []),
      ...((projectJson.permission as PermissionConfig | undefined)?.allow || []),
    ],
    ask: [
      ...((projectToml.permission as PermissionConfig | undefined)?.ask || []),
      ...((projectJson.permission as PermissionConfig | undefined)?.ask || []),
    ],
    rules: [
      ...((projectToml.permission as PermissionConfig | undefined)?.rules || []),
      ...((projectJson.permission as PermissionConfig | undefined)?.rules || []),
    ],
  };
  cfg.permission = mergePermissionTrust(
    globalPermission,
    projectPermission,
    DEFAULT_CONFIG.permission,
  );

  // Environment overrides
  if (process.env.FORGE_PROVIDER) cfg.provider = process.env.FORGE_PROVIDER as ProviderId;
  if (process.env.FORGE_MODEL) cfg.model = process.env.FORGE_MODEL;
  if (process.env.FORGE_BASE_URL) cfg.baseUrl = process.env.FORGE_BASE_URL;
  if (process.env.FORGE_PERMISSION_MODE) {
    cfg.permissionMode = process.env.FORGE_PERMISSION_MODE as ForgeConfig["permissionMode"];
  }
  if (process.env.FORGE_SANDBOX) {
    cfg.sandbox = process.env.FORGE_SANDBOX as ForgeConfig["sandbox"];
  }
  if (process.env.FORGE_SANDBOX_NETWORK) {
    cfg.sandboxNetwork = process.env.FORGE_SANDBOX_NETWORK as SandboxNetwork;
  }
  if (process.env.FORGE_SANDBOX_MISSING_BACKEND) {
    cfg.sandboxMissingBackend = process.env
      .FORGE_SANDBOX_MISSING_BACKEND as SandboxMissingBackend;
  }
  if (process.env.FORGE_READ_OUTSIDE) {
    cfg.readOutsideWorkspace = process.env.FORGE_READ_OUTSIDE as ReadOutsideWorkspace;
  }
  if (process.env.FORGE_BLOCKING_STOP === "0") cfg.blockingStopHooks = false;
  if (process.env.FORGE_BLOCKING_STOP === "1") cfg.blockingStopHooks = true;
  if (process.env.FORGE_GOAL_GATE === "0") cfg.goal.enabled = false;
  if (process.env.FORGE_GOAL_STUCK_THRESHOLD) {
    const n = Number(process.env.FORGE_GOAL_STUCK_THRESHOLD);
    if (Number.isFinite(n) && n >= 0) cfg.goal.stuckThreshold = n;
  }

  cfg = deepMerge(cfg as unknown as Record<string, unknown>, overrides as never) as unknown as ForgeConfig;
  cfg.workspace = cfg.workspace ? path.resolve(cfg.workspace) : cwd;

  cfg.permission = {
    deny: cfg.permission?.deny ?? DEFAULT_CONFIG.permission.deny,
    allow: cfg.permission?.allow ?? [],
    ask: cfg.permission?.ask ?? [],
    rules: cfg.permission?.rules ?? [],
  };
  if (!cfg.sandbox) cfg.sandbox = DEFAULT_CONFIG.sandbox;
  if (!cfg.sandboxMissingBackend) {
    cfg.sandboxMissingBackend = DEFAULT_CONFIG.sandboxMissingBackend;
  }
  if (!cfg.readOutsideWorkspace) {
    cfg.readOutsideWorkspace = DEFAULT_CONFIG.readOutsideWorkspace;
  }
  return cfg;
}

export function defaultConfigToml(): string {
  return `# Forge agent config — ~/.forge/config.toml
# Docs: see docs/SAFETY.md

provider = "xai"
model = "grok-4"
temperature = 0.2
max_tokens = 8192
max_turns = 0
permission_mode = "default"  # default | acceptEdits | plan | bypassPermissions | dontAsk

# OS sandbox for bash (macOS: sandbox-exec, Linux: bwrap)
# off | workspace | read-only | strict
sandbox = "workspace"
# unrestricted | blocked  (unset: workspace=open, read-only/strict=blocked)
# sandbox_network = "unrestricted"
# fail-closed (default) | fallback
sandbox_missing_backend = "fail-closed"
# ask | allow | deny — file/path access outside workspace
read_outside_workspace = "ask"

blocking_stop_hooks = true
compat_claude_hooks = true
compat_cursor_hooks = true

[goal]
enabled = true
stuck_threshold = 3
auto_arm = true

# Permission rules — deny always wins (including YOLO)
# Project .forge/config.toml may only ADD deny rules, never remove global ones.
[permission]
deny = [
  "Bash(rm -rf /)",
  "Bash(rm -fr /)",
  "Bash(rm -rf ~)",
  "Bash(git push --force *main*)",
]
allow = []
ask = []

# Optional per-provider overrides
# [providers.xai]
# base_url = "https://api.x.ai/v1"
`;
}
