import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseCostUsd,
  resolveMaxCostUsd,
  sessionCostUsd,
  costCapStatus,
  formatCostBudgetLine,
  MAX_COST_USD_CEILING,
} from "../src/util/cost-budget.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { loadConfig } from "../src/config/load.js";
import {
  createSession,
  saveSession,
  loadSession,
  clearConversation,
} from "../src/session/session.js";
import {
  handleSlash,
  classifyLiveSlash,
  buildEffectiveConfigSnap,
  formatEffectiveConfig,
} from "../src/commands/slash.js";
import { HookRunner } from "../src/harness/hooks.js";
import {
  clearLiveNotices,
  drainLiveNotices,
} from "../src/harness/live-notices.js";
import {
  buildRunEndMetrics,
  collectUsageStats,
  formatUsageStats,
} from "../src/session/metrics.js";
import { estimateCostUsd } from "../src/util/format.js";

describe("parseCostUsd", () => {
  it("parses plain, $, and usd suffixes", () => {
    assert.equal(parseCostUsd("5"), 5);
    assert.equal(parseCostUsd("$2.50"), 2.5);
    assert.equal(parseCostUsd("1.25usd"), 1.25);
    assert.equal(parseCostUsd("  $10 USD "), 10);
  });

  it("treats off/unlimited/0 as unlimited (0)", () => {
    assert.equal(parseCostUsd("0"), 0);
    assert.equal(parseCostUsd("off"), 0);
    assert.equal(parseCostUsd("unlimited"), 0);
    assert.equal(parseCostUsd("none"), 0);
  });

  it("returns null for invalid / over-ceiling", () => {
    assert.equal(parseCostUsd(""), null);
    assert.equal(parseCostUsd("abc"), null);
    assert.equal(parseCostUsd("-1"), null);
    assert.equal(parseCostUsd(String(MAX_COST_USD_CEILING + 1)), null);
  });

  it("returns undefined when omitted", () => {
    assert.equal(parseCostUsd(undefined), undefined);
    assert.equal(parseCostUsd(null), undefined);
  });
});

describe("resolveMaxCostUsd + costCapStatus", () => {
  it("defaults to unlimited", () => {
    assert.equal(resolveMaxCostUsd({ maxCostUsd: 0 }), null);
    assert.equal(resolveMaxCostUsd({ maxCostUsd: 5 }), 5);
  });

  it("session override wins including explicit 0", () => {
    assert.equal(
      resolveMaxCostUsd({ maxCostUsd: 10 }, { maxCostUsd: 2 }),
      2,
    );
    assert.equal(
      resolveMaxCostUsd({ maxCostUsd: 10 }, { maxCostUsd: 0 }),
      null,
    );
  });

  it("detects hit when spent >= cap", () => {
    const meta = {
      totalPromptTokens: 1_000_000,
      totalCompletionTokens: 1_000_000,
      maxCostUsd: 0.0001,
    };
    // Force a tiny cap so any non-zero estimate hits
    const st = costCapStatus(
      { maxCostUsd: 0, provider: "xai", model: "grok-4.5" },
      meta,
    );
    // With session override 0.0001, almost any tokens hit
    const spent = sessionCostUsd("xai", meta, "grok-4.5");
    assert.ok(spent > 0);
    assert.equal(st.cap, 0.0001);
    assert.equal(st.hit, spent >= 0.0001);
    assert.match(formatCostBudgetLine(st), /budget:/);
  });

  it("unlimited status line", () => {
    const st = costCapStatus(
      { maxCostUsd: 0, provider: "xai", model: "grok-4.5" },
      { totalPromptTokens: 100, totalCompletionTokens: 50 },
    );
    assert.equal(st.cap, null);
    assert.equal(st.hit, false);
    assert.match(formatCostBudgetLine(st), /unlimited/);
  });
});

describe("loadConfig max_cost_usd / FORGE_MAX_COST_USD", () => {
  const prev = process.env.FORGE_MAX_COST_USD;
  after(() => {
    if (prev === undefined) delete process.env.FORGE_MAX_COST_USD;
    else process.env.FORGE_MAX_COST_USD = prev;
  });

  it("reads FORGE_MAX_COST_USD", () => {
    process.env.FORGE_MAX_COST_USD = "7.5";
    const cfg = loadConfig();
    assert.equal(cfg.maxCostUsd, 7.5);
    delete process.env.FORGE_MAX_COST_USD;
  });

  it("DEFAULT_CONFIG has maxCostUsd 0", () => {
    assert.equal(DEFAULT_CONFIG.maxCostUsd, 0);
  });
});

