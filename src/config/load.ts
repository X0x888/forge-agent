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
import { applyPreferences, loadPreferences } from "./preferences.js";
import { parseReasoningEffort } from "./reasoning.js";

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
    prompt_profile: "promptProfile",
    sandbox_network: "sandboxNetwork",
    sandbox_missing_backend: "sandboxMissingBackend",
    read_outside_workspace: "readOutsideWorkspace",
    reasoning_effort: "reasoningEffort",
    effort: "reasoningEffort",
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
 * Bar A footgun guard: project `.forge/config` must not weaken the host safety
 * posture (credential redirect, YOLO, sandbox off, missing-backend fallback,
 * unrestricted outside reads). Global ~/.forge + env + CLI still can.
 */
export function applySafeProjectOverlay(
  globalCfg: ForgeConfig,
  projectRaw: Partial<ForgeConfig>,
): ForgeConfig {
  const cfg = { ...globalCfg };

  // Safe / useful project knobs
  if (projectRaw.model) cfg.model = projectRaw.model;
  if (projectRaw.reasoningEffort) cfg.reasoningEffort = projectRaw.reasoningEffort;
  if (typeof projectRaw.temperature === "number") cfg.temperature = projectRaw.temperature;
  if (typeof projectRaw.maxTokens === "number") cfg.maxTokens = projectRaw.maxTokens;
  if (typeof projectRaw.maxTurns === "number") cfg.maxTurns = projectRaw.maxTurns;
  if (projectRaw.systemPromptExtra) cfg.systemPromptExtra = projectRaw.systemPromptExtra;
  if (typeof projectRaw.autoCompactThreshold === "number") {
    cfg.autoCompactThreshold = projectRaw.autoCompactThreshold;
  }
  if (typeof projectRaw.contextWindow === "number") {
    cfg.contextWindow = projectRaw.contextWindow;
  }
  if (projectRaw.goal && typeof projectRaw.goal === "object") {
    cfg.goal = { ...cfg.goal, ...projectRaw.goal };
  }

  // permissionMode: allow default|acceptEdits|plan|dontAsk — never project YOLO
  if (projectRaw.permissionMode) {
    if (projectRaw.permissionMode === "bypassPermissions") {
      console.error(
        "forge: ignoring project permission_mode=bypassPermissions (set in ~/.forge or CLI)",
      );
    } else {
      cfg.permissionMode = projectRaw.permissionMode;
    }
  }

  // sandbox: allow tighter profiles; never sandbox=off from project
  if (projectRaw.sandbox) {
    if (projectRaw.sandbox === "off") {
      console.error(
        "forge: ignoring project sandbox=off (set in ~/.forge or CLI / FORGE_SANDBOX)",
      );
    } else {
      cfg.sandbox = projectRaw.sandbox;
    }
  }

  // network: project may only tighten to blocked
  if (projectRaw.sandboxNetwork === "blocked") {
    cfg.sandboxNetwork = "blocked";
  } else if (projectRaw.sandboxNetwork === "unrestricted") {
    // only if global already unrestricted — do not open network from project alone
    if (globalCfg.sandboxNetwork === "unrestricted" || !globalCfg.sandboxNetwork) {
      /* leave default-from-profile */
    }
  }

  // missing backend: project cannot force fallback
  if (projectRaw.sandboxMissingBackend === "fail-closed") {
    cfg.sandboxMissingBackend = "fail-closed";
  } else if (projectRaw.sandboxMissingBackend === "fallback") {
    console.error(
      "forge: ignoring project sandbox_missing_backend=fallback (set globally if you must)",
    );
  }

  // outside workspace: project may tighten to deny/ask, never allow
  if (projectRaw.readOutsideWorkspace === "allow") {
    console.error(
      "forge: ignoring project read_outside_workspace=allow (set in ~/.forge or CLI)",
    );
  } else if (
    projectRaw.readOutsideWorkspace === "deny" ||
    projectRaw.readOutsideWorkspace === "ask"
  ) {
    cfg.readOutsideWorkspace = projectRaw.readOutsideWorkspace;
  }

  // baseUrl / provider / providers: never from project (credential redirect)
  if (projectRaw.baseUrl && projectRaw.baseUrl !== globalCfg.baseUrl) {
    console.error(
      "forge: ignoring project base_url (credential redirect risk; set in ~/.forge or FORGE_BASE_URL)",
    );
  }
  if (projectRaw.provider && projectRaw.provider !== globalCfg.provider) {
    console.error(
      "forge: ignoring project provider override (set in ~/.forge or FORGE_PROVIDER)",
    );
  }

  // blockingStopHooks: project may only force true
  if (projectRaw.blockingStopHooks === true) {
    cfg.blockingStopHooks = true;
  } else if (projectRaw.blockingStopHooks === false) {
    console.error(
      "forge: ignoring project blocking_stop_hooks=false (set FORGE_BLOCKING_STOP=0 globally)",
    );
  }

  return cfg;
}

