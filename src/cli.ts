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
import type { ForgeConfig } from "./config/types.js";
import { parseReasoningEffort } from "./config/reasoning.js";
import { resolveAuth, resolveAuthFresh, describeAuth } from "./auth/resolve.js";
import { loginInteractive, logout, printAuthStatus, supportsOAuth } from "./auth/login.js";
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
    .option("--title <text>", "Label for a new session (searchable via list -q / /sessions search)")
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
      const auth = await resolveAuthFresh(config);
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
      const prompt = promptParts?.length ? promptParts.join(" ") : undefined;
      const willHeadless = Boolean(
        prompt && (!process.stdin.isTTY || process.env.FORGE_HEADLESS === "1"),
      );
      // Interactive REPL: resume newest same-cwd session (OpenCode --continue style)
      // unless --new / --session / FORGE_NO_AUTO_RESUME. Headless always fresh unless --session.
      const session = resolveSession(config, {
        ...opts,
        autoResume: !willHeadless,
      });
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
        const result = await runHeadless({
          config,
          provider,
          session,
          hooks,
          prompt,
        });
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
    .argument("<prompt...>", "Prompt to run")
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
  releasedOnContinueCap, hitMaxTurns, editCount, aborted, timedOut, promptTokens,
  completionTokens, durationMs, model, provider
  (releasedOnContinueCap/hitMaxTurns → safety valves; still ok unless aborted/timedOut)

Empty prompts exit 1 before auth/session create (no orphan sessions, no API spend).
Label runs: --title <label> (searchable via forge sessions list -q / /sessions search).
Multi-step CI without copying ids: forge run "…" --continue --json

