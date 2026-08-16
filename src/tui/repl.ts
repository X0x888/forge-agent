import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import { applyModelContextWindow } from "../config/model-info.js";
import type { LLMProvider } from "../providers/types.js";
import type { SessionData } from "../session/session.js";
import { HookRunner } from "../harness/hooks.js";
import { PermissionGate } from "../agent/permissions.js";
import { runAgentLoopThroughDrops } from "../agent/loop.js";
import { formatBangOutput, runBangShell } from "./bang-shell.js";
import {
  handleSlash,
  isLiveSafeSlash,
  classifyLiveSlash,
  type SlashResult,
} from "../commands/slash.js";
import {
  peekInterjections,
  pushInterjection,
} from "../harness/interjection.js";
import {
  saveSession,
  isLastVerificationStale,
  formatResumeOrientation,
  isSyntheticUserMessage,
} from "../session/session.js";
import { log } from "../util/log.js";
import {
  maybeTurnEndAttention,
  turnEndOutcomeLabel,
} from "../util/attention.js";
import { describeAuth, resolveAuthFresh } from "../auth/resolve.js";
import type { ResolvedAuth } from "../auth/types.js";
import {
  createToolEndCoalescer,
  createToolStartDelayer,
} from "./tool-transcript.js";
import { postureHead, postureWarnings } from "./posture.js";
import {
  composeTurnCloser,
  formatRunStopReason,
  formatTurnChangeSummaryForSession,
  formatUserTurnOpen,
  formatAssistantTurnOpen,
} from "./turn-summary.js";
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
  activityElapsedSec,
} from "../statusline/activity.js";
import {
  listTasks,
  killAllRunningTasks,
  installBackgroundTaskExitHook,
  peekTaskLastLine,
} from "../agent/tools/background-tasks.js";
import { loadHistory, appendHistory } from "./history.js";
import { makeCompleter } from "./complete.js";
import { createPromptEditor } from "./prompt-editor.js";
import { setStdinLeaseHolder, stdinLeaseHeld } from "./stdin-lease.js";
import {
  buildIdlePrompt,
  buildLivePrompt,
  renderIdleStatusLine,
  renderLiveRunHeader,
  renderTurnFooter,
  formatSessionDetails,
  formatLiveControlFeedback,
  formatBackgroundTasksList,
  formatIdleBgCompletionNotice,
  createWorkingIndicator,
  shouldRedockLiveOnPhase,
  type StatusBarContext,
} from "./status-bar.js";
import { createBottomStatusDock, isBottomStatusEnabled } from "./bottom-status.js";
import {
  acquireSessionLock,
  releaseSessionLock,
  formatLockHolder,
} from "../session/lock.js";

import { getForgeVersion } from "../util/version.js";
import { loadPreferences, dismissHint } from "../config/preferences.js";
import { formatBanner } from "./banner.js";
import { pickTurnEndHint, ABORT_ACK, ABORT_RECOVERY } from "./hints.js";
import {
  alreadyOnboarded,
  rewriteIdleSetupShortcut,
  setupAutoCardDisabled,
} from "../util/setup-readiness.js";
import {
  collectSetupAssessment,
  formatSetupCard,
  formatSetupCompactLine,
} from "../commands/setup.js";
import { resolveMaxCostUsd, sessionCostUsd } from "../util/cost-budget.js";
import { isBellEnabled, isNotifyEnabled } from "../util/attention.js";
import { loadUlwCycle } from "../harness/ulw-cycle.js";
import { listProjectRulePaths } from "../agent/system-prompt.js";