/**
 * Load config with precedence (later wins, with deny-trust + project safety):
 * 1. DEFAULT_CONFIG
 * 2. ~/.forge/config.toml | config.json  (global)
 * 3. <cwd>/.forge/config.toml | config.json  (project — safe overlay only)
 * 4. ~/.forge/preferences.json  (last /model + /permissions + /effort — all sessions/folders)
 * 5. environment variables
 * 6. explicit CLI overrides
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

  const projectRaw = deepMerge(
    projectToml as Record<string, unknown>,
    projectJson as never,
  ) as Partial<ForgeConfig>;

  let cfg = applySafeProjectOverlay(globalMerged, projectRaw);

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

  // Interactive preferences (slash /model, /permissions, /effort) — beat static config
  applyPreferences(cfg, loadPreferences());

  // Environment overrides
  if (process.env.FORGE_PROVIDER) cfg.provider = process.env.FORGE_PROVIDER as ProviderId;
  if (process.env.FORGE_MODEL) cfg.model = process.env.FORGE_MODEL;
  if (process.env.FORGE_BASE_URL) cfg.baseUrl = process.env.FORGE_BASE_URL;
  {
    const effortRaw =
      process.env.FORGE_REASONING_EFFORT || process.env.FORGE_EFFORT;
    if (effortRaw) {
      const e = parseReasoningEffort(effortRaw);
      if (e) cfg.reasoningEffort = e;
    }
  }
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
  // Coerce string effort from TOML/JSON if still unparsed
  if (typeof (cfg as { reasoningEffort?: unknown }).reasoningEffort === "string") {
    const e = parseReasoningEffort(String(cfg.reasoningEffort));
    cfg.reasoningEffort = e ?? undefined;
  }
  return cfg;
}

export function defaultConfigToml(): string {
  return `# Forge agent config — ~/.forge/config.toml
# Docs: docs/SAFETY.md · docs/PRODUCTION.md · docs/RELIABILITY.md

provider = "xai"
model = "grok-4.5"
# low | medium | high  (only sent for models that support it, e.g. grok-4.5)
reasoning_effort = "high"
temperature = 0.2
max_tokens = 8192
max_turns = 0                 # 0 = unlimited; set e.g. 200 to cap agent turns
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

# Harness: keep true for production (Stop hooks can force continue)
blocking_stop_hooks = true
compat_claude_hooks = true
compat_cursor_hooks = true

# Context: auto-compact when estimated tokens exceed this fraction of context_window
# auto_compact_threshold = 0.85
# context_window = 500000

[goal]
enabled = true
stuck_threshold = 3
auto_arm = true

# Permission rules — deny always wins (including YOLO)
# Project .forge/config.toml may only ADD deny rules, never remove global ones.
# Project cannot set: base_url, bypassPermissions, sandbox=off, missing-backend fallback.
[permission]
deny = [
  "Bash(rm -rf /)",
  "Bash(rm -fr /)",
  "Bash(rm -rf ~)",
  "Bash(git push --force *main*)",
]
allow = []
ask = []

# Optional per-provider overrides (global ~/.forge only — not project)
# [providers.xai]
# base_url = "https://api.x.ai/v1"
# Env: FORGE_PROVIDER_TIMEOUT_MS, FORGE_MAX_RUN_MS, FORGE_LOG_JSON, FORGE_HEADLESS — see .env.example
`;
}
