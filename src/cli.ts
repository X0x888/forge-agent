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
import { installGroupedHelp } from "./cli/help-groups.js";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import {
  formatRelativeTime,
  estimateCostUsd,
  formatCost,
} from "./util/format.js";
import { parseCostUsd, resolveMaxCostUsd } from "./util/cost-budget.js";
import { familyCostJson } from "./session/subagent-usage.js";
import { productionWarningsForRun } from "./util/production-warnings.js";
import { listActiveProjectMemory } from "./harness/project-memory.js";
import { resolveWorktreeLandMode } from "./agent/worktree.js";
import { isFalsy } from "./util/bool.js";
import { loadConfig } from "./config/load.js";
import {
  resolveSandboxNetwork,
  type ForgeConfig,
  type PermissionMode,
  type ProviderId,
  type SandboxMissingBackend,
  type ReadOutsideWorkspace,
  type SandboxNetwork,
  type SandboxProfile,
} from "./config/types.js";
import { parseReasoningEffort, resolveReasoningEffort } from "./config/reasoning.js";
import { formatFallbackChain, parseFallbackModels } from "./config/model-fallback.js";
import { loadPreferences, savePreferences } from "./config/preferences.js";
import { resolveAuth, resolveAuthFresh, describeAuth } from "./auth/resolve.js";
import { loginInteractive, logout, printAuthStatus, supportsOAuth } from "./auth/login.js";
import {
  listCredentials,
  listAccountSummaries,
  clearCredential,
  upsertApiKey,
  removeAccount,
  setAccountDisabled,
  setAccountPriority,
  setAccountLabel,
  getAutoSwitchSettings,
  setAutoSwitchSettings,
  resolveAccountSelector,
  getActiveAccount,
} from "./auth/store.js";
import {
  assessMultiAccountReadiness,
  clearAccountCooldown,
  formatAccountsTable,
  formatMultiAccountReadiness,
  switchAccount,
} from "./auth/accounts.js";
import { importGrokCredentials } from "./auth/import-grok.js";
import { importLocalCopilotCredentials } from "./auth/copilot.js";
import { importLocalCursorCredentials, isCursorProvider } from "./auth/cursor.js";
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
  formatNumberedPickerRow,
  formatSessionLookupMiss,
  listSessionLookupSuggestions,
  findRecentSessionForCwd,
  setSessionTitle,
  maybeSetTitle,
  MAX_SESSION_TITLE_CHARS,
  setSessionPinned,
  formatResumeOrientation,
  resolveSessionDir,
  resolveSessionJsonPath,
  isLastVerificationStale,
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
import { parseRuleString } from "./agent/rules.js";
import {
  killAllRunningTasks,
  listTasks,
  installBackgroundTaskExitHook,
} from "./agent/tools/background-tasks.js";
import { loadSavedAllows } from "./agent/permission-saved.js";
import { runAgentLoopThroughDrops } from "./agent/loop.js";
import { runRepl } from "./tui/repl.js";
import {
  formatRunStopReason,
  formatTurnChangeSummaryForSession,
  formatUserTurnOpen,
  formatAssistantTurnOpen,
  createThinkingLandmark,
} from "./tui/turn-summary.js";
import { forgeHome, ensureDir, inspectSecureFile } from "./util/fs.js";
import { log, setLogLevel } from "./util/log.js";
import { mergeRunOpts } from "./util/merge-run-opts.js";
import { armGoal, formatGoalStatus, loadGoal } from "./harness/goal.js";
import {
  armUlwCycle,
  loadUlwCycle,
  formatUlwCounts,
  normalizeMaxWaves,
  mandateFromUserText,
  PLACEHOLDER_MANDATE,
  displayUlwMandate,
} from "./harness/ulw-cycle.js";
import { openTodos } from "./agent/todos.js";
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
import { formatExpertTips, expertTipsLines } from "./util/tips.js";
import {
  shouldOfferLoginPicker,
  offerLoginInteractive,
  formatPostLoginOfferExit,
} from "./tui/login-offer.js";
import {
  collectSetupAssessment,
  formatSetupCard,
  setupJsonPayload,
} from "./commands/setup.js";
import { runForgeInit } from "./commands/init-scaffold.js";
import { editDistance } from "./util/string-distance.js";
import {
  isAcceptableUnknownModelId,
  suggestName,
  suggestSessionAction,
} from "./util/suggest.js";
import { parseDaysWindow, daysWindowHelp } from "./util/days-window.js";
import { parseNewsCount, newsCountHelp } from "./util/news-count.js";
import { parseLogsLines, logsLinesHelp } from "./util/logs-lines.js";
import {
  normalizeProviderId,
  PROVIDER_IDS as PROVIDER_ID_LIST,
  providerIdHelp,
} from "./util/provider-id.js";
import {
  normalizePermissionMode,
  normalizeSandboxProfile,
  normalizeSandboxNetwork,
} from "./util/mode-aliases.js";
import {
  normalizeCompletionShell,
  shellCompletionScript,
} from "./util/completion-script.js";
import { providerTimeoutMs } from "./util/abort.js";
import { detectProjectHints, getGitSnapshot } from "./util/git-context.js";
import {
  detectProjectIntel,
  hasNodeModules,
  multipleLockfiles,
} from "./util/project-intel.js";
import {
  defaultBashBackgroundTimeoutMs,
  defaultBashTimeoutMs,
  envPositiveInt, maxRunMsFromEnv,
  parseCliNonNegInt,
} from "./util/env.js";
import {
  isBellEnabled,
  isNotifyEnabled,
  maybeTurnEndAttention,
  turnEndOutcomeLabel,
} from "./util/attention.js";
import { isFormatOnWriteEnabled } from "./agent/tools/format-on-write.js";
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
  // `forge --version --json` / `-V --json` for CI (Commander prints plain version only).
  if (
    process.argv.includes("--json") &&
    (process.argv.includes("--version") || process.argv.includes("-V"))
  ) {
    console.log(
      JSON.stringify({
        ok: true,
        version: VERSION,
        name: "forge",
        node: process.version,
      }),
    );
    return;
  }
  const program = new Command();
  // When --json is on argv, Commander parse errors become structured stdout
  // (CI must not scrape stderr for "unknown option").
  const wantJsonCli = process.argv.includes("--json");
  program.exitOverride();
  program.configureOutput({
    writeErr: (str) => {
      if (wantJsonCli) return; // structured path below
      process.stderr.write(str);
    },
  });
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
  forge "next step" --continue                 # bare headless same-cwd resume (fail-closed if none)
  forge "next step" --json                     # bare headless JSON (parity with run --json)
  forge setup --json · forge init --json · forge tips --json · forge completion bash --json
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

Docs: docs/GETTING-STARTED.md · docs/PRODUCTION.md · docs/RELIABILITY.md · docs/ULW.md · forge news
`,
    )
    .option("-m, --model <model>", "Model id")
    .option("--fallback-models <models>", "Same-provider fallbacks after 429/5xx (comma list; off disables)")
    .option("-p, --provider <provider>", "Provider: xai|anthropic|openai|openrouter|deepseek|google|copilot|cursor|custom")
    .option("--base-url <url>", "Override API base URL")
    .option(
      "--effort <level>",
      "Thinking effort (default = model max): low|medium|high|xhigh|max",
    )
    .option(
      "--reasoning-effort <level>",
      "Alias for --effort",
    )
    .option(
      "--max-turns <n>",
      "Cap agent turns (0 = unlimited; default from config / FORGE_MAX_TURNS)",
    )
    .option(
      "--max-cost <usd>",
      "Cap session spend estimate in USD (0 = unlimited; FORGE_MAX_COST_USD / max_cost_usd)",
    )
    .option(
      "--permission-mode <mode>",
      "default|acceptEdits|plan|bypassPermissions|dontAsk (aliases: ask=default, accept, deny/dont-ask, yolo)",
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
      "--read-outside <mode>",
      "Read files outside workspace: ask|allow|deny (default ask; env FORGE_READ_OUTSIDE)",
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
    .option(
      "--max-waves <n>",
      "ULW wave cap (positive int; auto LAST when wave hits N). 0/omit = unlimited. Implies --ulw when set >0",
    )
    .option("--goal <objective>", "Arm a relentless /goal on start")
    .option(
      "--new",
      "Force a new session (default resumes newest same-cwd session in the REPL)",
    )
    .option("--session <id>", "Resume session id/prefix or unique title")
    .option(
      "--continue",
      "Resume newest same-cwd session (fail-closed if none; parity with forge run --continue)",
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
    );
  installGroupedHelp(program);
  program
    .argument("[prompt...]", "Optional initial prompt (also used by `forge run`)")
    .action(async (promptParts: string[], opts) => {
      if (opts.printLogs) setLogLevel("debug");
      await ensureHome();
      const wantJson = Boolean(opts.json);
      let prompt = promptParts?.length
        ? promptParts.join(" ").trim() || undefined
        : undefined;
      // Bare `forge sesions` looks like a subcommand typo — fail closed.
      // Real one-word tasks that collide: quote them (`forge "sessions"` is still a prompt
      // only if it is not an exact subcommand; exact names are routed by Commander).
      if (prompt) {
        const cmdTip = suggestTopLevelCommand(prompt);
        if (cmdTip) {
          const tip =
            `Did you mean: forge ${cmdTip}? ` +
            `(got bare prompt "${prompt}" — not a subcommand). ` +
            `Run: forge ${cmdTip}   ·  force as prompt: forge run "${prompt}"`;
          if (wantJson) {
            emitFailJson({
              reason: "command_typo",
              error: tip,
              prompt,
              suggestion: cmdTip,
              hint: `forge ${cmdTip} --help`,
            });
          } else {
            log.error(tip);
          }
          process.exit(1);
        }
      }
      // --json is headless-only (same payload as forge run --json).
      if (wantJson && !prompt) {
        emitFailJson({
          reason: "empty_prompt",
          error:
            'Empty prompt. Usage: forge "your task" --json   (or: forge run "your task" --json)',
          hint: 'forge run "your task" --json',
        });
        process.exit(1);
      }
      // Empty --title '' fails closed before auth/session.
      if (opts.title != null) {
        opts.title = assertTitleOpt(opts.title, { json: wantJson });
      }
      // Empty --goal '' is invalid (flag present but blank objective).
      if (opts.goal != null) {
        opts.goal = assertGoalOpt(opts.goal, { json: wantJson });
      }
      const config = buildConfig(opts);
      // --json forces headless even on a TTY (parity with forge run --json).
      const willHeadless = Boolean(
        prompt &&
          (wantJson ||
            !process.stdin.isTTY ||
            process.env.FORGE_HEADLESS === "1"),
      );
      // Fail-closed session flags before auth (CI reasons without credentials).
      // Do NOT create a fresh session yet — resolveSession creates on miss, which
      // would orphan dirs when auth fails. Only preflight when --session/--continue
      // can exit without creating; otherwise auth first, then resolve.
      const needsSessionPreflight =
        opts.session != null || Boolean(opts.continue);
      // Keep the preflight session so an early headless slash runs against the
      // REQUESTED session — probing a throwaway would save an empty session
      // (ephemeral is false under --session) and arm sidecars on the wrong id.
      let preflightSession: ReturnType<typeof resolveSession> | null = null;
      if (needsSessionPreflight) {
        // resolveSession exits on --session miss / --continue miss|locked.
        // json:true silences resume chatter — real resolve happens after auth.
        // Omit title so a failed auth cannot leave a half-applied /title rename.
        preflightSession = resolveSession(config, {
          ...opts,
          title: undefined,
          autoResume: false,
          continue: Boolean(opts.continue),
          json: true,
        });
      }
      // Pure-control headless slash before auth (parity with forge run)
      // A forwarded slash (kind "prompt", e.g. /ulw) arms sidecars + saves the
      // session it ran against — reuse that session for the run instead of
      // orphaning it and creating a second, unarmed one (parity with forge run).
      let earlyForwardedSession: ReturnType<typeof resolveSession> | null =
        null;
      if (willHeadless && prompt && /^\s*[\/!]/.test(prompt)) {
        const earlySession =
          preflightSession ??
          createSession({
            cwd: config.workspace || process.cwd(),
            provider: config.provider,
            model: config.model,
            ultrawork: Boolean(opts.ulw || opts.goal),
            title: typeof opts.title === "string" ? opts.title : undefined,
          });
        try {
          const { resolveHeadlessSlashPrompt, stripAnsi } = await import(
            "./commands/headless-slash.js"
          );
          const hooksEarly = new HookRunner(config, earlySession.meta.cwd);
          const resolved = await resolveHeadlessSlashPrompt({
            prompt,
            session: earlySession,
            config,
            hooks: hooksEarly,
            // No --session/--continue: pure-control must not pollute sessions list
            ephemeral: !preflightSession,
          });
          if (resolved.kind === "done") {
            const out = stripAnsi(resolved.output);
            if (wantJson) {
              const payload = {
                reason: "slash",
                command: resolved.command,
                output: out,
                sessionId: resolved.ephemeral ? null : resolved.session.meta.id,
                sessionPath: resolved.ephemeral
                  ? null
                  : resolveSessionDir(resolved.session.meta.id),
                ephemeral: Boolean(resolved.ephemeral),
                forgeHome: forgeHome(),
                provider: config.provider,
                model: config.model,
                permissionMode: config.permissionMode,
                node: process.version,
              };
              if (resolved.failed) emitFailJson({ ...payload, error: out });
              else emitOkJson({ ok: true, ...payload });
            } else if (out) {
              process.stdout.write(out.endsWith("\n") ? out : out + "\n");
            }
            process.exit(resolved.failed ? 1 : 0);
          }
          if (resolved.kind === "prompt") {
            prompt = resolved.prompt;
            // Fresh probe session (no --session/--continue): keep it for the
            // run — side effects (ULW/goal sidecar, title) are keyed to its id.
            // With a preflight session, resolveSession below re-resolves the
            // same id from disk (the slash saved it on forward) and still
            // applies --title / resume orientation.
            if (!preflightSession) earlyForwardedSession = resolved.session;
            if (!wantJson && resolved.notice) {
              log.dim(stripAnsi(resolved.notice));
            }
          }
        } catch {
          /* fall through to auth */
        }
      }
      let auth = await resolveAuthFresh(config);
      if (!auth) {
        const msg =
          "Not authenticated. Run: forge login\n" +
          "  or set XAI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / …";
        if (wantJson) {
          emitFailJson({
            reason: "unauthenticated",
            forgeHome: forgeHome(),
            error:
              "Not authenticated. Run forge login --api-key $KEY --json (CI) or forge login (interactive), or set an API key env var.",
            provider: config.provider,
            authMethod: null,
            hint: "forge login --api-key $KEY --json  ·  forge login  ·  set XAI_API_KEY / ANTHROPIC_API_KEY / …",
          });
          process.exit(1);
        }
        const offer = shouldOfferLoginPicker({
          json: wantJson,
          headless: willHeadless,
          isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        });
        let declined: "quit" | "env" | undefined;
        if (offer) {
          const result = await offerLoginInteractive();
          if (result.ok) auth = await resolveAuthFresh(config);
          else declined = result.reason;
        }
        if (!auth) {
          if (declined) {
            const line = formatPostLoginOfferExit(declined);
            if (line) log.error(line);
            process.exit(1);
          }
          log.error(msg);
          process.exit(1);
        }
      }
      // Provider/model alignment with resumed sessions happens after resolveSession
      // (sticky login must not hijack an older chat's provider). Fresh sessions keep
      // config/sticky provider; auth is re-checked against the effective provider below.

      // Interactive REPL: resume newest same-cwd session (OpenCode --continue style)
      // unless --new / --session / FORGE_NO_AUTO_RESUME. Headless starts fresh unless
      // --session or explicit --continue (parity with forge run --continue).
      // A forwarded early slash already produced+saved its session — reuse it.
      const session =
        earlyForwardedSession ??
        resolveSession(config, {
          ...opts,
          autoResume: !willHeadless,
          continue: Boolean(opts.continue),
          json: wantJson,
          // Interactive REPL prints orientation on the banner; headless
          // `--continue` has no banner and still needs the peek.
          skipOrientation: !willHeadless,
        });
      // Prefer resumed session provider/model/plan unless CLI -p/-m/--permission-mode set.
      {
        const argv = process.argv;
        const providerExplicit = argv.some(
          (a, i) =>
            a === "-p" ||
            a === "--provider" ||
            a.startsWith("--provider="),
        );
        const modelExplicit = argv.some(
          (a) => a === "-m" || a === "--model" || a.startsWith("--model="),
        );
        const permissionExplicit = argv.some(
          (a) =>
            a === "--permission-mode" || a.startsWith("--permission-mode="),
        );
        if (!modelExplicit && session.meta.model) {
          config.model = session.meta.model;
        }
        if (
          opts.fallbackModels == null &&
          !process.env.FORGE_FALLBACK_MODELS &&
          Array.isArray(session.meta.fallbackModels)
        ) {
          config.fallbackModels = session.meta.fallbackModels;
        }
        if (!providerExplicit && session.meta.provider) {
          config.provider = session.meta.provider as typeof config.provider;
        }
        // Session-scoped /plan survives resume (OpenCode-style) unless CLI overrides.
        if (!permissionExplicit) {
          try {
            const { applySessionPermissionMode } = await import(
              "./session/session.js"
            );
            if (applySessionPermissionMode(config, session) && !wantJson) {
              log.dim(
                `Restored session permission mode: ${config.permissionMode}`,
              );
            }
          } catch {
            /* never block startup on meta restore */
          }
        }
      }
      // Re-resolve auth for the effective provider (session may differ from sticky default).
      let effectiveAuth = auth;
      if (auth.provider !== config.provider) {
        const again = await resolveAuthFresh(config, String(config.provider));
        if (again) effectiveAuth = again;
        else if (!wantJson) {
          log.warn(
            `No credentials for session provider ${config.provider}; using ${auth.provider}`,
          );
          config.provider = auth.provider as typeof config.provider;
        }
      }
      const provider = createProvider(config, effectiveAuth);
      {
        const maxWavesOpt = parseCliMaxWaves(opts.maxWaves, wantJson);
        const wantUlw = Boolean(opts.ulw) || maxWavesOpt !== undefined;
        if (wantUlw) {
          session.meta.ultrawork = true;
          const mandate =
            mandateFromUserText(prompt || "") || PLACEHOLDER_MANDATE;
          const maxWaves =
            maxWavesOpt === undefined ? undefined : maxWavesOpt;
          const state = armUlwCycle(session.meta.id, mandate, {
            cwd: session.meta.cwd || process.cwd(),
            cycle: 1,
            editCount: session.meta.editCount,
            ...(maxWaves !== undefined ? { maxWaves } : {}),
          });
          // Seed a board only when the backlog gate is actually on.
          try {
            const { todosFromMandate } = await import(
              "./harness/decision-memory.js"
            );
            const { applyTodos, openTodos } = await import("./agent/todos.js");
            if (
              state.backlogRequired &&
              openTodos(session.todos || []) < 2
            ) {
              const seeded = todosFromMandate(mandate, { max: 12 });
              applyTodos(session, seeded, false);
              if (seeded.length >= 2 && state.backlogRequired) {
                state.backlogRequired = false;
                const { saveUlwCycle } = await import("./harness/ulw-cycle.js");
                saveUlwCycle(state);
              }
            }
          } catch {
            /* */
          }
          saveSession(session);
          if (!wantJson) {
            const cap =
              state.maxWaves != null ? ` max_waves=${state.maxWaves}` : "";
            log.info(
              `ULW cycle=1${cap} armed for: ${displayUlwMandate(mandate).slice(0, 80)}`,
            );
          }
        }
      }
      if (opts.goal) {
        armGoal(session.meta.id, String(opts.goal), "manual");
        session.meta.ultrawork = true;
        maybeSetTitle(session, String(opts.goal));
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
          console.log(stringifyJsonResult(result));
        }
        if (result.timedOut) process.exitCode = 124;
        else if (result.aborted) process.exitCode = 130;
        else if (isEmptyRunResult(result)) process.exitCode = 1;
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
    .option("--fallback-models <models>", "Same-provider fallbacks after 429/5xx (comma list; off disables)")
    .option("-p, --provider <provider>", "Provider")
    .option("--base-url <url>", "Override API base URL")
    .option("--effort <level>", "Thinking effort (default model max): low|medium|high|xhigh|max")
    .option("--reasoning-effort <level>", "Alias for --effort")
    .option(
      "--max-turns <n>",
      "Cap agent turns (0 = unlimited; default from config / FORGE_MAX_TURNS)",
    )
    .option(
      "--max-cost <usd>",
      "Cap session spend estimate in USD (0 = unlimited; FORGE_MAX_COST_USD / max_cost_usd)",
    )
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
      "--read-outside <mode>",
      "Read files outside workspace: ask|allow|deny (default ask; env FORGE_READ_OUTSIDE)",
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
    .option(
      "--max-waves <n>",
      "ULW wave cap (positive int; auto LAST at N). 0/omit = unlimited. Implies --ulw when set >0",
    )
    .option("--goal <objective>", "Arm /goal")
    .option("--cwd <path>", "Workspace", process.cwd())
    .option(
      "--session <id>",
      "Resume session id/prefix or unique title (continue prior headless run)",
    )
    .option(
      "--continue",
      "Resume newest same-cwd session (≤14d; skips foreign locks; fail-closed if none). Conflicts with --new",
    )
    .option("--new", "Force a new session (default when --session/--continue omitted)")
    .option("--title <text>", "Label for a new session (CI-friendly; searchable via list -q)")
    .option("--json", "Emit JSON result on stdout")
    .option(
      "--no-blocking-stop",
      "Disable blocking Stop hooks (not recommended for production)",
    )
    .addHelpText(
      "after",
      `
Exit codes:
  0    success
  1    error, empty/whitespace prompt, empty run, or unauthenticated
  124  wall-clock timeout (FORGE_MAX_RUN_MS)
  130  aborted (SIGINT)

--json fields (success): ok, version, node, forgeHome, sessionId, sessionPath, title, pinned, foreignLock, provider, stickyProvider, authMethod, model, reasoningEffort, cwd, git, projectLabel, projectHints, packageName, packageVersion, packageEnginesNode, packageManager, checkCommands, projectStackSummary, monorepoRoot, workspaces, nodeModulesPresent, multipleLockfiles, permissionMode, sandbox, sandboxNetwork, sandboxMissingBackend, readOutsideWorkspace, ultrawork, ulwCycle, ulwWave, ulwMaxWaves, ulwBlocks, ulwMandate, ulwSoftPrompt, ulwExpandedMandate, goalActive, goal, goalStuckThreshold, goalBlocks, goalStuckBlocks, goalCriteria, denyRules, allowRules, askRules, maxTurns, maxTurnsUnlimited, maxCostUsd, maxCostUnlimited, effectiveMaxCostUsd, sessionCostUsd, parentCostUsd, subagentCostUsd, subagentUsage, productionWarnings, formatOnWrite, subagentLandMode, projectMemoryCount, lastCheckpoint, blockingStop, maxRunMs, providerTimeoutMs, bashTimeoutMs, bashBackgroundTimeoutMs, permissionAskTimeoutMs, doomLoopThreshold, errorStreakThreshold, ulwMaxContinues, editCount, lastVerificationCommand, lastVerificationAt, lastEditAt, lastVerificationStale, openTodos, messageCount, finalText, turns, stopContinues,
  releasedOnContinueCap, hitMaxTurns, hitCostCap, stuckReleased, lastCycleReleased, finishReason, lastError, editCount, aborted, timedOut,
  harnessUserPokes, admitCount, proofPokes, providerRounds,
  promptTokens, completionTokens, durationMs
  (FORGE_JSON_COMPACT=1 → single-line success JSON for CI log aggregation)
  (releasedOnContinueCap/hitMaxTurns/hitCostCap/stuckReleased/lastCycleReleased → safety valves; still ok unless aborted/timedOut/empty run)
  (lastError → {at,code,message,tips} when stamped — max_cost/max_turns/continue_cap_*/handoff_released/proof_claim_released/ulw_stuck_wall/ulw_cycle_complete/goal_stuck_wall/…)
  (finishReason → last provider finish_reason, or null if no model turn)

