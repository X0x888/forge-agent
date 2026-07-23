import readline from "node:readline";
import chalk from "chalk";
import type { ForgeConfig } from "../config/types.js";
import type { LLMProvider } from "../providers/types.js";
import type { SessionData } from "../session/session.js";
import { HookRunner } from "../harness/hooks.js";
import { PermissionGate } from "../agent/permissions.js";
import { runAgentLoop } from "../agent/loop.js";
import { handleSlash } from "../commands/slash.js";
import { saveSession } from "../session/session.js";
import { log } from "../util/log.js";
import { describeAuth } from "../auth/resolve.js";
import type { ResolvedAuth } from "../auth/types.js";

export async function runRepl(opts: {
  config: ForgeConfig;
  provider: LLMProvider;
  session: SessionData;
  hooks: HookRunner;
  auth: ResolvedAuth;
  initialPrompt?: string;
}): Promise<void> {
  const { config, provider, session, hooks, auth } = opts;
  const permissions = new PermissionGate({ interactive: true });

  console.log(chalk.bold.cyan("\n  ⚒  Forge — agent CLI with a real harness\n"));
  console.log(
    chalk.dim(
      `  ${auth.provider}/${config.model} · ${describeAuth(auth)}\n` +
        `  session ${session.meta.id.slice(0, 8)} · Stop hooks: ${config.blockingStopHooks ? "blocking" : "passive"}\n` +
        `  /help for commands · /goal <obj> to arm relentless drive · /ulw for max autonomy\n`,
    ),
  );

  await hooks.run("SessionStart", {
    sessionId: session.meta.id,
    cwd: session.meta.cwd,
    workspaceRoot: config.workspace || session.meta.cwd,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = () => {
    const flags = [
      session.meta.ultrawork ? chalk.magenta("ULW") : "",
    ]
      .filter(Boolean)
      .join(" ");
    const prefix = flags ? chalk.dim(`[${flags}] `) : "";
    rl.setPrompt(prefix + chalk.green("forge") + chalk.dim(" › "));
    rl.prompt();
  };

  const handleLine = async (line: string) => {
    const text = line.trim();
    if (!text) {
      prompt();
      return;
    }

    const slash = handleSlash(text, { session, config, hooks });
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

    try {
      rl.pause();
      const result = await runAgentLoop({
        config,
        provider,
        session,
        hooks,
        permissions,
        userMessage,
        stream: true,
        onToken: (t) => {
          process.stdout.write(t);
        },
      });
      if (result.finalText && !result.finalText.endsWith("\n")) {
        process.stdout.write("\n");
      }
      if (result.stopContinues > 0) {
        log.dim(
          `Harness continued ${result.stopContinues} time(s) via Stop block`,
        );
      }
    } catch (err) {
      log.error((err as Error).message);
    } finally {
      rl.resume();
      prompt();
    }
  };

  const shutdown = async () => {
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

  rl.on("SIGINT", () => {
    console.log(chalk.dim("\n(Interrupted — type /quit to exit)"));
    prompt();
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
