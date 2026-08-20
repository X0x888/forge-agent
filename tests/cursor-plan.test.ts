import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectPlanUsage,
  cursorUsagePool,
  parseCursorPeriodUsage,
} from "../src/statusline/plan.js";
import { formatPlan } from "../src/statusline/render.js";
import { CURSOR_NATIVE_REJECT } from "../src/providers/cursor-proto.js";

describe("cursorUsagePool", () => {
  it("puts Cursor Grok / Composer on the auto bar", () => {
    assert.equal(cursorUsagePool("cursor-grok-4.6-xhigh-fast"), "auto");
    assert.equal(cursorUsagePool("composer-2.5"), "auto");
    assert.equal(cursorUsagePool("grok-4.6"), "auto");
  });
  it("puts Claude / GPT on the API bar", () => {
    assert.equal(cursorUsagePool("claude-sonnet-5"), "api");
    assert.equal(cursorUsagePool("claude-fable-5-max"), "api");
    assert.equal(cursorUsagePool("gpt-5.5"), "api");
  });
});

describe("parseCursorPeriodUsage", () => {
  const ultra = {
    planUsage: {
      limit: 40_000,
      remaining: 38_467,
      includedSpend: 1_533,
      autoPercentUsed: 0.686,
      apiPercentUsed: 0.322,
      totalPercentUsed: 3.8,
    },
    autoBucketModels: ["composer-2.5", "cursor-grok-4.5-high"],
    billingCycleEnd: String(Date.parse("2026-09-13T00:00:00Z")),
  };

  it("Cursor Grok uses autoPercentUsed and does not attach the $400 API cap", () => {
    const plan = parseCursorPeriodUsage(ultra, {
      model: "cursor-grok-4.6-xhigh-fast",
    });
    assert.equal(plan.product, "Cursor Models");
    assert.equal(plan.percent, 0.7);
    assert.equal(plan.used, undefined);
    assert.equal(plan.limit, undefined);
    const hud = formatPlan(plan, false);
    assert.match(hud || "", /use:0\.7%/);
    assert.equal(/400/.test(hud || ""), false);
  });

  it("named API models use apiPercentUsed plus the dollar cap", () => {
    const plan = parseCursorPeriodUsage(ultra, { model: "claude-sonnet-5" });
    assert.equal(plan.product, "Cursor API");
    assert.equal(plan.percent, 0.3);
    assert.equal(plan.used, 15.33);
    assert.equal(plan.limit, 400);
  });

  it("does not invent percent when spend fields are missing", () => {
    const plan = parseCursorPeriodUsage({ planUsage: {} });
    assert.equal(plan.percent, undefined);
    assert.equal(plan.used, undefined);
    assert.equal(plan.limit, undefined);
  });
});

describe("collectPlanUsage cursor", () => {
  let tmp: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cursor-plan-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("does not claim there is no quota API when logged out", async () => {
    const plan = await collectPlanUsage({
      provider: "cursor",
      authMethod: "subscription",
    });
    assert.equal(plan?.product, "Cursor");
    assert.equal(plan?.percent, undefined);
    assert.equal(/no third-party/i.test(plan?.note || ""), false);
    const hud = formatPlan(plan, false);
    assert.equal(hud, null);
  });
});

describe("Cursor native-tool reject copy", () => {
  it("names Forge edit tools, not search_mcp", () => {
    assert.match(CURSOR_NATIVE_REJECT, /write_file/);
    assert.match(CURSOR_NATIVE_REJECT, /search_replace/);
    assert.match(CURSOR_NATIVE_REJECT, /apply_patch/);
    assert.match(CURSOR_NATIVE_REJECT, /not search_mcp/);
    assert.equal(/Use the MCP tools provided/i.test(CURSOR_NATIVE_REJECT), false);
  });
});
