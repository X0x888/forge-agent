import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession, saveSession } from "../src/session/session.js";
import { sessionToSnapshot } from "../src/statusline/snapshot.js";
import { renderHud, renderTmux } from "../src/statusline/render.js";
import {
  heartbeatSession,
  computeLiveness,
  releaseSession,
} from "../src/statusline/active.js";
import { collectPlanUsage } from "../src/statusline/plan.js";

describe("statusline", () => {
  it("builds snapshot and renders without plan inventing numbers", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "anthropic", model: "claude-sonnet-4" });
    s.messages.push({ role: "user", content: "hello world ".repeat(50) });
    s.meta.totalPromptTokens = 1200;
    s.meta.totalCompletionTokens = 400;
    s.meta.ultrawork = true;
    saveSession(s);

    const snap = sessionToSnapshot(s, {
      windowTokens: 100_000,
      authMethod: "api_key",
      authLabel: "env:ANTHROPIC_API_KEY",
    });
    assert.equal(snap.provider, "anthropic");
    assert.ok(snap.context.percent >= 0);
    assert.equal(snap.tokens.totalTokens, 1600);
    assert.ok(snap.tags.includes("ULW"));

    const hud = renderHud([snap], { plain: true, width: 120 });
    assert.match(hud, /anthropic/);
    assert.match(hud, /ctx:|█|░|%/i);
    assert.match(hud, /tok:/);

    const tmux = renderTmux(snap);
    assert.match(tmux, /forge/);
    assert.match(tmux, /ctx:/);
  });

  it("tracks live heartbeat", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl2-"));
    process.env.FORGE_HOME = tmp;
    heartbeatSession({
      sessionId: "abc-123",
      cwd: tmp,
      provider: "xai",
      model: "grok-4",
    });
    const { liveness } = computeLiveness("abc-123", new Date().toISOString());
    assert.equal(liveness, "live");
    releaseSession("abc-123");
  });

  it("plan adapter is honest for api_key and copilot", async () => {
    const api = await collectPlanUsage({ provider: "anthropic", authMethod: "api_key" });
    assert.ok(api?.note);
    assert.equal(api?.percent, undefined);

    const copilot = await collectPlanUsage({
      provider: "copilot",
      authMethod: "subscription",
    });
    assert.ok(copilot?.note?.toLowerCase().includes("quota") || copilot?.product);
    assert.equal(copilot?.percent, undefined);
  });

  it("hides N/A plan noise in render", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sl3-"));
    process.env.FORGE_HOME = tmp;
    const s = createSession({ cwd: tmp, provider: "openai", model: "gpt-4.1" });
    const snap = sessionToSnapshot(s, { authMethod: "api_key" });
    snap.plan = {
      source: "openai:api_key",
      note: "API key — billed per token; see session cost estimate",
      product: "OpenAI API",
    };
    const hud = renderHud([snap], { plain: true, width: 100 });
    assert.doesNotMatch(hud, /billed per token/);
  });
});
