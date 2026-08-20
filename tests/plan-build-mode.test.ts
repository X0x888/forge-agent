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
  persistSessionMode,
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
import { executeTool, TOOL_DEFINITIONS } from "../src/agent/tools/index.js";
import { isExitPlanModeToolName } from "../src/agent/tools/exit-plan-mode.js";
import {
  isReadOnlyToolName,
  filterToolsForPermissionMode,
} from "../src/agent/loop.js";
import { filterToolsForSubagent } from "../src/agent/subagent.js";

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
    assert.match(plan, /exit_plan_mode/);
    assert.match(plan, /\/build/);
    assert.match(plan, /Verification/);
    assert.match(plan, /hard-denied|permission-denied|Mutations/i);

    const child = buildBaselineSystemPrompt({
      config: { ...DEFAULT_CONFIG, permissionMode: "plan" },
      workspace: tmp,
      subagentDepth: 1,
    });
    assert.match(child, /research subagent/i);
    assert.match(child, /Do not call exit_plan_mode/);
  });

  it("PermissionGate plan deny message points at exit_plan_mode / /build", async () => {
    const gate = new PermissionGate({ interactive: false });
    const d = await gate.request({
      toolName: "write_file",
      input: { path: path.join(tmp, "x.ts"), content: "x" },
      mode: "plan",
      workspace: tmp,
    });
    assert.equal(d.decision, "deny");
    assert.match(d.reason || "", /exit_plan_mode|\/build/);
  });

  it("PermissionGate plan allows read-only bash and denies mutating bash", async () => {
    const gate = new PermissionGate({ interactive: false });
    const ro = await gate.request({
      toolName: "bash",
      input: { command: "git status" },
      mode: "plan",
      workspace: tmp,
    });
    assert.equal(ro.decision, "allow", ro.reason);
    assert.match(ro.reason || "", /plan_readonly_bash|plan_read/);

    const mut = await gate.request({
      toolName: "bash",
      input: { command: "git commit -m x" },
      mode: "plan",
      workspace: tmp,
    });
    assert.equal(mut.decision, "deny");
    assert.match(mut.reason || "", /plan_mode|bash mutations/i);

    const writey = await gate.request({
      toolName: "bash",
      input: { command: "rm -rf dist" },
      mode: "plan",
      workspace: tmp,
    });
    assert.equal(writey.decision, "deny");
  });

  it("tab-completes /plan and /build", () => {
    const [planHits] = forgeCompleter("/pl");
    assert.ok(planHits.some((h) => h.startsWith("/plan")));
    const [buildHits] = forgeCompleter("/bu");
    assert.ok(buildHits.some((h) => h.startsWith("/build")));
    const [permHits] = forgeCompleter("/permissions ");
    assert.ok(permHits.some((h) => h.includes("build")));
  });

  it("/sessions errors lists only lastError sessions", async () => {
    const hooks = new HookRunner(DEFAULT_CONFIG, tmp);
    const good = createSession({
      cwd: tmp,
      provider: "xai",
      model: "m",
      title: "good-session",
    });
    saveSession(good);
    const bad = createSession({
      cwd: tmp,
      provider: "xai",
      model: "m",
      title: "bad-fail",
    });
    setSessionLastError(bad, {
      code: "rate_limited",
      message: "xai HTTP 429",
      tips: ["switch"],
    });
    saveSession(bad);
    const r = await handleSlash("/sessions errors", {
      session: good,
      config: { ...DEFAULT_CONFIG, workspace: tmp },
      hooks,
    });
    assert.equal(r.handled, true);
    const out = String(r.output || "");
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /bad-fail/);
    assert.match(out, /rate_limited/);
    assert.ok(
      plain.indexOf("rate_limited") < plain.indexOf("bad-fail"),
      plain,
    );
    assert.doesNotMatch(out, /good-session/);
  });
});