describe("/budget slash + live classify", () => {
  let tmp: string;
  let prevHome: string | undefined;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-budget-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
  });

  after(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  });

  it("classifies status readonly and set as control", () => {
    assert.equal(classifyLiveSlash("/budget"), "readonly");
    assert.equal(classifyLiveSlash("/budget status"), "readonly");
    assert.equal(classifyLiveSlash("/budget 5"), "control");
    assert.equal(classifyLiveSlash("/budget off"), "control");
  });

  it("sets and clears session budget", async () => {
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.5",
    });
    clearLiveNotices();
    const config = {
      ...DEFAULT_CONFIG,
      maxCostUsd: 10,
      blockingStopHooks: true,
      compatClaudeHooks: false,
      compatCursorHooks: false,
    };
    const hooks = new HookRunner(config, tmp);

    const set = await handleSlash("/budget 3.5", { session, config, hooks });
    assert.equal(set.handled, true);
    assert.match(set.output || "", /budget  ·  ok/);
    assert.match(set.output || "", /\$3\.50/);
    assert.equal(session.meta.maxCostUsd, 3.5);
    const notices = drainLiveNotices(session.meta.id);
    assert.ok(notices.some((n) => /spend cap to \$3\.5/i.test(n)));

    // Round-trip via save/load
    saveSession(session);
    const reloaded = loadSession(session.meta.id)!;
    assert.equal(reloaded.meta.maxCostUsd, 3.5);

    const off = await handleSlash("/budget off", {
      session: reloaded,
      config,
      hooks,
    });
    assert.equal(off.handled, true);
    assert.equal(reloaded.meta.maxCostUsd, 0);
    assert.match(off.output || "", /unlimited/i);

    // clearConversation drops override
    reloaded.meta.maxCostUsd = 2;
    clearConversation(reloaded);
    assert.equal(reloaded.meta.maxCostUsd, undefined);
  });

  it("/cost shows budget line", async () => {
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.5",
    });
    session.meta.maxCostUsd = 5;
    session.meta.totalPromptTokens = 1000;
    session.meta.totalCompletionTokens = 500;
    const config = {
      ...DEFAULT_CONFIG,
      blockingStopHooks: true,
      compatClaudeHooks: false,
      compatCursorHooks: false,
    };
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/cost", { session, config, hooks });
    assert.equal(r.handled, true);
    assert.match(r.output || "", /budget:/i);
    assert.match(r.output || "", /\/budget/);
  });

  it("/cost shows last-round cache separately from the session smear", async () => {
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.6",
    });
    session.meta.totalPromptTokens = 200_000;
    session.meta.totalCompletionTokens = 10_000;
    session.meta.totalCacheReadTokens = 80_000;
    session.meta.lastRoundPromptTokens = 40_000;
    session.meta.lastRoundCacheReadTokens = 39_600;
    const config = {
      ...DEFAULT_CONFIG,
      blockingStopHooks: true,
      compatClaudeHooks: false,
      compatCursorHooks: false,
    };
    const hooks = new HookRunner(config, tmp);
    const r = await handleSlash("/cost", { session, config, hooks });
    assert.equal(r.handled, true);
    assert.match(r.output || "", /session smear/);
    assert.match(r.output || "", /last round:.*99%/);
  });

  it("effective config snap includes cost budget", () => {
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.5",
    });
    session.meta.maxCostUsd = 4;
    const config = { ...DEFAULT_CONFIG, maxCostUsd: 10 };
    const snap = buildEffectiveConfigSnap(config, { session });
    assert.equal(snap.maxCostUsd, 10);
    assert.equal(snap.effectiveMaxCostUsd, 4);
    const text = formatEffectiveConfig(config, { session });
    assert.match(text, /cost budget/i);
    assert.match(text, /\$4/);
  });
});

describe("metrics costCapHits", () => {
  it("counts hitCostCap on run_end", () => {
    const ev = buildRunEndMetrics({
      sessionId: "m1",
      provider: "xai",
      model: "grok-4.5",
      turns: 2,
      stopContinues: 0,
      hitCostCap: true,
      editCount: 0,
      promptTokens: 100,
      completionTokens: 50,
      ok: true,
    });
    assert.equal(ev.hitCostCap, true);
    // collectUsageStats reads metrics.jsonl — unit-check the event shape only
    assert.ok(estimateCostUsd("xai", 100, 50, "grok-4.5") >= 0);
  });

  it("formatUsageStats includes costCap column", () => {
    // Minimal synthetic stats object
    const stats = collectUsageStats(0);
    assert.ok(typeof stats.costCapHits === "number");
    const text = formatUsageStats(stats);
    assert.match(text, /costCap=/);
  });
});