--json early failures (stdout, still exit ≠0): { ok:false, version, reason, error, … } (typos may include suggestion)
  reason=empty_prompt | command_typo | conflicting_flags | unauthenticated | session_not_found | locked | empty_run | timeout | aborted
  | continue_miss | continue_locked  (explicit --continue with nothing resumable)
  | invalid_effort | invalid_permission_mode | invalid_sandbox
  | invalid_sandbox_network | invalid_sandbox_missing | invalid_provider
  | invalid_model | invalid_base_url | invalid_cwd | invalid_title
  | invalid_deny | invalid_allow | invalid_ask | invalid_goal
  | invalid_keep | invalid_limit | invalid_max_age_days | invalid_days | invalid_lines
  | invalid_interval | invalid_count | invalid_query | invalid_shell
  | missing_base_url  (custom without --base-url / FORGE_BASE_URL)
  | error | timeout | aborted  (mid-run catch path)

Empty prompts exit 1 before auth/session create (no orphan sessions, no API spend).
--session/--new/--title work on parent or subcommand (optsWithGlobals merge).
Label runs: --title <label> (searchable via forge sessions list -q / /sessions search).
Multi-step CI without copying ids: forge run "…" --continue --json
  (--continue fails closed if no same-cwd session / all locked — omit for fresh)

