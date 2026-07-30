/**
 * OpenCode-style /plan ↔ /build: session-scoped plan mode without sticky prefs footgun.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyLiveSlash,
  isLiveSafeSlash,
  handleSlash,
} from "../src/commands/slash.js";
import {
  createSession,
  saveSession,
  loadSession,
  enterSessionPlanMode,
  exitSessionPlanMode,
  applySessionPermissionMode,
  formatResumeOrientation,
  formatSessionShareCard,
  formatSessionSummary,
  forkSession,
  setSessionLastError,
} from "../src/session/session.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { HookRunner } from "../src/harness/hooks.js";
import { buildBaselineSystemPrompt } from "../src/agent/system-prompt.js";
import { PermissionGate } from "../src/agent/permissions.js";
import { loadPreferences } from "../src/config/preferences.js";
import { drainLiveNotices, clearLiveNotices } from "../src/harness/live-notices.js";
import { forgeCompleter } from "../src/tui/complete.js";

describe("plan/build live controls", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-plan-build-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
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

  it("classifies /plan /build /execute as live control", () => {
    assert.equal(classifyLiveSlash("/plan"), "control");
    assert.equal(classifyLiveSlash("/plan auth redesign"), "control");
    assert.equal(classifyLiveSlash("/build"), "control");
    assert.equal(classifyLiveSlash("/build ship it"), "control");
    assert.equal(classifyLiveSlash("/execute"), "control");
    assert.equal(classifyLiveSlash("/permissions plan"), "control");
    assert.equal(classifyLiveSlash("/permissions build"), "control");
    assert.ok(isLiveSafeSlash("/plan"));
    assert.ok(isLiveSafeSlash("/build"));
    // sticky mode changes remain idle-only
    assert.equal(classifyLiveSlash("/permissions acceptEdits"), "idle-only");
    assert.equal(classifyLiveSlash("/permissions bypassPermissions"), "idle-only");
  });

  it("/plan is session-scoped and does not touch sticky preferences", async () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const cfg = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "acceptEdits" as const,
    };
    clearLiveNotices(session.meta.id);

    const r = await handleSlash("/plan focus on auth", {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(r.output || "", /PLAN MODE/);
    assert.match(r.output || "", /Focus: focus on auth/);
    assert.equal(cfg.permissionMode, "plan");
    assert.equal(session.meta.permissionMode, "plan");
    assert.equal(session.meta.permissionModeBeforePlan, "acceptEdits");

    // Sticky prefs must remain untouched
    const prefs = loadPreferences();
    assert.notEqual(prefs.permissionMode, "plan");

    const notices = drainLiveNotices(session.meta.id);
    assert.ok(notices.some((n) => /PLAN MODE/i.test(n)));
  });

  it("/build restores prior mode and clears plan bookkeeping", async () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const cfg = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "acceptEdits" as const,
    };
    clearLiveNotices(session.meta.id);

    await handleSlash("/plan", { session, config: cfg, hooks });
    assert.equal(cfg.permissionMode, "plan");

    const r = await handleSlash("/build implement now", {
      session,
      config: cfg,
      hooks,
    });
    assert.equal(r.handled, true);
    assert.match(r.output || "", /BUILD MODE/);
    assert.equal(cfg.permissionMode, "acceptEdits");
    // Session override cleared — sticky prefs / CLI own post-plan mode
    assert.equal(session.meta.permissionMode, undefined);
    assert.equal(session.meta.permissionModeBeforePlan, undefined);

    const notices = drainLiveNotices(session.meta.id);
    assert.ok(notices.some((n) => /left PLAN MODE/i.test(n) || /BUILD/i.test(n)));
  });

  it("/permissions plan|build aliases route correctly", async () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const cfg = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "default" as const,
    };

    await handleSlash("/permissions plan", { session, config: cfg, hooks });
    assert.equal(cfg.permissionMode, "plan");

    await handleSlash("/permissions build", { session, config: cfg, hooks });
    assert.equal(cfg.permissionMode, "default");
  });

  it("/execute is an alias of /build", async () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const cfg = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "dontAsk" as const,
    };
    enterSessionPlanMode(cfg, session);
    const r = await handleSlash("/execute", { session, config: cfg, hooks });
    assert.equal(r.handled, true);
    assert.equal(cfg.permissionMode, "dontAsk");
  });

  it("session helpers round-trip plan mode across save/load", () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const cfg = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "acceptEdits" as const,
    };
    enterSessionPlanMode(cfg, session);
    saveSession(session);

    const loaded = loadSession(session.meta.id);
    assert.ok(loaded);
    assert.equal(loaded!.meta.permissionMode, "plan");
    assert.equal(loaded!.meta.permissionModeBeforePlan, "acceptEdits");

    const cfg2 = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "default" as const,
    };
    assert.equal(applySessionPermissionMode(cfg2, loaded!), true);
    assert.equal(cfg2.permissionMode, "plan");

    const out = exitSessionPlanMode(cfg2, loaded!);
    assert.equal(out.mode, "acceptEdits");
    assert.equal(out.wasPlan, true);
    assert.equal(cfg2.permissionMode, "acceptEdits");
    assert.equal(loaded!.meta.permissionMode, undefined);
    assert.equal(loaded!.meta.permissionModeBeforePlan, undefined);
  });

  it("fork copies session plan override", () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const cfg = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "acceptEdits" as const,
    };
    enterSessionPlanMode(cfg, session);
    setSessionLastError(session, {
      code: "rate_limited",
      message: "429",
      tips: ["switch"],
    });
    saveSession(session);
    const forked = forkSession(session);
    assert.equal(forked.meta.permissionMode, "plan");
    assert.equal(forked.meta.permissionModeBeforePlan, "acceptEdits");
    // Fresh experiment — do not inherit failure banner
    assert.equal(forked.meta.lastError, undefined);
  });

  it("resume orientation and share card surface PLAN", () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    session.meta.permissionMode = "plan";
    session.meta.permissionModeBeforePlan = "acceptEdits";
    const orient = formatResumeOrientation(session);
    assert.match(orient, /PLAN/);
    const card = formatSessionShareCard(session);
    assert.match(card, /PLAN/);
    const summary = formatSessionSummary(session);
    assert.match(summary, /PLAN/);
  });

  it("resume orientation and share card surface lastError", () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    setSessionLastError(session, {
      code: "auth_expired",
      message: "xai HTTP 401: Invalid API key",
      tips: ["forge login"],
    });
    const orient = formatResumeOrientation(session);
    assert.match(orient, /Last error/);
    assert.match(orient, /auth_expired/);
    assert.match(orient, /forge login/);
    const card = formatSessionShareCard(session);
    assert.match(card, /lastErr/);
    assert.match(card, /auth_expired/);
    const summary = formatSessionSummary(session);
    assert.match(summary, /lastErr/);
  });

  it("system prompt PLAN MODE block is richer under plan", () => {
    const base = buildBaselineSystemPrompt({
      config: { ...DEFAULT_CONFIG, permissionMode: "acceptEdits" },
      workspace: tmp,
    });
    assert.doesNotMatch(base, /## PLAN MODE/);

    const plan = buildBaselineSystemPrompt({
      config: { ...DEFAULT_CONFIG, permissionMode: "plan" },
      workspace: tmp,
    });
    assert.match(plan, /PLAN MODE/);
    assert.match(plan, /\/build/);
    assert.match(plan, /Verification/);
    assert.match(plan, /hard-denied|permission-denied|Mutations/i);
  });

  it("PermissionGate plan deny message points at /build", async () => {
    const gate = new PermissionGate({ interactive: false });
    const d = await gate.request({
      toolName: "write_file",
      input: { path: path.join(tmp, "x.ts"), content: "x" },
      mode: "plan",
      workspace: tmp,
    });
    assert.equal(d.decision, "deny");
    assert.match(d.reason || "", /\/build/);
  });

  it("tab-completes /plan and /build", () => {
    const [planHits] = forgeCompleter("/pl");
    assert.ok(planHits.some((h) => h.startsWith("/plan")));
    const [buildHits] = forgeCompleter("/bu");
    assert.ok(buildHits.some((h) => h.startsWith("/build")));
    const [permHits] = forgeCompleter("/permissions ");
    assert.ok(permHits.some((h) => h.includes("build")));
  });
});
