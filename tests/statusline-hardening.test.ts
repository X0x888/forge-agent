import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import { createSession, saveSession } from "../src/session/session.js";
import { runStatusWatch } from "../src/statusline/watch.js";
import {
  heartbeatSession,
  loadActiveRegistry,
} from "../src/statusline/active.js";
import { collectPlanUsage } from "../src/statusline/plan.js";
import { renderHud } from "../src/statusline/render.js";
import { sessionToSnapshot } from "../src/statusline/snapshot.js";
import { upsertOAuth } from "../src/auth/store.js";
import { savePreferences } from "../src/config/preferences.js";
import { loadConfig } from "../src/config/load.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";

const ANSI_SGR = /\x1b\[[0-9;]*m/g;

function visibleWidth(text: string): number {
  return text.replace(ANSI_SGR, "").length;
}

describe("status watch hardening", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-slh-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.FORGE_API_KEY;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  });

  it("never overlaps slow ticks (plan probe) and removes SIGINT listener", async () => {
    // A live subscription account sends the plan probe to the network.
    upsertOAuth("xai", { accessToken: "tok-watch", method: "subscription" });
    const s = createSession({ cwd: tmp, provider: "xai", model: "grok-4.5" });
    saveSession(s);
    // A plan-cache path that can never be read/written (a directory) forces
    // every tick to hit the network stub instead of the 60s cache.
    fs.mkdirSync(path.join(tmp, "statusline", "plan-cache.json"), {
      recursive: true,
    });

    let cur = 0;
    let maxConcurrent = 0;
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      cur += 1;
      maxConcurrent = Math.max(maxConcurrent, cur);
      // ~400ms probe vs 250ms interval: without the in-flight guard the next
      // tick starts while this one is still awaiting → concurrent fetches.
      await new Promise((r) => setTimeout(r, 400));
      cur -= 1;
      return new Response("{}", { status: 401 });
    }) as typeof fetch;

    const sigintBaseline = process.listenerCount("SIGINT");
    try {
      const ac = new AbortController();
      const watch = runStatusWatch({
        intervalMs: 250,
        json: true,
        signal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 1300));
      assert.equal(
        process.listenerCount("SIGINT"),
        sigintBaseline + 1,
        "watch must hold exactly one SIGINT listener while running",
      );
      ac.abort();
      await watch;
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.ok(fetchCalls >= 2, `expected several plan probes, got ${fetchCalls}`);
    assert.equal(
      maxConcurrent,
      1,
      "ticks overlapped: a new tick started while one was in flight",
    );
    assert.equal(
      process.listenerCount("SIGINT"),
      sigintBaseline,
      "SIGINT listener leaked after watch ended",
    );
  });
});

