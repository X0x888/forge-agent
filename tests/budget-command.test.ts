/**
 * /budget is the sit-down spend key — never a config.toml dump.
 * Raising/clearing the cap unsticks max_cost so /retry can run.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyLiveSlash,
  handleSlash,
} from "../src/commands/slash.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import {
  clearLiveNotices,
  drainLiveNotices,
} from "../src/harness/live-notices.js";
import {
  createSession,
  setSessionLastError,
} from "../src/session/session.js";
import { retryRefusedNext } from "../src/session/last-error.js";
import {
  budgetKindFromStatus,
  budgetNextKeys,
  formatBudgetCard,
  formatBudgetVerdict,
  parseBudgetArg,
  runBudget,
  shouldClearMaxCostLastError,
} from "../src/tui/budget-card.js";
import { costCapStatus } from "../src/util/cost-budget.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("/budget card", () => {
  it("parses peek / set / invalid", () => {
    assert.equal(parseBudgetArg("").verb, "peek");
    assert.equal(parseBudgetArg("status").verb, "peek");
    assert.equal(parseBudgetArg("off").amount, 0);
    assert.equal(parseBudgetArg("5").amount, 5);
    assert.equal(parseBudgetArg("$2.50").amount, 2.5);
    assert.equal(parseBudgetArg("abc").verb, "invalid");
  });

  it("verdict + Next: none / ok / HIT / invalid", () => {
    assert.match(formatBudgetVerdict("none", { color: false }), /^budget  ·  none$/);
    assert.match(formatBudgetVerdict("ok", { color: false }), /^budget  ·  ok$/);
    assert.match(formatBudgetVerdict("hit", { color: false }), /^budget  ·  HIT$/);
    assert.deepEqual(budgetNextKeys("none"), ["/budget 5"]);
    assert.deepEqual(budgetNextKeys("ok"), []);
    assert.deepEqual(budgetNextKeys("hit"), ["/budget off"]);
    const none = formatBudgetCard({
      kind: "none",
      status: { cap: null, spent: 0.01, hit: false, ratio: null, remaining: null },
      color: false,
    });
    assert.match(none, /budget  ·  none/);
    assert.match(none, /Next  \/budget 5/);
    assert.doesNotMatch(none, /FORGE_MAX_COST_USD|config\.toml/);
    const hit = formatBudgetCard({
      kind: "hit",
      status: {
        cap: 2,
        spent: 2.14,
        hit: true,
        ratio: 1.07,
        remaining: 0,
      },
      color: false,
    });
    assert.match(hit, /budget  ·  HIT/);
    assert.match(hit, /Next  \/budget off/);
    assert.doesNotMatch(hit, /forge /);
  });

  it("clears max_cost lastErr only when the cap no longer hits", () => {
    const err = { code: "max_cost" };
    assert.equal(
      shouldClearMaxCostLastError(err, {
        cap: null,
        spent: 2,
        hit: false,
        ratio: null,
        remaining: null,
      }),
      true,
    );
    assert.equal(
      shouldClearMaxCostLastError(err, {
        cap: 10,
        spent: 2,
        hit: false,
        ratio: 0.2,
        remaining: 8,
      }),
      true,
    );
    assert.equal(
      shouldClearMaxCostLastError(err, {
        cap: 1,
        spent: 2,
        hit: true,
        ratio: 2,
        remaining: 0,
      }),
      false,
    );
    assert.equal(
      shouldClearMaxCostLastError({ code: "rate_limited" }, {
        cap: null,
        spent: 2,
        hit: false,
        ratio: null,
        remaining: null,
      }),
      false,
    );
  });
});

describe("/budget slash", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-budget-cmd-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = path.join(tmp, "home");
    fs.mkdirSync(process.env.FORGE_HOME, { recursive: true });
    clearLiveNotices();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  function session() {
    return createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.5",
    });
  }

  function hooks() {
    return new HookRunner(
      {
        ...DEFAULT_CONFIG,
        blockingStopHooks: true,
        compatClaudeHooks: false,
        compatCursorHooks: false,
      },
      tmp,
    );
  }

  it("live: peek readonly, set/off control", () => {
    assert.equal(classifyLiveSlash("/budget"), "readonly");
    assert.equal(classifyLiveSlash("/budget status"), "readonly");
    assert.equal(classifyLiveSlash("/budget 5"), "control");
    assert.equal(classifyLiveSlash("/budget off"), "control");
  });

  it("designed empty is none + Next /budget 5", async () => {
    const r = await handleSlash("/budget", {
      session: session(),
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks: hooks(),
    });
    const out = strip(r.output || "");
    assert.match(out, /^budget  ·  none/m);
    assert.match(out, /Next  \/budget 5/);
    assert.doesNotMatch(out, /FORGE_MAX_COST_USD|config\.toml|max_cost_usd/);
    assert.equal(r.failed, undefined);
  });

  it("ok cap has no Next", async () => {
    const s = session();
    const r = await handleSlash("/budget 5", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks: hooks(),
    });
    const out = strip(r.output || "");
    assert.equal(s.meta.maxCostUsd, 5);
    assert.match(out, /^budget  ·  ok/m);
    assert.match(out, /\$5\.00/);
    assert.doesNotMatch(out, /Next/);
    const notices = drainLiveNotices(s.meta.id);
    assert.ok(notices.some((n) => /spend cap to \$5/i.test(n)));
  });

  it("HIT opens Next /budget off", async () => {
    const s = session();
    s.meta.maxCostUsd = 0.0001;
    s.meta.totalPromptTokens = 1_000_000;
    s.meta.totalCompletionTokens = 1_000_000;
    const st = costCapStatus(
      { ...DEFAULT_CONFIG, provider: "xai", model: "grok-4.5" },
      s.meta,
    );
    assert.equal(budgetKindFromStatus(st), "hit");
    const r = runBudget({
      session: s,
      config: { ...DEFAULT_CONFIG, provider: "xai", model: "grok-4.5" },
      arg: "",
      color: false,
      persist: false,
      notify: false,
    });
    const out = strip(r.output);
    assert.match(out, /^budget  ·  HIT/m);
    assert.match(out, /Next  \/budget off/);
  });

  it("invalid is failed + typeable Next", async () => {
    const r = await handleSlash("/budget abc", {
      session: session(),
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks: hooks(),
    });
    const out = strip(r.output || "");
    assert.equal(r.failed, true);
    assert.match(out, /^budget  ·  invalid/m);
    assert.match(out, /Next  \/budget 5/);
    assert.doesNotMatch(out, /FORGE_MAX_COST_USD/);
  });

  it("/budget off clears max_cost so /retry is no longer refused", async () => {
    const s = session();
    s.messages.push({ role: "user", content: "continue the wave" });
    setSessionLastError(s, {
      code: "max_cost",
      message: "Session spend cap hit.",
      tips: ["/budget"],
    });
    assert.equal(retryRefusedNext(s.meta.lastError), "/budget");
    const refused = await handleSlash("/retry", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks: hooks(),
    });
    assert.match(strip(refused.output || ""), /retry  ·  lastErr/);
    assert.match(strip(refused.output || ""), /Next  \/budget/);
    assert.equal(refused.forwardPrompt, undefined);

    const off = await handleSlash("/budget off", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks: hooks(),
    });
    const out = strip(off.output || "");
    assert.match(out, /^budget  ·  none/m);
    assert.equal(s.meta.maxCostUsd, 0);
    assert.equal(s.meta.lastError, undefined);
    assert.equal(retryRefusedNext(s.meta.lastError), undefined);

    const again = await handleSlash("/retry", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks: hooks(),
    });
    assert.match(strip(again.output || ""), /retry  ·  ok/);
    assert.ok(again.forwardPrompt);
  });

  it("still-HIT set does not clear max_cost lastErr", async () => {
    const s = session();
    s.meta.totalPromptTokens = 1_000_000;
    s.meta.totalCompletionTokens = 1_000_000;
    setSessionLastError(s, {
      code: "max_cost",
      message: "Session spend cap hit.",
    });
    const r = await handleSlash("/budget 0.0001", {
      session: s,
      config: { ...DEFAULT_CONFIG, workspace: tmp, provider: "xai", model: "grok-4.5" },
      hooks: hooks(),
    });
    const out = strip(r.output || "");
    assert.match(out, /^budget  ·  HIT/m);
    assert.equal(s.meta.lastError?.code, "max_cost");
    assert.equal(retryRefusedNext(s.meta.lastError), "/budget");
  });
});