CI tips: forge doctor --json · --permission-mode acceptEdits · --sandbox workspace · --sandbox-missing fail-closed · --read-outside deny · --title ci-job
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
      let prompt = (promptParts || []).join(" ").trim();
      const wantJson = Boolean(runOpts.json);
      // --continue/--session vs --new are mutually exclusive (was silent prefer --new).
      if (runOpts.continue && runOpts.new) {
        failInvalidFlag(
          "conflicting_flags",
          "Cannot combine --continue with --new. Use one: resume same-cwd, or force a fresh session.",
          { continue: true, new: true },
          { json: wantJson },
        );
      }
      if (runOpts.session != null && runOpts.new) {
        failInvalidFlag(
          "conflicting_flags",
          "Cannot combine --session with --new. Pass --session to resume, or --new for a fresh session.",
          { session: String(runOpts.session), new: true },
          { json: wantJson },
        );
      }
      if (runOpts.session != null && runOpts.continue) {
        failInvalidFlag(
          "conflicting_flags",
          "Cannot combine --session with --continue. Pass --session <id|title>, or --continue for newest same-cwd.",
          { session: String(runOpts.session), continue: true },
          { json: wantJson },
        );
      }
      // Empty --title '' fails closed (no silent drop → auto title from prompt).
      if (runOpts.title != null) {
        runOpts.title = assertTitleOpt(runOpts.title, { json: wantJson });
      }
      if (runOpts.goal != null) {
        runOpts.goal = assertGoalOpt(runOpts.goal, { json: wantJson });
      }
      if (!prompt) {
        const msg =
          'Empty prompt. Usage: forge run "your task" [--title label] [--json]';
        if (wantJson) {
          emitFailJson({
            error: msg,
            reason: "empty_prompt",
            hint: 'forge run "your task" --json',
          });
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
      // Empty --cwd already rejected in buildConfig; keep resolve defensive.
      const cwd = path.resolve(String(runOpts.cwd || process.cwd()));
      // Commander always applies option defaults — only treat --cwd as explicit
      // when the user actually passed it on the CLI (so --session keeps its cwd).
      const cwdExplicit =
        command?.getOptionValueSource?.("cwd") === "cli" ||
        command?.parent?.getOptionValueSource?.("cwd") === "cli";
      let session;
      let resumed = false;
      // Session lookup / --continue fail-closed before auth so CI gets the right
      // reason without requiring credentials (parity with empty_prompt).
      // --session present (including "") must not silently start fresh
      const sessionFlag =
        runOpts.session != null ? String(runOpts.session).trim() : "";
      const sessionPassed = runOpts.session != null;
      if (sessionPassed && !runOpts.new) {
        if (!sessionFlag) {
          const msg =
            'Empty --session. Pass an id/prefix/title, or omit --session for a new run.';
          if (wantJson) {
            emitFailJson({
              reason: "session_not_found",
              session: String(runOpts.session),
              error: msg,
            });
          } else {
            log.error(msg);
          }
          process.exit(1);
        }
        session = loadSession(sessionFlag);
        if (!session) {
          const miss = formatSessionLookupMiss(sessionFlag);
          if (wantJson) {
            emitFailJson({
              error: miss,
              reason: "session_not_found",
              session: sessionFlag,
              suggestions: listSessionLookupSuggestions(sessionFlag),
            });
          } else {
            log.error(miss);
          }
          process.exit(1);
        }
        resumed = true;
      } else if (runOpts.continue && !runOpts.new) {
        // OpenCode-style headless continue: newest same-cwd session without copying ids.
        // Explicit --continue fails closed when nothing is resumable (CI safety —
        // never silently start a fresh session and report ok:true).
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
            } else {
              failContinueMiss({
                json: wantJson,
                cwd,
                reason: "continue_miss",
                error: `Failed to load same-cwd session ${hit.meta.id.slice(0, 8)} for --continue.`,
                skippedLocked: hit.skippedLocked,
                candidates: hit.candidates,
              });
            }
          } else if (hit && hit.skippedLocked > 0) {
            failContinueMiss({
              json: wantJson,
              cwd,
              reason: "continue_locked",
              error:
                `No unlocked same-cwd session to continue (${hit.skippedLocked} locked). ` +
                `Use --session <id> to attach, or omit --continue for a fresh run.`,
              skippedLocked: hit.skippedLocked,
              candidates: hit.candidates,
            });
          } else {
            failContinueMiss({
              json: wantJson,
              cwd,
              reason: "continue_miss",
              error:
                "No prior same-cwd session to continue. " +
                "Omit --continue to start fresh, or pass --session <id|title>.",
              skippedLocked: 0,
              candidates: hit?.candidates ?? 0,
            });
          }
        } catch {
          failContinueMiss({
            json: wantJson,
            cwd,
            reason: "continue_miss",
            error:
              "Failed to resolve same-cwd session for --continue. " +
              "Omit --continue to start fresh, or pass --session <id|title>.",
          });
        }
      }
      const providerExplicit =
        command?.getOptionValueSource?.("provider") === "cli" ||
        command?.parent?.getOptionValueSource?.("provider") === "cli";
      // When resuming without explicit -p, prefer the session's provider for auth
      // so sticky login preferences cannot silently switch a resumed conversation.
      const authProviderHint =
        !providerExplicit && resumed && session?.meta?.provider
          ? String(session.meta.provider)
          : undefined;
      // Pure-control headless slash (/commands, /plan, /help, …) must work
      // without auth so CI can probe hygiene. Template forwards still need auth.
      if (/^\s*\//.test(prompt)) {
        // Only a session created fresh by this invocation is disposable —
        // a resumed (--continue/--session) session must never be deleted.
        let createdFresh = false;
        if (!session) {
          session = createSession({
            cwd,
            provider: config.provider,
            model: config.model,
            ultrawork: Boolean(runOpts.ulw || runOpts.goal),
            title:
              typeof runOpts.title === "string" ? runOpts.title : undefined,
          });
          createdFresh = true;
        }
        try {
          const { resolveHeadlessSlashPrompt, stripAnsi } = await import(
            "./commands/headless-slash.js"
          );
          const hooksEarly = new HookRunner(config, session.meta.cwd);
          const resolved = await resolveHeadlessSlashPrompt({
            prompt,
            session,
            config,
            hooks: hooksEarly,
            ephemeral: createdFresh,
          });
          session = resolved.session;
          if (resolved.kind === "done") {
            const out = stripAnsi(resolved.output);
            if (wantJson) {
              const payload = {
                reason: "slash",
                command: resolved.command,
                output: out,
                sessionId: resolved.ephemeral ? null : resolved.session.meta.id,
                sessionPath: resolved.ephemeral
                  ? null
                  : resolveSessionDir(resolved.session.meta.id),
                ephemeral: Boolean(resolved.ephemeral),
                forgeHome: forgeHome(),
                provider: config.provider,
                model: config.model,
                permissionMode: config.permissionMode,
                node: process.version,
              };
              if (resolved.failed) emitFailJson({ ...payload, error: out });
              else emitOkJson({ ok: true, ...payload });
            } else if (out) {
              process.stdout.write(out.endsWith("\n") ? out : out + "\n");
            }
            process.exit(resolved.failed ? 1 : 0);
          }
          if (resolved.kind === "prompt") {
            prompt = resolved.prompt;
            if (!wantJson && resolved.notice) {
              log.dim(stripAnsi(resolved.notice));
            }
          }
        } catch {
          /* fall through to auth + normal run */
        }
      }
      const auth = await resolveAuthFresh(config, authProviderHint);
      if (!auth) {
        const msg = "Not authenticated. Run forge login or set an API key.";
        if (wantJson) {
          emitFailJson({
            error:
              "Not authenticated. Run forge login --api-key $KEY --json (CI) or forge login (interactive), or set an API key env var.",
            reason: "unauthenticated",
            forgeHome: forgeHome(),
            provider: authProviderHint || config.provider,
            authMethod: null,
            hint: "forge login --api-key $KEY --json  ·  forge login  ·  set provider API key env",
          });
        } else {
          log.error(msg);
        }
        process.exit(1);
      }
      // Align config to resolved auth when not resuming / not explicit -p.
      if (!providerExplicit && !resumed && auth.provider !== config.provider) {
        if (!wantJson) {
          log.info(
            `Using provider ${auth.provider} from available credentials`,
          );
        }
        config.provider = auth.provider as typeof config.provider;
        if (!runOpts.model) {
          config.model =
            config.providers[auth.provider]?.defaultModel || config.model;
        }
      }
      if (resumed && session) {
        // Align live config model with resumed session unless CLI overrode it
        if (!runOpts.model) config.model = session.meta.model || config.model;
        if (!providerExplicit) {
          config.provider = (session.meta.provider ||
            auth.provider ||
            config.provider) as typeof config.provider;
        }
        // Keep session identity stable on resume (do not rewrite to sticky default)
        if (providerExplicit) {
          session.meta.provider = String(config.provider);
        }
        if (runOpts.model) {
          session.meta.model = config.model;
        }

        if (cwdExplicit) {
          session.meta.cwd = cwd;
        }
        // Prefer session workspace for tools when not explicitly overridden
        if (!cwdExplicit && session.meta.cwd) {
          config.workspace = session.meta.cwd;
        }
        // Session-scoped /plan survives headless resume unless --permission-mode set.
        {
          const permissionExplicit =
            command?.getOptionValueSource?.("permissionMode") === "cli" ||
            command?.parent?.getOptionValueSource?.("permissionMode") === "cli" ||
            process.argv.some(
              (a) =>
                a === "--permission-mode" ||
                a.startsWith("--permission-mode="),
            );
          if (!permissionExplicit) {
            try {
              const { applySessionPermissionMode } = await import(
                "./session/session.js"
              );
              applySessionPermissionMode(config, session);
            } catch {
              /* */
            }
          }
        }
        saveSession(session);
        if (runOpts.session) {
          log.dim(
            `Resuming session ${session.meta.id.slice(0, 8)} (${session.messages.length} msgs)`,
          );
        }
        try {
          const peek = formatResumeOrientation(session, { compact: true });
          if (peek) log.dim(peek);
        } catch {
          /* */
        }
      } else if (!session) {
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
      {
        const maxWavesOpt = parseCliMaxWaves(runOpts.maxWaves, wantJson);
        const wantUlw =
          Boolean(runOpts.ulw || runOpts.goal) || maxWavesOpt !== undefined;
        if (wantUlw) {
          session.meta.ultrawork = true;
          armUlwCycle(
            session.meta.id,
            mandateFromUserText(prompt || "") || PLACEHOLDER_MANDATE,
            {
              cwd: session.meta.cwd || process.cwd(),
              cycle: 1,
              editCount: session.meta.editCount,
              ...(maxWavesOpt !== undefined ? { maxWaves: maxWavesOpt } : {}),
            },
          );
          saveSession(session);
        }
      }
      if (runOpts.goal) {
        armGoal(session.meta.id, String(runOpts.goal), "manual");
        maybeSetTitle(session, String(runOpts.goal));
        saveSession(session);
      }
      const provider = createProvider(config, auth);
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
        console.log(stringifyJsonResult(result));
      }
      // CI-friendly exit codes: wall-clock timeout=124, abort=130, empty=1
      if (result.timedOut) process.exitCode = 124;
      else if (result.aborted) process.exitCode = 130;
      else if (isEmptyRunResult(result)) process.exitCode = 1;
    });

  program
    .command("login")
    .description(
      "Authenticate: SuperGrok OIDC (default for xai), local Copilot/Cursor, API key, Grok import, or device code",
    )
    .option("-p, --provider <provider>", "Provider (default: sticky preference or xai)", "xai")
    .option("--api-key [key]", "Use API key (prompt if omitted)")
    .option(
      "--from-grok",
      "Import SuperGrok session from ~/.grok/auth.json (Grok Build already logged in)",
    )
    .option(
      "--from-copilot",
      "Import GitHub Copilot from local CLI keychain / VS Code apps.json",
    )
    .option(
      "--from-cursor",
      "Import Cursor from local CLI auth.json / keychain / CURSOR_API_KEY",
    )
    .option(
      "--oauth",
      "Browser SuperGrok / OIDC (default for xai; same public client as Grok CLI)",
    )
    .option("--device", "Device-code flow (headless SSH / remote)")
    .option(
      "--add",
      "Add another account for this provider (keep existing; multi-account)",
    )
    .option(
      "--label <label>",
      "Display label for API-key accounts (or rename identity hint)",
    )
    .option("--json", "Machine-readable JSON (never includes tokens)")
    .action(async (opts, command) => {
      await ensureHome();
      const globals = (command?.optsWithGlobals?.() || {}) as Record<string, unknown>;
      const merged = { ...globals, ...opts } as Record<string, unknown>;
      const wantJson = Boolean(merged.json || opts.json);
      // Parent -p/--provider must not be clobbered by login's default "xai".
      // When -p is omitted, prefer sticky preferences.provider (last login -p).
      const localSrc = command?.getOptionValueSource?.("provider");
      const parentSrc = command?.parent?.getOptionValueSource?.("provider");
      let stickyProvider: string | undefined;
      try {
        stickyProvider = loadPreferences().provider;
      } catch {
        /* */
      }
      let providerRaw = stickyProvider || "xai";
      if (localSrc === "cli" && opts.provider != null) {
        providerRaw = String(opts.provider);
      } else if (parentSrc === "cli" && globals.provider != null) {
        providerRaw = String(globals.provider);
      } else if (localSrc === "cli" || parentSrc === "cli") {
        // explicit empty handled by normalize below
        if (opts.provider != null) providerRaw = String(opts.provider);
      }
      const providerParsed = normalizeProviderId(providerRaw);
      const providerNorm = providerParsed.ok
        ? providerParsed.provider
        : providerRaw.trim().toLowerCase();
      const failLogin = (
        reason: string,
        error: string,
        extra?: Record<string, unknown>,
      ): never => {
        if (wantJson) {
          emitFailJson({
            reason,
            error,
            provider: providerNorm,
            ...extra,
          });
        } else {
          log.error(error);
        }
        process.exit(1);
      };
      if (!providerParsed.ok) {
        const tip = providerParsed.raw
          ? suggestName(providerParsed.raw, [...PROVIDER_IDS], {
              minLength: 2,
              minScore: 36,
              requirePrefix3: false,
            })
          : null;
        failLogin(
          "invalid_provider",
          tip
            ? `Invalid --provider "${providerRaw}". Did you mean: ${tip}? Use ${providerIdHelp()}.`
            : `Invalid --provider "${providerRaw}". Use ${providerIdHelp()}.`,
          {
            provider: providerRaw,
            ...(tip ? { suggestion: tip } : {}),
          },
        );
      }
      const provider = providerParsed.ok
        ? providerParsed.provider
        : (providerNorm as import("./config/types.js").ProviderId);
      // Commander optional --api-key [key]: true = flag only, "" = empty string, string = value.
      // Empty string must NOT fall through to Grok import (user asked for api_key).
      const apiKeyFlag = opts.apiKey !== undefined;
      const apiKeyValue =
        typeof opts.apiKey === "string" ? opts.apiKey.trim() : "";

      // Explicit Grok Build file import only (--from-grok). Default is SuperGrok OIDC.
      if (opts.fromGrok) {
        const result = importGrokCredentials();
        if (result.imported) {
          try {
            savePreferences({ provider: "xai" });
          } catch {
            /* preferences are best-effort */
          }
          if (wantJson) {
            emitOkJson({
              forgeHome: forgeHome(),
              method: "from_grok",
              provider: "xai",
              accountLabel: result.email ? `grok:${result.email}` : null,
              accountId: result.accountId || null,
              created: result.created ?? null,
              expiresAt: result.expiresAt
              ? new Date(result.expiresAt * 1000).toISOString()
              : null,
            });
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
          log.info("Next: forge   ·   forge setup   ·   forge doctor");
          return;
        }
        failLogin("grok_import_failed", result.reason || "Import failed", {
          email: result.email || null,
        });
      }

      // Import local GitHub Copilot CLI / VS Code credentials.
      const wantFromCopilot =
        Boolean(opts.fromCopilot) ||
        // Default for -p copilot when no other method flag is set
        (provider === "copilot" &&
          !opts.device &&
          !opts.oauth &&
          !apiKeyFlag);
      if (wantFromCopilot) {
        const result = await importLocalCopilotCredentials();
        if (result.imported) {
          try {
            savePreferences({ provider: "copilot" });
          } catch {
            /* preferences are best-effort */
          }
          if (wantJson) {
            emitOkJson({
              forgeHome: forgeHome(),
              method: "from_copilot",
              provider: "copilot",
              accountLabel: result.login ? `copilot:${result.login}` : null,
              accountId: result.accountId || null,
              created: result.created ?? null,
              source: result.source || null,
              expiresAt: result.expiresAt
                ? new Date(result.expiresAt * 1000).toISOString()
                : null,
            });
            return;
          }
          log.success(
            `Imported local GitHub Copilot session${
              result.login ? ` (${result.login})` : ""
            }${result.source ? ` from ${result.source}` : ""}`,
          );
          if (result.expiresAt) {
            const hours = Math.max(
              0,
              (result.expiresAt - Math.floor(Date.now() / 1000)) / 3600,
            );
            log.dim(
              `Copilot session expires ${new Date(result.expiresAt * 1000).toISOString()} (~${hours.toFixed(1)}h). ` +
                `GitHub token stored for auto re-exchange. ` +
                `Alt: forge login -p copilot --device`,
            );
          }
          log.info("Next: forge -p copilot   ·   forge setup   ·   forge doctor");
          return;
        }
        // Explicit --from-copilot fails closed; bare -p copilot falls through to device.
        if (opts.fromCopilot) {
          failLogin(
            "copilot_import_failed",
            result.reason || "Local Copilot import failed",
            { login: result.login || null, source: result.source || null },
          );
        }
        if (!wantJson) {
          log.warn(result.reason || "Local Copilot import failed");
          log.info("Falling back to GitHub device-code login…");
        }
      }

      // Import local Cursor CLI / SDK / desktop credentials.
      const wantFromCursor =
        Boolean(opts.fromCursor) ||
        (isCursorProvider(provider) &&
          !opts.device &&
          !opts.oauth &&
          !apiKeyFlag);
      if (wantFromCursor) {
        const result = await importLocalCursorCredentials();
        if (result.imported) {
          try {
            savePreferences({ provider: "cursor" });
          } catch {
            /* preferences are best-effort */
          }
          if (wantJson) {
            emitOkJson({
              forgeHome: forgeHome(),
              method: "from_cursor",
              provider: "cursor",
              accountLabel: result.email ? `cursor:${result.email}` : null,
              accountId: result.accountId || null,
              created: result.created ?? null,
              source: result.source || null,
              expiresAt: result.expiresAt
                ? new Date(result.expiresAt * 1000).toISOString()
                : null,
            });
            return;
          }
          log.success(
            `Imported local Cursor session${
              result.email ? ` (${result.email})` : ""
            }${result.source ? ` from ${result.source}` : ""}`,
          );
          if (result.expiresAt) {
            const hours = Math.max(
              0,
              (result.expiresAt - Math.floor(Date.now() / 1000)) / 3600,
            );
            log.dim(
              `Cursor access token expires ${new Date(result.expiresAt * 1000).toISOString()} (~${hours.toFixed(1)}h). ` +
                `Refresh token stored for auto-renew. ` +
                `Alt: forge login -p cursor --oauth`,
            );
          }
          log.info("Next: forge -p cursor   ·   forge setup   ·   forge doctor");
          return;
        }
        if (opts.fromCursor) {
          failLogin(
            "cursor_import_failed",
            result.reason || "Local Cursor import failed",
            { email: result.email || null, source: result.source || null },
          );
        }
        if (!wantJson) {
          log.warn(result.reason || "Local Cursor import failed");
          log.info("Falling back to Cursor browser login…");
        }
      }

      // Default xAI path: native SuperGrok OIDC (browser), not import-from-grok.
      // Copilot: device code (no browser redirect registered).
      let method: "api_key" | "oauth" | "device" = "api_key";
      if (opts.device) method = "device";
      else if (opts.oauth) method = "oauth";
      else if (apiKeyFlag) method = "api_key";
      else if (provider === "copilot") method = "device";
      else if (isCursorProvider(provider) || supportsOAuth(provider)) method = "oauth";
      else method = "api_key";

      // --json requires a non-interactive path (explicit API key or --from-copilot/--from-cursor).
      if (wantJson && method !== "api_key") {
        failLogin(
          "interactive_required",
          `login --json only supports --api-key, --from-copilot, or --from-cursor (got method=${method}). ` +
            `Use forge login --api-key <key> --json or forge login --from-cursor --json.`,
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
          if (provider === "copilot") {
            const { storeCopilotFromGitHubToken } = await import(
              "./auth/copilot.js"
            );
            await storeCopilotFromGitHubToken(apiKeyValue, {
              label: "api-key-json",
            });
          } else if (isCursorProvider(provider)) {
            const { storeCursorFromAccessToken } = await import(
              "./auth/cursor.js"
            );
            await storeCursorFromAccessToken(apiKeyValue, {
              label: "api-key-json",
            });
          } else {
            upsertApiKey(
              provider,
              apiKeyValue,
              typeof opts.label === "string" && opts.label.trim()
                ? opts.label.trim()
                : opts.add
                  ? `api-key-${Date.now().toString(36)}`
                  : "api-key",
              { forceNew: Boolean(opts.add) },
            );
          }
          try {
            savePreferences({ provider });
          } catch {
            /* preferences are best-effort */
          }
          const active = getActiveAccount(provider);
          emitOkJson({
            forgeHome: forgeHome(),
            method: "api_key",
            provider,
            accountId: active?.id || null,
            accountLabel: active?.accountLabel || null,
            // never echo the key
          });
          return;
        }
        const loginResult = await loginInteractive({
          provider,
          method,
          apiKey: apiKeyValue || undefined,
          addAccount: Boolean(opts.add),
          accountLabel:
            typeof opts.label === "string" && opts.label.trim()
              ? opts.label.trim()
              : undefined,
        });
        try {
          savePreferences({ provider });
        } catch {
          /* preferences are best-effort */
        }
        if (loginResult?.created && !wantJson) {
          log.dim(
            `Multi-account: forge accounts list · forge accounts switch <id> · forge auth`,
          );
        }
        if (!wantJson) {
          log.info("Next: forge   ·   forge setup   ·   forge doctor");
        }
      } catch (err) {
        if (provider === "xai" && method === "oauth" && !wantJson) {
          log.dim(
            "Also: forge login --device · forge login --from-grok · forge login --api-key",
          );
        }
        if (provider === "copilot" && !wantJson) {
          log.dim(
            "Also: forge login --from-copilot · forge login -p copilot --device · forge login -p copilot --api-key",
          );
        }
        if (isCursorProvider(provider) && !wantJson) {
          log.dim(
            "Also: forge login --from-cursor · forge login -p cursor --oauth · forge login -p cursor --api-key",
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
      const wantJson = Boolean(merged.json || opts.json);
      let provider: string | undefined;
      const providerExplicit = localSrc === "cli" || parentSrc === "cli";
      const providerRaw =
        localSrc === "cli" && "provider" in opts
          ? opts.provider
          : parentSrc === "cli" && "provider" in merged
            ? merged.provider
            : undefined;
      if (providerExplicit) {
        // Empty -p '' must not silently clear ALL credentials.
        const raw = providerRaw != null ? String(providerRaw).trim() : "";
        if (!raw) {
          failInvalidFlag(
            "invalid_provider",
            `Invalid --provider "${providerRaw ?? ""}". Use ${providerIdHelp()}, or omit -p to clear all.`,
            { provider: String(providerRaw ?? "") },
            { json: wantJson },
          );
        }
        const norm = normalizeProviderId(raw);
        if (!norm.ok) {
          const tip = norm.raw
            ? suggestName(norm.raw, [...PROVIDER_IDS], {
                minLength: 2,
                minScore: 36,
                requirePrefix3: false,
              })
            : null;
          failInvalidFlag(
            "invalid_provider",
            tip
              ? `Invalid --provider "${raw}". Did you mean: ${tip}? Use ${providerIdHelp()}, or omit -p to clear all.`
              : `Invalid --provider "${raw}". Use ${providerIdHelp()}, or omit -p to clear all.`,
            {
              provider: raw,
              ...(tip ? { suggestion: tip } : {}),
            },
            { json: wantJson },
          );
        }
        provider = norm.provider;
      } else if (typeof opts.provider === "string" && opts.provider.trim()) {
        provider = opts.provider.trim();
      }
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

        // Drop sticky provider+model preference when they no longer have
        // credentials — a stale foreign model would pair with the fallback
        // provider and fail every chat call until /model.
        try {
          const pref = loadPreferences();
          if (!provider) {
            if (pref.provider || pref.model) {
              savePreferences({ provider: null, model: null });
            }
          } else if (pref.provider === provider) {
            savePreferences({ provider: null, model: null });
          }
        } catch {
          /* preferences best-effort */
        }
        emitOkJson(
          {
            forgeHome: forgeHome(),
            cleared: provider || "all",
            removed: before,
            count: before.length,
          },
          true,
        );
        return;
      }
      logout(provider);

        // Drop sticky provider+model preference when they no longer have
        // credentials — a stale foreign model would pair with the fallback
        // provider and fail every chat call until /model.
        try {
          const pref = loadPreferences();
          if (!provider) {
            if (pref.provider || pref.model) {
              savePreferences({ provider: null, model: null });
            }
          } else if (pref.provider === provider) {
            savePreferences({ provider: null, model: null });
          }
        } catch {
          /* preferences best-effort */
        }
    });

  program
    .command("auth")
    .description("Show authentication status")
    .option("--json", "Machine-readable JSON (never includes tokens)")
    .action(async (opts, command) => {
      const config = loadConfig();
      const auth = await resolveAuthFresh(config);
      if (flagJson(opts, command)) {
        const accounts = listAccountSummaries();
        const settings = getAutoSwitchSettings();
        const authenticated = Boolean(auth);
        // Legacy `stored` = one row per active provider (backward compatible)
        const stored = listCredentials().map((c) => ({
          provider: c.provider,
          method: c.method,
          accountLabel: c.accountLabel || null,
          subscription: c.subscription || null,
          expiresAt: c.expiresAt
            ? new Date(c.expiresAt * 1000).toISOString()
            : null,
          expired:
            typeof c.expiresAt === "number"
              ? c.expiresAt < Math.floor(Date.now() / 1000)
              : false,
        }));
        const payload = {
          authenticated,
          forgeHome: forgeHome(),
          configProvider: config.provider,
          autoSwitch: settings.autoSwitch,
          switchThresholdPercent: settings.switchThresholdPercent,
          active: auth
            ? {
                provider: auth.provider,
                method: auth.method,
                accountLabel: auth.accountLabel || null,
                accountId: auth.accountId || null,
                baseUrl: auth.baseUrl || null,
                // token intentionally omitted
              }
            : null,
          description: describeAuth(auth),
          accounts,
          stored,
          ...(!authenticated
            ? {
                reason: "unauthenticated",
                error:
                  "Not authenticated. Run forge login --api-key $KEY --json (CI) or forge login (interactive), or set an API key env var.",
                hint: "forge login --api-key $KEY --json  ·  forge login  ·  forge accounts list  ·  set XAI_API_KEY / ANTHROPIC_API_KEY / …",
              }
            : {}),
        };
        // ok tracks auth for CI (parity with doctor --json); still exit 1 when false
        if (authenticated) emitOkJson(payload, true);
        else emitFailJson(payload);
        if (!authenticated) process.exitCode = 1;
        return;
      }
      printAuthStatus();
      console.log(`\nActive resolution: ${describeAuth(auth)}`);
      if (!auth) process.exitCode = 1;
    });

  // ── Multi-account management ─────────────────────────────────────────────
  const accountsCmd = program
    .command("accounts")
    .alias("account")
    .description(
      "Manage multi-account logins (list, switch, remove, auto-switch)",
    )
    .option("--json", "Machine-readable JSON (never includes tokens)");

  accountsCmd
    .command("list")
    .description("List all stored accounts (default)")
    .option("-p, --provider <provider>", "Filter by provider")
    .option("--json", "Machine-readable JSON")
    .action((opts, command) => {
      const wantJson = flagJson(opts, command) || flagJson(accountsCmd.opts(), accountsCmd);
      const providerRaw =
        typeof opts.provider === "string" ? opts.provider.trim() : "";
      let provider: string | undefined;
      if (providerRaw) {
        const norm = normalizeProviderId(providerRaw);
        if (!norm.ok) {
          failInvalidFlag(
            "invalid_provider",
            `Invalid --provider "${providerRaw}". Use ${providerIdHelp()}.`,
            { provider: providerRaw },
            { json: wantJson },
          );
        }
        provider = norm.provider;
      }
      const accounts = listAccountSummaries(provider);
      const settings = getAutoSwitchSettings();
      const readiness = assessMultiAccountReadiness(provider);
      if (wantJson) {
        emitOkJson({
          forgeHome: forgeHome(),
          autoSwitch: settings.autoSwitch,
          switchThresholdPercent: settings.switchThresholdPercent,
          multiAccount: readiness,
          accounts,
          count: accounts.length,
        });
        return;
      }
      console.log(formatAccountsTable(provider));
    });

  accountsCmd
    .command("status")
    .alias("ready")
    .description(
      "Unattended multi-account readiness (eligible/cooldown/auto-switch)",
    )
    .option("-p, --provider <provider>", "Filter by provider")
    .option("--json", "Machine-readable JSON")
    .action((opts, command) => {
      const wantJson = flagJson(opts, command);
      const providerRaw =
        typeof opts.provider === "string" ? opts.provider.trim() : "";
      let provider: string | undefined;
      if (providerRaw) {
        const norm = normalizeProviderId(providerRaw);
        if (!norm.ok) {
          failInvalidFlag(
            "invalid_provider",
            `Invalid --provider "${providerRaw}".`,
            { provider: providerRaw },
            { json: wantJson },
          );
        }
        provider = norm.provider;
      }
      const readiness = assessMultiAccountReadiness(provider);
      if (wantJson) {
        emitOkJson({
          forgeHome: forgeHome(),
          multiAccount: readiness,
          accounts: listAccountSummaries(provider),
        });
        return;
      }
      console.log(formatMultiAccountReadiness(provider));
      console.log("");
      console.log(formatAccountsTable(provider));
    });

  accountsCmd
    .command("clear-cooldown")
    .alias("clearcooldown")
    .description(
      "Clear rate-limit cooldown on accounts (selector, provider, or all)",
    )
    .argument(
      "[selector]",
      "Account id/label, provider name, or omit for all",
    )
    .option("--json", "Machine-readable JSON")
    .action((selector: string | undefined, opts, command) => {
      const wantJson = flagJson(opts, command);
      const r = clearAccountCooldown(selector?.trim() || undefined);
      if (wantJson) {
        emitOkJson({
          forgeHome: forgeHome(),
          cleared: r.cleared,
          ids: r.ids,
          selector: selector?.trim() || null,
        });
        return;
      }
      if (r.cleared === 0) {
        log.info(
          selector?.trim()
            ? `No cooldown on "${selector.trim()}"`
            : "No accounts in cooldown",
        );
      } else {
        log.success(`Cleared cooldown on ${r.cleared} account(s)`);
      }
    });

  accountsCmd
    .command("switch")
    .description("Set the active account for its provider")
    .argument("<selector>", "Account id, label, email, or provider:N")
    .option("-p, --provider <provider>", "Disambiguate by provider")
    .option("--json", "Machine-readable JSON")
    .action((selector: string, opts, command) => {
      const wantJson = flagJson(opts, command);
      const providerRaw =
        typeof opts.provider === "string" ? opts.provider.trim() : "";
      let provider: string | undefined;
      if (providerRaw) {
        const norm = normalizeProviderId(providerRaw);
        if (!norm.ok) {
          failInvalidFlag(
            "invalid_provider",
            `Invalid --provider "${providerRaw}".`,
            { provider: providerRaw },
            { json: wantJson },
          );
        }
        provider = norm.provider;
      }
      const hit = resolveAccountSelector(selector, provider);
      if (!hit.ok) {
        if (wantJson) {
          emitFailJson({
            reason: "account_not_found",
            error: hit.error,
            matches: hit.matches || null,
          });
        } else {
          log.error(hit.error);
          if (hit.matches?.length) {
            for (const m of hit.matches) {
              console.log(`  ${m.id}  ${m.accountLabel || ""}`);
            }
          }
        }
        process.exitCode = 1;
        return;
      }
      const r = switchAccount(String(hit.account.provider), {
        toId: hit.account.id,
        reason: "manual",
      });
      if (!r.switched) {
        if (wantJson) {
          emitFailJson({ reason: "switch_failed", error: r.reason });
        } else {
          log.error(r.reason || "switch failed");
        }
        process.exitCode = 1;
        return;
      }
      try {
        savePreferences({ provider: hit.account.provider as ProviderId });
      } catch {
        /* */
      }
      if (wantJson) {
        emitOkJson({
          forgeHome: forgeHome(),
          switched: true,
          fromId: r.fromId || null,
          toId: r.toId || null,
          toLabel: r.toLabel || null,
          provider: hit.account.provider,
        });
        return;
      }
      log.success(
        `Active ${hit.account.provider} account → ${r.toLabel || r.toId}`,
      );
    });

  accountsCmd
    .command("remove")
    .alias("rm")
    .description("Remove one stored account")
    .argument("<selector>", "Account id, label, email, or provider:N")
    .option("-p, --provider <provider>", "Disambiguate by provider")
    .option("--json", "Machine-readable JSON")
    .action((selector: string, opts, command) => {
      const wantJson = flagJson(opts, command);
      const providerRaw =
        typeof opts.provider === "string" ? opts.provider.trim() : "";
      let provider: string | undefined;
      if (providerRaw) {
        const norm = normalizeProviderId(providerRaw);
        provider = norm.ok ? norm.provider : providerRaw;
      }
      const hit = resolveAccountSelector(selector, provider);
      if (!hit.ok) {
        if (wantJson) {
          emitFailJson({ reason: "account_not_found", error: hit.error });
        } else {
          log.error(hit.error);
        }
        process.exitCode = 1;
        return;
      }
      const summary = {
        id: hit.account.id,
        provider: hit.account.provider,
        accountLabel: hit.account.accountLabel || null,
      };
      removeAccount(hit.account.id);
      if (wantJson) {
        emitOkJson({ forgeHome: forgeHome(), removed: summary });
        return;
      }
      log.success(`Removed account ${summary.id}`);
    });

  accountsCmd
    .command("rename")
    .description("Set display label for an account")
    .argument("<selector>", "Account id or label")
    .argument("<label>", "New display label")
    .option("--json", "Machine-readable JSON")
    .action((selector: string, label: string, opts, command) => {
      const wantJson = flagJson(opts, command);
      const hit = resolveAccountSelector(selector);
      if (!hit.ok) {
        if (wantJson) {
          emitFailJson({ reason: "account_not_found", error: hit.error });
        } else {
          log.error(hit.error);
        }
        process.exitCode = 1;
        return;
      }
      setAccountLabel(hit.account.id, label);
      if (wantJson) {
        emitOkJson({
          forgeHome: forgeHome(),
          id: hit.account.id,
          accountLabel: label.trim(),
        });
        return;
      }
      log.success(`Renamed ${hit.account.id} → ${label.trim()}`);
    });

  accountsCmd
    .command("priority")
    .description("Set auto-switch priority (higher = preferred)")
    .argument("<selector>", "Account id or label")
    .argument("<n>", "Priority integer (e.g. 10)")
    .option("--json", "Machine-readable JSON")
    .action((selector: string, nRaw: string, opts, command) => {
      const wantJson = flagJson(opts, command);
      const n = Number.parseInt(String(nRaw), 10);
      if (!Number.isFinite(n)) {
        failInvalidFlag(
          "invalid_priority",
          `Priority must be an integer (got "${nRaw}")`,
          { priority: nRaw },
          { json: wantJson },
        );
      }
      const hit = resolveAccountSelector(selector);
      if (!hit.ok) {
        if (wantJson) {
          emitFailJson({ reason: "account_not_found", error: hit.error });
        } else {
          log.error(hit.error);
        }
        process.exitCode = 1;
        return;
      }
      setAccountPriority(hit.account.id, n);
      if (wantJson) {
        emitOkJson({
          forgeHome: forgeHome(),
          id: hit.account.id,
          priority: n,
        });
        return;
      }
      log.success(`Priority for ${hit.account.id} → ${n}`);
    });

  accountsCmd
    .command("disable")
    .description("Disable an account (excluded from resolve/auto-switch)")
    .argument("<selector>", "Account id or label")
    .option("--json", "Machine-readable JSON")
    .action((selector: string, opts, command) => {
      const wantJson = flagJson(opts, command);
      const hit = resolveAccountSelector(selector);
      if (!hit.ok) {
        if (wantJson) {
          emitFailJson({ reason: "account_not_found", error: hit.error });
        } else {
          log.error(hit.error);
        }
        process.exitCode = 1;
        return;
      }
      setAccountDisabled(hit.account.id, true);
      if (wantJson) {
        emitOkJson({ forgeHome: forgeHome(), id: hit.account.id, disabled: true });
        return;
      }
      log.success(`Disabled ${hit.account.id}`);
    });

  accountsCmd
    .command("enable")
    .description("Re-enable a disabled account")
    .argument("<selector>", "Account id or label")
    .option("--json", "Machine-readable JSON")
    .action((selector: string, opts, command) => {
      const wantJson = flagJson(opts, command);
      const hit = resolveAccountSelector(selector);
      if (!hit.ok) {
        if (wantJson) {
          emitFailJson({ reason: "account_not_found", error: hit.error });
        } else {
          log.error(hit.error);
        }
        process.exitCode = 1;
        return;
      }
      setAccountDisabled(hit.account.id, false);
      if (wantJson) {
        emitOkJson({ forgeHome: forgeHome(), id: hit.account.id, disabled: false });
        return;
      }
      log.success(`Enabled ${hit.account.id}`);
    });

  accountsCmd
    .command("auto-switch")
    .description("Configure smart account switching on low usage / rate-limit")
    .argument("[mode]", "on | off | status (default: status)")
    .option(
      "--threshold <percent>",
      "Proactive switch when plan used% ≥ this (0–100)",
    )
    .option("--json", "Machine-readable JSON")
    .action((modeRaw: string | undefined, opts, command) => {
      const wantJson = flagJson(opts, command);
      const mode = (modeRaw || "status").trim().toLowerCase();
      if (mode === "on" || mode === "off" || mode === "enable" || mode === "disable") {
        setAutoSwitchSettings({
          autoSwitch: mode === "on" || mode === "enable",
        });
      } else if (mode !== "status" && mode !== "show" && mode !== "") {
        failInvalidFlag(
          "invalid_mode",
          `Unknown auto-switch mode "${modeRaw}". Use on|off|status.`,
          { mode: modeRaw },
          { json: wantJson },
        );
      }
      if (opts.threshold != null && opts.threshold !== "") {
        const t = Number(opts.threshold);
        if (!Number.isFinite(t) || t < 0 || t > 100) {
          failInvalidFlag(
            "invalid_threshold",
            `Threshold must be 0–100 (got "${opts.threshold}")`,
            { threshold: opts.threshold },
            { json: wantJson },
          );
        }
        setAutoSwitchSettings({ switchThresholdPercent: t });
      }
      const settings = getAutoSwitchSettings();
      if (wantJson) {
        emitOkJson({
          forgeHome: forgeHome(),
          autoSwitch: settings.autoSwitch,
          switchThresholdPercent: settings.switchThresholdPercent,
        });
        return;
      }
      log.info(
        `Auto-switch: ${settings.autoSwitch ? "on" : "off"}  threshold: ${settings.switchThresholdPercent}% used`,
      );
      log.dim(
        "When on: switches to another same-provider account on rate-limit/quota or when plan usage ≥ threshold.",
      );
    });

  // Default action for bare `forge accounts`
  accountsCmd.action((opts) => {
    const wantJson = Boolean(opts?.json);
    const accounts = listAccountSummaries();
    const settings = getAutoSwitchSettings();
    const readiness = assessMultiAccountReadiness();
    if (wantJson) {
      emitOkJson({
        forgeHome: forgeHome(),
        autoSwitch: settings.autoSwitch,
        switchThresholdPercent: settings.switchThresholdPercent,
        multiAccount: readiness,
        accounts,
        count: accounts.length,
      });
      return;
    }
    console.log(formatAccountsTable());
  });

  program
    .command("sessions")
    .description(
      "List, show, path, export, import, fork, pin/unpin, title, delete (--force if locked), prune, or search sessions",
    )
    .argument(
      "[action]",
      "list (default) | show <id> | path <id> | export <id> | import <file> | fork <id> | pin <id> | unpin <id> | title <id> <name> | delete <id> [--force] | prune | search <q>",
    )
    .argument("[id]", "Session id/prefix/title or import file path")
    .argument("[extra...]", "title: new label words (or clear|none|- to unset)")
    .option("--keep <n>", "Prune: keep newest N sessions (all|max = keep everything)", "50")
    .option("--max-age-days <n>", "Prune: also drop sessions older than N days (0/all/none = no age filter)")
    .option("--json", "Machine-readable JSON (list includes relativeAge)")
    .option("--out <path>", "Export: write artifact to file (mode 0600); omit → stdout (human) or envelope.body (--json)")
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
      "--errors",
      "List: only sessions with lastError (recovery backlog; aliases: errors|failed|err action)",
    )
    .option(
      "--untitled",
      "List: only sessions without a title (aliases: untitled|notitle|nameless action)",
    )
    .option(
      "--force-last-error",
      "Prune: also delete sessions that still carry lastError (default: keep for /sessions errors)",
    )
    .option(
      "-n, --limit <n>",
      "List limit (0/all/max = unlimited)",
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
      // Empty --cwd '' is never a valid workspace filter/import override.
      if (cwdExplicit && globalOpts.cwd != null && !String(globalOpts.cwd).trim()) {
        failInvalidFlag(
          "invalid_cwd",
          `Invalid --cwd "${globalOpts.cwd}". Pass a non-empty workspace path.`,
          { cwd: String(globalOpts.cwd) },
          { json: Boolean(globalOpts.json) },
        );
      }
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
            emitFailJson({
              deleted: false,
              reason: result.reason,
              id: result.id || null,
              sessionPath: result.id ? resolveSessionDir(result.id) : null,
              detail: result.detail || null,
            });
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
        if (globalOpts.json) emitOkJson({
              forgeHome: forgeHome(),
              deleted: true,
              id: result.id,
              // Path may already be gone; still report canonical location for audit.
              sessionPath: result.id
                ? path.join(forgeHome(), "sessions", result.id)
                : null,
            });
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
          emitOkJson(
            {
              forgeHome: forgeHome(),
              id: sid,
              dir,
              path: dir,
              sessionPath: dir,
              sessionJson: jsonPath,
              foreignLock,
            },
            true,
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
          emitOkJson({
                forgeHome: forgeHome(),
                meta: s.meta,
                relativeAge: formatRelativeTime(s.meta.updatedAt || s.meta.createdAt),
                todos: s.todos,
                messageCount: s.messages.length,
                path: dir,
                sessionPath: dir,
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
                ulw: (() => {
                  try {
                    const u = loadUlwCycle(s.meta.id);
                    if (!u?.enabled) return null;
                    const mandate = String(u.mandate || "").trim();
                    return {
                      cycle: u.cycle,
                      wave: u.wave,
                      blocks: u.blocks,
                      softPrompt: Boolean(u.softPrompt),
                      mandate: mandate
                        ? mandate.length > 200
                          ? `${mandate.slice(0, 200)}…`
                          : mandate
                        : null,
                    };
                  } catch {
                    return null;
                  }
                })(),
                goal: (() => {
                  try {
                    const g = loadGoal(s.meta.id);
                    if (!g || !g.objective) return null;
                    return {
                      status: g.status,
                      paused: Boolean(g.paused),
                      blocks: g.blocks,
                      stuckBlocks: g.stuckBlocks,
                      criteria: Array.isArray(g.criteria)
                        ? g.criteria.slice(0, 7).map((c) => {
                            const s = String(c || "").trim();
                            return s.length > 120 ? `${s.slice(0, 120)}…` : s;
                          })
                        : [],
                      objective:
                        g.objective.length > 200
                          ? `${g.objective.slice(0, 200)}…`
                          : g.objective,
                    };
                  } catch {
                    return null;
                  }
                })(),
                git: gitSnapshotForRun(s.meta.cwd || process.cwd()),
                projectHints: (() => {
                  try {
                    return detectProjectHints(s.meta.cwd || process.cwd());
                  } catch {
                    return [];
                  }
                })(),
                ...(() => {
                  const m = packageManifestForRun(s.meta.cwd || process.cwd());
                  return {
                    packageName: m.name,
                    packageVersion: m.version,
                    packageEnginesNode: m.enginesNode,
                  };
                })(),
              }, true);
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
          const tip = fmt
            ? suggestName(fmt, ["md", "markdown", "json"], {
                minLength: 2,
                minScore: 36,
                requirePrefix3: false,
              })
            : null;
          const shown = globalOpts.format != null ? String(globalOpts.format) : fmt;
          const msg = tip
            ? `Unknown export format "${shown}". Did you mean: ${tip}? Use md or json.`
            : `Unknown export format "${shown}". Use md or json.`;
          if (globalOpts.json) {
            emitFailJson({
              reason: "invalid_format",
              format: shown,
              error: msg,
              ...(tip ? { suggestion: tip } : {}),
            });
          } else {
            log.error(msg);
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
            emitFailJson({
              reason: "usage",
              error:
              "Export --out requires a file path (got empty). Example: --out ./session.md",
            });
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
                emitFailJson({
                  reason: "is_directory",
                  path: p,
                  error: `Export --out is a directory. Pass a file path (e.g. ${hint}).`,
                  hint,
                });
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
                emitFailJson({
                  reason: "write_failed",
                  path: p,
                  error: message,
                });
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
              emitFailJson({
                reason: "write_failed",
                path: p,
                error: message,
              });
            } else {
              log.error(`Export write failed: ${message}`);
            }
            process.exit(1);
          }
          if (globalOpts.json) {
            emitOkJson({forgeHome: forgeHome(),
                path: p,
                out: p,
                sessionPath: resolveSessionDir(s.meta.id),
                format: fmt,
                foreignLock,
              });
          } else log.success(`Exported ${fmt} → ${p}`);
        } else if (globalOpts.json) {
          // --json without --out: always structured envelope (never raw md on stdout).
          let parsedBody: unknown = body;
          if (fmt === "json") {
            try {
              parsedBody = JSON.parse(body);
            } catch {
              parsedBody = body;
            }
          }
          emitOkJson({
            forgeHome: forgeHome(),
            id: s.meta.id,
            path: resolveSessionDir(s.meta.id),
            sessionPath: resolveSessionDir(s.meta.id),
            title: s.meta.title || null,
            format: fmt === "markdown" ? "md" : fmt,
            foreignLock,
            body: parsedBody,
          });
        } else {
          // Human path without --out: emit the artifact on stdout (md/json body).
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
            emitFailJson({
              reason: "not_found",
              path: p,
            });
          } else {
            log.error(`File not found: ${p}`);
          }
          process.exit(1);
        }
        try {
          if (fs.statSync(p).isDirectory()) {
            if (globalOpts.json) {
              emitFailJson({
                reason: "is_directory",
                path: p,
                error:
                "Import path is a directory. Pass a session export .json file.",
              });
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
            emitFailJson({
              reason: "invalid",
              path: p,
              error: message,
            });
          } else {
            log.error(message);
          }
          process.exit(1);
        }
        try {
          let raw = fs.readFileSync(p, "utf8");
          // Accept forge sessions export --json envelope: { ok, body, format, id, ... }
          // Unwrap body when present so CI round-trips work without manual jq.
          try {
            const envelope = JSON.parse(raw) as {
              ok?: unknown;
              body?: unknown;
              format?: unknown;
              meta?: unknown;
              messages?: unknown;
            };
            if (
              envelope &&
              typeof envelope === "object" &&
              envelope.body != null &&
              !Array.isArray(envelope.messages) &&
              !envelope.meta
            ) {
              const fmt = String(envelope.format || "").toLowerCase();
              // Only auto-unwrap JSON session bodies. Markdown export envelopes
              // should fail with the markdown-import hint, not a confusing JSON parse.
              if (
                fmt === "json" ||
                (typeof envelope.body === "object" && envelope.body !== null)
              ) {
                raw =
                  typeof envelope.body === "string"
                    ? envelope.body
                    : JSON.stringify(envelope.body);
              } else if (fmt === "md" || fmt === "markdown") {
                throw new Error(
                  "Invalid session JSON: markdown export envelope is not importable. " +
                    "Re-export with --format json (or import a forge-session-v1 JSON file).",
                );
              }
            }
          } catch (err) {
            // Re-throw our markdown envelope error; ignore plain parse failures.
            if (
              err instanceof Error &&
              /markdown export envelope is not importable/i.test(err.message)
            ) {
              throw err;
            }
            /* not JSON envelope — importSessionJson will parse/validate */
          }
          // Only honor --cwd for import when explicitly passed (not parent default)
          const importCwd =
            cwdExplicit && globalOpts.cwd
              ? path.resolve(String(globalOpts.cwd))
              : undefined;
          const s = importSessionJson(raw, {
            cwd: importCwd,
          });
          if (globalOpts.json) {
            emitOkJson({
                forgeHome: forgeHome(),
                id: s.meta.id,
                path: resolveSessionDir(s.meta.id),
                sessionPath: resolveSessionDir(s.meta.id),
                title: s.meta.title,
                messageCount: s.messages.length,
                editCount: s.meta.editCount ?? 0,
                lastVerificationCommand:
                  s.meta.lastVerificationCommand ?? null,
                lastVerificationAt: s.meta.lastVerificationAt ?? null,
                lastEditAt: s.meta.lastEditAt ?? null,
                lastVerificationStale: isLastVerificationStale(s.meta),
              });
          } else {
            log.success(
              `Imported → ${s.meta.id} (${s.messages.length} msgs, ${s.todos.length} todos)`,
            );
            log.dim(
              `Resume with: forge --session ${s.meta.id.slice(0, 8)}  ·  or same-cwd: forge run "…" --continue`,
            );
            try {
              const peek = formatResumeOrientation(s, { compact: true });
              if (peek) log.dim(peek);
            } catch {
              /* */
            }
          }
        } catch (err) {
          let message = (err as Error).message || String(err);
          // Markdown exports are not importable — steer experts to --format json.
          // Skip when the error already names markdown recovery (envelope path).
          if (
            !/markdown/i.test(message) &&
            (/Unexpected token/i.test(message) ||
              /Invalid session JSON/i.test(message))
          ) {
            try {
              const head = fs.readFileSync(p, "utf8").slice(0, 80);
              if (head.startsWith("#") || head.startsWith("<!--") || /^\s*#\s*Forge session/i.test(head)) {
                message +=
                  "\nHint: markdown exports are not importable. Re-export with --format json (or import the export --json envelope body).";
              } else if (head.trimStart().startsWith("{")) {
                message +=
                  "\nHint: expected forge-session-v1 JSON with messages[]. If this is an export --json envelope, body must be the session object (auto-unwrapped when ok+body present).";
              }
            } catch {
              /* */
            }
          }
          if (globalOpts.json) {
            emitFailJson({
              reason: "invalid",
              path: p,
              error: message,
            });
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
          emitOkJson({forgeHome: forgeHome(),
              id: s.meta.id,
              path: resolveSessionDir(s.meta.id),
              sessionPath: resolveSessionDir(s.meta.id),
              pinned,
              title: s.meta.title || null,
              foreignLock,
            });
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
        if (!clear && labelRaw.length > MAX_SESSION_TITLE_CHARS) {
          failInvalidFlag(
            "invalid_title",
            `Invalid title (length ${labelRaw.length}). Pass at most ${MAX_SESSION_TITLE_CHARS} characters.`,
            { title: labelRaw.slice(0, 40) + "…", length: labelRaw.length },
            { json: Boolean(globalOpts.json) },
          );
        }
        const next = setSessionTitle(s, clear ? "" : labelRaw);
        if (globalOpts.json) {
          emitOkJson({forgeHome: forgeHome(),
              id: s.meta.id,
              path: resolveSessionDir(s.meta.id),
              sessionPath: resolveSessionDir(s.meta.id),
              title: next || null,
              foreignLock,
            });
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
          emitOkJson({
              forgeHome: forgeHome(),
              sourceId: s.meta.id,
              id: forked.meta.id,
              path: resolveSessionDir(forked.meta.id),
              sessionPath: resolveSessionDir(forked.meta.id),
              title: forked.meta.title,
              messageCount: forked.messages.length,
              sourceForeignLock,
              ulw: (() => {
                try {
                  const u = loadUlwCycle(forked.meta.id);
                  if (!u?.enabled) return null;
                  return {
                    cycle: u.cycle,
                    wave: u.wave,
                    softPrompt: Boolean(u.softPrompt),
                  };
                } catch {
                  return null;
                }
              })(),
              goal: (() => {
                try {
                  const g = loadGoal(forked.meta.id);
                  if (!g?.objective) return null;
                  return {
                    status: g.status,
                    paused: Boolean(g.paused),
                    blocks: g.blocks,
                    stuckBlocks: g.stuckBlocks,
                    criteria: Array.isArray(g.criteria)
                      ? g.criteria.slice(0, 7).map((c) => {
                          const s = String(c || "").trim();
                          return s.length > 120 ? `${s.slice(0, 120)}…` : s;
                        })
                      : [],
                    objective:
                      g.objective.length > 200
                        ? `${g.objective.slice(0, 200)}…`
                        : g.objective,
                  };
                } catch {
                  return null;
                }
              })(),
            });
        } else {
          let badge = "";
          try {
            const u = loadUlwCycle(forked.meta.id);
            if (u?.enabled) badge += ` ULW c=${u.cycle}`;
          } catch {
            /* */
          }
          try {
            const g = loadGoal(forked.meta.id);
            if (g?.objective && g.status === "active") {
              badge += g.paused ? " GOAL⏸" : " GOAL";
            }
          } catch {
            /* */
          }
          log.success(
            `Forked ${s.meta.id.slice(0, 8)} → ${forked.meta.id} (${forked.messages.length} msgs)${badge}`,
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
        // maxAgeDays: 0 = no age filter; omit → undefined (keep-only prune).
        // Explicit invalid/empty fails closed (parity with --keep).
        // all|none|off → 0 (no age filter) for expert muscle-memory.
        let maxAgeDays: number | undefined;
        if (globalOpts.maxAgeDays != null) {
          const rawAge = String(globalOpts.maxAgeDays).trim().toLowerCase();
          if (
            rawAge === "all" ||
            rawAge === "none" ||
            rawAge === "off" ||
            rawAge === "never"
          ) {
            maxAgeDays = 0;
          } else {
            const parsed = parseCliNonNegInt(globalOpts.maxAgeDays);
            if (parsed === null) {
              const tip = suggestToken(String(globalOpts.maxAgeDays ?? ""), [
                "0",
                "7",
                "14",
                "30",
                "all",
                "none",
                "off",
                "never",
              ]);
              failInvalidFlag(
                "invalid_max_age_days",
                tip
                  ? `Invalid --max-age-days "${globalOpts.maxAgeDays}". Did you mean: ${tip}? Pass a non-negative integer (0/all/none = no age filter).`
                  : `Invalid --max-age-days "${globalOpts.maxAgeDays}". Pass a non-negative integer (0/all/none = no age filter).`,
                {
                  maxAgeDays: String(globalOpts.maxAgeDays),
                  ...(tip ? { suggestion: tip } : {}),
                },
                { json: Boolean(globalOpts.json) },
              );
            }
            if (parsed !== undefined) maxAgeDays = parsed;
          }
        }
        const keep = requireCliKeepCount(
          globalOpts.keep,
          50,
          "--keep",
          "invalid_keep",
          { json: Boolean(globalOpts.json) },
        );
        const result = pruneSessions({
          // 0 is valid (keep none); Number(x)||50 wrongly treated 0 as missing
          keep,
          maxAgeDays,
          forceLastError: Boolean(globalOpts.forceLastError),
        });
        if (globalOpts.json) {
          emitOkJson(
            {
              forgeHome: forgeHome(),
              deleted: result.deleted,
              kept: result.kept,
              scanned: result.scanned,
              skippedLocked: result.skippedLocked,
              skippedPinned: result.skippedPinned,
              skippedLastError: result.skippedLastError,
              deletedWithLastError: result.deletedWithLastError,
              forceLastError: Boolean(globalOpts.forceLastError),
              keep,
              ...(maxAgeDays !== undefined ? { maxAgeDays } : {}),
            },
            true,
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
              (result.skippedLastError
                ? `; skipped ${result.skippedLastError} lastError`
                : "") +
              (result.deletedWithLastError
                ? `; deleted ${result.deletedWithLastError} with lastError`
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
        "errors",
        "error",
        "failed",
        "fail",
        "err",
        "untitled",
        "notitle",
        "nameless",
        // list filters (parity with /sessions pinned · --pinned)
        "pinned",
        "pins",
        "pin",
        "unpin",
        "title",
        "rename",
        "delete",
        "rm",
        "remove",
        "prune",
        // search aliases (parity with /sessions search) — not bare title queries
        "search",
        "find",
        "q",
      ]);
      // 0 = unlimited (not coerced to 30 via Number(x)||default).
      // Positive values above 10_000 fail closed (typos like 100000); use 0/all for unlimited.
      let limit: number;
      {
        const rawLim =
          globalOpts.limit != null
            ? String(globalOpts.limit).trim().toLowerCase()
            : "";
        if (
          rawLim === "all" ||
          rawLim === "max" ||
          rawLim === "full" ||
          rawLim === "unlimited"
        ) {
          limit = 0;
        } else {
          limit = requireCliCount(
            globalOpts.limit,
            30,
            "--limit",
            "invalid_limit",
            {
              json: Boolean(globalOpts.json),
              aliasCandidates: ["all", "max", "0", "10", "30", "50", "100"],
            },
          );
        }
      }
      if (limit > 10_000) {
        failInvalidFlag(
          "invalid_limit",
          `Invalid --limit "${globalOpts.limit}". Pass 0/all (unlimited) or 1–10000.`,
          { value: String(globalOpts.limit ?? limit), limit },
          { json: Boolean(globalOpts.json) },
        );
      }
      // Only filter when --cwd was explicitly passed (parent default cwd is ignored).
      // listSessions applies cwd/query before limit so multi-project lists stay complete.
      const cwdFilter =
        cwdExplicit && globalOpts.cwd
          ? path.resolve(String(globalOpts.cwd))
          : null;
      // Empty -q/--query '' is invalid when the flag is present (not "no filter").
      const queryExplicit =
        command.getOptionValueSource?.("query") === "cli" ||
        command.parent?.getOptionValueSource?.("query") === "cli";
      if (
        queryExplicit &&
        globalOpts.query != null &&
        !String(globalOpts.query).trim()
      ) {
        failInvalidFlag(
          "invalid_query",
          `Invalid --query "${globalOpts.query}". Pass a non-empty search string, or omit -q.`,
          { query: String(globalOpts.query) },
          { json: Boolean(globalOpts.json) },
        );
      }
      let queryFilter =
        typeof globalOpts.query === "string" && globalOpts.query.trim()
          ? globalOpts.query.trim()
          : null;
      // forge sessions search|find|q <text> — first-class (parity with /sessions search).
      // Without this, `search` was an unknown action typo→search then never applied the query.
      if (act === "search" || act === "find" || act === "q") {
        const parts = [id, ...(extra || [])].filter(
          (p): p is string => typeof p === "string" && p.trim().length > 0,
        );
        const q = parts.join(" ").trim();
        if (!q) {
          failUsage("Usage: forge sessions search <id-or-title-substring>", {
            json: Boolean(globalOpts.json),
          });
        }
        if (queryFilter && queryFilter !== q) {
          // Prefer explicit positional search text over -q when both present.
        }
        queryFilter = q;
      }
      // Close typos of known actions fail closed (prun→prune, serach→search)
      // even when a second arg is present — never treat "serach x" as a title query.
      // Also: `forge sessions login` must not silently search for "login".
      // Prefer exact top-level command names over weak session-action edit distance
      // (e.g. "auth" must not become "path").
      if (action && !knownSessionActions.has(act)) {
        const topHit = (TOP_LEVEL_COMMANDS as readonly string[]).find(
          (c) => c.toLowerCase() === act,
        );
        if (topHit) {
          failInvalidFlag(
            "unknown_session_action",
            `Unknown sessions action "${action}". Did you mean: forge ${topHit}?`,
            {
              action: String(action),
              suggestion: topHit,
              hint: `forge ${topHit} --help`,
            },
            { json: Boolean(globalOpts.json) },
          );
        }
        const tip = suggestSessionAction(act);
        if (tip) {
          failInvalidFlag(
            "unknown_session_action",
            `Unknown sessions action "${action}". Did you mean: ${tip}?`,
            { action: String(action), suggestion: tip },
            { json: Boolean(globalOpts.json) },
          );
        }
      }
      if (
        !queryFilter &&
        action &&
        !knownSessionActions.has(act) &&
        !id
      ) {
        queryFilter = String(action).trim();
      }
      const pinnedOnly =
        Boolean(globalOpts.pinned) ||
        act === "pinned" ||
        act === "pins";
      // Note: act === "pin" is the pin/unpin mutation path above, not list filter.
      const errorsOnly =
        Boolean(globalOpts.errors) ||
        act === "errors" ||
        act === "error" ||
        act === "failed" ||
        act === "fail" ||
        act === "err";
      const untitledOnly =
        Boolean(globalOpts.untitled) ||
        act === "untitled" ||
        act === "notitle" ||
        act === "nameless";
      let list = listSessions({
        limit:
          (errorsOnly || untitledOnly || pinnedOnly) && limit === 30
            ? 50
            : limit,
        ...(cwdFilter ? { cwd: cwdFilter } : {}),
        ...(queryFilter ? { query: queryFilter } : {}),
        ...(pinnedOnly ? { pinned: true } : {}),
      });
      if (errorsOnly) {
        list = list.filter((s) => Boolean(s.lastError?.message));
      }
      if (untitledOnly) {
        list = list.filter((s) => !String(s.title || "").trim());
      }
      if (globalOpts.json) {
        // Global inventory (unfiltered) so CI/experts can prune without doctor.
        let sessionsTotal = 0;
        let sessionsUntitled = 0;
        let sessionsWithLastError = 0;
        let sessionsPinned = 0;
        try {
          const all = listSessions({ limit: 10_000 });
          sessionsTotal = all.length;
          sessionsUntitled = all.filter(
            (s) => !String(s.title || "").trim(),
          ).length;
          sessionsWithLastError = all.filter((s) =>
            Boolean(s.lastError?.message),
          ).length;
          sessionsPinned = all.filter((s) => Boolean(s.pinned)).length;
        } catch {
          /* */
        }
        emitOkJson({forgeHome: forgeHome(),
              cwd: cwdFilter,
              query: queryFilter,
              errorsOnly,
              untitledOnly,
              pinnedOnly,
              limit,
              count: list.length,
              sessionsTotal,
              sessionsUntitled,
              sessionsWithLastError,
              sessionsPinned,
              sessions: list.map((s) => {
                const lock = readSessionLock(s.id);
                const foreignLock = sessionHasForeignLiveLock(s.id);
                let ulwCycle: number | null = null;
                let ulwWave: number | null = null;
                let ulwMaxWaves: number | null = null;
                let goalActive = false;
                try {
                  const u = loadUlwCycle(s.id);
                  if (u?.enabled) {
                    ulwCycle = u.cycle;
                    ulwWave = u.wave;
                    ulwMaxWaves = u.maxWaves ?? null;
                  }
                } catch {
                  /* */
                }
                try {
                  const g = loadGoal(s.id);
                  goalActive = Boolean(
                    g && g.status === "active" && !g.paused && g.objective,
                  );
                } catch {
                  /* */
                }
                return {
                  ...s,
                  path: resolveSessionDir(s.id),
                  sessionPath: resolveSessionDir(s.id),
                  relativeAge: formatRelativeTime(s.updatedAt || s.createdAt),
                  foreignLock,
                  lock: lock
                    ? {
                        pid: lock.pid,
                        hostname: lock.hostname,
                        acquiredAt: lock.acquiredAt,
                        holder: formatLockHolder(lock),
                      }
                    : null,
                  ulwCycle,
                  ulwWave,
                  ulwMaxWaves,
                  goalActive,
                  totalPromptTokens: s.totalPromptTokens || 0,
                  totalCompletionTokens: s.totalCompletionTokens || 0,
                  estCostUsd: estimateCostUsd(
                    s.provider || "xai",
                    s.totalPromptTokens || 0,
                    s.totalCompletionTokens || 0,
                    s.model,
                    s.totalCacheReadTokens || 0,
                  ),
                  maxCostUsd:
                    s.maxCostUsd !== undefined && s.maxCostUsd !== null
                      ? s.maxCostUsd
                      : null,
                  lastError: s.lastError
                    ? {
                        at: s.lastError.at,
                        code: s.lastError.code,
                        message: s.lastError.message,
                        tips: s.lastError.tips,
                      }
                    : null,
                };
              }),
            }, true);
        return;
      }
      if (!list.length) {
        if (errorsOnly) {
          console.log(
            "No sessions with lastError. Provider failures stamp ERR on list and forge status.",
          );
          return;
        }
        if (untitledOnly) {
          console.log(
            "No untitled sessions. /title · --title · /goal set auto-titles new ones.",
          );
          return;
        }
        if (pinnedOnly) {
          console.log(
            "No pinned sessions. forge sessions pin <id> · /pin protects from prune.",
          );
          return;
        }
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
      list.forEach((s, i) => {
        const extras: string[] = [];
        const lock = readSessionLock(s.id);
        if (lock && sessionHasForeignLiveLock(s.id)) extras.push("LOCK");
        try {
          const g = loadGoal(s.id);
          if (g?.objective && g.status === "active" && !g.paused) extras.push("GOAL");
          else if (g?.paused) extras.push("GOAL⏸");
        } catch {
          /* */
        }
        if (s.parentSessionId) extras.push("FORK");
        console.log(formatNumberedPickerRow(i, s, extras));
      });
      const filterNotes: string[] = [];
      if (cwdFilter) filterNotes.push(`cwd=${cwdFilter}`);
      if (queryFilter) filterNotes.push(`q=${JSON.stringify(queryFilter)}`);
      if (pinnedOnly) filterNotes.push("pinned");
      if (errorsOnly) filterNotes.push("errors");
      if (untitledOnly) filterNotes.push("untitled");
      let invNote = "";
      try {
        // Cheap inventory hint on human list (best-effort; never fail list).
        const all = listSessions({ limit: 10_000 });
        const total = all.length;
        const untitled = all.filter((s) => !String(s.title || "").trim()).length;
        const errs = all.filter((s) => Boolean(s.lastError?.message)).length;
        const pinned = all.filter((s) => Boolean(s.pinned)).length;
        if (total >= 100 || untitled >= 5 || errs >= 3 || pinned >= 10) {
          invNote =
            `  ·  inventory ${total} total · ${untitled} untitled · ${errs} lastError` +
            (pinned ? ` · ${pinned} pinned` : "");
        }
      } catch {
        /* */
      }
      console.log(
        chalk.dim(
          `\n  forge sessions show|export|import|fork|title|delete <id> [--force]  ·  prune --keep 50` +
            (filterNotes.length
              ? `  ·  filtered ${filterNotes.join(" ")}`
              : "  ·  list --cwd <path> · list -q <text>") +
            invNote,
        ),
      );
    },
    );

  program
    .command("init")
    .description("Write default config and example hooks into ~/.forge and .forge/")
    .option("--json", "Machine-readable JSON ({ ok, wrote[], existed[] })")
    .action(
      async (
        opts: { json?: boolean },
        command?: { optsWithGlobals?: () => Record<string, unknown> },
      ) => {
        const wantJson = flagJson(opts as Record<string, unknown>, command);
        ensureHome();
        const result = await runForgeInit({
          cwd: process.cwd(),
          quiet: wantJson,
        });
        if (wantJson) {
          emitOkJson({
            home: result.home,
            cwd: result.cwd,
            wrote: result.wrote,
            existed: result.existed,
            lspEnsure: result.lspEnsure,
            next: ["forge login", "forge setup", "forge doctor", "forge"],
          }, true);
          return;
        }
        log.info("Done. Next: forge login && forge setup && forge doctor && forge");
        log.dim(
          'Docs: docs/GETTING-STARTED.md · docs/LSP.md · forge lsp ensure · eval "$(forge completion bash)"',
        );
      },
    );

  program
    .command("setup")
    .description("First-day checklist: auth, model, budget, notify, AGENTS.md, LSP")
    .option("--json", "Machine-readable JSON ({ ok, ready, total, items[] })")
    .action(
      async (
        opts: { json?: boolean },
        command?: { optsWithGlobals?: () => Record<string, unknown> },
      ) => {
        const wantJson = flagJson(opts as Record<string, unknown>, command);
        ensureHome();
        const config = loadConfig();
        const auth = await resolveAuthFresh(config);
        const assessed = await collectSetupAssessment({
          config,
          auth: auth ?? null,
        });
        if (wantJson) {
          emitOkJson(
            setupJsonPayload(assessed, {
              forgeHome: forgeHome(),
              provider: config.provider,
              model: config.model,
              authenticated: Boolean(auth),
            }),
            true,
          );
          return;
        }
        console.log(formatSetupCard(assessed));
        if (!auth) {
          log.dim("Not signed in — forge login  ·  then forge setup");
        }
      },
    );

  program
    .command("lsp")
    .description(
      "Language servers: status, detect, ensure (auto-install TS/Python + project Rust/Go)",
    )
    .argument(
      "[action]",
      "status | ensure | detect | install (default: status)",
      "status",
    )
    .option("--dry-run", "With ensure: plan only, do not install")
    .option("-y, --yes", "With ensure: force install (default for ensure)")
    .option(
      "--only <langs>",
      "Comma-separated language ids (typescript,python,rust,go)",
    )
    .option("--json", "Machine-readable JSON")
    .action(
      async (
        action: string,
        opts: {
          dryRun?: boolean;
          yes?: boolean;
          only?: string;
          json?: boolean;
        },
        command?: { optsWithGlobals?: () => Record<string, unknown> },
      ) => {
        const wantJson = flagJson(opts as Record<string, unknown>, command);
        const act = (action || "status").trim().toLowerCase();
        const cwd = process.cwd();
        const {
          buildEnsurePlan,
          ensureLspServers,
          formatEnsurePlan,
          formatEnsureResult,
          formatFullInstallGuide,
        } = await import("./lsp/ensure.js");
        const { detectProjectLanguages } = await import("./lsp/detect.js");
        const { LspManager, formatLspStatus } = await import(
          "./lsp/manager.js"
        );

        if (act === "detect") {
          const detected = detectProjectLanguages(cwd);
          const plan = buildEnsurePlan(cwd);
          if (wantJson) {
            emitOkJson(
              {
                action: "detect",
                detected,
                toInstall: plan.toInstall.map((i) => i.languageId),
                ready: plan.ready.map((i) => i.languageId),
              },
              true,
            );
            return;
          }
          console.log(
            "Detected:\n" +
              detected
                .map(
                  (d) =>
                    `  ${d.languageId}  [${d.tier}]  ${d.reasons.slice(0, 2).join("; ")}`,
                )
                .join("\n") +
              "\n\n" +
              formatEnsurePlan(plan),
          );
          return;
        }

        if (act === "install" || act === "recipes" || act === "help") {
          if (wantJson) {
            emitOkJson(
              { action: "install", guide: formatFullInstallGuide(cwd) },
              true,
            );
            return;
          }
          console.log(formatFullInstallGuide(cwd));
          return;
        }

        if (act === "ensure" || act === "fix" || act === "auto") {
          const only = opts.only
            ? opts.only.split(/[,\s]+/).filter(Boolean)
            : undefined;
          if (opts.dryRun) {
            const plan = buildEnsurePlan(cwd);
            if (wantJson) {
              emitOkJson(
                {
                  action: "ensure",
                  dryRun: true,
                  toInstall: plan.toInstall,
                  ready: plan.ready,
                  tips: plan.tips,
                },
                true,
              );
              return;
            }
            console.log(formatEnsurePlan(plan));
            return;
          }
          const logs: string[] = [];
          const result = await ensureLspServers({
            workspace: cwd,
            forceInstall: true,
            only,
            onLog: (line) => {
              logs.push(line);
              if (!wantJson) console.error(line);
            },
          });
          if (wantJson) {
            emitOkJson(
              {
                action: "ensure",
                installed: result.installed,
                failed: result.failed,
                ready: result.plan.ready.map((r) => r.languageId),
                toInstall: result.plan.toInstall.map((r) => r.languageId),
              },
              result.failed.length === 0,
            );
            return;
          }
          console.log(formatEnsureResult(result));
          if (result.failed.length) process.exitCode = 1;
          return;
        }

        // status (default)
        const manager = new LspManager({ workspace: cwd });
        const plan = buildEnsurePlan(cwd);
        if (wantJson) {
          emitOkJson(
            {
              action: "status",
              servers: manager.status(),
              ensure: {
                ready: plan.ready.map((r) => r.languageId),
                toInstall: plan.toInstall.map((r) => r.languageId),
                tips: plan.tips.map((t) => t.tip || t.installHint),
              },
            },
            true,
          );
          return;
        }
        console.log(formatLspStatus(manager));
        console.log("");
        console.log(formatEnsurePlan(plan));
      },
    );

  program
    .command("models")
    .description("List known models for configured providers (OpenRouter / xAI / Cursor merge remote catalogs when available)")
    .option("-p, --provider <provider>", "Filter to one provider (xai|anthropic|openai|openrouter|deepseek|google|copilot|cursor|custom)")
    .option("--refresh", "Refresh OpenRouter / xAI / Cursor remote model catalog")
    .option("--json", "Machine-readable JSON")
    .action(async (opts, command) => {
      const wantJson = flagJson(opts, command);
      // Parent also defines -p/--provider; merge so `forge -p xai models` works.
      const globals = (command?.optsWithGlobals?.() || {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...globals, ...opts, json: wantJson };
      {
        const localSrc = command?.getOptionValueSource?.("provider");
        const parentSrc = command?.parent?.getOptionValueSource?.("provider");
        if (parentSrc === "cli" && localSrc !== "cli" && "provider" in globals) {
          merged.provider = globals.provider;
        } else if (localSrc === "cli" && "provider" in opts) {
          merged.provider = opts.provider;
        }
      }
      // Fail closed on empty/invalid -p (including parent) before listing.
      // buildConfig validates provider when present; loadConfig alone ignores -p.
      const config =
        merged.provider != null ? buildConfig(merged) : loadConfig();
      const { buildModelCatalog } = await import("./config/model-catalog.js");
      const refresh = Boolean(opts.refresh);
      let rows = await Promise.all(
        Object.entries(config.providers).map(async ([id, p]) => {
          let models =
            p.models?.length ? [...p.models] : p.defaultModel ? [p.defaultModel] : [];
          let remoteCount = 0;
          let freeForm = false;
          if (id === "openrouter" || id === "xai" || id === "cursor" || refresh) {
            try {
              const store = await import("./auth/store.js");
              const apiKey =
                id === "openrouter"
                  ? process.env.OPENROUTER_API_KEY?.trim() ||
                    store.getCredential("openrouter")?.accessToken
                  : id === "xai"
                    ? process.env.XAI_API_KEY?.trim() ||
                      store.getCredential("xai")?.accessToken
                    : id === "cursor"
                      ? process.env.CURSOR_API_KEY?.trim() ||
                        process.env.CURSOR_ACCESS_TOKEN?.trim() ||
                        store.getCredential("cursor")?.accessToken
                      : undefined;
              const cat = await buildModelCatalog(config, id, {
                refreshRemote:
                  id === "openrouter" ||
                  id === "xai" ||
                  id === "cursor" ||
                  refresh,
                apiKey,
                useCache: true,
              });
              models = cat.ids;
              remoteCount = cat.remoteCount;
              freeForm = cat.freeForm;
            } catch {
              /* keep static */
            }
          } else {
            const { providerAllowsFreeFormModels, recentModelsForProvider } =
              await import("./config/model-catalog.js");
            freeForm = providerAllowsFreeFormModels(id);
            const recent = recentModelsForProvider(id);
            if (recent.length) {
              models = [...new Set([...recent, ...models])];
            }
          }
          return {
            provider: id,
            defaultModel: p.defaultModel || null,
            supportsOAuth: Boolean(p.supportsOAuth),
            models,
            freeForm,
            remoteCount,
            baseUrl: p.baseUrl || null,
          };
        }),
      );
      if (merged.provider != null) {
        const want = String(config.provider || "").toLowerCase();
        rows = rows.filter((r) => r.provider.toLowerCase() === want);
        if (!rows.length) {
          // Known provider id but not in config.providers (shouldn't happen for stock ids)
          failInvalidFlag(
            "invalid_provider",
            `No models entry for provider "${config.provider}".`,
            { provider: String(config.provider) },
            { json: wantJson },
          );
        }
      }
      if (wantJson) {
        emitOkJson(
          {
            forgeHome: forgeHome(),
            ...(merged.provider != null
              ? { provider: config.provider }
              : {}),
            providers: rows,
          },
          true,
        );
        return;
      }
      for (const r of rows) {
        const models = r.models.length
          ? r.models.length > 24
            ? `${r.models.slice(0, 24).join(", ")} …(+${r.models.length - 24})`
            : r.models.join(", ")
          : r.defaultModel || "(any)";
        const flags =
          (r.freeForm ? " free-form" : "") +
          (r.remoteCount ? ` remote=${r.remoteCount}` : "");
        console.log(
          `${r.provider.padEnd(12)} default=${String(r.defaultModel || "").padEnd(28)} oauth=${r.supportsOAuth ? "yes" : "no "}${flags}  models: ${models}`,
        );
      }
      if (rows.some((r) => r.provider === "openrouter")) {
        console.log(
          chalk.dim(
            "OpenRouter: free-form ids work · forge models -p openrouter --refresh · REPL: /provider openrouter · /model <id>",
          ),
        );
      }
      if (rows.some((r) => r.provider === "xai")) {
        console.log(
          chalk.dim(
            "xAI: grok-4.6 default · newer grok-*.* ids inherit latest flagship effort/context · forge models -p xai --refresh",
          ),
        );
      }
      if (rows.some((r) => r.provider === "cursor")) {
        console.log(
          chalk.dim(
            "Cursor: native quota · cursor-grok-4.6-xhigh-fast default · forge models -p cursor --refresh · forge login -p cursor",
          ),
        );
      }
    });

  program
    .command("completion")
    .description("Print shell completion script (bash|zsh|fish)")
    .argument("[shell]", "bash | zsh | fish", "bash")
    .option("--json", "Machine-readable JSON (shell name + script, or error)")
    .action(
      (
        shell: string,
        opts: { json?: boolean },
        command?: { optsWithGlobals?: () => Record<string, unknown> },
      ) => {
        const wantJson = flagJson(opts as Record<string, unknown>, command);
        const normalized = normalizeCompletionShell(shell);
        if (!normalized) {
          const rawShell = String(shell ?? "");
          const tip = rawShell.trim()
            ? suggestName(rawShell.trim(), ["bash", "zsh", "fish"], {
                minLength: 2,
                minScore: 30,
                requirePrefix3: false,
              })
            : null;
          const msg = tip
            ? `Unknown completion shell "${shell}". Did you mean: ${tip}? Use bash, zsh, or fish.`
            : `Unknown completion shell "${shell}". Use bash, zsh, or fish.`;
          if (wantJson) {
            emitFailJson({
              reason: "invalid_shell",
              shell: rawShell,
              error: msg,
              supported: ["bash", "zsh", "fish"],
              ...(tip ? { suggestion: tip } : {}),
            });
          } else {
            log.error(msg);
          }
          process.exit(1);
        }
        const script = shellCompletionScript(normalized);
        if (wantJson) {
          emitOkJson({ forgeHome: forgeHome(), shell: normalized, script }, true);
        } else {
          console.log(script);
        }
      },
    );

  program
    .command("prune-tool-output")
    .description("Prune ~/.forge/tool-output full dumps (disk hygiene)")
    .option("--keep <n>", "Keep newest N files", "80")
    .option("--max-age-days <n>", "Also drop files older than N days (0/all/none = no age filter)", "14")
    .option("--json", "Machine-readable JSON")
    .action((opts, command) => {
      const before = toolOutputStats();
      let toolMaxAge = 14;
      const maxAgeFromCli = command?.getOptionValueSource?.("maxAgeDays") === "cli";
      if (maxAgeFromCli) {
        const rawAge = String(opts.maxAgeDays ?? "").trim().toLowerCase();
        if (!rawAge) {
          failInvalidFlag(
            "invalid_max_age_days",
            'Invalid --max-age-days "". Pass a non-negative integer, or all|none|off|never (0 = no age filter).',
            { value: String(opts.maxAgeDays ?? "") },
            { json: flagJson(opts, command) },
          );
        }
        if (
          rawAge === "all" ||
          rawAge === "none" ||
          rawAge === "off" ||
          rawAge === "never"
        ) {
          toolMaxAge = 0;
        } else {
          toolMaxAge = requireCliCount(
            opts.maxAgeDays,
            14,
            "--max-age-days",
            "invalid_max_age_days",
            {
              json: flagJson(opts, command),
              aliasCandidates: ["0", "7", "14", "30", "all", "none", "off", "never"],
            },
          );
        }
      }
      const result = pruneToolOutputsSync({
        // 0 is valid (delete all eligible dumps)
        keep: requireCliKeepCount(opts.keep, 80, "--keep", "invalid_keep", { json: flagJson(opts, command) }),
        // 0 = no age filter; default 14 when unset
        maxAgeDays: toolMaxAge,
      });
      if (flagJson(opts, command)) {
        emitOkJson({ forgeHome: forgeHome(), before, ...result, after: toolOutputStats() }, true);
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
      const result = pruneMetrics({ keep: requireCliKeepCount(opts.keep, 500, "--keep", "invalid_keep", { json: flagJson(opts, command) }) });
      if (flagJson(opts, command)) {
        emitOkJson({ forgeHome: forgeHome(), before, ...result }, true);
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
    .option(
      "-n, --lines <n>",
      "Number of recent events (0/all/max = all in window)",
      "30",
    )
    .option("--path", "Print log file path only")
    .option("--json", "Machine-readable JSON { ok, path, count, limit, events }")
    .action(async (opts, command) => {
      if (opts.path) {
        console.log(sandboxLogPath());
        return;
      }
      // 0 = all events in the 512 KiB window. Explicit invalid/empty fails closed.
      // all|max|full → 0 shared with /logs (parseLogsLines).
      // Default 30 only when --lines is omitted (Commander default).
      let n = 30;
      const linesFromCli = command?.getOptionValueSource?.("lines") === "cli";
      if (linesFromCli) {
        const raw = String(opts.lines ?? "");
        if (!raw.trim()) {
          failInvalidFlag(
            "invalid_lines",
            `Invalid --lines "${opts.lines}". Pass ${logsLinesHelp()}.`,
            { value: raw },
            { json: flagJson(opts, command) },
          );
        }
        const parsed = parseLogsLines(opts.lines);
        if (!parsed.ok) {
          const tip = suggestToken(raw, ["0", "all", "max", "full", "30", "50", "100", "200"]);
          failInvalidFlag(
            "invalid_lines",
            tip
              ? `Invalid --lines "${opts.lines}". Did you mean: ${tip}? Pass ${logsLinesHelp()}.`
              : `Invalid --lines "${opts.lines}". Pass ${logsLinesHelp()}.`,
            { value: raw, ...(tip ? { suggestion: tip } : {}) },
            { json: flagJson(opts, command) },
          );
        }
        n = parsed.lines;
      }
      if (flagJson(opts, command)) {
        const { readSandboxLogTail } = await import("./agent/sandbox-log.js");
        const events = readSandboxLogTail(n);
        emitOkJson(
          {
            forgeHome: forgeHome(),
            path: sandboxLogPath(),
            count: events.length,
            limit: n,
            events,
          },
          true,
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
    .option("--max-turns <n>", "Cap agent turns override (0 = unlimited)")
    .option("--max-cost <usd>", "Cap session spend estimate USD (0 = unlimited)")
    .option("--cwd <path>", "Workspace", process.cwd())
    .action((opts, command) => {
      const wantJson = flagJson(opts, command);
      // Parent also defines -p/--provider/-m/--model/--cwd; merge CLI-sourced
      // values so empty strings fail closed (parity with doctor).
      const globals = (command?.optsWithGlobals?.() || {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...globals, ...opts, json: wantJson };
      for (const key of [
        "provider",
        "model",
        "cwd",
        "maxTurns",
        "maxCost",
        "sandbox",
        "sandboxMissing",
        "sandboxNetwork",
        "readOutside",
        "permissionMode",
        "blockingStop",
        "noBlockingStop",
      ] as const) {
        const localSrc = command?.getOptionValueSource?.(key);
        const parentSrc = command?.parent?.getOptionValueSource?.(key);
        if (parentSrc === "cli" && localSrc !== "cli" && key in globals) {
          merged[key] = globals[key];
        } else if (localSrc === "cli" && key in opts) {
          merged[key] = opts[key];
        } else if (localSrc !== "cli" && parentSrc !== "cli") {
          // Drop default cwd so buildConfig does not treat default as explicit.
          if (key === "cwd") delete merged.cwd;
        }
      }
      const config = buildConfig(merged);
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
    .option("--days <n>", "Only metrics from the last N days (0/all=all time; week|month|today|7d)")
    .option("--json", "Machine-readable JSON")
    .action((opts, command) => {
      // Omit --days → all time (0). Explicit empty/invalid → invalid_days.
      // all|week|month|today|Nd aliases shared with /stats (parseDaysWindow).
      let days = 0;
      if (opts.days != null) {
        const parsed = parseDaysWindow(opts.days);
        if (!parsed.ok) {
          const tip = suggestToken(String(opts.days ?? ""), [
            "0",
            "7",
            "14",
            "30",
            "all",
            "week",
            "month",
            "today",
            "7d",
          ]);
          failInvalidFlag(
            "invalid_days",
            tip
              ? `Invalid --days "${opts.days}". Did you mean: ${tip}? Pass a ${daysWindowHelp()} (0 = all time).`
              : `Invalid --days "${opts.days}". Pass a ${daysWindowHelp()} (0 = all time).`,
            { days: String(opts.days), ...(tip ? { suggestion: tip } : {}) },
            { json: flagJson(opts, command) },
          );
        }
        days = parsed.days;
      }
      const stats = collectUsageStats({ days });
      if (flagJson(opts, command)) {
        emitOkJson({ forgeHome: forgeHome(), ...stats }, true);
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
    .option("--json", "Machine-readable JSON ({ ok, tips })")
    .action(
      (
        opts: { json?: boolean },
        command?: { optsWithGlobals?: () => Record<string, unknown> },
      ) => {
        const tips = formatExpertTips();
        if (flagJson(opts as Record<string, unknown>, command)) {
          const lines = expertTipsLines();
          emitOkJson(
            {
              forgeHome: forgeHome(),
              tips,
              lines,
              sections: lines
                .filter((l) => l.startsWith("  "))
                .map((l) => {
                  const m = l.match(/^\s+([^:]+):/);
                  return m ? m[1].trim() : l.trim();
                }),
            },
            true,
          );
          return;
        }
        console.log(tips);
      },
    );

  program
    .command("news")
    .alias("changelog")
    .description("What's new — highlights from packaged CHANGELOG.md")
    .argument("[count]", "How many recent releases to show (1–10, or all|full|max; default 1)")
    .option("--json", "Machine-readable JSON releases")
    .action(
      (
        countArg: string | undefined,
        opts: { json?: boolean },
        command?: { optsWithGlobals?: () => Record<string, unknown> },
      ) => {
        // Explicit invalid/empty count fails closed; omit → 1.
        // all|full|max|latest shared with /news (parseNewsCount).
        let n = 1;
        if (countArg !== undefined) {
          const rawCount = String(countArg);
          if (!rawCount.trim()) {
            failInvalidFlag(
              "invalid_count",
              `Invalid news count "${countArg}". Pass a ${newsCountHelp()}.`,
              { count: rawCount },
              { json: flagJson(opts as Record<string, unknown>, command) },
            );
          }
          const parsed = parseNewsCount(countArg);
          if (!parsed.ok) {
            const tip = suggestToken(rawCount, ["1", "3", "5", "10", "all", "full", "max", "latest"]);
            failInvalidFlag(
              "invalid_count",
              tip
                ? `Invalid news count "${countArg}". Did you mean: ${tip}? Pass a ${newsCountHelp()}.`
                : `Invalid news count "${countArg}". Pass a ${newsCountHelp()}.`,
              { count: rawCount, ...(tip ? { suggestion: tip } : {}) },
              { json: flagJson(opts as Record<string, unknown>, command) },
            );
          }
          n = parsed.count;
        }
        if (flagJson(opts as Record<string, unknown>, command)) {
          const releases = loadChangelogReleases().slice(0, n);
          emitOkJson({ forgeHome: forgeHome(), count: releases.length, releases }, true);
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
    .option("--max-turns <n>", "Cap agent turns override (0 = unlimited)")
    .option("--max-cost <usd>", "Cap session spend estimate USD (0 = unlimited)")
    .option(
      "--sandbox <profile>",
      "What-if OS sandbox: off|workspace|read-only|strict",
    )
    .option(
      "--sandbox-missing <mode>",
      "What-if missing backend: fail-closed|fallback",
    )
    .option(
      "--sandbox-network <mode>",
      "What-if bash network: unrestricted|blocked",
    )
    .option(
      "--read-outside <mode>",
      "What-if outside reads: ask|allow|deny",
    )
    .option(
      "--permission-mode <mode>",
      "What-if permission mode (yolo/plan/…)",
    )
    .option(
      "--no-blocking-stop",
      "What-if: disable blocking Stop hooks",
    )
    .option("--json", "Machine-readable summary on stdout")
    .action(async (opts, command) => {
      const wantJson = flagJson(opts, command);
      // Parent also defines -p/--provider/--cwd; merge so flags bind either place.
      // Prefer CLI-sourced values over doctor defaults / parent defaults.
      const globals = (command?.optsWithGlobals?.() || {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...globals, ...opts, json: wantJson };
      for (const key of [
        "provider",
        "cwd",
        "maxTurns",
        "maxCost",
        "sandbox",
        "sandboxMissing",
        "sandboxNetwork",
        "readOutside",
        "permissionMode",
        "blockingStop",
        "noBlockingStop",
      ] as const) {
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
        const check = await runDoctorCheck(config);
        // Prefer fresh auth (matches doctor report) for describeAuth field
        const auth =
          (await resolveAuthFresh(config).catch(() => null)) ||
          resolveAuth(config);
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
        const maxRunMs = maxRunMsFromEnv();
        const doomLoopThreshold = envPositiveInt("FORGE_DOOM_LOOP_THRESHOLD", 3);
        const errorStreakThreshold = envPositiveInt(
          "FORGE_ERROR_STREAK_THRESHOLD",
          5,
        );
        const ulwMaxContinues = envPositiveInt("FORGE_ULW_MAX_CONTINUES", 200);
        const permAskTimeoutMs = permissionAskTimeoutMs();
        console.log(
          stringifyJsonResult({
              ok,
              version: VERSION,
              forgeHome: home,
              provider: (auth?.provider || config.provider) as string,
              model:
                auth && auth.provider !== config.provider
                  ? config.providers[auth.provider]?.defaultModel ||
                    config.model
                  : config.model,
              configProvider: config.provider,
              auth: describeAuth(auth),
              authenticated: check.authenticated,
              blockingStop: check.blockingStop,
              modelInCatalog: check.modelInCatalog,
              permissionMode: config.permissionMode,
              sandbox: config.sandbox,
              sandboxNetwork: resolveSandboxNetwork(config),
              sandboxMissingBackend: config.sandboxMissingBackend ?? "fail-closed",
              readOutsideWorkspace: config.readOutsideWorkspace ?? "ask",
              stickyProvider: (() => {
                try {
                  return loadPreferences().provider ?? null;
                } catch {
                  return null;
                }
              })(),
              denyRules: config.permission?.deny?.length ?? 0,
              allowRules: config.permission?.allow?.length ?? 0,
              askRules: config.permission?.ask?.length ?? 0,
              maxTurns: config.maxTurns,
              maxTurnsUnlimited: !(
                typeof config.maxTurns === "number" && config.maxTurns > 0
              ),
              maxCostUsd: config.maxCostUsd ?? 0,
              maxCostUnlimited: !(
                typeof config.maxCostUsd === "number" && config.maxCostUsd > 0
              ),
              sessionCount,
              sessionsLocked,
              sessionsPinned,
              projectRulesCount: check.projectRulesCount ?? 0,
              projectCommandsCount: check.projectCommandsCount ?? 0,
              projectSkillsCount: check.projectSkillsCount ?? 0,
              sessionsWithLastError: check.sessionsWithLastError ?? 0,
              sessionsUntitled: check.sessionsUntitled ?? 0,
              sessionsTotal: check.sessionsTotal ?? 0,
              modelDefaultContextWindow:
                check.modelDefaultContextWindow ?? null,
              contextWindowRatio: check.contextWindowRatio ?? null,
              contextWindow: config.contextWindow,
              autoCompactThreshold: config.autoCompactThreshold,
              contextWindowExplicit: Boolean(config.contextWindowExplicit),
              gitIsWorktree: check.gitIsWorktree ?? null,
              gitBranch: check.gitBranch ?? null,
              gitRoot: check.gitRoot ?? null,
              gitChangedFiles: check.gitChangedFiles ?? null,
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
              notifyOnTurnEnd: isNotifyEnabled(),
              formatOnWrite: check.formatOnWrite ?? false,
              subagentLandMode: check.subagentLandMode ?? "auto",
              projectMemoryCount: check.projectMemoryCount ?? 0,
              packageManager: check.packageManager ?? null,
              projectKinds: check.projectKinds ?? [],
              checkCommands: check.checkCommands ?? [],
              workspaces: check.workspaces ?? [],
              monorepoRoot: check.monorepoRoot ?? null,
              projectStackSummary: check.projectStackSummary ?? null,
              fileReadGuard: check.fileReadGuard ?? true,
              verifyHint: check.verifyHint ?? true,
              nodeModulesPresent: check.nodeModulesPresent ?? null,
              packageManagerMismatch: check.packageManagerMismatch ?? null,
              multipleLockfiles: check.multipleLockfiles ?? [],
              autoResume:
                process.env.FORGE_NO_AUTO_RESUME !== "1" &&
                process.env.FORGE_NO_AUTO_RESUME !== "true",
              multiAccount: check.multiAccount ?? null,
              node: process.version,
              packageEnginesNode: (() => {
                try {
                  return packageManifestForRun(
                    config.workspace || process.cwd(),
                  ).enginesNode;
                } catch {
                  return null;
                }
              })(),
              report: check.report,
            }),
        );
        if (!ok) process.exitCode = 1;
        return;
      }
      // Plain doctor: same health signal as --json (exit 1 on issues) so
      // scripts that forget --json still fail closed in CI.
      const check = await runDoctorCheck(config);
      console.log(check.report);
      if (!check.ok) process.exitCode = 1;
    });

  program
    .command("status")
    .description(
      "Native statusline HUD (provider-agnostic: tokens always; plan/credits when available)",
    )
    .option("--watch", "Live refresh (default 1s; with --json emits one snapshot and exits)")
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
      const wantJson = flagJson(stOpts, command);
      // Empty --cwd '' must not silently list all workspaces.
      const cwdExplicit =
        command?.getOptionValueSource?.("cwd") === "cli" ||
        command?.parent?.getOptionValueSource?.("cwd") === "cli";
      if (
        cwdExplicit &&
        stOpts.cwd != null &&
        !String(stOpts.cwd).trim()
      ) {
        failInvalidFlag(
          "invalid_cwd",
          `Invalid --cwd "${stOpts.cwd}". Pass a non-empty workspace path.`,
          { cwd: String(stOpts.cwd) },
          { json: wantJson },
        );
      }
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
          emitFailJson({
            reason: "session_not_found",
            session: String(stOpts.session),
            error: msg,
            count: 0,
            sessions: [],
            generatedAt: new Date().toISOString(),
          });
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
            emitFailJson({
              reason: "session_not_found",
              session: sessionArg,
              error: formatSessionLookupMiss(sessionArg),
              suggestions: listSessionLookupSuggestions(sessionArg),
              count: 0,
              sessions: [],
              generatedAt: new Date().toISOString(),
            });
          } else {
            log.error(formatSessionLookupMiss(sessionArg));
          }
          process.exit(1);
        }
      }

      // Explicit invalid --interval fails closed even without --watch
      // (experts may set the flag in shared scripts; empty/default still OK).
      // Explicit --interval '' / non-numeric fails closed; omit → default 1000.
      const intervalFromCli =
        command?.getOptionValueSource?.("interval") === "cli" ||
        command?.parent?.getOptionValueSource?.("interval") === "cli";
      if (intervalFromCli) {
        const rawInterval = String(stOpts.interval ?? "");
        if (!rawInterval.trim()) {
          failInvalidFlag(
            "invalid_interval",
            `Invalid --interval "${stOpts.interval}". Pass a positive integer milliseconds.`,
            { interval: rawInterval },
            { json: wantJson },
          );
        }
        const n = Number(rawInterval.trim());
        if (!Number.isFinite(n) || n < 0) {
          failInvalidFlag(
            "invalid_interval",
            `Invalid --interval "${stOpts.interval}". Pass a positive integer milliseconds.`,
            { interval: rawInterval },
            { json: wantJson },
          );
        }
      } else if (
        stOpts.interval != null &&
        String(stOpts.interval).trim() !== "" &&
        !Number.isFinite(Number(String(stOpts.interval).trim()))
      ) {
        failInvalidFlag(
          "invalid_interval",
          `Invalid --interval "${stOpts.interval}". Pass a positive integer milliseconds.`,
          { interval: String(stOpts.interval) },
          { json: wantJson },
        );
      }

      if (stOpts.watch) {
        // --watch --json is a CI footgun (infinite NDJSON). Single-shot JSON instead;
        // human TTY watch still loops until SIGINT.
        if (wantJson || Boolean(stOpts.json)) {
          const snaps = await collectSnapshots(collectOpts);
          console.log(snapshotsToJson(snaps));
          return;
        }
        const ac = new AbortController();
        process.on("SIGINT", () => ac.abort());
        await runStatusWatch({
          ...collectOpts,
          intervalMs: parseStatusIntervalMs(stOpts.interval),
          json: false,
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

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    // Commander exitOverride: help/version exits + unknown options/args.
    const e = err as {
      code?: string;
      message?: string;
      exitCode?: number;
    };
    const code = String(e?.code || "");
    const msg = String(e?.message || err || "CLI error");
    // help/version are successful exits under exitOverride
    if (code === "commander.helpDisplayed" || code === "commander.version") {
      process.exit(0);
    }
    if (wantJsonCli) {
      const reason =
        code === "commander.unknownOption"
          ? "unknown_option"
          : code === "commander.unknownCommand"
            ? "unknown_command"
            : code === "commander.missingArgument"
              ? "missing_argument"
              : code === "commander.excessArguments"
                ? "excess_arguments"
                : "cli_error";
      const clean = msg.replace(/^error:\s*/i, "").trim();
      const foot =
        reason === "excess_arguments"
          ? excessArgCommandHint()
          : reason === "unknown_option"
            ? unknownOptionHint(clean)
            : reason === "unknown_command"
              ? (() => {
                  const m = clean.match(/unknown command ['"]?([\w-]+)/i);
                  if (!m) return {} as { suggestion?: string; hint?: string };
                  const tip = suggestTopLevelCommand(m[1] || "");
                  return tip
                    ? {
                        suggestion: tip,
                        hint: `forge ${tip} --help`,
                      }
                    : { hint: "forge --help" };
                })()
              : {};
      emitFailJson({
        reason,
        error: clean,
        code: code || null,
        ...(foot.suggestion ? { suggestion: foot.suggestion } : {}),
        ...(foot.hint ? { hint: foot.hint } : {}),
      });
      process.exit(typeof e?.exitCode === "number" ? e.exitCode : 1);
    }
    // writeErr already printed commander errors to stderr; only log non-commander.
    if (!code.startsWith("commander.")) {
      log.error(msg);
    } else if (code === "commander.excessArguments") {
      const foot = excessArgCommandHint();
      if (foot.hint) log.error(foot.hint);
    }
    process.exit(typeof e?.exitCode === "number" ? e.exitCode : 1);
  }
}

/**
 * Session id/title miss for CLI commands. With --json, emit structured stdout
 * so CI need not scrape stderr (parity with forge run --json early failures).
 */
function failSessionLookup(
  target: string,
  opts?: { json?: boolean; cwd?: string },
): never {
  const error = formatSessionLookupMiss(target, {
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
  });
  if (opts?.json) {
    emitFailJson({
      reason: "session_not_found",
      session: target,
      error,
      suggestions: listSessionLookupSuggestions(target, {
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      }),
    });
  } else {
    log.error(error);
  }
  process.exit(1);
}

/**
 * Usage / missing-arg failures for sessions subcommands.
 * With --json: `{ ok:false, reason:usage, error }` on stdout.
 */

/** Top-level CLI subcommands (for bare `forge <typo>` recovery). */
const TOP_LEVEL_COMMANDS = [
  "run",
  "login",
  "logout",
  "auth",
  "accounts",
  "sessions",
  "init",
  "setup",
  "lsp",
  "models",
  "completion",
  "prune-tool-output",
  "prune-metrics",
  "logs",
  "config",
  "stats",
  "tips",
  "news",
  "doctor",
  "status",
] as const;

/**
 * When a bare prompt is a single token that looks like a mistyped subcommand,
 * return the closest command name (else null). Avoids false positives on short
 * real prompts ("hi", "ok", "fix").
 */
/** Common abbreviations / near-misses experts type as bare `forge <token>`. */
const TOP_LEVEL_ALIASES: Record<string, (typeof TOP_LEVEL_COMMANDS)[number]> = {
  cfg: "config",
  conf: "config",
  log: "logs",
  model: "models",
  session: "sessions",
  sess: "sessions",
  complete: "completion",
  whatsnew: "news",
  hud: "status",
  whoami: "auth",
  account: "accounts",
  diagnose: "doctor",
  tip: "tips",
  cheatsheet: "tips",
};

function suggestTopLevelCommand(prompt: string): string | null {
  const t = prompt.trim();
  if (!t || /\s/.test(t)) return null;
  // flags / paths / urls are not command typos
  if (t.startsWith("-") || t.includes("/") || t.includes(":") || t.includes(".")) return null;
  const q = t.toLowerCase();
  // exact command — commander would have routed it; still skip
  if ((TOP_LEVEL_COMMANDS as readonly string[]).includes(q)) return null;
  // Explicit aliases (allow short tokens like cfg/log that fail the length floor)
  const aliased = TOP_LEVEL_ALIASES[q];
  if (aliased) return aliased;
  if (q.length < 4) return null;

  let best: { name: string; score: number } | null = null;
  for (const name of TOP_LEVEL_COMMANDS) {
    let score = 0;
    if (name.startsWith(q) || q.startsWith(name)) score = 80;
    else if (name.includes(q) || q.includes(name)) score = 55;
    else {
      const d = editDistance(q, name);
      const maxD = q.length <= 5 ? 2 : q.length <= 9 ? 3 : 4;
      if (d > maxD) continue;
      // Require shared 3-char prefix so "next" does not match "news".
      if (q.length >= 3 && name.length >= 3 && q.slice(0, 3) !== name.slice(0, 3)) {
        continue;
      }
      score = 40 - d;
      if (name.length === q.length) score += 3;
      if (name[0] === q[0]) score += 2;
    }
    if (!best || score > best.score) best = { name, score };
  }
  // Require a meaningful score so "hello" does not suggest noise
  if (!best || best.score < 38) return null;
  return best.name;
}


/** Common `forge <cmd> <other-cmd>` footguns (logout under auth, login under doctor, …). */
function excessArgCommandHint(argv: string[] = process.argv): {
  suggestion?: string;
  hint?: string;
} {
  const args = argv.map((a) => a.toLowerCase()).filter((a) => a && !a.startsWith("-"));
  // drop node + script
  const start = args.findIndex((a) => a === "forge" || a.endsWith("/forge") || a.endsWith("cli.js"));
  const tokens = start >= 0 ? args.slice(start + 1) : args;
  if (tokens.length < 2) return {};
  const [cmd, excess] = tokens;
  if (!cmd || !excess) return {};
  const top = new Set(
    (TOP_LEVEL_COMMANDS as readonly string[]).map((c) => c.toLowerCase()),
  );
  // excess token is itself a real top-level command → likely wrong nesting
  if (!top.has(excess)) return {};
  if (cmd === excess) return {};
  // auth logout / auth login are the classic cases; also doctor login, status login, …
  if (cmd === "auth" && (excess === "logout" || excess === "login")) {
    return {
      suggestion: excess,
      hint: `Did you mean: forge ${excess}${excess === "logout" ? " [--provider …]" : " […]"} [--json]?`,
    };
  }
  if (
    excess === "login" ||
    excess === "logout" ||
    excess === "doctor" ||
    excess === "auth" ||
    excess === "status" ||
    excess === "config" ||
    excess === "sessions"
  ) {
    return {
      suggestion: excess,
      hint: `Did you mean: forge ${excess} …? (got nested under \`${cmd}\`)`,
    };
  }
  return {};
}

/** Recover unknown --flag typos from a stable expert allowlist. */
function unknownOptionHint(message: string): {
  suggestion?: string;
  hint?: string;
} {
  const m = message.match(/unknown option ['"]?(-{1,2}[\w-]+)/i);
  if (!m) return {};
  const raw = m[1] || "";
  const candidates = [
    "--json",
    "--session",
    "--continue",
    "--new",
    "--title",
    "--cwd",
    "--provider",
    "--model",
    "--effort",
    "--permission-mode",
    "--sandbox",
    "--sandbox-network",
    "--sandbox-missing",
    "--read-outside",
    "--max-turns",
    "--max-waves",
    "--base-url",
    "--api-key",
    "--ulw",
    "--goal",
    "--force",
    "--help",
    "--version",
  ];
  const tip = suggestName(raw.replace(/^--?/, ""), candidates.map((c) => c.replace(/^--?/, "")), {
    minLength: 2,
    minScore: 36,
    requirePrefix3: false,
  });
  if (!tip) {
    return { hint: "forge run --help  ·  forge --help" };
  }
  const flag = tip.startsWith("-") ? tip : `--${tip}`;
  return {
    suggestion: flag,
    hint: `Did you mean ${flag}?  ·  forge run --help`,
  };
}


function suggestToken(
  raw: string,
  candidates: string[],
): string | null {
  const s = raw.trim();
  if (!s) return null;
  return suggestName(s, candidates, {
    minLength: 2,
    minScore: 30,
    requirePrefix3: false,
  });
}

function failUsage(message: string, opts?: { json?: boolean }): never {
  if (opts?.json) {
    emitFailJson({ reason: "usage", error: message });
  } else {
    log.error(message);
  }
  process.exit(1);
}

/**
 * Explicit --continue with nothing resumable.
 * Headless/CI must not silently start a fresh session (ok:true false-positive).
 * Interactive auto-resume (no --continue) still soft-starts fresh.
 */
function failContinueMiss(opts: {
  json?: boolean;
  cwd: string;
  reason: "continue_miss" | "continue_locked";
  error: string;
  skippedLocked?: number;
  candidates?: number;
}): never {
  if (opts.json) {
    // Surface recent same-cwd sessions so CI can pick --session without a second list call.
    let recent: Array<{
      id: string;
      title: string | null;
      path: string;
      relativeAge: string;
      pinned: boolean;
    }> = [];
    try {
      recent = listSessions({ cwd: opts.cwd, limit: 5 }).map((s) => ({
        id: s.id,
        title: s.title || null,
        path: resolveSessionDir(s.id) || "",
        relativeAge: formatRelativeTime(s.updatedAt || s.createdAt),
        pinned: Boolean(s.pinned),
      }));
    } catch {
      recent = [];
    }
    emitFailJson({
      reason: opts.reason,
      error: opts.error,
      cwd: opts.cwd,
      skippedLocked: opts.skippedLocked ?? 0,
      candidates: opts.candidates ?? 0,
      suggestions: recent,
      hint:
        opts.reason === "continue_locked"
          ? 'forge run "…" --session <id> --json   or omit --continue'
          : 'forge run "…" --json   (fresh) · forge run "…" --session <id> --json',
    });
  } else {
    log.error(opts.error);
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
const PROVIDER_IDS = new Set<string>([...PROVIDER_ID_LIST]);

/** Structured JSON success on stdout (always includes version for CI matrices). */

/** Headless success JSON: pretty by default; FORGE_JSON_COMPACT=1 for single-line CI logs. */
/** Empty/no-turn headless result — keep exit code + JSON ok in lockstep. */
function isEmptyRunResult(result: {
  finalText?: string | null;
  turns?: number;
}): boolean {
  const turns =
    typeof result.turns === "number" && Number.isFinite(result.turns)
      ? result.turns
      : 0;
  const text = String(result.finalText ?? "").trim();
  return !text && turns === 0;
}

function stringifyJsonResult(payload: unknown): string {
  const compact =
    process.env.FORGE_JSON_COMPACT === "1" ||
    process.env.FORGE_JSON_COMPACT === "true";
  // Support-bundle defaults for doctor/run/status-style objects (payload wins).
  const body =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload)
      ? {
          version: getForgeVersion(),
          node: process.version,
          forgeHome: forgeHome(),
          ...(payload as Record<string, unknown>),
        }
      : payload;
  return compact
    ? JSON.stringify(body)
    : JSON.stringify(body, null, 2);
}

function emitOkJson(
  payload: Record<string, unknown>,
  pretty = false,
): void {
  const body = {
    ok: true,
    version: getForgeVersion(),
    node: process.version,
    // Support-bundle default; payload may override (e.g. tests).
    forgeHome: forgeHome(),
    ...payload,
  };
  const usePretty =
    pretty &&
    process.env.FORGE_JSON_COMPACT !== "1" &&
    process.env.FORGE_JSON_COMPACT !== "true";
  console.log(usePretty ? JSON.stringify(body, null, 2) : JSON.stringify(body));
}

/** Structured JSON failure on stdout (always includes version for CI matrices). */
/** CI self-audit warnings for risky headless settings (non-blocking; doctor still authoritative). */
function packageManifestForRun(cwd: string): {
  name: string | null;
  version: string | null;
  enginesNode: string | null;
} {
  try {
    const pkgPath = path.join(cwd, "package.json");
    if (!fs.existsSync(pkgPath)) {
      return { name: null, version: null, enginesNode: null };
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
      engines?: { node?: unknown };
    };
    const name = typeof pkg.name === "string" ? pkg.name.trim() : "";
    const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
    const enginesNode =
      pkg.engines && typeof pkg.engines.node === "string"
        ? pkg.engines.node.trim()
        : "";
    return {
      name: name || null,
      version: version || null,
      enginesNode: enginesNode || null,
    };
  } catch {
    return { name: null, version: null, enginesNode: null };
  }
}

/** Project stack for run/status JSON (package manager + preferred checks). */
function projectIntelForRun(cwd: string): {
  packageManager: string | null;
  checkCommands: string[];
  projectStackSummary: string | null;
  monorepoRoot: string | null;
  workspaces: string[];
  nodeModulesPresent: boolean | null;
  multipleLockfiles: string[];
} {
  try {
    const intel = detectProjectIntel(cwd);
    return {
      packageManager: intel.packageManager ?? null,
      checkCommands: [...intel.checkCommands],
      projectStackSummary: intel.summary || null,
      monorepoRoot: intel.monorepoRoot ?? null,
      workspaces: [...(intel.workspaces || [])],
      nodeModulesPresent: hasNodeModules(cwd),
      multipleLockfiles: multipleLockfiles(cwd),
    };
  } catch {
    return {
      packageManager: null,
      checkCommands: [],
      projectStackSummary: null,
      monorepoRoot: null,
      workspaces: [],
      nodeModulesPresent: null,
      multipleLockfiles: [],
    };
  }
}

function gitSnapshotForRun(cwd: string): {
  branch: string | null;
  dirty: boolean | null;
  changedFiles: number | null;
  ahead: number | null;
  behind: number | null;
  root: string | null;
  isWorktree: boolean | null;
} | null {
  try {
    const g = getGitSnapshot(cwd);
    if (!g.branch && !g.root) return null;
    return {
      branch: g.branch ?? null,
      dirty: g.dirty ?? null,
      changedFiles: g.changedFiles ?? null,
      ahead: g.ahead ?? null,
      behind: g.behind ?? null,
      root: g.root ?? null,
      isWorktree: g.isWorktree ?? null,
    };
  } catch {
    return null;
  }
}

// productionWarningsForRun lives in util/production-warnings.ts (unit-tested).

function emitFailJson(
  payload: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      ok: false,
      version: getForgeVersion(),
      node: process.version,
      forgeHome: forgeHome(),
      ...payload,
    }),
  );
}

/** Structured CLI flag validation failure (parity with invalid_effort). */
function failInvalidFlag(
  reason: string,
  message: string,
  extra: Record<string, unknown>,
  opts?: { json?: boolean },
): never {
  if (opts?.json) {
    emitFailJson({ reason, error: message, ...extra });
  } else {
    log.error(message);
  }
  process.exit(1);
}

/**
 * Parse `--max-waves` CLI flag.
 * - omitted / undefined → undefined (leave existing / default unlimited)
 * - 0 → null (unlimited / clear)
 * - positive integer → cap
 * - invalid → fail closed
 */
function parseCliMaxWaves(
  raw: unknown,
  wantJson: boolean,
): number | null | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (s === "") {
    failInvalidFlag(
      "invalid_max_waves",
      `Invalid --max-waves "". Pass a positive integer, or 0 for unlimited.`,
      { maxWaves: String(raw) },
      { json: wantJson },
    );
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n || n > 10_000) {
    failInvalidFlag(
      "invalid_max_waves",
      `Invalid --max-waves "${raw}". Pass an integer 0–10000 (0 = unlimited).`,
      { maxWaves: String(raw) },
      { json: wantJson },
    );
  }
  if (n === 0) return null;
  return normalizeMaxWaves(n);
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

/** status --interval: empty/omitted → 1000; 0 or below → 250 min floor. Non-numeric rejected earlier. */
function parseStatusIntervalMs(raw: unknown): number {
  if (raw == null || raw === "") return 1000;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return 1000;
  // 0 or negative: use minimum watch interval (not "disabled" — watch needs a tick)
  if (n <= 0) return 250;
  return Math.min(60_000, Math.max(250, Math.floor(n)));
}

/** logs -n: 0 = all in window; empty/invalid → fallback; else 1..200 */

/** Fail closed on explicit invalid CLI counts (--keep/--limit/…). Omitted → fallback. */

/** --keep with all|max|unlimited → keep everything (large sentinel). */
function requireCliKeepCount(
  raw: unknown,
  fallback: number,
  flag: string,
  reason: string,
  opts?: { json?: boolean },
): number {
  if (raw != null && String(raw).trim() !== "") {
    const key = String(raw).trim().toLowerCase();
    if (key === "all" || key === "max" || key === "unlimited" || key === "everything") {
      return 1_000_000;
    }
  }
  return requireCliCount(raw, fallback, flag, reason, {
    ...opts,
    aliasCandidates: ["all", "max", "unlimited", "everything", "0", "10", "50", "80", "100"],
  });
}

function requireCliCount(
  raw: unknown,
  fallback: number,
  flag: string,
  reason: string,
  opts?: { json?: boolean; aliasCandidates?: string[] },
): number {
  const parsed = parseCliNonNegInt(raw);
  if (parsed === undefined) return fallback;
  if (parsed === null) {
    const tip = suggestToken(
      String(raw ?? ""),
      opts?.aliasCandidates ?? ["0", "1", "7", "14", "30", "all", "none", "off", "never"],
    );
    failInvalidFlag(
      reason,
      tip
        ? `Invalid ${flag} "${raw}". Did you mean: ${tip}? Pass a non-negative integer (0 is allowed).`
        : `Invalid ${flag} "${raw}". Pass a non-negative integer (0 is allowed).`,
      { value: String(raw ?? ""), ...(tip ? { suggestion: tip } : {}) },
      { json: Boolean(opts?.json) },
    );
  }
  return parsed;
}


/**
 * Empty --title '' is invalid when the flag is present (Commander sets "").
 * Omitted title stays undefined.
 */
function assertTitleOpt(
  title: unknown,
  opts?: { json?: boolean },
): string | undefined {
  if (title == null) return undefined;
  const t = String(title).trim();
  if (!t) {
    failInvalidFlag(
      "invalid_title",
      `Invalid --title "${title}". Pass a non-empty label, or omit --title.`,
      { title: String(title) },
      { json: Boolean(opts?.json) },
    );
  }
  // Keep titles searchable/listable; extreme lengths are almost always accidents.
  if (t.length > MAX_SESSION_TITLE_CHARS) {
    failInvalidFlag(
      "invalid_title",
      `Invalid --title (length ${t.length}). Pass at most ${MAX_SESSION_TITLE_CHARS} characters.`,
      { title: t.slice(0, 40) + "…", length: t.length },
      { json: Boolean(opts?.json) },
    );
  }
  return t;
}

/** Empty --goal '' is invalid when the flag is present. */
function assertGoalOpt(
  goal: unknown,
  opts?: { json?: boolean },
): string | undefined {
  if (goal == null) return undefined;
  const g = String(goal).trim();
  if (!g) {
    failInvalidFlag(
      "invalid_goal",
      `Invalid --goal "${goal}". Pass a non-empty objective, or omit --goal.`,
      { goal: String(goal) },
      { json: Boolean(opts?.json) },
    );
  }
  // Extreme lengths blow context and are almost always accidents/CI mis-quotes.
  if (g.length > 4000) {
    failInvalidFlag(
      "invalid_goal",
      `Invalid --goal (length ${g.length}). Pass at most 4000 characters.`,
      { goal: g.slice(0, 40) + "…", length: g.length },
      { json: Boolean(opts?.json) },
    );
  }
  return g;
}

function buildConfig(opts: Record<string, unknown>): ForgeConfig {
  const wantJson = Boolean(opts.json);
  // Empty --cwd '' must not silently resolve to process.cwd() (path.resolve('')).
  // Explicit --cwd that does not exist / is not a directory fails closed (CI safety).
  let cwd = path.resolve(String(opts.cwd || process.cwd()));
  if (opts.cwd != null) {
    const rawCwd = String(opts.cwd).trim();
    if (!rawCwd) {
      failInvalidFlag(
        "invalid_cwd",
        `Invalid --cwd "${opts.cwd}". Pass a non-empty workspace path.`,
        { cwd: String(opts.cwd) },
        { json: wantJson },
      );
    }
    cwd = path.resolve(rawCwd);
    try {
      const st = fs.statSync(cwd);
      if (!st.isDirectory()) {
        failInvalidFlag(
          "invalid_cwd",
          `Invalid --cwd "${opts.cwd}". Path exists but is not a directory.`,
          { cwd: String(opts.cwd), resolved: cwd },
          { json: wantJson },
        );
      }
    } catch {
      failInvalidFlag(
        "invalid_cwd",
        `Invalid --cwd "${opts.cwd}". Directory does not exist (resolved: ${cwd}).`,
        { cwd: String(opts.cwd), resolved: cwd },
        { json: wantJson },
      );
    }
  }
  const overrides: Partial<ForgeConfig> = { workspace: cwd };
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
  if (opts.fallbackModels != null) {
    const parsed = parseFallbackModels(opts.fallbackModels);
    if (parsed === undefined) {
      failInvalidFlag(
        "invalid_fallback_models",
        `Invalid --fallback-models "${opts.fallbackModels}". Use a comma list, or off.`,
        { fallbackModels: String(opts.fallbackModels) },
        { json: wantJson },
      );
    }
    overrides.fallbackModels = parsed;
  }
  if (opts.provider != null) {
    const norm = normalizeProviderId(opts.provider);
    if (!norm.ok) {
      const tip = norm.raw
        ? suggestName(norm.raw, [...PROVIDER_IDS], {
            minLength: 2,
            minScore: 36,
            requirePrefix3: false,
          })
        : null;
      failInvalidFlag(
        "invalid_provider",
        tip
          ? `Invalid --provider "${opts.provider}". Did you mean: ${tip}? Use ${providerIdHelp()}.`
          : `Invalid --provider "${opts.provider}". Use ${providerIdHelp()}.`,
        {
          provider: String(opts.provider),
          ...(tip ? { suggestion: tip } : {}),
        },
        { json: wantJson },
      );
    }
    overrides.provider = norm.provider;
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
    // Reject non-http(s) / empty host early — opaque fetch errors waste retries/CI time.
    try {
      const u = new URL(base);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        const scheme = u.protocol.replace(/:$/, "") || u.protocol;
        const tip =
          scheme === "ftp" ||
          scheme === "ftps" ||
          scheme === "ws" ||
          scheme === "wss" ||
          scheme === "file"
            ? "https"
            : null;
        failInvalidFlag(
          "invalid_base_url",
          tip
            ? `Invalid --base-url "${opts.baseUrl}". Did you mean: https://…? Use http:// or https:// (got ${u.protocol}).`
            : `Invalid --base-url "${opts.baseUrl}". Use http:// or https:// (got ${u.protocol}).`,
          {
            baseUrl: String(opts.baseUrl),
            ...(tip ? { suggestion: tip } : {}),
          },
          { json: wantJson },
        );
      }
      if (!u.hostname) {
        failInvalidFlag(
          "invalid_base_url",
          `Invalid --base-url "${opts.baseUrl}". Pass a host (e.g. https://api.x.ai/v1).`,
          { baseUrl: String(opts.baseUrl) },
          { json: wantJson },
        );
      }
    } catch {
      failInvalidFlag(
        "invalid_base_url",
        `Invalid --base-url "${opts.baseUrl}". Pass an absolute http(s) URL (e.g. https://api.x.ai/v1).`,
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
        const tip = raw
          ? suggestName(raw, ["low", "medium", "high", "xhigh", "max", "minimal"], {
              minLength: 2,
              minScore: 36,
              requirePrefix3: false,
            })
          : null;
        failInvalidFlag(
          "invalid_effort",
          tip
            ? `Invalid --effort "${effortRaw}". Did you mean: ${tip}? Use low, medium, high, xhigh, or max.`
            : `Invalid --effort "${effortRaw}". Use low, medium, high, xhigh, or max.`,
          {
            effort: String(effortRaw),
            ...(tip ? { suggestion: tip } : {}),
          },
          { json: wantJson },
        );
      }
      overrides.reasoningEffort = e;
    }
  }
  if (opts.maxTurns != null) {
    const raw = String(opts.maxTurns).trim();
    const n = raw === "" ? NaN : Number(raw);
    // Cap at 100_000 — larger values are almost always typos; 0 remains unlimited.
    if (
      !Number.isFinite(n) ||
      n < 0 ||
      Math.floor(n) !== n ||
      n > 100_000
    ) {
      failInvalidFlag(
        "invalid_max_turns",
        `Invalid --max-turns "${opts.maxTurns}". Pass an integer 0–100000 (0 = unlimited).`,
        { maxTurns: String(opts.maxTurns) },
        { json: wantJson },
      );
    }
    overrides.maxTurns = n;
  }
  if (opts.maxCost != null) {
    const parsed = parseCostUsd(opts.maxCost);
    if (parsed === null || parsed === undefined) {
      failInvalidFlag(
        "invalid_max_cost",
        `Invalid --max-cost "${opts.maxCost}". Pass a USD amount (e.g. 5, $2.50) or 0/off for unlimited.`,
        { maxCost: String(opts.maxCost) },
        { json: wantJson },
      );
    }
    overrides.maxCostUsd = parsed;
  }
  // != null so empty string "" fails closed (Commander sets "" for --flag '')
  if (opts.permissionMode != null) {
    const mode = normalizePermissionMode(opts.permissionMode);
    if (!mode) {
      const tip = String(opts.permissionMode).trim()
        ? suggestName(String(opts.permissionMode).trim(), [...PERMISSION_MODES], {
            minLength: 3,
            minScore: 36,
            requirePrefix3: false,
          })
        : null;
      failInvalidFlag(
        "invalid_permission_mode",
        tip
          ? `Invalid --permission-mode "${opts.permissionMode}". Did you mean: ${tip}? Use default|acceptEdits|plan|bypassPermissions|dontAsk.`
          : `Invalid --permission-mode "${opts.permissionMode}". Use default|acceptEdits|plan|bypassPermissions|dontAsk.`,
        {
          permissionMode: String(opts.permissionMode),
          ...(tip ? { suggestion: tip } : {}),
        },
        { json: wantJson },
      );
    }
    overrides.permissionMode = mode;
  }
  if (opts.sandbox != null) {
    const profile = normalizeSandboxProfile(opts.sandbox);
    if (!profile) {
      const tip = String(opts.sandbox).trim()
        ? suggestName(String(opts.sandbox).trim(), [...SANDBOX_PROFILES], {
            minLength: 3,
            minScore: 36,
            requirePrefix3: false,
          })
        : null;
      failInvalidFlag(
        "invalid_sandbox",
        tip
          ? `Invalid --sandbox "${opts.sandbox}". Did you mean: ${tip}? Use off|workspace|read-only|strict.`
          : `Invalid --sandbox "${opts.sandbox}". Use off|workspace|read-only|strict.`,
        {
          sandbox: String(opts.sandbox),
          ...(tip ? { suggestion: tip } : {}),
        },
        { json: wantJson },
      );
    }
    overrides.sandbox = profile;
  }
  if (opts.sandboxNetwork != null) {
    const net = normalizeSandboxNetwork(opts.sandboxNetwork);
    if (!net) {
      const tip = String(opts.sandboxNetwork).trim()
        ? suggestName(String(opts.sandboxNetwork).trim(), [...SANDBOX_NETWORKS], {
            minLength: 3,
            minScore: 36,
            requirePrefix3: false,
          })
        : null;
      failInvalidFlag(
        "invalid_sandbox_network",
        tip
          ? `Invalid --sandbox-network "${opts.sandboxNetwork}". Did you mean: ${tip}? Use unrestricted|blocked.`
          : `Invalid --sandbox-network "${opts.sandboxNetwork}". Use unrestricted|blocked.`,
        {
          sandboxNetwork: String(opts.sandboxNetwork),
          ...(tip ? { suggestion: tip } : {}),
        },
        { json: wantJson },
      );
    }
    overrides.sandboxNetwork = net;
  }
  if (opts.sandboxMissing != null) {
    const rawMiss = String(opts.sandboxMissing).trim();
    const missAlias: Record<string, string> = {
      fail_closed: "fail-closed",
      failclosed: "fail-closed",
      "fail-close": "fail-closed",
      closed: "fail-closed",
      fall_back: "fallback",
      "fall-back": "fallback",
    };
    const miss = missAlias[rawMiss.toLowerCase()] || rawMiss;
    if (!SANDBOX_MISSING.has(miss as SandboxMissingBackend)) {
      const tip = miss
        ? suggestName(miss, [...SANDBOX_MISSING], {
            minLength: 3,
            minScore: 36,
            requirePrefix3: false,
          })
        : null;
      failInvalidFlag(
        "invalid_sandbox_missing",
        tip
          ? `Invalid --sandbox-missing "${opts.sandboxMissing}". Did you mean: ${tip}? Use fail-closed|fallback.`
          : `Invalid --sandbox-missing "${opts.sandboxMissing}". Use fail-closed|fallback.`,
        {
          sandboxMissing: String(opts.sandboxMissing),
          ...(tip ? { suggestion: tip } : {}),
        },
        { json: wantJson },
      );
    }
    overrides.sandboxMissingBackend = miss as SandboxMissingBackend;
  }
  if (opts.readOutside != null) {
    const rawRo = String(opts.readOutside).trim();
    if (!rawRo) {
      failInvalidFlag(
        "invalid_read_outside",
        'Invalid --read-outside "" (empty). Use ask|allow|deny.',
        { readOutside: String(opts.readOutside) },
        { json: wantJson },
      );
    }
    const roAlias: Record<string, ReadOutsideWorkspace> = {
      ask: "ask",
      allow: "allow",
      deny: "deny",
      yes: "allow",
      no: "deny",
      block: "deny",
      prompt: "ask",
    };
    const ro = roAlias[rawRo.toLowerCase()] || rawRo;
    if (ro !== "ask" && ro !== "allow" && ro !== "deny") {
      const tip = suggestName(rawRo, ["ask", "allow", "deny"], {
        minLength: 2,
        minScore: 36,
        requirePrefix3: false,
      });
      failInvalidFlag(
        "invalid_read_outside",
        tip
          ? `Invalid --read-outside "${opts.readOutside}". Did you mean: ${tip}? Use ask|allow|deny.`
          : `Invalid --read-outside "${opts.readOutside}". Use ask|allow|deny.`,
        {
          readOutside: String(opts.readOutside),
          ...(tip ? { suggestion: tip } : {}),
        },
        { json: wantJson },
      );
    }
    overrides.readOutsideWorkspace = ro as ReadOutsideWorkspace;
  }
  if (opts.blockingStop === false || opts.noBlockingStop) {
    overrides.blockingStopHooks = false;
  }
  const cfg = loadConfig(overrides, cwd);
  // CLI --deny/--allow/--ask append to config rules.
  // Empty strings (e.g. --deny '') fail closed — they are never meaningful rules.
  const cleanRules = (
    raw: unknown,
    flag: string,
    reason: string,
  ): string[] => {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
      const s = String(item ?? "").trim();
      if (!s) {
        failInvalidFlag(
          reason,
          `Invalid ${flag} "${item}". Pass a non-empty rule like 'Bash(rm *)'.`,
          { [flag.replace(/^--/, "")]: String(item ?? "") },
          { json: wantJson },
        );
      }
      // Empty tool() patterns (Bash()) are not meaningful — require a pattern or bare tool.
      if (!parseRuleString(s)) {
        failInvalidFlag(
          reason,
          `Invalid ${flag} "${s}". Use Tool or Tool(pattern), e.g. 'Bash' or 'Bash(rm *)' (empty Tool() is invalid).`,
          { [flag.replace(/^--/, "")]: s },
          { json: wantJson },
        );
      }
      out.push(s);
    }
    return out;
  };
  const extraDeny = cleanRules(opts.deny, "--deny", "invalid_deny");
  const extraAllow = cleanRules(opts.allow, "--allow", "invalid_allow");
  const extraAsk = cleanRules(opts.ask, "--ask", "invalid_ask");
  if (extraDeny.length || extraAllow.length || extraAsk.length) {
    cfg.permission = {
      deny: [...(cfg.permission?.deny || []), ...extraDeny],
      allow: [...(cfg.permission?.allow || []), ...extraAllow],
      ask: [...(cfg.permission?.ask || []), ...extraAsk],
      rules: cfg.permission?.rules || [],
    };
  }
  // Explicit --model: if it is a close typo of a known catalog id, fail closed
  // with a suggestion. Unknown free-form ids (OpenRouter, custom) still pass.
  if (opts.model != null) {
    const model = String(cfg.model || "").trim();
    const prov = cfg.providers[cfg.provider];
    // Prefer current provider catalog so grok-45 → grok-4.5 not a shorter sibling.
    const primary = [
      ...(prov?.models || []),
      ...(prov?.defaultModel ? [prov.defaultModel] : []),
    ];
    const secondary = Object.values(cfg.providers).flatMap((p) => [
      ...(p.models || []),
      ...(p.defaultModel ? [p.defaultModel] : []),
    ]);
    const knownPrimary = [...new Set(primary.filter(Boolean))];
    const knownAll = [...new Set([...primary, ...secondary].filter(Boolean))];
    const exact = knownAll.some((m) => m.toLowerCase() === model.toLowerCase());
    if (model && !exact) {
      const tip =
        suggestName(model, knownPrimary, {
          minLength: 3,
          minScore: 38,
          requirePrefix3: false,
        }) ||
        suggestName(model, knownAll, {
          minLength: 3,
          minScore: 42,
          requirePrefix3: false,
        });
      if (
        tip &&
        tip.toLowerCase() !== model.toLowerCase() &&
        !isAcceptableUnknownModelId(model, tip)
      ) {
        failInvalidFlag(
          "invalid_model",
          `Invalid --model "${opts.model}". Did you mean: ${tip}?`,
          { model: String(opts.model), suggestion: tip, provider: cfg.provider },
          { json: wantJson },
        );
      }
    }
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
     * Conflicts with --new (fail closed). Still respects --session.
     */
    continue?: boolean;
    /** Structured stdout on session miss (bare forge --json). */
    json?: boolean;
    /**
     * REPL banner already prints formatResumeOrientation — skip the CLI
     * peek so resume is one card. Headless `--continue` must keep the peek.
     */
    skipOrientation?: boolean;
  },
) {
  // --continue/--session and --new are mutually exclusive (was silent prefer --new).
  if (opts.continue && opts.new) {
    failInvalidFlag(
      "conflicting_flags",
      "Cannot combine --continue with --new. Use one: resume same-cwd, or force a fresh session.",
      { continue: true, new: true },
      { json: Boolean(opts.json) },
    );
  }
  if (opts.session != null && opts.new) {
    failInvalidFlag(
      "conflicting_flags",
      "Cannot combine --session with --new. Pass --session to resume, or --new for a fresh session.",
      { session: String(opts.session), new: true },
      { json: Boolean(opts.json) },
    );
  }
  if (opts.session != null && opts.continue) {
    failInvalidFlag(
      "conflicting_flags",
      "Cannot combine --session with --continue. Pass --session <id|title>, or --continue for newest same-cwd.",
      { session: String(opts.session), continue: true },
      { json: Boolean(opts.json) },
    );
  }
  if (opts.session != null) {
    const sessionFlag = String(opts.session).trim();
    if (!sessionFlag) {
      const msg =
        'Empty --session. Pass an id/prefix/title, or omit --session.';
      if (opts.json) {
        emitFailJson({
          reason: "session_not_found",
          session: String(opts.session),
          error: msg,
        });
      } else {
        log.error(msg);
      }
      process.exit(1);
    }
    const s = loadSession(sessionFlag);
    if (!s) {
      const miss = formatSessionLookupMiss(sessionFlag);
      if (opts.json) {
        emitFailJson({
          reason: "session_not_found",
          session: sessionFlag,
          error: miss,
          suggestions: listSessionLookupSuggestions(sessionFlag),
        });
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
        if (!opts.skipOrientation) {
          const peek = formatResumeOrientation(s, { compact: true });
          if (peek) {
            log.dim(`${peek}\n(/last 3 for more · /retry to re-run)`);
          }
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
            if (!opts.skipOrientation) {
              try {
                const peek = formatResumeOrientation(s, { compact: true });
                if (peek) {
                  log.dim(`${peek}\n(/last 3 for more · /retry to re-run)`);
                }
              } catch {
                /* never block resume on peek */
              }
            }
          }
          // Do NOT rewrite provider/model from live config here: the caller
          // aligns config FROM the resumed session unless CLI -p/-m overrode
          // (bare forge action / forge run both do this). Clobbering session
          // meta first made that prefer-session block a dead no-op and let
          // sticky prefs silently hijack an older chat's provider.
          return s;
        }
      } else if (hit && hit.skippedLocked > 0) {
        // Interactive auto-resume: soft-start fresh when all candidates locked.
        // Explicit --continue (headless or bare): fail closed.
        if (opts.continue) {
          failContinueMiss({
            json: Boolean(opts.json),
            cwd,
            reason: "continue_locked",
            error:
              `No unlocked same-cwd session to continue (${hit.skippedLocked} locked). ` +
              `Use --session <id> to attach, or omit --continue for a fresh run.`,
            skippedLocked: hit.skippedLocked,
            candidates: hit.candidates,
          });
        }
        if (!opts.json) {
          log.info(
            `Starting fresh session — ${hit.skippedLocked} same-cwd session${hit.skippedLocked === 1 ? "" : "s"} locked by other process(es). Use --session <id> to attach anyway.`,
          );
        }
      } else if (opts.continue) {
        failContinueMiss({
          json: Boolean(opts.json),
          cwd,
          reason: "continue_miss",
          error:
            "No prior same-cwd session to continue. " +
            "Omit --continue to start fresh, or pass --session <id|title>.",
          skippedLocked: hit?.skippedLocked ?? 0,
          candidates: hit?.candidates ?? 0,
        });
      }
    } catch {
      if (opts.continue) {
        failContinueMiss({
          json: Boolean(opts.json),
          cwd,
          reason: "continue_miss",
          error:
            "Failed to resolve same-cwd session for --continue. " +
            "Omit --continue to start fresh, or pass --session <id|title>.",
        });
      }
      /* interactive auto-resume: fall through to new session */
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
        emitFailJson({
          error: msg,
          reason: "locked",
          forgeHome: forgeHome(),
          sessionId: opts.session.meta.id,
          sessionPath: resolveSessionDir(opts.session.meta.id),
          lock: {
            pid: lock.holder.pid,
            hostname: lock.holder.hostname,
            acquiredAt: lock.holder.acquiredAt,
            holder: formatLockHolder(lock.holder),
          },
          hint:
            'Wait for the holder, forge run "…" --session <other-id> --json, or FORGE_FORCE_SESSION_LOCK=1',
        });
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
  const maxRunMs = maxRunMsFromEnv();
  if (maxRunMs != null) {
    maxRunTimer = setTimeout(() => {
      if (!ac.signal.aborted) {
        timedOut = true;
        log.warn(`FORGE_MAX_RUN_MS=${maxRunMs} exceeded — aborting headless run`);
        ac.abort();
      }
    }, maxRunMs);
    maxRunTimer.unref?.();
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

  // Headless slash: forge run "/plan" · "/commands" · custom .forge/commands
  // Expand forwardPrompt templates; pure control slashes exit without a model call.
  let headlessPrompt = opts.prompt;
  {
    const { resolveHeadlessSlashPrompt, stripAnsi } = await import(
      "./commands/headless-slash.js"
    );
    const resolved = await resolveHeadlessSlashPrompt({
      prompt: opts.prompt,
      session: opts.session,
      config: opts.config,
      hooks: opts.hooks,
      // Fresh empty session + pure control → discard (avoid list pollution)
      ephemeral:
        (opts.session.messages?.filter((m) => m.role !== "system").length ??
          0) === 0,
    });
    opts.session = resolved.session;
    if (resolved.kind === "prompt") {
      headlessPrompt = resolved.prompt;
      if (!opts.json && resolved.notice) {
        log.dim(stripAnsi(resolved.notice));
      }
    } else if (resolved.kind === "done") {
      const out = stripAnsi(resolved.output);
      const ephemeral = Boolean(resolved.ephemeral);
      if (opts.json) {
        const payload = {
          reason: "slash",
          command: resolved.command,
          output: out,
          sessionId: ephemeral ? null : opts.session.meta.id,
          sessionPath: ephemeral
            ? null
            : resolveSessionDir(opts.session.meta.id),
          ephemeral,
          forgeHome: forgeHome(),
          provider: opts.config.provider,
          model: opts.config.model,
          permissionMode: opts.config.permissionMode,
          node: process.version,
        };
        if (resolved.failed) emitFailJson({ ...payload, error: out });
        else emitOkJson({ ok: true, ...payload });
      } else if (out) {
        process.stdout.write(out.endsWith("\n") ? out : out + "\n");
      }
      if (!ephemeral) {
        await opts.hooks.run("SessionEnd", {
          sessionId: opts.session.meta.id,
          cwd: opts.session.meta.cwd,
          workspaceRoot: opts.config.workspace || opts.session.meta.cwd,
        });
        saveSession(opts.session);
      }
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
      if (maxRunTimer) clearTimeout(maxRunTimer);
      cleanupBg();
      releaseLock();
      process.exit(resolved.failed ? 1 : 0);
    }
  }

  const t0 = Date.now();
  const turnAtStart = opts.session.meta.turnCount;
  if (!opts.json) {
    const open = formatUserTurnOpen(headlessPrompt);
    if (open) console.log(open);
  }
  let result;
  try {
    result = await runAgentLoopThroughDrops({
      config: opts.config,
      provider: opts.provider,
      session: opts.session,
      hooks: opts.hooks,
      permissions,
      userMessage: headlessPrompt,
      stream: !opts.json,
      signal: ac.signal,
      events: opts.json
        ? undefined
        : (() => {
            let opened = false;
            const think = createThinkingLandmark();
            return {
              onReasoning: (p: { chars: number }) => {
                if (opened) return;
                think.push(p.chars);
              },
              onToken: (t: string) => {
                if (!opened) {
                  opened = true;
                  if (!think.takeForReply(formatAssistantTurnOpen())) {
                    process.stdout.write(`${formatAssistantTurnOpen()}\n`);
                  }
                }
                process.stdout.write(t);
              },
              onPhase: (phase: string) => {
                if (phase === "tool") think.settle();
              },
            };
          })(),
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
    let recovery: { code: string; tips: string[]; message: string } | undefined;
    try {
      const { formatProviderError } = await import("./providers/errors.js");
      const fmt = formatProviderError(err, {
        provider: String(opts.config.provider),
        model: opts.config.model,
      });
      recovery = fmt;
    } catch {
      /* */
    }
    if (timedOut) {
      try {
        const { setSessionLastError } = await import("./session/session.js");
        setSessionLastError(opts.session, {
          code: "max_run_ms",
          message: "Run hit FORGE_MAX_RUN_MS wall-clock limit (exit 124)",
          tips: [
            "Raise FORGE_MAX_RUN_MS or narrow the task",
            "forge run --continue  ·  /retry",
          ],
        });
        saveSession(opts.session);
        recovery = {
          code: "max_run_ms",
          message: "Run hit FORGE_MAX_RUN_MS wall-clock limit (exit 124)",
          tips: [
            "Raise FORGE_MAX_RUN_MS or narrow the task",
            "forge run --continue  ·  /retry",
          ],
        };
      } catch {
        /* */
      }
    }
    appendSessionMetrics(
      buildRunEndMetrics({
        sessionId: opts.session.meta.id,
        provider: String(opts.config.provider),
        model: opts.config.model,
        cwd: opts.session.meta.cwd,
        turns: 0,
        stopContinues: 0,
        editCount: opts.session.meta.editCount,
        lastVerificationCommand:
          opts.session.meta.lastVerificationCommand ?? null,
        lastVerificationAt: opts.session.meta.lastVerificationAt ?? null,
        lastEditAt: opts.session.meta.lastEditAt ?? null,
        lastVerificationStale: isLastVerificationStale(opts.session.meta),
        promptTokens: 0,
        completionTokens: 0,
        durationMs: Date.now() - t0,
        aborted: ac.signal.aborted,
        timedOut,
        ok: false,
        headless: true,
        ultrawork: opts.session.meta.ultrawork,
        lastErrorCode:
          recovery?.code || opts.session.meta.lastError?.code || undefined,
      }),
    );
    if (opts.json) {
      emitFailJson({
        reason: timedOut
          ? "timeout"
          : ac.signal.aborted
            ? "aborted"
            : recovery?.code || "error",
        error: recovery?.message || message,
        recovery: recovery
          ? { code: recovery.code, tips: recovery.tips }
          : undefined,
        lastError: opts.session.meta.lastError
          ? {
              at: opts.session.meta.lastError.at,
              code: opts.session.meta.lastError.code,
              message: opts.session.meta.lastError.message,
              tips: opts.session.meta.lastError.tips,
            }
          : null,
        timedOut,
        aborted: ac.signal.aborted,
        node: process.version,
        forgeHome: forgeHome(),
        sessionId: opts.session.meta.id,
        sessionPath: resolveSessionDir(opts.session.meta.id),
        title: opts.session.meta.title || null,
        pinned: Boolean(opts.session.meta.pinned),
        foreignLock: sessionHasForeignLiveLock(opts.session.meta.id),
        provider: opts.config.provider,
        stickyProvider: (() => {
          try {
            return loadPreferences().provider ?? null;
          } catch {
            return null;
          }
        })(),
        authMethod: (() => {
          try {
            const a = resolveAuth(opts.config);
            return a?.method ?? null;
          } catch {
            return null;
          }
        })(),
        model: opts.config.model,
        reasoningEffort:
          resolveReasoningEffort(
            opts.config.model,
            opts.config.reasoningEffort,
          ) ?? null,
        ...(opts.config.baseUrl ? { baseUrl: opts.config.baseUrl } : {}),
        cwd: opts.session.meta.cwd || opts.config.workspace || null,
        git: gitSnapshotForRun(
          opts.session.meta.cwd || opts.config.workspace || process.cwd(),
        ),
        projectLabel: (() => {
          const cwd =
            opts.session.meta.cwd || opts.config.workspace || process.cwd();
          try {
            const parts = String(cwd)
              .replace(/[\/]+$/, "")
              .split(/[\/]/)
              .filter(Boolean);
            return parts.slice(-2).join("/") || String(cwd);
          } catch {
            return null;
          }
        })(),
        projectHints: (() => {
          try {
            return detectProjectHints(
              opts.session.meta.cwd || opts.config.workspace || process.cwd(),
            );
          } catch {
            return [];
          }
        })(),
        ...(() => {
          const cwd =
            opts.session.meta.cwd || opts.config.workspace || process.cwd();
          const m = packageManifestForRun(cwd);
          const intel = projectIntelForRun(cwd);
          return {
            packageName: m.name,
            packageVersion: m.version,
            packageEnginesNode: m.enginesNode,
            packageManager: intel.packageManager,
            checkCommands: intel.checkCommands,
            projectStackSummary: intel.projectStackSummary,
            monorepoRoot: intel.monorepoRoot,
            workspaces: intel.workspaces,
            nodeModulesPresent: intel.nodeModulesPresent,
            multipleLockfiles: intel.multipleLockfiles,
          };
        })(),
        permissionMode: opts.config.permissionMode,
        contextWindow: opts.config.contextWindow,
        autoCompactThreshold: opts.config.autoCompactThreshold,
        contextWindowExplicit: Boolean(opts.config.contextWindowExplicit),
        sandbox: opts.config.sandbox,
        sandboxNetwork: resolveSandboxNetwork(opts.config),
        sandboxMissingBackend: opts.config.sandboxMissingBackend ?? "fail-closed",
        readOutsideWorkspace: opts.config.readOutsideWorkspace ?? "ask",
        ultrawork: Boolean(opts.session.meta.ultrawork),
        ulwCycle: (() => {
          try {
            const u = loadUlwCycle(opts.session.meta.id);
            return u?.enabled ? u.cycle : null;
          } catch {
            return null;
          }
        })(),
        ulwWave: (() => {
          try {
            const u = loadUlwCycle(opts.session.meta.id);
            return u?.enabled ? u.wave : null;
          } catch {
            return null;
          }
        })(),
        ulwMaxWaves: (() => {
          try {
            const u = loadUlwCycle(opts.session.meta.id);
            if (!u?.enabled) return null;
            return u.maxWaves ?? null;
          } catch {
            return null;
          }
        })(),
        ulwBlocks: (() => {
          try {
            const u = loadUlwCycle(opts.session.meta.id);
            return u?.enabled ? u.blocks : null;
          } catch {
            return null;
          }
        })(),
        ulwMandate: (() => {
          try {
            const u = loadUlwCycle(opts.session.meta.id);
            if (!u?.enabled) return null;
            const text = String(u.mandate || "").trim();
            if (!text) return null;
            return text.length > 200 ? `${text.slice(0, 200)}…` : text;
          } catch {
            return null;
          }
        })(),
        ulwSoftPrompt: (() => {
          try {
            const u = loadUlwCycle(opts.session.meta.id);
            return u?.enabled ? Boolean(u.softPrompt) : null;
          } catch {
            return null;
          }
        })(),
        ulwExpandedMandate: (() => {
          try {
            const u = loadUlwCycle(opts.session.meta.id);
            if (!u?.enabled || !u.softPrompt) return null;
            const text = String(u.expandedMandate || "").trim();
            if (!text) return null;
            return text.length > 240 ? `${text.slice(0, 240)}…` : text;
          } catch {
            return null;
          }
        })(),
        goalActive: Boolean(
          (() => {
            try {
              const g = loadGoal(opts.session.meta.id);
              return g && g.status === "active" && !g.paused;
            } catch {
              return false;
            }
          })(),
        ),
        goal: (() => {
          try {
            const g = loadGoal(opts.session.meta.id);
            if (!g || g.status !== "active" || g.paused) return null;
            const text = String(g.objective || "").trim();
            if (!text) return null;
            return text.length > 200 ? `${text.slice(0, 200)}…` : text;
          } catch {
            return null;
          }
        })(),
        goalStuckThreshold: opts.config.goal?.stuckThreshold ?? null,
        goalBlocks: (() => {
          try {
            const g = loadGoal(opts.session.meta.id);
            return g?.objective ? g.blocks : null;
          } catch {
            return null;
          }
        })(),
        goalStuckBlocks: (() => {
          try {
            const g = loadGoal(opts.session.meta.id);
            return g?.objective ? g.stuckBlocks : null;
          } catch {
            return null;
          }
        })(),
        goalCriteria: (() => {
          try {
            const g = loadGoal(opts.session.meta.id);
            if (!g?.objective || !Array.isArray(g.criteria) || !g.criteria.length) {
                return null;
            }
            return g.criteria.slice(0, 7).map((c) => {
                const s = String(c || "").trim();
                return s.length > 120 ? `${s.slice(0, 120)}…` : s;
            });
          } catch {
            return null;
          }
        })(),
        denyRules: opts.config.permission?.deny?.length ?? 0,
        allowRules: opts.config.permission?.allow?.length ?? 0,
        askRules: opts.config.permission?.ask?.length ?? 0,
        maxTurns: opts.config.maxTurns ?? 0,
        maxTurnsUnlimited: !(
          typeof opts.config.maxTurns === "number" && opts.config.maxTurns > 0
        ),
        maxCostUsd: opts.config.maxCostUsd ?? 0,
        maxCostUnlimited: !(
          typeof opts.config.maxCostUsd === "number" && opts.config.maxCostUsd > 0
        ),
        effectiveMaxCostUsd: resolveMaxCostUsd(opts.config, opts.session.meta),
        ...familyCostJson(
          opts.session.meta,
          String(opts.config.provider),
          opts.config.model,
        ),
        productionWarnings: productionWarningsForRun(opts.config, {
          ultrawork: Boolean(opts.session.meta.ultrawork),
          sessionMaxCostUsd: opts.session.meta.maxCostUsd,
          editCount: opts.session.meta.editCount,
          lastVerificationCommand: opts.session.meta.lastVerificationCommand,
          lastVerificationAt: opts.session.meta.lastVerificationAt,
          lastEditAt: opts.session.meta.lastEditAt,
        }),
        formatOnWrite: isFormatOnWriteEnabled(),
        subagentLandMode: resolveWorktreeLandMode(),
        projectMemoryCount: (() => {
          try {
            return listActiveProjectMemory(
              opts.session.meta.cwd || process.cwd(),
            ).length;
          } catch {
            return 0;
          }
        })(),
        lastCheckpoint: opts.session.meta.lastCheckpoint ?? null,
        autoCommit: opts.session.meta.lastAutoCommit ?? null,
        blockingStop: !isFalsy(opts.config.blockingStopHooks),
        maxRunMs: maxRunMsFromEnv(),
        providerTimeoutMs: providerTimeoutMs(),
        bashTimeoutMs: defaultBashTimeoutMs(),
        bashBackgroundTimeoutMs: defaultBashBackgroundTimeoutMs(),
        permissionAskTimeoutMs: permissionAskTimeoutMs() || null,
        doomLoopThreshold: envPositiveInt("FORGE_DOOM_LOOP_THRESHOLD", 3),
        errorStreakThreshold: envPositiveInt("FORGE_ERROR_STREAK_THRESHOLD", 5),
        ulwMaxContinues: envPositiveInt("FORGE_ULW_MAX_CONTINUES", 200),
        editCount: opts.session.meta.editCount,
        lastVerificationCommand:
          opts.session.meta.lastVerificationCommand ?? null,
        lastVerificationAt: opts.session.meta.lastVerificationAt ?? null,
        lastEditAt: opts.session.meta.lastEditAt ?? null,
        lastVerificationStale: isLastVerificationStale(opts.session.meta),
        openTodos: openTodos(opts.session.todos || []),
        messageCount: opts.session.messages?.length ?? 0,
        durationMs: Date.now() - t0,
      });
      process.exit(timedOut ? 124 : 1);
    }
    // Human path: print recovery tips then rethrow for outer handler / exit
    if (recovery) {
      try {
        const { formatProviderErrorText } = await import(
          "./providers/errors.js"
        );
        log.error(
          formatProviderErrorText(err, {
            provider: String(opts.config.provider),
            model: opts.config.model,
          }),
        );
      } catch {
        log.error(message);
      }
      process.exit(timedOut ? 124 : 1);
    }
    throw err;
  } finally {
    if (maxRunTimer) clearTimeout(maxRunTimer);
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }

  try {
    // Wall-clock timeout: stamp lastError for expert recovery surfaces
    if (timedOut) {
      try {
        const { setSessionLastError } = await import("./session/session.js");
        setSessionLastError(opts.session, {
          code: "max_run_ms",
          message: "Run hit FORGE_MAX_RUN_MS wall-clock limit (exit 124)",
          tips: [
            "Raise FORGE_MAX_RUN_MS or narrow the task",
            "forge run --continue  ·  /retry  ·  /sessions errors",
          ],
        });
      } catch {
        /* */
      }
    }
    await opts.hooks.run("SessionEnd", {
      sessionId: opts.session.meta.id,
      cwd: opts.session.meta.cwd,
      workspaceRoot: opts.config.workspace || opts.session.meta.cwd,
    });
    saveSession(opts.session);

    // Headless turn-end attention (opt-in BEL/notify) — same verify trail as REPL.
    try {
      const outcome = turnEndOutcomeLabel({
        hitCostCap: result.hitCostCap,
        hitMaxTurns: result.hitMaxTurns,
        releasedOnContinueCap: result.releasedOnContinueCap,
        stuckReleased: result.stuckReleased,
        lastCycleReleased: result.lastCycleReleased,
        aborted: result.aborted,
        lastErrorCode: opts.session.meta.lastError?.code,
        editCount: opts.session.meta.editCount,
        lastVerificationCommand: opts.session.meta.lastVerificationCommand,
        lastVerificationStale: isLastVerificationStale(opts.session.meta),
      });
      maybeTurnEndAttention({
        title: "Forge",
        body: `${opts.session.meta.title || "forge run"} · ${outcome}`,
      });
    } catch {
      /* never block headless exit on notify */
    }

    if (!opts.json && result.finalText && !result.finalText.endsWith("\n")) {
      process.stdout.write("\n");
    }
    if (!opts.json) {
      try {
        const line = formatTurnChangeSummaryForSession(
          opts.session,
          turnAtStart,
        );
        if (line) process.stdout.write(`${chalk.dim(line)}\n`);
      } catch {
        /* summary is best-effort — never block headless exit */
      }
    }

    const durationMs = Date.now() - t0;
    const goal = loadGoal(opts.session.meta.id);
    const emptyRun = isEmptyRunResult(result);
    if (emptyRun && !timedOut && !result.aborted) {
      try {
        const { setSessionLastError } = await import("./session/session.js");
        setSessionLastError(opts.session, {
          code: "empty_run",
          message:
            "Empty run: no model turns and no finalText — check auth/model or provider logs",
          tips: [
            "forge doctor  ·  forge auth  ·  check model id",
            "forge logs  ·  raise --max-turns  ·  inspect sessionPath",
          ],
        });
        saveSession(opts.session);
      } catch {
        /* */
      }
    }
    if (!opts.json) {
      try {
        const stop = formatRunStopReason({
          hitCostCap: result.hitCostCap,
          hitMaxTurns: result.hitMaxTurns,
          releasedOnContinueCap: result.releasedOnContinueCap,
          stuckReleased: result.stuckReleased,
          lastCycleReleased: result.lastCycleReleased,
          aborted: result.aborted,
          stopContinues: result.stopContinues,
          lastErrorCode: opts.session.meta.lastError?.code,
        });
        if (stop) process.stdout.write(`${chalk.dim(stop)}\n`);
      } catch {
        /* stop reason is best-effort — never block headless exit */
      }
    }
    const payload = {
      // Align ok with CI exit codes: empty/no-turn runs are not success.
      ok: !result.aborted && !timedOut && !emptyRun,
      ...(result.aborted
        ? {
            reason: "aborted" as const,
            error: "Run aborted (SIGINT/SIGTERM or FORGE_MAX_RUN_MS cancel).",
          }
        : timedOut
          ? {
              reason: "timeout" as const,
              error:
                "Run hit FORGE_MAX_RUN_MS wall-clock limit (exit 124).",
            }
          : emptyRun
            ? {
                reason: "empty_run" as const,
                error:
                  "Empty run: no model turns and no finalText. " +
                  "Check auth/model, provider errors in logs, or raise --max-turns / inspect sessionPath.",
              }
            : {}),
      version: getForgeVersion(),
      node: process.version,
      forgeHome: forgeHome(),
      sessionId: opts.session.meta.id,
      sessionPath: resolveSessionDir(opts.session.meta.id),
      title: opts.session.meta.title || null,
      pinned: Boolean(opts.session.meta.pinned),
      foreignLock: sessionHasForeignLiveLock(opts.session.meta.id),
      provider: opts.config.provider,
      stickyProvider: (() => {
        try {
          return loadPreferences().provider ?? null;
        } catch {
          return null;
        }
      })(),
      authMethod: (() => {
        try {
          const a = resolveAuth(opts.config);
          return a?.method ?? null;
        } catch {
          return null;
        }
      })(),
      model: opts.config.model,
      reasoningEffort:
        resolveReasoningEffort(
          opts.config.model,
          opts.config.reasoningEffort,
        ) ?? null,
      ...(opts.config.baseUrl
        ? { baseUrl: opts.config.baseUrl }
        : {}),
      cwd: opts.session.meta.cwd || opts.config.workspace || null,
      git: gitSnapshotForRun(
        opts.session.meta.cwd || opts.config.workspace || process.cwd(),
      ),
      projectLabel: (() => {
        const cwd =
          opts.session.meta.cwd || opts.config.workspace || process.cwd();
        try {
          const parts = String(cwd)
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .filter(Boolean);
          return parts.slice(-2).join("/") || String(cwd);
        } catch {
          return null;
        }
      })(),
      projectHints: (() => {
        try {
          return detectProjectHints(
            opts.session.meta.cwd || opts.config.workspace || process.cwd(),
          );
        } catch {
          return [];
        }
      })(),
      ...(() => {
        const cwd =
          opts.session.meta.cwd || opts.config.workspace || process.cwd();
        const m = packageManifestForRun(cwd);
        const intel = projectIntelForRun(cwd);
        return {
          packageName: m.name,
          packageVersion: m.version,
          packageEnginesNode: m.enginesNode,
          packageManager: intel.packageManager,
          checkCommands: intel.checkCommands,
          projectStackSummary: intel.projectStackSummary,
          monorepoRoot: intel.monorepoRoot,
          workspaces: intel.workspaces,
          nodeModulesPresent: intel.nodeModulesPresent,
          multipleLockfiles: intel.multipleLockfiles,
        };
      })(),
      permissionMode: opts.config.permissionMode,
      contextWindow: opts.config.contextWindow,
      autoCompactThreshold: opts.config.autoCompactThreshold,
      contextWindowExplicit: Boolean(opts.config.contextWindowExplicit),
      sandbox: opts.config.sandbox,
      sandboxNetwork: resolveSandboxNetwork(opts.config),
      sandboxMissingBackend: opts.config.sandboxMissingBackend ?? "fail-closed",
      readOutsideWorkspace: opts.config.readOutsideWorkspace ?? "ask",
      ultrawork: Boolean(opts.session.meta.ultrawork),
      ulwCycle: (() => {
        try {
          const u = loadUlwCycle(opts.session.meta.id);
          return u?.enabled ? u.cycle : null;
        } catch {
          return null;
        }
      })(),
      ulwWave: (() => {
        try {
          const u = loadUlwCycle(opts.session.meta.id);
          return u?.enabled ? u.wave : null;
        } catch {
          return null;
        }
      })(),
      ulwMaxWaves: (() => {
        try {
          const u = loadUlwCycle(opts.session.meta.id);
          if (!u?.enabled) return null;
          return u.maxWaves ?? null;
        } catch {
          return null;
        }
      })(),
      ulwBlocks: (() => {
        try {
          const u = loadUlwCycle(opts.session.meta.id);
          return u?.enabled ? u.blocks : null;
        } catch {
          return null;
        }
      })(),
      ulwMandate: (() => {
        try {
          const u = loadUlwCycle(opts.session.meta.id);
          if (!u?.enabled) return null;
          const text = String(u.mandate || "").trim();
          if (!text) return null;
          return text.length > 200 ? `${text.slice(0, 200)}…` : text;
        } catch {
          return null;
        }
      })(),
      ulwSoftPrompt: (() => {
        try {
          const u = loadUlwCycle(opts.session.meta.id);
          return u?.enabled ? Boolean(u.softPrompt) : null;
        } catch {
          return null;
        }
      })(),
      ulwExpandedMandate: (() => {
        try {
          const u = loadUlwCycle(opts.session.meta.id);
          if (!u?.enabled || !u.softPrompt) return null;
          const text = String(u.expandedMandate || "").trim();
          if (!text) return null;
          return text.length > 240 ? `${text.slice(0, 240)}…` : text;
        } catch {
          return null;
        }
      })(),
      goalActive: Boolean(goal && goal.status === "active" && !goal.paused),
      goal: (() => {
        if (!goal || goal.status !== "active" || goal.paused) return null;
        const text = String(goal.objective || "").trim();
        if (!text) return null;
        return text.length > 200 ? `${text.slice(0, 200)}…` : text;
      })(),
      goalStuckThreshold: opts.config.goal?.stuckThreshold ?? null,
      goalBlocks: (() => {
        try {
          const g = loadGoal(opts.session.meta.id);
          return g?.objective ? g.blocks : null;
        } catch {
          return null;
        }
      })(),
      goalStuckBlocks: (() => {
        try {
          const g = loadGoal(opts.session.meta.id);
          return g?.objective ? g.stuckBlocks : null;
        } catch {
          return null;
        }
      })(),
      goalCriteria: (() => {
        try {
          const g = loadGoal(opts.session.meta.id);
          if (!g?.objective || !Array.isArray(g.criteria) || !g.criteria.length) {
            return null;
          }
          return g.criteria.slice(0, 7).map((c) => {
            const s = String(c || "").trim();
            return s.length > 120 ? `${s.slice(0, 120)}…` : s;
          });
        } catch {
          return null;
        }
      })(),
      denyRules: opts.config.permission?.deny?.length ?? 0,
      allowRules: opts.config.permission?.allow?.length ?? 0,
      askRules: opts.config.permission?.ask?.length ?? 0,
maxTurns: opts.config.maxTurns ?? 0,
      maxTurnsUnlimited: !(
        typeof opts.config.maxTurns === "number" && opts.config.maxTurns > 0
      ),
      maxCostUsd: opts.config.maxCostUsd ?? 0,
      maxCostUnlimited: !(
        typeof opts.config.maxCostUsd === "number" && opts.config.maxCostUsd > 0
      ),
      // Effective cap after session /budget override (null = unlimited).
      effectiveMaxCostUsd: resolveMaxCostUsd(opts.config, opts.session.meta),
      ...familyCostJson(
        opts.session.meta,
        String(opts.config.provider),
        opts.config.model,
      ),
      productionWarnings: productionWarningsForRun(opts.config, {
        ultrawork: Boolean(opts.session.meta.ultrawork),
        sessionMaxCostUsd: opts.session.meta.maxCostUsd,
        hitCostCap: result.hitCostCap,
        hitMaxTurns: result.hitMaxTurns,
        releasedOnContinueCap: result.releasedOnContinueCap,
        editCount: opts.session.meta.editCount,
        lastVerificationCommand: opts.session.meta.lastVerificationCommand,
          lastVerificationAt: opts.session.meta.lastVerificationAt,
          lastEditAt: opts.session.meta.lastEditAt,
      }),
      formatOnWrite: isFormatOnWriteEnabled(),
        subagentLandMode: resolveWorktreeLandMode(),
        projectMemoryCount: (() => {
          try {
            return listActiveProjectMemory(
              opts.session.meta.cwd || process.cwd(),
            ).length;
          } catch {
            return 0;
          }
        })(),
        lastCheckpoint: opts.session.meta.lastCheckpoint ?? null,
        autoCommit: result.autoCommit ?? opts.session.meta.lastAutoCommit ?? null,
      blockingStop: !isFalsy(opts.config.blockingStopHooks),
      maxRunMs: maxRunMsFromEnv(),
      providerTimeoutMs: providerTimeoutMs(),
      bashTimeoutMs: defaultBashTimeoutMs(),
      bashBackgroundTimeoutMs: defaultBashBackgroundTimeoutMs(),
      permissionAskTimeoutMs: permissionAskTimeoutMs() || null,
      doomLoopThreshold: envPositiveInt("FORGE_DOOM_LOOP_THRESHOLD", 3),
      errorStreakThreshold: envPositiveInt("FORGE_ERROR_STREAK_THRESHOLD", 5),
      ulwMaxContinues: envPositiveInt("FORGE_ULW_MAX_CONTINUES", 200),
      finalText: result.finalText,
      turns: result.turns,
      stopContinues: result.stopContinues,
      releasedOnContinueCap: result.releasedOnContinueCap,
      hitMaxTurns: result.hitMaxTurns,
      hitCostCap: result.hitCostCap,
      stuckReleased: result.stuckReleased,
      lastCycleReleased: result.lastCycleReleased,
      finishReason: result.finishReason,
      harnessUserPokes: result.harnessUserPokes ?? 0,
      admitCount: result.admitCount ?? 0,
      proofPokes: result.proofPokes ?? 0,
      providerRounds: result.providerRounds ?? result.turns,
      lastError: opts.session.meta.lastError
        ? {
            at: opts.session.meta.lastError.at,
            code: opts.session.meta.lastError.code,
            message: opts.session.meta.lastError.message,
            tips: opts.session.meta.lastError.tips,
          }
        : null,
      editCount: opts.session.meta.editCount,
        lastVerificationCommand:
          opts.session.meta.lastVerificationCommand ?? null,
        lastVerificationAt: opts.session.meta.lastVerificationAt ?? null,
        lastEditAt: opts.session.meta.lastEditAt ?? null,
        lastVerificationStale: isLastVerificationStale(opts.session.meta),
      openTodos: openTodos(opts.session.todos || []),
      messageCount: opts.session.messages?.length ?? 0,
      aborted: result.aborted,
      timedOut,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cacheReadTokens: result.cacheReadTokens,
      lastRoundPromptTokens: opts.session.meta.lastRoundPromptTokens ?? null,
      lastRoundCacheReadTokens: opts.session.meta.lastRoundCacheReadTokens ?? null,
      lastPruneKind: opts.session.meta.lastPruneKind ?? null,
      lastRoundCacheRatio: (() => {
        const lastP = opts.session.meta.lastRoundPromptTokens ?? 0;
        const lastC = opts.session.meta.lastRoundCacheReadTokens ?? 0;
        return lastP > 0 ? Math.min(1, lastC / lastP) : null;
      })(),
      servedModels: result.servedModels,
      fallbackModels: opts.config.fallbackModels ?? null,
      fallbackChain: formatFallbackChain(opts.config),
      lastModelFallback: opts.session.meta.lastModelFallback ?? null,
      durationMs,
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
        hitCostCap: payload.hitCostCap,
        stuckReleased: payload.stuckReleased,
        lastCycleReleased: payload.lastCycleReleased,
        editCount: payload.editCount,
        promptTokens: payload.promptTokens,
        completionTokens: payload.completionTokens,
        cacheReadTokens: payload.cacheReadTokens,
        lastRoundPromptTokens: payload.lastRoundPromptTokens ?? undefined,
        lastRoundCacheReadTokens: payload.lastRoundCacheReadTokens ?? undefined,
        lastRoundCacheRatio: payload.lastRoundCacheRatio ?? undefined,
        servedModels: payload.servedModels,
        harnessUserPokes: payload.harnessUserPokes,
        admitCount: payload.admitCount,
        proofPokes: payload.proofPokes,
        providerRounds: payload.providerRounds,
        durationMs,
        aborted: payload.aborted,
        timedOut: payload.timedOut,
        ok: payload.ok,
        headless: true,
        ultrawork: opts.session.meta.ultrawork,
        // Continue-cap / content-filter releases stamp lastError — surface in metrics
        lastErrorCode: opts.session.meta.lastError?.code || undefined,
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
