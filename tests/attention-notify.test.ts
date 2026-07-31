import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isBellEnabled,
  isNotifyEnabled,
  maybeRingBell,
  maybeDesktopNotify,
  setBellEnabled,
  setNotifyEnabled,
  turnEndOutcomeLabel,
} from "../src/util/attention.js";
import { createSession } from "../src/session/session.js";
import { sessionToSnapshot } from "../src/statusline/snapshot.js";
import { renderCompactStrip, renderHud } from "../src/statusline/render.js";
import { handleSlash, classifyLiveSlash } from "../src/commands/slash.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import {
  clearLiveNotices,
  drainLiveNotices,
} from "../src/harness/live-notices.js";

describe("desktop notify preference", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevBell: string | undefined;
  let prevNotify: string | undefined;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-notify-"));
    prevHome = process.env.FORGE_HOME;
    prevBell = process.env.FORGE_BELL;
    prevNotify = process.env.FORGE_NOTIFY;
    process.env.FORGE_HOME = tmp;
    delete process.env.FORGE_BELL;
    delete process.env.FORGE_NOTIFY;
  });

  after(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    if (prevBell === undefined) delete process.env.FORGE_BELL;
    else process.env.FORGE_BELL = prevBell;
    if (prevNotify === undefined) delete process.env.FORGE_NOTIFY;
    else process.env.FORGE_NOTIFY = prevNotify;
  });

  it("defaults notify off and respects preference + env", () => {
    assert.equal(isNotifyEnabled(), false);
    setNotifyEnabled(true);
    assert.equal(isNotifyEnabled(), true);
    process.env.FORGE_NOTIFY = "0";
    assert.equal(isNotifyEnabled(), false);
    delete process.env.FORGE_NOTIFY;
    setNotifyEnabled(false);
    assert.equal(isNotifyEnabled(), false);
  });

  it("maybeDesktopNotify no-ops when disabled", () => {
    setNotifyEnabled(false);
    assert.equal(maybeDesktopNotify({ title: "t", body: "b" }), false);
  });

  it("maybeRingBell still honors force", () => {
    setBellEnabled(false);
    // force rings only on TTY — just ensure it does not throw
    const rang = maybeRingBell({ force: true });
    assert.equal(typeof rang, "boolean");
  });

  it("/notify status and on/off", async () => {
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.5",
    });
    clearLiveNotices();
    const config = {
      ...DEFAULT_CONFIG,
      blockingStopHooks: true,
      compatClaudeHooks: false,
      compatCursorHooks: false,
    };
    const hooks = new HookRunner(config, tmp);
    const st = await handleSlash("/notify", { session, config, hooks });
    assert.equal(st.handled, true);
    assert.match(st.output || "", /desktop notify/i);

    const on = await handleSlash("/notify on", { session, config, hooks });
    assert.equal(on.handled, true);
    assert.equal(isNotifyEnabled(), true);
    const noticesOn = drainLiveNotices(session.meta.id);
    assert.ok(noticesOn.some((n) => /desktop notify/i.test(n)));

    const off = await handleSlash("/notify off", { session, config, hooks });
    assert.equal(off.handled, true);
    assert.equal(isNotifyEnabled(), false);
    const noticesOff = drainLiveNotices(session.meta.id);
    assert.ok(noticesOff.some((n) => /disabled turn-end desktop notify/i.test(n)));
  });

  it("classifies /notify live", () => {
    assert.equal(classifyLiveSlash("/notify"), "readonly");
    assert.equal(classifyLiveSlash("/notify status"), "readonly");
    assert.equal(classifyLiveSlash("/notify on"), "control");
  });
});

describe("turnEndOutcomeLabel", () => {
  it("prefers safety valves over generic complete", () => {
    assert.equal(turnEndOutcomeLabel({ hitCostCap: true }), "cost cap");
    assert.equal(turnEndOutcomeLabel({ hitMaxTurns: true }), "max turns");
    assert.equal(
      turnEndOutcomeLabel({ releasedOnContinueCap: true }),
      "continue cap",
    );
    assert.equal(turnEndOutcomeLabel({ aborted: true }), "aborted");
    assert.equal(
      turnEndOutcomeLabel({ lastErrorCode: "handoff_released" }),
      "handoff released",
    );
    assert.equal(
      turnEndOutcomeLabel({ lastErrorCode: "proof_claim_released" }),
      "proof-claim released",
    );
    assert.equal(
      turnEndOutcomeLabel({ lastErrorCode: "continue_cap_stop" }),
      "continue cap",
    );
    assert.equal(turnEndOutcomeLabel({}), "turn complete");
    assert.equal(
      turnEndOutcomeLabel({ editCount: 2 }),
      "turn complete · no last-verify",
    );
    assert.equal(
      turnEndOutcomeLabel({
        editCount: 2,
        lastVerificationCommand: "npm test",
        lastVerificationStale: true,
      }),
      "turn complete · last-verify stale",
    );
    assert.equal(
      turnEndOutcomeLabel({
        editCount: 2,
        lastVerificationCommand: "npm test",
        lastVerificationStale: false,
      }),
      "turn complete · verified",
    );
    // Flags win over lastError
    assert.equal(
      turnEndOutcomeLabel({
        hitCostCap: true,
        lastErrorCode: "handoff_released",
      }),
      "cost cap",
    );
  });
});

describe("budget HUD", () => {
  let tmp: string;
  let prevHome: string | undefined;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-budget-hud-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
  });

  after(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  });

  it("includes budget in snapshot and render when capped", () => {
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.5",
    });
    session.meta.totalPromptTokens = 50_000;
    session.meta.totalCompletionTokens = 10_000;
    session.meta.maxCostUsd = 5;
    const snap = sessionToSnapshot(session, {
      windowTokens: 128_000,
      maxCostUsd: 0,
    });
    assert.ok(snap.budget);
    assert.equal(snap.budget!.capUsd, 5);
    assert.ok(snap.budget!.spentUsd >= 0);
    const strip = renderCompactStrip(snap, { plain: true, width: 120 });
    assert.match(strip, /budget/i);
    const hud = renderHud([snap], { plain: true, width: 140 });
    assert.match(hud, /budget/i);
  });

  it("omits budget when unlimited", () => {
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.5",
    });
    session.meta.totalPromptTokens = 1000;
    const snap = sessionToSnapshot(session, {
      windowTokens: 128_000,
      maxCostUsd: 0,
    });
    assert.equal(snap.budget, undefined);
  });

  it("status JSON serializes budget when capped", async () => {
    const { snapshotsToJson } = await import("../src/statusline/render.js");
    const session = createSession({
      cwd: tmp,
      provider: "xai",
      model: "grok-4.5",
    });
    session.meta.maxCostUsd = 3;
    session.meta.totalPromptTokens = 20_000;
    session.meta.totalCompletionTokens = 5_000;
    const snap = sessionToSnapshot(session, {
      windowTokens: 128_000,
      maxCostUsd: 0,
    });
    assert.ok(snap.budget);
    assert.ok(snap.tags.some((t) => t.startsWith("BUDGET")));
    const json = JSON.parse(snapshotsToJson([snap]));
    assert.equal(json.ok, true);
    assert.ok(json.sessions[0].budget);
    assert.equal(json.sessions[0].budget.capUsd, 3);
    assert.ok(json.sessions[0].tags.some((t: string) => t.startsWith("BUDGET")));
  });
});
