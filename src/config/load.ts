import fs from "node:fs";
import path from "node:path";
import toml from "toml";
import { forgeHome, readJsonFile } from "../util/fs.js";
import { DEFAULT_CONFIG, type ForgeConfig, type ProviderId } from "./types.js";

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
 * Load config with precedence (later wins):
 * 1. DEFAULT_CONFIG
 * 2. ~/.forge/config.toml | config.json
 * 3. <cwd>/.forge/config.toml | config.json
 * 4. environment variables
 * 5. explicit CLI overrides
 */
export function loadConfig(overrides: Partial<ForgeConfig> = {}, cwd = process.cwd()): ForgeConfig {
  const home = forgeHome();
  const globalToml = loadToml(path.join(home, "config.toml"));
  const globalJson = loadJson(path.join(home, "config.json"));
  const projectToml = loadToml(path.join(cwd, ".forge", "config.toml"));
  const projectJson = loadJson(path.join(cwd, ".forge", "config.json"));

  let cfg = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, globalToml as never) as unknown as ForgeConfig;
  cfg = deepMerge(cfg as unknown as Record<string, unknown>, globalJson as never) as unknown as ForgeConfig;
  cfg = deepMerge(cfg as unknown as Record<string, unknown>, projectToml as never) as unknown as ForgeConfig;
  cfg = deepMerge(cfg as unknown as Record<string, unknown>, projectJson as never) as unknown as ForgeConfig;

  // Environment overrides
  if (process.env.FORGE_PROVIDER) cfg.provider = process.env.FORGE_PROVIDER as ProviderId;
  if (process.env.FORGE_MODEL) cfg.model = process.env.FORGE_MODEL;
  if (process.env.FORGE_BASE_URL) cfg.baseUrl = process.env.FORGE_BASE_URL;
  if (process.env.FORGE_PERMISSION_MODE) {
    cfg.permissionMode = process.env.FORGE_PERMISSION_MODE as ForgeConfig["permissionMode"];
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
  return cfg;
}

export function defaultConfigToml(): string {
  return `# Forge agent config — ~/.forge/config.toml
# Docs: see README.md

provider = "xai"
model = "grok-4"
temperature = 0.2
max_tokens = 8192
# 0 = unlimited turns per user message
max_turns = 0
permission_mode = "default"  # default | acceptEdits | plan | bypassPermissions

# Claude Code parity: Stop hooks CAN block the agent from finishing.
# Grok Build lacks this; Forge has it by design.
blocking_stop_hooks = true
compat_claude_hooks = true
compat_cursor_hooks = true

[goal]
enabled = true
stuck_threshold = 3
auto_arm = true

# Optional per-provider overrides
# [providers.xai]
# base_url = "https://api.x.ai/v1"
# default_model = "grok-4"
`;
}