CI tips: forge doctor --json · --permission-mode acceptEdits · --sandbox workspace · --title ci-job
Docs: docs/PRODUCTION.md
`,
    )
    .action(async (promptParts: string[], opts, command) => {
      await ensureHome();
      // Validate prompt before auth/session side effects (no orphan empty sessions).
      const prompt = (promptParts || []).join(" ").trim();
      const wantJson = Boolean(opts.json);
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
      const config = buildConfig({ ...opts, permissionMode: opts.permissionMode });
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
      const cwd = path.resolve(opts.cwd || process.cwd());
      // Commander always applies option defaults — only treat --cwd as explicit
      // when the user actually passed it on the CLI (so --session keeps its cwd).
      const cwdExplicit = command?.getOptionValueSource?.("cwd") === "cli";
      let session;
      let resumed = false;
      if (opts.session && !opts.new) {
        session = loadSession(String(opts.session));
        if (!session) {
          const miss = formatSessionLookupMiss(String(opts.session));
          if (wantJson) {
            console.log(
              JSON.stringify({
                ok: false,
                error: miss,
                reason: "session_not_found",
                session: String(opts.session),
              }),
            );
          } else {
            log.error(miss);
          }
          process.exit(1);
        }
        resumed = true;
      } else if (opts.continue && !opts.new) {
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
        if (!opts.model) config.model = session.meta.model || config.model;
        if (!opts.provider) {
          config.provider = (session.meta.provider || config.provider) as typeof config.provider;
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
        if (opts.session) {
          log.dim(`Resuming session ${session.meta.id.slice(0, 8)} (${session.messages.length} msgs)`);
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
          ultrawork: Boolean(opts.ulw || opts.goal),
          title: typeof opts.title === "string" ? opts.title : undefined,
        });
      }
      // Allow --title on resume to relabel (experts tagging CI pipelines)
      if (
        opts.title &&
        typeof opts.title === "string" &&
        (opts.session || opts.continue)
      ) {
        setSessionTitle(session, opts.title);
      }
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
      // CI-friendly exit codes: wall-clock timeout=124, abort=130, empty=1
      if (result.timedOut) process.exitCode = 124;
      else if (result.aborted) process.exitCode = 130;
      else if (!result.finalText && result.turns === 0) process.exitCode = 1;
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
              const hours = Math.max(
                0,
                (result.expiresAt - Math.floor(Date.now() / 1000)) / 3600,
              );
              log.dim(
                `Access token expires ${new Date(result.expiresAt * 1000).toISOString()} (~${hours.toFixed(1)}h). ` +
                  `SuperGrok sessions are ~6h; Forge re-imports ~/.grok/auth.json on start when stale. ` +
                  `For multi-day runs use: forge login --api-key`,
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
    .action(async () => {
      printAuthStatus();
      const config = loadConfig();
      const auth = await resolveAuthFresh(config);
      console.log(`\nActive resolution: ${describeAuth(auth)}`);
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
    .option("-n, --limit <n>", "List limit", "30")
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
          log.error("Usage: forge sessions delete <id> [--force]");
          process.exit(1);
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
          log.error("Usage: forge sessions path <id|title>");
          process.exit(1);
        }
        const dir = resolveSessionDir(target);
        if (!dir) {
          log.error(formatSessionLookupMiss(target));
          process.exit(1);
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
          log.error("Usage: forge sessions show <id>");
          process.exit(1);
        }
        const s = loadSession(target);
        if (!s) {
          log.error(formatSessionLookupMiss(target));
          process.exit(1);
        }
        const lock = readSessionLock(s.meta.id);
        const foreignLock = sessionHasForeignLiveLock(s.meta.id);
        if (globalOpts.json) {
          const dir = resolveSessionDir(s.meta.id);
          console.log(
            JSON.stringify(
              {
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
          log.error("Usage: forge sessions export <id> [--format md|json] [--out path]");
          process.exit(1);
        }
        // Validate format before session lookup so bad flags fail fast.
        const fmt = String(globalOpts.format || "md").toLowerCase();
        if (fmt !== "md" && fmt !== "markdown" && fmt !== "json") {
          log.error(`Unknown export format "${fmt}". Use md or json.`);
          process.exit(1);
        }
        const s = loadSession(target);
        if (!s) {
          log.error(formatSessionLookupMiss(target));
          process.exit(1);
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
        if (globalOpts.out) {
          const p = path.resolve(String(globalOpts.out));
          // Exports may contain secrets from agent transcripts — mode 0600.
          fs.writeFileSync(p, body, { encoding: "utf8", mode: 0o600 });
          try {
            fs.chmodSync(p, 0o600);
          } catch {
            /* windows / some FS ignore mode */
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
          log.error("Usage: forge sessions import <export.json>");
          process.exit(1);
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
          log.error(`Usage: forge sessions ${act} <id|title>`);
          process.exit(1);
        }
        const s = loadSession(target);
        if (!s) {
          log.error(formatSessionLookupMiss(target));
          process.exit(1);
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
          log.error(
            "Usage: forge sessions title <id|title> <name|clear|none|->",
          );
          process.exit(1);
        }
        const s = loadSession(target);
        if (!s) {
          log.error(formatSessionLookupMiss(target));
          process.exit(1);
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
          log.error("Usage: forge sessions fork <id>");
          process.exit(1);
        }
        const s = loadSession(target);
        if (!s) {
          log.error(formatSessionLookupMiss(target));
          process.exit(1);
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
        const result = pruneSessions({
          keep: Number(globalOpts.keep) || 50,
          maxAgeDays:
            globalOpts.maxAgeDays != null
              ? Number(globalOpts.maxAgeDays)
              : undefined,
        });
        if (globalOpts.json) {
          console.log(JSON.stringify(result, null, 2));
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
      const limit = Number(globalOpts.limit) || 30;
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
              cwd: cwdFilter,
              query: queryFilter,
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
    .action((opts) => {
      const config = loadConfig();
      if (opts.json) {
        const rows = Object.entries(config.providers).map(([id, p]) => ({
          provider: id,
          defaultModel: p.defaultModel || null,
          supportsOAuth: Boolean(p.supportsOAuth),
          models: p.models?.length ? p.models : p.defaultModel ? [p.defaultModel] : [],
          baseUrl: p.baseUrl || null,
        }));
        console.log(JSON.stringify({ providers: rows }, null, 2));
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
    .action((opts) => {
      const before = toolOutputStats();
      const result = pruneToolOutputsSync({
        keep: Number(opts.keep) || 80,
        maxAgeDays: Number(opts.maxAgeDays) || 14,
      });
      if (opts.json) {
        console.log(
          JSON.stringify({ before, ...result, after: toolOutputStats() }, null, 2),
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
    .action((opts) => {
      const before = metricsStats();
      const result = pruneMetrics({ keep: Number(opts.keep) || 500 });
      if (opts.json) {
        console.log(JSON.stringify({ before, ...result }, null, 2));
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
    .option("--json", "Machine-readable JSON array")
    .action(async (opts) => {
      if (opts.path) {
        console.log(sandboxLogPath());
        return;
      }
      const n = Math.min(200, Math.max(1, Number(opts.lines) || 30));
      if (opts.json) {
        const { readSandboxLogTail } = await import("./agent/sandbox-log.js");
        console.log(JSON.stringify(readSandboxLogTail(n), null, 2));
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
    .action((opts) => {
      const config = buildConfig(opts);
      console.log(
        formatEffectiveConfig(config, {
          json: Boolean(opts.json),
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
    .action((opts) => {
      const daysRaw = opts.days != null ? Number(opts.days) : 0;
      const days =
        Number.isFinite(daysRaw) && daysRaw > 0 ? Math.floor(daysRaw) : 0;
      const stats = collectUsageStats({ days });
      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
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
    .action((countArg: string, opts: { json?: boolean }) => {
      const n = Math.max(1, Math.min(10, parseInt(String(countArg || "1"), 10) || 1));
      if (opts.json) {
        const releases = loadChangelogReleases().slice(0, n);
        console.log(
          JSON.stringify(
            {
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
    });

  program
    .command("doctor")
    .description("Check auth, Node version, config, and harness settings")
    .option("-p, --provider <provider>", "Provider override")
    .option("--cwd <path>", "Workspace", process.cwd())
    .option("--json", "Machine-readable summary on stdout")
    .action((opts) => {
      const config = buildConfig(opts);
      if (opts.json) {
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
  {
    const effortRaw = opts.effort ?? opts.reasoningEffort;
    if (effortRaw != null && String(effortRaw).trim()) {
      const e = parseReasoningEffort(String(effortRaw));
      if (!e) {
        log.error(
          `Invalid --effort "${effortRaw}". Use low, medium, or high.`,
        );
        process.exit(1);
      }
      overrides.reasoningEffort = e;
    }
  }
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
  opts: {
    session?: string;
    new?: boolean;
    cwd?: string;
    title?: string;
    /** When true and no --session/--new, resume newest same-cwd session. */
    autoResume?: boolean;
  },
) {
  if (opts.session) {
    const s = loadSession(opts.session);
    if (!s) {
      log.error(formatSessionLookupMiss(opts.session));
      process.exit(1);
    }
    if (typeof opts.title === "string" && opts.title.trim()) {
      setSessionTitle(s, opts.title);
    }
    // Explicit --session (interactive): same orientation peek as auto-resume.
    if (opts.autoResume) {
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
  const noAuto =
    opts.new ||
    process.env.FORGE_NO_AUTO_RESUME === "1" ||
    process.env.FORGE_NO_AUTO_RESUME === "true";
  // Explicit --title on a fresh start should not silently attach to auto-resume.
  const wantTitle =
    typeof opts.title === "string" && opts.title.trim().length > 0;
  if (opts.autoResume && !noAuto && !wantTitle) {
    try {
      const hit = findRecentSessionForCwd(cwd);
      if (hit?.meta) {
        const s = loadSession(hit.meta.id);
        if (s) {
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
        log.info(
          `Starting fresh session — ${hit.skippedLocked} same-cwd session${hit.skippedLocked === 1 ? "" : "s"} locked by other process(es). Use --session <id> to attach anyway.`,
        );
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
            error: message,
            timedOut,
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
