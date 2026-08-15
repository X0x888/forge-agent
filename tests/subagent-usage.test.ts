import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSubagentUsageRecord,
  familyCostBreakdown,
  familyCostJson,
  foldChildUsage,
  formatFamilyCostLines,
  formatSubagentTokensHeader,
  resolveChildUsage,
} from "../src/session/subagent-usage.js";
import type { SessionMeta } from "../src/session/session.js";

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "parent",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    cwd: "/tmp",
    provider: "xai",
    model: "grok-4.6",
    ultrawork: false,
    turnCount: 1,
    editCount: 0,
    totalPromptTokens: 3_000_000,
    totalCompletionTokens: 20_000,
    totalCacheReadTokens: 500_000,
    ...over,
  };
}

describe("resolveChildUsage", () => {
  it("uses child.meta when the loop delta is 0 (completed-child fold bug)", () => {
    const u = resolveChildUsage(
      {
        totalPromptTokens: 1_600_000,
        totalCompletionTokens: 8_000,
        totalCacheReadTokens: 300_000,
      },
      { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 },
    );
    assert.equal(u.promptTokens, 1_600_000);
    assert.equal(u.completionTokens, 8_000);
    assert.equal(u.cacheReadTokens, 300_000);
  });

  it("takes the larger of meta and loop delta", () => {
    const u = resolveChildUsage(
      {
        totalPromptTokens: 100,
        totalCompletionTokens: 10,
        totalCacheReadTokens: 0,
      },
      { promptTokens: 2_447_484, completionTokens: 11_790, cacheReadTokens: 467_456 },
    );
    assert.equal(u.promptTokens, 2_447_484);
    assert.equal(u.cacheReadTokens, 467_456);
  });
});

describe("foldChildUsage", () => {
  it("adds child tokens to the parent once", () => {
    const parent = meta();
    const rec = buildSubagentUsageRecord({
      sessionId: "46a61ac1",
      description: "Audit CLI help and onboarding UX",
      subagentType: "explore",
      status: "incomplete_max_turns",
      turns: 40,
      maxTurns: 40,
      usage: {
        promptTokens: 2_447_484,
        completionTokens: 11_790,
        cacheReadTokens: 467_456,
      },
      provider: "xai",
      model: "grok-4.6",
    });
    const first = foldChildUsage(parent, rec);
    assert.equal(first.added, true);
    assert.equal(parent.totalPromptTokens, 3_000_000 + 2_447_484);
    assert.equal(parent.subagentUsage?.length, 1);
    assert.ok((parent.subagentUsage?.[0].estCostUsd || 0) > 4);

    const second = foldChildUsage(parent, rec);
    assert.equal(second.added, false);
    assert.equal(second.delta.promptTokens, 0);
    assert.equal(parent.totalPromptTokens, 3_000_000 + 2_447_484);
    assert.equal(parent.subagentUsage?.length, 1);
  });
});

describe("familyCostBreakdown", () => {
  it("splits parent vs children without inventing a cap", () => {
    const parent = meta({ totalPromptTokens: 5_447_484 });
    foldChildUsage(
      parent,
      buildSubagentUsageRecord({
        sessionId: "kid",
        description: "Audit TUI",
        subagentType: "explore",
        status: "completed",
        turns: 27,
        maxTurns: 40,
        usage: {
          promptTokens: 1_600_000,
          completionTokens: 8_000,
          cacheReadTokens: 300_000,
        },
        provider: "xai",
        model: "grok-4.6",
      }),
    );
    const b = familyCostBreakdown(parent, "xai", "grok-4.6");
    assert.equal(b.childSum.count, 1);
    assert.equal(b.parent.promptTokens, 5_447_484);
    assert.equal(b.family.promptTokens, 5_447_484 + 1_600_000);
    assert.ok(b.family.estCostUsd > b.parent.estCostUsd);
    const lines = formatFamilyCostLines(b);
    assert.ok(lines.some((l) => /family:/.test(l)));
    assert.ok(lines.some((l) => /explore 27\/40 completed/.test(l)));
    assert.equal(lines.some((l) => /cap|budget/i.test(l)), false);
    const json = familyCostJson(parent, "xai", "grok-4.6");
    assert.equal(json.subagentUsage.length, 1);
    assert.ok(json.sessionCostUsd > json.parentCostUsd);
    assert.ok(json.subagentCostUsd > 0);
  });

  it("prints nothing extra when no children ran", () => {
    assert.deepEqual(formatFamilyCostLines(familyCostBreakdown(meta())), []);
  });
});

describe("formatSubagentTokensHeader", () => {
  it("shows in/cache/out and est $", () => {
    const line = formatSubagentTokensHeader(
      {
        promptTokens: 2_447_484,
        completionTokens: 11_790,
        cacheReadTokens: 467_456,
      },
      4.265,
    );
    assert.match(line, /in=/);
    assert.match(line, /cache=/);
    assert.match(line, /out=/);
    assert.match(line, /\$4\.265/);
    assert.doesNotMatch(line, /cap|budget/i);
  });

  it("omits an empty usage line", () => {
    assert.equal(
      formatSubagentTokensHeader(
        { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 },
        0,
      ),
      "",
    );
  });
});
