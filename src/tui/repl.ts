import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import { applyModelContextWindow } from "../config/model-info.js";
import type { LLMProvider } from "../providers/types.js";
import type { SessionData } from "../session/session.js";
import { HookRunner } from "../harness/hooks.js";
import { PermissionGate } from "../agent/permissions.js";
import { runAgentLoop } from "../agent/loop.js";
import {
  handleSlash,
  isLiveSafeSlash,
  classifyLiveSlash,
  LIVE_CONTROLS_HINT,
  type SlashResult,
} from "../commands/slash.js";
import { pushInterjection } from "../harness/interjection.js";
import { saveSession, isLastVerificationStale } from "../session/session.js";
import { readFileMutations } from "../session/mutations.js";
import { log } from "../util/log.js";
import {
  maybeTurnEndAttention,
  turnEndOutcomeLabel,
} from "../util/attention.js";
import { describeAuth, resolveAuthFresh } from "../auth/resolve.js";
import type { ResolvedAuth } from "../auth/types.js";
import {
  formatToolStart,
  formatToolEnd,
  formatDiffBlock,
  formatToolOutputHead,
} from "../util/format.js";
import { postureHead, postureWarnings } from "./posture.js";
import { formatTurnChangeSummary } from "./turn-summary.js";
import {
  createMarkdownRenderer,
  type MarkdownRenderer,
} from "./markdown.js";
import { getGitSnapshot } from "../util/git-context.js";
import { detectProjectIntel } from "../util/project-intel.js";
import { createProvider } from "../providers/factory.js";
import { resolveAuth } from "../auth/resolve.js";
import { heartbeatSession, releaseSession } from "../statusline/active.js";
import {
  beginTurn,
  endTurn,
  setPhase,
  getActivity,
  syncBackgroundCounts,
} from "../statusline/activity.js";
import {
  listTasks,
  killAllRunningTasks,
  installBackgroundTaskExitHook,
} from "../agent/tools/background-tasks.js";
import { loadHistory, appendHistory } from "./history.js";
import { makeCompleter } from "./complete.js";
import { createPromptEditor } from "./prompt-editor.js";
import {
  buildPromptFlags,
  buildLivePrompt,
  renderIdleStatusLine,
  renderLiveRunHeader,
  renderTurnFooter,
  formatLiveControlFeedback,
  createWorkingIndicator,
  type StatusBarContext,
} from "./status-bar.js";
import {
  acquireSessionLock,
  releaseSessionLock,
  formatLockHolder,
} from "../session/lock.js";

import { getForgeVersion } from "../util/version.js";
import { loadPreferences, savePreferences } from "../config/preferences.js";
const VERSION = getForgeVersion();