describe("exit_plan_mode tool", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-exit-plan-"));
    prevHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("is defined and aliased", () => {
    assert.ok(
      TOOL_DEFINITIONS.some((d) => d.function.name === "exit_plan_mode"),
    );
    assert.equal(isExitPlanModeToolName("exit_plan_mode"), true);
    assert.equal(isExitPlanModeToolName("ExitPlanMode"), true);
    assert.equal(isExitPlanModeToolName("exitPlanMode"), true);
    assert.equal(isExitPlanModeToolName("ask_user"), false);
    assert.equal(isReadOnlyToolName("exit_plan_mode"), false);
  });

  it("is denied to subagents (cannot flip parent session)", () => {
    const names = filterToolsForSubagent("full").map((t) => t.function.name);
    assert.ok(!names.includes("exit_plan_mode"));
    const ro = filterToolsForSubagent("read-only").map((t) => t.function.name);
    assert.ok(!ro.includes("exit_plan_mode"));
  });

  it("fails closed headless when not entered from yolo", async () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const config = { ...DEFAULT_CONFIG, workspace: tmp, permissionMode: "default" as const };
    enterSessionPlanMode(config, session);
    const r = await executeTool(
      "exit_plan_mode",
      JSON.stringify({ plan: "1. Ship persistSessionMode" }),
      { workspace: tmp, session, config },
    );
    assert.equal(r.isError, true);
    assert.match(r.output, /Staying in plan mode|not available/i);
    assert.equal(config.permissionMode, "plan");
  });

  it("auto-approves when session entered plan from bypassPermissions", async () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "bypassPermissions" as const,
    };
    enterSessionPlanMode(config, session);
    assert.equal(config.permissionMode, "plan");
    const r = await executeTool(
      "ExitPlanMode",
      JSON.stringify({ plan: "1. Implement X\n2. Test Y" }),
      { workspace: tmp, session, config },
    );
    assert.equal(r.isError, undefined);
    assert.match(r.output, /Plan approved/);
    assert.match(r.output, /Implement X/);
    assert.equal(config.permissionMode, "bypassPermissions");
    assert.equal(session.meta.permissionModeBeforePlan, undefined);
  });

  it("rejects empty plan and not-in-plan", async () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: tmp,
      permissionMode: "bypassPermissions" as const,
    };
    const notPlan = await executeTool(
      "exit_plan_mode",
      JSON.stringify({ plan: "do it" }),
      { workspace: tmp, session, config },
    );
    assert.equal(notPlan.isError, true);
    assert.match(notPlan.output, /not in plan mode/);

    enterSessionPlanMode(config, session);
    const empty = await executeTool(
      "exit_plan_mode",
      JSON.stringify({ plan: "   " }),
      { workspace: tmp, session, config },
    );
    assert.equal(empty.isError, true);
    assert.match(empty.output, /plan is required/);
    assert.equal(config.permissionMode, "plan");
  });

  it("persistSessionMode writes session meta", () => {
    const session = createSession({ cwd: tmp, provider: "xai", model: "m" });
    const config = { ...DEFAULT_CONFIG, workspace: tmp, permissionMode: "default" as const };
    enterSessionPlanMode(config, session);
    persistSessionMode(session);
    const loaded = loadSession(session.meta.id);
    assert.ok(loaded);
    assert.equal(loaded!.meta.permissionMode, "plan");
    assert.equal(loaded!.meta.permissionModeBeforePlan, "default");
  });

  it("system prompt teaches exit_plan_mode instead of waiting for /build", () => {
    const text = buildBaselineSystemPrompt({
      config: { ...DEFAULT_CONFIG, permissionMode: "plan" },
      workspace: tmp,
    });
    assert.match(text, /exit_plan_mode/);
    assert.doesNotMatch(text, /stop and wait for \/build/i);
  });

  it("plan mode tool schema hides write tools and keeps exit_plan_mode", () => {
    const names = filterToolsForPermissionMode(
      TOOL_DEFINITIONS,
      "plan",
    ).map((t) => t.function.name);
    assert.ok(names.includes("exit_plan_mode"));
    assert.ok(names.includes("read_file"));
    assert.ok(names.includes("ask_user"));
    assert.ok(!names.includes("write_file"));
    assert.ok(names.includes("bash"));
    assert.ok(names.includes("spawn_subagent"));
    const full = filterToolsForPermissionMode(TOOL_DEFINITIONS, "default");
    assert.equal(full.length, TOOL_DEFINITIONS.length);
  });
});
