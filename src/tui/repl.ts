import readline from "node:readline";
import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
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
} from "../commands/slash.js";
import { pushInterjection } from "../harness/interjection.js";
import { saveSession } from "../session/session.js";
import { log } from "../util/log.js";
import { describeAuth } from "../auth/resolve.js";
import type { ResolvedAuth } from "../auth/types.js";
import {
  formatToolStart,
  formatToolEnd,
} from "../util/format.js";
import { detectProjectHints, getGitSnapshot } from "../util/git-context.js";
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
import { listTasks } from "../agent/tools/background-tasks.js";
import { loadHistory, appendHistory } from "./history.js";
import { makeCompleter } from "./complete.js";
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

  // Exclusive session lock — warn (don't hard-fail) if another live process holds it
  {
    const lock = acquireSessionLock(session.meta.id);
    if (!lock.ok && lock.holder) {
      log.warn(
        `Session ${session.meta.id.slice(0, 8)} is locked by ${formatLockHolder(lock.holder)}. ` +
          `Continuing may race writes — prefer one REPL per session, or /new.`,
      );
    } else if (lock.stolen && lock.holder) {
      log.dim(
        `Took over stale session lock from ${formatLockHolder(lock.holder)}`,
      );
    }
  }

  printBanner(config, auth, session);

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
  /**
   * Tools currently between onPhase("tool") and onToolSettled
   * (includes permission prompts — not only running tools).
   */
  let pendingTools = 0;

  const savedHistory = loadHistory(300);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 300,
    history: savedHistory,
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
      } finally {
        working.resume();
        working.repaint();
      }
      // Always restore the live input line so the next control is obvious
      livePrompt();
      return;
    }

    let slash = await handleSlash(text, { session, config, hooks, auth });
    if (slash.replaceSession) {
      releaseSessionLock(session.meta.id);
      session = slash.replaceSession;
      const lock = acquireSessionLock(session.meta.id);
      if (!lock.ok && lock.holder) {
        log.warn(
          `Resumed session locked by ${formatLockHolder(lock.holder)} — writes may race`,
        );
      }
      hooks = new HookRunner(config, session.meta.cwd);
      const a = resolveAuth(config);
      if (a) {
        auth = a;
        provider = createProvider(config, auth);
      }
      if (slash.output) console.log(slash.output);
      prompt();
      return;
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
    // Intentionally do NOT rl.pause() — live controls need stdin while working.
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
            process.stdout.write(t);
          },
          onToolStart: (name, args) => {
            if (streamActive || sawToken) {
              process.stdout.write("\n");
            }
            streamActive = false;
            working.setStreaming(false);
            sawToken = false;
            console.error(formatToolStart(name, args));
          },
          onToolEnd: (name, r) => {
            console.error(formatToolEnd(name, r));
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

      if (result.finalText && !result.finalText.endsWith("\n")) {
        process.stdout.write("\n");
      }
      if (result.aborted) {
        console.log(chalk.yellow("\n⚠ Run aborted."));
      }
      if (result.stopContinues > 0) {
        log.dim(
          `Harness continued ${result.stopContinues} time(s) via Stop block`,
        );
      }

      // Post-turn footer — always-on session health without /status
      console.log(
        renderTurnFooter(statusCtx(), {
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          stopContinues: result.stopContinues,
        }),
      );
      lastStatusStrip = ""; // force fresh strip after turn
    } catch (err) {
      working.stop();
      log.error((err as Error).message);
    } finally {
      endTurn();
      busy = false;
      abortController = null;
      pulseHeartbeat();
      prompt({ forceStatus: true });
    }
  };

  const shutdown = async () => {
    if (busy && abortController) abortController.abort();
    working.stop();
    clearInterval(hbTimer);
    endTurn();
    releaseSession(session.meta.id);
    releaseSessionLock(session.meta.id);
    await hooks.run("SessionEnd", {
      sessionId: session.meta.id,
      cwd: session.meta.cwd,
      workspaceRoot: config.workspace || session.meta.cwd,
    });
    saveSession(session);
    rl.close();
    process.exit(0);
  };

  rl.on("line", (line) => {
    void handleLine(line);
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
      void shutdown();
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
    void shutdown();
  });

  if (opts.initialPrompt) {
    await handleLine(opts.initialPrompt);
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
  const hints = detectProjectHints(cwd);
  console.log(chalk.bold.cyan("\n  ⚒  Forge") + chalk.dim(` v${VERSION}`));
  console.log(
    chalk.dim(
      `  ${auth.provider}/${config.model} · ${describeAuth(auth)}\n` +
        `  session ${session.meta.id.slice(0, 8)}` +
        (session.meta.title ? ` · ${session.meta.title.slice(0, 40)}` : "") +
        ` · Stop: ${config.blockingStopHooks ? "blocking" : "passive"}` +
        ` · perms: ${config.permissionMode}` +
        (git.branch ? ` · ${git.branch}${git.dirty ? "*" : ""}` : "") +
        (hints.length ? ` · ${hints.join("+")}` : "") +
        `\n  Native live status while working · type at live › mid-run (/cycle 0)\n` +
        `  ↑↓ history · Tab complete · /tasks · /status · /quit\n`,
    ),
  );
}
