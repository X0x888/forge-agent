import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectPlanUsage,
  parseCursorPeriodUsage,
} from "../src/statusline/plan.js";
import { formatPlan } from "../src/statusline/render.js";
import { CURSOR_NATIVE_REJECT } from "../src/providers/cursor-proto.js";

describe("parseCursorPeriodUsage", () => {
  it("maps planUsage cents to percent and dollars", () => {
    const plan = parseCursorPeriodUsage({
      planUsage: {
        limit: 20_000,
        remaining: 16_000,
        includedSpend: 4_000,
      },
      billingCycleEnd: String(Date.parse("2026-09-01T00:00:00Z")),
    });
    assert.equal(plan.percent, 20);
    assert.equal(plan.used, 40);
    assert.equal(plan.limit, 200);
    assert.equal(plan.remaining, 160);
    assert.equal(plan.product, "Cursor");
    assert.match(plan.resetsAt || "", /^2026-09-01/);
    const hud = formatPlan(plan, false);
    assert.match(hud || "", /use:20%/);
  });

  it("does not invent percent when spend fields are missing", () => {
    const plan = parseCursorPeriodUsage({ planUsage: {} });
    assert.equal(plan.percent, undefined);
    assert.equal(plan.used, undefined);
    assert.equal(plan.limit, undefined);
  });

  it("prefers totalPercentUsed from the dashboard body", () => {
    const plan = parseCursorPeriodUsage({
      planUsage: {
        limit: 40_000,
        remaining: 38_467,
        includedSpend: 1_533,
        totalPercentUsed: 3.8,
        apiPercentUsed: 2.1,
        autoPercentUsed: 1.7,
      },
    });
    assert.equal(plan.percent, 3.8);
    assert.equal(plan.used, 15.33);
    assert.equal(plan.limit, 400);
  });

  it("derives used from limit - remaining", () => {
    const plan = parseCursorPeriodUsage({
      planUsage: { limit: 1000, remaining: 250 },
    });
    assert.equal(plan.percent, 75);
    assert.equal(plan.used, 7.5);
    assert.equal(plan.remaining, 2.5);
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