describe("active-session registry locking", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-slh-active-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  });

  it("serializes concurrent heartbeats across processes (no lost entries)", async () => {
    // Same race class as auth.json: load → mutate → save from N REPLs.
    const activeUrl = pathToFileURL(
      path.resolve("src/statusline/active.ts"),
    ).href;
    const CHILDREN = 3;
    const PER_CHILD = 10;
    const script = [
      `const { heartbeatSession } = await import(${JSON.stringify(activeUrl)});`,
      "const tag = process.env.FORGE_TAG;",
      "const n = Number(process.env.FORGE_N);",
      "for (let i = 0; i < n; i++) {",
      '  heartbeatSession({ sessionId: "sx-" + tag + "-" + i, cwd: process.env.FORGE_HOME, provider: "xai", model: "m" });',
      "}",
    ].join("\n");
    await Promise.all(
      Array.from(
        { length: CHILDREN },
        (_, c) =>
          new Promise<void>((resolve, reject) => {
            const kid = spawn(
              process.execPath,
              ["--import", "tsx", "--input-type=module", "-e", script],
              {
                env: {
                  ...process.env,
                  FORGE_HOME: tmp,
                  FORGE_TAG: String(c),
                  FORGE_N: String(PER_CHILD),
                },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let err = "";
            kid.stderr.on("data", (d) => {
              err += String(d);
            });
            kid.on("exit", (code) =>
              code === 0
                ? resolve()
                : reject(new Error(`child ${c} exited ${code}: ${err}`)),
            );
          }),
      ),
    );
    const reg = loadActiveRegistry();
    for (let c = 0; c < CHILDREN; c++) {
      for (let i = 0; i < PER_CHILD; i++) {
        assert.ok(
          reg.sessions[`sx-${c}-${i}`],
          `lost heartbeat entry sx-${c}-${i}`,
        );
      }
    }
    // The sidecar lock is released after the critical section.
    assert.equal(fs.existsSync(`${tmp}/active_sessions.json.lock`), false);
  });

  it("steals a dead-pid registry lock without waiting", () => {
    const lock = `${tmp}/active_sessions.json.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() }));
    const t0 = Date.now();
    heartbeatSession({
      sessionId: "steal-1",
      cwd: tmp,
      provider: "xai",
      model: "m",
    });
    assert.ok(
      Date.now() - t0 < 1_500,
      "dead-pid lock must be stolen immediately, not waited out",
    );
    assert.ok(loadActiveRegistry().sessions["steal-1"]);
    assert.equal(fs.existsSync(lock), false);
  });
});

describe("plan cache hardening", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-slh-plan-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.FORGE_API_KEY;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  });

  it("writes plan cache under FORGE_HOME atomically with mode 0600", async () => {
    upsertOAuth("xai", { accessToken: "tok-plan", method: "subscription" });
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    // Nested SuperGrok shape (format=credits) — the live production body.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls += 1;
      const url = String(input);
      if (url.includes("format=credits")) {
        return new Response(
          JSON.stringify({
            config: {
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                end: "2099-01-08T00:00:00Z",
              },
              creditUsagePercent: 22,
              productUsage: [{ product: "GrokBuild", usagePercent: 22 }],
              billingPeriodEnd: "2099-01-08T00:00:00Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // plain /billing for used/limit merge
      return new Response(
        JSON.stringify({
          config: {
            used: { val: 2200 },
            monthlyLimit: { val: 10000 },
            billingPeriodEnd: "2099-01-08T00:00:00Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const plan = await collectPlanUsage({
        provider: "xai",
        authMethod: "subscription",
      });
      assert.equal(plan?.percent, 22);
      assert.equal(plan?.used, 2200);
      assert.equal(plan?.limit, 10000);
      assert.equal(plan?.resetsAt, "2099-01-08T00:00:00Z");
      assert.equal(plan?.periodLabel, "week");
    } finally {
      globalThis.fetch = origFetch;
    }
    // FORGE_HOME is honored (previously hardcoded ~/.forge/statusline).
    const cacheFile = path.join(tmp, "statusline", "plan-cache.json");
    assert.ok(fs.existsSync(cacheFile), "cache must live under FORGE_HOME");
    const mode = fs.statSync(cacheFile).mode & 0o777;
    assert.equal(mode, 0o600, `cache mode ${mode.toString(8)} != 600`);
    // No tmp file left behind by the atomic write.
    assert.equal(
      fs.readdirSync(path.join(tmp, "statusline")).filter((f) => f.endsWith(".tmp")).length,
      0,
    );
    // Second probe is served from cache (no second fetch pair).
    const again = await collectPlanUsage({
      provider: "xai",
      authMethod: "subscription",
    });
    assert.equal(again?.percent, 22);
    // First call may hit credits + plain (2); second is cache-only
    assert.equal(fetchCalls, 2);
  });

  it("caches nested-parse plan so forge status --watch shows use%+reset", async () => {
    upsertOAuth("xai", { accessToken: "tok-watch", method: "subscription" });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          config: {
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              end: "2099-06-01T00:00:00Z",
            },
            creditUsagePercent: 41.4,
            billingPeriodEnd: "2099-06-01T00:00:00Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const plan = await collectPlanUsage({
        provider: "xai",
        authMethod: "subscription",
      });
      assert.equal(plan?.percent, 41);
      assert.equal(plan?.resetsAt, "2099-06-01T00:00:00Z");
      const { formatPlan } = await import("../src/statusline/render.js");
      const line = formatPlan(plan, false)!;
      assert.match(line, /use:41%/);
      assert.match(line, /reset /);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("HUD width clipping", () => {
  it("shed never cuts inside an ANSI escape sequence", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-slh-clip-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({
      cwd: path.join(tmp, "a-very-long-project-directory-name"),
      provider: "xai",
      model: "grok-4.5",
    });
    const snap = sessionToSnapshot(s, { authMethod: "api_key" });
    snap.projectLabel = "a-very-long-project-name-for-clipping";
    snap.tags = ["ULW", "PIN", "LOCK:pid123"];

    const prevLevel = chalk.level;
    chalk.level = 3; // force SGR output even under non-TTY test runs
    try {
      const hud = renderHud([snap], { color: true, width: 30 });
      assert.ok(/\x1b\[/.test(hud), "test is vacuous without ANSI colors");
      for (const line of hud.split("\n")) {
        assert.ok(
          visibleWidth(line) <= 30,
          `line exceeds width: ${JSON.stringify(line)}`,
        );
        assert.ok(
          !line.replace(ANSI_SGR, "").includes("\x1b"),
          `cut ANSI escape in: ${JSON.stringify(line)}`,
        );
      }
    } finally {
      chalk.level = prevLevel;
    }
  });
});

describe("config-file provider switch follows provider default model", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-slh-cfg-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    delete process.env.FORGE_PROVIDER;
  });

  it("provider = \"claude\" with no model picks the anthropic default", () => {
    fs.writeFileSync(path.join(tmp, "config.toml"), 'provider = "claude"\n');
    const cfg = loadConfig({}, tmp);
    assert.equal(cfg.provider, "anthropic");
    assert.equal(cfg.model, DEFAULT_CONFIG.providers?.anthropic?.defaultModel);
    assert.notEqual(cfg.model, DEFAULT_CONFIG.model);
  });

  it("explicit file model wins over the provider switch rescue", () => {
    fs.writeFileSync(
      path.join(tmp, "config.toml"),
      'provider = "claude"\nmodel = "claude-custom-x"\n',
    );
    const cfg = loadConfig({}, tmp);
    assert.equal(cfg.provider, "anthropic");
    assert.equal(cfg.model, "claude-custom-x");
  });

  it("sticky prefs model wins over a config-file provider", () => {
    savePreferences({ model: "gpt-4.1" });
    fs.writeFileSync(path.join(tmp, "config.toml"), 'provider = "claude"\n');
    const cfg = loadConfig({}, tmp);
    assert.equal(cfg.provider, "anthropic");
    assert.equal(cfg.model, "gpt-4.1");
  });

  it("CLI provider switch still rescues over a config-file model", () => {
    fs.writeFileSync(path.join(tmp, "config.toml"), 'model = "file-model"\n');
    const cfg = loadConfig({ provider: "openai" }, tmp);
    assert.equal(cfg.provider, "openai");
    assert.equal(cfg.model, DEFAULT_CONFIG.providers?.openai?.defaultModel);
  });

  it("env provider switch beats config-file provider and follows its default", () => {
    fs.writeFileSync(path.join(tmp, "config.toml"), 'provider = "claude"\n');
    process.env.FORGE_PROVIDER = "openai";
    const cfg = loadConfig({}, tmp);
    assert.equal(cfg.provider, "openai");
    assert.equal(cfg.model, DEFAULT_CONFIG.providers?.openai?.defaultModel);
  });
});
