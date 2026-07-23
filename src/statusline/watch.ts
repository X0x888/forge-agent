import { collectSnapshots } from "./snapshot.js";
import { renderHud, snapshotsToJson } from "./render.js";
import type { CollectOptions } from "./types.js";

export interface WatchOptions extends CollectOptions {
  intervalMs?: number;
  json?: boolean;
  plain?: boolean;
  tmux?: boolean;
  /** Clear screen each frame (default true for TTY) */
  clear?: boolean;
  signal?: AbortSignal;
}

/**
 * Live statusline loop — print HUD every intervalMs until aborted.
 */
export async function runStatusWatch(opts: WatchOptions = {}): Promise<void> {
  const interval = Math.max(250, opts.intervalMs ?? 1000);
  const clear =
    opts.clear ?? (Boolean(process.stdout.isTTY) && !opts.json && !opts.tmux);
  const plain = opts.plain || Boolean(process.env.NO_COLOR);

  const tick = async () => {
    const snaps = await collectSnapshots({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      all: opts.all,
      fetchPlan: opts.fetchPlan,
      config: opts.config,
    });
    if (opts.json) {
      process.stdout.write(snapshotsToJson(snaps) + "\n");
      return;
    }
    const body = renderHud(snaps, {
      plain,
      singleLine: opts.tmux,
      tmux: opts.tmux,
      width: process.stdout.columns,
    });
    if (clear) {
      // Clear screen + home cursor
      process.stdout.write("\x1b[2J\x1b[H");
    }
    process.stdout.write(body + (body.endsWith("\n") ? "" : "\n"));
  };

  await tick();

  return new Promise((resolve) => {
    const id = setInterval(() => {
      if (opts.signal?.aborted) {
        clearInterval(id);
        resolve();
        return;
      }
      void tick().catch((err) => {
        process.stderr.write(`status watch: ${(err as Error).message}\n`);
      });
    }, interval);

    const onAbort = () => {
      clearInterval(id);
      resolve();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    process.on("SIGINT", () => {
      clearInterval(id);
      resolve();
    });
  });
}