export async function runRepl(opts: {
  config: ForgeConfig;
  provider: LLMProvider;
  session: SessionData;
  hooks: HookRunner;
  auth: ResolvedAuth;
  initialPrompt?: string;
}): Promise<void> {
  let { config, provider, session, hooks, auth } = opts;
  const permissions = new PermissionGate({ interactive: true });
  installBackgroundTaskExitHook();

  // Exclusive session lock — fail-closed on live foreign holders (parity with
  // headless). Multi-day unattended + REPL must not race session.json.
  {
    const force =
      process.env.FORGE_FORCE_SESSION_LOCK === "1" ||
      process.env.FORGE_FORCE_SESSION_LOCK === "true";
    const lock = acquireSessionLock(session.meta.id, { force });
    if (!lock.ok && lock.holder) {
      if (!force) {
        log.error(
          `Session ${session.meta.id.slice(0, 8)} is locked by ${formatLockHolder(lock.holder)}. ` +
            `Refusing concurrent write (multi-day safety). Use forge --new, wait for the other process, ` +
            `or FORGE_FORCE_SESSION_LOCK=1 to override.`,
        );
        process.exit(1);
      }
      log.warn(
        `FORGE_FORCE_SESSION_LOCK — continuing despite lock held by ${formatLockHolder(lock.holder)}`,
      );
    } else if (lock.stolen && lock.holder) {
      log.dim(
        `Took over stale session lock from ${formatLockHolder(lock.holder)}`,
      );
    }
  }

  printBanner(config, auth, session);

  // Soft LSP ensure tip (once/day when recommended servers missing)
  try {
    const { maybeLspEnsureTip } = await import("../lsp/ensure.js");
    const tip = maybeLspEnsureTip(config.workspace || session.meta.cwd);
    if (tip) log.dim(tip);
  } catch {
    /* never block REPL on LSP tip */
  }

  let lastKnownBgRunning = 0;

  const refreshIdlePromptFlags = () => {
    if (busy || !process.stdout.isTTY) return;
    try {
      const prefix = buildPromptFlags(statusCtx());
      rl.setPrompt(prefix + chalk.green("forge") + chalk.dim(" › "));
      // Redisplay prompt without accepting a new line
      rl.prompt(true);
    } catch {
      /* readline may be closed */
    }
  };

  const pulseHeartbeat = () => {
    const act = getActivity();
    const bgRunning = listTasks().filter((t) => t.status === "running").length;
    if (bgRunning !== act.bgRunning) {
      syncBackgroundCounts({
        running: bgRunning,
        total: listTasks().length,
        hint: act.bgHint,
      });
    }
    // Live-update prompt flags when bg tasks finish while idle
    if (!busy && bgRunning !== lastKnownBgRunning) {
      lastKnownBgRunning = bgRunning;
      lastStatusStrip = "";
      refreshIdlePromptFlags();
    } else {
      lastKnownBgRunning = bgRunning;
    }
    heartbeatSession({
      sessionId: session.meta.id,
      cwd: session.meta.cwd,
      provider: session.meta.provider,
      model: config.model,
      busy: act.busy,
      phase: act.phase,
      phaseDetail: act.detail,
      bgRunning: Math.max(act.bgRunning, bgRunning),
    });
  };

  // statusCtx / lastStatusStrip / rl are declared below; heartbeat uses them
  // after rl is created — first pulse is deferred until then.

  await hooks.run("SessionStart", {
    sessionId: session.meta.id,
    cwd: session.meta.cwd,
    workspaceRoot: config.workspace || session.meta.cwd,
  });

  let busy = false;
  let abortController: AbortController | null = null;
  /** Session-local: diffs + tool output under each end line (minimal when off). */
  let verboseToolOutput = false;
  /**
   * Tools currently between onPhase("tool") and onToolSettled
   * (includes permission prompts — not only running tools).
   */
  let pendingTools = 0;

  const savedHistory = loadHistory(300);
  // Premium multi-line paste editor (bracketed paste + explicit Enter to send).
  // Falls back to classic readline when stdin is not a TTY.
  const rl = createPromptEditor({
    history: savedHistory,
    historySize: 300,
    completer: makeCompleter(() => config),
  });

  const statusCtx = (): StatusBarContext => ({ config, session, auth });
  /** Avoid reprinting an identical strip on every empty Enter */
  let lastStatusStrip = "";
  /** Spinner frame for prompt-docked live status */
  let liveFrame = 0;
  /** When true, token stream has taken stdout — re-dock prompt after */
  let streamActive = false;

  /**
   * Mid-run prompt — THE visible status dock (spin + phase + live ›).
   * Always starts on a fresh line so tokens/spinner cannot erase it.
   */
  const livePrompt = (opts?: { freshLine?: boolean }) => {
    try {
      if (opts?.freshLine !== false) {
        // Ensure we are not appending to a half-written model line
        process.stdout.write("\n");
      }
      rl.setPrompt(
        buildLivePrompt(statusCtx(), {
          frame: liveFrame,
          phase: getActivity().phase,
          detail: getActivity().detail,
        }),
      );
      rl.prompt();
    } catch {
      /* readline may be closed */
    }
  };

  const working = createWorkingIndicator({
    getContext: statusCtx,
    // Critical: no \r spinner — it was wiping live › off the terminal
    dockInPrompt: true,
    onTick: (frame) => {
      if (!busy || streamActive) return;
      liveFrame = frame;
      try {
        rl.setPrompt(
          buildLivePrompt(statusCtx(), {
            frame,
            phase: getActivity().phase,
            detail: getActivity().detail,
          }),
        );
        // true = preserve current input buffer while redrawing
        rl.prompt(true);
      } catch {
        /* ignore */
      }
    },
  });

  pulseHeartbeat();
  const hbTimer = setInterval(pulseHeartbeat, 4_000);
  hbTimer.unref?.();

  /** Idle prompt (forge ›) with status strip above. */
  const prompt = (opts?: { forceStatus?: boolean }) => {
    if (process.stdout.isTTY) {
      const strip = renderIdleStatusLine(statusCtx());
      if (strip && (opts?.forceStatus || strip !== lastStatusStrip)) {
        console.log(strip);
        lastStatusStrip = strip;
      }
    }
    const prefix = buildPromptFlags(statusCtx());
    rl.setPrompt(prefix + chalk.green("forge") + chalk.dim(" › "));
    rl.prompt();
  };

  const handleLine = async (line: string) => {
    const text = line.trim();
    if (!text) {
      if (busy) livePrompt();
      else prompt();
      return;
    }

    appendHistory(text);

    // REPL-local session toggle — works idle and mid-run, never persisted.
    if (text === "/verbose") {
      verboseToolOutput = !verboseToolOutput;
      const msg = verboseToolOutput
        ? "Tool detail: diffs + full output under each tool line (/verbose to minimize)"
        : "Tool detail: status lines only (/verbose for diffs + output)";
      if (busy) {
        console.log(formatLiveControlFeedback(text, msg, "ok"));
        livePrompt();
      } else {
        log.dim(msg);
        prompt();
      }
      return;
    }

    // ── Mid-run input ──────────────────────────────────────────────────
    // Keep stdin open during agent turns so users can steer the harness
    // without aborting (/cycle 0, /ulw-off, /goal pause, /status, …).
    // Free-text is queued as a Grok-style interjection (drained next LLM call).
    // Conversation mutators and new agent turns still require idle (or Ctrl+C).
    if (busy) {
      if (!text.startsWith("/")) {
        pushInterjection(session.meta.id, text);
        console.log(
          formatLiveControlFeedback(
            "(message)",
            `Queued for next model step.\n${LIVE_CONTROLS_HINT}`,
            "info",
          ),
        );
        livePrompt();
        return;
      }
      const liveKind = classifyLiveSlash(text);
      if (liveKind === "idle-only" || !isLiveSafeSlash(text)) {
        console.log(
          formatLiveControlFeedback(
            text,
            `That command needs an idle prompt (Ctrl+C to abort the run first).\n${LIVE_CONTROLS_HINT}`,
            "warn",
          ),
        );
        livePrompt();
        return;
      }

      working.pause();
      try {
        const slash = await handleSlash(text, { session, config, hooks, auth });
        if (slash.session) session = slash.session;
        if (slash.replaceSession) {
          console.log(
            formatLiveControlFeedback(
              text,
              "Cannot switch sessions while a run is in progress. Ctrl+C first.",
              "warn",
            ),
          );
          livePrompt();
          return;
        }
        if (slash.forwardPrompt) {
          console.log(
            formatLiveControlFeedback(
              text,
              "That command would start a new turn mid-run. Ctrl+C first, then retry.",
              "warn",
            ),
          );
          livePrompt();
          return;
        }
        // Mid-run /accounts switch or /provider: hot-swap client credentials
        if (slash.providerUpdated) {
          const fresh = await resolveAuthFresh(config, String(config.provider));
          if (fresh) {
            auth = fresh;
            provider = createProvider(config, auth);
          }
        } else if (slash.authUpdated && auth) {
          if (provider.updateCredentials) {
            provider.updateCredentials(auth.token);
          } else {
            provider = createProvider(config, auth);
          }
        }
        if (slash.output) {
          console.log(
            formatLiveControlFeedback(text, slash.output, "ok"),
          );
        } else {
          console.log(
            formatLiveControlFeedback(text, "Applied.", "ok"),
          );
        }
        if (slash.quit || liveKind === "quit") {
          if (abortController) abortController.abort();
          await shutdown();
          return;
        }
      } catch (err) {
        // Slash handlers do unguarded disk I/O (session save, prefs) — a
        // throw must surface on the live dock, not kill the REPL.
        console.log(
          formatLiveControlFeedback(
            text,
            (err as Error).message || String(err),
            "warn",
          ),
        );
      } finally {
        working.resume();
        working.repaint();
      }
      // Always restore the live input line so the next control is obvious
      livePrompt();
      return;
    }

    // Same guard as the live path — report the throw, keep the loop alive.
    let slash: SlashResult;
    try {
      slash = await handleSlash(text, { session, config, hooks, auth });
    } catch (err) {
      log.error((err as Error).message || String(err));
      prompt();
      return;
    }
    if (slash.replaceSession) {
      releaseSessionLock(session.meta.id);
      session = slash.replaceSession;
      const force =
        process.env.FORGE_FORCE_SESSION_LOCK === "1" ||
        process.env.FORGE_FORCE_SESSION_LOCK === "true";
      const lock = acquireSessionLock(session.meta.id, { force });
      if (!lock.ok && lock.holder) {
        if (!force) {
          log.error(
            `Resumed session locked by ${formatLockHolder(lock.holder)}. ` +
              `Refusing concurrent write. Use /new or FORGE_FORCE_SESSION_LOCK=1.`,
          );
          process.exit(1);
        }
        log.warn(
          `FORGE_FORCE_SESSION_LOCK — resumed despite lock by ${formatLockHolder(lock.holder)}`,
        );
      }
      hooks = new HookRunner(config, session.meta.cwd);
      const a = resolveAuth(config);
      if (a) {
        // Auth may fall back to another provider (expired xAI, only OpenAI
        // key left) — realign provider + model or the next call 404s on a
        // grok-4.5 id against a non-xAI endpoint. Mirrors cli.ts startup.
        if (a.provider !== config.provider) {
          config.provider = a.provider;
          const catalog = config.providers[a.provider]?.models ?? [];
          if (!catalog.includes(config.model)) {
            config.model =
              config.providers[a.provider]?.defaultModel || config.model;
          }
          applyModelContextWindow(config, config.model);
          log.dim(
            `Provider realigned to ${a.provider} (model ${config.model}) after auth fallback`,
          );
        }
        auth = a;
        provider = createProvider(config, auth);
      }
      if (slash.output) console.log(slash.output);
      prompt();
      return;
    }

    // /accounts switch or /provider mutates auth/config; hot-swap live client
    // so the next turn does not keep the previous bearer or base URL.
    if (slash.providerUpdated) {
      const fresh = await resolveAuthFresh(config, String(config.provider));
      if (fresh) {
        auth = fresh;
        provider = createProvider(config, auth);
        log.dim(
          `Provider switched → ${config.provider}/${config.model} (${describeAuth(auth)})`,
        );
      } else {
        log.warn(
          `Provider set to ${config.provider} but no credentials resolved — forge login -p ${config.provider}`,
        );
      }
    } else if (slash.authUpdated && auth) {
      if (provider.updateCredentials) {
        provider.updateCredentials(auth.token);
      } else {
        provider = createProvider(config, auth);
      }
      log.dim(`Provider credentials updated (${describeAuth(auth)})`);
    }

    if (slash.handled && !slash.forwardPrompt) {
      if (slash.output) console.log(slash.output);
      if (slash.quit) {
        await shutdown();
        return;
      }
      prompt();
      return;
    }

    const userMessage = slash.forwardPrompt || text;
    if (slash.output) console.log(slash.output);

    busy = true;
    pendingTools = 0;
    abortController = new AbortController();
    // For the end-of-turn change summary: edits with turn > this landed now.
    const turnAtStart = session.meta.turnCount;
    // Live controls need stdin while working (editor stays open).
    beginTurn();
    pulseHeartbeat();

    // Native live chrome: header + docked live › prompt (status lives IN the prompt)
    process.stdout.write("\n");
    console.log(renderLiveRunHeader(statusCtx()));
    console.log(
      chalk.bold.cyan("  ↓  controls open here — look for ") +
        chalk.bold.white("live ›") +
        chalk.bold.cyan("  at the bottom while working"),
    );
    streamActive = false;
    liveFrame = 0;
    working.start();
    livePrompt({ freshLine: true });

    let sawToken = false;
    /** Tool phase: pause prompt refresh so tool logs stay clean */
    let toolHold = false;
    /** Streaming markdown renderer for the current assistant text segment. */
    let md: MarkdownRenderer | null = null;
    /** Flush any buffered partial line (styled) before non-token output. */
    const flushMarkdown = () => {
      if (!md) return;
      const rest = md.end();
      md = null;
      if (rest) process.stdout.write(rest);
    };

    const setToolHold = (on: boolean) => {
      if (on && !toolHold) {
        working.pause();
        toolHold = true;
      } else if (!on && toolHold) {
        working.resume();
        toolHold = false;
      }
    };

    /** After model text or tools, re-dock the live line on a new row */
    const redockLive = () => {
      flushMarkdown();
      streamActive = false;
      working.setStreaming(false);
      livePrompt({ freshLine: true });
    };

    try {
      const result = await runAgentLoop({
        config,
        provider,
        session,
        hooks,
        permissions,
        userMessage,
        stream: true,
        signal: abortController.signal,
        events: {
          onToken: (t) => {
            if (!sawToken) {
              // Leave the live › line above; stream on following lines
              process.stdout.write("\n");
              working.setStreaming(true);
              streamActive = true;
              sawToken = true;
            }
            if (!md) md = createMarkdownRenderer();
            process.stdout.write(md.push(t));
          },
          onToolStart: (name, args) => {
            flushMarkdown();
            if (streamActive || sawToken) {
              process.stdout.write("\n");
            }
            streamActive = false;
            working.setStreaming(false);
            sawToken = false;
            console.error(formatToolStart(name, args));
          },
          onToolEnd: (name, r) => {
            // Minimal by default: one status line per tool. Diffs and output
            // heads are display-only (zero model tokens) but cost render time
            // and scroll noise on unattended runs — opt in with /verbose.
            console.error(formatToolEnd(name, r));
            if (verboseToolOutput) {
              if (r.diff) {
                console.error(formatDiffBlock(r.diff));
              } else if (r.output) {
                const head = formatToolOutputHead(r.output, {
                  verbose: true,
                });
                if (head) console.error(head);
              }
            }
          },
          onToolSettled: () => {
            pendingTools = Math.max(0, pendingTools - 1);
            if (pendingTools === 0) {
              setToolHold(false);
              // Between tools — re-dock live › under tool output
              redockLive();
            }
          },
          onPhase: (phase, detail) => {
            setPhase(phase, detail);
            working.setPhase(phase, detail);
            pulseHeartbeat();
            if (phase === "tool") {
              pendingTools += 1;
              // Permission prompts print before onToolStart — keep the
              // styled token stream ahead of any prompt output.
              flushMarkdown();
              streamActive = false;
              working.setStreaming(false);
              sawToken = false;
              setToolHold(true);
            } else if (
              (phase === "thinking" ||
                phase === "compacting" ||
                phase === "stop_guard") &&
              pendingTools === 0
            ) {
              setToolHold(false);
              if (streamActive || sawToken) {
                redockLive();
                sawToken = false;
              } else {
                working.setStreaming(false);
                streamActive = false;
                // Refresh prompt in place for phase change
                livePrompt({ freshLine: false });
              }
              if (phase === "stop_guard") {
                redockLive();
              }
            }
          },
          onStatus: (msg) => {
            working.pause();
            log.dim(msg);
            working.resume();
          },
        },
      });

      working.stop();
      streamActive = false;
      flushMarkdown();

      if (result.finalText && !result.finalText.endsWith("\n")) {
        process.stdout.write("\n");
      }
      if (result.aborted) {
        console.log(chalk.yellow("\n⚠ Run aborted."));
      }
      if (result.stopContinues > 0) {
        log.dim(
          result.releasedOnContinueCap
            ? `Harness continued ${result.stopContinues} time(s); released on continue-cap (safety valve)`
            : `Harness continued ${result.stopContinues} time(s) via Stop block`,
        );
      }
      if (result.hitMaxTurns) {
        log.dim(
          `Hit maxTurns — raise max_turns or continue with a follow-up prompt`,
        );
      }

      // Post-turn footer — always-on session health without /status
      console.log(
        renderTurnFooter(statusCtx(), {
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          cacheReadTokens: result.cacheReadTokens,
          stopContinues: result.stopContinues,
        }),
      );
      // Unattended-run summary: what actually changed on disk + proof status.
      // One dim line — the useful answer when you come back to a finished run.
      printTurnChangeSummary(session, turnAtStart);
      // Optional attention for long background ULW/goal runs (default off)
      {
        const outcome = turnEndOutcomeLabel({
          hitCostCap: result.hitCostCap,
          hitMaxTurns: result.hitMaxTurns,
          releasedOnContinueCap: result.releasedOnContinueCap,
          aborted: result.aborted,
          lastErrorCode: session.meta.lastError?.code,
          editCount: session.meta.editCount,
          lastVerificationCommand: session.meta.lastVerificationCommand,
          lastVerificationStale: isLastVerificationStale(session.meta),
        });

        maybeTurnEndAttention({
          title: "Forge",
          body: `${session.meta.title || "Forge"} · ${outcome}`,
          subtitle: session.meta.id.slice(0, 8),
        });
      }
      lastStatusStrip = ""; // force fresh strip after turn
      try {
        const { appendSessionMetrics, buildRunEndMetrics } = await import(
          "../session/metrics.js"
        );
        appendSessionMetrics(
          buildRunEndMetrics({
            sessionId: session.meta.id,
            provider: String(config.provider),
            model: config.model,
            cwd: session.meta.cwd,
            turns: result.turns,
            stopContinues: result.stopContinues,
            releasedOnContinueCap: result.releasedOnContinueCap,
            hitMaxTurns: result.hitMaxTurns,
            hitCostCap: result.hitCostCap,
            editCount: session.meta.editCount,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            cacheReadTokens: result.cacheReadTokens,
            servedModels: result.servedModels,
            aborted: result.aborted,
            ok: !result.aborted,
            headless: false,
            ultrawork: session.meta.ultrawork,
            lastErrorCode: session.meta.lastError?.code || undefined,
          }),
        );
      } catch {
        /* metrics never block REPL */
      }
    } catch (err) {
      working.stop();
      flushMarkdown();
      try {
        const { formatProviderError, formatProviderErrorText } = await import(
          "../providers/errors.js"
        );
        const fmt = formatProviderError(err, {
          provider: String(config.provider),
          model: config.model,
        });
        log.error(formatProviderErrorText(err, {
          provider: String(config.provider),
          model: config.model,
        }));
        try {
          const { appendSessionMetrics, buildRunEndMetrics } = await import(
            "../session/metrics.js"
          );
          appendSessionMetrics(
            buildRunEndMetrics({
              sessionId: session.meta.id,
              provider: String(config.provider),
              model: config.model,
              cwd: session.meta.cwd,
              turns: 0,
              stopContinues: 0,
              editCount: session.meta.editCount,
              promptTokens: 0,
              completionTokens: 0,
              aborted: false,
              ok: false,
              headless: false,
              ultrawork: session.meta.ultrawork,
              lastErrorCode:
                fmt.code || session.meta.lastError?.code || undefined,
            }),
          );
        } catch {
          /* metrics never block REPL */
        }
      } catch {
        log.error((err as Error).message);
      }
    } finally {
      endTurn();
      busy = false;
      abortController = null;
      pulseHeartbeat();
      prompt({ forceStatus: true });
    }
  };

  // rl.close() synchronously re-emits "close" → the close handler below would
  // otherwise start a second shutdown (SessionEnd hooks firing twice).
  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      if (busy && abortController) abortController.abort();
      working.stop();
      clearInterval(hbTimer);
      endTurn();
      releaseSession(session.meta.id);
      releaseSessionLock(session.meta.id);
      // SessionEnd first so hooks can still observe in-flight bg tasks
      await hooks.run("SessionEnd", {
        sessionId: session.meta.id,
        cwd: session.meta.cwd,
        workspaceRoot: config.workspace || session.meta.cwd,
      });
      saveSession(session);
      // Don't leave orphaned background shells after the REPL exits
      try {
        const killed = killAllRunningTasks({ force: true });
        if (killed > 0) {
          log.dim(`Stopped ${killed} background task${killed === 1 ? "" : "s"} on exit`);
        }
      } catch {
        /* never block exit */
      }
      rl.close();
    } catch (err) {
      // Failed mid-shutdown (e.g. session save ENOSPC/EACCES) — allow one
      // retry (/quit or Ctrl+C) instead of trapping the user with no exit.
      shutdownStarted = false;
      throw err;
    }
    process.exit(0);
  };

  // shutdown() normally ends in process.exit(0). If it throws, still leave
  // the process — an unhandled rejection would crash the REPL (Node default),
  // and swallowing it would hang with readline already closed.
  const reportShutdownError = (err: unknown) => {
    log.error(`Shutdown failed: ${(err as Error).message || String(err)}`);
    process.exit(1);
  };

  rl.on("line", (line) => {
    // Last-resort net: an unhandled rejection here crashes the whole REPL
    // (Node default) mid-session. Report like any other REPL error and
    // re-dock the prompt so the input loop stays alive.
    void handleLine(line).catch((err: unknown) => {
      log.error((err as Error).message || String(err));
      try {
        if (busy) livePrompt();
        else prompt({ forceStatus: true });
      } catch {
        /* readline may be closed */
      }
    });
  });

  let sigintArmed = false;
  rl.on("SIGINT", () => {
    if (busy && abortController) {
      working.stop();
      console.log(chalk.yellow("\nAborting current run… (Ctrl+C again to exit)"));
      abortController.abort();
      return;
    }
    if (sigintArmed) {
      void shutdown().catch(reportShutdownError);
      return;
    }
    sigintArmed = true;
    console.log(chalk.dim("\n(Ctrl+C again to exit, or type /quit)"));
    setTimeout(() => {
      sigintArmed = false;
    }, 1500);
    if (!busy) prompt();
  });

  rl.on("close", () => {
    void shutdown().catch(reportShutdownError);
  });

  if (opts.initialPrompt) {
    await handleLine(opts.initialPrompt).catch((err: unknown) => {
      log.error((err as Error).message || String(err));
      prompt({ forceStatus: true });
    });
  } else {
    prompt();
  }
}

