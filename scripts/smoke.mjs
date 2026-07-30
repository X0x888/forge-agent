#!/usr/bin/env node
/**
 * Production smoke: build binary + fail-closed JSON checks.
 * Uses spawn with explicit argv (empty strings preserved — unlike shell '').
 * Isolates FORGE_HOME so developer ~/.forge / ~/.grok never affect CI.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");
const home = path.join(root, ".tmp", "smoke-home");
// Fresh home every run — headless slash / doctor must not leave sessions that
// flip later fail-closed checks (continue_miss, empty_prompt, …).
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });

const env = {
  ...process.env,
  FORGE_HOME: home,
  GROK_HOME: path.join(home, "no-grok"),
};
// Strip provider API keys so unauth paths are deterministic
for (const k of Object.keys(env)) {
  if (/_API_KEY$|^FORGE_API_KEY$|^XAI_|^ANTHROPIC_|^OPENAI_|^OPENROUTER_|^GOOGLE_|^GEMINI_/.test(k)) {
    delete env[k];
  }
}

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error,
  };
}

function mustInclude(label, args, needle, opts) {
  const r = run(args, opts);
  const out = r.stdout + r.stderr;
  // Tolerate pretty-printed JSON spacing ("ok": true vs "ok":true)
  const compact = out.replace(/\s+/g, "");
  const compactNeedle = String(needle).replace(/\s+/g, "");
  if (!out.includes(needle) && !compact.includes(compactNeedle)) {
    console.error(`SMOKE FAIL: ${label}`);
    console.error(`  args: ${JSON.stringify(args)}`);
    console.error(`  expected includes: ${needle}`);
    console.error(`  status: ${r.status} error: ${r.error?.message || ""}`);
    console.error(`  stdout: ${r.stdout.slice(0, 400)}`);
    console.error(`  stderr: ${r.stderr.slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`ok  ${label}`);
}

if (!fs.existsSync(cli)) {
  console.error("dist/cli.js missing — run npm run build first");
  process.exit(1);
}

// version
{
  const r = run(["--version"]);
  if (!r.stdout.includes("0.")) {
    console.error("SMOKE FAIL: --version", r.stdout);
    process.exit(1);
  }
  console.log("ok  --version", r.stdout.trim());
}

// Soft probes (may fail on fresh CI home)
run(["doctor", "--json"]);
run(["auth", "--json"]);
run(["completion", "bash"]);
run(["models", "--json"]);
run(["stats", "--json"]);
run(["news"]);
run(["logs"]);
run(["tips"]);
run(["prune-tool-output", "--json"]);
run(["prune-metrics", "--json"]);

mustInclude("config has version", ["config", "--json"], '"version"');
mustInclude("empty_prompt", ["run", "--json"], "empty_prompt");
mustInclude("invalid_provider empty", ["run", "x", "--json", "--provider", ""], "invalid_provider");
mustInclude("invalid_provider bogus", ["run", "x", "--json", "--provider", "not-a-provider"], "invalid_provider");
mustInclude("continue_miss", ["run", "x", "--continue", "--json"], "continue_miss");
mustInclude("invalid_shell", ["completion", "powershell", "--json"], "invalid_shell");
mustInclude("invalid_cwd empty", ["run", "x", "--cwd", "", "--json"], "invalid_cwd");
mustInclude("invalid_title empty", ["run", "x", "--title", "", "--json"], "invalid_title");
mustInclude("invalid_deny empty", ["run", "x", "--deny", "", "--json"], "invalid_deny");
mustInclude("invalid_goal empty", ["run", "x", "--goal", "", "--json"], "invalid_goal");
mustInclude("invalid_query empty", ["sessions", "list", "-q", "", "--json"], "invalid_query");
mustInclude("command_typo", ["sesions", "--json"], "command_typo");
mustInclude("unknown_session_action", ["sessions", "prun", "--json"], "unknown_session_action");
mustInclude("invalid_model typo", ["run", "x", "--model", "grok-45", "--json"], "invalid_model");
mustInclude("invalid_effort typo", ["run", "x", "--effort", "medum", "--json"], "invalid_effort");
mustInclude("invalid_interval", ["status", "--interval", "nope", "--json"], "invalid_interval");
mustInclude("version --json ok", ["--version", "--json"], '"ok":true');
mustInclude("conflicting continue+new", ["run", "x", "--continue", "--new", "--json"], "conflicting_flags");
mustInclude("conflicting session+continue", ["run", "x", "--session", "abc", "--continue", "--json"], "conflicting_flags");
mustInclude("invalid_cwd missing", ["run", "x", "--cwd", "/no/such/forge-cwd-smoke", "--json"], "invalid_cwd");
mustInclude("models -p xai", ["models", "-p", "xai", "--json"], '"provider": "xai"');
mustInclude("invalid_count news", ["news", "11", "--json"], "invalid_count");
mustInclude("invalid_lines logs", ["logs", "-n", "201", "--json"], "invalid_lines");
mustInclude("invalid_limit", ["sessions", "list", "--limit", "10001", "--json"], "invalid_limit");
mustInclude("unknown_option", ["run", "x", "--not-a-real-flag", "--json"], "unknown_option");
mustInclude("excess_arguments", ["init", "extra", "--json"], "excess_arguments");
mustInclude("unauth api-key hint", ["run", "x", "--json"], "api-key");
mustInclude("invalid_max_turns", ["run", "x", "--max-turns", "abc", "--json"], "invalid_max_turns");
mustInclude("invalid_sandbox_missing", ["run", "x", "--sandbox-missing", "fallbak", "--json"], "invalid_sandbox_missing");
mustInclude("invalid_format typo", ["sessions", "export", "x", "--format", "jsn", "--json"], "invalid_format");
mustInclude("invalid_read_outside typo", ["run", "x", "--read-outside", "den", "--json"], "invalid_read_outside");
mustInclude("invalid_days typo", ["stats", "--days", "wek", "--json"], "invalid_days");
mustInclude("doctor readOutsideWorkspace", ["doctor", "--json"], "readOutsideWorkspace");
mustInclude("doctor projectRulesCount", ["doctor", "--json"], "projectRulesCount");
mustInclude("doctor projectCommandsCount", ["doctor", "--json"], "projectCommandsCount");
mustInclude("doctor sessionsWithLastError", ["doctor", "--json"], "sessionsWithLastError");
mustInclude("doctor sessionsUntitled", ["doctor", "--json"], "sessionsUntitled");
mustInclude("doctor sessionsTotal", ["doctor", "--json"], "sessionsTotal");
mustInclude("doctor modelDefaultContextWindow", ["doctor", "--json"], "modelDefaultContextWindow");
mustInclude("doctor contextWindow", ["doctor", "--json"], "contextWindow");
mustInclude("doctor autoCompactThreshold", ["doctor", "--json"], "autoCompactThreshold");
mustInclude("doctor gitIsWorktree", ["doctor", "--json"], "gitIsWorktree");
mustInclude("doctor gitChangedFiles", ["doctor", "--json"], "gitChangedFiles");
mustInclude("doctor formatOnWrite", ["doctor", "--json"], "formatOnWrite");
mustInclude("status formatOnWrite", ["status", "--json"], "formatOnWrite");
mustInclude("config formatOnWrite", ["config", "--json"], "formatOnWrite");

// Headless slash: pure control exits without auth/model (reason: slash)
mustInclude(
  "headless slash /commands",
  ["run", "/commands", "--json", "--permission-mode", "plan"],
  '"reason":"slash"',
);
mustInclude(
  "headless slash /help",
  ["run", "/help", "--json"],
  '"reason":"slash"',
);

// status --watch should one-shot in non-TTY smoke (must not hang)
mustInclude("status --watch json", ["status", "--watch", "--json"], '"ok":true', {
  timeoutMs: 8_000,
});

console.log("\nSmoke OK");
