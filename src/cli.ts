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
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { formatRelativeTime } from "./util/format.js";
import { loadConfig, defaultConfigToml } from "./config/load.js";
import type {
  ForgeConfig,
  PermissionMode,
  ProviderId,
  SandboxMissingBackend,
  SandboxNetwork,
  SandboxProfile,
} from "./config/types.js";
import { parseReasoningEffort } from "./config/reasoning.js";
import { resolveAuth, resolveAuthFresh, describeAuth } from "./auth/resolve.js";
import { loginInteractive, logout, printAuthStatus, supportsOAuth } from "./auth/login.js";
import {
  listCredentials,
  clearCredential,
  upsertApiKey,
} from "./auth/store.js";
import { importGrokCredentials } from "./auth/import-grok.js";
import { createProvider } from "./providers/factory.js";
import {
  createSession,
  loadSession,
  listSessions,
  saveSession,
  deleteSessionDetailed,
  pruneSessions,
  sessionHasForeignLiveLock,
  forkSession,
  exportSessionMarkdown,
  exportSessionJson,
  importSessionJson,
  formatSessionSummary,
  formatSessionLookupMiss,
  findRecentSessionForCwd,
  setSessionTitle,
  setSessionPinned,
  formatResumeOrientation,
  resolveSessionDir,
  resolveSessionJsonPath,
} from "./session/session.js";
import {
  appendSessionMetrics,
  buildRunEndMetrics,
  collectUsageStats,
  formatUsageStats,
  metricsStats,
  pruneMetrics,
} from "./session/metrics.js";
import {
  acquireSessionLock,
  releaseSessionLock,
  readSessionLock,
  formatLockHolder,
} from "./session/lock.js";
import { HookRunner } from "./harness/hooks.js";
import { PermissionGate } from "./agent/permissions.js";
import {
  killAllRunningTasks,
  listTasks,
  installBackgroundTaskExitHook,
} from "./agent/tools/background-tasks.js";
import { loadSavedAllows } from "./agent/permission-saved.js";
import { runAgentLoop } from "./agent/loop.js";
import { runRepl } from "./tui/repl.js";
import { forgeHome, ensureDir, inspectSecureFile } from "./util/fs.js";
import { log, setLogLevel } from "./util/log.js";
import { mergeRunOpts } from "./util/merge-run-opts.js";
import { armGoal, formatGoalStatus, loadGoal } from "./harness/goal.js";
import { armUlwCycle, loadUlwCycle, formatUlwCounts } from "./harness/ulw-cycle.js";
import { formatEffectiveConfig, runDoctorCheck } from "./commands/slash.js";
import {
  collectSnapshots,
  renderHud,
  renderTmux,
  snapshotsToJson,
  runStatusWatch,
} from "./statusline/index.js";

