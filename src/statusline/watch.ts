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
 *
 * Abort listener is installed *before* the first tick. The first tick used
 * to run unabortably; a hung plan probe / keychain spawnSync pinned
 * `npm test` for hours. When `signal` is passed (tests/embedders), we do
 * **not** swallow process SIGINT — that hid Ctrl+C in the dogfood hang.
 * CLI `forge status --watch` (no signal) still stops on SIGINT.
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

  if (opts.signal?.aborted) return;

  return new Promise((resolve) => {
    let inFlight = false;
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearInterval(id);
      process.removeListener("SIGINT", onSigint);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onSigint = () => cleanup();
    const onAbort = () => cleanup();
    // CLI watch has no AbortSignal — SIGINT stops the loop.
    // Tests pass `signal` and must not steal process SIGINT.
    if (!opts.signal) {
      process.on("SIGINT", onSigint);
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const runTick = () => {
      if (opts.signal?.aborted) {
        cleanup();
        return;
      }
      // A tick can outlive the interval (plan probes wait up to ~4s) — never
      // overlap frames or clear-screen/body writes interleave on the TTY.
      if (inFlight) return;
      inFlight = true;
      void tick()
        .catch((err) => {
          process.stderr.write(`status watch: ${(err as Error).message}\n`);
        })
        .finally(() => {
          inFlight = false;
          if (opts.signal?.aborted) cleanup();
        });
    };

    const id = setInterval(runTick, interval);
    runTick();
  });
}