/** True when this process already printed the full first-run /setup card. */
let setupCardShownThisProcess = false;
/** Idle 1–6 remap is live while the card or compact line is advertising it. */
let setupIdleNumbersEnabled = false;
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

  await printBanner(config, auth, session);

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
      rl.setPrompt(buildIdlePrompt(statusCtx()));
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
      if (bgRunning < lastKnownBgRunning) {
        const justDone = listTasks()
          .filter((t) => t.status !== "running" && t.endedAt && Date.now() - t.endedAt < 15_000)
          .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
          .slice(0, Math.max(1, lastKnownBgRunning - bgRunning));
        const notice = formatIdleBgCompletionNotice(
          justDone.map((t) => ({
            id: t.id,
            command: t.command,
            status: t.status,
            exitCode: t.exitCode,
            lastLine: peekTaskLastLine(t),
          })),
        );
        if (notice) {
          try {
            bottomDock.pause();
            process.stdout.write(`\n${notice}\n`);
            bottomDock.resume();
          } catch {
            /* */
          }
        }
      }
      lastKnownBgRunning = bgRunning;
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

  // statusCtx / rl are declared below; heartbeat uses them
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

  /**
   * Sticky bottom dock — model + active-account quota + weekly reset.
   * Plan is shared into statusCtx so the footer / /status HUD stay in sync.
   */
  const bottomDock = createBottomStatusDock({
    getContext: () => ({ config, session, auth }),
  });

  const statusCtx = (): StatusBarContext => ({
    config,
    session,
    auth,
    plan: bottomDock.getPlan(),
    verbose: verboseToolOutput,
  });
  /** Spinner frame for prompt-docked live status */
  let liveFrame = 0;
  /** When true, token stream has taken stdout — re-dock prompt after */
  let streamActive = false;
  /** Per-turn hook: reprint live › below a long token stream (10s heartbeat). */
  let onStreamHeartbeat: (() => void) | null = null;

  /**
   * Mid-run prompt — THE visible status dock (spin + phase + live ›).
   * Always starts on a fresh line so tokens/spinner cannot erase it.
   */
  const livePrompt = (opts?: { freshLine?: boolean }) => {
    if (stdinLeaseHeld() || rl.isSuspended()) return;
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
      bottomDock.refresh();
    } catch {
      /* readline may be closed */
    }
  };

  const working = createWorkingIndicator({
    getContext: statusCtx,
    // Critical: no \r spinner — it was wiping live › off the terminal
    dockInPrompt: true,
    onTick: (frame) => {
      if (!busy || streamActive || stdinLeaseHeld() || rl.isSuspended()) return;
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
    onStreamTick: () => {
      onStreamHeartbeat?.();
    },
  });

  pulseHeartbeat();
  const hbTimer = setInterval(pulseHeartbeat, 4_000);
  hbTimer.unref?.();

  // Always-on bottom status region (model · use% · reset · ctx)
  bottomDock.start();

  /** Dedup idle strip when the dock is off (FORGE_BOTTOM_STATUS=0). */
  let lastStatusStrip = "";
  /** Idle prompt (forge ›). Dock is the HUD; reprint the strip only when off. */
  const prompt = (opts?: { forceStatus?: boolean }) => {
    if (stdinLeaseHeld() || rl.isSuspended()) return;
    if (!bottomDock.active()) {
      const strip = renderIdleStatusLine(statusCtx());
      if (strip && (opts?.forceStatus || strip !== lastStatusStrip)) {
        console.log(strip);
        lastStatusStrip = strip;
      }
    } else {
      lastStatusStrip = "";
    }
    rl.setPrompt(buildIdlePrompt(statusCtx()));
    rl.prompt();
    bottomDock.refresh();
  };

  // Nested permission / ask_user prompts take the TTY; re-dock as soon as
  // they release it so live › does not wait for the next heartbeat tick.
  setStdinLeaseHolder({
    suspend: () => {
      // Dock 2s paint uses DECSC/DECRC — freeze it so Allow?/ask_user
      // is not clobbered while the nested readline owns stdin.
      bottomDock.pause();
      rl.suspend();
    },
    resume: () => {
      rl.resume();
      bottomDock.resume();
      if (busy) livePrompt({ freshLine: true });
      else prompt();
    },
  });

  const handleLine = async (
    line: string,
    src?: { echo?: boolean },
  ) => {
    let text = line.trim();
    if (!text) {
      if (busy) livePrompt();
      else prompt();
      return;
    }

    // First-run card numbers 1–6 are typeable at the idle prompt only.
    // Live turns leave a bare digit alone (it is a mid-run interjection).
    if (!busy) {
      try {
        const prefs = loadPreferences();
        text = rewriteIdleSetupShortcut(text, {
          enabled:
            !prefs.setupSkipped &&
            (setupIdleNumbersEnabled ||
              setupCardShownThisProcess ||
              (!alreadyOnboarded(prefs) && !setupAutoCardDisabled())),
        });
      } catch {
        /* never block input on prefs */
      }
    }

    appendHistory(text);

    // REPL-local session toggle — works idle and mid-run, never persisted.
    if (text === "/verbose") {
      verboseToolOutput = !verboseToolOutput;
      const msg = verboseToolOutput
        ? "Tool detail: diffs + full output under each tool line (/verbose to minimize)"
        : "Tool detail: status lines + error tails (/verbose for diffs + full output)";
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
      if (text.startsWith("!")) {
        try {
          const bang = await runBangShell({
            line: text,
            config,
            session,
            permissions,
            persist: false,
            onProgress: (line) => working.setPhase("tool", `bash ${line}`),
          });
          if (bang.handled) {
            console.log(formatBangOutput(bang.output, bang.isError));
            pushInterjection(
              session.meta.id,
              `[User ran bang-shell]\n${bang.output}`,
            );
            livePrompt();
            return;
          }
        } catch (err) {
          log.error((err as Error).message || String(err));
          livePrompt();
          return;
        }
      }
      if (!text.startsWith("/")) {
        pushInterjection(session.meta.id, text);
        const depth = peekInterjections(session.meta.id).length;
        const open = formatUserTurnOpen(text, { queued: depth });
        console.log(open ? chalk.cyan(open) : formatLiveControlFeedback(
          "(message)",
          `queued q:${depth}`,
          "info",
        ));
        livePrompt();
        return;
      }

      const liveKind = classifyLiveSlash(text);
      if (liveKind === "idle-only" || !isLiveSafeSlash(text)) {
        console.log(
          formatLiveControlFeedback(
            text,
            `That command needs an idle prompt (Ctrl+C to abort the run first).`,
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
        if (slash.queueInterjection) {
          pushInterjection(session.meta.id, slash.queueInterjection);
          if (slash.output) {
            console.log(
              formatLiveControlFeedback(text, slash.output, "ok"),
            );
          }
          const depth = peekInterjections(session.meta.id).length;
          const open = formatUserTurnOpen(slash.queueInterjection, {
            queued: depth,
          });
          if (open) console.log(chalk.cyan(open));
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

    if (text.startsWith("!")) {
      const started = !working.active();
      if (started) working.start();
      working.setPhase("tool", `bash ${text.slice(1).trim()}`);
      try {
        const bang = await runBangShell({
          line: text,
          config,
          session,
          permissions,
          onProgress: (line) => working.setPhase("tool", `bash ${line}`),
        });
        if (bang.handled) {
          console.log(formatBangOutput(bang.output, bang.isError));
          prompt();
          return;
        }
      } catch (err) {
        log.error((err as Error).message || String(err));
        prompt();
        return;
      } finally {
        if (started) working.stop();
      }
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
    if (src?.echo || slash.forwardPrompt) {
      const open = formatUserTurnOpen(userMessage);
      if (open) console.log(chalk.cyan(open));
    }

    busy = true;
    rl.setBusy(true);
    pendingTools = 0;
    abortController = new AbortController();
    // For the end-of-turn change summary: edits with turn > this landed now.
    const turnAtStart = session.meta.turnCount;
    // Live controls need stdin while working (editor stays open).
    beginTurn();
    pulseHeartbeat();

    // Native live chrome: identity + harness on the dock / live ›, not a
    // second "live run" banner that restates the same model/ULW bits.
    if (!isBottomStatusEnabled()) {
      process.stdout.write("\n");
      console.log(renderLiveRunHeader(statusCtx()));
    }
    streamActive = false;
    liveFrame = 0;
    working.start();
    livePrompt({ freshLine: true });

    let sawToken = false;
    const toolEnds = createToolEndCoalescer((line) => console.error(line));
    const toolStarts = createToolStartDelayer((line) => console.error(line));
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

    /**
     * Long token streams park `live ›` above the reply. Heartbeat only
     * refreshes the sticky dock — reprinting the prompt every 10s sliced
     * the transcript. First mid-run keystroke redocks via abandonPaint.
     */
    onStreamHeartbeat = () => {
      if (!busy) return;
      bottomDock.refresh();
    };

    try {
      const result = await runAgentLoopThroughDrops({
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
              toolEnds.flush();
              // Leave the live › line above; stream on following lines
              process.stdout.write("\n");
              process.stdout.write(`${formatAssistantTurnOpen()}\n`);
              working.setStreaming(true);
              streamActive = true;
              sawToken = true;
              // Stream overwrites the parked `live ›` row. Forget that paint
              // so the next keystroke / redock starts below the reply.
              rl.abandonPaint();
            }
            if (!md) md = createMarkdownRenderer();
            process.stdout.write(md.push(t));
          },
          onToolStart: (name, args) => {
            flushMarkdown();
            if (streamActive || sawToken) {
              toolEnds.flush();
              process.stdout.write("\n");
            }
            streamActive = false;
            working.setStreaming(false);
            sawToken = false;
            // Default: hold ▸ until ~700ms so fast tools stay one ✓ row.
            // /verbose still prints start immediately.
            toolStarts.push(name, args, { immediate: verboseToolOutput });
          },
          onToolEnd: (name, r) => {
            // Settle before the ✓/✗ row so a late timer cannot print ▸ after.
            toolStarts.settle(name);
            // Minimal by default: one status line per tool. Consecutive
            // same-tool ✓ rows collapse to `✓ grep ×4`. Failures and
            // /verbose stay one-per-call. Edits with a diff print a short preview.
            toolEnds.push(name, r, { verbose: verboseToolOutput });
          },
          onToolSettled: () => {
            pendingTools = Math.max(0, pendingTools - 1);
            if (pendingTools === 0) {
              setToolHold(false);
              // Do not reprint live › after every tool — that fossilized
              // a prompt row between ▸ and ✓. Dock refreshes in-place
              // on the next think/wait phase.
            }
          },
          onPhase: (phase, detail) => {
            setPhase(phase, detail);
            working.setPhase(phase, detail);
            pulseHeartbeat();
            if (phase === "tool") {
              pendingTools += 1;
              // Permission prompts print before onToolStart — keep the
              // styled token stream ahead of any prompt output. Flush a
              // different-tool ×N so Allow? is not buried under a held row.
              flushMarkdown();
              const nextName = (detail ?? "").split(/\s+/)[0];
              if (nextName) toolEnds.flushUnless(nextName);
              streamActive = false;
              working.setStreaming(false);
              sawToken = false;
              setToolHold(true);
            } else if (shouldRedockLiveOnPhase(phase, pendingTools)) {
              setToolHold(false);
              if (streamActive || sawToken || phase === "stop_guard") {
                redockLive();
                sawToken = false;
              } else {
                working.setStreaming(false);
                streamActive = false;
                // Refresh prompt in place for phase change
                livePrompt({ freshLine: false });
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
      toolStarts.flush();
      toolEnds.flush();
      flushMarkdown();

      if (result.finalText && !result.finalText.endsWith("\n")) {
        process.stdout.write("\n");
      }
      if (result.aborted) {
        console.log(chalk.yellow(ABORT_RECOVERY));
      }
      {
        const stop = formatRunStopReason({
          hitCostCap: result.hitCostCap,
          hitMaxTurns: result.hitMaxTurns,
          releasedOnContinueCap: result.releasedOnContinueCap,
          aborted: result.aborted,
          stopContinues: result.stopContinues,
          lastErrorCode: session.meta.lastError?.code,
        });
        if (stop && !result.aborted) log.dim(stop);
      }

      // Refresh plan occasionally after turns (uses 60s cache — cheap)
      void bottomDock.refreshPlan();

      // One turn closer: health bits + Δ files/verify (no last✓ + verify: pair).
      printTurnCloser(session, turnAtStart, statusCtx(), {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        cacheReadTokens: result.cacheReadTokens,
        stopContinues: result.stopContinues,
      });
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
            lastRoundPromptTokens: session.meta.lastRoundPromptTokens,
            lastRoundCacheReadTokens: session.meta.lastRoundCacheReadTokens,
            lastRoundCacheRatio: (() => {
              const p = session.meta.lastRoundPromptTokens ?? 0;
              const c = session.meta.lastRoundCacheReadTokens ?? 0;
              return p > 0 ? Math.min(1, c / p) : undefined;
            })(),
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
      toolStarts.flush();
      toolEnds.flush();
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
          repl: true,
        }));
        // Auth expiry should usually recover mid-loop; if it still escapes,
        // warm the live provider bearer so the next prompt/continue does not
        // reuse a known-dead token (unattended ULW "type continue" friction).
        if (
          fmt.code === "auth_expired" ||
          fmt.code === "auth_forbidden" ||
          /auth recovery failed|401|403|unauthorized|could not be validated/i.test(
            (err as Error).message || "",
          )
        ) {
          try {
            const { isTokenAuthFailure } = await import("../auth/refresh.js");
            if (isTokenAuthFailure(err) || fmt.code?.startsWith("auth_")) {
              const fresh = await resolveAuthFresh(
                config,
                String(config.provider),
              );
              if (fresh?.token) {
                auth = fresh;
                if (provider.updateCredentials) {
                  provider.updateCredentials(fresh.token);
                } else {
                  provider = createProvider(config, auth);
                }
                log.dim(
                  "Credentials refreshed after auth error — ready for next prompt",
                );
              }
            }
          } catch {
            /* best-effort; user can forge login */
          }
        }
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
      onStreamHeartbeat = null;
      endTurn();
      busy = false;
      rl.setBusy(false);
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
      bottomDock.stop();
      clearInterval(hbTimer);
      endTurn();
      setStdinLeaseHolder(null);
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
      console.log(chalk.yellow(`\n${ABORT_ACK}`));
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
    await handleLine(opts.initialPrompt, { echo: true }).catch((err: unknown) => {
      log.error((err as Error).message || String(err));
      prompt({ forceStatus: true });
    });
  } else {
    prompt();
  }
}

async function printBanner(
  config: ForgeConfig,
  auth: ResolvedAuth,
  session: SessionData,
): Promise<void> {
  const cwd = config.workspace || session.meta.cwd;
  const git = getGitSnapshot(cwd);
  const intel = detectProjectIntel(cwd);
  const projectBits = [
    intel.packageManager || null,
    intel.kinds.length ? intel.kinds.join("+") : null,
    intel.checkCommands[0] || null,
  ].filter(Boolean) as string[];

  let ulwArmed = false;
  try {
    const { loadUlwCycle } = await import("../harness/ulw-cycle.js");
    const ulw = loadUlwCycle(session.meta.id);
    ulwArmed = Boolean(ulw?.enabled);
  } catch {
    /* */
  }

  const realUserTurns = (session.messages || []).filter(
    (m) => m.role === "user" && !isSyntheticUserMessage(m),
  ).length;
  const isFirstSession =
    (session.meta.turnCount || 0) === 0 && realUserTurns === 0;

  let setupCard: string | undefined;
  let setupCompact: string | undefined;
  try {
    const prefs = loadPreferences();
    if (!setupAutoCardDisabled()) {
      const assessed = await collectSetupAssessment({
        config,
        session,
        auth,
      });
      if (!alreadyOnboarded(prefs)) {
        setupCardShownThisProcess = true;
        setupIdleNumbersEnabled = true;
        setupCard = formatSetupCard(assessed);
        // Do not markSetupSeen on first paint — that burned the teaching
        // beat before the user could type 1–6. /setup actions still stamp it.
      } else if (
        !prefs.setupSkipped &&
        (assessed.recommendedOpen > 0 || assessed.blocking)
      ) {
        setupIdleNumbersEnabled = true;
        setupCompact = formatSetupCompactLine(assessed);
      }
    }
  } catch {
    /* never block REPL on setup card */
  }

  const text = formatBanner({
    version: VERSION,
    provider: String(auth.provider || config.provider),
    model: config.model,
    authLabel: describeAuth(auth),
    sessionId: session.meta.id,
    sessionTitle: session.meta.title || undefined,
    permissionMode: config.permissionMode,
    sandbox: String(config.sandbox || "workspace"),
    blockingStop: Boolean(config.blockingStopHooks),
    gitBranch: git.branch,
    gitDirty: Boolean(git.dirty),
    projectBits,
    ulwArmed,
    posture: postureHead(config),
    postureWarnings: postureWarnings(config),
    showEmptyState: isFirstSession,
    setupCard,
    setupCompact,
    resumeOrientation: isFirstSession
      ? undefined
      : formatResumeOrientation(session, {
        maxChars: 180,
        fileLimit: 4,
        compact: true,
      }),
    dockOn: isBottomStatusEnabled(),
  });
  const [first, ...rest] = text.split("\n");
  console.log(chalk.bold.cyan("\n" + first));
  for (const line of rest) {
    if (line.startsWith("  ⚠")) console.log(chalk.yellow(line));
    else if (line.includes("Type a task in English")) console.log(chalk.cyan(line));
    else console.log(chalk.dim(line));
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
 * One turn closer: health footer + Δ files/verify. When this turn edited
 * files, omit last✓/next from the footer so proof status appears once.
 */
function printTurnCloser(
  session: SessionData,
  turnAtStart: number,
  ctx: StatusBarContext,
  turn: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    stopContinues?: number;
  },
): void {
  let delta: string | null = null;
  try {
    delta = formatTurnChangeSummaryForSession(session, turnAtStart);
  } catch {
    /* journal is best-effort */
  }
  try {
    const footer = renderTurnFooter(ctx, turn, {
      omitProof: Boolean(delta),
    });
    console.log(composeTurnCloser(footer, delta ? chalk.dim(delta) : null));
  } catch {
    if (delta) console.log(chalk.dim(delta));
  }
  try {
    printTurnHint(session, Boolean(delta));
  } catch {
    /* never block turn-end on hints */
  }
}

function printTurnHint(session: SessionData, hadFileEdits: boolean): void {
  try {
    let skip = setupCardShownThisProcess;
    try {
      const ulw = loadUlwCycle(session.meta.id);
      if (ulw?.enabled && ulw.cycle === 1) skip = true;
    } catch {
      /* */
    }
    const prefs = loadPreferences();
    let projectRulesCount = 0;
    try {
      projectRulesCount = listProjectRulePaths(
        session.meta.cwd || process.cwd(),
      ).length;
    } catch {
      /* */
    }
    const pick = pickTurnEndHint({
      dismissed: prefs.dismissedHints || [],
      skip,
      hadFileEdits,
      projectRulesCount,
      sessionCostUsd: sessionCostUsd(
        String(session.meta.provider || "xai"),
        session.meta,
        session.meta.model,
      ),
      hasBudget: resolveMaxCostUsd(null, session.meta) != null,
      turnElapsedSec: activityElapsedSec(),
      notifyOn: isNotifyEnabled(),
      bellOn: isBellEnabled(),
    });
    if (!pick) return;
    console.log(chalk.cyan(`  Tip: ${pick.text}`));
    dismissHint(pick.id);
  } catch {
    /* never block turn-end on hints */
  }
}