function printBanner(
  config: ForgeConfig,
  auth: ResolvedAuth,
  session: SessionData,
): void {
  const cwd = config.workspace || session.meta.cwd;
  const git = getGitSnapshot(cwd);
  const intel = detectProjectIntel(cwd);
  const projectBits = [
    intel.packageManager || null,
    intel.kinds.length ? intel.kinds.join("+") : null,
    intel.checkCommands[0] || null,
  ].filter(Boolean);
  console.log(chalk.bold.cyan("\n  ⚒  Forge") + chalk.dim(` v${VERSION}`));
  console.log(
    chalk.dim(
      `  ${auth.provider}/${config.model} · ${describeAuth(auth)}\n` +
        `  session ${session.meta.id.slice(0, 8)}` +
        (session.meta.title ? ` · ${session.meta.title.slice(0, 40)}` : "") +
        ` · Stop: ${config.blockingStopHooks ? "blocking" : "passive"}` +
        ` · perms: ${config.permissionMode}` +
        (git.branch ? ` · ${git.branch}${git.dirty ? "*" : ""}` : "") +
        (projectBits.length ? ` · ${projectBits.join(" · ")}` : "") +
        `\n  Native live status while working · type at live › mid-run (/cycle 0)\n` +
        `  Paste multi-line safely (↵ sends · ^J newline) · ↑↓ history · Tab · /tips · /quit\n` +
        `  Fresh session: forge --new  ·  resume is automatic for this cwd\n`,
    ),
  );
  printPosture(config);
  // One-time expert tip for first interactive launch (persisted in preferences).
  try {
    const prefs = loadPreferences();
    if (!prefs.seenWelcomeTip) {
      let stackBit = "";
      try {
        const intel = detectProjectIntel(cwd);
        if (intel.checkCommands[0] || intel.packageManager) {
          const bits = [
            intel.packageManager || null,
            intel.checkCommands[0] || null,
          ].filter(Boolean);
          if (bits.length) stackBit = ` · stack: ${bits.join(" · ")}`;
        }
      } catch {
        /* */
      }
      console.log(
        chalk.cyan(
          `  Tip: /plan → design · /build → ship · /commit [do] · /budget N · /notify on · /done winds ULW+goal · /model live · /undo · /context · forge tips · forge doctor --json${stackBit}\n`,
        ),
      );
      savePreferences({ seenWelcomeTip: true });
    }
  } catch {
    /* never block REPL on prefs */
  }
}

/**
 * One-line sampling/context posture at startup + warnings ONLY for settings
 * that silently degrade results. Logic lives in ./posture.js (pure, tested).
 */
function printPosture(config: ForgeConfig): void {
  try {
    console.log(chalk.dim(`  ${postureHead(config)}`));
    const warns = postureWarnings(config);
    for (const w of warns) console.log(chalk.yellow(`  ⚠ ${w}`));
    if (warns.length) console.log(chalk.dim(`  ↳ review: /config · forge doctor`));
  } catch {
    /* posture is best-effort */
  }
}

/**
 * End-of-turn change summary for unattended runs (files + verify status).
 * Formatting is pure in ./turn-summary.js (tested); this is the journal
 * read + print shim. Silent when nothing was edited.
 */
function printTurnChangeSummary(
  session: SessionData,
  turnAtStart: number,
): void {
  try {
    const edits = readFileMutations(session.meta.id).filter(
      (m) => m.turn > turnAtStart,
    );
    const line = formatTurnChangeSummary(edits, session.meta.cwd, session.meta);
    if (line) console.log(chalk.dim(line));
  } catch {
    /* summary is best-effort */
  }
}