import { getForgeVersion } from "./util/version.js";
import {
  formatWhatsNew,
  loadChangelogReleases,
} from "./util/changelog.js";
import { formatExpertTips } from "./util/tips.js";
import { shellCompletionScript } from "./util/completion-script.js";
import { providerTimeoutMs } from "./util/abort.js";
import {
  defaultBashBackgroundTimeoutMs,
  defaultBashTimeoutMs,
  envPositiveInt,
  parseKeepCount,
} from "./util/env.js";
import { isBellEnabled } from "./util/attention.js";
import { permissionAskTimeoutMs } from "./agent/permissions.js";
import {
  pruneToolOutputsSync,
  toolOutputStats,
} from "./agent/tools/truncate.js";
import {
  formatSandboxLogTail,
  sandboxLogPath,
  sandboxLogStats,
} from "./agent/sandbox-log.js";
import { mutationsJournalStats } from "./session/mutations.js";
const VERSION = getForgeVersion();

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("forge")
    .description(
      "Forge — AI coding agent with blocking Stop hooks, /goal driver, and multi-provider auth",
    )
    .version(VERSION)
    .addHelpText(
      "after",
      `
Examples:
  forge login
  forge doctor --json
  forge run "fix CI" --permission-mode acceptEdits --json
  forge run "continue" --session <id> --json
  forge run "next step" --continue --json
  forge "next step" --continue                 # bare headless same-cwd resume
  forge "next step" --json                     # bare headless JSON (parity with run --json)
  forge sessions prune --keep 50
  forge sessions export <id> --format json --out ./session.json
  forge stats --days 7
  forge news
  forge tips
  forge logs
  forge config --json
  forge prune-tool-output --keep 80
  forge prune-metrics --keep 500
  eval "$(forge completion bash)"

Docs: docs/PRODUCTION.md · docs/RELIABILITY.md · docs/ULW.md · forge news
`,
    )
    .option("-m, --model <model>", "Model id")
    .option("-p, --provider <provider>", "Provider: xai|anthropic|openai|openrouter|google|custom")
    .option("--base-url <url>", "Override API base URL")
    .option(
      "--effort <level>",
      "Reasoning effort for supported models: low|medium|high",
    )
    .option(
      "--reasoning-effort <level>",
      "Alias for --effort",
    )
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
    .option(
      "--new",
      "Force a new session (default resumes newest same-cwd session in the REPL)",
    )
    .option("--session <id>", "Resume session id/prefix or unique title")
    .option(
      "--continue",
      "Resume newest same-cwd session (headless bare forge parity with forge run --continue)",
    )
    .option("--title <text>", "Label for a new session (searchable via list -q / /sessions search)")
    .option(
      "--json",
      "Headless JSON result on stdout (parity with forge run --json; implies non-interactive)",
    )
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
      const wantJson = Boolean(opts.json);
      const prompt = promptParts?.length
        ? promptParts.join(" ").trim() || undefined
        : undefined;
      // --json is headless-only (same payload as forge run --json).
      if (wantJson && !prompt) {
        console.log(
          JSON.stringify({
            ok: false,
            reason: "empty_prompt",
            error:
              'Empty prompt. Usage: forge "your task" --json   (or: forge run "your task" --json)',
          }),
        );
        process.exit(1);
      }
      const config = buildConfig(opts);
      const auth = await resolveAuthFresh(config);
      if (!auth) {
        const msg =
          "Not authenticated. Run: forge login\n" +
          "  or set XAI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / …";
        if (wantJson) {
          console.log(
            JSON.stringify({
              ok: false,
              reason: "unauthenticated",
              error: "Not authenticated. Run forge login or set an API key.",
              provider: config.provider,
            }),
          );
        } else {
          log.error(msg);
        }
        process.exit(1);
      }
      // Align provider if auth auto-detected a different one
      if (auth.provider !== config.provider) {
        if (!wantJson) {
          log.info(`Using provider ${auth.provider} from available credentials`);
        }
        config.provider = auth.provider;
        if (!opts.model) {
          config.model =
            config.providers[auth.provider]?.defaultModel || config.model;
        }
      }

      const provider = createProvider(config, auth);
      // --json forces headless even on a TTY (parity with forge run --json).
      const willHeadless = Boolean(
        prompt &&
          (wantJson ||
            !process.stdin.isTTY ||
            process.env.FORGE_HEADLESS === "1"),
      );
      // Interactive REPL: resume newest same-cwd session (OpenCode --continue style)
      // unless --new / --session / FORGE_NO_AUTO_RESUME. Headless starts fresh unless
      // --session or explicit --continue (parity with forge run --continue).
      const session = resolveSession(config, {
        ...opts,
        autoResume: !willHeadless,
        continue: Boolean(opts.continue),
        json: wantJson,
      });
      if (opts.ulw) {
        session.meta.ultrawork = true;
        const mandate = prompt || "improve the codebase";
        armUlwCycle(session.meta.id, mandate, { cycle: 1 });
        saveSession(session);
        if (!wantJson) log.info(`ULW cycle=1 armed for: ${mandate.slice(0, 80)}`);
      }
      if (opts.goal) {
        armGoal(session.meta.id, String(opts.goal), "manual");
        session.meta.ultrawork = true;
        saveSession(session);
        if (!wantJson) {
          log.info("Goal armed:\n" + formatGoalStatus(loadGoal(session.meta.id)));
        }
      }

      const hooks = new HookRunner(config, session.meta.cwd);

      // Non-TTY, FORGE_HEADLESS, or --json → single-shot
      if (willHeadless && prompt) {
        const result = await runHeadless({
          config,
          provider,
          session,
          hooks,
          prompt,
          json: wantJson,
        });
        if (wantJson) {
          console.log(JSON.stringify(result, null, 2));
        }
        if (result.timedOut) process.exitCode = 124;
        else if (result.aborted) process.exitCode = 130;
        else if (!result.finalText && result.turns === 0) process.exitCode = 1;
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
    .description(
      "Headless one-shot agent run (CI / scripts). Exit: 0 ok · 1 error/empty · 124 FORGE_MAX_RUN_MS · 130 abort",
    )
    .argument("[prompt...]", "Prompt to run (required; empty → exit 1)")
    .option("-m, --model <model>", "Model id")
    .option("-p, --provider <provider>", "Provider")
    .option("--base-url <url>", "Override API base URL")
    .option("--effort <level>", "Reasoning effort: low|medium|high")
    .option("--reasoning-effort <level>", "Alias for --effort")
    .option("--permission-mode <mode>", "Permission mode", "acceptEdits")
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
    .option("--ulw", "Ultrawork mode")
    .option("--goal <objective>", "Arm /goal")
    .option("--cwd <path>", "Workspace", process.cwd())
    .option(
      "--session <id>",
      "Resume session id/prefix or unique title (continue prior headless run)",
    )
    .option(
      "--continue",
      "Resume newest same-cwd session (≤14d; skips foreign locks). Ignored with --session/--new",
    )
    .option("--new", "Force a new session (default when --session/--continue omitted)")
    .option("--title <text>", "Label for a new session (CI-friendly; searchable via list -q)")
    .option("--json", "Emit JSON result on stdout")
    .addHelpText(
      "after",
      `
Exit codes:
  0    success
  1    error, empty/whitespace prompt, empty run, or unauthenticated
  124  wall-clock timeout (FORGE_MAX_RUN_MS)
  130  aborted (SIGINT)

--json fields (success): ok, sessionId, title, finalText, turns, stopContinues,
  releasedOnContinueCap, hitMaxTurns, finishReason, editCount, aborted, timedOut,
  promptTokens, completionTokens, durationMs, model, provider
  (releasedOnContinueCap/hitMaxTurns → safety valves; still ok unless aborted/timedOut)
  (finishReason → last provider finish_reason, or null if no model turn)

--json early failures (stdout, still exit ≠0): { ok:false, reason, error, … }
  reason=empty_prompt | unauthenticated | session_not_found | locked
  | invalid_effort | invalid_permission_mode | invalid_sandbox
  | invalid_sandbox_network | invalid_sandbox_missing | invalid_provider
  | invalid_model | invalid_base_url
  | missing_base_url  (custom without --base-url / FORGE_BASE_URL)
  | error | timeout | aborted  (mid-run catch path)

Empty prompts exit 1 before auth/session create (no orphan sessions, no API spend).
--session/--new/--title work on parent or subcommand (optsWithGlobals merge).
Label runs: --title <label> (searchable via forge sessions list -q / /sessions search).
Multi-step CI without copying ids: forge run "…" --continue --json

CI tips: forge doctor --json · --permission-mode acceptEdits · --sandbox workspace · --title ci-job
Docs: docs/PRODUCTION.md
`,
    )
    .action(async (promptParts: string[], opts, command) => {
      await ensureHome();
      // Parent program also defines --session/--new/--title/--cwd/--permission-mode;
      // merge so flags work whether bound to parent or subcommand. Prefer CLI-sourced
      // values over Commander defaults (run's permissionMode default must not clobber
      // parent --permission-mode yolo / explicit invalid values we validate).
      const runOpts = mergeRunOpts(command, opts);
      // Validate prompt before auth/session side effects (no orphan empty sessions).
      const prompt = (promptParts || []).join(" ").trim();
      const wantJson = Boolean(runOpts.json);
      if (!prompt) {
        const msg =
          'Empty prompt. Usage: forge run "your task" [--title label] [--json]';
        if (wantJson) {
          console.log(
            JSON.stringify({ ok: false, error: msg, reason: "empty_prompt" }),
          );
        } else {
          log.error(msg);
        }
        process.exitCode = 1;
        process.exit(1);
      }
      const config = buildConfig({
        ...runOpts,
        permissionMode: runOpts.permissionMode,
      });
      const auth = await resolveAuthFresh(config);
      if (!auth) {
        const msg = "Not authenticated. Run forge login or set an API key.";
        if (wantJson) {
          console.log(
            JSON.stringify({
              ok: false,
              error: msg,
              reason: "unauthenticated",
              provider: config.provider,
            }),
          );
        } else {
          log.error(msg);
        }
        process.exit(1);
      }
      const provider = createProvider(config, auth);
      const cwd = path.resolve(String(runOpts.cwd || process.cwd()));
      // Commander always applies option defaults — only treat --cwd as explicit
      // when the user actually passed it on the CLI (so --session keeps its cwd).
      const cwdExplicit =
        command?.getOptionValueSource?.("cwd") === "cli" ||
        command?.parent?.getOptionValueSource?.("cwd") === "cli";
      let session;
      let resumed = false;
      // --session present (including "") must not silently start fresh
      const sessionFlag =
        runOpts.session != null ? String(runOpts.session).trim() : "";
      const sessionPassed = runOpts.session != null;
      if (sessionPassed && !runOpts.new) {
        if (!sessionFlag) {
          const msg =
            'Empty --session. Pass an id/prefix/title, or omit --session for a new run.';
          if (wantJson) {
            console.log(
              JSON.stringify({
                ok: false,
                reason: "session_not_found",
                session: String(runOpts.session),
                error: msg,
              }),
            );
          } else {
            log.error(msg);
          }
          process.exit(1);
        }
        session = loadSession(sessionFlag);
        if (!session) {
          const miss = formatSessionLookupMiss(sessionFlag);
          if (wantJson) {
            console.log(
              JSON.stringify({
                ok: false,
                error: miss,
                reason: "session_not_found",
                session: sessionFlag,
              }),
            );
          } else {
            log.error(miss);
          }
          process.exit(1);
        }
        resumed = true;
      } else if (runOpts.continue && !runOpts.new) {
        // OpenCode-style headless continue: newest same-cwd session without copying ids.
        try {
          const hit = findRecentSessionForCwd(cwd);
          if (hit?.meta) {
            session = loadSession(hit.meta.id);
            if (session) {
              resumed = true;
              const skipNote =
                hit.skippedLocked > 0
                  ? ` (skipped ${hit.skippedLocked} locked)`
                  : "";
              log.dim(
                `Continuing ${session.meta.id.slice(0, 8)} — ${session.meta.title || "untitled"} (${session.messages.length} msgs)${skipNote}`,
              );
            }
          } else if (hit && hit.skippedLocked > 0) {
            log.warn(
              `No unlocked same-cwd session to continue (${hit.skippedLocked} locked). Starting fresh. Use --session <id> to attach anyway.`,
            );
          } else {
            log.dim("No prior same-cwd session to continue — starting fresh.");
          }
        } catch {
          /* fall through to new session */
        }
      }
      if (resumed && session) {
        // Align live config model with resumed session unless CLI overrode it
        if (!runOpts.model) config.model = session.meta.model || config.model;
        if (!runOpts.provider) {
          config.provider = (session.meta.provider ||
            config.provider) as typeof config.provider;
        }
        session.meta.provider = String(config.provider);
        session.meta.model = config.model;
        if (cwdExplicit) {
          session.meta.cwd = cwd;
        }
        // Prefer session workspace for tools when not explicitly overridden
        if (!cwdExplicit && session.meta.cwd) {
          config.workspace = session.meta.cwd;
        }
        saveSession(session);
        if (runOpts.session) {
          log.dim(
            `Resuming session ${session.meta.id.slice(0, 8)} (${session.messages.length} msgs)`,
          );
        }
        try {
          const peek = formatResumeOrientation(session);
          if (peek) log.dim(peek);
        } catch {
          /* */
        }
      } else {
        session = createSession({
          cwd,
          provider: config.provider,
          model: config.model,
          ultrawork: Boolean(runOpts.ulw || runOpts.goal),
          title: typeof runOpts.title === "string" ? runOpts.title : undefined,
        });
      }
      // Allow --title on resume to relabel (experts tagging CI pipelines)
      if (
        runOpts.title &&
        typeof runOpts.title === "string" &&
        (runOpts.session || runOpts.continue)
      ) {
        setSessionTitle(session, runOpts.title);
      }
      if (runOpts.ulw || runOpts.goal) {
        session.meta.ultrawork = true;
        armUlwCycle(session.meta.id, prompt, { cycle: 1 });
        saveSession(session);
      }
      if (runOpts.goal) armGoal(session.meta.id, String(runOpts.goal), "manual");
      const hooks = new HookRunner(config, session.meta.cwd);
      const result = await runHeadless({
        config,
        provider,
        session,
        hooks,
        prompt,
        json: wantJson,
      });
      if (wantJson) {
        console.log(JSON.stringify(result, null, 2));
      }
      // CI-friendly exit codes: wall-clock timeout=124, abort=130, empty=1
      if (result.timedOut) process.exitCode = 124;
      else if (result.aborted) process.exitCode = 130;
      else if (!result.finalText && result.turns === 0) process.exitCode = 1;
    });

  program
    .command("login")
    .description(
      "Authenticate: SuperGrok OIDC (default for xai), API key, Grok import, or device code",
    )
    .option("-p, --provider <provider>", "Provider", "xai")
    .option("--api-key [key]", "Use API key (prompt if omitted)")
    .option(
      "--from-grok",
      "Import SuperGrok session from ~/.grok/auth.json (Grok Build already logged in)",
    )
    .option(
      "--oauth",
      "Browser SuperGrok / OIDC (default for xai; same public client as Grok CLI)",
    )
    .option("--device", "Device-code flow (headless SSH / remote)")
    .option("--json", "Machine-readable JSON (never includes tokens)")
    .action(async (opts, command) => {
      await ensureHome();
      const globals = (command?.optsWithGlobals?.() || {}) as Record<string, unknown>;
      const merged = { ...globals, ...opts } as Record<string, unknown>;
      const wantJson = Boolean(merged.json || opts.json);
      // Parent -p/--provider must not be clobbered by login's default "xai".
      const localSrc = command?.getOptionValueSource?.("provider");
      const parentSrc = command?.parent?.getOptionValueSource?.("provider");
      let providerRaw = "xai";
      if (localSrc === "cli" && opts.provider != null) {
        providerRaw = String(opts.provider);
      } else if (parentSrc === "cli" && globals.provider != null) {
        providerRaw = String(globals.provider);
      } else if (opts.provider != null) {
        providerRaw = String(opts.provider);
      }
      const providerNorm = providerRaw.trim().toLowerCase();
      const failLogin = (reason: string, error: string, extra?: Record<string, unknown>) => {
        if (wantJson) {
          console.log(
            JSON.stringify({
              ok: false,
              reason,
              error,
              provider: providerNorm,
              ...extra,
            }),
          );
        } else {
          log.error(error);
        }
        process.exit(1);
      };
      if (!PROVIDER_IDS.has(providerNorm)) {
        failLogin(
          "invalid_provider",
          `Invalid --provider "${providerRaw}". Use xai|anthropic|openai|openrouter|google|custom.`,
          { provider: providerRaw },
        );
      }
      const provider = providerNorm === "grok" ? "xai" : providerNorm;
      // Commander optional --api-key [key]: true = flag only, "" = empty string, string = value.
      // Empty string must NOT fall through to Grok import (user asked for api_key).
      const apiKeyFlag = opts.apiKey !== undefined;
      const apiKeyValue =
        typeof opts.apiKey === "string" ? opts.apiKey.trim() : "";

      // Explicit Grok Build file import only (--from-grok). Default is SuperGrok OIDC.
      if (opts.fromGrok) {
        const result = importGrokCredentials();
        if (result.imported) {
          if (wantJson) {
            console.log(
              JSON.stringify({
                ok: true,
                method: "from_grok",
                provider: "xai",
                accountLabel: result.email ? `grok:${result.email}` : null,
                expiresAt: result.expiresAt
                  ? new Date(result.expiresAt * 1000).toISOString()
                  : null,
              }),
            );
            return;
          }
          log.success(
            `Imported Grok subscription session${result.email ? ` (${result.email})` : ""}`,
          );
          if (result.expiresAt) {
            const hours = Math.max(
              0,
              (result.expiresAt - Math.floor(Date.now() / 1000)) / 3600,
            );
            log.dim(
              `Access token expires ${new Date(result.expiresAt * 1000).toISOString()} (~${hours.toFixed(1)}h). ` +
                `Prefer: forge login  (native SuperGrok OIDC) for independent refresh. ` +
                `Multi-day unattended: forge login --api-key`,
            );
          }
          log.info("Try: forge");
          return;
        }
        failLogin("grok_import_failed", result.reason || "Import failed", {
          email: result.email || null,
        });
      }

      // Default xAI path: native SuperGrok OIDC (browser), not import-from-grok.
      let method: "api_key" | "oauth" | "device" = "api_key";
      if (opts.device) method = "device";
      else if (opts.oauth) method = "oauth";
      else if (apiKeyFlag) method = "api_key";
      else if (supportsOAuth(provider)) method = "oauth";
      else method = "api_key";

      // --json requires a non-interactive path (explicit API key).
      if (wantJson && method !== "api_key") {
        failLogin(
          "interactive_required",
          `login --json only supports --api-key (got method=${method}). Use forge login --api-key <key> --json.`,
          { method },
        );
      }
      if (wantJson && method === "api_key" && !apiKeyValue) {
        failLogin(
          "api_key_required",
          "login --json requires an explicit key: forge login --api-key <key> --json",
        );
      }
      try {
        if (wantJson && method === "api_key") {
          // Quiet path — no log.success noise mixed into CI stdout/stderr.
          upsertApiKey(provider, apiKeyValue);
          console.log(
            JSON.stringify({
              ok: true,
              method: "api_key",
              provider,
              // never echo the key
            }),
          );
          return;
        }
        await loginInteractive({
          provider,
          method,
          apiKey: apiKeyValue || undefined,
        });
      } catch (err) {
        if (provider === "xai" && method === "oauth" && !wantJson) {
          log.dim(
            "Also: forge login --device · forge login --from-grok · forge login --api-key",
          );
        }
        failLogin("login_failed", (err as Error).message || String(err), {
          method,
        });
      }
    });

  program
    .command("logout")
    .description("Clear stored credentials")
    .option("-p, --provider <provider>", "Provider (omit for all)")
    .option("--json", "Machine-readable JSON")
    .action((opts, command) => {
      // Parent also defines -p/--provider; prefer CLI-sourced value from either side.
      const merged = {
        ...(command?.optsWithGlobals?.() || {}),
        ...opts,
      } as Record<string, unknown>;
      const localSrc = command?.getOptionValueSource?.("provider");
      const parentSrc = command?.parent?.getOptionValueSource?.("provider");
      let provider: string | undefined;
      if (localSrc === "cli" && typeof opts.provider === "string") {
        provider = opts.provider.trim() || undefined;
      } else if (parentSrc === "cli" && typeof merged.provider === "string") {
        provider = String(merged.provider).trim() || undefined;
      } else if (typeof opts.provider === "string" && opts.provider.trim()) {
        provider = opts.provider.trim();
      }
      const wantJson = Boolean(merged.json || opts.json);
      if (wantJson) {
        const before = listCredentials()
          .filter((c) => !provider || c.provider === provider)
          .map((c) => ({
            provider: c.provider,
            method: c.method,
            accountLabel: c.accountLabel || null,
          }));
        // Clear without log.success noise on stdout/stderr for CI JSON.
        if (provider) clearCredential(provider);
        else {
          for (const c of [...listCredentials()]) clearCredential(c.provider);
        }
        console.log(
          JSON.stringify(
            {
              ok: true,
              cleared: provider || "all",
              removed: before,
              count: before.length,
            },
            null,
            2,
          ),
        );
        return;
      }
      logout(provider);
    });

  program
    .command("auth")
    .description("Show authentication status")
    .option("--json", "Machine-readable JSON (never includes tokens)")
    .action(async (opts, command) => {
      const config = loadConfig();
      const auth = await resolveAuthFresh(config);
      if (flagJson(opts, command)) {
        const { nowEpoch } = await import("./util/fs.js");
        const now = nowEpoch();
        const creds = listCredentials().map((c) => {
          const expired =
            typeof c.expiresAt === "number" ? c.expiresAt < now : false;
          return {
            provider: c.provider,
            method: c.method,
            accountLabel: c.accountLabel || null,
            subscription: c.subscription || null,
            expiresAt: c.expiresAt
              ? new Date(c.expiresAt * 1000).toISOString()
              : null,
            expired,
            // Never dump accessToken / refreshToken / clientId
          };
        });
        const authenticated = Boolean(auth);
        console.log(
          JSON.stringify(
            {
              // ok tracks auth for CI (parity with doctor --json); still exit 1 when false
              ok: authenticated,
              authenticated,
              active: auth
                ? {
                    provider: auth.provider,
                    method: auth.method,
                    accountLabel: auth.accountLabel || null,
                    baseUrl: auth.baseUrl || null,
                    // token intentionally omitted
                  }
                : null,
              description: describeAuth(auth),
              stored: creds,
              ...(!authenticated
                ? {
                    reason: "unauthenticated",
                    error: "Not authenticated. Run forge login or set an API key.",
                  }
                : {}),
            },
            null,
            2,
          ),
        );
        if (!authenticated) process.exitCode = 1;
        return;
      }
      printAuthStatus();
      console.log(`\nActive resolution: ${describeAuth(auth)}`);
      if (!auth) process.exitCode = 1;
    });

  program
    .command("sessions")
    .description(
      "List, show, path, export, import, fork, pin/unpin, title, delete (--force if locked), or prune sessions",
    )
    .argument(
      "[action]",
      "list (default) | show <id> | path <id> | export <id> | import <file> | fork <id> | pin <id> | unpin <id> | title <id> <name> | delete <id> [--force] | prune",
    )
    .argument("[id]", "Session id/prefix/title or import file path")
    .argument("[extra...]", "title: new label words (or clear|none|- to unset)")
    .option("--keep <n>", "Prune: keep newest N sessions", "50")
    .option("--max-age-days <n>", "Prune: also drop sessions older than N days")
    .option("--json", "Machine-readable JSON")
    .option("--out <path>", "Export: write to file (default stdout)")
    .option("--format <fmt>", "Export format: md|json (default md)", "md")
    .option(
      "--cwd <path>",
      "List: filter by workspace cwd · Import: workspace cwd override",
    )
    .option(
      "-q, --query <text>",
      "List: case-insensitive id/title/last-prompt substring filter",
    )
    .option("--pinned", "List: only pin-protected sessions")
    .option(
      "-n, --limit <n>",
      "List limit (0 = unlimited)",
      "30",
    )
    .option("--force", "Delete even if another live process holds the session lock")
    .action(
      (
        action: string | undefined,
        id: string | undefined,
        extra: string[] | undefined,
        opts: Record<string, unknown>,
        command: { optsWithGlobals: () => Record<string, unknown>; getOptionValueSource?: (n: string) => string | undefined; parent?: { getOptionValueSource?: (n: string) => string | undefined } },
      ) => {
      // Commander may attach --cwd to the parent program when both define it;
      // prefer optsWithGlobals + explicit CLI source for list filtering.
      const globalOpts = {
        ...command.optsWithGlobals(),
        ...opts,
      } as Record<string, unknown>;
      const cwdExplicit =
        command.getOptionValueSource?.("cwd") === "cli" ||
        command.parent?.getOptionValueSource?.("cwd") === "cli";
      const act = (action || "list").toLowerCase();
      if (act === "delete" || act === "rm" || act === "remove") {
        const target = id || "";
        if (!target) {
          failUsage("Usage: forge sessions delete <id> [--force]", {
            json: Boolean(globalOpts.json),
          });
        }
        const result = deleteSessionDetailed(target, {
          force: Boolean(globalOpts.force),
        });
        if (!result.ok) {
          if (globalOpts.json) {
            console.log(
              JSON.stringify({
                ok: false,
                deleted: false,
                reason: result.reason,
                id: result.id || null,
                detail: result.detail || null,
              }),
            );
          } else if (result.reason === "locked") {
            log.error(
              `Session locked: ${result.id?.slice(0, 8) || target}` +
                (result.detail ? ` — ${result.detail}` : ""),
            );
          } else {
            log.error(formatSessionLookupMiss(target));
          }
          process.exit(1);
        }
        if (globalOpts.json)
          console.log(
            JSON.stringify({ ok: true, deleted: true, id: result.id }),
          );
        else log.success(`Deleted session ${result.id}`);
        return;
      }
      if (act === "path" || act === "dir" || act === "location") {
        const target = id || "";
        if (!target) {
          failUsage("Usage: forge sessions path <id|title>", {
            json: Boolean(globalOpts.json),
          });
        }
        const dir = resolveSessionDir(target);
        if (!dir) {
          failSessionLookup(target, { json: Boolean(globalOpts.json) });
        }
        const jsonPath =
          resolveSessionJsonPath(target) || path.join(dir, "session.json");
        const sid = path.basename(dir);
        const foreignLock = sessionHasForeignLiveLock(sid);
        if (globalOpts.json) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                id: sid,
                dir,
                sessionJson: jsonPath,
                foreignLock,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(dir);
          console.log(chalk.dim(jsonPath));
          if (foreignLock) {
            const lock = readSessionLock(sid);
            log.dim(
              `foreign live lock` +
                (lock ? `: ${formatLockHolder(lock)}` : ""),
            );
          }
        }
        return;
      }
      if (act === "show" || act === "info" || act === "get") {
        const target = id || "";
        if (!target) {
          failUsage("Usage: forge sessions show <id>", {
            json: Boolean(globalOpts.json),
          });
        }
        const s = loadSession(target);
        if (!s) {
          failSessionLookup(target, { json: Boolean(globalOpts.json) });
        }
        const lock = readSessionLock(s.meta.id);
        const foreignLock = sessionHasForeignLiveLock(s.meta.id);
        if (globalOpts.json) {
          const dir = resolveSessionDir(s.meta.id);
          console.log(
            JSON.stringify(
              {
                ok: true,
                meta: s.meta,
                todos: s.todos,
                messageCount: s.messages.length,
                path: dir,
                sessionJson: dir ? path.join(dir, "session.json") : null,
                foreignLock,
                lock: lock
                  ? {
                      pid: lock.pid,
                      hostname: lock.hostname,
                      acquiredAt: lock.acquiredAt,
                      holder: formatLockHolder(lock),
                    }
                  : null,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(formatSessionSummary(s));
          if (lock) {
            console.log(
              `  lock:     ${formatLockHolder(lock)}` +
                (foreignLock ? "  (foreign live)" : ""),
            );
          } else {
            console.log(`  lock:     (none)`);
          }
        }
        return;
      }
      if (act === "export") {
        const target = id || "";
        if (!target) {
          failUsage(
            "Usage: forge sessions export <id> [--format md|json] [--out path]",
            { json: Boolean(globalOpts.json) },
          );
        }
        // Validate format before session lookup so bad flags fail fast.
        // Empty --format '' must not coerce to md via || default.
        const fmtRaw =
          globalOpts.format != null
            ? String(globalOpts.format).trim().toLowerCase()
            : "md";
        const fmt = fmtRaw || "";
        if (fmt !== "md" && fmt !== "markdown" && fmt !== "json") {
          if (globalOpts.json) {
            console.log(
              JSON.stringify({
                ok: false,
                reason: "invalid_format",
                format: globalOpts.format != null ? String(globalOpts.format) : fmt,
                error: `Unknown export format "${globalOpts.format ?? ""}". Use md or json.`,
              }),
            );
          } else {
            log.error(
              `Unknown export format "${globalOpts.format ?? ""}". Use md or json.`,
            );
          }
          process.exit(1);
        }
        const s = loadSession(target);
        if (!s) {
          failSessionLookup(target, { json: Boolean(globalOpts.json) });
        }
        const foreignLock = sessionHasForeignLiveLock(s.meta.id);
        if (foreignLock && !globalOpts.json) {
          const lock = readSessionLock(s.meta.id);
          log.warn(
            `Session has a foreign live lock` +
              (lock ? ` (${formatLockHolder(lock)})` : "") +
              ` — export may capture a mid-write snapshot`,
          );
        }
        const body =
          fmt === "json" ? exportSessionJson(s) : exportSessionMarkdown(s);
        // Commander may set out="" when user passes --out ''; treat as usage miss.
        // out != null means the flag was present (including empty string).
        const outPassed = globalOpts.out != null;
        const outRaw = outPassed ? String(globalOpts.out).trim() : "";
        if (outPassed && !outRaw) {
          if (globalOpts.json) {
            console.log(
              JSON.stringify({
                ok: false,
                reason: "usage",
                error:
                  "Export --out requires a file path (got empty). Example: --out ./session.md",
              }),
            );
          } else {
            log.error(
              "Export --out requires a file path (got empty). Example: --out ./session.md",
            );
          }
          process.exit(1);
        }
        if (outRaw) {
          const p = path.resolve(outRaw);
          // Refuse directory targets early — writeFileSync EISDIR is opaque.
          try {
            if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
              const hint = path.join(
                p,
                `session-${s.meta.id.slice(0, 8)}.${fmt === "json" ? "json" : "md"}`,
              );
              if (globalOpts.json) {
                console.log(
                  JSON.stringify({
                    ok: false,
                    reason: "is_directory",
                    path: p,
                    error: `Export --out is a directory. Pass a file path (e.g. ${hint}).`,
                    hint,
                  }),
                );
              } else {
                log.error(
                  `Export --out is a directory: ${p}\n  Pass a file path, e.g. ${hint}`,
                );
              }
              process.exit(1);
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              const message = (err as Error).message || String(err);
              if (globalOpts.json) {
                console.log(
                  JSON.stringify({
                    ok: false,
                    reason: "write_failed",
                    path: p,
                    error: message,
                  }),
                );
              } else {
                log.error(message);
              }
              process.exit(1);
            }
          }
          try {
            // Exports may contain secrets from agent transcripts — mode 0600.
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, body, { encoding: "utf8", mode: 0o600 });
            try {
              fs.chmodSync(p, 0o600);
            } catch {
              /* windows / some FS ignore mode */
            }
          } catch (err) {
            const message = (err as Error).message || String(err);
            if (globalOpts.json) {
              console.log(
                JSON.stringify({
                  ok: false,
                  reason: "write_failed",
                  path: p,
                  error: message,
                }),
              );
            } else {
              log.error(`Export write failed: ${message}`);
            }
            process.exit(1);
          }
          if (globalOpts.json) {
            console.log(
              JSON.stringify({
                ok: true,
                path: p,
                format: fmt,
                foreignLock,
              }),
            );
          } else log.success(`Exported ${fmt} → ${p}`);
        } else {
          // Without --out, emit the artifact on stdout (md/json body).
          // Structured status requires --out (see --json + --out above).
          process.stdout.write(body.endsWith("\n") ? body : body + "\n");
        }
        return;
      }
      if (act === "import") {
        const file = id || "";
        if (!file) {
          failUsage("Usage: forge sessions import <export.json>", {
            json: Boolean(globalOpts.json),
          });
        }
        const p = path.resolve(file);
        if (!fs.existsSync(p)) {
          if (globalOpts.json) {
            console.log(
              JSON.stringify({
                ok: false,
                reason: "not_found",
                path: p,
              }),
            );
          } else {
            log.error(`File not found: ${p}`);
          }
          process.exit(1);
        }
        try {
          if (fs.statSync(p).isDirectory()) {
            if (globalOpts.json) {
              console.log(
                JSON.stringify({
                  ok: false,
                  reason: "is_directory",
                  path: p,
                  error:
                    "Import path is a directory. Pass a session export .json file.",
                }),
              );
            } else {
              log.error(
                `Import path is a directory: ${p}\n  Pass a session export .json file.`,
              );
            }
            process.exit(1);
          }
        } catch (err) {
          const message = (err as Error).message || String(err);
          if (globalOpts.json) {
            console.log(
              JSON.stringify({
                ok: false,
                reason: "invalid",
                path: p,
                error: message,
              }),
            );
          } else {
            log.error(message);
          }
          process.exit(1);
        }
        try {
          const raw = fs.readFileSync(p, "utf8");
          // Only honor --cwd for import when explicitly passed (not parent default)
          const importCwd =
            cwdExplicit && globalOpts.cwd
              ? path.resolve(String(globalOpts.cwd))
              : undefined;
          const s = importSessionJson(raw, {
            cwd: importCwd,
          });
          if (globalOpts.json) {
            console.log(
              JSON.stringify({
                ok: true,
                id: s.meta.id,
                title: s.meta.title,
                messageCount: s.messages.length,
              }),
            );
          } else {
            log.success(
              `Imported → ${s.meta.id} (${s.messages.length} msgs, ${s.todos.length} todos)`,
            );
            log.dim(
              `Resume with: forge --session ${s.meta.id.slice(0, 8)}  ·  or same-cwd: forge run "…" --continue`,
            );
            try {
              const peek = formatResumeOrientation(s);
              if (peek) log.dim(peek);
            } catch {
              /* */
            }
          }
        } catch (err) {
          const message = (err as Error).message || String(err);
          if (globalOpts.json) {
            console.log(
              JSON.stringify({
                ok: false,
                reason: "invalid",
                path: p,
                error: message,
              }),
            );
          } else {
            log.error(message);
          }
          process.exit(1);
        }
        return;
      }
      if (act === "pin" || act === "unpin") {
        const target = id || "";
        if (!target) {
          failUsage(`Usage: forge sessions ${act} <id|title>`, {
            json: Boolean(globalOpts.json),
          });
        }
        const s = loadSession(target);
        if (!s) {
          failSessionLookup(target, { json: Boolean(globalOpts.json) });
        }
        const foreignLock = sessionHasForeignLiveLock(s.meta.id);
        if (foreignLock && !globalOpts.json) {
          const lock = readSessionLock(s.meta.id);
          log.warn(
            `Session has a foreign live lock` +
              (lock ? ` (${formatLockHolder(lock)})` : "") +
              ` — pin change may race the holder`,
          );
        }
        const pinned = setSessionPinned(s, act === "pin");
        if (globalOpts.json) {
          console.log(
            JSON.stringify({
              ok: true,
              id: s.meta.id,
              pinned,
              title: s.meta.title || null,
              foreignLock,
            }),
          );
        } else {
          log.success(
            pinned
              ? `Pinned ${s.meta.id.slice(0, 8)}${s.meta.title ? ` — ${s.meta.title}` : ""} (protected from prune)`
              : `Unpinned ${s.meta.id.slice(0, 8)}${s.meta.title ? ` — ${s.meta.title}` : ""}`,
          );
        }
        return;
      }
      if (act === "title" || act === "rename") {
        // forge sessions title <id|title> <new label words…|clear|none|->
        const target = id || "";
        const labelRaw = (Array.isArray(extra) ? extra : [])
          .map((x) => String(x || "").trim())
          .filter(Boolean)
          .join(" ")
          .trim();
        if (!target || !labelRaw) {
          failUsage(
            "Usage: forge sessions title <id|title> <name|clear|none|->",
            { json: Boolean(globalOpts.json) },
          );
        }
        const s = loadSession(target);
        if (!s) {
          failSessionLookup(target, { json: Boolean(globalOpts.json) });
        }
        const foreignLock = sessionHasForeignLiveLock(s.meta.id);
        if (foreignLock && !globalOpts.json) {
          const lock = readSessionLock(s.meta.id);
          log.warn(
            `Session has a foreign live lock` +
              (lock ? ` (${formatLockHolder(lock)})` : "") +
              ` — title change may race the holder`,
          );
        }
        const clear =
          ["clear", "none", "-", "off", "unset"].includes(labelRaw.toLowerCase());
        const next = setSessionTitle(s, clear ? "" : labelRaw);
        if (globalOpts.json) {
          console.log(
            JSON.stringify({
              ok: true,
              id: s.meta.id,
              title: next || null,
              foreignLock,
            }),
          );
        } else {
          log.success(
            next
              ? `Titled ${s.meta.id.slice(0, 8)} — ${next}`
              : `Cleared title on ${s.meta.id.slice(0, 8)} (auto-title may refill)`,
          );
        }
        return;
      }
      if (act === "fork" || act === "clone") {
        const target = id || "";
        if (!target) {
          failUsage("Usage: forge sessions fork <id>", {
            json: Boolean(globalOpts.json),
          });
        }
        const s = loadSession(target);
        if (!s) {
          failSessionLookup(target, { json: Boolean(globalOpts.json) });
        }
        const sourceForeignLock = sessionHasForeignLiveLock(s.meta.id);
        if (sourceForeignLock && !globalOpts.json) {
          const lock = readSessionLock(s.meta.id);
          log.warn(
            `Source session has a foreign live lock` +
              (lock ? ` (${formatLockHolder(lock)})` : "") +
              ` — fork snapshot may be mid-write`,
          );
        }
        const forked = forkSession(s);
        if (globalOpts.json) {
          console.log(
            JSON.stringify({
              ok: true,
              sourceId: s.meta.id,
              id: forked.meta.id,
              title: forked.meta.title,
              messageCount: forked.messages.length,
              sourceForeignLock,
            }),
          );
        } else {
          log.success(
            `Forked ${s.meta.id.slice(0, 8)} → ${forked.meta.id} (${forked.messages.length} msgs)`,
          );
          log.dim(`Resume with: forge --session ${forked.meta.id.slice(0, 8)}`);
          try {
            const peek = formatResumeOrientation(forked);
            if (peek) log.dim(`${peek}\n(/last 3 · /retry · forge run --continue)`);
          } catch {
            /* */
          }
        }
        return;
      }
      if (act === "prune") {
        // maxAgeDays: 0 = no age filter; unset/invalid → undefined (keep-only prune)
        let maxAgeDays: number | undefined;
        if (
          globalOpts.maxAgeDays != null &&
          String(globalOpts.maxAgeDays).trim() !== ""
        ) {
          const n = Number(String(globalOpts.maxAgeDays).trim());
          if (Number.isFinite(n) && n >= 0) maxAgeDays = Math.floor(n);
        }
        const result = pruneSessions({
          // 0 is valid (keep none); Number(x)||50 wrongly treated 0 as missing
          keep: parseKeepCount(globalOpts.keep, 50),
          maxAgeDays,
        });
        if (globalOpts.json) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                deleted: result.deleted,
                kept: result.kept,
                scanned: result.scanned,
                skippedLocked: result.skippedLocked,
                skippedPinned: result.skippedPinned,
              },
              null,
              2,
            ),
          );
        } else {
          log.success(
            `Pruned ${result.deleted.length} session(s); kept ${result.kept} (scanned ${result.scanned}` +
              (result.skippedLocked
                ? `; skipped ${result.skippedLocked} locked`
                : "") +
              (result.skippedPinned
                ? `; skipped ${result.skippedPinned} pinned`
                : "") +
              `)`,
          );
          if (result.deleted.length && result.deleted.length <= 20) {
            for (const d of result.deleted) console.log(`  - ${d}`);
          }
        }
        return;
      }
      // list (default); allow `forge sessions` and `forge sessions list`
      // Unknown first arg (e.g. `forge sessions incident`) is a title/id query,
      // unless -q/--query already provided.
      const knownSessionActions = new Set([
        "list",
        "ls",
        "show",
        "info",
        "get",
        "path",
        "dir",
        "location",
        "export",
        "import",
        "fork",
        "clone",
        "pin",
        "unpin",
        "title",
        "rename",
        "delete",
        "rm",
        "remove",
        "prune",
      ]);
      // 0 = unlimited (not coerced to 30 via Number(x)||default)
      const limit = parseKeepCount(globalOpts.limit, 30);
      // Only filter when --cwd was explicitly passed (parent default cwd is ignored).
      // listSessions applies cwd/query before limit so multi-project lists stay complete.
      const cwdFilter =
        cwdExplicit && globalOpts.cwd
          ? path.resolve(String(globalOpts.cwd))
          : null;
      let queryFilter =
        typeof globalOpts.query === "string" && globalOpts.query.trim()
          ? globalOpts.query.trim()
          : null;
      if (
        !queryFilter &&
        action &&
        !knownSessionActions.has(act) &&
        !id
      ) {
        queryFilter = String(action).trim();
      }
      const pinnedOnly = Boolean(globalOpts.pinned);
      const list = listSessions({
        limit,
        ...(cwdFilter ? { cwd: cwdFilter } : {}),
        ...(queryFilter ? { query: queryFilter } : {}),
        ...(pinnedOnly ? { pinned: true } : {}),
      });
      if (globalOpts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              cwd: cwdFilter,
              query: queryFilter,
              limit,
              count: list.length,
              sessions: list.map((s) => {
                const lock = readSessionLock(s.id);
                const foreignLock = sessionHasForeignLiveLock(s.id);
                return {
                  ...s,
                  foreignLock,
                  lock: lock
                    ? {
                        pid: lock.pid,
                        hostname: lock.hostname,
                        acquiredAt: lock.acquiredAt,
                        holder: formatLockHolder(lock),
                      }
                    : null,
                };
              }),
            },
            null,
            2,
          ),
        );
        return;
      }
      if (!list.length) {
        const bits: string[] = [];
        if (cwdFilter) bits.push(`cwd ${cwdFilter}`);
        if (queryFilter) bits.push(`query ${JSON.stringify(queryFilter)}`);
        console.log(
          bits.length ? `No sessions for ${bits.join(" · ")}.` : "No sessions.",
        );
        return;
      }
      // When listing across workspaces, show project basename so multi-project
      // experts can tell sessions apart without --cwd.
      const showCwdCol = !cwdFilter;
      for (const s of list) {
        const lock = readSessionLock(s.id);
        // Only surface foreign live locks in the list — own-pid locks are noise
        // while the REPL/`forge run` that holds them is the current process.
        let lockNote = "";
        if (lock && sessionHasForeignLiveLock(s.id)) {
          lockNote = `  LOCK ${formatLockHolder(lock)}`;
        }
        let cwdNote = "";
        if (showCwdCol && s.cwd) {
          try {
            cwdNote = `  ${path.basename(path.resolve(s.cwd))}`;
          } catch {
            cwdNote = `  ${path.basename(s.cwd)}`;
          }
        }
        const prev = (s.lastUserPreview || "").slice(0, 40);
        const prevNote = prev
          ? `  “${prev}${(s.lastUserPreview || "").length > 40 ? "…" : ""}”`
          : "";
        const age = formatRelativeTime(s.updatedAt).padStart(8);
        console.log(
          `${s.id}  ${age}  ${s.provider}/${s.model}  turns=${s.turnCount}  edits=${s.editCount}${s.ultrawork ? "  ULW" : ""}${s.pinned ? "  PIN" : ""}${s.title ? `  ${s.title.slice(0, 40)}` : ""}${prevNote}${cwdNote}${lockNote}`,
        );
      }
      const filterNotes: string[] = [];
      if (cwdFilter) filterNotes.push(`cwd=${cwdFilter}`);
      if (queryFilter) filterNotes.push(`q=${JSON.stringify(queryFilter)}`);
      if (pinnedOnly) filterNotes.push("pinned");
      console.log(
        chalk.dim(
          `\n  forge sessions show|export|import|fork|title|delete <id> [--force]  ·  prune --keep 50` +
            (filterNotes.length
              ? `  ·  filtered ${filterNotes.join(" ")}`
              : "  ·  list --cwd <path> · list -q <text>"),
        ),
      );
    },
    );

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
          `# AGENTS.md

Project instructions for Forge (and other coding agents).

## Build

- Install: \`npm install\`
- Build / typecheck / test: describe the real commands for this repo
- CI entrypoint if any

## Conventions

- Language, module system, style, architecture boundaries
- Non-obvious constraints (auth, migrations, generated code)

## Safety / production notes for agents

- Prefer small focused diffs; run the cheapest relevant check after edits
- Do not weaken fail-closed sandbox or commit secrets
- Long autonomous work: use ULW/\`/goal\` only when the user wants relentless execution
`,
          "utf8",
        );
        log.success(`Wrote ${agents}`);
      }
      log.info("Done. Next: forge login && forge doctor && forge");
      log.dim("Docs: docs/PRODUCTION.md · docs/RELIABILITY.md · eval \"$(forge completion bash)\"");
    });

  program
    .command("models")
    .description("List known models for configured providers")
    .option("--json", "Machine-readable JSON")
    .action((opts, command) => {
      const config = loadConfig();
      if (flagJson(opts, command)) {
        const rows = Object.entries(config.providers).map(([id, p]) => ({
          provider: id,
          defaultModel: p.defaultModel || null,
          supportsOAuth: Boolean(p.supportsOAuth),
          models: p.models?.length ? p.models : p.defaultModel ? [p.defaultModel] : [],
          baseUrl: p.baseUrl || null,
        }));
        console.log(JSON.stringify({ ok: true, providers: rows }, null, 2));
        return;
      }
      for (const [id, p] of Object.entries(config.providers)) {
        const models = p.models?.length ? p.models.join(", ") : p.defaultModel || "(any)";
        console.log(
          `${id.padEnd(12)} default=${(p.defaultModel || "").padEnd(28)} oauth=${p.supportsOAuth ? "yes" : "no "}  models: ${models}`,
        );
      }
    });

  program
    .command("completion")
    .description("Print shell completion script (bash|zsh|fish)")
    .argument("[shell]", "bash | zsh | fish", "bash")
    .action((shell: string) => {
      console.log(shellCompletionScript(String(shell || "bash").toLowerCase()));
    });

  program
    .command("prune-tool-output")
    .description("Prune ~/.forge/tool-output full dumps (disk hygiene)")
    .option("--keep <n>", "Keep newest N files", "80")
    .option("--max-age-days <n>", "Also drop files older than N days", "14")
    .option("--json", "Machine-readable JSON")
    .action((opts, command) => {
      const before = toolOutputStats();
      const result = pruneToolOutputsSync({
        // 0 is valid (delete all eligible dumps)
        keep: parseKeepCount(opts.keep, 80),
        // 0 = no age filter; default 14 when unset/invalid
        maxAgeDays: parseKeepCount(opts.maxAgeDays, 14),
      });
      if (flagJson(opts, command)) {
        console.log(
          JSON.stringify(
            { ok: true, before, ...result, after: toolOutputStats() },
            null,
            2,
          ),
        );
        return;
      }
      log.success(
        `Pruned ${result.deleted} tool-output file(s); kept ${result.kept}` +
          (result.freedBytes
            ? ` · freed ${(result.freedBytes / 1024).toFixed(0)} KB`
            : ""),
      );
      if (before.files === 0) log.dim("tool-output was already empty");
    });

  program
    .command("prune-metrics")
    .description("Prune ~/.forge/metrics.jsonl (keep newest N events)")
    .option("--keep <n>", "Keep newest N events", "500")
    .option("--json", "Machine-readable JSON")
    .action((opts, command) => {
      const before = metricsStats();
      // 0 is valid at CLI; pruneMetrics floors to ≥1 internally
      const result = pruneMetrics({ keep: parseKeepCount(opts.keep, 500) });
      if (flagJson(opts, command)) {
        console.log(JSON.stringify({ ok: true, before, ...result }, null, 2));
        return;
      }
      log.success(
        `Pruned metrics: removed ${result.deleted}, kept ${result.kept} (was ${result.beforeEvents})`,
      );
      if (before.events === 0) log.dim("metrics.jsonl was already empty");
    });

  program
    .command("logs")
    .description(
      "Tail sandbox/safety events (~/.forge/logs/sandbox.jsonl) — no secrets",
    )
    .option("-n, --lines <n>", "Number of recent events", "30")
    .option("--path", "Print log file path only")
    .option("--json", "Machine-readable JSON { ok, path, count, limit, events }")
    .action(async (opts, command) => {
      if (opts.path) {
        console.log(sandboxLogPath());
        return;
      }
      const n = Math.min(200, Math.max(1, Number(opts.lines) || 30));
      if (flagJson(opts, command)) {
        const { readSandboxLogTail } = await import("./agent/sandbox-log.js");
        const events = readSandboxLogTail(n);
        console.log(
          JSON.stringify(
            {
              ok: true,
              path: sandboxLogPath(),
              count: events.length,
              limit: n,
              events,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(formatSandboxLogTail(n));
    });

  program
    .command("config")
    .description(
      "Print effective config snapshot (no secrets) — same as REPL /config",
    )
    .option("--json", "Machine-readable JSON")
    .option("-p, --provider <provider>", "Provider override")
    .option("-m, --model <model>", "Model override")
    .option("--cwd <path>", "Workspace", process.cwd())
    .action((opts, command) => {
      const wantJson = flagJson(opts, command);
      const config = buildConfig({ ...opts, json: wantJson });
      console.log(
        formatEffectiveConfig(config, {
          json: wantJson,
        }),
      );
    });

  program
    .command("stats")
    .description(
      "Usage dashboard from metrics.jsonl + session inventory (counter-only, no prompts)",
    )
    .option("--days <n>", "Only metrics from the last N days (default: all)")
    .option("--json", "Machine-readable JSON")
    .action((opts, command) => {
      const daysRaw = opts.days != null ? Number(opts.days) : 0;
      const days =
        Number.isFinite(daysRaw) && daysRaw > 0 ? Math.floor(daysRaw) : 0;
      const stats = collectUsageStats({ days });
      if (flagJson(opts, command)) {
        console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
        return;
      }
      console.log(formatUsageStats(stats));
      if (stats.runs === 0) {
        log.dim(
          "No run metrics yet — complete a forge run or REPL turn to populate ~/.forge/metrics.jsonl",
        );
      }
    });

  program
    .command("tips")
    .description("Expert cheat sheet (live controls, sessions, CI)")
    .action(() => {
      console.log(formatExpertTips());
    });

  program
    .command("news")
    .alias("changelog")
    .description("What's new — highlights from packaged CHANGELOG.md")
    .argument("[count]", "How many recent releases to show (default 1)", "1")
    .option("--json", "Machine-readable JSON releases")
    .action(
      (
        countArg: string,
        opts: { json?: boolean },
        command?: { optsWithGlobals?: () => Record<string, unknown> },
      ) => {
        const n = Math.max(
          1,
          Math.min(10, parseInt(String(countArg || "1"), 10) || 1),
        );
        if (flagJson(opts as Record<string, unknown>, command)) {
          const releases = loadChangelogReleases().slice(0, n);
          console.log(
            JSON.stringify(
              {
                ok: true,
                version: getForgeVersion(),
                count: releases.length,
                releases,
              },
              null,
              2,
            ),
          );
          return;
        }
        console.log(formatWhatsNew({ count: n }));
      },
    );

  program
    .command("doctor")
    .description("Check auth, Node version, config, and harness settings")
    .option("-p, --provider <provider>", "Provider override")
    .option("--cwd <path>", "Workspace", process.cwd())
    .option("--json", "Machine-readable summary on stdout")
    .action((opts, command) => {
      const wantJson = flagJson(opts, command);
      // Parent also defines -p/--provider/--cwd; merge so flags bind either place.
      // Prefer CLI-sourced values over doctor defaults / parent defaults.
      const globals = (command?.optsWithGlobals?.() || {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...globals, ...opts, json: wantJson };
      for (const key of ["provider", "cwd"] as const) {
        const localSrc = command?.getOptionValueSource?.(key);
        const parentSrc = command?.parent?.getOptionValueSource?.(key);
        if (parentSrc === "cli" && localSrc !== "cli" && key in globals) {
          merged[key] = globals[key];
        } else if (localSrc === "cli" && key in opts) {
          merged[key] = opts[key];
        }
      }
      const config = buildConfig(merged);
      if (wantJson) {
        const check = runDoctorCheck(config);
        const auth = resolveAuth(config);
        let sessionCount = 0;
        let sessionsLocked = 0;
        let sessionsPinned = 0;
        try {
          const sessions = listSessions(10_000);
          sessionCount = sessions.length;
          for (const s of sessions) {
            if (sessionHasForeignLiveLock(s.id)) sessionsLocked += 1;
            if (s.pinned) sessionsPinned += 1;
          }
        } catch {
          /* */
        }
        let toolOutput = { files: 0, bytes: 0 };
        try {
          const st = toolOutputStats();
          toolOutput = { files: st.files, bytes: st.bytes };
        } catch {
          /* */
        }
        let sandboxLog = { bytes: 0, backupBytes: 0 };
        try {
          const sl = sandboxLogStats();
          sandboxLog = { bytes: sl.bytes, backupBytes: sl.backupBytes };
        } catch {
          /* */
        }
        let metrics = { events: 0, bytes: 0 };
        try {
          const m = metricsStats();
          metrics = { events: m.events, bytes: m.bytes };
        } catch {
          /* */
        }
        let undoJournal = { sessions: 0, bytes: 0, entries: 0 };
        try {
          undoJournal = mutationsJournalStats();
        } catch {
          /* */
        }
        let backgroundTasks = { running: 0, total: 0 };
        try {
          const tasks = listTasks();
          backgroundTasks = {
            running: tasks.filter((t) => t.status === "running").length,
            total: tasks.length,
          };
        } catch {
          /* */
        }
        let savedAllows = 0;
        try {
          savedAllows = loadSavedAllows(
            config.workspace || process.cwd(),
          ).length;
        } catch {
          /* */
        }
        const home = forgeHome();
        const secureFiles = {
          auth: inspectSecureFile(path.join(home, "auth.json")),
          permissions: inspectSecureFile(path.join(home, "permissions.json")),
          preferences: inspectSecureFile(path.join(home, "preferences.json")),
        };
        // CI contract: structured check.ok (issues array) — never chalk/report regex.
        // secureFiles.modeOk is also enforced so mode drift cannot hide behind report text.
        const secureFilesOk = Object.values(secureFiles).every(
          (f) => f.modeOk !== false,
        );
        const ok =
          check.ok &&
          secureFilesOk &&
          check.blockingStop &&
          check.authenticated;
        const maxRunMsRaw = process.env.FORGE_MAX_RUN_MS?.trim();
        const maxRunMs =
          maxRunMsRaw && /^\d+$/.test(maxRunMsRaw) && Number(maxRunMsRaw) >= 5_000
            ? Number(maxRunMsRaw)
            : null;
        const doomLoopThreshold = envPositiveInt("FORGE_DOOM_LOOP_THRESHOLD", 3);
        const errorStreakThreshold = envPositiveInt(
          "FORGE_ERROR_STREAK_THRESHOLD",
          5,
        );
        const ulwMaxContinues = envPositiveInt("FORGE_ULW_MAX_CONTINUES", 200);
        const permAskTimeoutMs = permissionAskTimeoutMs();
        console.log(
          JSON.stringify(
            {
              ok,
              version: VERSION,
              provider: config.provider,
              model: config.model,
              auth: describeAuth(auth),
              authenticated: check.authenticated,
              blockingStop: check.blockingStop,
              permissionMode: config.permissionMode,
              sandbox: config.sandbox,
              maxTurns: config.maxTurns,
              maxTurnsUnlimited: !(
                typeof config.maxTurns === "number" && config.maxTurns > 0
              ),
              sessionCount,
              sessionsLocked,
              sessionsPinned,
              toolOutput,
              sandboxLog,
              metrics,
              undoJournal,
              backgroundTasks,
              savedAllows,
              secureFiles,
              issues: check.issues,
              providerTimeoutMs: providerTimeoutMs(),
              bashTimeoutMs: defaultBashTimeoutMs(),
              bashBackgroundTimeoutMs: defaultBashBackgroundTimeoutMs(),
              maxRunMs,
              permissionAskTimeoutMs: permAskTimeoutMs || null,
              doomLoopThreshold,
              errorStreakThreshold,
              ulwMaxContinues,
              bellOnTurnEnd: isBellEnabled(),
              autoResume:
                process.env.FORGE_NO_AUTO_RESUME !== "1" &&
                process.env.FORGE_NO_AUTO_RESUME !== "true",
              node: process.version,
              report: check.report,
            },
            null,
            2,
          ),
        );
        if (!ok) process.exitCode = 1;
        return;
      }
      // Plain doctor: same health signal as --json (exit 1 on issues) so
      // scripts that forget --json still fail closed in CI.
      const check = runDoctorCheck(config);
      console.log(check.report);
      if (!check.ok) process.exitCode = 1;
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
    .action(async (opts, command) => {
      // Parent also defines --session/--cwd; merge so flags bind either place.
      const stOpts = {
        ...(command?.optsWithGlobals?.() || {}),
        ...opts,
      } as Record<string, unknown>;
      // --session present (including "") must not silently list all sessions
      const sessionPassed = stOpts.session != null;
      const sessionArg =
        sessionPassed && String(stOpts.session).trim()
          ? String(stOpts.session).trim()
          : undefined;
      const cwdArg =
        typeof stOpts.cwd === "string" && stOpts.cwd.trim()
          ? String(stOpts.cwd).trim()
          : undefined;
      const collectOpts = {
        sessionId: sessionArg,
        cwd: cwdArg,
        all: Boolean(stOpts.all),
        fetchPlan: stOpts.plan !== false,
        config: loadConfig({}, cwdArg || process.cwd()),
      };

      // Fail fast on empty --session or miss before watch loop.
      if (sessionPassed && !sessionArg) {
        const msg =
          'Empty --session. Pass an id/prefix/title, or omit --session.';
        if (stOpts.json || flagJson(opts, command)) {
          console.log(
            JSON.stringify(
              {
                ok: false,
                reason: "session_not_found",
                session: String(stOpts.session),
                error: msg,
                count: 0,
                sessions: [],
                generatedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
          );
        } else {
          log.error(msg);
        }
        process.exit(1);
      }
      if (sessionArg) {
        const probe = await collectSnapshots({
          ...collectOpts,
          fetchPlan: false,
        });
        if (probe.length === 0) {
          if (stOpts.json || flagJson(opts, command)) {
            console.log(
              JSON.stringify(
                {
                  ok: false,
                  reason: "session_not_found",
                  session: sessionArg,
                  error: formatSessionLookupMiss(sessionArg),
                  count: 0,
                  sessions: [],
                  generatedAt: new Date().toISOString(),
                },
                null,
                2,
              ),
            );
          } else {
            log.error(formatSessionLookupMiss(sessionArg));
          }
          process.exit(1);
        }
      }

      if (stOpts.watch) {
        const ac = new AbortController();
        process.on("SIGINT", () => ac.abort());
        await runStatusWatch({
          ...collectOpts,
          intervalMs: Number(stOpts.interval) || 1000,
          json: Boolean(stOpts.json),
          plain: Boolean(stOpts.plain),
          tmux: Boolean(stOpts.tmux),
          signal: ac.signal,
        });
        return;
      }

      const snaps = await collectSnapshots(collectOpts);
      if (stOpts.json) {
        console.log(snapshotsToJson(snaps));
        return;
      }
      if (stOpts.tmux) {
        console.log(renderTmux(snaps[0]));
        return;
      }
      console.log(
        renderHud(snaps, {
          plain: Boolean(stOpts.plain),
          width: process.stdout.columns,
        }),
      );
    });

  await program.parseAsync(process.argv);
}

/**
 * Session id/title miss for CLI commands. With --json, emit structured stdout
 * so CI need not scrape stderr (parity with forge run --json early failures).
 */
function failSessionLookup(
  target: string,
  opts?: { json?: boolean },
): never {
  const error = formatSessionLookupMiss(target);
  if (opts?.json) {
    console.log(
      JSON.stringify({
        ok: false,
        reason: "session_not_found",
        session: target,
        error,
      }),
    );
  } else {
    log.error(error);
  }
  process.exit(1);
}

/**
 * Usage / missing-arg failures for sessions subcommands.
 * With --json: `{ ok:false, reason:usage, error }` on stdout.
 */
function failUsage(message: string, opts?: { json?: boolean }): never {
  if (opts?.json) {
    console.log(
      JSON.stringify({
        ok: false,
        reason: "usage",
        error: message,
      }),
    );
  } else {
    log.error(message);
  }
  process.exit(1);
}

const PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
]);
const SANDBOX_PROFILES = new Set<SandboxProfile>([
  "off",
  "workspace",
  "read-only",
  "strict",
]);
const SANDBOX_NETWORKS = new Set<SandboxNetwork>(["unrestricted", "blocked"]);
const SANDBOX_MISSING = new Set<SandboxMissingBackend>([
  "fail-closed",
  "fallback",
]);
/** Known provider ids + common aliases (grok → xai). */
const PROVIDER_IDS = new Set<string>([
  "xai",
  "grok",
  "anthropic",
  "openai",
  "openrouter",
  "google",
  "custom",
]);

/** Structured CLI flag validation failure (parity with invalid_effort). */
function failInvalidFlag(
  reason: string,
  message: string,
  extra: Record<string, unknown>,
  opts?: { json?: boolean },
): never {
  if (opts?.json) {
    console.log(
      JSON.stringify({
        ok: false,
        reason,
        error: message,
        ...extra,
      }),
    );
  } else {
    log.error(message);
  }
  process.exit(1);
}

/**
 * Parent and subcommands both define `--json`. Commander may attach the flag
 * to the parent only (`forge auth --json` → parent.json=true, local.json=false).
 * Prefer local, then optsWithGlobals.
 */
function flagJson(
  opts: Record<string, unknown> | undefined,
  command?: {
    optsWithGlobals?: () => Record<string, unknown>;
  },
): boolean {
  if (opts && Boolean(opts.json)) return true;
  const g = command?.optsWithGlobals?.() || {};
  return Boolean(g.json);
}

function buildConfig(opts: Record<string, unknown>): ForgeConfig {
  const cwd = path.resolve(String(opts.cwd || process.cwd()));
  const overrides: Partial<ForgeConfig> = { workspace: cwd };
  const wantJson = Boolean(opts.json);
  // != null so empty string "" fails closed (Commander sets "" for --flag '')
  if (opts.model != null) {
    const model = String(opts.model).trim();
    if (!model) {
      failInvalidFlag(
        "invalid_model",
        `Invalid --model "${opts.model}". Pass a non-empty model id.`,
        { model: String(opts.model) },
        { json: wantJson },
      );
    }
    overrides.model = model;
  }
  if (opts.provider != null) {
    const raw = String(opts.provider).trim().toLowerCase();
    if (!raw || !PROVIDER_IDS.has(raw)) {
      failInvalidFlag(
        "invalid_provider",
        `Invalid --provider "${opts.provider}". Use xai|anthropic|openai|openrouter|google|custom.`,
        { provider: String(opts.provider) },
        { json: wantJson },
      );
    }
    // grok is a friendly alias for xai (auth resolve already treats them alike)
    overrides.provider = (raw === "grok" ? "xai" : raw) as ProviderId;
  }
  if (opts.baseUrl != null) {
    const base = String(opts.baseUrl).trim();
    if (!base) {
      failInvalidFlag(
        "invalid_base_url",
        `Invalid --base-url "${opts.baseUrl}". Pass a non-empty http(s) URL.`,
        { baseUrl: String(opts.baseUrl) },
        { json: wantJson },
      );
    }
    overrides.baseUrl = base;
  }
  // custom without an explicit base URL silently hits api.openai.com — fail fast.
  {
    const prov = String(overrides.provider || "").toLowerCase();
    const base =
      (opts.baseUrl != null && String(opts.baseUrl).trim()) ||
      process.env.FORGE_BASE_URL?.trim() ||
      "";
    if (prov === "custom" && !base) {
      failInvalidFlag(
        "missing_base_url",
        `Provider "custom" requires --base-url (or FORGE_BASE_URL).`,
        { provider: "custom" },
        { json: wantJson },
      );
    }
  }
  {
    // Flag present (including "") must validate — empty used to skip and hit the API.
    const effortRaw = opts.effort ?? opts.reasoningEffort;
    if (effortRaw != null) {
      const raw = String(effortRaw).trim();
      const e = raw ? parseReasoningEffort(raw) : null;
      if (!e) {
        failInvalidFlag(
          "invalid_effort",
          `Invalid --effort "${effortRaw}". Use low, medium, or high.`,
          { effort: String(effortRaw) },
          { json: wantJson },
        );
      }
      overrides.reasoningEffort = e;
    }
  }
  // != null so empty string "" fails closed (Commander sets "" for --flag '')
  if (opts.permissionMode != null) {
    const mode = String(opts.permissionMode).trim();
    if (!PERMISSION_MODES.has(mode as PermissionMode)) {
      failInvalidFlag(
        "invalid_permission_mode",
        `Invalid --permission-mode "${opts.permissionMode}". Use default|acceptEdits|plan|bypassPermissions|dontAsk.`,
        { permissionMode: String(opts.permissionMode) },
        { json: wantJson },
      );
    }
    overrides.permissionMode = mode as PermissionMode;
  }
  if (opts.sandbox != null) {
    const profile = String(opts.sandbox).trim();
    if (!SANDBOX_PROFILES.has(profile as SandboxProfile)) {
      failInvalidFlag(
        "invalid_sandbox",
        `Invalid --sandbox "${opts.sandbox}". Use off|workspace|read-only|strict.`,
        { sandbox: String(opts.sandbox) },
        { json: wantJson },
      );
    }
    overrides.sandbox = profile as SandboxProfile;
  }
  if (opts.sandboxNetwork != null) {
    const net = String(opts.sandboxNetwork).trim();
    if (!SANDBOX_NETWORKS.has(net as SandboxNetwork)) {
      failInvalidFlag(
        "invalid_sandbox_network",
        `Invalid --sandbox-network "${opts.sandboxNetwork}". Use unrestricted|blocked.`,
        { sandboxNetwork: String(opts.sandboxNetwork) },
        { json: wantJson },
      );
    }
    overrides.sandboxNetwork = net as SandboxNetwork;
  }
  if (opts.sandboxMissing != null) {
    const miss = String(opts.sandboxMissing).trim();
    if (!SANDBOX_MISSING.has(miss as SandboxMissingBackend)) {
      failInvalidFlag(
        "invalid_sandbox_missing",
        `Invalid --sandbox-missing "${opts.sandboxMissing}". Use fail-closed|fallback.`,
        { sandboxMissing: String(opts.sandboxMissing) },
        { json: wantJson },
      );
    }
    overrides.sandboxMissingBackend = miss as SandboxMissingBackend;
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
  opts: {
    session?: string;
    new?: boolean;
    cwd?: string;
    title?: string;
    /** When true and no --session/--new, resume newest same-cwd session. */
    autoResume?: boolean;
    /**
     * Explicit --continue (bare forge / parent flag): resume newest same-cwd
     * even when headless or FORGE_NO_AUTO_RESUME — parity with forge run --continue.
     * Still respects --new and --session.
     */
    continue?: boolean;
    /** Structured stdout on session miss (bare forge --json). */
    json?: boolean;
  },
) {
  if (opts.session != null) {
    const sessionFlag = String(opts.session).trim();
    if (!sessionFlag) {
      const msg =
        'Empty --session. Pass an id/prefix/title, or omit --session.';
      if (opts.json) {
        console.log(
          JSON.stringify({
            ok: false,
            reason: "session_not_found",
            session: String(opts.session),
            error: msg,
          }),
        );
      } else {
        log.error(msg);
      }
      process.exit(1);
    }
    const s = loadSession(sessionFlag);
    if (!s) {
      const miss = formatSessionLookupMiss(sessionFlag);
      if (opts.json) {
        console.log(
          JSON.stringify({
            ok: false,
            reason: "session_not_found",
            session: sessionFlag,
            error: miss,
          }),
        );
      } else {
        log.error(miss);
      }
      process.exit(1);
    }
    if (typeof opts.title === "string" && opts.title.trim()) {
      setSessionTitle(s, opts.title);
    }
    // Explicit --session (interactive): same orientation peek as auto-resume.
    // Quiet under --json so CI stdout stays a single JSON object.
    if ((opts.autoResume || opts.continue) && !opts.json) {
      try {
        const title = s.meta.title || "untitled";
        log.info(
          `Resumed ${s.meta.id.slice(0, 8)} — ${title} (${s.messages.length} msgs)`,
        );
        const peek = formatResumeOrientation(s);
        if (peek) {
          log.dim(`${peek}\n(/last 3 for more · /retry to re-run)`);
        }
      } catch {
        /* never block resume on peek */
      }
    }
    return s;
  }
  const cwd = path.resolve(String(opts.cwd || config.workspace || process.cwd()));
  // Explicit --continue overrides FORGE_NO_AUTO_RESUME (same as forge run --continue).
  const noAuto =
    opts.new ||
    (!opts.continue &&
      (process.env.FORGE_NO_AUTO_RESUME === "1" ||
        process.env.FORGE_NO_AUTO_RESUME === "true"));
  // Explicit --title on a fresh start should not silently attach to auto-resume.
  // With --continue, --title relabels the resumed session (CI tagging).
  const wantTitle =
    typeof opts.title === "string" && opts.title.trim().length > 0;
  if ((opts.autoResume || opts.continue) && !noAuto && (!wantTitle || opts.continue)) {
    try {
      const hit = findRecentSessionForCwd(cwd);
      if (hit?.meta) {
        const s = loadSession(hit.meta.id);
        if (s) {
          if (opts.continue && wantTitle) {
            setSessionTitle(s, String(opts.title));
          }
          const title = s.meta.title || "untitled";
          const skipNote =
            hit.skippedLocked > 0
              ? ` (skipped ${hit.skippedLocked} locked session${hit.skippedLocked === 1 ? "" : "s"})`
              : "";
          const flags: string[] = [];
          try {
            const ulw = loadUlwCycle(s.meta.id);
            if (ulw?.enabled) flags.push(formatUlwCounts(ulw));
          } catch {
            /* */
          }
          try {
            const g = loadGoal(s.meta.id);
            if (g?.objective && g.status === "active") {
              flags.push(g.paused ? "GOAL:paused" : "GOAL");
            }
          } catch {
            /* */
          }
          if (s.meta.ultrawork && !flags.some((f) => f.startsWith("ULW") || f.includes("cycle="))) {
            flags.push("ULW");
          }
          const flagNote = flags.length ? ` · ${flags.join(" · ")}` : "";
          if (!opts.json) {
            log.info(
              `Resumed ${s.meta.id.slice(0, 8)} — ${title} (${s.messages.length} msgs)${flagNote}${skipNote}. Use --new for a fresh session.`,
            );
            // Orient experts immediately after same-cwd auto-resume.
            try {
              const peek = formatResumeOrientation(s);
              if (peek) {
                log.dim(`${peek}\n(/last 3 for more · /retry to re-run)`);
              }
            } catch {
              /* never block resume on peek */
            }
          }
          // Keep provider/model from live config when CLI/prefs differ, but preserve session history
          if (config.model && s.meta.model !== config.model) {
            s.meta.model = config.model;
          }
          if (config.provider && s.meta.provider !== String(config.provider)) {
            s.meta.provider = String(config.provider);
          }
          return s;
        }
      } else if (hit && hit.skippedLocked > 0) {
        if (!opts.json) {
          log.info(
            `Starting fresh session — ${hit.skippedLocked} same-cwd session${hit.skippedLocked === 1 ? "" : "s"} locked by other process(es). Use --session <id> to attach anyway.`,
          );
        }
      } else if (opts.continue && !opts.json) {
        log.dim("No prior same-cwd session to continue — starting fresh.");
      }
    } catch {
      /* fall through to new session */
    }
  }
  return createSession({
    cwd,
    provider: String(config.provider),
    model: config.model,
    ultrawork: false,
    title: wantTitle ? String(opts.title) : undefined,
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
  // Headless always sets FORGE_HEADLESS so permission gate stays fail-closed
  if (!process.env.FORGE_HEADLESS) process.env.FORGE_HEADLESS = "1";
  installBackgroundTaskExitHook();

  // Same session lock as REPL — concurrent forge run --session / REPL must not race.
  // Headless defaults fail-closed on a foreign live lock (CI safety). Override with
  // FORGE_FORCE_SESSION_LOCK=1 when an operator intentionally shares a session id.
  const forceSessionLock =
    process.env.FORGE_FORCE_SESSION_LOCK === "1" ||
    process.env.FORGE_FORCE_SESSION_LOCK === "true";
  const lock = acquireSessionLock(opts.session.meta.id, {
    force: forceSessionLock,
  });
  if (!lock.ok && lock.holder) {
    if (!forceSessionLock) {
      const msg =
        `Session ${opts.session.meta.id.slice(0, 8)} is locked by ${formatLockHolder(lock.holder)}. ` +
        `Refusing concurrent headless write. Wait for the other process, use a different --session, ` +
        `or set FORGE_FORCE_SESSION_LOCK=1 to override.`;
      if (opts.json) {
        console.log(
          JSON.stringify({
            ok: false,
            error: msg,
            reason: "locked",
            sessionId: opts.session.meta.id,
            lock: {
              pid: lock.holder.pid,
              hostname: lock.holder.hostname,
              acquiredAt: lock.holder.acquiredAt,
              holder: formatLockHolder(lock.holder),
            },
          }),
        );
      } else {
        log.error(msg);
      }
      process.exit(1);
    }
    log.warn(
      `Session ${opts.session.meta.id.slice(0, 8)} is locked by ${formatLockHolder(lock.holder)}. ` +
        `FORGE_FORCE_SESSION_LOCK set — continuing; concurrent writes may race.`,
    );
  } else if (lock.stolen && lock.holder) {
    log.dim(
      `Took over stale session lock from ${formatLockHolder(lock.holder)}`,
    );
  }

  const ac = new AbortController();
  let timedOut = false;
  const onSigInt = () => {
    if (!ac.signal.aborted) {
      log.warn("SIGINT — aborting headless run…");
      ac.abort();
    }
  };
  const onSigTerm = () => {
    if (!ac.signal.aborted) ac.abort();
  };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  // Optional wall-clock deadline for CI (FORGE_MAX_RUN_MS, min 5s)
  let maxRunTimer: ReturnType<typeof setTimeout> | undefined;
  const maxRunRaw = process.env.FORGE_MAX_RUN_MS?.trim();
  if (maxRunRaw && /^\d+$/.test(maxRunRaw)) {
    const ms = Number(maxRunRaw);
    if (ms >= 5_000) {
      maxRunTimer = setTimeout(() => {
        if (!ac.signal.aborted) {
          timedOut = true;
          log.warn(`FORGE_MAX_RUN_MS=${ms} exceeded — aborting headless run`);
          ac.abort();
        }
      }, ms);
      maxRunTimer.unref?.();
    }
  }

  const releaseLock = (): void => {
    try {
      releaseSessionLock(opts.session.meta.id);
    } catch {
      /* never fail exit on lock */
    }
  };

  const cleanupBg = (): void => {
    try {
      killAllRunningTasks({ force: true });
    } catch {
      /* never fail exit on bg cleanup */
    }
  };

  await opts.hooks.run("SessionStart", {
    sessionId: opts.session.meta.id,
    cwd: opts.session.meta.cwd,
    workspaceRoot: opts.config.workspace || opts.session.meta.cwd,
  });

  const t0 = Date.now();
  let result;
  try {
    result = await runAgentLoop({
      config: opts.config,
      provider: opts.provider,
      session: opts.session,
      hooks: opts.hooks,
      permissions,
      userMessage: opts.prompt,
      stream: !opts.json,
      signal: ac.signal,
      onToken: opts.json
        ? undefined
        : (t) => {
            process.stdout.write(t);
          },
    });
  } catch (err) {
    await opts.hooks.run("SessionEnd", {
      sessionId: opts.session.meta.id,
      cwd: opts.session.meta.cwd,
      workspaceRoot: opts.config.workspace || opts.session.meta.cwd,
    });
    saveSession(opts.session);
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    if (maxRunTimer) clearTimeout(maxRunTimer);
    cleanupBg();
    releaseLock();
    const message = (err as Error).message || String(err);
    appendSessionMetrics(
      buildRunEndMetrics({
        sessionId: opts.session.meta.id,
        provider: String(opts.config.provider),
        model: opts.config.model,
        cwd: opts.session.meta.cwd,
        turns: 0,
        stopContinues: 0,
        editCount: opts.session.meta.editCount,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: Date.now() - t0,
        aborted: ac.signal.aborted,
        timedOut,
        ok: false,
        headless: true,
        ultrawork: opts.session.meta.ultrawork,
      }),
    );
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            reason: timedOut
              ? "timeout"
              : ac.signal.aborted
                ? "aborted"
                : "error",
            error: message,
            timedOut,
            aborted: ac.signal.aborted,
            sessionId: opts.session.meta.id,
            title: opts.session.meta.title || null,
            editCount: opts.session.meta.editCount,
            durationMs: Date.now() - t0,
          },
          null,
          2,
        ),
      );
      process.exit(timedOut ? 124 : 1);
    }
    throw err;
  } finally {
    if (maxRunTimer) clearTimeout(maxRunTimer);
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }

  try {
    await opts.hooks.run("SessionEnd", {
      sessionId: opts.session.meta.id,
      cwd: opts.session.meta.cwd,
      workspaceRoot: opts.config.workspace || opts.session.meta.cwd,
    });
    saveSession(opts.session);

    if (!opts.json && result.finalText && !result.finalText.endsWith("\n")) {
      process.stdout.write("\n");
    }

    const durationMs = Date.now() - t0;
    const payload = {
      ok: !result.aborted && !timedOut,
      sessionId: opts.session.meta.id,
      title: opts.session.meta.title || null,
      finalText: result.finalText,
      turns: result.turns,
      stopContinues: result.stopContinues,
      releasedOnContinueCap: result.releasedOnContinueCap,
      hitMaxTurns: result.hitMaxTurns,
      finishReason: result.finishReason,
      editCount: opts.session.meta.editCount,
      aborted: result.aborted,
      timedOut,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      durationMs,
      model: opts.config.model,
      provider: opts.config.provider,
    };
    appendSessionMetrics(
      buildRunEndMetrics({
        sessionId: payload.sessionId,
        provider: String(payload.provider),
        model: payload.model,
        cwd: opts.session.meta.cwd,
        turns: payload.turns,
        stopContinues: payload.stopContinues,
        releasedOnContinueCap: payload.releasedOnContinueCap,
        hitMaxTurns: payload.hitMaxTurns,
        editCount: payload.editCount,
        promptTokens: payload.promptTokens,
        completionTokens: payload.completionTokens,
        durationMs,
        aborted: payload.aborted,
        timedOut: payload.timedOut,
        ok: payload.ok,
        headless: true,
        ultrawork: opts.session.meta.ultrawork,
      }),
    );
    return payload;
  } finally {
    cleanupBg();
    releaseLock();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
