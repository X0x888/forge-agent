import readline from "node:readline";
import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import type { LLMProvider } from "../providers/types.js";
import type { SessionData } from "../session/session.js";
import { HookRunner } from "../harness/hooks.js";
import { PermissionGate } from "../agent/permissions.js";
import { runAgentLoop } from "../agent/loop.js";
import { handleSlash, completeSlash } from "../commands/slash.js";
import { saveSession, estimateTokens } from "../session/session.js";
import { loadGoal } from "../harness/goal.js";
import { log } from "../util/log.js";
import { describeAuth } from "../auth/resolve.js";
import type { ResolvedAuth } from "../auth/types.js";
import {
  formatToolStart,
  formatToolEnd,
  formatTokens,
  estimateCostUsd,
  formatCost,
} from "../util/format.js";
import { detectProjectHints, getGitSnapshot } from "../util/git-context.js";
import { createProvider } from "../providers/factory.js";
import { resolveAuth } from "../auth/resolve.js";
import { heartbeatSession, releaseSession } from "../statusline/active.js";

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

  printBanner(config, auth, session);

  heartbeatSession({
    sessionId: session.meta.id,
    cwd: session.meta.cwd,
    provider: session.meta.provider,
    model: config.model,
  });
  // Keep liveness fresh while idle in the REPL
  const hbTimer = setInterval(() => {
    heartbeatSession({
      sessionId: session.meta.id,
      cwd: session.meta.cwd,
      provider: session.meta.provider,
      model: config.model,
    });
  }, 8_000);
  hbTimer.unref?.();

  await hooks.run("SessionStart", {
    sessionId: session.meta.id,
    cwd: session.meta.cwd,
    workspaceRoot: config.workspace || session.meta.cwd,
  });

  let busy = false;
  let abortController: AbortController | null = null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 200,
    completer: (line: string) => {
      const hits = completeSlash(line);
      return [hits.length ? hits : completeSlash("/"), line] as [
        string[],
        string,
      ];
    },
  });

  const prompt = () => {
    const flags: string[] = [];
    if (session.meta.ultrawork) flags.push(chalk.magenta("ULW"));
    const g = loadGoal(session.meta.id);
    if (g?.objective && !g.paused && g.status === "active") {
      flags.push(chalk.yellow("GOAL"));
    }
    if (config.permissionMode === "plan") flags.push(chalk.blue("PLAN"));
    const prefix = flags.length ? chalk.dim(`[${flags.join(" ")}] `) : "";
    rl.setPrompt(prefix + chalk.green("forge") + chalk.dim(" › "));
    rl.prompt();
  };

  const handleLine = async (line: string) => {
    const text = line.trim();
    if (!text) {
      prompt();
      return;
    }

    if (busy) {
      log.warn("Still working — press Ctrl+C to abort, then try again.");
      return;
    }

    let slash = await handleSlash(text, { session, config, hooks });
    if (slash.replaceSession) {
      session = slash.replaceSession;
      // Recreate hooks for new session cwd if needed
      hooks = new HookRunner(config, session.meta.cwd);
      // Provider may need refresh if model/provider changed
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
    abortController = new AbortController();
    rl.pause();

    try {
      process.stdout.write("\n");
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
          onToken: (t) => process.stdout.write(t),
          onToolStart: (name, args) => {
            console.error(formatToolStart(name, args));
          },
          onToolEnd: (name, r) => {
            console.error(formatToolEnd(name, r));
          },
          onStatus: (msg) => log.dim(msg),
        },
      });

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
      if (result.promptTokens + result.completionTokens > 0) {
        const cost = estimateCostUsd(
          String(config.provider),
          result.promptTokens,
          result.completionTokens,
        );
        log.dim(
          `turn tokens in=${formatTokens(result.promptTokens)} out=${formatTokens(result.completionTokens)} · est ${formatCost(cost)} · ctx ~${formatTokens(estimateTokens(session.messages))}`,
        );
      }
    } catch (err) {
      log.error((err as Error).message);
    } finally {
      busy = false;
      abortController = null;
      rl.resume();
      prompt();
    }
  };

  const shutdown = async () => {
    if (busy && abortController) abortController.abort();
    clearInterval(hbTimer);
    releaseSession(session.meta.id);
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
  console.log(chalk.bold.cyan("\n  ⚒  Forge") + chalk.dim(` v0.3.0`));
  console.log(
    chalk.dim(
      `  ${auth.provider}/${config.model} · ${describeAuth(auth)}\n` +
        `  session ${session.meta.id.slice(0, 8)}` +
        (session.meta.title ? ` · ${session.meta.title.slice(0, 40)}` : "") +
        ` · Stop: ${config.blockingStopHooks ? "blocking" : "passive"}` +
        (git.branch ? ` · ${git.branch}${git.dirty ? "*" : ""}` : "") +
        (hints.length ? ` · ${hints.join("+")}` : "") +
        `\n  /help · /goal · /statusline · forge status --watch · Ctrl+C aborts run\n`,
    ),
  );
}
