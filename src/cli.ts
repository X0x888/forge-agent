#!/usr/bin/env node
/**
 * Forge — AI coding agent CLI
 *
 * Harness features ported / fixed relative to peers:
 *  - Blocking Stop hooks (Claude Code) — Grok Build's Stop is passive only
 *  - /goal relentless driver (Codex)
 *  - Ultrawork max-autonomy mode (oh-my-claude)
 *  - API key + OAuth/subscription auth where providers allow
 *  - Multi-provider: xAI, Anthropic, OpenAI, OpenRouter, Google
 */
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, defaultConfigToml } from "./config/load.js";
import type { ForgeConfig } from "./config/types.js";
import { resolveAuth, describeAuth } from "./auth/resolve.js";
import { loginInteractive, logout, printAuthStatus, supportsOAuth } from "./auth/login.js";
import { importGrokCredentials } from "./auth/import-grok.js";
import { createProvider } from "./providers/factory.js";
import { createSession, loadSession, listSessions, saveSession } from "./session/session.js";
import { HookRunner } from "./harness/hooks.js";
import { PermissionGate } from "./agent/permissions.js";
import { runAgentLoop } from "./agent/loop.js";
import { runRepl } from "./tui/repl.js";
import { forgeHome, ensureDir } from "./util/fs.js";
import { log, setLogLevel } from "./util/log.js";
import { armGoal, formatGoalStatus, loadGoal } from "./harness/goal.js";
import { armUlwCycle } from "./harness/ulw-cycle.js";
import { runDoctor } from "./commands/slash.js";
import {
  collectSnapshots,
  renderHud,
  renderTmux,
  snapshotsToJson,
  runStatusWatch,
} from "./statusline/index.js";

const VERSION = "0.8.0";

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("forge")
    .description(
      "Forge — AI coding agent with blocking Stop hooks, /goal driver, and multi-provider auth",
    )
    .version(VERSION)
    .option("-m, --model <model>", "Model id")
    .option("-p, --provider <provider>", "Provider: xai|anthropic|openai|openrouter|google|custom")
    .option("--base-url <url>", "Override API base URL")
    .option(
      "--permission-mode <mode>",
      "default|acceptEdits|plan|bypassPermissions|dontAsk",
    )
    .option(
      "--sandbox <profile>",
      "OS sandbox for bash: off|workspace|read-only|strict",
    )
    .option(
      "--sandbox-network <mode>",
      "Child bash network: unrestricted|blocked",
    )
    .option(
      "--sandbox-missing <mode>",
      "When sandbox backend missing: fail-closed|fallback (default fail-closed)",
    )
    .option(
      "--deny <rule>",
      "Permission deny rule (repeatable), e.g. 'Bash(rm *)'",
      (v: string, acc: string[]) => acc.concat(v),
      [] as string[],
    )
    .option(
      "--allow <rule>",
      "Permission allow rule (repeatable)",
      (v: string, acc: string[]) => acc.concat(v),
      [] as string[],
    )
    .option(
      "--ask <rule>",
      "Permission ask rule (repeatable)",
      (v: string, acc: string[]) => acc.concat(v),
      [] as string[],
    )
    .option("--ulw", "Start in ultrawork (max autonomy) mode")
    .option("--goal <objective>", "Arm a relentless /goal on start")
    .option("--new", "Force a new session")
    .option("--session <id>", "Resume session id")
    .option("--cwd <path>", "Workspace directory", process.cwd())
    .option("--print-logs", "Verbose debug logs")
    .option(
      "--no-blocking-stop",
      "Disable blocking Stop hooks (Grok-compatible passive mode)",
    )
    .argument("[prompt...]", "Optional initial prompt (also used by `forge run`)")
    .action(async (promptParts: string[], opts) => {
      if (opts.printLogs) setLogLevel("debug");
      await ensureHome();
      const config = buildConfig(opts);
      const auth = resolveAuth(config);
      if (!auth) {
        log.error(
          "Not authenticated. Run: forge login\n" +
            "  or set XAI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / …",
        );
        process.exit(1);
      }
      // Align provider if auth auto-detected a different one
      if (auth.provider !== config.provider) {
        log.info(`Using provider ${auth.provider} from available credentials`);
        config.provider = auth.provider;
        if (!opts.model) {
          config.model =
            config.providers[auth.provider]?.defaultModel || config.model;
        }
      }

      const provider = createProvider(config, auth);
      const session = resolveSession(config, opts);
      const prompt = promptParts?.length ? promptParts.join(" ") : undefined;
      if (opts.ulw) {
        session.meta.ultrawork = true;
        const mandate = prompt || "improve the codebase";
        armUlwCycle(session.meta.id, mandate, { cycle: 1 });
        saveSession(session);
        log.info(`ULW cycle=1 armed for: ${mandate.slice(0, 80)}`);
      }
      if (opts.goal) {
        armGoal(session.meta.id, String(opts.goal), "manual");
        session.meta.ultrawork = true;
        saveSession(session);
        log.info("Goal armed:\n" + formatGoalStatus(loadGoal(session.meta.id)));
      }

      const hooks = new HookRunner(config, session.meta.cwd);

      // Non-TTY or explicit prompt without interactive intent → single-shot
      if (prompt && (!process.stdin.isTTY || process.env.FORGE_HEADLESS === "1")) {
        await runHeadless({ config, provider, session, hooks, prompt });
        return;
      }

      await runRepl({
        config,
        provider,
        session,
        hooks,
        auth,
        initialPrompt: prompt,
      });
    });

  program
    .command("run")
    .description("Headless one-shot agent run (CI / scripts)")
    .argument("<prompt...>", "Prompt to run")
    .option("-m, --model <model>", "Model id")
    .option("-p, --provider <provider>", "Provider")
    .option("--permission-mode <mode>", "Permission mode", "acceptEdits")
    .option("--ulw", "Ultrawork mode")
    .option("--goal <objective>", "Arm /goal")
    .option("--cwd <path>", "Workspace", process.cwd())
    .option("--json", "Emit JSON result on stdout")
    .action(async (promptParts: string[], opts) => {
      await ensureHome();
      const config = buildConfig({ ...opts, permissionMode: opts.permissionMode });
      const auth = resolveAuth(config);
      if (!auth) {
        log.error("Not authenticated. Run forge login or set an API key.");
        process.exit(1);
      }
      const provider = createProvider(config, auth);
      const session = createSession({
        cwd: path.resolve(opts.cwd || process.cwd()),
        provider: config.provider,
        model: config.model,
        ultrawork: Boolean(opts.ulw || opts.goal),
      });
      const prompt = promptParts.join(" ");
      if (opts.ulw || opts.goal) {
        session.meta.ultrawork = true;
        armUlwCycle(session.meta.id, prompt, { cycle: 1 });
        saveSession(session);
      }
      if (opts.goal) armGoal(session.meta.id, String(opts.goal), "manual");
      const hooks = new HookRunner(config, session.meta.cwd);
      const result = await runHeadless({
        config,
        provider,
        session,
        hooks,
        prompt,
        json: Boolean(opts.json),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      }
    });

  program
    .command("login")
    .description("Authenticate (API key, Grok subscription import, or OAuth)")
    .option("-p, --provider <provider>", "Provider", "xai")
    .option("--api-key [key]", "Use API key (prompt if omitted)")
    .option(
      "--from-grok",
      "Import SuperGrok / xAI session from ~/.grok/auth.json (recommended if you use Grok Build)",
    )
    .option("--oauth", "Browser OAuth flow (needs a registered client id)")
    .option("--device", "Device-code flow (headless)")
    .action(async (opts) => {
      await ensureHome();
      const provider = opts.provider as string;

      if (opts.fromGrok || (provider === "xai" && !opts.apiKey && !opts.oauth && !opts.device)) {
        // Default xAI login path: reuse Grok Build subscription session when present
        if (opts.fromGrok || !opts.apiKey) {
          const result = importGrokCredentials();
          if (result.imported) {
            log.success(
              `Imported Grok subscription session${result.email ? ` (${result.email})` : ""}`,
            );
            if (result.expiresAt) {
              log.dim(
                `Expires ${new Date(result.expiresAt * 1000).toISOString()} — re-run grok login + forge login --from-grok when expired`,
              );
            }
            log.info("Try: forge");
            return;
          }
          if (opts.fromGrok) {
            log.error(result.reason || "Import failed");
            process.exit(1);
          }
          // Fall through to other methods if auto-import missed
          log.warn(result.reason || "No Grok session to import — trying other methods");
        }
      }

      let method: "api_key" | "oauth" | "device" = "api_key";
      if (opts.device) method = "device";
      else if (opts.oauth) method = "oauth";
      else if (opts.apiKey !== undefined) method = "api_key";
      else if (supportsOAuth(provider) && provider !== "xai") {
        method = "oauth";
      } else {
        method = "api_key";
      }
      try {
        await loginInteractive({
          provider,
          method,
          apiKey: typeof opts.apiKey === "string" ? opts.apiKey : undefined,
        });
      } catch (err) {
        log.error((err as Error).message);
        process.exit(1);
      }
    });

  program
    .command("logout")
    .description("Clear stored credentials")
    .option("-p, --provider <provider>", "Provider (omit for all)")
    .action((opts) => {
      logout(opts.provider);
    });

  program
    .command("auth")
    .description("Show authentication status")
    .action(() => {
      printAuthStatus();
      const config = loadConfig();
      const auth = resolveAuth(config);
      console.log(`\nActive resolution: ${describeAuth(auth)}`);
    });

  program
    .command("sessions")
    .description("List recent sessions")
    .action(() => {
      const list = listSessions(30);
      if (!list.length) {
        console.log("No sessions.");
        return;
      }
      for (const s of list) {
        console.log(
          `${s.id}  ${s.updatedAt}  ${s.provider}/${s.model}  turns=${s.turnCount}  edits=${s.editCount}${s.ultrawork ? "  ULW" : ""}`,
        );
      }
    });

  program
    .command("init")
    .description("Write default config and example hooks into ~/.forge and .forge/")
    .action(() => {
      ensureHome();
      const homeCfg = path.join(forgeHome(), "config.toml");
      if (!fs.existsSync(homeCfg)) {
        fs.writeFileSync(homeCfg, defaultConfigToml(), "utf8");
        log.success(`Wrote ${homeCfg}`);
      } else {
        log.info(`Exists: ${homeCfg}`);
      }
      const projectDir = path.join(process.cwd(), ".forge");
      ensureDir(projectDir);
      ensureDir(path.join(projectDir, "hooks"));
      const stopHook = path.join(projectDir, "hooks", "stop-goal-example.json");
      if (!fs.existsSync(stopHook)) {
        fs.writeFileSync(
          stopHook,
          JSON.stringify(
            {
              hooks: {
                Stop: [
                  {
                    hooks: [
                      {
                        type: "command",
                        command: "node -e " +
                          JSON.stringify(
                            `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);if(j.goalObjective&&!(j.lastAssistantMessage||'').includes('Goal achieved')){console.log(JSON.stringify({decision:'block',reason:'Goal still active — keep working: '+j.goalObjective.slice(0,200)}));}else{console.log(JSON.stringify({decision:'allow'}));}});`,
                          ),
                        timeout: 10,
                      },
                    ],
                  },
                ],
              },
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );
        log.success(`Wrote example Stop hook: ${stopHook}`);
      }
      const agents = path.join(process.cwd(), "AGENTS.md");
      if (!fs.existsSync(agents)) {
        fs.writeFileSync(
          agents,
          `# AGENTS.md\n\nProject instructions for Forge (and other coding agents).\n\n## Build\n\n- Describe how to install, build, and test this repo.\n\n## Conventions\n\n- Note style, architecture, and non-obvious constraints.\n`,
          "utf8",
        );
        log.success(`Wrote ${agents}`);
      }
      log.info("Done. Run: forge login && forge");
    });

  program
    .command("models")
    .description("List known models for configured providers")
    .action(() => {
      const config = loadConfig();
      for (const [id, p] of Object.entries(config.providers)) {
        const models = p.models?.length ? p.models.join(", ") : p.defaultModel || "(any)";
        console.log(
          `${id.padEnd(12)} default=${(p.defaultModel || "").padEnd(28)} oauth=${p.supportsOAuth ? "yes" : "no "}  models: ${models}`,
        );
      }
    });

  program
    .command("doctor")
    .description("Check auth, Node version, config, and harness settings")
    .option("-p, --provider <provider>", "Provider override")
    .option("--cwd <path>", "Workspace", process.cwd())
    .action((opts) => {
      const config = buildConfig(opts);
      console.log(runDoctor(config));
    });

  program
    .command("status")
    .description(
      "Native statusline HUD (provider-agnostic: tokens always; plan/credits when available)",
    )
    .option("--watch", "Live refresh (default 1s)")
    .option("--interval <ms>", "Watch interval ms", "1000")
    .option("--session <id>", "Focus session id / prefix")
    .option("--cwd <path>", "Filter sessions by workspace")
    .option("--all", "Show all recent sessions")
    .option("--json", "Machine-readable JSON")
    .option("--tmux", "Single-line plain output for tmux status-right")
    .option("--plain", "No color")
    .option("--no-plan", "Skip network plan/billing probe")
    .action(async (opts) => {
      const collectOpts = {
        sessionId: opts.session as string | undefined,
        cwd: opts.cwd as string | undefined,
        all: Boolean(opts.all),
        fetchPlan: opts.plan !== false,
        config: loadConfig({}, opts.cwd || process.cwd()),
      };

      if (opts.watch) {
        const ac = new AbortController();
        process.on("SIGINT", () => ac.abort());
        await runStatusWatch({
          ...collectOpts,
          intervalMs: Number(opts.interval) || 1000,
          json: Boolean(opts.json),
          plain: Boolean(opts.plain),
          tmux: Boolean(opts.tmux),
          signal: ac.signal,
        });
        return;
      }

      const snaps = await collectSnapshots(collectOpts);
      if (opts.json) {
        console.log(snapshotsToJson(snaps));
        return;
      }
      if (opts.tmux) {
        console.log(renderTmux(snaps[0]));
        return;
      }
      console.log(
        renderHud(snaps, {
          plain: Boolean(opts.plain),
          width: process.stdout.columns,
        }),
      );
    });

  await program.parseAsync(process.argv);
}

function buildConfig(opts: Record<string, unknown>): ForgeConfig {
  const cwd = path.resolve(String(opts.cwd || process.cwd()));
  const overrides: Partial<ForgeConfig> = { workspace: cwd };
  if (opts.model) overrides.model = String(opts.model);
  if (opts.provider) overrides.provider = String(opts.provider) as ForgeConfig["provider"];
  if (opts.baseUrl) overrides.baseUrl = String(opts.baseUrl);
  if (opts.permissionMode) {
    overrides.permissionMode = String(opts.permissionMode) as ForgeConfig["permissionMode"];
  }
  if (opts.sandbox) {
    overrides.sandbox = String(opts.sandbox) as ForgeConfig["sandbox"];
  }
  if (opts.sandboxNetwork) {
    overrides.sandboxNetwork = String(opts.sandboxNetwork) as ForgeConfig["sandboxNetwork"];
  }
  if (opts.sandboxMissing) {
    overrides.sandboxMissingBackend = String(
      opts.sandboxMissing,
    ) as ForgeConfig["sandboxMissingBackend"];
  }
  if (opts.blockingStop === false || opts.noBlockingStop) {
    overrides.blockingStopHooks = false;
  }
  const cfg = loadConfig(overrides, cwd);
  // CLI --deny/--allow/--ask append to config rules
  const extraDeny = Array.isArray(opts.deny) ? (opts.deny as string[]) : [];
  const extraAllow = Array.isArray(opts.allow) ? (opts.allow as string[]) : [];
  const extraAsk = Array.isArray(opts.ask) ? (opts.ask as string[]) : [];
  if (extraDeny.length || extraAllow.length || extraAsk.length) {
    cfg.permission = {
      deny: [...(cfg.permission?.deny || []), ...extraDeny],
      allow: [...(cfg.permission?.allow || []), ...extraAllow],
      ask: [...(cfg.permission?.ask || []), ...extraAsk],
      rules: cfg.permission?.rules || [],
    };
  }
  return cfg;
}

function resolveSession(
  config: ForgeConfig,
  opts: { session?: string; new?: boolean; cwd?: string },
) {
  if (opts.session) {
    const s = loadSession(opts.session);
    if (!s) {
      log.error(`Session not found: ${opts.session}`);
      process.exit(1);
    }
    return s;
  }
  return createSession({
    cwd: path.resolve(String(opts.cwd || config.workspace || process.cwd())),
    provider: String(config.provider),
    model: config.model,
    ultrawork: false,
  });
}

async function ensureHome(): Promise<void> {
  ensureDir(forgeHome());
  ensureDir(path.join(forgeHome(), "hooks"));
  ensureDir(path.join(forgeHome(), "sessions"));
}

async function runHeadless(opts: {
  config: ForgeConfig;
  provider: ReturnType<typeof createProvider>;
  session: ReturnType<typeof createSession>;
  hooks: HookRunner;
  prompt: string;
  json?: boolean;
}) {
  const permissions = new PermissionGate({ interactive: false });
  await opts.hooks.run("SessionStart", {
    sessionId: opts.session.meta.id,
    cwd: opts.session.meta.cwd,
    workspaceRoot: opts.config.workspace || opts.session.meta.cwd,
  });

  const result = await runAgentLoop({
    config: opts.config,
    provider: opts.provider,
    session: opts.session,
    hooks: opts.hooks,
    permissions,
    userMessage: opts.prompt,
    stream: !opts.json,
    onToken: opts.json
      ? undefined
      : (t) => {
          process.stdout.write(t);
        },
  });

  await opts.hooks.run("SessionEnd", {
    sessionId: opts.session.meta.id,
    cwd: opts.session.meta.cwd,
    workspaceRoot: opts.config.workspace || opts.session.meta.cwd,
  });
  saveSession(opts.session);

  if (!opts.json && result.finalText && !result.finalText.endsWith("\n")) {
    process.stdout.write("\n");
  }

  return {
    sessionId: opts.session.meta.id,
    finalText: result.finalText,
    turns: result.turns,
    stopContinues: result.stopContinues,
    editCount: opts.session.meta.editCount,
    aborted: result.aborted,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
